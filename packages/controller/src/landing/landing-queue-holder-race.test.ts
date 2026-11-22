import assert from "node:assert/strict";
import { after, test } from "node:test";
import { assignmentIdOf, type Owner } from "../domain/assignment-model.js";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import type { JsonObject } from "../storage/types.js";
import { LandingQueueOps, LandingQueueService, type QueueApproval } from "./index.js";

after(stopServer);

// Card P10 (ninth slice): a take-out by the task's own agent is judged on the holder as read inside the queue's own write. The assignment record is written back unchanged in that write, so a hand-off at the same
// moment makes exactly one of the two writes win. The races are made without any pause: the judgment itself performs the hand-off between its read and the commit.
const BASE = "b".repeat(40);
const tree = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => `sbm-${"abcdefghijklmnopqrstuvwxyz234567"[n % 32]!.repeat(20)}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); return true; });
};
const ownerOf = (body: JsonObject): Owner | undefined => { const a = body as unknown as { state?: string; owner?: Owner }; return a.state === "assigned" ? a.owner : undefined; };

for (const backend of backends) {
  const rig = async (o: { badBody?: boolean } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval>();
    const service = LandingQueueService.withEpoch(w.storage, w.epoch, options);
    const ops = new LandingQueueOps(service, {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async () => "main",
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
      holderOf: async (taskId) => { const a = await w.assignments.getAssignment(taskId); return a?.state === "assigned" ? a.owner : undefined; },
      holderRecord: { refOf: (taskId) => ({ kind: "assignment", id: assignmentIdOf(taskId) }), ownerOf: (body) => { if (o.badBody === true) throw new Error("not an assignment"); return ownerOf(body); } },
    });
    const person = async (name: string): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants: [] });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    let n = 0;
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
    const approve = (k: number, t: string, author = "agent:ann"): string => { approvals.set(sbm(k), { taskId: t, projectId: w.project, base: BASE, tree: tree(k), submittedBy: author, approved: true }); return sbm(k); };
    const queued = async () => (await ops.list(w.owner, { projectId: w.project })).items.map((e) => e.submissionId);
    /** A take-out through the service itself with a judgment that does `during` once (after reading the record, before the commit) and then judges as the door does. */
    const removeWith = (taskId: string, by: Principal, during: () => Promise<void>, commandId: string) => {
      let first = true, calls = 0;
      return service.remove({
        commandId, actor: by.id, projectId: w.project, branch: "main", taskId, reason: "take it out",
        holder: {
          ref: { kind: "assignment", id: assignmentIdOf(taskId) },
          allowed: async (e, body) => {
            calls++;
            const who = body === undefined ? undefined : ownerOf(body);
            const verdict = who !== undefined ? who.id === by.id.replace(/^agent:/, "") : e.author === by.id;
            if (first) { first = false; await during(); }
            return verdict;
          },
        },
      }).then((r) => ({ r, calls }), (error: unknown) => { throw Object.assign(error as Error, { calls }); });
    };
    return { store, w, ops, service, person, task, handOff, approve, queued, removeWith, close: () => store.close() };
  };

  test(`${backend.name}: a hand-off between the holder being read and the take-out's commit makes the take-out judge again: the old holder is refused and the entry stays (card P10, ninth slice)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann"); await r.person("bob");
      const t1 = await r.task("one", "ann");
      const s1 = r.approve(1, t1);
      await r.ops.add(ann, { commandId: "a1", submissionId: s1 });
      const before = (await r.w.assignments.getAssignment(t1))!.revision;
      // ann is judged as the holder; the hand-off to bob happens before the commit; the commit then loses and is built again, and ann is not the holder any more.
      await assert.rejects(() => r.removeWith(t1, ann, () => r.handOff(t1, "bob"), "race-a"), (error: unknown) => {
        assert.ok(error instanceof DomainError && error.code === "not_found", String(error));
        assert.equal((error as unknown as { calls: number }).calls, 2, "judged twice: on the old holder, then on the new");
        return true;
      });
      assert.deepEqual(await r.queued(), [s1], "the entry was not taken out");
      const now = (await r.w.assignments.getAssignment(t1))!;
      assert.equal((now.owner as Owner).id, "bob");
      assert.equal(now.revision, before + 1, "only the hand-off changed the record");
    } finally { await r.close(); }
  });

  test(`${backend.name}: a hand-off that comes after the take-out finds the entry gone; a take-out by the new holder judged before the hand-off is refused without writing (card P10, ninth slice)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann"), bob = await r.person("bob");
      const t1 = await r.task("one", "ann");
      const s1 = r.approve(1, t1);
      await r.ops.add(ann, { commandId: "a1", submissionId: s1 });
      // bob is judged while ann still holds the task: refused at once (no commit, no retry), whatever happens after.
      await assert.rejects(() => r.removeWith(t1, bob, () => r.handOff(t1, "bob"), "race-b"), (error: unknown) => {
        assert.ok(error instanceof DomainError && error.code === "not_found", String(error));
        assert.equal((error as unknown as { calls: number }).calls, 1, "judged once: nothing was written");
        return true;
      });
      assert.deepEqual(await r.queued(), [s1]);
      // The hand-off is done now: bob is the holder and takes it out; the record keeps its owner.
      const rev = (await r.w.assignments.getAssignment(t1))!.revision;
      const out = await r.ops.remove(bob, { commandId: "b1", taskId: t1, reason: "mine now" });
      assert.equal(out.removed?.submissionId, s1);
      const after = (await r.w.assignments.getAssignment(t1))!;
      assert.equal((after.owner as Owner).id, "bob", "the holder is unchanged");
      assert.equal(after.revision, rev + 1, "the take-out wrote the record back (it is the guard)");
      // The write-back is the cost: a hand-off that was prepared on the earlier revision is told to read again, never applied on a stale view.
      await refuses("stale_revision", () => r.w.assignments.transferTask({ commandId: "late", actor: r.w.owner.id, taskId: t1, expectedRevision: rev, to: { kind: "agent", id: "ann" }, reason: "stale" }));
    } finally { await r.close(); }
  });

  test(`${backend.name}: the door judges the holder on the record: after a hand-off, old holder refused and new holder allowed; a task nobody holds goes to the author; a record that cannot be read refuses (card P10, ninth slice)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann"), bob = await r.person("bob");
      const t1 = await r.task("one", "ann"), t2 = await r.task("two");
      const [s1, s2] = [r.approve(1, t1), r.approve(2, t2)];
      await r.ops.add(ann, { commandId: "a1", submissionId: s1 });
      await r.ops.add(ann, { commandId: "a2", submissionId: s2 });
      await r.handOff(t1, "bob");
      await refuses("not_found", () => r.ops.remove(ann, { commandId: "a3", taskId: t1, reason: "handed off" }));
      // A task credential of another task carries nothing for this task.
      const wrong = { ...bob, taskScope: { taskId: t2, projectId: r.w.project } } as Principal;
      await refuses("not_found", () => r.ops.remove(wrong, { commandId: "b0", taskId: t1, reason: "wrong credential" }));
      assert.equal((await r.ops.remove(bob, { commandId: "b1", taskId: t1, reason: "mine" })).removed?.submissionId, s1);
      // t2 was never assigned: no record to guard, so the author takes it out and bob may not.
      await refuses("not_found", () => r.ops.remove(bob, { commandId: "b2", taskId: t2, reason: "not mine" }));
      assert.equal((await r.ops.remove(ann, { commandId: "a4", taskId: t2, reason: "withdrawn" })).removed?.submissionId, s2);
      assert.deepEqual(await r.queued(), []);
      // The owner is never judged on the holder.
      await r.ops.add(r.w.owner, { commandId: "o1", submissionId: s1 });
      assert.equal((await r.ops.remove(r.w.owner, { commandId: "o2", taskId: t1, reason: "owner" })).removed?.submissionId, s1);
    } finally { await r.close(); }

    const bad = await rig({ badBody: true });
    try {
      const ann = await bad.person("ann");
      const t1 = await bad.task("one", "ann");
      const s1 = bad.approve(1, t1);
      await bad.ops.add(ann, { commandId: "a1", submissionId: s1 });
      await refuses("not_found", () => bad.ops.remove(ann, { commandId: "a2", taskId: t1, reason: "unreadable" }));
      assert.equal((await bad.ops.remove(bad.w.owner, { commandId: "o1", taskId: t1, reason: "owner" })).removed?.submissionId, s1);
    } finally { await bad.close(); }
  });

  test(`${backend.name}: a take-out and a hand-off sent together end in one consistent state, with no waiting (card P10, ninth slice)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann"); await r.person("bob");
      for (let i = 0; i < 6; i++) {
        const t = await r.task(`race${i}`, "ann");
        const s = r.approve(10 + i, t);
        await r.ops.add(ann, { commandId: `add${i}`, submissionId: s });
        const rev = (await r.w.assignments.getAssignment(t))!.revision;
        const [out, moved] = await Promise.allSettled([
          r.ops.remove(ann, { commandId: `rm${i}`, taskId: t, reason: "withdrawn" }),
          r.w.assignments.transferTask({ commandId: `tr${i}`, actor: r.w.owner.id, taskId: t, expectedRevision: rev, to: { kind: "agent", id: "bob" }, reason: "hand-off" }),
        ]);
        const held = ((await r.w.assignments.getAssignment(t))!.owner as Owner).id;
        const entry = (await r.queued()).includes(s);
        if (out.status === "fulfilled") {
          assert.equal(entry, false, "a take-out that answered removed the entry");
          // Either the take-out came first (then the hand-off was told to read again) or the hand-off came first and ann was still judged on a record that said ann.
          if (moved.status === "rejected") assert.equal(held, "ann");
        } else {
          assert.ok(out.reason instanceof DomainError && out.reason.code === "not_found", String(out.reason));
          assert.equal(entry, true, "a refused take-out left the entry");
          assert.equal(moved.status, "fulfilled");
          assert.equal(held, "bob");
        }
      }
    } finally { await r.close(); }
  });
}
