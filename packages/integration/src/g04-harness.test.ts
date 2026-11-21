import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { CHILD_DEADLINE_MS, KILLED_AT, killProblem, runChild, type ChildRun, type StoreSpec } from "./g04-fixture.js";

// Card G04, the kill harness itself: every G04 kill file (g04-kill, g04-wait, g04-tool) asks `killProblem` whether a child really died by its own SIGKILL on
// the boundary the uncrashed run numbered, and `runChild` kills a child that never reaches its boundary instead of leaving it to the file's time limit.
// The probe scenarios of g04-child.ts open no database, so the spec below is never read.

const PROBE_SPEC: StoreSpec = { kind: "sqlite", path: "unused" };
const LABELS = ["probe 0", "probe 1", "probe 2"];

function withDir<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), "g04h-"));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

test("a real child killed at its boundary by its own SIGKILL counts as the kill, and only on the label the uncrashed run numbered", async () => {
  const child = await withDir((dir) => runChild(PROBE_SPEC, dir, 2, "probe-kill"));
  assert.equal(child.killed, true, child.err);
  assert.equal(child.hung, false);
  assert.ok(child.err.includes(`${KILLED_AT}"probe 2"\n`), child.err);
  assert.equal(killProblem(child, LABELS, 2, "2 probe 2"), undefined);
  // The same death read against an uncrashed run whose boundary 2 is another step: the kill landed elsewhere.
  assert.match(killProblem(child, ["probe 0", "probe 1", "probe 2 moved"], 2, "2 x") ?? "", /^2 x: the child died elsewhere/);
  // And against the boundary before it (a child one step ahead of the uncrashed run).
  assert.match(killProblem(child, LABELS, 1, "1 x") ?? "", /^1 x: the child died elsewhere/);
  // A boundary the uncrashed run never reached.
  assert.match(killProblem(child, LABELS, 3, "3 x") ?? "", /^3 x: the child died elsewhere/);
});

test("a child that never reaches its boundary is killed by the parent at the deadline and reported as hung, never as killed", async () => {
  const started = Date.now();
  const child = await withDir((dir) => runChild(PROBE_SPEC, dir, 0, "probe-hang", 1_000));
  assert.equal(child.hung, true);
  assert.equal(child.killed, false, "the parent's SIGKILL is not the child's own");
  // Ended by the deadline, far inside the default one (the probe would otherwise run until the file's time limit).
  assert.ok(Date.now() - started < CHILD_DEADLINE_MS, `ended after ${Date.now() - started} ms`);
  assert.match(killProblem(child, LABELS, 0, "0 probe 0") ?? "", /^0 probe 0: the child hung, it did not reach its boundary and was killed by the parent/);
});

test("the deadline sits under the integration package's 300 s file limit, with room for a child's normal run", () => {
  assert.ok(CHILD_DEADLINE_MS >= 60_000 && CHILD_DEADLINE_MS <= 150_000, String(CHILD_DEADLINE_MS));
});

test("killProblem: a child that finished, exited by itself, or died without saying where is not a kill at the boundary", () => {
  const run = (over: Partial<ChildRun>): ChildRun => ({ killed: true, hung: false, out: "", err: `${KILLED_AT}"probe 1"\n`, ...over });
  assert.equal(killProblem(run({}), LABELS, 1, "1"), undefined);
  assert.match(killProblem(run({ out: "finished\n" }), LABELS, 1, "1") ?? "", /^1: the child was not killed/);
  assert.match(killProblem(run({ killed: false, err: " exit 1" }), LABELS, 1, "1") ?? "", /^1: the child was not killed/);
  assert.match(killProblem(run({ err: "" }), LABELS, 1, "1") ?? "", /^1: the child died elsewhere/);
  // The label is matched whole: "probe 1" is not found in a report of "probe 10" (the JSON quotes and the newline bound it).
  assert.match(killProblem(run({ err: `${KILLED_AT}"probe 10"\n` }), [...LABELS], 1, "1") ?? "", /^1: the child died elsewhere/);
  // Hung wins over everything else: a hung child that had also printed a label is still hung.
  assert.match(killProblem(run({ hung: true, killed: false }), LABELS, 1, "1") ?? "", /^1: the child hung/);
});
