import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { ProjectService } from "../domain/service.js";
import { LandingGate, type LandingCheckHostReport } from "../landing/index.js";
import { IntegrationPolicyService } from "../policy/integration-policy.js";
import { PrincipalService, type Principal } from "../security/index.js";
import { SubmissionService, landingDirectorGate } from "../submissions/index.js";
import { WorkspaceOpService, type WorkspacePort, type WorkspaceDeps } from "./index.js";

after(stopServer);

// Card P09 (sixth slice): the `director` required check at landing, with the real submission service (its sign-off records and their per-submission list) and the real landing gate on all four backends. A landing goes ahead
// only when the newest director sign-off of the landed submission says approve; none is not run, a decline fails (and goes back to the author), a later sign-off replaces an earlier one, a sign-off recorded while the host ran
// the checks is seen, and it carries over to a refreshed tree only while the host-computed patch ID is unchanged.
const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), HEAD = "c".repeat(40), TREE = "e".repeat(40), OLD_TREE = "d".repeat(40), PATCH = "a".repeat(40), NEW_PATCH = "f".repeat(40);
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

for (const backend of backends) {
  const rig = async (required: readonly ("director" | "review")[] = ["director"]) => {
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
    const dee = await agent("dee", ["director"]);
    const dot = await agent("dot", ["director"]);
    const rev = await agent("rev", ["reviewer"]);
    const svc = SubmissionService.withEpoch(store.storage, projects.epoch, async (id) => roles.get(id) ?? [], options);
    const code = async (tree = TREE, patchId = PATCH): Promise<string> => (await svc.record(ann, { commandId: cid("code"), taskId: task, kind: "code", role: "author", base: BASE, tree, patchId })).id;
    const sub = await code();
    const integration = IntegrationPolicyService.withEpoch(store.storage, projects.epoch, options);
    await integration.set(owner, { commandId: cid("req"), projectId: project, requiredChecks: [...required] });
    const gate = new LandingGate({
      requiredChecks: async (p) => (await integration.effective(p)).requiredChecks,
      tests: async () => undefined,
      approvalOf: (id) => svc.approvalOf(id),
      // The controller's own composition (start.ts uses the same function).
      directorGate: async (id) => landingDirectorGate(svc)(id),
      now: options.clock,
    });
    const host = { change: { base: BASE, head: HEAD, tree: TREE, patchId: PATCH } as LandingCheckHostReport["change"], reviewedPatch: PATCH as string | undefined, during: undefined as undefined | (() => Promise<void>) };
    const calls: { checks: Parameters<NonNullable<WorkspacePort["landingChecks"]>>[0][]; runs: unknown[] } = { checks: [], runs: [] };
    const port = (): WorkspacePort => ({
      run: async (call) => { calls.runs.push(call); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1 } }; },
      landingChecks: async (call) => {
        calls.checks.push(call);
        if (host.during !== undefined) await host.during();
        return { checkout: true, ...(host.change === undefined ? {} : { change: host.change }), ...(call.reviewed === undefined || host.reviewedPatch === undefined ? {} : { reviewedPatchId: host.reviewedPatch, reviewedReplays: true }), checks: [] };
      },
    });
    const told: { text: string }[] = [];
    const deps = (): WorkspaceDeps => ({
      quiesce: { around: async (_scope, _op, run, after) => { const out = await run({ attempts: [{ attemptId: "att-1" }] } as never); await after?.("att-1"); return out; } },
      portOf: async () => port(),
      assignee: async () => "agent:bob",
      attempts: { live: async () => [], frozenReason: async () => undefined, release: async () => undefined, tell: async () => true },
      approvalOf: (id) => svc.approvalOf(id),
      landingGate: (call) => gate.evaluate(call),
      tellAuthor: async (x) => { told.push(x); },
    });
    const service = WorkspaceOpService.withEpoch(store.storage, projects.epoch, deps(), options);
    const land = (commandId: string, submissionId: string | undefined = sub) => service.request(owner, { commandId, operation: "landing", taskId: task, reason: "ready", ...(submissionId === undefined ? {} : { submissionId }) });
    const signoff = (by: Principal, decision: "approve" | "decline", subject = sub) => svc.record(by, { commandId: cid("so"), taskId: task, kind: "signoff", role: "director", subject, decision });
    return { roles, store, owner, ann, dee, dot, rev, task, sub, svc, code, host, calls, told, land, signoff, projects, project };
  };

  test(`${backend.name}: the director check passes only on a director's approval of the named submission: none is not run, a decline fails, the newest sign-off decides (card P09)`, async () => {
    const r = await rig();
    try {
      const none = await r.land("d0");
      assert.equal(none.state, "refused", none.summary);
      assert.deepEqual(none.checks!.results.map((x) => [x.check, x.result]), [["director", "not_run"]]);
      assert.match(none.checks!.results[0]!.summary, /no director has signed off/);
      assert.equal(r.calls.runs.length, 0, "nothing was landed");
      assert.equal(r.told.length, 1, "the author is told");
      assert.match(r.told[0]!.text, /director: not run/);
      await r.signoff(r.dee, "decline");
      const declined = await r.land("d1");
      assert.deepEqual([declined.state, declined.checks!.results[0]!.result], ["refused", "fail"]);
      assert.match(declined.checks!.results[0]!.summary, /declines it/);
      assert.match(r.told[1]!.text, /director: failed/);
      // A later approval (by another director) replaces the decline.
      await r.signoff(r.dot, "approve");
      const ok = await r.land("d2");
      assert.equal(ok.state, "done", ok.summary);
      assert.deepEqual([ok.checks!.passed, ok.checks!.results[0]!.result, ok.checks!.results[0]!.boundTo], [true, "pass", TREE]);
      assert.match(ok.checks!.results[0]!.summary, new RegExp(`signed off by ${r.dot.id.replace(/[:.]/g, "\\$&")} for this tree`));
      assert.equal(r.calls.runs.length, 1);
      assert.deepEqual(r.calls.checks[2]!.reviewed, { base: BASE, tree: TREE }, "the host computes the patch ID even when only director is required");
      // A later decline takes the approval back.
      await r.signoff(r.dee, "decline");
      const back = await r.land("d3");
      assert.deepEqual([back.state, back.checks!.results[0]!.result], ["refused", "fail"]);
      assert.equal(r.calls.runs.length, 1);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: nobody but a director other than the submitter can give the sign-off the check reads, and a review is never one (card P09)`, async () => {
    const r = await rig();
    try {
      await assert.rejects(r.signoff(r.ann, "approve"), (e: { code?: string }) => e.code === "forbidden", "the author holds no director role");
      await assert.rejects(r.svc.record(r.rev, { commandId: cid("so"), taskId: r.task, kind: "signoff", role: "director", subject: r.sub, decision: "approve" }), (e: { code?: string }) => e.code === "forbidden", "a reviewer claiming the director role");
      // A director that submitted the work cannot sign it off.
      r.roles.set(r.dee.id, ["director", "author"]);
      const mine = (await r.svc.record(r.dee, { commandId: cid("code"), taskId: r.task, kind: "code", role: "author", base: BASE, tree: OLD_TREE, patchId: NEW_PATCH })).id;
      await assert.rejects(r.signoff(r.dee, "approve", mine), (e: { code?: string }) => e.code === "forbidden");
      // A review approval and QA-style records do not count as a director approval.
      await r.svc.record(r.rev, { commandId: cid("rv"), taskId: r.task, kind: "review", role: "reviewer", subject: r.sub, verdict: "approve" });
      const out = await r.land("n1");
      assert.deepEqual([out.state, out.checks!.results[0]!.result], ["refused", "not_run"], out.summary);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a sign-off on another submission of the task does not count for the landed one, not even one with the very same tree and patch, nor one on a document submission (card P09)`, async () => {
    const r = await rig();
    try {
      // Another code submission of the task with exactly the landed tree and patch: its approval is its own, never the landed submission's.
      const twin = await r.code(TREE, PATCH);
      await r.signoff(r.dee, "approve", twin);
      // A document submission of the same task, signed off: its list is keyed by the document, which no landing reads.
      r.roles.set(r.ann.id, ["author", "docs"]);
      const doc = (await r.svc.record(r.ann, { commandId: cid("doc"), taskId: r.task, kind: "document", role: "docs", artifactDigest: `sha256:${"0".repeat(64)}` })).id;
      await r.signoff(r.dot, "approve", doc);
      const twinOut = await r.land("o0");
      assert.deepEqual([twinOut.state, twinOut.checks!.results[0]!.result], ["refused", "not_run"], twinOut.summary);
      assert.match(twinOut.checks!.results[0]!.summary, /no director has signed off/);
      assert.equal(r.calls.runs.length, 0);
      const other = await r.code(OLD_TREE, NEW_PATCH);
      await r.signoff(r.dee, "approve", other);
      const out = await r.land("o1");
      assert.deepEqual([out.state, out.checks!.results[0]!.result], ["refused", "not_run"], out.summary);
      assert.equal(r.calls.runs.length, 0);
      // The other submission, with its own sign-off, would be judged on its own.
      r.host.change = { base: BASE, head: HEAD, tree: OLD_TREE, patchId: NEW_PATCH };
      r.host.reviewedPatch = NEW_PATCH;
      assert.equal((await r.land("o2", other)).state, "done");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a decline recorded while the host runs the checks refuses the landing, because the sign-off is read again afterwards (card P09)`, async () => {
    const r = await rig();
    try {
      await r.signoff(r.dee, "approve");
      r.host.during = async () => { await r.signoff(r.dot, "decline"); };
      const out = await r.land("w1");
      assert.equal(out.state, "refused", out.summary);
      assert.equal(out.checks!.results[0]!.result, "fail");
      assert.equal(r.calls.runs.length, 0);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the sign-off carries over to a refreshed tree only while the host's patch ID is unchanged; an unreadable patch is not run (card P09)`, async () => {
    const r = await rig();
    try {
      await r.signoff(r.dee, "approve");
      r.host.change = { base: "9".repeat(40), head: HEAD, tree: OLD_TREE, patchId: PATCH };
      const carried = await r.land("c1");
      assert.equal(carried.state, "done", carried.summary);
      assert.match(carried.checks!.results[0]!.summary, /carried over to this tree because the patch is unchanged/);
      assert.equal(carried.checks!.results[0]!.boundTo, OLD_TREE);
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: NEW_PATCH };
      const changed = await r.land("c2");
      assert.deepEqual([changed.state, changed.checks!.results[0]!.result], ["refused", "fail"]);
      assert.match(changed.checks!.results[0]!.summary, /differs from what the director signed off/);
      r.host.change = { base: BASE, head: HEAD, tree: TREE, patchId: PATCH };
      r.host.reviewedPatch = NEW_PATCH;
      assert.deepEqual([(await r.land("c3")).checks!.results[0]!.result], ["fail"]);
      r.host.reviewedPatch = undefined;
      assert.deepEqual([(await r.land("c4")).checks!.results[0]!.result], ["not_run"]);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: director beside review: both must pass; an approved review does not stand in for the director and the director does not stand in for the review (card P09)`, async () => {
    const r = await rig(["review", "director"]);
    try {
      await r.svc.record(r.rev, { commandId: cid("rv"), taskId: r.task, kind: "review", role: "reviewer", subject: r.sub, verdict: "approve" });
      const noDirector = await r.land("b1");
      assert.deepEqual(noDirector.checks!.results.map((x) => [x.check, x.result]), [["review", "pass"], ["director", "not_run"]]);
      await r.signoff(r.dee, "approve");
      assert.equal((await r.land("b2")).state, "done");
      await r.svc.record(r.rev, { commandId: cid("rv"), taskId: r.task, kind: "review", role: "reviewer", subject: r.sub, verdict: "changes" });
      const unreviewed = await r.land("b3");
      assert.deepEqual(unreviewed.checks!.results.map((x) => [x.check, x.result]), [["review", "fail"], ["director", "pass"]]);
    } finally { await r.store.close(); }
  });
}
