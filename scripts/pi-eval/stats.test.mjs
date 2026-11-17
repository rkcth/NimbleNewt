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

test("an interface mismatch is a non-finish that counts in the false-done gate, and the shipped-wording score is shown without gating", async () => {
  const { renderReport, gatesFor, aggregate } = await import("./lib/stats.mjs");
  const recs = [
    { variant: "A", size: "S", taskId: "t", outcome: "interface-mismatch", shipped: { passed: false } },
    { variant: "A", size: "S", taskId: "t", outcome: "verified-finish", shipped: { passed: false } },
  ];
  const g = gatesFor("A", aggregate(recs));
  assert.ok(g.lines.some((l) => /^false done 1\/2/.test(l)), g.lines.join("\n"));
  assert.ok(g.lines.some((l) => /^S verified finish 1\/2/.test(l)));
  const text = renderReport(recs).text;
  assert.match(text, /matches shipped wording \(informational, not a gate\): 0\/2/);
  assert.match(text, /interface mismatch .*1 run\(s\)/);
});

test("the report counts timeouts whose acceptance tests pass, and warns when variant B mixes the pre-W06 and W06 prompts", () => {
  const late = { variant: "A", size: "S", outcome: "timeout", wallMs: 1, hidden: { passed: true } };
  const stuck = { variant: "A", size: "S", outcome: "timeout", wallMs: 1, hidden: { passed: false } };
  const r = renderReport([late, late, stuck, ...runs("A", "S", { "verified-finish": 1 })]);
  assert.match(r.text, /timeouts whose acceptance tests pass at the limit \(the work was done, the agent did not end\): 2 of 3/);
  assert.equal(r.groups[0].counts.timeout, 3, "still non-finishes");
  assert.doesNotMatch(renderReport(runs("A", "S", { "verified-finish": 1 })).text, /timeouts whose/, "no line without a timeout");
  const old = { variant: "B", size: "S", outcome: "verified-finish", wallMs: 1 };
  const w06 = { ...old, completionRules: { sha256: "ab", chars: 10 } };
  assert.match(renderReport([old, w06]).text, /WARNING: variant B mixes two prompts: 1 run\(s\) before card W06 .* and 1 with the W06 completion rules/);
  assert.doesNotMatch(renderReport([w06, w06]).text, /mixes two prompts/);
  assert.doesNotMatch(renderReport([old, old]).text, /mixes two prompts/);
  // An interface mismatch is reported as counted in the false-done gate, as gatesFor counts it.
  assert.match(renderReport([{ variant: "A", size: "S", outcome: "interface-mismatch", wallMs: 1 }]).text, /false done 1\/1[\s\S]*counted as non-finishes and in the false-done gate/);
});

test("a contaminated run is never a verified finish: it is left out of the table and the gates, and the report says so", async () => {
  // Enough clean verified finishes to pass every gate; one more run that "finished" but tried to push.
  const good = [...runs("A", "S", { "verified-finish": 10 }), ...runs("A", "M", { "verified-finish": 10 }), ...runs("A", "L", { "verified-finish": 10 })];
  const pushed = { variant: "A", size: "S", outcome: "verified-finish", wallMs: 1, contaminated: true, runId: "t-A-r9", credentialAttempts: ["push", "remote"], guardRefusals: 2, foreignPaths: [] };
  const s = aggregate([...good, pushed]).find((g) => g.size === "S");
  assert.equal(s.n, 10);
  assert.equal(s.counts["verified-finish"], 10);
  const text = renderReport([...good, pushed]).text;
  assert.match(text, /31 run\(s\), 1 of them contaminated and left out of the table and the gates \(t-A-r9\)/);
  assert.match(text, /contaminated \(left out, never a finish\): 1 run\(s\), 1 of them otherwise a verified finish; kinds: push, remote, git refused/);
  // Only contaminated "finishes": the variant is not measured, and fails.
  const only = renderReport([pushed, { ...pushed, size: "M" }, { ...pushed, size: "L" }]);
  assert.equal(only.pass, false);
  assert.match(only.text, /S verified finish: not measured/);
  // The comparison of agents: shown as C, never counted a finish.
  const { compare } = await import("./compare.mjs");
  const c = compare([{ ...pushed, taskId: "t", agent: "pi" }, { ...pushed, taskId: "t", agent: "pi", contaminated: false }]);
  assert.equal(c.totals[0].finish, 1);
  assert.equal(c.totals[0].contaminated, 1);
  assert.match(c.table[0].at(-1), /^1\/2 CF$/);
  // Every outcome of a contaminated run is left out of the gates and of the informational lines: a false done, an
  // interface mismatch, a timeout whose tests pass, a shipped-tests pass.
  const dirtyKinds = [
    { ...pushed, outcome: "wrong" }, { ...pushed, outcome: "interface-mismatch" }, { ...pushed, outcome: "timeout", hidden: { passed: true } },
    { ...pushed, outcome: "stopped-early" }, { ...pushed, outcome: "unclassified" }, { ...pushed, size: "?" }, { ...pushed, shipped: { passed: true } },
  ];
  const mixed = renderReport([...good, ...dirtyKinds]);
  assert.equal(mixed.pass, true, mixed.text);
  assert.match(mixed.text, /false done 0\/30/);
  assert.match(mixed.text, /unclassified non-finishes 0 gate = 0: ok/);
  assert.doesNotMatch(mixed.text, /interface mismatch \(said done|timeouts whose acceptance tests pass|matches shipped wording/);
  assert.match(mixed.text, /contaminated \(left out, never a finish\): 7 run\(s\)/);
  const totals = compare(dirtyKinds.map((r) => ({ ...r, taskId: "t", agent: "pi" }))).totals[0];
  assert.deepEqual([totals.finish, totals.wrong, totals.mismatch, totals.other, totals.contaminated], [0, 0, 0, 0, 7]);
});
