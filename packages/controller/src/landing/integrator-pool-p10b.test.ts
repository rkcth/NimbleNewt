import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Grant, Principal } from "../security/principals.js";
import { IntegratorLeaseOps, IntegratorLeaseService, IntegratorPool, LandingQueueService, POOL_LIMITS, type LandingQueue } from "./index.js";

after(stopServer);

// Card P10b (first slice): integrators shared across projects as a pool. A free integrator takes the next project with queued work: the landing branch, among the projects it may land on, whose first queued approved
// work has waited longest; one project at a time; a branch another integrator holds is passed over; nothing of a project it has no right on is looked at or counted; nothing taken says why.
const MIN = 60_000;
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
    const branches = new Map<string, string | undefined>();
    const unreadable = new Set<string>();
    const retired = new Set<string>();
    const landingBranch = async (call: { projectId: string }): Promise<string | undefined> => { if (unreadable.has(call.projectId)) throw new Error("settings down"); return branches.has(call.projectId) ? branches.get(call.projectId) : "main"; };
    const activeAgent = async (id: string) => !retired.has(id);
    const leases = IntegratorLeaseService.withEpoch(w.storage, w.epoch, options);
    const leaseOps = new IntegratorLeaseOps(leases, { landingBranch, activeAgent });
    const queue = LandingQueueService.withEpoch(w.storage, w.epoch, options);
    const pool = new IntegratorPool(leases, leaseOps, queue, { landingBranch, activeAgent });
    const project = async (name: string): Promise<string> => (await w.projects.createProject({ commandId: `p-${name}`, actor: w.owner.id, name })).id;
    const task = async (projectId: string, title: string): Promise<string> => (await w.projects.createTask({ commandId: `t-${title}`, actor: w.owner.id, projectId, title })).id;
    const person = async (name: string, grants: Grant[]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    let n = 0;
    /** Queues approved work of a new task in `projectId` on `branch`; the clock then moves a minute, so each queue's first place is older than the next one's. */
    const queued = async (projectId: string, branch = "main"): Promise<{ taskId: string; submissionId: string }> => {
      n++;
      const taskId = await task(projectId, `work-${n}`);
      await queue.enqueue({ commandId: `q-${n}`, actor: "controller", projectId, branch, submissionId: sbm(n), taskId, base: BASE, tree: tree(n), author: "agent:writer" });
      w.clock.advance(MIN);
      return { taskId, submissionId: sbm(n) };
    };
    return { store, w, leases, leaseOps, queue, pool, project, task, person, queued, branches, unreadable, retired, landingBranch, activeAgent, close: () => store.close() };
  };
  const lands = (projects: string[]): Grant[] => projects.map((project) => ({ action: "integration.lease", project }));

  test(`${backend.name}: a free integrator takes the project whose queued work waited longest; one project at a time; a held branch is passed over; a repeat answers the hold (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b, c] = [await r.project("Apple"), await r.project("Birch"), await r.project("Cedar")];
      // Queued in the order c, a, b (c's work waited longest), whatever the order of the project IDs.
      const qc = await r.queued(c), qa = await r.queued(a), qb = await r.queued(b);
      await r.queued(a); // a second entry behind a's first changes nothing: the first place counts
      const ivy = await r.person("ivy", lands([a, b, c])), max = await r.person("max", lands([a, b, c])), sue = await r.person("sue", [{ action: "integration.lease", project: "*" }]), zed = await r.person("zed", lands([a, b, c]));
      const first = await r.pool.next(ivy, { commandId: "i1", ttlMs: 10 * MIN });
      assert.equal(first.outcome, "taken");
      if (first.outcome !== "taken") return;
      assert.deepEqual([first.projectId, first.branch, first.taskId, first.submissionId, first.lease.holder, first.lease.taskId, first.lease.fence, first.lease.live], [c, "main", qc.taskId, qc.submissionId, "ivy", qc.taskId, 1, true]);
      assert.equal(first.waitingSince, "2026-10-23T09:00:00.000Z");
      // The lease it got is the one a landing shows (P10's door).
      assert.deepEqual(await r.leaseOps.checkLanding(ivy, { taskId: qc.taskId, projectId: c, branch: "main", leaseId: first.lease.leaseId, fence: first.lease.fence }), { leaseId: first.lease.leaseId, fence: 1 });
      // One project at a time: asking again (the same request or a new one) answers the hold and takes nothing more.
      for (const id of ["i1", "i2"]) {
        const again = await r.pool.next(ivy, { commandId: id, ttlMs: 10 * MIN });
        assert.equal(again.outcome, "holding", id);
        if (again.outcome === "holding") { assert.deepEqual([again.projectId, again.lease.leaseId, again.holding], [c, first.lease.leaseId, 1]); assert.match(again.reason, /release it when its queue is done/); }
      }
      assert.equal((await r.leases.heldBy("ivy")).leases.length, 1);
      // The next integrator is passed c (held) and takes a; a grant for every project serves every project; then nothing is left.
      const second = await r.pool.next(max, { commandId: "m1", ttlMs: 10 * MIN });
      assert.deepEqual(second.outcome === "taken" ? [second.projectId, second.taskId] : second, [a, qa.taskId]);
      const third = await r.pool.next(sue, { commandId: "s1", ttlMs: 10 * MIN });
      assert.deepEqual(third.outcome === "taken" ? [third.projectId, third.taskId] : third, [b, qb.taskId]);
      const none = await r.pool.next(zed, { commandId: "z1", ttlMs: 10 * MIN });
      assert.deepEqual(none, { outcome: "none", reason: "nothing was taken: 3 branches are held by another integrator", heldByOthers: 3, awaitingWork: 0, unreadable: 0, partial: false });
      // Released, the branch is free again: the next ask takes it (the oldest work still waits there, nothing landed).
      await r.leaseOps.release(ivy, { commandId: "r1", leaseId: first.lease.leaseId, fence: 1 });
      const back = await r.pool.next(zed, { commandId: "z2", ttlMs: 10 * MIN });
      assert.deepEqual(back.outcome === "taken" ? [back.projectId, back.lease.holder, back.lease.fence] : back, [c, "zed", 2]);
      // An expired hold is free: when max's runs out, ivy (free since her release) takes a.
      r.w.clock.advance(11 * MIN);
      const expired = await r.pool.next(ivy, { commandId: "i3", ttlMs: 30 * MIN });
      assert.equal(expired.outcome, "taken");
      // b and c expired too: the oldest of the three is c.
      assert.equal(expired.outcome === "taken" ? expired.projectId : "", c);
    } finally { await r.close(); }
  });

  test(`${backend.name}: only projects the integrator may land on are looked at and counted; the owner, a task credential and malformed requests are refused (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b] = [await r.project("Apple"), await r.project("Birch")];
      await r.queued(a); const qb = await r.queued(b);
      const ann = await r.person("ann", lands([a])), bob = await r.person("bob", lands([b])), eve = await r.person("eve", [{ action: "workspace.manage", project: a }, { action: "task.read", project: "*" }]);
      const own = await r.pool.next(ann, { commandId: "a1", ttlMs: 10 * MIN });
      assert.equal(own.outcome === "taken" ? own.projectId : own.outcome, a);
      // bob may land on b only: a's held branch is not his business (not counted), and he takes b.
      const bobs = await r.pool.next(bob, { commandId: "b1", ttlMs: 10 * MIN });
      assert.deepEqual(bobs.outcome === "taken" ? [bobs.projectId, bobs.taskId] : bobs, [b, qb.taskId]);
      await r.leaseOps.release(bob, { commandId: "b2", leaseId: bobs.outcome === "taken" ? bobs.lease.leaseId : "", fence: 1 });
      // Someone without the right anywhere is told there is no work, with no count of anyone else's projects.
      assert.deepEqual(await r.pool.next(eve, { commandId: "e1", ttlMs: 10 * MIN }), { outcome: "none", reason: "no project you integrate has approved work waiting to land", heldByOthers: 0, awaitingWork: 0, unreadable: 0, partial: false });
      // The right taken away from ann: her hold on a no longer makes her busy (she cannot land with it), and a is not served to her; nothing else is hers.
      await r.w.principals.setGrants(r.w.owner, { commandId: "g1", principalId: "agent:ann", expectedRevision: (await r.w.principals.get("agent:ann"))!.revision, grants: lands([b]) });
      const ann2 = await r.w.principals.authenticate((await r.w.principals.issueCredential(r.w.owner, "agent:ann")).token);
      const moved = await r.pool.next(ann2, { commandId: "a2", ttlMs: 10 * MIN });
      assert.deepEqual(moved.outcome === "taken" ? [moved.projectId, moved.lease.holder] : moved, [b, "ann"]);
      // Refused: the owner (it names an agent through integrator.lease.acquire), a task credential, unknown arguments, bad hold times, a missing command ID.
      await refuses("forbidden", () => r.pool.next(r.w.owner, { commandId: "o1", ttlMs: 10 * MIN }), /only an integrator agent/);
      await refuses("forbidden", () => r.pool.next({ ...bob, taskScope: { taskId: qb.taskId, projectId: b } }, { commandId: "t1", ttlMs: 10 * MIN }), /task credential/);
      await refuses("forbidden", () => r.pool.next({ ...bob, kind: "service", id: "service:x" } as Principal, { commandId: "x1", ttlMs: 10 * MIN }));
      await refuses("invalid_command", () => r.pool.next(bob, { commandId: "b3", ttlMs: 10 * MIN, projectId: a } as never));
      for (const ttlMs of [5, 1.5 + 10 * MIN, 25 * 60 * MIN, -MIN, Number.NaN, "600000"]) await refuses("invalid_command", () => r.pool.next(bob, { commandId: "b4", ttlMs } as never), /ttlMs/);
      await refuses("invalid_command", () => r.pool.next(bob, { commandId: "", ttlMs: 10 * MIN }), /commandId/);
      await refuses("invalid_command", () => r.pool.next(bob, { commandId: "x".repeat(121), ttlMs: 10 * MIN }), /commandId/);
      assert.equal((await r.leases.heldBy("bob")).leases.length, 0, "a refused request takes nothing");
    } finally { await r.close(); }
  });

  test(`${backend.name}: passed over with a reason: a reserved first place without work, a queue off the landing branch, unreadable settings; a retired holder's branch is taken (card P10b)`, async () => {
    const r = await rig();
    try {
      const [a, b, c, d] = [await r.project("Apple"), await r.project("Birch"), await r.project("Cedar"), await r.project("Dogwood")];
      // a: its only entry is taken out with its place kept (a reservation), so its first place waits for that task's work.
      const qa = await r.queued(a);
      await r.queue.reserve({ commandId: "res-a", actor: "controller", projectId: a, branch: "main", taskId: qa.taskId, round: 3, cap: 3 });
      await r.queue.remove({ commandId: "rm-a", actor: "controller", projectId: a, branch: "main", taskId: qa.taskId, reason: "refreshing", keepReservation: true } as never);
      await r.queued(a); // newer work behind the reserved place: the queue holds an entry, but its first place has none
      // b: queued on a branch the owner no longer names; c: its settings cannot be read.
      await r.queued(b, "old"); r.branches.set(b, "main");
      await r.queued(c); r.unreadable.add(c);
      const ivy = await r.person("ivy", lands([a, b, c, d])), old = await r.person("old", lands([d]));
      const none = await r.pool.next(ivy, { commandId: "i1", ttlMs: 10 * MIN });
      assert.deepEqual(none, { outcome: "none", reason: "nothing was taken: 1 reserved first place waits for its task's approved work; 1 queue could not be judged (the landing settings could not be read, or the record does not match its task)", heldByOthers: 0, awaitingWork: 1, unreadable: 1, partial: false });
      // A project naming no landing branch is passed over too.
      const qd = await r.queued(d);
      r.branches.set(d, undefined);
      assert.equal((await r.pool.next(ivy, { commandId: "i2", ttlMs: 10 * MIN })).outcome, "none");
      r.branches.set(d, "main");
      // d's branch is held by an agent that is then retired: not passed over; the lease door ends that hold and ivy takes it with a new fence.
      const olds = await r.pool.next(old, { commandId: "o1", ttlMs: 60 * MIN });
      assert.equal(olds.outcome === "taken" ? olds.projectId : "", d);
      assert.equal((await r.pool.next(ivy, { commandId: "i3", ttlMs: 10 * MIN })).outcome, "none", "an active holder keeps it");
      r.retired.add("old");
      const took = await r.pool.next(ivy, { commandId: "i4", ttlMs: 10 * MIN });
      assert.deepEqual(took.outcome === "taken" ? [took.projectId, took.taskId, took.lease.holder, took.lease.fence] : took, [d, qd.taskId, "ivy", 2]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: race: integrators asking at the same moment never share a branch and none holds two (card P10b)`, async () => {
    const r = await rig();
    try {
      const projects = [await r.project("P1"), await r.project("P2"), await r.project("P3")];
      for (const p of projects) await r.queued(p);
      const names = ["i1", "i2", "i3", "i4", "i5"];
      const agents = await Promise.all(names.map((x) => r.person(x, [{ action: "integration.lease", project: "*" }])));
      // Separate doors over the same records, as separate controller services would be.
      const doors = agents.map(() => { const l = IntegratorLeaseService.withEpoch(r.w.storage, r.w.epoch, { clock: r.w.clock.now, pause: async () => undefined }); return new IntegratorPool(l, new IntegratorLeaseOps(l, { landingBranch: r.landingBranch, activeAgent: r.activeAgent }), LandingQueueService.withEpoch(r.w.storage, r.w.epoch, { clock: r.w.clock.now, pause: async () => undefined }), { landingBranch: r.landingBranch, activeAgent: r.activeAgent }); });
      const answers = await Promise.all(agents.map((a, i) => doors[i]!.next(a, { commandId: `race-${i}`, ttlMs: 10 * MIN })));
      const taken = answers.filter((x) => x.outcome === "taken");
      assert.equal(taken.length, 3, JSON.stringify(answers));
      assert.deepEqual(taken.map((x) => (x.outcome === "taken" ? x.projectId : "")).sort(), [...projects].sort(), "each project's branch went to exactly one");
      for (const x of answers.filter((y) => y.outcome !== "taken")) assert.equal(x.outcome, "none");
      for (const name of names) assert.ok((await r.leases.heldBy(name)).leases.length <= 1, name);
      // And the same integrator asking twice at once ends with one hold.
      const solo = await r.project("P4"); await r.queued(solo); const other = await r.project("P5"); await r.queued(other);
      const loner = await r.person("loner", [{ action: "integration.lease", project: solo }, { action: "integration.lease", project: other }]);
      const twice = await Promise.all([doors[0]!.next(loner, { commandId: "l1", ttlMs: 10 * MIN }), doors[1]!.next(loner, { commandId: "l2", ttlMs: 10 * MIN })]);
      // Both asks go for the same oldest queue: one takes it, the other finds the caller's own hold there (before or at the door) and answers it; never "held by another integrator", never a second branch.
      assert.deepEqual(twice.map((x) => x.outcome).sort(), ["holding", "taken"], JSON.stringify(twice));
      const held = (await r.leases.heldBy("loner")).leases;
      assert.deepEqual(held.map((l) => l.projectId), [solo]);
      const h = twice.find((x) => x.outcome === "holding");
      assert.equal(h?.outcome === "holding" ? h.lease.leaseId : "", held[0]!.leaseId);
    } finally { await r.close(); }
  });

  test(`${backend.name}: bounded and fail closed: an incomplete read of the caller's holds is refused; an incomplete queue walk and the try limit are said as partial; hostile queue records (card P10b)`, async () => {
    const r = await rig();
    try {
      const a = await r.project("Apple");
      await r.queued(a);
      const ivy = await r.person("ivy", [{ action: "integration.lease", project: "*" }]);
      // heldBy itself: no pages read is partial.
      assert.deepEqual(await r.leases.heldBy("ivy", 0), { leases: [], partial: true });
      const partialHolds = new IntegratorPool({ heldBy: async () => ({ leases: [], partial: true }), get: (id) => r.leases.get(id), projectOfTask: (t) => r.leases.projectOfTask(t) }, r.leaseOps, r.queue, { landingBranch: r.landingBranch });
      await refuses("unavailable", () => partialHolds.next(ivy, { commandId: "p1", ttlMs: 10 * MIN }), /could not all be read/);
      assert.equal((await r.leases.heldBy("ivy")).leases.length, 0, "nothing taken");
      // A queue walk that stopped early: work found is still taken; with nothing found, the answer says not every queue was looked at.
      const walk = (queues: LandingQueue[], partial: boolean) => ({ queuesWithEntries: async () => ({ queues, partial }) });
      const real = (await r.queue.queuesWithEntries()).queues;
      const some = await new IntegratorPool(r.leases, r.leaseOps, walk(real, true), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p2", ttlMs: 10 * MIN });
      assert.equal(some.outcome, "taken");
      if (some.outcome === "taken") await r.leaseOps.release(ivy, { commandId: "p2r", leaseId: some.lease.leaseId, fence: some.lease.fence });
      assert.deepEqual(await new IntegratorPool(r.leases, r.leaseOps, walk([], true), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p3", ttlMs: 10 * MIN }), { outcome: "none", reason: "nothing was taken: not every queue was looked at in this request; ask again", heldByOthers: 0, awaitingWork: 0, unreadable: 0, partial: true });
      // The try limit: every lease refused (lost to others), more candidates than tries: at most POOL_LIMITS.tries tried, and the answer is partial.
      const many: LandingQueue[] = Array.from({ length: POOL_LIMITS.tries + 3 }, (_, i) => ({ ...real[0]!, projectId: a, branch: "main", queueId: `lqu-${i}` }));
      let tried = 0;
      const losing = { acquire: async () => { tried++; throw new DomainError("unavailable", "held"); } };
      const lost = await new IntegratorPool(r.leases, losing, walk(many, false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p4", ttlMs: 10 * MIN });
      assert.deepEqual([tried, lost.outcome, lost.outcome === "none" ? [lost.heldByOthers, lost.partial] : []], [POOL_LIMITS.tries, "none", [POOL_LIMITS.tries, true]]);
      // A lease door that fails otherwise is not swallowed.
      const broken = { acquire: async () => { throw new DomainError("stale_revision", "boom"); } };
      await refuses("stale_revision", () => new IntegratorPool(r.leases, broken, walk(real, false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p5", ttlMs: 10 * MIN }));
      // A door refusing after the pool's own checks passed (the branch, task or right changed meanwhile) is counted, never "no work waits".
      for (const code of ["forbidden", "not_found"] as const) {
        const changed = await new IntegratorPool(r.leases, { acquire: async () => { throw new DomainError(code, "changed"); } }, walk(real, false), { landingBranch: r.landingBranch }).next(ivy, { commandId: `p5-${code}`, ttlMs: 10 * MIN });
        assert.deepEqual(changed.outcome === "none" ? [changed.unreadable, changed.heldByOthers, changed.partial] : changed, [1, 0, false], code);
      }
      // The caller's own live hold found at the branch after the free check (another request of its own took it meanwhile): answered as its hold, before or after the door.
      const mineNow = await r.leaseOps.acquire(ivy, { commandId: "p5-own", taskId: real[0]!.entries[0]!.taskId, branch: "main", ttlMs: 10 * MIN });
      const blind = { heldBy: async () => ({ leases: [], partial: false }), get: (id: string) => r.leases.get(id), projectOfTask: (t: string) => r.leases.projectOfTask(t) };
      let doorAsked = 0;
      const seenBefore = await new IntegratorPool(blind, { acquire: async () => { doorAsked++; throw new DomainError("unavailable", "held"); } }, walk(real, false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p5-b", ttlMs: 10 * MIN });
      assert.deepEqual(seenBefore.outcome === "holding" ? [seenBefore.lease.leaseId, seenBefore.holding, doorAsked] : seenBefore, [mineNow.leaseId, 1, 0]);
      let gets = 0;
      const lateGet = { ...blind, get: async (id: string) => (gets++ === 0 ? undefined : r.leases.get(id)) };
      const seenAfter = await new IntegratorPool(lateGet, { acquire: async () => { throw new DomainError("unavailable", "held"); } }, walk(real, false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p5-c", ttlMs: 10 * MIN });
      assert.deepEqual(seenAfter.outcome === "holding" ? seenAfter.lease.leaseId : seenAfter, mineNow.leaseId);
      // Another integrator's hold seen only at the door stays "held by another".
      const othersGet = { ...blind, get: async (id: string) => (gets++ % 2 === 0 ? undefined : { ...(await r.leases.get(id))!, holder: "someone" }) };
      gets = 0;
      const lostLate = await new IntegratorPool(othersGet, { acquire: async () => { throw new DomainError("unavailable", "held"); } }, walk(real, false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p5-d", ttlMs: 10 * MIN });
      assert.deepEqual(lostLate.outcome === "none" ? [lostLate.heldByOthers, lostLate.unreadable] : lostLate, [1, 0]);
      await r.leaseOps.release(ivy, { commandId: "p5-own-r", leaseId: mineNow.leaseId, fence: mineNow.fence });
      // A replayed lease answer that is not the caller's live hold is not work taken.
      const stale = { acquire: async () => ({ ...(await r.leases.get(IntegratorLeaseService.leaseIdOf(a, "main")))!, live: false }) };
      assert.equal((await new IntegratorPool(r.leases, stale, walk(real, false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p6", ttlMs: 10 * MIN })).outcome, "none");
      // The pool's own judgement, not only the lease door's: a queue off the landing branch is never asked of the door at all.
      const asked: string[] = [];
      const recording = { acquire: async (by: Principal, c: { branch: string }) => { asked.push(c.branch); return r.leaseOps.acquire(by, c as never); } };
      assert.equal((await new IntegratorPool(r.leases, recording, walk([{ ...real[0]!, branch: "old" }], false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p6b", ttlMs: 10 * MIN })).outcome, "none");
      assert.deepEqual(asked, [], "an off-branch queue is passed over before any lease is asked for");
      // A door answering a live hold of the caller that is another project's or branch's lease is not work taken for this queue.
      const mine = { ...(await r.leases.get(IntegratorLeaseService.leaseIdOf(a, "main")))!, live: true, holder: "ivy" };
      // An active integrator's live hold seen before the door is passed over without asking the door (it costs no try).
      let doorCalls = 0;
      const othersHold = { ...blind, get: async (id: string) => ({ ...(await r.leases.get(id))!, live: true, holder: "someone" }) };
      const passed = await new IntegratorPool(othersHold, { acquire: async () => { doorCalls++; return mine; } }, walk(real, false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p6d", ttlMs: 10 * MIN });
      assert.deepEqual([passed.outcome, passed.outcome === "none" ? passed.heldByOthers : -1, doorCalls], ["none", 1, 0]);
      // ... and a live hold of another holder, or of another project or branch, answered by the door is not work taken for this queue.
      for (const wrong of [{ ...mine, projectId: "proj-elsewhere" }, { ...mine, branch: "other" }, { ...mine, holder: "someone" }]) {
        assert.equal((await new IntegratorPool(r.leases, { acquire: async () => wrong }, walk(real, false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p6c", ttlMs: 10 * MIN })).outcome, "none", JSON.stringify([wrong.projectId, wrong.branch]));
      }
      // Hostile records: an unreadable `since` sorts last; a queue of a project string the caller has no right on is not looked at; an entry list with a first place of another task than the front mark uses the entry's time.
      const b = await r.project("Birch"); const qb = await r.queued(b);
      const qbRec = (await r.queue.queuesWithEntries()).queues.find((q) => q.projectId === b)!;
      const qaRec = real[0]!;
      const order = await new IntegratorPool(r.leases, r.leaseOps, walk([{ ...qaRec, front: { taskId: qaRec.entries[0]!.taskId, since: "not a time" } }, qbRec, { ...qbRec, projectId: "proj-elsewhere" }], false), { landingBranch: r.landingBranch }).next(ivy, { commandId: "p7", ttlMs: 10 * MIN });
      assert.deepEqual(order.outcome === "taken" ? [order.projectId, order.taskId] : order, [b, qb.taskId]);
      const ann = await r.person("ann", lands([a]));
      const mixed = await new IntegratorPool(r.leases, r.leaseOps, walk([{ ...qbRec }, { ...qaRec, front: { taskId: "task-someoneelse", since: "2000-01-01T00:00:00.000Z" } }], false), { landingBranch: r.landingBranch }).next(ann, { commandId: "p8", ttlMs: 10 * MIN });
      assert.deepEqual(mixed.outcome === "taken" ? [mixed.projectId, mixed.waitingSince] : mixed, [a, qaRec.entries[0]!.queuedAt], "the front mark of another task is not used; b is not ann's");
    } finally { await r.close(); }
  });
}
