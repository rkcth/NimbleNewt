import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "../policy/integration-policy.js";
import { LandingGate, landingChecksText, type QaGateView, type DocsGateView, type ContractTests, type LandingCheckHost, type LandingCheckHostReport, type ReviewedSubmission } from "./landing-gate.js";

// Card P09: the landing gate judges the project's required checks on the exact tree a landing would make. Not run counts as failed; a reviewer's approval carries over to another tree only while the patch ID is unchanged.
const BASE = "b".repeat(40), TREE = "e".repeat(40), OLD_TREE = "d".repeat(40), PATCH = "a".repeat(40), OTHER_PATCH = "c".repeat(40);
const TASK = "tsk-aaaaaaaaaaaaaaaaaaaa", SUB = "sbm-aaaaaaaaaaaaaaaaaaaa";

const gate = (o: { required?: readonly Check[]; tests?: ContractTests | undefined; approval?: ReviewedSubmission | undefined | (() => Promise<ReviewedSubmission | undefined>) } = {}) => {
  const seen: { tests: { taskId: string; authors: readonly string[] }[] } = { tests: [] };
  const g = new LandingGate({
    requiredChecks: async () => o.required ?? ["tests", "review"],
    tests: async (taskId, authors) => { seen.tests.push({ taskId, authors }); return o.tests; },
    approvalOf: async (id) => (typeof o.approval === "function" ? o.approval() : id === SUB ? o.approval : undefined),
    now: () => "2026-11-18T10:00:00.000Z",
  });
  return { g, seen };
};
const host = (report: { [K in keyof LandingCheckHostReport]?: LandingCheckHostReport[K] | undefined } | ((call: Parameters<NonNullable<LandingCheckHost["landingChecks"]>>[0]) => LandingCheckHostReport | Promise<LandingCheckHostReport>)) => {
  const calls: Parameters<NonNullable<LandingCheckHost["landingChecks"]>>[0][] = [];
  const h: LandingCheckHost = { landingChecks: async (call) => { calls.push(call); return typeof report === "function" ? report(call) : { checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: call.checks.map((c) => ({ name: c.name, state: "passed" as const, exitCode: 0, ms: 5 })), ...(call.reviewed === undefined ? {} : { reviewedPatchId: PATCH }), ...report } as LandingCheckHostReport; } };
  return { h, calls };
};
const unit: ContractTests = { version: 3, checks: [{ name: "unit", run: ["/opt/node/bin/node", "--test"], timeoutSeconds: 30 }, { name: "lint", run: ["lint"] }] };
const approved: ReviewedSubmission = { taskId: TASK, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: "agent:sam" };

test("every required check passes on the integrated tree: the landing may go ahead, each result bound to that tree, the contract's commands asked of the host with their time limits (card P09)", async () => {
  const { g, seen } = gate({ tests: unit, approval: approved });
  const { h, calls } = host({});
  const r = await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, author: "agent:ann", host: h });
  assert.equal(r.passed, true, JSON.stringify(r));
  assert.deepEqual([r.tree, r.base, r.patchId, r.submissionId, r.contractVersion], [TREE, BASE, PATCH, SUB, 3]);
  assert.deepEqual(r.results.map((x) => [x.check, x.result, x.boundTo]), [["tests", "pass", TREE], ["review", "pass", TREE]]);
  assert.deepEqual(calls[0]!.checks, [{ name: "unit", run: ["/opt/node/bin/node", "--test"], timeoutMs: 30_000 }, { name: "lint", run: ["lint"], timeoutMs: 600_000 }]);
  assert.deepEqual(seen.tests, [{ taskId: TASK, authors: ["agent:ann", "agent:sam"] }], "the assignee and the submitter are named, so neither's own contract change is used");
  assert.deepEqual(calls[0]!.reviewed, { base: BASE, tree: TREE }, "the host is asked for the patch ID of the reviewed base and tree");
});

