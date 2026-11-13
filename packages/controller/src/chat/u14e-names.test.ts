import assert from "node:assert/strict";
import { after, test } from "node:test";
import { API_VERSION } from "../api/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { GrantService } from "../security/grants.js";
import { cid, openWorld, options, type ApiExtra, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

// Card U14e: the first-run owner knows names, not IDs. A task is given to an agent by the agent's name, and with one project the owner is not asked which project a task title is about.
for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>) => Promise<void>, extra: ApiExtra = {}) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const w = await openWorld(backend, script, undefined, extra);
      try { await body(w, script); } finally { await w.close(); }
    });
  const say = (w: World, text: string) => w.chat().submit(w.ownerToken, { messageId: cid("m"), text });
  const call = async (w: World, op: string, args: Record<string, unknown> = {}) => (await w.api.handle(w.ownerToken, { v: API_VERSION, op, args } as never)) as any;

  suite("a task is given to an agent by the agent's name, in a project with no focus, and the proposal shows the name and carries the agent's ID", async (w, script) => {
    const p = await w.project("Garden");
    const t = await w.task(p, "Say hello");
    const ann = (await w.agents.create(w.owner, { commandId: cid("ag"), friendlyName: "Ann" })).id;
    script["give Say hello to Ann"] = [cmd("task.assign", { taskTitle: "Say hello", agentName: "Ann" }, "give Say hello to Ann")];
    const r = await say(w, "give Say hello to Ann");
    assert.equal(r.outcomes.length, 1);
    const o = r.outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    assert.equal(await w.assignments.getAssignment(t), undefined, "nothing is assigned before the yes");
    const applied = await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId! });
    assert.equal(applied.applied, true);
    assert.deepEqual((await w.assignments.getAssignment(t))!.owner, { kind: "agent", id: ann });
  });

  suite("a name that is no agent is refused, two agents of one name are asked about, and an ID given together with a name is refused", async (w, script) => {
    const p = await w.project("Garden");
    const t = await w.task(p, "Say hello");
    await w.agents.create(w.owner, { commandId: cid("a1"), friendlyName: "Ann" });
    script["give Say hello to Bob"] = [cmd("task.assign", { taskTitle: "Say hello", agentName: "Bob" }, "give Say hello to Bob")];
    const none = (await say(w, "give Say hello to Bob")).outcomes[0]!;
    assert.deepEqual([none.status, none.code], ["refused", "not_found"]);
    await w.agents.create(w.owner, { commandId: cid("a2"), friendlyName: "Ann" });
    script["give Say hello to Ann"] = [cmd("task.assign", { taskTitle: "Say hello", agentName: "Ann" }, "give Say hello to Ann")];
    const two = (await say(w, "give Say hello to Ann")).outcomes[0]!;
    assert.equal(two.status, "asked", JSON.stringify(two));
    script["give Say hello to Ann id"] = [cmd("task.assign", { taskTitle: "Say hello", agentName: "Ann", owner: { kind: "agent", id: "Ann" } }, "give Say hello to Ann id")];
    const both = (await say(w, "give Say hello to Ann id")).outcomes[0]!;
    assert.deepEqual([both.status, both.code], ["refused", "invalid_command"]);
    assert.equal(await w.assignments.getAssignment(t), undefined);
  });

  suite("the name is matched whatever its case, to the agent of that name among several; a retired namesake and a look-alike in other letters are not that agent; a transfer works by name too (review)", async (w, script) => {
    const p = await w.project("Garden");
    const t = await w.task(p, "Say hello");
    const old = await w.agents.create(w.owner, { commandId: cid("a0"), friendlyName: "Bob" });
    await w.agents.retire(w.owner, { commandId: cid("rt"), agentId: old.id, expectedRevision: old.revision });
    const ann = (await w.agents.create(w.owner, { commandId: cid("a1"), friendlyName: "Ann" })).id;
    const bob = (await w.agents.create(w.owner, { commandId: cid("a2"), friendlyName: "Bob" })).id;
    // "Аnn" with a Cyrillic first letter is another name: refused, never read as Ann.
    script["give Say hello to Аnn"] = [cmd("task.assign", { taskTitle: "Say hello", agentName: "Аnn" }, "give Say hello to Аnn")];
    const lookalike = (await say(w, "give Say hello to Аnn")).outcomes[0]!;
    assert.deepEqual([lookalike.status, lookalike.code], ["refused", "not_found"], JSON.stringify(lookalike));
    // Lower case, and two agents: Bob (the active one; the retired Bob is left out, so nothing is asked) is chosen, not Ann.
    script["give Say hello to bob"] = [cmd("task.assign", { taskTitle: "Say hello", agentName: "bob" }, "give Say hello to bob")];
    const o = (await say(w, "give Say hello to bob")).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    assert.equal((await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId! })).applied, true);
    assert.deepEqual((await w.assignments.getAssignment(t))!.owner, { kind: "agent", id: bob });
    script["move Say hello over to ANN"] = [cmd("task.transfer", { taskTitle: "Say hello", agentName: "ANN" }, "move Say hello over to ANN")];
    const moved = (await say(w, "move Say hello over to ANN")).outcomes[0]!;
    assert.equal(moved.status, "proposed", JSON.stringify(moved));
    assert.deepEqual((await w.assignments.getAssignment(t))!.owner, { kind: "agent", id: bob }, "nothing moves before the yes");
    assert.equal((await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: moved.proposalId! })).applied, true);
    assert.deepEqual((await w.assignments.getAssignment(t))!.owner, { kind: "agent", id: ann });
  });

  suite("a right is given to an agent by its name: the proposal is for that agent's principal, nothing is granted before the yes, and an unknown name or a name with a grantee is refused (review)", async (w, script) => {
    await w.project("Garden");
    const bob = (await w.agents.create(w.owner, { commandId: cid("a1"), friendlyName: "Bob" })).id;
    const ann = (await w.agents.create(w.owner, { commandId: cid("a2"), friendlyName: "Ann" })).id;
    const grants = async () => ((await call(w, "grant.list", {})).result.items as { grantee: string; action: string }[]).filter((g) => g.action === "task.read");
    const words = "Give ann the right task.read in the project Garden";
    script[words] = [cmd("grant.create", { agentName: "ann", action: "task.read", projectName: "Garden", basis: "x" }, words)];
    const o = (await say(w, words)).outcomes[0]!;
    assert.equal(o.status, "proposed", JSON.stringify(o));
    assert.deepEqual(await grants(), [], "nothing is granted before the yes");
    assert.equal((await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: o.proposalId! })).applied, true);
    assert.deepEqual((await grants()).map((g) => g.grantee), [`agent:${ann}`]);
    // The other agent by its name: each right goes to the agent named, whichever of the two the list gives first.
    const forBob = "Give BOB the right task.read in the project Garden";
    script[forBob] = [cmd("grant.create", { agentName: "BOB", action: "task.read", projectName: "Garden", basis: "x" }, forBob)];
    const ob = (await say(w, forBob)).outcomes[0]!;
    assert.equal(ob.status, "proposed", JSON.stringify(ob));
    assert.equal((await w.chat().applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: ob.proposalId! })).applied, true);
    assert.deepEqual((await grants()).map((g) => g.grantee).sort(), [`agent:${ann}`, `agent:${bob}`].sort());
    const unknown = "Give Carl the right task.read in the project Garden";
    script[unknown] = [cmd("grant.create", { agentName: "Carl", action: "task.read", projectName: "Garden", basis: "x" }, unknown)];
    assert.equal(((await say(w, unknown)).outcomes[0]!).code, "not_found");
    const both = `Give Ann agent:${ann} the right task.read in the project Garden`;
    script[both] = [cmd("grant.create", { agentName: "Ann", grantee: `agent:${ann}`, action: "task.read", projectName: "Garden", basis: "x" }, both)];
    assert.equal(((await say(w, both)).outcomes[0]!).code, "invalid_command");
  }, (storage, epoch) => ({ grants: GrantService.withEpoch(storage, epoch, options) }));

  suite("with exactly one project a task title needs no project; with two the owner is still asked which", async (w, script) => {
    const a = await w.project("Garden");
    const t = await w.task(a, "Water beans");
    script["Water beans is ready"] = [cmd("task.transition", { taskTitle: "Water beans", to: "ready" }, "Water beans is ready")];
    const one = (await say(w, "Water beans is ready")).outcomes[0]!;
    assert.equal(one.status, "applied", JSON.stringify(one));
    assert.equal((await call(w, "task.get", { taskId: t })).result.item.state, "ready");
    await w.project("Yard");
    script["Rename Water beans to Water the beans"] = [cmd("task.update", { taskTitle: "Water beans", title: "Water the beans" }, "Rename Water beans to Water the beans")];
    const two = (await say(w, "Rename Water beans to Water the beans")).outcomes[0]!;
    assert.equal(two.status, "asked", JSON.stringify(two));
    assert.match(two.question ?? "", /Which project/);
  });
}
