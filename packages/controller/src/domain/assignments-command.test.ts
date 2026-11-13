import assert from "node:assert/strict";
import { after, test } from "node:test";
import { deferredCommandState } from "../api/command-state.js";
import { ASSIGNMENT_EVENTS, AssignmentService, DeliveryDispatcher, type Fence, type Owner } from "./index.js";
import { ProjectService } from "./service.js";
import { backends, stopServer } from "./testing/backends.js";

after(stopServer);

const T = "2026-10-20T10:00:00.000Z";
const fast = { clock: () => T, pause: async () => undefined };
const me = "rob";
const ann: Owner = { kind: "agent", id: "ann" };
const bob: Owner = { kind: "agent", id: "bob" };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

/** The state a client would be told, read the way the API reads it. */
const stateOf = async (assign: AssignmentService, commandId: string): Promise<string> => {
  const record = (await assign.deferredCommand(commandId))!;
  return deferredCommandState({ assignment: record.assignment, generation: record.generation, attempt: record.attempt, taskState: record.taskState, deliveryState: record.deliveryState, ...(record.attemptsPartial === true ? { attemptsPartial: true } : {}) }).state;
};

test("the word table for deferred commands (card U13 finish)", () => {
  const base = { assignment: { generation: 1, state: "assigned" as const }, generation: 1, attempt: undefined, taskState: "ready", deliveryState: undefined };
  const state = (over: object) => deferredCommandState({ ...base, ...over }).state;
  assert.equal(state({}), "accepted");
  assert.equal(state({ deliveryState: "pending" }), "accepted");
  assert.equal(state({ deliveryState: "claimed" }), "accepted");
  assert.equal(state({ deliveryState: "delivered" }), "queued");
  assert.equal(state({ taskState: "blocked", deliveryState: "delivered" }), "blocked");
  assert.equal(state({ taskState: "done" }), "failed");
  assert.equal(state({ assignment: { generation: 2, state: "assigned" } }), "failed");
  assert.equal(state({ assignment: { generation: 1, state: "released" } }), "failed");
  assert.equal(state({ attempt: { state: "active" } }), "running");
  assert.equal(state({ attempt: { state: "succeeded" } }), "completed");
  assert.equal(state({ attempt: { state: "failed" } }), "failed");
  for (const s of ["abandoned", "superseded", "released"] as const) assert.equal(state({ attempt: { state: s } }), "outcome_unknown", s);
  assert.equal(state({ attemptsPartial: true }), "outcome_unknown");
  assert.equal(state({ assignment: undefined }), "outcome_unknown");
});

