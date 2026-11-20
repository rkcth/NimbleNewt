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
      // The owner takes the head out during the quiesce.
      r.setBeforeRun(async () => { await r.ops.remove(r.w.owner, { commandId: "out", taskId: t1, reason: "not now" }); });
      const a = await r.workspace().request(ivy, { commandId: "w1", operation: "landing", taskId: t1, reason: "x", leaseId: lease.leaseId, fence: lease.fence });
      assert.equal(a.state, "refused");
      assert.match(a.summary ?? "", /no longer the oldest approved one in the landing queue, so nothing was landed/);
      // The owner's landing of a task with nothing queued, while something is queued during the quiesce.
      r.setBeforeRun(async () => undefined);
      await r.ops.remove(r.w.owner, { commandId: "out2", taskId: t2, reason: "empty it" });
      r.setBeforeRun(async () => { await r.ops.add(r.w.owner, { commandId: "q3", submissionId: r.approve(3, t2) }); });
      const b = await r.workspace().request(r.w.owner, { commandId: "w2", operation: "landing", taskId: t1, reason: "x" });
      assert.equal(b.state, "refused");
      assert.match(b.summary ?? "", /no longer the oldest approved one/);
      assert.equal(r.calls.length, 0, "no host was asked");
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
      while (r.calls.length < 1) await new Promise((ok) => setTimeout(ok, 5));
      // The later landing's queue check has finished (it is not the oldest) before the host answers; on a slow machine it would otherwise start after the oldest landed and find itself the oldest.
      while (!judged.includes(t2)) await new Promise((ok) => setTimeout(ok, 5));
      assert.equal(r.calls.length, 1, "only one landing reached the host");
      go();
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
      // A submission taken out during its landing that the host then lands is still noted as landed.
      r.setAnswer(async (call) => ({ ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }));
      const svc = WorkspaceOpService.withEpoch(r.w.storage, r.w.epoch, {
        quiesce: { around: async (_scope, _op, run) => run({ attempts: [] } as never) },
        portOf: async () => ({ run: async (call) => { await r.ops.remove(r.w.owner, { commandId: "out-during", taskId: t2, reason: "taken out" }); return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: call.submission!.id, base: call.submission!.base, tree: call.submission!.tree } }; } }),
        landingLease: (by, call) => r.leaseOps.checkLanding(by, { ...call, branch: "main" }),
        landingQueue: { check: (by, call) => r.ops.checkLanding(by, call), landedChanges: (p, b, s) => r.ops.landedChanges(p, b, s) },
      }, { clock: r.w.clock.now, pause: async () => undefined });
      assert.equal((await svc.request(ivy, { commandId: "w3", operation: "landing", taskId: t2, reason: "land it", leaseId: lease.leaseId, fence: lease.fence })).state, "done");
      assert.deepEqual(await r.queued(), []);
      await refuses("invalid_transition", () => r.ops.add(r.w.owner, { commandId: "a4", submissionId: newest }), /already landed/);
    } finally { await r.close(); }
  });
}
