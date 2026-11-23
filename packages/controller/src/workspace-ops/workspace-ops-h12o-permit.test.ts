import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { scopedCommandId } from "../security/credentials.js";
import { PrincipalService } from "../security/index.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceDeps, type WorkspaceOutcome } from "./index.js";

after(stopServer);

// Card H12o (permit slice): the controller marks a submission's release as a permit commit only when a reviewer approved it. Before: a release that names an approved submission commits exactly its tree on its base, once. The controller's side: what is refused before anything is recorded, what the host is told,
// the one commit record per submission written with the release that made or found the commit, a repeat answered from that record, and a retry or restart between the commit and its record.
const options = { clock: () => "2026-11-17T10:00:00.000Z", pause: async () => undefined };
const BASE = "b".repeat(40), TREE = "e".repeat(40), COMMIT = "c".repeat(40), OTHER = "f".repeat(40);
const S1 = "sbm-aaaaaaaaaaaaaaaaaaaa", S2 = "sbm-bbbbbbbbbbbbbbbbbbbb";
const refuses = async (code: string, run: () => Promise<unknown>, match?: RegExp) => assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, code, e.message); if (match !== undefined) assert.match(e.message, match); return true; });
/** What the local host answers for a submission's release (see `WorkspaceHost.#release`). */
const committed = (call: WorkspaceCall, more: { recovered?: boolean; commit?: string; tree?: string; submission?: string | null } = {}): WorkspaceOutcome => ({
  ok: true, summary: "committed",
  detail: { committed: true, commit: more.commit ?? COMMIT, parent: call.submission!.base, tree: more.tree ?? call.submission!.tree, files: 1, ...(more.submission === null ? {} : { submission: more.submission ?? call.submission!.id }), recovered: more.recovered === true, changed: more.recovered !== true },
});

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const projects = await ProjectService.open(store.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(store.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const project = (await projects.createProject({ commandId: "p", actor: owner.id, name: "P" })).id;
    const task = (await projects.createTask({ commandId: "t", actor: owner.id, projectId: project, title: "T" })).id;
    const other = (await projects.createTask({ commandId: "t2", actor: owner.id, projectId: project, title: "T2" })).id;
    // The submissions as `SubmissionService.approvalOf` would answer: S1 of `task`, S2 of `other`.
    const approvals = new Map<string, { taskId: string; base: string; tree: string; approved: boolean; approvedBy?: string; reason?: string; submittedBy?: string }>([
      [S1, { taskId: task, base: BASE, tree: TREE, approved: false, reason: "no reviewer has approved it yet" }],
      [S2, { taskId: other, base: BASE, tree: TREE, approved: true, approvedBy: "agent:rev" }],
    ]);
    const calls: WorkspaceCall[] = [];
    let answer: (call: WorkspaceCall) => Promise<WorkspaceOutcome> = async (call) => committed(call);
    let beforeRun: () => void = () => undefined;
    const deps = (more: Partial<WorkspaceDeps> = {}): WorkspaceDeps => ({
      quiesce: { around: async (_scope, _op, run) => { beforeRun(); return run({ attempts: [] } as never); } },
      portOf: async () => ({ run: async (call) => { calls.push(call); return answer(call); } }),
      approvalOf: async (id) => approvals.get(id),
      ...more,
    });
    const service = (more: Partial<WorkspaceDeps> = {}) => WorkspaceOpService.withEpoch(store.storage, projects.epoch, deps(more), options);
    const recorded = async (commandId: string) => store.storage.getAggregate({ kind: "workspace-request", id: derivedId("wsr", scopedCommandId(owner.id, commandId)) });
    return { store, owner, project, task, other, approvals, calls, service, recorded, setAnswer: (f: typeof answer) => { answer = f; }, setBeforeRun: (f: () => void) => { beforeRun = f; } };
  };

  test(`${backend.name}: a reviewer's approval makes the release a permit commit and the record says what the host answered; the one-agent approval never does (card H12o, permit slice)`, async () => {
    const r = await rig();
    try {
      const svc = r.service();
      // A reviewer's approval: the host is told `permit`, and its confirmation is kept on the commit record.
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:rev" });
      r.setAnswer(async (call) => { const o = committed(call); return { ...o, detail: { ...(o as { detail: object }).detail, permitted: true } } as WorkspaceOutcome; });
      const first = await svc.request(r.owner, { commandId: "p1", operation: "release", taskId: r.task, reason: "commit", submissionId: S1 });
      assert.equal(first.state, "done", first.summary);
      assert.equal(r.calls[0]!.permit, true);
      assert.equal((await svc.submissionCommit(S1))?.permitted, true);
      // Asking again is answered from the record and does not ask the host; the answer says it is a permit commit.
      const again = await svc.request(r.owner, { commandId: "p2", operation: "release", taskId: r.task, reason: "again", submissionId: S1 });
      assert.equal(r.calls.length, 1);
      assert.deepEqual([(again.detail as Record<string, unknown>)["alreadyRecorded"], (again.detail as Record<string, unknown>)["permitted"]], [true, true]);
      assert.match(again.summary ?? "", /permit commit/);
      // The one-agent approval (no reviewer judged it): no permit asked, and a host that answers `permitted` anyway is never recorded as having made a permit commit (the controller did not ask for one).
      r.approvals.set(S2, { taskId: r.other, base: BASE, tree: TREE, approved: true, approvedBy: "review_disabled_single_agent" });
      r.setAnswer(async (call) => { const o = committed(call); return { ...o, detail: { ...(o as { detail: object }).detail, permitted: true } } as WorkspaceOutcome; });
      const single = await svc.request(r.owner, { commandId: "p3", operation: "release", taskId: r.other, reason: "commit", submissionId: S2 });
      assert.equal(single.state, "done", single.summary);
      assert.equal(r.calls[1]!.permit, undefined, "no permit is asked for a one-agent approval");
      assert.equal((await svc.submissionCommit(S2))?.permitted, undefined);
      const singleAgain = await svc.request(r.owner, { commandId: "p3b", operation: "release", taskId: r.other, reason: "again", submissionId: S2 });
      assert.deepEqual([r.calls.length, (singleAgain.detail as Record<string, unknown>)["permitted"]], [2, false]);
      assert.doesNotMatch(singleAgain.summary ?? "", /permit commit/);
      // A plain release never carries it.
      r.setAnswer(async () => ({ ok: true, summary: "plain", detail: { committed: true, commit: OTHER, parent: BASE, tree: TREE, files: 1, changed: true } }));
      const plain = await svc.request(r.owner, { commandId: "p4", operation: "release", taskId: r.other, reason: "plain" });
      assert.equal(plain.state, "done");
      assert.equal(r.calls[2]!.permit, undefined);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a host that makes a plain commit for a reviewer-approved request is recorded as not permitted (card H12o, permit slice)`, async () => {
    const r = await rig();
    try {
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:rev" });
      const svc = r.service();
      r.setAnswer(async (call) => committed(call));
      const out = await svc.request(r.owner, { commandId: "q1", operation: "release", taskId: r.task, reason: "commit", submissionId: S1 });
      assert.equal(out.state, "done");
      assert.equal(r.calls[0]!.permit, true);
      assert.equal((await svc.submissionCommit(S1))?.permitted, undefined, "the record never claims a permit the host did not confirm");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an approval carried over from an earlier submission of the same claimed patch is no release permit: refused before anything is recorded or asked, and never released by itself (card Q02 review)`, async () => {
    const r = await rig();
    try {
      (r.approvals as Map<string, object>).set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann", carriedFrom: S2 });
      const svc = r.service();
      await refuses("review_invalid", () => svc.request(r.owner, { commandId: "c1", operation: "release", taskId: r.task, reason: "commit", submissionId: S1 }), /no review of its own/);
      assert.equal(await svc.releaseApproved(S1, "rvw-x"), undefined);
      assert.equal(r.calls.length, 0);
      assert.equal(await r.recorded("c1"), undefined);
      // A review of its own makes it a permit as before.
      r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann" });
      assert.equal((await svc.request(r.owner, { commandId: "c2", operation: "release", taskId: r.task, reason: "commit", submissionId: S1 })).state, "done");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an approval that names the submission's own author is refused before anything is recorded or asked (card H12o, permit slice)`, async () => {
    const r = await rig();
    try {
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:ann", submittedBy: "agent:ann" });
      const svc = r.service();
      await refuses("review_invalid", () => svc.request(r.owner, { commandId: "o1", operation: "release", taskId: r.task, reason: "commit", submissionId: S1 }), /own author/);
      assert.equal(r.calls.length, 0);
      assert.equal(await r.recorded("o1"), undefined);
      // Another reviewer's approval of the same submission is a permit.
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approvedBy: "agent:rev", submittedBy: "agent:ann" });
      const ok = await svc.request(r.owner, { commandId: "o2", operation: "release", taskId: r.task, reason: "commit", submissionId: S1 });
      assert.equal(ok.state, "done", ok.summary);
      assert.equal(r.calls[0]!.permit, true);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an approval that changes while the task is made quiet (to the author's own, or to the one-agent approval) refuses the permit release before the host is asked (card H12o, permit slice)`, async () => {
    const r = await rig();
    try {
      const svc = r.service();
      for (const [i, later] of [{ approvedBy: "agent:ann", submittedBy: "agent:ann" }, { approvedBy: "review_disabled_single_agent", submittedBy: "agent:ann" }].entries()) {
        r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann" });
        r.setBeforeRun(() => { r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: true, ...later }); });
        const out = await svc.request(r.owner, { commandId: `s${i}`, operation: "release", taskId: r.task, reason: "commit", submissionId: S1 });
        assert.equal(out.state, "refused", out.summary);
        assert.match(out.summary ?? "", i === 0 ? /own author/ : /no longer approved by a reviewer/);
        assert.equal(r.calls.length, 0);
        assert.equal(await svc.submissionCommit(S1), undefined);
      }
      // A second reviewer's approval in between still approves it as a reviewer's: the permit is asked.
      r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: true, approvedBy: "agent:rev", submittedBy: "agent:ann" });
      r.setBeforeRun(() => { r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: true, approvedBy: "agent:rev2", submittedBy: "agent:ann" }); });
      const ok = await svc.request(r.owner, { commandId: "s9", operation: "release", taskId: r.task, reason: "commit", submissionId: S1 });
      assert.equal(ok.state, "done", ok.summary);
      assert.equal(r.calls[0]!.permit, true);
    } finally { await r.store.close(); }
  });
}
