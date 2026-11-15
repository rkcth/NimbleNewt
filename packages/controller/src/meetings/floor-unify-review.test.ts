import assert from "node:assert/strict";
import { after, test } from "node:test";
import { stopServer } from "../domain/testing/backends.js";
import { TurnWaitsOnTool } from "./floor.js";
import type { FloorBody } from "./floor-types.js";
import { floorSuite, type FloorWorld } from "./floor-suite.js";
import { MeetingProcedureService } from "./procedure.js";
import type { DecisionRecordBody, MotionBody } from "./record-types.js";

// Review of the M05/M06 integration (the procedure is the one service that runs a motion; the floor is its members and chair): who learns who has voted, a ballot or revision an inquiry interrupts, a motion begun without
// the floor, and the scheduled turn (bounded work, archived projects, a meeting closed by other means).

after(stopServer);

let n = 0;
const cid = (label: string): string => `${label}-u${n++}`;
const MOTION = "Move the nightly build to 01:00 because the cache is warm then.";
const motionOf = async (w: FloorWorld, id: string): Promise<MotionBody> => (await w.records.motion(w.owner, id)) as unknown as MotionBody;
const floorOf = async (w: FloorWorld, rec: string): Promise<FloorBody> => (await w.floor.state(w.owner, rec)) as unknown as FloorBody;
const transcript = async (w: FloorWorld, rec: string): Promise<{ kind: string; speaker: string; text: string }[]> => (await w.records.discussion(w.owner, rec, { limit: 100 }))!.entries as never;
const start = async (w: FloorWorld, rec: string): Promise<string> => (await w.floor.start(w.service, { commandId: cid("st"), recordId: rec, motion: { text: MOTION } })).motionId!;
const decisionOf = async (w: FloorWorld, motionId: string): Promise<DecisionRecordBody> => (await w.records.decision(w.owner, (await motionOf(w, motionId)).decisionId!)) as never;
const untilVoteOpen = async (w: FloorWorld, rec: string, motionId: string): Promise<void> => {
  for (let i = 0; i < 200; i += 1) { if ((await motionOf(w, motionId)).state === "voting") return; await w.floor.advance(w.service, { recordId: rec }); }
  assert.fail("the vote never opened");
};
const waitFor = async (what: string, ok: () => boolean | Promise<boolean>): Promise<void> => {
  for (let i = 0; i < 20_000; i += 1) { if (await ok()) return; await new Promise<void>((r) => setImmediate(r)); }
  assert.fail(`never became true: ${what}`);
};
const setProject = async (w: FloorWorld, state: "archived" | "active"): Promise<void> => {
  await w.projects.updateProject({ commandId: cid("ps"), actor: w.owner.id, projectId: w.project, expectedRevision: (await w.projects.getProject(w.project))!.revision, state } as never);
};

floorSuite(test, "a manager agent that drives the vote is never told which voter was asked or who has not answered", async (w) => {
  const { rec } = await w.meet({ roster: [w.pA, w.pB, w.pC], chair: w.pA });
  const motionId = await start(w, rec);
  await untilVoteOpen(w, rec, motionId);
  const voters = [w.pA, w.pB, w.pC];
  const one = await w.floor.advance(w.mgr, { recordId: rec });
  assert.equal("did" in one && one.did, "procedure");
  assert.ok(!voters.some((v) => JSON.stringify(one).includes(v)), `advance names no voter: ${JSON.stringify(one)}`);
  const rest = await w.floor.drive(w.mgr, { recordId: rec });
  assert.ok(!voters.some((v) => JSON.stringify(rest).includes(v)), `drive names no voter: ${JSON.stringify(rest)}`);
  // the owner (and a host or service) is told
  const { rec: rec2 } = await w.meet({ roster: [w.pA, w.pB, w.pC], chair: w.pA });
  const m2 = await start(w, rec2);
  await untilVoteOpen(w, rec2, m2);
  const seen = await w.floor.advance(w.owner, { recordId: rec2 });
  assert.ok(voters.some((v) => JSON.stringify(seen).includes(v)), "the owner sees whose ballot was taken");
});

