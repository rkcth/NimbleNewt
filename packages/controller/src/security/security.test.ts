import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer, type World } from "../domain/testing/backends.js";
import { PrincipalService, SecureApi, redact, redactText, type Principal } from "./index.js";

after(stopServer);

const T = "2026-10-21T10:00:00.000Z";
const options = { clock: () => T, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    world: World; principals: PrincipalService; projects: ProjectService; assignments: AssignmentService; owner: Principal; ownerToken: string;
    as(principal: Principal): SecureApi;
    agent(name: string, grants?: { action: string; project: string }[]): Promise<{ principal: Principal; token: string }>;
  }
  const suite = (name: string, body: (ctx: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const issued = await principals.bootstrapOwner({ name: "rob" });
        const owner = await principals.authenticate(issued.token);
        const as = (p: Principal) => new SecureApi(p, { projects, assignments });
        const agent = async (name: string, grants: { action: string; project: string }[] = []) => {
          await principals.enroll(owner, { commandId: cid("enroll"), kind: "agent", name, grants });
          const credential = await principals.issueCredential(owner, `agent:${name}`);
          return { principal: await principals.authenticate(credential.token), token: credential.token };
        };
        await body({ world, principals, projects, assignments, owner, ownerToken: issued.token, as, agent });
      } finally { await world.close(); }
    });
  const world2 = async (ctx: Ctx) => {
    const a = await ctx.as(ctx.owner).createProject({ commandId: cid("pa"), name: "Project A" });
    const b = await ctx.as(ctx.owner).createProject({ commandId: cid("pb"), name: "Project B" });
    const ta = await ctx.as(ctx.owner).createTask({ commandId: cid("ta"), projectId: a.id, title: "task in A" });
    const tb = await ctx.as(ctx.owner).createTask({ commandId: cid("tb"), projectId: b.id, title: "task in B" });
    return { a: a.id, b: b.id, ta: ta.id, tb: tb.id };
  };
  const dump = async (world: World): Promise<string> => JSON.stringify([
    await world.storage.listAggregates("principal", { limit: 100 }), await world.storage.listAggregates("installation", { limit: 100 }), await world.storage.listAudit({ afterSeq: 0, limit: 1000 }),
  ]);

  suite("the installation has one owner, created once; its secret is shown once and stored only as a hash, in no record and no audit entry", async ({ principals, world, ownerToken, owner }) => {
    assert.equal(owner.id, "owner:rob");
    assert.equal(owner.kind, "owner");
    await refuses("forbidden", () => principals.bootstrapOwner({ name: "mallory" }), (e) => assert.match(e.message, /already has an owner/));
    await refuses("forbidden", () => principals.bootstrapOwner({ name: "rob" }));
    const secret = ownerToken.slice(ownerToken.lastIndexOf(".") + 1);
    assert.ok(secret.length >= 43);
    const stored = await dump(world);
    assert.ok(!stored.includes(secret), "the secret is in no stored record or audit entry");
    assert.ok(!stored.includes(ownerToken), "nor the token");
    assert.match(stored, /scrypt-v1/);
    const record = (await principals.get("owner:rob"))!;
    assert.deepEqual([record.hasCredential, "credential" in record], [true, false], "reads never return the credential");
  });

  suite("authentication fails the same way for an unknown principal, a wrong secret, a malformed token and a disabled principal", async ({ principals, agent, owner }) => {
    const ann = await agent("ann");
    const messages = new Set<string>();
    const bad = [
      `agent:nobody.${"A".repeat(43)}`, `${ann.token.slice(0, -2)}xx`, "", "nonsense", "agent:ann.", ".secret", `agent:ann.${"B".repeat(500)}`, undefined, 42, null, { token: ann.token },
    ];
    for (const token of bad) {
      await assert.rejects(principals.authenticate(token), (e: unknown) => { assert.ok(e instanceof DomainError && e.code === "unauthenticated"); messages.add(e.message); return true; });
    }
    // Another principal's id with ann's secret.
    const ben = await agent("ben");
    const swapped = `agent:ben.${ann.token.slice(ann.token.lastIndexOf(".") + 1)}`;
    await assert.rejects(principals.authenticate(swapped), (e: unknown) => e instanceof DomainError && e.code === "unauthenticated");
    await principals.disable(owner, { commandId: cid("dis"), principalId: "agent:ann", expectedRevision: (await principals.get("agent:ann"))!.revision });
    await assert.rejects(principals.authenticate(ann.token), (e: unknown) => { assert.ok(e instanceof DomainError && e.code === "unauthenticated"); messages.add(e.message); return true; });
    assert.equal(messages.size, 1, "one message for every kind of failure: nothing says which part was wrong");
    assert.equal((await principals.authenticate(ben.token)).id, "agent:ben");
  });

  suite("only the owner enrolls principals, grants and disables; there is no second owner and the owner cannot be disabled", async ({ principals, owner, agent }) => {
    const ann = await agent("ann");
    await refuses("forbidden", () => principals.enroll(ann.principal, { commandId: cid("e"), kind: "agent", name: "evil" }));
    await refuses("forbidden", () => principals.setGrants(ann.principal, { commandId: cid("g"), principalId: "agent:ann", expectedRevision: 1, grants: [{ action: "*", project: "*" }] }));
    await refuses("forbidden", () => principals.issueCredential(ann.principal, "agent:ann"));
    await refuses("invalid_command", () => principals.enroll(owner, { commandId: cid("e2"), kind: "owner" as never, name: "second" }), (e) => assert.match(e.message, /one owner/));
    await refuses("invalid_command", () => principals.enroll(owner, { commandId: cid("e3"), kind: "agent", name: "Bad Name" }));
    await refuses("invalid_command", () => principals.enroll(owner, { commandId: cid("e4"), kind: "agent", name: "x", grants: [{ action: "task.create", project: "nope" }] }));
    await refuses("invalid_command", () => principals.enroll(owner, { commandId: cid("e5"), kind: "agent", name: "y", grants: [{ action: "Not An Action", project: "*" }] }));
    await refuses("invalid_command", () => principals.disable(owner, { commandId: cid("d"), principalId: "owner:rob", expectedRevision: 1 }), (e) => assert.match(e.message, /owner cannot be disabled/));
    await refuses("stale_revision", () => principals.setGrants(owner, { commandId: cid("g2"), principalId: "agent:ann", expectedRevision: 9, grants: [] }));
  });

  suite("a command that names another actor is refused; the actor recorded is always the authenticated principal", async (ctx) => {
    const ids = await world2(ctx);
    const ann = await ctx.agent("ann", [{ action: "task.*", project: ids.a }, { action: "project.read", project: ids.a }]);
    const api = ctx.as(ann.principal);
    await refuses("forbidden", () => api.createTask({ commandId: cid("spoof"), projectId: ids.a, title: "x", actor: "owner:rob" } as never), (e) => assert.match(e.message, /names the actor owner:rob/));
    const made = await api.createTask({ commandId: "ann-task", projectId: ids.a, title: "mine" });
    assert.ok(made.id);
    const audit = (await ctx.world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((r) => r.type === "task.create");
    assert.deepEqual(audit.map((r) => r.actor).slice(-1), ["agent:ann"]);
    // Naming oneself is harmless.
    await api.createTask({ commandId: cid("self"), projectId: ids.a, title: "y", actor: "agent:ann" } as never);
  });

  suite("a grant for one project says nothing about another: reads, writes, lists and lookups of the other project are refused, and a missing record looks the same", async (ctx) => {
    const ids = await world2(ctx);
    const ann = await ctx.agent("ann", [{ action: "task.*", project: ids.a }, { action: "project.read", project: ids.a }]);
    const api = ctx.as(ann.principal);
    assert.equal((await api.getTask(ids.ta))!.title, "task in A");
    assert.equal((await api.getProject(ids.a))!.name, "Project A");
    await api.transitionTask({ commandId: cid("t"), taskId: ids.ta, expectedRevision: 1, to: "ready" });
    await refuses("forbidden", () => api.getTask(ids.tb));
    await refuses("forbidden", () => api.getProject(ids.b));
    await refuses("forbidden", () => api.createTask({ commandId: cid("c"), projectId: ids.b, title: "sneaky" }));
    await refuses("forbidden", () => api.transitionTask({ commandId: cid("t2"), taskId: ids.tb, expectedRevision: 1, to: "ready" }));
    await refuses("forbidden", () => api.updateTask({ commandId: cid("u"), taskId: ids.tb, expectedRevision: 1, title: "hijack" }));
    await refuses("forbidden", () => api.listTasks({ projectId: ids.b, limit: 10 }));
    await refuses("forbidden", () => api.listTasks({ limit: 10 }), (e) => assert.match(e.message, /must name a project/));
    const answer = (run: () => Promise<unknown>) => run().then(() => "returned", (e: unknown) => `${(e as DomainError).code}: ${(e as DomainError).message}`);
    const absent = await answer(() => api.getTask("task-aaaaaaaaaaaaaaaaaaaa"));
    const other = await answer(() => api.getTask(ids.tb));
    assert.equal(absent, other, "a task in another project and a task that does not exist get the very same answer, naming no project");
    assert.equal(await answer(() => api.transitionTask({ commandId: cid("h1"), taskId: ids.tb, expectedRevision: 1, to: "ready" })), await answer(() => api.transitionTask({ commandId: cid("h2"), taskId: "task-aaaaaaaaaaaaaaaaaaaa", expectedRevision: 1, to: "ready" })));
    assert.equal(await answer(() => api.getAssignment(ids.tb)), await answer(() => api.getAssignment("task-aaaaaaaaaaaaaaaaaaaa")));
    assert.ok(!other.includes("proj-"), other);
    assert.deepEqual((await api.listProjects({ limit: 10 })).items.map((p) => p.id), [ids.a], "only the readable project is listed");
    assert.equal((await api.listTasks({ projectId: ids.a, limit: 10 })).items.length, 1);
    // The owner sees everything, and a missing record is simply missing.
    const owner = ctx.as(ctx.owner);
    assert.equal((await owner.listProjects({ limit: 10 })).items.length, 2);
    await refuses("not_found", () => owner.getTask("task-aaaaaaaaaaaaaaaaaaaa"));
  });

  suite("an action that belongs to no project needs a grant for every project; a narrower grant is not enough", async (ctx) => {
    const ids = await world2(ctx);
    const narrow = await ctx.agent("narrow", [{ action: "project.create", project: ids.a }]);
    await refuses("forbidden", () => ctx.as(narrow.principal).createProject({ commandId: cid("p"), name: "nope" }));
    const wide = await ctx.agent("wide", [{ action: "project.create", project: "*" }]);
    assert.ok((await ctx.as(wide.principal).createProject({ commandId: cid("p2"), name: "ok" })).id);
    const none = await ctx.agent("none");
    await refuses("forbidden", () => ctx.as(none.principal).getProject(ids.a));
    assert.deepEqual((await ctx.as(none.principal).listProjects({ limit: 10 })).items, []);
  });

  suite("work as an attempt's owner needs the right grant and being that owner: another principal, even with the grant, cannot admit, finish or write as it", async (ctx) => {
    const ids = await world2(ctx);
    const worker = [{ action: "attempt.work", project: ids.a }, { action: "task.read", project: ids.a }, { action: "assignment.read", project: ids.a }];
    const ann = await ctx.agent("ann", worker);
    const ben = await ctx.agent("ben", worker);
    const owner = ctx.as(ctx.owner);
    await owner.transitionTask({ commandId: cid("r"), taskId: ids.ta, expectedRevision: 1, to: "ready" });
    await owner.assignTask({ commandId: cid("as"), taskId: ids.ta, owner: { kind: "agent", id: "ann" } });
    const assignment = (await owner.getAssignment(ids.ta))!;
    // Ben has the grant but is not the owner: he cannot admit an attempt for ann, nor for himself, since the task is ann's.
    await refuses("forbidden", () => ctx.as(ben.principal).admitAttempt({ commandId: cid("a1"), taskId: ids.ta, expectedRevision: assignment.revision, generation: 1, owner: { kind: "agent", id: "ann" } }), (e) => assert.match(e.message, /only its own attempts/));
    await refuses("fenced", () => ctx.as(ben.principal).admitAttempt({ commandId: cid("a2"), taskId: ids.ta, expectedRevision: assignment.revision, generation: 1, owner: { kind: "agent", id: "ben" } }));
    const admitted = await ctx.as(ann.principal).admitAttempt({ commandId: cid("a3"), taskId: ids.ta, expectedRevision: assignment.revision, generation: 1, owner: { kind: "agent", id: "ann" } });
    const fence = { generation: 1, attemptId: admitted.id };
    await refuses("forbidden", () => ctx.as(ben.principal).transitionTaskAsOwner({ commandId: cid("w"), taskId: ids.ta, expectedRevision: 2, to: "in_progress", fence }), (e) => assert.match(e.message, /not the owner/));
    await refuses("forbidden", () => ctx.as(ben.principal).finishAttempt({ commandId: cid("f"), taskId: ids.ta, expectedRevision: assignment.revision + 1, fence, outcome: "succeeded" }));
    await ctx.as(ann.principal).transitionTaskAsOwner({ commandId: cid("w2"), taskId: ids.ta, expectedRevision: 2, to: "in_progress", fence });
    await ctx.as(ann.principal).finishAttempt({ commandId: cid("f2"), taskId: ids.ta, expectedRevision: assignment.revision + 1, fence, outcome: "succeeded" });
    // And ann cannot touch project B's work at all.
    await refuses("forbidden", () => ctx.as(ann.principal).observeActivity({ commandId: cid("o"), taskId: ids.tb, observedBy: "ann", generation: 1, kind: "heartbeat" }));
    // Without the assignment grant nobody but the owner assigns.
    await refuses("forbidden", () => ctx.as(ann.principal).assignTask({ commandId: cid("as2"), taskId: ids.ta, expectedRevision: assignment.revision + 2, owner: { kind: "agent", id: "ann" } }));
  });

  suite("a tool call passes the same gate: tool.<name> in the project, with prefix grants, and nothing for another project", async (ctx) => {
    const ids = await world2(ctx);
    const ann = await ctx.agent("ann", [{ action: "tool.read-file", project: ids.a }, { action: "tool.shell.*", project: ids.a }]);
    const api = ctx.as(ann.principal);
    await api.authorizeTool("read-file", ids.ta);
    await api.authorizeTool("shell.run", ids.ta);
    await refuses("forbidden", () => api.authorizeTool("read-file", ids.tb), (e) => assert.ok(!e.message.includes("proj-"), e.message));
    await refuses("forbidden", () => api.authorizeTool("write-file", ids.ta));
    await refuses("forbidden", () => api.authorizeTool("read-file", "task-aaaaaaaaaaaaaaaaaaaa"), (e) => assert.match(e.message, /may not read that/));
    await ctx.as(ctx.owner).authorizeTool("anything", ids.tb);
  });

  suite("grants take effect on the next authentication, and a re-issued credential replaces the old one at once", async (ctx) => {
    const ids = await world2(ctx);
    const ann = await ctx.agent("ann");
    await refuses("forbidden", () => ctx.as(ann.principal).getProject(ids.a));
    const rev = (await ctx.principals.get("agent:ann"))!.revision;
    await ctx.principals.setGrants(ctx.owner, { commandId: cid("g"), principalId: "agent:ann", expectedRevision: rev, grants: [{ action: "project.read", project: ids.a }] });
    const refreshed = await ctx.principals.authenticate(ann.token);
    assert.equal((await ctx.as(refreshed).getProject(ids.a))!.name, "Project A");
    const second = await ctx.principals.issueCredential(ctx.owner, "agent:ann");
    await refuses("unauthenticated", () => ctx.principals.authenticate(ann.token));
    assert.equal((await ctx.principals.authenticate(second.token)).id, "agent:ann");
    await refuses("not_found", () => ctx.principals.issueCredential(ctx.owner, "agent:ghost"));
  });

  suite("secrets are removed from the messages a caller sees", async (ctx) => {
    const ids = await world2(ctx);
    const ann = await ctx.agent("ann", [{ action: "task.*", project: ids.a }]);
    const leak = "Bearer abcdefghijklmnopqrstuvwxyz0123456789";
    await assert.rejects(ctx.as(ann.principal).createTask({ commandId: cid("c"), projectId: ids.a, title: "x", actor: `agent:other ${leak} ${ann.token}` } as never), (e: unknown) => {
      assert.ok(e instanceof DomainError && e.code === "forbidden");
      assert.ok(!e.message.includes("abcdefghijklmnopqrstuvwxyz"), e.message);
      assert.ok(!e.message.includes(ann.token.slice(ann.token.lastIndexOf(".") + 1)), e.message);
      return true;
    });
  });
}