test("not run counts as failed: no host that can check, a host that throws, no checkout, an unreadable change, nothing to land, no test commands, a command not run (card P09)", async () => {
  const notPassed = async (h: LandingCheckHost | undefined, tests: ContractTests | null = unit, why?: RegExp) => {
    const r = await gate({ tests: tests ?? undefined, approval: approved }).g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: h });
    assert.equal(r.passed, false, JSON.stringify(r));
    assert.ok(r.results.some((x) => x.result === "not_run"), JSON.stringify(r.results));
    if (why !== undefined) assert.match(r.results.map((x) => x.summary).join(" | "), why);
    return r;
  };
  const none = await notPassed(undefined, unit, /cannot run landing checks/);
  assert.deepEqual(none.results.map((x) => x.result), ["not_run", "not_run"]);
  await notPassed({ landingChecks: async () => { throw new Error("connection lost"); } }, unit, /could not run the landing checks: connection lost/);
  await notPassed(host({ checkout: false }).h, unit, /holds no checkout/);
  await notPassed(host({ change: undefined, problem: "bad object" }).h, unit, /could not be read: bad object/);
  await notPassed(host({ change: { base: BASE, head: BASE, tree: TREE } }).h, unit, /nothing to land/);
  const noCommands = await notPassed(host({}).h, { version: 1, checks: [] }, /names no test commands/);
  assert.deepEqual(noCommands.results.map((x) => [x.check, x.result]), [["tests", "not_run"], ["review", "pass"]], "the review still passes: only tests did not run");
  await notPassed(host({}).h, null, /has no contract/);
  const skipped = await notPassed(host((call) => ({ checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [{ name: call.checks[0]!.name, state: "passed" }, { name: "lint", state: "not-run", reason: "the sandbox refused the check" }] })).h, unit, /1 of 2 test command\(s\) did not run: lint/);
  assert.equal(skipped.results[0]!.runs![1]!.note, "the sandbox refused the check");
  const missing = await notPassed(host((call) => ({ checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [{ name: call.checks[0]!.name, state: "passed" }] })).h, unit);
  assert.equal(missing.results[0]!.runs![1]!.note, "the host did not report it");
});

test("a failing test command fails the gate with its output, redacted and cut; a failure beside one not run is a failure (card P09)", async () => {
  const secret = `sk-${"A1b2C3d4".repeat(5)}`;
  const { h } = host((call) => ({ checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [{ name: call.checks[0]!.name, state: "failed", exitCode: 1, output: `${"x".repeat(5000)}\nassertion failed with key ${secret}‮` }, { name: "lint", state: "not-run", reason: "no program" }] }));
  const r = await gate({ tests: unit, approval: approved }).g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: h });
  assert.equal(r.passed, false);
  const t = r.results[0]!;
  assert.deepEqual([t.result, t.boundTo, t.runs![0]!.exitCode], ["fail", TREE, 1]);
  assert.match(t.summary, /1 of 2 test command\(s\) failed on the integrated tree: unit/);
  const note = t.runs![0]!.note!;
  assert.ok(note.length <= 300, String(note.length));
  assert.match(note, /assertion failed/);
  assert.ok(!note.includes(secret), "a credential in the output is not kept");
  assert.ok(!note.includes("‮"), "control characters are not kept");
  const text = landingChecksText(TASK, "wsr-aaaaaaaaaaaaaaaaaaaa", r);
  assert.match(text, /- tests: failed\. 1 of 2/);
  assert.match(text, /  - unit: exit 1: .*assertion failed/);
  assert.match(text, /  - lint: did not run: no program/);
  assert.match(text, /A check that did not run counts as failed/);
  assert.ok(landingChecksText(TASK, "wsr-aaaaaaaaaaaaaaaaaaaa", r, 120).length <= 120);
});

