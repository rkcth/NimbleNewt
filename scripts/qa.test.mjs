import assert from "node:assert/strict";
import { test } from "node:test";
import { crossRunProblems, judgeRun, markers, parseTotals, renderSummary } from "./qa.mjs";

const spec = (n, pass, fail = 0) => `ℹ tests ${n}\nℹ suites 3\nℹ pass ${pass}\nℹ fail ${fail}\nℹ cancelled 0\nℹ skipped 0\nℹ todo 0\n`;

test("totals are summed over every package's summary block, in spec and TAP format", () => {
  const totals = parseTotals(`${spec(23, 23)}noise\n${spec(120, 119, 1)}# tests 2\n# pass 2\n# fail 0\n# cancelled 0\n`);
  assert.deepEqual(totals, { tests: 145, pass: 144, fail: 1, cancelled: 0, skipped: 0, todo: 0, blocks: 3 });
  assert.equal(parseTotals("no summary here").tests, 0);
  assert.equal(parseTotals("  ℹ tests 5 extra").tests, 0, "only a summary line counts");
});

test("the gate messages and the platform line are picked out of the log", () => {
  const found = markers("package boundaries ok\nlicense inventory ok\n# Subtest: G02 environment: the exact pin\nok 6 - G02 environment: the exact pin\n# G02 environment: linux/x64 node 22.19.0 pi-durable 1.3.0\n");
  assert.deepEqual(found, { packageBoundaries: "package boundaries ok", licenseInventory: "license inventory ok", g02Environment: "# G02 environment: linux/x64 node 22.19.0 pi-durable 1.3.0" });
  assert.deepEqual(markers("nothing"), { packageBoundaries: null, licenseInventory: null, g02Environment: null });
});

test("a run passes only when it exits 0, ran tests, had no failures and changed nothing", () => {
  const good = { exitCode: 0, totals: parseTotals(spec(10, 10)), lockfileBefore: "a", lockfileAfter: "a", dirtyBefore: " M kept.txt", dirtyAfter: " M kept.txt" };
  assert.deepEqual(judgeRun(good), []);
  assert.match(judgeRun({ ...good, exitCode: 1 })[0], /exited with 1/);
  assert.match(judgeRun({ ...good, totals: parseTotals("") })[0], /no test totals/);
  assert.match(judgeRun({ ...good, totals: parseTotals(spec(10, 9, 1)) }).join(), /1 tests failed/);
  assert.match(judgeRun({ ...good, totals: { ...good.totals, cancelled: 2 } }).join(), /2 tests were cancelled/);
  assert.match(judgeRun({ ...good, lockfileAfter: "b" }).join(), /package-lock\.json changed/);
  assert.match(judgeRun({ ...good, dirtyAfter: " M kept.txt\n M src/a.ts" }).join(), /tracked files differ.*src\/a\.ts/);
  assert.equal(judgeRun({ ...good, exitCode: 1, dirtyAfter: " M x", lockfileAfter: "b" }).length, 3, "every problem is reported");
});

test("the summary states the verdict, names failing runs, and says it is not an acceptance", () => {
  const run = (n, passed) => ({ run: n, passed, seconds: 1.5, totals: parseTotals(spec(10, passed ? 10 : 9, passed ? 0 : 1)), markers: { g02Environment: "G02 environment: x" }, problems: passed ? [] : ["1 tests failed"] });
  const environment = { os: "Linux 6", arch: "x64", node: "v22.19.0", pathHasSpace: true, workingTreeClean: true };
  const bad = renderSummary({ commit: "abc", environment, runs: [run(1, true), run(2, false)], passed: false });
  assert.match(bad, /1 of 2 runs FAILED/);
  assert.match(bad, /\| 2 \| FAIL \|/);
  assert.match(bad, /path contains a space: yes/);
  assert.match(bad, /not an acceptance/);
  assert.match(renderSummary({ commit: "abc", environment, runs: [run(1, true)], passed: true }), /all 1 runs passed/);
});

test("runs on one machine must report the same number of tests and packages", () => {
  const r = (run, tests, blocks) => ({ run, totals: { tests, blocks } });
  assert.deepEqual(crossRunProblems([r(1, 757, 5), r(2, 757, 5)]), []);
  assert.deepEqual(crossRunProblems([r(1, 757, 5), r(2, 700, 4), r(3, 757, 5)]), ["run 2 had 700 tests in 4 packages, run 1 had 757 tests in 5 packages"]);
  assert.deepEqual(crossRunProblems([]), []);
  const environment = { os: "Linux 6", arch: "x64", node: "v22", pathHasSpace: false, workingTreeClean: true };
  const run = { run: 1, passed: true, seconds: 1, totals: parseTotals(spec(1, 1)), markers: {}, problems: [] };
  const text = renderSummary({ commit: "abc", environment, runs: [run], passed: false, crossRunProblems: ["run 2 differs"] });
  assert.match(text, /not consistent/);
  assert.match(text, /Inconsistent: run 2 differs\./);
});
