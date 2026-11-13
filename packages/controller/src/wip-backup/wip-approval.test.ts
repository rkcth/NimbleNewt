import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { GrantService, PrincipalService, type Principal } from "../security/index.js";
import { WIP_GRANTEE, WIP_GRANT_ACTION, WipBackupService, wipBackupRouter, wipRefOf, wipTasksSource, type WipBackupCall, type WipBackupOutcome, type WipBackupPort, type WipRestoreCall, type WipRestoreOutcome } from "./index.js";

after(stopServer);

// Card P02b, the finishing slice, on every storage backend: the standing approval is a real A07 grant (listed with the other standing rules, revoked the same way, and a push is covered only while it stands), the owner's
// push credential is only a secret NAME, a restore asks the host for exactly the last confirmed backup, and the product's task source and router say honestly what can and cannot be carried.
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const T0 = Date.parse("2026-11-13T10:00:00.000Z");
const COMMIT_A = "a".repeat(40);
const COMMIT_B = "b".repeat(40);
const REMOTE = "https://git.example.com/me/wip.git";
const refuses = async (code: string, run: () => Promise<unknown>): Promise<DomainError> => {
  let seen: unknown;
  await assert.rejects(run, (error: unknown) => { seen = error; assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, (error as DomainError).message); return true; });
  return seen as DomainError;
};

