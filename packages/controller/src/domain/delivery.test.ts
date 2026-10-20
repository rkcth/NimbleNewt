import assert from "node:assert/strict";
import { after, test } from "node:test";
import { FaultInjectingStorage } from "../storage/faults.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { DeliveryDispatcher, DomainError, TASK_EVENTS, derivedId, taskEventId, type Delivery, type TaskEvent } from "./index.js";
import { ProjectService } from "./service.js";
import { backends, stopServer, type World } from "./testing/backends.js";

after(stopServer);

const T = "2026-10-20T10:00:00.000Z";
const at = (ms: number): string => new Date(Date.parse(T) + ms).toISOString();
const fast = { clock: () => T, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const me = "rob";

/** A destination that remembers what it was given and ignores a message it has already seen, as a real one must. */
function engine() {
  const seen = new Map<string, TaskEvent>();
  const calls: Delivery[] = [];
  return {
    seen, calls,
    handler: async (d: Delivery): Promise<JsonObject> => { calls.push(d); seen.set(d.deliveryId, d.payload as unknown as TaskEvent); return { accepted: true }; },
  };
}

for (const backend of backends) {
  const suite = (name: string, body: (svc: ProjectService, world: World, epoch: number) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const svc = await ProjectService.open(world.storage, { holder: "c1", ...fast });
        await body(svc, world, svc.epoch);
      } finally { await world.close(); }
    });
  const project = async (svc: ProjectService) => (await svc.createProject({ commandId: cid("p"), actor: me, name: "Garden" })).id;
  const dispatcher = (world: World, epoch: number, e: ReturnType<typeof engine>, extra: Partial<ConstructorParameters<typeof DeliveryDispatcher>[2]> = {}) =>
    new DeliveryDispatcher(world.storage, epoch, { destination: TASK_EVENTS, claimant: "d1", handler: e.handler, clock: () => T, pause: async () => undefined, ...extra });

  suite("every task command writes its event in the same transaction, in order, as a snapshot of the new revision", async (svc, world, epoch) => {
    const p = await project(svc);
    const t = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p, title: "Buy seeds" });
    const u = await svc.updateTask({ commandId: cid("u"), actor: me, taskId: t.id, expectedRevision: 1, title: "Buy more seeds" });
    const m = await svc.transitionTask({ commandId: cid("m"), actor: me, taskId: t.id, expectedRevision: u.revision, to: "ready" });
    const e = engine();
    for (let i = 0; i < 3; i++) assert.equal((await dispatcher(world, epoch, e).runOnce()).delivered, 1, "one message of a task per pass: the next waits for the previous receipt");
    assert.deepEqual([...e.seen.keys()], [taskEventId(t.id, 1), taskEventId(t.id, 2), taskEventId(t.id, 3)]);
    assert.deepEqual(e.calls.map((c) => (c.payload as unknown as TaskEvent).change), ["created", "updated", "transitioned"]);
    const last = e.calls[2]!.payload as unknown as TaskEvent;
    assert.deepEqual([last.revision, last.state, last.from, last.projectId], [m.revision, "ready", "proposed", p]);
    assert.equal((await dispatcher(world, epoch, e).runOnce()).delivered, 0, "nothing is delivered twice");
    for (const id of e.seen.keys()) {
      const record = await world.storage.getDelivery(id);
      assert.equal(record?.state, "delivered");
      assert.deepEqual(record?.receipt, { result: { accepted: true }, attempt: 1 });
    }
  });

  suite("a command that fails or is refused announces nothing, and a repeat announces nothing new", async (svc, world, epoch) => {
    const p = await project(svc);
    const t = await svc.createTask({ commandId: "make", actor: me, projectId: p, title: "x" });
    const before = await world.storage.getDelivery(taskEventId(t.id, 1));
    assert.equal(before?.state, "pending");
    await assert.rejects(svc.transitionTask({ commandId: cid("bad"), actor: me, taskId: t.id, expectedRevision: 1, to: "done" }), (e: unknown) => e instanceof DomainError && e.code === "invalid_transition");
    await assert.rejects(svc.updateTask({ commandId: cid("stale"), actor: me, taskId: t.id, expectedRevision: 7, title: "y" }), (e: unknown) => e instanceof DomainError && e.code === "stale_revision");
    assert.equal(await world.storage.getDelivery(taskEventId(t.id, 2)), undefined, "a refused command left no message");
    await svc.createTask({ commandId: "make", actor: me, projectId: p, title: "x" });
    const e = engine();
    await dispatcher(world, epoch, e).runOnce();
    assert.equal(e.calls.length, 1, "the repeated command did not announce again");
  });

  suite("a commit that failed before it happened leaves neither the change nor the message; one that committed but was reported lost has both once", async (_svc, world, epoch) => {
    const base = ProjectService.withEpoch(world.storage, epoch, fast);
    const p = await base.createProject({ commandId: "p-faults", actor: me, name: "G" });
    const storage: ControllerStorage = new FaultInjectingStorage(world.storage, [{ when: "before", kind: "unavailable" }, { when: "after", kind: "uncertain_commit" }]);
    const svc = ProjectService.withEpoch(storage, epoch, fast);
    await assert.rejects(svc.createTask({ commandId: "t-faults", actor: me, projectId: p.id, title: "x" }), (e: unknown) => e instanceof DomainError && e.code === "unavailable");
    assert.equal((await world.storage.listAggregates("task", { limit: 10 })).length, 0, "nothing committed, so no change and no message");
    assert.equal(await world.storage.getDelivery(taskEventId(derivedId("task", "t-faults"), 1)), undefined);
    const t = await svc.createTask({ commandId: "t-faults", actor: me, projectId: p.id, title: "x" });
    assert.equal(t.replayed, true, "the commit that was reported lost is found by its operation ID");
    assert.equal((await world.storage.listAggregates("task", { limit: 10 })).length, 1);
    const e = engine();
    await dispatcher(world, epoch, e).runOnce();
    assert.equal(e.calls.length, 1, "exactly one message for the one task");
  });

  suite("a handler that fails is retried after its backoff, and later messages of the same task wait for it", async (svc, world, epoch) => {
    const p = await project(svc);
    const t = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p, title: "x" });
    await svc.transitionTask({ commandId: cid("m"), actor: me, taskId: t.id, expectedRevision: 1, to: "ready" });
    const e = engine();
    let fail = true;
    let now = T;
    const flaky = async (d: Delivery) => { if (fail) throw new Error("engine is down"); return e.handler(d); };
    const d = new DeliveryDispatcher(world.storage, epoch, { destination: TASK_EVENTS, claimant: "d1", handler: flaky, clock: () => now, backoffMs: () => 1000, pause: async () => undefined });
    assert.deepEqual(await d.runOnce(), { delivered: 0, failed: 1, superseded: 0 });
    assert.deepEqual(await d.runOnce(), { delivered: 0, failed: 0, superseded: 0 }, "nothing is due before the backoff ends, and the later message waits behind the first");
    now = at(1001); fail = false;
    assert.deepEqual(await d.runOnce(), { delivered: 1, failed: 0, superseded: 0 });
    assert.deepEqual(await d.runOnce(), { delivered: 1, failed: 0, superseded: 0 });
    assert.deepEqual([...e.seen.keys()], [taskEventId(t.id, 1), taskEventId(t.id, 2)], "delivered in commit order");
    const record = await world.storage.getDelivery(taskEventId(t.id, 1));
    assert.deepEqual([record?.state, record?.attempts], ["delivered", 2]);
  });

  suite("when the receipt cannot be recorded the message is handed over again with the same ID, and a destination that deduplicates acts once", async (svc, world, epoch) => {
    const p = await project(svc);
    const t = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p, title: "x" });
    const e = engine();
    let now = T;
    // The first receipt commit fails before it happens (the handler has already run).
    const storage: ControllerStorage = new FaultInjectingStorage(world.storage, [{ when: "before", kind: "unavailable" }]);
    const first = new DeliveryDispatcher(storage, epoch, { destination: TASK_EVENTS, claimant: "d1", handler: e.handler, clock: () => now, leaseMs: 5000, attempts: 1, pause: async () => undefined });
    assert.deepEqual(await first.runOnce(), { delivered: 0, failed: 1, superseded: 0 });
    assert.equal((await world.storage.getDelivery(taskEventId(t.id, 1)))?.state, "claimed", "the controller does not know it was delivered");
    assert.deepEqual(await first.runOnce(), { delivered: 0, failed: 0, superseded: 0 }, "still claimed until the lease ends");
    now = at(5001);
    assert.deepEqual(await first.runOnce(), { delivered: 1, failed: 0, superseded: 0 });
    assert.equal(e.calls.length, 2, "the destination was handed the message twice");
    assert.deepEqual(e.calls.map((c) => c.deliveryId), [taskEventId(t.id, 1), taskEventId(t.id, 1)]);
    assert.equal(e.seen.size, 1, "and holds it once");
    assert.equal(e.calls[1]!.attempt, 2);
  });

  suite("a receipt commit reported lost but committed is found by its operation ID, not redone", async (svc, world, epoch) => {
    const p = await project(svc);
    const t = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p, title: "x" });
    const e = engine();
    const storage: ControllerStorage = new FaultInjectingStorage(world.storage, [{ when: "after", kind: "uncertain_commit" }]);
    const d = new DeliveryDispatcher(storage, epoch, { destination: TASK_EVENTS, claimant: "d1", handler: e.handler, clock: () => T, pause: async () => undefined });
    assert.deepEqual(await d.runOnce(), { delivered: 1, failed: 0, superseded: 0 });
    assert.equal(e.calls.length, 1);
    assert.equal((await world.storage.getDelivery(taskEventId(t.id, 1)))?.state, "delivered");
    const receipts = (await world.storage.listAudit({ afterSeq: 0, limit: 100 })).filter((r) => r.type === "delivery.receipt");
    assert.equal(receipts.length, 1, "one receipt record");
  });

  suite("a dispatcher that lost its claim to another one records nothing and says so", async (svc, world, epoch) => {
    const p = await project(svc);
    const t = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p, title: "x" });
    const e = engine();
    let now = T;
    let b: DeliveryDispatcher | undefined;
    let takenOver = false;
    const slow = async (d: Delivery) => {
      // While A is inside its handler, its lease ends and B takes the message and delivers it.
      now = at(61_000);
      if (!takenOver) { takenOver = true; assert.deepEqual(await b!.runOnce(), { delivered: 1, failed: 0, superseded: 0 }); }
      return e.handler(d);
    };
    const a = new DeliveryDispatcher(world.storage, epoch, { destination: TASK_EVENTS, claimant: "A", handler: slow, clock: () => now, pause: async () => undefined });
    b = new DeliveryDispatcher(world.storage, epoch, { destination: TASK_EVENTS, claimant: "B", handler: e.handler, clock: () => now, pause: async () => undefined });
    assert.deepEqual(await a.runOnce(), { delivered: 0, failed: 0, superseded: 1 });
    const record = await world.storage.getDelivery(taskEventId(t.id, 1));
    assert.equal(record?.state, "delivered");
    assert.equal((record?.receipt as { attempt: number }).attempt, 2, "B's receipt stands");
  });

  suite("a deposed controller's dispatcher stops with stale_epoch and delivers nothing", async (svc, world, epoch) => {
    const p = await project(svc);
    await svc.createTask({ commandId: cid("t"), actor: me, projectId: p, title: "x" });
    await world.storage.acquireEpoch({ holder: "c2", at: T });
    const e = engine();
    await assert.rejects(dispatcher(world, epoch, e).runOnce(), (error: unknown) => error instanceof DomainError && error.code === "stale_epoch");
    assert.equal(e.calls.length, 0);
  });

  suite("reconciliation finds a task whose current revision has no event, announces it once, and leaves everything else alone", async (svc, world, epoch) => {
    const p = await project(svc);
    const t = await svc.createTask({ commandId: cid("t"), actor: me, projectId: p, title: "x" });
    // A task written without an event (as by a store restored from a copy, or from before events existed).
    const orphan = await world.storage.applyOperation({
      operationId: "legacy-task", epoch, actor: me, correlationId: "legacy", at: T,
      changes: [{ type: "create", ref: { kind: "task", id: "task-aaaaaaaaaaaaaaaaaaaa" }, body: { projectId: p, title: "legacy", description: "", state: "ready", createdBy: me } }],
      audit: [], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    });
    assert.equal(orphan.replayed, false);
    const first = await svc.reconcileTaskEvents({ limit: 10 });
    assert.deepEqual([first.checked, first.repaired], [2, ["task-aaaaaaaaaaaaaaaaaaaa"]]);
    assert.equal(first.next, undefined);
    assert.deepEqual((await svc.reconcileTaskEvents({ limit: 10 })).repaired, [], "a second pass repairs nothing");
    const e = engine();
    await dispatcher(world, epoch, e).runOnce();
    assert.deepEqual(e.calls.map((c) => c.deliveryId).sort(), [taskEventId("task-aaaaaaaaaaaaaaaaaaaa", 1), taskEventId(t.id, 1)].sort());
    assert.equal((e.seen.get(taskEventId("task-aaaaaaaaaaaaaaaaaaaa", 1)) as TaskEvent).change, "reconciled");
    const paged = await svc.reconcileTaskEvents({ limit: 1 });
    assert.equal(paged.checked, 1);
    assert.ok(paged.next !== undefined, "a full page says where to continue");
  });
}
