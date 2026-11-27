import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "../policy/integration-policy.js";
import { LandingGate, type DirectorGateView, type DocsGateView, type LandingCheckHost, type LandingCheckHostReport, type QaGateView, type ReviewedSubmission } from "./landing-gate.js";

// Card P08 landing re-check: git's patch ID leaves out line numbers, so on the SAME base two different trees can have the same patch ID (the same edit placed in either of two identical blocks of a file; shown with real
// git in worker/workspace/landing-checks-recheck.test.ts). A judgement given on one tree counts for another by patch ID only across a refresh or re-apply onto another base; on the same base the tree must be the same.
const BASE = "b".repeat(40), TREE = "e".repeat(40), OLD_BASE = "1".repeat(40), OTHER_TREE = "d".repeat(40), PATCH = "a".repeat(40);
const TASK = "tsk-aaaaaaaaaaaaaaaaaaaa", SUB = "sbm-aaaaaaaaaaaaaaaaaaaa", EARLY = "sbm-bbbbbbbbbbbbbbbbbbbb";
type Call = Parameters<NonNullable<LandingCheckHost["landingChecks"]>>[0];
type Side = { base: string; tree: string };

const own = (s: Side): ReviewedSubmission => ({ taskId: TASK, base: s.base, tree: s.tree, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: "agent:sam" });

/**
 * One landing judged: the landed change is `landed`; the submission is `sub`; an optional earlier submission `early` the verdict or the QA evidence came from. Every patch ID the host computes is PATCH. The host's replay
 * proof (first review) is the tree compared on the same base; on another base it is `shown` (for `sub`) and `earlyShown` (for `early`), both true unless said, as for a real refresh; `null` models a git that failed.
 */
const run = async (o: { required: Check[]; landed: Side; sub: Side; early?: Side; carryReview?: boolean; carryQa?: boolean; shown?: boolean | null; earlyShown?: boolean | null }) => {
  const proof = (s: Side, shown: boolean | null | undefined): boolean | null => (s.base === o.landed.base ? s.tree === o.landed.tree : shown === undefined ? true : shown);
  const approval: ReviewedSubmission = { ...own(o.sub), ...(o.carryReview === true ? { carriedFrom: EARLY } : {}) };
  const qa: QaGateView = { taskId: TASK, submissionId: SUB, tree: o.sub.tree, verdict: "passed", reasons: [], ...(o.carryQa === true ? { carriedFrom: [EARLY] } : {}) };
  const docs: DocsGateView = { taskId: TASK, submissionId: SUB, tree: o.sub.tree, checked: 1, pending: [] };
  const director: DirectorGateView = { taskId: TASK, submissionId: SUB, tree: o.sub.tree, signoff: { newest: "approve", by: "agent:dir", signoffId: "sbm-dddddddddddddddddddd" } };
  const g = new LandingGate({
    requiredChecks: async () => o.required,
    tests: async () => undefined,
    approvalOf: async (id) => (id === SUB ? approval : undefined),
    qaGate: async () => qa,
    docsGate: async () => docs,
    directorGate: async () => director,
    samePatch: async () => (o.early === undefined ? [] : [{ submissionId: EARLY, ...o.early }]),
    now: () => "2026-11-26T10:00:00.000Z",
  });
  const calls: Call[] = [];
  const h: LandingCheckHost = { landingChecks: async (call) => {
    calls.push(call);
    return { checkout: true, change: { base: o.landed.base, head: "f".repeat(40), tree: o.landed.tree, patchId: PATCH }, checks: [], ...(call.reviewed === undefined ? {} : { reviewedPatchId: PATCH, reviewedReplays: proof(call.reviewed, o.shown) }), ...(call.carried === undefined ? {} : { carriedPatchIds: call.carried.map(() => PATCH), carriedReplays: call.carried.map((c) => proof(c, o.earlyShown)) }) } as LandingCheckHostReport;
  } };
  const record = await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: h });
  return { g, record, calls };
};

