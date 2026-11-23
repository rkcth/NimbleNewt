import assert from "node:assert/strict";
import { test } from "node:test";
import { LandingGate, type LandingCheckHost, type LandingCheckHostReport, type QaGateView, type ReviewedSubmission } from "./landing-gate.js";

// Card Q02 review: a verdict or QA evidence carried over from an earlier submission of the same CLAIMED patch counts at landing only when the host computes, from that earlier submission's own base and tree, the same
// patch as the landed submission's. The claimed patch ID is the submitter's word: an earlier submission of other code that named this patch ID gives nothing.
const BASE = "b".repeat(40), TREE = "e".repeat(40), OLD_BASE = "1".repeat(40), OLD_TREE = "d".repeat(40), PATCH = "a".repeat(40), OTHER_PATCH = "c".repeat(40);
const TASK = "tsk-aaaaaaaaaaaaaaaaaaaa", SUB = "sbm-aaaaaaaaaaaaaaaaaaaa", EARLY = "sbm-bbbbbbbbbbbbbbbbbbbb", OTHER = "sbm-cccccccccccccccccccc";
type Call = Parameters<NonNullable<LandingCheckHost["landingChecks"]>>[0];

const carried: ReviewedSubmission = { taskId: TASK, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: "agent:sam", carriedFrom: EARLY };
const own: ReviewedSubmission = { taskId: TASK, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: "agent:sam" };
const qaPassed = (extra: Partial<QaGateView> = {}): QaGateView => ({ taskId: TASK, submissionId: SUB, tree: TREE, verdict: "passed", reasons: [], ...extra });

const run = async (o: { required?: ("review" | "qa")[]; approval: () => ReviewedSubmission; qa?: () => QaGateView; samePatch?: (() => Promise<readonly { submissionId: string; base: string; tree: string }[]>) | null; carriedIds?: (call: Call) => readonly (string | null)[] | undefined }) => {
  const calls: Call[] = [];
  const g = new LandingGate({
    requiredChecks: async () => o.required ?? ["review"],
    tests: async () => undefined,
    approvalOf: async (id) => (id === SUB ? o.approval() : undefined),
    ...(o.qa === undefined ? {} : { qaGate: async () => o.qa!() }),
    ...(o.samePatch === null ? {} : { samePatch: o.samePatch ?? (async () => [{ submissionId: EARLY, base: OLD_BASE, tree: OLD_TREE }]) }),
    now: () => "2026-11-23T10:00:00.000Z",
  });
  const h: LandingCheckHost = { landingChecks: async (call) => {
    calls.push(call);
    const ids = o.carriedIds === undefined ? call.carried?.map(() => PATCH) : o.carriedIds(call);
    return { checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [], ...(call.reviewed === undefined ? {} : { reviewedPatchId: PATCH }), ...(ids === undefined ? {} : { carriedPatchIds: ids }) } as LandingCheckHostReport;
  } };
  const record = await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: h });
  return { g, record, calls };
};

test("a carried approval passes only when the host finds the same patch in the earlier submission's own base and tree; the host is asked for it (card Q02 review)", async () => {
  const ok = await run({ approval: () => carried });
  assert.deepEqual(ok.record.results.map((r) => r.result), ["pass"], JSON.stringify(ok.record.results));
  assert.match(ok.record.results[0]!.summary, new RegExp(`on ${EARLY}, carried over because the host found the same patch`));
  assert.deepEqual(ok.calls[0]!.carried, [{ base: OLD_BASE, tree: OLD_TREE }]);
  // The earlier submission named this patch ID but its own base and tree make another patch: the reviewer saw other code, so nothing carries.
  const lied = await run({ approval: () => carried, carriedIds: () => [OTHER_PATCH] });
  assert.deepEqual([lied.record.passed, lied.record.results[0]!.result], [false, "fail"]);
  assert.match(lied.record.results[0]!.summary, /was given on patch c{12}, not a{12}; a review of this submission is needed/);
  // The host could not compute it, did not answer it, or no reader of the earlier submissions is wired: fail closed.
  for (const o of [{ carriedIds: () => [null] }, { carriedIds: () => undefined }, { samePatch: null }, { samePatch: async () => { throw new Error("storage down"); } }, { samePatch: async () => [{ submissionId: OTHER, base: OLD_BASE, tree: OLD_TREE }] }, { samePatch: async () => [{ submissionId: EARLY, base: "../x", tree: OLD_TREE }] }] as const) {
    const r = await run({ approval: () => carried, ...(o as object) });
    assert.deepEqual([r.record.passed, r.record.results[0]!.result], [false, "fail"], JSON.stringify(o));
    assert.match(r.record.results[0]!.summary, /could not be checked for the same patch/);
  }
  // An approval of the submission's own is judged as before; the earlier submissions do not matter to it.
  const mine = await run({ approval: () => own, carriedIds: () => [OTHER_PATCH] });
  assert.deepEqual(mine.record.results.map((r) => r.result), ["pass"]);
  const noReader = await run({ approval: () => own, samePatch: null });
  assert.deepEqual([noReader.record.results.map((r) => r.result), noReader.calls[0]!.carried], [["pass"], undefined]);
});

test("carried QA evidence passes only when the host finds the same patch in each earlier submission it came from (card Q02 review)", async () => {
  const two = async () => [{ submissionId: EARLY, base: OLD_BASE, tree: OLD_TREE }, { submissionId: OTHER, base: OLD_BASE, tree: "9".repeat(40) }];
  const ok = await run({ required: ["qa"], approval: () => own, qa: () => qaPassed({ carriedFrom: [EARLY, OTHER] }), samePatch: two });
  assert.deepEqual(ok.record.results.map((r) => r.result), ["pass"], JSON.stringify(ok.record.results));
  assert.equal(ok.calls[0]!.carried?.length, 2);
  const one = await run({ required: ["qa"], approval: () => own, qa: () => qaPassed({ carriedFrom: [EARLY, OTHER] }), samePatch: two, carriedIds: () => [PATCH, OTHER_PATCH] });
  assert.deepEqual([one.record.passed, one.record.results[0]!.result], [false, "fail"]);
  assert.match(one.record.results[0]!.summary, new RegExp(`carried over from ${OTHER}, whose own base and tree make a different patch`));
  const unknown = await run({ required: ["qa"], approval: () => own, qa: () => qaPassed({ carriedFrom: [EARLY] }), samePatch: null });
  assert.deepEqual([unknown.record.passed, unknown.record.results[0]!.result], [false, "fail"]);
  assert.match(unknown.record.results[0]!.summary, /could not be checked for the same patch/);
  // Evidence of its own only: as before.
  assert.deepEqual((await run({ required: ["qa"], approval: () => own, qa: () => qaPassed(), samePatch: null })).record.results.map((r) => r.result), ["pass"]);
});

test("read again before the write: an approval that now carries from an earlier submission the host did not check is refused (card Q02 review)", async () => {
  let a: ReviewedSubmission = own;
  const { g, record } = await run({ approval: () => a, samePatch: async () => [] });
  assert.equal(record.passed, true);
  // A review of the submission's own was taken back (none now) and an approval of an earlier copy would carry: it was never checked for this landing.
  a = carried;
  const again = await g.recheck(record);
  assert.deepEqual(again.changed.map((c) => [c.check, c.result]), [["review", "fail"]]);
  assert.equal(again.record.passed, false);
  a = own;
  assert.deepEqual((await g.recheck(record)).changed, []);
});
