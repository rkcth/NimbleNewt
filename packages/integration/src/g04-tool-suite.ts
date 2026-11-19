import assert from "node:assert/strict";
import { after, test } from "node:test";
import { HEAVY_SKIP, describe, engines, stopServer, withEngine } from "./g04-fixture.js";
import { DONE_TEXT, cleanToolRun, killToolAndRestart, toolBoundaries, type ToolKilled } from "./g04-tool.js";

/** The outcome of a kill at each boundary of the tool route when Pi does not run an interrupted call again (the production bridge tools' setting), by the boundary's label. */
export function expectedWithoutReplay(label: string): string {
  if (/after generation\.admit|before effect\.claim/.test(label)) return "admitted, never started: nothing pushed, the intent stays open, model told it did not finish";
  if (/after effect\.claim|outside: before applying/.test(label)) return "started, never settled (not pushed): no blocker, model told it did not finish";
  if (/outside: after applying|before effect\.settle/.test(label)) return "started, never settled (pushed): no blocker, model told it did not finish";
  if (/after effect\.settle|tool: outcome known/.test(label)) return "pushed once and confirmed, but the model was told it did not finish";
  return "cut before the call was admitted: nothing pushed, model told it did not finish";
}

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
    const runs: ToolKilled[] = [];
    for (const point of points) runs.push(await withEngine(engine, (spec, dir) => killToolAndRestart(spec, dir, clean, point, replay)));
    for (const r of runs) console.log(`# g04 tool${replay === undefined ? "" : " replayed"}[${engine.name}] ${r.label}: ${r.outcome} (model asked ${r.modelCalls} time(s) after the restart)`);
    assert.deepEqual(runs.flatMap((r) => r.problems), []);
    return { runs, points, first: describe(clean, points[0]!), last: describe(clean, points.at(-1)!) };
  };

  test(`${engine.name}: a real SIGKILL at every boundary of a protected tool call the Pi model makes (admission, the effect ledger, the target) never pushes twice, never reports a push that did not happen and loses no acknowledged operation; an interrupted call is not run again, so a started effect stays unsettled and a finished one is reported to the model as not finished`, { skip: heavy ? HEAVY_SKIP : false }, async () => {
    const { runs, points, first, last } = await sweep(undefined);
    assert.ok(points.length >= 14, `${points.length} boundaries`);
    assert.deepEqual(runs.map((r) => `${r.label}: ${r.outcome}`), runs.map((r) => `${r.label}: ${expectedWithoutReplay(r.label)}`));
    console.log(`# g04 tool[${engine.name}]: ${points.length} boundaries of the tool route (SIGKILL), ${first} to ${last}, database read before restart, restarted and checked`);
  });

  test(`${engine.name}: when Pi runs the interrupted call again with the same call ID, the same admission and the effect ledger finish it: a real SIGKILL at every boundary of the route ends with the push applied once, confirmed and reported to the model`, { skip: heavy ? HEAVY_SKIP : false }, async () => {
    const { runs, points, first, last } = await sweep("safe");
    assert.deepEqual(runs.filter((r) => r.outcome !== "pushed once, model told").map((r) => `${r.label}: ${r.outcome}`), []);
    console.log(`# g04 tool replayed[${engine.name}]: ${points.length} boundaries of the tool route (SIGKILL), ${first} to ${last}, every one finished as the uncrashed run`);
  });
}
