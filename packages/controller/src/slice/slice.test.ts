import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import { Chaos, Crash } from "./chaos.js";
import { Clock, check, runPath, signature, startProcess, type Slice, type SliceWorld } from "./pipeline.js";

after(stopServer);

interface Outcome { readonly labels: readonly string[]; readonly problems: readonly string[]; readonly signature: string; readonly restarted: boolean }

/** One run of the whole path, killed at boundary `crashAt` (or never), then restarted and completed. */
async function runOnce(backend: Backend, crashAt?: number): Promise<Outcome> {
  const world = await backend.open();
  const directory = mkdtempSync(join(tmpdir(), "nn slice-"));
  try {
    const chaos = new Chaos(crashAt);
    const clock = new Clock();
    const sw: SliceWorld = { storage: world.storage, directory, chaos, clock: clock.now };
    let slice: Slice | undefined;
    let restarted = false;
    try {
      slice = await startProcess(sw, "process-1");
      await runPath(slice);
    } catch (error) {
      if (!chaos.crashed) throw error; // only a crash is expected
      if (!(error instanceof Crash) && !(error instanceof Error)) throw error;
    }
    if (chaos.crashed) {
      // The process is gone. Time passes (leases end), a new process starts under a new epoch, and the same path is run again.
      const labels = [...chaos.labels];
      const chaosLabel = labels[labels.length - 1];
      chaos.revive();
      clock.advance(10 * 60_000);
      restarted = true;
      slice = await startProcess(sw, "process-2");
      await runPath(slice);
      return { labels, problems: await check(slice, sw, chaosLabel), signature: await signature(sw), restarted };
    }
    return { labels: [...chaos.labels], problems: await check(slice!, sw), signature: await signature(sw), restarted };
  } finally {
    await world.close();
    rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}

/** Every Nth boundary, always including the first and last. */
const sample = (count: number, stride: number): number[] => [...new Set([...Array.from({ length: Math.ceil(count / stride) }, (_, i) => i * stride), 0, count - 1])].sort((a, b) => a - b);

for (const backend of backends) {
  const full = backend.name === "reference store" || backend.name === "SQLite";
  test(`${backend.name}: the path from a chat command to a worker result survives a crash at ${full ? "every" : "a spread of"} enumerated boundaries`, async () => {
    const clean = await runOnce(backend);
    assert.deepEqual(clean.problems, [], "the uncrashed run is correct");
    assert.equal(clean.restarted, false);
    const boundaries = clean.labels.length;
    assert.ok(boundaries >= 40, `expected a rich set of boundaries, found ${boundaries}`);
    const kinds = new Set(clean.labels.map((l) => l.replace(/ (apply|claim|retry)?.*$/, "").replace(/:.*$/, "")));
    for (const expected of ["before applyOperation", "after applyOperation", "blob", "outside"]) assert.ok([...kinds, ...clean.labels].some((l) => l.startsWith(expected.split(" ")[0]!)), `boundary kind ${expected} is enumerated`);
    const indexes = full ? Array.from({ length: boundaries }, (_, i) => i) : sample(boundaries, 7);
    const failures: string[] = [];
    for (const i of indexes) {
      const outcome = await runOnce(backend, i);
      if (!outcome.restarted) { failures.push(`${i} (${clean.labels[i]}): the crash point was never reached`); continue; }
      if (outcome.problems.length > 0) failures.push(`${i} (${clean.labels[i]}): ${outcome.problems.join("; ")}`);
      else if (outcome.signature !== clean.signature) failures.push(`${i} (${clean.labels[i]}): the recovered state differs from the clean run`);
    }
    assert.deepEqual(failures, [], `${failures.length} of ${indexes.length} crash points failed`);
    console.log(`# slice[${backend.name}]: ${indexes.length} of ${boundaries} boundaries crashed, restarted and verified`);
  });
}
