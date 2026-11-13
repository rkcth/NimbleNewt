import assert from "node:assert/strict";
import { after, test } from "node:test";
import { deferredCommandState } from "../api/command-state.js";
import { ASSIGNMENT_EVENTS, AssignmentService, DeliveryDispatcher, type Fence, type Owner } from "./index.js";
import { derivedId } from "./ids.js";
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
  suite("completed means the attempt succeeded, not that the task finished; a release after success, a transfer to the same owner and a proposed task (card U13 finish review)", async ({ projects, assign }) => {
    // The attempt failed, then the task was moved to done by hand: the command still reads failed.
    const taskId = await readyTask(projects);
    const id = cid("assign");
    await assign.assignTask({ commandId: id, actor: me, taskId, owner: ann });
    const a = await admit(assign, taskId, ann);
    await assign.finishAttempt({ commandId: cid("fin"), actor: "ann", taskId, expectedRevision: a.rev, fence: a.fence, outcome: "failed" });
    await projects.transitionTask({ commandId: cid("ip"), actor: me, taskId, expectedRevision: (await projects.getTask(taskId))!.revision, to: "in_progress" });
    await projects.transitionTask({ commandId: cid("dn"), actor: me, taskId, expectedRevision: (await projects.getTask(taskId))!.revision, to: "done" });
    assert.equal(await stateOf(assign, id), "failed", "a finished task does not make a failed attempt completed");
    // Succeeded, then released: still completed (the attempt is found among the records of its generation).
    const t2 = await readyTask(projects);
    const id2 = cid("assign");
    await assign.assignTask({ commandId: id2, actor: me, taskId: t2, owner: ann });
    const b = await admit(assign, t2, ann);
    await assign.finishAttempt({ commandId: cid("fin"), actor: "ann", taskId: t2, expectedRevision: b.rev, fence: b.fence, outcome: "succeeded" });
    await assign.releaseTask({ commandId: cid("rel"), actor: me, taskId: t2, expectedRevision: b.rev + 1 });
    assert.equal(await stateOf(assign, id2), "completed");
    // Transferred to the same owner while an attempt was active: the old command is unknown, the new one starts again.
    const t3 = await readyTask(projects);
    const id3 = cid("assign");
    await assign.assignTask({ commandId: id3, actor: me, taskId: t3, owner: ann });
    const c3 = await admit(assign, t3, ann);
    const same = cid("transfer");
    await assign.transferTask({ commandId: same, actor: me, taskId: t3, expectedRevision: c3.rev, to: ann });
    assert.deepEqual([await stateOf(assign, id3), await stateOf(assign, same)], ["outcome_unknown", "accepted"]);
    // A proposed task (never made ready) can take no attempt yet: accepted, not running or completed.
    const p = await projects.createProject({ commandId: cid("p"), actor: me, name: "Shed" });
    const t4 = (await projects.createTask({ commandId: cid("t"), actor: me, projectId: p.id, title: "Paint" })).id;
    const id4 = cid("assign");
    await assign.assignTask({ commandId: id4, actor: me, taskId: t4, owner: ann });
    assert.equal(await stateOf(assign, id4), "accepted");
  });

  suite("the attempt scan: rights are checked before it, a scan cut short says partial, and an earlier attempt never stands in for a later one (card U13 finish review)", async ({ projects, world, epoch }) => {
    let lists = 0;
    const counted = new Proxy(world.storage, { get(target, key) { const v = Reflect.get(target, key, target); if (key === "listAggregates") return (...args: unknown[]) => { lists += 1; return (v as (...a: unknown[]) => unknown).apply(target, args); }; return typeof v === "function" ? v.bind(target) : v; } });
    const small = AssignmentService.withEpoch(counted, epoch, projects, { ...fast, attemptScan: 1 });
    const full = AssignmentService.withEpoch(world.storage, epoch, projects, fast);
    const taskId = await readyTask(projects);
    // Choose admission command IDs so that attempt 1's ID sorts first: a scan of one record then finds attempt 1 only.
    const ids: string[] = [];
    for (let i = 0; ids.length < 3; i++) { const c = `adm-${i}-${n++}`; if (ids.length === 0 || derivedId("att", c) > derivedId("att", ids[ids.length - 1]!)) ids.push(c); }
    const id = cid("assign");
    await full.assignTask({ commandId: id, actor: me, taskId, owner: ann });
    const step = async (commandId: string, owner: Owner, outcome?: "succeeded" | "failed"): Promise<void> => {
      const a = (await full.getAssignment(taskId))!;
      const r = await full.admitAttempt({ commandId, actor: me, taskId, expectedRevision: a.revision, generation: a.generation, owner });
      assert.equal(r.id, derivedId("att", commandId));
      if (outcome !== undefined) await full.finishAttempt({ commandId: cid("fin"), actor: owner.id, taskId, expectedRevision: a.revision + 1, fence: { generation: a.generation, attemptId: r.id }, outcome });
    };
    await step(ids[0]!, ann, "succeeded");
    await step(ids[1]!, ann, "failed");
    const t = cid("transfer");
    await full.transferTask({ commandId: t, actor: me, taskId, expectedRevision: (await full.getAssignment(taskId))!.revision, to: bob });
    await step(ids[2]!, bob);
    assert.equal(await stateOf(full, id), "failed", "read in full: the generation's latest attempt failed");
    const cut = (await small.deferredCommand(id))!;
    assert.equal(cut.attempt?.number, 1, "the cut scan found only attempt 1");
    assert.equal(cut.attemptsPartial, true);
    assert.equal(await stateOf(small, id), "outcome_unknown", "attempt 1 succeeded, but it is not the generation's latest: never completed");
    // Refused before the scan: a caller without the right costs no attempt read.
    lists = 0;
    await assert.rejects(() => small.deferredCommand(id, async () => { throw new Error("refused"); }), /refused/);
    assert.equal(lists, 0);
    // A command whose generation has no attempt in the part read is unknown too, never failed or accepted on a guess.
    const step2 = async (task: string): Promise<void> => { const a = (await full.getAssignment(task))!; await full.admitAttempt({ commandId: cid("adm"), actor: me, taskId: task, expectedRevision: a.revision, generation: a.generation, owner: bob }); };
    const other = await readyTask(projects);
    const quiet = cid("assign");
    await full.assignTask({ commandId: quiet, actor: me, taskId: other, owner: ann });
    const q = (await full.getAssignment(other))!;
    await full.transferTask({ commandId: cid("transfer"), actor: me, taskId: other, expectedRevision: q.revision, to: bob });
    lists = 0;
    assert.deepEqual([await stateOf(full, quiet), await stateOf(small, quiet), lists], ["failed", "failed", 0], "the task never had an attempt: nothing to scan");
    await step2(other);
    assert.equal(await stateOf(small, quiet), "outcome_unknown", "now it has one (of another generation) and the cut scan cannot rule one out");
    assert.equal(await stateOf(full, quiet), "failed");
    // The current generation's active attempt is read directly, not by the scan.
    lists = 0;
    assert.equal(await stateOf(small, t), "running");
    assert.equal(lists, 0);
    assert.throws(() => AssignmentService.withEpoch(world.storage, epoch, projects, { attemptScan: 0 }), /attemptScan/);
  });
}
