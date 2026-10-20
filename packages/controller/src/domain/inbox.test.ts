import assert from "node:assert/strict";
import { after, test } from "node:test";
import { FaultInjectingStorage } from "../storage/faults.js";
import type { JsonObject } from "../storage/types.js";
import {
  ASSIGNMENT_EVENTS, AssignmentService, DeliveryDispatcher, DomainError, InboxService, assignmentEventId, inboxMessageId,
  type AssignmentEvent, type DomainErrorCode, type Owner,
} from "./index.js";
import { ProjectService } from "./service.js";
import { backends, stopServer, type World } from "./testing/backends.js";

after(stopServer);

const T = "2026-10-20T10:00:00.000Z";
const fast = { clock: () => T, pause: async () => undefined };
const me = "rob";
const ann: Owner = { kind: "agent", id: "ann" };
const bob: Owner = { kind: "agent", id: "bob" };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const SOURCE = "worker-1";

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    check?.(error);
    return true;
  });
};

for (const backend of backends) {
  const suite = (name: string, body: (ctx: { projects: ProjectService; assign: AssignmentService; inbox: InboxService; world: World; epoch: number }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...fast });
        const assign = AssignmentService.withEpoch(world.storage, projects.epoch, projects, fast);
        await body({ projects, assign, inbox: InboxService.withEpoch(world.storage, projects.epoch, assign, fast), world, epoch: projects.epoch });
      } finally { await world.close(); }
    });
  const readyTask = async (projects: ProjectService, title = "Buy seeds"): Promise<string> => {
    const p = await projects.createProject({ commandId: cid("p"), actor: me, name: "Garden" });
    const t = await projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title });
    await projects.transitionTask({ commandId: cid("ready"), actor: me, taskId: t.id, expectedRevision: 1, to: "ready" });
    return t.id;
  };
  /** The message the sender would deliver for assignment revision `revision` of a task, as the outbox holds it. */
  const incoming = async (world: World, taskId: string, revision: number) => {
    const d = (await world.storage.getDelivery(assignmentEventId(taskId, revision)))!;
    return { source: SOURCE, deliveryId: d.deliveryId, orderingKey: taskId, sequence: d.aggregateRevision, payload: d.payload };
  };
  const attempts = async (assign: AssignmentService, taskId: string) => (await assign.getAssignment(taskId))!.attempts;

  suite("a message is held durably once; a repeat is answered from the record; a changed payload is refused and changes nothing", async ({ inbox, world }) => {
    const message = { source: SOURCE, deliveryId: "d-1", orderingKey: "task-x", sequence: 3, payload: { a: 1, b: [true, null] } as JsonObject };
    const first = await inbox.receive(message);
    assert.deepEqual([first.revision, first.replayed], [1, false]);
    const stored = (await inbox.getByDelivery(SOURCE, "d-1"))!;
    assert.deepEqual([stored.state, stored.payload, stored.sequence, stored.orderingKey, stored.id], ["received", message.payload, 3, "task-x", inboxMessageId(SOURCE, "d-1")]);
    assert.deepEqual(await inbox.receive({ ...message, payload: { b: [true, null], a: 1 } }), { ...first, replayed: true }, "key order does not make it a different payload");
    await refuses("payload_changed", () => inbox.receive({ ...message, payload: { a: 2 } }));
    assert.deepEqual((await inbox.getByDelivery(SOURCE, "d-1"))!.payload, message.payload);
    assert.equal((await world.storage.listAudit({ afterSeq: 0, limit: 100 })).filter((r) => r.type === "inbox.receive").length, 1);
    const other = await inbox.receive({ ...message, source: "worker-2" });
    assert.notEqual(other.id, first.id, "the same delivery ID from another source is another message");
    await refuses("invalid_command", () => inbox.receive({ ...message, deliveryId: "" }));
    await refuses("invalid_command", () => inbox.receive({ ...message, payload: [] as never }));
    await refuses("invalid_command", () => inbox.receive({ ...message, deliveryId: "big", payload: { text: "x".repeat(70_000) } }), (e) => assert.equal(e.field, "payload"));
    await refuses("invalid_command", () => inbox.receive({ ...message, colour: "red" } as never));
  });

  suite("a delivery is acknowledged only after the message is durably held", async ({ projects, assign, world, epoch, inbox }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const lossy = new FaultInjectingStorage(world.storage, [{ when: "before", kind: "unavailable" }]);
    const faulty = InboxService.withEpoch(lossy, epoch, assign, { ...fast, attempts: 1 });
    const dispatcher = (target: InboxService) => new DeliveryDispatcher(world.storage, epoch, { destination: ASSIGNMENT_EVENTS, claimant: "d", handler: target.handler(SOURCE), clock: () => T, backoffMs: () => 0, pause: async () => undefined });
    assert.deepEqual(await dispatcher(faulty).runOnce(), { delivered: 0, failed: 1, superseded: 0, held: 0 });
    assert.equal(await inbox.getByDelivery(SOURCE, assignmentEventId(taskId, 1)), undefined, "nothing was held");
    assert.notEqual((await world.storage.getDelivery(assignmentEventId(taskId, 1)))?.state, "delivered", "so nothing was acknowledged");
    assert.deepEqual(await dispatcher(inbox).runOnce(), { delivered: 1, failed: 0, superseded: 0, held: 0 });
    const held = (await inbox.getByDelivery(SOURCE, assignmentEventId(taskId, 1)))!;
    assert.equal(held.state, "received");
    const delivery = (await world.storage.getDelivery(assignmentEventId(taskId, 1)))!;
    assert.deepEqual([delivery.state, (delivery.receipt as { result: { messageId: string } }).result.messageId], ["delivered", held.id]);
  });

  suite("a duplicate message and a repeated admission create one attempt", async ({ projects, assign, inbox, world }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const message = await incoming(world, taskId, 1);
    const one = await inbox.receive(message);
    const two = await inbox.receive(message);
    assert.deepEqual([one.id, two.replayed], [two.id, true]);
    const first = await inbox.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: one.id });
    assert.deepEqual([first.outcome, first.replayed], ["admitted", false]);
    const again = await inbox.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: one.id });
    assert.deepEqual([again.outcome, again.attemptId, again.replayed], ["admitted", first.attemptId, true]);
    assert.equal(await attempts(assign, taskId), 1);
    assert.deepEqual([(await assign.getAttempt(first.attemptId!))!.owner, (await inbox.getMessage(one.id))!.state], [ann, "admitted"]);
  });

  suite("messages arriving out of order cannot create a second attempt", async ({ projects, assign, inbox, world }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    await assign.transferTask({ commandId: cid("tr"), actor: me, taskId, expectedRevision: 1, to: bob });
    const newer = await inbox.receive(await incoming(world, taskId, 2));
    const older = await inbox.receive(await incoming(world, taskId, 1));
    const a2 = await inbox.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: newer.id });
    assert.equal(a2.outcome, "admitted");
    assert.equal((await assign.getAttempt(a2.attemptId!))!.owner.id, "bob");
    const a1 = await inbox.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: older.id });
    assert.deepEqual([a1.outcome, a1.attemptId], ["superseded", undefined]);
    assert.equal(await attempts(assign, taskId), 1);
    assert.deepEqual([(await inbox.getMessage(older.id))!.state, (await inbox.getMessage(older.id))!.settlement?.outcome], ["settled", "superseded"]);
  });

  suite("a task that already has an active attempt is not given another", async ({ projects, assign, inbox, world }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const direct = await assign.admitAttempt({ commandId: cid("direct"), actor: me, taskId, expectedRevision: 1, generation: 1, owner: ann });
    const m = await inbox.receive(await incoming(world, taskId, 1));
    const r = await inbox.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: m.id });
    assert.deepEqual([r.outcome, r.attemptId], ["already_active", direct.id]);
    assert.equal(await attempts(assign, taskId), 1);
  });

  suite("messages that announce something other than a new owner are ignored, and unknown ones are not found", async ({ projects, assign, inbox, world }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    await assign.admitAttempt({ commandId: cid("direct"), actor: me, taskId, expectedRevision: 1, generation: 1, owner: ann });
    const m = await inbox.receive(await incoming(world, taskId, 2));
    assert.equal((await inbox.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: m.id })).outcome, "ignored");
    const stranger = await inbox.receive({ source: SOURCE, deliveryId: "not-an-event", payload: { hello: "world" } });
    assert.equal((await inbox.admitAssignment({ commandId: cid("adm2"), actor: "worker", messageId: stranger.id })).outcome, "ignored");
    await refuses("not_found", () => inbox.admitAssignment({ commandId: cid("adm3"), actor: "worker", messageId: inboxMessageId(SOURCE, "never-received") }));
    await refuses("invalid_command", () => inbox.admitAssignment({ commandId: cid("adm4"), actor: "worker", messageId: "bogus" }));
  });

  suite("two admissions of one message at once yield one attempt and one answer", async ({ projects, assign, inbox, world }) => {
    for (let i = 0; i < 5; i++) {
      const taskId = await readyTask(projects, `race ${i}`);
      await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
      const m = await inbox.receive(await incoming(world, taskId, 1));
      const results = await Promise.all([
        inbox.admitAssignment({ commandId: cid("x"), actor: "w1", messageId: m.id }),
        inbox.admitAssignment({ commandId: cid("y"), actor: "w2", messageId: m.id }),
      ]);
      assert.equal(results[0].outcome, "admitted");
      assert.deepEqual([results[1].outcome, results[1].attemptId], ["admitted", results[0].attemptId]);
      assert.equal(await attempts(assign, taskId), 1);
    }
  });

  suite("a crash between creating the attempt and recording the admission is repaired by repeating it", async ({ projects, assign, world, epoch }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const healthy = InboxService.withEpoch(world.storage, epoch, assign, fast);
    const m = await healthy.receive(await incoming(world, taskId, 1));
    // The mark commit fails after the attempt was created.
    const crashing = InboxService.withEpoch(new FaultInjectingStorage(world.storage, [{ when: "before", kind: "unavailable" }]), epoch, assign, { ...fast, attempts: 1 });
    await refuses("unavailable", () => crashing.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: m.id }));
    assert.equal(await attempts(assign, taskId), 1, "the attempt exists");
    assert.equal((await healthy.getMessage(m.id))!.state, "received", "but the message does not yet say so");
    const done = await healthy.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: m.id });
    assert.equal(done.outcome, "admitted");
    assert.equal(await attempts(assign, taskId), 1, "repeating it found its own attempt");
    assert.equal(done.attemptId, (await assign.getAssignment(taskId))!.activeAttemptId);
  });

  suite("a task that is not ready is deferred without recording anything, and a closed task settles the message as task_closed", async ({ projects, assign, inbox, world }) => {
    const p = await projects.createProject({ commandId: cid("p"), actor: me, name: "G" });
    const early = await projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "not ready yet" });
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId: early.id, owner: ann });
    const m = await inbox.receive(await incoming(world, early.id, 1));
    const deferred = await inbox.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: m.id });
    assert.deepEqual([deferred.outcome, deferred.attemptId, (await inbox.getMessage(m.id))!.state], ["deferred", undefined, "received"]);
    assert.equal(await attempts(assign, early.id), 0);
    await projects.transitionTask({ commandId: cid("ready"), actor: me, taskId: early.id, expectedRevision: 1, to: "ready" });
    assert.equal((await inbox.admitAssignment({ commandId: cid("adm2"), actor: "worker", messageId: m.id })).outcome, "admitted", "once the task is ready the same message is admitted");

    const closed = await projects.createTask({ commandId: cid("t2"), actor: me, projectId: p.id, title: "cancelled" });
    await assign.assignTask({ commandId: cid("a2"), actor: me, taskId: closed.id, owner: ann });
    await projects.transitionTask({ commandId: cid("cancel"), actor: me, taskId: closed.id, expectedRevision: 1, to: "cancelled" });
    const m2 = await inbox.receive(await incoming(world, closed.id, 1));
    const r = await inbox.admitAssignment({ commandId: cid("adm3"), actor: "worker", messageId: m2.id });
    assert.deepEqual([r.outcome, (await inbox.getMessage(m2.id))!.state, await attempts(assign, closed.id)], ["task_closed", "settled", 0]);
  });

  suite("a decision that no attempt was made cannot contradict an attempt another caller created for the same message", async ({ projects, assign, world, epoch }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const x = await assign.admitAttempt({ commandId: cid("x"), actor: me, taskId, expectedRevision: 1, generation: 1, owner: ann });
    const healthy = InboxService.withEpoch(world.storage, epoch, assign, fast);
    const m = await healthy.receive(await incoming(world, taskId, 1));
    let interfered = false;
    // Caller A has decided "already_active" (X is active). Just before its decision is recorded, X finishes and caller B creates the attempt for this message.
    const racing = new Proxy(world.storage, {
      get(target, name, receiver) {
        const value = Reflect.get(target, name, receiver) as unknown;
        if (typeof value !== "function") return value;
        if (name === "applyOperation") {
          return async (input: Parameters<typeof target.applyOperation>[0]) => {
            if (!interfered && input.operationId === `cmd:mark:${m.id}`) {
              interfered = true;
              await assign.finishAttempt({ commandId: cid("fin"), actor: "ann", taskId, expectedRevision: 2, fence: { generation: 1, attemptId: x.id }, outcome: "succeeded" });
              // Caller B gets as far as creating the attempt for this message (its own mark has not been recorded yet).
              await assign.admitAttempt({ commandId: `adm:${m.id}`, actor: "inbox", taskId, expectedRevision: 3, generation: 1, owner: ann });
            }
            return target.applyOperation(input);
          };
        }
        return value.bind(target);
      },
    });
    const a = InboxService.withEpoch(racing, epoch, assign, fast);
    const result = await a.admitAssignment({ commandId: cid("a-adm"), actor: "worker-a", messageId: m.id });
    assert.equal(interfered, true);
    assert.equal(result.outcome, "admitted", "A learns that an attempt was made for this message");
    const message = (await healthy.getMessage(m.id))!;
    assert.deepEqual([message.state, message.admission?.outcome, message.admission?.attemptId], ["admitted", "admitted", result.attemptId]);
    assert.notEqual(result.attemptId, x.id);
    assert.equal(await attempts(assign, taskId), 2, "X and the one attempt for the message");
    await healthy.settle({ commandId: cid("settle"), actor: "w", messageId: m.id, expectedRevision: message.revision, outcome: "completed" });
  });

  suite("settlement records how an admitted message ended, once", async ({ projects, assign, inbox, world }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const m = await inbox.receive(await incoming(world, taskId, 1));
    await refuses("invalid_command", () => inbox.settle({ commandId: cid("early"), actor: "w", messageId: m.id, expectedRevision: 1, outcome: "completed" }), (e) => assert.match(e.message, /only an admitted message/));
    await inbox.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: m.id });
    const admitted = (await inbox.getMessage(m.id))!;
    await refuses("stale_revision", () => inbox.settle({ commandId: cid("stale"), actor: "w", messageId: m.id, expectedRevision: 1, outcome: "completed" }));
    const settle = { commandId: "settle-once", actor: "w", messageId: m.id, expectedRevision: admitted.revision, outcome: "failed" as const, detail: "out of seeds" };
    const first = await inbox.settle(settle);
    assert.deepEqual(await inbox.settle(settle), { ...first, replayed: true });
    const settled = (await inbox.getMessage(m.id))!;
    assert.deepEqual([settled.state, settled.settlement], ["settled", { outcome: "failed", detail: "out of seeds" }]);
    await refuses("invalid_command", () => inbox.settle({ ...settle, commandId: cid("again"), expectedRevision: settled.revision }), (e) => assert.match(e.message, /is settled/));
    await refuses("command_conflict", () => inbox.settle({ ...settle, outcome: "completed" }));
  });

  suite("a deposed controller cannot receive or admit", async ({ projects, assign, inbox, world }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const m = await inbox.receive(await incoming(world, taskId, 1));
    await world.storage.acquireEpoch({ holder: "c2", at: T });
    await refuses("stale_epoch", () => inbox.receive({ source: SOURCE, deliveryId: "late", payload: {} }));
    await refuses("stale_epoch", () => inbox.admitAssignment({ commandId: cid("adm"), actor: "worker", messageId: m.id }));
    assert.equal(await attempts(assign, taskId), 0);
    const event = (await inbox.getMessage(m.id))!.payload as unknown as AssignmentEvent;
    assert.equal(event.change, "assigned");
  });
}
