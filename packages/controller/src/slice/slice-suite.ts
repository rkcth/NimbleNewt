import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { backends, stopServer, type Backend } from "../domain/testing/backends.js";
import { Chaos, Crash } from "./chaos.js";
import { Clock, check, runPath, signature, startProcess, type Slice, type SliceWorld } from "./pipeline.js";


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

const GROUP = 15;

/** A crash run that takes more than this is treated as hung, so a hang is reported as a failure naming the boundary instead of as a silent timeout of the whole file. */
const RUN_LIMIT_MS = 120_000;
async function withWatchdog<T>(work: Promise<T>, what: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([work, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`${what} did not finish within ${RUN_LIMIT_MS / 1000} s: a hang, not just a slow run`)), RUN_LIMIT_MS); })]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}

/** Every Nth boundary, always including the first and last. */
const sample = (count: number, stride: number): number[] => [...new Set([...Array.from({ length: Math.ceil(count / stride) }, (_, i) => i * stride), 0, count - 1])].sort((a, b) => a - b);

const BOUNDARIES = 129;

/**
 * Which crash points a test file runs: all of them, one half of them, or a spread of them. A test file is itself bound by the package's per-file limit (600 s; it was 300 s) on
 * Node 22 (on Node 24 the limit is per test), and Windows runners are several times slower than Linux, so the work is divided among files; every
 * boundary of the full backends is still crashed by exactly one file.
 */
export type Share = "all" | "first half" | "second half" | "a spread";

/** Declares the tests of one backend's share of the crash enumeration. Call it at the top level of a test file. */
export function defineSliceTests(backendName: string, share: Share): void {
  const backend = backends.find((b) => b.name === backendName);
  if (backend === undefined) throw new Error(`no backend named ${backendName}`);
  after(stopServer);
  const full = share !== "a spread";
  // The clean run (which also counts the boundaries) is done once and shared by the tests of this file.
  let clean: Promise<Outcome> | undefined;
  const cleanRun = (): Promise<Outcome> => (clean ??= runOnce(backend));

  test(`${backend.name}: the uncrashed path is correct and exposes a rich set of boundaries`, async () => {
    const outcome = await cleanRun();
    assert.deepEqual(outcome.problems, [], "the uncrashed run is correct");
    assert.equal(outcome.restarted, false);
    assert.equal(outcome.labels.length, BOUNDARIES, "the path's boundaries changed: update BOUNDARIES");
    for (const expected of ["before applyOperation", "after applyOperation", "blob", "outside", "bridge", "conversation"]) assert.ok(outcome.labels.some((l) => l.startsWith(expected)), `boundary kind ${expected} is enumerated`);
  });

  const all = Array.from({ length: BOUNDARIES }, (_, i) => i);
  const indexes = share === "a spread" ? sample(BOUNDARIES, 7) : share === "first half" ? all.slice(0, 65) : share === "second half" ? all.slice(65) : all;
  for (let start = 0; start < indexes.length; start += GROUP) {
    const group = indexes.slice(start, start + GROUP);
    test(`${backend.name}: the path survives a crash at ${full ? "each of" : "a spread of"} the boundaries ${group[0]} to ${group[group.length - 1]} (${group.length})`, async () => {
      const reference = await cleanRun();
      assert.equal(reference.labels.length, BOUNDARIES, "the clean run did not produce the expected boundaries");
      const failures: string[] = [];
      for (const i of group) {
        const outcome = await withWatchdog(runOnce(backend, i), `boundary ${i} (${reference.labels[i]}) on ${backend.name}`);
        if (!outcome.restarted) { failures.push(`${i} (${reference.labels[i]}): the crash point was never reached`); continue; }
        if (outcome.problems.length > 0) failures.push(`${i} (${reference.labels[i]}): ${outcome.problems.join("; ")}`);
        else if (outcome.signature !== reference.signature) failures.push(`${i} (${reference.labels[i]}): the recovered state differs from the clean run`);
      }
      assert.deepEqual(failures, [], `${failures.length} of ${group.length} crash points failed`);
      console.log(`# slice[${backend.name}]: boundaries ${group[0]}-${group[group.length - 1]}: ${group.length} crashed, restarted and verified`);
    });
  }
}
