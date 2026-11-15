import assert from "node:assert/strict";
import { after, test } from "node:test";
import { stopServer } from "../domain/testing/backends.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { proposalReason } from "../chat/commands.js";
import type { FloorBody } from "./floor-types.js";
import { floorSuite, type FloorWorld } from "./floor-suite.js";
import { FLOOR_DEFAULTS, floorSettingsFromInstallation } from "./floor-settings.js";
import { MeetingProcedureService } from "./procedure.js";
import type { MotionBody } from "./record-types.js";

// Review of card M05 against the meeting procedure of card M06: the two never drive one motion, the floor's owner controls work on a vote the procedure runs, and nobody but the owner learns who has voted.

after(stopServer);

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, message?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof DomainError, String(error));
    assert.equal(error.code, code, error.message);
    if (message !== undefined) assert.match(error.message, message);
    return true;
  });
};
let n = 0;
const cid = (label: string): string => `${label}-r${n++}`;
const MOTION = "Move the nightly build to 01:00 because the cache is warm then.";
const floorOf = async (w: FloorWorld, rec: string): Promise<FloorBody> => (await w.floor.state(w.owner, rec)) as unknown as FloorBody;
const motionOf = async (w: FloorWorld, id: string): Promise<MotionBody> => (await w.records.motion(w.owner, id)) as unknown as MotionBody;
const transcript = async (w: FloorWorld, rec: string): Promise<{ text: string }[]> => (await w.records.discussion(w.owner, rec, { limit: 100 }))!.entries as never;
const start = async (w: FloorWorld, rec: string): Promise<string> => (await w.floor.start(w.service, { commandId: cid("st"), recordId: rec, motion: { text: MOTION } })).motionId!;
const untilVoteOpen = async (w: FloorWorld, rec: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if ((await floorOf(w, rec)).vote?.opened === true) return;
    await w.floor.advance(w.service, { recordId: rec });
  }
  assert.fail("the vote never opened");
};
/** Waits for a condition by letting the event loop turn, never by a fixed pause. */
const waitFor = async (what: string, ok: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 20_000; i += 1) { if (await ok()) return; await new Promise<void>((r) => setImmediate(r)); }
  assert.fail(`never became true: ${what}`);
};

floorSuite(test, "the chair, a manager agent and a member see only what a member sees while a vote is open: not who has voted, not whose ballot is next", async (w) => {
  // the chair is a voter here
  const { rec } = await w.meet({ roster: [w.pA, w.pB, w.pC], chair: w.pA });
  await start(w, rec);
  await untilVoteOpen(w, rec);
  const first = await w.floor.advance(w.mgr, { recordId: rec });
  assert.equal("did" in first && first.did, "ballot");
  assert.equal("agent" in first, false, "a manager agent that runs the meeting is not told whose ballot was taken");
  const owner = await floorOf(w, rec);
  assert.equal(Object.keys(owner.vote!.cast).length, 1, "the owner sees the record of the vote");
  for (const viewer of [w.asA, w.asB, w.mgr]) {
    const seen = JSON.stringify(await w.floor.state(viewer, rec));
    assert.equal(seen.includes("\"cast\""), false, `${viewer.id} is not shown who has voted`);
    assert.equal(seen.includes("\"turns\""), false, `${viewer.id} is not shown the turn log`);
    assert.equal(seen.includes("\"ballot\""), false, `${viewer.id} is not shown whose ballot is being asked`);
    const waiting = await w.floor.waiting(viewer, rec);
    assert.deepEqual([waiting!.kind, (waiting as { who?: string }).who], ["agent", "the voters"]);
  }
  const next = ((await w.floor.waiting(w.owner, rec)) as { who?: string }).who;
  assert.ok(next !== undefined && [w.pA, w.pB, w.pC].includes(next) && !Object.keys(owner.vote!.cast).includes(next), "the owner sees whose ballot is next");
});

