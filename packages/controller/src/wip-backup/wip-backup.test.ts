import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { WIP_LIMITS, WipBackupService, remoteProblem, wipRefOf, type WipBackupCall, type WipBackupOutcome, type WipReport } from "./index.js";

after(stopServer);

// Card P02b, on every storage backend: the backup is off by default, the owner's turning it on records one standing approval for exactly one remote and the project's own namespace, a failed push is never a backup,
// and the controller pushes nowhere that approval does not cover.
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const refuses = async (code: string, run: () => Promise<unknown>): Promise<DomainError> => {
  let seen: unknown;
  await assert.rejects(run, (error: unknown) => { seen = error; assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
  return seen as DomainError;
};

for (const backend of backends) {
  const suite = (name: string, body: (c: { svc: WipBackupService; owner: Principal; agent: Principal; project: string; other: string; clock: { ms: number }; protectedBranches: Set<string> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const clock = { ms: T0 };
        const options = { clock: () => new Date(clock.ms).toISOString(), pause: async () => undefined };
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [] });
        const agent = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
        const project = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "Garden" })).id;
        const other = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "Orchard" })).id;
        const protectedBranches = new Set<string>();
        const svc = WipBackupService.withEpoch(world.storage, projects.epoch, { ...options, branches: { isProtected: async (_p, branch) => branch !== undefined && protectedBranches.has(branch) } });
        await body({ svc, owner, agent, project, other, clock, protectedBranches });
      } finally { await world.close(); }
    });

  const REMOTE = "/backups/garden.git";
  /** A scripted host: answers each task's backup from a queue, records every call. */
  const host = (answers: (call: WipBackupCall, n: number) => WipBackupOutcome | Error) => {
    const calls: WipBackupCall[] = [];
    return { calls, port: { backup: async (call: WipBackupCall) => { calls.push(call); const r = answers(call, calls.length); if (r instanceof Error) throw r; return r; } } };
  };
  const good = (commitId: string, more: Record<string, unknown> = {}): WipBackupOutcome => ({ ok: true, summary: "Backed up", detail: { commitId, tree: "t".repeat(40), files: 3, unchanged: false, blocked: [], ...more } });
  const tasks = (...ids: string[]) => async () => ids.map((taskId) => ({ taskId, developer: "agent:ann", executor: "host:one" }));

  suite("it is off by default: no record, nothing pushed, and only the owner can read or change it", async ({ svc, owner, agent, project }) => {
    const view = await svc.get(owner, project);
    assert.deepEqual([view.revision, view.enabled, view.tasks.length], [0, false, 0]);
    const h = host(() => good(COMMIT_A));
    assert.deepEqual(await svc.sweep(owner, { port: h.port, tasks: tasks("task-one") }), { attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
    assert.equal(h.calls.length, 0, "a project that never turned it on is never backed up");
    await refuses("forbidden", () => svc.get(agent, project));
    await refuses("forbidden", () => svc.set(agent, { commandId: cid("s"), projectId: project, enabled: true, remote: REMOTE }));
    await refuses("forbidden", () => svc.sweep(agent, { port: h.port, tasks: tasks("task-one") }));
    // Turning off what was never on records nothing.
    assert.deepEqual(await svc.set(owner, { commandId: cid("off"), projectId: project, enabled: false }), { revision: 0, enabled: false });
    assert.equal((await svc.get(owner, project)).revision, 0);
    assert.deepEqual(await svc.authorize(project, REMOTE, wipRefOf(project, "task-one")), { allowed: false, reason: "the work-in-progress backup is not on for this project, so it needs the normal approval for a push" });
  });

  suite("turning it on records one standing approval for exactly that remote and the project's namespace, with the owner's words; turning it off revokes it", async ({ svc, owner, project, clock }) => {
    const on = await svc.set(owner, { commandId: cid("on"), projectId: project, enabled: true, remote: REMOTE, basis: "back up my garden work to the backups folder" });
    assert.equal(on.enabled, true);
    const v = await svc.get(owner, project);
    assert.deepEqual(v.approval?.scope, { remote: REMOTE, projectId: project, namespace: `refs/heads/nn-wip/${project}/` });
    assert.equal(v.approval?.basis, "back up my garden work to the backups folder");
    assert.equal(v.approval?.approvedBy, owner.id);
    assert.equal(v.everyMinutes, WIP_LIMITS.defaultMinutes);
    assert.equal(v.enabled, true);
    // The same turn-on repeated applies once.
    assert.equal((await svc.set(owner, { commandId: cid("on2"), projectId: project, enabled: true, remote: REMOTE })).enabled, true);
    assert.equal((await svc.get(owner, project)).approval?.basis, "back up my garden work to the backups folder", "turning it on again for the same remote keeps the one approval");
    clock.ms += 60_000;
    await svc.set(owner, { commandId: cid("off"), projectId: project, enabled: false });
    const off = await svc.get(owner, project);
    assert.equal(off.enabled, false);
    assert.equal(off.approval?.revokedAt, new Date(clock.ms).toISOString());
    assert.equal(off.approval?.revokedBy, owner.id);
    assert.match((await svc.authorize(project, REMOTE, wipRefOf(project, "task-one")) as { reason: string }).reason, /not on/);
    // Turning it on again is a NEW approval (the revoked one stays in the history).
    clock.ms += 60_000;
    await svc.set(owner, { commandId: cid("on3"), projectId: project, enabled: true, remote: REMOTE });
    const again = await svc.get(owner, project);
    assert.equal(again.approval?.approvedAt, new Date(clock.ms).toISOString());
    assert.equal(again.history.length, 1);
    assert.ok(again.history[0]!.revokedAt !== undefined);
  });

  suite("a changed remote ends the old approval and records a new one; the interval is bounded; a bad request records nothing", async ({ svc, owner, project, other }) => {
    await svc.set(owner, { commandId: cid("on"), projectId: project, enabled: true, remote: REMOTE, everyMinutes: 30 });
    await svc.set(owner, { commandId: cid("move"), projectId: project, remote: "/backups/other.git" });
    const v = await svc.get(owner, project);
    assert.equal(v.remote, "/backups/other.git");
    assert.equal(v.everyMinutes, 30, "the interval is kept");
    assert.equal(v.approval?.scope.remote, "/backups/other.git");
    assert.equal(v.history[0]!.scope.remote, REMOTE);
    assert.ok(v.history[0]!.revokedAt !== undefined, "the approval for the old remote was ended");
    assert.equal((await svc.authorize(project, REMOTE, wipRefOf(project, "task-one"))).allowed, false, "the old remote is no longer covered");
    assert.equal((await svc.authorize(project, "/backups/other.git", wipRefOf(project, "task-one"))).allowed, true);
    const rev = (await svc.get(owner, project)).revision;
    for (const bad of [{ everyMinutes: 1 }, { everyMinutes: 5000 }, { everyMinutes: 2.5 }, { remote: "" }, { enabled: "yes" }, { basis: "" }, { nope: 1 }, {}]) await refuses("invalid_command", () => svc.set(owner, { commandId: cid("bad"), projectId: project, ...bad } as never));
    await refuses("invalid_command", () => svc.set(owner, { commandId: cid("badp"), projectId: "nope", enabled: true, remote: REMOTE }));
    await refuses("stale_revision", () => svc.set(owner, { commandId: cid("stale"), projectId: project, everyMinutes: 10, expectedRevision: rev - 1 }));
    assert.equal((await svc.get(owner, project)).revision, rev, "nothing was recorded");
    // Turning it on for a project that has none needs the remote.
    await refuses("invalid_command", () => svc.set(owner, { commandId: cid("noremote"), projectId: other, enabled: true }));
  });

  suite("a remote with a password or key in it, a helper or option, or a protocol that is not https, ssh or a folder is refused and never recorded", async ({ svc, owner, project }) => {
    const planted = ["gh", "p_", "A1b2C3d4".repeat(5)].join("");
    const bad = [`https://rob:hunter2@git.example.com/me/wip.git`, `https://git.example.com/me/wip.git?token=${planted}`, `https://${planted}@git.example.com/me/wip.git`, "--upload-pack=evil", "ext::sh -c evil", "a b", "x\ny", "http://git.example.com/wip.git", "git://git.example.com/wip.git", "ftp://x/y", "a".repeat(501)];
    for (const remote of bad) { assert.notEqual(remoteProblem(remote), undefined, remote.slice(0, 40)); await refuses("invalid_command", () => svc.set(owner, { commandId: cid("r"), projectId: project, enabled: true, remote })); }
    for (const ok of ["/backups/garden.git", "C:\\backups\\garden.git", "git@git.example.com:me/wip.git", "ssh://git@git.example.com/me/wip.git", "https://git.example.com/me/wip.git", "file:///backups/garden.git", "../relative/wip.git"]) assert.equal(remoteProblem(ok), undefined, ok);
    assert.equal((await svc.get(owner, project)).revision, 0);
    await refuses("invalid_command", () => svc.set(owner, { commandId: cid("b"), projectId: project, enabled: true, remote: REMOTE, basis: `my key is ${planted}` }));
  });

  suite("the standing approval covers only its remote, its project's namespace and a branch the owner has not protected; a push anywhere else is not covered and says it takes the normal approval", async ({ svc, owner, project, other, protectedBranches }) => {
    await svc.set(owner, { commandId: cid("on"), projectId: project, enabled: true, remote: REMOTE });
    const ok = (remote: string, ref: string, p = project) => svc.authorize(p, remote, ref);
    assert.deepEqual(await ok(REMOTE, wipRefOf(project, "task-one")), { allowed: true });
    for (const [remote, ref, why] of [
      ["/somewhere/else.git", wipRefOf(project, "task-one"), /only the remote the owner named/],
      [REMOTE, "refs/heads/main", /only branches under/], [REMOTE, "refs/heads/master", /only branches under/], [REMOTE, "main", /only branches under/],
      [REMOTE, wipRefOf(other, "task-one"), /only branches under/], [REMOTE, `refs/heads/nn-wip/${project}`, /only branches under/], [REMOTE, `refs/heads/nn-wip/${project}/a/b`, /only branches under/],
      [REMOTE, `refs/heads/nn-wip/${project}/..`, /only branches under/], [REMOTE, `refs/heads/nn-wip/${project}/x.lock`, /only branches under/], [REMOTE, `refs/heads/nn-wip/${project}/.hid`, /only branches under/],
      [REMOTE, `refs/tags/nn-wip/${project}/task-one`, /only branches under/], [REMOTE, `+${wipRefOf(project, "task-one")}`, /only branches under/],
    ] as const) { const r = await ok(remote, ref); assert.equal(r.allowed, false, ref); assert.match((r as { reason: string }).reason, why); assert.match((r as { reason: string }).reason, /normal approval/); }
    // Another project is not covered by this project's approval.
    assert.equal((await ok(REMOTE, wipRefOf(other, "task-one"), other)).allowed, false);
    // A branch the owner protects (the rule of card A07f) is not pushed to.
    protectedBranches.add(`nn-wip/${project}/task-one`);
    assert.match(((await ok(REMOTE, wipRefOf(project, "task-one"))) as { reason: string }).reason, /owner protects this branch/);
  });

  suite("a sweep backs up each task of an enabled project once its interval has passed, names the branch, never a protected one, and keeps the last confirmed commit", async ({ svc, owner, project, clock }) => {
    await svc.set(owner, { commandId: cid("on"), projectId: project, enabled: true, remote: REMOTE, everyMinutes: 15 });
    let commit = COMMIT_A;
    const h = host(() => good(commit, { files: 7 }));
    assert.deepEqual(await svc.sweep(owner, { port: h.port, tasks: tasks("task-one", "task-two") }), { attempted: 2, succeeded: 2, failed: 0, skipped: 0 });
    assert.deepEqual(h.calls.map((c) => [c.taskId, c.ref, c.remote, c.developer, c.executor]), [["task-one", wipRefOf(project, "task-one"), REMOTE, "agent:ann", "host:one"], ["task-two", wipRefOf(project, "task-two"), REMOTE, "agent:ann", "host:one"]]);
    let v = await svc.get(owner, project);
    assert.equal(v.tasks.length, 2);
    assert.deepEqual(v.tasks.find((t) => t.taskId === "task-one")?.lastSuccess, { commitId: COMMIT_A, tree: "t".repeat(40), at: new Date(clock.ms).toISOString(), files: 7, unchanged: false });
    // Before the interval: skipped, the host is not asked.
    clock.ms += 14 * 60_000;
    assert.deepEqual(await svc.sweep(owner, { port: h.port, tasks: tasks("task-one", "task-two") }), { attempted: 0, succeeded: 0, failed: 0, skipped: 2 });
    assert.equal(h.calls.length, 2);
    // After it: asked again, the new commit is the last success.
    clock.ms += 2 * 60_000; commit = COMMIT_B;
    assert.equal((await svc.sweep(owner, { port: h.port, tasks: tasks("task-one") })).succeeded, 1);
    v = await svc.get(owner, project);
    assert.equal(v.tasks.find((t) => t.taskId === "task-one")?.lastSuccess?.commitId, COMMIT_B);
    // A task whose name is not a plain name is skipped (never turned into a branch name).
    assert.equal((await svc.sweep(owner, { port: h.port, tasks: async () => [{ taskId: "../main", developer: "agent:ann", executor: "host:one" }] })).skipped, 1);
    // Turned off: no more calls.
    await svc.set(owner, { commandId: cid("off"), projectId: project, enabled: false });
    clock.ms += 60 * 60_000;
    const before = h.calls.length;
    await svc.sweep(owner, { port: h.port, tasks: tasks("task-one") });
    assert.equal(h.calls.length, before, "a revoked approval stops every push");
  });

  suite("a failed push is reported once and never counted as a backup: the last confirmed commit stays, failures are counted, and a host that does not name the commit counts for nothing", async ({ svc, owner, project, clock }) => {
    await svc.set(owner, { commandId: cid("on"), projectId: project, enabled: true, remote: REMOTE, everyMinutes: 5 });
    const reports: WipReport[] = [];
    const report = (r: WipReport): void => { reports.push(r); };
    let mode: "good" | "refused" | "throws" | "nocommit" | "report-throws" = "good";
    const h = host(() => (mode === "good" ? good(COMMIT_A) : mode === "refused" ? { ok: false, reason: "the push to the backup remote failed: ! [rejected] (non-fast-forward)" } : mode === "throws" ? new Error("the host went away") : { ok: true, summary: "x", detail: {} }));
    const run = async () => { clock.ms += 6 * 60_000; return svc.sweep(owner, { port: h.port, tasks: tasks("task-one"), report }); };
    await run();
    const last = (await svc.get(owner, project)).tasks[0]!;
    assert.equal(last.lastSuccess?.commitId, COMMIT_A);
    mode = "refused"; assert.equal((await run()).failed, 1);
    mode = "throws"; assert.equal((await run()).failed, 1);
    mode = "nocommit"; assert.equal((await run()).failed, 1);
    const t = (await svc.get(owner, project)).tasks[0]!;
    assert.deepEqual(t.lastSuccess, last.lastSuccess, "three failures did not move the last successful backup");
    assert.equal(t.consecutiveFailures, 3);
    assert.match(t.lastFailure?.reason ?? "", /not counted as a backup/);
    assert.equal(reports.filter((r) => r.kind === "failed").length, 1, "the owner is told when it starts failing, not at every try");
    assert.match(reports[0]!.text, /not counted as a backup/);
    mode = "good"; await run();
    const healed = (await svc.get(owner, project)).tasks[0]!;
    assert.equal(healed.consecutiveFailures, 0);
    // A new failure after a success is reported again.
    mode = "refused"; await run();
    assert.equal(reports.filter((r) => r.kind === "failed").length, 2);
    // A report that throws changes nothing that was recorded.
    mode = "refused";
    await svc.sweep(owner, { port: h.port, tasks: tasks("task-one"), report: () => { throw new Error("no channel"); } }).catch(() => undefined);
    assert.ok((await svc.get(owner, project)).tasks[0]!.lastSuccess !== undefined);
  });

  suite("files the host left out are kept and reported once per change, and a changed remote starts the task's record afresh", async ({ svc, owner, project, clock }) => {
    await svc.set(owner, { commandId: cid("on"), projectId: project, enabled: true, remote: REMOTE, everyMinutes: 5 });
    const reports: WipReport[] = [];
    let blocked: { path: string; reason: string }[] = [{ path: ".env", reason: "looks like a credential (API key)" }];
    const h = host(() => good(COMMIT_A, { blocked }));
    const run = async () => { clock.ms += 6 * 60_000; return svc.sweep(owner, { port: h.port, tasks: tasks("task-one"), report: (r) => { reports.push(r); } }); };
    await run(); await run();
    assert.equal(reports.filter((r) => r.kind === "blocked").length, 1, "the same left-out file is reported once");
    assert.match(reports[0]!.text, /\.env \(looks like a credential/);
    assert.deepEqual((await svc.get(owner, project)).tasks[0]!.blocked, [{ path: ".env", reason: "looks like a credential (API key)" }]);
    blocked = [{ path: ".env", reason: "looks like a credential (API key)" }, { path: "id_key", reason: "private key block" }];
    await run();
    assert.equal(reports.filter((r) => r.kind === "blocked").length, 2, "a changed set is reported again");
    blocked = [];
    await run();
    assert.deepEqual((await svc.get(owner, project)).tasks[0]!.blocked, []);
    // Another remote: the old record's last success was to the old remote and is not carried over.
    await svc.set(owner, { commandId: cid("move"), projectId: project, remote: "/backups/other.git" });
    const refused = host(() => ({ ok: false, reason: "no route to the new remote" }));
    clock.ms += 6 * 60_000;
    await svc.sweep(owner, { port: refused.port, tasks: tasks("task-one") });
    const t = (await svc.get(owner, project)).tasks[0]!;
    assert.equal(t.lastSuccess, undefined, "a backup to the old remote is not a backup to the new one");
    assert.equal(t.remote, "/backups/other.git");
  });

  suite("a sweep that is already running is given to the second ask, and a path or reason from the host is cleaned before it is kept", async ({ svc, owner, project }) => {
    await svc.set(owner, { commandId: cid("on"), projectId: project, enabled: true, remote: REMOTE });
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const planted = ["gh", "p_", "Zy9x8W7v".repeat(5)].join("");
    const h = host(() => good(COMMIT_A, { blocked: [{ path: `notes/${planted}.txt`, reason: `contains ${planted}` }] }));
    const slow = { backup: async (c: WipBackupCall) => { await gate; return h.port.backup(c); } };
    const first = svc.sweep(owner, { port: slow, tasks: tasks("task-one") });
    const second = svc.sweep(owner, { port: slow, tasks: tasks("task-one") });
    release();
    assert.deepEqual(await first, await second);
    assert.equal(h.calls.length, 1, "one sweep, one call");
    const kept = JSON.stringify((await svc.get(owner, project)).tasks);
    assert.ok(!kept.includes(planted), "a credential-shaped text from the host is not kept");
  });
}