test("a reviewer's approval carries over to another tree only while the patch ID is unchanged; an unreviewed, rejected or foreign submission does not pass (card P09)", async () => {
  // The host computes the reviewed patch ID from the submission's base and tree: by default what the submission names.
  const review = async (approval: ReviewedSubmission | undefined, submissionId: string | null = SUB, computed: { reviewedPatchId?: string | undefined; reviewedProblem?: string; reviewedReplays?: boolean | null } = { reviewedPatchId: approval?.patchId, reviewedReplays: true }) => (await gate({ required: ["review"], approval }).g.evaluate({ taskId: TASK, projectId: "proj-x", ...(submissionId === null ? {} : { submissionId }), host: host(computed).h })).results[0]!;
  const same = await review(approved);
  assert.deepEqual([same.result, same.boundTo], ["pass", TREE]);
  assert.match(same.summary, /approved by agent:rev for this tree/);
  // Another tree on the SAME base with the same patch ID (the same edit at another place of a file): no refresh happened, so the tree itself is compared (card P08 landing re-check).
  const placed = await review({ ...approved, tree: OLD_TREE });
  assert.deepEqual([placed.result, placed.treeMismatch], ["fail", true]);
  assert.match(placed.summary, /approved for tree d{12}, but the landing carries tree e{12} on the same base b{12}/);
  assert.equal(same.treeMismatch, undefined);
  // Refreshed onto a newer base: another tree, the same patch: the approval carries over.
  const carried = await review({ ...approved, base: "9".repeat(40), tree: OLD_TREE });
  assert.equal(carried.result, "pass");
  assert.match(carried.summary, /for tree d{12}; carried over to this tree because the patch is unchanged/);
  // The same, but the host does not show the landed tree is exactly the reviewed change carried onto the new base (the same patch ID can hold an edit placed elsewhere): refused (card P08 landing re-check, first review).
  const notShown = await review({ ...approved, base: "9".repeat(40), tree: OLD_TREE }, SUB, { reviewedPatchId: PATCH, reviewedReplays: false });
  assert.deepEqual([notShown.result, notShown.treeMismatch], ["fail", true]);
  assert.match(notShown.summary, /was not shown to be exactly that change carried onto it/);
  // Another patch (the work changed since the review): a new review is needed.
  const changed = await review({ ...approved, tree: OLD_TREE, patchId: OTHER_PATCH });
  assert.equal(changed.result, "fail");
  assert.match(changed.summary, /approved for patch c{12}, the landing carries patch a{12}; a new review is needed/);
  assert.equal((await review({ ...approved, tree: TREE, patchId: OTHER_PATCH })).result, "fail", "the same tree with a different patch is not the reviewed change");
  const { patchId: _p, ...noPatch } = approved; void _p;
  assert.equal((await review(noPatch, SUB, { reviewedPatchId: PATCH })).result, "fail");
  // The submission names the landed patch, but its own base and tree make another: the submitter's word is not taken.
  const claimed = await review(approved, SUB, { reviewedPatchId: OTHER_PATCH });
  assert.equal(claimed.result, "fail");
  assert.match(claimed.summary, /names patch a{12}, but its base and tree make patch c{12}/);
  // The host could not compute it (objects missing, a host that does not know the field): not run.
  const unknown = await review(approved, SUB, { reviewedPatchId: undefined, reviewedProblem: "bad object" });
  assert.equal(unknown.result, "not_run");
  assert.match(unknown.summary, /could not compute the patch ID of what was reviewed in sbm-a+: bad object/);
  assert.equal((await review(approved, SUB, { reviewedPatchId: undefined })).result, "not_run", "a host that answers no reviewed patch ID");
  // A review that asked for changes while the tests ran: read again after the host's run.
  let reads = 0;
  const late = await gate({ required: ["review"], approval: async () => (reads++ === 0 ? approved : { ...approved, approved: false, newest: "changes", reason: "its newest review says changes" }) }).g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: host({}).h });
  assert.equal(late.results[0]!.result, "fail");
  // Not reviewed yet: not run; the newest review asks for changes: failed.
  assert.equal((await review({ taskId: TASK, base: BASE, tree: TREE, patchId: PATCH, approved: false, reason: "no reviewer has approved it yet" })).result, "not_run");
  const asked = await review({ taskId: TASK, base: BASE, tree: TREE, patchId: PATCH, approved: false, newest: "changes", reason: "its newest review (sbm-x) says changes" });
  assert.equal(asked.result, "fail");
  assert.match(asked.summary, /says changes/);
  assert.equal((await review(undefined)).result, "not_run");
  assert.equal((await review({ ...approved, taskId: "tsk-bbbbbbbbbbbbbbbbbbbb" })).result, "not_run", "another task's submission");
  const unnamed = await review(approved, null);
  assert.equal(unnamed.result, "not_run");
  assert.match(unnamed.summary, /names no reviewed code submission/);
});

test("qa and docs without their readers wired, and director (not collected at landing yet), do not pass; a project that requires nothing is not gated and the host is not asked; unreadable required checks throw (card P09)", async () => {
  const r = await gate({ required: ["qa", "docs", "director"] }).g.evaluate({ taskId: TASK, projectId: "proj-x", host: host({}).h });
  assert.equal(r.passed, false);
  assert.deepEqual(r.results.map((x) => [x.check, x.result]), [["qa", "not_run"], ["docs", "not_run"], ["director", "not_run"]]);
  const { h, calls } = host({});
  const free = await gate({ required: [] }).g.evaluate({ taskId: TASK, projectId: "proj-x", host: h });
  assert.deepEqual([free.passed, free.results.length, calls.length, free.tree], [true, 0, 0, undefined]);
  const broken = new LandingGate({ requiredChecks: async () => { throw new Error("policy store down"); }, tests: async () => undefined, approvalOf: async () => undefined, now: () => "t" });
  await assert.rejects(broken.evaluate({ taskId: TASK, projectId: "proj-x", host: h }), /policy store down/);
});