floorSuite(test, "a voter whose ballot turn waits on a tool is not named to the members or the chair while the vote is open", async (w) => {
  const { rec } = await w.meet({ roster: [w.pA, w.pB, w.pC], chair: w.pA });
  const motionId = await start(w, rec);
  await untilVoteOpen(w, rec, motionId);
  w.script.on((r) => { if (r.kind === "ballot") throw new TurnWaitsOnTool("the build log"); return undefined; });
  const r = await w.floor.advance(w.service, { recordId: rec });
  assert.equal("waiting" in r && r.waiting, "tool", JSON.stringify(r));
  const asked = w.script.of("ballot")[0]!.agent;
  for (const viewer of [w.asA, w.asB, w.asC, w.mgr]) {
    const waiting = await w.floor.waiting(viewer, rec);
    assert.equal(JSON.stringify(waiting).includes(asked), false, `${viewer.id} is not told whose ballot waits: ${JSON.stringify(waiting)}`);
    assert.equal(JSON.stringify(await w.floor.state(viewer, rec)).includes(asked), false, `${viewer.id}'s view of the floor does not name the voter`);
  }
  assert.equal(((await w.floor.waiting(w.owner, rec)) as { who?: string }).who, asked, "the owner sees who it waits on");
});

floorSuite(test, "a revision turn answered as an inquiry opens is set aside and offered again when the vote resumes, not taken from what was said before", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  await untilVoteOpen(w, rec, motionId);
  await w.floor.advance(w.service, { recordId: rec }); // the first ballot
  const first = w.script.of("ballot")[0]!.agent;
  await w.procedure.ownerMessage(w.owner, { commandId: cid("om"), recordId: rec, text: "Please also think about the backup window before you settle." });
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let gated = false;
  w.script.on(async (r) => {
    if (r.kind !== "revision") return undefined;
    if (!gated) { gated = true; await gate; return { text: "VOTE: no\nREASON: said before the inquiry.", usage: { visibleTokens: 10, hiddenTokens: 0 } }; }
    return { text: "VOTE: yes\nREASON: still fine after the owner's questions.", usage: { visibleTokens: 10, hiddenTokens: 0 } };
  });
  const pending = w.floor.drive(w.service, { recordId: rec });
  await waitFor("the revision turn is being asked", () => w.script.of("revision").length === 1);
  assert.equal(w.script.of("revision")[0]!.agent, first);
  assert.equal((await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec })).voteHeld, true);
  release();
  const held = await pending;
  assert.equal("waiting" in held.last && held.last.waiting, "owner", JSON.stringify(held));
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  await w.floor.drive(w.service, { recordId: rec });
  assert.equal(w.script.of("revision").filter((c) => c.agent === first).length, 2, "the revision turn is asked again");
  assert.equal((await motionOf(w, motionId)).state, "adopted", "the answer given after the inquiry is the one that counts");
  const table = (await decisionOf(w, motionId)).table as unknown as { voter?: string; agent?: string; value?: string }[];
  assert.equal(JSON.stringify(table).includes("said before the inquiry"), false, "the set-aside answer was never cast");
});

