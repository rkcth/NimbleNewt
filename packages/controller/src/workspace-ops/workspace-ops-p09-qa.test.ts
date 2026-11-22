import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CommandRunner } from "../domain/runner.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { LandingGate, type LandingCheckHostReport } from "../landing/index.js";
import { IntegrationPolicyService } from "../policy/integration-policy.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { QaEvidenceService, landingQaGate } from "../submissions/index.js";
import type { JsonObject } from "../storage/types.js";
import { WorkspaceOpService, type WorkspacePort, type WorkspaceDeps } from "./index.js";

after(stopServer);

// Card P09 (third slice): the `qa` required check is collected at landing. The real QA evidence service (Q02) and the real landing gate: only independent evidence on the named submission counts, a failure goes back to the
// author with its reasons, evidence invalidated while the host ran the checks refuses the landing, and the evidence carries over to the integrated tree only while the host-computed patch ID is unchanged.
const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), HEAD = "c".repeat(40), TREE = "e".repeat(40), OLD_TREE = "d".repeat(40), PATCH = "a".repeat(40), NEW_PATCH = "f".repeat(40);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const rig = async (required: readonly ("qa" | "review" | "tests")[] = ["qa"]) => {
    const store = await backend.open();
    const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
    const roles = new Map<string, string[]>();
    const agent = async (nm: string, held: string[]): Promise<Principal> => {
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
      const p = await principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
      roles.set(p.id, held);
      return p;
    };
    const ann = await agent("ann", ["author"]);
    const qa = await agent("qa", ["qa"]);
    const runner = new CommandRunner(store.storage, projects.epoch, options);
    const plant = async (kind: string, id: string, body: object): Promise<void> => {
      const found = await runner.get(kind, id);
      await runner.command("test.plant", { commandId: cid("plant"), actor: owner.id }, async () => ({ payload: { kind, id }, build: async () => ({ ref: { kind, id }, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: found.revision, body: body as JsonObject }], detail: {} }) }));
    };
    const sub = derivedId("sbm", cid("sub"));
    const code = { taskId: task, projectId: project, kind: "code", role: "author", submittedBy: ann.id, submittedAt: "2026-11-18T09:00:00.000Z", makesCommit: true, base: BASE, tree: TREE, patchId: PATCH, evidence: [] };
    await plant("submission", sub, code);
    const integration = IntegrationPolicyService.withEpoch(store.storage, projects.epoch, options);
    await integration.set(owner, { commandId: cid("req"), projectId: project, requiredChecks: [...required] });
    const qaService = QaEvidenceService.withEpoch(store.storage, projects.epoch, { rolesOf: async (id) => roles.get(id) ?? [], notify: async () => undefined }, options);
    const approvals = new Map<string, { taskId: string; base: string; tree: string; patchId?: string; approved: boolean; approvedBy?: string; newest?: "approve" | "changes" | "reject"; submittedBy?: string }>([
      [sub, { taskId: task, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: ann.id }],
    ]);
    const gate = new LandingGate({
      requiredChecks: async (p) => (await integration.effective(p)).requiredChecks,
      tests: async () => undefined,
      approvalOf: async (id) => approvals.get(id),
      // The controller's own composition (start.ts uses the same function).
      qaGate: landingQaGate(qaService),
      now: options.clock,
    });
    const host = { change: { base: BASE, head: HEAD, tree: TREE, patchId: PATCH } as LandingCheckHostReport["change"], reviewedPatch: PATCH as string | undefined, during: undefined as undefined | (() => Promise<void>) };
    const calls: { checks: Parameters<NonNullable<WorkspacePort["landingChecks"]>>[0][]; runs: unknown[] } = { checks: [], runs: [] };
    const port = (): WorkspacePort => ({
      run: async (call) => { calls.runs.push(call); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1 } }; },
      landingChecks: async (call) => {
        calls.checks.push(call);
        if (host.during !== undefined) await host.during();
        return { checkout: true, ...(host.change === undefined ? {} : { change: host.change }), ...(call.reviewed === undefined || host.reviewedPatch === undefined ? {} : { reviewedPatchId: host.reviewedPatch }), checks: [] };
      },
    });
    const told: { text: string }[] = [];
    const deps = (): WorkspaceDeps => ({
      quiesce: { around: async (_scope, _op, run, after) => { const out = await run({ attempts: [{ attemptId: "att-1" }] } as never); await after?.("att-1"); return out; } },
      portOf: async () => port(),
      assignee: async () => "agent:bob",
      attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async () => true },
      approvalOf: async (id) => approvals.get(id),
      landingGate: (call) => gate.evaluate(call),
      tellAuthor: async (x) => { told.push(x); },
    });
    const service = WorkspaceOpService.withEpoch(store.storage, projects.epoch, deps(), options);
    const land = (commandId: string, submissionId: string | undefined = sub) => service.request(owner, { commandId, operation: "landing", taskId: task, reason: "ready", ...(submissionId === undefined ? {} : { submissionId }) });
    const evidence = (by: Principal, result: string, extra: { submissionId?: string } = {}) => qaService.record(by, { commandId: cid("ev"), submissionId: sub, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "smoke", result }], ...extra });
    // A second code submission of the same task (another tree), and one of another task.
    const sub2 = derivedId("sbm", cid("sub2"));
    await plant("submission", sub2, { ...code, tree: OLD_TREE, patchId: NEW_PATCH, submittedAt: "2026-11-18T09:10:00.000Z" });
    approvals.set(sub2, { taskId: task, base: BASE, tree: OLD_TREE, patchId: NEW_PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: ann.id });
    const otherTask = (await projects.createTask({ commandId: cid("t2"), actor: owner.id, projectId: project, title: "T2" })).id;
    const foreign = derivedId("sbm", cid("subx"));
    await plant("submission", foreign, { ...code, taskId: otherTask });
    approvals.set(foreign, { taskId: otherTask, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: ann.id });
    return { store, owner, ann, qa, task, sub, sub2, foreign, approvals, host, calls, told, land, evidence, plant, integration, project };
  };

  test(`${backend.name}: the qa check passes only on independent evidence for the named submission; none, a self-check, a failure, blocked and not-run each refuse and go back to the author (card P09)`, async () => {
    const r = await rig();
    try {
      const none = await r.land("q0");
      assert.equal(none.state, "refused", none.summary);
      assert.deepEqual(none.checks!.results.map((x) => [x.check, x.result]), [["qa", "not_run"]], "no evidence is not run");
      assert.match(none.checks!.results[0]!.summary, /did not pass: no_evidence/);
      assert.equal(r.calls.runs.length, 0, "nothing was landed");
      assert.equal(r.told.length, 1, "the author is told");
      assert.match(r.told[0]!.text, /qa: not run/);
      // The author's own check never counts.
      assert.equal((await r.evidence(r.ann, "passed")).source, "self");
      const self = await r.land("q1");
      assert.deepEqual([self.state, self.checks!.results[0]!.result], ["refused", "not_run"]);
      // Independent evidence that failed, was blocked, or did not run fails the check with the reason.
      await r.evidence(r.qa, "failed");
      const failed = await r.land("q2");
      assert.deepEqual([failed.state, failed.checks!.results[0]!.result], ["refused", "fail"]);
      assert.match(failed.checks!.results[0]!.summary, /check_failed/);
      await r.evidence(r.qa, "blocked");
      const blocked = await r.land("q3");
      assert.deepEqual([blocked.state, blocked.checks!.results[0]!.result, /check_blocked/.test(blocked.checks!.results[0]!.summary)], ["refused", "fail", true]);
      await r.evidence(r.qa, "not-run");
      assert.match((await r.land("q3b")).checks!.results[0]!.summary, /check_not_run/);
      assert.equal(r.calls.runs.length, 0);
      // A newer independent pass decides it.
      await r.evidence(r.qa, "passed");
      const ok = await r.land("q4");
      assert.equal(ok.state, "done", ok.summary);
      assert.deepEqual([ok.checks!.passed, ok.checks!.results[0]!.result, ok.checks!.results[0]!.boundTo], [true, "pass", TREE]);
      assert.equal(r.calls.runs.length, 1);
      assert.deepEqual(r.calls.checks[0]!.reviewed, { base: BASE, tree: TREE }, "the host computes the patch ID even when only qa is required");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: evidence that stops holding while the host runs the checks refuses the landing, because the gate is read again afterwards (card P09)`, async () => {
    const r = await rig();
    try {
      await r.evidence(r.qa, "passed");
      r.host.during = async () => { await r.evidence(r.qa, "failed"); };
      const out = await r.land("d1");
      assert.equal(out.state, "refused", out.summary);
      assert.equal(out.checks!.results[0]!.result, "fail");
      assert.equal(r.calls.runs.length, 0);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the evidence carries over to a refreshed tree only while the patch ID is unchanged, the submission's own claim is checked against the host's patch, and an unreadable patch is not run (card P09)`, async () => {
    const r = await rig();
    try {
      await r.evidence(r.qa, "passed");
      // Same patch on another tree (the work was refreshed onto a newer base): the evidence carries over.
      r.host.change = { base: "9".repeat(40), head: HEAD, tree: OLD_TREE, patchId: PATCH };
      const carried = await r.land("c1");
      assert.equal(carried.state, "done", carried.summary);
      assert.match(carried.checks!.results[0]!.summary, /carried over to this tree because the patch is unchanged/);
      assert.equal(carried.checks!.results[0]!.boundTo, OLD_TREE);
      // A different patch: the evidence was for other work.
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: NEW_PATCH };
      const changed = await r.land("c2");
      assert.deepEqual([changed.state, changed.checks!.results[0]!.result], ["refused", "fail"]);
      assert.match(changed.checks!.results[0]!.summary, /differs from what QA checked/);
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: PATCH };
      // The submission names the landed patch but its base and tree make another one.
      r.host.reviewedPatch = NEW_PATCH;
      const claimed = await r.land("c3");
      assert.deepEqual([claimed.state, claimed.checks!.results[0]!.result], ["refused", "fail"]);
      assert.match(claimed.checks!.results[0]!.summary, /names patch a{12}, but its base and tree make patch f{12}/);
      r.host.reviewedPatch = undefined;
      const unknown = await r.land("c4");
      assert.deepEqual([unknown.state, unknown.checks!.results[0]!.result], ["refused", "not_run"]);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: qa beside review: both must pass; a QA failure refuses even an approved submission (card P09)`, async () => {
    const r = await rig(["review", "qa"]);
    try {
      const noQa = await r.land("b1");
      assert.equal(noQa.state, "refused");
      assert.deepEqual(noQa.checks!.results.map((x) => [x.check, x.result]), [["review", "pass"], ["qa", "not_run"]]);
      await r.evidence(r.qa, "passed");
      const both = await r.land("b2");
      assert.equal(both.state, "done", both.summary);
      r.approvals.set(r.sub, { ...r.approvals.get(r.sub)!, approved: false, newest: "changes" });
      const unreviewed = await r.land("b3");
      assert.deepEqual(unreviewed.checks!.results.map((x) => [x.check, x.result]), [["review", "fail"], ["qa", "pass"]]);
      assert.equal(unreviewed.state, "refused");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: evidence for another submission of the task, a submission of another task, and evidence made stale by a contract change do not count (card P09)`, async () => {
    const r = await rig();
    try {
      // An independent pass on another submission (another tree) of the same task says nothing about the named one.
      await r.evidence(r.qa, "passed", { submissionId: r.sub2 });
      const other = await r.land("o1");
      assert.deepEqual([other.state, other.checks!.results[0]!.result], ["refused", "not_run"], other.summary);
      assert.match(other.checks!.results[0]!.summary, /no_evidence/);
      // Evidence of another task's submission (same tree and patch) cannot be used by naming it: the request does not find it for this task (the gate's own task check is in landing-gate.test.ts).
      assert.equal((await r.evidence(r.qa, "passed", { submissionId: r.foreign })).source, "independent");
      await assert.rejects(r.land("o2", r.foreign), (error: { code?: string }) => error.code === "not_found");
      assert.equal(r.calls.runs.length, 0);
      // A pass that held, then the task contract changed: the evidence is stale and the landing is refused.
      await r.evidence(r.qa, "passed");
      assert.equal((await r.land("o3")).state, "done");
      await r.plant("task-contract", r.task, { taskId: r.task, version: 1, acceptanceCriteria: ["the page loads"], requiredEvidence: [], checks: [{ name: "smoke", run: ["true"] }] });
      const stale = await r.land("o4");
      assert.deepEqual([stale.state, stale.checks!.results[0]!.result], ["refused", "fail"], stale.summary);
      assert.match(stale.checks!.results[0]!.summary, /stale_evidence/);
      assert.equal(r.calls.runs.length, 1);
    } finally { await r.store.close(); }
  });
}
