import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { LandingGate, type LandingCheckHostReport } from "../landing/index.js";
import { IntegrationPolicyService } from "../policy/integration-policy.js";
import { PrincipalService } from "../security/index.js";
import { SubmissionService } from "../submissions/index.js";
import { WorkspaceOpService, type WorkspacePort, type WorkspaceDeps } from "./index.js";

after(stopServer);

// Card P09 (fifth slice): the evidence the author recorded on a code submission (Q01b) is compared with the landing gate's own result for the same tree. The real submission service stores the claim, the real landing
// gate and workspace operations judge the landing: an author that recorded `fail` for a check the gate found passing is refused and told why; one that recorded `pass` for a failing check is told so; a claim never
// makes a check pass, and a claim for another tree than the one judged is not compared.
const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), HEAD = "c".repeat(40), T1 = "e".repeat(40), T2 = "d".repeat(40), T3 = "9".repeat(40), P1 = "a".repeat(40), P2 = "f".repeat(40);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
    const task = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
    await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: "ann", grants: [{ action: "task.read", project }] });
    const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
    const submissions = SubmissionService.withEpoch(store.storage, projects.epoch, async () => ["author"], { ...options, reviewersAvailableIn: async () => [] });
    const integration = IntegrationPolicyService.withEpoch(store.storage, projects.epoch, options);
    await integration.set(owner, { commandId: cid("req"), projectId: project, requiredChecks: ["tests", "review"] });
    // The controller's own composition: the gate reads the submission through the real service (start.ts passes `submissions.approvalOf`).
    const gate = new LandingGate({ requiredChecks: async (p) => (await integration.effective(p)).requiredChecks, tests: async () => ({ version: 1, checks: [{ name: "unit", run: ["node", "--test"] }] }), approvalOf: (id) => submissions.approvalOf(id), now: options.clock });
    const host = { change: { base: BASE, head: HEAD, tree: T1, patchId: P1 } as LandingCheckHostReport["change"], reviewedPatch: P1 as string | undefined, unit: "passed" as "passed" | "failed" };
    const calls = { runs: 0 };
    const port = (): WorkspacePort => ({
      run: async () => { calls.runs++; return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1 } }; },
      landingChecks: async (call) => ({ checkout: true, ...(host.change === undefined ? {} : { change: host.change }), ...(call.reviewed === undefined || host.reviewedPatch === undefined ? {} : { reviewedPatchId: host.reviewedPatch }), checks: call.checks.map((c) => ({ name: c.name, state: host.unit, exitCode: host.unit === "passed" ? 0 : 1 })) }),
    });
    const told: { text: string }[] = [];
    const deps = (): WorkspaceDeps => ({
      quiesce: { around: async (_scope, _op, run, after) => { const out = await run({ attempts: [{ attemptId: "att-1" }] } as never); await after?.("att-1"); return out; } },
      portOf: async () => port(),
      assignee: async () => "agent:bob",
      attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async () => true },
      approvalOf: (id) => submissions.approvalOf(id),
      landingGate: (call) => gate.evaluate(call),
      tellAuthor: async (x) => { told.push(x); },
    });
    const service = WorkspaceOpService.withEpoch(store.storage, projects.epoch, deps(), options);
    const submit = async (tree: string, patchId: string, evidence: { check: string; result: string; boundTo: string }[]) => (await submissions.record(ann, { commandId: cid("sub"), taskId: task, kind: "code", role: "author", base: BASE, tree, patchId, evidence } as never)).id as string;
    const land = (commandId: string, submissionId: string) => service.request(owner, { commandId, operation: "landing", taskId: task, reason: "ready", submissionId });
    return { store, host, calls, told, submit, land, submissions };
  };

  test(`${backend.name}: evidence saying fail for a check the gate found passing refuses the landing and tells the author why; a new submission with matching evidence lands (card P09)`, async () => {
    const r = await rig();
    try {
      const bad = await r.submit(T1, P1, [{ check: "tests", result: "fail", boundTo: T1 }]);
      assert.deepEqual((await r.submissions.approvalOf(bad))?.evidence, [{ check: "tests", result: "fail", boundTo: T1 }], "the real service passes the claim to the gate");
      const refused = await r.land("c1", bad);
      assert.equal(refused.state, "refused", refused.summary);
      const tests = refused.checks!.results.find((x) => x.check === "tests")!;
      assert.deepEqual([tests.result, tests.disagreement, tests.claimed], ["fail", "claimed_fail_passed", "fail"]);
      assert.match(tests.summary, /says fail, but the gate found it passing/);
      assert.equal(refused.checks!.results.find((x) => x.check === "review")!.result, "pass");
      assert.equal(r.calls.runs, 0, "nothing was landed");
      assert.equal(r.told.length, 1);
      assert.match(r.told[0]!.text, /tests: failed\. the author's own evidence for tests on this tree says fail, but the gate found it passing/);
      // A replay of the same landing answers the stored outcome.
      assert.equal((await r.land("c1", bad)).state, "refused");
      assert.equal(r.told.length, 1);
      // The author's way out: the very same tree submitted again (a new submission) with evidence that matches what the gate finds lands; the stale claim does not block it.
      const same = await r.submit(T1, P1, [{ check: "tests", result: "pass", boundTo: T1 }]);
      assert.notEqual(same, bad);
      const ok = await r.land("c2", same);
      assert.equal(ok.state, "done", ok.summary);
      assert.equal(ok.checks!.passed, true);
      assert.equal(r.calls.runs, 1);
      // So does newer work with matching evidence.
      r.host.change = { base: BASE, head: HEAD, tree: T2, patchId: P2 }; r.host.reviewedPatch = P2;
      const good = await r.submit(T2, P2, [{ check: "tests", result: "pass", boundTo: T2 }]);
      assert.equal((await r.land("c3", good)).state, "done");
      assert.equal(r.calls.runs, 2);
      assert.equal(r.told.length, 1, "nothing more was told");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: evidence saying pass for a failing check is flagged and never passes it; fixing the work lands (card P09)`, async () => {
    const r = await rig();
    try {
      const sub = await r.submit(T1, P1, [{ check: "tests", result: "pass", boundTo: T1 }]);
      r.host.unit = "failed";
      const refused = await r.land("p1", sub);
      assert.equal(refused.state, "refused", refused.summary);
      const tests = refused.checks!.results.find((x) => x.check === "tests")!;
      assert.deepEqual([tests.result, tests.disagreement, tests.claimed], ["fail", "claimed_pass_failed", "pass"]);
      assert.match(tests.summary, /says pass, but the gate found it failing/);
      assert.equal(r.calls.runs, 0);
      r.host.unit = "passed";
      assert.equal((await r.land("p2", sub)).state, "done");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: evidence bound to the submitted tree is not compared with a refreshed tree's result, and evidence for a check the project does not require is ignored (card P09)`, async () => {
    const r = await rig();
    try {
      const sub = await r.submit(T1, P1, [{ check: "tests", result: "fail", boundTo: T1 }, { check: "lint", result: "fail", boundTo: T1 }]);
      // The work was refreshed onto a newer base: the same patch on another tree, so the claim (for T1) is not about the tree the gate judged.
      r.host.change = { base: "8".repeat(40), head: HEAD, tree: T3, patchId: P1 };
      const ok = await r.land("t1", sub);
      assert.equal(ok.state, "done", ok.summary);
      assert.deepEqual(ok.checks!.results.map((x) => [x.check, x.result, x.disagreement]), [["tests", "pass", undefined], ["review", "pass", undefined]]);
      // The same claim on the judged tree refuses.
      r.host.change = { base: BASE, head: HEAD, tree: T1, patchId: P1 };
      assert.equal((await r.land("t2", sub)).state, "refused");
    } finally { await r.store.close(); }
  });
}
