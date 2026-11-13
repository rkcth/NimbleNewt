import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService, HostService, LocalWorker, startController, type WorkerHost, type WorkspaceCall } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces, type CheckoutLocation } from "@nimblenewt/worker";

// Card H12p, end to end through startController: a running agent (its own task credential, the local worker, a real checkout in a temporary git repository) calls work.refresh. The production workspace port re-applies its
// work onto the landing branch's moved head with no quiesce; conflicts are listed with markers and never resolved; the request is recorded and counted as a round; and the rounds are carried on the code submission the agent's
// work.end { submit } opens.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ext4 = async () => ({ type: "ext4", network: false });
const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as const;
const api = async (c: { api: { handle(token: string, req: never): Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>, commandId?: string) =>
  (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };
const until = async (ok: () => boolean | Promise<boolean>, why: string): Promise<void> => { const end = Date.now() + 60_000; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await new Promise((r) => setTimeout(r, 25)); } };
const lines = (n: number, edit?: [number, string]): string => Array.from({ length: n }, (_, i) => (edit !== undefined && edit[0] === i ? edit[1] : `line ${i}`)).join("\n") + "\n";

test("a running agent refreshes its own checkout through work.refresh: no quiesce, changed and new files survive, conflicts are listed and not resolved, rounds are counted and carried on its submission (card H12p)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-h12p-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n"); await writeFile(join(shared, "doc.txt"), lines(20));
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: () => shared, busy: () => [] });
  const ran: WorkspaceCall[] = [];
  const told: string[] = [];
  const finishes: (() => void)[] = [];
  const inTurn: Promise<void>[] = [];
  const credentials = new Map<string, string>();
  let local: LocalWorker | undefined;
  const head = (): string => sh(shared, "rev-parse", "HEAD");
  const advance = async (files: Record<string, string>): Promise<string> => {
    for (const [path, content] of Object.entries(files)) { await mkdir(join(shared, path, ".."), { recursive: true }); await writeFile(join(shared, path), content); }
    sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "moved"); return head();
  };
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts, filesystem: ext4, features: [], harnesses: [PI],
    // The host's own staging is not under test here: it reports the checkout's base and a fixed tree; the rounds on the submission are.
    landing: async () => ({ base: head(), head: head(), mine: [], landed: [] }),
    stage: async () => ({ base: head(), tree: "b".repeat(40), patchId: "c".repeat(40), files: ["src/a.ts"] }),
    dispatch: {
      manual: true,
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined,
        build: () => {
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, version: "w-1", capabilities: () => CAPS,
            workspace: { run: async (call) => { ran.push(call); return ws.port.run(call); } },
            sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
            runtimes: { open: async (order) => {
              credentials.set(order.attemptId, order.credential);
              let started!: () => void; inTurn.push(new Promise<void>((ok) => { started = ok; }));
              let finish!: () => void; const over = new Promise<void>((ok) => { finish = ok; }); finishes.push(finish);
              return { run: async () => { started(); await over; return { status: "completed", text: "done" }; }, checkpoint: async () => ({}), tell: async (text: string) => { told.push(text); }, close: async () => undefined };
            } },
          });
          return local as WorkerHost;
        },
      },
    },
  });
  try {
    assert.ok(c.dispatch !== undefined, c.dispatchProblem);
    const s = c.services;
    const boot = await s.principals.bootstrapOwner({ name: "rob" });
    const owner = await s.principals.authenticate(boot.token);
    const project = (await s.projects.createProject({ commandId: "p1", actor: owner.id, name: "Garden" })).id;
    await s.principals.enroll(owner, { commandId: "e-w1", kind: "host", name: "w1", grants: [] });
    const self = await s.principals.authenticate((await s.principals.issueCredential(owner, "host:w1")).token);
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 1, memoryMb: 1024 } });
    await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), self);
    // An author-role agent with a task of its own and an admitted attempt.
    const agent = ((await s.agents.create(owner, { commandId: "mk-1", friendlyName: "Ann", roles: ["author"] })) as { id: string }).id;
    for (const g of workGrants(project, ["read-file"])) await s.grants.grant(owner, { commandId: `g-${g.action}`, grantee: `agent:${agent}`, action: g.action, project, source: "direct", basis: "test" } as never);
    const task = (await s.projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "Dig" })).id;
    await s.projects.transitionTask({ commandId: "r1", actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
    await s.assignments.assignTask({ commandId: "as1", actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
    const a = (await s.assignments.getAssignment(task))!;
    const attempt = (await s.assignments.admitAttempt({ commandId: "ad1", actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
    await ws.ensure({ taskId: task, projectId: project });
    const where: CheckoutLocation = ws.locate({ taskId: task, projectId: project })!;
    assert.deepEqual((await c.dispatch.dispatcher.tick()).started, [attempt]);
    await inTurn[0];
    const token = credentials.get(attempt)!;
    assert.ok(token !== undefined && token.length > 0, "the worker was given the attempt's own credential");

    // The agent's work: a changed file that the landing branch will also change, a changed file it will not, and a new file.
    await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 'mine';\n");
    await writeFile(join(where.checkout, "doc.txt"), lines(20, [2, "mine two"]));
    await writeFile(join(where.checkout, "mine.ts"), "export const m = 1;\n");
    const moved = await advance({ "src/a.ts": "export const a = 'landing';\n", "doc.txt": lines(20, [15, "landing fifteen"]), "other.ts": "export const o = 1;\n" });
    const sharedBefore = [head(), sh(shared, "status", "--porcelain=v1"), sh(shared, "for-each-ref")].join("|");

    const first = await api(c, token, "work.refresh", { attemptId: attempt }, "rf-1");
    assert.equal(first.ok, true, JSON.stringify(first));
    const item = first.result.item;
    assert.deepEqual([item.state, item.operation, item.round, item.replayed], ["done", "reapply", 1, false], JSON.stringify(item));
    assert.deepEqual([item.detail.base, item.detail.kept, item.detail.taken, item.detail.merged, item.detail.conflicts], [moved, 1, 1, 1, [{ path: "src/a.ts", kind: "overlap" }]], JSON.stringify(item.detail));
    assert.equal(ran.at(-1)!.operation, "reapply");
    assert.deepEqual(ran.at(-1)!.quietAttempts, [], "no quiesce: nothing was made quiet");
    const st = (await c.dispatch.dispatcher.get(c.dispatch.principal, attempt))!;
    assert.equal(st.frozen, undefined); assert.equal(st.state, "running");
    assert.deepEqual(told, [], "the answer is the telling: the agent is not also told");
    const doc = await readFile(join(where.checkout, "doc.txt"), "utf8");
    assert.ok(doc.includes("mine two") && doc.includes("landing fifteen") && !doc.includes("<<<<<<<"), "a non-overlapping edit in the same file is merged");
    const conflicted = await readFile(join(where.checkout, "src", "a.ts"), "utf8");
    assert.ok(conflicted.includes("<<<<<<< mine") && conflicted.includes("'mine'") && conflicted.includes("'landing'"), "the overlapping edit keeps both sides with markers");
    assert.equal(await readFile(join(where.checkout, "mine.ts"), "utf8"), "export const m = 1;\n");
    assert.equal(await readFile(join(where.checkout, "other.ts"), "utf8"), "export const o = 1;\n");
    assert.equal([head(), sh(shared, "status", "--porcelain=v1"), sh(shared, "for-each-ref")].join("|"), sharedBefore, "the shared repository is only read");

    // The same call again is the recorded answer; the owner reads the record; another operation on the task is not blocked afterwards.
    const asked = ran.length;
    const again = await api(c, token, "work.refresh", { attemptId: attempt }, "rf-1");
    assert.deepEqual([again.ok, again.result.item.replayed, again.result.item.id], [true, true, item.id]);
    assert.equal(ran.length, asked);
    const read = await api(c, boot.token, "workspace.get", { requestId: item.id });
    assert.deepEqual([read.result.item.operation, read.result.item.round, read.result.item.requestedBy], ["reapply", 1, `agent:${agent}`]);

    // At the head already: nothing changes and it is not a round. The agent fixes the conflict itself, the branch moves again: round 2.
    const same = await api(c, token, "work.refresh", { attemptId: attempt }, "rf-2");
    assert.deepEqual([same.result.item.state, same.result.item.detail.changed, same.result.item.round], ["done", false, undefined]);
    await writeFile(join(where.checkout, "src", "a.ts"), "export const a = 'fixed';\n");
    await advance({ "third.ts": "export const t = 1;\n" });
    const second = await api(c, token, "work.refresh", { attemptId: attempt }, "rf-3");
    assert.deepEqual([second.result.item.state, second.result.item.round, second.result.item.detail.conflictCount], ["done", 2, 0], JSON.stringify(second));
    assert.equal(await readFile(join(where.checkout, "src", "a.ts"), "utf8"), "export const a = 'fixed';\n", "the agent's fix survives the refresh");

    // The owner cannot ask for it (it is the author's own tool), and a stranger's attempt is not found.
    assert.equal((await api(c, boot.token, "workspace.request", { operation: "reapply", taskId: task, reason: "refresh it" }, "o-1")).error?.code, "invalid_command");
    assert.equal((await api(c, boot.token, "work.refresh", { attemptId: attempt }, "o-2")).error?.code, "forbidden");
    const mine = await api(c, token, "work.refresh", { attemptId: "att-nope" }, "rf-4");
    assert.equal(mine.error?.code, "not_found");

    // The rounds ride on the submission: two moving refreshes so far.
    const ended = await api(c, token, "work.end", { attemptId: attempt, submit: true, result: "done", report: "did the work; found a conflict; left nothing; could not do nothing" }, "we-1");
    assert.equal(ended.ok, true, JSON.stringify(ended));
    await until(async () => { await c.dispatch!.dispatcher.tick(); return (await s.workEnd.get(attempt))?.state === "done"; }, "the ending was not completed");
    const rec = (await s.workEnd.get(attempt))!;
    assert.equal(rec.outcome, "submitted", JSON.stringify(rec));
    const sub = await api(c, boot.token, "submission.get", { submissionId: rec.submissionId });
    assert.equal(sub.ok, true, JSON.stringify(sub));
    assert.deepEqual([sub.result.item.kind, sub.result.item.refreshRound], ["code", 2]);
    for (const f of finishes) f();
    await c.dispatch.dispatcher.idle();
  } finally { for (const f of finishes) f(); await c.close(); try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to open */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
