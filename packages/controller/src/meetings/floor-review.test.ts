import assert from "node:assert/strict";
import { after, test } from "node:test";
import { stopServer } from "../domain/testing/backends.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { proposalReason } from "../chat/commands.js";
import type { FloorBody } from "./floor-types.js";
import { floorSuite, type FloorWorld } from "./floor-suite.js";
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
const floorOf = async (w: FloorWorld, rec: string): Promise<FloorBody & { phase: string }> => (await w.floor.state(w.owner, rec)) as unknown as FloorBody & { phase: string };
const cast = async (w: FloorWorld, motionId: string): Promise<number> => ((await motionOf(w, motionId)).ballots ?? 0);
const motionOf = async (w: FloorWorld, id: string): Promise<MotionBody> => (await w.records.motion(w.owner, id)) as unknown as MotionBody;
const transcript = async (w: FloorWorld, rec: string): Promise<{ text: string }[]> => (await w.records.discussion(w.owner, rec, { limit: 100 }))!.entries as never;
const start = async (w: FloorWorld, rec: string): Promise<string> => (await w.floor.start(w.service, { commandId: cid("st"), recordId: rec, motion: { text: MOTION } })).motionId!;
const untilVoteOpen = async (w: FloorWorld, rec: string, motionId: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) {
    if ((await motionOf(w, motionId)).state === "voting") return;
    await w.floor.advance(w.service, { recordId: rec });
  }
  assert.fail("the vote never opened");
};

floorSuite(test, "the chair, a manager agent and a member see only what a member sees while a vote is open: not who has voted, not whose ballot is next", async (w) => {
  // the chair is a voter here
  const { rec } = await w.meet({ roster: [w.pA, w.pB, w.pC], chair: w.pA });
  const motionId = await start(w, rec);
  await untilVoteOpen(w, rec, motionId);
  const first = await w.floor.advance(w.mgr, { recordId: rec });
  assert.equal("did" in first && first.did, "procedure");
  assert.equal("agent" in first, false, "a manager agent that runs the meeting is not told whose ballot was taken");
  assert.equal(await cast(w, motionId), 1, "one ballot was cast");
  for (const viewer of [w.asA, w.asB, w.mgr]) {
    const seen = JSON.stringify(await w.floor.state(viewer, rec));
    assert.equal(seen.includes("\"cast\""), false, `${viewer.id} is not shown who has voted`);
    assert.equal(seen.includes("\"turns\""), false, `${viewer.id} is not shown the turn log`);
    assert.equal(seen.includes("\"ballot\""), false, `${viewer.id} is not shown whose ballot is being asked`);
    const waiting = await w.floor.waiting(viewer, rec);
    assert.deepEqual([waiting!.kind, (waiting as { who?: string }).who], ["agent", "the voters"]);
  }
  const next = ((await w.floor.waiting(w.owner, rec)) as { who?: string }).who;
  assert.ok(next !== undefined && [w.pA, w.pB, w.pC].includes(next), "the owner sees whose ballot is next");
});

floorSuite(test, "an inquiry opened while a ballot is being answered holds the vote: the ballot is set aside, the owner's questions run, and the voter is asked again when the vote resumes", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  await untilVoteOpen(w, rec, motionId);
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
  // waits on the ballot call itself (no fixed count of event-loop turns), and the advance is settled before the test can end, so a failure here is never hidden by its run into the closed storage
  let voter: string;
  let r: Awaited<typeof pending>;
  try {
    voter = (await w.script.until("the first ballot is being asked", (c) => c.kind === "ballot", pending)).agent;
    assert.equal((await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec })).voteHeld, true);
    release();
    r = await pending;
  } finally {
    release();
    await pending.catch(() => undefined);
  }
  assert.equal("waiting" in r && r.waiting, "owner", "the ballot answered after the hold is not cast");
  assert.equal(await cast(w, motionId), 0);
  assert.ok((await floorOf(w, rec)).turns.some((t) => t.kind === "ballot" && t.agent === voter), "the set-aside call is still counted");
  const asked = await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pB, question: "What did the last run cost?" });
  assert.equal(asked.answered, true, "the owner's question is not blocked by the set-aside ballot");
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  await w.floor.drive(w.service, { recordId: rec });
  assert.equal(w.script.of("ballot").filter((c) => c.agent === voter).length, 2, "the voter is asked again after the inquiry");
  assert.equal((await motionOf(w, motionId)).state, "adopted");
});

