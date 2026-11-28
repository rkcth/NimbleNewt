import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DEFAULT_LIMITS } from "../admission/index.js";
import { DomainError } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld, workGrants } from "../dispatch/testing/world.js";
import type { Grant, Principal } from "../security/principals.js";
import type { JsonObject } from "../storage/types.js";
import {
  IntegratorCapacity, IntegratorLeaseOps, IntegratorLeaseService, IntegratorPool, IntegratorWake, INTEGRATOR_WAKE_LIMITS, LANDING_TASK_KIND, LandingQueueService, WAKE_EVERY_MS, WAKE_KIND, activeAgentIds, frontOf,
} from "./index.js";

after(stopServer);

// Card P10b (first clause, second part: "another is woken through admission and budget, with reserved capacity"). On the controller's rounds a landing branch with approved work first in its queue, no live lease of an
// active agent and no wake yet gets one free integrator of the project (the pool's rule), as a landing task assigned to it. The dispatcher knows the task as a landing task: its attempt asks admission for a `landing` place
// of the reserved control lane, which author attempts never take and whose queue they cannot fill, and its budget is held on the task whose approved work it lands.
const MIN = 60_000;
const BASE = "b".repeat(40);
const tree = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => `sbm-${"abcdefghijklmnopqrstuvwxyz234567"[n % 32]!.repeat(20)}`;
const lands = (projects: string[]): Grant[] => projects.map((project) => ({ action: "integration.lease", project }));

