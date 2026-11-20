import assert from "node:assert/strict";
import { after, test } from "node:test";
import { EXHAUSTIVE, HEAVY_SKIP, WHOLE, cleanRun, engines, partName, pickIndexes, share, stopServer, withEngine, type Clean, type Part } from "./g04-fixture.js";
import { ADMISSION, RESULT, STRIDE, keyPoints, killAndRestart } from "./g04-kill.js";

/**
 * Card G04, controller and worker killed together: the child process holds the controller services and the Pi adapter; SIGKILL lands at a numbered
 * boundary. After each kill the database is read before any command runs (every acknowledged operation present, nothing unstarted present), then the
 * restarted process runs the same path and the result must equal the uncrashed run, with the model's answer in the transcript once and the protected
 * effect applied once.
 * `part`: this file runs only its share of the boundaries (see `share`); the files of one engine together run every one the sweep picks.
 */
export function defineKillTests(engineName: string, heavy = false, part: Part = WHOLE): void {
  const engine = engines.find((e) => e.name === engineName)!;
  after(stopServer);

  test(`${engine.name}: the real SIGKILL ${EXHAUSTIVE ? "at every boundary" : "at the boundaries around admission, the model request, the outside effect and the result, and every eighth boundary"} of the path with the real Pi adapter loses no acknowledged operation and repeats no effect${partName(part)}`, { skip: heavy ? HEAVY_SKIP : false }, async () => {
    const clean: Clean = await withEngine(engine, (spec, dir) => cleanRun(spec, dir));
    assert.ok(clean.labels.length >= 100, `${clean.labels.length} boundaries`);
    for (const type of [...ADMISSION, ...RESULT]) assert.ok(clean.operations.some((o) => o.type === type), `the path has a ${type} operation`);
    const picked = pickIndexes(clean.labels.length, keyPoints(clean), STRIDE);
    const points = share(picked, part);
    const failures: string[] = [];
    let resumedAtRequest = 0;
    const inFlight = clean.labels.indexOf("bridge: request submitted, result not yet read");
    // The part that holds this boundary checks the resume below; every sweep picks it, so one part of each engine always does.
    assert.ok(picked.includes(inFlight), "the boundary with the model request in flight is one the sweep kills at");
    for (const point of points) {
      const done = await withEngine(engine, (spec, dir) => killAndRestart(spec, dir, clean, point));
      failures.push(...done.problems);
      if (point === inFlight) resumedAtRequest = done.resumed;
    }
    assert.deepEqual(failures, []);
    if (points.includes(inFlight)) assert.ok(resumedAtRequest > 0, "killed with the model request in flight, the restart found interrupted work and resumed it through the reviewed recovery step");
    console.log(`# g04 kill[${engine.name}]${partName(part)}: ${points.length} of ${clean.labels.length} boundaries (SIGKILL; ${picked.length} in all parts), database read before restart, restarted and verified`);
  });
}