test("each judged check refuses a different tree on the same base although the patch ID matches, says why, and marks it; the same tree, or a refresh onto another base, still passes (card P08 landing re-check)", async () => {
  const needed: Record<string, RegExp> = {
    review: /^sbm-a+ was approved for tree d{12}, but the landing carries tree e{12} on the same base b{12}; on one base only the same tree counts, not the same patch ID, so a new submission and review are needed$/,
    qa: /^the QA evidence of sbm-a+ is for tree d{12}, but the landing carries tree e{12} on the same base b{12};.* so new QA evidence is needed$/,
    docs: /^the documents were verified against sbm-a+, tree d{12}, but the landing carries tree e{12} on the same base b{12};.* so the documents must be verified against the landed code$/,
    director: /^the director signed off sbm-a+ for tree d{12}, but the landing carries tree e{12} on the same base b{12};.* so a new director sign-off is needed$/,
  };
  for (const check of ["review", "qa", "docs", "director"] as const) {
    const placed = await run({ required: [check], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: OTHER_TREE } });
    assert.equal(placed.record.passed, false, check);
    const e = placed.record.results[0]!;
    assert.deepEqual([e.check, e.result, e.treeMismatch, e.boundTo], [check, "fail", true, TREE], check);
    assert.match(e.summary, needed[check]!, check);
    assert.ok(e.summary.length <= 300);
    // The host computed the patch ID from the submission's own base and tree, as before: the refusal is not for want of that.
    assert.deepEqual(placed.calls[0]!.reviewed, { base: BASE, tree: OTHER_TREE }, check);
    const same = await run({ required: [check], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: TREE } });
    assert.deepEqual([same.record.passed, same.record.results[0]!.treeMismatch], [true, undefined], check);
    const refreshed = await run({ required: [check], landed: { base: BASE, tree: TREE }, sub: { base: OLD_BASE, tree: OTHER_TREE } });
    assert.deepEqual([refreshed.record.passed, refreshed.record.results[0]!.treeMismatch], [true, undefined], `${check} after a refresh`);
    assert.match(refreshed.record.results[0]!.summary, /carried over to this tree because the patch is unchanged/, check);
  }
});

test("a verdict carried from an earlier submission (card Q02) on the same base as this submission or as the landed change counts only for that very tree; across a refresh the patch ID carries it (card P08 landing re-check)", async () => {
  // The earlier submission was approved as tree d on base b; this one is tree e on base b with the same patch ID: no refresh happened between them, so the approval is not this submission's.
  const placed = await run({ required: ["review"], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: TREE }, early: { base: BASE, tree: OTHER_TREE }, carryReview: true });
  assert.deepEqual([placed.record.passed, placed.record.results[0]!.result, placed.record.results[0]!.treeMismatch], [false, "fail", true]);
  assert.match(placed.record.results[0]!.summary, /^sbm-a+ has no review of its own; the approval of sbm-b+ was given for tree d{12}, but this one is tree e{12} on the same base b{12};.* a review of this submission is needed$/);
  // The earlier submission and this one are different trees on one base, and the landing was re-applied onto a newer base (so it differs from both by base): the approval is still not this submission's.
  const reapplied = await run({ required: ["review"], landed: { base: "2".repeat(40), tree: "3".repeat(40) }, sub: { base: BASE, tree: TREE }, early: { base: BASE, tree: OTHER_TREE }, carryReview: true });
  assert.deepEqual([reapplied.record.results[0]!.result, reapplied.record.results[0]!.treeMismatch], ["fail", true]);
  assert.match(reapplied.record.results[0]!.summary, /given for tree d{12}, but this one is tree e{12} on the same base b{12}/);
  // The landed change is on the earlier submission's own base with another tree (a landing without a queue carries whatever the checkout committed): the approval is compared with the landed change too.
  const atLanding = await run({ required: ["review"], landed: { base: OLD_BASE, tree: TREE }, sub: { base: BASE, tree: "9".repeat(40) }, early: { base: OLD_BASE, tree: OTHER_TREE }, carryReview: true });
  assert.deepEqual([atLanding.record.results[0]!.result, atLanding.record.results[0]!.treeMismatch], ["fail", true]);
  assert.match(atLanding.record.results[0]!.summary, /given for tree d{12}, but the landing carries tree e{12} on the same base 1{12}/);
  // A real refresh: the earlier submission on base 1, this one on base b: the patch ID carries the approval as before.
  const refreshed = await run({ required: ["review"], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: TREE }, early: { base: OLD_BASE, tree: OTHER_TREE }, carryReview: true });
  assert.deepEqual(refreshed.record.results.map((r) => [r.result, r.treeMismatch]), [["pass", undefined]], JSON.stringify(refreshed.record.results));
  // The very same tree and base (a resubmission of the identical work) carries it too.
  const identical = await run({ required: ["review"], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: TREE }, early: { base: BASE, tree: TREE }, carryReview: true });
  assert.equal(identical.record.passed, true);
});

test("QA evidence carried from an earlier submission on the same base counts only for that very tree; across a refresh it carries (card P08 landing re-check)", async () => {
  const placed = await run({ required: ["qa"], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: TREE }, early: { base: BASE, tree: OTHER_TREE }, carryQa: true });
  assert.deepEqual([placed.record.results[0]!.result, placed.record.results[0]!.treeMismatch], ["fail", true]);
  assert.match(placed.record.results[0]!.summary, /^QA evidence of sbm-a+ came from sbm-b+, tree d{12}, but this one is tree e{12} on the same base b{12};.* new QA evidence on this submission is needed$/);
  const refreshed = await run({ required: ["qa"], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: TREE }, early: { base: OLD_BASE, tree: OTHER_TREE }, carryQa: true });
  assert.equal(refreshed.record.passed, true, JSON.stringify(refreshed.record.results));
});

