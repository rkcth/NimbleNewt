import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { MeetingRecordService, taskUpdateApplier, type DecisionRecordBody } from "../meetings/index.js";
import { GrantService } from "../security/index.js";
import type { ChatService, Outcome } from "./index.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const OP = "meeting.record.owner-respond";

/** The owner's answer to a meeting decision that waits for them, by chat (card M02h, second slice), over every backend. */
for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, ctl: Ctl) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const holder: { r?: MeetingRecordService } = {};
      const lazy = new Proxy({}, { get: (_t, k) => (...a: unknown[]) => (holder.r as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string]!(...a) }) as MeetingRecordService;
      const w = await openWorld(backend, script, undefined, { records: lazy });
      const grants = GrantService.withEpoch(w.world.storage, w.projects.epoch, options);
      const authority = async (id: string) => { const p = await w.principals.get(id); return p === undefined ? undefined : grants.effective({ id, kind: p.kind, name: p.name, grants: p.grants }, options.clock()); };
      holder.r = MeetingRecordService.withEpoch(w.world.storage, w.projects.epoch, { meetings: w.meetings, decisions: w.decisions }, { ...options, authority, appliers: { "task.update": taskUpdateApplier(w.projects) }, shareable: async () => false });
      const records = holder.r;
      const project = await w.project("A");
      const mgr = await w.agent("mgr", [{ action: "meeting.manage", project }]);
      const crew = [await w.agent("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }, { action: "task.update", project }]), await w.agent("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]), await w.agent("cy", [{ action: "task.read", project }, { action: "meeting.attend", project }])];
      const ctl: Ctl = {
        project, mgrToken: mgr.token, crewTokens: crew.map((c) => c.token),
        decision: async (id) => (await records.decision(w.owner, id)) as unknown as DecisionRecordBody & { id: string },
        /** An adopted decision with one task change that waits for the owner, who joined before it was applied. */
        pending: async (wording, topic, title) => {
          const taskId = await w.task(project, title);
          const task = (await w.projects.getTask(taskId))!;
          const item = (await w.meetings.addAgendaItem(w.owner, { commandId: cid("it"), projectId: project, topic, question: "What do we do?", urgency: "urgent", intent: "delegated-decision" })).id;
          const occ = (await w.meetings.callUrgent(mgr.principal, { commandId: cid("urg"), projectId: project, title: "Sync", reason: "decide", roster: crew.map((c) => c.principal.id) })).id;
          const rec = (await records.open(mgr.principal, { commandId: cid("open"), occurrenceId: occ })).id;
          for (const c of crew) await records.join(c.principal, { commandId: cid("j"), recordId: rec });
          const change = { kind: "task.update", agent: crew[0]!.principal.id, target: { kind: "task", id: taskId }, expectedRevision: task.revision, patch: { title: `${title} v2` }, summary: `retitle ${title}` };
          const motion = (await records.move(crew[1]!.principal, { commandId: cid("mv"), recordId: rec, text: wording, agendaItemId: item, changes: [change] } as never)).id;
          await records.openVote(w.owner, { commandId: cid("ov"), motionId: motion, expectedVersion: 1 });
          for (const c of crew) await records.castBallot(c.principal, { commandId: cid("b"), motionId: motion, version: 1, value: "yes", reason: "yes, it helps" } as never);
          const closed = await records.closeVote(w.owner, { commandId: cid("cl"), motionId: motion });
          await records.ownerJoin(w.owner, { commandId: cid("oj"), recordId: rec });
          return { id: closed.decisionId!, taskId };
        },
        title: async (taskId) => (await w.projects.getTask(taskId))!.title,
      };
      try { await body(w, script, ctl); } finally { await w.close(); }
    });
  interface Ctl {
    project: string; mgrToken: string; crewTokens: string[];
    decision(id: string): Promise<DecisionRecordBody & { id: string }>;
    pending(wording: string, topic: string, title: string): Promise<{ id: string; taskId: string }>;
    title(taskId: string): Promise<string>;
  }
  const say = (w: World, chat: ChatService, text: string) => chat.submit(w.ownerToken, { messageId: cid("m"), text });
  const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1); return outcomes[0]!; };
  const call = async (w: World, token: string, op: string, args: Record<string, unknown>, commandId?: string) => w.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;

  suite("an agreement to a held meeting decision is found by its words, shown first, and carries out the rest when confirmed", async (w, script, ctl) => {
    const nightly = await ctl.pending("Move the nightly build to one in the morning.", "nightly build", "Nightly build task");
    const staging = await ctl.pending("Retire the old staging server on Friday.", "staging server", "Staging task");
    const chat = w.chat();
    // The owner never names an ID: the words fit one waiting decision.
    script["Yes, go ahead with the nightly build change."] = [cmd(OP, { response: "agree", decisionTopic: "nightly build" }, "go ahead with the nightly build change")];
    const proposed = only((await say(w, chat, "Yes, go ahead with the nightly build change.")).outcomes);
    assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
    assert.match(String(proposed.preview), /agreeing lets the changes still waiting be carried out/);
    assert.equal((await ctl.decision(nightly.id)).ownerResponse, "pending", "nothing changed before the owner confirms");
    await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
    assert.equal((await ctl.decision(nightly.id)).ownerResponse, "agreed");
    assert.equal(await ctl.title(nightly.taskId), "Nightly build task v2", "the change was carried out");
    assert.equal((await ctl.decision(staging.id)).ownerResponse, "pending", "the other decision is untouched");
    assert.equal(await ctl.title(staging.taskId), "Staging task");
  });

  suite("words that fit several held decisions, or none, ask or refuse; a name for a decision the model made up is refused", async (w, script, ctl) => {
    const a = await ctl.pending("Move the nightly build to one in the morning.", "nightly build", "Nightly task");
    const b = await ctl.pending("Retire the old staging server on Friday.", "staging server", "Staging task");
    const chat = w.chat();
    script["Agree to it."] = [cmd(OP, { response: "agree" }, "Agree to it")];
    const first = await say(w, chat, "Agree to it.");
    const asked = only(first.outcomes);
    assert.equal(asked.status, "asked", JSON.stringify(asked));
    assert.ok(a.id && b.id);
    assert.equal(((asked.options ?? []) as string[]).length, 2);
    // The owner's answer picks one; the proposal is then shown and nothing was changed before.
    script["The staging one."] = [{ kind: "answer", turnId: first.turnId, choice: b.id, evidence: "The staging one", basis: "owner" }];
    const picked = only((await say(w, chat, "The staging one.")).outcomes);
    assert.equal(picked.status, "proposed", JSON.stringify(picked));
    assert.equal((await ctl.decision(b.id)).ownerResponse, "pending");
    script["Agree to the payroll change."] = [cmd(OP, { response: "agree", decisionTopic: "payroll" }, "Agree to the payroll change")];
    const none = only((await say(w, chat, "Agree to the payroll change.")).outcomes);
    assert.deepEqual([none.status, none.code], ["refused", "not_found"], JSON.stringify(none));
    // A word the owner never said is refused, not matched.
    script["Please agree with the staging one."] = [cmd(OP, { response: "agree", decisionTopic: "nightly" }, "agree with the staging one")];
    const foreign = only((await say(w, chat, "Please agree with the staging one.")).outcomes);
    assert.deepEqual([foreign.status, foreign.code], ["refused", "unsupported_value"], JSON.stringify(foreign));
    // A bare alternative (the model's own object) is not an argument.
    script["Do the staging thing differently."] = [cmd(OP, { response: "alternative", decisionTopic: "staging", alternative: { statement: "x" } }, "Do the staging thing differently")];
    const objectGiven = only((await say(w, chat, "Do the staging thing differently.")).outcomes);
    assert.equal(objectGiven.status, "refused", JSON.stringify(objectGiven));
    // With nothing waiting, the owner is told so.
    await w.api.handle(w.ownerToken, { v: 1, op: OP, commandId: cid("direct"), args: { decisionId: a.id, response: "decline" } } as never);
    await w.api.handle(w.ownerToken, { v: 1, op: OP, commandId: cid("direct"), args: { decisionId: b.id, response: "decline" } } as never);
    script["Agree with the nightly one."] = [cmd(OP, { response: "agree", decisionTopic: "nightly" }, "Agree with the nightly one")];
    const nothing = only((await say(w, chat, "Agree with the nightly one.")).outcomes);
    assert.deepEqual([nothing.status, nothing.code], ["refused", "not_found"], JSON.stringify(nothing));
  });

  suite("a decline refuses the changes not yet carried out; an alternative in the owner's own words is recorded as their decision and linked to the held one", async (w, script, ctl) => {
    const a = await ctl.pending("Move the nightly build to one in the morning.", "nightly build", "Nightly task");
    const b = await ctl.pending("Retire the old staging server on Friday.", "staging server", "Staging task");
    const chat = w.chat();
    script["No, do not retire the staging server."] = [cmd(OP, { response: "decline", decisionTopic: "staging server" }, "do not retire the staging server")];
    const declining = only((await say(w, chat, "No, do not retire the staging server.")).outcomes);
    assert.equal(declining.status, "proposed", JSON.stringify(declining));
    assert.match(String(declining.preview), /declining refuses the changes not yet carried out/);
    await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: declining.proposalId! });
    const declined = await ctl.decision(b.id);
    assert.equal(declined.ownerResponse, "declined");
    assert.equal(declined.changes[0]!.state, "not-applied");
    assert.equal(await ctl.title(b.taskId), "Staging task", "the declined change was not carried out");

    // The owner's alternative: their own words are the decision, recorded from this very message.
    script["I would rather keep the nightly build at midnight until March."] = [cmd(OP, { response: "alternative", decisionTopic: "nightly", alternativeStatement: "keep the nightly build at midnight until March" }, "keep the nightly build at midnight until March")];
    const alternative = only((await say(w, chat, "I would rather keep the nightly build at midnight until March.")).outcomes);
    assert.equal(alternative.status, "proposed", JSON.stringify(alternative));
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: alternative.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    const answered = await ctl.decision(a.id);
    assert.equal(answered.ownerResponse, "alternative");
    assert.equal(answered.changes[0]!.state, "not-applied");
    assert.equal(await ctl.title(a.taskId), "Nightly task");
    const recorded = (await call(w, w.ownerToken, "decision.get", { decisionId: answered.ownerDecisionId })).result.item;
    assert.equal(recorded.statement, "keep the nightly build at midnight until March");
    assert.equal(recorded.wording, "keep the nightly build at midnight until March");
    // An alternative needs the owner's words.
    script["Do something else with the nightly build."] = [cmd(OP, { response: "alternative", decisionTopic: "nightly" }, "Do something else with the nightly build")];
    const empty = only((await say(w, chat, "Do something else with the nightly build.")).outcomes);
    assert.equal(empty.status, "refused", JSON.stringify(empty));
  });

  suite("only the owner sees or answers the held decisions: the list and the answer refuse an agent or a task credential, and chat is the owner's alone", async (w, _script, ctl) => {
    const d = await ctl.pending("Move the nightly build to one in the morning.", "nightly build", "Nightly task");
    const listed = await call(w, w.ownerToken, "meeting.decisions.waiting", {});
    assert.deepEqual(listed.result.item.items.map((i: { id: string }) => i.id), [d.id]);
    assert.equal(listed.result.item.items[0].text, "Move the nightly build to one in the morning.");
    assert.equal(listed.result.item.items[0].left, 1);
    for (const token of [ctl.mgrToken, ...ctl.crewTokens]) {
      const refused = await call(w, token, "meeting.decisions.waiting", {});
      assert.deepEqual([refused.ok, refused.error?.code], [false, "forbidden"], JSON.stringify(refused));
      const answer = await call(w, token, OP, { decisionId: d.id, response: "agree" }, cid("x"));
      assert.deepEqual([answer.ok, answer.error?.code], [false, "forbidden"], JSON.stringify(answer));
    }
    assert.equal((await ctl.decision(d.id)).ownerResponse, "pending");
    assert.equal((await call(w, w.ownerToken, "meeting.decisions.waiting", { limit: 0 })).ok, false);
  });
}
