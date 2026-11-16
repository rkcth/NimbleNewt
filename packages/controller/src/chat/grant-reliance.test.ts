import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { GrantService } from "../security/index.js";
import { StatusService } from "../status/index.js";
import { adminIntent } from "../web/door.js";
import { ModelInterpreter } from "./model-interpreter.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

// Follow-up to card T7: before the owner takes a standing right back, the running work that may rely on it is listed (capped, with a count of the rest), on the page's read, in the chat's preview of the
// take-back and in a status answer the owner can ask for in free words. All four storage backends.

after(stopServer);
const LEAK = "sk-LEAK-0123456789abcdef";
const ask = (request: Record<string, unknown>, evidence: string) => ({ kind: "status", request, evidence, basis: "owner" });
const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const lines = (outcomes: readonly { lines?: readonly { text: string }[] }[]): string => outcomes.flatMap((o) => (o.lines ?? []).map((l) => l.text)).join("\n");
type Call = { ok: boolean; result?: any; error?: { code: string } };

/** A task that is ready, owned by the agent and has an attempt running (the owner's `id` is the agent's name, as the principal `agent:<name>` has it). */
async function running(w: World, projectId: string, title: string, agent: string): Promise<string> {
  const taskId = await w.task(projectId, title);
  await w.projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId, expectedRevision: 1, to: "ready" });
  await w.assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId, owner: { kind: "agent", id: agent } });
  const a = (await w.assignments.getAssignment(taskId))!;
  await w.assignments.admitAttempt({ commandId: cid("ad"), actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent } });
  return taskId;
}

test("the interpreter is told to ask what running work relies on a right, and that taking it back is shown first (follow-up to card T7)", async () => {
  let system = "";
  const m = new ModelInterpreter({ complete: async (_route, r) => { system = r.system; return "[]"; } }, () => ["a/primary"]);
  await m.interpret({ text: "would taking back that right stop anything?", quoted: [], focus: {}, proposals: [] });
  assert.match(system, /grant_reliance\(grantId\)/, "the status kind comes from the table");
  assert.match(system, /what is running that needs that right/);
  assert.match(system, /the preview names the running work that may rely on the right/);
  assert.match(system, /It says what the right covers, not what the work will use/);
});