test("read again right before the write, a refused tree stays refused and a passing one stays passing; nothing on the host is asked again (card P08 landing re-check)", async () => {
  const ok = await run({ required: ["review", "qa", "docs", "director"], landed: { base: BASE, tree: TREE }, sub: { base: OLD_BASE, tree: OTHER_TREE } });
  assert.equal(ok.record.passed, true, JSON.stringify(ok.record.results));
  const again = await ok.g.recheck(ok.record);
  assert.deepEqual([again.changed.length, again.record.passed, ok.calls.length], [0, true, 1]);
  const placed = await run({ required: ["review", "qa", "docs", "director"], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: OTHER_TREE } });
  assert.deepEqual(placed.record.results.map((r) => r.treeMismatch), [true, true, true, true]);
});

test("on another base the patch ID alone carries nothing: each judged check passes only when the host shows the landed tree is exactly the judged change carried onto that base (card P08 landing re-check, first review)", async () => {
  const needed: Record<string, RegExp> = {
    review: /^sbm-a+ was approved for tree d{12} on base 1{12}; the landing's tree e{12} on base b{12} was not shown to be exactly that change carried onto it, so a new submission and review are needed$/,
    qa: /^the QA evidence of sbm-a+ is for tree d{12} on base 1{12};.* so new QA evidence is needed$/,
    docs: /^the documents were verified against sbm-a+, tree d{12} on base 1{12};.* so the documents must be verified against the landed code$/,
    director: /^the director signed off sbm-a+ for tree d{12} on base 1{12};.* so a new director sign-off is needed$/,
  };
  for (const check of ["review", "qa", "docs", "director"] as const) {
    for (const shown of [false, null]) {
      const moved = await run({ required: [check], landed: { base: BASE, tree: TREE }, sub: { base: OLD_BASE, tree: OTHER_TREE }, shown });
      const e = moved.record.results[0]!;
      assert.deepEqual([moved.record.passed, e.result, e.treeMismatch], [false, "fail", true], `${check} ${String(shown)}`);
      assert.match(e.summary, needed[check]!, check);
      assert.ok(e.summary.length <= 300, check);
    }
    // The host was asked about the submission's own base and tree, and it said yes: the judgement carries.
    const shown = await run({ required: [check], landed: { base: BASE, tree: TREE }, sub: { base: OLD_BASE, tree: OTHER_TREE }, shown: true });
    assert.equal(shown.record.passed, true, check);
    assert.deepEqual(shown.calls[0]!.reviewed, { base: OLD_BASE, tree: OTHER_TREE }, check);
  }
  // A host that does not report the proof at all (an older host) shows nothing: refused, as not shown.
  const g = new LandingGate({ requiredChecks: async () => ["review"], tests: async () => undefined, approvalOf: async () => own({ base: OLD_BASE, tree: OTHER_TREE }), now: () => "2026-11-26T10:00:00.000Z" });
  const old = await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: { landingChecks: async () => ({ checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [], reviewedPatchId: PATCH }) } });
  assert.deepEqual([old.passed, old.results[0]!.treeMismatch], [false, true]);
});

test("a verdict or QA evidence carried from an earlier submission on another base counts only when the host shows the landed tree is exactly that submission's change carried onto the landed base (card P08 landing re-check, first review)", async () => {
  // The approved earlier submission on base 1, this one on base b (the author refreshed and placed the same edit elsewhere: the same patch ID). The host shows this submission is what lands, but not the earlier one's change.
  const review = await run({ required: ["review"], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: TREE }, early: { base: OLD_BASE, tree: OTHER_TREE }, carryReview: true, earlyShown: false });
  assert.deepEqual([review.record.results[0]!.result, review.record.results[0]!.treeMismatch], ["fail", true]);
  assert.match(review.record.results[0]!.summary, /^sbm-a+ has no review of its own; the approval of sbm-b+ was given for tree d{12} on base 1{12}; the landing's tree e{12} on base b{12} was not shown .* a review of this submission is needed$/);
  const qa = await run({ required: ["qa"], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: TREE }, early: { base: OLD_BASE, tree: OTHER_TREE }, carryQa: true, earlyShown: null });
  assert.deepEqual([qa.record.results[0]!.result, qa.record.results[0]!.treeMismatch], ["fail", true]);
  assert.match(qa.record.results[0]!.summary, /^QA evidence of sbm-a+ came from sbm-b+, for tree d{12} on base 1{12};.* new QA evidence on this submission is needed$/);
  // Read again before the write, the refusal stands and nothing on the host is asked again.
  const passing = await run({ required: ["review", "qa"], landed: { base: BASE, tree: TREE }, sub: { base: BASE, tree: TREE }, early: { base: OLD_BASE, tree: OTHER_TREE }, carryReview: true, carryQa: true });
  assert.equal(passing.record.passed, true, JSON.stringify(passing.record.results));
  assert.deepEqual(passing.calls[0]!.carried, [{ base: OLD_BASE, tree: OTHER_TREE }]);
  const again = await passing.g.recheck(passing.record);
  assert.deepEqual([again.changed.length, passing.calls.length], [0, 1]);
});
