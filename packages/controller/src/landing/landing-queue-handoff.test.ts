import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import { LandingQueueOps, LandingQueueService, type QueueApproval } from "./index.js";

after(stopServer);

// Card P10 (hand-off): the agent that holds a task now answers for the task's queued work. After a hand-off the new holder may add the task's approved submission to the landing queue and take it out, although
// the entry still names the old author; the agent that handed the task off may no longer. While nobody holds the task, the submission's author may, as before. The holder is read from the real assignment record.
const BASE = "b".repeat(40);
const tree = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => `sbm-${"abcdefghijklmnopqrstuvwxyz234567"[n % 32]!.repeat(20)}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  const rig = async (o: { holderFails?: boolean; noHolder?: boolean } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval>();
    const holderOf = async (taskId: string): Promise<string | undefined> => {
      if (o.holderFails === true) throw new Error("the assignments could not be read");
      const a = await w.assignments.getAssignment(taskId);
      return a?.state === "assigned" && a.owner !== undefined ? `${a.owner.kind}:${a.owner.id}` : undefined;
    };
    const ops = new LandingQueueOps(LandingQueueService.withEpoch(w.storage, w.epoch, options), {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async () => "main",
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
      ...(o.noHolder === true ? {} : { holderOf }),
    });
    const person = async (name: string): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants: [] });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    let n = 0;
    /** A ready task held by `holder` (an agent name), or by nobody. */
    const task = async (title: string, holder?: string): Promise<string> => {
      const id = (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId: w.project, title })).id;
      await w.projects.transitionTask({ commandId: `ready-${title}`, actor: w.owner.id, taskId: id, expectedRevision: 1, to: "ready" });
      if (holder !== undefined) await w.assignments.assignTask({ commandId: `as-${title}`, actor: w.owner.id, taskId: id, owner: { kind: "agent", id: holder } });
      return id;
    };
    const handOff = async (taskId: string, to: string): Promise<void> => {
      const a = (await w.assignments.getAssignment(taskId))!;
      await w.assignments.transferTask({ commandId: `tr-${taskId}-${++n}`, actor: w.owner.id, taskId, expectedRevision: a.revision, to: { kind: "agent", id: to }, reason: "hand-off" });
    };
    const release = async (taskId: string): Promise<void> => {
      const a = (await w.assignments.getAssignment(taskId))!;
      await w.assignments.releaseTask({ commandId: `rel-${taskId}-${++n}`, actor: w.owner.id, taskId, expectedRevision: a.revision });
    };
    const approve = (k: number, t: string, author = "agent:ann"): string => { approvals.set(sbm(k), { taskId: t, projectId: w.project, base: BASE, tree: tree(k), submittedBy: author, approved: true }); return sbm(k); };
    const queued = async () => (await ops.list(w.owner, { projectId: w.project })).items.map((e) => [e.submissionId, e.author]);
    return { store, w, ops, person, task, handOff, release, approve, queued, close: () => store.close() };
  };

  test(`${backend.name}: after a hand-off the task's new holder takes its queued work out and adds it back; the agent that handed it off may do neither (card P10)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann"), bob = await r.person("bob"), eve = await r.person("eve");
      const t1 = await r.task("one", "ann");
      const s1 = r.approve(1, t1);
      // While ann holds the task, she adds and takes out her own work; bob may not.
      assert.equal((await r.ops.add(ann, { commandId: "a1", submissionId: s1 })).position, 1);
      await refuses("not_found", () => r.ops.remove(bob, { commandId: "b0", taskId: t1, reason: "not yet mine" }));
      await r.handOff(t1, "bob");
      // The entry still names ann as the author (what was approved, by whom), but bob answers for it now.
      assert.deepEqual(await r.queued(), [[s1, "agent:ann"]]);
      await refuses("not_found", () => r.ops.remove(ann, { commandId: "a2", taskId: t1, reason: "handed off" }), /not yours/);
      await refuses("not_found", () => r.ops.remove(eve, { commandId: "e1", taskId: t1, reason: "a stranger" }));
      const out = await r.ops.remove(bob, { commandId: "b1", taskId: t1, reason: "I will refresh it first" });
      assert.equal(out.removed?.submissionId, s1);
      assert.equal((await r.ops.remove(bob, { commandId: "b1", taskId: t1, reason: "I will refresh it first" })).replayed, true, "a repeat answers it was done");
      assert.deepEqual(await r.queued(), []);
      // Adding: the old author is refused, the holder adds the task's approved submission back (the author stays ann).
      await refuses("not_found", () => r.ops.add(ann, { commandId: "a3", submissionId: s1 }), /not yours/);
      await refuses("not_found", () => r.ops.add(eve, { commandId: "e2", submissionId: s1 }));
      assert.equal((await r.ops.add(bob, { commandId: "b2", submissionId: s1 })).position, 1);
      assert.deepEqual(await r.queued(), [[s1, "agent:ann"]]);
      // A task credential of another task does not carry the holder's rights.
      const t2 = await r.task("two", "bob");
      const scoped = { ...bob, taskScope: { taskId: t2, projectId: r.w.project } } as Principal;
      await refuses("not_found", () => r.ops.remove(scoped, { commandId: "b3", taskId: t1, reason: "wrong credential" }));
      await refuses("not_found", () => r.ops.add(scoped, { commandId: "b4", submissionId: s1 }));
      const own = { ...bob, taskScope: { taskId: t1, projectId: r.w.project } } as Principal;
      assert.equal((await r.ops.remove(own, { commandId: "b5", taskId: t1, reason: "its own task credential" })).removed?.submissionId, s1);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a task nobody holds leaves its work to the submission's author; a task handed back to its author is hers again (card P10, hand-off)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann"), bob = await r.person("bob");
      const t1 = await r.task("one", "ann"), t2 = await r.task("two");
      const [s1, s2] = [r.approve(1, t1), r.approve(2, t2)];
      await r.ops.add(r.w.owner, { commandId: "o1", submissionId: s1 });
      await r.ops.add(ann, { commandId: "a1", submissionId: s2 });
      // Never assigned: the author takes it out, nobody else.
      await refuses("not_found", () => r.ops.remove(bob, { commandId: "b1", taskId: t2, reason: "x" }));
      assert.equal((await r.ops.remove(ann, { commandId: "a2", taskId: t2, reason: "withdrawn" })).removed?.submissionId, s2);
      // Handed to bob, then released: nobody holds it, so the author's rule applies again and bob (no longer the holder) is refused.
      await r.handOff(t1, "bob");
      await r.release(t1);
      await refuses("not_found", () => r.ops.remove(bob, { commandId: "b2", taskId: t1, reason: "released" }));
      // Handed back to ann after bob held it: hers again.
      await r.w.assignments.assignTask({ commandId: "as-again", actor: r.w.owner.id, taskId: t1, expectedRevision: (await r.w.assignments.getAssignment(t1))!.revision, owner: { kind: "agent", id: "bob" } });
      await r.handOff(t1, "ann");
      await refuses("not_found", () => r.ops.remove(bob, { commandId: "b3", taskId: t1, reason: "handed back" }));
      assert.equal((await r.ops.remove(ann, { commandId: "a3", taskId: t1, reason: "mine again" })).removed?.submissionId, s1);
      // Held by a person (not an agent) with the same bare ID as the author: the task is held by someone else, so the author's agent answers for nothing.
      const a1 = (await r.w.assignments.getAssignment(t1))!;
      await r.w.assignments.transferTask({ commandId: "tr-person", actor: r.w.owner.id, taskId: t1, expectedRevision: a1.revision, to: { kind: "person", id: "ann" }, reason: "a person takes it" });
      await refuses("not_found", () => r.ops.add(ann, { commandId: "a4", submissionId: s1 }));
      assert.equal((await r.ops.add(r.w.owner, { commandId: "o2", submissionId: s1 })).position, 1);
      await refuses("not_found", () => r.ops.remove(ann, { commandId: "a5", taskId: t1, reason: "held by a person" }));
    } finally { await r.close(); }
  });

  test(`${backend.name}: a holder that cannot be read refuses the task's own agent (fails closed) but not the owner; without a holder reader the author rule stands (card P10, hand-off)`, async () => {
    const failing = await rig({ holderFails: true });
    try {
      const ann = await failing.person("ann");
      const t1 = await failing.task("one", "ann");
      const s1 = failing.approve(1, t1);
      await refuses("not_found", () => failing.ops.add(ann, { commandId: "a1", submissionId: s1 }));
      assert.equal((await failing.ops.add(failing.w.owner, { commandId: "o1", submissionId: s1 })).position, 1);
      await refuses("not_found", () => failing.ops.remove(ann, { commandId: "a2", taskId: t1, reason: "x" }));
      assert.equal((await failing.ops.remove(failing.w.owner, { commandId: "o2", taskId: t1, reason: "the owner decides" })).removed?.submissionId, s1);
    } finally { await failing.close(); }
    const plain = await rig({ noHolder: true });
    try {
      const ann = await plain.person("ann"), bob = await plain.person("bob");
      const t1 = await plain.task("one", "ann");
      const s1 = plain.approve(1, t1);
      await plain.handOff(t1, "bob");
      // No holder reader: the entry's author alone, whatever the assignment says.
      assert.equal((await plain.ops.add(ann, { commandId: "a1", submissionId: s1 })).position, 1);
      await refuses("not_found", () => plain.ops.remove(bob, { commandId: "b1", taskId: t1, reason: "x" }));
      assert.equal((await plain.ops.remove(ann, { commandId: "a2", taskId: t1, reason: "y" })).removed?.submissionId, s1);
    } finally { await plain.close(); }
  });
}
