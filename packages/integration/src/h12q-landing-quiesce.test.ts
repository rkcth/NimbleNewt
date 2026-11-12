import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService, HostService, LocalWorker, startController, type WorkerHost } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces } from "@nimblenewt/worker";

// Card H12q, end to end through startController: a landing asked for through workspace.request waits for the running attempt's call in flight to settle, is carried out by the production workspace port
// (LocalWorkspaces, with the local worker's own view of which attempts are busy), and an attempt of the task cannot start while it runs.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ext4 = async () => ({ type: "ext4", network: false });
const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as const;
const api = async (c: { api: { handle(token: string, req: never): Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>, commandId?: string) =>
  (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };

test("landing waits for the running attempt's call in flight to settle, is done by the production workspace port on the landing branch's head, and holds back a new attempt of the task (card H12q)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-h12q-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  let local: LocalWorker | undefined;
  const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: () => shared, busy: () => local?.busyAttempts() ?? [], landing: () => ({ branch: "main", requirePermit: false }) });
  // What happened at the host, in order.
  const log: string[] = [];
  let callEnded = false;
  let callStarted!: () => void; const inCall = new Promise<void>((ok) => { callStarted = ok; });
  let busyInCall: string[] = [];
  let gate: Promise<void> | undefined; let entered: (() => void) | undefined;
  const finishes: (() => void)[] = [];
  const turns: Promise<void>[] = [];
  let opened = 0;
  let projectId = "";
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined,
        build: () => {
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, version: "w-1", capabilities: () => CAPS,
            workspace: { run: async (call) => { log.push(`host:${call.operation}:callEnded=${callEnded}`); entered?.(); if (gate !== undefined) await gate; return ws.port.run(call); } },
            sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
            runtimes: { open: async (_order, call) => {
              const first = opened++ === 0;
              let started!: () => void; turns.push(new Promise<void>((ok) => { started = ok; }));
              let finish!: () => void; const over = new Promise<void>((ok) => { finish = ok; }); finishes.push(finish);
              return { run: async () => {
                if (first) {
                  // A call in flight when the landing is asked for: it ends only when the quiesce tells it to stop.
                  void call({ callId: "w1", tool: { name: "read-file", version: "1" }, args: {} }, { kind: "local", run: async (signal) => { callStarted(); await new Promise<void>((r) => signal.addEventListener("abort", () => r(), { once: true })); callEnded = true; return { text: "stopped" }; } }).then((r) => { log.push(`call:${JSON.stringify(r).slice(0, 200)}`); }, (e) => { log.push(`callerr:${(e as Error).message}`); });
                }
                started(); await over; return { status: "completed", text: "done", endKind: "normal" };
              }, checkpoint: async () => ({}), tell: async (text: string) => { log.push(`told:${text}`); }, close: async () => undefined };
            } },
          });
          return local as WorkerHost;
        },
      },
    },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const boot = await c.services.principals.bootstrapOwner({ name: "rob" });
    const owner = await c.services.principals.authenticate(boot.token);
    projectId = (await c.services.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await c.services.principals.enroll(owner, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
    const self = await c.services.principals.authenticate((await c.services.principals.issueCredential(owner, "host:w1")).token);
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 1, memoryMb: 1024 } });
    await local!.register(HostService.withEpoch(c.storage, c.epoch, c.services.assignments), self);
    // The tool call of the attempt is judged against the routing table (the attempt's route must still be eligible).
    await c.services.routing.setTable(owner, { commandId: "rt", expectedRevision: 0, table: { providers: { cloud: { enabled: true, paid: true, location: "cloud" }, other: { enabled: true, paid: true, location: "cloud" } }, routes: { "cloud/small": { contextTokens: 128_000, capabilities: ["tools"] }, "other/backup": { contextTokens: 128_000, capabilities: ["tools"] } }, profiles: { main: ["cloud/small", "other/backup"] }, roles: { coordinator: "main", "safety-supervisor": "main" } } as never });
    let n = 0;
    const attemptFor = async (taskId?: string) => {
      n++;
      const agent = `agt-${String.fromCharCode(96 + n).repeat(20)}`;
      await c.services.principals.enroll(owner, { commandId: `e-${n}`, kind: "agent", name: agent, grants: workGrants(projectId, ["read-file"]) });
      const task = taskId ?? (await c.services.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId, title: `Dig ${n}` })).id;
      if (taskId === undefined) {
        await c.services.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
        await c.services.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
      }
      const a = (await c.services.assignments.getAssignment(task))!;
      const attempt = (await c.services.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: a.owner ?? { kind: "agent", id: agent }, harness: "pi" })).id;
      return { task, attempt };
    };
    const state = async (id: string) => (await c.dispatch!.dispatcher.get(c.dispatch!.principal, id))!;

    // ---- a running attempt with a call in flight; its work is committed in the checkout ----------------------------------------------
    const A = await attemptFor();
    const made = await ws.ensure({ taskId: A.task, projectId });
    const inCheckout = ["--git-dir", made.gitDir, "--work-tree", made.checkout];
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 2; // the agent's work\n");
    sh(made.checkout, ...inCheckout, "add", "-A"); sh(made.checkout, ...inCheckout, "commit", "-q", "-m", "agent work");
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [A.attempt]);
    await turns[0];
    let giveUp: NodeJS.Timeout | undefined;
    try { await Promise.race([inCall, new Promise<void>((_, no) => { giveUp = setTimeout(() => no(new Error(`the call never started: ${log.join(" | ")}`)), 5000); })]); } finally { clearTimeout(giveUp); }
    busyInCall = await local!.busyAttempts();
    assert.deepEqual(busyInCall, [A.attempt], "the local worker reports the attempt with a call in flight as busy");
    const head = sh(shared, "rev-parse", "HEAD");
    // A landing is made under the project's integrator lease on the owner's landing branch (card P10).
    const named = await api(c, boot.token, "project.branches.change", { project: projectId, landing: "main" }, "branch-main");
    assert.equal(named.ok, true, JSON.stringify(named));
    const taken = await api(c, boot.token, "integrator.lease.acquire", { taskId: A.task, branch: "main", ttlMs: 3_600_000, holder: "agt-integrator" }, "lease-main");
    assert.equal(taken.ok, true, JSON.stringify(taken));
    const lease = { leaseId: taken.result.item.leaseId as string, fence: taken.result.item.fence as number };

    const landing = await api(c, boot.token, "workspace.request", { operation: "landing", taskId: A.task, reason: "reviewed and ready", ...lease }, "land-1");
    assert.equal(landing.ok, true, JSON.stringify(landing));
    assert.equal(landing.result.state, "done", JSON.stringify(landing));
    assert.equal(landing.result.detail.landed, true);
    assert.deepEqual(log.filter((l) => l.startsWith("host:")), ["host:landing:callEnded=true"], "the host was asked only after the call in flight had ended");
    assert.equal(await readFile(join(shared, "src", "a.ts"), "utf8"), "export const a = 2; // the agent's work\n");
    assert.equal(sh(shared, "rev-parse", "HEAD"), head, "landing makes no commit");
    assert.deepEqual(landing.result.quietAttempts, [A.attempt]);
    assert.deepEqual(landing.result.told, [A.attempt]);
    assert.ok(log.some((l) => /landed on the landing branch/.test(l)), "the running agent is told its work was landed");
    assert.equal((await state(A.attempt)).frozen, undefined, "the attempt is released and goes on");
    assert.deepEqual(await local!.busyAttempts(), [], "and nothing is in flight now");

    // ---- the landing branch moves: a second landing of work based on the old head is refused and writes nothing ---------------------
    // The landed file waits, uncommitted, in the shared tree: until the integrator commits it no landing is made (and the head has not moved, so the head alone would not have said so).
    const waiting = await api(c, boot.token, "workspace.request", { operation: "landing", taskId: A.task, reason: "too early", ...lease }, "land-1b");
    assert.equal(waiting.result.state, "refused", JSON.stringify(waiting));
    assert.match(waiting.result.summary, /uncommitted file/);
    sh(shared, "add", "src/a.ts"); sh(shared, "commit", "-q", "-m", "integrator commits the landed file");
    const committed = sh(shared, "rev-parse", "HEAD");
    assert.notEqual(committed, head, "the landing branch really has a new commit");
    await writeFile(join(shared, "src", "c.ts"), "export const c = 1;\n");
    sh(shared, "add", "src/c.ts"); sh(shared, "commit", "-q", "-m", "second");
    assert.notEqual(sh(shared, "rev-parse", "HEAD"), committed);
    await writeFile(join(made.checkout, "src", "a.ts"), "export const a = 3;\n");
    sh(made.checkout, ...inCheckout, "add", "-A"); sh(made.checkout, ...inCheckout, "commit", "-q", "-m", "more work");
    const sharedBefore = [sh(shared, "rev-parse", "HEAD"), sh(shared, "status", "--porcelain=v1")].join("|");
    const stale = await api(c, boot.token, "workspace.request", { operation: "landing", taskId: A.task, reason: "again", ...lease }, "land-2");
    assert.equal(stale.result.state, "refused", JSON.stringify(stale));
    assert.match(stale.result.summary, /refreshes onto the head first/);
    assert.equal([sh(shared, "rev-parse", "HEAD"), sh(shared, "status", "--porcelain=v1")].join("|"), sharedBefore);
    assert.equal((await state(A.attempt)).frozen, undefined);
    for (const f of finishes) f();
    await c.dispatch.dispatcher.idle();

    // ---- an attempt of the task cannot start while a landing runs -----------------------------------------------------------------
    const B = await attemptFor();
    await ws.ensure({ taskId: B.task, projectId });
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [B.attempt]);
    await turns[1];
    await c.dispatch.dispatcher.stop(c.dispatch.principal, B.attempt, { emergency: true, reason: "test" });
    const B2 = await attemptFor(B.task);
    let release!: () => void; gate = new Promise<void>((ok) => { release = ok; });
    const inHost = new Promise<void>((ok) => { entered = ok; });
    const running = api(c, boot.token, "workspace.request", { operation: "landing", taskId: B.task, reason: "while it waits", ...lease }, "land-3");
    await inHost;
    const held = await c.dispatch.dispatcher.tick();
    assert.deepEqual(held.started, [], "the waiting attempt is not started while the landing runs");
    assert.ok(held.waiting.includes(B2.attempt));
    release(); gate = undefined;
    assert.equal((await running).result.state, "done");
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [B2.attempt], "and it starts when the landing has ended");
    await turns[2];
    for (const f of finishes) f();
    await c.dispatch.dispatcher.idle();
    assert.equal(existsSync(join(dir, "work", "journal")), true);
  } finally { for (const f of finishes) f(); await c.close(); try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to open */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
