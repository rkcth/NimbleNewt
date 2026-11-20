import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import { LandingQueueOps, LandingQueueService, type QueueApproval } from "./index.js";

after(stopServer);

// Card P10, landing-queue polish (follow-ups of the queue slice's review): `landing.queue.list` reads any branch's queue and names the project's other branches whose queues still hold work (a branch that
// was the landing branch before the owner named another); `landing.queue.remove` judges who may take anything out before it says the project names no landing branch, and can take an entry out of another
// branch's queue.
const BASE = "b".repeat(40);
const tree = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => `sbm-${"abcdefghijklmnopqrstuvwxyz234567"[n % 32]!.repeat(20)}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};

for (const backend of backends) {
  const rig = async () => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval>();
    let branch: string | undefined = "main";
    const queue = LandingQueueService.withEpoch(w.storage, w.epoch, options);
    const ops = new LandingQueueOps(queue, {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async () => branch,
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
    });
    const person = async (name: string, grants = [{ action: "integration.lease", project: w.project }]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    const task = async (title: string, projectId = w.project): Promise<string> => (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId, title })).id;
    const approve = (n: number, t: string, author = "agent:ann", projectId = w.project): string => { approvals.set(sbm(n), { taskId: t, projectId, base: BASE, tree: tree(n), submittedBy: author, approved: true }); return sbm(n); };
    const ids = (items: readonly { position: number; submissionId: string }[]) => items.map((e) => [e.position, e.submissionId]);
    return { store, w, queue, ops, person, task, approve, ids, setBranch: (b: string | undefined) => { branch = b; }, close: () => store.close() };
  };

  test(`${backend.name}: after the owner names another landing branch, the old branch's queue is listed among the project's other queues and can be read by name (card P10, polish)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann", []), ivy = await r.person("ivy");
      const [t1, t2, t3] = [await r.task("one"), await r.task("two"), await r.task("three")];
      const [s1, s2] = [r.approve(1, t1), r.approve(2, t2)];
      await r.ops.add(r.w.owner, { commandId: "o1", submissionId: s1 });
      await r.ops.add(r.w.owner, { commandId: "o2", submissionId: s2 });
      // Another project's queue on the same branch name is never listed here.
      const other = (await r.w.projects.createProject({ commandId: "p2", actor: r.w.owner.id, name: "Other" })).id;
      const s9 = r.approve(9, await r.task("nine", other), "agent:ann", other);
      await r.ops.add(r.w.owner, { commandId: "o9", submissionId: s9 });
      await r.queue.enqueue({ commandId: "x-old", actor: r.w.owner.id, projectId: other, branch: "old", submissionId: sbm(10), taskId: await r.task("ten", other), base: BASE, tree: tree(10), author: "agent:ann" });

      const before = await r.ops.list(r.w.owner, { projectId: r.w.project });
      assert.deepEqual([before.branch, before.landingBranch, r.ids(before.items), before.others, before.partial], ["main", "main", [[1, s1], [2, s2]], [], undefined]);

      // The owner names "trunk": the default view is trunk's (empty), and main's two entries are named, not lost from sight.
      r.setBranch("trunk");
      const after = await r.ops.list(r.w.owner, { projectId: r.w.project });
      assert.deepEqual([after.branch, after.landingBranch, after.items, after.others], ["trunk", "trunk", [], [{ branch: "main", entries: 2 }]]);
      // Read by name: the old queue in full, still oldest first.
      const old = await r.ops.list(ivy, { projectId: r.w.project, branch: "main" });
      assert.deepEqual([old.branch, old.landingBranch, r.ids(old.items), old.others], ["main", "trunk", [[1, s1], [2, s2]], []]);
      // A new approval queues on trunk; main's queue is then listed beside it.
      const s3 = r.approve(3, t3);
      assert.equal((await r.ops.add(ann, { commandId: "a3", submissionId: s3 })).branch, "trunk");
      const both = await r.ops.list(r.w.owner, { projectId: r.w.project });
      assert.deepEqual([r.ids(both.items), both.others], [[[1, s3]], [{ branch: "main", entries: 2 }]]);
      const fromMain = await r.ops.list(r.w.owner, { projectId: r.w.project, branch: "main" });
      assert.deepEqual(fromMain.others, [{ branch: "trunk", entries: 1 }], "read by name, the landing branch's queue is the other one");
      // No landing branch at all: nothing is the default, every queue with work is named.
      r.setBranch(undefined);
      const none = await r.ops.list(r.w.owner, { projectId: r.w.project });
      assert.deepEqual([none.branch, none.landingBranch, none.items, none.others], ["", "", [], [{ branch: "main", entries: 2 }, { branch: "trunk", entries: 1 }]]);
      // Rights and the branch's form: the same as the default view.
      await refuses("not_found", () => r.ops.list(ann, { projectId: r.w.project, branch: "main" }));
      for (const bad of ["", "two\nlines", "x".repeat(201), 7]) await refuses("invalid_command", () => r.ops.list(r.w.owner, { projectId: r.w.project, branch: bad as never }));
      await refuses("invalid_command", () => r.ops.list(r.w.owner, { projectId: r.w.project, branch: "main", extra: 1 } as never));
    } finally { await r.close(); }
  });

  test(`${backend.name}: taking work out judges the caller's rights before the landing branch, and can take it out of another branch's queue (card P10, polish)`, async () => {
    const r = await rig();
    try {
      const ann = await r.person("ann", []), bob = await r.person("bob", []), ivy = await r.person("ivy");
      const [t1, t2, t3] = [await r.task("one"), await r.task("two"), await r.task("three")];
      const [s1, s2, s3] = [r.approve(1, t1), r.approve(2, t2, "agent:bob"), r.approve(3, t3)];
      for (const [i, s] of [s1, s2, s3].entries()) await r.ops.add(r.w.owner, { commandId: `o${i}`, submissionId: s });

      // The project names no landing branch: who may take nothing out is told nothing exists; the owner and an integrator are told the configuration fact.
      r.setBranch(undefined);
      await refuses("not_found", () => r.ops.remove(ann, { commandId: "a0", taskId: t1, reason: "x" }), /does not exist or is not yours/);
      await refuses("not_found", () => r.ops.remove(bob, { commandId: "b0", taskId: t1, reason: "x" }), /does not exist or is not yours/);
      await refuses("forbidden", () => r.ops.remove(ivy, { commandId: "i0", taskId: t1, reason: "x" }), /names no landing branch/);
      await refuses("forbidden", () => r.ops.remove(r.w.owner, { commandId: "w0", taskId: t1, reason: "x" }), /names no landing branch/);

      // Now trunk: the entries sit in main's queue. Named by branch, each may take out what it may: the author its own, not another's; the integrator and the owner any.
      r.setBranch("trunk");
      await refuses("not_found", () => r.ops.remove(r.w.owner, { commandId: "w1", taskId: t1, reason: "x" }), /has no submission in the landing queue of branch trunk/);
      await refuses("not_found", () => r.ops.remove(ann, { commandId: "a1", taskId: t2, reason: "not mine", branch: "main" }), /does not exist or is not yours/);
      const own = await r.ops.remove(ann, { commandId: "a2", taskId: t1, reason: "the landing branch changed", branch: "main" });
      assert.deepEqual([own.branch, own.removed?.submissionId, own.replayed], ["main", s1, false]);
      assert.equal((await r.ops.remove(ann, { commandId: "a2", taskId: t1, reason: "the landing branch changed", branch: "main" })).replayed, true, "a repeat answers it was done");
      assert.equal((await r.ops.remove(ivy, { commandId: "i2", taskId: t2, reason: "moved to trunk", branch: "main" })).removed?.submissionId, s2);
      // With no landing branch the owner can still clear a named branch.
      r.setBranch(undefined);
      assert.equal((await r.ops.remove(r.w.owner, { commandId: "w2", taskId: t3, reason: "cleared", branch: "main" })).removed?.submissionId, s3);
      assert.deepEqual((await r.ops.list(r.w.owner, { projectId: r.w.project })).others, [], "main's queue is empty, so it is no longer listed");
      for (const bad of ["", "a\tb", "x".repeat(201)]) await refuses("invalid_command", () => r.ops.remove(r.w.owner, { commandId: "w3", taskId: t1, reason: "x", branch: bad }));
    } finally { await r.close(); }
  });

  test(`${backend.name}: the project's other queues are found across more than one page of queue records (card P10, polish)`, async () => {
    const r = await rig();
    try {
      const t = await r.task("one");
      const other = (await r.w.projects.createProject({ commandId: "p2", actor: r.w.owner.id, name: "Other" })).id;
      const t2 = await r.task("two", other);
      // 230 queues of this project and 20 of another: more than one page of 200 records.
      for (let i = 0; i < 250; i++) {
        const mine = i < 230;
        await r.queue.enqueue({ commandId: `q${i}`, actor: r.w.owner.id, projectId: mine ? r.w.project : other, branch: `b${String(i).padStart(3, "0")}`, submissionId: sbm(i % 32), taskId: mine ? t : t2, base: BASE, tree: tree(i + 1), author: "agent:ann" });
      }
      const found = await r.queue.queuesOf(r.w.project);
      assert.equal(found.partial, false);
      assert.equal(found.queues.length, 230);
      assert.deepEqual(found.queues.slice(0, 2), [{ branch: "b000", entries: 1 }, { branch: "b001", entries: 1 }]);
      assert.equal(found.queues.at(-1)!.branch, "b229");
      const listed = await r.ops.list(r.w.owner, { projectId: r.w.project });
      assert.deepEqual([listed.branch, listed.others.length, listed.others.some((o) => o.branch === "main")], ["main", 230, false]);
      assert.equal((await r.queue.queuesOf(other)).queues.length, 20);
    } finally { await r.close(); }
  });
}
