import assert from "node:assert/strict";
import { personalNamespace } from "../catalog/catalog.js";
import { after, test } from "node:test";
import { DeskService } from "../context/index.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "../dispatch/testing/world.js";
import { GrantService, PrincipalService, TaskCredentialService, allows, allowsExactly, requireAction, type Grant, type Principal } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-21T10:00:00.000Z");
const minutes = (m: number): void => { now += m * 60_000; };
const options = { clock: () => new Date(now).toISOString(), pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx { tc: TaskCredentialService; projects: ProjectService; principals: PrincipalService; grants: GrantService; desks: DeskService; owner: Principal; a: string; b: string; ta: string; ta2: string; tb: string; ann: string }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-21T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const a = (await projects.createProject({ commandId: cid("pa"), actor: "owner:rob", name: "A" })).id;
        const b = (await projects.createProject({ commandId: cid("pb"), actor: "owner:rob", name: "B" })).id;
        const task = async (p: string) => (await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: p, title: "t" })).id;
        const [ta, ta2, tb] = [await task(a), await task(a), await task(b)];
        const work = (p: string): Grant[] => ["desk.write", "desk.read", "task.read", "artifact.publish", "history.read"].map((action) => ({ action, project: p }));
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [...work(a), ...work(b)] });
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        for (const id of [ta, ta2]) await grants.grant(owner, { commandId: cid("g"), grantee: "agent:ann", action: "task.update", project: a, resource: { kind: "task", id }, source: "direct", basis: "this task" });
        await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "wide", grants: [{ action: "*", project: "*" }] });
        await body({
          tc: TaskCredentialService.withEpoch(world.storage, projects.epoch, options), projects, principals, grants,
          desks: DeskService.withEpoch(world.storage, projects.epoch, options), owner, a, b, ta, ta2, tb, ann: "agent:ann",
        });
      } finally { await world.close(); }
    });

  suite("a task credential carries only the grants of its task's project, and reaches no other project, task or project-less action", async (c) => {
    const { token } = await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta, agentId: c.ann });
    const p = await c.tc.authenticate(token);
    assert.deepEqual([p.id, p.kind, p.taskScope], [c.ann, "agent", { taskId: c.ta, projectId: c.a }]);
    assert.ok(p.grants.every((g) => g.project === c.a), "no grant for another project");
    assert.ok(allows(p, "desk.write", c.a));
    assert.ok(!allows(p, "desk.write", c.b), "the agent's own grant for project B does not come along");
    assert.ok(!allows(p, "project.create", undefined));
    assert.ok(allows(p, "task.update", c.a, { resource: { kind: "task", id: c.ta } }));
    assert.ok(!allows(p, "task.update", c.a, { resource: { kind: "task", id: c.ta2 } }), "another task of the same project, by resource");
    assert.ok(!p.grants.some((g) => g.resource?.id === c.ta2));
    assert.ok(!allowsExactly(p, "desk.write", c.b));
    assert.throws(() => requireAction(p, "task.read", c.b), (e) => e instanceof DomainError && e.code === "forbidden");
    // The agent's own credential still reaches both: the task credential is the narrower thing.
    const plain = await c.grants.effective({ id: c.ann, kind: "agent", name: "ann", grants: (await c.principals.get(c.ann))!.grants }, new Date(now).toISOString());
    assert.ok(allows(plain, "desk.write", c.b));
    // The access checks hold even for an object whose grants were not cut down: a task scope alone keeps it inside its project.
    const forged = { ...p, grants: [{ action: "*", project: "*" }] };
    assert.ok(allows(forged, "desk.write", c.a) && !allows(forged, "desk.write", c.b) && !allows(forged, "project.create", undefined) && !allows(forged, "task.update", c.a, { resource: { kind: "task", id: c.ta2 } }));
    // Taking a fresh snapshot of the task principal does not widen it.
    const again = await c.grants.effective(p, new Date(now).toISOString());
    assert.ok(!allows(again, "desk.write", c.b) && again.taskScope?.taskId === c.ta);
  });

  suite("a grant for every project is narrowed to the task's project, and a wildcard agent is still held inside it", async (c) => {
    await c.principals.enroll(c.owner, { commandId: cid("e"), kind: "agent", name: "mid", grants: [{ action: "desk.*", project: "*" }] });
    const p = await c.tc.authenticate((await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.tb, agentId: "agent:mid" })).token);
    assert.deepEqual(p.grants.map((g) => [g.action, g.project]), [["desk.*", c.b], [`tool.${personalNamespace("agent:mid").replace(/^a_/, "a-")}.*`, c.b]], "the grant for the agent's own tool namespace comes with enrolment");
    assert.ok(allows(p, "desk.read", c.b) && !allows(p, "desk.read", c.a));
    const wide = await c.tc.authenticate((await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta, agentId: "agent:wide" })).token);
    assert.ok(allows(wide, "task.update", c.a) && !allows(wide, "task.update", c.b) && !allows(wide, "principal.manage", undefined));
  });

  suite("an agent serving two projects holds a separate credential per task, and one cannot be used for the other", async (c) => {
    const one = await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta, agentId: c.ann });
    const two = await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.tb, agentId: c.ann });
    assert.notEqual(one.id, two.id);
    const pa = await c.tc.authenticate(one.token);
    const pb = await c.tc.authenticate(two.token);
    assert.ok(allows(pa, "desk.write", c.a) && !allows(pa, "desk.write", c.b));
    assert.ok(allows(pb, "desk.write", c.b) && !allows(pb, "desk.write", c.a));
    // The secret of one under the name of the other, and a made-up name, are refused alike.
    const secretOne = one.token.slice(one.token.lastIndexOf(".") + 1);
    for (const bad of [`${two.id}.${secretOne}`, `tcr-aaaaaaaaaaaaaaaaaaaa.${secretOne}`, "nonsense", "", `${one.id}.`, 7, undefined, `${one.id}.${"x".repeat(500)}`]) await refuses("unauthenticated", () => c.tc.authenticate(bad));
    // Real work through a service with each credential: records written by project A's credential are in project A only.
    const w = await c.desks.write(pa, { commandId: cid("w"), projectId: c.a, kind: "note", title: "n", body: "from task one", visibility: "shared", status: "accepted" });
    await refuses("forbidden", () => c.desks.write(pa, { commandId: cid("w"), projectId: c.b, kind: "note", title: "n", body: "wrong project", visibility: "shared", status: "accepted" }));
    assert.equal((await c.desks.read(pa, w.id)).projectId, c.a);
    await refuses("forbidden", () => c.desks.read(pb, w.id));
    // The agent's own records in project B are its own, but not through the credential for task A: being the owner of a record is not a way round the project.
    const plain = await c.principals.authenticate((await c.principals.issueCredential(c.owner, c.ann)).token);
    const mine = await c.desks.write(plain, { commandId: cid("w"), projectId: c.b, kind: "note", title: "n", body: "my own, in B", visibility: "private", status: "accepted" });
    assert.equal((await c.desks.read(plain, mine.id)).projectId, c.b);
    assert.equal((await c.desks.read(pb, mine.id)).projectId, c.b);
    await refuses("forbidden", () => c.desks.read(pa, mine.id));
    assert.deepEqual((await c.desks.list(pa, { projectId: c.b, limit: 10 })).items, []);
  });

  suite("a credential ends with its task, with a revocation, with its expiry and with the agent, and is refused at once afterwards", async (c) => {
    const { id, token } = await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta, agentId: c.ann });
    await c.tc.authenticate(token);
    // Revoked.
    const [row] = await c.tc.list(c.owner, c.ta);
    await refuses("forbidden", () => c.tc.revoke(c.ann as never, { commandId: cid("r"), credentialId: id, expectedRevision: row!.revision, reason: "x" }));
    await c.tc.revoke(c.owner, { commandId: cid("r"), credentialId: id, expectedRevision: row!.revision, reason: "done with it" });
    await refuses("unauthenticated", () => c.tc.authenticate(token));
    await refuses("invalid_command", () => c.tc.revoke(c.owner, { commandId: cid("r"), credentialId: id, expectedRevision: row!.revision + 1, reason: "again" }));
    // Reissued: the old token stays dead, the new one works.
    const fresh = await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta, agentId: c.ann });
    assert.equal(fresh.id, id);
    await refuses("unauthenticated", () => c.tc.authenticate(token));
    await c.tc.authenticate(fresh.token);
    // Replaced by another issue: the earlier token stops.
    const third = await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta, agentId: c.ann });
    await refuses("unauthenticated", () => c.tc.authenticate(fresh.token));
    await c.tc.authenticate(third.token);
    // Task done.
    const t = (await c.projects.getTask(c.ta))!;
    let revision = t.revision;
    for (const to of ["ready", "in_progress", "done"] as const) { await c.projects.transitionTask({ commandId: cid("m"), actor: "owner:rob", taskId: c.ta, expectedRevision: revision, to }); revision += 1; }
    await refuses("unauthenticated", () => c.tc.authenticate(third.token));
    await refuses("invalid_transition", () => c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta, agentId: c.ann }));
    // Expiry, and a disabled agent.
    const timed = await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta2, agentId: c.ann, expiresAt: new Date(now + 10 * 60_000).toISOString() });
    await c.tc.authenticate(timed.token);
    minutes(11);
    await refuses("unauthenticated", () => c.tc.authenticate(timed.token));
    const live = await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta2, agentId: c.ann });
    await c.tc.authenticate(live.token);
    const agent = (await c.principals.get(c.ann))!;
    await c.principals.disable(c.owner, { commandId: cid("d"), principalId: c.ann, expectedRevision: agent.revision });
    await refuses("unauthenticated", () => c.tc.authenticate(live.token));
  });

  suite("a revoked grant or a restriction shows at the next request with a task credential, and only the owner issues, revokes or lists", async (c) => {
    const { token } = await c.tc.issue(c.owner, { commandId: cid("i"), taskId: c.ta, agentId: c.ann });
    assert.ok(allows(await c.tc.authenticate(token), "desk.write", c.a));
    await c.grants.restrict(c.owner, { commandId: cid("rs"), subject: c.ann, action: "desk.write", project: c.a, reason: "stop writing" });
    const p = await c.tc.authenticate(token);
    assert.ok(!allows(p, "desk.write", c.a) && allows(p, "desk.read", c.a));
    const me = await c.principals.authenticate((await c.principals.issueCredential(c.owner, c.ann)).token);
    await refuses("forbidden", () => c.tc.issue(me, { commandId: cid("i"), taskId: c.ta, agentId: c.ann }));
    assert.deepEqual(await c.tc.list(me), []);
    for (const bad of [{ taskId: "nope", agentId: c.ann }, { taskId: c.ta, agentId: "owner:rob" }, { taskId: c.ta, agentId: "agent:ghost" }, { taskId: c.ta, agentId: c.ann, expiresAt: "tomorrow" }, { taskId: c.ta, agentId: c.ann, extra: 1 }]) await assert.rejects(() => c.tc.issue(c.owner, { commandId: cid("i"), ...bad } as never), (e: unknown) => e instanceof DomainError);
    // No secret in the owner's list, and the task credential never lets its holder read credentials.
    assert.ok(!JSON.stringify(await c.tc.list(c.owner)).includes("salt"));
    assert.ok(!allows(p, "principal.manage", undefined));
  });
}