for (const backend of backends) {
  const suite = (name: string, body: (c: { svc: WipBackupService; grants: GrantService; owner: Principal; agent: Principal; project: string; clock: { ms: number } }) => Promise<void>) =>
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
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const svc = WipBackupService.withEpoch(world.storage, projects.epoch, { ...options, grants, ensureGrantee: async () => { if ((await principals.get(WIP_GRANTEE)) === undefined) await principals.provisionService("dispatcher"); } });
        await body({ svc, grants, owner, agent, project, clock });
      } finally { await world.close(); }
    });

  const host = (answer: (call: WipBackupCall) => WipBackupOutcome) => {
    const calls: WipBackupCall[] = [];
    const restores: WipRestoreCall[] = [];
    let restoreAnswer: WipRestoreOutcome = { ok: true, summary: "Restored 3 file(s)", detail: { where: "as the task's own checkout on this host", commitId: COMMIT_A, files: 3, baseFound: true } };
    const port: WipBackupPort = { backup: async (call) => { calls.push(call); return answer(call); }, restore: async (call) => { restores.push(call); return restoreAnswer; } };
    return { calls, restores, port, answerRestore: (r: WipRestoreOutcome) => { restoreAnswer = r; } };
  };
  const good = (commitId: string): WipBackupOutcome => ({ ok: true, summary: "Backed up", detail: { commitId, tree: "t".repeat(40), files: 3, unchanged: false, blocked: [] } });
  const tasks = (...ids: string[]) => async () => ids.map((taskId) => ({ taskId, developer: "agent:ann", executor: "host:local" }));

  suite("turning it on makes a real standing grant (listed with the standing rules), a push is covered only while it stands, and revoking it in the list ends the backup quietly", async ({ svc, grants, owner, project, clock }) => {
    await svc.set(owner, { commandId: cid("on"), projectId: project, enabled: true, remote: REMOTE, basis: "keep a copy of the garden work" });
    const v = await svc.get(owner, project);
    const id = v.approval?.grantId;
    assert.match(id ?? "", /^grt-/);
    assert.equal(v.approvalHeld, true);
    const listed = (await grants.list(owner, { grantee: WIP_GRANTEE })).items.find((g) => g.id === id);
    assert.ok(listed !== undefined, "the approval is in the owner's list of standing rules");
    assert.deepEqual([listed.source, listed.action, listed.project, listed.state, listed.resource?.id], ["standing", WIP_GRANT_ACTION, project, "active", `refs/heads/nn-wip/${project}/`]);
    assert.ok(listed.terms?.conditions?.includes(`remote: ${REMOTE}`));
    assert.match(listed.basis, /keep a copy of the garden work/);
    const ref = wipRefOf(project, "task-one");
    assert.deepEqual(await svc.authorize(project, REMOTE, ref), { allowed: true });
    assert.equal((await svc.authorize(project, "https://git.example.com/me/other.git", ref)).allowed, false, "another remote is not covered");

    const h = host(() => good(COMMIT_A));
    clock.ms += 16 * 60_000;
    assert.equal((await svc.sweep(owner, { port: h.port, tasks: tasks("task-one") })).succeeded, 1);

    // The owner revokes it the way any standing rule is revoked: nothing more is pushed, no failure is recorded and nobody is bothered.
    await grants.revoke(owner, { commandId: cid("rv"), grantId: id!, expectedRevision: listed.revision, reason: "stop it" });
    const after = await svc.get(owner, project);
    assert.deepEqual([after.enabled, after.approvalHeld], [false, false]);
    const reports: unknown[] = [];
    clock.ms += 16 * 60_000;
    assert.deepEqual(await svc.sweep(owner, { port: h.port, tasks: tasks("task-one"), report: (r) => { reports.push(r); } }), { attempted: 0, succeeded: 0, failed: 0, skipped: 0 });
    assert.equal(h.calls.length, 1);
    assert.deepEqual(reports, []);
    const denied = await svc.authorize(project, REMOTE, ref);
    assert.equal(denied.allowed, false);
    assert.match((denied as { reason: string }).reason, /standing grant behind the backup was revoked/);

    // Turning it on again records a NEW approval (a new grant); the old one stays revoked.
    await svc.set(owner, { commandId: cid("on2"), projectId: project, enabled: true, basis: "again please" });
    const again = await svc.get(owner, project);
    assert.notEqual(again.approval?.grantId, id);
    assert.equal(again.enabled, true);
    assert.deepEqual(await svc.authorize(project, REMOTE, ref), { allowed: true });
    clock.ms += 16 * 60_000;
    assert.equal((await svc.sweep(owner, { port: h.port, tasks: tasks("task-one") })).succeeded, 1);
  });

  suite("turning it off or moving it revokes the grant first; a refused change leaves no standing grant behind; the same command ID makes one grant", async ({ svc, grants, owner, project }) => {
    await svc.set(owner, { commandId: "same-on", projectId: project, enabled: true, remote: REMOTE });
    await svc.set(owner, { commandId: "same-on", projectId: project, enabled: true, remote: REMOTE });
    const first = (await svc.get(owner, project)).approval!.grantId!;
    const active = async (): Promise<string[]> => (await grants.list(owner, { grantee: WIP_GRANTEE })).items.filter((g) => g.state === "active").map((g) => g.id);
    assert.deepEqual(await active(), [first]);
    // Moving to another remote ends the old approval and records a new one.
    await svc.set(owner, { commandId: cid("mv"), projectId: project, remote: "https://git.example.com/me/second.git" });
    const second = (await svc.get(owner, project)).approval!.grantId!;
    assert.notEqual(second, first);
    assert.deepEqual(await active(), [second]);
    assert.equal((await grants.getGrant(first))?.state, "revoked");
    // A change that is refused after the grant would have been made (a stale revision) leaves nothing active but the standing one.
    await refuses("stale_revision", () => svc.set(owner, { commandId: cid("st"), projectId: project, remote: "https://git.example.com/me/third.git", expectedRevision: 1 }));
    assert.deepEqual(await active(), [second]);
    assert.equal((await svc.get(owner, project)).remote, "https://git.example.com/me/second.git");
    // Off revokes the grant.
    await svc.set(owner, { commandId: cid("off"), projectId: project, enabled: false });
    assert.deepEqual(await active(), []);
    const off = await svc.get(owner, project);
    assert.deepEqual([off.enabled, off.approval?.revokedAt !== undefined], [false, true]);
  });

  suite("a setting recorded before the grant existed covers nothing until it is turned on again", async ({ svc, owner, project }) => {
    // A service without the grants wiring records the older kind of approval (no grant behind it).
    const world = await backend.open();
    try {
      const options = { clock: () => new Date(T0).toISOString(), pause: async () => undefined };
      const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
      const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
      const rob = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
      const p = (await projects.createProject({ commandId: cid("pz"), actor: "owner:rob", name: "Old" })).id;
      const legacy = WipBackupService.withEpoch(world.storage, projects.epoch, options);
      await legacy.set(rob, { commandId: cid("lg"), projectId: p, enabled: true, remote: REMOTE });
      const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
      const strict = WipBackupService.withEpoch(world.storage, projects.epoch, { ...options, grants, ensureGrantee: async () => { await principals.provisionService("dispatcher"); } });
      const view = await strict.get(rob, p);
      assert.deepEqual([view.enabled, view.approvalHeld], [false, false]);
      const r = await strict.authorize(p, REMOTE, wipRefOf(p, "task-one"));
      assert.equal(r.allowed, false);
      assert.match((r as { reason: string }).reason, /recorded before the standing grant existed/);
      await strict.set(rob, { commandId: cid("again"), projectId: p, enabled: true });
      assert.deepEqual(await strict.authorize(p, REMOTE, wipRefOf(p, "task-one")), { allowed: true });
    } finally { await world.close(); }
    void svc; void owner; void project;
  });

  suite("the push credential is only the NAME of a secret: kept in the setting, passed to the host, refused for a folder or ssh remote, never a value", async ({ svc, owner, project, clock }) => {
    const planted = ["gh", "p_", "Qw3rTy9u".repeat(5)].join("");
    await refuses("invalid_command", () => svc.set(owner, { commandId: cid("c1"), projectId: project, enabled: true, remote: REMOTE, credential: planted }));
    await refuses("invalid_command", () => svc.set(owner, { commandId: cid("c2"), projectId: project, enabled: true, remote: REMOTE, credential: "has space" }));
    await refuses("invalid_command", () => svc.set(owner, { commandId: cid("c3"), projectId: project, enabled: true, remote: "/backups/garden.git", credential: "garden-token" }));
    await refuses("invalid_command", () => svc.set(owner, { commandId: cid("c4"), projectId: project, enabled: true, remote: "git@example.com:me/wip.git", credential: "garden-token" }));
    assert.equal((await svc.get(owner, project)).revision, 0, "nothing was recorded by a refused change");
    await svc.set(owner, { commandId: cid("c5"), projectId: project, enabled: true, remote: REMOTE, credential: "garden-token" });
    const v = await svc.get(owner, project);
    assert.equal(v.credential, "garden-token");
    assert.deepEqual(await svc.credentialNames(), ["garden-token"]);
    const h = host(() => good(COMMIT_A));
    clock.ms += 16 * 60_000;
    await svc.sweep(owner, { port: h.port, tasks: tasks("task-one") });
    assert.equal(h.calls[0]!.credential, "garden-token", "the host gets the name and resolves the value itself");
    // A change of the interval keeps the name; null clears it.
    await svc.set(owner, { commandId: cid("c6"), projectId: project, everyMinutes: 30 });
    assert.equal((await svc.get(owner, project)).credential, "garden-token");
    await svc.set(owner, { commandId: cid("c7"), projectId: project, credential: null });
    assert.equal((await svc.get(owner, project)).credential, undefined);
    assert.deepEqual(await svc.credentialNames(), []);
    assert.ok(!JSON.stringify(await svc.get(owner, project)).includes(planted));
  });

  suite("a restore asks the host for exactly the last confirmed backup, once per command, whether or not the backup is still on; a failure is recorded and said", async ({ svc, owner, agent, project, clock }) => {
    const h = host(() => good(COMMIT_A));
    const restore = (commandId: string, taskId = "task-one", port: Pick<WipBackupPort, "restore"> | undefined = h.port) => svc.restore(owner, { commandId, projectId: project, taskId }, port);
    await refuses("not_found", () => restore(cid("r0")));
    await svc.set(owner, { commandId: cid("on"), projectId: project, enabled: true, remote: REMOTE, credential: "garden-token" });
    await refuses("not_found", () => restore(cid("r1")));
    clock.ms += 16 * 60_000;
    await svc.sweep(owner, { port: h.port, tasks: tasks("task-one") });
    await refuses("forbidden", () => svc.restore(agent, { commandId: cid("ra"), projectId: project, taskId: "task-one" }, h.port));
    await refuses("invalid_command", () => restore(cid("rb"), "../evil"));
    const done = await restore("restore-1");
    assert.deepEqual([done.restored, done.replayed, done.where, done.commitId, done.files, done.baseFound], [true, false, "as the task's own checkout on this host", COMMIT_A, 3, true]);
    assert.deepEqual(h.restores, [{ projectId: project, taskId: "task-one", remote: REMOTE, ref: wipRefOf(project, "task-one"), expectCommit: COMMIT_A, credential: "garden-token" }]);
    const again = await restore("restore-1");
    assert.equal(again.replayed, true);
    assert.equal(h.restores.length, 1, "the same command never restores twice");
    await refuses("command_conflict", () => restore("restore-1", "task-two"));
    // Turned off: the backup stays on the owner's remote and can still be read back.
    await svc.set(owner, { commandId: cid("off"), projectId: project, enabled: false });
    assert.equal((await restore(cid("r2"))).replayed, false);
    // A host that cannot restore, one that refuses and one that throws are all said, in words, and recorded.
    await refuses("unavailable", () => restore(cid("r3"), "task-one", {}));
    h.answerRestore({ ok: false, reason: "the branch on the remote is not the last backup the controller confirmed" });
    const refused = await refuses("unavailable", () => restore("restore-fail"));
    assert.match(refused.message, /not the last backup the controller confirmed/);
    const replayed = await refuses("unavailable", () => restore("restore-fail"));
    assert.equal(replayed.message, refused.message);
    assert.equal(h.restores.length, 3, "the failed command did not ask the host again");
    await refuses("unavailable", () => restore(cid("r4"), "task-one", { restore: async () => { throw new Error("disk full"); } }));
  });

  test(`${backend.name}: the task source offers the open tasks some host took (with the owner's agent and that host), and the router sends a backup only to this computer's host and says why for a remote one`, async () => {
    const all = [
      { id: "task-a", state: "in_progress", createdBy: "owner:rob" }, { id: "task-b", state: "done", createdBy: "owner:rob" }, { id: "task-c", state: "ready", createdBy: "agent:zed" },
      { id: "task-d", state: "blocked", createdBy: "owner:rob" }, { id: "task-e", state: "proposed", createdBy: "owner:rob" },
    ];
    const placedAt: Record<string, string | undefined> = { "task-a": "host:local", "task-b": "host:local", "task-c": "host:far", "task-d": undefined, "task-e": "host:local" };
    const source = wipTasksSource({
      tasks: { listTasks: async (q) => { const from = q.afterId === undefined ? 0 : all.findIndex((t) => t.id === q.afterId) + 1; const items = all.slice(from, from + 2); return { items, ...(from + 2 < all.length ? { next: items[items.length - 1]!.id } : {}) }; } },
      assignment: async (id) => (id === "task-a" ? { state: "assigned", owner: { kind: "agent", id: "ann" } } : id === "task-c" ? { state: "released" } : undefined),
      placed: async (id) => placedAt[id],
    });
    assert.deepEqual(await source("proj-x"), [{ taskId: "task-a", developer: "agent:ann", executor: "host:local" }, { taskId: "task-c", developer: "agent:zed", executor: "host:far" }]);

    const local = host(() => good(COMMIT_A));
    const router = wipBackupRouter({ localHostId: "host:local", local: local.port, placed: async (id) => placedAt[id] });
    const call = (taskId: string, executor: string): WipBackupCall => ({ projectId: "proj-x", taskId, remote: REMOTE, ref: "refs/heads/nn-wip/proj-x/t", developer: "agent:ann", executor });
    assert.equal((await router.backup(call("task-a", "host:local"))).ok, true);
    const far = await router.backup(call("task-c", "host:far"));
    assert.equal(far.ok, false);
    assert.match((far as { reason: string }).reason, /host:far, a remote worker host, and the worker protocol cannot carry/);
    assert.equal(local.calls.length, 1, "a remote host's task never reached this computer's host");
    const restoreCall = (taskId: string): WipRestoreCall => ({ projectId: "proj-x", taskId, remote: REMOTE, ref: "refs/heads/nn-wip/proj-x/t", expectCommit: COMMIT_B });
    assert.equal((await router.restore!(restoreCall("task-a"))).ok, true);
    assert.equal((await router.restore!(restoreCall("task-d"))).ok, true, "a task never placed anywhere goes to the one host this computer has");
    assert.equal((await router.restore!(restoreCall("task-c"))).ok, false);
    assert.equal(local.restores.length, 2);
  });
}
