import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { scopedCommandId } from "../security/credentials.js";
import { PrincipalService } from "../security/index.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceDeps, type WorkspaceOutcome } from "./index.js";
import { CONTRIBUTOR_APPROVAL_TEXT } from "../submissions/contributors.js";

after(stopServer);

// Card H12o: a release that names an approved submission commits exactly its tree on its base, once. The controller's side: what is refused before anything is recorded, what the host is told,
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
    const approvals = new Map<string, { taskId: string; base: string; tree: string; approved: boolean; approvedBy?: string; reason?: string }>([
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

  test(`${backend.name}: a release names only an approved code submission of its own task; anything else is refused before anything is recorded or any host is asked (card H12o)`, async () => {
    const r = await rig();
    try {
      const svc = r.service();
      const release = (commandId: string, submissionId: unknown, operation = "release") => svc.request(r.owner, { commandId, operation: operation as never, taskId: r.task, reason: "commit the reviewed work", submissionId: submissionId as string });
      await refuses("invalid_command", () => release("a1", S1, "integration"), /only a release commits a submission/);
      await refuses("invalid_command", () => release("a2", "sbm-../x"), /not a submission ID/);
      await refuses("not_found", () => release("a3", "sbm-cccccccccccccccccccc"), /is not a code submission of task/);
      await refuses("not_found", () => release("a4", S2), /is not a code submission of task/);
      await refuses("review_invalid", () => release("a5", S1), /is not approved \(no reviewer has approved it yet\)/);
      // Card Q04 re-check: a not-counted approval's reason is kept whole, the owner's way out included, for an agent named with the full 40 characters.
      const asAnswered = r.approvals.get(S1)!;
      r.approvals.set(S1, { ...asAnswered, reason: `the approval by agent:${"a".repeat(40)} does not count: ${CONTRIBUTOR_APPROVAL_TEXT}` });
      await refuses("review_invalid", () => release("a5q", S1), /the owner adds a reviewer agent or drops the review check\)\); it is committed only once a reviewer approves it$/);
      r.approvals.set(S1, asAnswered);
      await refuses("unavailable", () => r.service({ approvalOf: undefined } as never).request(r.owner, { commandId: "a6", operation: "release", taskId: r.task, reason: "x", submissionId: S1 }), /submissions are not known/);
      // A task credential (even one carrying the owner's grants) never asks for a release, so it cannot have its own task's submission committed; the approval is not even looked up.
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:rev" });
      let looked = 0;
      const counting = r.service({ approvalOf: async (id) => { looked++; return r.approvals.get(id); } });
      const scoped = { ...r.owner, taskScope: { taskId: r.task, projectId: r.project } } as never;
      await refuses("not_found", () => counting.request(scoped, { commandId: "a7", operation: "release", taskId: r.task, reason: "x", submissionId: S1 }), /not yours to manage/);
      assert.equal(looked, 0, "the approval was not looked up for a caller who may not ask");
      r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: false, reason: "no reviewer has approved it yet" });
      for (const id of ["a1", "a2", "a3", "a4", "a5", "a6", "a7"]) assert.equal(await r.recorded(id), undefined, `${id} recorded nothing`);
      assert.equal(r.calls.length, 0, "no host was asked");
      assert.equal(await svc.submissionCommit(S1), undefined);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an approved submission is committed once: the host is told the approved base and tree, the commit is recorded with the release, and asking again answers the record without asking the host (card H12o)`, async () => {
    const r = await rig();
    try {
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:rev" });
      const svc = r.service();
      const first = await svc.request(r.owner, { commandId: "b1", operation: "release", taskId: r.task, reason: "commit the reviewed work", submissionId: S1 });
      assert.equal(first.state, "done", first.summary);
      assert.deepEqual(first.submission, { id: S1, base: BASE, tree: TREE, approvedBy: "agent:rev" });
      assert.deepEqual(r.calls.map((c) => [c.operation, c.submission]), [["release", { id: S1, base: BASE, tree: TREE }]]);
      const made = await svc.submissionCommit(S1);
      assert.deepEqual([made?.commitId, made?.parent, made?.tree, made?.taskId, made?.recovered, made?.requestId], [COMMIT, BASE, TREE, r.task, false, first.id]);
      const again = await svc.request(r.owner, { commandId: "b2", operation: "release", taskId: r.task, reason: "again", submissionId: S1 });
      assert.equal(again.state, "done");
      assert.deepEqual([again.detail?.["alreadyRecorded"], again.detail?.["commit"]], [true, COMMIT]);
      assert.match(again.summary ?? "", /was already committed as cccccccccccc/);
      assert.equal(r.calls.length, 1, "the host was not asked again");
      // A plain release (no submission) is unchanged: it records no submission commit.
      r.setAnswer(async () => ({ ok: true, summary: "plain", detail: { committed: true, commit: OTHER, parent: BASE, tree: TREE, files: 1, changed: true } }));
      const plain = await svc.request(r.owner, { commandId: "b3", operation: "release", taskId: r.other, reason: "plain" });
      assert.equal(plain.state, "done");
      assert.equal(plain.submission, undefined);
      assert.equal(r.calls[1]!.submission, undefined, "nothing about a submission is sent");
      assert.equal(await svc.submissionCommit(S2), undefined);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a host answer that is not this submission's approved commit is recorded as the host said but never as the submission's commit (card H12o)`, async () => {
    const r = await rig();
    try {
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:rev" });
      const svc = r.service();
      for (const [n, more] of [["c1", { submission: null }], ["c2", { tree: OTHER }], ["c3", { submission: S2 }]] as const) {
        r.setAnswer(async (call) => committed(call, more as never));
        const a = await svc.request(r.owner, { commandId: n, operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
        assert.equal(a.state, "done");
        assert.equal(await svc.submissionCommit(S1), undefined, `${n}: not taken as the submission's commit`);
      }
      // A refusal (the checkout no longer holds the approved tree) records nothing either.
      r.setAnswer(async () => ({ ok: false, reason: "the checkout no longer holds the approved work of submission" }));
      const refused = await svc.request(r.owner, { commandId: "c4", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      assert.equal(refused.state, "refused");
      assert.equal(await svc.submissionCommit(S1), undefined);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: an approval taken back while the task is made quiet stops the release before the host is asked (card H12o)`, async () => {
    const r = await rig();
    try {
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:rev" });
      r.setBeforeRun(() => { r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: false, approvedBy: undefined as never, reason: "its newest review (sbm-x) says changes" }); });
      const a = await r.service().request(r.owner, { commandId: "d1", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      assert.equal(a.state, "refused");
      assert.match(a.summary ?? "", /no longer approved, so nothing was committed: .*says changes/);
      assert.equal(r.calls.length, 0);
      // The same for a submission whose approved tree changed in between (a new submission under the same ID cannot happen; the check is still made).
      r.setBeforeRun(() => { r.approvals.set(S1, { taskId: r.task, base: BASE, tree: OTHER, approved: true, approvedBy: "agent:rev" }); });
      r.approvals.set(S1, { taskId: r.task, base: BASE, tree: TREE, approved: true, approvedBy: "agent:rev" });
      const b = await r.service().request(r.owner, { commandId: "d2", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      assert.equal(b.state, "refused");
      assert.match(b.summary ?? "", /changed/);
      assert.equal(r.calls.length, 0);
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: a retry or a restart between the commit and its record records the commit the host finds, once (card H12o)`, async () => {
    const r = await rig();
    try {
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:rev" });
      // The host commits, then its answer is lost: the request failed, no commit is recorded.
      let commits = 0;
      r.setAnswer(async () => { commits++; throw new Error("the connection to the host dropped"); });
      const lost = await r.service().request(r.owner, { commandId: "e1", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      assert.equal(lost.state, "failed");
      assert.equal(await r.service().submissionCommit(S1), undefined);
      // The controller stops while the host works on a second try: the request is left open.
      let hang!: (o: WorkspaceOutcome) => void;
      r.setAnswer(() => new Promise<WorkspaceOutcome>((ok) => { hang = ok; }));
      const first = r.service();
      const left = first.request(r.owner, { commandId: "e2", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      while (r.calls.length < 2) await new Promise((ok) => setTimeout(ok, 5));
      // A new controller over the same records: recovery marks the left request uncertain; a new request finds the commit the host made (the host answers it as recovered, no second commit).
      const second = r.service();
      assert.equal((await second.recover(r.owner)).length, 1);
      r.setAnswer(async (call) => committed(call, { recovered: true }));
      const found = await second.request(r.owner, { commandId: "e3", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      assert.equal(found.state, "done", found.summary);
      const made = await second.submissionCommit(S1);
      assert.deepEqual([made?.commitId, made?.recovered, made?.requestId], [COMMIT, true, found.id]);
      assert.equal(commits, 1);
      // The first controller's call finishes late: its outcome replaces `uncertain`, and the commit record is not written twice or changed.
      hang(committed(r.calls[1]!));
      await left.catch(() => undefined);
      const still = await second.submissionCommit(S1);
      assert.deepEqual([still?.requestId, still?.recovered], [found.id, true]);
      const repeat = await second.request(r.owner, { commandId: "e4", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      assert.equal(repeat.detail?.["alreadyRecorded"], true);
      assert.equal(r.calls.length, 3, "the repeat asked no host");
    } finally { await r.store.close(); }
  });

  test(`${backend.name}: two controllers releasing the same approved submission at the same moment write one commit record, and both requests are recorded done (H12o second review)`, async () => {
    const r = await rig();
    try {
      r.approvals.set(S1, { ...r.approvals.get(S1)!, approved: true, approvedBy: "agent:rev" });
      // The host holds both answers until both requests have asked it, then answers both at once (the second as the commit it found, as a real host does).
      let go!: () => void;
      const together = new Promise<void>((ok) => { go = ok; });
      r.setAnswer(async (call) => { await together; return committed(call, { recovered: r.calls.indexOf(call) === 1 }); });
      const one = r.service(), two = r.service();
      // The second starts once the first is at the host (two starts at the very same moment: one is refused stale_revision on the task's open index, before anything is asked).
      const a = one.request(r.owner, { commandId: "g1", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      while (r.calls.length < 1) await new Promise((ok) => setTimeout(ok, 5));
      const b = two.request(r.owner, { commandId: "g2", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      while (r.calls.length < 2) await new Promise((ok) => setTimeout(ok, 5));
      go();
      const [x, y] = await Promise.all([a, b]);
      assert.deepEqual([x.state, y.state], ["done", "done"], `${x.summary} / ${y.summary}`);
      const made = await one.submissionCommit(S1);
      assert.equal(made?.commitId, COMMIT);
      assert.ok(made !== undefined && [x.id, y.id].includes(made.requestId), "the record names one of the two requests");
      assert.deepEqual([(await r.recorded("g1"))?.body["state"], (await r.recorded("g2"))?.body["state"]], ["done", "done"]);
      const again = await two.request(r.owner, { commandId: "g3", operation: "release", taskId: r.task, reason: "x", submissionId: S1 });
      assert.deepEqual([again.detail?.["alreadyRecorded"], again.detail?.["commit"]], [true, COMMIT]);
      assert.equal(r.calls.length, 2, "the third request asked no host");
    } finally { await r.store.close(); }
  });

}
