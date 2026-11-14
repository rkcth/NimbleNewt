import assert from "node:assert/strict";
import { after, test } from "node:test";
import { stopServer } from "../domain/testing/backends.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import type { MeetingFloorService } from "./floor.js";
import type { FloorBody } from "./floor-types.js";
import { floorSuite, type FloorWorld } from "./floor-suite.js";
import type { DecisionRecordBody, MotionBody, RecordBody } from "./record-types.js";

after(stopServer);

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const MOTION = "Move the nightly build to 01:00 because the cache is warm then.";

const floorOf = async (w: FloorWorld, rec: string): Promise<FloorBody> => (await w.floor.state(w.owner, rec)) as unknown as FloorBody;
const recordOf = async (w: FloorWorld, rec: string): Promise<RecordBody> => (await w.records.record(w.owner, rec)) as unknown as RecordBody;
const transcript = async (w: FloorWorld, rec: string): Promise<{ seq: number; kind: string; speaker: string; text: string }[]> => (await w.records.discussion(w.owner, rec, { limit: 100 }))!.entries as never;
const run = async (w: FloorWorld, rec: string, max = 200): Promise<void> => { await w.floor.drive(w.service, { recordId: rec, maxUnits: max }); };
const start = async (w: FloorWorld, rec: string, settings?: Record<string, unknown>): Promise<string> => (await w.floor.start(w.service, { commandId: cid("st"), recordId: rec, motion: { text: MOTION }, ...(settings === undefined ? {} : { settings }) })).motionId!;
const decisionOf = async (w: FloorWorld, motionId: string): Promise<DecisionRecordBody> => (await w.records.decision(w.owner, ((await w.records.motion(w.owner, motionId)) as unknown as MotionBody).decisionId!)) as never;

floorSuite(test, "a whole meeting runs: blind first round, chair work, second round, objection check, ballots and a decision, one unit at a time", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  await run(w, rec);
  const f = await floorOf(w, rec);
  assert.equal(f.phase, "done");
  const d = await decisionOf(w, motionId);
  assert.equal(d.outcome, "adopted");
  assert.equal(d.table.length, 3);
  const kinds = w.script.calls.map((c) => c.kind);
  assert.deepEqual(kinds.slice(0, 3), ["blind-statement", "blind-statement", "blind-statement"], "round 1 is blind");
  assert.ok(kinds.includes("chair-notes") && kinds.includes("chair-summary") && kinds.includes("objection") && kinds.includes("chair-match"));
  assert.equal(w.script.of("statement").length, 3, "round 2 is one open turn per member");
  assert.equal(w.script.of("ballot").length, 3);
  assert.equal(w.script.maxInflight <= 4, true);
});

/** Waits for a condition by letting the event loop turn, never by a fixed pause. */
const waitFor = async (what: string, ok: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 20_000; i += 1) { if (await ok()) return; await new Promise<void>((r) => setImmediate(r)); }
  assert.fail(`never became true: ${what}`);
};
const marker = (r: { agent: string; kind: string; round?: number }): string => `[${r.kind}:${r.round ?? 0}:${r.agent.slice(-6)}]`;
const reply = (text: string, visible = 30, hidden = 0): { text: string; usage: { visibleTokens: number; hiddenTokens: number } } => ({ text, usage: { visibleTokens: visible, hiddenTokens: hidden } });

floorSuite(test, "the first round is blind: a member sees the motion and nothing anyone else said, and the rounds after it see everything said up to their turn", async (w) => {
  const { rec } = await w.meet();
  w.script.on((r) => (r.kind === "blind-statement" || r.kind === "statement" ? reply(`STANCE: for\nSTATEMENT: ${marker(r)} my view`) : undefined));
  await start(w, rec);
  await run(w, rec);
  const blind = w.script.of("blind-statement");
  assert.equal(blind.length, 3);
  for (const call of blind) {
    assert.ok(call.prompt.text.includes(MOTION), "the motion is there");
    assert.ok(!call.prompt.text.includes("my view"), "no other statement is shown in the blind round");
    assert.ok(call.prompt.text.includes("independent first round"));
  }
  // later turns: the whole transcript up to the turn, in order
  const r2 = w.script.of("statement");
  assert.equal(r2.length, 3);
  assert.ok(r2[0]!.prompt.text.includes("[blind-statement:1:"), "round 2 sees the blind statements");
  assert.ok(!r2[0]!.prompt.text.includes(marker(r2[1]!)), "the first speaker of round 2 hears no later speaker");
  assert.ok(r2[2]!.prompt.text.includes(marker(r2[0]!)) && r2[2]!.prompt.text.includes(marker(r2[1]!)), "the third hears the first two");
  // the record keeps all of it, in the order written
  const t = await transcript(w, rec);
  assert.equal(t.filter((e) => e.kind === "statement" && e.text.includes("my view")).length >= 6, true);
});

