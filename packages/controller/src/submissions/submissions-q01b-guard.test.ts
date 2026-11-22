import assert from "node:assert/strict";
import { after, test } from "node:test";
import { AssignmentService } from "../domain/assignments.js";
import { assignmentIdOf } from "../domain/assignment-model.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PrincipalService } from "../security/index.js";
import { attemptOfAssignments, SubmissionService, type AttemptOf } from "./index.js";

after(stopServer);

// Card Q01b: the attempt a code submission is checked against is read, and the submission is written later. These tests use the real assignment service on every backend and change the
// attempt in that gap: the record must not be written under an attempt that is no longer the task's current one.
const options = { clock: () => "2026-11-22T10:00:00.000Z", pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const BASE = "c".repeat(40), T1 = "a".repeat(40), T2 = "b".repeat(40), PATCH = "d".repeat(40);

for (const backend of backends) {
  const suite = (name: string, body: (c: Awaited<ReturnType<typeof setup>>) => Promise<void>) => test(`${backend.name}: ${name}`, async () => {
    const world = await backend.open();
    try { await body(await setup(world)); } finally { await world.close(); }
  });
  const setup = async (world: Awaited<ReturnType<typeof backend.open>>) => {
    const projects = await ProjectService.open(world.storage, { holder: "c1", ...options });
    const principals = PrincipalService.withEpoch(world.storage, projects.epoch, options);
    const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
    const assign = AssignmentService.withEpoch(world.storage, projects.epoch, projects, options);
    const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "P" })).id;
    const agent = async (nm: string) => {
      await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: [{ action: "task.read", project }] });
      return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
    };
    const task = async (): Promise<string> => {
      const t = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: project, title: "T" })).id;
      await projects.transitionTask({ commandId: cid("ready"), actor: owner.id, taskId: t, expectedRevision: 1, to: "ready" });
      return t;
    };
    const admit = async (taskId: string, who: string): Promise<{ attemptId: string; generation: number }> => {
      let a = await assign.getAssignment(taskId);
      if (a === undefined || a.state !== "assigned" || a.owner?.id !== who) {
        if (a === undefined) await assign.assignTask({ commandId: cid("a"), actor: owner.id, taskId, owner: { kind: "agent", id: who } });
        else await assign.transferTask({ commandId: cid("x"), actor: owner.id, taskId, expectedRevision: a.revision, to: { kind: "agent", id: who } });
        a = (await assign.getAssignment(taskId))!;
      }
      const r = await assign.admitAttempt({ commandId: cid("admit"), actor: owner.id, taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: who } });
      return { attemptId: r.id, generation: a.generation };
    };
    // The port the controller builds (`start.ts` maps the assignment's bare agent ID to the principal's `agent:` form), with a hook that runs right after the attempt was read.
    const port = (gap: () => Promise<void>): AttemptOf => { const of = attemptOfAssignments(assign); return async (taskId) => { const a = await of(taskId); await gap(); return a === undefined ? undefined : { ...a, ownerId: `agent:${a.ownerId}` }; }; };
    const svc = (attemptOf: AttemptOf, clock = options.clock) => SubmissionService.withEpoch(world.storage, projects.epoch, async () => ["author"], { ...options, clock, attemptOf });
    return { assign, agent, task, admit, port, svc, owner, world, projects, epoch: projects.epoch };
  };
  const code = (taskId: string, tree = T1) => ({ commandId: cid("s"), taskId, kind: "code" as const, role: "author", base: BASE, tree, patchId: PATCH });
  const refused = async (run: () => Promise<unknown>, match: RegExp): Promise<void> => assert.rejects(run, (e: unknown) => { assert.ok(e instanceof DomainError, String(e)); assert.equal(e.code, "forbidden", e.message); assert.match(e.message, match); return true; });
  const recorded = async (s: SubmissionService, by: Parameters<SubmissionService["list"]>[0], taskId: string): Promise<number> => (await s.list(by, taskId, { limit: 100 })).items.length;

  suite("no gap: a code submission under the task's current attempt is recorded and names it", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    const { attemptId } = await c.admit(t, "ann");
    const s = c.svc(c.port(async () => undefined));
    const r = await s.record(ann, code(t));
    assert.equal((await s.get(ann, r.id))?.attemptId, attemptId);
  });

  suite("the attempt ends between the check and the write: nothing is recorded, and the answer says why (not a command-ID conflict)", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    const { attemptId, generation } = await c.admit(t, "ann");
    let ended = false;
    const s = c.svc(c.port(async () => {
      if (ended) return; ended = true;
      const a = (await c.assign.getAssignment(t))!;
      await c.assign.finishAttempt({ commandId: cid("f"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, fence: { generation, attemptId }, outcome: "failed" });
    }));
    await refused(() => s.record(ann, code(t)), /attempt changed while/);
    assert.equal(await recorded(s, ann, t), 0);
  });

  suite("the task moves to another agent between the check and the write: nothing is recorded under the old owner's attempt; sent again later it is refused by the ordinary owner check", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    await c.admit(t, "ann");
    let moved = false;
    const s = c.svc(c.port(async () => {
      if (moved) return; moved = true;
      const a = (await c.assign.getAssignment(t))!;
      await c.assign.transferTask({ commandId: cid("x"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, to: { kind: "agent", id: "bob" } });
    }));
    const first = code(t);
    await refused(() => s.record(ann, first), /attempt changed while/);
    assert.equal(await recorded(s, ann, t), 0);
    await refused(() => s.record(ann, first), /owns the task's current attempt/);
    assert.equal(await recorded(s, ann, t), 0);
  });

  suite("a change that leaves the attempt as it was does not refuse; a repeat after the first record answers with it (the guard is only on a new write)", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    const { attemptId, generation } = await c.admit(t, "ann");
    const s = c.svc(c.port(async () => undefined));
    const cmd = code(t);
    const first = await s.record(ann, cmd);
    const a = (await c.assign.getAssignment(t))!;
    await c.assign.finishAttempt({ commandId: cid("f"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, fence: { generation, attemptId }, outcome: "succeeded" });
    const again = await s.record(ann, cmd);
    assert.deepEqual([again.id, again.replayed], [first.id, true]);
    assert.equal(await recorded(s, ann, t), 1);
  });

  suite("a hand-made attempt port with no guards behaves as before (nothing added to the write)", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    const s = c.svc(async () => ({ ownerId: ann.id, state: "active", attemptId: "att-x" }));
    const r = await s.record(ann, code(t));
    assert.equal((await s.get(ann, r.id))?.attemptId, "att-x");
  });

  suite("after a refused write the agent's next submission, under the now-current attempt, is recorded", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    const { attemptId, generation } = await c.admit(t, "ann");
    let step = 0;
    const s = c.svc(c.port(async () => {
      if (step++ !== 0) return;
      const a = (await c.assign.getAssignment(t))!;
      await c.assign.finishAttempt({ commandId: cid("f"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, fence: { generation, attemptId }, outcome: "failed" });
    }));
    const first = code(t);
    await refused(() => s.record(ann, first), /attempt changed while/);
    const next = await c.admit(t, "ann");
    // the refused command's ID is not used up: the same command sent again is recorded under the now-current attempt
    const r = await s.record(ann, first);
    assert.equal(r.replayed, false);
    assert.equal((await s.get(ann, r.id))?.attemptId, next.attemptId);
    assert.equal(await recorded(s, ann, t), 1);
    const other = await s.record(ann, code(t, T2));
    assert.equal((await s.get(ann, other.id))?.attemptId, next.attemptId);
    assert.equal(await recorded(s, ann, t), 2);
  });

  suite("two controllers: the other controller ends the attempt between this one's check and write; nothing is recorded", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    const { attemptId, generation } = await c.admit(t, "ann");
    const otherAssign = AssignmentService.withEpoch(c.world.storage, c.epoch, c.projects, options);
    let ended = false;
    const s = c.svc(c.port(async () => {
      if (ended) return; ended = true;
      const a = (await otherAssign.getAssignment(t))!;
      await otherAssign.finishAttempt({ commandId: cid("f"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, fence: { generation, attemptId }, outcome: "abandoned" });
    }));
    await refused(() => s.record(ann, code(t)), /attempt changed while/);
    assert.equal(await recorded(s, ann, t), 0);
  });

  suite("a duplicate whose original is recorded and whose attempt then ends while the duplicate is between its check and write answers with the original record, not a refusal", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    const { attemptId, generation } = await c.admit(t, "ann");
    const cmd = code(t);
    const plain = c.svc(c.port(async () => undefined));
    let original: Awaited<ReturnType<SubmissionService["record"]>> | undefined;
    // The duplicate runs a moment later (another clock), as a resend does: its write is not byte-identical to the original's, so storage does not simply replay it.
    const late = c.svc(c.port(async () => {
      if (original !== undefined) return;
      original = await plain.record(ann, cmd);
      const a = (await c.assign.getAssignment(t))!;
      await c.assign.finishAttempt({ commandId: cid("f"), actor: c.owner.id, taskId: t, expectedRevision: a.revision, fence: { generation, attemptId }, outcome: "succeeded" });
    }), () => "2026-11-22T10:00:01.000Z");
    const dup = await late.record(ann, cmd);
    assert.ok(original !== undefined);
    assert.deepEqual([dup.id, dup.replayed], [original.id, true]);
    assert.equal(await recorded(plain, ann, t), 1);
    assert.equal((await plain.get(ann, dup.id))?.attemptId, attemptId);
  });

  suite("two controllers: the same submission sent to both at once is recorded once and both answer with it", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    await c.admit(t, "ann");
    const cmd = code(t);
    const [x, y] = await Promise.all([c.svc(c.port(async () => undefined)).record(ann, cmd), c.svc(c.port(async () => undefined)).record(ann, cmd)]);
    assert.equal(x.id, y.id);
    assert.equal(await recorded(c.svc(c.port(async () => undefined)), ann, t), 1);
  });

  suite("the assignment port names both records it read at their revisions, and each guard is checked on its own", async (c) => {
    const ann = await c.agent("ann"), t = await c.task();
    const { attemptId } = await c.admit(t, "ann");
    const read = (await attemptOfAssignments(c.assign)(t))!;
    const a = (await c.assign.getAssignment(t))!, at = (await c.assign.getAttempt(attemptId))!;
    assert.deepEqual(read.guards, [{ kind: "assignment", id: assignmentIdOf(t), revision: a.revision }, { kind: "attempt", id: attemptId, revision: at.revision }]);
    // a port that reports either record at a revision it no longer has is refused, whichever it is
    for (const stale of [0, 1]) {
      const guards = read.guards!.map((g, i) => (i === stale ? { ...g, revision: g.revision + 5 } : g));
      const s = c.svc(async () => ({ ownerId: ann.id, state: "active", attemptId, guards }));
      await refused(() => s.record(ann, code(t)), /attempt changed while/);
    }
    assert.equal(await recorded(c.svc(async () => undefined), ann, t), 0);
  });
}
