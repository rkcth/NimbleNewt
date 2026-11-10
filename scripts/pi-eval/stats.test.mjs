// Tests for the bench's aggregation, Wilson intervals and release gates.
import assert from "node:assert/strict";
import { test } from "node:test";
import { aggregate, gatesFor, renderReport, wilson } from "./lib/stats.mjs";

const close = (a, b, eps = 1e-4) => assert.ok(Math.abs(a - b) < eps, `${a} vs ${b}`);

test("Wilson 95% intervals match published values", () => {
  const a = wilson(9, 10);
  close(a.low, 0.5958); close(a.high, 0.9821);
  const b = wilson(0, 10);
  close(b.low, 0); close(b.high, 0.2775);
  const c = wilson(10, 10);
  close(c.low, 0.7225); close(c.high, 1);
  assert.deepEqual(wilson(0, 0), { low: 0, high: 1, p: null });
  assert.throws(() => wilson(3, 2), RangeError);
});

const runs = (variant, size, outcomes) => Object.entries(outcomes).flatMap(([outcome, n]) => Array.from({ length: n }, () => ({ variant, size, outcome, wallMs: 60_000 })));

test("results are grouped per variant and size with every outcome counted", () => {
  const g = aggregate([...runs("A", "S", { "verified-finish": 3, "stopped-early": 1 }), ...runs("B", "S", { empty: 1 }), { variant: "A", size: "S", outcome: "made-up" }]);
  assert.equal(g.length, 2);
  const a = g.find((x) => x.variant === "A");
  assert.equal(a.n, 5);
  assert.equal(a.counts["verified-finish"], 3);
  assert.equal(a.counts.unclassified, 1, "an outcome the bench does not know counts as unclassified");
});

test("the gates pass only at >=90% S, >=85% M, >=70% L, false done <=5% and no unclassified run", () => {
  const good = [...runs("A", "S", { "verified-finish": 19, "stopped-early": 1 }), ...runs("A", "M", { "verified-finish": 17, length: 3 }), ...runs("A", "L", { "verified-finish": 14, timeout: 6 })];
  const ok = gatesFor("A", aggregate(good));
  assert.equal(ok.pass, true, ok.failures.join("; "));
  // Two more stops in S take it under 90 % (19 of 22).
  const lowS = gatesFor("A", aggregate([...good, ...runs("A", "S", { "stopped-early": 2 })]));
  assert.equal(lowS.pass, false);
  assert.match(lowS.failures.join(), /S: verified finish/);
  // Four false dones in 64 runs is over 5 %.
  const wrong = gatesFor("A", aggregate([...good, ...runs("A", "L", { wrong: 4 })]));
  assert.equal(wrong.pass, false);
  assert.match(wrong.failures.join(), /false done/);
  // One unclassified run fails the variant, whatever its rates.
  const unc = gatesFor("A", aggregate([...good, ...runs("A", "S", { unclassified: 1 })]));
  assert.equal(unc.pass, false);
  assert.match(unc.failures.join(), /unclassified/);
  // A size with no runs is not measured, and that fails.
  const noL = gatesFor("A", aggregate(good.filter((r) => r.size !== "L")));
  assert.equal(noL.pass, false);
  assert.match(noL.failures.join(), /L: not measured/);
});

test("the report has a table row per variant and size, each variant's gates and one result line", () => {
  const recs = [...runs("A", "S", { "verified-finish": 1, "stopped-early": 1 }), ...runs("B", "S", { "verified-finish": 2 })];
  const r = renderReport(recs);
  assert.match(r.text, /\| A +\| S +\| 1 +\| 2 +\| 1 \(50\.0%\)/, "tasks, then runs");
  assert.match(r.text, /\| B +\| S +\| 1 +\| 2 +\| 2 \(100\.0%\)/);
  assert.match(r.text, /not independent samples/);
  assert.match(r.text, /## Variant A[\s\S]*FAIL: .*M: not measured/);
  assert.match(r.text, /RESULT: FAIL \(A fail, B fail\)$/);
  assert.equal(r.pass, false);
  assert.match(renderReport([]).text, /RESULT: no runs/);
});

test("an interface mismatch is a non-finish but not a false done, and the shipped-wording score is shown without gating", async () => {
  const { renderReport, gatesFor, aggregate } = await import("./lib/stats.mjs");
  const recs = [
    { variant: "A", size: "S", taskId: "t", outcome: "interface-mismatch", shipped: { passed: false } },
    { variant: "A", size: "S", taskId: "t", outcome: "verified-finish", shipped: { passed: false } },
  ];
  const g = gatesFor("A", aggregate(recs));
  assert.ok(g.lines.some((l) => /^false done 0\/2/.test(l)), g.lines.join("\n"));
  assert.ok(g.lines.some((l) => /^S verified finish 1\/2/.test(l)));
  const text = renderReport(recs).text;
  assert.match(text, /matches shipped wording \(informational, not a gate\): 0\/2/);
  assert.match(text, /interface mismatch .*1 run\(s\)/);
});