for (const backend of backends) {
  test(`${backend.name}: the running work that may rely on a right is listed, capped, counted and said the same way in the read, the take-back preview and a status answer (follow-up to card T7)`, async () => {
    const script: Record<string, unknown[]> = {};
    let statusSvc: StatusService | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch, built) => {
      statusSvc = StatusService.withEpoch(storage, epoch, { assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts }, options);
      return { grants: GrantService.withEpoch(storage, epoch, options), status: statusSvc };
    });
    try {
      const grants = GrantService.withEpoch(w.world.storage, w.projects.epoch, options);
      const chat = w.chat({ status: statusSvc! });
      const say = async (text: string, intents: unknown[]) => { script[text] = intents; return chat.submit(w.ownerToken, { messageId: cid("m"), text }); };
      const as = (token: string, op: string, args: Record<string, unknown>) => w.api.handle(token, { v: 1, op, args } as never) as Promise<Call>;
      const rely = async (grantId: string) => (await as(w.ownerToken, "grant.reliance", { grantId })).result.items[0] as { total: number; items: { taskId: string; title: string; agentId: string; projectId: string; attemptNumber: number }[]; state: string; complete: boolean };
      const give = (grantee: string, action: string, project: string, resource?: { kind: string; id: string }) => grants.grant(w.owner, { commandId: cid("g"), grantee, action, project, ...(resource === undefined ? {} : { resource }), source: "direct", basis: "test" });

      const a = await w.project("Garden"), b = await w.project("Shed");
      await w.agent("ann", []); await w.agent("bob", []);
      const a1 = await running(w, a, "Dig the first bed", "ann");
      const a2 = await running(w, a, "Plant the beans", "ann");
      const b1 = await running(w, b, "Paint the shed", "ann");
      await running(w, a, "Bob's watering", "bob");
      // Assigned but with no attempt running, and finished: neither is running work.
      const idle = await w.task(a, "Not started");
      await w.projects.transitionTask({ commandId: cid("tr"), actor: "owner:rob", taskId: idle, expectedRevision: 1, to: "ready" });
      await w.assignments.assignTask({ commandId: cid("as"), actor: "owner:rob", taskId: idle, owner: { kind: "agent", id: "ann" } });
      const ended = await running(w, a, "Already ended", "ann");
      const asg = (await w.assignments.getAssignment(ended))!;
      await w.assignments.finishAttempt({ commandId: cid("fi"), actor: "inbox", taskId: ended, expectedRevision: asg.revision, fence: { generation: asg.generation, attemptId: asg.activeAttemptId! }, outcome: "failed" });

      const inA = await give("agent:ann", "task.update", a);
      const everywhere = await give("agent:ann", "task.update", "*");
      const bobs = await give("agent:bob", "task.update", "*");
      const oneTask = await give("agent:ann", "task.read", a, { kind: "task", id: a1 });
      await w.agent("cat", []);
      const service = await give("agent:cat", "task.update", "*");

      // The read: the right's own project, every project, another agent's, one task, and a right no agent holds.
      const one = await rely(inA.id);
      assert.deepEqual([one.total, one.items.map((i) => i.taskId).sort(), one.complete, one.state], [2, [a1, a2].sort(), true, "active"]);
      assert.deepEqual(one.items.map((i) => [i.agentId, i.attemptNumber]), [["ann", 1], ["ann", 1]]);
      assert.equal((await rely(everywhere.id)).total, 3, "every project: both gardens tasks and the shed");
      assert.deepEqual((await rely(everywhere.id)).items.map((i) => i.taskId).sort(), [a1, a2, b1].sort());
      assert.equal((await rely(bobs.id)).total, 1);
      assert.deepEqual((await rely(oneTask.id)).items.map((i) => i.taskId), [a1], "a right on one task covers only that task");
      assert.equal((await rely(service.id)).total, 0, "an agent with no running work relies on its right for nothing");
      const all = (await as(w.ownerToken, "grant.reliance", {})).result;
      assert.deepEqual([all.items.length, all.more, Object.fromEntries(all.items.map((i: any) => [i.grantId, i.total]))], [5, false, { [inA.id]: 2, [everywhere.id]: 3, [bobs.id]: 1, [oneTask.id]: 1, [service.id]: 0 }]);

      // The take-back from the page is shown first, and its preview names the running work; nothing is taken back yet.
      const page = adminIntent("grant-revoke", { grantId: inA.id, reason: "the garden is closed" });
      const proposed = await chat.submit(w.ownerToken, { messageId: cid("ui"), text: page.text }, { fixedIntents: [page.intent] } as never);
      assert.equal(proposed.outcomes[0]!.status, "proposed", JSON.stringify(proposed.outcomes));
      const shownFirst = JSON.stringify(proposed.outcomes);
      assert.match(shownFirst, /2 running tasks may rely on it/);
      assert.match(shownFirst, /Dig the first bed/);
      assert.match(shownFirst, /Plant the beans/);
      assert.doesNotMatch(shownFirst, /Paint the shed|Bob's watering|Not started|Already ended/, "only the work the right covers is named");
      assert.match(shownFirst, /may stop it at the next check/);
      assert.equal((await grants.getGrant(inA.id))!.state, "active", "still in force until Apply");

      // The same words typed in chat, and the status answer asked for in free words (no magic phrase); both are read-only.
      const typed = `take back ${everywhere.id} because the team is moving on`;
      const t = await say(typed, [cmd("grant.revoke", { grantId: everywhere.id, reason: "the team is moving on" }, typed)]);
      assert.equal(t.outcomes[0]!.status, "proposed", JSON.stringify(t.outcomes));
      assert.match(JSON.stringify(t.outcomes), /3 running tasks may rely on it/);
      const q = `what is running that needs ${inA.id}?`;
      const r = await say(q, [ask({ kind: "grant_reliance", grantId: inA.id }, q)]);
      assert.equal(r.outcomes[0]!.status, "answered", JSON.stringify(r.outcomes));
      const said = lines(r.outcomes as never);
      assert.match(said, /2 running tasks may rely on it/);
      assert.match(said, new RegExp(`"Dig the first bed" is running \\(task ${a1}, agent ann, attempt 1\\)`));
      const q2 = "does any running work depend on my standing rights?";
      const r2 = await say(q2, [ask({ kind: "grant_reliance" }, q2)]);
      const overall = lines(r2.outcomes as never);
      assert.match(overall, /4 of the 5 standing rights have running work that may rely on them/);
      assert.match(overall, /task\.update for agent:bob in every project/);
      assert.equal((await grants.getGrant(everywhere.id))!.state, "active", "asking and previewing change nothing");

      // Apply the first take-back: the right is gone, a second look says so and counts no work.
      const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: (proposed.outcomes[0] as any).proposalId } as never);
      assert.equal((applied as any).applied, true, JSON.stringify(applied));
      const gone = await rely(inA.id);
      assert.deepEqual([gone.state, gone.total], ["revoked", 0]);
      const q3 = `is anything still relying on ${inA.id}?`;
      assert.match(lines((await say(q3, [ask({ kind: "grant_reliance", grantId: inA.id }, q3)])).outcomes as never), /is already taken back/);

      // Checked: a task credential and an agent are told nothing (forbidden / missing), a made-up or malformed ID and a stray field are refused, never a server error.
      const ann = await w.agent("eve", [{ action: "*", project: "*" }]);
      assert.equal((await as(ann.token, "grant.reliance", {})).error?.code, "forbidden");
      assert.equal((await as(w.ownerToken, "grant.reliance", { grantId: "grt-aaaaaaaaaaaaaaaaaaaa" })).error?.code, "not_found");
      assert.equal((await as(w.ownerToken, "grant.reliance", { grantId: "nope" })).error?.code, "invalid_command");
      assert.equal((await as(w.ownerToken, "grant.reliance", { grantId: inA.id, limit: 1 })).error?.code, "invalid_command");
      const asked = await w.api.handle(ann.token, { v: 1, op: "status.ask", args: { request: { kind: "grant_reliance" } } } as never) as any;
      assert.doesNotMatch(JSON.stringify(asked), /Dig the first bed/, "an agent is told no title");
      await assert.rejects(statusSvc!.ask(w.owner, { kind: "grant_reliance", grantId: "bogus" } as never), /grantId/);
      await assert.rejects(statusSvc!.ask(w.owner, { kind: "grant_reliance", extra: 1 } as never), /extra|unknown/i);
    } finally { await w.close(); }
  });

  test(`${backend.name}: at most ten tasks of a right are listed with a count of the rest, a title is only a quotation, and every answer stays inside the chat's limits (follow-up to card T7)`, async () => {
    const script: Record<string, unknown[]> = {};
    let statusSvc: StatusService | undefined;
    const w = await openWorld(backend, script, undefined, (storage, epoch, built) => {
      statusSvc = StatusService.withEpoch(storage, epoch, { assignments: built.assignments, waits: WaitService.withEpoch(storage, epoch, built.assignments, options), blockers: BlockerService.withEpoch(storage, epoch, options), contracts: built.contracts }, options);
      return { grants: GrantService.withEpoch(storage, epoch, options), status: statusSvc };
    });
    try {
      const grants = GrantService.withEpoch(w.world.storage, w.projects.epoch, options);
      const chat = w.chat({ status: statusSvc! });
      const p = await w.project("Farm");
      await w.agent("dan", []);
      for (let i = 1; i <= 12; i++) await running(w, p, i === 1 ? `Hostile ${LEAK} ‮evil "quote"` : `Chore number ${i}`, "dan");
      const given = await grants.grant(w.owner, { commandId: cid("g"), grantee: "agent:dan", action: "task.update", project: "*", source: "direct", basis: "test" });
      const read = ((await w.api.handle(w.ownerToken, { v: 1, op: "grant.reliance", args: { grantId: given.id } } as never)) as Call).result.items[0];
      assert.deepEqual([read.total, read.items.length, read.complete], [12, 10, true]);

      script[`what relies on ${given.id}`] = [ask({ kind: "grant_reliance", grantId: given.id }, `what relies on ${given.id}`)];
      const again = await chat.submit(w.ownerToken, { messageId: cid("m"), text: `what relies on ${given.id}` });
      const texts = ((again.outcomes[0] as any).lines as { text: string }[]).map((l) => l.text);
      assert.equal(texts.length, 12, JSON.stringify(again.outcomes) + " the head, ten tasks and the count of the rest");
      assert.ok(texts.length <= 30, "a status answer is at most 30 lines");
      assert.match(texts[0]!, /12 running tasks may rely on it/);
      assert.equal(texts.filter((l) => / is running \(task /.test(l)).length, 10);
      assert.match(texts[11]!, /^2 more running tasks are not listed\.$/);
      const everything = texts.join("\n") + JSON.stringify(again.outcomes);
      assert.doesNotMatch(everything, /sk-LEAK/, "a credential-shaped run in a title is not repeated");
      assert.doesNotMatch(everything, /‮/, "a text-direction override is written out, never sent as the character");

      // The take-back preview carries the same head, ten entries and the count of the rest, and every line is short.
      const page = adminIntent("grant-revoke", { grantId: given.id, reason: "all done" });
      const proposed = await chat.submit(w.ownerToken, { messageId: cid("ui"), text: page.text }, { fixedIntents: [page.intent] } as never);
      assert.equal(proposed.outcomes[0]!.status, "proposed", JSON.stringify(proposed.outcomes));
      const body = await chat.getProposal(w.ownerToken, (proposed.outcomes[0] as any).proposalId);
      const notes = body!.preview.slice(1);
      assert.match(body!.preview[0]!, /Revoke grant/);
      assert.equal(notes.length, 12);
      assert.ok(notes.every((n) => n.length <= 400), "each preview line fits the chat's line limit");
      assert.match(notes[0]!, /12 running tasks may rely on it/);
      assert.match(notes[11]!, /2 more running tasks are not listed/);
      assert.doesNotMatch(JSON.stringify(body), /sk-LEAK|‮/);
      assert.ok(body!.preview.length <= 40);
    } finally { await w.close(); }
  });
}
