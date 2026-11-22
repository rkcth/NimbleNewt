import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceOutcome } from "../workspace-ops/index.js";
import { IntegratorLeaseOps, IntegratorLeaseService, LANDING_QUEUE_LIMITS, LandingQueueOps, LandingQueueService, frontOf, type QueueApproval } from "./index.js";

after(stopServer);
// Card P10, eighth slice: a reserved place whose work was returned to its author (no approved entry) holds the branch only for a bound (`releaseMs`, twelve hours counted from when it last had no approved entry). Then
// the controller ends the reservation, inside the queue's own write, tells the task's holder, the director and the owner, and the landing that waited goes on in the same call. No submission waits forever.


// Card P10: after the refresh-round cap a task's place in the landing queue is reserved (it keeps its turn while it has no approved entry, and while that place is first nothing else lands); a reserved
// task that needs yet another round, and a first place that holds the branch too long while other work waits, are told to the director once; and under steady load no submission waits forever.
const MIN = 60_000;
const oid = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => { const a = "abcdefghijklmnopqrstuvwxyz234567"; let s = ""; for (let i = 0, v = n; i < 20; i++, v = Math.floor(v / 32)) s += a[v % 32]; return `sbm-${s}`; };
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
type Told = { commandId: string; taskId: string; branch: string; why: "front" | "round" | "returns" | "unassigned" | "released"; text: string };

