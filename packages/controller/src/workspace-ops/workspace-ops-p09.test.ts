import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
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
const BASE = "b".repeat(40), OLD_BASE = "9".repeat(40), HEAD = "c".repeat(40), TREE = "e".repeat(40), OLD_TREE = "d".repeat(40), PATCH = "a".repeat(40), NEW_PATCH = "f".repeat(40);
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
    const host = { change: { base: BASE, head: HEAD, tree: TREE, patchId: PATCH } as LandingCheckHostReport["change"], exit: new Map<string, "passed" | "failed" | "not-run">(), landingChecks: true, throws: false, reviewedPatch: PATCH as string | undefined };
    const calls: { checks: Parameters<NonNullable<WorkspacePort["landingChecks"]>>[0][]; runs: WorkspaceCall[] } = { checks: [], runs: [] };
    const port = (): WorkspacePort => ({
      run: async (call) => { calls.runs.push(call); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1 } }; },
      ...(host.landingChecks ? { landingChecks: async (call: Parameters<NonNullable<WorkspacePort["landingChecks"]>>[0]) => {
        calls.checks.push(call);
        if (host.throws) throw new Error("the host went away");
        return { checkout: true, ...(host.change === undefined ? {} : { change: host.change }), ...(call.reviewed === undefined || host.reviewedPatch === undefined ? {} : { reviewedPatchId: host.reviewedPatch, reviewedReplays: true }), checks: call.checks.map((c) => ({ name: c.name, state: host.exit.get(c.name) ?? "passed", exitCode: host.exit.get(c.name) === "failed" ? 1 : 0, ...(host.exit.get(c.name) === "failed" ? { output: `${c.name}: 1 test failed` } : {}) })) };
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
    return { store, epoch: projects.epoch, principals, owner, ann, project, task, approvals, host, calls, told, toldAttempts, setTellFails: (v: boolean) => { tellFails = v; }, integration, contracts, service, land, recorded, setChecks };
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
      assert.deepEqual(r.calls.checks[0]!.reviewed, { base: BASE, tree: TREE }, "the host computes the patch ID of the reviewed base and tree");
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
      // Reviewed as another tree on the SAME base, with the same patch ID (the same edit at another place of a file): no refresh happened, so the tree itself is compared and the landing is refused (card P08 landing
      // re-check). The owner is told once per request; the approval and the submission are left as they are.
      const reviewedAs = r.approvals.get(S1)!;
      r.approvals.set(S1, { ...reviewedAs, tree: OLD_TREE });
      const owner: { commandId: string; taskId: string; text: string }[] = [];
      const notifying = r.service({ notify: async (n) => { owner.push(n); } });
      const placed = await r.land(notifying, "r0", S1);
      assert.equal(placed.state, "refused", placed.summary);
      assert.equal(placed.checks!.results[1]!.result, "fail");
      assert.equal(placed.checks!.results[1]!.treeMismatch, true);
      assert.match(placed.checks!.results[1]!.summary, /approved for tree d{12}, but the landing carries tree e{12} on the same base b{12}; .*a new submission and review are needed/);
      assert.equal(r.calls.runs.length, 0, "the host is never asked to land");
      assert.equal(owner.length, 1);
      assert.match(owner[0]!.text, /^Task \S+ was not landed \(wsr-[a-z2-7]{20}\): its tree is not exactly what its review judged, only the same patch ID\. A new submission must be judged\.$/);
      assert.ok(owner[0]!.text.length <= 200);
      assert.equal((await r.land(notifying, "r0", S1)).state, "refused", "a repeat answers the recorded outcome");
      assert.equal(owner.length, 1, "the owner is not told again for the same request");
      assert.deepEqual(r.approvals.get(S1), { ...reviewedAs, tree: OLD_TREE }, "the submission's approval is not touched");
      // Reviewed on an older tree of an older base, refreshed onto a newer base: same patch, so the approval carries over.
      r.approvals.set(S1, { ...reviewedAs, base: OLD_BASE, tree: OLD_TREE });
      const carried = await r.land(notifying, "r1", S1);
      assert.equal(carried.state, "done", carried.summary);
      assert.match(carried.checks!.results[1]!.summary, /carried over to this tree because the patch is unchanged/);
      assert.equal(carried.checks!.results[1]!.treeMismatch, undefined);
      assert.equal(owner.length, 1, "a landing that passed tells the owner nothing of this");
      // The work changed after the review (a new patch): refused, a new review is needed.
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: NEW_PATCH };
      const changed = await r.land(r.service(), "r2", S1);
      assert.equal(changed.state, "refused");
      assert.equal(changed.checks!.results[1]!.result, "fail");
      assert.match(changed.checks!.results[1]!.summary, /a new review is needed/);
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: PATCH };
      // The submission names the landed patch but its base and tree, read by the host, make another: refused.
      r.host.reviewedPatch = NEW_PATCH;
      const claimed = await r.land(r.service(), "r2b", S1);
      assert.equal(claimed.state, "refused");
      assert.match(claimed.checks!.results[1]!.summary, /names patch a{12}, but its base and tree make patch f{12}/);
      r.host.reviewedPatch = undefined;
      const unknown = await r.land(r.service(), "r2c", S1);
      assert.deepEqual([unknown.state, unknown.checks!.results[1]!.result], ["refused", "not_run"]);
      r.host.reviewedPatch = PATCH;
      // The submitter (ann, not the assignee bob) loosens its own contract (a command that always passes): the owner's version still runs, and still fails.
      r.host.exit.set("unit", "failed");
      await r.setChecks(r.ann, [{ name: "trivial", run: ["true"] }]);
      const loosened = await r.land(r.service(), "r3", S1);
      assert.equal(loosened.state, "refused");
      assert.deepEqual([loosened.checks!.contractVersion, loosened.checks!.results[0]!.result], [1, "fail"]);
      assert.deepEqual(r.calls.checks.at(-1)!.checks.map((c) => c.name), ["unit"]);
      // The same when ann is the assignee and the landing names no submission.
      const asAssignee = await r.land(r.service({ assignee: async () => "agent:ann" }), "r4");
      assert.deepEqual([asAssignee.state, asAssignee.checks!.contractVersion, asAssignee.checks!.results[0]!.result], ["refused", 1, "fail"]);
      // Someone else then stores a version that changes another field (the owner's priority): the checks it carries forward are still ann's, so they still do not count (second review).
      await r.contracts.setContract(r.owner, { commandId: "prio", taskId: r.task, expectedVersion: 2, priority: 7 });
      const carried2 = await r.land(r.service(), "r5", S1);
      assert.deepEqual([carried2.state, carried2.checks!.contractVersion, carried2.checks!.results[0]!.result], ["refused", 1, "fail"]);
      assert.deepEqual(r.calls.checks.at(-1)!.checks.map((c) => c.name), ["unit"]);
      // The owner sets the checks itself: from then on they are the owner's, whoever stores a later version that leaves them alone.
      await r.setChecks(r.owner, [{ name: "unit", run: ["npm", "test"] }, { name: "lint", run: ["lint"] }]);
      await r.contracts.setContract(r.ann, { commandId: "crit", taskId: r.task, expectedVersion: 4, acceptanceCriteria: ["the unit tests pass"] });
      const owners = await r.land(r.service(), "r6", S1);
      assert.deepEqual([owners.checks!.contractVersion, r.calls.checks.at(-1)!.checks.map((c) => c.name)], [5, ["unit", "lint"]]);
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

  test(`${backend.name}: checks set only by the task's own authors: the owner gets a needs-you notice once per contract version, and naming the same checks accepts them so the landing runs them (card P09 follow-up)`, async () => {
    const r = await rig();
    try {
      const owned: { commandId: string; taskId: string; text: string }[] = [];
      let notifyFails = false;
      const svc = () => r.service({ notify: async (n) => { if (notifyFails) throw new Error("notices down"); owned.push(n); } });
      // No contract at all: the owner is asked to set test commands.
      const none = await r.land(svc(), "o0", S1);
      assert.deepEqual([none.state, none.checks!.testsNeedOwner, none.toldOwner], ["refused", "no-commands", true]);
      assert.match(none.summary!, /the task has no test commands, so the owner is asked to set them/);
      assert.deepEqual(owned.map((n) => n.commandId), [`lgo-${r.task}-v0-no-commands`]);
      // Only ann (the submitter) set the checks: they do not run, ann is told, and so is the owner.
      await r.setChecks(r.ann, [{ name: "trivial", run: ["true"] }]);
      const out = await r.land(svc(), "o1", S1);
      assert.equal(out.state, "refused", out.summary);
      assert.deepEqual([out.checks!.testsNeedOwner, out.checks!.contractVersion, out.checks!.results[0]!.result, out.toldOwner, out.toldAuthor], ["authors-only", 1, "not_run", true, "agent:ann"]);
      assert.match(out.summary!, /set only by its own authors, so the owner is asked to set or accept them/);
      assert.deepEqual([owned[1]!.commandId, owned[1]!.taskId], [`lgo-${r.task}-v1-authors-only`, r.task]);
      assert.ok(owned[1]!.text.length <= 200, owned[1]!.text);
      assert.match(owned[1]!.text, /cannot land: its test commands were set only by its own agents.*Set or accept them \(contract\.set checks\)/);
      assert.match(r.told.at(-1)!.text, /the owner was told/);
      assert.equal(((await r.recorded("o1"))!.body as { toldOwner?: unknown }).toldOwner, true, "on the stored record");
      // The next landing while nothing changed carries the same notice identity (the notice service answers a repeat once).
      await r.land(svc(), "o2", S1);
      assert.equal(owned[2]!.commandId, owned[1]!.commandId);
      // The author naming its own checks again is no change and accepts nothing.
      await refuses("invalid_command", () => r.contracts.setContract(r.ann, { commandId: "self", taskId: r.task, expectedVersion: 1, checks: [{ name: "trivial", run: ["true"] }] }), /already has these values/);
      // The owner names the same checks: that accepts them, and the landing runs them.
      const accepted = await r.contracts.setContract(r.owner, { commandId: "accept", taskId: r.task, expectedVersion: 1, checks: [{ name: "trivial", run: ["true"] }] });
      assert.equal(accepted.revision, 2);
      const v2 = (await r.contracts.history(r.owner, r.task))!.at(-1)! as unknown as { checksSetBy?: string; changedBy: string };
      assert.deepEqual([v2.changedBy, v2.checksSetBy], [r.owner.id, r.owner.id]);
      const landed = await r.land(svc(), "o3", S1);
      assert.equal(landed.state, "done", landed.summary);
      assert.deepEqual([landed.checks!.contractVersion, landed.checks!.testsNeedOwner, landed.toldOwner, r.calls.checks.at(-1)!.checks.map((c) => c.name)], [2, undefined, undefined, ["trivial"]]);
      assert.equal(owned.length, 3, "a landing that passed tells the owner nothing");
      // Accepted once: naming them again is no change.
      await refuses("invalid_command", () => r.contracts.setContract(r.owner, { commandId: "again", taskId: r.task, expectedVersion: 2, checks: [{ name: "trivial", run: ["true"] }] }), /already has these values/);
      // A later version that does not name the checks (ann's criteria) does not carry the acceptance mark, and the owner's acceptance still counts.
      await r.contracts.setContract(r.ann, { commandId: "crit", taskId: r.task, expectedVersion: 2, acceptanceCriteria: ["it works"] });
      assert.equal(((await r.contracts.history(r.owner, r.task))!.at(-1)! as unknown as { checksSetBy?: string }).checksSetBy, undefined);
      // The author naming the owner's accepted checks is an acceptance of its own: it does not count, the owner's still does.
      await r.contracts.setContract(r.ann, { commandId: "ann-accept", taskId: r.task, expectedVersion: 3, checks: [{ name: "trivial", run: ["true"] }] });
      const still = await r.land(svc(), "o4", S1);
      assert.deepEqual([still.state, still.checks!.contractVersion], ["done", 3], "ann's version 4 is skipped back to version 3, which carries the owner's accepted checks");
      // A failing command is the author's to fix: the owner is not told.
      r.host.exit.set("trivial", "failed");
      const failing = await r.land(svc(), "o5", S1);
      assert.deepEqual([failing.state, failing.checks!.testsNeedOwner, failing.toldOwner, owned.length], ["refused", undefined, undefined, 3]);
      // A notice that cannot be sent is recorded as not told; the landing is still refused.
      notifyFails = true;
      await r.setChecks(r.ann, [{ name: "other", run: ["true"] }]);
      const quiet = await r.land(svc(), "o6", S1);
      assert.deepEqual([quiet.state, quiet.checks!.results[0]!.result, quiet.toldOwner], ["refused", "fail", undefined], "ann's new checks do not run; the owner's accepted ones still do");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the owner made the contract without checks and the author added them: authors-only, and a notice that cannot be sent is recorded as not told (card P09 follow-up, first review)`, async () => {
    const r = await rig();
    try {
      let notifyFails = true;
      const owned: string[] = [];
      const svc = () => r.service({ notify: async (n) => { if (notifyFails) throw new Error("notices down"); owned.push(n.commandId); } });
      await r.contracts.setContract(r.owner, { commandId: "own-crit", taskId: r.task, expectedVersion: 0, acceptanceCriteria: ["it works"] });
      await r.setChecks(r.ann, [{ name: "trivial", run: ["true"] }]);
      const failed = await r.land(svc(), "p1", S1);
      assert.deepEqual([failed.state, failed.checks!.testsNeedOwner, failed.checks!.contractVersion, failed.toldOwner], ["refused", "authors-only", 2, undefined]);
      assert.equal(((await r.recorded("p1"))!.body as { toldOwner?: unknown }).toldOwner, undefined, "not recorded as told");
      notifyFails = false;
      const told = await r.land(svc(), "p2", S1);
      assert.deepEqual([told.checks!.testsNeedOwner, told.toldOwner, owned], ["authors-only", true, [`lgo-${r.task}-v2-authors-only`]]);
      // The owner accepting them makes them count.
      await r.contracts.setContract(r.owner, { commandId: "own-accept", taskId: r.task, expectedVersion: 2, checks: [{ name: "trivial", run: ["true"] }] });
      assert.equal((await r.land(svc(), "p3", S1)).state, "done");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: accepting checks needs the authority to set them (card P09 follow-up)`, async () => {
    const r = await rig();
    try {
      await r.setChecks(r.ann, [{ name: "trivial", run: ["true"] }]);
      // cid may read the task but not change its contract.
      await r.principals.enroll(r.owner, { commandId: "e-cid", kind: "agent", name: "cid", grants: [{ action: "task.read", project: r.project }] });
      const reader = await r.principals.authenticate((await r.principals.issueCredential(r.owner, "agent:cid")).token);
      await refuses("forbidden", () => r.contracts.setContract(reader, { commandId: "cid-accept", taskId: r.task, expectedVersion: 1, checks: [{ name: "trivial", run: ["true"] }] }));
      assert.equal((await r.contracts.get(r.owner, r.task))!.version, 1, "nothing stored");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a difficulty version stored by someone else over the author's checks does not make them count, nor does a version that carries the author's checksSetBy under another changedBy (card P09 follow-up, second review)`, async () => {
    const r = await rig();
    try {
      const runner = new CommandRunner(r.store.storage, r.epoch, options);
      // Commits contract version changes the way difficulty.set does (one command), with the change built by the caller.
      const commit = (commandId: string, build: () => Promise<{ changes: Parameters<CommandRunner["command"]>[2] extends (m: never) => Promise<{ build: () => Promise<infer B> }> ? B extends { changes: infer C } ? C : never : never; version: number }>) =>
        runner.command("difficulty.set", { commandId, actor: "agent:par" }, async () => ({ payload: { taskId: r.task }, build: async () => { const c = await build(); return { ref: { kind: "task-contract", id: r.task }, creates: false, changes: c.changes, detail: { version: c.version } }; } }));
      await r.setChecks(r.ann, [{ name: "trivial", run: ["true"] }]);
      // The delegating parent sets the difficulty (contracts.difficultyChanges, as DifficultyService does): a version by someone else that does not name the checks.
      await commit("diff-1", async () => (await r.contracts.difficultyChanges("agent:par", r.task, "hard", 1))!);
      const v2 = (await r.contracts.history(r.owner, r.task))!.at(-1)! as unknown as { changedBy: string; checksSetBy?: string; difficulty?: string };
      assert.deepEqual([v2.changedBy, v2.checksSetBy, v2.difficulty], ["agent:par", undefined, "hard"], "the difficulty version does not carry ann's checksSetBy");
      const first = await r.land(r.service(), "d1", S1);
      assert.deepEqual([first.state, first.checks!.testsNeedOwner, first.checks!.contractVersion, first.checks!.results[0]!.result], ["refused", "authors-only", 2, "not_run"]);
      // A version that kept ann's checksSetBy while someone else stored it (as a writer that copied the body would): the checks are still ann's.
      const now = (await r.store.storage.getAggregate({ kind: "task-contract", id: r.task }))!;
      const carried = { ...(now.body as Record<string, unknown>), version: 3, changedBy: "agent:par", checksSetBy: "agent:ann", difficulty: "easy" };
      await commit("carry-1", async () => ({ version: 3, changes: [{ type: "update", ref: { kind: "task-contract", id: r.task }, expectedRevision: now.revision, body: carried as never }, { type: "create", ref: { kind: "task-contract-version", id: `${r.task}.3` }, body: { ...carried, changedAt: options.clock() } as never }] }));
      const second = await r.land(r.service(), "d2", S1);
      assert.deepEqual([second.state, second.checks!.testsNeedOwner, second.checks!.contractVersion], ["refused", "authors-only", 3], "a carried checksSetBy is read as who set the checks");
      // ann cannot accept them there (still its own), the owner can.
      await refuses("invalid_command", () => r.contracts.setContract(r.ann, { commandId: "ann-again", taskId: r.task, expectedVersion: 3, checks: [{ name: "trivial", run: ["true"] }] }), /already has these values/);
      await r.contracts.setContract(r.owner, { commandId: "own-accept", taskId: r.task, expectedVersion: 3, checks: [{ name: "trivial", run: ["true"] }] });
      assert.equal((await r.land(r.service(), "d3", S1)).state, "done");
    } finally { await r.store.close(); }
  });
}
