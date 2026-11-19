import assert from "node:assert/strict";
import { after, test } from "node:test";
import { API_VERSION } from "../api/index.js";
import { STANDARD_ROLES } from "../agents/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService } from "../security/grants.js";
import { cid, openWorld, options, type ApiExtra, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const AUTHOR = STANDARD_ROLES.find((r) => r.name === "author")!.capabilities;
const REVIEWER = STANDARD_ROLES.find((r) => r.name === "reviewer")!.capabilities;

// Card D01: "let Ann work on Garden" is one plain sentence. The chat draws up every right Ann's own roles stand for (the role templates), only in the project named, one line each, shown first.
for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const w = await openWorld(backend, script, undefined, ((storage, epoch) => ({ grants: GrantService.withEpoch(storage, epoch, options) })) as ApiExtra);
      try { await w.agents.seedStandardRoles(); await body(w, script); } finally { await w.close(); }
    });
  const say = (w: World, text: string) => w.chat().submit(w.ownerToken, { messageId: cid("m"), text });
  const call = async (w: World, op: string, args: Record<string, unknown> = {}, commandId?: string) => (await w.api.handle(w.ownerToken, { v: API_VERSION, op, ...(commandId === undefined ? {} : { commandId }), args } as never)) as any;
  const rightsOf = async (w: World, agentId: string) => ((await call(w, "grant.list", { limit: 100 })).result.items as { grantee: string; action: string; project: string; state: string; expiresAt?: string }[]).filter((g) => g.grantee === `agent:${agentId}` && g.state === "active");
  const apply = async (w: World, proposalId: string) => assert.equal((await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId })).applied, true);

  suite("one sentence proposes every right of the agent's role, one line each, only in the project named; nothing is given before the yes; the yes gives exactly those", async (w, script) => {
    const garden = await w.project("Garden");
    await w.project("Yard");
    const ann = (await w.agents.create(w.owner, { commandId: cid("a"), friendlyName: "Ann", roles: ["author"] })).id;
    const words = "let Ann work on Garden";
    script[words] = [cmd("grant.create", { agentName: "Ann", projectName: "Garden", bundle: "roles" }, words)];
    const o = (await say(w, words)).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    const preview = (o as { preview?: readonly string[] }).preview ?? [];
    for (const action of AUTHOR) assert.equal(preview.filter((l) => l.startsWith("Grant right") && new RegExp(`\\): action=${action.replace(".", "\\.")}(,|$)`).test(l)).length, 1, `one line for ${action}: ${preview.join("\n")}`);
    assert.ok(preview.every((l) => !l.startsWith("Grant right") || l.includes('only in "Garden"')), "every line says Garden only");
    assert.ok(preview.some((l) => l.startsWith('These are the rights the role author of "Ann" stands for, each only in "Garden"')), preview.join("\n"));
    assert.deepEqual(await rightsOf(w, ann), [], "nothing is given before the yes");
    await apply(w, o.proposalId!);
    const given = await rightsOf(w, ann);
    assert.deepEqual(given.map((g) => g.action).sort(), [...AUTHOR].sort());
    assert.ok(given.every((g) => g.project === garden), "only in Garden");
  });

  suite("an agent with two roles gets both bundles once each; saying it again gives nothing twice, and only what is missing is drawn up", async (w, script) => {
    const garden = await w.project("Garden");
    await w.project("Yard");
    const ann = (await w.agents.create(w.owner, { commandId: cid("a"), friendlyName: "Ann", roles: ["author", "reviewer"] })).id;
    const union = [...new Set([...AUTHOR, ...REVIEWER])];
    // One right Ann already has for good in Garden is left out of the first proposal and named as left out.
    await call(w, "grant.create", { grantee: `agent:${ann}`, action: "task.read", project: garden, basis: "Ann reads Garden" }, cid("g"));
    // A right held in another project is no right in Garden: it is still drawn up.
    const yard = (await call(w, "project.list")).result.items.find((p: { name: string }) => p.name === "Yard")!.id as string;
    await call(w, "grant.create", { grantee: `agent:${ann}`, action: "desk.read", project: yard, basis: "Ann reads Yard" }, cid("g"));
    // A right taken back is no longer held: it is drawn up again.
    const back = (await call(w, "grant.create", { grantee: `agent:${ann}`, action: "desk.write", project: garden, basis: "Ann writes Garden" }, cid("g"))).result;
    assert.equal((await call(w, "grant.revoke", { grantId: back.id, expectedRevision: back.revision, reason: "not now" }, cid("rv"))).error, undefined);
    const words = "set Ann up to work on Garden";
    script[words] = [cmd("grant.create", { agentName: "Ann", projectName: "Garden", bundle: "roles" }, words)];
    const o = (await say(w, words)).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    const preview = (o as { preview?: readonly string[] }).preview ?? [];
    assert.equal(preview.filter((l) => l.startsWith("Grant right")).length, union.length - 1, preview.join("\n"));
    assert.ok(preview.some((l) => l.includes("roles author, reviewer") && l.includes("already held there and left out: task.read")), preview.join("\n"));
    await apply(w, o.proposalId!);
    assert.deepEqual((await rightsOf(w, ann)).filter((g) => g.project === garden).map((g) => g.action).sort(), [...union].sort(), "each right once");
    const again = (await say(w, words)).outcomes[0]!;
    assert.deepEqual([again.status, again.code], ["refused", "invalid_command"], JSON.stringify(again));
    assert.match(again.message ?? "", /already holds every right/);
  });

  suite("times the owner gives apply to every right of the bundle, a right held for good is left out of a timed one, and a right held only for a while is not counted as held for good", async (w, script) => {
    const garden = await w.project("Garden");
    const ann = (await w.agents.create(w.owner, { commandId: cid("a"), friendlyName: "Ann", roles: ["reviewer"] })).id;
    await call(w, "grant.create", { grantee: `agent:${ann}`, action: "review.decide", project: garden, basis: "Ann reviews Garden" }, cid("g"));
    const words = "let Ann review in Garden until 2099-12-31";
    script[words] = [cmd("grant.create", { agentName: "Ann", projectName: "Garden", bundle: "roles", expiresAt: "2099-12-31T23:59:59.000Z" }, words)];
    const o = (await say(w, words)).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    await apply(w, o.proposalId!);
    const given = (await rightsOf(w, ann)).filter((g) => g.expiresAt !== undefined);
    assert.deepEqual(given.map((g) => g.action).sort(), REVIEWER.filter((a) => a !== "review.decide").sort(), "every right but the one held for good, each with the end the owner gave");
    assert.ok(given.every((g) => g.expiresAt === "2099-12-31T23:59:59.000Z"), JSON.stringify(given));
    const forGood = "let Ann work on Garden";
    script[forGood] = [cmd("grant.create", { agentName: "Ann", projectName: "Garden", bundle: "roles" }, forGood)];
    const o2 = (await say(w, forGood)).outcomes[0]!;
    assert.equal(o2.status, "proposed", "rights that run out do not count as held for good");
    assert.equal(((o2 as { preview?: readonly string[] }).preview ?? []).filter((l) => l.startsWith("Grant right")).length, REVIEWER.length - 1, "only the one held for good is left out");
  });

  suite("what is refused, with nothing given: an agent with no role, a bundle beside an action, a bundle with no agent name, an unknown bundle, and no project", async (w, script) => {
    await w.project("Garden");
    await w.project("Yard");
    const bob = (await w.agents.create(w.owner, { commandId: cid("b"), friendlyName: "Bob" })).id;
    const ann = (await w.agents.create(w.owner, { commandId: cid("a"), friendlyName: "Ann", roles: ["author"] })).id;
    const refused = async (words: string, args: Record<string, unknown>, code: string, message: RegExp) => {
      script[words] = [cmd("grant.create", args, words)];
      const o = (await say(w, words)).outcomes[0]!;
      assert.deepEqual([o.status, o.code], ["refused", code], `${words}: ${JSON.stringify(o)}`);
      assert.match(o.message ?? "", message, words);
    };
    await refused("let Bob work on Garden", { agentName: "Bob", projectName: "Garden", bundle: "roles" }, "invalid_command", /"Bob" has no role/);
    await refused("let Ann work on Garden with task.read", { agentName: "Ann", projectName: "Garden", bundle: "roles", action: "task.read" }, "invalid_command", /named twice over/);
    await refused(`let agent:${ann} work on Garden`, { grantee: `agent:${ann}`, projectName: "Garden", bundle: "roles" }, "invalid_command", /named by its name/);
    await refused("let Ann do everything on Garden", { agentName: "Ann", projectName: "Garden", bundle: "everything" }, "invalid_command", /bundle must be one of roles/);
    await refused("let Ann work", { agentName: "Ann", bundle: "roles" }, "invalid_command", /Which project/);
    assert.deepEqual([...(await rightsOf(w, ann)), ...(await rightsOf(w, bob))], []);
  });

  suite("the bundle follows the role template as it stands: an owner who redefined the role gets their own list", async (w, script) => {
    await w.project("Garden");
    const role = await w.agents.getRole(w.owner, "author");
    await w.agents.defineRole(w.owner, { commandId: cid("r"), name: "author", capabilities: ["task.read", "attempt.work"], expectedRevision: role!.revision });
    const ann = (await w.agents.create(w.owner, { commandId: cid("a"), friendlyName: "Ann", roles: ["author"] })).id;
    const words = "let Ann work on Garden";
    script[words] = [cmd("grant.create", { agentName: "Ann", projectName: "Garden", bundle: "roles" }, words)];
    const o = (await say(w, words)).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    await apply(w, o.proposalId!);
    assert.deepEqual((await rightsOf(w, ann)).map((g) => g.action).sort(), ["attempt.work", "task.read"]);
  });
}