for (const backend of backends) {
  test(`${backend.name}: agentOf gives the agent's own grants uncut, only to the dispatcher, only while the attempt's credential is active, the task open and the agent active`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const ann = await w.agent("ann", workGrants(w.project));
      const { taskId, attemptId } = await w.task("t", ann);
      const seen: Record<string, unknown> = {};
      w.worker.script = async ({ order }) => {
        const own = await w.credentials.agentOf(w.dispatcherPrincipal, order.attemptId);
        seen["own"] = { id: own.id, scope: own.taskScope, asOf: own.asOf !== undefined, read: allows(own, "task.read", w.project) };
        const owner = await w.credentials.agentOf(w.owner, order.attemptId).catch((e: unknown) => e);
        const agent = await w.credentials.agentOf(own, order.attemptId).catch((e: unknown) => e);
        seen["owner"] = owner; seen["agent"] = agent;
        seen["unknown attempt"] = await w.credentials.agentOf(w.dispatcherPrincipal, "att-aaaaaaaaaaaaaaaaaaaa").catch((e: unknown) => e);
        // The agent is disabled meanwhile: nothing is returned for it.
        const rec = (await w.principals.get("agent:ann"))!;
        await w.principals.disable(w.owner, { commandId: cid("dis"), principalId: "agent:ann", expectedRevision: rec.revision });
        seen["inactive"] = await w.credentials.agentOf(w.dispatcherPrincipal, order.attemptId).catch((e: unknown) => e);
        return { status: "completed", text: "x" };
      };
      await w.dispatcher.tick(); await w.dispatcher.idle();
      assert.deepEqual(seen["own"], { id: "agent:ann", scope: undefined, asOf: true, read: true });
      for (const k of ["owner", "agent"]) { assert.ok(seen[k] instanceof DomainError, k); assert.equal((seen[k] as DomainError).code, "forbidden", k); }
      for (const k of ["unknown attempt", "inactive"]) assert.ok(seen[k] instanceof DomainError, k);
      // The attempt is over and its credential ended with it.
      await refuses("unauthenticated", () => w.credentials.agentOf(w.dispatcherPrincipal, attemptId!));
      void taskId;
    } finally { await store.close(); }
  });

  test(`${backend.name}: agentOf is refused once the credential has expired`, async () => {
    const store = await backend.open();
    try {
      // The time cap is off unless the owner turns it on (attempts have no time limit by default), so this test turns it on: the credential ends with the attempt's time.
      const w = await buildWorld(store.storage, { options: { attemptMs: 4 * 60 * 60_000 } as never });
      const ann = await w.agent("ann", workGrants(w.project));
      await w.task("t", ann);
      let result: unknown;
      w.worker.script = async ({ order }) => {
        w.clock.advance(5 * 60 * 60_000);
        result = await w.credentials.agentOf(w.dispatcherPrincipal, order.attemptId).catch((e: unknown) => e);
        return { status: "completed", text: "x" };
      };
      await w.dispatcher.tick(); await w.dispatcher.idle();
      assert.ok(result instanceof DomainError, String(result));
    } finally { await store.close(); }
  });
}