for (const backend of backends) {
  const suite = (name: string, body: (ctx: { world: World; principals: PrincipalService; projects: ProjectService; assignments: AssignmentService; owner: Principal; issued: { principalId: string; token: string }; as(p: Principal): SecureApi; agent(name: string, grants?: { action: string; project: string }[]): Promise<Principal> }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const assignments = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const issued = await principals.bootstrapOwner({ name: "rob" });
        const owner = await principals.authenticate(issued.token);
        const agent = async (name: string, grants: { action: string; project: string }[] = []) => {
          await principals.enroll(owner, { commandId: cid("enroll"), kind: "agent", name, grants });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${name}`)).token);
        };
        await body({ world, principals, projects, assignments, owner, issued, as: (p) => new SecureApi(p, { projects, assignments }), agent });
      } finally { await world.close(); }
    });

  suite("two principals can use the same command ID without meeting: neither can probe the other's IDs or block them, and their records differ", async ({ as, owner, agent, projects }) => {
    const p = await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "P" });
    const q = await projects.createProject({ commandId: cid("q"), actor: "owner:rob", name: "Q" });
    const bob = await agent("bob", [{ action: "task.*", project: q.id }]);
    const first = await as(bob).createTask({ commandId: "future", projectId: q.id, title: "bob's" });
    const second = await as(owner).createTask({ commandId: "future", projectId: p.id, title: "the owner's" });
    assert.notEqual(first.id, second.id, "the same command ID names different records for different principals");
    assert.equal((await projects.getTask(second.id))!.title, "the owner's", "bob's use of the ID did not block the owner's");
    // Reusing one's own command ID for a different command is still a conflict; for the same command it replays.
    await refuses("command_conflict", () => as(bob).createTask({ commandId: "future", projectId: q.id, title: "something else" }));
    assert.equal((await as(bob).createTask({ commandId: "future", projectId: q.id, title: "bob's" })).replayed, true);
    // Bob reusing an ID the owner used gets no hint that it was used.
    const probe = await as(bob).createTask({ commandId: "future", projectId: q.id, title: "bob's" });
    assert.equal(probe.id, first.id);
  });

  suite("a principal reports only its own activity", async ({ as, owner, agent, projects, assignments }) => {
    const p = await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: "P" });
    const t = await projects.createTask({ commandId: cid("t"), actor: "owner:rob", projectId: p.id, title: "x" });
    const ann = await agent("ann", [{ action: "attempt.work", project: p.id }]);
    await refuses("forbidden", () => as(ann).observeActivity({ commandId: cid("o"), taskId: t.id, observedBy: "bob", generation: 1, kind: "heartbeat" }), (e) => assert.match(e.message, /only its own activity/));
    await as(ann).observeActivity({ commandId: cid("o2"), taskId: t.id, observedBy: "ann", generation: 1, kind: "heartbeat" });
    assert.equal((await assignments.getActivity(t.id))!.observedBy, "ann");
    await as(owner).observeActivity({ commandId: cid("o3"), taskId: t.id, observedBy: "bob", generation: 1, kind: "heartbeat" });
  });

  suite("listing projects fills the page with readable ones even when many unreadable ones come first", async ({ as, agent, projects }) => {
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push((await projects.createProject({ commandId: cid("p"), actor: "owner:rob", name: `P${i}` })).id);
    const target = [...ids].sort().at(-1)!;
    const reader = await agent("reader", [{ action: "project.read", project: target }]);
    const page = await as(reader).listProjects({ limit: 2 });
    assert.deepEqual(page.items.map((p) => p.id), [target], "the one readable project is found even though it sorts last");
    assert.equal(page.next, undefined);
  });
}

for (const backend of backends) {
  test(`${backend.name}: bootstrapping again, with the same command ID or another, is refused rather than returning a token that works for nothing`, async () => {
    const world = await backend.open();
    try {
      const epoch = (await ProjectService.open(world.storage, { holder: "c1", ...options })).epoch;
      const principals = PrincipalService.withEpoch(world.storage, epoch, options);
      const first = await principals.bootstrapOwner({ name: "rob", commandId: "install-1" });
      assert.equal((await principals.authenticate(first.token)).id, "owner:rob");
      await refuses("forbidden", () => principals.bootstrapOwner({ name: "rob", commandId: "install-1" }), (e) => assert.match(e.message, /already bootstrapped/));
      await refuses("forbidden", () => principals.bootstrapOwner({ name: "other", commandId: "install-2" }), (e) => assert.match(e.message, /already has an owner/));
      assert.equal((await principals.authenticate(first.token)).id, "owner:rob", "the original credential still works");
    } finally { await world.close(); }
  });
}

test("redaction replaces secret-shaped text and the values of fields named like secrets, however deep", () => {
  const token = `agent:ann.${"x".repeat(43)}`;
  assert.equal(redactText(`token=${token} next`), "[redacted] next");
  assert.equal(redactText(`use ${token} next`), "use [redacted] next");
  assert.equal(redactText("Authorization: Bearer abcdefghijklmnop1234567890"), "Authorization: [redacted]");
  assert.equal(redactText("key sk-abcdefghijklmnopqrstuvwxyz and ghp_abcdefghijklmnopqrstuvwxyz0123456789 and AKIAABCDEFGHIJKLMNOP"), "key [redacted] and [redacted] and [redacted]");
  assert.equal(redactText("-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----"), "[redacted]");
  assert.equal(redactText("postgres://nn:hunter2@db.example:5432/x"), "postgres://nn:[redacted]@db.example:5432/x");
  assert.equal(redactText("nothing to hide here, owner:rob and agent:ann are fine"), "nothing to hide here, owner:rob and agent:ann are fine");
  const input = { name: "ok", apiKey: "k1", nested: { password: "p", list: [{ secret: "s", text: `use ${token}` }], keep: 3 }, token: null, authorization: "Bearer zzzzzzzzzzzzzzzzzzzz" };
  assert.equal(redactText("mysql://admin:pw123@db/x and https://u:p4ss@host/y"), "mysql://admin:[redacted]@db/x and https://u:[redacted]@host/y");
  assert.equal(redactText("jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijk end"), "jwt [redacted] end");
  assert.equal(redactText("slack xoxb-1234567890-abcdefghij here"), "slack [redacted] here");
  assert.equal(redactText("set password=hunter2 now"), "set [redacted] now");
  assert.deepEqual(redact({ inputTokens: 1200, outputTokens: 80, accessToken: "a", client_secret: "b", userKey: "keep", apiKey: "c", signingKey: "d" }), { inputTokens: 1200, outputTokens: 80, accessToken: "[redacted]", client_secret: "[redacted]", userKey: "keep", apiKey: "[redacted]", signingKey: "[redacted]" }, "counts of tokens are not secrets");
  assert.deepEqual(redact(input), { name: "ok", apiKey: "[redacted]", nested: { password: "[redacted]", list: [{ secret: "[redacted]", text: "use [redacted]" }], keep: 3 }, token: null, authorization: "[redacted]" });
  assert.equal(input.apiKey, "k1", "the input is not changed");
  let deep: Record<string, unknown> = { v: 1 };
  for (let i = 0; i < 100; i++) deep = { next: deep };
  assert.ok(JSON.stringify(redact(deep)).includes("[redacted]"), "a hostile depth is cut off, not followed");
});