floorSuite(test, "an inquiry opened while a ballot is being answered holds the vote: the ballot is set aside, the owner's questions run, and the voter is asked again when the vote resumes", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  await untilVoteOpen(w, rec);
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let gated = false;
  w.script.on(async (r) => {
    if (r.kind !== "ballot" || gated) return undefined;
    gated = true;
    await gate;
    return { text: "VOTE: yes\nREASON: formed before the inquiry.", usage: { visibleTokens: 10, hiddenTokens: 0 } };
  });
  const pending = w.floor.advance(w.service, { recordId: rec });
  await waitFor("the first ballot is being asked", () => w.script.of("ballot").length === 1);
  const voter = w.script.of("ballot")[0]!.agent;
  assert.equal((await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec })).voteHeld, true);
  release();
  const r = await pending;
  assert.equal("waiting" in r && r.waiting, "owner", "the ballot answered after the hold is not cast");
  assert.equal(Object.keys((await floorOf(w, rec)).vote!.cast).length, 0);
  assert.ok((await floorOf(w, rec)).turns.some((t) => t.kind === "ballot" && t.agent === voter), "the set-aside call is still counted");
  const asked = await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pB, question: "What did the last run cost?" });
  assert.equal(asked.answered, true, "the owner's question is not blocked by the set-aside ballot");
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  await w.floor.drive(w.service, { recordId: rec });
  assert.equal(w.script.of("ballot").filter((c) => c.agent === voter).length, 2, "the voter is asked again after the inquiry");
  assert.equal((await motionOf(w, motionId)).state, "adopted");
});

floorSuite(test, "the floor and the meeting procedure never drive one motion; the floor's inquiry and questions work on a vote the procedure runs, and a held answer is released once", async (w) => {
  const { rec } = await w.meet();
  // the meeting procedure (card M06) with scripted members
  const procedure = MeetingProcedureService.withEpoch(w.storage, w.epoch, w.records, {
    clock: w.iso, actAs: async (a) => w.principalOf(a),
    floor: {
      comment: async (q) => ({ text: `${q.agent.slice(-6)} comments.` }),
      objection: async () => ({ answer: "none" }),
      ballot: async () => ({ value: "yes", reason: "the plan keeps the cache warm overnight" }),
      revision: async () => ({ keep: true }),
    },
  });
  // a motion the floor moved is the floor's alone
  const floorMotion = await start(w, rec);
  await refuses("invalid_command", () => procedure.begin(w.service, { commandId: cid("pb"), motionId: floorMotion }), /run by the meeting floor/);
  await w.floor.end(w.owner, { commandId: cid("end"), recordId: rec });

  // A second meeting: the procedure runs the motion and the floor carries only the owner's controls.
  const second = (await w.meet()).rec;
  const motionId = (await w.records.move(w.asD, { commandId: cid("mv"), recordId: second, text: MOTION })).id;
  await procedure.begin(w.service, { commandId: cid("pb"), motionId });
  await w.floor.start(w.service, { commandId: cid("fs"), recordId: second });
  const idle = await w.floor.drive(w.service, { recordId: second });
  assert.equal(idle.did, 0, "a floor without a motion runs no rounds of its own");
  assert.equal(w.script.calls.filter((c) => c.recordId === second).length, 0);
  for (let i = 0; i < 100 && (await motionOf(w, motionId)).state !== "voting"; i += 1) await procedure.advance(w.service, { motionId });
  assert.equal((await motionOf(w, motionId)).state, "voting");
  await procedure.advance(w.service, { motionId }); // one ballot is cast
  assert.equal((await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: second })).voteHeld, true, "the procedure's vote is held");
  assert.equal((await procedure.advance(w.service, { motionId })).waiting?.on, "owner");
  w.script.on((r) => (r.kind === "owner-answer" ? { text: "ANSWER: held-from-the-voters\nSOURCES: none\nCOMPLETED: none\nPROPOSED: none\nINVESTIGATE: none", usage: { visibleTokens: 10, hiddenTokens: 0 } } : undefined));
  assert.equal((await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: second, agent: w.pC, question: "Is the cache really warm?" })).answered, true);
  assert.equal((await transcript(w, second)).some((e) => e.text.includes("held-from-the-voters")), false, "held from the voters while the procedure's vote is open");
  // words that repeat a cast ballot's reason are refused with a warning while the vote is open
  await refuses("invalid_command", () => w.floor.address(w.owner, { commandId: cid("ad"), recordId: second, text: "As I understand it the plan keeps the cache warm overnight, right?" }), /ballots stop being private/);
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: second });
  await procedure.run(w.service, { motionId });
  assert.equal((await motionOf(w, motionId)).state, "adopted");
  // a controller that stops right after writing the released answer (before the floor notes it) leaves it for the next one, which writes nothing twice
  const crashing = new Proxy(w.records, { get: (t, k) => (k === "append" ? async (by: never, c: { commandId: string }) => { const out = await t.append(by, c as never); if (c.commandId.includes("-hr-")) throw new Error("stopped"); return out; } : (t as unknown as Record<string | symbol, unknown>)[k as string] instanceof Function ? ((t as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string]!).bind(t) : (t as unknown as Record<string | symbol, unknown>)[k as string]) });
  await assert.rejects(w.reopen({ records: crashing as never }).advance(w.service, { recordId: second }), /stopped/);
  await w.floor.advance(w.service, { recordId: second });
  await w.reopen().advance(w.service, { recordId: second });
  const released = (await transcript(w, second)).filter((e) => e.text.includes("held-from-the-voters"));
  assert.equal(released.length, 1, "released once the vote closed, and only once");
  assert.equal((await floorOf(w, second)).held.length, 0);
});

