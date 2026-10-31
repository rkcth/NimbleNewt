import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService, HostService, LocalWorker, RemoteWorkerClient, WorkspaceResponder, startController, type WorkerHost, type WorkspaceCall } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, WorkspaceHost, type CheckoutLocation } from "@nimblenewt/worker";

// Card H12m, end to end through startController: the host that holds a real checkout (real git in temp directories) answers integration, refresh and quarantine for the controller's workspace.request, on the local worker and,
// over the authenticated transport, on a remote worker, with the same typed outcomes.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ext4 = async () => ({ type: "ext4", network: false });
const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as const;

/** A machine's side: a shared repository, a git bridge and a workspace host that finds each task's checkout where this machine put it. */
async function machine(dir: string, name: string) {
  const shared = join(dir, name, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, name, "scratch") });
  const places = new Map<string, CheckoutLocation>();
  const ran: WorkspaceCall[] = [];
  const host = new WorkspaceHost({ git, journal: join(dir, name, "journal"), locate: ({ taskId }) => places.get(taskId) });
  return {
    shared, git, places, ran, host,
    /** What the machine's `workspace` port is: the real host, noting what it was asked. */
    port: { run: async (call: WorkspaceCall) => { ran.push(call); return host.run(call); } },
    async checkoutFor(taskId: string): Promise<CheckoutLocation> {
      const where: CheckoutLocation = { shared, checkout: join(dir, name, taskId, "checkout"), gitDir: join(dir, name, taskId, "task.git"), bridgeState: join(dir, name, taskId, "state"), quarantineRoot: join(dir, name, "quarantine") };
      await git.createCheckout({ shared, commit: await git.head(shared), gitDir: where.gitDir, checkout: where.checkout });
      places.set(taskId, where);
      return where;
    },
    state: (): string => [sh(shared, "rev-parse", "HEAD"), sh(shared, "status", "--porcelain=v1"), sh(shared, "for-each-ref")].join("|"),
  };
}

