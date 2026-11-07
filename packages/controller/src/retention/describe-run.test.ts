import assert from "node:assert/strict";
import { test } from "node:test";
import { describeRun, type RunReport } from "./service.js";

const held = (n: number) => Array.from({ length: n }, (_, i) => ({ kind: "summary-record", id: `s-${i}`, reasons: ["held"] }));
const report = (extra: Partial<RunReport>): RunReport => ({ dryRun: false, enabled: true, derivedDays: 7, candidates: [], removed: 0, retained: [], partial: false, ...extra } as RunReport);

test("the kept number says 'or more' when a list of held material was cut at its limit, and counts held records and held versions together (card T02c review)", () => {
  const few = describeRun(report({ retained: held(3), catalogVersions: { keep: 1, candidates: [], retained: [{ name: "a", version: "1.0.0", reasons: ["x"] }], removed: 0, partial: false } }));
  assert.match(few, /; 4 kept because something still needs them/);
  assert.doesNotMatch(few, /or more/);
  assert.match(describeRun(report({ retained: held(200) })), /; 200 or more kept because/);
  const versions = Array.from({ length: 200 }, (_, i) => ({ name: "a", version: `1.0.${i}`, reasons: ["x"] }));
  assert.match(describeRun(report({ dryRun: true, digest: "d", retained: held(5), catalogVersions: { keep: 1, candidates: [], retained: versions, removed: 0, partial: false } })), /205 or more kept because/);
});
