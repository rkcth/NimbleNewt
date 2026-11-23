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
// Card P10, twelfth slice: an APPROVED first place that holds the branch past the defer bound is moved to the back (`LandingQueueOps.#deferFirst`, `LandingQueueService.deferFirst`). The rig is the eleventh slice's (a landing was asked for
// behind the place. The rig is the tenth slice's, with a landing branch each task is judged on.

const MIN = 60_000;
const oid = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => { const a = "abcdefghijklmnopqrstuvwxyz234567"; let s = ""; for (let i = 0, v = n; i < 20; i++, v = Math.floor(v / 32)) s += a[v % 32]; return `sbm-${s}`; };
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
type Told = { commandId: string; taskId: string; branch: string; why: "front" | "round" | "returns" | "unassigned" | "released" | "deferred"; text: string };

for (const backend of backends) {
  const rig = async (o: { cap?: number | (() => Promise<number>); holdMs?: number; releaseMs?: number; deferMs?: number; sweepPolicyReads?: number; gate?: (call: WorkspaceCall) => Promise<void> } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval>();
    /** Submissions whose approval cannot be read. */
    const unreadable = new Set<string>();
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
      approvalOf: async (id) => { if (unreadable.has(id)) throw new Error("the review could not be read"); return approvals.get(id); },
      landingBranch: async ({ taskId }) => { policyReads.count++; const b = branches.get(taskId) ?? "main"; if (b === "!") throw new Error("the landing settings could not be read"); return b === "-" ? undefined : b; },
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
      refreshCap: typeof cap === "function" ? cap : async () => cap ?? 3,
      isDirector: async (by) => directors.has(by.id),
      escalate: async (n) => { if (failing.escalations > 0) { failing.escalations--; throw new Error("the owner could not be told"); } told.push({ commandId: n.commandId, taskId: n.taskId, branch: n.branch, why: n.why, text: n.text }); },
      ...(o.holdMs === undefined ? {} : { holdMs: o.holdMs }),
      ...(o.releaseMs === undefined ? {} : { releaseMs: o.releaseMs }),
      ...(o.deferMs === undefined ? {} : { deferMs: o.deferMs }),
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
    /** Called after each read of a task's open-request record by the landing (the workspace service), to act at that exact moment. */
    const hooks: { openRead?: ((taskId: string) => Promise<void>) | undefined } = {};
    const watched = new Proxy(w.storage, { get: (target, p) => {
      if (p === "getAggregate") return async (ref: { kind: string; id: string }) => { const found = await target.getAggregate(ref); if (ref.kind === "workspace-open") await hooks.openRead?.(ref.id); return found; };
      const v = Reflect.get(target, p, target) as unknown;
      return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
    } });
    const svc = WorkspaceOpService.withEpoch(watched, w.epoch, {
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
      store, w, ops, queue, holders, unreadable, hooks, approvals, options, policyReads, retired, tells, person, task, branches, submit, takeBack, told, failing, directors, lander, list, calls,
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
  const deferred = (r: Awaited<ReturnType<typeof rig>>) => r.told.filter((t) => t.why === "deferred");
  /** Two tasks approved on `branch`, t1 first and t2 behind it; the clock is the rig's. */
  const two = async (r: Awaited<ReturnType<typeof rig>>, tag = "", branch = "main") => {
    const [t1, t2] = [await r.task(`one${tag}`), await r.task(`two${tag}`)];
    r.branches.set(t1, branch); r.branches.set(t2, branch);
    const s1 = r.submit(t1, r.head());
    await r.ops.queueApproved(s1, `d1${tag}`);
    r.w.clock.advance(1); // t2 is queued after t1 (a move needs newer work waiting behind)
    const s2 = r.submit(t2, r.head());
    await r.ops.queueApproved(s2, `d2${tag}`);
    return { t1, t2, s1, s2 };
  };

  test(`${backend.name}: an approved first place held for the defer bound is moved to the back by the controller's round, exactly at the bound, once, and nothing is removed (card P10, twelfth slice)`, async () => {
    const r = await rig({ holdMs: 4 * HOUR, deferMs: 24 * HOUR });
    try {
      const { t1, t2, s1, s2 } = await two(r);
      r.holders.set(t1, { kind: "agent", id: "ann" });
      const before = (await r.list()).items.find((e) => e.taskId === t1)!;
      r.w.clock.advance(24 * HOUR - MIN);
      const early = await r.ops.sweepBounds();
      assert.deepEqual(early, { checked: 1, released: 0, partial: false }, "a minute under the bound moves nothing (the director is told at four hours as before)");
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2]]);
      assert.equal(deferred(r).length, 0);
      r.w.clock.advance(MIN);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 0, partial: false, deferred: 1 });
      const after = await r.list();
      assert.deepEqual(await r.queued(), [[1, t2], [2, t1]]);
      assert.equal(after.front?.taskId, t2, "the next task is first now, with its own count");
      const moved = after.items.find((e) => e.taskId === t1)!;
      assert.deepEqual([moved.submissionId, moved.base, moved.tree, moved.author, moved.queuedAt, moved.queuedBy], [s1, before.base, before.tree, before.author, before.queuedAt, before.queuedBy], "the approved work is unchanged");
      assert.ok(moved.seq > after.items.find((e) => e.taskId === t2)!.seq);
      assert.equal(after.items.find((e) => e.taskId === t2)!.submissionId, s2);
      assert.deepEqual(deferred(r).map((t) => t.taskId), [t1], "the director and the owner are told once");
      assert.match(deferred(r)[0]!.text, /moved it to the back of the queue/);
      assert.deepEqual(r.tells.map((t) => [t.taskId, t.to]), [[t1, "ann"]], "the task's holder is told once");
      assert.equal(r.calls.length, 0, "nothing was landed");
      // The move is one audit entry with the task, the submission and both places.
      const audits = (await r.w.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "landing.queue.defer");
      assert.equal(audits.length, 1);
      assert.deepEqual([audits[0]!.detail["taskId"], audits[0]!.detail["submissionId"], audits[0]!.detail["deferred"], audits[0]!.detail["from"], moved.seq === audits[0]!.detail["to"]], [t1, s1, true, before.seq, true]);
      // Later rounds do nothing: the new first place has held the branch for no time, and the moved work is behind it.
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false });
      assert.equal(deferred(r).length, 1);
      assert.equal(r.tells.length, 1);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a landing asked for behind an approved first place past the bound moves it to the back and goes ahead in the same call; a landing of the first place itself moves nothing (card P10, twelfth slice)`, async () => {
    const r = await rig({ deferMs: 24 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2, s2 } = await two(r);
      const land = await r.lander(ivy, t2);
      r.w.clock.advance(24 * HOUR - MIN);
      await refuses("invalid_transition", () => land(t2), /lands first/);
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2]], "under the bound the refusal stands");
      r.w.clock.advance(MIN);
      const out = await land(t2);
      assert.equal(out.state, "done", JSON.stringify(out));
      assert.equal(r.calls.length, 1);
      assert.equal(r.calls[0]!.submission!.id, s2);
      assert.deepEqual(await r.queued(), [[1, t1]], "the moved work is still queued and first again");
      assert.deepEqual(deferred(r).map((t) => t.taskId), [t1]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: nothing is moved or told while nothing waits behind the approved first place, or only work that is judged on another branch, or when no landing branch can be read (card P10, twelfth slice)`, async () => {
    const r = await rig({ deferMs: 24 * HOUR });
    try {
      const t1 = await r.task("alone");
      await r.ops.queueApproved(r.submit(t1, r.head()), "a1");
      r.w.clock.advance(72 * HOUR);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false });
      assert.deepEqual([...(await r.queued())], [[1, t1]]);
      // A task behind it whose own landing branch is another one does not count as waiting here.
      const t2 = await r.task("elsewhere");
      r.branches.set(t2, "release-2");
      await r.ops.queueApproved(r.submit(t2, r.head()), "a2").catch(() => undefined);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false });
      assert.equal(r.told.length, 0);
      // A branch that cannot be read, or names none, does not count either (fail closed).
      r.branches.set(t2, "!");
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false });
      r.branches.set(t2, "-");
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 0, released: 0, partial: false });
      assert.deepEqual((await r.list()).items.map((e) => e.taskId)[0], t1);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a landing on its way to the host keeps the first place where it is; once it ends the next round moves nothing that landed (card P10, twelfth slice)`, async () => {
    let atHost: () => void = () => undefined, release: () => void = () => undefined;
    const reached = new Promise<void>((res) => { atHost = res; });
    const blocked = new Promise<void>((res) => { release = res; });
    let first = true;
    const r = await rig({ deferMs: 24 * HOUR, gate: async () => { if (first) { first = false; atHost(); await blocked; } } });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2 } = await two(r);
      const land = await r.lander(ivy, t1);
      const one = land(t1);
      await reached;
      r.w.clock.advance(48 * HOUR);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 0, partial: false }, "the landing at the host holds the place");
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2]]);
      assert.equal(deferred(r).length, 0);
      release();
      assert.equal((await one).state, "done");
      assert.deepEqual(await r.queued(), [[1, t2]]);
    } finally { release(); await r.close(); }
  });

  test(`${backend.name}: the move is judged inside the queue's own write: a stale first place, another submission, a time not up, nobody behind and a repeat each move nothing; a reserved task keeps its reservation on its new number (card P10, twelfth slice)`, async () => {
    const r = await rig({ cap: 2 });
    try {
      const { t1, t2, s1, s2 } = await two(r);
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 }), "reserved");
      const front = (await r.queue.get(r.w.project, "main")).front!;
      const call = { projectId: r.w.project, branch: "main", taskId: t1, submissionId: s1, since: front.since, olderThanMs: 24 * HOUR, waiting: s2 };
      assert.equal(await r.queue.deferFirst(call), undefined, "the time is not up");
      r.w.clock.advance(24 * HOUR);
      assert.equal(await r.queue.deferFirst({ ...call, submissionId: s2 }), undefined, "another submission than the first entry");
      assert.equal(await r.queue.deferFirst({ ...call, taskId: t2 }), undefined, "another task than the first");
      assert.equal(await r.queue.deferFirst({ ...call, since: "2000-01-01T00:00:00.000Z" }), undefined, "a first place that is not the one judged");
      assert.equal(await r.queue.deferFirst({ ...call, waiting: s1 }), undefined, "the waiting work named is the first task's own");
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2]]);
      const moved = await r.queue.deferFirst(call);
      assert.ok(moved !== undefined);
      assert.equal(moved.entry.submissionId, s1);
      const q = await r.queue.get(r.w.project, "main");
      assert.deepEqual(q.entries.map((e) => e.taskId), [t2, t1]);
      assert.equal(q.reservations?.find((x) => x.taskId === t1)?.seq, moved.seq, "the reservation follows its task's number");
      assert.equal(q.entries.find((e) => e.taskId === t1)?.seq, moved.seq);
      assert.equal(q.nextSeq, moved.seq + 1);
      assert.equal(await r.queue.deferFirst(call), undefined, "a repeat of the same move moves nothing more");
      assert.deepEqual((await r.queue.get(r.w.project, "main")).entries.map((e) => e.taskId), [t2, t1]);
      // The moved entry was queued before the new first one: named as the waiting work, the write refuses to move it back (no endless swap).
      const back = (await r.queue.get(r.w.project, "main")).front!;
      r.w.clock.advance(48 * HOUR);
      assert.equal(await r.queue.deferFirst({ projectId: r.w.project, branch: "main", taskId: t2, submissionId: s2, since: back.since, olderThanMs: 24 * HOUR, waiting: s1 }), undefined, "work moved behind it does not move it back");
      assert.deepEqual((await r.queue.get(r.w.project, "main")).entries.map((e) => e.taskId), [t2, t1]);
      // Nobody behind a first place: nothing to move.
      await r.ops.remove(r.w.owner, { commandId: "rm-t1", taskId: t1, reason: "out" });
      const f2 = (await r.queue.get(r.w.project, "main")).front!;
      r.w.clock.advance(48 * HOUR);
      assert.equal(await r.queue.deferFirst({ projectId: r.w.project, branch: "main", taskId: t2, submissionId: s2, since: f2.since, olderThanMs: 24 * HOUR, waiting: s2 }), undefined, "nothing waits behind it");
    } finally { await r.close(); }
  });

  test(`${backend.name}: a notice that could not be given does not undo the move, and a record from before the round (no deferMs read) is unchanged by a view (card P10, twelfth slice)`, async () => {
    const r = await rig({ deferMs: 24 * HOUR });
    try {
      const { t1, t2 } = await two(r);
      r.failing.escalations = 1;
      r.w.clock.advance(24 * HOUR);
      assert.deepEqual(await r.ops.sweepBounds(), { checked: 1, released: 0, partial: false, deferred: 1 });
      assert.deepEqual(await r.queued(), [[1, t2], [2, t1]]);
      const view = await r.list();
      assert.equal((view.front as { deferMs?: number }).deferMs, 24 * HOUR);
      const rev = (await r.queue.get(r.w.project, "main")).revision;
      await r.list(); await r.list();
      assert.equal((await r.queue.get(r.w.project, "main")).revision, rev, "a read writes nothing");
    } finally { await r.close(); }
  });

  test(`${backend.name}: review: two approved tasks that both do not land change places once, not every day; newer work queued later moves the first place again (card P10, twelfth slice review)`, async () => {
    const r = await rig({ deferMs: 24 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2 } = await two(r);
      r.w.clock.advance(24 * HOUR);
      assert.equal((await r.ops.sweepBounds()).deferred, 1);
      assert.deepEqual(await r.queued(), [[1, t2], [2, t1]]);
      // t1 was queued before t2: it waits behind t2 now, but it does not move t2 back, however long t2 holds the branch.
      for (let day = 0; day < 4; day++) {
        r.w.clock.advance(24 * HOUR);
        assert.equal((await r.ops.sweepBounds()).deferred, undefined, `day ${day}`);
      }
      assert.deepEqual(await r.queued(), [[1, t2], [2, t1]]);
      assert.equal(deferred(r).length, 1, "one notice for the one move");
      // A landing asked for by the moved task is refused as before and moves nothing.
      const land = await r.lander(ivy, t1);
      await refuses("invalid_transition", () => land(t1), /lands first/);
      assert.deepEqual(await r.queued(), [[1, t2], [2, t1]]);
      // Work queued after t2 does ask for the move: t2 goes to the back, behind it.
      const t3 = await r.task("three");
      r.w.clock.advance(1);
      await r.ops.queueApproved(r.submit(t3, r.head()), "d3");
      assert.equal((await r.ops.sweepBounds()).deferred, 1);
      assert.deepEqual((await r.queued()).map((x) => x[1]), [t1, t3, t2]);
      assert.deepEqual(deferred(r).map((t) => t.taskId), [t1, t2]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: review: work behind the first place moves it only while that work is still approved for the base and tree it was queued with; an approval that cannot be read moves nothing (card P10, twelfth slice review)`, async () => {
    const r = await rig({ deferMs: 24 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2, s2 } = await two(r);
      r.w.clock.advance(24 * HOUR);
      const approved = r.approvals.get(s2)!;
      r.takeBack(s2);
      assert.equal((await r.ops.sweepBounds()).deferred, undefined, "taken back");
      r.approvals.set(s2, { ...approved, tree: oid(7) });
      assert.equal((await r.ops.sweepBounds()).deferred, undefined, "approved for another tree");
      r.approvals.set(s2, approved);
      r.unreadable.add(s2);
      assert.equal((await r.ops.sweepBounds()).deferred, undefined, "unreadable");
      const land = await r.lander(ivy, t2);
      await refuses("invalid_transition", () => land(t2), /lands first/);
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2]]);
      assert.equal(deferred(r).length, 0);
      r.unreadable.delete(s2);
      assert.equal((await r.ops.sweepBounds()).deferred, 1, "readable and approved again");
      assert.deepEqual(await r.queued(), [[1, t2], [2, t1]]);
    } finally { await r.close(); }
  });

  test(`${backend.name}: review: race: a move that read the first task's open-request record before that task's landing started is built again and moves nothing; the landing goes on (card P10, twelfth slice review)`, async () => {
    let atHost: () => void = () => undefined, release: () => void = () => undefined;
    const reached = new Promise<void>((res) => { atHost = res; });
    const blocked = new Promise<void>((res) => { release = res; });
    let gated = true;
    const r = await rig({ deferMs: 24 * HOUR, gate: async () => { if (gated) { gated = false; atHost(); await blocked; } } });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2, s1, s2 } = await two(r);
      r.w.clock.advance(24 * HOUR);
      // The move's first read of task one's open-request record (there is none yet) is held until the landing of task one is at the host. Each side waits for the other's step, no sleeps.
      let readOpen!: () => void, letGo!: () => void;
      const opened = new Promise<void>((res) => { readOpen = res; });
      const go = new Promise<void>((res) => { letGo = res; });
      let holding = true;
      const held = new Proxy(r.w.storage, { get: (target, p) => {
        if (p === "getAggregate") return async (ref: { kind: string; id: string }) => { const found = await target.getAggregate(ref); if (holding && ref.kind === "workspace-open" && ref.id === t1) { holding = false; readOpen(); await go; } return found; };
        const v = Reflect.get(target, p, target) as unknown;
        return typeof v === "function" ? (v as (...a: unknown[]) => unknown).bind(target) : v;
      } });
      const front = (await r.queue.get(r.w.project, "main")).front!;
      const moving = LandingQueueService.withEpoch(held, r.w.epoch, r.options).deferFirst({ projectId: r.w.project, branch: "main", taskId: t1, submissionId: s1, since: front.since, olderThanMs: 24 * HOUR, waiting: s2 }).then((v) => v, (e: unknown) => e);
      await opened;
      const land = await r.lander(ivy, t1);
      const one = land(t1);
      await reached;
      letGo();
      assert.equal(await moving, undefined, "the move met the record the landing wrote, was built again and found the landing at the host");
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2]]);
      release();
      assert.equal((await one).state, "done");
      assert.deepEqual(await r.queued(), [[1, t2]]);
      assert.equal(deferred(r).length, 0);
      assert.equal((await r.w.storage.listAudit({ afterSeq: 0, limit: 1000 })).filter((a) => a.type === "landing.queue.defer").length, 0);
    } finally { release(); await r.close(); }
  });

  test(`${backend.name}: review: race: a move that commits while the first task's landing is being recorded wins, and the landing, its start built again, stops before the host is asked (card P10, twelfth slice review)`, async () => {
    const r = await rig({ deferMs: 24 * HOUR });
    try {
      const ivy = await r.person("ivy");
      const { t1, t2, s1, s2 } = await two(r);
      r.w.clock.advance(24 * HOUR);
      const front = (await r.queue.get(r.w.project, "main")).front!;
      // The landing reads task one's open-request record twice before it writes; right after the second read the move commits (it rewrites that record).
      let reads = 0, moved: unknown;
      r.hooks.openRead = async (id) => { if (id === t1 && ++reads === 2) moved = await r.queue.deferFirst({ projectId: r.w.project, branch: "main", taskId: t1, submissionId: s1, since: front.since, olderThanMs: 24 * HOUR, waiting: s2 }); };
      const land = await r.lander(ivy, t1);
      const out = await land(t1);
      r.hooks.openRead = undefined;
      assert.ok(moved !== undefined, "the move went ahead (the landing was not recorded yet)");
      assert.ok(reads >= 3, "the landing's start was built again after the move");
      assert.equal(out.state, "refused", out.summary);
      assert.match(out.summary ?? "", /no longer the oldest approved one in the landing queue, so nothing was landed/);
      assert.equal(r.calls.length, 0, "no host was asked");
      assert.deepEqual(await r.queued(), [[1, t2], [2, t1]]);
    } finally { await r.close(); }
  });
}
