import assert from "node:assert/strict";
import { test } from "node:test";
import { diagnose, slowest } from "./qa-diagnose.mjs";

const spec = (names) => names.map((n) => `✔ passing (1ms)\n✖ ${n} (12.5ms)\n  AssertionError [ERR_ASSERTION]: boom\n    at x\n`).join("");
const tap = (name) => `ok 1 - fine\nnot ok 2 - ${name}\n  ---\n  error: 'wrong'\n  expected: 1\n  actual: 2\n  ...\n`;

test("each failing test is listed once with the number of runs it failed in, most frequent first", () => {
  const found = diagnose([spec(["A", "B"]), spec(["A"]), spec(["A", "C"])]);
  assert.deepEqual(found.map((f) => [f.name, f.runs]), [["A", 3], ["B", 1], ["C", 1]]);
});

test("TAP output is understood too, and the error lines are kept", () => {
  const [one] = diagnose([tap("a thing")]);
  assert.equal(one.name, "a thing");
  assert.ok(one.detail.some((l) => l.includes("expected: 1")));
});

test("a log with no failures gives nothing", () => {
  assert.deepEqual(diagnose(["ok 1 - fine\n# tests 1\n"]), []);
});

test("the error lines stop at the next test or at the npm error that closes the run", () => {
  const log = "✖ the broken thing (3ms)\n✔ a fine thing (1ms)\n\nℹ tests 2\n\n✖ failing tests:\n\n✖ the broken thing (3ms)\n  AssertionError: boom\n    expected: 1\n    actual: 2\nnpm error Lifecycle script `test` failed\n";
  const [one] = diagnose([log]);
  assert.ok(one.detail.some((l) => l.includes("AssertionError: boom")));
  assert.ok(!one.detail.some((l) => l.includes("npm error")), one.detail.join("|"));
});

test("the slowest tests come out of both spec and TAP output, longest first", () => {
  const spec = "✔ quick (2.5ms)\n✔ the slow one (4200.1ms)\n✖ a failure (900ms)\n";
  assert.deepEqual(slowest(spec, 2), [{ name: "the slow one", ms: 4200.1 }, { name: "a failure", ms: 900 }]);
  const tap = "ok 1 - quick\n  ---\n  duration_ms: 3\n  ...\nok 2 - heavy\n  ---\n  duration_ms: 1500.5\n  type: 'test'\n  ...\n";
  assert.deepEqual(slowest(tap, 1), [{ name: "heavy", ms: 1500.5 }]);
  assert.deepEqual(slowest("nothing here"), []);
});