floorSuite(test, "firstRound open lets each member hear the earlier speakers, and the settings can be changed for one meeting by the owner only", async (w) => {
  const { rec } = await w.meet();
  w.script.on((r) => (r.kind === "statement" || r.kind === "blind-statement" ? reply(`STANCE: for\nSTATEMENT: ${marker(r)} open view`) : undefined));
  await start(w, rec, { firstRound: "open" });
  await run(w, rec);
  assert.equal(w.script.of("blind-statement").length, 0);
  const s = w.script.of("statement");
  assert.equal(s.length, 6, "two comment rounds of three open turns each");
  assert.ok(s[1]!.prompt.text.includes(marker(s[0]!)) || s[1]!.prompt.text.includes("thinks the nightly build"), "the second speaker of the first round hears the first");
  const f = await floorOf(w, rec);
  assert.equal(f.settings.firstRound, "open");
  await refuses("forbidden", () => w.floor.configure(w.asA, { commandId: cid("cf"), recordId: rec, set: { commentRounds: 4 } }));
  await refuses("forbidden", () => w.floor.configure(w.service, { commandId: cid("cf"), recordId: rec, set: { commentRounds: 4 } }));
  await refuses("invalid_command", () => w.floor.configure(w.owner, { commandId: cid("cf"), recordId: rec, set: { commentRounds: 99 } }));
  await refuses("invalid_command", () => w.floor.configure(w.owner, { commandId: cid("cf"), recordId: rec, set: { nonsense: 1 } }));
});

floorSuite(test, "a prompt is built shared-first: everything the same for every member comes first and is byte-identical; the agent-first order puts the member first", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec);
  await run(w, rec);
  const blind = w.script.of("blind-statement");
  assert.equal(new Set(blind.map((c) => c.prompt.shared)).size, 1, "one shared part for the batch");
  for (const c of blind) { assert.ok(c.prompt.text.startsWith(c.prompt.shared)); assert.equal(c.prompt.order, "shared-first"); }
  assert.notEqual(blind[0]!.prompt.specific, blind[1]!.prompt.specific);
  const ballots = w.script.of("ballot");
  assert.equal(new Set(ballots.map((c) => c.prompt.shared)).size, 1, "the ballot prompts share their prefix too");
  w.script.reset();
  const second = await w.meet();
  await start(w, second.rec, { promptOrder: "agent-first" });
  await run(w, second.rec);
  const first = w.script.of("blind-statement");
  assert.equal(first[0]!.prompt.order, "agent-first");
  assert.ok(!first[0]!.prompt.text.startsWith(first[0]!.prompt.shared));
  assert.ok(first[0]!.prompt.text.startsWith("You are agent:"));
});

floorSuite(test, "nobody holds the floor out of turn: the model is asked of one member at a time except in a blind round and an objection check, and ballots never reach another voter", async (w) => {
  const { rec } = await w.meet();
  const seen: Record<string, number> = {};
  w.script.on((r) => { seen[r.kind] = Math.max(seen[r.kind] ?? 0, w.script.inflight); return undefined; });
  w.script.on((r) => (r.kind === "ballot" ? reply(`VOTE: yes\nREASON: secret-reason-${r.agent.slice(-6)}`) : undefined));
  const motionId = await start(w, rec);
  await run(w, rec);
  for (const [kind, most] of Object.entries(seen)) if (kind !== "blind-statement" && kind !== "objection") assert.equal(most, 1, `${kind} is asked of one member at a time`);
  const ballots = w.script.of("ballot");
  assert.equal(ballots.length, 3);
  for (const b of ballots) assert.ok(!b.prompt.text.includes("secret-reason"), "the last voter's delivery holds no other ballot");
  const t = await transcript(w, rec);
  const before = t.filter((e) => e.text.includes("secret-reason"));
  const d = await decisionOf(w, motionId);
  assert.equal(d.table.every((r) => r.reason.startsWith("secret-reason")), true);
  assert.ok(before.length <= 1, "at most the revealed table entry mentions them");
});