floorSuite(test, "a model call that fails with the route's own words keeps none of them: no host path or detail reaches the floor or the owner", async (w) => {
  const { rec } = await w.meet();
  w.script.on((r) => {
    if (r.kind === "blind-statement" && r.agent === w.pA) throw new Error("ENOENT: open '/home/rob/.config/route/key-file' failed");
    return undefined;
  });
  await start(w, rec);
  await w.floor.drive(w.service, { recordId: rec, maxUnits: 3 });
  const seen = JSON.stringify(await floorOf(w, rec)) + JSON.stringify(w.notices) + JSON.stringify(await transcript(w, rec));
  assert.equal(seen.includes("/home/rob"), false);
  assert.equal(seen.includes("ENOENT"), false);
  assert.ok(seen.includes("the model call failed"));
});

test("the owner's words that amend a motion are shown first; plain words to the meeting apply at once", () => {
  const context = { profile: "derived" as const, said: true, quoted: false };
  assert.match(String(proposalReason("meeting.floor.address", { recordId: "mrc-x", text: "use one o'clock", amend: { text: "Move it to 01:30." } }, false, context as never)), /shown first/);
  assert.equal(proposalReason("meeting.floor.address", { recordId: "mrc-x", text: "carry on" }, false, context as never), undefined);
});

test("rounds, reruns, revisions and tabling are one choice: the floor follows the procedure's settings unless its own key was set", () => {
  const set = (value: unknown): { value: unknown; set: boolean } => ({ value, set: true });
  const dflt = (value: unknown): { value: unknown; set: boolean } => ({ value, set: false });
  const s = floorSettingsFromInstallation({ "meeting.rounds": set(4), "meeting.tabling": set(false), "meeting.vote.maxRevisions": set(1), "meeting.objection.reruns": dflt(2), "meeting.floor.objectionReruns": set(0), "meeting.floor.commentRounds": dflt(2) });
  assert.deepEqual([s.commentRounds, s.tabling, s.maxRevisionsPerVoter, s.objectionReruns], [4, false, 1, 0]);
  assert.deepEqual(floorSettingsFromInstallation({}), FLOOR_DEFAULTS);
  assert.equal(floorSettingsFromInstallation({ "meeting.floor.commentRounds": set(1), "meeting.rounds": set(5) }).commentRounds, 1, "the floor's own key, set on purpose, wins");
});
