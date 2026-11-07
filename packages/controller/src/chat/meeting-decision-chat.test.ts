import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { describe, proposalReason } from "./commands.js";
import { MeetingRecordService, taskUpdateApplier, type ChangeApplier, type DecisionRecordBody } from "../meetings/index.js";
import { GrantService } from "../security/index.js";
import type { ChatService, Outcome } from "./index.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const OP = "meeting.record.owner-respond";

interface Ctl {
  project: string; mgrToken: string; hostToken: string; crewTokens: string[];
  records: MeetingRecordService;
  /** Failures of the applier still to come (a change then stays applying). */
  crash: { n: number };
  /** When set, the list of waiting decisions the chat reads is cut to this one and says it was cut. */
  cutTo: { id?: string };
  decision(id: string): Promise<DecisionRecordBody & { id: string }>;
  /** An adopted decision with one task change that waits for the owner, who joined before it was applied. With `started`, its change was started (and crashed) before the owner joined. */
  pending(wording: string, topic: string, title: string, o?: { started?: boolean; noTopic?: boolean }): Promise<{ id: string; taskId: string }>;
  title(taskId: string): Promise<string>;
}

/** The owner's answer to a meeting decision that waits for them, by chat (card M02h, second slice), over every backend. */
for (const backend of backends) {
  const suite = (name: string, body: (w: World, script: Record<string, unknown>, ctl: Ctl) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const script: Record<string, unknown> = {};
      const holder: { r?: MeetingRecordService } = {};
      const cutTo: { id?: string } = {};
      const lazy = new Proxy({}, { get: (_t, k) => async (...a: unknown[]) => {
        const real = holder.r as unknown as Record<string, (...x: unknown[]) => Promise<unknown>>;
        const out = await real[k as string]!(...a);
        if (k === "ownerPending" && cutTo.id !== undefined) return { items: (out as { items: { id: string }[] }).items.filter((i) => i.id === cutTo.id), truncated: true };
        return out;
      } }) as MeetingRecordService;
      const w = await openWorld(backend, script, undefined, { records: lazy });
      const grants = GrantService.withEpoch(w.world.storage, w.projects.epoch, options);
      const authority = async (id: string) => { const p = await w.principals.get(id); return p === undefined ? undefined : grants.effective({ id, kind: p.kind, name: p.name, grants: p.grants }, options.clock()); };
      const crash = { n: 0 };
      const base = taskUpdateApplier(w.projects);
      const crashing: ChangeApplier = { ...base, widens: "spend", async apply(ch) { if (crash.n > 0) { crash.n--; throw new DomainError("unavailable", "storage went away"); } return base.apply(ch); } };
      holder.r = MeetingRecordService.withEpoch(w.world.storage, w.projects.epoch, { meetings: w.meetings, decisions: w.decisions }, { ...options, authority, appliers: { "task.update": crashing }, widening: async () => "allow", shareable: async () => false });
      const records = holder.r;
      const project = await w.project("A");
      const mgr = await w.agent("mgr", [{ action: "meeting.manage", project }]);
      await w.principals.enroll(w.owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] });
      const hostToken = (await w.principals.issueCredential(w.owner, "host:h1")).token;
      const crew = [await w.agent("ann", [{ action: "task.read", project }, { action: "meeting.attend", project }, { action: "task.update", project }]), await w.agent("bob", [{ action: "task.read", project }, { action: "meeting.attend", project }]), await w.agent("cy", [{ action: "task.read", project }, { action: "meeting.attend", project }])];
      const ctl: Ctl = {
        project, mgrToken: mgr.token, hostToken, crewTokens: crew.map((c) => c.token), records, crash, cutTo,
        decision: async (id) => (await records.decision(w.owner, id)) as unknown as DecisionRecordBody & { id: string },
        pending: async (wording, topic, title, o = {}) => {
          const taskId = await w.task(project, title);
          const task = (await w.projects.getTask(taskId))!;
          // The agenda item carries the topic; the motion names none (as a motion that answers an agenda item usually does not).
          const item = (await w.meetings.addAgendaItem(w.owner, { commandId: cid("it"), projectId: project, topic, question: "What do we do?", urgency: "urgent", intent: "delegated-decision" })).id;
          const occ = (await w.meetings.callUrgent(mgr.principal, { commandId: cid("urg"), projectId: project, title: "Sync", reason: "decide", roster: crew.map((c) => c.principal.id) })).id;
          const rec = (await records.open(mgr.principal, { commandId: cid("open"), occurrenceId: occ })).id;
          for (const c of crew) await records.join(c.principal, { commandId: cid("j"), recordId: rec });
          const change = { kind: "task.update", agent: crew[0]!.principal.id, target: { kind: "task", id: taskId }, expectedRevision: task.revision, patch: { title: `${title} v2` }, summary: `retitle ${title}` };
          const motion = (await records.move(crew[1]!.principal, { commandId: cid("mv"), recordId: rec, text: wording, agendaItemId: item, changes: [change] } as never)).id;
          await records.openVote(w.owner, { commandId: cid("ov"), motionId: motion, expectedVersion: 1 });
          for (const c of crew) await records.castBallot(c.principal, { commandId: cid("b"), motionId: motion, version: 1, value: "yes", reason: "yes, it helps" } as never);
          const closed = await records.closeVote(w.owner, { commandId: cid("cl"), motionId: motion });
          if (o.started === true) {
            crash.n = 1;
            await assert.rejects(() => records.apply(w.owner, { decisionId: closed.decisionId! }), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
          }
          await records.ownerJoin(w.owner, { commandId: cid("oj"), recordId: rec });
          return { id: closed.decisionId!, taskId };
        },
        title: async (taskId) => (await w.projects.getTask(taskId))!.title,
      };
      try { await body(w, script, ctl); } finally { await w.close(); }
    });
  const say = (w: World, chat: ChatService, text: string) => chat.submit(w.ownerToken, { messageId: cid("m"), text });
  const only = (outcomes: readonly Outcome[]): Outcome => { assert.equal(outcomes.length, 1); return outcomes[0]!; };
  const call = async (w: World, token: string, op: string, args: Record<string, unknown>, commandId?: string) => w.api.handle(token, { v: 1, op, ...(commandId === undefined ? {} : { commandId }), args } as never) as Promise<any>;
  const NIGHTLY = "Move the nightly build to one in the morning.";
  const STAGING = "Retire the old staging server on Friday.";

  suite("an agreement to a held meeting decision is found by its words (also ordinary ones like 'change' and 'one'), shown first with a true reason, and reported when confirmed", async (w, script, ctl) => {
    const nightly = await ctl.pending(NIGHTLY, "nightly build", "Nightly build task");
    const staging = await ctl.pending(STAGING, "staging server", "Staging task");
    const chat = w.chat();
    // The owner never names an ID. Ordinary words ("change", "one", "decision") do not stop the match.
    script["Yes, go ahead with the nightly build change."] = [cmd(OP, { response: "agree", decisionTopic: "nightly build change" }, "go ahead with the nightly build change")];
    const proposed = only((await say(w, chat, "Yes, go ahead with the nightly build change.")).outcomes);
    assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
    assert.match(String(proposed.preview), /agreeing lets the changes still waiting be carried out/);
    assert.match(String(proposed.preview), /Move the nightly build to one in the morning/, "the decision is named in the preview");
    const body = (await chat.getProposal(w.ownerToken, proposed.proposalId!))!;
    assert.match(body.reason, /your answer to a meeting decision is shown first: it is final/);
    assert.equal((await ctl.decision(nightly.id)).ownerResponse, "pending", "nothing changed before the owner confirms");
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
    assert.deepEqual(applied.results[0]!.shown, ["You agreed. 1 change is carried out."], "what happened is told");
    assert.equal((await ctl.decision(nightly.id)).ownerResponse, "agreed");
    assert.equal(await ctl.title(nightly.taskId), "Nightly build task v2", "the change was carried out");
    assert.equal((await ctl.decision(staging.id)).ownerResponse, "pending", "the other decision is untouched");
    // "the staging one" fits one decision.
    script["Yes to the staging one."] = [cmd(OP, { response: "agree", decisionTopic: "staging one" }, "Yes to the staging one")];
    assert.equal(only((await say(w, chat, "Yes to the staging one.")).outcomes).status, "proposed");
  });

  suite("an agreement where every target moved on is told so, not reported as a plain success", async (w, script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly build task");
    await w.projects.updateTask({ commandId: cid("mv"), actor: "owner:rob", taskId: d.taskId, expectedRevision: (await w.projects.getTask(d.taskId))!.revision, title: "Changed by someone else" } as never);
    const chat = w.chat();
    script["Agree with the nightly build."] = [cmd(OP, { response: "agree", decisionTopic: "nightly build" }, "Agree with the nightly build")];
    const proposed = only((await say(w, chat, "Agree with the nightly build.")).outcomes);
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
    assert.deepEqual(applied.results[0]!.shown, ["You agreed, but none of its changes could be carried out now (what they change had moved on)."]);
  });

  suite("words that fit several held decisions ask which and the answer is carried on; none, a model's own ID, an ID not waiting, and a cut list are handled without guessing", async (w, script, ctl) => {
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const b = await ctl.pending(STAGING, "staging server", "Staging task");
    const chat = w.chat();
    script["Agree with the decision."] = [cmd(OP, { response: "agree", decisionTopic: "decision" }, "Agree with the decision")];
    const first = await say(w, chat, "Agree with the decision.");
    const asked = only(first.outcomes);
    assert.equal(asked.status, "asked", JSON.stringify(asked));
    assert.equal(((asked.options ?? []) as string[]).length, 2);
    // The owner's answer picks one; nothing was changed before, and the question's words are not kept (they would clash with the ID).
    script["The staging one."] = [{ kind: "answer", turnId: first.turnId, choice: b.id, evidence: "The staging one", basis: "owner" }];
    const picked = only((await say(w, chat, "The staging one.")).outcomes);
    assert.equal(picked.status, "proposed", JSON.stringify(picked));
    assert.match(String(picked.preview), /staging server on Friday/);
    assert.equal((await ctl.decision(b.id)).ownerResponse, "pending");
    // A model that names an ID the owner did not say, with two decisions waiting, is asked about.
    script["Agree to it."] = [cmd(OP, { response: "agree", decisionId: a.id }, "Agree to it")];
    assert.equal(only((await say(w, chat, "Agree to it.")).outcomes).status, "asked");
    // An ID the owner wrote in their message is theirs.
    script[`Agree to ${a.id}.`] = [cmd(OP, { response: "agree", decisionId: a.id }, `Agree to ${a.id}`)];
    assert.equal(only((await say(w, chat, `Agree to ${a.id}.`)).outcomes).status, "proposed");
    // An ID that is not waiting is not found.
    script["Agree to mdc-aaaaaaaaaaaaaaaaaaaa."] = [cmd(OP, { response: "agree", decisionId: "mdc-aaaaaaaaaaaaaaaaaaaa" }, "Agree to mdc-aaaaaaaaaaaaaaaaaaaa")];
    const unknown = only((await say(w, chat, "Agree to mdc-aaaaaaaaaaaaaaaaaaaa.")).outcomes);
    assert.deepEqual([unknown.status, unknown.code], ["refused", "not_found"], JSON.stringify(unknown));
    // Words that fit nothing.
    script["Agree to the payroll change."] = [cmd(OP, { response: "agree", decisionTopic: "payroll" }, "Agree to the payroll change")];
    const none = only((await say(w, chat, "Agree to the payroll change.")).outcomes);
    assert.deepEqual([none.status, none.code], ["refused", "not_found"], JSON.stringify(none));
    // A word the owner never said is refused, not matched.
    script["Please agree with the staging one."] = [cmd(OP, { response: "agree", decisionTopic: "nightly" }, "agree with the staging one")];
    const foreign = only((await say(w, chat, "Please agree with the staging one.")).outcomes);
    assert.deepEqual([foreign.status, foreign.code], ["refused", "unsupported_value"], JSON.stringify(foreign));
    // The model's own alternative object is not an argument, even with words that are in the message.
    script["Keep the staging server until May."] = [cmd(OP, { response: "alternative", decisionTopic: "staging", alternative: { statement: "Keep the staging server until May" } }, "Keep the staging server until May")];
    const objectGiven = only((await say(w, chat, "Keep the staging server until May.")).outcomes);
    assert.deepEqual([objectGiven.status, objectGiven.code], ["refused", "invalid_command"], JSON.stringify(objectGiven));
    assert.match(String(objectGiven.message), /alternative is not an argument/);
    // A list cut short does not read as "nothing waits": the owner is told more wait than were read.
    ctl.cutTo.id = a.id;
    script["Agree with the staging server."] = [cmd(OP, { response: "agree", decisionTopic: "staging server" }, "Agree with the staging server")];
    const cut = only((await say(w, chat, "Agree with the staging server.")).outcomes);
    assert.equal(cut.status, "refused", JSON.stringify(cut));
    assert.match(String(cut.message), /More meeting decisions wait for you than could be read/);
    delete ctl.cutTo.id;
    // With nothing waiting, the owner is told so.
    await call(w, w.ownerToken, OP, { decisionId: a.id, response: "decline" }, cid("direct"));
    await call(w, w.ownerToken, OP, { decisionId: b.id, response: "decline" }, cid("direct"));
    script["Agree with the nightly one."] = [cmd(OP, { response: "agree", decisionTopic: "nightly" }, "Agree with the nightly one")];
    const nothing = only((await say(w, chat, "Agree with the nightly one.")).outcomes);
    assert.deepEqual([nothing.status, nothing.code], ["refused", "not_found"], JSON.stringify(nothing));
    // Already answered: a second answer through the operation is refused.
    const again = await call(w, w.ownerToken, OP, { decisionId: a.id, response: "agree" }, cid("direct"));
    assert.deepEqual([again.ok, again.error?.code], [false, "invalid_command"]);
  });

  suite("a decline names what it refuses and what is finished anyway; a started change that could not be finished is told", async (w, script, ctl) => {
    const started = await ctl.pending(NIGHTLY, "nightly build", "Nightly task", { started: true });
    const plain = await ctl.pending(STAGING, "staging server", "Staging task");
    const chat = w.chat();
    // A decision whose change had started before the owner came is not held for the owner (it is carried on), so only the other waits.
    const waiting = (await call(w, w.ownerToken, "meeting.decisions.waiting", {})).result.item.items as { id: string; applying: number; topic?: string }[];
    assert.deepEqual(waiting.map((i) => [i.id, i.applying, i.topic]), [[plain.id, 0, "staging server"]], "the topic of the agenda item is returned for a motion that names none");
    script["No, not the staging server."] = [cmd(OP, { response: "decline", decisionTopic: "staging server" }, "not the staging server")];
    const plainOutcome = only((await say(w, chat, "No, not the staging server.")).outcomes);
    assert.match(String(plainOutcome.preview), /declining refuses the changes not yet started; those already done stay done\)/);
    const declined = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: plainOutcome.proposalId! });
    assert.deepEqual(declined.results[0]!.shown, ["You declined. The changes not yet started are refused; those already done stay done."]);
    assert.equal((await ctl.decision(plain.id)).changes[0]!.state, "not-applied");
    assert.equal(await ctl.title(plain.taskId), "Staging task");
    // The answer itself, for a change that had started and could not be finished just now: the owner is told it stays applying.
    ctl.crash.n = 1;
    const direct = await call(w, w.ownerToken, OP, { decisionId: started.id, response: "decline" }, cid("direct"));
    assert.deepEqual(direct.result.shown, ["You declined. The changes not yet started are refused; those already done stay done.", "A change that had already started could not be finished just now; it stays applying until the decision is applied again."]);
    assert.equal(direct.result.stillApplying, true);
    assert.equal((await ctl.decision(started.id)).changes[0]!.state, "applying");
  });

  test("the preview of a decline or an alternative says how many changes already started will still be finished", () => {
    const labels = { "mdc-x": "Move the build; 2 changes left to carry out", "started:mdc-x": "1" };
    assert.match(describe(OP, { decisionId: "mdc-x", response: "decline" }, labels), /declining refuses the changes not yet started; 1 already started will still be finished; those already done stay done\)/);
    assert.match(describe(OP, { decisionId: "mdc-x", response: "decline" }, { ...labels, "started:mdc-x": "0" }), /declining refuses the changes not yet started; those already done stay done\)/);
    assert.match(describe(OP, { decisionId: "mdc-x", response: "alternative", alternative: { projectId: "prj-1", topic: "build", statement: "keep it", basedOn: 3 } }, labels), /^Answer a meeting decision \(your own decision is recorded and the changes not yet started are refused; 1 already started will still be finished; those already done stay done\): response=alternative, alternative="keep it" on topic "build"/);
    for (const text of [proposalReason("standup.prepare", {}, false, { profile: "derived", said: true, quoted: false }), proposalReason("standup.add-statement", {}, false, { profile: "derived", said: true, quoted: false })]) assert.doesNotMatch(String(text), /role's capabilities/);
    assert.match(String(proposalReason("standup.prepare", {}, false, { profile: "derived", said: true, quoted: false })), /tells its agents and builds their briefs/);
    assert.match(String(proposalReason("standup.add-statement", {}, false, { profile: "derived", said: true, quoted: false })), /goes into an agent's brief/);
  });

  suite("an alternative in the owner's own words is shown in full, recorded as their decision on the decision's topic, and refused up front when the service would refuse it", async (w, script, ctl) => {
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const b = await ctl.pending(STAGING, "staging server", "Staging task");
    const chat = w.chat();
    const said = "I would rather keep the nightly build at midnight until March.";
    script[said] = [cmd(OP, { response: "alternative", decisionTopic: "nightly", alternativeStatement: "keep the nightly build at midnight until March" }, "keep the nightly build at midnight until March")];
    const alternative = only((await say(w, chat, said)).outcomes);
    assert.equal(alternative.status, "proposed", JSON.stringify(alternative));
    const preview = String(alternative.preview);
    assert.match(preview, /alternative="keep the nightly build at midnight until March" on topic "nightly build"/, "the owner sees the words and the topic they will have recorded");
    assert.doesNotMatch(preview, /projectId|basedOn|category/);
    assert.match(preview, /your own decision is recorded and the changes not yet started are refused/);
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: alternative.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.match(applied.results[0]!.shown![0]!, /^You chose your own decision instead \(dec-/);
    const answered = await ctl.decision(a.id);
    assert.equal(answered.ownerResponse, "alternative");
    assert.equal(answered.changes[0]!.state, "not-applied");
    assert.equal(await ctl.title(a.taskId), "Nightly task");
    const recorded = (await call(w, w.ownerToken, "decision.get", { decisionId: answered.ownerDecisionId })).result.item;
    assert.deepEqual([recorded.statement, recorded.wording, recorded.topic], ["keep the nightly build at midnight until March", "keep the nightly build at midnight until March", "nightly build"], "on the agenda item's topic, which a later motion is checked against");

    // Words the decision service would refuse are not proposed: a negation, one word, no words at all. The decision keeps waiting.
    const instead = (text: string, statement: string, evidence = statement) => { script[text] = [cmd(OP, { response: "alternative", decisionTopic: "staging", alternativeStatement: statement }, evidence)]; return say(w, chat, text); };
    for (const [text, statement, reason] of [
      ["Instead of that, keep the staging server until May.", "keep the staging server until May", /follow a negation|negation/],
      ["Don't retire it; keep the staging server in place.", "keep the staging server in place", /negation/],
      ["Stay put at the staging server.", "Stay", /at least two words/],
    ] as const) {
      const refused = only((await instead(text, statement, text.replace(/\.$/, ""))).outcomes);
      assert.deepEqual([refused.status, refused.code], ["refused", "invalid_command"], `${text}: ${JSON.stringify(refused)}`);
      assert.match(String(refused.message), /^Nothing was proposed: /);
      assert.match(String(refused.message), reason);
      assert.match(String(refused.message), /The meeting decision still waits for your answer; say what you decide instead as its own sentence \(for example "Keep the staging server until May\."\)/);
    }
    assert.equal((await ctl.decision(b.id)).ownerResponse, "pending", "nothing was changed");
    // An alternative without words, and one too long to show whole.
    script["Do something else with the staging server."] = [cmd(OP, { response: "alternative", decisionTopic: "staging" }, "Do something else with the staging server")];
    assert.equal(only((await say(w, chat, "Do something else with the staging server.")).outcomes).status, "refused");
    const long = `keep the staging server ${"for a long time ".repeat(12)}`.trim();
    const tooLong = only((await instead(`Please ${long}.`, long)).outcomes);
    assert.match(String(tooLong.message), /too long to show whole/);
  });

  suite("an alternative stated with a decision of the same message on the same topic is based on that decision, not made a dispute of it", async (w, script, ctl) => {
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: ctl.project });
    w.profile.value = "autonomous";
    const said = "Use midnight for the nightly build. I would rather keep the nightly build at midnight until March.";
    script[said] = [
      cmd("decision.record", { projectId: ctl.project, category: "decision", topic: "nightly build", statement: "Use midnight for the nightly build", wording: "Use midnight for the nightly build" }, "Use midnight for the nightly build"),
      cmd(OP, { response: "alternative", decisionTopic: "nightly", alternativeStatement: "keep the nightly build at midnight until March", alternativeTopic: "nightly build" }, "keep the nightly build at midnight until March"),
    ];
    const outcomes = (await say(w, chat, said)).outcomes;
    const proposal = outcomes.find((o) => o.status === "proposed")!;
    assert.ok(proposal, JSON.stringify(outcomes));
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposal.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    const dec = await ctl.decision(a.id);
    assert.equal(dec.ownerResponse, "alternative", JSON.stringify(dec));
    const got = await call(w, w.ownerToken, "decision.get", { decisionId: dec.ownerDecisionId });
    const recorded = got.result?.item;
    assert.ok(recorded, JSON.stringify(got));
    assert.notEqual(recorded.state, "disputed", JSON.stringify(recorded));
    assert.equal(recorded.version, 2);
  });

  suite("only the owner sees or answers the held decisions: an agent, a host and a task-scoped owner credential are refused, and the chat is the owner's alone", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const listed = await call(w, w.ownerToken, "meeting.decisions.waiting", {});
    assert.deepEqual(listed.result.item.items.map((i: { id: string }) => i.id), [d.id]);
    assert.equal(listed.result.item.items[0].text, NIGHTLY);
    assert.equal(listed.result.item.items[0].left, 1);
    for (const token of [ctl.mgrToken, ctl.hostToken, ...ctl.crewTokens]) {
      const refused = await call(w, token, "meeting.decisions.waiting", {});
      assert.deepEqual([refused.ok, refused.error?.code], [false, "forbidden"], JSON.stringify(refused));
      const answer = await call(w, token, OP, { decisionId: d.id, response: "agree" }, cid("x"));
      assert.deepEqual([answer.ok, answer.error?.code], [false, "forbidden"], JSON.stringify(answer));
    }
    // A task-scoped owner credential reads nothing and answers nothing.
    const scoped = { ...w.owner, taskScope: { taskId: "task-aaaaaaaaaaaaaaaaaaaa" } } as never;
    assert.deepEqual(await ctl.records.ownerPending(scoped), { items: [], truncated: false });
    await assert.rejects(() => ctl.records.ownerRespond(scoped, { commandId: cid("x"), decisionId: d.id, response: "agree" }), (e: unknown) => e instanceof DomainError && e.code === "forbidden");
    assert.equal((await ctl.decision(d.id)).ownerResponse, "pending");
    assert.equal((await call(w, w.ownerToken, "meeting.decisions.waiting", { limit: 0 })).ok, false);
  });
}
