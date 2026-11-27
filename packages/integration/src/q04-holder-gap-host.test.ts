import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { AdmissionService, HostService, LocalWorker, startController, type WorkerHost } from "@nimblenewt/controller";
import { PI, workGrants } from "@nimblenewt/controller/testing";
import { GitBridge, LocalWorkspaces } from "@nimblenewt/worker";

// Card Q04, the holder gap, end to end (first review): the real checkout layout on real git, handed to each attempt with its attempt ID as the product's local host does (`scripts/local-host.mjs`), and the
// controller's own ending, staging and contributor rule. Two agents on one task: Ann writes the code, Ben holds the task for a review. When Ben's attempt changes nothing, he stays independent across the
// author's next version (the two-agent review loop does not lock itself). When Ben's attempt leaves a file git does not ignore, the next version stages it and Ben becomes a contributor, so his approval of it
// is refused in plain words.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ext4 = async () => ({ type: "ext4", network: false });
const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as const;
const api = async (c: { api: { handle(token: string, req: never): Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>, commandId?: string) =>
  (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };
const until = async (ok: () => boolean | Promise<boolean>, why: string): Promise<void> => { const end = Date.now() + 60_000; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await new Promise((r) => setTimeout(r, 25)); } };
const REPORT = "did the work; found nothing; left nothing; could not do nothing";

test("two agents on one task over the real checkout: a reviewer whose attempt changed nothing may approve the author's next version; one whose attempt left a file that version staged is a contributor and is refused (card Q04)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-q04h-"));
  const shared = join(dir, "shared");
  await mkdir(join(shared, "src"), { recursive: true });
  sh(dir, "init", "-q", "-b", "main", shared);
  await writeFile(join(shared, "README.md"), "hello\n"); await writeFile(join(shared, "src", "a.ts"), "export const a = 1;\n"); await writeFile(join(shared, ".gitignore"), "build/\n");
  sh(shared, "add", "-A"); sh(shared, "commit", "-q", "-m", "first");
  const git = await GitBridge.create({ scratch: join(dir, "scratch") });
  const ws = new LocalWorkspaces({ root: join(dir, "work"), git, shared: () => shared, busy: () => [] });
  const finishes = new Map<string, () => void>();
  const started = new Map<string, Promise<void>>();
  const starters = new Map<string, () => void>();
  const credentials = new Map<string, string>();
  let local: LocalWorker | undefined;
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
            submitView: (scope) => ws.submitView(scope),
            stage: (scope) => ws.stageWork(scope),
            sandbox: { open: async (r) => ({ revision: r.revision, close: async () => undefined }) },
            runtimes: { open: async (order) => {
              credentials.set(order.attemptId, order.credential);
              starters.get(order.attemptId)?.();
              let finish!: () => void; const over = new Promise<void>((ok) => { finish = ok; }); finishes.set(order.attemptId, finish);
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
    const ann = ((await s.agents.create(owner, { commandId: "mk-1", friendlyName: "Ann", roles: ["author"] })) as { id: string }).id;
    const ben = ((await s.agents.create(owner, { commandId: "mk-2", friendlyName: "Ben", roles: ["reviewer"] })) as { id: string }).id;
    for (const who of [ann, ben]) for (const g of workGrants(project, ["read-file"])) await s.grants.grant(owner, { commandId: `g-${who}-${g.action}`, grantee: `agent:${who}`, action: g.action, project, source: "direct", basis: "test" } as never);
    const benToken = (await s.principals.issueCredential(owner, `agent:${ben}`)).token;
    let n = 0;
    /** The task's next attempt by `who` (the task assigned or transferred to that agent first), started by the dispatcher, then its workspace handed out with its attempt ID as the product host does. */
    const attempt = async (task: string, who: string): Promise<{ attempt: string; checkout: string }> => {
      n++;
      const now = await s.assignments.getAssignment(task);
      if (now === undefined) await s.assignments.assignTask({ commandId: `as${n}`, actor: owner.id, taskId: task, owner: { kind: "agent", id: who } });
      else if (now.owner?.id !== who) await s.assignments.transferTask({ commandId: `tr${n}`, actor: owner.id, taskId: task, expectedRevision: now.revision, to: { kind: "agent", id: who }, reason: "review" } as never);
      const a = (await s.assignments.getAssignment(task))!;
      const id = (await s.assignments.admitAttempt({ commandId: `ad${n}`, actor: "inbox", taskId: task, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: who }, harness: "pi" })).id;
      started.set(id, new Promise<void>((ok) => { starters.set(id, ok); }));
      const made = await ws.ensure({ taskId: task, projectId: project, attemptId: id });
      assert.deepEqual([...(await c.dispatch!.dispatcher.tick()).started], [id]);
      await started.get(id);
      return { attempt: id, checkout: made.checkout };
    };
    /** Ends an attempt through work.end (submitting or not); answers the code submission's ID when it submitted. */
    const end = async (id: string, submit: boolean): Promise<string | undefined> => {
      const ended = await api(c, credentials.get(id)!, "work.end", { attemptId: id, submit, result: "done", report: REPORT }, `we-${id}`);
      assert.equal(ended.ok, true, JSON.stringify(ended));
      await until(async () => { await c.dispatch!.dispatcher.tick(); return (await s.workEnd.get(id))?.state === "done"; }, "the ending was not completed");
      finishes.get(id)?.();
      await c.dispatch!.dispatcher.idle();
      const rec = (await s.workEnd.get(id))!;
      if (submit) assert.equal(rec.outcome, "submitted", JSON.stringify(rec));
      return rec.submissionId;
    };
    const review = (task: string, subject: string, key: string) => api(c, benToken, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject, verdict: "approve" }, key);
    const handover = (task: string): { attemptId: string; left: string[]; overflow?: true } => JSON.parse(readFileSync(join(dir, "work", project, task, "handover.json"), "utf8"));

    for (const leaves of [false, true]) {
      const task = (await s.projects.createTask({ commandId: `t-${leaves}`, actor: owner.id, projectId: project, title: leaves ? "Leaves" : "Clean" })).id;
      await s.projects.transitionTask({ commandId: `r-${leaves}`, actor: owner.id, taskId: task, expectedRevision: 1, to: "ready" });
      // Ann's first attempt writes v1 and submits it.
      const a1 = await attempt(task, ann);
      await writeFile(join(a1.checkout, "src", "a.ts"), "export const a = 2;\n");
      const v1 = await end(a1.attempt, true);
      assert.ok(v1 !== undefined);
      // Ben holds the task for the review: his test run writes build output (ignored) and, in the second task, a file git does not ignore. He asks for changes and ends without submitting.
      const b1 = await attempt(task, ben);
      await mkdir(join(b1.checkout, "build"), { recursive: true });
      await writeFile(join(b1.checkout, "build", "out.js"), "built\n");
      if (leaves) await writeFile(join(b1.checkout, "notes.txt"), "the reviewer's scratch notes\n");
      assert.equal((await api(c, benToken, "submission.record", { taskId: task, kind: "review", role: "reviewer", subject: v1, verdict: "changes" }, `rv-c-${leaves}`)).ok, true, "Ben asks for changes");
      await end(b1.attempt, false);
      // Ann's next attempt starts from what Ben left and submits v2.
      const a2 = await attempt(task, ann);
      const h = handover(task);
      assert.deepEqual([h.attemptId, h.left, h.overflow], [a2.attempt, leaves ? [a1.attempt, b1.attempt] : [a1.attempt], undefined], "the host names the attempts that left the checkout changed");
      await writeFile(join(a2.checkout, "src", "a.ts"), "export const a = 3;\n");
      const v2 = await end(a2.attempt, true);
      assert.ok(v2 !== undefined && v2 !== v1);
      const approved = await review(task, v2!, `rv-a-${leaves}`);
      if (!leaves) {
        assert.equal(approved.ok, true, `a reviewer that left nothing may approve the next version: ${JSON.stringify(approved)}`);
      } else {
        assert.equal(approved.ok, false, "the reviewer's file is in v2, so he is a contributor");
        assert.equal(approved.error?.code, "forbidden");
        assert.match(approved.error!.message, /already contributed code to this task, so it cannot approve it; another reviewer has to \(with none left, the owner adds a reviewer agent or drops the review check\)/);
      }
    }
  } finally { for (const f of finishes.values()) f(); await c.close(); try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to open */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
