import assert from "node:assert/strict";
import { after, test } from "node:test";
import { BudgetService } from "../budgets/budgets.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PauseService } from "../lifecycle/pause.js";
import { StopService, type StopPorts } from "../lifecycle/stop.js";
import { ContractService } from "../planning/index.js";
import { PrincipalService } from "../security/index.js";
import { SWARM_LIMITS_REF, SwarmLimitsService, SwarmService } from "./index.js";

after(stopServer);

const WANT = { expectedResult: "the bed is dug", acceptanceCriteria: ["30 cm deep"] };
const options = { clock: () => "2026-11-08T10:00:00.000Z", pause: async () => undefined };
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, message?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (message !== undefined) assert.match(error.message, message); return true; });
};
const ports: StopPorts = { inventory: async () => [], cleanup: async () => ({ remaining: [] }), checkpoint: async () => ({ checkpointId: "ck", durable: true, artifactsDurable: true }), terminate: async () => ({ ended: true, unresolved: [] }) };
/** A promise and the function that settles it, to hold a step of one call while another runs. */
const latch = (): { wait: Promise<void>; open: () => void } => { let open!: () => void; const wait = new Promise<void>((r) => { open = r; }); return { wait, open }; };

for (const backend of backends) {
  type Hooks = { beforeDelegate?: () => Promise<void>; afterDelegate?: () => Promise<void>; beforeAdvance?: () => Promise<void>; beforeTransition?: () => Promise<void>; stuck?: () => boolean };
  const world = async (hooks: Hooks = {}) => {
    const w = await backend.open();
    const projects = await ProjectService.open(w.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(w.storage, projects.epoch, options);
    const rob = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    await principals.enroll(rob, { commandId: "e-ann", kind: "agent", name: "ann", grants: [] });
    const ann = await principals.authenticate((await principals.issueCredential(rob, "agent:ann")).token);
    const project = (await projects.createProject({ commandId: "p1", actor: rob.id, name: "Garden" })).id;
    const root = (await projects.createTask({ commandId: "t-root", actor: rob.id, projectId: project, title: "Plant" })).id;
    const budgets = BudgetService.withEpoch(w.storage, projects.epoch, options);
    await budgets.open(rob, { commandId: "b-open", taskId: root, currency: "USD", costMicros: 1_000_000, computeMs: 600_000 });
    const pauses = PauseService.withEpoch(w.storage, projects.epoch, {}, options);
    const stops = StopService.withEpoch(w.storage, projects.epoch, pauses, ports, options);
    // Wrappers that can hold a spawn just before its allowance is handed over, hold a cancel while it stops a child, or make a child's stop not finish.
    const held = new Proxy(budgets, { get: (t, k) => (k === "delegate" ? async (...a: Parameters<BudgetService["delegate"]>) => { await hooks.beforeDelegate?.(); const r = await t.delegate(...a); await hooks.afterDelegate?.(); return r; } : typeof (t as never)[k] === "function" ? ((t as never)[k] as (...a: unknown[]) => unknown).bind(t) : (t as never)[k]) });
    const slowStops = new Proxy(stops, { get: (t, k) => (k === "advance" ? async (...a: Parameters<StopService["advance"]>) => { await hooks.beforeAdvance?.(); if (hooks.stuck?.() === true) return { outcome: undefined } as never; return t.advance(...a); } : typeof (t as never)[k] === "function" ? ((t as never)[k] as (...a: unknown[]) => unknown).bind(t) : (t as never)[k]) });
    const settings = SwarmLimitsService.withEpoch(w.storage, projects.epoch, options);
    const contracts = ContractService.withEpoch(w.storage, projects.epoch, options);
    const slowProjects = new Proxy(projects, { get: (t, k) => (k === "transitionTask" ? async (...a: Parameters<ProjectService["transitionTask"]>) => { await hooks.beforeTransition?.(); return t.transitionTask(...a); } : typeof (t as never)[k] === "function" ? ((t as never)[k] as (...a: unknown[]) => unknown).bind(t) : (t as never)[k]) });
    const swarm = SwarmService.withEpoch(w.storage, projects.epoch, { projects: slowProjects, contracts, budgets: held, stops: slowStops, settings }, options);
    let n = 0;
    const spawn = (parentTaskId = root, extra: Record<string, unknown> = {}) => swarm.spawn(rob, { commandId: `sp${n++}`, parentTaskId, title: `Child ${n}`, ...WANT, costMicros: 1000, computeMs: 100, ...extra } as never);
    const finish = async (id: string) => { const t = (await projects.getTask(id))!; await projects.transitionTask({ commandId: `fin-${id}`, actor: rob.id, taskId: id, expectedRevision: t.revision, to: "cancelled" } as never); };
    const tasks = async () => (await w.storage.listAggregates("task", { limit: 500 })).map((t) => ({ id: t.id, title: (t.body as { title: string }).title, state: (t.body as { state: string }).state }));
    return { w, rob, ann, project, root, budgets, settings, swarm, contracts, projects, spawn, finish, tasks };
  };
  const suite = (name: string, run: () => Promise<void>) => test(`${backend.name}: swarm limits (card H10): ${name}`, run);

  suite("the defaults hold until the owner changes them; the owner sets, turns off and unsets; only the owner may; the record is race-safe and checked", async () => {
    const x = await world();
    try {
      assert.deepEqual(await x.settings.effective(), { depth: 3, liveChildren: 4, totalChildren: 16 });
      const first = await x.settings.get(x.rob);
      assert.deepEqual([first.revision, first.limits, first.effective, first.damaged], [0, {}, { depth: 3, liveChildren: 4, totalChildren: 16 }, []]);
      await refuses("forbidden", () => x.settings.get(x.ann));
      await refuses("forbidden", () => x.settings.change(x.ann, { commandId: "c0", set: { liveChildren: 9 } }));
      const r1 = await x.settings.change(x.rob, { commandId: "c1", set: { liveChildren: 2, totalChildren: null }, expectedRevision: 0 });
      assert.deepEqual(await x.settings.effective(), { depth: 3, liveChildren: 2 }, "no fan-in total");
      await refuses("stale_revision", () => x.settings.change(x.rob, { commandId: "c2", set: { depth: 1 }, expectedRevision: 0 }));
      assert.deepEqual(await x.settings.change(x.rob, { commandId: "c1", set: { liveChildren: 2, totalChildren: null }, expectedRevision: 0 }), r1, "a repeat applies once");
      await x.settings.change(x.rob, { commandId: "c3", unset: ["totalChildren"], set: { depth: 0 } });
      assert.deepEqual(await x.settings.effective(), { depth: 0, liveChildren: 2, totalChildren: 16 });
      for (const bad of [{ set: { depth: 9 } }, { set: { liveChildren: -1 } }, { set: { totalChildren: 0 } }, { set: { depth: null } }, { set: { width: 2 } }, { unset: ["width"] }, {}, { set: { depth: 1 }, unset: ["depth"] }, { set: { depth: 1.5 } }]) {
        await refuses("invalid_command", () => x.settings.change(x.rob, { commandId: `bad-${JSON.stringify(bad)}`, ...bad } as never));
      }
    } finally { await x.w.close(); }
  });

  suite("depth 0 or live children 0 allow no new child, nothing is left live, and the next figure is read at the next spawn", async () => {
    const x = await world();
    try {
      await x.settings.change(x.rob, { commandId: "d0", set: { depth: 0 } });
      const before = (await x.tasks()).length;
      await refuses("invalid_command", () => x.spawn(), /no child tasks now/);
      assert.equal((await x.tasks()).length, before, "nothing was made");
      await x.settings.change(x.rob, { commandId: "d1", set: { depth: 1, liveChildren: 0 } });
      await refuses("invalid_command", () => x.spawn(), /no new child tasks now/);
      assert.ok((await x.tasks()).every((t) => t.id === x.root || t.state === "cancelled"), "the child made before the refusal was cancelled");
      await x.settings.change(x.rob, { commandId: "d2", set: { liveChildren: 1 } });
      const child = await x.spawn();
      await refuses("invalid_command", () => x.spawn(child.taskId), /at most 1 levels deep/);
      await refuses("invalid_command", () => x.spawn(), /at most 1 live children/);
    } finally { await x.w.close(); }
  });

  suite("the fan-in total counts finished children too, so a parent's children in all stay bounded; spawns at the same moment cannot pass it", async () => {
    const x = await world();
    try {
      await x.settings.change(x.rob, { commandId: "f1", set: { totalChildren: 2, liveChildren: 10 } });
      const a = await x.spawn();
      await x.finish(a.taskId);
      await x.spawn();
      await refuses("invalid_command", () => x.spawn(), /at most 2 children in all \(the owner's fan-in limit\)/);
      // Raised: four at once meet a total of 4 with two already made, so exactly two pass.
      await x.settings.change(x.rob, { commandId: "f2", set: { totalChildren: 4 } });
      const results = await Promise.allSettled([0, 1, 2, 3].map(() => x.spawn()));
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 2, JSON.stringify(results.map((r) => (r.status === "rejected" ? String(r.reason) : "ok"))));
      for (const r of results) if (r.status === "rejected") assert.match(String(r.reason), /fan-in|claimed a place/);
      assert.equal((await x.swarm.children(x.root, x.project)).length, 4);
      // Turned off: the total no longer counts.
      await x.settings.change(x.rob, { commandId: "f3", set: { totalChildren: null } });
      await x.spawn();
    } finally { await x.w.close(); }
  });

  suite("a child needs the outcome and acceptance criteria its parent assigns, gets them in its contract, and spends only the allowance delegated to it", async () => {
    const x = await world();
    try {
      const before = (await x.tasks()).length;
      await refuses("invalid_command", () => x.spawn(x.root, { expectedResult: undefined }), /expectedResult/);
      await refuses("invalid_command", () => x.spawn(x.root, { acceptanceCriteria: [] }), /acceptanceCriteria/);
      await refuses("invalid_command", () => x.spawn(x.root, { expectedResult: "  " }), /expectedResult/);
      assert.equal((await x.tasks()).length, before, "nothing was made");
      // The parent is limited in both money and compute time, so a child given only one of them would be unlimited in the other: refused, and the child made for it is cancelled.
      await refuses("invalid_command", () => x.spawn(x.root, { computeMs: undefined }), /compute time is limited/);
      const made = await x.spawn(x.root, { costMicros: 5000, computeMs: 700 });
      const contract = await x.contracts.get(x.rob, made.taskId);
      assert.deepEqual([contract?.expectedResult, contract?.acceptanceCriteria], [WANT.expectedResult, WANT.acceptanceCriteria]);
      const child = (await x.budgets.report(x.rob, made.taskId))!;
      assert.deepEqual([child.limit.costMicros, child.limit.computeMs], [5000, 700]);
      await refuses("invalid_command", () => x.budgets.reserve(x.rob, { commandId: "over", taskId: made.taskId, costMicros: 5001, purpose: "more than it was given" }), /budget/);
      await x.budgets.reserve(x.rob, { commandId: "fits", taskId: made.taskId, costMicros: 5000, computeMs: 700, purpose: "all it was given" });
      // A finished parent spawns nothing.
      await x.finish(made.taskId);
      await refuses("invalid_command", () => x.spawn(made.taskId), /cancelled task spawns nothing/);
    } finally { await x.w.close(); }
  });

  suite("a damaged setting refuses spawning (nothing starts on a guess) but cancelling still works, and setting the damaged figure repairs it", async () => {
    const x = await world();
    try {
      const child = await x.spawn();
      await x.w.storage.applyOperation({ operationId: "damage", epoch: x.projects.epoch, actor: "owner:rob", correlationId: "damage", at: options.clock(), changes: [{ type: "create", ref: SWARM_LIMITS_REF, body: { depth: "deep" } }], audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [] } as never);
      await refuses("integrity", () => x.spawn(), /damaged at depth/);
      assert.equal((await x.settings.get(x.rob)).effective, null);
      const cancelled = await x.swarm.cancel(x.rob, { commandId: "cx", parentTaskId: x.root, reason: "plans changed" });
      assert.deepEqual([cancelled.settled, cancelled.pending], [[child.taskId], []]);
      await refuses("invalid_command", () => x.settings.change(x.rob, { commandId: "r0", set: { liveChildren: 3 } }), /damaged at depth/);
      await x.settings.change(x.rob, { commandId: "r1", unset: ["depth"] });
      await x.spawn();
    } finally { await x.w.close(); }
  });

  suite("cancelling settles a child whose spawn was still in progress: its allowance goes back, the spawn says so, and nothing is left live", async () => {
    const hold = latch();
    const reached = latch();
    let holding = false;
    const x = await world({ beforeDelegate: async () => { if (holding) { reached.open(); await hold.wait; } } });
    try {
      const first = await x.spawn();
      holding = true;
      const late = x.spawn();
      await reached.wait; // the late spawn has claimed its place and waits before its allowance is handed over
      holding = false;
      const result = await x.swarm.cancel(x.rob, { commandId: "c1", parentTaskId: x.root, reason: "plans changed" });
      assert.equal(result.pending.length, 0, JSON.stringify(result));
      assert.equal(result.settled.length, 2, "the linked child and the one still being made");
      assert.ok(result.settled.includes(first.taskId));
      hold.open();
      await refuses("invalid_command", () => late, /cancelled while this child was being made/);
      const live = (await x.tasks()).filter((t) => t.id !== x.root && t.state !== "cancelled");
      assert.deepEqual(live, [], "no child of the cancelled swarm is live");
      assert.deepEqual((await x.budgets.report(x.rob, x.root))!.delegatedToChildren, { costMicros: 0, computeMs: 0 }, "everything handed down came back");
      // Once nothing is pending the parent may spawn again.
      await x.spawn();
    } finally { await x.w.close(); }
  });

  suite("a spawn that hands its allowance over after the cancel looked for it, and sees its child still live, does not keep that allowance from the parent", async () => {
    const spawnHold = latch();
    const spawnReached = latch();
    const cancelHold = latch();
    const cancelReached = latch();
    let holdSpawn = false;
    let holdCancel = false;
    const x = await world({
      beforeDelegate: async () => { if (holdSpawn) { holdSpawn = false; spawnReached.open(); await spawnHold.wait; } },
      beforeTransition: async () => { if (holdCancel) { holdCancel = false; cancelReached.open(); await cancelHold.wait; } },
    });
    try {
      holdSpawn = true;
      const late = x.spawn();
      await spawnReached.wait; // claimed, no allowance yet
      holdCancel = true;
      const cancelling = x.swarm.cancel(x.rob, { commandId: "c1", parentTaskId: x.root, reason: "plans changed" });
      await cancelReached.wait; // the cancel found no allowance and is about to cancel the child
      spawnHold.open();
      const made = await late; // the spawn hands the allowance over, links, and still sees its child live
      cancelHold.open();
      const result = await cancelling;
      assert.deepEqual([result.settled, result.pending], [[made.taskId], []]);
      assert.equal((await x.projects.getTask(made.taskId))!.state, "cancelled");
      assert.deepEqual((await x.budgets.report(x.rob, x.root))!.delegatedToChildren, { costMicros: 0, computeMs: 0 }, "the allowance handed over late came back");
    } finally { await x.w.close(); }
  });

  suite("while a swarm is being cancelled no new child is made under it, and until a cancel ends with nothing pending the parent stays closed", async () => {
    const hold = latch();
    const reached = latch();
    let holding = true;
    let stuck = true;
    const x = await world({ beforeAdvance: async () => { if (holding) { holding = false; reached.open(); await hold.wait; } }, stuck: () => stuck });
    try {
      const a = await x.spawn();
      const grandchild = await x.spawn(a.taskId);
      const cancelling = x.swarm.cancel(x.rob, { commandId: "c1", parentTaskId: x.root, reason: "plans changed" });
      await reached.wait;
      await refuses("invalid_command", () => x.spawn(), /being cancelled/);
      await refuses("invalid_command", () => x.spawn(a.taskId), /being cancelled/);
      hold.open();
      const first = await cancelling;
      assert.deepEqual(first.pending.sort(), [a.taskId, grandchild.taskId].sort(), "the stops did not finish");
      await refuses("invalid_command", () => x.spawn(), /being cancelled/);
      stuck = false;
      const second = await x.swarm.cancel(x.rob, { commandId: "c2", parentTaskId: x.root, reason: "plans changed" });
      assert.deepEqual([second.settled, second.pending], [[grandchild.taskId, a.taskId], []], "deepest first");
      const again = await x.spawn();
      assert.ok(again.taskId);
    } finally { await x.w.close(); }
  });

  // Review of card H10: the money paths around a cancel.
  const delegated = async (x: Awaited<ReturnType<typeof world>>) => (await x.budgets.report(x.rob, x.root))!.delegatedToChildren;

  suite("a spawn that crashes just after its hand-over, to a child a cancel already cancelled, leaves nothing with that child: a cancelled task is given no allowance", async () => {
    const hold = latch();
    const reached = latch();
    let holding = true;
    const x = await world({ beforeDelegate: async () => { if (holding) { holding = false; reached.open(); await hold.wait; } }, afterDelegate: async () => { throw new Error("the process died after the hand-over"); } });
    try {
      const late = x.spawn();
      await reached.wait; // claimed, no allowance yet
      const result = await x.swarm.cancel(x.rob, { commandId: "c1", parentTaskId: x.root, reason: "plans changed" });
      assert.deepEqual(result.pending, []);
      const [child] = result.settled;
      hold.open();
      await assert.rejects(late);
      assert.equal(await x.w.storage.getAggregate({ kind: "budget-link", id: child! }), undefined, "the cancelled child was given no allowance");
      assert.deepEqual(await delegated(x), { costMicros: 0, computeMs: 0 }, "nothing stays handed down");
    } finally { await x.w.close(); }
  });

  suite("a delegation whose child is cancelled between the delegation's read of it and its commit is refused, not committed to the cancelled task", async () => {
    const x = await world();
    try {
      const child = (await x.projects.createTask({ commandId: "t-c", actor: x.rob.id, projectId: x.project, title: "Child" })).id;
      let cancelOnRead = true;
      // The delegation's read of the child task is answered, and only then is the task cancelled: its commit meets a newer task.
      const storage = new Proxy(x.w.storage, { get: (t, k) => (k === "getAggregate" ? async (ref: { kind: string; id: string }) => { const v = await t.getAggregate(ref); if (cancelOnRead && ref.kind === "task" && ref.id === child) { cancelOnRead = false; await x.finish(child); } return v; } : typeof (t as never)[k] === "function" ? ((t as never)[k] as (...a: unknown[]) => unknown).bind(t) : (t as never)[k]) });
      const racing = BudgetService.withEpoch(storage, x.projects.epoch, options);
      await refuses("invalid_command", () => racing.delegate(x.rob, { commandId: "d-race", parentTaskId: x.root, childTaskId: child, costMicros: 1000, computeMs: 100 }), /cancelled task is given no allowance/);
      assert.equal(cancelOnRead, false, "the race was staged");
      assert.equal(await x.w.storage.getAggregate({ kind: "budget-link", id: child }), undefined);
      assert.deepEqual(await delegated(x), { costMicros: 0, computeMs: 0 });
    } finally { await x.w.close(); }
  });

  suite("a parent cancelled by another path while its child is being made hands that child nothing; the child is cancelled", async () => {
    let cancelParent: (() => Promise<void>) | undefined;
    const x = await world({ beforeDelegate: async () => { const run = cancelParent; cancelParent = undefined; await run?.(); } });
    try {
      const parent = await x.spawn();
      cancelParent = () => x.finish(parent.taskId); // after the spawn's finished-parent check and its claim, before the hand-over
      await refuses("invalid_command", () => x.spawn(parent.taskId, { costMicros: 400, computeMs: 40 }), /cancelled task hands on no allowance/);
      assert.equal(cancelParent, undefined, "the race was staged");
      const report = (await x.budgets.report(x.rob, parent.taskId))!;
      assert.deepEqual(report.delegatedToChildren, { costMicros: 0, computeMs: 0 });
      assert.deepEqual((await x.tasks()).filter((t) => t.id !== x.root && t.state !== "cancelled"), [], "nothing is left live");
    } finally { await x.w.close(); }
  });

  suite("a cancel cancels a child before it takes back the allowance, so a cancel that fails half-way never leaves a live child with its limit taken down (a limit of 0 reads as none)", async () => {
    let failing = false;
    const x = await world({ beforeTransition: async () => { if (failing) { failing = false; throw new DomainError("unavailable", "the store went away"); } } });
    try {
      const child = await x.spawn();
      failing = true;
      await refuses("unavailable", () => x.swarm.cancel(x.rob, { commandId: "c1", parentTaskId: x.root, reason: "plans changed" }));
      assert.notEqual((await x.projects.getTask(child.taskId))!.state, "cancelled");
      const limit = (await x.budgets.report(x.rob, child.taskId))!.limit;
      assert.deepEqual([limit.costMicros, limit.computeMs], [1000, 100], "the live child keeps the limit it was given");
      const again = await x.swarm.cancel(x.rob, { commandId: "c2", parentTaskId: x.root, reason: "plans changed" });
      assert.deepEqual([again.settled, again.pending], [[child.taskId], []]);
      assert.deepEqual(await delegated(x), { costMicros: 0, computeMs: 0 });
    } finally { await x.w.close(); }
  });

  suite("what a cancelled child held and has since let go of, and what a finished child did not use, go back on the next cancel", async () => {
    const x = await world();
    try {
      const child = await x.spawn();
      const hold = await x.budgets.reserve(x.rob, { commandId: "hold", taskId: child.taskId, costMicros: 600, computeMs: 60, purpose: "a call in flight" });
      await x.swarm.cancel(x.rob, { commandId: "c1", parentTaskId: x.root, reason: "plans changed" });
      assert.deepEqual(await delegated(x), { costMicros: 600, computeMs: 60 }, "the hold stays with the child");
      await x.budgets.release(x.rob, { commandId: "let-go", reservationId: hold.id });
      // A child that finished its work keeps what it did not use until the swarm is settled.
      const done = await x.spawn();
      for (const to of ["ready", "in_progress", "done"]) { const t = (await x.projects.getTask(done.taskId))!; await x.projects.transitionTask({ commandId: `to-${to}`, actor: x.rob.id, taskId: done.taskId, expectedRevision: t.revision, to } as never); }
      assert.deepEqual(await delegated(x), { costMicros: 1600, computeMs: 160 }, "the cancelled child's 600 and the finished child's 1000");
      const again = await x.swarm.cancel(x.rob, { commandId: "c2", parentTaskId: x.root, reason: "plans changed" });
      assert.deepEqual([again.settled.sort(), again.pending], [[child.taskId, done.taskId].sort(), []]);
      assert.deepEqual(await delegated(x), { costMicros: 0, computeMs: 0 }, "what was let go of and what was left came back");
    } finally { await x.w.close(); }
  });

  suite("a nested cancel that ends while an outer cancel still runs does not reopen its task to new children", async () => {
    const hold = latch();
    const reached = latch();
    let holding = false;
    const x = await world({ beforeAdvance: async () => { if (holding) { holding = false; reached.open(); await hold.wait; } } });
    try {
      const inner = await x.spawn();
      const grandchild = await x.spawn(inner.taskId, { costMicros: 400, computeMs: 40 });
      holding = true;
      const outer = x.swarm.cancel(x.rob, { commandId: "outer", parentTaskId: x.root, reason: "plans changed" });
      await reached.wait; // the outer cancel has sealed the swarm and is stopping the grandchild
      const nested = await x.swarm.cancel(x.rob, { commandId: "inner", parentTaskId: inner.taskId, reason: "that part is not needed" });
      assert.deepEqual([nested.settled, nested.pending], [[grandchild.taskId], []]);
      await refuses("invalid_command", () => x.spawn(inner.taskId, { costMicros: 400, computeMs: 40 }), /being cancelled/);
      hold.open();
      const result = await outer;
      assert.deepEqual(result.pending, [], JSON.stringify(result));
      const live = (await x.tasks()).filter((t) => t.id !== x.root && t.state !== "cancelled");
      assert.deepEqual(live, [], "no child of the cancelled swarm is live");
      assert.deepEqual(await delegated(x), { costMicros: 0, computeMs: 0 });
      await x.spawn();
    } finally { await x.w.close(); }
  });

  // Review round 4 of card H10: contention on one parent.
  suite("as many spawns at once as a parent may have live children all get their place: none is refused only because the others claimed theirs at the same moment", async () => {
    const x = await world();
    try {
      await x.settings.change(x.rob, { commandId: "m1", set: { liveChildren: 64, totalChildren: null } });
      const results = await Promise.allSettled(Array.from({ length: 64 }, () => x.spawn(x.root, { costMicros: 100, computeMs: 10 })));
      assert.deepEqual(results.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)), []);
      assert.equal((await x.swarm.children(x.root, x.project)).length, 64);
      assert.deepEqual(await delegated(x), { costMicros: 6400, computeMs: 640 });
      await refuses("invalid_command", () => x.spawn(x.root, { costMicros: 100, computeMs: 10 }), /at most 64 live children/);
    } finally { await x.w.close(); }
  });

  suite("two cancels of the same swarm sent together both end: neither is refused because the other stopped a child first, nothing is left live or handed down, and the parent reopens", async () => {
    const x = await world();
    try {
      await x.settings.change(x.rob, { commandId: "m1", set: { liveChildren: 12 } });
      const made = await Promise.all(Array.from({ length: 12 }, () => x.spawn(x.root, { costMicros: 100, computeMs: 10 })));
      const both = await Promise.allSettled([x.swarm.cancel(x.rob, { commandId: "ca", parentTaskId: x.root, reason: "plans changed" }), x.swarm.cancel(x.rob, { commandId: "cb", parentTaskId: x.root, reason: "plans changed" })]);
      assert.deepEqual(both.filter((r) => r.status === "rejected").map((r) => String((r as PromiseRejectedResult).reason)), []);
      const ends = both.map((r) => (r as PromiseFulfilledResult<{ settled: string[]; pending: string[] }>).value);
      // Each settles every child or, where the other was still stopping it, reports it pending; between them every child is settled.
      for (const end of ends) assert.equal(end.settled.length + end.pending.length, made.length, JSON.stringify(end));
      assert.ok(ends.some((end) => end.pending.length === 0), JSON.stringify(ends));
      assert.deepEqual((await x.tasks()).filter((t) => t.id !== x.root && t.state !== "cancelled"), [], "no child is live");
      assert.deepEqual(await delegated(x), { costMicros: 0, computeMs: 0 });
      await x.spawn();
    } finally { await x.w.close(); }
  });
}
