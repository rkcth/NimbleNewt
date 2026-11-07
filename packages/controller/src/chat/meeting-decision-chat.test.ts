import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ownerAnswerLines } from "../api/operations.js";
import { describe, proposalReason } from "./commands.js";
import { MeetingRecordService, taskUpdateApplier, type ChangeApplier, type DecisionRecordBody } from "../meetings/index.js";
import { GrantService } from "../security/index.js";
import type { ChatService, Outcome } from "./index.js";
import { cid, openWorld, options, type World } from "./testing/harness.js";

after(stopServer);

const cmd = (op: string, args: Record<string, unknown>, evidence: string) => ({ kind: "command", op, args, evidence, basis: "owner" });
const OP = "meeting.record.owner-respond";
const STILL = "1 change started but could not be carried out just now and stays applying. Nothing applies it again by itself: it is finished when the decision is applied again through the API (meeting.record.apply); you have no chat command for that yet.";

interface Ctl {
  project: string; mgrToken: string; hostToken: string; crewTokens: string[];
  records: MeetingRecordService;
  /** Failures of the applier still to come (a change then stays applying). */
  crash: { n: number; plain: number };
  /** What the approval policy says to a widening change: allow, or ask (the decision then waits for the owner). */
  policy: { value: "allow" | "ask" };
  /** When set, the decision guard cannot be read (a pass that throws before any change starts). */
  authFail: { on: boolean; after: number; calls: number };
  /** When set, the next owner decision recorded is saved and then the call fails (a crash between recording the alternative and saving the answer). */
  recordCrash: { n: number };
  /** Run once right after the next owner decision is recorded (another answer winning the race). */
  afterRecord: { run?: () => Promise<void> };
  /** When set, the list of waiting decisions the chat reads is cut to this one and says it was cut. */
  cutTo: { id?: string };
  decision(id: string): Promise<DecisionRecordBody & { id: string }>;
  /** An adopted decision with one task change that waits for the owner, who joined before it was applied. With `started`, its change was started (and crashed) before the owner joined. */
  pending(wording: string, topic: string, title: string, o?: { project?: string; started?: boolean; kinds?: ("task.update" | "task.retitle")[]; join?: boolean; agendaTopic?: string }): Promise<{ id: string; taskId: string; taskIds: string[] }>;
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
      const authFail = { on: false, after: 0, calls: 0 };
      const recordCrash = { n: 0 };
      const afterRecord: { run?: () => Promise<void> } = {};
      const realRecord = w.decisions.record.bind(w.decisions);
      (w.decisions as { record: typeof w.decisions.record }).record = async (...a) => { const r = await realRecord(...a); if (afterRecord.run !== undefined) { const f = afterRecord.run; delete afterRecord.run; await f(); } if (recordCrash.n > 0) { recordCrash.n--; throw new DomainError("unavailable", "storage went away after the decision was saved"); } return r; };
      const realGuard = w.decisions.guard.bind(w.decisions);
      (w.decisions as { guard: typeof w.decisions.guard }).guard = async (...a) => { if (authFail.on && ++authFail.calls > authFail.after) throw new DomainError("unavailable", "the decision guard could not be read"); return realGuard(...a); };
      const authority = async (id: string) => { const p = await w.principals.get(id); return p === undefined ? undefined : grants.effective({ id, kind: p.kind, name: p.name, grants: p.grants }, options.clock()); };
      const crash = { n: 0, plain: 0 };
      const policy: { value: "allow" | "ask" } = { value: "allow" };
      const base = taskUpdateApplier(w.projects);
      const crashing: ChangeApplier = { ...base, widens: "spend", async apply(ch) { if (crash.n > 0) { crash.n--; throw new DomainError("unavailable", "storage went away"); } return base.apply(ch); } };
      const plainOne: ChangeApplier = { ...base, async apply(ch) { if (crash.plain > 0) { crash.plain--; throw new DomainError("unavailable", "storage went away"); } return base.apply(ch); } };
      holder.r = MeetingRecordService.withEpoch(w.world.storage, w.projects.epoch, { meetings: w.meetings, decisions: w.decisions }, { ...options, authority, appliers: { "task.update": crashing, "task.retitle": plainOne }, widening: async () => policy.value, shareable: async () => false });
      const records = holder.r;
      const project = await w.project("A");
      const mgr = await w.agent("mgr", [{ action: "meeting.manage", project: "*" }]);
      await w.principals.enroll(w.owner, { commandId: cid("e"), kind: "host", name: "h1", grants: [] });
      const hostToken = (await w.principals.issueCredential(w.owner, "host:h1")).token;
      const crew = [await w.agent("ann", [{ action: "task.read", project: "*" }, { action: "meeting.attend", project: "*" }, { action: "task.update", project: "*" }]), await w.agent("bob", [{ action: "task.read", project: "*" }, { action: "meeting.attend", project: "*" }]), await w.agent("cy", [{ action: "task.read", project: "*" }, { action: "meeting.attend", project: "*" }])];
      const ctl: Ctl = {
        project, mgrToken: mgr.token, hostToken, crewTokens: crew.map((c) => c.token), records, crash, policy, cutTo, authFail, recordCrash, afterRecord,
        decision: async (id) => (await records.decision(w.owner, id)) as unknown as DecisionRecordBody & { id: string },
        pending: async (wording, topic, title, o = {}) => {
          const kinds = o.kinds ?? ["task.update"];
          const taskIds: string[] = [];
          const changes: Record<string, unknown>[] = [];
          for (const [n, kind] of kinds.entries()) {
            const name = n === 0 ? title : `${title} ${n + 1}`;
            const taskId = await w.task(o.project ?? project, name);
            taskIds.push(taskId);
            changes.push({ kind, agent: crew[0]!.principal.id, target: { kind: "task", id: taskId }, expectedRevision: (await w.projects.getTask(taskId))!.revision, patch: { title: `${name} v2` }, summary: `retitle ${name}` });
          }
          // The agenda item carries the topic; the motion names none (as a motion that answers an agenda item usually does not).
          const item = (await w.meetings.addAgendaItem(w.owner, { commandId: cid("it"), projectId: o.project ?? project, topic: o.agendaTopic ?? topic, question: "What do we do?", urgency: "urgent", intent: "delegated-decision" })).id;
          const occ = (await w.meetings.callUrgent(mgr.principal, { commandId: cid("urg"), projectId: o.project ?? project, title: "Sync", reason: "decide", roster: crew.map((c) => c.principal.id) })).id;
          const rec = (await records.open(mgr.principal, { commandId: cid("open"), occurrenceId: occ })).id;
          for (const c of crew) await records.join(c.principal, { commandId: cid("j"), recordId: rec });
          const motion = (await records.move(crew[1]!.principal, { commandId: cid("mv"), recordId: rec, text: wording, agendaItemId: item, changes } as never)).id;
          await records.openVote(w.owner, { commandId: cid("ov"), motionId: motion, expectedVersion: 1 });
          for (const c of crew) await records.castBallot(c.principal, { commandId: cid("b"), motionId: motion, version: 1, value: "yes", reason: "yes, it helps" } as never);
          const closed = await records.closeVote(w.owner, { commandId: cid("cl"), motionId: motion });
          if (o.started === true) {
            crash.n = 1;
            await assert.rejects(() => records.apply(w.owner, { decisionId: closed.decisionId! }), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
          }
          if (o.join !== false) await records.ownerJoin(w.owner, { commandId: cid("oj"), recordId: rec });
          return { id: closed.decisionId!, taskId: taskIds[0]!, taskIds };
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
    assert.deepEqual(applied.results[0]!.shown, ["You agreed. 1 change carried out now."], "what happened is told");
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
    assert.deepEqual(applied.results[0]!.shown, ["You agreed. None of its changes was carried out now.", "1 change not carried out: what it changes had moved on."]);
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
    assert.deepEqual(direct.result.shown, ["You declined. The changes not yet started are refused; those already done stay done.", STILL]);
    assert.equal(direct.result.stillApplying, true);
    assert.equal((await ctl.decision(started.id)).changes[0]!.state, "applying");
  });

  test("the preview of a decline or an alternative says how many changes already started will still be finished", () => {
    const labels = { "mdc-x": "Move the build; 2 changes left to carry out", "started:mdc-x": "1" };
    assert.match(describe(OP, { decisionId: "mdc-x", response: "decline" }, labels), /declining refuses the changes not yet started; 1 already started will still be finished; those already done stay done\)/);
    assert.match(describe(OP, { decisionId: "mdc-x", response: "decline" }, { ...labels, "started:mdc-x": "0" }), /declining refuses the changes not yet started; those already done stay done\)/);
    assert.match(describe(OP, { decisionId: "mdc-x", response: "alternative", alternative: { projectId: "prj-1", topic: "build", statement: "keep it", basedOn: 3 } }, labels), /^Answer a meeting decision \(your own decision is recorded and the changes not yet started are refused; 1 already started will still be finished; those already done stay done\): response=alternative, decisionId="Move the build; 2 changes left to carry out", alternative="keep it" on topic "build"/);
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
    const said = "For build hours, use midnight for the nightly build. I would rather keep the nightly build at midnight until March, as the nightly schedule.";
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

  suite("a long alternative on a long topic with a started change is shown whole, with the decision it answers", async (w, script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const chat = w.chat();
    const statement = "keep the nightly build at midnight for the whole spring release cycle so that the partners can plan their own nights around it";
    const topic = "nightly build schedule for the spring release cycle partners and the support";
    assert.ok(statement.length <= 150 && statement.length > 120 && topic.length <= 80 && topic.length > 70, `${statement.length} ${topic.length}`);
    const said = `I would rather ${statement}, under ${topic}.`;
    script[said] = [cmd(OP, { response: "alternative", decisionTopic: "nightly", alternativeStatement: statement, alternativeTopic: topic }, `rather ${statement}`)];
    const proposed = only((await say(w, chat, said)).outcomes);
    assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
    const line = String(proposed.preview);
    assert.ok(line.includes(`alternative="${statement}" on topic "${topic}"`), line);
    assert.ok(line.includes("Move the nightly build to one in the morning"), "the decision being answered is still named");
    assert.ok(!line.endsWith("..."), line);
    assert.ok(d.id);
    // The worst case with many started changes still fits.
    const long = describe(OP, { decisionId: d.id, response: "alternative", alternative: { statement, topic } }, { [d.id]: `${"x".repeat(80)}; 99 changes left to carry out`, [`started:${d.id}`]: "12" });
    assert.ok(long.includes(`alternative="${statement}" on topic "${topic}"`) && long.includes("xxxx") && !long.endsWith("..."), `${long.length}: ${long}`);
  });

  suite("a part-applied decision that is agreed after its targets moved says what was done before and why the rest was not carried out", async (w, script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Mixed task", { kinds: ["task.retitle", "task.update", "task.update"], join: false });
    ctl.policy.value = "ask"; // asked only now: a decision concluded under "ask" waits whole, one asked part way is held
    assert.deepEqual(await ctl.records.apply(w.owner, { decisionId: d.id }), { applied: 1, notApplied: 0, pending: 2, waitingFor: "owner" });
    for (const taskId of d.taskIds.slice(1)) await w.projects.updateTask({ commandId: cid("mv"), actor: "owner:rob", taskId, expectedRevision: (await w.projects.getTask(taskId))!.revision, title: "Changed by someone else" } as never);
    const chat = w.chat();
    script["Agree with the nightly build."] = [cmd(OP, { response: "agree", decisionTopic: "nightly build" }, "Agree with the nightly build")];
    const proposed = only((await say(w, chat, "Agree with the nightly build.")).outcomes);
    assert.equal(proposed.status, "proposed", JSON.stringify(proposed));
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
    assert.deepEqual(applied.results[0]!.shown, ["You agreed. None of its changes was carried out now. 1 change had been done before.", "2 changes not carried out: what it changes had moved on."]);
    assert.deepEqual((await ctl.decision(d.id)).changes.map((c) => c.state), ["applied", "not-applied", "not-applied"]);
  });

  suite("an agreement whose applier fails keeps the answer, says so, and the change is finished by applying the decision again", async (w, script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const chat = w.chat();
    script["Agree with the nightly build."] = [cmd(OP, { response: "agree", decisionTopic: "nightly build" }, "Agree with the nightly build")];
    const proposed = only((await say(w, chat, "Agree with the nightly build.")).outcomes);
    ctl.crash.n = 1;
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(applied.results[0]!.shown, ["You agreed. None of its changes was carried out now.", STILL]);
    const saved = await ctl.decision(d.id);
    assert.deepEqual([saved.ownerResponse, saved.changes[0]!.state], ["agreed", "applying"]);
    assert.deepEqual((await call(w, w.ownerToken, "meeting.decisions.waiting", {})).result.item.items, [], "it no longer waits for the owner");
    const again = await call(w, w.ownerToken, "meeting.record.apply", { decisionId: d.id }, cid("apply"));
    assert.deepEqual([again.ok, again.result.applied], [true, 1], JSON.stringify(again));
    assert.equal(await ctl.title(d.taskId), "Nightly task v2");
  });

  suite("a decision that waits with one change already started says so before a decline, and tells afterwards that the started change was finished", async (w, script, ctl) => {
    // A widening change waits for the owner while the plain one is started in the same pass and fails: the decision waits with [adopted, applying].
    const d = await ctl.pending(NIGHTLY, "nightly build", "Held task", { kinds: ["task.update", "task.retitle"], join: false });
    ctl.policy.value = "ask";
    ctl.crash.plain = 1;
    await assert.rejects(() => ctl.records.apply(w.owner, { decisionId: d.id }), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
    const item = (await call(w, w.ownerToken, "meeting.decisions.waiting", {})).result.item.items[0];
    assert.deepEqual([item.id, item.left, item.applying], [d.id, 2, 1]);
    const chat = w.chat();
    script["No, not the nightly build."] = [cmd(OP, { response: "decline", decisionTopic: "nightly build" }, "not the nightly build")];
    const proposed = only((await say(w, chat, "No, not the nightly build.")).outcomes);
    assert.match(String(proposed.preview), /declining refuses the changes not yet started; 1 already started will still be finished; those already done stay done\)/);
    const declined = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
    assert.deepEqual(declined.results[0]!.shown, ["You declined. The changes not yet started are refused; those already done stay done.", "1 change already started was finished."]);
    assert.deepEqual((await ctl.decision(d.id)).changes.map((c) => c.state), ["not-applied", "applied"]);
    assert.equal(await ctl.title(d.taskIds[1]!), "Held task 2 v2");
  });

  suite("an alternative the decision service would refuse on the topic is not proposed: another kind of decision on it, the same words already decided, no topic of its own", async (w, script, ctl) => {
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const b = await ctl.pending(STAGING, "staging server", "Staging task");
    const chat = w.chat();
    const decide = (topic: string, category: string, statement: string) => w.decisions.record(w.owner, { commandId: cid("dec"), projectId: ctl.project, category, topic, statement, wording: statement, source: { channel: "direct" }, basedOn: 0 } as never);
    await decide("nightly build", "goal", "Ship the nightly build by Friday");
    await decide("staging server", "decision", "keep the staging server until May");
    const asRefused = async (text: string, decisionTopic: string, statement: string, extra: Record<string, unknown> = {}) => {
      script[text] = [cmd(OP, { response: "alternative", decisionTopic, alternativeStatement: statement, ...extra }, text.replace(/\.$/, ""))];
      return only((await say(w, chat, text)).outcomes);
    };
    const goal = await asRefused("I would rather keep the nightly build at midnight.", "nightly", "keep the nightly build at midnight");
    assert.deepEqual([goal.status, goal.code], ["refused", "invalid_command"], JSON.stringify(goal));
    assert.match(String(goal.message), /^Nothing was proposed: the topic "nightly build" holds goal decisions/);
    assert.match(String(goal.message), /The meeting decision still waits for your answer/);
    const same = await asRefused("I would rather keep the staging server until May.", "staging", "keep the staging server until May");
    assert.match(String(same.message), /^Nothing was proposed: you have already decided exactly this on the topic "staging server"; it stands/);
    // The owner's own topic words name another topic, which is free: proposed.
    const other = await asRefused("I would rather keep the staging server until May, topic hosting plan.", "staging", "keep the staging server until May", { alternativeTopic: "hosting plan" });
    assert.equal(other.status, "proposed", JSON.stringify(other));
    assert.equal((await ctl.decision(a.id)).ownerResponse, "pending");
    assert.equal((await ctl.decision(b.id)).ownerResponse, "pending");
  });

  suite("a model's own ID missing from a cut list says so; a one-word alternative is told the real rule; words match whole words only", async (w, script, ctl) => {
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const b = await ctl.pending(STAGING, "staging server", "Staging task");
    const chat = w.chat();
    ctl.cutTo.id = a.id;
    script["Agree with that one."] = [cmd(OP, { response: "agree", decisionId: b.id }, "Agree with that one")];
    const cut = only((await say(w, chat, "Agree with that one.")).outcomes);
    assert.match(String(cut.message), /More meeting decisions wait for you than could be read/);
    delete ctl.cutTo.id;
    script["Do it at the staging server."] = [cmd(OP, { response: "alternative", decisionTopic: "staging", alternativeStatement: "Do it" }, "Do it at the staging server")];
    const short = only((await say(w, chat, "Do it at the staging server.")).outcomes);
    assert.match(String(short.message), /a decision needs at least two words and at least six characters/);
    // "night" is part of "nightly" but not a word of it; "builds" fits "build".
    script["Agree with the night one."] = [cmd(OP, { response: "agree", decisionTopic: "night" }, "Agree with the night one")];
    const part = only((await say(w, chat, "Agree with the night one.")).outcomes);
    assert.deepEqual([part.status, part.code], ["refused", "not_found"], JSON.stringify(part));
    script["Agree with the nightly builds."] = [cmd(OP, { response: "agree", decisionTopic: "nightly builds" }, "Agree with the nightly builds")];
    assert.equal(only((await say(w, chat, "Agree with the nightly builds.")).outcomes).status, "proposed");
  });

  test("the lines told after an answer give the true reason for every kind of change that was not carried out", () => {
    const reasons: Record<string, RegExp> = { conflict: /moved on/, unauthorized: /no one with the right/, gate: /project's rules or a later decision/, missing: /no longer exists/, failed: /could not be carried out/, recommendation: /only a recommendation/ };
    for (const [code, re] of Object.entries(reasons)) {
      const lines = ownerAnswerLines("agree", { carriedOut: 0, refused: [code, code], alreadyDone: 0, stillOpen: 0 });
      assert.match(lines[1]!, new RegExp(`^2 changes not carried out: .*${re.source}`), code);
    }
    assert.deepEqual(ownerAnswerLines("agree", { carriedOut: 2, refused: [], alreadyDone: 1, stillOpen: 1 }), ["You agreed. 2 changes carried out now. 1 change had been done before.", "1 change still waits to be carried out."]);
    assert.deepEqual(ownerAnswerLines("decline", { carriedOut: 0, refused: ["owner", "owner"], alreadyDone: 0, stillOpen: 0 }), ["You declined. The changes not yet started are refused; those already done stay done."], "the owner's own refusal is not listed as a failure");
    assert.equal(ownerAnswerLines("decline", { carriedOut: 0, refused: ["conflict"], alreadyDone: 0, stillOpen: 1, applying: 1, stillApplying: true }).length, 3);
  });

  suite("a decision with no topic of its own is not given a topic made from an agent's words: the owner is asked to name one", async (w, script, ctl) => {
    // The agenda topic cannot stand as a decision topic (punctuation), and the motion names none.
    await ctl.pending(NIGHTLY, "nightly build", "Nightly task", { agendaTopic: "Nightly build?!" });
    const chat = w.chat();
    const said = "I would rather keep the nightly build at midnight until March.";
    script[said] = [cmd(OP, { response: "alternative", decisionTopic: "nightly", alternativeStatement: "keep the nightly build at midnight until March" }, "keep the nightly build at midnight until March")];
    const refused = only((await say(w, chat, said)).outcomes);
    assert.match(String(refused.message), /^Nothing was proposed: the decision has no topic of its own\. The meeting decision still waits for your answer; name a topic for yours/);
  });

  const REPORT = "Keep the nightly report weekly.";

  suite("after the question which decision, an alternative and a decision stated in the same message are linked to the message the words were said in, and confirm", async (w, script, ctl) => {
    w.profile.value = "autonomous";
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const b = await ctl.pending(REPORT, "nightly report", "Report task");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: ctl.project });
    const said = "For build hours, use midnight for the nightly build. I would rather keep the nightly build at midnight until March, as the nightly schedule.";
    script[said] = [
      cmd("decision.record", { projectId: ctl.project, category: "decision", topic: "build hours", statement: "use midnight for the nightly build", wording: "use midnight for the nightly build" }, "use midnight for the nightly build"),
      cmd(OP, { response: "alternative", decisionTopic: "nightly", alternativeStatement: "keep the nightly build at midnight until March", alternativeTopic: "nightly schedule" }, "keep the nightly build at midnight until March"),
    ];
    const first = await say(w, chat, said);
    assert.ok(first.outcomes.some((o) => o.status === "asked"), JSON.stringify(first.outcomes));
    assert.equal(first.outcomes.filter((o) => o.status === "applied").length, 0, "nothing runs while the question is open");
    script["The build one."] = [{ kind: "answer", turnId: first.turnId, choice: a.id, evidence: "The build one", basis: "owner" }];
    const answered = (await say(w, chat, "The build one.")).outcomes;
    // The decision stated in the first message is recorded from that message, not from the answer.
    const recordedStep = answered.find((o) => o.op === "decision.record")!;
    assert.equal(recordedStep.status, "applied", JSON.stringify(answered));
    const rec = (await call(w, w.ownerToken, "decision.get", { decisionId: recordedStep.id })).result.item;
    assert.equal(rec.source.turnId, first.turnId);
    const proposal = answered.find((o) => o.status === "proposed")!;
    assert.ok(proposal, JSON.stringify(answered));
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposal.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.equal((await ctl.decision(a.id)).ownerResponse, "alternative");
    assert.equal((await ctl.decision(b.id)).ownerResponse, "pending");
  });