test("tests with no command a landing can use say whether the owner is needed: set only by the task's authors, or none at all; not when there are commands or nothing to land (card P09 follow-up)", async () => {
  const run = async (tests: ContractTests | undefined, report: Parameters<typeof host>[0] = {}, required?: readonly Check[]) => gate({ tests, approval: approved, ...(required === undefined ? {} : { required }) }).g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: host(report).h });
  const onlyAuthors = await run({ version: 4, checks: [], onlyAuthors: true });
  assert.equal(onlyAuthors.testsNeedOwner, "authors-only");
  assert.equal(onlyAuthors.contractVersion, 4);
  assert.match(onlyAuthors.results[0]!.summary, /set only by its own authors.*set or accept them/);
  assert.match(landingChecksText(TASK, "wsr-x", onlyAuthors), /the owner was told/);
  assert.equal((await run(undefined)).testsNeedOwner, "no-commands");
  assert.equal((await run({ version: 2, checks: [] })).testsNeedOwner, "no-commands");
  const fine = await run(unit);
  assert.equal(fine.testsNeedOwner, undefined);
  assert.doesNotMatch(landingChecksText(TASK, "wsr-x", { ...fine, passed: false }), /owner was told/);
  assert.equal((await run({ version: 4, checks: [], onlyAuthors: true }, { change: { base: BASE, head: BASE, tree: TREE } })).testsNeedOwner, undefined, "nothing to land: not the contract's fault");
  assert.equal((await run(undefined, {}, ["review"])).testsNeedOwner, undefined, "tests not required");
});

test("when the gate stops waiting for the host, it aborts the call's signal so the host stops the check processes; a host that answers in time is not stopped (card P09 follow-up)", async () => {
  const quick: ContractTests = { version: 1, checks: [{ name: "slow", run: ["slow"], timeoutSeconds: 0.02 }] };
  const make = (h: LandingCheckHost) => new LandingGate({ requiredChecks: async () => ["tests"], tests: async () => quick, approvalOf: async () => undefined, now: () => "2026-11-18T10:00:00.000Z" }, { marginMs: 20 }).evaluate({ taskId: TASK, projectId: "proj-x", host: h });
  let signal: AbortSignal | undefined;
  let abortedWith: unknown;
  // The gate's own timer does not hold the process open (it is unref'd); this one does while the test waits.
  const keep = setInterval(() => undefined, 1000);
  let r;
  try { r = await make({ landingChecks: (call) => { signal = call.signal; call.signal?.addEventListener("abort", () => { abortedWith = call.signal?.reason; }); return new Promise(() => undefined); } }); } finally { clearInterval(keep); }
  assert.equal(r.passed, false);
  assert.match(r.results[0]!.summary, /did not answer within/);
  assert.equal(signal?.aborted, true, "the host was told to stop");
  assert.match(String((abortedWith as Error)?.message), /did not answer within/);
  let inTime: AbortSignal | undefined;
  const ok = await make({ landingChecks: async (call) => { inTime = call.signal; return { checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [{ name: "slow", state: "passed" }] }; } });
  assert.equal(ok.passed, true);
  assert.equal(inTime?.aborted, false);
});

// Card P09 (third slice): the qa check with a fake QA gate (the real one is exercised in workspace-ops-p09-qa.test.ts).
const qaGate = (g: Partial<QaGateView> | undefined | (() => Promise<QaGateView | undefined>)) => new LandingGate({
  requiredChecks: async () => ["qa"], tests: async () => undefined, approvalOf: async () => approved, now: () => "2026-11-18T10:00:00.000Z",
  qaGate: async (id) => (typeof g === "function" ? g() : g === undefined ? undefined : { taskId: TASK, submissionId: id, tree: TREE, verdict: "passed" as const, reasons: [], ...g }),
});
const qaRun = (g: Parameters<typeof qaGate>[0], opts: { submissionId?: string | undefined } = { submissionId: SUB }) => qaGate(g).evaluate({ taskId: TASK, projectId: "proj-x", ...(opts.submissionId === undefined ? {} : { submissionId: opts.submissionId }), host: host({}).h });