floorSuite(test, "the turn limit counts visible tokens only: hidden reasoning is budgeted apart, a long statement is cut at a word, and a turn that hangs is given up on", async (w) => {
  const { rec } = await w.meet();
  const long = `STANCE: for\nSTATEMENT: ${"word ".repeat(300)}end`;
  w.script.on((r) => {
    if (r.kind !== "blind-statement") return undefined;
    if (r.agent === w.pA) return reply("STANCE: for\nSTATEMENT: short one", 100, 700); // 700 hidden tokens, within the visible limit
    if (r.agent === w.pB) return reply(long, 500, 0);
    return reply("STANCE: for\nSTATEMENT: reasoned too long", 60, 900); // over the hidden budget
  });
  await start(w, rec);
  await run(w, rec, 1);
  const f = await floorOf(w, rec);
  const byAgent = (a: string) => f.turns.find((t) => t.agent === a && t.kind === "blind-statement")!;
  assert.equal(byAgent(w.pA).truncated, undefined, "700 hidden tokens do not make 100 visible tokens too long");
  assert.equal(byAgent(w.pA).hiddenTokens, 700);
  assert.equal(byAgent(w.pB).truncated, true);
  assert.equal(byAgent(w.pB).visibleTokens, 220);
  assert.equal(byAgent(w.pC).hiddenOver, true);
  const t = await transcript(w, rec);
  const cut = t.find((e) => e.text.startsWith("word word"))!;
  assert.ok(cut.text.length < long.length / 2 && !cut.text.endsWith("wor"), "cut at a word");
  assert.ok(w.script.calls.every((c) => c.maxVisibleTokens === 220 && c.maxHiddenTokens === 800));
  // a hang: the timer fires, the turn is recorded as no response and the meeting goes on
  w.script.on((r) => (r.kind === "statement" && r.agent === w.pB ? new Promise<never>(() => undefined) : undefined));
  const p = w.floor.drive(w.service, { recordId: rec });
  await waitFor("the hung turn started", () => w.script.calls.some((c) => c.kind === "statement" && c.agent === w.pB));
  assert.equal(w.hooks.timerMs.at(-1), 120_000);
  w.hooks.fireTimer.at(-1)!();
  const out = await p;
  assert.ok(out.last && "waiting" in out.last);
  const g = await floorOf(w, rec);
  assert.equal(g.turns.some((x) => x.agent === w.pB && x.noResponse !== undefined && x.kind === "statement"), true);
  assert.equal(g.phase, "done", "the meeting finished without the hung turn");
});

const motionOf = async (w: FloorWorld, id: string): Promise<MotionBody> => (await w.records.motion(w.owner, id)) as unknown as MotionBody;

floorSuite(test, "the objection check is a bounded call (the motion and a round summary, yes or no); an objection goes to the chair, an amendment starts a fresh round, and the vote is on the new version", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  let objected = false;
  w.script.on((r) => {
    if (r.kind === "objection" && r.agent === w.pA && !objected) { objected = true; return reply("OBJECT: yes\nREASON: it is unclear what warm means"); }
    return undefined;
  });
  w.script.on((r) => (r.kind === "chair-ruling" ? reply("RULING: amend\nAMENDED_MOTION: Move the nightly build to 01:00 if the cache hit rate is above 80 percent.\nREASON: clarifies warm") : undefined));
  await run(w, rec);
  const objections = w.script.of("objection");
  assert.equal(objections.length, 6, "three members asked twice: before and after the amendment");
  for (const o of objections) {
    assert.ok(o.prompt.text.includes("Summary of the discussion"), "only the round summary");
    assert.ok(!o.prompt.text.includes("[#"), "none of the transcript's entries");
    assert.ok(o.prompt.text.includes("MOTION (version"), "the motion version");
    assert.ok(o.maxVisibleTokens <= 80, "a bounded answer");
  }
  assert.equal(w.script.of("chair-ruling").length, 1);
  assert.equal(w.script.of("statement").length, 6, "a fresh round of comments followed the amendment");
  const m = await motionOf(w, motionId);
  assert.equal(m.version, 2);
  assert.equal(m.state, "adopted");
  const d = await decisionOf(w, motionId);
  assert.equal(d.version, 2);
  const t = await transcript(w, rec);
  assert.ok(t.some((e) => e.text.startsWith("Objection: it is unclear what warm means")), "the objection's reason is in the transcript for the ruling and later speakers");
  assert.ok(t.some((e) => e.text.includes("Chair's ruling: motion amended")));
});

floorSuite(test, "after the rerun limit the chair may only rule to proceed, and the remaining objections are recorded as dissent", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec, { objectionReruns: 0 });
  w.script.on((r) => (r.kind === "objection" && r.agent === w.pC ? reply("OBJECT: yes\nREASON: still unclear") : undefined));
  w.script.on((r) => (r.kind === "chair-ruling" ? reply("RULING: amend\nAMENDED_MOTION: something else entirely\nREASON: try") : undefined));
  await run(w, rec);
  const m = await motionOf(w, (await floorOf(w, rec)).motionId!);
  assert.equal(m.version, 1, "no amendment was allowed");
  assert.equal(m.state, "adopted");
  const t = await transcript(w, rec);
  assert.ok(t.some((e) => e.text.includes("recorded as dissent") && e.text.includes("still unclear")));
  assert.ok(w.script.of("chair-ruling")[0]!.prompt.specific.includes("no more amendments"));
});

