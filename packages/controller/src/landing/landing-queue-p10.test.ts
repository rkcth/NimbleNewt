import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceOutcome } from "../workspace-ops/index.js";
import { IntegratorLeaseOps, IntegratorLeaseService, LandingQueueOps, LandingQueueService, type QueueApproval } from "./index.js";
import { CONTRIBUTOR_APPROVAL_TEXT } from "../submissions/contributors.js";

after(stopServer);

// Card P10 (queue slice): the oldest-first landing queue of a project's landing branch. Approved code submissions wait there; a landing lands only the oldest, exactly its approved base and tree (the host is told
// both and checks them; a landing it confirms takes the entry out in the same write that records the landing); an integrator lands nothing that is not queued, so it carries no content of its own; two integrators,
// or two landings, racing for one branch never both reach the host.
const MIN = 60_000;
const BASE = "b".repeat(40), OTHER = "f".repeat(40);
const tree = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => `sbm-${"abcdefghijklmnopqrstuvwxyz234567"[n % 32]!.repeat(20)}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval>();
    let branch: string | undefined = "main";
    const queueOps = (q = LandingQueueService.withEpoch(w.storage, w.epoch, options)) => new LandingQueueOps(q, {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async () => branch,
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
    });
    const ops = queueOps();
    const leases = IntegratorLeaseService.withEpoch(w.storage, w.epoch, options);
    const leaseOps = new IntegratorLeaseOps(leases, { landingBranch: async () => branch });
    const person = async (name: string, grants = [{ action: "integration.lease", project: w.project }, { action: "workspace.manage", project: w.project }]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    const task = async (title: string): Promise<string> => (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId: w.project, title })).id;
    /** An approved code submission `n` of task `t` by `author`, as `SubmissionService.approvalOf` answers it. */
    const approve = (n: number, t: string, author = "agent:ann", approved = true): string => { approvals.set(sbm(n), { taskId: t, projectId: w.project, base: BASE, tree: tree(n), submittedBy: author, approved, ...(approved ? {} : { reason: "its newest review says changes" }) }); return sbm(n); };
    const calls: WorkspaceCall[] = [];
    let answer: (call: WorkspaceCall) => Promise<WorkspaceOutcome> = async (call) => ({ ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, waitingToCommit: true, ...(call.submission === undefined ? {} : { submission: call.submission.id, base: call.submission.base, tree: call.submission.tree }) } });
    let beforeRun: () => Promise<void> = async () => undefined;
    const workspace = (q = ops) => WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: { around: async (_scope, _op, run) => { await beforeRun(); return run({ attempts: [] } as never); } },
      portOf: async () => ({ run: async (call) => { calls.push(call); return answer(call); } }),
      landingLease: (by, call) => leaseOps.checkLanding(by, { ...call, branch }),
      landingQueue: { check: (by, call) => q.checkLanding(by, call), landedChanges: (p, b, s) => q.landedChanges(p, b, s) },
    }, options);
    const recorded = async (by: Principal, commandId: string) => w.storage.getAggregate({ kind: "workspace-request", id: derivedId("wsr", scopedCommandId(by.id, commandId)) });
    return {
      store, w, ops, queueOps, leases, leaseOps, person, task, approve, approvals, calls, workspace, recorded,
      setBranch: (b: string | undefined) => { branch = b; },
      setAnswer: (f: typeof answer) => { answer = f; }, setBeforeRun: (f: () => Promise<void>) => { beforeRun = f; },
      queued: async () => (await ops.list(w.owner, { projectId: w.project })).items.map((e) => [e.position, e.submissionId, e.taskId]),
      close: () => store.close(),
    };
  };

  test(`${backend.name}: approved submissions queue oldest first, one place per task (a newer approval keeps the task's turn); who may add, take out and read (card P10, queue)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann", []), ivy = await r.person("ivy"), eve = await r.person("eve", [{ action: "workspace.manage", project: r.w.project }]);
      const [t1, t2, t3] = [await r.task("one"), await r.task("two"), await r.task("three")];
      const [s1, s2, s3] = [r.approve(1, t1), r.approve(2, t2, "agent:ivy"), r.approve(3, t3)];
      // The author queues its own; an integrator any; someone who is neither is told nothing exists.
      assert.equal((await r.ops.add(ann, { commandId: "a1", submissionId: s1 })).position, 1);
      await refuses("not_found", () => r.ops.add(eve, { commandId: "e1", submissionId: s3 }));
      await refuses("not_found", () => r.ops.add(ann, { commandId: "a2", submissionId: s2 }), /not yours/);
      assert.equal((await r.ops.add(ivy, { commandId: "i1", submissionId: s2 })).position, 2);
      assert.equal((await r.ops.add(r.w.owner, { commandId: "o1", submissionId: s3 })).position, 3);
      // Not approved, no landing branch, malformed.
      const s4 = r.approve(4, t1, "agent:ann", false);
      await refuses("review_invalid", () => r.ops.add(ann, { commandId: "a3", submissionId: s4 }), /not approved \(its newest review says changes\)/);
      // Card Q04 re-check: a not-counted approval's reason is kept whole, the owner's way out included, for an agent named with the full 40 characters.
      const asAnswered = r.approvals.get(s4)!;
      r.approvals.set(s4, { ...asAnswered, reason: `the approval by agent:${"a".repeat(40)} does not count: ${CONTRIBUTOR_APPROVAL_TEXT}` });
      await refuses("review_invalid", () => r.ops.add(ann, { commandId: "a3q", submissionId: s4 }), /the owner adds a reviewer agent or drops the review check\)\); only approved work is queued to land$/);
      r.approvals.set(s4, asAnswered);
      await refuses("invalid_command", () => r.ops.add(ann, { commandId: "a4", submissionId: "sbm-../x" }));
      r.setBranch(undefined);
      const s5 = r.approve(5, t1);
      await refuses("forbidden", () => r.ops.add(ann, { commandId: "a5", submissionId: s5 }), /names no landing branch/);
      r.setBranch("main");
      // The same submission again stays where it is; a newer approved one of task one takes its place (position 1 kept).
      assert.deepEqual(await r.ops.add(ivy, { commandId: "i2", submissionId: s1 }).then((x) => [x.position, x.already]), [1, true]);
      const replaced = await r.ops.add(ann, { commandId: "a6", submissionId: s5 });
      assert.deepEqual([replaced.position, replaced.replaced, replaced.already], [1, s1, false]);
      assert.deepEqual(await r.queued(), [[1, s5, t1], [2, s2, t2], [3, s3, t3]]);
      // Reading: the owner and integrators only.
      await refuses("not_found", () => r.ops.list(ann, { projectId: r.w.project }));
      assert.equal((await r.ops.list(ivy, { projectId: r.w.project })).branch, "main");
      // Taking out: the author its own entry, an integrator or the owner any; others are told nothing exists.
      await refuses("not_found", () => r.ops.remove(ann, { commandId: "ar1", taskId: t2, reason: "not mine" }));
      await refuses("not_found", () => r.ops.remove(eve, { commandId: "er1", taskId: t3, reason: "x" }));
      assert.equal((await r.ops.remove(ann, { commandId: "ar2", taskId: t3, reason: "withdrawn by its author" })).removed?.submissionId, s3);
      assert.equal((await r.ops.remove(ann, { commandId: "ar2", taskId: t3, reason: "withdrawn by its author" })).replayed, true, "a repeat answers it was done");
      await refuses("not_found", () => r.ops.remove(r.w.owner, { commandId: "or1", taskId: t3, reason: "again" }), /has no submission/);
      // The controller's own queueing when an approval is recorded, and its withdrawal when a newer review takes it back.
      assert.equal(await r.ops.queueApproved(s3, "sbm-review-1"), true);
      assert.deepEqual(await r.queued(), [[1, s5, t1], [2, s2, t2], [3, s3, t3]], "queued again at the back");
      r.approve(3, t3, "agent:ann", false);
      assert.equal(await r.ops.queueApproved(s3, "sbm-review-2"), false, "work that is not approved is not queued");
      assert.equal(await r.ops.withdrawUnapproved(s3, "sbm-review-2"), true);
      assert.equal(await r.ops.withdrawUnapproved(s2, "sbm-review-3"), false, "an approved entry stays");
      assert.deepEqual(await r.queued(), [[1, s5, t1], [2, s2, t2]]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: race: submissions queued at the same moment by separate controllers' services are all kept, each with its own place (card P10, queue)`, async () => {
    const r = await rig();
    try {
      const tasks = await Promise.all(Array.from({ length: 12 }, (_, i) => r.task(`race-${i}`)));
      const ids = tasks.map((t, i) => r.approve(i + 1, t));
      // Three services over the same records (three runners), twelve adds at once, plus a take-out of one of them racing the others.
      const doors = [r.queueOps(), r.queueOps(), r.queueOps()];
      const added = await Promise.all(ids.map((id, i) => doors[i % 3]!.add(r.w.owner, { commandId: `race-${i}`, submissionId: id })));
      assert.equal(added.length, 12);
      const items = (await r.ops.list(r.w.owner, { projectId: r.w.project })).items;
      assert.deepEqual(items.map((e) => e.submissionId).sort(), [...ids].sort(), "none was lost");
      assert.equal(new Set(items.map((e) => e.seq)).size, 12, "each has its own number");
      assert.deepEqual(items.map((e) => e.seq), [...items.map((e) => e.seq)].sort((a, b) => a - b), "listed in the order they were queued");
      const more = await Promise.all([r.task("late-1"), r.task("late-2")]);
      const late = more.map((t, i) => r.approve(20 + i, t));
      await Promise.all([doors[0]!.remove(r.w.owner, { commandId: "race-out", taskId: tasks[0]!, reason: "out" }), doors[1]!.add(r.w.owner, { commandId: "race-l1", submissionId: late[0]! }), doors[2]!.add(r.w.owner, { commandId: "race-l2", submissionId: late[1]! })]);
      const after = (await r.ops.list(r.w.owner, { projectId: r.w.project })).items.map((e) => e.submissionId);
      assert.equal(after.length, 13);
      assert.ok(!after.includes(ids[0]!) && late.every((l) => after.includes(l)));
    } finally { await r.close(); }
  });

  test(`${backend.name}: a landing lands only the oldest queued submission, exactly its base and tree, and the landing takes it out of the queue in the same write (card P10, queue)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2, t3] = [await r.task("one"), await r.task("two"), await r.task("three")];
      const lease = await r.leaseOps.acquire(ivy, { commandId: "l1", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      const svc = r.workspace();
      const land = (by: Principal, commandId: string, taskId: string, more: Record<string, unknown> = {}) => svc.request(by, { commandId, operation: "landing", taskId, reason: "land it", ...(by.kind === "owner" ? {} : { leaseId: lease.leaseId, fence: lease.fence }), ...more } as never);
      // Nothing queued: an integrator lands nothing (it carries no content of its own).
      await refuses("invalid_transition", () => land(ivy, "w0", t1), /no approved submission in the landing queue of branch main/);
      const [s1, s2] = [r.approve(1, t1), r.approve(2, t2)];
      await r.ops.add(ivy, { commandId: "q1", submissionId: s1 });
      await r.ops.add(ivy, { commandId: "q2", submissionId: s2 });
      // Not the oldest; a submission that is not the task's entry; the owner landing a task with nothing queued while the queue is not empty.
      await refuses("invalid_transition", () => land(ivy, "w1", t2), /is number 2 in the landing queue of branch main; the oldest .* lands first/);
      await refuses("invalid_transition", () => land(ivy, "w2", t1, { submissionId: s2 }), /is not the submission task/);
      await refuses("invalid_transition", () => land(r.w.owner, "w3", t3), /not empty and task .* has nothing in it/);
      // A head whose approval was taken back is not landed.
      r.approve(1, t1, "agent:ann", false);
      await refuses("review_invalid", () => land(ivy, "w4", t1), /no longer approved as queued/);
      r.approve(1, t1);
      for (const [by, id] of [[ivy, "w0"], [ivy, "w1"], [ivy, "w2"], [r.w.owner, "w3"], [ivy, "w4"]] as const) assert.equal(await r.recorded(by, id), undefined, `${id}: nothing recorded`);
      assert.equal(r.calls.length, 0, "no host was asked");
      // The oldest lands: the host is told the submission, base and tree; its confirmed landing takes the entry out.
      const first = await land(ivy, "w5", t1);
      assert.equal(first.state, "done", first.summary);
      assert.deepEqual(first.queued, { submissionId: s1, base: BASE, tree: tree(1), branch: "main" });
      assert.deepEqual(r.calls.map((c) => [c.operation, c.taskId, c.submission]), [["landing", t1, { id: s1, base: BASE, tree: tree(1) }]]);
      assert.deepEqual(await r.queued(), [[1, s2, t2]]);
      // A landing the host does not confirm as exactly that submission leaves the entry where it is, and says so.
      r.setAnswer(async () => ({ ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: s2, base: BASE, tree: OTHER } }));
      const odd = await land(ivy, "w6", t2);
      assert.equal(odd.state, "done");
      assert.match(odd.summary ?? "", /did not confirm that exactly submission .* stays in the landing queue/);
      assert.deepEqual(await r.queued(), [[1, s2, t2]]);
      // A refused landing leaves it too.
      r.setAnswer(async () => ({ ok: false, reason: "the checkout's committed work is not the approved tree" }));
      assert.equal((await land(ivy, "w7", t2, { submissionId: s2 })).state, "refused");
      assert.deepEqual(await r.queued(), [[1, s2, t2]]);
      // The owner lands the head without naming it (as by chat), and then, with the queue empty, a task with nothing queued as before (no submission told to the host).
      r.setAnswer(async (call) => ({ ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, ...(call.submission === undefined ? {} : { submission: call.submission.id, base: call.submission.base, tree: call.submission.tree }) } }));
      assert.equal((await land(r.w.owner, "w8", t2)).queued?.submissionId, s2);
      assert.deepEqual(await r.queued(), []);
      const plain = await land(r.w.owner, "w9", t3);
      assert.equal(plain.state, "done");
      assert.equal(plain.queued, undefined);
      assert.equal(r.calls[r.calls.length - 1]!.submission, undefined);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a queue that moves while the task is made quiet stops the landing before the host is asked (card P10, queue)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const lease = await r.leaseOps.acquire(ivy, { commandId: "l1", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      await r.ops.add(ivy, { commandId: "q1", submissionId: r.approve(1, t1) });
      await r.ops.add(ivy, { commandId: "q2", submissionId: r.approve(2, t2) });
      // During the quiesce the owner tries to take the head out (refused while its landing is in progress, card P10 in-progress take-out), and a newer approved submission of task one takes the head's place:
      // the queue moved, so the landing stops before the host is asked.
      let taking: unknown;
      r.setBeforeRun(async () => { taking = await r.ops.remove(r.w.owner, { commandId: "out", taskId: t1, reason: "not now" }).catch((e: unknown) => e); await r.ops.add(ivy, { commandId: "q1b", submissionId: r.approve(4, t1) }); });
      const a = await r.workspace().request(ivy, { commandId: "w1", operation: "landing", taskId: t1, reason: "x", leaseId: lease.leaseId, fence: lease.fence });
      assert.ok(taking instanceof DomainError && taking.code === "invalid_transition" && /being landed .* right now/.test(taking.message), String(taking));
      assert.equal(a.state, "refused");
      assert.match(a.summary ?? "", /no longer the oldest approved one in the landing queue, so nothing was landed/);
      assert.equal(r.calls.length, 0);
      // The landing ended, so the head can be taken out now. The owner's landing of a task with nothing queued, while something is queued during the quiesce.
      r.setBeforeRun(async () => undefined);
      await r.ops.remove(r.w.owner, { commandId: "out1", taskId: t1, reason: "not now" });
      await r.ops.remove(r.w.owner, { commandId: "out2", taskId: t2, reason: "empty it" });
      r.setBeforeRun(async () => { await r.ops.add(r.w.owner, { commandId: "q3", submissionId: r.approve(3, t2) }); });
      const b = await r.workspace().request(r.w.owner, { commandId: "w2", operation: "landing", taskId: t1, reason: "x" });
      assert.equal(b.state, "refused");
      assert.match(b.summary ?? "", /no longer the oldest approved one/);
      assert.equal(r.calls.length, 0, "no host was asked");
    } finally { await r.close(); }
  });

  test(`${backend.name}: an entry whose landing is in progress cannot be taken out until the landing ends, so the queue never has two landings on the host (card P10, in-progress take-out)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const lease = await r.leaseOps.acquire(ivy, { commandId: "l1", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      const [s1, s2] = [r.approve(1, t1), r.approve(2, t2)];
      await r.ops.add(ivy, { commandId: "q1", submissionId: s1 });
      await r.ops.add(ivy, { commandId: "q2", submissionId: s2 });
      // The host holds its answer until told; the test waits for the host call itself (no sleeps).
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((res) => { entered = res; });
      const held = new Promise<void>((res) => { release = res; });
      r.setAnswer(async (call) => { entered(); await held; return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }; });
      const first = r.workspace().request(ivy, { commandId: "w1", operation: "landing", taskId: t1, reason: "land one", leaseId: lease.leaseId, fence: lease.fence });
      await reached;
      assert.equal(r.calls.length, 1);
      // Taking the head out (the owner, the integrator, or the controller withdrawing an approval that was taken back) is refused with a plain reason; the queue is unchanged.
      await refuses("invalid_transition", () => r.ops.remove(r.w.owner, { commandId: "out1", taskId: t1, reason: "not now" }), /being landed on branch main right now.*wait for that landing to end/);
      await refuses("invalid_transition", () => r.ops.remove(ivy, { commandId: "out2", taskId: t1, reason: "not now" }), /cannot be taken out/);
      r.approvals.set(s1, { ...r.approvals.get(s1)!, approved: false, reason: "its newest review says changes" });
      assert.equal(await r.ops.withdrawUnapproved(s1, "rev-x"), false, "the controller's withdrawal waits too");
      assert.deepEqual(await r.queued(), [[1, s1, t1], [2, s2, t2]]);
      // The second entry never reaches the host meanwhile (it is not the oldest), and the other entry can be taken out: only the one on the host is held.
      await refuses("invalid_transition", () => r.workspace().request(ivy, { commandId: "w2", operation: "landing", taskId: t2, reason: "land two", leaseId: lease.leaseId, fence: lease.fence }), /oldest/);
      assert.equal(r.calls.length, 1, "only the first landing is on the host");
      assert.equal((await r.ops.remove(r.w.owner, { commandId: "out-other", taskId: t2, reason: "later" })).removed?.submissionId, s2);
      await r.ops.add(ivy, { commandId: "q2b", submissionId: s2 });
      assert.deepEqual(await r.queued(), [[1, s1, t1], [2, s2, t2]]);
      release();
      assert.equal((await first).state, "done");
      assert.deepEqual(await r.queued(), [[1, s2, t2]]);
      // After the landing ended the take-out is allowed again.
      assert.equal((await r.ops.remove(r.w.owner, { commandId: "out3", taskId: t2, reason: "not now" })).removed?.submissionId, s2);
      assert.deepEqual(await r.queued(), []);
      assert.equal(r.calls.length, 1);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a take-out that read a task with no open-request record yet, and a landing of that task that starts before the take-out writes, never both go ahead (card P10, in-progress take-out)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const lease = await r.leaseOps.acquire(ivy, { commandId: "l1", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      const [s1, s2] = [r.approve(1, t1), r.approve(2, t2)];
      await r.ops.add(ivy, { commandId: "q1", submissionId: s1 });
      await r.ops.add(ivy, { commandId: "q2", submissionId: s2 });
      assert.equal(await r.w.storage.getAggregate({ kind: "workspace-open", id: t1 }), undefined, "task one never had a workspace request");
      // The take-out's first read of task one's open-request record is held (after reading that there is none) until the landing is at the host. Deterministic: each side waits for the other's step, no sleeps.
      let readOpen!: () => void, letGo!: () => void;
      const opened = new Promise<void>((res) => { readOpen = res; });
      const go = new Promise<void>((res) => { letGo = res; });
      let holding = true;
      const base = r.w.storage;
      const storage = new Proxy(base, { get: (target, p) => {
        if (p === "getAggregate") return async (ref: { kind: string; id: string }) => { const found = await target.getAggregate(ref); if (holding && ref.kind === "workspace-open" && ref.id === t1) { holding = false; readOpen(); await go; } return found; };
        const v = Reflect.get(target, p, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } });
      const heldOps = r.queueOps(LandingQueueService.withEpoch(storage, r.w.epoch, { clock: r.w.clock.now, pause: async () => undefined }));
      const taking = heldOps.remove(r.w.owner, { commandId: "out", taskId: t1, reason: "not now" }).then(() => undefined, (e: unknown) => e);
      await opened;
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((res) => { entered = res; });
      const held = new Promise<void>((res) => { release = res; });
      r.setAnswer(async (call) => { entered(); await held; return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }; });
      const first = r.workspace().request(ivy, { commandId: "w1", operation: "landing", taskId: t1, reason: "land one", leaseId: lease.leaseId, fence: lease.fence });
      await reached;
      // The take-out goes on with what it read (no record): its write meets the record the landing created, it is built again, and it is refused.
      letGo();
      const outcome = await taking;
      assert.ok(outcome instanceof DomainError && outcome.code === "invalid_transition" && /being landed/.test(outcome.message), String(outcome));
      assert.deepEqual(await r.queued(), [[1, s1, t1], [2, s2, t2]]);
      await refuses("invalid_transition", () => r.workspace().request(ivy, { commandId: "w2", operation: "landing", taskId: t2, reason: "land two", leaseId: lease.leaseId, fence: lease.fence }), /oldest/);
      assert.equal(r.calls.length, 1, "only the first landing is on the host");
      release();
      assert.equal((await first).state, "done");
      assert.deepEqual(await r.queued(), [[1, s2, t2]]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: second review: a repeat of a landing's command while the first call is at the host (the record then says uncertain) still holds its entry in the queue until the landing ends (card P10, in-progress take-out)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const lease = await r.leaseOps.acquire(ivy, { commandId: "l1", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      const [s1, s2] = [r.approve(1, t1), r.approve(2, t2)];
      await r.ops.add(ivy, { commandId: "q1", submissionId: s1 });
      await r.ops.add(ivy, { commandId: "q2", submissionId: s2 });
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((res) => { entered = res; });
      const held = new Promise<void>((res) => { release = res; });
      r.setAnswer(async (call) => { entered(); await held; return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }; });
      // One controller (one service): the repeat finds its own first call still running.
      const svc = r.workspace();
      const ask = { commandId: "w1", operation: "landing" as const, taskId: t1, reason: "land one", leaseId: lease.leaseId, fence: lease.fence };
      const first = svc.request(ivy, ask);
      try {
        await reached;
        const repeat = await svc.request(ivy, ask);
        assert.deepEqual([repeat.state, repeat.replayed], ["uncertain", true]);
        await refuses("invalid_transition", () => r.ops.remove(r.w.owner, { commandId: "out1", taskId: t1, reason: "not now" }), /being landed on branch main right now/);
        // P10 polish: the guard holds also when the entry is named by its branch (here after the owner named another landing branch meanwhile), for the owner and for the integrator.
        r.setBranch("trunk");
        try {
          await refuses("invalid_transition", () => r.ops.remove(r.w.owner, { commandId: "out2", taskId: t1, reason: "not now", branch: "main" }), /being landed on branch main right now/);
          await refuses("invalid_transition", () => r.ops.remove(ivy, { commandId: "out3", taskId: t1, reason: "not now", branch: "main" }), /being landed on branch main right now/);
        } finally { r.setBranch("main"); }
        assert.deepEqual(await r.queued(), [[1, s1, t1], [2, s2, t2]]);
        await refuses("invalid_transition", () => r.workspace().request(ivy, { commandId: "w2", operation: "landing", taskId: t2, reason: "land two", leaseId: lease.leaseId, fence: lease.fence }), /oldest/);
        assert.equal(r.calls.length, 1, "only the first landing is on the host");
      } finally { release(); }
      assert.equal((await first).state, "done");
      assert.deepEqual(await r.queued(), [[1, s2, t2]]);
      assert.equal((await r.ops.remove(r.w.owner, { commandId: "out2", taskId: t2, reason: "later" })).removed?.submissionId, s2);
    } finally { await r.close(); }
  });

  test(`${backend.name}: second review: a take-out that rewrites a task's open-request record while another workspace request of that task is being recorded does not make that request fail (card P10, in-progress take-out)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const t1 = await r.task("one");
      const s1 = r.approve(1, t1);
      await r.ops.add(ivy, { commandId: "q1", submissionId: s1 });
      // The request reads task one's open-request record twice before it writes (resolving what was left open, then building its write); right after the second read the owner takes the entry out, which rewrites that record.
      let reads = 0, takenOut: unknown;
      const base = r.w.storage;
      const storage = new Proxy(base, { get: (target, p) => {
        if (p === "getAggregate") return async (ref: { kind: string; id: string }) => { const found = await target.getAggregate(ref); if (ref.kind === "workspace-open" && ref.id === t1 && ++reads === 2) takenOut = (await r.ops.remove(r.w.owner, { commandId: "out", taskId: t1, reason: "not now" })).removed?.submissionId; return found; };
        const v = Reflect.get(target, p, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } });
      const svc = WorkspaceOpService.withEpoch(storage, r.w.epoch, { quiesce: { around: async (_scope, _op, run) => run({ attempts: [] } as never) }, portOf: async () => ({ run: async (call) => { r.calls.push(call); return { ok: true, summary: "refreshed", detail: { changed: false } }; } }) }, { clock: r.w.clock.now, pause: async () => undefined });
      const out = await svc.request(r.w.owner, { commandId: "w1", operation: "refresh", taskId: t1, reason: "move it to the head" });
      assert.equal(takenOut, s1, "the take-out went ahead (no landing was in progress)");
      assert.equal(out.state, "done", out.summary);
      assert.equal(r.calls.length, 1);
      assert.deepEqual(await r.queued(), []);
      assert.deepEqual((await r.w.storage.getAggregate({ kind: "workspace-open", id: t1 }))?.body, {});
    } finally { await r.close(); }
  });

  test(`${backend.name}: re-check: a take-out that commits while a landing of that task is being recorded wins, and the landing, its start built again, stops before the host is asked (card P10, in-progress take-out)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const lease = await r.leaseOps.acquire(ivy, { commandId: "l1", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      const [s1, s2] = [r.approve(1, t1), r.approve(2, t2)];
      await r.ops.add(ivy, { commandId: "q1", submissionId: s1 });
      await r.ops.add(ivy, { commandId: "q2", submissionId: s2 });
      // The landing reads task one's open-request record twice before it writes (resolving what was left open, then building its start write); right after the second read the owner takes the entry out.
      let reads = 0, takenOut: unknown;
      const base = r.w.storage;
      const storage = new Proxy(base, { get: (target, p) => {
        if (p === "getAggregate") return async (ref: { kind: string; id: string }) => { const found = await target.getAggregate(ref); if (ref.kind === "workspace-open" && ref.id === t1 && ++reads === 2) takenOut = (await r.ops.remove(r.w.owner, { commandId: "out", taskId: t1, reason: "not now" })).removed?.submissionId; return found; };
        const v = Reflect.get(target, p, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } });
      const svc = WorkspaceOpService.withEpoch(storage, r.w.epoch, {
        quiesce: { around: async (_scope, _op, run) => run({ attempts: [] } as never) },
        portOf: async () => ({ run: async (call) => { r.calls.push(call); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }; } }),
        landingLease: (by, call) => r.leaseOps.checkLanding(by, { ...call, branch: "main" }),
        landingQueue: { check: (by, call) => r.ops.checkLanding(by, call), landedChanges: (p, b, s) => r.ops.landedChanges(p, b, s) },
      }, { clock: r.w.clock.now, pause: async () => undefined });
      const out = await svc.request(ivy, { commandId: "w1", operation: "landing", taskId: t1, reason: "land one", leaseId: lease.leaseId, fence: lease.fence });
      assert.equal(takenOut, s1, "the take-out went ahead (the landing was not recorded yet)");
      assert.ok(reads >= 3, "the landing's start was built again after the take-out");
      assert.equal(out.state, "refused", out.summary);
      assert.match(out.summary ?? "", /no longer the oldest approved one in the landing queue, so nothing was landed/);
      assert.equal(r.calls.length, 0, "no host was asked");
      assert.deepEqual(await r.queued(), [[1, s2, t2]]);
      assert.deepEqual((await r.w.storage.getAggregate({ kind: "workspace-open", id: t1 }))?.body, {});
    } finally { await r.close(); }
  });

  test(`${backend.name}: re-check: a request left open by a stopped controller is still marked uncertain when a take-out rewrites the task's open-request record at that moment (card P10, in-progress take-out)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const t1 = await r.task("one");
      const s1 = r.approve(1, t1);
      await r.ops.add(ivy, { commandId: "q1", submissionId: s1 });
      // The first controller's refresh is at the host (and stays there): to a second controller it is a request left open by a controller that stopped.
      let entered!: () => void, release!: () => void;
      const reached = new Promise<void>((res) => { entered = res; });
      const held = new Promise<void>((res) => { release = res; });
      const quiet = { around: async (_scope: unknown, _op: unknown, run: (q: never) => Promise<unknown>) => run({ attempts: [] } as never) } as never;
      const options = { clock: r.w.clock.now, pause: async () => undefined };
      const first = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, { quiesce: quiet, portOf: async () => ({ run: async () => { entered(); await held; return { ok: true, summary: "refreshed", detail: { changed: false } }; } }) }, options);
      const ask = { commandId: "w1", operation: "refresh" as const, taskId: t1, reason: "move it to the head" };
      const running = first.request(r.w.owner, ask).catch((e: unknown) => e);
      try {
        await reached;
        // The second controller's repeat marks it uncertain; right after it reads the open-request record to build that write, the owner takes the entry out (a refresh is not a landing), which rewrites that record.
        let takenOut: unknown, armed = true;
        const storage = new Proxy(r.w.storage, { get: (target, p) => {
          if (p === "getAggregate") return async (ref: { kind: string; id: string }) => { const found = await target.getAggregate(ref); if (armed && ref.kind === "workspace-open" && ref.id === t1) { armed = false; takenOut = (await r.ops.remove(r.w.owner, { commandId: "out", taskId: t1, reason: "not now" })).removed?.submissionId; } return found; };
          const v = Reflect.get(target, p, target) as unknown;
          return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
        } });
        const second = WorkspaceOpService.withEpoch(storage, r.w.epoch, { quiesce: quiet, portOf: async () => ({ run: async () => { throw new Error("not asked"); } }) }, options);
        const repeat = await second.request(r.w.owner, ask);
        assert.equal(takenOut, s1, "the take-out went ahead");
        assert.deepEqual([repeat.state, repeat.replayed], ["uncertain", true]);
        assert.deepEqual((await r.w.storage.getAggregate({ kind: "workspace-open", id: t1 }))?.body, {});
      } finally { release(); await running; }
    } finally { await r.close(); }
  });

  test(`${backend.name}: race: two integrators racing for the branch, and two landings racing for the queue, never both reach the host (card P10, queue)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy"), max = await r.person("max");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      await r.ops.add(r.w.owner, { commandId: "q1", submissionId: r.approve(1, t1) });
      await r.ops.add(r.w.owner, { commandId: "q2", submissionId: r.approve(2, t2) });
      // Two integrators take the branch at the same moment from two services: one holds it.
      const taking = await Promise.allSettled([r.leaseOps.acquire(ivy, { commandId: "li", taskId: t1, branch: "main", ttlMs: 10 * MIN }), new IntegratorLeaseOps(IntegratorLeaseService.withEpoch(r.w.storage, r.w.epoch, { clock: r.w.clock.now, pause: async () => undefined }), { landingBranch: async () => "main" }).acquire(max, { commandId: "lm", taskId: t1, branch: "main", ttlMs: 10 * MIN })]);
      const won = taking.flatMap((t) => (t.status === "fulfilled" ? [t.value] : []));
      assert.equal(won.length, 1, "one integrator holds the branch");
      const holder = won[0]!.holder === "ivy" ? ivy : max, loser = holder === ivy ? max : ivy;
      // Both integrators land the oldest at the same moment, each with the holder's numbers, from two services; then the holder lands both queued tasks at once from two services, with the host holding its answer.
      let go!: () => void;
      const together = new Promise<void>((ok) => { go = ok; });
      r.setAnswer(async (call) => { await together; return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }; });
      const ask = (by: Principal, svc: WorkspaceOpService, id: string, taskId: string) => svc.request(by, { commandId: id, operation: "landing", taskId, reason: "race", leaseId: won[0]!.leaseId, fence: won[0]!.fence }).then((a) => a.state, (e: DomainError) => e.code);
      // The second service's queue check is observed, so the test knows (without waiting for a time) when the later landing has been judged against the queue while the oldest is still on the host.
      const twoQueue = r.queueOps(), judged: string[] = [], judgeCheck = twoQueue.checkLanding.bind(twoQueue);
      twoQueue.checkLanding = async (by, call) => { try { return await judgeCheck(by, call); } finally { judged.push(call.taskId); } };
      const one = r.workspace(), two = r.workspace(twoQueue);
      const racing = [ask(holder, one, "h1", t1), ask(loser, two, "x1", t1), ask(holder, two, "h2", t2)];
      // A landing that ends before the point waited for (a fault before the host or before its queue check) ends the wait too, so the assertions report it instead of the file waiting for its timeout; the held host answer is
      // released whatever happens, so a failed assertion does not leave the first landing waiting.
      const ended = racing.map(() => false);
      racing.forEach((p, i) => { void p.finally(() => { ended[i] = true; }); });
      try {
        while (r.calls.length < 1 && !ended[0]) await new Promise((ok) => setTimeout(ok, 5));
        // The later landing's queue check has finished (it is not the oldest) before the host answers; on a slow machine it would otherwise start after the oldest landed and find itself the oldest.
        while (!judged.includes(t2) && !ended[2]) await new Promise((ok) => setTimeout(ok, 5));
        assert.ok(judged.includes(t2), "the later landing was judged against the queue while the oldest was on the host");
        assert.equal(r.calls.length, 1, "only one landing reached the host");
      } finally { go(); }
      const states = await Promise.all(racing);
      assert.deepEqual(states, ["done", "fenced", "invalid_transition"], JSON.stringify(states));
      assert.deepEqual(r.calls.map((c) => c.taskId), [t1]);
      // The next is now the oldest and lands.
      assert.equal(await ask(holder, one, "h3", t2), "done");
      assert.deepEqual(r.calls.map((c) => c.taskId), [t1, t2]);
      assert.deepEqual(await r.queued(), []);
    } finally { await r.close(); }
  });

  test(`${backend.name}: review: a landing's outcome is recorded with its queue entry taken out even when the queue changes at the same moment, and an author's take-out is judged on the entry inside the write (card P10, queue)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2, t3] = [await r.task("one"), await r.task("two"), await r.task("three")];
      const lease = await r.leaseOps.acquire(ivy, { commandId: "l1", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      await r.ops.add(ivy, { commandId: "q1", submissionId: r.approve(1, t1) });
      await r.ops.add(ivy, { commandId: "q2", submissionId: r.approve(2, t2) });
      // Approvals keep arriving while the landing's outcome is written: each of the first six reads of the queue for the outcome is followed by another change, so the outcome's write loses its race six times
      // (more than the five attempts the outcome's write once had).
      const s3 = r.approve(3, t3);
      let raced = 0;
      const svc = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, {
        quiesce: { around: async (_scope, _op, run) => run({ attempts: [] } as never) },
        portOf: async () => ({ run: async (call) => ({ ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }) }),
        landingLease: (by, call) => r.leaseOps.checkLanding(by, { ...call, branch: "main" }),
        landingQueue: { check: (by, call) => r.ops.checkLanding(by, call), landedChanges: async (p, b, s) => { const changes = await r.ops.landedChanges(p, b, s); if (raced < 6) { raced++; if (raced === 1) await r.ops.add(r.w.owner, { commandId: "q3", submissionId: s3 }); else { await r.ops.remove(r.w.owner, { commandId: `out-${raced}`, taskId: t3, reason: "x" }); await r.ops.add(r.w.owner, { commandId: `q3-${raced}`, submissionId: s3 }); } } return changes; } },
      }, { clock: r.w.clock.now, pause: async () => undefined });
      const landed = await svc.request(ivy, { commandId: "w1", operation: "landing", taskId: t1, reason: "land it", leaseId: lease.leaseId, fence: lease.fence });
      assert.equal(landed.state, "done", landed.summary);
      assert.equal(raced, 6);
      assert.deepEqual((await r.queued()).map((e) => e[2]), [t2, t3], "the landed entry left, and the entries written meanwhile were all kept");
      // An author may take out only an entry that is its own, decided on what the queue holds when it is written.
      await refuses("not_found", () => LandingQueueService.withEpoch(r.w.storage, r.w.epoch, { clock: r.w.clock.now, pause: async () => undefined }).remove({ commandId: "svc-out", actor: "agent:eve", projectId: r.w.project, branch: "main", taskId: t2, reason: "x", allowed: (e) => e.author === "agent:eve" }));
      assert.deepEqual((await r.queued()).map((e) => e[2]), [t2, t3], "nothing was taken out");
      // The controller's withdrawal of a submission whose approval was taken back, while a newer approved submission of the same task takes its place at the same moment: only the old one may leave.
      const s4 = r.approve(4, t2);
      const real = LandingQueueService.withEpoch(r.w.storage, r.w.epoch, { clock: r.w.clock.now, pause: async () => undefined });
      const racing = { get: async (p: string, b: string) => { const q = await real.get(p, b); await real.enqueue({ commandId: "replace-t2", actor: r.w.owner.id, projectId: p, branch: b, submissionId: s4, taskId: t2, base: BASE, tree: tree(4), author: "agent:ann" }); return q; }, remove: (c: Parameters<LandingQueueService["remove"]>[0]) => real.remove(c) } as unknown as LandingQueueService;
      r.approve(2, t2, "agent:ann", false);
      assert.equal(await r.queueOps(racing).withdrawUnapproved(sbm(2), "review-changes"), false, "the old submission had already been replaced");
      assert.deepEqual((await r.queued()).map((e) => [e[1], e[2]]), [[s4, t2], [sbm(3), t3]], "the newer approved submission keeps the task's place");
    } finally { await r.close(); }
  });

  test(`${backend.name}: second review: a landed submission is not queued again, an older submission does not take a newer one's place, and a landing the host does not confirm says the entry stays (card P10, queue)`, async () => {
    const r = await rig();
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const lease = await r.leaseOps.acquire(ivy, { commandId: "l1", taskId: t1, branch: "main", ttlMs: 10 * MIN });
      const land = (commandId: string, taskId: string) => r.workspace().request(ivy, { commandId, operation: "landing", taskId, reason: "land it", leaseId: lease.leaseId, fence: lease.fence });
      // Task one's first submission lands; a later review approving it again (or a hand add) does not put it back at the head.
      const s1 = r.approve(1, t1);
      assert.equal(await r.ops.queueApproved(s1, "rev-1"), true);
      assert.equal((await land("w1", t1)).state, "done");
      assert.deepEqual(await r.queued(), []);
      assert.equal(await r.ops.queueApproved(s1, "rev-2"), false, "a second approval of landed work is not queued");
      await refuses("invalid_transition", () => r.ops.add(ivy, { commandId: "a1", submissionId: s1 }), /already landed/);
      assert.deepEqual(await r.queued(), []);
      // Task two: a newer submission is queued; the older one, approved late, does not take its place; a newer one still does.
      const at = (n: number, t: string, when: string): string => { r.approve(n, t); r.approvals.set(sbm(n), { ...r.approvals.get(sbm(n))!, submittedAt: when }); return sbm(n); };
      const older = at(2, t2, "2026-01-01T00:00:01.000Z"), newer = at(3, t2, "2026-01-01T00:00:02.000Z"), newest = at(4, t2, "2026-01-01T00:00:03.000Z");
      assert.equal(await r.ops.queueApproved(newer, "rev-3"), true);
      assert.equal(await r.ops.queueApproved(older, "rev-4"), false, "the older approval does not replace the newer");
      await refuses("invalid_transition", () => r.ops.add(r.w.owner, { commandId: "a2", submissionId: older }), /already has a newer submission/);
      assert.deepEqual(await r.queued(), [[1, newer, t2]]);
      assert.equal((await r.ops.add(r.w.owner, { commandId: "a3", submissionId: newest })).replaced, newer);
      assert.deepEqual(await r.queued(), [[1, newest, t2]]);
      // The host wrote the files but could not mark the checkout (landed: false): the entry stays at the head and the summary says so.
      r.setAnswer(async (call) => ({ ok: true, summary: "1 file(s) landed; the checkout could not be marked as landed", detail: { landed: false, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }));
      const unmarked = await land("w2", t2);
      assert.equal(unmarked.state, "done");
      assert.match(unmarked.summary ?? "", /did not confirm that exactly submission .* stays in the landing queue \(landing\.queue\.remove takes it out\)/);
      assert.deepEqual(await r.queued(), [[1, newest, t2]]);
      // A take-out during the landing is refused; a newer submission takes the task's place meanwhile, and the submission the host then lands is still noted as landed (it is no longer queued).
      const latest = at(5, t2, "2026-01-01T00:00:04.000Z");
      r.setAnswer(async (call) => ({ ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }));
      const svc = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, {
        quiesce: { around: async (_scope, _op, run) => run({ attempts: [] } as never) },
        portOf: async () => ({ run: async (call) => { await refuses("invalid_transition", () => r.ops.remove(r.w.owner, { commandId: "out-during", taskId: t2, reason: "taken out" }), /being landed/); assert.equal((await r.ops.add(r.w.owner, { commandId: "a5", submissionId: latest })).replaced, newest); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }; } }),
        landingLease: (by, call) => r.leaseOps.checkLanding(by, { ...call, branch: "main" }),
        landingQueue: { check: (by, call) => r.ops.checkLanding(by, call), landedChanges: (p, b, s) => r.ops.landedChanges(p, b, s) },
      }, { clock: r.w.clock.now, pause: async () => undefined });
      assert.equal((await svc.request(ivy, { commandId: "w3", operation: "landing", taskId: t2, reason: "land it", leaseId: lease.leaseId, fence: lease.fence })).state, "done");
      assert.deepEqual(await r.queued(), [[1, latest, t2]]);
      await refuses("invalid_transition", () => r.ops.add(r.w.owner, { commandId: "a4", submissionId: newest }), /already landed/);
    } finally { await r.close(); }
  });
}