for (const backend of backends) {
  const rig = async (o: { landingBranch?: (call: { taskId: string; projectId: string }) => Promise<string | undefined> } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const activeAgent = async (id: string) => { const p = await w.principals.get(`agent:${id}`); return p !== undefined && p.kind === "agent" && p.state === "active"; };
    const landingBranch = o.landingBranch ?? (async (): Promise<string> => "main");
    const leases = IntegratorLeaseService.withEpoch(w.storage, w.epoch, options);
    const leaseOps = new IntegratorLeaseOps(leases, { landingBranch, activeAgent });
    const queue = LandingQueueService.withEpoch(w.storage, w.epoch, options);
    const pool = new IntegratorPool(leases, leaseOps, queue, { landingBranch, activeAgent });
    let wakeRef: IntegratorWake | undefined;
    const capacity = new IntegratorCapacity(leases, { agents: () => activeAgentIds(w.storage), principal: (id) => w.principals.current(id), wakes: () => wakeRef!.now() });
    const deps = { queue, leases, capacity, projects: w.projects, assignments: w.assignments, landingBranch, activeAgent };
    const wake = IntegratorWake.withEpoch(w.storage, w.epoch, deps, options);
    wakeRef = wake;
    const project = async (name: string): Promise<string> => (await w.projects.createProject({ commandId: `p-${name}`, actor: w.owner.id, name })).id;
    const person = async (name: string, grants: Grant[]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    let n = 0;
    const queued = async (projectId: string): Promise<string> => {
      n++;
      const taskId = (await w.projects.createTask({ commandId: `t-${n}`, actor: w.owner.id, projectId, title: `work-${n}` })).id;
      await queue.enqueue({ commandId: `q-${n}`, actor: "controller", projectId, branch: "main", submissionId: sbm(n), taskId, base: BASE, tree: tree(n), author: "agent:writer" });
      w.clock.advance(MIN);
      return taskId;
    };
    const end = async (taskId: string) => { n++; const t = (await w.projects.getTask(taskId))!; await w.projects.transitionTask({ commandId: `end-${n}`, actor: w.owner.id, taskId, expectedRevision: t.revision, to: "cancelled" }); };
    const raw = async (kind: string, id: string, body: unknown) => {
      n++;
      const runner = new CommandRunner(w.storage, w.epoch, options);
      const now = await runner.get(kind, id);
      await runner.command("test.raw", { commandId: `raw-${n}`, actor: "test" }, async () => ({ payload: { n }, build: async () => ({ ref: { kind, id }, creates: now === undefined, changes: [now === undefined ? { type: "create" as const, ref: { kind, id }, body: body as JsonObject } : { type: "update" as const, ref: { kind, id }, expectedRevision: now.revision, body: body as JsonObject }], detail: {} }) }));
    };
    const tasksOf = async (projectId: string): Promise<string[]> => (await w.storage.listAggregates("task", { limit: 1000 })).filter((t) => (t.body as { projectId?: string }).projectId === projectId && (t.body as { title?: string }).title?.startsWith("Land the approved work") === true).map((t) => t.id);
    return { store, w, options, leases, leaseOps, queue, pool, capacity, wake, deps, project, person, queued, end, raw, tasksOf, close: () => store.close() };
  };

  test(`${backend.name}: a free integrator is woken for the queue that waited longest, one project at a time, and a wake ends with its landing task (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      const frontA = await r.queued(a);
      const frontB = await r.queued(b);
      const ivy = await r.person("ivy", lands([a, b]));
      await r.person("max", lands([b]));
      // The oldest queue first: a goes to ivy (the first free integrator of a by ID); she is then busy, so b goes to max.
      const first = await r.wake.round();
      assert.deepEqual(first.woken.map((x) => [x.projectId, x.agentId]), [[a, "ivy"], [b, "max"]], JSON.stringify(first));
      assert.deepEqual([first.partial, first.unreadable, first.noneFree], [false, 0, 0]);
      const taskA = first.woken[0]!.taskId, taskB = first.woken[1]!.taskId;
      // The landing task: in the queue's project, ready, assigned to the woken integrator, and known as a landing task of the queued work's own task.
      const t = (await r.w.projects.getTask(taskA))!;
      assert.deepEqual([t.projectId, t.state, t.title], [a, "ready", "Land the approved work queued on main"]);
      assert.deepEqual((await r.w.assignments.getAssignment(taskA))!.owner, { kind: "agent", id: "ivy" });
      assert.deepEqual(await r.wake.landingOf(taskA), { budgetTaskId: frontA, projectId: a, branch: "main", agentId: "ivy" });
      assert.deepEqual(await r.wake.landingOf(taskB), { budgetTaskId: frontB, projectId: b, branch: "main", agentId: "max" });
      assert.equal(await r.wake.landingOf(frontA), undefined, "an author's task is not a landing task");
      // The owner's view: woken, and an integrator woken is busy elsewhere.
      const shown = await r.capacity.of(a, "main", frontA);
      assert.deepEqual(shown.state === "woken" ? [shown.agentId, shown.taskId] : shown, ["ivy", taskA]);
      assert.notEqual((await r.capacity.of(a, "old")).state, "woken", "another branch of the project is not the woken one");
      assert.deepEqual(await r.capacity.integrators(b), { free: [], busy: 2, partial: false });
      // A second round wakes nobody again and makes no second task.
      const again = await r.wake.round();
      assert.deepEqual([again.woken.length, again.open], [0, 2]);
      assert.deepEqual((await r.tasksOf(a)).length, 1);
      // Ivy takes a's lease (the pool gives her the oldest queue): held; her wake stays open until her landing task ends.
      const took = await r.pool.next(ivy, { commandId: "i1", ttlMs: 10 * MIN });
      assert.equal(took.outcome === "taken" ? took.projectId : took.outcome, a);
      assert.equal((await r.capacity.of(a, "main", frontA)).state, "held");
      // Her landing task ends and she lets the lease go: the next round wakes for a again (a new task), and the record counts it as the second wake for the same first work.
      await r.end(taskA);
      if (took.outcome === "taken") await r.leaseOps.release(ivy, { commandId: "i1r", leaseId: took.lease.leaseId, fence: took.lease.fence });
      const second = await r.wake.round();
      assert.deepEqual(second.woken.map((x) => [x.projectId, x.agentId]), [[a, "ivy"]]);
      assert.notEqual(second.woken[0]!.taskId, taskA);
      const rec = (await r.w.storage.getAggregate({ kind: WAKE_KIND, id: IntegratorWake.wakeIdOf(a, "main") }))!.body as { frontWakes: number; wakes: number; taskId: string };
      assert.deepEqual([rec.frontWakes, rec.wakes, rec.taskId], [2, 2, second.woken[0]!.taskId]);
      // Woken for the same first work at most perFront times: then nobody more, and the owner's view says so.
      await r.end(second.woken[0]!.taskId);
      const third = await r.wake.round();
      assert.equal(third.woken.length, 1);
      await r.end(third.woken[0]!.taskId);
      const fourth = await r.wake.round();
      assert.deepEqual([fourth.woken.length, fourth.spent], [0, 1]);
      assert.deepEqual(await r.capacity.of(a, "main", frontA), { state: "free", free: 1, busy: 0, partial: false, wakesSpent: INTEGRATOR_WAKE_LIMITS.perFront });
      assert.deepEqual(await r.capacity.of(a, "main", "task-other"), { state: "free", free: 1, busy: 0, partial: false }, "another first work has its own count");
      // Other work comes first (the first is taken out): its count starts again.
      await r.queue.remove({ commandId: "rm1", actor: "controller", projectId: a, branch: "main", taskId: frontA, reason: "test" });
      const frontA2 = await r.queued(a);
      const fifth = await r.wake.round();
      assert.deepEqual(fifth.woken.map((x) => [x.projectId, x.agentId]), [[a, "ivy"]]);
      assert.deepEqual(await r.wake.landingOf(fifth.woken[0]!.taskId).then((x) => x?.budgetTaskId), frontA2);
      const rec2 = (await r.w.storage.getAggregate({ kind: WAKE_KIND, id: IntegratorWake.wakeIdOf(a, "main") }))!.body as { frontWakes: number; wakes: number };
      assert.deepEqual([rec2.frontWakes, rec2.wakes], [1, 4]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: what keeps a branch from a wake: a live hold of an active agent, no free integrator, another landing branch, unreadable settings or records; a disabled holder does not (card P10b)`, async () => {
    const r = await rig({ landingBranch: async ({ projectId }) => { if (projectId === broken) throw new Error("settings fault"); return projectId === elsewhere ? "release" : "main"; } });
    let broken = "", elsewhere = "";
    try {
      const [a, b, c, d] = [await r.project("Apple"), await r.project("Birch"), await r.project("Cedar"), await r.project("Damson")];
      broken = c; elsewhere = d;
      const frontA = await r.queued(a); await r.queued(b); await r.queued(c); await r.queued(d);
      // Nobody serves any of them: nothing woken, and the landing branch of d is not main, c's settings fail.
      const none = await r.wake.round();
      assert.deepEqual([none.woken.length, none.noneFree, none.unreadable, none.held], [0, 2, 1, 0], JSON.stringify(none));
      // An agent with other rights, or with a wildcard action, is no integrator.
      await r.person("eve", [{ action: "integration.*", project: "*" }, { action: "workspace.manage", project: a }]);
      assert.equal((await r.wake.round()).woken.length, 0);
      // Sue holds a's lease live (taken for her by the owner): a is held, b gets the free one.
      const sue = await r.person("sue", lands([a]));
      const hold = await r.leaseOps.acquire(sue, { commandId: "s1", taskId: frontA, branch: "main", ttlMs: 10 * MIN });
      await r.person("ivy", lands([a, b]));
      const one = await r.wake.round();
      assert.deepEqual([one.woken.map((x) => x.projectId), one.held], [[b], 1]);
      // Sue is disabled: her live hold no longer keeps a from a wake, and a is woken for ... nobody free (ivy is woken for b), then a third integrator takes it.
      await r.w.principals.disable(r.w.owner, { commandId: "d-sue", principalId: "agent:sue", expectedRevision: (await r.w.principals.get("agent:sue"))!.revision });
      const two = await r.wake.round();
      assert.deepEqual([two.woken.length, two.held, two.noneFree, two.open], [0, 0, 1, 1]);
      await r.person("zed", lands([a]));
      const three = await r.wake.round();
      assert.deepEqual(three.woken.map((x) => [x.projectId, x.agentId]), [[a, "zed"]]);
      assert.equal(hold.holder, "sue");
      // A queue whose first place is a reservation waiting for work is not woken for (nothing can land).
      const e = await r.project("Elder");
      const waiting = (await r.w.projects.createTask({ commandId: "tw", actor: r.w.owner.id, projectId: e, title: "waits" })).id;
      await r.queue.reserve({ commandId: "res1", actor: "controller", projectId: e, branch: "main", taskId: waiting, round: 3, cap: 3 });
      const later = (await r.w.projects.createTask({ commandId: "tl", actor: r.w.owner.id, projectId: e, title: "later" })).id;
      await r.queue.enqueue({ commandId: "ql", actor: "controller", projectId: e, branch: "main", submissionId: sbm(31), taskId: later, base: BASE, tree: tree(98), author: "agent:writer" });
      assert.equal(((await r.queue.queuesWithEntries()).queues.find((q) => q.projectId === e)?.entries.length), 1, "the queue has approved work behind the reserved first place");
      await r.person("yan", lands([e]));
      assert.deepEqual((await r.wake.round()).woken.filter((x) => x.projectId === e), []);
      // An integrator holding a live lease of one project it serves is busy for the others (one project at a time), judged on the leases the round read once.
      const [g, hh] = [await r.project("Ginkgo"), await r.project("Hazel")];
      const frontG = await r.queued(g);
      const lee = await r.person("lee", lands([g, hh]));
      await r.leaseOps.acquire(lee, { commandId: "lee1", taskId: frontG, branch: "main", ttlMs: 10 * MIN });
      await r.queued(hh);
      const busyLee = await r.wake.round();
      assert.deepEqual(busyLee.woken.filter((x) => x.projectId === g || x.projectId === hh), [], JSON.stringify(busyLee));
    } finally { await r.close(); }
  });

  test(`${backend.name}: bounded and fail closed: leases or wakes not all read, a damaged or misplaced wake record, a record whose task is another project's, the round bound, a throttled round, a failed assignment repeated without a second task (card P10b)`, async () => {
    const r = await rig();
    try {
      const a = await r.project("Apple");
      const frontA = await r.queued(a);
      await r.person("ivy", lands(["*"]));
      // Leases not all read: nobody woken, and why.
      const blindLeases = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...r.deps, leases: { liveLeases: async () => ({ leases: [], partial: true }), projectOfTask: (t) => r.leases.projectOfTask(t) } }, r.options);
      assert.deepEqual([(await blindLeases.round()).stopped, (await blindLeases.round()).woken.length], ["the integrator leases could not all be read", 0]);
      // The capacity view failing to judge (its own reads incomplete): nobody woken.
      const blindCapacity = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...r.deps, capacity: { integrators: async () => undefined } }, r.options);
      assert.deepEqual((await blindCapacity.round()).woken, []);
      // A queue record whose first task belongs to another project is not trusted.
      const b = await r.project("Birch");
      const foreign = (await r.w.projects.createTask({ commandId: "tf", actor: r.w.owner.id, projectId: a, title: "foreign" })).id;
      await r.queue.enqueue({ commandId: "qf", actor: "controller", projectId: b, branch: "main", submissionId: sbm(30), taskId: foreign, base: BASE, tree: tree(99), author: "agent:writer" });
      // The assignment fails once: the records are written first, so the landing task is known as one before anyone can be given an attempt on it; the next round finishes the same wake (no second task, no second
      // record) by assigning it to the integrator the record names.
      const real = r.w.assignments.assignTask.bind(r.w.assignments);
      let failing = true;
      const flaky = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...r.deps, assignments: { getAssignment: (t) => r.w.assignments.getAssignment(t), assignTask: async (c) => { if (failing) { failing = false; throw new DomainError("unavailable", "store fault"); } return real(c); } } }, r.options);
      const failed = await flaky.round();
      assert.deepEqual([failed.woken.length, failed.unreadable], [0, 2], JSON.stringify(failed));
      const made = await r.tasksOf(a);
      assert.equal(made.length, 1);
      const rec = (await r.w.storage.getAggregate({ kind: WAKE_KIND, id: IntegratorWake.wakeIdOf(a, "main") }))!;
      assert.deepEqual([(rec.body as { taskId?: string }).taskId, (rec.body as { agentId?: string }).agentId], [made[0], "ivy"]);
      assert.equal(((await r.w.storage.getAggregate({ kind: LANDING_TASK_KIND, id: made[0]! }))?.body as { frontTaskId?: string } | undefined)?.frontTaskId, frontA, "known as a landing task before it is assigned");
      assert.equal(await r.wake.landingOf(made[0]!), undefined, "not the woken integrator's yet, so no landing place and no allowance of the queued work");
      assert.equal(await r.w.assignments.getAssignment(made[0]!), undefined, "nobody can be given an attempt on it yet");
      // A landing record that does not name this wake's integrator (damage): the task is not assigned on its word, and the round says it could not judge the branch.
      const linkGood = (await r.w.storage.getAggregate({ kind: LANDING_TASK_KIND, id: made[0]! }))!.body as Record<string, unknown>;
      await r.raw(LANDING_TASK_KIND, made[0]!, { ...linkGood, agentId: "zed" });
      const misnamed = await r.wake.round();
      assert.deepEqual([misnamed.woken.length, misnamed.unreadable >= 1, await r.w.assignments.getAssignment(made[0]!)], [0, true, undefined], JSON.stringify(misnamed));
      await r.raw(LANDING_TASK_KIND, made[0]!, linkGood);
      const ok = await flaky.round();
      assert.deepEqual(ok.woken.map((x) => [x.projectId, x.taskId, x.agentId]), [[a, made[0]!, "ivy"]]);
      assert.equal((await r.w.assignments.getAssignment(made[0]!))?.owner?.id, "ivy");
      assert.deepEqual(await r.tasksOf(a), made, "the same task, not a second");
      assert.equal((await r.w.storage.getAggregate({ kind: WAKE_KIND, id: IntegratorWake.wakeIdOf(a, "main") }))!.revision, rec.revision, "the same record, not a second wake");
      assert.deepEqual((await flaky.round()).woken, [], "an assigned wake is not finished again");
      // Released by the owner afterwards: a later round does not assign it again (the owner's choice stands; cancelling the task ends the wake).
      const held = (await r.w.assignments.getAssignment(made[0]!))!;
      await r.w.assignments.releaseTask({ commandId: "rel", actor: r.w.owner.id, taskId: made[0]!, expectedRevision: held.revision });
      assert.deepEqual((await r.wake.round()).woken, []);
      assert.equal((await r.w.assignments.getAssignment(made[0]!))?.owner, undefined);
      const back = (await r.w.assignments.getAssignment(made[0]!))!;
      await r.w.assignments.assignTask({ commandId: "reassign", actor: r.w.owner.id, taskId: made[0]!, expectedRevision: back.revision, owner: { kind: "agent", id: "ivy" } });
      const c2 = await r.project("Cherry");
      await r.queued(c2);
      await r.person("aaa", lands([c2]));
      // A round that stopped after the task was made ready and before its records, while other work came first in the queue: the next round repeats the same task command (it carries no queued task, so it is
      // the same command), writes the records for the work first now and assigns. The task, ready with no assignment meanwhile, could be given no attempt.
      const realTransition = r.w.projects.transitionTask.bind(r.w.projects);
      const stopping = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...r.deps, projects: { createTask: (c) => r.w.projects.createTask(c), getTask: (t) => r.w.projects.getTask(t), transitionTask: async (c) => { await realTransition(c); throw new DomainError("unavailable", "the process stopped"); } } }, r.options);
      assert.equal((await stopping.round()).woken.length, 0);
      const half = await r.tasksOf(c2);
      assert.equal(half.length, 1);
      assert.deepEqual([(await r.w.projects.getTask(half[0]!))?.state, await r.w.assignments.getAssignment(half[0]!), await r.wake.landingOf(half[0]!)], ["ready", undefined, undefined]);
      const c2Queue = (await r.queue.queuesWithEntries()).queues.find((q) => q.projectId === c2)!;
      const c2First = c2Queue.entries[0]!.taskId;
      const c2Other = (await r.w.projects.createTask({ commandId: "tc2o", actor: r.w.owner.id, projectId: c2, title: "other" })).id;
      await r.queue.enqueue({ commandId: "qc2o", actor: "controller", projectId: c2, branch: "main", submissionId: sbm(31), taskId: c2Other, base: BASE, tree: tree(98), author: "agent:writer" });
      await r.queue.remove({ commandId: "qc2w", actor: "controller", projectId: c2, branch: "main", taskId: c2First, reason: "withdrawn" });
      assert.equal(frontOf((await r.queue.get(c2, "main")))?.taskId, c2Other, "other work is first now");
      const kept = await r.wake.round();
      assert.deepEqual(kept.woken.map((x) => [x.projectId, x.agentId, x.taskId]), [[c2, "aaa", half[0]!]], JSON.stringify(kept));
      assert.deepEqual(await r.tasksOf(c2), half, "the same task, not a second");
      assert.equal((await r.wake.landingOf(half[0]!))?.budgetTaskId, c2Other, "paid from the work first in the queue now");
      // Anything but a refusal from a step of the wake is not swallowed.
      const c3 = await r.project("Damson");
      await r.queued(c3);
      await r.person("bbb", lands([c3]));
      const throwing = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...r.deps, assignments: { getAssignment: (t) => r.w.assignments.getAssignment(t), assignTask: async () => { throw new TypeError("broken"); } } }, r.options);
      await assert.rejects(() => throwing.round(), TypeError);
      await assert.rejects(() => throwing.round(), TypeError, "nor when the next round finishes the same wake");
      // Given to someone else in the moment between ready and the records (a holder of assignment.manage): the records still name the integrator the round chose, the task is not assigned again, and it is its
      // assignee's ordinary work (no landing place, nothing of the queued work's allowance), never a landing task of an agent the round did not choose.
      const c4 = await r.project("Elder");
      await r.queued(c4);
      await r.person("ccc", lands([c4]));
      const grabbing = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...r.deps, projects: { createTask: (c) => r.w.projects.createTask(c), getTask: (t) => r.w.projects.getTask(t), transitionTask: async (c) => {
        const out = await realTransition(c);
        await r.w.assignments.assignTask({ commandId: "grab", actor: r.w.owner.id, taskId: c.taskId, owner: { kind: "agent", id: "zed" } });
        return out;
      } } }, r.options);
      const grabbed = await grabbing.round();
      const t4 = await r.tasksOf(c4);
      assert.equal(t4.length, 1);
      assert.deepEqual(grabbed.woken.filter((x) => x.projectId === c4).map((x) => x.agentId), ["ccc"], JSON.stringify(grabbed));
      assert.equal(((await r.w.storage.getAggregate({ kind: WAKE_KIND, id: IntegratorWake.wakeIdOf(c4, "main") }))?.body as { agentId?: string } | undefined)?.agentId, "ccc");
      assert.equal(((await r.w.storage.getAggregate({ kind: LANDING_TASK_KIND, id: t4[0]! }))?.body as { agentId?: string } | undefined)?.agentId, "ccc");
      assert.equal((await r.w.assignments.getAssignment(t4[0]!))?.owner?.id, "zed", "the assignment stands");
      assert.equal(await r.wake.landingOf(t4[0]!), undefined, "zed's ordinary work");
      assert.deepEqual((await r.wake.round()).woken.filter((x) => x.projectId === c4), [], "not assigned on a later round either");
      assert.equal((await r.w.assignments.getAssignment(t4[0]!))?.owner?.id, "zed");
      // A damaged wake record (or one stored under another branch's ID): nobody is woken anywhere, and the owner's view says not known.
      const realId = IntegratorWake.wakeIdOf(a, "main");
      const good = (await r.w.storage.getAggregate({ kind: WAKE_KIND, id: realId }))!.body as Record<string, unknown>;
      // Each damage on its own, under the branch's own wake ID (so the ID check does not hide it).
      for (const bad of [{ projectId: a }, { ...good, state: "ended" }, { ...good, frontWakes: 0 }, { ...good, frontWakes: 9, wakes: 2 }, { ...good, wakes: 1.5 }, { ...good, at: "yesterday" }, { ...good, agentId: "../x" }, { ...good, branch: "main\n" }]) {
        await r.raw(WAKE_KIND, realId, bad);
        const stopped = await r.wake.round();
        assert.deepEqual([stopped.stopped, stopped.woken.length], ["the wake records could not all be read", 0], JSON.stringify(bad));
        assert.deepEqual(await r.capacity.of(a, "main", frontA), { state: "unknown", reason: "the integrators the controller woke could not all be read" });
        assert.equal(await r.capacity.integrators(a), undefined);
      }
      await r.raw(WAKE_KIND, realId, good);
      assert.equal((await r.wake.round()).stopped, undefined, "repaired");
      await r.raw(WAKE_KIND, "iwk-damaged", good);
      assert.equal((await r.wake.round()).stopped, "the wake records could not all be read", "a good body under another ID is misplaced");
      // A landing-task record that does not read as one is damage, not "no landing task": read as none, the task would run as ordinary work paid from no allowance.
      const linkOk = { projectId: a, branch: "main", frontTaskId: frontA, agentId: "ivy", wakeId: IntegratorWake.wakeIdOf(a, "main"), at: "2026-01-01T00:00:00.000Z" };
      assert.equal((await (async () => { await r.raw(LANDING_TASK_KIND, foreign, linkOk); return r.wake.landingOf(foreign); })()), undefined, "a well-formed record is read (and answers nothing while nobody is assigned)");
      let h = 0;
      for (const bad of [{ ...linkOk, frontTaskId: "../../x" }, { ...linkOk, frontTaskId: 7 }, { ...linkOk, branch: "dev" }, { ...linkOk, projectId: 7 }, { ...linkOk, branch: "main\n", wakeId: IntegratorWake.wakeIdOf(a, "main\n") }, { ...linkOk, projectId: "../p", wakeId: IntegratorWake.wakeIdOf("../p", "main") }, { ...linkOk, agentId: "../x" }, (({ wakeId: _w, ...rest }) => rest)(linkOk), { ...linkOk, wakeId: IntegratorWake.wakeIdOf(a, "old") }, {}]) {
        h++;
        await r.raw(LANDING_TASK_KIND, `task-hostile${h}`, bad);
        await assert.rejects(() => r.wake.landingOf(`task-hostile${h}`), (e: unknown) => e instanceof DomainError && e.code === "integrity", JSON.stringify(bad));
      }
      // A landing task given to someone else after its wake is that agent's ordinary work: no landing place, and it does not spend the queued work's allowance.
      assert.equal((await r.wake.landingOf(made[0]!))?.budgetTaskId, frontA);
      const asg = (await r.w.assignments.getAssignment(made[0]!))!;
      await r.w.assignments.transferTask({ commandId: "xfer", actor: r.w.owner.id, taskId: made[0]!, expectedRevision: asg.revision, to: { kind: "agent", id: "zed" } });
      assert.equal(await r.wake.landingOf(made[0]!), undefined);
    } finally { await r.close(); }
  });

  test(`${backend.name}: at most perRound wakes per round (partial), and a throttled round runs once per WAKE_EVERY_MS of the controller's clock (card P10b)`, async () => {
    const r = await rig();
    try {
      const projects: string[] = [];
      for (let i = 0; i < INTEGRATOR_WAKE_LIMITS.perRound + 2; i++) { const p = await r.project(`P${i}`); projects.push(p); await r.queued(p); await r.person(`ag${i}`, lands([p])); }
      const first = await r.wake.round();
      assert.deepEqual([first.woken.length, first.partial], [INTEGRATOR_WAKE_LIMITS.perRound, true]);
      assert.deepEqual(first.woken.map((x) => x.projectId), projects.slice(0, INTEGRATOR_WAKE_LIMITS.perRound), "oldest first");
      const t1 = await r.wake.round({ throttled: true });
      assert.deepEqual(t1.woken.map((x) => x.projectId), projects.slice(INTEGRATOR_WAKE_LIMITS.perRound));
      assert.deepEqual(await r.wake.round({ throttled: true }), { woken: [], held: 0, open: 0, noneFree: 0, spent: 0, unreadable: 0, partial: false, skipped: true });
      r.w.clock.advance(WAKE_EVERY_MS - 1);
      assert.equal((await r.wake.round({ throttled: true })).skipped, true, "not yet");
      await r.person("late", lands(["*"]));
      const late = await r.project("Late");
      await r.queued(late);
      assert.deepEqual((await r.wake.round({ throttled: true })).woken.map((x) => [x.projectId, x.agentId]), [[late, "late"]]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a damaged landing record keeps its task from starting at all; a sound one of another agent leaves it ordinary work (card P10b)`, async () => {
    const r = await rig();
    try {
      const w = r.w;
      const ann = await w.agent("ann", workGrants(w.project));
      let ran = 0;
      w.worker.script = async () => { ran++; return { status: "completed", text: "x" }; };
      const t = await w.task("Damaged", ann);
      const sound = { projectId: w.project, branch: "main", frontTaskId: t.taskId, agentId: "someone-else", wakeId: IntegratorWake.wakeIdOf(w.project, "main"), at: "2026-01-01T00:00:00.000Z" };
      await r.raw(LANDING_TASK_KIND, t.taskId, { ...sound, frontTaskId: "../x" });
      w.dispatcher = w.restart({ landingOf: (x) => r.wake.landingOf(x) });
      const tick = await w.dispatcher.tick();
      assert.ok(!tick.started.includes(t.attemptId!), JSON.stringify(tick));
      await w.dispatcher.idle();
      assert.equal(ran, 0);
      await r.raw(LANDING_TASK_KIND, t.taskId, sound);
      const later = await w.dispatcher.tick();
      assert.ok(later.started.includes(t.attemptId!), JSON.stringify(later));
      await w.dispatcher.idle();
      assert.equal(ran, 1);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a landing attempt does not start once the queued work's allowance is used up, though the landing task has none of its own (card P10b)`, async () => {
    const r = await rig();
    try {
      const w = r.w;
      const frontA = await r.queued(w.project);
      await w.budgets.open(w.owner, { commandId: "bo", taskId: frontA, currency: "USD", costMicros: 10_000, computeMs: 3_600_000 });
      await w.budgets.charge(w.dispatcherPrincipal, { commandId: "use-up", activity: "model-call", taskId: frontA, costMicros: 10_000 });
      const ivy = await w.agent("ivy", [...workGrants(w.project), ...lands([w.project])]);
      let ran = 0;
      w.worker.script = async () => { ran++; return { status: "completed", text: "x" }; };
      w.dispatcher = w.restart({ landingOf: (t) => r.wake.landingOf(t) });
      const woken = await r.wake.round();
      const landingTask = woken.woken[0]!.taskId;
      const asg = (await w.assignments.getAssignment(landingTask))!;
      const attempt = (await w.assignments.admitAttempt({ commandId: "adm-l", actor: "inbox", taskId: landingTask, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: ivy.aid }, harness: "pi" })).id;
      const tick = await w.dispatcher.tick();
      assert.ok(!tick.started.includes(attempt), JSON.stringify(tick));
      await w.dispatcher.idle();
      assert.equal(ran, 0);
      assert.equal(await w.budgets.report(w.owner, landingTask), undefined, "the landing task has no allowance that could have let it start");
    } finally { await r.close(); }
  });

  test(`${backend.name}: the woken integrator's attempt is admitted in a landing place while author attempts fill the productive places and their queue, and its budget is held on the queued work's task (card P10b)`, async () => {
    const r = await rig();
    try {
      const w = r.w;
      const frontA = await r.queued(w.project);
      await w.budgets.open(w.owner, { commandId: "bo", taskId: frontA, currency: "USD", costMicros: 10_000, computeMs: 3_600_000 });
      const ivy = await w.agent("ivy", [...workGrants(w.project, ["read-file"]), ...lands([w.project])]);
      const ann = await w.agent("ann", workGrants(w.project));
      // Saturated: one productive place and one waiting place; three author attempts.
      await w.admission.setLimits({ commandId: "lim", actor: w.owner.id, limits: { ...DEFAULT_LIMITS, productive: 1, perHost: 1, queue: 1 } });
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const landingTasks = new Set<string>();
      let during: { reserved: number; own: unknown } | undefined;
      const calls: string[] = [];
      w.worker.script = async ({ order, gateway }) => {
        if (landingTasks.has(order.taskId)) {
          during = { reserved: (await w.budgets.report(w.owner, frontA))!.reservedInFlight.computeMs, own: await w.budgets.report(w.owner, order.taskId) };
          // A tool call is judged against the allowance that pays for it, the queued work's: allowed while it lasts, refused once it is used up (the landing task has no budget of its own to say otherwise).
          const call = async (callId: string) => (await gateway.call({ callId, tool: { name: "read-file", version: "1.0.0" }, args: { path: "README.md" } }, { kind: "local", run: async () => ({ text: "ok" }) })).state;
          calls.push(await call("l1"));
          await w.budgets.charge(w.dispatcherPrincipal, { commandId: "use-up", activity: "model-call", taskId: frontA, costMicros: 10_000 });
          calls.push(await call("l2"));
          // What its turn reports is the queued work's spending.
          await gateway.usage({ turnSeq: 1, costMicros: 5, computeMs: 40, cache: { backend: "localp", route: "localp/small", cachedTokens: 3, computedTokens: 4, writtenTokens: 0 } } as never);
          return { status: "completed", text: "landed" };
        }
        await gate; return { status: "completed", text: "x" };
      };
      const authors = [await w.task("Write A", ann), await w.task("Write B", ann), await w.task("Write C", ann)];
      w.dispatcher = w.restart({ landingOf: (t) => r.wake.landingOf(t) });
      await w.dispatcher.tick();
      const snap = await w.admission.snapshot();
      assert.deepEqual([snap.running.length, snap.queue.length], [1, 1], "the productive place and its queue are full");
      // The wake: a landing task for ivy; its attempt admitted as the inbox does.
      const woken = await r.wake.round();
      assert.deepEqual(woken.woken.map((x) => x.agentId), [ivy.aid]);
      const landingTask = woken.woken[0]!.taskId;
      landingTasks.add(landingTask);
      const asg = (await w.assignments.getAssignment(landingTask))!;
      const attempt = (await w.assignments.admitAttempt({ commandId: "adm-l", actor: "inbox", taskId: landingTask, expectedRevision: asg.revision, generation: asg.generation, owner: { kind: "agent", id: ivy.aid }, harness: "pi" })).id;
      const tick = await w.dispatcher.tick();
      assert.ok(tick.started.includes(attempt), JSON.stringify(tick));
      // The author attempt still runs (held on its gate), so the landing turn's end is waited for by itself.
      for (let i = 0; i < 500 && (during === undefined || (await w.admission.snapshot()).running.some((e) => e.class === "landing")); i++) await new Promise((resolve) => setTimeout(resolve, 10));
      const req = (await w.storage.listAggregates("dispatch", { limit: 100 })).map((d) => d.body as { attemptId: string; ask?: { landing?: true } }).find((d) => d.attemptId === attempt);
      assert.equal(req?.ask?.landing, true);
      // Its budget hold was on the queued work's own task, which it lands; the landing task has none of its own.
      assert.ok(during !== undefined && during.reserved > 0, JSON.stringify(during));
      assert.equal(during!.own, undefined);
      assert.deepEqual(calls, ["confirmed", "refused"]);
      const entries = (await w.storage.listAggregates("budget-entry", { limit: 1000 })).map((e) => e.body as { taskId?: string; agentId?: string; activity?: string });
      assert.ok(entries.some((e) => e.taskId === frontA && e.agentId === `agent:${ivy.aid}` && e.activity === "model-call"), JSON.stringify(entries));
      assert.ok(entries.every((e) => e.taskId !== landingTask), "nothing is charged to the landing task");
      // While it ran, the authors still held their place and their waiting place: none was taken from them, and none was given to them.
      const after = await w.admission.snapshot();
      assert.deepEqual(after.running.filter((e) => e.class === "productive").length, 1);
      assert.ok(after.running.every((e) => e.class !== "landing"), "the landing place came back when the attempt ended");
      void authors;
      open();
      await w.dispatcher.idle();
    } finally { await r.close(); }
  });
}