floorSuite(test, "an inquiry that holds the vote just as a ballot is cast sets the ballot aside: the voter is asked again, never recorded as giving no ballot", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  await untilVoteOpen(w, rec, motionId);
  let raced = false;
  const records = new Proxy(w.records, {
    get: (t, k) => {
      if (k === "castBallot") {
        return async (by: never, c: never) => {
          // the owner's inquiry lands between the procedure's check of the hold and the cast
          if (!raced) { raced = true; await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec }); }
          return t.castBallot(by, c);
        };
      }
      const v = (t as unknown as Record<string | symbol, unknown>)[k as string];
      return typeof v === "function" ? (v as (...x: unknown[]) => unknown).bind(t) : v;
    },
  });
  const procedure = MeetingProcedureService.withEpoch(w.storage, w.epoch, records as never, { clock: w.iso, settings: async () => w.procSettings.current, floor: w.floor.asMembers(), chair: w.floor.asChair(), actAs: async (a: string) => w.principalOf(a) });
  const step = await procedure.advance(w.service, { motionId });
  assert.equal(step.waiting?.on, "owner", JSON.stringify(step));
  const status = (await procedure.status(w.service, motionId)) as unknown as { noBallot: string[]; voteAsked: string[] };
  assert.deepEqual([status.noBallot, status.voteAsked], [[], []], "nobody is recorded as giving no ballot");
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  await procedure.run(w.service, { motionId, steps: 50 });
  assert.equal((await motionOf(w, motionId)).state, "adopted");
  assert.equal((await decisionOf(w, motionId)).table.length, 3, "every voter's ballot counts");
});

floorSuite(test, "a motion whose procedure was begun without the floor being started still gets real answers from the members (the floor is put on by itself), and the scheduled turns then leave it to the floor", async (w) => {
  const { rec } = await w.meet();
  const motionId = await w.motion(rec);
  await w.procedure.begin(w.service, { commandId: cid("pb"), motionId });
  await w.procedure.run(w.service, { motionId, steps: 100 });
  const said = (await transcript(w, rec)).filter((e) => e.kind === "statement" && [w.pA, w.pB, w.pC].includes(e.speaker));
  assert.ok(said.length >= 3, `the members spoke: ${JSON.stringify(await transcript(w, rec))}`);
  assert.equal((await motionOf(w, motionId)).state, "adopted");
  assert.equal((await decisionOf(w, motionId)).table.length, 3, "every member gave a ballot");
  assert.equal(await w.floor.runs(rec), true, "the floor runs it now, so the procedure's own turn skips it");
});

floorSuite(test, "the scheduled turn holds an archived project's meetings: nobody is asked, no reminder is sent, until the project is restored", async (w) => {
  const { rec } = await w.meet();
  const motionId = await start(w, rec);
  await setProject(w, "archived");
  const before = w.script.calls.length;
  const t = await w.floor.tick(w.service);
  assert.equal(t.driven, 0);
  assert.equal((await w.procedure.driveAll(w.service, {})).driven, 0, "the procedure's own turn holds it too");
  assert.equal(w.script.calls.length, before, "nobody was asked");
  await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec });
  w.clock.tick(40);
  assert.deepEqual((await w.floor.tick(w.service)).reminded, [], "no reminder for an archived project");
  assert.equal(w.notices.some((x) => x.kind === "inquiry-idle"), false);
  await setProject(w, "active");
  assert.deepEqual((await w.floor.tick(w.service)).reminded, [rec], "reminded once restored");
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  for (let i = 0; i < 30 && (await motionOf(w, motionId)).state !== "adopted"; i += 1) await w.floor.tick(w.service);
  assert.equal((await motionOf(w, motionId)).state, "adopted");
});

floorSuite(test, "a meeting closed by other means while an inquiry is open: the inquiry ends with it, no reminder repeats, the Needs-you item goes and the owner's done is not refused", async (w) => {
  const settled: string[] = [];
  w.reopen({ settleOwner: async (s) => { settled.push(`${s.recordId}:${s.kinds.join(",")}`); } });
  const a = (await w.meet()).rec;
  const b = (await w.meet()).rec;
  await start(w, a); await start(w, b);
  for (const rec of [a, b]) await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec });
  for (const rec of [a, b]) await w.records.finish(w.owner, { commandId: cid("fin"), recordId: rec });
  // the owner says done on the list: accepted, the inquiry and its notices are closed
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: a });
  assert.ok(settled.some((s) => s.startsWith(`${a}:`)));
  // the other is closed by the scheduled turn
  w.clock.tick(40);
  const t = await w.floor.tick(w.service);
  assert.deepEqual(t.reminded, [], "nothing reminds the owner of a closed meeting's inquiry");
  assert.equal(w.notices.some((x) => x.kind === "inquiry-idle"), false);
  assert.deepEqual((await w.floor.openInquiries(w.owner, 10)).items, [], "nothing is left on the Needs-you list");
  assert.ok(settled.some((s) => s.startsWith(`${b}:`)));
  assert.equal((await floorOf(w, b)).state, "ended");
});