for (const backend of backends) {
  const rig = async (o: { cap?: number | (() => Promise<number>); holdMs?: number; releaseMs?: number; gate?: (call: WorkspaceCall) => Promise<void> } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval>();
    const told: Told[] = [];
    const directors = new Set<string>();
    const cap = o.cap;
    /** While positive, an escalation fails (the owner could not be told) after it was asked; each failure counts down. */
    const failing = { escalations: 0 };
    const holders = new Map<string, { kind: string; id: string }>();
    const retired = new Set<string>();
    const tells: { taskId: string; to: string; text: string; purpose?: string }[] = [];
    const queue = LandingQueueService.withEpoch(w.storage, w.epoch, options);
    const ops = new LandingQueueOps(queue, {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async () => "main",
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
      refreshCap: typeof cap === "function" ? cap : async () => cap ?? 3,
      isDirector: async (by) => directors.has(by.id),
      escalate: async (n) => { if (failing.escalations > 0) { failing.escalations--; throw new Error("the owner could not be told"); } told.push({ commandId: n.commandId, taskId: n.taskId, branch: n.branch, why: n.why, text: n.text }); },
      ...(o.holdMs === undefined ? {} : { holdMs: o.holdMs }),
      ...(o.releaseMs === undefined ? {} : { releaseMs: o.releaseMs }),
      holderOf: async (t) => holders.get(t),
      activeAgent: async (id) => !retired.has(id),
      tell: async (n) => { tells.push({ taskId: n.taskId, to: n.to, text: n.text, ...(n.purpose === undefined ? {} : { purpose: n.purpose }) }); },
    });
    const leaseOps = new IntegratorLeaseOps(IntegratorLeaseService.withEpoch(w.storage, w.epoch, options), { landingBranch: async () => "main" });
    const person = async (name: string, grants = [{ action: "integration.lease", project: w.project }, { action: "workspace.manage", project: w.project }]): Promise<Principal> => {
      await w.principals.enroll(w.owner, { commandId: `en-${name}`, kind: "agent", name, grants });
      return w.principals.authenticate((await w.principals.issueCredential(w.owner, `agent:${name}`)).token);
    };
    const task = async (title: string): Promise<string> => (await w.projects.createTask({ commandId: `task-${title}`, actor: w.owner.id, projectId: w.project, title })).id;
    let nextSbm = 1;
    /** A code submission of task `t` on `base`, approved or not, as `SubmissionService.approvalOf` answers it. */
    const submit = (t: string, base: string, approved = true, author = "agent:ann"): string => { const id = sbm(nextSbm++); approvals.set(id, { taskId: t, projectId: w.project, base, tree: oid(100_000 + nextSbm), submittedBy: author, approved, ...(approved ? {} : { reason: "its newest review says changes" }) }); return id; };
    const takeBack = (id: string): void => { approvals.set(id, { ...approvals.get(id)!, approved: false, reason: "its newest review says changes" }); };
    // The landing branch's head as the host sees it: a landing lands only on its approved base.
    let head = oid(1), commits = 1;
    const calls: WorkspaceCall[] = [];
    const host = async (call: WorkspaceCall): Promise<WorkspaceOutcome> => {
      calls.push(call);
      await o.gate?.(call);
      const s = call.submission!;
      if (s.base !== head) return { ok: false, reason: `submission ${s.id} was approved on ${s.base.slice(0, 12)} but the landing branch is at ${head.slice(0, 12)}` };
      head = oid(++commits);
      return { ok: true, summary: "landed", detail: { landed: true, changed: true, written: 1, submission: s.id, base: s.base, tree: s.tree } };
    };
    const svc = WorkspaceOpService.withEpoch(w.storage, w.epoch, {
      quiesce: { around: async (_scope, _op, run) => run({ attempts: [] } as never) },
      portOf: async () => ({ run: host }),
      landingLease: (by, call) => leaseOps.checkLanding(by, { ...call, branch: "main" }),
      landingQueue: { check: (by, call) => ops.checkLanding(by, call), landedChanges: (p, b, s) => ops.landedChanges(p, b, s) },
    }, options);
    let landings = 0;
    let last: { leaseId: string; fence: number } | undefined;
    const lander = async (by: Principal, holderTask: string) => {
      // A lease is asked for again at each landing (the clock moves by many hours, and a lease lasts at most a day).
      return async (taskId: string) => {
        if (last !== undefined) await leaseOps.release(by, { commandId: `unlease-${++landings}`, leaseId: last.leaseId, fence: last.fence }).catch(() => undefined);
        const lease = last = await leaseOps.acquire(by, { commandId: `lease-${++landings}`, taskId: holderTask, branch: "main", ttlMs: 20 * 60 * MIN });
        return svc.request(by, { commandId: `land-${landings}`, operation: "landing", taskId, reason: "land it", leaseId: lease.leaseId, fence: lease.fence } as never);
      };
    };
    const list = () => ops.list(w.owner, { projectId: w.project });
    return {
      store, w, ops, queue, holders, retired, tells, person, task, submit, takeBack, told, failing, directors, lander, list, calls,
      head: () => head,
      queued: async () => (await list()).items.map((e) => [e.position, e.taskId]),
      close: () => store.close(),
    };
  };

  const HOUR = 60 * MIN;
  /** Two tasks: t1 reserved at the cap and then withdrawn (a reserved place with no approved entry, first), t2 queued approved behind it. */
  const reservedAway = async (r: Awaited<ReturnType<typeof rig>>) => {
    const [t1, t2] = [await r.task("one"), await r.task("two")];
    const s1 = r.submit(t1, r.head());
    await r.ops.queueApproved(s1, "rv1");
    await r.ops.queueApproved(r.submit(t2, r.head()), "rv2");
    assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 }), "reserved");
    r.takeBack(s1);
    assert.equal(await r.ops.withdrawUnapproved(s1, "rv3"), true);
    return { t1, t2, s1 };
  };

  test(`${backend.name}: a reserved place with no approved entry holds the branch for the bound, then is ended and the waiting landing goes on in the same call (card P10, eighth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2 } = await reservedAway(r);
      const land = await r.lander(ivy, t2);
      const waiting = (await r.list()).front!;
      assert.deepEqual([waiting.taskId, waiting.waitingForApproval, typeof waiting.idleSince], [t1, true, "string"]);
      // A write to the queue meanwhile (another task queued behind) does not restart the bound.
      r.w.clock.advance(6 * HOUR);
      const t3 = await r.task("three");
      await r.ops.queueApproved(r.submit(t3, oid(2)), "rv9"); // approved on the head after t2 lands
      r.w.clock.advance(6 * HOUR - MIN);
      await refuses("invalid_transition", () => land(t2), /holds the first place \(reserved/);
      assert.deepEqual((await r.list()).reservations.map((x) => x.taskId), [t1], "not yet: under the bound");
      assert.equal(r.calls.length, 0);
      r.w.clock.advance(MIN);
      const out = await land(t2);
      assert.equal(out.state, "done", out.summary);
      assert.equal(r.calls.length, 1);
      const after = await r.list();
      assert.deepEqual([after.reservations, after.items.map((e) => e.taskId), after.front?.taskId], [[], [t3], t3]);
      // The director and the owner are told once (the four-hour notice of the first place came first), and the text says what happens to the work.
      const released = r.told.filter((t) => t.why === "released");
      assert.deepEqual(released.map((t) => t.taskId), [t1]);
      assert.match(released[0]!.text, new RegExp(`Task ${t1}'s reserved place in the landing queue of branch main was released: it had no approved submission for at least 12 h`));
      // The task's refreshed work, approved later, takes its turn at the back.
      const s1b = r.submit(t1, r.head());
      await r.ops.queueApproved(s1b, "rv4");
      assert.deepEqual(await r.queued(), [[1, t3], [2, t1]]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: the bound counts from when the place last had no approved entry, and approved work coming back restarts it (card P10, eighth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR, holdMs: 100 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      // t1's approved entry was first for a day on a base the branch is not at (it cannot land): that time is not idle time.
      const s1 = r.submit(t1, oid(999));
      await r.ops.queueApproved(s1, "rv1");
      await r.ops.queueApproved(r.submit(t2, r.head()), "rv2");
      assert.equal((await r.list()).front!.idleSince, undefined, "an approved entry is not idle");
      await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 });
      r.w.clock.advance(24 * HOUR);
      r.takeBack(s1);
      assert.equal(await r.ops.withdrawUnapproved(s1, "rv3"), true);
      const land = await r.lander(ivy, t2);
      await refuses("invalid_transition", () => land(t2), /holds the first place/);
      assert.deepEqual((await r.list()).reservations.map((x) => x.taskId), [t1], "a day first as an entry is not twelve hours idle");
      // The queue's own write judges it the same way (a caller that read an old front cannot end the place).
      assert.equal(await r.queue.releaseIdle({ projectId: r.w.project, branch: "main", taskId: t1, since: (await r.list()).front!.since, olderThanMs: 12 * HOUR }), undefined);
      // Idle for 11 h, then approved work comes back (the entry takes the reserved place), then it is withdrawn again: the bound starts over.
      r.w.clock.advance(11 * HOUR);
      const s1b = r.submit(t1, oid(998));
      await r.ops.queueApproved(s1b, "rv4");
      assert.equal((await r.list()).front!.idleSince, undefined);
      r.takeBack(s1b);
      assert.equal(await r.ops.withdrawUnapproved(s1b, "rv5"), true);
      r.w.clock.advance(11 * HOUR);
      await refuses("invalid_transition", () => land(t2), /holds the first place/);
      assert.equal(r.told.filter((t) => t.why === "released").length, 0);
      r.w.clock.advance(HOUR);
      assert.equal((await land(t2)).state, "done");
      assert.equal(r.told.filter((t) => t.why === "released").length, 1);
    } finally { await r.close(); }
  });

  test(`${backend.name}: the release is judged inside the queue's write: a stale read, a take-out, returned approved work and a double release change nothing wrongly (card P10, eighth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const { t1, t2 } = await reservedAway(r);
      const since = (await r.list()).front!.since;
      const ask = (taskId = t1, at = since, ms = 12 * HOUR) => r.queue.releaseIdle({ projectId: r.w.project, branch: "main", taskId, since: at, olderThanMs: ms });
      r.w.clock.advance(12 * HOUR);
      assert.equal(await ask(t2), undefined, "a task that is not first");
      assert.equal(await ask(t1, "2000-01-01T00:00:00.000Z"), undefined, "a first place that is no longer the one that was read");
      assert.equal(await ask(t1, since, 13 * HOUR), undefined, "the stored time decides, not the caller's");
      // Approved work came back between the caller's read and its write: the entry is the place, nothing is ended.
      const s1b = r.submit(t1, oid(998));
      await r.ops.queueApproved(s1b, "rv4");
      assert.equal(await ask(), undefined);
      assert.deepEqual((await r.list()).reservations.map((x) => x.taskId), [t1]);
      r.takeBack(s1b);
      assert.equal(await r.ops.withdrawUnapproved(s1b, "rv5"), true);
      r.w.clock.advance(12 * HOUR);
      const since2 = (await r.list()).front!.since;
      // Taken out by the director at that moment: the release finds nothing.
      await r.ops.remove(r.w.owner, { commandId: "out", taskId: t1, reason: "the director decided" });
      assert.equal(await ask(t1, since2), undefined);
      // Two releases of a place at the same moment (two landings waiting): one ends it.
      await r.ops.remove(r.w.owner, { commandId: "out2", taskId: t2, reason: "the director decided" });
      await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 });
      const s1c = r.submit(t1, oid(997));
      await r.ops.queueApproved(s1c, "rv6");
      r.takeBack(s1c);
      assert.equal(await r.ops.withdrawUnapproved(s1c, "rv7"), true);
      const front = (await r.list()).front!;
      assert.equal(front.taskId, t1);
      r.w.clock.advance(12 * HOUR);
      const both = await Promise.all([ask(t1, front.since), ask(t1, front.since)]);
      assert.equal(both.filter((x) => x !== undefined).length, 1);
      assert.deepEqual((await r.list()).reservations, []);
    } finally { await r.close(); }
  });

  test(`${backend.name}: two landings waiting behind a silent reserved place both go on after one release, and the notice is given once (card P10, eighth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t2 } = await reservedAway(r);
      const t3 = await r.task("three");
      await r.ops.queueApproved(r.submit(t3, oid(2)), "rv9"); // approved on the head after t2 lands
      const landIvy = await r.lander(ivy, t2);
      r.w.clock.advance(13 * HOUR);
      // Both ask at once; the first place was ended by one of them and the other judges the queue as it is then (it is the oldest now, the other the second).
      const results = await Promise.allSettled([landIvy(t2), landIvy(t3)]);
      const done = results.filter((x) => x.status === "fulfilled" && (x.value as { state: string }).state === "done").length;
      assert.ok(done >= 1, JSON.stringify(results.map((x) => (x.status === "fulfilled" ? x.value : String(x.reason)))));
      assert.equal(r.told.filter((t) => t.why === "released").length, 1);
      // Whichever of the two went first, the other lands next: nothing is left holding the branch.
      if (r.calls.length === 1) assert.equal((await landIvy(t3)).state, "done");
      assert.equal(r.calls.length, 2);
      assert.deepEqual((await r.list()).items, []);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a landing that loses the race to another release judges the queue again and goes on (card P10, eighth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2 } = await reservedAway(r);
      const original = r.queue.releaseIdle.bind(r.queue);
      // Another landing ends the place first, in the instant between this landing's read and its release.
      r.queue.releaseIdle = async (c) => { await original(c); return original(c); };
      r.w.clock.advance(12 * HOUR);
      const land = await r.lander(ivy, t2);
      const out = await land(t2);
      assert.equal(out.state, "done", out.summary);
      assert.deepEqual((await r.list()).reservations.map((x) => x.taskId).filter((x) => x === t1), []);
    } finally { await r.close(); }
  });

  test(`${backend.name}: the reserved task's own landing and a landing with nothing behind are not releases; a notice that fails or a task nobody holds still ends the place; the holder is told (card P10, eighth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const ivy = await r.person("ivy"), ann = await r.person("ann", []);
      const { t1, t2 } = await reservedAway(r);
      r.holders.set(t1, { kind: "agent", id: ann.id });
      r.w.clock.advance(20 * HOUR);
      // The reserved task itself asks to land: refused as before, its place kept (only a landing BEHIND the place ends it).
      const land = await r.lander(ivy, t2);
      await refuses("invalid_transition", () => r.ops.checkLanding(ivy, { taskId: t1, projectId: r.w.project, submissionId: undefined }), /holds a reserved place/);
      assert.deepEqual((await r.list()).reservations.map((x) => x.taskId), [t1]);
      // The owner could not be told: the place is ended all the same and the landing goes on.
      r.failing.escalations = 1;
      assert.equal((await land(t2)).state, "done");
      assert.deepEqual((await r.list()).reservations, []);
      assert.deepEqual(r.tells.map((t) => [t.taskId, t.to, t.purpose]), [[t1, ann.id, "your task's reserved place in the landing queue was released"]]);
      assert.match(r.tells[0]!.text, /was released: it had no approved submission for at least 12 h/);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a retired holder is not told, nobody holding the task is not told, and a project with no notices still releases (card P10, eighth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const ivy = await r.person("ivy"), ann = await r.person("ann", []);
      const { t1, t2 } = await reservedAway(r);
      r.holders.set(t1, { kind: "agent", id: ann.id });
      r.holders.set(t2, { kind: "person", id: "pat" });
      r.retired.add(ann.id);
      r.w.clock.advance(12 * HOUR);
      const land = await r.lander(ivy, t2);
      assert.equal((await land(t2)).state, "done");
      assert.deepEqual(r.tells, []);
      assert.equal(r.told.filter((t) => t.why === "released").length, 1);
    } finally { await r.close(); }
  });

  test(`${backend.name}: under steady load no submission waits forever behind a reserved place nobody ever refreshes (card P10, eighth slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR, holdMs: 4 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const silent = await r.task("silent");
      const s0 = r.submit(silent, r.head());
      await r.ops.queueApproved(s0, "rv0");
      assert.equal(await r.ops.afterRound({ taskId: silent, projectId: r.w.project, round: 2 }), "reserved");
      r.takeBack(s0);
      assert.equal(await r.ops.withdrawUnapproved(s0, "rv0b"), true);
      const tasks: string[] = [];
      for (let i = 0; i < 6; i++) { const t = await r.task(`t${i}`); tasks.push(t); await r.ops.queueApproved(r.submit(t, oid(1 + i)), `rvq${i}`); }
      const land = await r.lander(ivy, tasks[0]!);
      let waited = 0;
      for (const t of tasks) {
        // The oldest waiting task asks; while the silent place holds the branch an hour passes between asks (no director acts).
        for (let tries = 0; ; tries++) {
          assert.ok(tries <= 13, `task ${t} waited more than 13 hours`);
          const out = await land(t).then((x) => x.state, () => "refused");
          if (out === "done") break;
          r.w.clock.advance(HOUR); waited++;
        }
      }
      assert.ok(waited <= 12, `${waited} hours in all`);
      assert.deepEqual((await r.list()).reservations, []);
      assert.equal(r.told.filter((t) => t.why === "front" && t.taskId === silent).length, 1, "the director was told at the hold time");
      assert.equal(r.told.filter((t) => t.why === "released").length, 1);
      assert.equal(r.calls.length, 6);
    } finally { await r.close(); }
  });
}