floorSuite(test, "the floor is the procedure's members: a motion started through the procedure alone still gets the floor's turns, inquiry and questions, and a held answer is released once", async (w) => {
  const { rec } = await w.meet();
  const motionId = (await w.records.move(w.asD, { commandId: cid("mv"), recordId: rec, text: MOTION })).id;
  await w.procedure.begin(w.service, { commandId: cid("pb"), motionId });
  await w.floor.start(w.service, { commandId: cid("fs"), recordId: rec });
  for (let i = 0; i < 100 && (await motionOf(w, motionId)).state !== "voting"; i += 1) await w.procedure.advance(w.service, { motionId });
  assert.equal((await motionOf(w, motionId)).state, "voting");
  assert.ok(w.script.calls.length > 0, "the members' turns were the floor's");
  await w.procedure.advance(w.service, { motionId }); // one ballot is cast
  assert.equal((await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec })).voteHeld, true, "the procedure's vote is held");
  assert.equal((await w.procedure.advance(w.service, { motionId })).waiting?.on, "owner");
  w.script.on((r) => (r.kind === "owner-answer" ? { text: "ANSWER: held-from-the-voters\nSOURCES: none\nCOMPLETED: none\nPROPOSED: none\nINVESTIGATE: none", usage: { visibleTokens: 10, hiddenTokens: 0 } } : undefined));
  assert.equal((await w.floor.ask(w.owner, { commandId: cid("ask"), recordId: rec, agent: w.pC, question: "Is the cache really warm?" })).answered, true);
  assert.equal((await transcript(w, rec)).some((e) => e.text.includes("held-from-the-voters")), false, "held from the voters while the vote is open");
  // words that repeat a cast ballot's reason are refused with a warning while the vote is open
  await refuses("invalid_command", () => w.floor.address(w.owner, { commandId: cid("ad"), recordId: rec, text: "As I understand it, the cache is warm at that hour, right?" }), /ballots stop being private/);
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  await w.procedure.run(w.service, { motionId });
  assert.equal((await motionOf(w, motionId)).state, "adopted");
  // a controller that stops right after writing the released answer (before the floor notes it) leaves it for the next one, which writes nothing twice
  const crashing = new Proxy(w.records, { get: (t, k) => (k === "append" ? async (by: never, c: { commandId: string }) => { const out = await t.append(by, c as never); if (c.commandId.includes("-hr-")) throw new Error("stopped"); return out; } : (t as unknown as Record<string | symbol, unknown>)[k as string] instanceof Function ? ((t as unknown as Record<string, (...x: unknown[]) => unknown>)[k as string]!).bind(t) : (t as unknown as Record<string | symbol, unknown>)[k as string]) });
  await assert.rejects(w.reopen({ records: crashing as never }).advance(w.service, { recordId: rec }), /stopped/);
  await w.reopen().advance(w.service, { recordId: rec });
  await w.reopen().advance(w.service, { recordId: rec });
  const released = (await transcript(w, rec)).filter((e) => e.text.includes("held-from-the-voters"));
  assert.equal(released.length, 1, "released once the vote closed, and only once");
  assert.equal((await floorOf(w, rec)).held.length, 0);
});

floorSuite(test, "the procedure driven on its own (the scheduled loop, an API call) asks no member while the owner's inquiry or the meeting's timebox holds the meeting, and goes on when it ends", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec });
  const before = w.script.calls.length;
  const held = await w.procedure.advance(w.service, { motionId });
  assert.equal(held.waiting?.on, "owner", JSON.stringify(held));
  assert.equal((await w.procedure.driveAll(w.service, {})).steps >= 0, true);
  assert.equal(w.script.calls.length, before, "nobody was asked while the inquiry was open");
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  const moved = await w.procedure.advance(w.service, { motionId });
  assert.equal(moved.waiting, undefined, "the procedure goes on");
  assert.ok(w.script.calls.length > before);
  // a used-up timebox holds it the same way
  w.clock.tick(120);
  const callsBefore = w.script.calls.length;
  await w.procedure.advance(w.service, { motionId }); // the floor's wrap-up of the used-up timebox comes first
  assert.equal((await motionOf(w, motionId)).state, "tabled", "a motion not yet voted on is tabled when the time is used up");
  const after = await w.procedure.advance(w.service, { motionId });
  assert.ok(after.waiting !== undefined || after.done, JSON.stringify(after));
  assert.equal(w.script.calls.length, callsBefore, "no member was asked after the timebox");
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
