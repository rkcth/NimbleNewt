import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, SecureApi, allows, type Principal } from "./index.js";

after(stopServer);

const T = "2026-10-21T10:00:00.000Z";
const BEFORE = "2026-10-21T09:00:00.000Z";
const SOON = "2026-10-21T12:00:00.000Z";
const LATER = "2026-10-21T13:00:00.000Z";
const options = { clock: () => T, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  const suite = (name: string, body: (c: {
    grants: GrantService; grantsAt(clock: string): GrantService; owner: Principal; a: string; b: string; ta: string; ta2: string; tb: string;
    api(p: Principal): SecureApi; agent(name: string): Promise<Principal>; login(name: string): Promise<Principal>; at(p: Principal, when: string): Promise<Principal>;
  }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const api = (p: Principal) => new SecureApi(p, { projects, assignments });
        const agent = async (name: string) => {
          await principals.enroll(owner, { commandId: cid("enroll"), kind: "agent", name, grants: [] });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${name}`)).token);
        };
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const ta = (await projects.createTask({ commandId: cid("ta"), actor: "owner:rob", projectId: a, title: "one" })).id;
        const ta2 = (await projects.createTask({ commandId: cid("ta2"), actor: "owner:rob", projectId: a, title: "two" })).id;
        const tb = (await projects.createTask({ commandId: cid("tb"), actor: "owner:rob", projectId: b, title: "three" })).id;
        await body({ grants, grantsAt: (clock) => GrantService.withEpoch(world.storage, projects.epoch, { ...options, clock: () => clock }), owner, a, b, ta, ta2, tb, api, agent, login: async (name) => principals.authenticate((await principals.issueCredential(owner, `agent:${name}`)).token), at: (p, when) => grants.effective(p, when) });
      } finally { await world.close(); }
    });
  const give = (g: GrantService, owner: Principal, grantee: string, action: string, project: string, extra: Record<string, unknown> = {}) =>
    g.grant(owner, { commandId: cid("g"), grantee, action, project, source: "direct", basis: "the owner said so", ...extra } as never);

  suite("a direct grant covers what it names in its project and nothing else", async ({ grants, owner, a, b, ta, tb, api, agent, at }) => {
    const ann = await agent("ann");
    await refuses("forbidden", () => api(ann).getTask(ta));
    await give(grants, owner, "agent:ann", "task.read", a);
    const now = await at(ann, T);
    assert.equal((await api(now).getTask(ta))!.id, ta);
    await refuses("forbidden", () => api(now).getTask(tb), (e) => assert.ok(!e.message.includes(b)));
    await refuses("forbidden", () => api(now).createTask({ commandId: cid("c"), projectId: a, title: "x" }), (e) => assert.match(e.message, /may not task.create/));
  });

  suite("an agreed grant is carried out by the controller as one direct, ending grant for one project, with the decision and who allowed it in its basis; nothing wider and nobody else may use it (card M02e)", async ({ grants, grantsAt, owner, a, b, ta, tb, api, agent, at }) => {
    const ann = await agent("ann");
    const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as unknown as Principal;
    const end = SOON;
    const base = { commandId: cid("ag"), grantee: "agent:ann", action: "task.read", project: a, expiresAt: end, basis: "to read the plan", decisionId: "mtg:dec-1:chg-1", agreedBy: "owner:agreed" };
    const made = await grants.grantAgreed(controller, base);
    assert.equal((await grants.grantAgreed(controller, base)).replayed, true, "a repeat after a crash grants once");
    const now = await at(ann, T);
    // Judged at the test clock (the secured API reads the wall clock, which is past this fixed time).
    assert.equal(allows(now, "task.read", a, { now: T }), true, "it covers what it names");
    assert.equal(allows(now, "task.read", b, { now: T }), false);
    const record = (await grants.list(owner, { grantee: "agent:ann" })).items.find((g) => g.id === made.id);
    assert.match(String(record?.basis), /meeting decision mtg:dec-1:chg-1, allowed by owner:agreed: to read the plan/);
    assert.equal(record?.source, "direct");
    await refuses("forbidden", () => grants.grantAgreed(ann, { ...base, commandId: cid("ag") }));
    await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), project: "*" }));
    await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), expiresAt: undefined } as never));
    await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), agreedBy: "the agent said so" }));
    await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), source: "standing" } as never));
    for (const action of ["*", "task.*", "approve.effect", "approve.*", "tool.run", "principal.manage", "budget.manage", "task.nonsense", "review.policy.write", "project.participants.write", "effect.perform", "meeting.manage", "responsibility.assign", "resource.scope.write", "config.write", "config.read"]) {
      await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), action }), (e) => assert.equal(e.field, "action"));
    }
    await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), expiresAt: "2026-10-21T09:00:00.000Z" }), (e) => assert.match(e.message, /past/));
    await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), expiresAt: "2026-12-31T00:00:00.000Z" }), (e) => assert.match(e.message, /30 days/));
    await grants.grantAgreed(controller, { ...base, commandId: cid("ag"), expiresAt: "2026-11-20T10:00:00.000Z" });
    await grants.grantAgreed(controller, { ...base, commandId: cid("ag"), action: "desk.write" });
    // Malformed times that match the shape are refused (a NaN would defeat the cap and never expire).
    for (const bad of ["9999-99-99T00:00:00.000Z", "2026-11-15T25:00:00.000Z", "2026-02-30T10:00:00.000Z"]) {
      await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), expiresAt: bad }), (e) => assert.equal(e.field, "expiresAt"));
      await refuses("invalid_command", () => grants.grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "task.read", project: a, source: "direct", basis: "x", expiresAt: bad }), (e) => assert.equal(e.field, "expiresAt"));
      await refuses("invalid_command", () => grants.grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "task.read", project: a, source: "direct", basis: "x", notBefore: bad }), (e) => assert.equal(e.field, "notBefore"));
    }
    // A replay after a crash answers with the grant made, even when the clock has passed its end or the grantee has gone.
    const replay = await grantsAt("2026-10-21T13:00:00.000Z").grantAgreed(controller, base);
    assert.equal(replay.replayed, true);
    assert.equal(replay.id, made.id);
    for (const grantee of ["host:h1", "service:s1", "client:c1", "owner:rob", "agent:nobody"]) {
      await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), grantee }), (e) => assert.equal(e.field, "grantee"));
    }
    void b;
  });

  suite("an agreed grant of task.update or task.transition is allowed only for exactly one task and covers only that task (card M02e)", async ({ grants, a, ta, ta2, agent, at }) => {
    const ann = await agent("ann");
    const controller = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as unknown as Principal;
    const base = { grantee: "agent:ann", project: a, expiresAt: SOON, basis: "to edit one task", decisionId: "mtg:dec-1:chg-1", agreedBy: "owner:agreed" };
    for (const action of ["task.update", "task.transition"]) {
      await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), action }), (e) => assert.equal(e.field, "action"));
      await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), action, resource: { kind: "project", id: a } }), (e) => assert.equal(e.field, "resource"));
      await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), action, resource: { kind: "task", id: ta, extra: 1 } } as never));
    }
    await refuses("invalid_command", () => grants.grantAgreed(controller, { ...base, commandId: cid("ag"), action: "principal.manage", resource: { kind: "task", id: ta } }), (e) => assert.equal(e.field, "action"));
    await grants.grantAgreed(controller, { ...base, commandId: cid("ag"), action: "task.update", resource: { kind: "task", id: ta } });
    const now = await at(ann, T);
    assert.equal(allows(now, "task.update", a, { now: T, resource: { kind: "task", id: ta } }), true);
    assert.equal(allows(now, "task.update", a, { now: T, resource: { kind: "task", id: ta2 } }), false, "not the neighbour task");
    assert.equal(allows(now, "task.update", a, { now: T }), false, "not without naming a task");
    assert.equal(allows(now, "task.transition", a, { now: T, resource: { kind: "task", id: ta } }), false, "only the action granted");
  });

  suite("a malformed timestamp is refused on every grant path", async ({ grants, owner, a, agent }) => {
    await agent("ann");
    const parent = await give(grants, owner, "agent:ann", "task.read", a, { expiresAt: SOON });
    for (const bad of ["9999-99-99T00:00:00.000Z", "2026-11-15T25:00:00.000Z"]) {
      await refuses("invalid_command", () => grants.derive(owner, { commandId: cid("d"), parentId: parent.id, action: "task.read", project: a, basis: "x", expiresAt: bad }), (e) => assert.equal(e.field, "expiresAt"));
      await refuses("invalid_command", () => grants.restrict(owner, { commandId: cid("rs"), subject: "agent:ann", action: "task.read", project: a, reason: "x", expiresAt: bad } as never), (e) => assert.equal(e.field, "expiresAt"));
    }
  });

  suite("a grant for one resource says nothing about its neighbours", async ({ grants, owner, a, ta, ta2, api, agent, at }) => {
    const ann = await agent("ann");
    await give(grants, owner, "agent:ann", "task.read", a, { resource: { kind: "task", id: ta } });
    const now = await at(ann, T);
    assert.equal((await api(now).getTask(ta))!.id, ta);
    await refuses("forbidden", () => api(now).getTask(ta2));
  });

  suite("a grant stops counting when it expires, even on a snapshot taken earlier", async ({ grants, owner, a, ta, api, agent, at }) => {
    const ann = await agent("ann");
    await give(grants, owner, "agent:ann", "task.read", a, { expiresAt: SOON });
    const early = await at(ann, T);
    void api; void ta;
    assert.equal(allows(early, "task.read", a, { now: T, resource: { kind: "task", id: ta } }), true);
    assert.equal(allows(early, "task.read", a, { now: LATER, resource: { kind: "task", id: ta } }), false, "judged at a later time the same snapshot no longer allows it");
    assert.equal(allows(await at(ann, LATER), "task.read", a, { now: LATER }), false);
  });

  suite("a grant that has not started yet does not count", async ({ grants, owner, a, agent, at }) => {
    const ann = await agent("ann");
    await give(grants, owner, "agent:ann", "task.read", a, { notBefore: SOON });
    assert.equal(allows(await at(ann, T), "task.read", a, { now: T }), false);
    assert.equal(allows(await at(ann, LATER), "task.read", a, { now: LATER }), true);
  });

  suite("revoking takes the authority away at the next snapshot, once, with a revision check", async ({ grants, owner, a, ta, api, agent, at }) => {
    const ann = await agent("ann");
    const g = await give(grants, owner, "agent:ann", "task.read", a);
    assert.equal(allows(await at(ann, T), "task.read", a, { now: T }), true);
    await refuses("stale_revision", () => grants.revoke(owner, { commandId: cid("r"), grantId: g.id, expectedRevision: 5, reason: "x" }));
    await grants.revoke(owner, { commandId: cid("r"), grantId: g.id, expectedRevision: g.revision, reason: "no longer needed" });
    await refuses("forbidden", () => (async () => api(await at(ann, T)).getTask(ta))());
    assert.deepEqual((await grants.getGrant(g.id))!.state, "revoked");
    await refuses("stale_revision", () => grants.revoke(owner, { commandId: cid("r2"), grantId: g.id, expectedRevision: g.revision, reason: "again" }));
  });

  suite("a derived grant can be narrower, never wider, and falls with its parent", async ({ grants, owner, a, b, agent, at }) => {
    const ann = await agent("ann");
    const parent = await give(grants, owner, "agent:ann", "task.*", a, { expiresAt: SOON });
    const child = await grants.derive(ann, { commandId: cid("d"), parentId: parent.id, action: "task.read", project: a, basis: "reading the brief is part of the job" });
    const child2 = await grants.derive(ann, { commandId: cid("d2"), parentId: child.id, action: "task.read", project: a, basis: "same, again" });
    const view = await at(ann, T);
    assert.deepEqual(view.grants.map((g) => g.action).filter((a) => !a.startsWith("tool.a-")).sort(), ["task.*", "task.read", "task.read"]);
    const derived = (await grants.getGrant(child.id))!;
    assert.equal(derived.expiresAt, SOON, "a derived grant ends no later than its parent");
    for (const wider of [{ action: "*", project: a }, { action: "task.read", project: b }, { action: "task.read", project: "*" }, { action: "task.read", project: a, expiresAt: LATER }, { action: "project.read", project: a }]) {
      await refuses("forbidden", () => grants.derive(ann, { commandId: cid("w"), parentId: parent.id, basis: "wider", ...wider } as never), (e) => assert.match(e.message, /cannot be wider/));
    }
    await grants.revoke(owner, { commandId: cid("r"), grantId: parent.id, expectedRevision: parent.revision, reason: "done" });
    assert.deepEqual((await at(ann, T)).grants.filter((g) => !g.action.startsWith("tool.a-")), [], "children, and their children, stop counting with the parent");
    await refuses("forbidden", () => grants.derive(ann, { commandId: cid("late"), parentId: parent.id, action: "task.read", project: a, basis: "after revoke" }));
    void child2;
  });

  suite("nobody can derive from a grant they do not hold, and only the owner decides", async ({ grants, owner, a, agent }) => {
    const ann = await agent("ann");
    const eve = await agent("eve");
    const parent = await give(grants, owner, "agent:ann", "task.*", a);
    await refuses("forbidden", () => grants.derive(eve, { commandId: cid("d"), parentId: parent.id, action: "task.read", project: a, basis: "borrowing" }), (e) => assert.match(e.message, /holds no such grant/));
    await refuses("forbidden", () => grants.derive(eve, { commandId: cid("d"), parentId: "grt-aaaaaaaaaaaaaaaaaaaa", action: "task.read", project: a, basis: "missing" }), (e) => assert.match(e.message, /holds no such grant/));
    await refuses("forbidden", () => give(grants, ann, "agent:eve", "task.read", a), (e) => assert.match(e.message, /only the owner/));
    await refuses("forbidden", () => grants.restrict(ann, { commandId: cid("x"), subject: "agent:eve", action: "task.*", project: a, reason: "no" }));
    await refuses("forbidden", () => grants.revoke(ann, { commandId: cid("x"), grantId: parent.id, expectedRevision: 1, reason: "no" }));
  });

  suite("a restriction beats a grant, can be limited to one resource, applies to everyone but the owner, and can be lifted", async ({ grants, owner, a, ta, ta2, api, agent, at }) => {
    const ann = await agent("ann");
    await give(grants, owner, "agent:ann", "task.*", a);
    const r = await grants.restrict(owner, { commandId: cid("rs"), subject: "agent:ann", action: "task.update", project: a, resource: { kind: "task", id: ta }, reason: "frozen for release" });
    let now = await at(ann, T);
    await refuses("forbidden", () => api(now).updateTask({ commandId: cid("u"), taskId: ta, expectedRevision: 1, title: "changed" }));
    assert.equal((await api(now).updateTask({ commandId: cid("u"), taskId: ta2, expectedRevision: 1, title: "changed" })).revision, 2, "the other task is not restricted");
    assert.equal((await api(now).getTask(ta))!.id, ta, "reading is not restricted");
    assert.equal((await grants.explain(ann, "task.update", a, T, { kind: "task", id: ta })).allowed, false);
    assert.match((await grants.explain(ann, "task.update", a, T, { kind: "task", id: ta })).because, /frozen for release/);
    await grants.lift(owner, { commandId: cid("l"), restrictionId: r.id, expectedRevision: r.revision, reason: "released" });
    now = await at(ann, T);
    assert.equal((await api(now).updateTask({ commandId: cid("u2"), taskId: ta, expectedRevision: 1, title: "changed now" })).revision, 2);
    await refuses("invalid_command", () => grants.lift(owner, { commandId: cid("l2"), restrictionId: r.id, expectedRevision: r.revision + 1, reason: "again" }));
  });

  suite("a restriction for everyone leaves the owner alone, and one that has expired no longer applies", async ({ grants, owner, a, ta, api, agent, at }) => {
    const ann = await agent("ann");
    const eve = await agent("eve");
    await give(grants, owner, "agent:ann", "task.read", a);
    await give(grants, owner, "agent:eve", "task.read", a);
    await grants.restrict(owner, { commandId: cid("rs"), subject: "*", action: "task.read", project: a, reason: "lockdown", expiresAt: SOON });
    for (const p of [ann, eve]) await refuses("forbidden", async () => api(await at(p, T)).getTask(ta));
    assert.equal((await api(await at(owner, T)).getTask(ta))!.id, ta);
    assert.equal(allows(await at(ann, LATER), "task.read", a, { now: LATER, resource: { kind: "task", id: ta } }), true, "after it expires the grant counts again");
    void BEFORE;
  });

  suite("a restriction beats a derived grant too, and an unscoped restriction blocks a resource-scoped check", async ({ grants, owner, a, ta, agent, at }) => {
    const ann = await agent("ann");
    const parent = await give(grants, owner, "agent:ann", "task.*", a);
    await grants.derive(ann, { commandId: cid("d"), parentId: parent.id, action: "task.read", project: a, basis: "reading" });
    await grants.restrict(owner, { commandId: cid("rs"), subject: "agent:ann", action: "task.read", project: "*", reason: "paused" });
    assert.equal(allows(await at(ann, T), "task.read", a, { now: T, resource: { kind: "task", id: ta } }), false);
    assert.equal(allows(await at(ann, T), "task.update", a, { now: T, resource: { kind: "task", id: ta } }), true, "other actions are untouched");
  });

  suite("a principal fresh from authentication already carries its restrictions; explain agrees with the real check; derivation depth is limited", async ({ grants, owner, a, ta, api, agent }) => {
    // ann holds a broad grant from enrollment and is restricted on one task; her authentication snapshot, not one from effective(), must respect that.
    const ann = await agent("ann");
    await give(grants, owner, "agent:ann", "task.*", a);
    await grants.restrict(owner, { commandId: cid("rs"), subject: "agent:ann", action: "task.update", project: a, resource: { kind: "task", id: ta }, reason: "frozen" });
    const again = await grants.effective(ann, T);
    assert.equal(allows(again, "task.update", a, { now: T }), false, "no resource named: a resource-scoped restriction still applies");
    const said = await grants.explain(ann, "task.update", a, T);
    assert.equal(said.allowed, false);
    assert.match(said.because, /frozen/);
    assert.equal((await grants.explain(ann, "task.read", a, T)).allowed, true);
    assert.equal(allows(await grants.effective(ann, T), "task.update", a, { now: T }), (await grants.explain(ann, "task.update", a, T)).allowed);
    void api;
    // Derivation stops at eight levels.
    let parent = await give(grants, owner, "agent:ann", "task.read", a);
    for (let level = 1; level <= 8; level++) parent = await grants.derive(ann, { commandId: cid("lv"), parentId: parent.id, action: "task.read", project: a, basis: `level ${level}` });
    await refuses("forbidden", () => grants.derive(ann, { commandId: cid("lv"), parentId: parent.id, action: "task.read", project: a, basis: "too deep" }), (e) => assert.match(e.message, /limited to 8 levels/));
  });

  suite("a principal returned by authentication respects a restriction (the first snapshot, not only effective())", async ({ grants, owner, a, ta, api, agent, login }) => {
    await agent("ann");
    await give(grants, owner, "agent:ann", "task.*", a);
    await grants.restrict(owner, { commandId: cid("rs"), subject: "agent:ann", action: "task.read", project: a, reason: "paused" });
    const fresh = await login("ann");
    await refuses("forbidden", () => api(fresh).getTask(ta));
    assert.equal(allows(fresh, "task.read", a, { now: T, resource: { kind: "task", id: ta } }), false);
  });

  suite("bad grants are refused, and credential-shaped text is not recorded", async ({ grants, owner, a, agent }) => {
    await agent("ann");
    await refuses("invalid_command", () => give(grants, owner, "owner:rob", "task.read", a), (e) => assert.match(e.message, /needs no grant/));
    await refuses("not_found", () => give(grants, owner, "agent:nobody", "task.read", a));
    await refuses("invalid_command", () => give(grants, owner, "agent:ann", "Task Read", a));
    await refuses("invalid_command", () => give(grants, owner, "agent:ann", "task.read", "everything"));
    await refuses("invalid_command", () => give(grants, owner, "agent:ann", "task.read", a, { notBefore: SOON, expiresAt: T }));
    await refuses("invalid_command", () => give(grants, owner, "agent:ann", "task.read", a, { expiresAt: "tomorrow" }));
    await refuses("invalid_command", () => give(grants, owner, "agent:ann", "task.read", a, { basis: "use ghp_abcdefghijklmnopqrstuvwxyz0123456789" }), (e) => assert.match(e.message, /credential/));
    await refuses("invalid_command", () => give(grants, owner, "agent:ann", "task.read", a, { surprise: true }));
  });

  suite("the same command ID by the owner replays, and a different grant under it conflicts", async ({ grants, owner, a, agent }) => {
    await agent("ann");
    const command = { commandId: "grant-one", grantee: "agent:ann", action: "task.read", project: a, source: "direct", basis: "x" } as never;
    const first = await grants.grant(owner, command);
    assert.equal((await grants.grant(owner, command)).id, first.id);
    assert.equal((await grants.grant(owner, command)).replayed, true);
    await refuses("command_conflict", () => grants.grant(owner, { commandId: "grant-one", grantee: "agent:ann", action: "task.update", project: a, source: "direct", basis: "x" } as never));
  });
}

test("the owner is never restricted, and allows() with no restrictions behaves as before", () => {
  const owner: Principal = { id: "owner:rob", kind: "owner", name: "rob", grants: [], restrictions: [{ action: "*", project: "*" }] };
  assert.equal(allows(owner, "anything", undefined), true);
  const agent: Principal = { id: "agent:ann", kind: "agent", name: "ann", grants: [{ action: "task.*", project: "*" }], asOf: T };
  assert.equal(allows(agent, "task.read", "proj-aaaaaaaaaaaaaaaaaaaa"), true);
  assert.equal(allows(agent, "project.read", "proj-aaaaaaaaaaaaaaaaaaaa"), false);
  // A principal that never had its restrictions loaded is refused, not trusted.
  const raw: Principal = { id: "agent:ann", kind: "agent", name: "ann", grants: [{ action: "task.*", project: "*" }] };
  assert.equal(allows(raw, "task.read", "proj-aaaaaaaaaaaaaaaaaaaa"), false);
});
