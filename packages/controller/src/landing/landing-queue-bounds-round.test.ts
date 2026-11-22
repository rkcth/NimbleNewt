import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { CommandRunner } from "../domain/runner.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { WaitService } from "../domain/waits.js";
import { ContractService } from "../planning/contracts.js";
import { StatusService } from "../status/index.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceOutcome } from "../workspace-ops/index.js";
import { BOUNDS_SWEEP_EVERY_MS, BOUNDS_SWEEP_POLICY_READS, IntegratorLeaseOps, IntegratorLeaseService, LANDING_QUEUE_LIMITS, LandingQueueOps, LandingQueueService, frontOf, type QueueApproval } from "./index.js";

after(stopServer);
// Card P10, eleventh slice: the controller's regular round over the bounds that end a stuck first place (`LandingQueueOps.sweepBounds`). Until then both bounds were looked at only when a landing was asked for
// behind the place. The rig is the tenth slice's, with a landing branch each task is judged on.

const MIN = 60_000;
const oid = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => { const a = "abcdefghijklmnopqrstuvwxyz234567"; let s = ""; for (let i = 0, v = n; i < 20; i++, v = Math.floor(v / 32)) s += a[v % 32]; return `sbm-${s}`; };
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
type Told = { commandId: string; taskId: string; branch: string; why: "front" | "round" | "returns" | "unassigned" | "released"; text: string };

