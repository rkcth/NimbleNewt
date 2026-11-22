import assert from "node:assert/strict";
import { test } from "node:test";
import { LandingGate, type DirectorGateView, type LandingCheckHost, type LandingCheckHostReport, type ReviewedSubmission } from "./landing-gate.js";

// Card P09 (sixth slice): the `director` check. "The director approved this change" is the newest director sign-off recorded on the landed code submission saying approve, bound to the landed patch like `qa`.
const BASE = "b".repeat(40), TREE = "e".repeat(40), OLD_TREE = "d".repeat(40), PATCH = "a".repeat(40), OTHER = "c".repeat(40);
const TASK = "tsk-aaaaaaaaaaaaaaaaaaaa", SUB = "sbm-aaaaaaaaaaaaaaaaaaaa";
const approved: ReviewedSubmission = { taskId: TASK, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: "agent:sam" };
const signed: DirectorGateView = { taskId: TASK, submissionId: SUB, tree: TREE, signoff: { newest: "approve", by: "agent:dee", signoffId: "sbm-bbbbbbbbbbbbbbbbbbbb" } };

const rig = (o: { director?: DirectorGateView | undefined | (() => Promise<DirectorGateView | undefined>); wired?: boolean; approval?: ReviewedSubmission | undefined; required?: readonly ("tests" | "review" | "director")[] } = {}) => {
  const g = new LandingGate({
    requiredChecks: async () => o.required ?? ["director"],
    tests: async () => undefined,
    approvalOf: async (id) => (id === SUB ? ("approval" in o ? o.approval : approved) : undefined),
    ...(o.wired === false ? {} : { directorGate: async () => (typeof o.director === "function" ? o.director() : "director" in o ? o.director : signed) }),
    now: () => "2026-11-22T10:00:00.000Z",
  });
  const calls: Parameters<NonNullable<LandingCheckHost["landingChecks"]>>[0][] = [];
  const hostWith = (over: { [K in keyof LandingCheckHostReport]?: LandingCheckHostReport[K] | undefined } = {}): LandingCheckHost => ({
    landingChecks: async (call) => { calls.push(call); return { checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, checks: [], ...(call.reviewed === undefined ? {} : { reviewedPatchId: PATCH }), ...over } as LandingCheckHostReport; },
  });
  const run = (host: LandingCheckHost = hostWith(), submissionId: string | null = SUB) => g.evaluate({ taskId: TASK, projectId: "proj-x", host, ...(submissionId === null ? {} : { submissionId }) });
  return { g, calls, hostWith, run };
};
const only = (r: Awaited<ReturnType<ReturnType<typeof rig>["run"]>>) => [r.results[0]!.check, r.results[0]!.result] as const;

test("a director approval of the landed submission passes, bound to the tree, and the host is asked for the patch ID even when only director is required", async () => {
  const r = rig();
  const out = await r.run();
  assert.equal(out.passed, true, JSON.stringify(out));
  assert.deepEqual([...only(out), out.results[0]!.boundTo], ["director", "pass", TREE]);
  assert.match(out.results[0]!.summary, /signed off by agent:dee for this tree/);
  assert.deepEqual(r.calls[0]!.reviewed, { base: BASE, tree: TREE });
});

test("no sign-off is not run, a decline is a failure, no submission or no reader is not run (each counts as failed)", async () => {
  const { signoff: _gone, ...bare } = signed;
  const none = await rig({ director: bare }).run();
  assert.deepEqual([none.passed, ...only(none)], [false, "director", "not_run"]);
  assert.match(none.results[0]!.summary, /no director has signed off/);
  const declined = await rig({ director: { ...signed, signoff: { ...signed.signoff!, newest: "decline" } } }).run();
  assert.deepEqual([declined.passed, ...only(declined)], [false, "director", "fail"]);
  assert.match(declined.results[0]!.summary, /declines it/);
  const unnamed = await rig().run(undefined, null);
  assert.deepEqual(only(unnamed), ["director", "not_run"]);
  assert.match(unnamed.results[0]!.summary, /names no code submission/);
  const unwired = await rig({ wired: false }).run();
  assert.deepEqual(only(unwired), ["director", "not_run"]);
  assert.match(unwired.results[0]!.summary, /not collected at landing yet/);
});