test("qa: a passed gate passes; a gate for another tree or task, a missing gate and a thrown read are not run; failure reasons are told (card P09)", async () => {
  assert.deepEqual((await qaRun({})).results.map((x) => x.result), ["pass"]);
  assert.equal((await qaRun({ tree: OLD_TREE })).results[0]!.result, "not_run");
  assert.equal((await qaRun({ taskId: "tsk-bbbbbbbbbbbbbbbbbbbb" })).results[0]!.result, "not_run");
  assert.equal((await qaRun({ submissionId: "sbm-bbbbbbbbbbbbbbbbbbbb" })).results[0]!.result, "not_run", "a gate for another submission does not count");
  assert.equal((await qaRun(undefined)).results[0]!.result, "not_run");
  const thrown = await qaRun(async () => { throw new Error("storage down"); });
  assert.deepEqual([thrown.passed, thrown.results[0]!.result], [false, "not_run"]);
  assert.match(thrown.results[0]!.summary, /storage down/);
  const bad = await qaRun({ verdict: "failed", reasons: ["check_failed", "stale_evidence"] });
  assert.deepEqual([bad.passed, bad.results[0]!.result], [false, "fail"]);
  assert.match(bad.results[0]!.summary, /check_failed, stale_evidence/);
  assert.equal((await qaRun({ verdict: "failed", reasons: ["no_evidence"] })).results[0]!.result, "not_run");
  // Card Q04: evidence the gate left out because a contributor of the task recorded it is said in plain words.
  const byContributor = (await qaRun({ verdict: "failed", reasons: ["no_evidence"], byContributors: ["qae-aaaaaaaaaaaaaaaaaaaa"] })).results[0]!;
  assert.equal(byContributor.result, "not_run");
  assert.match(byContributor.summary, /a pass recorded by an agent that contributed code to this task does not count \(another QA agent has to check it\)/);
  assert.doesNotMatch((await qaRun({ verdict: "failed", reasons: ["no_evidence"] })).results[0]!.summary, /contributed/);
  assert.equal((await qaRun({ verdict: "failed", reasons: ["no_evidence", "check_missing"] })).results[0]!.result, "not_run", "no evidence against required checks is not run too");
  assert.equal((await qaRun({ verdict: "failed", reasons: ["decision_superseded", "no_evidence", "check_missing"] })).results[0]!.result, "fail");
  assert.equal((await qaRun({ verdict: "failed", reasons: ["check_missing"] })).results[0]!.result, "fail", "evidence that leaves a required check out failed");
  assert.equal((await qaRun({}, { submissionId: undefined })).results[0]!.result, "not_run");
});

test("qa: without a QA gate wired the check is not collected, as before (card P09)", async () => {
  const g = new LandingGate({ requiredChecks: async () => ["qa"], tests: async () => undefined, approvalOf: async () => approved, now: () => "2026-11-18T10:00:00.000Z" });
  const r = await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: host({}).h });
  assert.deepEqual([r.passed, r.results[0]!.result], [false, "not_run"]);
  assert.match(r.results[0]!.summary, /not collected/);
});

// Card P09 (fourth slice): the docs check with a fake documents gate (the real one is exercised in workspace-ops-p09-docs.test.ts).
const docsGate = (g: Partial<DocsGateView> | undefined | (() => Promise<DocsGateView | undefined>)) => new LandingGate({
  requiredChecks: async () => ["docs"], tests: async () => undefined, approvalOf: async () => approved, now: () => "2026-11-18T10:00:00.000Z",
  docsGate: async (taskId, id) => (typeof g === "function" ? g() : g === undefined ? undefined : { taskId, submissionId: id, tree: TREE, checked: 1, pending: [], ...g }),
});
const docsRun = (g: Parameters<typeof docsGate>[0], opts: { submissionId?: string | undefined } = { submissionId: SUB }) => docsGate(g).evaluate({ taskId: TASK, projectId: "proj-x", ...(opts.submissionId === undefined ? {} : { submissionId: opts.submissionId }), host: host({}).h });

