import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService, HostService, LocalWorker, startController, type WorkerHost } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces } from "@nimblenewt/worker";

// Card H12n, end to end through startController with no `landing` or `stage` of the composer's own: the agent's work.end { submit: true } is checked and staged by the host that holds its checkout (the local worker over the
// worker package's checkout layout, a real git repository). A submit whose base is stale but whose files the landing branch did not touch opens one code submission carrying the checkout's real base, staged tree and git's stable
// patch ID; a submit whose base is stale where the landing branch changed one of the agent's files is refused at once with the head commit and that file; a plain end of the same attempt is never refused.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ext4 = async () => ({ type: "ext4", network: false });
const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as const;
const api = async (c: { api: { handle(token: string, req: never): Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>, commandId?: string) =>
  (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };
const until = async (ok: () => boolean | Promise<boolean>, why: string): Promise<void> => { const end = Date.now() + 60_000; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await new Promise((r) => setTimeout(r, 25)); } };

test("work.end { submit: true } is checked and staged by the host that holds the checkout: a stale base with no overlap submits the real tree and patch ID; an overlapping one is refused with the head and the file; a plain end is not (card H12n)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-h12n-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: () => shared, busy: () => [] });
  const finishes: (() => void)[] = [];
  const started = new Map<string, Promise<void>>();
  const starters = new Map<string, () => void>();
  const credentials = new Map<string, string>();
  let local: LocalWorker | undefined;
  const head = (): string => sh(shared, "rev-parse", "HEAD");
  const advance = async (files: Record<string, string>): Promise<string> => {
    for (const [path, content] of Object.entries(files)) { await mkdir(join(shared, path, ".."), { recursive: true }); await writeFile(join(shared, path), content); }
    sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "moved"); return head();
  };
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined,
        build: () => {
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, version: "w-1", capabilities: () => CAPS,
            workspace: ws.port,
            // The host's side of a submit (card H12n): the same checkout layout the attempt works in.
            submitView: (scope) => ws.submitView(scope),
            stage: (scope) => ws.stageWork(scope),
            sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
            runtimes: { open: async (order) => {
              credentials.set(order.attemptId, order.credential);
              starters.get(order.attemptId)?.();
              let finish!: () => void; const over = new Promise<void>((ok) => { finish = ok; }); finishes.push(finish);
              return { run: async () => { await over; return { status: "completed", text: "done" }; }, checkpoint: async () => ({}), tell: async () => undefined, close: async () => undefined };
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
    await AdmissionService.withEpoch(c.storage, c.epoch).setCapacity({ commandId: "cap-w1", actor: owner.id, host: "host:w1", capacity: { cpus: 2, memoryMb: 2048 } });
    await local!.register(HostService.withEpoch(c.storage, c.epoch, s.assignments), self);
    const agent = ((await s.agents.create(owner, { commandId: "mk-1", friendlyName: "Ann", roles: ["author"] })) as { id: string }).id;
    for (const g of workGrants(project, ["read-file"])) await s.grants.grant(owner, { commandId: `g-${g.action}`, grantee: `agent:${agent}`, action: g.action, project, source: "direct", basis: "test" } as never);
    const admit = async (n: number): Promise<{ task: string; attempt: string }> => {
      const task = (await s.projects.createTask({ commandId: `t${n}`, actor: owner.id, projectId: project, title: `Dig ${n}` })).id;
      await s.projects.transitionTask({ commandId: `r${n}`, actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
      await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: task, owner: { kind: "agent", id: agent } });
      const a = (await s.assignments.getAssignment(task))!;
      const attempt = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent }, harness: "pi" })).id;
      started.set(attempt, new Promise<void>((ok) => { starters.set(attempt, ok); }));
      return { task, attempt };
    };
    const one = await admit(1);
    const two = await admit(2);
    const base = head();
    const where1 = (await ws.ensure({ taskId: one.task, projectId: project }));
    const where2 = (await ws.ensure({ taskId: two.task, projectId: project }));
    assert.deepEqual([...(await c.dispatch.dispatcher.tick()).started].sort(), [one.attempt, two.attempt].sort());
    await started.get(one.attempt); await started.get(two.attempt);

    // Both agents change src/a.ts (not committed: they cannot commit in this layout); one also adds a file.
    await writeFile(join(where1.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(where1.checkout, "src", "b.ts"), "export const b = 1;\n");
    await writeFile(join(where2.checkout, "src", "a.ts"), "export const a = 3;\n");
    // The landing branch moves in a file neither touched: stale, no overlap.
    const moved = await advance({ "README.md": "hello again\n" });
    assert.notEqual(moved, base);

    // The first agent submits: accepted, completed by the sweep, one code submission with the checkout's real base, staged tree and patch ID.
    const ended = await api(c, credentials.get(one.attempt)!, "work.end", { attemptId: one.attempt, submit: true, result: "done", report: "did the work; found nothing; left nothing; could not do nothing" }, "we-1");
    assert.equal(ended.ok, true, JSON.stringify(ended));
    await until(async () => { await c.dispatch!.dispatcher.tick(); return (await s.workEnd.get(one.attempt))?.state === "done"; }, "the ending was not completed");
    const rec = (await s.workEnd.get(one.attempt))!;
    assert.equal(rec.outcome, "submitted", JSON.stringify(rec));
    const sub = await api(c, boot.token, "submission.get", { submissionId: rec.submissionId });
    assert.equal(sub.ok, true, JSON.stringify(sub));
    const g = (...args: string[]): string => execFileSync("git", ["--git-dir", where1.gitDir, "--work-tree", where1.checkout, ...args], { encoding: "utf8" }).trim();
    const patch = execFileSync("git", ["patch-id", "--stable"], { input: execFileSync("git", ["--git-dir", where1.gitDir, "diff", "--cached", "--binary", "--full-index", base], { encoding: "utf8" }), encoding: "utf8" }).trim().split(/\s+/)[0];
    assert.deepEqual([sub.result.item.kind, sub.result.item.role, sub.result.item.base, sub.result.item.tree, sub.result.item.patchId], ["code", "author", base, g("write-tree"), patch], "the submission carries what the host staged");
    assert.equal(g("diff", "--cached", "--name-only", base), "src/a.ts\nsrc/b.ts");

    // Now the landing branch changes src/a.ts: the second agent's submit is refused with the head commit and the overlapping file, and nothing is recorded.
    const overlapped = await advance({ "src/a.ts": "export const a = 10;\n" });
    const refused = await api(c, credentials.get(two.attempt)!, "work.end", { attemptId: two.attempt, submit: true, result: "done", report: "did the work; found nothing; left nothing; could not do nothing" }, "we-2");
    assert.equal(refused.ok, false);
    assert.equal(refused.error?.code, "invalid_command");
    assert.match(refused.error!.message, new RegExp(`submit refused: the landing branch moved to ${overlapped} and changed 1 of your files \\(src/a\\.ts\\)`));
    assert.equal(await s.workEnd.get(two.attempt), undefined, "a refused submit records no ending");
    // A plain end is never refused for freshness.
    const plain = await api(c, credentials.get(two.attempt)!, "work.end", { attemptId: two.attempt, result: "done", report: "did the work; found nothing; left nothing; could not do nothing" }, "we-3");
    assert.equal(plain.ok, true, JSON.stringify(plain));
    await until(async () => { await c.dispatch!.dispatcher.tick(); return (await s.workEnd.get(two.attempt))?.state === "done"; }, "the plain ending was not completed");
    assert.notEqual((await s.workEnd.get(two.attempt))!.outcome, "submitted");
    for (const f of finishes) f();
    await c.dispatch.dispatcher.idle();
  } finally { for (const f of finishes) f(); await c.close(); try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to open */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
