import assert from "node:assert/strict";
import { after, test } from "node:test";
import { API_VERSION } from "../api/index.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { cid, openWorld, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });

// Card U14e: the first-run owner knows names, not IDs. A task is given to an agent by the agent's name, and with one project the owner is not asked which project a task title is about.
for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const w = await openWorld(backend, script);
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