test("docs: nothing pending passes; pending documents fail and are named; a gate for another tree, task or submission, a missing gate and a thrown read are not run (card P09)", async () => {
  assert.deepEqual((await docsRun({})).results.map((x) => x.result), ["pass"]);
  assert.match((await docsRun({ checked: 0 })).results[0]!.summary, /no documentation obligation describes this task/);
  const pending = await docsRun({ checked: 3, pending: [{ obligationId: "dob-aaaaaaaaaaaaaaaaaaaa", title: "User guide", reason: "it was never verified against tested code" }] });
  assert.deepEqual([pending.passed, pending.results[0]!.result], [false, "fail"]);
  assert.match(pending.results[0]!.summary, /1 of 3 document\(s\).*User guide \(it was never verified/);
  assert.equal((await docsRun({ tree: OLD_TREE })).results[0]!.result, "not_run");
  assert.equal((await docsRun({ taskId: "tsk-bbbbbbbbbbbbbbbbbbbb" })).results[0]!.result, "not_run");
  assert.equal((await docsRun({ submissionId: "sbm-bbbbbbbbbbbbbbbbbbbb" })).results[0]!.result, "not_run", "a gate for another submission does not count");
  assert.equal((await docsRun(undefined)).results[0]!.result, "not_run");
  assert.equal((await docsRun({ pending: undefined as never })).results[0]!.result, "not_run", "an unreadable answer is not a pass");
  const thrown = await docsRun(async () => { throw new Error("storage down"); });
  assert.equal(thrown.results[0]!.result, "not_run");
  assert.match(thrown.results[0]!.summary, /storage down/);
  assert.equal((await docsRun({}, { submissionId: undefined })).results[0]!.result, "not_run");
});

test("docs: many pending documents: at most five are named whole within the summary and the rest are counted (card P09)", async () => {
  const many = (n: number, title: (i: number) => string) => Array.from({ length: n }, (_, i) => ({ obligationId: `dob-${String(i).repeat(20)}`, title: title(i), reason: "never verified" }));
  const short = await docsRun({ checked: 9, pending: many(7, (i) => `G${i}`) });
  assert.deepEqual([short.passed, short.results[0]!.result], [false, "fail"]);
  const s = short.results[0]!.summary;
  assert.match(s, /^7 of 9 document\(s\)/);
  for (let i = 0; i < 5; i++) assert.ok(s.includes(`G${i} (never verified)`), `names G${i}: ${s}`);
  assert.ok(!s.includes("G5") && !s.includes("G6"), "names no more than five");
  assert.match(s, /; and 2 more$/);
  assert.match((await docsRun({ checked: 2, pending: many(2, (i) => `G${i}`) })).results[0]!.summary, /G0 \(never verified\); G1 \(never verified\)$/, "nothing is counted when all are named");
  // Long titles: only what fits is named whole; the first is shortened when it alone is too long; the count is never cut off.
  const long = (await docsRun({ checked: 4, pending: many(4, (i) => `${String(i).repeat(120)}`) })).results[0]!.summary;
  assert.ok(long.length <= 300, long);
  assert.match(long, /; and 3 more$/);
  const huge = (await docsRun({ checked: 3, pending: many(3, (i) => `${String(i).repeat(200)}`) })).results[0]!.summary;
  assert.ok(huge.length <= 300, huge);
  assert.match(huge, /0{20}\.\.\.; and 2 more$/);
  assert.equal((await docsRun({ checked: 0, pending: many(1, () => "G") })).results[0]!.result, "not_run", "a count below the pending documents is an unreadable answer");
});

test("a cut never leaves half a character: document names, a long summary and a failing command's output tail of emoji, in both parities, and a lone surrogate in the input (card P09)", async () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const smile = "\u{1F600}";
  for (const lead of ["", "x"]) {
    const named = (await docsRun({ checked: 1, pending: [{ obligationId: "dob-aaaaaaaaaaaaaaaaaaaa", title: `${lead}${smile.repeat(100)}`, reason: "never verified" }] })).results[0]!.summary;
    assert.doesNotMatch(named, lone, JSON.stringify(named));
    assert.match(named, new RegExp(`${smile}\\.\\.\\.$`, "u"));
    const thrown = (await docsRun(async () => { throw new Error(`\uD800${lead}${smile.repeat(200)}`); })).results[0]!.summary;
    assert.ok(thrown.length <= 300, String(thrown.length));
    assert.doesNotMatch(thrown, lone, JSON.stringify(thrown));
    const { h } = host((call) => ({ checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [{ name: call.checks[0]!.name, state: "failed", exitCode: 1, output: `${lead}${smile.repeat(600)}\uDC00` }, { name: "lint", state: "passed", exitCode: 0 }] }));
    const note = (await gate({ tests: unit, approval: approved }).g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: h })).results[0]!.runs![0]!.note!;
    assert.ok(note.startsWith("...") && note.length <= 300, note);
    assert.doesNotMatch(note, lone, JSON.stringify(note));
  }
});