for (const backend of backends) {
  const rig = async (o: { cap?: number | (() => Promise<number>); holdMs?: number; releaseMs?: number; sweepPolicyReads?: number; gate?: (call: WorkspaceCall) => Promise<void> } = {}) => {
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
    /** The landing branch each task is judged on ("main" unless set; "!" cannot be read, "-" names none). */
    const branches = new Map<string, string>();
    const retired = new Set<string>();
    /** How many landing branches were read (a few settings reads each). */
    const policyReads = { count: 0 };
    const tells: { taskId: string; to: string; text: string; purpose?: string }[] = [];
    const queue = LandingQueueService.withEpoch(w.storage, w.epoch, options);
    const ops = new LandingQueueOps(queue, {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async ({ taskId }) => { policyReads.count++; const b = branches.get(taskId) ?? "main"; if (b === "!") throw new Error("the landing settings could not be read"); return b === "-" ? undefined : b; },
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
      refreshCap: typeof cap === "function" ? cap : async () => cap ?? 3,
      isDirector: async (by) => directors.has(by.id),
      escalate: async (n) => { if (failing.escalations > 0) { failing.escalations--; throw new Error("the owner could not be told"); } told.push({ commandId: n.commandId, taskId: n.taskId, branch: n.branch, why: n.why, text: n.text }); },
      ...(o.holdMs === undefined ? {} : { holdMs: o.holdMs }),
      ...(o.releaseMs === undefined ? {} : { releaseMs: o.releaseMs }),
      ...(o.sweepPolicyReads === undefined ? {} : { sweepPolicyReads: o.sweepPolicyReads }),
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
      store, w, ops, queue, holders, policyReads, retired, tells, person, task, branches, submit, takeBack, told, failing, directors, lander, list, calls,
      head: () => head,
      queued: async () => (await list()).items.map((e) => [e.position, e.taskId]),
      close: () => store.close(),
    };
  };

  const HOUR = 60 * MIN;
  /** Two tasks on `branch`: t1 reserved at the cap and then withdrawn (a reserved place with no approved entry, first), t2 queued approved behind it. */
  const reservedAway = async (r: Awaited<ReturnType<typeof rig>>, tag = "", branch = "main") => {
    const [t1, t2] = [await r.task(`one${tag}`), await r.task(`two${tag}`)];
    r.branches.set(t1, branch); r.branches.set(t2, branch);
    const s1 = r.submit(t1, r.head());
    await r.ops.queueApproved(s1, `rv1${tag}`);
    const s2 = r.submit(t2, r.head());
    await r.ops.queueApproved(s2, `rv2${tag}`);
    assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 }), "reserved");
    r.takeBack(s1);
    assert.equal(await r.ops.withdrawUnapproved(s1, `rv3${tag}`), true);
    return { t1, t2, s1, s2 };
  };
  const released = (r: Awaited<ReturnType<typeof rig>>) => r.told.filter((t) => t.why === "released");

  test(`${backend.name}: a reserved place idle past the bound is ended by the controller's round with nothing asking to land, once, and nothing else moves (card P10, eleventh slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const { t1, t2, s2 } = await reservedAway(r);
      r.holders.set(t1, { kind: "agent", id: "ann" });
      r.w.clock.advance(12 * HOUR - MIN);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 0, partial: false }, "a minute under the bound ends nothing");
      assert.equal((await r.list()).front?.taskId, t1);
      assert.equal(released(r).length, 0);
      r.w.clock.advance(MIN);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 1, partial: false });
      const after = await r.list();
      assert.deepEqual([after.front?.taskId, after.reservations.length, after.items.map((e) => [e.taskId, e.submissionId])], [t2, 0, [[t2, s2]]], "the waiting work is first now and still queued as approved");
      assert.deepEqual(released(r).map((t) => t.taskId), [t1]);
      assert.deepEqual(r.tells.map((t) => [t.taskId, t.to]), [[t1, "ann"]], "the task's holder was told once");
      assert.equal(r.calls.length, 0, "nothing was landed");
      // A later round finds nothing more to do (the rest of the queue is one task's approved work) and tells nobody again.
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false });
      assert.equal(released(r).length, 1);
      assert.equal(r.tells.length, 1);
      // The released task's refreshed work takes its turn at the back.
      const s3 = r.submit(t1, r.head());
      await r.ops.queueApproved(s3, "rv-back");
      assert.deepEqual(await r.queued(), [[1, t2], [2, t1]]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a round ends nothing and tells nobody while no approved work of another task waits behind the place (card P10, eleventh slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const t1 = await r.task("lonely");
      const s1 = r.submit(t1, r.head());
      await r.ops.queueApproved(s1, "lone1");
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 }), "reserved");
      r.takeBack(s1);
      assert.equal(await r.ops.withdrawUnapproved(s1, "lone2"), true);
      r.w.clock.advance(48 * HOUR);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false });
      assert.deepEqual([(await r.list()).front?.taskId, (await r.list()).reservations.length, r.told.length], [t1, 1, 0]);
      // Nothing waiting behind a first approved place either: no notice at the hold bound.
      const t2 = await r.task("also-lonely");
      r.submit(t2, r.head());
      await r.ops.remove(r.w.owner, { commandId: "end-res", taskId: t1, reason: "end" });
      await r.ops.queueApproved(r.submit(t2, r.head()), "lone3");
      r.w.clock.advance(48 * HOUR);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false });
      assert.equal(r.told.length, 0);
    } finally { await r.close(); }
  });

  test(`${backend.name}: an approved first place held past the hold bound tells the director on a round with work waiting behind it, once, and removes nothing (card P10, eleventh slice)`, async () => {
    const r = await rig({ holdMs: 4 * HOUR });
    try {
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const [s1, s2] = [r.submit(t1, r.head()), r.submit(t2, r.head())];
      await r.ops.queueApproved(s1, "h1"); await r.ops.queueApproved(s2, "h2");
      r.w.clock.advance(4 * HOUR - MIN);
      await r.ops.sweepBounds();
      assert.equal(r.told.length, 0, "a minute under the bound tells nobody");
      r.w.clock.advance(MIN);
      assert.equal((await r.ops.sweepBounds()).checked, 1);
      assert.deepEqual(r.told.map((t) => [t.why, t.taskId]), [["front", t1]]);
      assert.equal((await r.list()).front?.escalated, true);
      await r.ops.sweepBounds(); await r.ops.sweepBounds();
      assert.equal(r.told.length, 1, "told once per first place");
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2]], "both approved submissions are still queued, in order");
      assert.equal(r.calls.length, 0);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a hold notice that could not be given is not marked and is given at the next round, then once (card P10, eleventh slice)`, async () => {
    const r = await rig({ holdMs: 4 * HOUR });
    try {
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      await r.ops.queueApproved(r.submit(t1, r.head()), "f1"); await r.ops.queueApproved(r.submit(t2, r.head()), "f2");
      r.w.clock.advance(4 * HOUR);
      r.failing.escalations = 1;
      await r.ops.sweepBounds();
      assert.equal(r.told.length, 0);
      assert.equal((await r.list()).front?.escalated, undefined, "not marked: nobody was told");
      await r.ops.sweepBounds(); await r.ops.sweepBounds();
      assert.deepEqual(r.told.map((t) => t.why), ["front"]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: only the landing branch the owner's policy names now is looked at, a branch that cannot be read is skipped, and one queue does not stop another (card P10, eleventh slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const old = await reservedAway(r, "-old", "old");
      const bad = await reservedAway(r, "-bad", "feature");
      const none = await reservedAway(r, "-none", "release");
      const live = await reservedAway(r, "-live", "main");
      r.w.clock.advance(13 * HOUR);
      // The owner named another landing branch since: the old queue is no longer landed from. One queue's settings cannot be read, one names no branch.
      for (const t of [old.t1, old.t2]) r.branches.set(t, "main");
      for (const t of [bad.t1, bad.t2]) r.branches.set(t, "!");
      for (const t of [none.t1, none.t2]) r.branches.set(t, "-");
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 1, partial: false });
      assert.deepEqual(released(r).map((t) => t.taskId), [live.t1], "only the queue of the current landing branch was ended");
      for (const [branch, first] of [["old", old.t1], ["feature", bad.t1], ["release", none.t1]] as const) {
        const q = await r.queue.get(r.w.project, branch);
        assert.deepEqual([q.front?.taskId, (q.reservations ?? []).length, q.entries.length], [first, 1, 1], `the ${branch} queue is untouched`);
      }
      assert.equal(r.calls.length, 0);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a record written before the idle time existed starts its count on a round and ends nothing then (card P10, eleventh slice)`, async () => {
    // A hold bound far away: the round must find the place due for its idle count alone (second review: it reads policies only for a place past a bound).
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR, holdMs: 1_000 * HOUR });
    try {
      const { t1, t2 } = await reservedAway(r);
      const queueId = LandingQueueService.queueIdOf(r.w.project, "main");
      const runner = new CommandRunner(r.w.storage, r.w.epoch, { clock: r.w.clock.now, pause: async () => undefined });
      await runner.command("test.legacy-queue", { commandId: "legacy-queue", actor: "service:test" }, async () => ({
        payload: {},
        build: async () => {
          const current = (await runner.get("landing-queue", queueId))!;
          const body = current.body as unknown as { front: { idleSince?: string } };
          const { idleSince: _dropped, ...front } = body.front;
          const ref = { kind: "landing-queue", id: queueId };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: JSON.parse(JSON.stringify({ ...body, front })) }], detail: {} };
        },
      }));
      assert.equal((await r.list()).front?.idleSince, undefined);
      r.w.clock.advance(48 * HOUR);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 0, partial: false }, "an unknown idle time ends nothing");
      const started = (await r.list()).front?.idleSince;
      assert.ok(started !== undefined && Date.parse(started) === Date.parse(r.w.clock.now()), "the count starts now");
      assert.equal((await r.list()).front?.taskId, t1);
      r.w.clock.advance(12 * HOUR);
      assert.equal((await r.ops.sweepBounds()).released, 1);
      assert.equal((await r.list()).front?.taskId, t2);
    } finally { await r.close(); }
  });

  test(`${backend.name}: approved work coming back before the round stops the count: the round ends nothing (card P10, eleventh slice)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const { t1, t2 } = await reservedAway(r);
      r.w.clock.advance(13 * HOUR);
      // The task's refreshed work is approved just before the round: the place is an approved first place now.
      await r.ops.queueApproved(r.submit(t1, r.head()), "back");
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 0, partial: false });
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2]]);
      assert.equal(released(r).length, 0);
    } finally { await r.close(); }
  });
  test(`${backend.name}: the branch judged is the one the task waiting behind the place lands on, as at a refused landing: a waiting task whose own setting names another branch ends nothing (card P10, eleventh slice review)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      // The first place's task still lands on main, but the task waiting behind it is now judged on another branch (a task's own landing setting): no landing behind the place can be asked for on main.
      const away = await reservedAway(r, "-away", "main");
      r.w.clock.advance(13 * HOUR);
      r.branches.set(away.t2, "release");
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false });
      // A landing of that task asked for now is judged on its own branch and ends nothing either.
      assert.equal(await r.ops.checkLanding(r.w.owner, { taskId: away.t2, projectId: r.w.project, submissionId: undefined }), undefined, "judged on the empty queue of its own branch");
      const q = await r.queue.get(r.w.project, "main");
      assert.deepEqual([q.front?.taskId, (q.reservations ?? []).length, released(r).length], [away.t1, 1, 0], "the reserved place stays");
      // The other way round: the first place's own task names another branch, the waiting task lands on main: a landing asked for behind the place would end it, and so does the round.
      r.branches.set(away.t2, "main");
      r.branches.set(away.t1, "release");
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 1, partial: false });
      assert.deepEqual(released(r).map((t) => t.taskId), [away.t1]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: the dispatcher's throttled round walks the queues at most once a minute of the queue's clock, and an unthrottled call always walks (card P10, eleventh slice review)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const { t1, t2 } = await reservedAway(r);
      r.w.clock.advance(12 * HOUR - MIN);
      assert.deepEqual(await r.ops.sweepBounds({ throttled: true }), { checked: 1, released: 0, partial: false });
      r.w.clock.advance(MIN);
      // Past the release bound, but within a minute of the last walk: skipped, nothing ended.
      r.w.clock.advance(-1);
      assert.deepEqual(await r.ops.sweepBounds({ throttled: true }), { checked: 0, released: 0, partial: false, skipped: true });
      assert.equal((await r.list()).front?.taskId, t1);
      r.w.clock.advance(1);
      assert.equal(BOUNDS_SWEEP_EVERY_MS, MIN);
      assert.deepEqual(await r.ops.sweepBounds({ throttled: true }), { checked: 1, released: 1, partial: false });
      assert.equal((await r.list()).front?.taskId, t2);
      assert.deepEqual((await r.ops.sweepBounds({ throttled: true })).skipped, true, "the next tick at the same moment is skipped");
      assert.equal((await r.ops.sweepBounds()).skipped, undefined, "an unthrottled call walks");
    } finally { await r.close(); }
  });

  test(`${backend.name}: a round reads no landing policy for a first place within its bounds, and reads at most its budget of policies per walk, then stops (partial) and goes on at the next walk (card P10, eleventh slice second review)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR, holdMs: 4 * HOUR, sweepPolicyReads: 1 });
    try {
      const main = await reservedAway(r, "-m", "main");
      const dev = await reservedAway(r, "-d", "dev");
      r.w.clock.advance(4 * HOUR - MIN);
      r.policyReads.count = 0;
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false }, "both places are within both bounds");
      assert.equal(r.policyReads.count, 0, "no policy was read for a place within its bounds");
      r.w.clock.advance(9 * HOUR);
      // Both places are past the release bound; the budget of one read lets one queue be judged, then the walk stops.
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 1, partial: true });
      assert.equal(r.policyReads.count, 1);
      assert.equal(released(r).length, 1);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 1, partial: false }, "the next walk reaches the other queue (the first one has nothing due any more)");
      assert.deepEqual(released(r).map((t) => t.taskId).sort(), [main.t1, dev.t1].sort());
      assert.equal(BOUNDS_SWEEP_POLICY_READS, 1_000);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a clock set back below the throttled round's last walk walks again at once (card P10, eleventh slice second review)`, async () => {
    const r = await rig({ cap: 2, releaseMs: 12 * HOUR });
    try {
      const { t1, t2 } = await reservedAway(r);
      r.w.clock.advance(13 * HOUR);
      // A walk that ends nothing (the follower is judged on another branch for now) still counts as the last walk.
      r.branches.set(t2, "release");
      assert.deepEqual(await r.ops.sweepBounds({ throttled: true }), { checked: 0, released: 0, partial: false });
      r.branches.set(t2, "main");
      r.w.clock.advance(-HOUR);
      assert.deepEqual(await r.ops.sweepBounds({ throttled: true }), { checked: 1, released: 1, partial: false }, "a clock set back does not skip");
      assert.equal((await r.list()).front?.taskId, t2);
      assert.equal(released(r)[0]?.taskId, t1);
    } finally { await r.close(); }
  });
}
