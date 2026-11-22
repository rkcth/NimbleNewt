import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { scopedCommandId } from "../security/credentials.js";
import { PrincipalService } from "../security/index.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceDeps, type WorkspaceOutcome } from "./index.js";

after(stopServer);

// Card H12o (automatic release): `releaseApproved` is the controller's own release of a submission that has just been approved. It is the owner's `release` request (same checks, same quiesce, same exactly-once
// record) under the controller's service identity; it does nothing, and never throws, when the work is not approved, the task has a live attempt or is paused, or the commit already exists.
const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), TREE = "e".repeat(40), COMMIT = "c".repeat(40);
const S1 = "sbm-aaaaaaaaaaaaaaaaaaaa";
const committed = (call: WorkspaceCall, permitted: boolean): WorkspaceOutcome => ({ ok: true, summary: "committed", detail: { committed: true, commit: COMMIT, parent: call.submission!.base, tree: call.submission!.tree, files: 1, submission: call.submission!.id, recovered: false, changed: true, ...(permitted ? { permitted: true } : {}) } });
const SERVICE = "service:workspace-release";

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: "p", actor: owner.id, name: "P" })).id;
    const task = (await projects.createTask({ commandId: "t", actor: owner.id, projectId: project, title: "T" })).id;
    const approvals = new Map<string, { taskId: string; base: string; tree: string; approved: boolean; approvedBy?: string; reason?: string; submittedBy?: string }>([[S1, { taskId: task, base: BASE, tree: TREE, approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann" }]]);
    const calls: WorkspaceCall[] = [];
    const state = { live: [] as string[], paused: false, quiesced: 0, fail: false };
    const deps: WorkspaceDeps = {
      quiesce: { around: async (_scope, _op, run) => { state.quiesced++; return run({ attempts: [] } as never); } },
      portOf: async () => ({ run: async (call) => { calls.push(call); if (state.fail) throw new Error("the host is down"); return committed(call, call.permit === true); } }),
      approvalOf: async (id) => approvals.get(id),
      attempts: { live: async () => state.live, frozenReason: async () => undefined, release: async () => undefined },
      paused: async () => state.paused,
    };
    const service = WorkspaceOpService.withEpoch(store.storage, projects.epoch, deps, options);
    const recorded = async (commandId: string, by: string) => store.storage.getAggregate({ kind: "workspace-request", id: derivedId("wsr", scopedCommandId(by, commandId)) });
    return { store, owner, task, approvals, calls, state, service, recorded };
  };

  test(`${backend.name}: a reviewer's approval is released by the controller itself as a permit commit, once, recorded under its own identity (card H12o, automatic release)`, async () => {
    const r = await rig();
    try {
      const out = await r.service.releaseApproved(S1, "sbm-review1");
      assert.equal(out?.state, "done", out?.summary);
      assert.deepEqual([r.calls.length, r.calls[0]!.operation, r.calls[0]!.permit, r.calls[0]!.submission], [1, "release", true, { id: S1, base: BASE, tree: TREE }]);
      assert.equal(r.state.quiesced, 1, "it goes through the quiesce like any release");
      assert.equal((await r.service.submissionCommit(S1))?.permitted, true);
      const rec = (await r.recorded("rel-auto:sbm-review1", SERVICE))?.body as { requestedBy?: string; operation?: string } | undefined;
      assert.deepEqual([rec?.requestedBy, rec?.operation], [SERVICE, "release"]);
      // The same approval again, and a later approval: the commit exists, so the host is not asked and nothing is made quiet.
      assert.equal(await r.service.releaseApproved(S1, "sbm-review1"), undefined);
      assert.equal(await r.service.releaseApproved(S1, "sbm-review2"), undefined);
      assert.deepEqual([r.calls.length, r.state.quiesced], [1, 1]);
      // The owner's own request for it is answered from the record.
      const manual = await r.service.request(r.owner, { commandId: "m1", operation: "release", taskId: r.task, reason: "again", submissionId: S1 });
      assert.equal((manual.detail as Record<string, unknown>)["alreadyRecorded"], true);
      assert.equal(r.calls.length, 1);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: the one-agent approval is released without the permit (card H12o, automatic release)`, async () => {
    const r = await rig();
    try {
      r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: true, approvedBy: "review_disabled_single_agent", submittedBy: "agent:ann" });
      const out = await r.service.releaseApproved(S1, S1);
      assert.equal(out?.state, "done", out?.summary);
      assert.equal(r.calls[0]!.permit, undefined);
      assert.equal((await r.service.submissionCommit(S1))?.permitted, undefined);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: nothing is asked and nothing is recorded for work not approved, a task with a live attempt, a paused task, an unknown submission or a bad cause (card H12o, automatic release)`, async () => {
    const r = await rig();
    try {
      r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: false, reason: "its newest review says changes" });
      assert.equal(await r.service.releaseApproved(S1, "c1"), undefined);
      r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann" });
      r.state.live = ["att-1"];
      assert.equal(await r.service.releaseApproved(S1, "c2"), undefined);
      r.state.live = []; r.state.paused = true;
      assert.equal(await r.service.releaseApproved(S1, "c3"), undefined);
      r.state.paused = false;
      assert.equal(await r.service.releaseApproved("sbm-zzzzzzzzzzzzzzzzzzzz", "c4"), undefined);
      assert.equal(await r.service.releaseApproved("not-a-submission", "c5"), undefined);
      assert.equal(await r.service.releaseApproved(S1, "has a space"), undefined);
      assert.deepEqual([r.calls.length, r.state.quiesced], [0, 0]);
      for (const c of ["c1", "c2", "c3", "c4", "c5"]) assert.equal(await r.recorded(`rel-auto:${c}`, SERVICE), undefined, c);
      // None of those used up the approval: the attempt ended, so the next approval releases it.
      const out = await r.service.releaseApproved(S1, "c6");
      assert.equal(out?.state, "done", out?.summary);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a host that fails is the recorded answer, never an error; a later approval tries again and the commit is made once (card H12o, automatic release)`, async () => {
    const r = await rig();
    try {
      r.state.fail = true;
      const failed = await r.service.releaseApproved(S1, "f1");
      assert.equal(failed?.state, "failed", failed?.summary);
      assert.equal(await r.service.submissionCommit(S1), undefined);
      // The same approval is answered from its record (no second try of the same command).
      const again = await r.service.releaseApproved(S1, "f1");
      assert.equal(again?.replayed, true);
      assert.equal(r.calls.length, 1);
      // Another approval is another command.
      r.state.fail = false;
      const ok = await r.service.releaseApproved(S1, "f2");
      assert.equal(ok?.state, "done", ok?.summary);
      assert.equal(r.calls.length, 2);
      assert.equal((await r.service.submissionCommit(S1))?.commitId, COMMIT);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an approval taken back while the task is made quiet refuses the automatic release before the host is asked; a control service has no way to ask for another operation (card H12o, automatic release)`, async () => {
    const r = await rig();
    try {
      const withdrawn = WorkspaceOpService.withEpoch(r.store.storage, (await ProjectService.open(r.store.storage, { holder: "c1", ...options })).epoch, {
        quiesce: { around: async (_s, _o, run) => { r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: false, reason: "its newest review says changes" }); return run({ attempts: [] } as never); } },
        portOf: async () => ({ run: async (call) => { r.calls.push(call); return committed(call, true); } }),
        approvalOf: async (id) => r.approvals.get(id),
      }, options);
      const out = await withdrawn.releaseApproved(S1, "w1");
      assert.equal(out?.state, "refused", out?.summary);
      assert.equal(r.calls.length, 0);
      assert.equal(await withdrawn.submissionCommit(S1), undefined);
      // Without submissions known, nothing happens.
      const blind = WorkspaceOpService.withEpoch(r.store.storage, (await ProjectService.open(r.store.storage, { holder: "c1", ...options })).epoch, { quiesce: { around: async (_s, _o, run) => run({ attempts: [] } as never) }, portOf: async () => undefined }, options);
      assert.equal(await blind.releaseApproved(S1, "w2"), undefined);
    } finally { await r.store.close(); }
  });
}