test("docs: without a documents gate wired the check is not collected, as before (card P09)", async () => {
  const g = new LandingGate({ requiredChecks: async () => ["docs"], tests: async () => undefined, approvalOf: async () => approved, now: () => "2026-11-18T10:00:00.000Z" });
  const r = await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: host({}).h });
  assert.deepEqual([r.passed, r.results[0]!.result], [false, "not_run"]);
  assert.match(r.results[0]!.summary, /not collected/);
});

// P09 fifth slice: the author's own evidence on the submission is compared with the gate's own result for the same tree.
const claimRun = async (evidence: ReviewedSubmission["evidence"], o: { required?: readonly Check[]; failTests?: boolean; tree?: string } = {}) => {
  const { g } = gate({ required: o.required ?? ["tests", "review"], tests: unit, approval: { ...approved, ...(evidence === undefined ? {} : { evidence }) } });
  const failing = (call: Parameters<NonNullable<LandingCheckHost["landingChecks"]>>[0]): LandingCheckHostReport => ({ checkout: true, change: { base: BASE, head: "f".repeat(40), tree: o.tree ?? TREE, patchId: PATCH }, checks: call.checks.map((c, i) => ({ name: c.name, state: o.failTests === true && i === 0 ? ("failed" as const) : ("passed" as const), exitCode: o.failTests === true && i === 0 ? 1 : 0 })), reviewedPatchId: PATCH });
  return g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: host(failing).h });
};
const by = (r: { results: readonly { check: string }[] }, check: string) => r.results.find((x) => x.check === check)! as import("./landing-gate.js").LandingCheckEntry;