  suite("a list cut short with nothing read, or with one match, says so and is not read as empty", async (w, script, ctl) => {
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    await ctl.pending(STAGING, "staging server", "Staging task");
    const chat = w.chat();
    ctl.cutTo.id = "mdn-nothing";
    script["Agree with the nightly build."] = [cmd(OP, { response: "agree", decisionTopic: "nightly build" }, "Agree with the nightly build")];
    const none = only((await say(w, chat, "Agree with the nightly build.")).outcomes);
    assert.match(String(none.message), /More meeting decisions exist than could be read at once, and none of those read waits for you/);
    ctl.cutTo.id = a.id;
    const one = only((await say(w, chat, "Agree with the nightly build.")).outcomes);
    assert.equal(one.status, "proposed", JSON.stringify(one));
    assert.ok((one.preview as unknown as string[]).some((l) => /^Not every waiting decision could be read; check this is the one you mean\.$/.test(l)), JSON.stringify(one.preview));
  });

  suite("an agreement whose pass fails before any change starts says the changes still wait and what finishes them; a repeated answer says it was already given", async (w, script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const chat = w.chat();
    script["Agree with the nightly build."] = [cmd(OP, { response: "agree", decisionTopic: "nightly build" }, "Agree with the nightly build")];
    const proposed = only((await say(w, chat, "Agree with the nightly build.")).outcomes);
    ctl.authFail.on = true;
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
    ctl.authFail.on = false;
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(applied.results[0]!.shown, ["You agreed. None of its changes was carried out now.", "Carrying out the changes failed before any of them started; 1 change still waits. Nothing applies it again by itself; the decision must be applied again through the API (meeting.record.apply), which you have no chat command for yet."]);
    assert.equal((await ctl.decision(d.id)).changes[0]!.state, "adopted", "nothing was started, so nothing is reported as applying");
    // The same answer sent again (same command ID) is told to be already given.
    const once = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "same-answer");
    assert.equal(once.ok, false, "the decision was answered above, so a new command is refused");
    const e = await ctl.pending(STAGING, "staging server", "Staging task");
    const first = await call(w, w.ownerToken, OP, { decisionId: e.id, response: "decline" }, "answer-once");
    assert.equal(first.result.shown[0], "You declined. The changes not yet started are refused; those already done stay done.");
    const again = await call(w, w.ownerToken, OP, { decisionId: e.id, response: "decline" }, "answer-once");
    assert.deepEqual([again.result.replayed, again.result.shown], [true, ["This answer (decline) was already given; nothing more was done now."]]);
  });

  test("started changes and other waiting changes are both told", () => {
    const lines = ownerAnswerLines("agree", { carriedOut: 0, refused: [], alreadyDone: 0, stillOpen: 3, applying: 1, stillApplying: true });
    assert.deepEqual(lines.slice(1), [STILL, "2 more changes still wait to be carried out."]);
  });

  suite("a topic with a conflict of any scope, a task-level one included, is not proposed for; each refusal says what to do", async (w, script, ctl) => {
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const chat = w.chat();
    const task = a.taskId;
    const decide = (statement: string) => w.decisions.record(w.owner, { commandId: cid("dec"), projectId: ctl.project, taskId: task, category: "decision", topic: "nightly build", statement, wording: statement, source: { channel: "direct" }, basedOn: 0 } as never);
    await decide("Run the nightly build at one");
    await decide("Run the nightly build at two");
    const text = "I would rather keep the nightly build at midnight until March.";
    script[text] = [cmd(OP, { response: "alternative", decisionTopic: "nightly", alternativeStatement: "keep the nightly build at midnight until March" }, "keep the nightly build at midnight until March")];
    const refused = only((await say(w, chat, text)).outcomes);
    assert.match(String(refused.message), /^Nothing was proposed: the topic "nightly build" has a conflict between two of your instructions\. The meeting decision still waits for your answer; settle that conflict first, or decline the meeting's decision\.$/);
  });

  suite("words match whole words across hyphens and es-plurals, and decisions of different projects are told apart by project, or narrowed by the project the owner names", async (w, script, ctl) => {
    const other = await w.project("B");
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const b = await ctl.pending(REPORT, "nightly report", "Report task", { project: other });
    const boxes = await ctl.pending("Replace the old boxes on Friday.", "hardware refresh", "Hardware task");
    const chat = w.chat();
    script["Agree with the staging-server."] = [cmd(OP, { response: "agree", decisionTopic: "nightly-build" }, "Agree with the staging-server")];
    // (the words are not in the message above on purpose: refused, nothing matched by accident)
    assert.equal(only((await say(w, chat, "Agree with the staging-server.")).outcomes).code, "unsupported_value");
    script["Agree with the nightly-build one."] = [cmd(OP, { response: "agree", decisionTopic: "nightly-build" }, "Agree with the nightly-build one")];
    const hyphen = only((await say(w, chat, "Agree with the nightly-build one.")).outcomes);
    assert.equal(hyphen.status, "proposed", JSON.stringify(hyphen));
    assert.match(String(hyphen.preview), /nightly build to one in the morning/);
    script["Agree with the box one."] = [cmd(OP, { response: "agree", decisionTopic: "box" }, "Agree with the box one")];
    const es = only((await say(w, chat, "Agree with the box one.")).outcomes);
    assert.match(String(es.preview), /old boxes/);
    // Two projects: the question names them.
    script["Agree with the nightly one."] = [cmd(OP, { response: "agree", decisionTopic: "nightly" }, "Agree with the nightly one")];
    const asked = only((await say(w, chat, "Agree with the nightly one.")).outcomes);
    assert.equal(asked.status, "asked");
    assert.ok((asked.options as string[]).some((o) => o.startsWith(a.id) && o.endsWith(", in A)")) && (asked.options as string[]).some((o) => o.startsWith(b.id) && o.endsWith(", in B)")), JSON.stringify(asked.options));
    // A project the owner names narrows the choice.
    script["Agree with the nightly one in B."] = [cmd(OP, { response: "agree", decisionTopic: "nightly", projectName: "B" }, "Agree with the nightly one in B")];
    const narrowed = only((await say(w, chat, "Agree with the nightly one in B.")).outcomes);
    assert.equal(narrowed.status, "proposed", JSON.stringify(narrowed));
    assert.match(String(narrowed.preview), /nightly report weekly/);
    // A project the owner names where nothing waits is told so, not "nothing waits anywhere".
    await w.project("C");
    script["Agree with the nightly one in C."] = [cmd(OP, { response: "agree", decisionTopic: "nightly", projectName: "C" }, "Agree with the nightly one in C")];
    const none = only((await say(w, chat, "Agree with the nightly one in C.")).outcomes);
    assert.equal(none.message, "no meeting decision of that project is waiting for your answer");
    assert.ok(boxes.id);
  });

  // A seeded sample of the flow: 1 to 3 waiting decisions, a response, a name that is unique or shared (so the owner is asked and picks in any order), a list cut short, a failing applier,
  // the same message or confirm sent again, a crash after the answer ran but before the proposal was marked applied, a second answer to the same decision in the message, and an agreement that stops part way.
  // For every sample: nothing is applied before the owner confirms, the confirm is never refused as invalid for a proposal the chat made, and what the owner is told matches what the record holds.
  suite("seeded samples of answering held decisions by chat keep their promises", async (w, script, ctl) => {
    w.profile.value = "autonomous";
    const nouns = ["nightly build", "staging server", "backup job", "billing export", "release notes", "cache warmup", "audit trail", "label printer", "mail relay", "search index", "log rotation", "image resize", "tax report", "door badge", "feed import", "queue limit", "spam filter", "disk quota", "chat export", "map tiles", "video proxy", "form archive", "user import", "help pages", "map labels", "rate table", "gift cards", "tag cloud", "icon pack", "font cache", "geo lookup", "sync log", "wiki links", "mail digest", "task board", "time sheet"];
    let seed = 20261107;
    const next = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const chat = w.chat();
    const months = ["March", "April", "May", "June", "July", "August", "September", "October", "November", "December", "January", "February"];
    for (let k = 0; k < 21; k++) {
      const count = 1 + next(3);
      let response = (["agree", "decline", "alternative"] as const)[next(3)]!;
      let shared = count > 1 && next(2) === 0;
      let cut = next(3) === 0;
      let partial = response === "agree" && next(3) === 0;
      let fail = response === "agree" && !partial && next(2) === 0;
      let twice = next(4) === 0;
      let crashAfter = next(3) === 0;
      // A crash between recording the alternative and saving the answer (chat path only; the confirm is then sent again).
      let recordCrash = response === "alternative" && next(2) === 0;
      const resendTurn = next(2) === 0;
      const resendConfirm = next(2) === 0;
      // Some combinations are forced so every kind is sampled whatever the sequence gives: two answers in one message (any response), and an agreement that stops part way and is then repeated after a crash.
      if (crashAfter) recordCrash = false;
      if (k % 7 === 3) { twice = true; shared = false; cut = false; }
      if (k === 20) { response = "agree"; partial = true; fail = false; crashAfter = true; shared = false; cut = false; twice = false; }
      if (k === 13) { response = "agree"; partial = true; fail = false; crashAfter = true; shared = false; cut = false; twice = false; }
      const made: { id: string; noun: string; taskId: string }[] = [];
      for (let n = 0; n < count; n++) {
        const noun = `${nouns[(k * 3 + n) % nouns.length]!} ${Math.floor((k * 3 + n) / nouns.length)}`.replace(" 0", "");
        const d = await ctl.pending(`Tune the ${noun} schedule.`, noun, `Task ${k}-${n}`, { kinds: partial && n === 0 ? ["task.update", "task.update"] : ["task.update"] });
        made.push({ id: d.id, noun, taskId: d.taskId });
      }
      const picked0 = made[next(count)]!;
      const target = k === 13 || k === 20 ? made[0]! : picked0;
      const partialTarget = partial && made[0]!.id === target.id;
      const name = shared ? "schedule" : target.noun;
      const keep = `keep the ${target.noun} at midnight until ${months[k % 12]}`;
      const label = JSON.stringify({ k, recordCrash, response, shared, cut, partial, fail, twice, crashAfter, resendTurn, resendConfirm, count });
      const text = response === "alternative" ? `Sample ${k}: I would rather ${keep} than that ${name} change.` : `Sample ${k}: ${response === "agree" ? "Agree with" : "No to"} the ${name} change.`;
      const one = cmd(OP, { response, decisionTopic: name, ...(response === "alternative" ? { alternativeStatement: keep } : {}) }, response === "alternative" ? keep : text.slice(text.indexOf(":") + 2, -1));
      // A second answer to the same decision in the same message (it can only fail when confirmed, so it is refused before).
      script[text] = twice && !shared && !cut ? [one, cmd(OP, { response: response === "decline" ? "agree" : "decline", decisionTopic: name }, text.slice(text.indexOf(":") + 2, -1))] : [one];
      if (cut) ctl.cutTo.id = target.id;
      const messageId = `m-sample-${k}`;
      const first = await chat.submit(w.ownerToken, { messageId, text });
      delete ctl.cutTo.id;
      for (const m of made) assert.equal((await ctl.decision(m.id)).ownerResponse, "pending", `sample ${label}: nothing is answered before the owner confirms`);
      let outcomes = first.outcomes;
      const mustAsk = shared && !cut;
      assert.equal(outcomes.some((o) => o.status === "asked"), mustAsk, `sample ${label}: ${JSON.stringify(outcomes)}`);
      let pickTurn = first.turnId;
      if (mustAsk) {
        script[`Sample ${k} pick.`] = [{ kind: "answer", turnId: first.turnId, choice: target.id, evidence: `Sample ${k} pick`, basis: "owner" }];
        const picked = await say(w, chat, `Sample ${k} pick.`);
        outcomes = picked.outcomes;
        pickTurn = picked.turnId;
      } else if (resendTurn) {
        // The message sent again with the same ID is the same turn: the same proposal, nothing new.
        const again = await chat.submit(w.ownerToken, { messageId, text });
        assert.equal(again.turnId, first.turnId, `sample ${label}`);
        assert.deepEqual(again.outcomes.map((o) => o.proposalId), first.outcomes.map((o) => o.proposalId), `sample ${label}: the same proposal`);
      }
      void pickTurn;
      if (twice && !shared && !cut) assert.deepEqual(outcomes.map((o) => o.status), ["proposed", "refused"], `sample ${label}: ${JSON.stringify(outcomes)}`);
      const proposal = outcomes.find((o) => o.status === "proposed");
      assert.ok(proposal, `sample ${label}: a proposal, not a refusal: ${JSON.stringify(outcomes)}`);
      for (const m of made) assert.equal((await ctl.decision(m.id)).ownerResponse, "pending", `sample ${label}: the proposal changes nothing`);
      if (fail) ctl.crash.n = 1;
      // k = 20: the first call fails before anything starts, the repeat carries one change out and fails on the next.
      const laterFail = k === 20;
      if (partialTarget) Object.assign(ctl.authFail, { on: true, after: laterFail ? 0 : 1, calls: 0 });
      let crashed = false;
      const flaky = { handle: async (token: string, raw: unknown) => { const r = await w.api.handle(token, raw as never); if ((raw as { op?: string }).op === OP && !crashed) { crashed = true; throw new Error("crash"); } return r; } };
      let applied;
      if (recordCrash) {
        ctl.recordCrash.n = 1;
        const failed = await chat.applyProposal(w.ownerToken, { commandId: `ap-${k}`, proposalId: proposal!.proposalId! }).catch((e: unknown) => e);
        assert.ok(failed instanceof Error || (failed as { applied: boolean }).applied === false, `sample ${label}: ${JSON.stringify(failed)}`);
        assert.equal((await ctl.decision(target.id)).ownerResponse, "pending", `sample ${label}: not answered by the failed confirm`);
        ctl.recordCrash.n = 0;
        applied = await chat.applyProposal(w.ownerToken, { commandId: `ap-${k}`, proposalId: proposal!.proposalId! });
      } else if (crashAfter) {
        await assert.rejects(w.chat({ api: flaky as never }).applyProposal(w.ownerToken, { commandId: `ap-${k}`, proposalId: proposal!.proposalId! }), /crash/, `sample ${label}`);
        ctl.crash.n = 0;
        if (laterFail) Object.assign(ctl.authFail, { on: true, after: 1, calls: 0 }); else ctl.authFail.on = false;
        applied = await w.chat().applyProposal(w.ownerToken, { commandId: `ap-${k}`, proposalId: proposal!.proposalId! });
      } else {
        applied = await chat.applyProposal(w.ownerToken, { commandId: `ap-${k}`, proposalId: proposal!.proposalId! });
      }
      ctl.crash.n = 0;
      ctl.authFail.on = false;
      assert.equal(applied.applied, true, `sample ${label}: ${JSON.stringify(applied)}`);
      const told = (applied.results[0]!.shown ?? []).join("\n");
      const rec = await ctl.decision(target.id);
      assert.equal(rec.ownerResponse, response === "agree" ? "agreed" : response === "decline" ? "declined" : "alternative", `sample ${label}`);
      for (const m of made.filter((x) => x.id !== target.id)) assert.equal((await ctl.decision(m.id)).ownerResponse, "pending", `sample ${label}: the others still wait`);
      const states = rec.changes.map((c) => c.state);
      if (response === "agree") {
        if (crashAfter) {
          // The first call ran fully before the crash; the repeat says it was given, and finishes only what a failed applier left.
          assert.match(told, /^This answer \(agree\) was already given/, `sample ${label}: ${told}`);
          if (fail) { assert.deepEqual(states, ["applied"], `sample ${label}`); assert.match(told, /this call finished what was left:\nYou agreed\. 1 change carried out now\./, `sample ${label}: ${told}`); }
          else if (partialTarget && laterFail) {
            assert.deepEqual(states, ["applied", "adopted"], `sample ${label}`);
            assert.match(told, /^This answer \(agree\) was already given; this call did this much of what was left:\nYou agreed\. 1 change carried out now\.\nCarrying out stopped before the rest started; 1 change still waits\./, `sample ${label}: ${told}`);
          }
          else if (partialTarget) { assert.deepEqual(states, ["applied", "applied"], `sample ${label}: the repeat finishes the rest`); assert.match(told, /1 change carried out now/, `sample ${label}: ${told}`); }
          else { assert.deepEqual(states, ["applied"], `sample ${label}`); assert.equal(told, "This answer (agree) was already given; nothing more was done now.", `sample ${label}`); }
        } else if (partialTarget) {
          assert.deepEqual(states, ["applied", "adopted"], `sample ${label}`);
          assert.match(told, /^You agreed\. 1 change carried out now\.\nCarrying out stopped before the rest started; 1 change still waits\./, `sample ${label}: ${told}`);
        } else {
          assert.deepEqual(states, [fail ? "applying" : "applied"], `sample ${label}`);
          assert.equal(/stays applying/.test(told), fail, `sample ${label}: ${told}`);
          assert.equal(/1 change carried out now/.test(told), !fail, `sample ${label}: ${told}`);
        }
      } else {
        assert.deepEqual(states, ["not-applied"], `sample ${label}`);
        if (crashAfter) assert.equal(told, `This answer (${response === "decline" ? "decline" : "your own decision"}) was already given; nothing more was done now.`, `sample ${label}: ${told}`);
        else assert.match(told, response === "decline" ? /^You declined/ : /^You chose your own decision instead/, `sample ${label}`);
        if (response === "alternative") {
          const own = await call(w, w.ownerToken, "decision.get", { decisionId: rec.ownerDecisionId });
          assert.equal(own.result.item.statement, keep, `sample ${label}: the owner's own words are the decision`);
          assert.equal(own.result.item.source.turnId, first.turnId, `sample ${label}: linked to the message the words were said in`);
          assert.equal((await w.decisions.history(w.owner, { projectId: ctl.project, topic: target.noun })).length, 1, `sample ${label}: recorded once`);
        }
      }
      // The same confirm sent again changes and tells nothing new that is false: the proposal is done.
      if (resendConfirm) {
        const statesBefore = JSON.stringify((await ctl.decision(target.id)).changes.map((c) => c.state));
        const again: { applied: boolean } | Error = await chat.applyProposal(w.ownerToken, { commandId: `ap-${k}`, proposalId: proposal!.proposalId! }).catch((e: Error) => e);
        assert.equal(JSON.stringify((await ctl.decision(target.id)).changes.map((c) => c.state)), statesBefore, `sample ${label}: a repeated confirm changes nothing`);
        if (!(again instanceof Error)) assert.equal(again.applied, true, `sample ${label}`);
      }
      // Leave nothing waiting for the next sample.
      for (const m of made.filter((x) => x.id !== target.id)) await call(w, w.ownerToken, OP, { decisionId: m.id, response: "decline" }, `clear-${k}-${m.id}`);
    }
  });

  const altArgs = (ctl: Ctl, topic: string, statement: string, id: string) => ({ commandId: id, projectId: ctl.project, category: "decision", topic, statement, wording: statement, source: { channel: "direct" }, basedOn: 0 });
  const firstWaiting = async (w: World): Promise<string> => (await call(w, w.ownerToken, "meeting.decisions.waiting", {})).result.item.items[0].id as string;

  suite("an alternative sent again with the same command is a repeat, not an error; a different command is refused as already answered", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const args = { decisionId: d.id, response: "alternative", alternative: altArgs(ctl, "nightly build", "Keep the nightly build at midnight.", "alt-direct") };
    const first = await call(w, w.ownerToken, OP, args, "ans-alt");
    assert.equal(first.ok, true, JSON.stringify(first));
    const again = await call(w, w.ownerToken, OP, args, "ans-alt");
    assert.equal(again.ok, true, JSON.stringify(again));
    assert.deepEqual([again.result.replayed, again.result.ownerDecisionId], [true, first.result.ownerDecisionId]);
    assert.deepEqual(again.result.shown, ["This answer (your own decision) was already given; nothing more was done now."]);
    const other = await call(w, w.ownerToken, OP, args, "ans-alt-2");
    assert.equal(other.ok, false);
    assert.equal(other.error.code, "invalid_command");
    assert.equal((await w.decisions.history(w.owner, { projectId: ctl.project, topic: "nightly build" })).length, 1, "recorded once");
  });

  suite("a proposal whose step ran but was not marked applied (a crash) is applied again as a repeat and says so", async (w, script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const text = "I would rather keep the nightly build at midnight until March, not that change.";
    script[text] = [cmd(OP, { response: "alternative", decisionTopic: "nightly build", alternativeStatement: "keep the nightly build at midnight until March" }, "keep the nightly build at midnight until March")];
    const proposal = only((await say(w, w.chat(), text)).outcomes);
    let crashed = false;
    const flaky = { handle: async (token: string, raw: unknown) => { const r = await w.api.handle(token, raw as never); if ((raw as { op?: string }).op === OP && !crashed) { crashed = true; throw new Error("crash"); } return r; } };
    await assert.rejects(w.chat({ api: flaky as never }).applyProposal(w.ownerToken, { commandId: "ap-crash", proposalId: proposal.proposalId! }), /crash/);
    assert.equal((await ctl.decision(d.id)).ownerResponse, "alternative");
    const again = await w.chat().applyProposal(w.ownerToken, { commandId: "ap-crash", proposalId: proposal.proposalId! });
    assert.equal(again.applied, true, JSON.stringify(again));
    assert.deepEqual(again.results[0]!.shown, ["This answer (your own decision) was already given; nothing more was done now."]);
  });

  suite("a repeated answer that finishes a started change says what it finished", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    ctl.crash.n = 1;
    const first = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-agree");
    assert.equal(first.result.stillApplying, true, JSON.stringify(first));
    const again = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-agree");
    assert.equal(again.result.replayed, true);
    assert.equal(again.result.carriedOut, 1);
    assert.deepEqual(again.result.shown, ["This answer (agree) was already given; this call finished what was left:", "You agreed. 1 change carried out now. 0 changes had been done before.".replace(" 0 changes had been done before.", "")]);
    assert.equal((await ctl.decision(d.id)).changes[0]!.state, "applied");
    const third = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-agree");
    assert.deepEqual(third.result.shown, ["This answer (agree) was already given; nothing more was done now."]);
    // A decline with a started change, finished by the repeat.
    const e = await ctl.pending(STAGING, "staging server", "Staging task", { kinds: ["task.update", "task.retitle"], join: false });
    ctl.policy.value = "ask";
    ctl.crash.plain = 1;
    await assert.rejects(() => ctl.records.apply(w.owner, { decisionId: e.id }), (x: unknown) => x instanceof DomainError && x.code === "unavailable");
    ctl.crash.plain = 1;
    const declined = await call(w, w.ownerToken, OP, { decisionId: e.id, response: "decline" }, "ans-decline");
    assert.equal(declined.result.stillApplying, true, JSON.stringify(declined));
    const repeat = await call(w, w.ownerToken, OP, { decisionId: e.id, response: "decline" }, "ans-decline");
    assert.equal(repeat.result.carriedOut, 1, JSON.stringify(repeat));
    assert.equal(repeat.result.shown[0], "This answer (decline) was already given; this call finished what was left:");
  });

  suite("an agreement that carries out the first change and stops before the second says the rest still wait, not that nothing started", async (w, script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task", { kinds: ["task.update", "task.update"] });
    const chat = w.chat();
    script["Agree with the nightly build."] = [cmd(OP, { response: "agree", decisionTopic: "nightly build" }, "Agree with the nightly build")];
    const proposed = only((await say(w, chat, "Agree with the nightly build.")).outcomes);
    Object.assign(ctl.authFail, { on: true, after: 1, calls: 0 });
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
    ctl.authFail.on = false;
    assert.equal(applied.applied, true, JSON.stringify(applied));
    assert.deepEqual(applied.results[0]!.shown, ["You agreed. 1 change carried out now.", "Carrying out stopped before the rest started; 1 change still waits. Nothing applies it again by itself; the decision must be applied again through the API (meeting.record.apply), which you have no chat command for yet."]);
    assert.deepEqual((await ctl.decision(d.id)).changes.map((c) => c.state), ["applied", "adopted"]);
  });

  suite("an alternative recorded in conflict with another instruction on its topic is told as a conflict", async (w, script, ctl) => {
    const d = await ctl.pending(STAGING, "staging server", "Staging task");
    const chat = w.chat();
    const text = "I would rather keep the staging server until May, not that change.";
    script[text] = [cmd(OP, { response: "alternative", decisionTopic: "staging server", alternativeStatement: "keep the staging server until May" }, "keep the staging server until May")];
    const proposed = only((await say(w, chat, text)).outcomes);
    // Another instruction on the topic arrives after the proposal was drawn up (a later turn).
    await w.decisions.record(w.owner, { commandId: cid("later"), projectId: ctl.project, category: "decision", topic: "staging server", statement: "Retire the staging server in April", wording: "Retire the staging server in April", source: { channel: "direct" }, basedOn: 0 } as never);
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: proposed.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    const shown = applied.results[0]!.shown!;
    assert.match(shown[0]!, /^You chose your own decision instead/);
    assert.equal(shown[shown.length - 1], "Your decision is recorded, but it conflicts with another of your instructions on its topic: nothing on that topic is in force until you choose.");
    assert.equal((await ctl.decision(d.id)).ownerResponse, "alternative");
  });

  suite("two answers to the same decision in one message: the first is proposed, the second refused", async (w, script, ctl) => {
    await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const text = "Agree with the nightly build. No, decline the nightly build.";
    script[text] = [cmd(OP, { response: "agree", decisionTopic: "nightly build" }, "Agree with the nightly build"), cmd(OP, { response: "decline", decisionTopic: "nightly build" }, "decline the nightly build")];
    const out = (await say(w, w.chat(), text)).outcomes;
    assert.deepEqual(out.map((o) => o.status), ["proposed", "refused"], JSON.stringify(out));
    assert.match(String(out[1]!.message), /already answered in this message/);
  });

  suite("a held message with two decisions on one topic: resent after a crash it records each once", async (w, script, ctl) => {
    w.profile.value = "autonomous";
    await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    await ctl.pending(REPORT, "nightly report", "Report task");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: ctl.project });
    const said = "For the schedule: use midnight for the nightly build. Then use one for the nightly build instead. Agree with the schedule change.";
    const dec = (statement: string) => cmd("decision.record", { projectId: ctl.project, category: "decision", topic: "schedule", statement, wording: statement }, statement);
    script[said] = [dec("use midnight for the nightly build"), dec("use one for the nightly build"), cmd(OP, { response: "agree", decisionTopic: "nightly" }, "Agree with the schedule change")];
    const first = await say(w, chat, said);
    assert.ok(first.outcomes.some((o) => o.status === "asked"), JSON.stringify(first.outcomes));
    script["The first one."] = [{ kind: "answer", turnId: first.turnId, choice: await firstWaiting(w), evidence: "The first one", basis: "owner" }];
    let calls = 0;
    const flaky = { handle: async (token: string, raw: unknown) => { if ((raw as { op?: string }).op === "decision.record" && ++calls === 2) throw new Error("crash"); return w.api.handle(token, raw as never); } };
    await assert.rejects(w.chat({ api: flaky as never }).submit(w.ownerToken, { messageId: "m-held-crash", text: "The first one." }), /crash/);
    const resumed = await w.chat().submit(w.ownerToken, { messageId: "m-held-crash", text: "The first one." });
    assert.deepEqual(resumed.outcomes.filter((o) => o.op === "decision.record").map((o) => o.status), ["applied", "applied"], JSON.stringify(resumed.outcomes));
    // The step recorded before the crash is answered from the record (no revision comes back, as from a send), because it is this message's own record.
    assert.equal(resumed.outcomes[0]!.revision, undefined, JSON.stringify(resumed.outcomes[0]));
    assert.deepEqual(resumed.outcomes[0]!.shown, ['Recorded decision version 1 on "schedule": use midnight for the nightly build']);
    assert.deepEqual((await w.decisions.history(w.owner, { projectId: ctl.project, topic: "schedule" })).map((d) => [d.version, d.state]), [[1, "superseded"], [2, "active"]]);
  });

  suite("a held message whose decision is recorded by the other copy between the look and the send answers applied", async (w, script, ctl) => {
    w.profile.value = "autonomous";
    await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    await ctl.pending(REPORT, "nightly report", "Report task");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: ctl.project });
    const said = "For the schedule: use midnight for the nightly build. Agree with the schedule change.";
    script[said] = [cmd("decision.record", { projectId: ctl.project, category: "decision", topic: "schedule", statement: "use midnight for the nightly build", wording: "use midnight for the nightly build" }, "use midnight for the nightly build"), cmd(OP, { response: "agree", decisionTopic: "nightly" }, "Agree with the schedule change")];
    const first = await say(w, chat, said);
    script["The first one."] = [{ kind: "answer", turnId: first.turnId, choice: await firstWaiting(w), evidence: "The first one", basis: "owner" }];
    let raced = false;
    const racing = { handle: async (token: string, raw: unknown) => { const r = raw as { op?: string; args?: Record<string, unknown> }; if (r.op === "decision.record" && !raced) { raced = true; await w.api.handle(token, { ...r, args: { ...r.args, basedOn: 9 } } as never); } return w.api.handle(token, raw as never); } };
    const out = (await w.chat({ api: racing as never }).submit(w.ownerToken, { messageId: "m-held-race", text: "The first one." })).outcomes;
    assert.equal(out.find((o) => o.op === "decision.record")!.status, "applied", JSON.stringify(out));
    assert.equal((await w.decisions.history(w.owner, { projectId: ctl.project, topic: "schedule" })).length, 1);
  });

  suite("two questions in a row, then an alternative: the alternative is still linked to the first message", async (w, script, ctl) => {
    w.profile.value = "autonomous";
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const b = await ctl.pending(REPORT, "nightly report", "Report task");
    const chat = w.chat();
    await chat.setFocus(w.ownerToken, { commandId: cid("f"), projectId: ctl.project });
    const said = "I would rather keep the nightly build at midnight until March than the first schedule change. Agree with the second schedule change.";
    script[said] = [
      cmd(OP, { response: "alternative", decisionTopic: "nightly", alternativeStatement: "keep the nightly build at midnight until March" }, "keep the nightly build at midnight until March"),
      cmd(OP, { response: "agree", decisionTopic: "nightly" }, "Agree with the second schedule change"),
    ];
    const first = await say(w, chat, said);
    assert.ok(first.outcomes.some((o) => o.status === "asked"), JSON.stringify(first.outcomes));
    script["The nightly build one."] = [{ kind: "answer", turnId: first.turnId, choice: a.id, evidence: "The nightly build one", basis: "owner" }];
    const second = await say(w, chat, "The nightly build one.");
    assert.ok(second.outcomes.some((o) => o.status === "asked"), JSON.stringify(second.outcomes));
    script["The report one."] = [{ kind: "answer", turnId: second.turnId, choice: b.id, evidence: "The report one", basis: "owner" }];
    const third = await say(w, chat, "The report one.");
    const alt = third.outcomes.find((o) => o.status === "proposed" && JSON.stringify(o).includes("keep the nightly build"));
    assert.ok(alt, JSON.stringify(third.outcomes));
    const applied = await chat.applyProposal(w.ownerToken, { commandId: cid("ap"), proposalId: alt!.proposalId! });
    assert.equal(applied.applied, true, JSON.stringify(applied));
    const rec = await ctl.decision(a.id);
    const own = await call(w, w.ownerToken, "decision.get", { decisionId: rec.ownerDecisionId });
    assert.equal(own.result.item.source.turnId, first.turnId);
  });

  suite("a crash between recording the alternative and saving the answer: the same confirm finishes it, the decision is recorded once", async (w, script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const chat = w.chat();
    const text = "I would rather keep the nightly build at midnight until March, not that change.";
    script[text] = [cmd(OP, { response: "alternative", decisionTopic: "nightly build", alternativeStatement: "keep the nightly build at midnight until March" }, "keep the nightly build at midnight until March")];
    const proposal = only((await say(w, chat, text)).outcomes);
    ctl.recordCrash.n = 1;
    const first = await chat.applyProposal(w.ownerToken, { commandId: "ap-rc", proposalId: proposal.proposalId! }).catch((e: unknown) => e);
    assert.ok(first instanceof Error || (first as { applied: boolean }).applied === false, JSON.stringify(first));
    assert.equal((await ctl.decision(d.id)).ownerResponse, "pending", "not answered yet");
    const again = await chat.applyProposal(w.ownerToken, { commandId: "ap-rc", proposalId: proposal.proposalId! });
    assert.equal(again.applied, true, JSON.stringify(again));
    const rec = await ctl.decision(d.id);
    assert.equal(rec.ownerResponse, "alternative");
    assert.match(again.results[0]!.shown![0]!, /^You chose your own decision instead/);
    assert.equal((await w.decisions.history(w.owner, { projectId: ctl.project, topic: "nightly build" })).length, 1, "recorded once");
    // Through the API too: a crash after recording, then the same arguments.
    const e = await ctl.pending(STAGING, "staging server", "Staging task");
    const args = { decisionId: e.id, response: "alternative", alternative: altArgs(ctl, "staging server", "Keep the staging server until May.", "alt-crash") };
    ctl.recordCrash.n = 1;
    assert.equal((await call(w, w.ownerToken, OP, args, "ans-crash")).ok, false);
    const ok = await call(w, w.ownerToken, OP, args, "ans-crash");
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });

  suite("the same answer command with other words for the alternative is refused, not silently answered with the old ones", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const first = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: altArgs(ctl, "nightly build", "Keep the nightly build at midnight.", "alt-g") }, "ans-g");
    assert.equal(first.ok, true, JSON.stringify(first));
    const changed = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: altArgs(ctl, "nightly build", "Run the nightly build at noon.", "alt-g") }, "ans-g");
    assert.equal(changed.ok, false);
    assert.equal(changed.error.code, "command_conflict");
    const other = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: altArgs(ctl, "nightly build", "Run the nightly build at noon.", "alt-h") }, "ans-g");
    assert.equal(other.ok, false);
    assert.equal(other.error.code, "invalid_command");
    // And before any answer: the alternative's command ID already used for other words is refused.
    const e = await ctl.pending(STAGING, "staging server", "Staging task");
    const other2 = await call(w, w.ownerToken, OP, { decisionId: e.id, response: "alternative", alternative: altArgs(ctl, "staging server", "Keep the staging server until May.", "alt-g") }, "ans-g2");
    assert.equal(other2.ok, false);
    assert.equal(other2.error.code, "command_conflict");
  });

  suite("a repeat that fails again says it could not finish; every change is in exactly one count", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task", { kinds: ["task.update", "task.update"] });
    const sum = (r: any): number => r.carriedOut + r.alreadyDone + r.refusedBefore + (r.refused as unknown as string[]).length + r.stillOpen;
    Object.assign(ctl.authFail, { on: true, after: 1, calls: 0 });
    const first = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-b");
    assert.equal(first.result.passFailed, true, JSON.stringify(first));
    assert.equal(sum(first.result), 2);
    // The same command, failing again at once (the guard fails on its first call): it finished nothing.
    Object.assign(ctl.authFail, { on: true, after: 0, calls: 0 });
    const again = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-b");
    ctl.authFail.on = false;
    assert.equal(again.result.replayed, true);
    assert.equal(sum(again.result), 2, JSON.stringify(again.result));
    assert.equal(again.result.shown[0], "This answer (agree) was already given; what was left could not be finished now:");
    assert.match(again.result.shown.join("\n"), /failed before any of the remaining changes started; 1 change still waits/);
    // Finished at last.
    const done = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-b");
    assert.equal(done.result.carriedOut, 1);
    assert.equal(sum(done.result), 2);
    assert.equal(done.result.shown[0], "This answer (agree) was already given; this call finished what was left:");
  });

  suite("a change refused before the answer is counted and told", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task", { kinds: ["task.update", "task.update"] });
    // The second task moves on before the agreement: its change is refused when carried out.
    const second = (await w.projects.getTask(d.taskIds[1]!))!;
    await w.projects.updateTask({ commandId: cid("u"), actor: w.owner.id, taskId: second.id, expectedRevision: second.revision, title: "Moved on" });
    const first = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-c");
    assert.deepEqual([first.result.carriedOut, first.result.refused, first.result.refusedBefore], [1, ["conflict"], 0], JSON.stringify(first.result));
    const again = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-c");
    assert.deepEqual([again.result.alreadyDone, again.result.refusedBefore, again.result.stillOpen], [1, 1, 0]);
  });

  test("earlier refusals and a passFailed with changes done before are told truly", () => {
    const lines = ownerAnswerLines("agree", { carriedOut: 0, refused: [], alreadyDone: 1, refusedBefore: 1, stillOpen: 1, applying: 0, passFailed: true });
    assert.equal(lines[0], "You agreed. None of its changes was carried out now. 1 change had been done before. 1 change had been refused before.");
    assert.match(lines[1]!, /^Carrying out the changes failed before any of the remaining changes started; 1 change still waits\./);
    assert.deepEqual(ownerAnswerLines("decline", { carriedOut: 0, refused: ["owner"], alreadyDone: 0, refusedBefore: 2, stillOpen: 0, applying: 0 }).slice(1), ["2 changes had been refused before."]);
  });

  suite("a repeat that moves things on and then fails does not say it finished what was left", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task", { kinds: ["task.update", "task.update"] });
    Object.assign(ctl.authFail, { on: true, after: 0, calls: 0 });
    const first = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-later");
    assert.equal(first.result.passFailed, true, JSON.stringify(first.result));
    Object.assign(ctl.authFail, { on: true, after: 1, calls: 0 });
    const again = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-later");
    ctl.authFail.on = false;
    assert.deepEqual((await ctl.decision(d.id)).changes.map((c) => c.state), ["applied", "adopted"]);
    assert.deepEqual(again.result.shown.slice(0, 2), ["This answer (agree) was already given; this call did this much of what was left:", "You agreed. 1 change carried out now."]);
    assert.match(again.result.shown[2], /^Carrying out stopped before the rest started; 1 change still waits\./);
    const done = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "agree" }, "ans-later");
    assert.equal(done.result.shown[0], "This answer (agree) was already given; this call finished what was left:");
  });

  test("a change refused in this call and a failure after it say 'the remaining changes'", () => {
    const lines = ownerAnswerLines("agree", { carriedOut: 0, refused: ["conflict"], alreadyDone: 0, refusedBefore: 0, stillOpen: 1, applying: 0, passFailed: true });
    assert.match(lines[lines.length - 1]!, /^Carrying out the changes failed before any of the remaining changes started; 1 change still waits\./);
    assert.equal(ownerAnswerLines("agree", { carriedOut: 1, refused: [], alreadyDone: 0, refusedBefore: 0, stillOpen: 1, applying: 0, passFailed: true, replayed: true })[0], "This answer (agree) was already given; this call did this much of what was left:");
  });

  suite("the same alternative command ID is the same decision only with the same content: task, category, gate, wording and exact words count; a gate alternative can be retried", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const base = altArgs(ctl, "nightly build", "Use the Red runner", "alt-same");
    ctl.recordCrash.n = 1;
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: base }, "ans-same")).ok, false);
    for (const [what, change] of [["wording", { wording: "Use the Red runner, please" }], ["task", { taskId: d.taskId }], ["case of the words", { statement: "use the red RUNNER" }]] as const) {
      const r = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: { ...base, ...change } }, "ans-same");
      assert.equal(r.ok, false, what);
      assert.equal(r.error.code, "command_conflict", what);
    }
    assert.equal((await ctl.decision(d.id)).ownerResponse, "pending");
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: base }, "ans-same")).ok, true);
    // A gate alternative: its stored topic is the gate topic, and a retry without a topic is the same command.
    const e = await ctl.pending(STAGING, "staging server", "Staging task");
    const gate = { commandId: "alt-gate", projectId: ctl.project, category: "gate", gate: "planning-only", statement: "plan only until June", wording: "plan only until June", source: { channel: "direct" }, basedOn: 0 };
    ctl.recordCrash.n = 1;
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: e.id, response: "alternative", alternative: gate }, "ans-gate")).ok, false);
    // Another kind of gate under the same command ID is another decision.
    const other = await call(w, w.ownerToken, OP, { decisionId: e.id, response: "alternative", alternative: { ...gate, gate: "implementation-hold" } }, "ans-gate");
    assert.equal(other.error.code, "command_conflict");
    const retried = await call(w, w.ownerToken, OP, { decisionId: e.id, response: "alternative", alternative: gate }, "ans-gate");
    assert.equal(retried.ok, true, JSON.stringify(retried));
  });

  suite("an owner decision recorded for an answer that lost the race is told to stand, in the retry and in the call that lost", async (w, script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    // A crash after recording, then a decline wins; the retry is told the decision stands.
    ctl.recordCrash.n = 1;
    const alt = altArgs(ctl, "nightly build", "Keep the nightly build at midnight.", "alt-orph");
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: alt }, "ans-orph")).ok, false);
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: d.id, response: "decline" }, "ans-decline")).ok, true);
    const retry = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: alt }, "ans-orph");
    assert.equal(retry.ok, false);
    assert.match(retry.error.message, /^your decision dec-\S+ on topic "nightly build" was recorded under this command ID and is in force, but this meeting decision no longer waits for an answer \(declined\); your decision is not linked to it; if it should not stand, say what you decide on topic "nightly build" now \(a later decision of yours replaces it\)$/);
    // A decline wins right after the record, in the same call.
    const e = await ctl.pending(STAGING, "staging server", "Staging task");
    ctl.afterRecord.run = async () => { await ctl.records.ownerRespond(w.owner, { commandId: "race-decline", decisionId: e.id, response: "decline" }); };
    const lost = await call(w, w.ownerToken, OP, { decisionId: e.id, response: "alternative", alternative: altArgs(ctl, "staging server", "Keep the staging server until May.", "alt-race") }, "ans-race");
    assert.equal(lost.ok, false);
    assert.match(lost.error.message, /^your decision dec-\S+ on topic "staging server" was recorded under this command ID and is in force, but this meeting decision no longer waits for an answer \(declined\)/);
    // Through chat the owner reads the same words.
    const f = await ctl.pending(REPORT, "nightly report", "Report task");
    const text = "I would rather keep the nightly report weekly until March, not that change.";
    script[text] = [cmd(OP, { response: "alternative", decisionTopic: "report", alternativeStatement: "keep the nightly report weekly until March" }, "keep the nightly report weekly until March")];
    const proposal = only((await say(w, w.chat(), text)).outcomes);
    ctl.afterRecord.run = async () => { await ctl.records.ownerRespond(w.owner, { commandId: "race-decline-2", decisionId: f.id, response: "decline" }); };
    const failed = await w.chat().applyProposal(w.ownerToken, { commandId: "ap-race", proposalId: proposal.proposalId! }).catch((x: unknown) => x);
    assert.match(JSON.stringify(failed), /was recorded under this command ID and is in force, but this meeting decision no longer waits for an answer \(declined\)/);
  });

  suite("the same alternative command ID: padded words, topic, source, category, gate, session and stance are all pinned; a retry with the identical padded words works", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const base = altArgs(ctl, "nightly build", "  use the teal runner  ", "alt-pin");
    ctl.recordCrash.n = 1;
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: base }, "ans-pin")).ok, false);
    const variants: [string, Record<string, unknown>, string][] = [
      ["another topic", { topic: "other topic" }, "command_conflict"],
      ["a chat source", { source: { channel: "chat", turnId: "turn-x" } }, "command_conflict"],
      ["a gate category", { category: "gate", gate: "planning-only" }, "command_conflict"],
      ["a goal category", { category: "goal" }, "command_conflict"],
      ["a permission category", { category: "permission" }, "command_conflict"],
      ["a session", { session: "phone" }, "command_conflict"],
      ["an unknown field", { bogus: 1 }, "invalid_command"],
      ["a basedOn that is not a version", { basedOn: -1 }, "invalid_command"],
      ["a brainstorm", { stance: "brainstorm" }, "invalid_command"],
    ];
    for (const [what, change, code] of variants) {
      const r = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: { ...base, ...change } }, "ans-pin");
      assert.equal(r.ok, false, what);
      assert.equal(r.error.code, code, `${what}: ${JSON.stringify(r.error)}`);
    }
    assert.equal((await ctl.decision(d.id)).ownerResponse, "pending");
    const ok = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: base }, "ans-pin");
    assert.equal(ok.ok, true, JSON.stringify(ok));
  });

  suite("the alternative's command ID used for another meeting decision that no longer waits: the owner is told the decision is recorded and not linked to it", async (w, _script, ctl) => {
    const x = await ctl.pending(STAGING, "staging server", "Staging task");
    const y = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: x.id, response: "agree" }, "ans-x")).ok, true);
    const alt = altArgs(ctl, "nightly build", "Keep the nightly build at midnight.", "alt-y");
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: y.id, response: "alternative", alternative: alt }, "ans-y")).ok, true);
    const r = await call(w, w.ownerToken, OP, { decisionId: x.id, response: "alternative", alternative: alt }, "ans-x2");
    assert.equal(r.ok, false);
    assert.match(r.error.message, /^your decision dec-\S+ on topic "nightly build" was recorded under this command ID and is in force, but this meeting decision no longer waits for an answer \(agreed\); your decision is not linked to it; if it should not stand/);
  });

  suite("the same alternative command ID for another project's meeting decision is a different decision", async (w, _script, ctl) => {
    const other = await w.project("B");
    const a = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    const b = await ctl.pending(REPORT, "nightly report", "Report task", { project: other });
    const alt = altArgs(ctl, "nightly build", "Keep the nightly build at midnight.", "alt-proj");
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: a.id, response: "alternative", alternative: alt }, "ans-proj")).ok, true);
    const r = await call(w, w.ownerToken, OP, { decisionId: b.id, response: "alternative", alternative: { ...alt, projectId: other } }, "ans-proj-b");
    assert.equal(r.ok, false);
    assert.equal(r.error.code, "command_conflict");
  });

  suite("an owner decision that conflicts and is then orphaned is told with the way to settle it", async (w, _script, ctl) => {
    const d = await ctl.pending(NIGHTLY, "nightly build", "Nightly task");
    await w.decisions.record(w.owner, { commandId: cid("later"), projectId: ctl.project, category: "decision", topic: "nightly build", statement: "Retire the nightly build in April", wording: "Retire the nightly build in April", source: { channel: "direct" }, basedOn: 0 } as never);
    const alt = altArgs(ctl, "nightly build", "Keep the nightly build until May.", "alt-disp");
    ctl.recordCrash.n = 1;
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: alt }, "ans-disp")).ok, false);
    assert.equal((await call(w, w.ownerToken, OP, { decisionId: d.id, response: "decline" }, "dec-disp")).ok, true);
    const r = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: alt }, "ans-disp");
    assert.match(r.error.message, /^your decision dec-\S+ on topic "nightly build" was recorded under this command ID and conflicts with another of your instructions, so nothing on that topic is in force until you choose, but this meeting decision no longer waits for an answer \(declined\); your decision is not linked to it; settle that conflict to choose$/);
  });

  test("a nothing-done repeat still tells that the owner's decision conflicts", () => {
    const lines = ownerAnswerLines("alternative", { carriedOut: 0, refused: [], alreadyDone: 0, refusedBefore: 0, stillOpen: 0, applying: 0, replayed: true, ownerDecisionDisputed: true });
    assert.deepEqual(lines, ["This answer (your own decision) was already given; nothing more was done now.", "Your decision is recorded, but it conflicts with another of your instructions on its topic: nothing on that topic is in force until you choose."]);
  });

  // The alternative through the API with random padding, crash, disputes and reuse: whatever happens the decision is recorded once, a retry works, and what is told is true of the record.
  suite("seeded alternatives through the API: padded words, a crash after recording, a conflict, a reuse on another decision", async (w, _script, ctl) => {
    let seed = 7;
    const next = (n: number): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed % n; };
    const months = ["March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
    for (let k = 0; k < 10; k++) {
      const noun = `thing${k} board`;
      const d = await ctl.pending(`Tune the ${noun} schedule.`, noun, `Task ${k}`);
      const pad = k === 4 ? "  " : ["", " ", "  "][next(3)]!;
      let crash = next(2) === 0;
      let dispute = next(3) === 0;
      let reuse = next(3) === 0;
      // Forced so each kind is sampled whatever the sequence gives.
      if (k === 1) { crash = true; dispute = true; }
      if (k === 4) { crash = true; reuse = true; dispute = false; }
      if (k === 6) { dispute = true; crash = false; }
      const statement = `${pad}Keep the ${noun} until ${months[k]}${pad}`;
      const alt = altArgs(ctl, noun, statement, `alt-p${k}`);
      if (dispute) await w.decisions.record(w.owner, { commandId: cid("later"), projectId: ctl.project, category: "decision", topic: noun, statement: `Retire the ${noun} in April`, wording: `Retire the ${noun} in April`, source: { channel: "direct" }, basedOn: 0 } as never);
      const label = JSON.stringify({ k, pad, crash, dispute, reuse });
      if (crash) { ctl.recordCrash.n = 1; assert.equal((await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: alt }, `ans-p${k}`)).ok, false, label); }
      const first = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: alt }, `ans-p${k}`);
      assert.equal(first.ok, true, `${label}: ${JSON.stringify(first)}`);
      assert.equal((await ctl.decision(d.id)).ownerResponse, "alternative", label);
      assert.equal(first.result.ownerDecisionDisputed === true, dispute, label);
      assert.equal(first.result.shown.includes("Your decision is recorded, but it conflicts with another of your instructions on its topic: nothing on that topic is in force until you choose."), dispute, `${label}: ${first.result.shown}`);
      const again = await call(w, w.ownerToken, OP, { decisionId: d.id, response: "alternative", alternative: alt }, `ans-p${k}`);
      assert.equal(again.result.replayed, true, label);
      assert.deepEqual(again.result.shown.slice(0, 1), ["This answer (your own decision) was already given; nothing more was done now."], label);
      assert.equal(again.result.shown.length, dispute ? 2 : 1, `${label}: the repeat tells the conflict too`);
      assert.equal((await w.decisions.history(w.owner, { projectId: ctl.project, topic: noun })).filter((h) => h.statement === statement).length, 1, `${label}: recorded once`);
      if (reuse) {
        const other = await ctl.pending(`Tune the ${noun} again.`, `${noun} again`, `Task ${k} again`);
        assert.equal((await call(w, w.ownerToken, OP, { decisionId: other.id, response: "decline" }, `dec-p${k}`)).ok, true, label);
        const r = await call(w, w.ownerToken, OP, { decisionId: other.id, response: "alternative", alternative: alt }, `ans-p${k}-x`);
        assert.equal(r.ok, false, label);
        assert.match(r.error.message, /was recorded under this command ID and (is in force|conflicts with another of your instructions[^;]*), but this meeting decision no longer waits for an answer \(declined\); your decision is not linked to it/, label);
      }
    }
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