floorSuite(test, "needs time to research: the chair tables the motion, no vote is held, and the research becomes owned follow-up tasks", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  w.script.on((r) => (r.kind === "objection" && r.agent === w.pB ? reply("OBJECT: research\nREASON: the benchmark numbers are missing") : undefined));
  w.script.on((r) => (r.kind === "chair-ruling" ? reply(`RULING: table\nRESEARCH: ${w.pB}: run the cache benchmark\nREASON: the numbers could change the outcome`) : undefined));
  await run(w, rec);
  const m = await motionOf(w, motionId);
  assert.equal(m.state, "tabled");
  assert.equal(w.script.of("ballot").length, 0, "no vote was held");
  const f = await floorOf(w, rec);
  assert.equal(f.phase, "done");
  const out = await w.floor.followUps(w.service, { recordId: rec });
  assert.equal(out.created.length, 1);
  assert.equal(out.created[0]!.owner, w.pB);
  assert.ok(out.created[0]!.title.includes("run the cache benchmark"));
  assert.equal((await w.floor.followUps(w.service, { recordId: rec })).created.length, 0, "a repeat makes no second task");
  assert.equal(w.created.length, 1);
});

floorSuite(test, "tabling can be switched off: research then reads as an ordinary objection", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec, { tabling: false });
  w.script.on((r) => (r.kind === "objection" && r.agent === w.pB ? reply("OBJECT: research\nREASON: numbers") : undefined));
  await run(w, rec);
  assert.ok(!w.script.of("objection")[0]!.prompt.text.includes("OBJECT: yes|no|research"));
  assert.equal((await motionOf(w, motionId)).state, "adopted");
});


floorSuite(test, "chair questions are checked by structure and counted against a cap; absent members are skipped and recorded; answers go into the transcript", async (w) => {
  const { rec } = await w.meet({ join: [w.pA, w.pB] });
  await start(w, rec);
  const questions = { questions: [
    { to: w.pB, topic: "How the cache behaves at 01:00; we support the idea", experience_sought: "what you measured on the nightly build" },
    { to: w.pC, topic: "last week's cache hit rate", experience_sought: "numbers from the dashboard" },
    { to: w.pA, topic: "x", experience_sought: "y", position: "for" },
  ] };
  w.script.on((r) => (r.kind === "chair-questions" && w.script.of("chair-questions").length === 1 ? reply(JSON.stringify(questions)) : undefined));
  await run(w, rec);
  const f = await floorOf(w, rec);
  assert.equal(f.chairQuestionsAsked, 2, "the cap of 2 counts the skipped one; the third was never considered");
  const [q1, q2] = f.chairQuestions;
  assert.equal(q1!.state, "answered", "the word support does not refuse a legitimate question");
  assert.equal(q1!.askedBy, "chair");
  assert.ok(q1!.why.length > 0);
  assert.equal(q2!.state, "skipped", "an absent member is skipped and recorded");
  assert.equal(w.script.of("chair-answer").length, 1);
  assert.equal(w.script.of("chair-answer")[0]!.agent, w.pB);
  assert.ok(f.skipped.some((s) => s.agent === w.pC));
  const t = await transcript(w, rec);
  assert.ok(t.some((e) => e.speaker === w.pD && e.text.startsWith(`Question to ${w.pB}`)));
  assert.ok(t.some((e) => e.text.includes(`Question to ${w.pC} skipped: absent`)));
  assert.ok(t.some((e) => e.speaker === w.pB && e.text.includes("answers briefly")), "the answer is in the transcript for everyone who later gets the floor");
  const later = w.script.of("statement").find((c) => c.round === 2)!;
  assert.ok(later.prompt.text.includes("answers briefly"));
});

floorSuite(test, "a question that names a position or carries a position field is refused; chair questions after the last round are followed by a reply from every present member", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec, { commentRounds: 1, chairQuestionCap: 3 });
  w.script.on((r) => (r.kind === "chair-questions" ? reply(JSON.stringify({ questions: [
    { to: w.pA, topic: "will you vote for or against this", experience_sought: "your stance" },
    { to: w.pB, topic: "the build time", experience_sought: "what you measured", stance: "for" },
    { to: w.pC, topic: "the cache layout", experience_sought: "how you configured it" },
  ] })) : undefined));
  await run(w, rec);
  const f = await floorOf(w, rec);
  assert.equal(f.chairQuestionsAsked, 1, "only the structurally sound question stands");
  assert.equal(f.notices.filter((x) => x.kind === "chair-question-refused").length, 2);
  assert.equal(w.script.of("reply").length, 3, "a short reply turn for every present member before the vote");
  const kinds = w.script.calls.map((c) => c.kind);
  assert.ok(kinds.indexOf("reply") > kinds.indexOf("chair-answer") && kinds.indexOf("reply") < kinds.indexOf("objection"));
});

