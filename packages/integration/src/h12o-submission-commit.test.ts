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

// Card H12o, end to end through startController: an agent's work.end { submit: true } opens a code submission (H12n), a second agent reviews it, and the owner's `workspace.request` release with `submissionId`
// commits exactly the approved tree in the task's own checkout, behind the quiesce, on the host that holds it (the local worker over a real git repository). Before the approval it is refused; asking again answers the
// recorded commit; a host answer lost after the commit is followed by a retry that finds the commit and records it, with one commit made; work changed after the approval is refused.
const hasGit = (() => { try { execFileSync("git", ["--version"], { stdio: "ignore" }); return true; } catch { return false; } })();
const skip = hasGit ? false : "git is not installed";
const sh = (cwd: string, ...args: string[]): string => execFileSync("git", ["-c", "core.hooksPath=/nonexistent-hooks", "-c", "core.autocrlf=false", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" }).trim();
const CAPS = { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] };
const ext4 = async () => ({ type: "ext4", network: false });
const facts = { platform: "linux", arch: "x64", osRelease: "6.8.0-generic", nodeVersion: "22.19.0" } as const;
const api = async (c: { api: { handle(token: string, req: never): Promise<unknown> } }, token: string, op: string, args: Record<string, unknown>, commandId?: string) =>
  (await c.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as { ok: boolean; result?: any; error?: { code: string; message: string } };
const until = async (ok: () => boolean | Promise<boolean>, why: string): Promise<void> => { const end = Date.now() + 60_000; while (!(await ok())) { if (Date.now() > end) assert.fail(why); await new Promise((r) => setTimeout(r, 25)); } };

test("an approved submission is committed once through the release operation on the host that holds the checkout: refused before approval, recorded with the release, found again after a lost answer, refused when the work changed (card H12o)", { skip }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "nn-h12o-"));
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
  // The host's answer to the next release is lost after the host carried it out (a dropped connection), when set.
  let loseNext = false;
  let hostCalls = 0;
  const c = await startController({
    storage: { kind: "sqlite", path: join(dir, "c.sqlite") }, argv: [], env: {}, print: () => undefined, facts, filesystem: ext4, features: [], harnesses: [PI],
    dispatch: {
      manual: true,
      route: async () => ({ route: "cloud/small", harness: "pi", role: "worker", request: { contextTokens: 1000, needs: [], data: "cloud-allowed", paidAuthorized: true } }),
      local: { acceptUnenforcedLimits: true, window: () => 8192, close: async () => undefined,
        build: () => {
          local = new LocalWorker({
            hostId: "host:w1", resources: { cpus: 1, memoryMb: 512 }, version: "w-1", capabilities: () => CAPS,
            workspace: { run: async (call) => { hostCalls++; const out = await ws.port.run(call as never); if (loseNext) { loseNext = false; throw new Error("the connection to the host dropped"); } return out as never; } },
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
    const reviewer = ((await s.agents.create(owner, { commandId: "mk-2", friendlyName: "Rev", roles: ["reviewer"] })) as { id: string }).id;
    for (const who of [agent, reviewer]) for (const g of workGrants(project, ["read-file"])) await s.grants.grant(owner, { commandId: `g-${who}-${g.action}`, grantee: `agent:${who}`, action: g.action, project, source: "direct", basis: "test" } as never);
    const rev = (await s.principals.issueCredential(owner, `agent:${reviewer}`)).token;
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
    const where1 = await ws.ensure({ taskId: one.task, projectId: project });
    const where2 = await ws.ensure({ taskId: two.task, projectId: project });
    assert.deepEqual([...(await c.dispatch.dispatcher.tick()).started].sort(), [one.attempt, two.attempt].sort());
    await started.get(one.attempt); await started.get(two.attempt);
    await writeFile(join(where1.checkout, "src", "a.ts"), "export const a = 2;\n");
    await writeFile(join(where2.checkout, "src", "b.ts"), "export const b = 1;\n");
    const submit = async (x: { task: string; attempt: string }, n: number): Promise<string> => {
      const ended = await api(c, credentials.get(x.attempt)!, "work.end", { attemptId: x.attempt, submit: true, result: "done", report: "did the work; found nothing; left nothing; could not do nothing" }, `we-${n}`);
      assert.equal(ended.ok, true, JSON.stringify(ended));
      await until(async () => { await c.dispatch!.dispatcher.tick(); return (await s.workEnd.get(x.attempt))?.state === "done"; }, "the ending was not completed");
      const rec = (await s.workEnd.get(x.attempt))!;
      assert.equal(rec.outcome, "submitted", JSON.stringify(rec));
      return rec.submissionId!;
    };
    const sub1 = await submit(one, 1);
    const sub2 = await submit(two, 2);
    const git1 = (...args: string[]): string => execFileSync("git", ["--git-dir", where1.gitDir, ...args], { encoding: "utf8" }).trim();
    const git2 = (...args: string[]): string => execFileSync("git", ["--git-dir", where2.gitDir, ...args], { encoding: "utf8" }).trim();
    const base1 = git1("rev-parse", "HEAD");
    const release = (taskId: string, submissionId: string, commandId: string) => api(c, boot.token, "workspace.request", { operation: "release", taskId, reason: "commit the reviewed work", submissionId }, commandId);

    // Not yet reviewed: refused, nothing asked of the host, nothing committed.
    const early = await release(one.task, sub1, "rel-0");
    assert.equal(early.ok, false);
    assert.equal(early.error?.code, "review_invalid", JSON.stringify(early));
    assert.match(early.error!.message, /is not approved \(no reviewer has approved it yet\)/);
    assert.equal(hostCalls, 0);
    // Another task's submission is not this task's.
    assert.equal((await release(one.task, sub2, "rel-x")).error?.code, "not_found");

    // The reviewer approves it; the release commits exactly the submitted tree on the submitted base, once.
    const sub = (await api(c, boot.token, "submission.get", { submissionId: sub1 })).result.item;
    const verdict = await api(c, rev, "submission.record", { taskId: one.task, kind: "review", role: "reviewer", subject: sub1, verdict: "approve" }, "rv-1");
    assert.equal(verdict.ok, true, JSON.stringify(verdict));
    const done = await release(one.task, sub1, "rel-1");
    assert.equal(done.ok, true, JSON.stringify(done));
    const d = done.result.detail;
    assert.equal(done.result.state, "done", done.result.summary);
    assert.deepEqual([d.committed, d.submission, d.recovered, d.parent, d.tree], [true, sub1, false, sub.base, sub.tree]);
    assert.deepEqual(done.result.submission, { id: sub1, base: sub.base, tree: sub.tree, approvedBy: `agent:${reviewer}` });
    assert.equal(git1("rev-parse", "HEAD"), d.commit);
    assert.equal(git1("log", "-1", "--format=%T"), sub.tree);
    assert.match(git1("log", "-1", "--format=%B"), new RegExp(`^NimbleNewt-Submission: ${sub1}$`, "m"));
    const made = (await c.storage.getAggregate({ kind: "submission-commit", id: sub1 }))?.body as { commitId?: string; requestId?: string; recovered?: boolean; permitted?: boolean } | undefined;
    assert.deepEqual([made?.commitId, made?.requestId, made?.recovered], [d.commit, done.result.id, false]);
    // A reviewer other than the author approved it, so the commit is a review-gate permit commit (card H12o, permit slice): the permit's marks, a line in the host's permit ledger, so a landing that requires the
    // permit (this host's default policy) no longer refuses it; the record keeps what the host confirmed.
    assert.deepEqual([d.permitted, d.permitRequiredToLand, made?.permitted], [true, false, true]);
    assert.match(git1("log", "-1", "--format=%B"), new RegExp(`^NimbleNewt-Request: ${done.result.id}$`, "m"));
    assert.deepEqual(await git.unpermitted({ gitDir: where1.gitDir, taskId: one.task }), []);
    // Asked again: the recorded commit, the host not asked, no second commit.
    const calls = hostCalls;
    const again = await release(one.task, sub1, "rel-2");
    assert.deepEqual([again.result.state, again.result.detail.alreadyRecorded, again.result.detail.commit], ["done", true, d.commit]);
    assert.equal(hostCalls, calls);
    assert.equal(git1("rev-list", "--count", `${base1}..HEAD`), "1");

    // Task two: approved, then a stray file appears in the checkout: refused, nothing committed.
    const sub2Body = (await api(c, boot.token, "submission.get", { submissionId: sub2 })).result.item;
    assert.equal((await api(c, rev, "submission.record", { taskId: two.task, kind: "review", role: "reviewer", subject: sub2, verdict: "approve" }, "rv-2")).ok, true);
    const base2 = git2("rev-parse", "HEAD");
    await writeFile(join(where2.checkout, "src", "stray.ts"), "export const s = 1;\n");
    const stale = await release(two.task, sub2, "rel-3");
    assert.equal(stale.result.state, "refused");
    assert.match(stale.result.summary, /no longer holds the approved work of submission .*its files changed/);
    assert.equal(git2("rev-parse", "HEAD"), base2);
    // The stray file goes; the host commits and its answer is lost: the request failed and no commit is recorded.
    rmSync(join(where2.checkout, "src", "stray.ts"));
    loseNext = true;
    const lost = await release(two.task, sub2, "rel-4");
    assert.equal(lost.result.state, "failed", JSON.stringify(lost.result));
    assert.equal(await c.storage.getAggregate({ kind: "submission-commit", id: sub2 }), undefined);
    const committed = git2("rev-parse", "HEAD");
    assert.notEqual(committed, base2, "the host did commit");
    // The retry finds that commit and records it: one commit for the submission.
    const retry = await release(two.task, sub2, "rel-5");
    assert.deepEqual([retry.result.state, retry.result.detail.commit, retry.result.detail.recovered], ["done", committed, true]);
    assert.equal(git2("rev-list", "--count", `${base2}..HEAD`), "1");
    assert.equal(git2("log", "-1", "--format=%T"), sub2Body.tree);
    const made2 = (await c.storage.getAggregate({ kind: "submission-commit", id: sub2 }))?.body as { commitId?: string; recovered?: boolean; permitted?: boolean } | undefined;
    assert.deepEqual([made2?.commitId, made2?.recovered, made2?.permitted], [committed, true, true]);
    assert.deepEqual(await git.unpermitted({ gitDir: where2.gitDir, taskId: two.task }), []);
    for (const f of finishes) f();
    await c.dispatch.dispatcher.idle();
  } finally { for (const f of finishes) f(); await c.close(); try { execFileSync("chmod", ["-R", "u+rwX", dir]); } catch { /* nothing to open */ } rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
});