test("a sign-off read for another task, another submission or another tree is not run; another task's submission is not a code submission of this task", async () => {
  for (const view of [{ ...signed, taskId: "tsk-bbbbbbbbbbbbbbbbbbbb" }, { ...signed, submissionId: "sbm-cccccccccccccccccccc" }, { ...signed, tree: OLD_TREE }]) {
    const out = await rig({ director: view }).run();
    assert.deepEqual(only(out), ["director", "not_run"], JSON.stringify(view));
    assert.match(out.results[0]!.summary, /could not be read for the tree it names/);
  }
  const foreign = await rig({ approval: { ...approved, taskId: "tsk-bbbbbbbbbbbbbbbbbbbb" } }).run();
  assert.deepEqual(only(foreign), ["director", "not_run"]);
  const gone = await rig({ director: undefined }).run();
  assert.match(gone.results[0]!.summary, /could not be read for the tree it names/);
  const broken = await rig({ director: async () => { throw new Error("store down"); } }).run();
  assert.deepEqual(only(broken), ["director", "not_run"]);
  assert.match(broken.results[0]!.summary, /could not be read: store down/);
});

test("the sign-off is read again after the host's run: a decline recorded while the checks ran refuses", async () => {
  // The answer after the host's run decides (a first read before the run would have shown a pass).
  let state: DirectorGateView = signed;
  const g = rig({ director: async () => state });
  const host: LandingCheckHost = { landingChecks: async () => { state = { ...signed, signoff: { ...signed.signoff!, newest: "decline" } }; return { checkout: true, change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: PATCH }, reviewedPatchId: PATCH, checks: [] }; } };
  assert.deepEqual(only(await g.run(host)), ["director", "fail"]);
});

test("the sign-off carries over to a refreshed tree only while the host-computed patch ID is unchanged", async () => {
  const r = rig();
  const carried = await r.run(r.hostWith({ change: { base: "9".repeat(40), head: "f".repeat(40), tree: OLD_TREE, patchId: PATCH } }));
  assert.deepEqual([...only(carried), carried.results[0]!.boundTo], ["director", "pass", OLD_TREE]);
  assert.match(carried.results[0]!.summary, /tree e{12}; carried over to this tree because the patch is unchanged/);
  const changed = await r.run(r.hostWith({ change: { base: BASE, head: "f".repeat(40), tree: TREE, patchId: OTHER } }));
  assert.deepEqual(only(changed), ["director", "fail"]);
  assert.match(changed.results[0]!.summary, /differs from what the director signed off/);
  const lying = await r.run(r.hostWith({ reviewedPatchId: OTHER }));
  assert.deepEqual(only(lying), ["director", "fail"]);
  assert.match(lying.results[0]!.summary, /names patch a{12}, but its base and tree make patch c{12}/);
  const blind = await r.run(r.hostWith({ reviewedPatchId: undefined, reviewedProblem: "object missing" }));
  assert.deepEqual(only(blind), ["director", "not_run"]);
  assert.match(blind.results[0]!.summary, /could not compute the patch ID of what the director signed off in .*: object missing/);
});

test("director beside review and tests: every one must pass, a director approval never stands in for a review", async () => {
  const r = rig({ required: ["review", "director"], approval: { ...approved, approved: false, newest: "changes" } });
  const out = await r.run();
  assert.deepEqual(out.results.map((x) => [x.check, x.result]), [["review", "fail"], ["director", "pass"]]);
  assert.equal(out.passed, false);
});

test("the summary stays bounded with whole characters when the signer's name is long and holds emoji", async () => {
  const by = `agent:${"\u{1F600}".repeat(400)}`;
  const out = await rig({ director: { ...signed, signoff: { newest: "decline", by, signoffId: signed.signoff!.signoffId } } }).run();
  const s = out.results[0]!.summary;
  assert.ok(s.length <= 300, String(s.length));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s), false, "no half of a pair");
});