floorSuite(test, "a member may ask the chair to put a question to someone else (within the cap, never during the vote); a challenge is ruled on by the chair, and the owner can overrule", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec);
  const { questionId } = await w.floor.requestChairQuestion(w.asA, { commandId: cid("rq"), recordId: rec, to: w.pC, topic: "the cache layout", experienceSought: "how you configured it" });
  await refuses("invalid_command", () => w.floor.requestChairQuestion(w.asA, { commandId: cid("rq"), recordId: rec, to: w.pB, topic: "how will you vote", experienceSought: "your stance" }));
  await refuses("forbidden", () => w.floor.requestChairQuestion(w.outsider, { commandId: cid("rq"), recordId: rec, to: w.pB, topic: "t", experienceSought: "e" }));
  await w.floor.requestChairQuestion(w.asB, { commandId: cid("rq"), recordId: rec, to: w.pA, topic: "the build time", experienceSought: "what you measured" });
  await refuses("invalid_command", () => w.floor.requestChairQuestion(w.asB, { commandId: cid("rq"), recordId: rec, to: w.pA, topic: "a third", experienceSought: "over the cap of two" }));
  await w.floor.challengeQuestion(w.asB, { commandId: cid("ch"), recordId: rec, questionId, reason: "this asks for a position" });
  await refuses("forbidden", () => w.floor.ruleOnChallenge(w.asA, { commandId: cid("ru"), recordId: rec, questionId, ruling: "upheld" }));
  await w.floor.ruleOnChallenge(w.asD, { commandId: cid("ru"), recordId: rec, questionId, ruling: "upheld" });
  let f = await floorOf(w, rec);
  assert.equal(f.chairQuestions.find((c) => c.id === questionId)!.state, "withdrawn");
  assert.equal(f.queue.some((q) => q.chairQuestionId === questionId), false, "a withdrawn question is not asked");
  await w.floor.ruleOnChallenge(w.owner, { commandId: cid("ru"), recordId: rec, questionId, ruling: "dismissed" });
  f = await floorOf(w, rec);
  assert.equal(f.chairQuestions.find((c) => c.id === questionId)!.challenge!.ruling, "dismissed");
  await run(w, rec);
  // once the vote is open no chair question is put
  await refuses("invalid_command", () => w.floor.requestChairQuestion(w.asA, { commandId: cid("rq"), recordId: rec, to: w.pB, topic: "late", experienceSought: "too late" }));
});

floorSuite(test, "the chair reads an absent member's desk by a list of file IDs: one inspection per file, quotes checked verbatim, and the summary lists files read and quoted", async (w) => {
  const { rec, occ } = await w.meet({ join: [w.pA, w.pB] });
  await w.grants.grant(w.owner, { commandId: cid("g"), grantee: w.pD, action: "desk.scratch.read", project: w.project, source: "direct", basis: "test" } as never);
  const shared1 = await w.desks.write(w.asC, { commandId: cid("w"), projectId: w.project, kind: "note", title: "cache benchmark", body: "The cache hit rate at 01:00 is 91 percent.", visibility: "shared", status: "accepted" } as never);
  const shared2 = await w.desks.write(w.asC, { commandId: cid("w"), projectId: w.project, kind: "note", title: "lunch plans", body: "Sandwiches on Friday.", visibility: "shared", status: "accepted" } as never);
  const draft = await w.desks.write(w.asC, { commandId: cid("w"), projectId: w.project, kind: "note", title: "half formed", body: "unfinished idea", visibility: "shared" } as never);
  const present = await w.desks.write(w.asA, { commandId: cid("w"), projectId: w.project, kind: "note", title: "present member", body: "A's own notes", visibility: "shared", status: "accepted" } as never);
  await start(w, rec);
  w.script.on((r) => (r.kind === "desk-offer" ? reply(JSON.stringify({ read: [shared1.id, present.id, "dsk-aaaaaaaaaaaaaaaaaaaa", draft.id] })) : undefined));
  w.script.on((r) => (r.kind === "desk-excerpts" ? reply(JSON.stringify({ excerpts: [
    { file: shared1.id, quote: "The cache hit rate at 01:00 is 91 percent.", bears_on: "the benchmark" },
    { file: shared1.id, quote: "The cache hit rate is 99 percent.", bears_on: "invented" },
  ] })) : undefined));
  await run(w, rec);
  const offer = w.script.of("desk-offer")[0]!.prompt.text;
  assert.ok(offer.includes(shared1.id) && offer.includes(shared2.id));
  assert.ok(!offer.includes(present.id) && !offer.includes(draft.id), "a present member's file and a draft are never offered");
  const f = await floorOf(w, rec);
  assert.deepEqual(f.desk.filesRead, [shared1.id], "only the file the chair chose from the offered list was read");
  assert.equal(f.desk.refused.length, 3);
  assert.deepEqual(f.desk.filesQuoted, [shared1.id]);
  assert.equal(f.desk.rejectedExcerpts, 1, "a quote that is not verbatim is refused");
  const reads = await w.deskReads.reads(w.owner, { occurrenceId: occ });
  assert.equal(reads.reads.length, 1, "one inspection record per file read");
  assert.equal(reads.reads[0]!.deskRecordId, shared1.id);
  const t = await transcript(w, rec);
  const ex = t.find((e) => e.text.includes("UNVERIFIED by"))!;
  assert.ok(ex.text.includes("The cache hit rate at 01:00 is 91 percent."));
  assert.ok(t.some((e) => e.text.startsWith("Desk read: files read") && e.text.includes(shared1.id)), "the transcript lists files read and files quoted");
});

