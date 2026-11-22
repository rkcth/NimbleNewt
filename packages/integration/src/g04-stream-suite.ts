import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HEAVY_SKIP, describe, engines, stopServer, withEngine } from "./g04-fixture.js";
import { CLEAN_OUTCOME, CLEAN_RESULT, cleanStreamRun, killStreamAndRestart, resultOf, streamBoundaries, streamOutcome, type EndOrder, type StreamKilled } from "./g04-stream.js";

/**
 * The boundaries the sweep must have, in this order, from the first model call to the tool's answer (labels without their index): the reply's generation begun, its tool call recorded before Pi may see it (its arguments, then
 * its end with the reply's finish), the generation completed at the reply's end, then the bridge's admission and the ledger. A step that disappeared or moved would otherwise go unkilled silently.
 */
const REPLY = ["before generation.begin", "after generation.begin", "before generation.record", "after generation.record", "before generation.record", "after generation.record"] as const;
const COMPLETE = ["before generation.complete", "after generation.complete"] as const;
const CALLED = "tool: called by the model";
export const STREAM_STEPS: Readonly<Record<EndOrder, readonly string[]>> = { "recorded first": [...REPLY, ...COMPLETE, CALLED, ...route()], "read first": [...REPLY, CALLED, ...COMPLETE, ...route()] };
function route(): string[] { return ["before generation.admit", "after generation.admit", "before effect.claim", "after effect.claim",
  "outside: before applying the effect", "outside: after applying the effect, before answering", "before effect.settle", "after effect.settle",
  "tool: outcome known, not yet returned to the model"]; }

/**
 * What each kill must end as (the result part: pushed, the effect, what the model was told). Every kill, in both orders, ends like the uncrashed run. Until G04 slice 7 the two kills between Pi storing the whole reply and the
 * controller completing its generation (read first: the tool called, the completion not begun) ended "nothing pushed, the model told it did not run", because a generation left streaming by the dead controller refused its
 * calls for good; the generation now records the epoch of its controller, and a stream left under an older epoch admits its complete call and ends in the same commit.
 */
export function expectedResult(_order: EndOrder, _label: string): string {
  return CLEAN_RESULT;
}

/**
 * Card G04, slice 6: a real SIGKILL at every boundary of the model stream before the tool runs (Pi's side) and of the tool's route, with the generation recorded by the production relay and stream tap and the tool run as the
 * production bridge runs it, in one of the two orders the end of a reply can take (`EndOrder`; one file per engine and order, as each sweep starts about 18 processes). After each kill the database is read before any command
 * runs, a new process finishes the path, and the invariants are checked (never pushed twice, never told "pushed" wrongly, the call admitted in at most one generation, no generation left streaming, the path finished, nothing
 * acknowledged lost); the result must be `expectedResult`'s. Each outcome is printed.
 */
export function defineStreamKillTests(engineName: string, order: EndOrder, heavy = false): void {
  const engine = engines.find((e) => e.name === engineName)!;
  after(stopServer);
  const what = order === "read first"
    ? "when Pi has stored the whole reply before the controller completes its generation (the production relay's order), ends like the uncrashed run at every boundary, including the two between those, where the restarted controller treats the generation its dead predecessor left streaming as ended and admits the complete call (slice 7); never pushed twice, nothing left streaming"
    : "when the controller completes the generation before Pi stores the reply, ends every time exactly like the uncrashed run: pushed once, confirmed and reported to the model, the call admitted in one generation, no generation left streaming";
  test(`${engine.name}: a real SIGKILL at every boundary of the model's reply through the production relay and stream tap (the generation begun, the tool call recorded, the reply completed) and of the tool's route, ${what}, nothing acknowledged lost`, { skip: heavy ? HEAVY_SKIP : false }, async () => {
    const clean = await withEngine(engine, (spec, dir) => cleanStreamRun(spec, dir, order));
    assert.equal(streamOutcome(clean.state), CLEAN_OUTCOME);
    const points = streamBoundaries(clean);
    assert.deepEqual(points.map((p) => describe(clean, p).replace(/^\d+ /, "")), [...STREAM_STEPS[order]]);
    const runs: StreamKilled[] = [];
    for (const point of points) runs.push(await withEngine(engine, (spec, dir) => killStreamAndRestart(spec, dir, clean, point, order)));
    for (const r of runs) console.log(`# g04 stream ${order}[${engine.name}] ${r.label}: ${r.outcome} (model asked ${r.modelCalls} time(s) after the restart)`);
    assert.deepEqual(runs.flatMap((r) => r.problems), []);
    // The result (what was pushed, the effect, what the model was told) at every boundary; the generations differ where the reply was asked again (the cut one is interrupted, its call dropped or withdrawn).
    assert.deepEqual(runs.map((r) => `${r.label}: ${resultOf(r.outcome)}`), runs.map((r) => `${r.label}: ${expectedResult(order, r.label)}`));
    console.log(`# g04 stream ${order}[${engine.name}]: ${points.length} boundaries (SIGKILL), ${describe(clean, points[0]!)} to ${describe(clean, points.at(-1)!)}, every one as expected`);
  });
}
