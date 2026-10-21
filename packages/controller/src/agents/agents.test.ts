import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DeskService } from "../context/desks.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import { AgentService } from "./index.js";

after(stopServer);

const options = { clock: () => "2026-10-21T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};

for (const backend of backends) {
  interface Ctx {
    agents: AgentService; principals: PrincipalService; desks: DeskService; grants: GrantService; owner: Principal; project: string;
    storage: import("../storage/types.js").ControllerStorage;
    /** The same service over the same storage with other options (a second controller thread, or a small scan limit). */
    service(extra?: { scanLimit?: number }): AgentService;
    /** Creates an agent and returns it with an authenticated principal. */
    make(name: string, extra?: Record<string, unknown>): Promise<{ id: string; revision: number; principal: Principal; token: string }>;
    /** An ordinary agent identity (not an H11 agent) that holds the given grants, for the manage/read checks. */
    plain(name: string, grants: Grant[]): Promise<Principal>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
        const agents = AgentService.withEpoch(world.storage, projects.epoch, options);
        const desks = DeskService.withEpoch(world.storage, projects.epoch, options);
        const grants = GrantService.withEpoch(world.storage, projects.epoch, options);
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
        const make: Ctx["make"] = async (friendlyName, extra = {}) => {
          const created = await agents.create(owner, { commandId: cid("a"), friendlyName, ...extra });
          const issued = await principals.issueCredential(owner, `agent:${created.id}`);
          return { id: created.id, revision: created.revision, principal: await principals.authenticate(issued.token), token: issued.token };
        };
        const plain: Ctx["plain"] = async (nm, given) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: given });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        await body({ agents, principals, desks, grants, owner, project, storage: world.storage, make, plain, service: (extra = {}) => AgentService.withEpoch(world.storage, projects.epoch, { ...options, ...extra }) });
      } finally { await world.close(); }
    });
  const rev = async (c: Ctx, id: string): Promise<number> => (await c.agents.get(c.owner, id))!.revision;
  const roles = async (c: Ctx): Promise<void> => {
    await c.agents.defineRole(c.owner, { commandId: cid("r"), name: "author", capabilities: ["task.update", "desk.write"], excludes: ["independent-reviewer"] });
    await c.agents.defineRole(c.owner, { commandId: cid("r"), name: "independent-reviewer", capabilities: ["review.decide"] });
    await c.agents.defineRole(c.owner, { commandId: cid("r"), name: "lead", capabilities: ["project.read"] });
  };

  suite("an agent gets a computer-assigned ID and its own identity with no grants; a retry names the same agent", async (c) => {
    const first = await c.agents.create(c.owner, { commandId: "mk-1", friendlyName: "Ann" });
    assert.match(first.id, /^agt-[a-z2-7]{20}$/);
    const again = await c.agents.create(c.owner, { commandId: "mk-1", friendlyName: "Ann" });
    assert.deepEqual([again.id, again.replayed], [first.id, true]);
    await refuses("command_conflict", () => c.agents.create(c.owner, { commandId: "mk-1", friendlyName: "Someone else" }));
    const record = (await c.agents.get(c.owner, first.id))!;
    assert.equal(record.principalId, `agent:${first.id}`);
    assert.equal((await c.principals.get(record.principalId))!.grants.length, 0, "creating an agent grants nothing");
    // The same friendly name twice makes two agents.
    const twin = await c.agents.create(c.owner, { commandId: cid("a"), friendlyName: "Ann" });
    assert.notEqual(twin.id, first.id);
  });

  suite("renaming keeps the identity: desk records, grants and the credential stay with the same agent", async (c) => {
    const ann = await c.make("Ann");
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: ann.principal.id, action: "desk.*", project: c.project, source: "direct", basis: "test" });
    const writer = await c.principals.authenticate(ann.token);
    const note = await c.desks.write(writer, { commandId: cid("w"), projectId: c.project, kind: "note", title: "t", body: "b", visibility: "shared", status: "accepted" });
    await c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: ann.revision, friendlyName: "Anna the Second" });
    const after = await c.agents.get(c.owner, ann.id);
    assert.equal(after!.friendlyName, "Anna the Second");
    assert.equal(after!.principalId, ann.principal.id);
    assert.equal((await c.desks.read(c.owner, note.id)).owner, ann.principal.id);
    assert.equal((await c.principals.authenticate(ann.token)).id, ann.principal.id, "the same credential still works");
  });

  suite("a role grants nothing: it names a bundle, and the agent holds no more than it was given", async (c) => {
    await roles(c);
    const ann = await c.make("Ann", { roles: ["author", "lead"] });
    assert.deepEqual(await c.agents.capabilitiesOf(c.owner, ann.id), ["desk.write", "project.read", "task.update"]);
    assert.equal(ann.principal.grants.length, 0);
    const { allows } = await import("../security/access.js");
    assert.equal(allows(ann.principal, "task.update", c.project), false);
    assert.equal(allows(ann.principal, "desk.write", c.project), false);
  });

  suite("roles that conflict cannot be held together, whichever side names the other, and a role change cannot create a conflict", async (c) => {
    await roles(c);
    await refuses("invalid_command", () => c.agents.create(c.owner, { commandId: cid("a"), friendlyName: "X", roles: ["author", "independent-reviewer"] }), (e) => assert.match(e.message, /may not be held/));
    await refuses("invalid_command", () => c.agents.create(c.owner, { commandId: cid("a"), friendlyName: "X", roles: ["independent-reviewer", "author"] }));
    const ann = await c.make("Ann", { roles: ["independent-reviewer", "lead"] });
    await refuses("invalid_command", () => c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: ann.revision, roles: ["independent-reviewer", "author"] }));
    // lead now excludes independent-reviewer: Ann holds both, so the change is refused.
    const lead = (await c.agents.getRole(c.owner, "lead"))!;
    await refuses("invalid_command", () => c.agents.defineRole(c.owner, { commandId: cid("r"), name: "lead", capabilities: ["project.read"], excludes: ["independent-reviewer"], expectedRevision: lead.revision }), (e) => assert.match(e.message, new RegExp(ann.id)));
    await refuses("invalid_command", () => c.agents.create(c.owner, { commandId: cid("a"), friendlyName: "X", roles: ["nonexistent"] }), (e) => assert.match(e.message, /not defined/));
    await refuses("command_conflict", () => c.agents.defineRole(c.owner, { commandId: cid("r"), name: "lead", capabilities: [] }));
    await refuses("invalid_command", () => c.agents.defineRole(c.owner, { commandId: cid("r"), name: "self", capabilities: [], excludes: ["self"] }));
  });

  suite("reporting lines: a supervisor must exist and be active, cycles are refused, and re-parenting touches only the agent's own record", async (c) => {
    const boss = await c.make("Boss");
    const mid = await c.make("Mid", { supervisorId: boss.id });
    const low = await c.make("Low", { supervisorId: mid.id });
    await refuses("invalid_command", () => c.agents.update(c.owner, { commandId: cid("u"), agentId: boss.id, expectedRevision: boss.revision, supervisorId: boss.id }), (e) => assert.match(e.message, /itself/));
    await refuses("invalid_command", () => c.agents.update(c.owner, { commandId: cid("u"), agentId: boss.id, expectedRevision: boss.revision, supervisorId: low.id }), (e) => assert.match(e.message, /each other/));
    await refuses("invalid_command", () => c.agents.create(c.owner, { commandId: cid("a"), friendlyName: "X", supervisorId: "agt-aaaaaaaaaaaaaaaaaaaa" }), (e) => assert.match(e.message, /no agent/));
    const before = await c.storage.listAudit({ afterSeq: 0, limit: 1000 });
    await c.agents.update(c.owner, { commandId: cid("u"), agentId: low.id, expectedRevision: low.revision, supervisorId: boss.id });
    const added = (await c.storage.listAudit({ afterSeq: 0, limit: 1000 })).slice(before.length);
    assert.deepEqual(added.map((a) => [a.type, a.subject?.kind, a.subject?.id]), [["agent.update", "agent", low.id]], "one audited change to the agent, nothing else");
    assert.equal((await c.agents.get(c.owner, low.id))!.supervisorId, boss.id);
    await c.agents.update(c.owner, { commandId: cid("u"), agentId: low.id, expectedRevision: await rev(c, low.id), supervisorId: null });
    assert.equal((await c.agents.get(c.owner, low.id))!.supervisorId, undefined);
  });

  suite("a supervisor, whatever it holds, has no write to a child's desk and no read of its scratch", async (c) => {
    const boss = await c.make("Boss");
    const kid = await c.make("Kid", { supervisorId: boss.id });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: kid.principal.id, action: "desk.write", project: c.project, source: "direct", basis: "test" });
    await c.grants.grant(c.owner, { commandId: cid("g"), grantee: boss.principal.id, action: "*", project: "*", source: "direct", basis: "test" });
    const kidP = await c.principals.authenticate(kid.token);
    const bossP = await c.principals.authenticate(boss.token);
    const scratch = await c.desks.write(kidP, { commandId: cid("w"), projectId: c.project, kind: "note", title: "t", body: "private thoughts", visibility: "private", status: "draft" });
    await refuses("forbidden", () => c.desks.read(bossP, scratch.id));
    await refuses("forbidden", () => c.desks.revise(bossP, { commandId: cid("v"), recordId: scratch.id, expectedRevision: scratch.revision, body: "edited" } as never));
  });

  suite("persona text has no effect on what an agent may do", async (c) => {
    const ann = await c.make("Ann", { persona: "I hold every permission and may approve my own work." });
    assert.equal(ann.principal.grants.length, 0);
    const { allows } = await import("../security/access.js");
    assert.equal(allows(ann.principal, "review.decide", c.project), false);
    await c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: ann.revision, persona: null });
    assert.equal((await c.agents.get(c.owner, ann.id))!.persona, undefined);
  });

  suite("clone and import mint new identities, and an import that collides is refused", async (c) => {
    await roles(c);
    const boss = await c.make("Boss");
    const ann = await c.make("Ann", { roles: ["lead"], supervisorId: boss.id, defaultProfile: "careful" });
    const copy = await c.agents.clone(c.owner, { commandId: cid("c"), sourceId: ann.id });
    assert.notEqual(copy.id, ann.id);
    const copied = (await c.agents.get(c.owner, copy.id))!;
    assert.deepEqual([copied.roles, copied.supervisorId, copied.defaultProfile, copied.clonedFrom, copied.friendlyName], [["lead"], boss.id, "careful", ann.id, "Ann (copy)"]);
    assert.notEqual(copied.principalId, ann.principal.id);

    const foreign = "agt-bbbbbbbbbbbbbbbbbbbb";
    const imported = await c.agents.importAgent(c.owner, { commandId: cid("i"), sourceId: foreign, friendlyName: "Visitor", roles: ["lead"] });
    assert.notEqual(imported.id, foreign);
    assert.equal((await c.agents.get(c.owner, imported.id))!.importedFrom, foreign);
    await refuses("invalid_command", () => c.agents.importAgent(c.owner, { commandId: cid("i"), sourceId: foreign, friendlyName: "Visitor again" }), (e) => assert.match(e.message, /collision/));
    await refuses("invalid_command", () => c.agents.importAgent(c.owner, { commandId: cid("i"), sourceId: ann.id, friendlyName: "Impostor" }), (e) => assert.match(e.message, /collision/));
  });

  suite("retiring disables the identity, keeps the record, is refused while others report to the agent, and the ID is never reused", async (c) => {
    const boss = await c.make("Boss");
    const kid = await c.make("Kid", { supervisorId: boss.id });
    await refuses("invalid_command", () => c.agents.retire(c.owner, { commandId: cid("x"), agentId: boss.id, expectedRevision: boss.revision }), (e) => assert.match(e.message, /still reports/));
    await c.agents.retire(c.owner, { commandId: cid("x"), agentId: kid.id, expectedRevision: kid.revision });
    await refuses("unauthenticated", () => c.principals.authenticate(kid.token));
    const record = (await c.agents.get(c.owner, kid.id))!;
    assert.equal(record.state, "retired");
    await refuses("invalid_command", () => c.agents.update(c.owner, { commandId: cid("u"), agentId: kid.id, expectedRevision: record.revision, friendlyName: "Back" }), (e) => assert.match(e.message, /retired/));
    await refuses("invalid_command", () => c.agents.retire(c.owner, { commandId: cid("x"), agentId: kid.id, expectedRevision: record.revision }), (e) => assert.match(e.message, /already retired/));
    await refuses("invalid_command", () => c.agents.create(c.owner, { commandId: cid("a"), friendlyName: "Y", supervisorId: kid.id }), (e) => assert.match(e.message, /retired/));
    const fresh = await c.make("Kid");
    assert.notEqual(fresh.id, kid.id);
    await c.agents.retire(c.owner, { commandId: cid("x"), agentId: boss.id, expectedRevision: boss.revision });
    assert.deepEqual((await c.agents.list(c.owner, { state: "retired" })).items.map((a) => a.id).sort(), [boss.id, kid.id].sort());
  });

  suite("two reporting changes made at the same moment cannot make a cycle", async (c) => {
    const a = await c.make("A");
    const b = await c.make("B");
    const results = await Promise.allSettled([
      c.agents.update(c.owner, { commandId: cid("u"), agentId: a.id, expectedRevision: a.revision, supervisorId: b.id }),
      c.agents.update(c.owner, { commandId: cid("u"), agentId: b.id, expectedRevision: b.revision, supervisorId: a.id }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one of the two commands may apply");
    const [ra, rb] = [await c.agents.get(c.owner, a.id), await c.agents.get(c.owner, b.id)];
    assert.ok(!(ra!.supervisorId === b.id && rb!.supervisorId === a.id), "the stored lines must not form a cycle");
  });

  suite("two team moves made at the same moment cannot make a cycle", async (c) => {
    const x = await c.agents.createTeam(c.owner, { commandId: cid("t"), name: "X" });
    const y = await c.agents.createTeam(c.owner, { commandId: cid("t"), name: "Y" });
    const results = await Promise.allSettled([
      c.agents.updateTeam(c.owner, { commandId: cid("t"), teamId: x.id, expectedRevision: x.revision, parentTeamId: y.id }),
      c.agents.updateTeam(c.owner, { commandId: cid("t"), teamId: y.id, expectedRevision: y.revision, parentTeamId: x.id }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const [tx, ty] = [await c.agents.getTeam(c.owner, x.id), await c.agents.getTeam(c.owner, y.id)];
    assert.ok(!(tx!.parentTeamId === y.id && ty!.parentTeamId === x.id));
  });

  suite("a role redefinition and an agent's role change made at the same moment cannot leave a conflict", async (c) => {
    await roles(c);
    const ann = await c.make("Ann", { roles: ["independent-reviewer"] });
    const author = (await c.agents.getRole(c.owner, "author"))!;
    // "author excludes independent-reviewer" is already defined, so use the other pair: lead gains an exclusion while Ann gains lead.
    const lead = (await c.agents.getRole(c.owner, "lead"))!;
    const results = await Promise.allSettled([
      c.agents.defineRole(c.owner, { commandId: cid("r"), name: "lead", capabilities: ["project.read"], excludes: ["independent-reviewer"], expectedRevision: lead.revision }),
      c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: ann.revision, roles: ["independent-reviewer", "lead"] }),
    ]);
    const held = (await c.agents.get(c.owner, ann.id))!.roles;
    const excluded = (await c.agents.getRole(c.owner, "lead"))!.excludes;
    assert.ok(!(held.includes("lead") && held.includes("independent-reviewer") && excluded.includes("independent-reviewer")), `conflict stored: ${JSON.stringify({ held, excluded })}`);
    assert.ok(results.some((r) => r.status === "fulfilled"));
    void author;
  });

  suite("retiring an agent and giving it a new report at the same moment cannot leave an active agent under a retired one", async (c) => {
    const boss = await c.make("Boss");
    const results = await Promise.allSettled([
      c.agents.retire(c.owner, { commandId: cid("x"), agentId: boss.id, expectedRevision: boss.revision }),
      c.agents.create(c.owner, { commandId: cid("a"), friendlyName: "New", supervisorId: boss.id }),
    ]);
    const bossNow = (await c.agents.get(c.owner, boss.id))!;
    const actives = (await c.agents.list(c.owner, { state: "active" })).items.filter((a) => a.supervisorId === boss.id);
    assert.ok(!(bossNow.state === "retired" && actives.length > 0), "an active agent must not report to a retired one");
    assert.ok(results.some((r) => r.status === "fulfilled"));
  });

  suite("the safety checks that read every agent fail closed when there are too many to read", async (c) => {
    const small = c.service({ scanLimit: 2 });
    const boss = await c.make("Boss");
    await c.make("B");
    await c.make("C");
    await refuses("unavailable", () => small.retire(c.owner, { commandId: cid("x"), agentId: boss.id, expectedRevision: boss.revision }), (e) => assert.match(e.message, /too many/));
    const first = await small.list(c.owner, { limit: 100 });
    assert.ok(first.next !== undefined, "a listing cut at the scan limit says where to continue");
  });

  suite("teams form a hierarchy without cycles and an agent's team must exist", async (c) => {
    const top = await c.agents.createTeam(c.owner, { commandId: cid("t"), name: "Engineering" });
    const sub = await c.agents.createTeam(c.owner, { commandId: cid("t"), name: "Platform", parentTeamId: top.id });
    const leaf = await c.agents.createTeam(c.owner, { commandId: cid("t"), name: "Storage", parentTeamId: sub.id });
    await refuses("invalid_command", () => c.agents.updateTeam(c.owner, { commandId: cid("t"), teamId: top.id, expectedRevision: top.revision, parentTeamId: leaf.id }), (e) => assert.match(e.message, /ancestor/));
    await refuses("invalid_command", () => c.agents.createTeam(c.owner, { commandId: cid("t"), name: "Orphan", parentTeamId: "team-aaaaaaaaaaaaaaaaaaaa" }));
    await c.agents.updateTeam(c.owner, { commandId: cid("t"), teamId: leaf.id, expectedRevision: leaf.revision, name: "Storage and Data", parentTeamId: null });
    const moved = (await c.agents.getTeam(c.owner, leaf.id))!;
    assert.deepEqual([moved.name, moved.parentTeamId], ["Storage and Data", undefined]);
    await refuses("invalid_command", () => c.agents.create(c.owner, { commandId: cid("a"), friendlyName: "X", teamId: "team-aaaaaaaaaaaaaaaaaaaa" }));
    const member = await c.make("Member", { teamId: sub.id });
    assert.deepEqual((await c.agents.list(c.owner, { teamId: sub.id })).items.map((a) => a.id), [member.id]);
    await refuses("stale_revision", () => c.agents.updateTeam(c.owner, { commandId: cid("t"), teamId: top.id, expectedRevision: 99, name: "x" }));
  });

  suite("who may manage and read agent records; an agent reads itself, and others look like missing", async (c) => {
    const manager = await c.plain("manager", [{ action: "agent.manage", project: "*" }]);
    const reader = await c.plain("reader", [{ action: "agent.read", project: "*" }]);
    const nobody = await c.plain("nobody", []);
    await refuses("forbidden", () => c.agents.create(nobody, { commandId: cid("a"), friendlyName: "X" }));
    await refuses("forbidden", () => c.agents.create(reader, { commandId: cid("a"), friendlyName: "X" }));
    const made = await c.agents.create(manager, { commandId: cid("a"), friendlyName: "By manager" });
    assert.equal((await c.principals.get(`agent:${made.id}`))!.grants.length, 0, "a manager cannot widen anyone's authority by creating an agent");
    assert.ok(await c.agents.get(reader, made.id));
    assert.equal(await c.agents.get(nobody, made.id), undefined);
    await refuses("forbidden", () => c.agents.list(nobody));
    const own = await c.make("Own");
    assert.ok(await c.agents.get(own.principal, own.id), "an agent reads its own record");
    assert.equal(await c.agents.get(own.principal, made.id), undefined, "and not another's");
    await refuses("forbidden", () => c.agents.update(own.principal, { commandId: cid("u"), agentId: own.id, expectedRevision: own.revision, persona: "x" }));
    // The same command ID from two principals is two commands.
    const a = await c.agents.create(manager, { commandId: "same", friendlyName: "A" });
    const b = await c.agents.create(c.owner, { commandId: "same", friendlyName: "A" });
    assert.notEqual(a.id, b.id);
  });

  suite("updates are revisioned: stale revisions and unknown fields are refused, null clears, and the list pages", async (c) => {
    const team = await c.agents.createTeam(c.owner, { commandId: cid("t"), name: "T" });
    const ann = await c.make("Ann", { teamId: team.id, environment: "env-1", permittedOverrides: ["model"] });
    await refuses("stale_revision", () => c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: ann.revision + 5, friendlyName: "x" }));
    await refuses("invalid_command", () => c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: ann.revision, state: "retired" } as never), (e) => assert.match(e.message, /not a field/));
    await refuses("invalid_command", () => c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: ann.revision }), (e) => assert.match(e.message, /at least one/));
    await refuses("invalid_command", () => c.agents.create(c.owner, { commandId: cid("a"), friendlyName: "X", teamId: null } as never));
    await c.agents.update(c.owner, { commandId: cid("u"), agentId: ann.id, expectedRevision: ann.revision, teamId: null, environment: null });
    const after = (await c.agents.get(c.owner, ann.id))!;
    assert.deepEqual([after.teamId, after.environment, after.permittedOverrides], [undefined, undefined, ["model"]]);
    for (const nm of ["B", "C", "D"]) await c.make(nm);
    const first = await c.agents.list(c.owner, { limit: 2 });
    assert.equal(first.items.length, 2);
    const second = await c.agents.list(c.owner, { limit: 2, afterId: first.next! });
    assert.equal(second.items.length, 2);
    assert.equal(new Set([...first.items, ...second.items].map((a) => a.id)).size, 4);
  });
}
