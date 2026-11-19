import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HEAVY_SKIP, describe, engines, stopServer, withEngine } from "./g04-fixture.js";
import { DONE_TEXT, PRODUCTION_REPLAY, cleanToolRun, killToolAndRestart, toolBoundaries, type ToolKilled } from "./g04-tool.js";

/**
 * The outcome of a kill at each boundary of the tool route when the interrupted call is NOT presented again (a tool that is not replay-safe, or a conversation whose interrupted work was abandoned), by the boundary's label.
 * G04 follow-up: once the attempt has ended, nothing is left open. A call admitted but never started is closed as failed; one that started is marked uncertain and the owner is told by a blocker; it is never run again.
 */
export function expectedNotPresentedAgain(label: string): string {
  if (/after generation\.admit|before effect\.claim/.test(label)) return "admitted, never started: closed as failed once the attempt ended, nothing pushed, no blocker, model told it did not finish";
  if (/after effect\.claim|outside: before applying/.test(label)) return "started, never settled: marked uncertain once the attempt ended, nothing pushed, the owner told by its blocker, blockers effect_uncertain, model told it did not finish";
  if (/outside: after applying|before effect\.settle/.test(label)) return "started, never settled: marked uncertain once the attempt ended, 1 pushed, the owner told by its blocker, blockers effect_uncertain, model told it did not finish";
  if (/after effect\.settle|tool: outcome known/.test(label)) return "pushed once and confirmed, but the call was not presented again: no blocker, model told it did not finish";
  return "cut before the call was admitted: nothing pushed, no blocker, model told it did not finish";
}

/** The boundaries the route must have, in this order, between the model's call and the tool's answer: without them a sweep could pass while skipping a step. */
export const ROUTE_STEPS = [
  "tool: called by the model", "before generation.begin", "after generation.begin", "before generation.record", "after generation.record",
  "before generation.complete", "after generation.complete", "before generation.admit", "after generation.admit", "before effect.claim", "after effect.claim",
  "outside: before applying the effect", "outside: after applying the effect, before answering", "before effect.settle", "after effect.settle",
  "tool: outcome known, not yet returned to the model",
] as const;

/**
 * Card G04, a kill inside a protected tool the model calls: the controller services and the real Pi adapter in one child process, the model's `push`
 * call running the L05d route (record, complete, admit the call as an effect, run it through the ledger against the idempotent target), and a real
 * SIGKILL at every boundary of that route. After each kill the database is read before any command runs, a new process finishes the path, and the
 * invariants are checked: never pushed twice, never told "pushed" when it was not, nothing acknowledged lost, the path finished with one answer.
 * The outcome of each kill is printed and compared with the one the evidence records (g04-evidence.md), so a change of behaviour shows here.
 */
export function defineToolKillTests(engineName: string, heavy = false): void {
  const engine = engines.find((e) => e.name === engineName)!;
  after(stopServer);

  const sweep = async (replay: "safe" | undefined): Promise<{ runs: ToolKilled[]; points: number[]; first: string; last: string }> => {
    const clean = await withEngine(engine, (spec, dir) => cleanToolRun(spec, dir, replay));
    assert.equal(clean.state.text, DONE_TEXT);
    const points = toolBoundaries(clean);
    // Every step of the route is a boundary, each once and in order (a step that disappeared or moved out of the tool would otherwise go unkilled silently).
    assert.deepEqual(points.map((p) => describe(clean, p).replace(/^\d+ /, "")), [...ROUTE_STEPS]);
    const runs: ToolKilled[] = [];
    for (const point of points) runs.push(await withEngine(engine, (spec, dir) => killToolAndRestart(spec, dir, clean, point, replay)));
    for (const r of runs) console.log(`# g04 tool${replay === undefined ? " not presented again" : ""}[${engine.name}] ${r.label}: ${r.outcome} (model asked ${r.modelCalls} time(s) after the restart)`);
    assert.deepEqual(runs.flatMap((r) => r.problems), []);
    return { runs, points, first: describe(clean, points[0]!), last: describe(clean, points.at(-1)!) };
  };

  test(`${engine.name}: a real SIGKILL at every boundary of a protected tool call the Pi model makes (admission, the effect ledger, the target), with the production bridge tools' setting (an interrupted call is presented again under its own call ID), ends every time exactly like the uncrashed run: pushed once, confirmed and reported to the model as pushed, the call admitted, no effect left open, no blocker, never pushed twice, nothing acknowledged lost`, { skip: heavy ? HEAVY_SKIP : false }, async () => {
    assert.equal(PRODUCTION_REPLAY, "safe", "the production bridge tools present an interrupted call again (G04 follow-up)");
    const { runs, points, first, last } = await sweep(PRODUCTION_REPLAY);
    assert.equal(points.length, ROUTE_STEPS.length);
    assert.deepEqual(runs.filter((r) => r.outcome !== "pushed once, model told").map((r) => `${r.label}: ${r.outcome}`), []);
    console.log(`# g04 tool[${engine.name}]: ${points.length} boundaries of the tool route (SIGKILL), ${first} to ${last}, database read before restart, restarted, every one finished as the uncrashed run`);
  });

  test(`${engine.name}: when an interrupted call is NOT presented again (a tool that is not replay-safe, or abandoned work), a real SIGKILL at every boundary still never pushes twice and leaves nothing open: once the attempt ends, an admitted call that never started is closed as failed and one that started is marked uncertain and reported to the owner, never run again`, { skip: heavy ? HEAVY_SKIP : false }, async () => {
    const { runs, points, first, last } = await sweep(undefined);
    assert.equal(points.length, ROUTE_STEPS.length);
    assert.deepEqual(runs.map((r) => `${r.label}: ${r.outcome}`), runs.map((r) => `${r.label}: ${expectedNotPresentedAgain(r.label)}`));
    console.log(`# g04 tool not presented again[${engine.name}]: ${points.length} boundaries of the tool route (SIGKILL), ${first} to ${last}, every effect closed or reported`);
  });
}