const api = async (c: { api: { handle(token: string, req: never): Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>, commandId?: string) =>
  (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };

test("local host: refresh, integration and quarantine of a running agent's real checkout; the agent is told, a quarantine stops it, and the host is found by the task's last placement (card H12m)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-h12m-"));
  const m = await machine(dir, "w1");
  const told: string[] = [];
  const turn: { started?: () => void; finish?: () => void } = {};
  const inTurn: Promise<void>[] = [];
  const finishes: (() => void)[] = [];
  let local: LocalWorker | undefined;
  let gate: Promise<void> | undefined;
  let entered: (() => void) | undefined;
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      local: { acceptUnenforcedLimits: true,
        window: () => 8192, close: async () => undefined,
        build: () => {
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, version: "w-1", capabilities: () => CAPS,
            workspace: { run: async (call) => { entered?.(); if (gate !== undefined) await gate; return m.port.run(call); } },
            sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
            runtimes: { open: async () => {
              let started!: () => void; inTurn.push(new Promise<void>((ok) => { started = ok; }));
              let finish!: () => void; const over = new Promise<void>((ok) => { finish = ok; }); finishes.push(finish);
              return { run: async () => { started(); await over; return { status: "completed", text: "done" }; }, checkpoint: async () => ({}), tell: async (text: string) => { told.push(text); }, close: async () => undefined };
            } },
          });
          return local as WorkerHost;
        },
      },
      // A second host with a workspace port that is not connected: it makes "the only host that can" false, so the right host is found only by where the task was placed.
      remote: { blobDirectory: join(dir, "blobs"), hosts: [{ hostId: "host:far", checkpointWaitMs: 100, pollMs: 10, resources: { cpus: 1, memoryMb: 256 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) }] },
    },
  });
  void turn;
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await c.services.principals.enroll(owner, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
    const self = await c.services.principals.authenticate((await c.services.principals.issueCredential(owner, "host:w1")).token);
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 1, memoryMb: 1024 } });
    await local!.register(HostService.withEpoch(c.storage, c.epoch, c.services.assignments), self);
    let n = 0;
    const attemptFor = async (taskId?: string) => {
      n++;
      const agent = `agt-${String.fromCharCode(96 + n).repeat(20)}`;
      await c.services.principals.enroll(owner, { commandId: `e-${n}`, kind: "agent", name: agent, grants: workGrants(project, ["read-file"]) });
      const task = taskId ?? (await c.services.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Dig ${n}` })).id;
      if (taskId === undefined) {
        await c.services.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
        await c.services.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
      }
      const a = (await c.services.assignments.getAssignment(task))!;
      const attempt = (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: a.owner ?? { kind: "agent", id: agent }, harness: "pi" })).id;
      return { task, attempt, agent: (a.owner?.id ?? agent) };
    };
    const state = async (id: string) => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))!;
    const owned = (id: string): string => id;

    // ---- a running agent: a dirty checkout refuses a refresh and nothing changes --------------------------------------------------
    const A = await attemptFor();
    const where = await m.checkoutFor(A.task);
    const tick1 = await c.dispatch.dispatcher.tick();
    assert.deepEqual(tick1.started, [A.attempt], JSON.stringify({ s: tick1.skipped, f: tick1.failures }));
    await inTurn[0];
    await writeFile(join(m.shared, "src", "c.ts"), "export const c = 1;\n"); sh(m.shared, "add", "-A"); sh(m.shared, "commit", "-q", "-m", "second");
    await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 2; // the agent's edit\n");
    const sharedBefore = m.state();
    const dirty = await api(c, boot.token, "workspace.request", { operation: "refresh", taskId: A.task, reason: "the base moved" }, "r-dirty");
    assert.equal(dirty.ok, true, JSON.stringify(dirty));
    assert.equal(dirty.result.state, "refused");
    assert.match(dirty.result.summary, /changed or new file/);
    assert.equal(dirty.result.assignee, owned(A.agent), "recorded against the task's assignee");
    assert.equal(m.ran.at(-1)!.assignee, owned(A.agent));
    assert.equal(await readFile(join(where.checkout, "src", "a.ts"), "utf8"), "export const a = 2; // the agent's edit\n", "the agent's work is untouched");
    assert.equal(existsSync(join(where.checkout, "src", "c.ts")), false);
    assert.equal(m.state(), sharedBefore, "the shared repository is untouched");
    assert.deepEqual(told, [], "a refused refresh changes nothing, so the agent is told nothing");
    assert.equal((await state(A.attempt)).frozen, undefined, "the agent is released and runs on");

    // ---- integration: the edit reaches the shared working tree through the bridge; no commit ----------------------------------------
    const head = sh(m.shared, "rev-parse", "HEAD");
    const integ = await api(c, boot.token, "workspace.request", { operation: "integration", taskId: A.task, reason: "ready to share" }, "r-int");
    assert.equal(integ.result.state, "done", JSON.stringify(integ));
    assert.equal(integ.result.detail.written, 1);
    assert.equal(await readFile(join(m.shared, "src", "a.ts"), "utf8"), "export const a = 2; // the agent's edit\n");
    assert.equal(sh(m.shared, "rev-parse", "HEAD"), head, "integration makes no commit");
    assert.equal(told.length, 1);
    assert.match(told[0]!, /integrated into the shared workspace/);
    assert.deepEqual(integ.result.told, [A.attempt]);
    // The same command again is the recorded answer: the host is not asked, the agent not told again.
    const asked = m.ran.length;
    assert.equal((await api(c, boot.token, "workspace.request", { operation: "integration", taskId: A.task, reason: "ready to share" }, "r-int")).result.replayed, true);
    assert.equal(m.ran.length, asked);
    assert.equal(told.length, 1);

    // ---- refresh of a clean checkout: it moves, the agent is told --------------------------------------------------------------------
    await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 1;\n");
    const fresh = await api(c, boot.token, "workspace.request", { operation: "refresh", taskId: A.task, reason: "the base moved" }, "r-fresh");
    assert.equal(fresh.result.state, "done", JSON.stringify(fresh));
    assert.equal(await readFile(join(where.checkout, "src", "c.ts"), "utf8"), "export const c = 1;\n");
    assert.equal(told.length, 2);
    assert.match(told[1]!, /was refreshed.*read them again/);

    // ---- quarantine: the checkout goes to the owner-only root, the attempt is stopped, the task is left as it is -----------------------
    await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 3; // unsaved\n");
    const quar = await api(c, boot.token, "workspace.request", { operation: "quarantine", taskId: A.task, reason: "odd edit" }, "r-quar");
    assert.equal(quar.result.state, "done", JSON.stringify(quar));
    assert.deepEqual(quar.result.stopped, [A.attempt]);
    assert.equal((await state(A.attempt)).state, "finished");
    assert.equal(existsSync(where.checkout), false);
    assert.equal(await readFile(join(where.quarantineRoot, quar.result.detail.quarantineId, "content", "src", "a.ts"), "utf8"), "export const a = 3; // unsaved\n");
    assert.equal(existsSync(where.gitDir), true);
    // No live attempt now, and two hosts could do this: the task's last placement names the host, so the answer is the host's own (the checkout is gone), not "no host".
    const gone = await api(c, boot.token, "workspace.request", { operation: "refresh", taskId: A.task, reason: "again" }, "r-gone");
    assert.equal(gone.result.state, "refused");
    assert.match(gone.result.summary, /not on this host/);

    // ---- an attempt that starts while an operation runs waits for it ------------------------------------------------------------------
    const B = await attemptFor();
    await m.checkoutFor(B.task);
    // Run B once so its last placement is on this host, then let it go.
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [B.attempt]);
    await inTurn[1];
    await c.dispatch.dispatcher.stop(c.dispatch.principal, B.attempt, { emergency: true, reason: "test" });
    const B2 = await attemptFor(B.task);
    let release!: () => void; gate = new Promise<void>((ok) => { release = ok; });
    const inHost = new Promise<void>((ok) => { entered = ok; });
    const busy = api(c, boot.token, "workspace.request", { operation: "refresh", taskId: B.task, reason: "while it waits" }, "r-busy");
    await inHost;
    const held = await c.dispatch.dispatcher.tick();
    assert.deepEqual(held.started, [], "the waiting attempt is not started while the operation runs");
    assert.ok(held.waiting.includes(B2.attempt));
    release(); gate = undefined;
    assert.equal((await busy).result.state, "done");
    // The attempt now waits (it holds a record, no host is pinned): the checkout's host is not guessed, although this host was the task's last placement and is the only one connected.
    const waitingAsk = await api(c, boot.token, "workspace.request", { operation: "refresh", taskId: B.task, reason: "while an attempt waits" }, "r-waiting");
    assert.equal(waitingAsk.result.state, "refused");
    assert.match(waitingAsk.result.summary, /no host that can do this holds the checkout/);
    const go = await c.dispatch.dispatcher.tick();
    assert.deepEqual(go.started, [B2.attempt], "and it starts when the operation has ended");
    await inTurn[2];
    for (const f of finishes) f();
    await c.dispatch.dispatcher.idle();
  } finally { for (const f of finishes) f(); await c.close(); try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to open */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});

test("remote host: the same requests cross the authenticated transport to a worker that holds the checkout and come back with the same typed outcomes; duplicated, dropped and delayed messages and a silent host (card H12m)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-h12m-r-"));
  const m = await machine(dir, "pc");
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      remote: { blobDirectory: join(dir, "blobs"), hosts: [{ hostId: "host:pc", checkpointWaitMs: 500, pollMs: 10, workspaceWaitMs: 2500, resources: { cpus: 1, memoryMb: 256 }, requirements: () => ({ data: "cloud-allowed" as const, harness: "pi" }) }] },
    },
  });
  let pumping = true;
  let holdAnswers = false;
  let pump: Promise<void> = Promise.resolve();
  try {
    assert.ok(c.dispatch?.workerUrl !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    const project = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await c.services.principals.enroll(owner, { commandId: "e-pc", kind: "host", name: "pc", grants: [] });
    const token = (await c.services.principals.issueCredential(owner, "host:pc")).token;
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-pc", actor: owner.id, host: "host:pc", capacity: { cpus: 8, memoryMb: 16_384 } });
    const client = new RemoteWorkerClient({ url: c.dispatch.workerUrl!, token, workerVersion: "worker-9.1.0" });
    await client.connect(CAPS as never);
    await client.heartbeat(1);
    // The worker's side of answering is the real responder over a client whose first answer for a request is dropped once (the network lost it).
    const dropped = new Set<string>();
    let answerCalls = 0;
    const flaky = { answerWorkspace: async (requestId: string, outcome: Parameters<typeof client.answerWorkspace>[1]) => { answerCalls++; if (!dropped.has(requestId)) { dropped.add(requestId); throw new Error("the connection broke"); } await client.answerWorkspace(requestId, outcome); } };
    const responder = new WorkspaceResponder({ client: flaky, port: m.port });

    let n = 0;
    const agent = `agt-${"a".repeat(20)}`;
    await c.services.principals.enroll(owner, { commandId: "e-a", kind: "agent", name: agent, grants: workGrants(project, ["read-file"]) });
    const task = (await c.services.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Dig" })).id;
    await c.services.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await c.services.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
    const a = (await c.services.assignments.getAssignment(task))!;
    const attemptId = (await c.services.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    const where = await m.checkoutFor(task);
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [attemptId]);
    const offer = (await client.offers()).find((o) => o.order.attemptId === attemptId)!;
    const attempt = client.attempt(attemptId, offer.placement);
    await attempt.accept();
    const told: string[] = [];
    let after = 0; let seq = 0;
    // The remote worker's loop: answers the controller's control messages (a checkpoint when asked, what it is told) and reads its workspace requests.
    pump = (async () => {
      while (pumping) {
        try {
          try { for (const msg of await attempt.pollControl(after)) { after = Math.max(after, msg.seq); if (msg.kind === "checkpoint") await attempt.putCheckpoint(++seq, { turn: seq }); if (msg.kind === "tell") told.push(msg.text); } } catch { /* the attempt is over: nothing to answer */ }
          if (!holdAnswers) { const requests = await client.workspaceRequests(); if (requests.length > 0) { responder.handle(requests); responder.handle(requests); } }
        } catch { /* the next round tries again */ }
        await new Promise((ok) => setTimeout(ok, 15));
      }
    })();
    const request = (operation: string, commandId: string, reason = "the base moved", taskId = task) => api(c, boot.token, "workspace.request", { operation, taskId, reason }, commandId);

    // A dirty checkout refuses a refresh, exactly as on the local host, and nothing changes.
    await writeFile(join(m.shared, "src", "c.ts"), "export const c = 1;\n"); sh(m.shared, "add", "-A"); sh(m.shared, "commit", "-q", "-m", "second");
    await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 2; // the agent's edit\n");
    const sharedBefore = m.state();
    const dirty = await request("refresh", "x-dirty");
    assert.equal(dirty.result.state, "refused");
    assert.match(dirty.result.summary, /changed or new file/);
    assert.equal(dirty.result.assignee, agent);
    assert.equal(m.ran.length, 1, "the host was asked once although the request was listed and handled twice, and its first answer was lost on the way");
    assert.ok(answerCalls >= 2, "the lost answer was sent again without running the request again");
    assert.equal(m.state(), sharedBefore);
    assert.equal(await readFile(join(where.checkout, "src", "a.ts"), "utf8"), "export const a = 2; // the agent's edit\n");

    // Integration over the transport: the agent's edit reaches the shared working tree on the worker's machine; no commit.
    const head = sh(m.shared, "rev-parse", "HEAD");
    const integ = await request("integration", "x-int", "ready to share");
    assert.equal(integ.result.state, "done", JSON.stringify(integ));
    assert.deepEqual([integ.result.detail.written, integ.result.detail.kept], [1, 0]);
    assert.equal(await readFile(join(m.shared, "src", "a.ts"), "utf8"), "export const a = 2; // the agent's edit\n");
    assert.equal(sh(m.shared, "rev-parse", "HEAD"), head);
    for (let i = 0; i < 100 && told.length < 1; i++) await new Promise((ok) => setTimeout(ok, 20));
    assert.match(told[0] ?? "", /integrated into the shared workspace/, "the agent is told over the control channel");
    // The same command is the recorded answer; the worker is not asked again.
    const ranBefore = m.ran.length;
    assert.equal((await request("integration", "x-int", "ready to share")).result.replayed, true);
    assert.equal(m.ran.length, ranBefore);

    // Refresh of a clean checkout.
    await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 1;\n");
    const fresh = await request("refresh", "x-fresh");
    assert.equal(fresh.result.state, "done", JSON.stringify(fresh));
    assert.equal(await readFile(join(where.checkout, "src", "c.ts"), "utf8"), "export const c = 1;\n");

    // A worker that does not answer in time: the request is recorded as failed (it may have been carried out), the ask is withdrawn and the worker, coming back, does not start it.
    holdAnswers = true;
    const silent = await request("refresh", "x-silent", "while the worker is away");
    assert.equal(silent.result.state, "failed", JSON.stringify(silent));
    assert.match(silent.result.summary, /did not answer/);
    const askedBefore = m.ran.length;
    holdAnswers = false;
    for (let i = 0; i < 10; i++) await new Promise((ok) => setTimeout(ok, 30));
    assert.equal(m.ran.length, askedBefore, "a withdrawn request is never started later");
    assert.equal((await state(c, attemptId))?.frozen, undefined, "the attempt is not left frozen");

    // Quarantine over the transport: the checkout moves on the worker's machine and the attempt is stopped.
    await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 3; // unsaved\n");
    const quar = await request("quarantine", "x-quar", "odd edit");
    assert.equal(quar.result.state, "done", JSON.stringify(quar));
    assert.deepEqual(quar.result.stopped, [attemptId]);
    assert.equal(existsSync(where.checkout), false);
    assert.equal(await readFile(join(where.quarantineRoot, quar.result.detail.quarantineId, "content", "src", "a.ts"), "utf8"), "export const a = 3; // unsaved\n");
    // No live attempt: the host of the task's last placement is asked and says the checkout is gone.
    const gone = await request("refresh", "x-gone");
    assert.equal(gone.result.state, "refused");
    assert.match(gone.result.summary, /not on this host/);
    void n;
  } finally {
    pumping = false; await pump;
    await c.close();
    try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to open */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
  async function state(ctl: typeof c, id: string) { return ctl.dispatch!.dispatcher.get(ctl.dispatch!.principal, id); }
});
