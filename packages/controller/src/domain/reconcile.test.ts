import assert from "node:assert/strict";
import { after, test } from "node:test";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import {
  ASSIGNMENT_EVENTS, AssignmentService, BlockerService, DomainError, EffectService, InboxService, Reconciler, TASK_EVENTS, assignmentEventId, taskEventId,
  type Delivery, type DomainErrorCode, type EffectBridge, type Owner,
} from "./index.js";
import { ProjectService } from "./service.js";
import { backends, stopServer, type World } from "./testing/backends.js";

after(stopServer);

const T0 = Date.parse("2026-10-20T10:00:00.000Z");
const me = "rob";
const ann: Owner = { kind: "agent", id: "ann" };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};

for (const backend of backends) {
  interface Ctx {
    projects: ProjectService; assign: AssignmentService; inbox: InboxService; effects: EffectService; blockers: BlockerService; world: World; epoch: number;
    clock: { now: number }; seen: { task: string[]; calls: number; failTask: boolean };
    reconciler(options?: ConstructorParameters<typeof Reconciler>[3], bridges?: Record<string, EffectBridge>): Reconciler;
  }
  const suite = (name: string, body: (ctx: Ctx) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      const clock = { now: T0 };
      const stamp = () => new Date(clock.now).toISOString();
      const options = { clock: stamp, pause: async () => undefined };
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
        const epoch = projects.epoch;
        const assign = AssignmentService.withEpoch(world.storage, epoch, projects, options);
        const inbox = InboxService.withEpoch(world.storage, epoch, assign, options);
        const effects = EffectService.withEpoch(world.storage, epoch, assign, { ...options, holder: "reconciler-effects" });
        const blockers = BlockerService.withEpoch(world.storage, epoch, options);
        const seen = { task: [] as string[], calls: 0, failTask: false };
        const reconciler = (extra: ConstructorParameters<typeof Reconciler>[3] = {}, bridges: Record<string, EffectBridge> = {}) => new Reconciler(world.storage, epoch, {
          projects, inbox, effects, blockers, bridges,
          destinations: [
            { name: TASK_EVENTS, handler: async (d: Delivery) => { seen.calls++; if (seen.failTask) throw new Error("engine down"); seen.task.push(d.deliveryId); } },
            { name: ASSIGNMENT_EVENTS, handler: inbox.handler("worker-1") },
          ],
        }, { ...options, ...extra });
        await body({ projects, assign, inbox, effects, blockers, world, epoch, clock, seen, reconciler });
      } finally { await world.close(); }
    });
  const readyTask = async (projects: ProjectService, title: string): Promise<string> => {
    const p = await projects.createProject({ commandId: cid("p"), actor: me, name: "Garden" });
    const t = await projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title });
    await projects.transitionTask({ commandId: cid("r"), actor: me, taskId: t.id, expectedRevision: 1, to: "ready" });
    return t.id;
  };
  const attempts = async (assign: AssignmentService, taskId: string) => (await assign.getAssignment(taskId))?.attempts ?? 0;
  /** An effect an executor started and died on: the outside world has it, nobody recorded the result, and the claim was never given back. */
  const strand = async (ctx: Ctx, bridge: EffectBridge, taskId?: string): Promise<string> => {
    let dead = true;
    const dying = new Proxy(ctx.world.storage, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (name === "applyOperation") return async (input: Parameters<ControllerStorage["applyOperation"]>[0]) => { if (dead && (input.settleEffects.length > 0 || input.operationId.startsWith("cmd:release:"))) throw Object.assign(new Error("died"), { kind: "unavailable", name: "StorageError" }); return target.applyOperation(input); };
        return value.bind(target);
      },
    });
    const doomed = EffectService.withEpoch(dying, ctx.epoch, ctx.assign, { clock: () => new Date(ctx.clock.now).toISOString(), holder: `executor-that-died-${n}` });
    const made = await doomed.intend({ commandId: cid("e"), actor: me, kind: "git-push", target: "repo:main", input: { c: 1 }, ...(taskId === undefined ? {} : { taskId }) });
    await assert.rejects(doomed.run(made.id, bridge));
    dead = false;
    return made.id;
  };
  const effects_status = async (ctx: Ctx, id: string): Promise<string | undefined> => (await ctx.effects.get(id))?.status;
  const ctx_effects = (world: World, epoch: number, assign: AssignmentService): EffectService => EffectService.withEpoch(world.storage, epoch, assign, { clock: () => new Date(T0).toISOString(), holder: "scan-effects" });
  const ZERO = { eventsRepaired: 0, deliveryFailures: 0, deliveriesHeld: 0, inboxAdmitted: 0, inboxHeld: 0, inboxDeferred: 0, effectsRun: 0, effectsHeld: 0, effectsUnbridged: 0, blockersOpened: 0, waitsTimedOut: 0, waitsOrphaned: 0, unexplainedBlocks: 0, errors: 0 };

  suite("after dropped wake-ups and a restart, one pass finds and finishes all pending work, with no model involved, and the next pass has nothing to do", async (ctx) => {
    const { projects, assign, inbox, effects, world, reconciler, seen, clock } = ctx;
    const t1 = await readyTask(projects, "one");
    const t2 = await readyTask(projects, "two");
    await assign.assignTask({ commandId: cid("a1"), actor: me, taskId: t1, owner: ann });
    await assign.assignTask({ commandId: cid("a2"), actor: me, taskId: t2, owner: ann });
    const outside: string[] = [];
    const askable: EffectBridge = { idempotent: false, execute: async (r) => { outside.push(r.key); return { ok: true }; }, reconcile: async (r) => ({ state: outside.includes(r.key) ? "applied" : "not_applied" }) };
    const intended = { id: await strand(ctx, askable) };
    assert.equal(outside.length, 1, "the effect happened; nobody recorded it");
    clock.now += 6 * 60_000; // its lease has ended

    // Nothing was ever dispatched: no wake-up reached anything. A fresh reconciler is the restarted process.
    const report = await reconciler({}, { "git-push": askable }).runPass();
    assert.deepEqual({ ...report, delivered: undefined }, { ...ZERO, delivered: undefined, inboxAdmitted: 2, effectsRun: 1, complete: true });
    assert.equal(report.delivered[TASK_EVENTS], 4, "created and ready, for each of two tasks");
    assert.equal(report.delivered[ASSIGNMENT_EVENTS], 2);
    assert.deepEqual([await attempts(assign, t1), await attempts(assign, t2)], [1, 1]);
    assert.equal((await effects.get(intended.id))!.status, "confirmed");
    assert.equal(outside.length, 1, "recovered by asking the target, not by repeating it");
    assert.equal(seen.task.length, 4);
    assert.equal((await world.storage.getDelivery(taskEventId(t1, 2)))?.state, "delivered");
    assert.equal((await world.storage.getDelivery(assignmentEventId(t1, 1)))?.state, "delivered");
    assert.equal((await inbox.getByDelivery("worker-1", assignmentEventId(t1, 1)))?.state, "admitted");

    // Admitting the attempts announced themselves (assignment events), which the next pass delivers and the inbox settles as "ignored" (they
    // announce no new owner); then there is nothing left.
    const follow = await reconciler({}, { "git-push": askable }).runPass();
    assert.deepEqual([follow.delivered[ASSIGNMENT_EVENTS], follow.inboxAdmitted], [2, 2]);
    const quiet = await reconciler({}, { "git-push": askable }).runPass();
    assert.deepEqual({ ...quiet, delivered: undefined }, { ...ZERO, delivered: undefined, complete: true }, "then a pass finds nothing");
    assert.deepEqual(Object.values(quiet.delivered), [0, 0]);
    assert.equal(seen.task.length, 4);
    assert.deepEqual([await attempts(assign, t1), await attempts(assign, t2), outside.length], [1, 1, 1], "nothing was done twice");
  });

  suite("a task whose current revision has no event is announced by the pass", async ({ projects, world, epoch, reconciler, seen }) => {
    await world.storage.applyOperation({
      operationId: "legacy-task", epoch, actor: me, correlationId: "legacy", at: new Date(T0).toISOString(),
      changes: [{ type: "create", ref: { kind: "task", id: "task-aaaaaaaaaaaaaaaaaaaa" }, body: { projectId: "proj-x", title: "legacy", description: "", state: "ready", createdBy: me } }],
      audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    });
    void projects;
    const report = await reconciler().runPass();
    assert.deepEqual([report.eventsRepaired, report.delivered[TASK_EVENTS]], [1, 1]);
    assert.deepEqual(seen.task, [taskEventId("task-aaaaaaaaaaaaaaaaaaaa", 1)]);
    assert.equal((await reconciler().runPass()).eventsRepaired, 0);
  });

  suite("a manual hold is respected by every pass and never cleared by one; resolving it lets the work go ahead", async (ctx) => {
    const { projects, assign, blockers, reconciler, effects } = ctx;
    const held = await readyTask(projects, "held");
    const free = await readyTask(projects, "free");
    for (const id of [held, free]) await assign.assignTask({ commandId: cid("a"), actor: me, taskId: id, owner: ann });
    const hold = await blockers.openBlocker({ commandId: cid("hold"), actor: me, type: "manual_hold", subject: { kind: "task", id: held }, summary: "wait for the garden plan", resolver: "rob" });
    const outside: string[] = [];
    const keyed: EffectBridge = { idempotent: true, execute: async (r) => { outside.push(r.key); return { ok: true }; } };
    const stranded = await strand(ctx, { idempotent: false, execute: async (r) => { outside.push(r.key); return {}; } }, held);
    const outsideBefore = outside.length;
    ctx.clock.now += 6 * 60_000;
    for (let i = 0; i < 3; i++) {
      const report = await reconciler({}, { "git-push": keyed }).runPass();
      assert.equal(report.inboxHeld, 1, `pass ${i}: the held task's message is left alone`);
      assert.equal(report.effectsHeld, 1, "the stranded effect of the held task is left alone");
    }
    assert.equal(outside.length, outsideBefore, "nothing was done for the held task");
    assert.equal((await effects.get(stranded))!.status, "intended");
    assert.deepEqual([await attempts(assign, held), await attempts(assign, free)], [0, 1]);
    assert.equal((await blockers.getBlocker(hold.id))!.state, "open", "no pass resolved the hold");
    assert.equal((await blockers.openFor("manual_hold", { kind: "task", id: held }))?.id, hold.id);
    await blockers.resolveBlocker({ commandId: cid("release"), actor: "rob", blockerId: hold.id, expectedRevision: 1, resolution: "plan received" });
    const after = await reconciler({}, { "git-push": keyed }).runPass();
    assert.equal(after.inboxAdmitted, 1);
    assert.equal(await attempts(assign, held), 1);
    assert.equal(after.effectsRun, 1, "and the stranded effect is recovered once the hold is gone");
    assert.equal((await effects.get(stranded))!.status, "confirmed");
  });

  suite("a message that keeps failing is held after its allowed attempts and one visible blocker is opened; resolving it lets delivery resume", async ({ projects, assign, blockers, reconciler, seen, clock, world }) => {
    const taskId = await readyTask(projects, "x");
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    seen.failTask = true;
    const options = { maxDeliveryAttempts: 3, backoffMs: () => 1000, holdCheckMs: 10 * 60_000 };
    let opened = 0;
    for (let i = 0; i < 6; i++) {
      const report = await reconciler(options).runPass();
      opened += report.blockersOpened;
      clock.now += 2000;
    }
    assert.equal(opened, 1, "exactly one blocker, however many passes found the trouble");
    const calls = seen.calls;
    assert.equal(calls, 3, "the first event was tried 3 times, and nothing behind it moved");
    const delivery = await world.storage.getDelivery(taskEventId(taskId, 1));
    const blocker = (await blockers.openFor("delivery_exhausted", { kind: "delivery", id: taskEventId(taskId, 1) }))!;
    assert.deepEqual([blocker.resolver, blocker.state, delivery?.attempts, delivery?.state], ["owner", "open", 3, "pending"]);
    assert.match(blocker.summary, /failed 3 times/);
    assert.match(blocker.summary, /engine down/);
    clock.now += 11 * 60_000;
    const held = await reconciler(options).runPass();
    assert.deepEqual([held.deliveriesHeld, held.blockersOpened], [1, 0]);
    assert.equal(seen.calls, calls, "the handler is not called while the blocker is open");
    // A person resolves the blocker before the cause is fixed: the message gets a fresh allowance, so one more failure does not hold it again at once.
    await blockers.resolveBlocker({ commandId: cid("res"), actor: "rob", blockerId: blocker.id, expectedRevision: blocker.revision, resolution: "engine restarted" });
    clock.now += 11 * 60_000;
    const retry = await reconciler(options).runPass();
    assert.deepEqual([retry.deliveryFailures, retry.blockersOpened, seen.calls], [1, 0, calls + 1], "one new failure, no new blocker");
    assert.equal(await blockers.openFor("delivery_exhausted", { kind: "delivery", id: taskEventId(taskId, 1) }), undefined);
    // Now the cause is fixed.
    seen.failTask = false;
    clock.now += 60_000;
    const resumed = await reconciler(options).runPass();
    assert.ok((resumed.delivered[TASK_EVENTS] ?? 0) >= 1);
    assert.equal((await world.storage.getDelivery(taskEventId(taskId, 1)))?.state, "delivered");
  });

  suite("one message that cannot be processed does not stop the pass: the others are admitted, effects are recovered and a blocker makes the skip visible", async (ctx) => {
    const { projects, assign, inbox, blockers, world, epoch, clock } = ctx;
    const ids: string[] = [];
    const messages: string[] = [];
    for (let i = 0; i < 3; i++) {
      const taskId = await readyTask(projects, `t${i}`);
      await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
      ids.push(taskId);
      messages.push((await inbox.receive({ source: "worker-1", deliveryId: assignmentEventId(taskId, 1), sequence: 1, payload: { taskId, revision: 1, generation: 1, state: "assigned", owner: ann as unknown as JsonObject, change: "assigned" } })).id);
    }
    const poisoned = messages[0]!;
    const outside: string[] = [];
    const askable: EffectBridge = { idempotent: false, execute: async (r) => { outside.push(r.key); return {}; }, reconcile: async (r) => ({ state: outside.includes(r.key) ? "applied" : "not_applied" }) };
    const stranded = await strand(ctx, askable);
    clock.now += 6 * 60_000;
    // An inbox whose admission of one particular message always fails for a lasting reason.
    const broken = new Proxy(inbox, {
      get(target, name, receiver) {
        if (name === "admitAssignment") return async (command: { messageId: string }) => { if (command.messageId === poisoned) throw new DomainError("integrity", "the record is malformed"); return target.admitAssignment(command as never); };
        const value = Reflect.get(target, name, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as InboxService;
    const make = () => new Reconciler(world.storage, epoch, {
      projects, inbox: broken, effects: ctx.effects, blockers, bridges: { "git-push": askable }, destinations: [],
    }, { clock: () => new Date(clock.now).toISOString(), pause: async () => undefined, pageSize: 10 });
    const first = await make().runPass();
    assert.deepEqual([first.errors, first.blockersOpened, first.inboxAdmitted, first.effectsRun], [1, 1, 2, 1], "the bad message is counted and flagged; the other two are admitted and the stranded effect is recovered in the same pass");
    assert.equal((await effects_status(ctx, stranded)), "confirmed");
    const attemptsMade = await Promise.all(ids.map((id) => attempts(assign, id)));
    assert.equal(attemptsMade.filter((a) => a === 0).length, 1, "exactly the poisoned message was skipped");
    assert.equal(attempts(assign, ids[messages.indexOf(poisoned)]!) instanceof Promise, true);
    assert.equal(await attempts(assign, ids[messages.indexOf(poisoned)]!), 0);
    const blocker = (await blockers.openFor("scan_failure", { kind: "inbox-message", id: poisoned }))!;
    assert.match(blocker.summary, /malformed/);
    assert.equal(blocker.resolver, "owner");
    for (let i = 0; i < 3; i++) assert.equal((await make().runPass()).blockersOpened, 0, "the same message does not open a blocker every pass");
  });

  suite("a trouble that comes back after a person resolved its blocker opens a new blocker", async ({ projects, assign, inbox, blockers, reconciler, seen, clock, world, epoch }) => {
    // Delivery: exhaust, resolve while the cause persists, exhaust again.
    const taskId = await readyTask(projects, "x");
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    seen.failTask = true;
    const options = { maxDeliveryAttempts: 2, backoffMs: () => 1000, holdCheckMs: 10 * 60_000 };
    const subject = { kind: "delivery", id: taskEventId(taskId, 1) };
    const exhaust = async () => { for (let i = 0; i < 3; i++) { await reconciler(options).runPass(); clock.now += 2000; } };
    await exhaust();
    const first = (await blockers.openFor("delivery_exhausted", subject))!;
    assert.ok(first);
    await blockers.resolveBlocker({ commandId: cid("res"), actor: "rob", blockerId: first.id, expectedRevision: first.revision, resolution: "looked, not fixed" });
    clock.now += 11 * 60_000;
    await exhaust();
    const second = (await blockers.openFor("delivery_exhausted", subject))!;
    assert.ok(second, "the second exhaustion is visible too");
    assert.notEqual(second.id, first.id);
    assert.equal(await blockers.occurrences("delivery_exhausted", subject), 2);
    // A lasting failure on a record: flagged, resolved, recurs.
    const messageId = (await inbox.receive({ source: "worker-1", deliveryId: "poison", payload: { taskId, change: "assigned" } })).id;
    const broken = new Proxy(inbox, {
      get(target, name, receiver) {
        if (name === "admitAssignment") return async (command: { messageId: string }) => { if (command.messageId === messageId) throw new DomainError("integrity", "malformed"); return target.admitAssignment(command as never); };
        const value = Reflect.get(target, name, receiver) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as InboxService;
    const run = () => new Reconciler(world.storage, epoch, { projects, inbox: broken, effects: ctx_effects(world, epoch, assign), blockers, bridges: {}, destinations: [] }, { clock: () => new Date(clock.now).toISOString(), pause: async () => undefined }).runPass();
    assert.equal((await run()).blockersOpened, 1);
    const flag = (await blockers.openFor("scan_failure", { kind: "inbox-message", id: messageId }))!;
    await blockers.resolveBlocker({ commandId: cid("res2"), actor: "rob", blockerId: flag.id, expectedRevision: flag.revision, resolution: "not fixed" });
    assert.equal((await run()).blockersOpened, 1, "it fails the same way again and is flagged again");
    const again = (await blockers.openFor("scan_failure", { kind: "inbox-message", id: messageId }))!;
    assert.notEqual(again.id, flag.id);
  });

  suite("an uncertain effect gets one visible blocker, which only a person resolves", async ({ projects, assign, effects, blockers, reconciler }) => {
    const taskId = await readyTask(projects, "x");
    void assign;
    const opaque: EffectBridge = { idempotent: false, execute: async () => { throw new Error("answer lost"); } };
    const intended = await effects.intend({ commandId: cid("e"), actor: me, kind: "git-push", target: "repo:main", input: {}, taskId });
    assert.equal((await effects.run(intended.id, opaque)).status, "uncertain");
    let opened = 0;
    for (let i = 0; i < 3; i++) opened += (await reconciler({}, { "git-push": opaque }).runPass()).blockersOpened;
    assert.equal(opened, 1);
    const blocker = (await blockers.openFor("effect_uncertain", { kind: "effect", id: intended.id }))!;
    assert.match(blocker.summary, /may or may not have happened/);
    assert.equal(blocker.resolver, "owner");
    await effects.resolve({ commandId: cid("res"), actor: "rob", effectId: intended.id, outcome: "confirmed", evidence: { checked: "the repository shows it" } });
    await blockers.resolveBlocker({ commandId: cid("bres"), actor: "rob", blockerId: blocker.id, expectedRevision: blocker.revision, resolution: "confirmed by hand" });
    assert.equal((await reconciler({}, { "git-push": opaque }).runPass()).blockersOpened, 0);
  });

  suite("scans keep a durable cursor: with a small page a restart between passes continues where the last pass stopped and covers everything", async ({ projects, assign, inbox, reconciler }) => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) {
      const taskId = await readyTask(projects, `t${i}`);
      await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
      ids.push(taskId);
      await inbox.receive({ source: "worker-1", deliveryId: assignmentEventId(taskId, 1), sequence: 1, payload: { taskId, revision: 1, generation: 1, state: "assigned", owner: ann as unknown as JsonObject, change: "assigned" } });
    }
    const admitted: number[] = [];
    const completes: boolean[] = [];
    for (let i = 0; i < 4; i++) {
      const report = await reconciler({ pageSize: 2 }).runPass(); // a new instance each pass: the process restarted
      admitted.push(report.inboxAdmitted);
      completes.push(report.complete);
    }
    assert.deepEqual(admitted.slice(0, 3), [2, 2, 1]);
    assert.deepEqual(completes.slice(0, 3), [false, false, true].map((c, i) => c && i === 2));
    for (const taskId of ids) assert.equal(await attempts(assign, taskId), 1);
  });

  suite("a deposed controller's pass stops with stale_epoch", async ({ world, reconciler }) => {
    await world.storage.acquireEpoch({ holder: "c2", at: new Date(T0).toISOString() });
    await refuses("stale_epoch", () => reconciler().runPass());
  });

  suite("blockers: opening is idempotent per type and subject, only a person closes one, and a later trouble opens a new one", async ({ blockers }) => {
    const subject = { kind: "task", id: "task-aaaaaaaaaaaaaaaaaaaa" };
    const [a, b] = await Promise.allSettled([
      blockers.openBlocker({ commandId: cid("o"), actor: me, type: "manual_hold", subject, summary: "wait", resolver: "rob" }),
      blockers.openBlocker({ commandId: cid("o"), actor: me, type: "manual_hold", subject, summary: "wait", resolver: "rob" }),
    ]);
    const first = (a.status === "fulfilled" ? a : b) as PromiseFulfilledResult<{ id: string; revision: number }>;
    assert.equal(first.status, "fulfilled");
    const again = await blockers.openBlocker({ commandId: cid("o2"), actor: me, type: "manual_hold", subject, summary: "wait again", resolver: "rob" });
    assert.equal(again.id, first.value.id, "an open blocker answers a second request");
    assert.equal((await blockers.list({ limit: 10, openOnly: true })).items.length, 1);
    await refuses("invalid_command", () => blockers.openBlocker({ commandId: cid("bad"), actor: me, type: "nonsense" as never, subject, summary: "x", resolver: "r" }));
    await refuses("invalid_command", () => blockers.openBlocker({ commandId: cid("bad"), actor: me, type: "manual_hold", subject: { kind: "Task", id: "x" }, summary: "x", resolver: "r" }));
    // Two people resolving it at once: one wins, the other is told it was resolved meanwhile (never a corruption error).
    const racing = await blockers.openBlocker({ commandId: cid("o4"), actor: me, type: "manual_hold", subject: { kind: "task", id: "task-bbbbbbbbbbbbbbbbbbbb" }, summary: "race", resolver: "rob" });
    const results = await Promise.allSettled([1, 2].map((k) => blockers.resolveBlocker({ commandId: cid(`rr${k}`), actor: "rob", blockerId: racing.id, expectedRevision: 1, resolution: `by ${k}` })));
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && (r.reason.code === "stale_revision" || r.reason.code === "invalid_command"), String(r.reason));
    assert.equal(await blockers.openFor("manual_hold", { kind: "task", id: "task-bbbbbbbbbbbbbbbbbbbb" }), undefined);
    await refuses("stale_revision", () => blockers.resolveBlocker({ commandId: cid("r"), actor: me, blockerId: first.value.id, expectedRevision: 9, resolution: "done" }));
    await blockers.resolveBlocker({ commandId: cid("r"), actor: "rob", blockerId: first.value.id, expectedRevision: (await blockers.getBlocker(first.value.id))!.revision, resolution: "done" });
    assert.equal(await blockers.openFor("manual_hold", subject), undefined);
    await refuses("invalid_command", () => blockers.resolveBlocker({ commandId: cid("r2"), actor: "rob", blockerId: first.value.id, expectedRevision: 2, resolution: "again" }));
    const next = await blockers.openBlocker({ commandId: cid("o3"), actor: me, type: "manual_hold", subject, summary: "wait once more", resolver: "rob" });
    assert.notEqual(next.id, first.value.id);
    assert.equal((await blockers.list({ limit: 10 })).items.length, 3);
    assert.equal((await blockers.list({ limit: 10, openOnly: true })).items.length, 1);
  });
}
