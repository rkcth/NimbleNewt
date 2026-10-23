import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EXHAUSTIVE, HEAVY_SKIP, cleanRun, engines, pickIndexes, stopServer, withEngine, type Clean } from "./g04-fixture.js";
import { ADMISSION, RESULT, STRIDE, keyPoints, killAndRestart } from "./g04-kill.js";

/**
 * Card G04, controller and worker killed together: the child process holds the controller services and the Pi adapter; SIGKILL lands at a numbered
 * boundary. After each kill the database is read before any command runs (every acknowledged operation present, nothing unstarted present), then the
 * restarted process runs the same path and the result must equal the uncrashed run, with the model's answer in the transcript once and the protected
 * effect applied once.
 */
export function defineKillTests(engineName: string, heavy = false): void {
  const engine = engines.find((e) => e.name === engineName)!;
  after(stopServer);

  test(`${engine.name}: the real SIGKILL ${EXHAUSTIVE ? "at every boundary" : "at the boundaries around admission, the model request, the outside effect and the result, and every eighth boundary"} of the path with the real Pi adapter loses no acknowledged operation and repeats no effect`, { skip: heavy ? HEAVY_SKIP : false }, async () => {
    const clean: Clean = await withEngine(engine, (spec, dir) => cleanRun(spec, dir));
    assert.ok(clean.labels.length >= 100, `${clean.labels.length} boundaries`);
    for (const type of [...ADMISSION, ...RESULT]) assert.ok(clean.operations.some((o) => o.type === type), `the path has a ${type} operation`);
    const points = pickIndexes(clean.labels.length, keyPoints(clean), STRIDE);
    const failures: string[] = [];
    let resumedAtRequest = 0;
    const inFlight = clean.labels.indexOf("bridge: request submitted, result not yet read");
    for (const point of points) {
      const done = await withEngine(engine, (spec, dir) => killAndRestart(spec, dir, clean, point));
      failures.push(...done.problems);
      if (point === inFlight) resumedAtRequest = done.resumed;
    }
    assert.deepEqual(failures, []);
    if (points.includes(inFlight)) assert.ok(resumedAtRequest > 0, "killed with the model request in flight, the restart found interrupted work and resumed it through the reviewed recovery step");
    console.log(`# g04 kill[${engine.name}]: ${points.length} of ${clean.labels.length} boundaries (SIGKILL), database read before restart, restarted and verified`);
  });
}