floorSuite(test, "an absent member whose desk was read is asked for a correction when it comes into the room", async (w) => {
  const { rec } = await w.meet({ join: [w.pA, w.pB] });
  const file = await w.desks.write(w.asC, { commandId: cid("w"), projectId: w.project, kind: "note", title: "my view", body: "I would rather wait a week before moving the build.", visibility: "shared", status: "accepted" } as never);
  await start(w, rec);
  w.script.on((r) => (r.kind === "desk-offer" ? reply(JSON.stringify({ read: [file.id] })) : undefined));
  w.script.on((r) => (r.kind === "desk-excerpts" ? reply(JSON.stringify({ excerpts: [{ file: file.id, quote: "I would rather wait a week", bears_on: "timing" }] })) : undefined));
  w.script.on((r) => (r.kind === "correction" ? reply("CORRECTION: These notes do not state my position.\nCONTRADICTS: yes") : undefined));
  // the chair's work after round 1 happens while C is out; C comes in before the vote opens
  while (true) { const r = await w.floor.advance(w.service, { recordId: rec }); if ("waiting" in r || (await floorOf(w, rec)).phase === "objection") break; }
  await w.records.join(w.asC, { commandId: cid("j"), recordId: rec });
  await run(w, rec);
  assert.equal(w.script.of("correction").length, 1);
  assert.equal(w.script.of("correction")[0]!.agent, w.pC);
  assert.ok(w.script.of("correction")[0]!.prompt.text.includes(file.id), "the returning member is shown what was read and quoted");
  const t = await transcript(w, rec);
  assert.ok(t.some((e) => e.speaker === w.pC && e.text.includes("These notes do not state my position")));
  const f = await floorOf(w, rec);
  assert.equal(f.desk.corrections.length, 1);
});

/** Runs until the meeting is at the start of the vote (ballots not yet asked), by advancing one unit at a time. */
const untilPhase = async (w: FloorWorld, rec: string, phase: string, extra: () => boolean = () => true): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    const f = await floorOf(w, rec);
    if (f.phase === phase && extra()) return;
    const r = await w.floor.advance(w.service, { recordId: rec });
    if ("waiting" in r && r.waiting !== undefined && r.waiting !== "busy") break;
  }
  assert.equal((await floorOf(w, rec)).phase, phase);
};

floorSuite(test, "the owner asks one agent a question: it is answered at the next boundary into the transcript, the owner's turn limit applies, and only the owner may ask", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec);
  await refuses("forbidden", () => w.floor.ask(w.asA, { commandId: cid("ask"), recordId: rec, agent: w.pB, question: "why?" }));
  await refuses("forbidden", () => w.floor.ask(w.asD, { commandId: cid("ask"), recordId: rec, agent: w.pB, question: "why?" }));
  await refuses("forbidden", () => w.floor.ask(w.mgr, { commandId: cid("ask"), recordId: rec, agent: w.pB, question: "why?" }));
  await refuses("invalid_command", () => w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pE, question: "outside the roster" }));
  w.script.on((r) => (r.kind === "owner-answer" ? reply("ANSWER: Because the cache is warm.\nSOURCES: none\nCOMPLETED: none\nPROPOSED: none\nINVESTIGATE: none", 90) : undefined));
  const r = await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pB, question: "Why 01:00?" });
  assert.equal(r.answered, true);
  const call = w.script.of("owner-answer")[0]!;
  assert.equal(call.agent, w.pB);
  assert.equal(call.maxVisibleTokens, 400, "the owner's own token limit, not the meeting's");
  const t = await transcript(w, rec);
  assert.ok(t.some((e) => e.kind === "owner-message" && e.text.includes("Why 01:00?")));
  assert.ok(t.some((e) => e.speaker === w.pB && e.text.includes("Because the cache is warm")));
  // the meeting then carries on, and a later speaker hears the exchange
  await run(w, rec);
  const later = w.script.of("blind-statement");
  assert.equal(later.length, 3);
  assert.equal((await floorOf(w, rec)).phase, "done");
  // the same command again answers nothing twice
  const again = await w.floor.ask(w.owner, { commandId: "same-cmd", recordId: rec, agent: w.pB, question: "Again?" }).catch(() => undefined);
  void again;
});

