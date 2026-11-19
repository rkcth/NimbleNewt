import assert from "node:assert/strict";
import { test } from "node:test";
import type { Check } from "../policy/integration-policy.js";
import { LandingGate, landingChecksText, type ContractTests, type LandingCheckHost, type LandingCheckHostReport, type ReviewedSubmission } from "./landing-gate.js";

// Card P09: the landing gate judges the project's required checks on the exact tree a landing would make. Not run counts as failed; a reviewer's approval carries over to another tree only while the patch ID is unchanged.
const BASE = "b".repeat(40), TREE = "e".repeat(40), OLD_TREE = "d".repeat(40), PATCH = "a".repeat(40), OTHER_PATCH = "c".repeat(40);
const TASK = "tsk-aaaaaaaaaaaaaaaaaaaa", SUB = "sbm-aaaaaaaaaaaaaaaaaaaa";

const gate = (o: { required?: readonly Check[]; tests?: ContractTests | undefined; approval?: ReviewedSubmission | undefined | (() => Promise<ReviewedSubmission | undefined>) } = {}) => {
  const seen: { tests: { taskId: string; author: string | undefined }[] } = { tests: [] };
  const g = new LandingGate({
    requiredChecks: async () => o.required ?? ["tests", "review"],
    tests: async (taskId, author) => { seen.tests.push({ taskId, author }); return o.tests; },
    approvalOf: async (id) => (typeof o.approval === "function" ? o.approval() : id === SUB ? o.approval : undefined),
    now: () => "2026-11-18T10:00:00.000Z",
  });
  return { g, seen };
};
const host = (report: { [K in keyof LandingCheckHostReport]?: LandingCheckHostReport[K] | undefined } | ((call: Parameters<NonNullable<LandingCheckHost["landingChecks"]>>[0]) => LandingCheckHostReport | Promise<LandingCheckHostReport>)) => {
  const calls: Parameters<NonNullable<LandingCheckHost["landingChecks"]>>[0][] = [];
  const h: LandingCheckHost = { landingChecks: async (call) => { calls.push(call); return typeof report === "function" ? report(call) : { checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: call.checks.map((c) => ({ name: c.name, state: "passed" as const, exitCode: 0, ms: 5 })), ...report } as LandingCheckHostReport; } };
  return { h, calls };
};
const unit: ContractTests = { version: 3, checks: [{ name: "unit", run: ["/opt/node/bin/node", "--test"], timeoutSeconds: 30 }, { name: "lint", run: ["lint"] }] };
const approved: ReviewedSubmission = { taskId: TASK, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve" };

test("every required check passes on the integrated tree: the landing may go ahead, each result bound to that tree, the contract's commands asked of the host with their time limits (card P09)", async () => {
  const { g, seen } = gate({ tests: unit, approval: approved });
  const { h, calls } = host({});
  const r = await g.evaluate({ taskId: TASK, projectId: "proj-x", submissionId: SUB, author: "agent:ann", host: h });
  assert.equal(r.passed, true, JSON.stringify(r));
  assert.deepEqual([r.tree, r.base, r.patchId, r.submissionId, r.contractVersion], [TREE, BASE, PATCH, SUB, 3]);
  assert.deepEqual(r.results.map((x) => [x.check, x.result, x.boundTo]), [["tests", "pass", TREE], ["review", "pass", TREE]]);
  assert.deepEqual(calls[0]!.checks, [{ name: "unit", run: ["/opt/node/bin/node", "--test"], timeoutMs: 30_000 }, { name: "lint", run: ["lint"], timeoutMs: 600_000 }]);
  assert.deepEqual(seen.tests, [{ taskId: TASK, author: "agent:ann" }], "the author is named, so its own contract change is left out");
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
  const review = async (approval: ReviewedSubmission | undefined, submissionId: string | null = SUB) => (await gate({ required: ["review"], approval }).g.evaluate({ taskId: TASK, projectId: "proj-x", ...(submissionId === null ? {} : { submissionId }), host: host({}).h })).results[0]!;
  const same = await review(approved);
  assert.deepEqual([same.result, same.boundTo], ["pass", TREE]);
  assert.match(same.summary, /approved by agent:rev for this tree/);
  // Refreshed onto a newer base: another tree, the same patch: the approval carries over.
  const carried = await review({ ...approved, tree: OLD_TREE });
  assert.equal(carried.result, "pass");
  assert.match(carried.summary, /for tree d{12}; carried over to this tree because the patch is unchanged/);
  // Another patch (the work changed since the review): a new review is needed.
  const changed = await review({ ...approved, tree: OLD_TREE, patchId: OTHER_PATCH });
  assert.equal(changed.result, "fail");
  assert.match(changed.summary, /approved for patch c{12}, the landing carries patch a{12}; a new review is needed/);
  assert.equal((await review({ ...approved, tree: TREE, patchId: OTHER_PATCH })).result, "fail", "the same tree with a different patch is not the reviewed change");
  const { patchId: _p, ...noPatch } = approved; void _p;
  assert.equal((await review(noPatch)).result, "fail");
  // Not reviewed yet: not run; the newest review asks for changes: failed.
  assert.equal((await review({ taskId: TASK, tree: TREE, patchId: PATCH, approved: false, reason: "no reviewer has approved it yet" })).result, "not_run");
  const asked = await review({ taskId: TASK, tree: TREE, patchId: PATCH, approved: false, newest: "changes", reason: "its newest review (sbm-x) says changes" });
  assert.equal(asked.result, "fail");
  assert.match(asked.summary, /says changes/);
  assert.equal((await review(undefined)).result, "not_run");
  assert.equal((await review({ ...approved, taskId: "tsk-bbbbbbbbbbbbbbbbbbbb" })).result, "not_run", "another task's submission");
  const unnamed = await review(approved, null);
  assert.equal(unnamed.result, "not_run");
  assert.match(unnamed.summary, /names no reviewed code submission/);
});

test("qa, docs and director are not collected at landing yet, so they do not pass; a project that requires nothing is not gated and the host is not asked; unreadable required checks throw (card P09)", async () => {
  const r = await gate({ required: ["qa", "docs", "director"] }).g.evaluate({ taskId: TASK, projectId: "proj-x", host: host({}).h });
  assert.equal(r.passed, false);
  assert.deepEqual(r.results.map((x) => [x.check, x.result]), [["qa", "not_run"], ["docs", "not_run"], ["director", "not_run"]]);
  const { h, calls } = host({});
  const free = await gate({ required: [] }).g.evaluate({ taskId: TASK, projectId: "proj-x", host: h });
  assert.deepEqual([free.passed, free.results.length, calls.length, free.tree], [true, 0, 0, undefined]);
  const broken = new LandingGate({ requiredChecks: async () => { throw new Error("policy store down"); }, tests: async () => undefined, approvalOf: async () => undefined, now: () => "t" });
  await assert.rejects(broken.evaluate({ taskId: TASK, projectId: "proj-x", host: h }), /policy store down/);
});