test("the author's evidence that says fail for a check the gate found passing is refused with a plain reason; matching evidence changes nothing (P09 fifth slice)", async () => {
  const clean = await claimRun(undefined);
  assert.equal(clean.passed, true);
  const agree = await claimRun([{ check: "tests", result: "pass", boundTo: TREE }, { check: "review", result: "pass", boundTo: TREE }]);
  assert.deepEqual([agree.passed, by(agree, "tests").disagreement, by(agree, "tests").claimed], [true, undefined, undefined]);
  const bad = await claimRun([{ check: "tests", result: "fail", boundTo: TREE }]);
  assert.equal(bad.passed, false);
  assert.deepEqual([by(bad, "tests").result, by(bad, "tests").disagreement, by(bad, "tests").claimed], ["fail", "claimed_fail_passed", "fail"]);
  assert.equal(by(bad, "review").result, "pass", "the other check is left as it is");
  assert.match(by(bad, "tests").summary, /author's own evidence for tests on this tree says fail, but the gate found it passing/);
  assert.match(landingChecksText(TASK, "req-1", bad), /- tests: failed\. the author's own evidence for tests/);
  // The name is matched without regard to case or edge spaces.
  assert.equal((await claimRun([{ check: " Tests ", result: "fail", boundTo: TREE }])).passed, false);
});

test("the author's evidence that says pass for a check the gate found failing is flagged, and never makes the check pass (P09 fifth slice)", async () => {
  const r = await claimRun([{ check: "tests", result: "pass", boundTo: TREE }], { failTests: true });
  assert.equal(r.passed, false);
  assert.deepEqual([by(r, "tests").result, by(r, "tests").disagreement, by(r, "tests").claimed], ["fail", "claimed_pass_failed", "pass"]);
  assert.match(by(r, "tests").summary, /says pass, but the gate found it failing: 1 of 2 test command\(s\) failed/);
  // Without any claim the failure reads as before.
  const plain = await claimRun(undefined, { failTests: true });
  assert.deepEqual([by(plain, "tests").disagreement, /author's own/.test(by(plain, "tests").summary)], [undefined, false]);
  // Evidence that agrees with a failure (fail, or not_run) is no disagreement: the failure reads exactly as without a claim.
  for (const result of ["fail", "not_run"]) {
    const same = await claimRun([{ check: "tests", result, boundTo: TREE }], { failTests: true });
    assert.deepEqual(by(same, "tests"), by(plain, "tests"), result);
  }
  // Self-contradicting evidence (both pass and fail for one check on this tree) never passes: refused when the gate passes, flagged when it fails.
  const both = [{ check: "tests", result: "pass", boundTo: TREE }, { check: "tests", result: "fail", boundTo: TREE }];
  assert.deepEqual([(await claimRun(both)).passed, by(await claimRun(both), "tests").disagreement], [false, "claimed_fail_passed"]);
  assert.deepEqual([(await claimRun(both, { failTests: true })).passed, by(await claimRun(both, { failTests: true }), "tests").disagreement], [false, "claimed_pass_failed"]);
});

test("evidence that is not about this tree and check is not compared: another tree, not_run, a check not required, a result the gate could not judge (P09 fifth slice)", async () => {
  const other = await claimRun([{ check: "tests", result: "fail", boundTo: OLD_TREE }]);
  assert.deepEqual([other.passed, by(other, "tests").disagreement], [true, undefined], "a claim for another tree says nothing about the integrated tree");
  assert.equal((await claimRun([{ check: "tests", result: "not_run", boundTo: TREE }])).passed, true, "not run is not a claim");
  assert.equal((await claimRun([{ check: "lint", result: "fail", boundTo: TREE }])).passed, true, "a check the project does not require");
  assert.equal((await claimRun([{ check: "qa", result: "fail", boundTo: TREE }])).passed, true, "a check the project does not require");
  // The gate itself had no result for the check (not run): a claim of pass changes nothing and is not called a contradiction.
  const { g } = gate({ required: ["tests"], tests: { version: 1, checks: [] }, approval: { ...approved, evidence: [{ check: "tests", result: "pass", boundTo: TREE }] } });
  const nr = await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: host({}).h });
  assert.deepEqual([nr.results[0]!.result, nr.results[0]!.disagreement], ["not_run", undefined]);
  // Malformed claims in a stored record are ignored.
  const junk = await claimRun([null, { check: 7, result: "fail", boundTo: TREE }] as never);
  assert.equal(junk.passed, true);
});

test("the claim comparison covers qa and docs as well as tests and review (P09 fifth slice)", async () => {
  const q: QaGateView = { taskId: TASK, submissionId: SUB, tree: TREE, verdict: "passed", reasons: [] };
  const d: DocsGateView = { taskId: TASK, submissionId: SUB, tree: TREE, checked: 0, pending: [] };
  const g = new LandingGate({ requiredChecks: async () => ["qa", "docs"], tests: async () => undefined, approvalOf: async () => ({ ...approved, evidence: [{ check: "qa", result: "fail", boundTo: TREE }, { check: "docs", result: "fail", boundTo: TREE }] }), qaGate: async () => q, docsGate: async () => d, now: () => "2026-11-18T10:00:00.000Z" });
  const r = await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: host({}).h });
  assert.deepEqual(r.results.map((x) => [x.check, x.result, x.disagreement]), [["qa", "fail", "claimed_fail_passed"], ["docs", "fail", "claimed_fail_passed"]]);
});

test("a disagreement's summary stays within the bound, its reason first, and never cuts a character in half, in both parities (P09 fifth slice)", async () => {
  const lone = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  for (const lead of ["", "x"]) {
    const d: DocsGateView = { taskId: TASK, submissionId: SUB, tree: TREE, checked: 1, pending: [{ obligationId: "dob-aaaaaaaaaaaaaaaaaaaa", title: `${lead}${"\u{1F600}".repeat(200)}`, reason: "never verified" }] };
    const g = new LandingGate({ requiredChecks: async () => ["docs"], tests: async () => undefined, approvalOf: async () => ({ ...approved, evidence: [{ check: "docs", result: "pass", boundTo: TREE }] }), docsGate: async () => d, now: () => "2026-11-18T10:00:00.000Z" });
    const e = (await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, host: host({}).h })).results[0]!;
    assert.deepEqual([e.result, e.disagreement], ["fail", "claimed_pass_failed"]);
    assert.ok(e.summary.length <= 300 && e.summary.endsWith("..."), String(e.summary.length));
    assert.match(e.summary, /^the author's own evidence for docs on this tree says pass, but the gate found it failing: /);
    assert.doesNotMatch(e.summary, lone, JSON.stringify(e.summary));
  }
});