for (const backend of backends) {
  const suite = (name: string, body: (ctx: { projects: ProjectService; assign: AssignmentService; world: Awaited<ReturnType<typeof backend.open>>; epoch: number }) => Promise<void>) =>
    test(`${backend.name}: ${name}`, async () => {
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...fast });
        await body({ projects, assign: AssignmentService.withEpoch(world.storage, projects.epoch, projects, fast), world, epoch: projects.epoch });
      } finally { await world.close(); }
    });
  const readyTask = async (projects: ProjectService): Promise<string> => {
    const p = await projects.createProject({ commandId: cid("p"), actor: me, name: "Garden" });
    const t = await projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "Buy seeds" });
    await projects.transitionTask({ commandId: cid("ready"), actor: me, taskId: t.id, expectedRevision: 1, to: "ready" });
    return t.id;
  };
  const admit = async (assign: AssignmentService, taskId: string, owner: Owner): Promise<{ fence: Fence; rev: number }> => {
    const a = (await assign.getAssignment(taskId))!;
    const r = await assign.admitAttempt({ commandId: cid("admit"), actor: me, taskId, expectedRevision: a.revision, generation: a.generation, owner });
    return { fence: { generation: a.generation, attemptId: r.id }, rev: a.revision + 1 };
  };

  suite("task.assign follows accepted, queued, running and completed from the stored records (card U13 finish)", async ({ projects, assign, world, epoch }) => {
    const taskId = await readyTask(projects);
    const id = cid("assign");
    await assign.assignTask({ commandId: id, actor: me, taskId, owner: ann });
    assert.equal(await stateOf(assign, id), "accepted", "recorded, the worker not yet told");
    const d = new DeliveryDispatcher(world.storage, epoch, { destination: ASSIGNMENT_EVENTS, claimant: "d", handler: async () => undefined, clock: () => T, pause: async () => undefined });
    assert.equal((await d.runOnce()).delivered, 1);
    assert.equal(await stateOf(assign, id), "queued", "the worker's inbox holds the message");
    const { fence, rev } = await admit(assign, taskId, ann);
    assert.equal(await stateOf(assign, id), "running");
    // A replay of the command changes nothing and reads the same.
    assert.equal((await assign.assignTask({ commandId: id, actor: me, taskId, owner: ann })).replayed, true);
    assert.equal(await stateOf(assign, id), "running");
    await assign.finishAttempt({ commandId: cid("fin"), actor: "ann", taskId, expectedRevision: rev, fence, outcome: "succeeded" });
    assert.equal(await stateOf(assign, id), "completed");
    const record = (await assign.deferredCommand(id))!;
    assert.deepEqual([record.type, record.taskId, record.generation, record.revision, record.attempt?.number, record.attempt?.state], ["task.assign", taskId, 1, 1, 1, "succeeded"]);
    assert.equal(await assign.deferredCommand("no-such-command"), undefined);
  });

  suite("a failed or abandoned attempt, a task that blocks, and a command that is not deferred (card U13 finish)", async ({ projects, assign }) => {
    const taskId = await readyTask(projects);
    const id = cid("assign");
    await assign.assignTask({ commandId: id, actor: me, taskId, owner: ann });
    const first = await admit(assign, taskId, ann);
    await assign.finishAttempt({ commandId: cid("fin"), actor: "ann", taskId, expectedRevision: first.rev, fence: first.fence, outcome: "failed" });
    assert.equal(await stateOf(assign, id), "failed");
    const second = await admit(assign, taskId, ann);
    assert.equal(await stateOf(assign, id), "running", "the latest attempt of the generation counts");
    await assign.finishAttempt({ commandId: cid("fin"), actor: "ann", taskId, expectedRevision: second.rev, fence: second.fence, outcome: "abandoned" });
    assert.equal(await stateOf(assign, id), "outcome_unknown");
    // A transition is a recorded command, but not a deferred one: it is not read here.
    const t = cid("tr");
    await projects.transitionTask({ commandId: t, actor: me, taskId, expectedRevision: (await projects.getTask(taskId))!.revision, to: "blocked" });
    assert.equal(await assign.deferredCommand(t), undefined);
    const other = await readyTask(projects);
    const blockedId = cid("assign");
    await assign.assignTask({ commandId: blockedId, actor: me, taskId: other, owner: ann });
    await projects.transitionTask({ commandId: cid("blk"), actor: me, taskId: other, expectedRevision: (await projects.getTask(other))!.revision, to: "blocked" });
    assert.equal(await stateOf(assign, blockedId), "blocked");
  });

  suite("task.transfer: the old generation's command reads failed or unknown, the new one follows its own attempt (card U13 finish)", async ({ projects, assign }) => {
    const taskId = await readyTask(projects);
    const a1 = cid("assign");
    await assign.assignTask({ commandId: a1, actor: me, taskId, owner: ann });
    // Replaced before any attempt began: it never took effect.
    const t1 = cid("transfer");
    await assign.transferTask({ commandId: t1, actor: me, taskId, expectedRevision: 1, to: bob });
    assert.equal(await stateOf(assign, a1), "failed");
    assert.equal(await stateOf(assign, t1), "accepted");
    assert.equal((await assign.deferredCommand(t1))!.type, "task.transfer");
    const bobs = await admit(assign, taskId, bob);
    assert.equal(await stateOf(assign, t1), "running");
    // Moved on while bob's attempt was active: his work may or may not have been completed.
    const t2 = cid("transfer");
    await assign.transferTask({ commandId: t2, actor: me, taskId, expectedRevision: bobs.rev, to: ann });
    assert.equal(await stateOf(assign, t1), "outcome_unknown");
    assert.equal(await stateOf(assign, t2), "accepted");
    // A release before an attempt began.
    await assign.releaseTask({ commandId: cid("rel"), actor: me, taskId, expectedRevision: (await assign.getAssignment(taskId))!.revision });
    assert.equal(await stateOf(assign, t2), "failed");
  });
}
