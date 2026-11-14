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