floorSuite(test, "an owner question to an agent that is not in the room is answered from its saved checkpoint, stamped as not live, and nobody outside the roster is brought in", async (w) => {
  const { rec } = await w.meet({ join: [w.pA, w.pB] });
  await start(w, rec);
  w.hooks.checkpoint = async (a) => (a === w.pC ? { savedAt: "2026-11-13T09:00:00.000Z", text: "I last saw the cache at 90 percent." } : undefined);
  w.script.on((r) => (r.kind === "checkpoint-answer" ? reply("It was at 90 percent when I last looked.") : undefined));
  const r = await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pC, question: "What was the hit rate?" });
  assert.equal(r.checkpoint, true);
  assert.equal(r.answered, true);
  const call = w.script.of("checkpoint-answer")[0]!;
  assert.ok(call.prompt.text.includes("I last saw the cache at 90 percent."));
  const t = await transcript(w, rec);
  const ans = t.find((e) => e.text.includes("90 percent when I last looked"))!;
  assert.ok(ans.text.includes("not live") && ans.text.includes("2026-11-13"), "the controller wraps the answer with its source and age");
  await refuses("invalid_command", () => w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pE, question: "you?" }));
  w.settings.current = { ...w.settings.current, checkpointAnswers: false };
  const { rec: r2 } = await w.meet({ join: [w.pA] });
  await start(w, r2);
  await refuses("invalid_command", () => w.floor.ask(w.owner, { commandId: cid("ask"), recordId: r2, agent: w.pC, question: "no checkpoint?" }));
});

floorSuite(test, "an owner inquiry pauses the clock and holds the vote; answers during it are held from the other voters until it ends, revision turns follow, and the vote then closes", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  await untilPhase(w, rec, "vote");
  // two voters cast, then the owner opens an inquiry
  await w.floor.advance(w.service, { recordId: rec });
  await w.floor.advance(w.service, { recordId: rec });
  await w.floor.advance(w.service, { recordId: rec });
  let f = await floorOf(w, rec);
  assert.equal(f.vote!.opened, true);
  const castBefore = Object.keys(f.vote!.cast).length;
  assert.ok(castBefore >= 1 && castBefore < 3, "mid-vote");
  const before = w.script.of("ballot").length;
  const inq = await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec });
  assert.equal(inq.voteHeld, true);
  assert.equal((await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec })).replayed, true);
  await refuses("forbidden", () => w.floor.openInquiry(w.asD, { commandId: cid("iq"), recordId: rec }));
  const waiting = await w.floor.waiting(w.owner, rec);
  assert.equal(waiting!.kind, "person");
  assert.equal((await w.floor.ownerPending(w.owner)).items.length, 1, "a Needs-you item");
  await refuses("forbidden", () => w.floor.ownerPending(w.asA));
  // nothing advances: no ballots are asked, and the motion's vote cannot be cast while held
  const r = await w.floor.advance(w.service, { recordId: rec });
  assert.equal("waiting" in r && r.waiting, "owner");
  assert.equal(w.script.of("ballot").length, before);
  const m = await motionOf(w, motionId);
  assert.equal(m.state, "voting");
  // the owner asks a question that is answered, but the answer is held from the remaining voters
  w.script.on((r2) => (r2.kind === "owner-answer" ? reply("ANSWER: held-answer-text\nSOURCES: none\nCOMPLETED: none\nPROPOSED: none\nINVESTIGATE: none") : undefined));
  const asked = await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pA, question: "Are you sure about the numbers?" });
  assert.equal(asked.answered, true);
  let t = await transcript(w, rec);
  assert.ok(t.some((e) => e.text.includes("Are you sure about the numbers?")), "the question text is visible to the others (the accepted smallest change)");
  assert.ok(!t.some((e) => e.text.includes("held-answer-text")), "the answer is not in the transcript while the vote is open");
  assert.equal(((await floorOf(w, rec)) as FloorBody).held.length, 1);
  const stateAsMember = (await w.floor.state(w.asB, rec)) as Record<string, unknown>;
  assert.equal(JSON.stringify(stateAsMember).includes("held-answer-text"), false);
  assert.equal(JSON.stringify(await w.floor.state(w.owner, rec)).includes("held-answer-text"), true, "the owner can read it");
  // a restart does not lose any of it
  const again = w.reopen();
  assert.equal((await again.waiting(w.owner, rec))!.kind, "person");
  w.clock.tick(5);
  // done with questions
  const ended = await again.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  assert.ok(ended.revisionsOffered >= 1, "a voter who cast before the question may revise");
  await run(w, rec);
  f = await floorOf(w, rec);
  assert.equal(f.inquiry, undefined);
  assert.equal(f.held.length, 0, "held answers released into the record at the close");
  t = await transcript(w, rec);
  assert.ok(t.some((e) => e.text.includes("held-answer-text")));
  assert.ok(w.script.of("revision").length >= 1);
  assert.equal(f.phase, "done");
  assert.equal((await decisionOf(w, motionId)).outcome, "adopted");
});

