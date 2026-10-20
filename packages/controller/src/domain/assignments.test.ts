import assert from "node:assert/strict";
import { after, test } from "node:test";
import { FaultInjectingStorage } from "../storage/faults.js";
import {
  ASSIGNMENT_EVENTS, AssignmentService, DeliveryDispatcher, assignmentIdOf, DomainError, assignmentEventId, derivedId, type AssignmentEvent, type DomainErrorCode, type Fence, type Owner,
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

const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => {
    assert.ok(error instanceof DomainError, `expected a DomainError, got ${String(error)}`);
    assert.equal(error.code, code, error.message);
    check?.(error);
    return true;
  });
};

for (const backend of backends) {
  const suite = (name: string, body: (ctx: { projects: ProjectService; assign: AssignmentService; world: World; epoch: number }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...fast });
        await body({ projects, assign: AssignmentService.withEpoch(world.storage, projects.epoch, projects, fast), world, epoch: projects.epoch });
      } finally { await world.close(); }
    });
  /** A ready task. */
  const readyTask = async (projects: ProjectService, title = "Buy seeds"): Promise<string> => {
    const p = await projects.createProject({ commandId: cid("p"), actor: me, name: "Garden" });
    const t = await projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title });
    await projects.transitionTask({ commandId: cid("ready"), actor: me, taskId: t.id, expectedRevision: 1, to: "ready" });
    return t.id;
  };
  const admit = async (assign: AssignmentService, taskId: string, owner: Owner = ann): Promise<{ fence: Fence; assignmentRevision: number }> => {
    const a = (await assign.getAssignment(taskId))!;
    const r = await assign.admitAttempt({ commandId: cid("admit"), actor: me, taskId, expectedRevision: a.revision, generation: a.generation, owner });
    return { fence: { generation: a.generation, attemptId: r.id }, assignmentRevision: a.revision + 1 };
  };

  suite("the first assignment starts generation 1 with a history record and an event; assigning again needs the revision and a released task", async ({ projects, assign, world }) => {
    const taskId = await readyTask(projects);
    const r = await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann, reason: "first" });
    assert.deepEqual([r.revision, r.replayed], [1, false]);
    const a = (await assign.getAssignment(taskId))!;
    assert.deepEqual([a.generation, a.state, a.owner, a.attempts, "activeAttemptId" in a], [1, "assigned", ann, 0, false]);
    const history = await assign.history(taskId);
    assert.deepEqual(history.map((h) => [h.generation, h.owner, h.cause, h.assignedBy, h.reason]), [[1, ann, "assigned", me, "first"]]);
    assert.equal((await world.storage.getDelivery(assignmentEventId(taskId, 1)))?.destination, ASSIGNMENT_EVENTS);
    await refuses("stale_revision", () => assign.assignTask({ commandId: cid("again"), actor: me, taskId, owner: bob }), (e) => assert.equal(e.currentRevision, 1));
    await refuses("invalid_command", () => assign.assignTask({ commandId: cid("again2"), actor: me, taskId, expectedRevision: 1, owner: bob }), (e) => assert.match(e.message, /transfer it or release/));
    await refuses("not_found", () => assign.assignTask({ commandId: cid("ghost"), actor: me, taskId: derivedId("task", "nobody"), owner: ann }));
  });

  suite("two competing first assignments yield one owner and one history record", async ({ projects, assign }) => {
    for (let i = 0; i < 6; i++) {
      const taskId = await readyTask(projects, `race ${i}`);
      const results = await Promise.allSettled([
        assign.assignTask({ commandId: cid("ra"), actor: me, taskId, owner: ann }),
        assign.assignTask({ commandId: cid("rb"), actor: me, taskId, owner: bob }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one assignment wins");
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.ok(lost.reason instanceof DomainError && lost.reason.code === "stale_revision", String(lost.reason));
      assert.equal((await assign.history(taskId)).length, 1);
      const winner = (await assign.getAssignment(taskId))!.owner;
      assert.ok(winner !== undefined && (winner.id === "ann" || winner.id === "bob"));
    }
  });

  suite("a repeated command applies once, and a reused command ID for another command is refused", async ({ projects, assign, world }) => {
    const taskId = await readyTask(projects);
    const command = { commandId: "assign-once", actor: me, taskId, owner: ann };
    const first = await assign.assignTask(command);
    assert.deepEqual(await assign.assignTask(command), { ...first, replayed: true });
    assert.equal((await world.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((r) => r.type === "task.assign").length, 1);
    await refuses("command_conflict", () => assign.assignTask({ ...command, owner: bob }));
    await refuses("invalid_command", () => assign.assignTask({ ...command, commandId: cid("x"), owner: { kind: "Agent!", id: "x" } }));
    await refuses("invalid_command", () => assign.assignTask({ ...command, commandId: cid("y"), colour: "red" } as never));
  });

  suite("only the current owner of the current generation can be admitted, and only one attempt is active", async ({ projects, assign }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const a = (await assign.getAssignment(taskId))!;
    await refuses("fenced", () => assign.admitAttempt({ commandId: cid("wrong-owner"), actor: me, taskId, expectedRevision: a.revision, generation: 1, owner: bob }));
    await refuses("fenced", () => assign.admitAttempt({ commandId: cid("wrong-gen"), actor: me, taskId, expectedRevision: a.revision, generation: 2, owner: ann }));
    const { fence, assignmentRevision } = await admit(assign, taskId);
    const attempt = (await assign.getAttempt(fence.attemptId))!;
    assert.deepEqual([attempt.state, attempt.number, attempt.generation, attempt.owner], ["active", 1, 1, ann]);
    const after = (await assign.getAssignment(taskId))!;
    assert.deepEqual([after.activeAttemptId, after.attempts, after.revision], [fence.attemptId, 1, assignmentRevision]);
    await refuses("invalid_command", () => assign.admitAttempt({ commandId: cid("second"), actor: me, taskId, expectedRevision: after.revision, generation: 1, owner: ann }), (e) => assert.match(e.message, /already has an active attempt/));
    await refuses("stale_revision", () => assign.admitAttempt({ commandId: cid("old-rev"), actor: me, taskId, expectedRevision: a.revision, generation: 1, owner: ann }));
  });

  suite("a task that is not ready or in progress, or is final, cannot be worked on or assigned", async ({ projects, assign }) => {
    const p = await projects.createProject({ commandId: cid("p"), actor: me, name: "G" });
    const t = await projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "x" });
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId: t.id, owner: ann });
    const a = (await assign.getAssignment(t.id))!;
    await refuses("invalid_command", () => assign.admitAttempt({ commandId: cid("proposed"), actor: me, taskId: t.id, expectedRevision: a.revision, generation: 1, owner: ann }), (e) => assert.match(e.message, /proposed/));
    await projects.transitionTask({ commandId: cid("c"), actor: me, taskId: t.id, expectedRevision: 1, to: "cancelled" });
    await refuses("invalid_command", () => assign.transferTask({ commandId: cid("tr"), actor: me, taskId: t.id, expectedRevision: a.revision, to: bob }), (e) => assert.match(e.message, /cancelled/));
  });

  suite("two competing admissions yield one valid writer", async ({ projects, assign }) => {
    for (let i = 0; i < 6; i++) {
      const taskId = await readyTask(projects, `admit race ${i}`);
      await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
      const a = (await assign.getAssignment(taskId))!;
      const go = (label: string) => assign.admitAttempt({ commandId: cid(label), actor: me, taskId, expectedRevision: a.revision, generation: 1, owner: ann });
      const results = await Promise.allSettled([go("x"), go("y")]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "exactly one admission wins");
      const lost = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
      assert.ok(lost.reason instanceof DomainError && lost.reason.code === "stale_revision", String(lost.reason));
      const after = (await assign.getAssignment(taskId))!;
      assert.equal(after.attempts, 1);
      const winner = (results.find((r) => r.status === "fulfilled") as PromiseFulfilledResult<{ id: string }>).value.id;
      assert.equal(after.activeAttemptId, winner);
      assert.equal((await assign.getAttempt(winner))!.state, "active");
    }
  });

  suite("after a transfer the old generation cannot mutate the task; the new one can; the old attempt is superseded", async ({ projects, assign }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const { fence: oldFence, assignmentRevision } = await admit(assign, taskId);
    const moved = await assign.transferTask({ commandId: cid("tr"), actor: me, taskId, expectedRevision: assignmentRevision, to: bob, reason: "ann is offline" });
    const a = (await assign.getAssignment(taskId))!;
    assert.deepEqual([moved.revision, a.generation, a.owner, "activeAttemptId" in a], [assignmentRevision + 1, 2, bob, false]);
    assert.equal((await assign.getAttempt(oldFence.attemptId))!.state, "superseded");
    const before = (await projects.getTask(taskId))!;
    await refuses("fenced", () => assign.transitionTask({ commandId: cid("old"), actor: "ann", taskId, expectedRevision: before.revision, to: "in_progress", fence: oldFence }));
    await refuses("fenced", () => assign.updateTask({ commandId: cid("old-edit"), actor: "ann", taskId, expectedRevision: before.revision, title: "hijacked", fence: oldFence }));
    assert.deepEqual([(await projects.getTask(taskId))!.revision, (await projects.getTask(taskId))!.title], [before.revision, "Buy seeds"], "the old generation changed nothing");
    const { fence: newFence } = await admit(assign, taskId, bob);
    const ok = await assign.transitionTask({ commandId: cid("new"), actor: "bob", taskId, expectedRevision: before.revision, to: "in_progress", fence: newFence });
    assert.equal(ok.revision, before.revision + 1);
    assert.equal((await projects.getTask(taskId))!.state, "in_progress");
    assert.deepEqual((await assign.history(taskId)).map((h) => [h.generation, h.owner.id, h.cause, h.previousOwner?.id, h.reason]), [[1, "ann", "assigned", undefined, undefined], [2, "bob", "transferred", "ann", "ann is offline"]]);
  });

  suite("a fenced write racing a transfer commits before it or is refused, never after", async ({ projects, assign, world }) => {
    for (let i = 0; i < 8; i++) {
      const taskId = await readyTask(projects, `fence race ${i}`);
      await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
      const { fence, assignmentRevision } = await admit(assign, taskId);
      const task = (await projects.getTask(taskId))!;
      const [write, transfer] = await Promise.allSettled([
        assign.transitionTask({ commandId: cid("w"), actor: "ann", taskId, expectedRevision: task.revision, to: "in_progress", fence }),
        assign.transferTask({ commandId: cid("t"), actor: me, taskId, expectedRevision: assignmentRevision, to: bob }),
      ]);
      assert.equal(transfer.status, "fulfilled", "the transfer is never blocked by the old owner's write");
      const audit = await world.storage.listAudit({ afterSeq: 0, limit: 1000 });
      const transferSeq = audit.find((r) => r.type === "task.transfer" && r.subject?.id === assignmentIdOf(taskId))!.seq;
      const writeSeq = audit.find((r) => r.type === "task.transition" && r.subject?.id === taskId && r.detail["to"] === "in_progress")?.seq;
      if (write.status === "fulfilled") {
        assert.ok(writeSeq !== undefined && writeSeq < transferSeq, "an accepted fenced write was committed before the transfer");
        assert.equal((await projects.getTask(taskId))!.state, "in_progress");
      } else {
        assert.ok(write.reason instanceof DomainError && write.reason.code === "fenced", String(write.reason));
        assert.equal((await projects.getTask(taskId))!.state, "ready", "a refused write changed nothing");
      }
    }
  });

  suite("a release ends the attempt and the fence, and the next assignment is a new generation", async ({ projects, assign }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const { fence, assignmentRevision } = await admit(assign, taskId);
    await assign.releaseTask({ commandId: cid("r"), actor: me, taskId, expectedRevision: assignmentRevision, reason: "paused" });
    const released = (await assign.getAssignment(taskId))!;
    assert.deepEqual([released.state, released.generation, "owner" in released, "activeAttemptId" in released], ["released", 1, false, false]);
    assert.equal((await assign.getAttempt(fence.attemptId))!.state, "released");
    const t = (await projects.getTask(taskId))!;
    await refuses("fenced", () => assign.transitionTask({ commandId: cid("w"), actor: "ann", taskId, expectedRevision: t.revision, to: "in_progress", fence }));
    await refuses("invalid_command", () => assign.releaseTask({ commandId: cid("r2"), actor: me, taskId, expectedRevision: released.revision }), (e) => assert.match(e.message, /already released/));
    await assign.assignTask({ commandId: cid("again"), actor: me, taskId, expectedRevision: released.revision, owner: bob });
    const again = (await assign.getAssignment(taskId))!;
    assert.deepEqual([again.generation, again.owner, again.attempts], [2, bob, 1]);
    assert.deepEqual((await assign.history(taskId)).map((h) => h.cause), ["assigned", "reassigned"]);
  });

  suite("finishing an attempt needs the current fence, frees the writer slot, and the next attempt is number 2", async ({ projects, assign }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const { fence, assignmentRevision } = await admit(assign, taskId);
    await refuses("fenced", () => assign.finishAttempt({ commandId: cid("bad"), actor: "ann", taskId, expectedRevision: assignmentRevision, fence: { generation: 1, attemptId: derivedId("att", "other") }, outcome: "succeeded" }));
    await assign.finishAttempt({ commandId: cid("fin"), actor: "ann", taskId, expectedRevision: assignmentRevision, fence, outcome: "failed", summary: "out of seeds" });
    const attempt = (await assign.getAttempt(fence.attemptId))!;
    assert.deepEqual([attempt.state, attempt.summary], ["failed", "out of seeds"]);
    const a = (await assign.getAssignment(taskId))!;
    assert.equal("activeAttemptId" in a, false);
    const second = await admit(assign, taskId);
    assert.equal((await assign.getAttempt(second.fence.attemptId))!.number, 2);
    await refuses("fenced", async () => assign.finishAttempt({ commandId: cid("late"), actor: "ann", taskId, expectedRevision: (await assign.getAssignment(taskId))!.revision, fence, outcome: "succeeded" }));
  });

  suite("observed activity is recorded separately: a worker that lost its generation is seen but owns nothing", async ({ projects, assign }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const { assignmentRevision } = await admit(assign, taskId);
    const seen = await assign.observeActivity({ commandId: cid("o1"), actor: "controller", taskId, observedBy: "ann", generation: 1, kind: "heartbeat", detail: "editing" });
    assert.equal(seen.revision, 1);
    assert.deepEqual([(await assign.getActivity(taskId))!.current, (await assign.getActivity(taskId))!.observedBy], [true, "ann"]);
    await assign.transferTask({ commandId: cid("tr"), actor: me, taskId, expectedRevision: assignmentRevision, to: bob });
    const afterTransfer = (await assign.getAssignment(taskId))!;
    await assign.observeActivity({ commandId: cid("o2"), actor: "controller", taskId, observedBy: "ann", generation: 1, kind: "tool_call" });
    const activity = (await assign.getActivity(taskId))!;
    assert.deepEqual([activity.observedBy, activity.generation, activity.current, activity.observations, activity.revision], ["ann", 1, false, 2, 2]);
    const unchanged = (await assign.getAssignment(taskId))!;
    assert.deepEqual([unchanged.revision, unchanged.owner, unchanged.generation], [afterTransfer.revision, bob, 2], "seeing the old worker changed no ownership");
    const replay = await assign.observeActivity({ commandId: "o2-fixed", actor: "controller", taskId, observedBy: "bob", generation: 2, kind: "heartbeat" });
    assert.equal((await assign.observeActivity({ commandId: "o2-fixed", actor: "controller", taskId, observedBy: "bob", generation: 2, kind: "heartbeat" })).replayed, true);
    assert.equal(replay.replayed, false);
    assert.equal((await assign.getActivity(taskId))!.current, true);
    const other = await readyTask(projects, "never assigned");
    await assign.observeActivity({ commandId: cid("o3"), actor: "controller", taskId: other, observedBy: "zed", generation: 1, kind: "heartbeat" });
    assert.equal((await assign.getActivity(other))!.current, false, "a task with no assignment has no current generation");
  });

  suite("concurrent first observations of a task end with one record and a clear refusal for the loser", async ({ projects, assign }) => {
    const taskId = await readyTask(projects);
    const results = await Promise.allSettled([
      assign.observeActivity({ commandId: cid("c1"), actor: "controller", taskId, observedBy: "ann", generation: 1, kind: "heartbeat" }),
      assign.observeActivity({ commandId: cid("c2"), actor: "controller", taskId, observedBy: "bob", generation: 1, kind: "heartbeat" }),
    ]);
    for (const r of results) if (r.status === "rejected") assert.ok(r.reason instanceof DomainError && r.reason.code === "stale_revision", String(r.reason));
    assert.ok(results.some((r) => r.status === "fulfilled"));
    assert.ok((await assign.getActivity(taskId)) !== undefined);
  });

  suite("assignment events are delivered in order as snapshots", async ({ projects, assign, world, epoch }) => {
    const taskId = await readyTask(projects);
    await assign.assignTask({ commandId: cid("a"), actor: me, taskId, owner: ann });
    const { fence, assignmentRevision } = await admit(assign, taskId);
    await assign.finishAttempt({ commandId: cid("f"), actor: "ann", taskId, expectedRevision: assignmentRevision, fence, outcome: "succeeded" });
    const seen: AssignmentEvent[] = [];
    const d = new DeliveryDispatcher(world.storage, epoch, { destination: ASSIGNMENT_EVENTS, claimant: "d", handler: async (m) => { seen.push(m.payload as unknown as AssignmentEvent); }, clock: () => T, pause: async () => undefined });
    for (let i = 0; i < 3; i++) assert.equal((await d.runOnce()).delivered, 1);
    assert.deepEqual(seen.map((e) => [e.revision, e.change, e.generation, e.activeAttemptId !== undefined]), [[1, "assigned", 1, false], [2, "attempt_admitted", 1, true], [3, "attempt_finished", 1, false]]);
  });

  suite("a deposed controller cannot assign or admit, and a failed commit leaves no assignment", async ({ projects, assign, world, epoch }) => {
    const taskId = await readyTask(projects);
    const faulty = new FaultInjectingStorage(world.storage, [{ when: "before", kind: "unavailable" }]);
    const flaky = AssignmentService.withEpoch(faulty, epoch, projects, fast);
    await refuses("unavailable", () => flaky.assignTask({ commandId: "flaky", actor: me, taskId, owner: ann }));
    assert.equal(await assign.getAssignment(taskId), undefined);
    assert.equal((await flaky.assignTask({ commandId: "flaky", actor: me, taskId, owner: ann })).revision, 1);
    const other = await readyTask(projects, "second");
    await world.storage.acquireEpoch({ holder: "c2", at: T });
    await refuses("stale_epoch", () => assign.transferTask({ commandId: cid("tr"), actor: me, taskId, expectedRevision: 1, to: bob }));
    await refuses("stale_epoch", () => assign.assignTask({ commandId: cid("new"), actor: me, taskId: other, owner: ann }));
    assert.equal(await assign.getAssignment(other), undefined);
  });
}
