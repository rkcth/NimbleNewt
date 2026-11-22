import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { CommandRunner } from "../domain/runner.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { LandingGate, type LandingCheckHostReport } from "../landing/index.js";
import { IntegrationPolicyService } from "../policy/integration-policy.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { AssignmentService } from "../domain/assignments.js";
import { DocObligationService, QaEvidenceService, landingDocsGate, landingQaGate } from "../submissions/index.js";
import type { JsonObject } from "../storage/types.js";
import { WorkspaceOpService, type WorkspacePort, type WorkspaceDeps } from "./index.js";

after(stopServer);

// Card P09 (fourth slice): the `docs` required check is collected at landing. The real documentation obligation service (Q03), the real QA evidence service and the real landing gate: every kept document that describes the task must
// be verified against the named code, a document that is not goes back to the author by name, a document recorded while the host ran the checks refuses the landing, and the verification carries over to the
// integrated tree only while the host-computed patch ID is unchanged. Reading is read only: nothing is flagged and no update task is opened by a landing.
const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), HEAD = "c".repeat(40), TREE = "e".repeat(40), OLD_TREE = "d".repeat(40), PATCH = "a".repeat(40), NEW_PATCH = "f".repeat(40);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const rig = async (required: readonly ("qa" | "review" | "tests" | "docs")[] = ["docs"]) => {
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
    const dora = await agent("dora", ["docs"]);
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
    const assignments = AssignmentService.withEpoch(store.storage, projects.epoch, projects, options);
    const docService = DocObligationService.withEpoch(store.storage, projects.epoch, {
      rolesOf: async (id) => roles.get(id) ?? [],
      gate: (by, s) => qaService.gate(by, s),
      newestChecked: async (by, t) => (await qaService.list(by, t)).items.find((e) => e.source === "independent")?.submissionId,
      projects, assignments,
    }, options);
    const approvals = new Map<string, { taskId: string; base: string; tree: string; patchId?: string; approved: boolean; approvedBy?: string; newest?: "approve" | "changes" | "reject"; submittedBy?: string }>([
      [sub, { taskId: task, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: ann.id }],
    ]);
    const gate = new LandingGate({
      requiredChecks: async (p) => (await integration.effective(p)).requiredChecks,
      tests: async () => undefined,
      approvalOf: async (id) => approvals.get(id),
      // The controller's own composition (start.ts uses the same function).
      qaGate: landingQaGate(qaService),
      docsGate: landingDocsGate(docService),
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
    const land = (commandId: string, submissionId: string | null = sub) => service.request(owner, { commandId, operation: "landing", taskId: task, reason: "ready", ...(submissionId === null ? {} : { submissionId }) });
    const evidence = (by: Principal, result: string, extra: { submissionId?: string; criteriaRevision?: number } = {}) => qaService.record(by, { commandId: cid("ev"), submissionId: sub, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "smoke", result }], ...extra });
    // A second code submission of the same task (another tree), and one of another task.
    const sub2 = derivedId("sbm", cid("sub2"));
    await plant("submission", sub2, { ...code, tree: OLD_TREE, patchId: NEW_PATCH, submittedAt: "2026-11-18T09:10:00.000Z" });
    approvals.set(sub2, { taskId: task, base: BASE, tree: OLD_TREE, patchId: NEW_PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: ann.id });
    const otherTask = (await projects.createTask({ commandId: cid("t2"), actor: owner.id, projectId: project, title: "T2" })).id;
    const foreign = derivedId("sbm", cid("subx"));
    await plant("submission", foreign, { ...code, taskId: otherTask });
    approvals.set(foreign, { taskId: otherTask, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: ann.id });
    const document = async (at = "2026-11-18T09:40:00.000Z"): Promise<string> => { const id = derivedId("sbm", cid("doc")); await plant("submission", id, { taskId: task, projectId: project, kind: "document", role: "docs", submittedBy: dora.id, submittedAt: at, makesCommit: false, artifactDigest: `sha256:${"e".repeat(64)}`, evidence: [] }); return id; };
    const passed = (s: string, result = "passed") => qaService.record(qa, { commandId: cid("qa"), submissionId: s, criteriaRevision: 0, environment: "linux", observedAt: "2026-11-18T09:30:00.000Z", checks: [{ name: "smoke", result }] });
    const record = (title: string, refs: string[] = [task]) => docService.record(dora, { commandId: cid("dr"), projectId: project, title, location: `docs/${title}.md`, audience: "user", owner: dora.id, applicableVersion: "1.0", implementationRefs: refs });
    const verify = async (obligationId: string, s: string, doc: string) => { const rev = (await docService.get(owner, obligationId) as unknown as { revision: number }).revision; return docService.verify(dora, { commandId: cid("dv"), obligationId, expectedRevision: rev, documentSubmissionId: doc, evidence: [s] }); };
    const snapshot = async (): Promise<string> => JSON.stringify((await docService.list(owner, project)).items.map((i) => [i.id, i.revision, i.state, i.updates.length]));
    return { store, owner, ann, qa, dora, docService, document, passed, record, verify, snapshot, task, otherTask, sub, sub2, foreign, approvals, host, calls, told, land, evidence, plant, integration, project };
  };

  test(`${backend.name}: the docs check passes when no document describes the task, and a document that is not verified against the named code refuses and is named to the author (card P09)`, async () => {
    const r = await rig();
    try {
      const none = await r.land("d0");
      assert.equal(none.state, "done", none.summary);
      assert.match(none.checks!.results[0]!.summary, /no documentation obligation describes this task/);
      assert.deepEqual(r.calls.checks[0]!.reviewed, { base: BASE, tree: TREE }, "the host computes the patch ID when only docs is required");
      const ob = await r.record("User guide");
      const elsewhere = await r.record("Other guide", [r.otherTask]);
      const before = await r.snapshot();
      const unverified = await r.land("d1");
      assert.deepEqual([unverified.state, unverified.checks!.results[0]!.result], ["refused", "fail"], unverified.summary);
      assert.match(unverified.checks!.results[0]!.summary, /1 of 1 document\(s\).*User guide \(it was never verified/);
      assert.match(r.told[0]!.text, /docs: failed/);
      assert.equal(r.calls.runs.length, 1, "only the first landing wrote");
      assert.equal(await r.snapshot(), before, "a refused landing flags nothing and opens no update task");
      // Verification needs tested code; then the document is verified against the named code and the landing is made.
      await r.passed(r.sub);
      await r.verify(ob.id, r.sub, await r.document());
      const ok = await r.land("d2");
      assert.equal(ok.state, "done", ok.summary);
      assert.deepEqual([ok.checks!.results[0]!.result, ok.checks!.results[0]!.boundTo], ["pass", TREE]);
      assert.match(ok.checks!.results[0]!.summary, /all 1 document/);
      assert.ok(elsewhere.id);
      assert.equal(r.calls.runs.length, 2);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a document checked against other code, a stale document and a document whose tested code lost its QA gate each refuse; a retired document does not count (card P09)`, async () => {
    const r = await rig();
    try {
      const ob = await r.record("Guide");
      await r.passed(r.sub);
      await r.verify(ob.id, r.sub, await r.document());
      assert.equal((await r.land("e0")).state, "done");
      // New tested code of the task (another tree): the document describes the old code, so landing the new code is refused (and the old code still lands).
      await r.passed(r.sub2);
      r.host.change = { base: BASE, head: HEAD, tree: OLD_TREE, patchId: NEW_PATCH };
      r.host.reviewedPatch = NEW_PATCH;
      const newer = await r.land("e1", r.sub2);
      assert.deepEqual([newer.state, newer.checks!.results[0]!.result], ["refused", "fail"], newer.summary);
      assert.match(newer.checks!.results[0]!.summary, /verified against tree e{12}, not this code \(tree d{12}\)/);
      // The impact check flags it stale; landing either code is then refused until a keeper verifies it against the newest code.
      const impact = await r.docService.impact(r.owner, { commandId: cid("imp"), taskId: r.task, submissionId: r.sub2 });
      assert.deepEqual(impact.flagged, [ob.id]);
      const stale = await r.land("e2", r.sub2);
      assert.match(stale.checks!.results[0]!.summary, /it is stale and its update is still due/);
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: PATCH }; r.host.reviewedPatch = PATCH;
      assert.equal((await r.land("e3")).checks!.results[0]!.result, "fail");
      const before = await r.snapshot();
      await r.verify(ob.id, r.sub2, await r.document("2026-11-18T10:30:00.000Z"));
      assert.equal(await r.snapshot() === before, false);
      r.host.change = { base: BASE, head: HEAD, tree: OLD_TREE, patchId: NEW_PATCH }; r.host.reviewedPatch = NEW_PATCH;
      assert.equal((await r.land("e4", r.sub2)).state, "done");
      // Its tested code loses the QA gate (independent evidence that failed): the document no longer stands on tested code.
      await r.passed(r.sub2, "failed");
      const lost = await r.land("e5", r.sub2);
      assert.deepEqual([lost.state, lost.checks!.results[0]!.result], ["refused", "fail"]);
      assert.match(lost.checks!.results[0]!.summary, /no longer passes its QA gate/);
      // A retired document is no longer kept: it does not hold a landing.
      await r.docService.retire(r.owner, { commandId: cid("ret"), obligationId: ob.id, expectedRevision: (await r.docService.get(r.owner, ob.id) as unknown as { revision: number }).revision });
      assert.equal((await r.land("e6", r.sub2)).state, "done");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a document recorded while the host runs the checks refuses the landing; a landing that names no submission is not run (no reader and an unreadable answer: landing-gate.test.ts) (card P09)`, async () => {
    const r = await rig();
    try {
      r.host.during = async () => { await r.record("Late guide"); };
      const late = await r.land("l1");
      assert.deepEqual([late.state, late.checks!.results[0]!.result], ["refused", "fail"], late.summary);
      assert.match(late.checks!.results[0]!.summary, /Late guide/);
      r.host.during = undefined;
      const unnamed = await r.land("l2", null);
      assert.deepEqual([unnamed.state, unnamed.checks!.results[0]!.result], ["refused", "not_run"]);
      assert.match(unnamed.checks!.results[0]!.summary, /names no code submission/);
      assert.equal(r.calls.runs.length, 0);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a document verified against another submission of the task with the very same tree counts while that code's QA gate passes; the reader refuses code of another task (card P09)`, async () => {
    const r = await rig();
    try {
      const ob = await r.record("Guide");
      await r.passed(r.sub);
      await r.verify(ob.id, r.sub, await r.document());
      // The same code submitted again (no QA evidence of its own): the document stands on the first submission's tested code.
      const again = derivedId("sbm", cid("again"));
      await r.plant("submission", again, { taskId: r.task, projectId: r.project, kind: "code", role: "author", submittedBy: r.ann.id, submittedAt: "2026-11-18T09:20:00.000Z", makesCommit: true, base: BASE, tree: TREE, patchId: PATCH, evidence: [] });
      r.approvals.set(again, { taskId: r.task, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: r.ann.id });
      const same = await r.land("s1", again);
      assert.equal(same.state, "done", same.summary);
      // That tested code loses its QA gate: the document no longer stands on tested code, and the summary names the code it was verified against.
      await r.passed(r.sub, "failed");
      const lost = await r.land("s2", again);
      assert.deepEqual([lost.state, lost.checks!.results[0]!.result], ["refused", "fail"], lost.summary);
      assert.ok(lost.checks!.results[0]!.summary.includes(`verified against (${r.sub}) no longer passes its QA gate`), lost.checks!.results[0]!.summary);
      // Read directly, the reader refuses a submission of another task (the landing gate compares the task too).
      await assert.rejects(landingDocsGate(r.docService)(r.task, r.foreign), /is code of task/);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the document verification carries over to a refreshed tree only while the patch ID is unchanged; the submission's claim is checked against the host's patch (card P09)`, async () => {
    const r = await rig();
    try {
      const ob = await r.record("Guide");
      await r.passed(r.sub);
      await r.verify(ob.id, r.sub, await r.document());
      r.host.change = { base: "9".repeat(40), head: HEAD, tree: OLD_TREE, patchId: PATCH };
      const carried = await r.land("c1");
      assert.equal(carried.state, "done", carried.summary);
      assert.match(carried.checks!.results[0]!.summary, /carried over to this tree because the patch is unchanged/);
      assert.equal(carried.checks!.results[0]!.boundTo, OLD_TREE);
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: NEW_PATCH };
      const changed = await r.land("c2");
      assert.deepEqual([changed.state, changed.checks!.results[0]!.result], ["refused", "fail"]);
      assert.match(changed.checks!.results[0]!.summary, /differs from the code the documents were checked against/);
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: PATCH };
      r.host.reviewedPatch = NEW_PATCH;
      const claimed = await r.land("c3");
      assert.deepEqual([claimed.state, claimed.checks!.results[0]!.result], ["refused", "fail"]);
      assert.match(claimed.checks!.results[0]!.summary, /names patch a{12}, but its base and tree make patch f{12}/);
      r.host.reviewedPatch = undefined;
      const unknown = await r.land("c4");
      assert.deepEqual([unknown.state, unknown.checks!.results[0]!.result], ["refused", "not_run"]);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: docs beside qa: both must pass; neither stands in for the other (card P09)`, async () => {
    const r = await rig(["docs", "qa"]);
    try {
      const ob = await r.record("Guide");
      const none = await r.land("b1");
      assert.deepEqual(none.checks!.results.map((x) => [x.check, x.result]), [["qa", "not_run"], ["docs", "fail"]]);
      assert.equal(none.state, "refused");
      assert.equal(r.calls.runs.length, 0);
      await r.passed(r.sub);
      const half = await r.land("b2");
      assert.deepEqual(half.checks!.results.map((x) => [x.check, x.result]), [["qa", "pass"], ["docs", "fail"]], "a QA pass does not stand in for documents");
      await r.verify(ob.id, r.sub, await r.document());
      const both = await r.land("b3");
      assert.equal(both.state, "done", both.summary);
      assert.deepEqual(both.checks!.results.map((x) => x.result), ["pass", "pass"]);
    } finally { await r.store.close(); }
  });
}