floorSuite(test, "the scheduled turns do bounded work: a few meetings and procedures each turn, going on from where the last stopped so every one is reached", async (w) => {
  const recs = [(await w.meet()).rec, (await w.meet()).rec, (await w.meet()).rec];
  for (const rec of recs) await start(w, rec);
  const reached = (): Set<string> => new Set(w.script.calls.map((c) => c.recordId));
  const first = await w.floor.tick(w.service, { meetings: 1, units: 1 });
  assert.equal(first.driven, 1);
  assert.equal(reached().size, 1, "one meeting a turn");
  await w.floor.tick(w.service, { meetings: 1, units: 1 });
  await w.floor.tick(w.service, { meetings: 1, units: 1 });
  assert.equal(reached().size, 3, "every meeting is reached in turn");
  // the procedure's own turn the same way (meetings it does not leave to the floor)
  const p = [(await w.meet()).rec, (await w.meet()).rec];
  const motions: string[] = [];
  for (const rec of p) { const m = await w.motion(rec); motions.push(m); await w.procedure.begin(w.service, { commandId: cid("pb"), motionId: m }); }
  const floorRuns = new Set(recs);
  const skip = async (r: string): Promise<boolean> => floorRuns.has(r);
  const one = await w.procedure.driveAll(w.service, { procedures: 1, steps: 1, skip });
  assert.equal(one.driven, 1);
  await w.procedure.driveAll(w.service, { procedures: 1, steps: 1, skip });
  for (const rec of p) assert.ok(reached().has(rec), "each procedure got its turn");
});

floorSuite(test, "each inquiry tells the owner once, a second inquiry in the same meeting as well", async (w) => {
  const { rec } = await w.meet();
  await start(w, rec);
  await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec });
  await w.floor.endInquiry(w.owner, { commandId: cid("ie"), recordId: rec });
  await w.floor.openInquiry(w.owner, { commandId: cid("iq"), recordId: rec });
  const opened = w.notices.filter((x) => x.kind === "inquiry-open") as { key?: string }[];
  assert.equal(opened.length, 2);
  assert.ok(opened[0]!.key !== undefined && opened[0]!.key !== opened[1]!.key, "each inquiry's notice is its own");
});

floorSuite(test, "a timebox used up during the vote asks no more ballots and no revision turns: the vote is counted with what was cast once its time is up", async (w) => {
  const { rec } = await w.meet({ endsInMinutes: 60 });
  const motionId = await start(w, rec);
  await untilVoteOpen(w, rec, motionId);
  await w.floor.advance(w.service, { recordId: rec }); // one ballot is cast
  assert.equal(w.script.of("ballot").length, 1);
  w.clock.tick(61); // past the meeting's time (and the vote's own limit)
  await w.floor.drive(w.service, { recordId: rec });
  await w.procedure.run(w.service, { motionId, steps: 20 });
  assert.equal(w.script.of("ballot").length, 1, "no ballot is asked once the timebox is used up");
  assert.equal(w.script.of("revision").length, 0);
  const m = await motionOf(w, motionId);
  assert.notEqual(m.state, "voting", "the vote was counted when its time was up");
  assert.equal((await floorOf(w, rec)).timebox?.reason, "time");
});
