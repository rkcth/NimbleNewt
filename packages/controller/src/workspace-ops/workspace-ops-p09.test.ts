import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { LandingGate, type LandingCheckHostReport } from "../landing/index.js";
import { ContractService } from "../planning/contracts.js";
import { IntegrationPolicyService } from "../policy/integration-policy.js";
import { scopedCommandId } from "../security/credentials.js";
import { PrincipalService } from "../security/index.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceDeps, type WorkspacePort } from "./index.js";

after(stopServer);

// Card P09: a landing is gated on the project's required checks, judged on the exact tree it would make. The controller's side through the real policy, contract and gate services: the host is asked to land only after every
// required check passed, and then only for the tree the checks ran on; a refusal is recorded with the results bound to that tree and goes back to the author; not run counts as failed; the review carries over by patch ID.
const options = { clock: () => "2026-11-18T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), HEAD = "c".repeat(40), TREE = "e".repeat(40), OLD_TREE = "d".repeat(40), PATCH = "a".repeat(40), NEW_PATCH = "f".repeat(40);
const S1 = "sbm-aaaaaaaaaaaaaaaaaaaa", S2 = "sbm-bbbbbbbbbbbbbbbbbbbb";
const refuses = async (code: string, run: () => Promise<unknown>, match?: RegExp) => assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); if (match !== undefined) assert.match(e.message, match); return true; });

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: "p", actor: owner.id, name: "P" })).id;
    const task = (await projects.createTask({ commandId: "t", actor: owner.id, projectId: project, title: "T" })).id;
    const other = (await projects.createTask({ commandId: "t2", actor: owner.id, projectId: project, title: "T2" })).id;
    await principals.enroll(owner, { commandId: "e-ann", kind: "agent", name: "ann", grants: [{ action: "task.read", project }, { action: "task.contract.write", project }] });
    const ann = await principals.authenticate((await principals.issueCredential(owner, "agent:ann")).token);
    const integration = IntegrationPolicyService.withEpoch(store.storage, projects.epoch, options);
    const contracts = ContractService.withEpoch(store.storage, projects.epoch, options);
    // The submissions as `SubmissionService.approvalOf` answers them: S1 is the task's code submission by ann, S2 another task's.
    const approvals = new Map<string, { taskId: string; base: string; tree: string; patchId?: string; approved: boolean; approvedBy?: string; newest?: "approve" | "changes" | "reject"; reason?: string; submittedBy?: string }>([
      [S1, { taskId: task, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", newest: "approve", submittedBy: "agent:ann" }],
      [S2, { taskId: other, base: BASE, tree: TREE, patchId: PATCH, approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann" }],
    ]);
    const gate = new LandingGate({ requiredChecks: async (p) => (await integration.effective(p)).requiredChecks, tests: (t, a) => contracts.landingTests(t, a), approvalOf: async (id) => approvals.get(id), now: options.clock });
    // The host: what the landing would carry and how each test command ended; every call is kept.
    const host = { change: { base: BASE, head: HEAD, tree: TREE, patchId: PATCH } as LandingCheckHostReport["change"], exit: new Map<string, "passed" | "failed" | "not-run">(), landingChecks: true, throws: false };
    const calls: { checks: Parameters<NonNullable<WorkspacePort["landingChecks"]>>[0][]; runs: WorkspaceCall[] } = { checks: [], runs: [] };
    const port = (): WorkspacePort => ({
      run: async (call) => { calls.runs.push(call); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1 } }; },
      ...(host.landingChecks ? { landingChecks: async (call: Parameters<NonNullable<WorkspacePort["landingChecks"]>>[0]) => {
        calls.checks.push(call);
        if (host.throws) throw new Error("the host went away");
        return { checkout: true, ...(host.change === undefined ? {} : { change: host.change }), checks: call.checks.map((c) => ({ name: c.name, state: host.exit.get(c.name) ?? "passed", exitCode: host.exit.get(c.name) === "failed" ? 1 : 0, ...(host.exit.get(c.name) === "failed" ? { output: `${c.name}: 1 test failed` } : {}) })) };
      } } : {}),
    });
    const told: { commandId: string; taskId: string; to: string; text: string }[] = [];
    const toldAttempts: string[] = [];
    let tellFails = false;
    const deps = (more: Partial<WorkspaceDeps> = {}): WorkspaceDeps => ({
      quiesce: { around: async (_scope, _op, run, after) => { const out = await run({ attempts: [{ attemptId: "att-1" }] } as never); await after?.("att-1"); return out; } },
      portOf: async () => port(),
      assignee: async () => "agent:bob",
      attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async (id, text) => { toldAttempts.push(`${id}: ${text}`); return true; } },
      approvalOf: async (id) => approvals.get(id),
      landingGate: (call) => gate.evaluate(call),
      tellAuthor: async (n) => { if (tellFails) throw new Error("inbox full"); told.push(n); },
      ...more,
    });
    const service = (more: Partial<WorkspaceDeps> = {}) => WorkspaceOpService.withEpoch(store.storage, projects.epoch, deps(more), options);
    const land = (svc: WorkspaceOpService, commandId: string, submissionId?: string) => svc.request(owner, { commandId, operation: "landing", taskId: task, reason: "reviewed and ready", ...(submissionId === undefined ? {} : { submissionId }) });
    const recorded = async (commandId: string) => store.storage.getAggregate({ kind: "workspace-request", id: derivedId("wsr", scopedCommandId(owner.id, commandId)) });
    const setChecks = async (by: typeof owner, checks: { name: string; run: string[] }[]) => {
      const now = await contracts.get(owner, task);
      await contracts.setContract(by, { commandId: `c-${by.id}-${now?.version ?? 0}`, taskId: task, expectedVersion: now?.version ?? 0, checks });
    };
    return { store, owner, ann, project, task, approvals, host, calls, told, toldAttempts, setTellFails: (v: boolean) => { tellFails = v; }, integration, service, land, recorded, setChecks };
  };

  test(`${backend.name}: a failing test command refuses the landing before anything is written; the results are recorded bound to the integrated tree and go back to the author (card P09)`, async () => {
    const r = await rig();
    try {
      await r.setChecks(r.owner, [{ name: "unit", run: ["npm", "test"] }, { name: "lint", run: ["lint"] }]);
      r.host.exit.set("unit", "failed");
      const out = await r.land(r.service(), "l1", S1);
      assert.equal(out.state, "refused", out.summary);
      assert.match(out.summary!, /^the required checks did not all pass on the integrated tree e{12} \(tests failed; a check that did not run counts as failed\), so nothing was landed/);
      assert.equal(r.calls.runs.length, 0, "the host was never asked to land");
      assert.deepEqual(r.calls.checks.map((c) => c.checks.map((x) => x.name)), [["unit", "lint"]], "the contract's commands, from the owner's version");
      const checks = out.checks!;
      assert.deepEqual([checks.passed, checks.tree, checks.patchId, checks.base, checks.submissionId, checks.required], [false, TREE, PATCH, BASE, S1, ["tests", "review"]]);
      assert.deepEqual(checks.results.map((x) => [x.check, x.result, x.boundTo]), [["tests", "fail", TREE], ["review", "pass", TREE]]);
      assert.deepEqual(((await r.recorded("l1"))!.body as { checks?: unknown }).checks, checks, "the results are on the stored record");
      assert.equal(out.landedSubmission, S1);
      // Back to the author: the agent that submitted the reviewed code (not the assignee), with the failing command's output; and the quiet attempt is told.
      assert.equal(out.toldAuthor, "agent:ann");
      assert.deepEqual(r.told.map((n) => [n.to, n.taskId, n.commandId]), [["agent:ann", r.task, `lgc-${out.id}`]]);
      assert.match(r.told[0]!.text, /- tests: failed\. 1 of 2 test command\(s\) failed on the integrated tree: unit\n  - unit: exit 1: unit: 1 test failed/);
      assert.deepEqual(out.told, ["att-1"]);
      assert.match(r.toldAttempts[0]!, /^att-1: \[workspace\] Your work on task .* was not landed: the required checks did not all pass/);
      // A repeat answers the record; nothing is run again.
      const again = await r.land(r.service(), "l1", S1);
      assert.deepEqual([again.replayed, again.state, r.calls.checks.length, r.told.length], [true, "refused", 1, 1]);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: when every required check passes the host is asked to land exactly the tree the checks ran on; a project that requires nothing is not gated and names no tree (card P09)`, async () => {
    const r = await rig();
    try {
      await r.setChecks(r.owner, [{ name: "unit", run: ["npm", "test"] }]);
      const out = await r.land(r.service(), "l2", S1);
      assert.equal(out.state, "done", out.summary);
      assert.deepEqual([out.checks!.passed, r.calls.runs.length, r.calls.runs[0]!.checkedTree], [true, 1, TREE]);
      assert.equal(r.told.length, 0);
      await r.integration.set(r.owner, { commandId: "none", projectId: r.project, requiredChecks: [] });
      const free = await r.land(r.service(), "l3");
      assert.equal(free.state, "done", free.summary);
      assert.deepEqual([free.checks!.required, free.checks!.passed, r.calls.checks.length], [[], true, 1], "the host was not asked for checks");
      assert.equal(r.calls.runs[1]!.checkedTree, undefined);
      // Other operations are never gated.
      r.host.exit.set("unit", "failed");
      await r.integration.set(r.owner, { commandId: "back", projectId: r.project, requiredChecks: ["tests"] });
      const refreshed = await r.service().request(r.owner, { commandId: "l4", operation: "refresh", taskId: r.task, reason: "move it" });
      assert.deepEqual([refreshed.state, refreshed.checks, r.calls.checks.length], ["done", undefined, 1]);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: not run counts as failed: no test commands, a host that cannot check, a host that throws, no review named, an unreadable policy (card P09)`, async () => {
    const r = await rig();
    try {
      const refused = async (commandId: string, svc: WorkspaceOpService, submissionId: string | undefined, why: RegExp) => {
        const out = await r.land(svc, commandId, submissionId);
        assert.equal(out.state, "refused", out.summary);
        assert.match(JSON.stringify(out.checks?.results ?? out.summary), why);
        return out;
      };
      // No contract at all: tests did not run.
      const noTests = await refused("n1", r.service(), S1, /has no contract naming test commands/);
      assert.deepEqual(noTests.checks!.results.map((x) => x.result), ["not_run", "pass"]);
      await r.setChecks(r.owner, [{ name: "unit", run: ["npm", "test"] }]);
      // The landing names no reviewed submission: review did not run.
      const noReview = await refused("n2", r.service(), undefined, /names no reviewed code submission/);
      assert.deepEqual(noReview.checks!.results.map((x) => x.result), ["pass", "not_run"]);
      r.host.landingChecks = false;
      const cannot = await refused("n3", r.service(), S1, /cannot run landing checks/);
      assert.deepEqual([cannot.checks!.tree, cannot.checks!.results.map((x) => x.result)], [undefined, ["not_run", "not_run"]]);
      r.host.landingChecks = true; r.host.throws = true;
      await refused("n4", r.service(), S1, /could not run the landing checks: the host went away/);
      r.host.throws = false;
      const unreadable = await r.land(r.service({ landingGate: async () => { throw new Error("policy store down"); } }), "n5", S1);
      assert.equal(unreadable.state, "refused");
      assert.match(unreadable.summary!, /required checks could not be read, so nothing was landed: policy store down/);
      assert.equal(r.calls.runs.length, 0, "no landing was asked of the host");
      // A failed notice is recorded as not told; the landing is still refused.
      r.setTellFails(true);
      const quiet = await refused("n6", r.service(), undefined, /names no reviewed/);
      assert.equal(quiet.toldAuthor, undefined);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the review carries over to a refreshed tree only while the patch ID is unchanged; the author's own contract change is not used (card P09)`, async () => {
    const r = await rig();
    try {
      await r.setChecks(r.owner, [{ name: "unit", run: ["npm", "test"] }]);
      // Reviewed on an older tree, refreshed onto a newer base: same patch, so the approval carries over.
      r.approvals.set(S1, { ...r.approvals.get(S1)!, tree: OLD_TREE });
      const carried = await r.land(r.service(), "r1", S1);
      assert.equal(carried.state, "done", carried.summary);
      assert.match(carried.checks!.results[1]!.summary, /carried over to this tree because the patch is unchanged/);
      // The work changed after the review (a new patch): refused, a new review is needed.
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: NEW_PATCH };
      const changed = await r.land(r.service(), "r2", S1);
      assert.equal(changed.state, "refused");
      assert.equal(changed.checks!.results[1]!.result, "fail");
      assert.match(changed.checks!.results[1]!.summary, /a new review is needed/);
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: PATCH };
      // The author loosens its own contract (no test commands): the owner's version still runs, and still fails.
      r.host.exit.set("unit", "failed");
      await r.setChecks(r.ann, []);
      const loosened = await r.land(r.service({ assignee: async () => "agent:ann" }), "r3", S1);
      assert.equal(loosened.state, "refused");
      assert.deepEqual([loosened.checks!.contractVersion, loosened.checks!.results[0]!.result], [1, "fail"]);
      assert.deepEqual(r.calls.checks.at(-1)!.checks.map((c) => c.name), ["unit"]);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a landing names only a code submission of its own task; an unapproved one is recorded and judged by the gate, not refused at the door (card P09)`, async () => {
    const r = await rig();
    try {
      const svc = r.service();
      await refuses("invalid_command", () => r.land(svc, "s1", "sbm-../x"), /not a submission ID/);
      await refuses("not_found", () => r.land(svc, "s2", S2), /is not a code submission of task/);
      await refuses("not_found", () => r.land(svc, "s3", "sbm-cccccccccccccccccccc"), /is not a code submission of task/);
      await refuses("unavailable", () => r.land(r.service({ approvalOf: undefined } as never), "s4", S1), /submissions are not known/);
      for (const id of ["s1", "s2", "s3", "s4"]) assert.equal(await r.recorded(id), undefined, `${id} recorded nothing`);
      await r.setChecks(r.owner, [{ name: "unit", run: ["npm", "test"] }]);
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: false, newest: "changes", reason: "its newest review (sbm-x) says changes" });
      const out = await r.land(svc, "s5", S1);
      assert.deepEqual([out.state, out.landedSubmission, out.checks!.results[1]!.result], ["refused", S1, "fail"]);
      assert.match(out.checks!.results[1]!.summary, /says changes/);
    } finally { await r.store.close(); }
  });
}