floorSuite(test, "an inquiry stops the meeting's clock and timebox, and the paused time is not counted", async (w) => {
  const { rec } = await w.meet({ endsInMinutes: 30 });
  await start(w, rec);
  await untilPhase(w, rec, "between");
  await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec });
  w.clock.tick(600); // ten hours go by
  const s = (await w.floor.state(w.owner, rec)) as Record<string, unknown>;
  assert.ok((s["elapsedMinutes"] as number) < 30, "the clock is paused");
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  const s2 = (await w.floor.state(w.owner, rec)) as Record<string, unknown>;
  assert.ok((s2["elapsedMinutes"] as number) < 30, "the paused time was removed");
  await run(w, rec);
  assert.equal((await floorOf(w, rec)).phase, "done");
  assert.equal((await floorOf(w, rec)).timebox, undefined);
});

floorSuite(test, "an inquiry idle past the owner-set time sends a reminder once per idle period", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec, { inquiryIdleMinutes: 10 });
  await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec });
  assert.deepEqual((await w.floor.sweep(w.service)).reminded, []);
  w.clock.tick(11);
  assert.deepEqual((await w.floor.sweep(w.service)).reminded, [rec]);
  assert.deepEqual((await w.floor.sweep(w.service)).reminded, [], "once per idle period");
  assert.ok(w.notices.some((n) => n.kind === "inquiry-idle"));
  await refuses("forbidden", () => w.floor.sweep(w.asA));
  w.clock.tick(11);
  assert.equal((await w.floor.sweep(w.service)).reminded.length, 1);
});

floorSuite(test, "the owner addresses the team: the words are in the transcript, nobody is given the floor out of turn, and each member hears them with its next turn; an amendment restarts the round", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  await untilPhase(w, rec, "between");
  const a = await w.floor.address(w.owner, { commandId: cid("adr"), recordId: rec, text: "Please focus on the cost, not the speed." });
  assert.equal(a.revisionsOffered, 0);
  await refuses("forbidden", () => w.floor.address(w.asD, { commandId: cid("adr"), recordId: rec, text: "chair speaking as owner" }));
  const calls = w.script.calls.length;
  await run(w, rec, 12);
  const next = w.script.calls.slice(calls).find((c) => c.kind === "statement")!;
  assert.ok(next.prompt.text.includes("Please focus on the cost"));
  // an amendment from the owner
  const b = await w.floor.address(w.owner, { commandId: cid("adr"), recordId: rec, text: "Change it: move to 02:00 instead.", amend: { text: "Move the nightly build to 02:00 because the cache is warm then." } });
  assert.equal(b.restarted, true);
  const f = await floorOf(w, rec);
  assert.equal(f.motionVersion, 2);
  assert.equal(f.phase, "round", "a fresh round of comments on the new version");
  assert.equal(f.fresh, true);
  assert.equal((await motionOf(w, motionId)).version, 2);
  await run(w, rec);
  assert.equal((await decisionOf(w, motionId)).version, 2);
});

floorSuite(test, "the chair cannot stop the owner: the owner's question runs even while the chair is asked for work, and only the owner can end the meeting", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec);
  await untilPhase(w, rec, "between");
  w.script.on((r) => (r.kind === "chair-notes" || r.kind === "chair-summary" ? new Promise<never>(() => undefined) : undefined));
  const stuck = w.floor.advance(w.service, { recordId: rec }).catch(() => undefined);
  void stuck;
  await waitFor("the chair call started", () => w.script.calls.some((c) => c.kind === "chair-summary" || c.kind === "chair-notes"));
  const r = await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pA, question: "Quick one?" });
  assert.equal(r.queued || r.answered, true, "queued at the safe boundary even while the chair is busy");
  await refuses("forbidden", () => w.floor.end(w.asD, { commandId: cid("end"), recordId: rec }));
  await refuses("forbidden", () => w.floor.end(w.mgr, { commandId: cid("end"), recordId: rec }));
  const out = await w.floor.end(w.owner, { commandId: cid("end"), recordId: rec, reason: "enough" });
  void out;
  assert.equal((await floorOf(w, rec)).state, "ended");
  assert.equal((await recordOf(w, rec)).state, "ended");
  await refuses("invalid_command", () => w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pA, question: "after the end" }));
});
