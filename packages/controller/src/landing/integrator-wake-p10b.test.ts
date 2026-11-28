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
  IntegratorCapacity, IntegratorLeaseOps, IntegratorLeaseService, IntegratorPool, IntegratorWake, INTEGRATOR_WAKE_LIMITS, LANDING_TASK_KIND, LandingQueueService, WAKE_EVERY_MS, WAKE_KIND, activeAgentIds,
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
      // The assignment fails once: no record is written; the next round makes the same task (no second one) and assigns it.
      const real = r.w.assignments.assignTask.bind(r.w.assignments);
      let failing = true;
      const flaky = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...r.deps, assignments: { getAssignment: (t) => r.w.assignments.getAssignment(t), assignTask: async (c) => { if (failing) { failing = false; throw new DomainError("unavailable", "store fault"); } return real(c); } } }, r.options);
      const failed = await flaky.round();
      assert.deepEqual([failed.woken.length, failed.unreadable], [0, 2], JSON.stringify(failed));
      assert.equal(await r.w.storage.getAggregate({ kind: WAKE_KIND, id: IntegratorWake.wakeIdOf(a, "main") }), undefined);
      const made = await r.tasksOf(a);
      assert.equal(made.length, 1);
      const ok = await flaky.round();
      assert.deepEqual(ok.woken.map((x) => [x.projectId, x.taskId]), [[a, made[0]!]]);
      assert.deepEqual(await r.tasksOf(a), made, "the same task, not a second");
      // Anything but a refusal from a step of the wake is not swallowed.
      const c2 = await r.project("Cherry");
      await r.queued(c2);
      await r.person("aaa", lands([c2]));
      const throwing = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...r.deps, assignments: { getAssignment: (t) => r.w.assignments.getAssignment(t), assignTask: async () => { throw new TypeError("broken"); } } }, r.options);
      await assert.rejects(() => throwing.round(), TypeError);
      // A round that stopped after the assignment (here: the task given to zed meanwhile): the wake is the assignee's, whoever is free now.
      const crashing = IntegratorWake.withEpoch(r.w.storage, r.w.epoch, { ...r.deps, assignments: { getAssignment: (t) => r.w.assignments.getAssignment(t), assignTask: async (c) => { await real({ ...c, owner: { kind: "agent", id: "zed" } }); throw new DomainError("unavailable", "the process stopped"); } } }, r.options);
      assert.equal((await crashing.round()).woken.length, 0);
      const kept = await r.wake.round();
      assert.deepEqual(kept.woken.map((x) => [x.projectId, x.agentId]), [[c2, "zed"]], JSON.stringify(kept));
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
      // A landing-task record that does not read as one is no landing task (the dispatcher admits it as ordinary work).
      await r.raw(LANDING_TASK_KIND, "task-hostile", { frontTaskId: "../../x", projectId: a, branch: "main", agentId: "ivy" });
      assert.equal(await r.wake.landingOf("task-hostile"), undefined);
      await r.raw(LANDING_TASK_KIND, "task-hostile2", { frontTaskId: frontA, projectId: 7, branch: "main", agentId: "ivy" });
      assert.equal(await r.wake.landingOf("task-hostile2"), undefined);
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

  test(`${backend.name}: the woken integrator's attempt is admitted in a landing place while author attempts fill the productive places and their queue, and its budget is held on the queued work's task (card P10b)`, async () => {
    const r = await rig();
    try {
      const w = r.w;
      const frontA = await r.queued(w.project);
      await w.budgets.open(w.owner, { commandId: "bo", taskId: frontA, currency: "USD", costMicros: 10_000, computeMs: 3_600_000 });
      const ivy = await w.agent("ivy", [...workGrants(w.project), ...lands([w.project])]);
      const ann = await w.agent("ann", workGrants(w.project));
      // Saturated: one productive place and one waiting place; three author attempts.
      await w.admission.setLimits({ commandId: "lim", actor: w.owner.id, limits: { ...DEFAULT_LIMITS, productive: 1, perHost: 1, queue: 1 } });
      let open: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => { open = resolve; });
      const landingTasks = new Set<string>();
      let during: { reserved: number; own: unknown } | undefined;
      w.worker.script = async ({ order }) => {
        if (landingTasks.has(order.taskId)) { during = { reserved: (await w.budgets.report(w.owner, frontA))!.reservedInFlight.computeMs, own: await w.budgets.report(w.owner, order.taskId) }; return { status: "completed", text: "landed" }; }
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
