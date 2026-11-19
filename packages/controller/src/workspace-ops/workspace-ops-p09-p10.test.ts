import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { LandingGate, LandingQueueOps, LandingQueueService, type LandingCheckHostReport } from "../landing/index.js";
import { ContractService } from "../planning/contracts.js";
import { IntegrationPolicyService } from "../policy/integration-policy.js";
import { PrincipalService } from "../security/index.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspacePort } from "./index.js";

after(stopServer);

// Cards P09 and P10 together: the landing gate judges exactly the submission the landing queue says is at the head of the landing branch, and the host is told both that submission (base == head, exactly its tree) and the
// tree the checks ran on. A gate that refuses leaves the entry in the queue and sends the results to its author; a gate that passes lands only the checked tree and the landing takes the entry out; a landing naming a
// submission that is not the head is refused before the gate or the host is asked; a queue that moves while the checks run lands nothing.
const options = { clock: () => "2026-11-19T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), HEAD = "c".repeat(40), TREE1 = "1".repeat(40), TREE2 = "2".repeat(40), PATCH1 = "a".repeat(40), PATCH2 = "e".repeat(40);
const S1 = "sbm-aaaaaaaaaaaaaaaaaaaa", S2 = "sbm-bbbbbbbbbbbbbbbbbbbb";
const refuses = async (code: string, run: () => Promise<unknown>, match?: RegExp) => assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); if (match !== undefined) assert.match(e.message, match); return true; });

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: "p", actor: owner.id, name: "P" })).id;
    const t1 = (await projects.createTask({ commandId: "t1", actor: owner.id, projectId: project, title: "one" })).id;
    const t2 = (await projects.createTask({ commandId: "t2", actor: owner.id, projectId: project, title: "two" })).id;
    const integration = IntegrationPolicyService.withEpoch(store.storage, projects.epoch, options);
    const contracts = ContractService.withEpoch(store.storage, projects.epoch, options);
    // Both submissions approved on the same base, as `SubmissionService.approvalOf` answers them: S1 (task one, by ann) and S2 (task two, by cid).
    const approvals = new Map([
      [S1, { taskId: t1, projectId: project, base: BASE, tree: TREE1, patchId: PATCH1, approved: true, approvedBy: "agent:rev", newest: "approve" as const, submittedBy: "agent:ann", submittedAt: "2026-11-19T09:00:00.000Z" }],
      [S2, { taskId: t2, projectId: project, base: BASE, tree: TREE2, patchId: PATCH2, approved: true, approvedBy: "agent:rev", newest: "approve" as const, submittedBy: "agent:cid", submittedAt: "2026-11-19T09:01:00.000Z" }],
    ]);
    const queueOps = new LandingQueueOps(LandingQueueService.withEpoch(store.storage, projects.epoch, options), {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async () => "main",
      projectOfTask: async (t) => ((await store.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
    });
    const gate = new LandingGate({ requiredChecks: async (p) => (await integration.effective(p)).requiredChecks, tests: (t, a) => contracts.landingTests(t, a), approvalOf: async (id) => approvals.get(id), now: options.clock });
    // The host holds task one's checkout: its committed change is exactly S1's tree on the base. Each test command ends as `exit` says; `duringChecks` runs while the host checks.
    const host = { exit: "failed" as "passed" | "failed", duringChecks: async () => undefined as unknown };
    const calls: { checks: Parameters<NonNullable<WorkspacePort["landingChecks"]>>[0][]; runs: WorkspaceCall[] } = { checks: [], runs: [] };
    const port: WorkspacePort = {
      run: async (call) => { calls.runs.push(call); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, ...(call.submission === undefined ? {} : { submission: call.submission.id, base: call.submission.base, tree: call.submission.tree }) } }; },
      landingChecks: async (call) => {
        calls.checks.push(call);
        await host.duringChecks();
        const change: LandingCheckHostReport["change"] = { base: BASE, head: HEAD, tree: TREE1, patchId: PATCH1 };
        return { checkout: true, change, ...(call.reviewed === undefined ? {} : { reviewedPatchId: call.reviewed.tree === TREE1 ? PATCH1 : PATCH2 }), checks: call.checks.map((c) => ({ name: c.name, state: host.exit, exitCode: host.exit === "failed" ? 1 : 0, ...(host.exit === "failed" ? { output: `${c.name}: 1 test failed` } : {}) })) };
      },
    };
    const told: { commandId: string; to: string; text: string }[] = [];
    const service = WorkspaceOpService.withEpoch(store.storage, projects.epoch, {
      quiesce: { around: async (_scope, _op, run, after) => { const out = await run({ attempts: [{ attemptId: "att-1" }] } as never); await after?.("att-1"); return out; } },
      portOf: async () => port,
      assignee: async () => "agent:bob",
      attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async () => true },
      approvalOf: async (id) => approvals.get(id),
      landingQueue: { check: (by, call) => queueOps.checkLanding(by, call), landedChanges: (p, b, s) => queueOps.landedChanges(p, b, s) },
      landingGate: (call) => gate.evaluate(call),
      tellAuthor: async (n) => { told.push(n); },
    }, options);
    const land = (commandId: string, taskId: string, submissionId?: string) => service.request(owner, { commandId, operation: "landing", taskId, reason: "reviewed and ready", ...(submissionId === undefined ? {} : { submissionId }) });
    const queued = async () => (await queueOps.list(owner, { projectId: project })).items.map((e) => [e.submissionId, e.taskId]);
    const setChecks = async (taskId: string, n: string) => {
      const now = await contracts.get(owner, taskId);
      await contracts.setContract(owner, { commandId: `c-${n}`, taskId, expectedVersion: now?.version ?? 0, checks: [{ name: "unit", run: ["npm", "test"] }] });
    };
    await setChecks(t1, "t1");
    await queueOps.add(owner, { commandId: "q1", submissionId: S1 });
    await queueOps.add(owner, { commandId: "q2", submissionId: S2 });
    return { store, owner, t1, t2, host, calls, told, land, queued, queueOps };
  };

  test(`${backend.name}: the gate judges the queue's head; a failing gate keeps it queued and tells its author; a passing gate lands only the checked tree and dequeues; a non-head submission is refused (cards P09 and P10)`, async () => {
    const r = await rig();
    try {
      assert.deepEqual(await r.queued(), [[S1, r.t1], [S2, r.t2]]);
      // Not the head: task two's landing, and task one's landing naming task two's submission, are refused before anything is recorded; neither the gate nor the host is asked.
      await refuses("invalid_transition", () => r.land("n1", r.t2), /number 2 in the landing queue/);
      await refuses("invalid_transition", () => r.land("n2", r.t2, S2), /number 2 in the landing queue/);
      await refuses("invalid_transition", () => r.land("n3", r.t1, S2), /is not the submission task .* has in the landing queue/);
      assert.deepEqual([r.calls.checks.length, r.calls.runs.length], [0, 0]);

      // The head with a failing test command: refused, nothing landed, the entry stays at the head, and S1's author (ann, not the assignee) gets the results. The landing names no submission: the gate judges the queue's.
      const failed = await r.land("f1", r.t1);
      assert.equal(failed.state, "refused", failed.summary);
      assert.match(failed.summary!, /the required checks did not all pass on the integrated tree 1{12} \(tests failed; .*\), so nothing was landed and submission sbm-a{20} stays in the landing queue; the author was sent the results/);
      assert.deepEqual(r.calls.checks.map((c) => c.reviewed), [{ base: BASE, tree: TREE1 }], "the review check is of the queued submission's base and tree");
      assert.deepEqual([failed.checks!.submissionId, failed.checks!.tree, failed.checks!.passed, failed.queued?.submissionId, failed.landedSubmission], [S1, TREE1, false, S1, undefined]);
      assert.deepEqual(failed.checks!.results.map((x) => [x.check, x.result]), [["tests", "fail"], ["review", "pass"]]);
      assert.equal(r.calls.runs.length, 0, "the host was never asked to land");
      assert.deepEqual(await r.queued(), [[S1, r.t1], [S2, r.t2]], "the refused head stays queued");
      assert.equal(failed.toldAuthor, "agent:ann");
      assert.deepEqual(r.told.map((n) => [n.to, n.commandId]), [["agent:ann", `lgc-${failed.id}`]]);
      assert.match(r.told[0]!.text, /unit: exit 1: unit: 1 test failed/);

      // The same head once the checks pass: the host is told both the queued submission and the checked tree, which are the same tree; the landing takes S1 out of the queue in the same write.
      r.host.exit = "passed";
      const landed = await r.land("p1", r.t1, S1);
      assert.equal(landed.state, "done", landed.summary);
      assert.equal(r.calls.runs.length, 1);
      assert.deepEqual([r.calls.runs[0]!.submission, r.calls.runs[0]!.checkedTree], [{ id: S1, base: BASE, tree: TREE1 }, TREE1]);
      assert.deepEqual([landed.checks!.passed, landed.checks!.submissionId, landed.checks!.tree, landed.queued?.submissionId], [true, S1, TREE1, S1]);
      assert.deepEqual(await r.queued(), [[S2, r.t2]], "only the landed submission left the queue");
      assert.equal(r.told.length, 1, "a passing gate tells nobody");
      // A repeat answers the record: no second check, no second landing.
      const again = await r.land("p1", r.t1, S1);
      assert.deepEqual([again.replayed, again.state, r.calls.checks.length, r.calls.runs.length], [true, "done", 2, 1]);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the queue moving while the checks run lands nothing, even when the checks passed (cards P09 and P10)`, async () => {
    const r = await rig();
    try {
      r.host.exit = "passed";
      // While the host runs the checks, the owner takes S1 out of the queue: the passing gate is not enough, the queue is shown again and the host is never asked to land.
      r.host.duringChecks = async () => r.queueOps.remove(r.owner, { commandId: "out", taskId: r.t1, reason: "not this one after all" });
      const out = await r.land("m1", r.t1);
      assert.equal(out.state, "refused", out.summary);
      assert.match(out.summary!, /no longer the oldest approved one in the landing queue, so nothing was landed/);
      assert.equal(out.checks!.passed, true);
      assert.deepEqual([r.calls.checks.length, r.calls.runs.length], [1, 0]);
      assert.deepEqual(await r.queued(), [[S2, r.t2]]);
    } finally { await r.store.close(); }
  });
}
