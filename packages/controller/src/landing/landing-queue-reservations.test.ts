import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { buildWorld } from "../dispatch/testing/world.js";
import type { Principal } from "../security/principals.js";
import { WorkspaceOpService, type WorkspaceCall, type WorkspaceOutcome } from "../workspace-ops/index.js";
import { IntegratorLeaseOps, IntegratorLeaseService, LANDING_QUEUE_LIMITS, LandingQueueOps, LandingQueueService, frontOf, type QueueApproval } from "./index.js";

after(stopServer);

// Card P10, reservations: after the refresh-round cap a task's place in the landing queue is reserved (it keeps its turn while it has no approved entry, and while that place is first nothing else lands); a reserved
// task that needs yet another round, and a first place that holds the branch too long while other work waits, are told to the director once; and under steady load no submission waits forever.
const MIN = 60_000;
const oid = (n: number): string => n.toString(16).padStart(40, "0");
const sbm = (n: number): string => { const a = "abcdefghijklmnopqrstuvwxyz234567"; let s = ""; for (let i = 0, v = n; i < 20; i++, v = Math.floor(v / 32)) s += a[v % 32]; return `sbm-${s}`; };
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, match?: RegExp): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); if (match !== undefined) assert.match(error.message, match); return true; });
};
type Told = { commandId: string; taskId: string; branch: string; why: "front" | "round"; text: string };

for (const backend of backends) {
  const rig = async (o: { cap?: number | (() => Promise<number>); holdMs?: number; gate?: (call: WorkspaceCall) => Promise<void> } = {}) => {
    const store = await backend.open();
    const w = await buildWorld(store.storage);
    const options = { clock: w.clock.now, pause: async () => undefined };
    const approvals = new Map<string, QueueApproval>();
    const told: Told[] = [];
    const directors = new Set<string>();
    const cap = o.cap;
    /** While positive, an escalation fails (the owner could not be told) after it was asked; each failure counts down. */
    const failing = { escalations: 0 };
    const ops = new LandingQueueOps(LandingQueueService.withEpoch(w.storage, w.epoch, options), {
      approvalOf: async (id) => approvals.get(id),
      landingBranch: async () => "main",
      projectOfTask: async (t) => ((await w.storage.getAggregate({ kind: "task", id: t }))?.body as { projectId?: string } | undefined)?.projectId,
      refreshCap: typeof cap === "function" ? cap : async () => cap ?? 3,
      isDirector: async (by) => directors.has(by.id),
      escalate: async (n) => { if (failing.escalations > 0) { failing.escalations--; throw new Error("the owner could not be told"); } told.push({ commandId: n.commandId, taskId: n.taskId, branch: n.branch, why: n.why, text: n.text }); },
      ...(o.holdMs === undefined ? {} : { holdMs: o.holdMs }),
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
    const lander = async (by: Principal, holderTask: string) => {
      const lease = await leaseOps.acquire(by, { commandId: "lease", taskId: holderTask, branch: "main", ttlMs: 20 * 60 * MIN });
      return (taskId: string) => svc.request(by, { commandId: `land-${++landings}`, operation: "landing", taskId, reason: "land it", leaseId: lease.leaseId, fence: lease.fence } as never);
    };
    const list = () => ops.list(w.owner, { projectId: w.project });
    return {
      store, w, ops, person, task, submit, takeBack, told, failing, directors, lander, list, calls,
      head: () => head,
      queued: async () => (await list()).items.map((e) => [e.position, e.taskId]),
      close: () => store.close(),
    };
  };

  test(`${backend.name}: at the refresh-round cap a task's place is reserved; it keeps its turn when its approval is taken back, and while it is first nothing else lands (card P10, reservations)`, async () => {
    const r = await rig({ cap: 2 });
    try {
      const ivy = await r.person("ivy");
      const [t1, t2, t3] = [await r.task("one"), await r.task("two"), await r.task("three")];
      const [s1, s2] = [r.submit(t1, r.head()), r.submit(t2, r.head())];
      await r.ops.queueApproved(s1, "rv1");
      await r.ops.queueApproved(s2, "rv2");
      // Below the cap nothing is reserved; at the cap the task's place (its entry's number) is.
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 1 }), undefined);
      assert.deepEqual((await r.list()).reservations, []);
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 }), "reserved");
      const listed = await r.list();
      assert.deepEqual(listed.reservations.map((x) => [x.taskId, x.seq, x.round, x.cap]), [[t1, 1, 2, 2]]);
      assert.deepEqual(listed.items.map((e) => [e.taskId, e.reserved === true]), [[t1, true], [t2, false]]);
      assert.deepEqual([listed.front?.taskId, listed.front?.waitingForApproval], [t1, false]);
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 }), undefined, "a repeat reserves nothing more");
      // Its approval is taken back: the entry leaves, the reserved place stays first, and another task's landing is refused before any host is asked.
      r.takeBack(s1);
      assert.equal(await r.ops.withdrawUnapproved(s1, "rv3"), true);
      assert.deepEqual(await r.queued(), [[1, t2]]);
      const waiting = await r.list();
      assert.deepEqual([waiting.front?.taskId, waiting.front?.waitingForApproval], [t1, true]);
      const land = await r.lander(ivy, t2);
      await refuses("invalid_transition", () => land(t2), new RegExp(`task ${t1} holds the first place \\(reserved after its author reached the refresh-round cap\\) and waits for its approved submission`));
      await refuses("invalid_transition", () => land(t1), new RegExp(`task ${t1} holds a reserved place in the landing queue of branch main but has no approved submission there`));
      // Second review: the owner cannot land the reserved task unqueued either (the queue is not empty), and is told why.
      await refuses("invalid_transition", () => r.ops.checkLanding(r.w.owner, { taskId: t1, projectId: r.w.project, submissionId: undefined }), /holds a reserved place .* lands from that place once its submission is approved/);
      await refuses("invalid_transition", () => r.ops.checkLanding(r.w.owner, { taskId: t3, projectId: r.w.project, submissionId: undefined }), /not empty and task .* has nothing in it/);
      assert.equal(r.calls.length, 0);
      // A newer task queued meanwhile goes behind; the reserved task's re-approval takes its reserved place (first), not the back, and lands; the landing ends the reservation.
      const s3 = r.submit(t3, r.head());
      await r.ops.queueApproved(s3, "rv4");
      const s1b = r.submit(t1, r.head());
      await r.ops.queueApproved(s1b, "rv5");
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2], [3, t3]]);
      const landed = await land(t1);
      assert.equal(landed.state, "done", landed.summary);
      const afterLanding = await r.list();
      assert.deepEqual([afterLanding.reservations, afterLanding.items.map((e) => e.taskId), afterLanding.front?.taskId], [[], [t2, t3], t2]);
      assert.equal(r.told.length, 0, "nobody was told: the reservation did its work");
    } finally { await r.close(); }
  });

  test(`${backend.name}: a reserved task that needs another round is told to the director once; who may end a reservation; the cap from the project's settings (card P10, reservations)`, async () => {
    let cap = 3;
    const r = await rig({ cap: async () => { if (cap < 0) throw new Error("settings unreadable"); return cap; } });
    try {
      const ann = await r.person("ann", []), eve = await r.person("eve", []), dee = await r.person("dee", []), ivy = await r.person("ivy");
      r.directors.add(dee.id);
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      // Not queued at all: the reserved place is the next number (the back), and the task takes it when approved.
      await r.ops.queueApproved(r.submit(t2, r.head()), "rv1");
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 3 }), "reserved");
      assert.deepEqual((await r.list()).reservations.map((x) => [x.taskId, x.seq]), [[t1, 2]]);
      // Rounds beyond the cap: the director is told once, naming the task, the round and the cap.
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 3 }), undefined);
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 4 }), "escalated");
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 5 }), undefined, "told once per reservation");
      assert.deepEqual(r.told.map((t) => [t.taskId, t.why, t.branch]), [[t1, "round", "main"]]);
      assert.match(r.told[0]!.text, new RegExp(`Task ${t1} needed refresh round 4 although its place in the landing queue of branch main was reserved at round 3 \\(the cap is 3\\).*landing\\.queue\\.remove`));
      assert.equal((await r.list()).reservations[0]!.escalatedRound, 4);
      // Ending a reservation of a task with no entry: not its author (nothing of its own is queued) nor a stranger; the director may.
      await refuses("not_found", () => r.ops.remove(ann, { commandId: "x1", taskId: t1, reason: "mine" }));
      await refuses("not_found", () => r.ops.remove(eve, { commandId: "x2", taskId: t1, reason: "no" }));
      const ended = await r.ops.remove(dee, { commandId: "x3", taskId: t1, reason: "it waits for the redesign" });
      assert.deepEqual([ended.removed, ended.reservationEnded], [undefined, true]);
      assert.deepEqual((await r.list()).reservations, []);
      // The director takes an entry out too; an author taking its own entry out ends its reservation.
      assert.deepEqual((await r.ops.remove(dee, { commandId: "x4", taskId: t2, reason: "not now" })).removed?.taskId, t2);
      const s1 = r.submit(t1, r.head());
      await r.ops.add(ann, { commandId: "a1", submissionId: s1 });
      await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 3 });
      const own = await r.ops.remove(ann, { commandId: "x5", taskId: t1, reason: "I withdraw it" });
      assert.deepEqual([own.removed?.submissionId, own.reservationEnded], [s1, true]);
      assert.deepEqual([(await r.list()).items, (await r.list()).reservations], [[], []]);
      // The cap is the project's setting: 0 reserves at the first round, unreadable settings use the default of 3.
      cap = 0;
      assert.equal(await r.ops.afterRound({ taskId: t2, projectId: r.w.project, round: 1 }), "reserved");
      assert.equal((await r.ops.remove(ivy, { commandId: "x6", taskId: t2, reason: "reset" })).reservationEnded, true);
      cap = -1;
      assert.equal(await r.ops.afterRound({ taskId: t2, projectId: r.w.project, round: 2 }), undefined);
      assert.equal(await r.ops.afterRound({ taskId: t2, projectId: r.w.project, round: 3 }), "reserved");
      assert.equal((await r.list()).reservations[0]!.cap, 3);
    } finally { await r.close(); }
  });

  test(`${backend.name}: a first place that holds the branch too long while another landing waits is told to the director once (card P10, reservations)`, async () => {
    const r = await rig({ holdMs: 60 * MIN });
    try {
      const ivy = await r.person("ivy");
      const [t1, t2, t3] = [await r.task("one"), await r.task("two"), await r.task("three")];
      const s1 = r.submit(t1, oid(999)); // approved on a base the branch is not at: it cannot land until its author refreshes
      await r.ops.queueApproved(s1, "rv1");
      await r.ops.queueApproved(r.submit(t2, r.head()), "rv2");
      const since = (await r.list()).front!.since;
      const land = await r.lander(ivy, t1);
      r.w.clock.advance(59 * MIN);
      await refuses("invalid_transition", () => land(t2), /the oldest .* lands first/);
      assert.equal(r.told.length, 0, "not yet: under the hold time");
      r.w.clock.advance(1 * MIN);
      await refuses("invalid_transition", () => land(t2), /the oldest .* lands first/);
      await refuses("invalid_transition", () => land(t2), /the oldest .* lands first/);
      assert.deepEqual(r.told.map((t) => [t.taskId, t.why]), [[t1, "front"]]);
      assert.match(r.told[0]!.text, new RegExp(`Task ${t1} has been first in the landing queue of branch main since ${since} \\(at least 1 h\\) and has not landed; other work waits behind it`));
      const front = (await r.list()).front!;
      assert.deepEqual([front.taskId, front.since, front.escalated], [t1, since, true]);
      // The head's own landing is not a wait behind it; once it is taken out, the next first place starts its own time.
      assert.equal((await land(t1)).state, "refused");
      assert.equal(r.told.length, 1);
      await r.ops.remove(r.w.owner, { commandId: "out", taskId: t1, reason: "the director decided" });
      const next = (await r.list()).front!;
      assert.deepEqual([next.taskId, next.escalated], [t2, undefined]);
      assert.notEqual(next.since, since);
      await r.ops.queueApproved(r.submit(t3, oid(998)), "rv3");
      assert.equal((await land(t2)).state, "done");
      r.w.clock.advance(61 * MIN);
      assert.equal(r.told.length, 1, "nothing waits behind the new first place yet");
    } finally { await r.close(); }
  });

  test(`${backend.name}: a reserved place that comes ahead of an entry whose landing is at the host waits until that landing ends (card P10, reservations)`, async () => {
    let atHost: () => void = () => undefined, release: () => void = () => undefined;
    const reached = new Promise<void>((res) => { atHost = res; });
    const blocked = new Promise<void>((res) => { release = res; });
    let first = true;
    const r = await rig({ cap: 2, gate: async () => { if (first) { first = false; atHost(); await blocked; } } });
    try {
      const ivy = await r.person("ivy");
      const [t1, t2] = [await r.task("one"), await r.task("two")];
      const s1 = r.submit(t1, r.head());
      await r.ops.queueApproved(s1, "rv1");
      await r.ops.queueApproved(r.submit(t2, r.head()), "rv2");
      // Task one's approval is taken back: it leaves (its place remembered); task two is first, and its landing passes its checks and waits at the host.
      r.takeBack(s1);
      assert.equal(await r.ops.withdrawUnapproved(s1, "rv3"), true);
      const land = await r.lander(ivy, t2);
      const two = land(t2);
      await reached;
      // Meanwhile task one's author reaches the cap: its old place (1, ahead of task two) is reserved, and its re-approval takes that place.
      assert.equal(await r.ops.afterRound({ taskId: t1, projectId: r.w.project, round: 2 }), "reserved");
      await r.ops.queueApproved(r.submit(t1, r.head()), "rv4");
      assert.deepEqual(await r.queued(), [[1, t1], [2, t2]]);
      // Task one is first, but task two's landing has not ended: task one's landing is refused before any host is asked (two landings never reach the host together).
      await refuses("invalid_transition", () => land(t1), new RegExp(`task ${t2}'s landing on branch main is in progress`));
      assert.equal(r.calls.length, 1);
      release();
      assert.equal((await two).state, "done");
      // Once it has ended, task one's landing is asked of the host (which refuses it: the branch moved since its approval).
      assert.equal((await land(t1)).state, "refused");
      assert.equal(r.calls.length, 2);
    } finally { release(); await r.close(); }
  });

  test(`${backend.name}: an escalation that could not be told is told at the next refused landing or round, and then once (card P10, reservations)`, async () => {
    const r = await rig({ cap: 2, holdMs: 60 * MIN });
    try {
      const ivy = await r.person("ivy");
      const [t1, t2, t3] = [await r.task("one"), await r.task("two"), await r.task("three")];
      await r.ops.queueApproved(r.submit(t1, oid(999)), "rv1"); // approved on a base the branch is not at
      await r.ops.queueApproved(r.submit(t2, r.head()), "rv2");
      const land = await r.lander(ivy, t1);
      r.w.clock.advance(60 * MIN);
      // The owner could not be told: nothing is marked, and the next refused landing tells; after that, once.
      r.failing.escalations = 1;
      await refuses("invalid_transition", () => land(t2), /the oldest .* lands first/);
      assert.deepEqual([r.told.length, (await r.list()).front?.escalated], [0, undefined]);
      await refuses("invalid_transition", () => land(t2), /the oldest .* lands first/);
      await refuses("invalid_transition", () => land(t2), /the oldest .* lands first/);
      assert.deepEqual(r.told.map((t) => [t.taskId, t.why]), [[t1, "front"]]);
      assert.equal((await r.list()).front?.escalated, true);
      // A round beyond the cap whose notice failed is told at the next round, naming that round; then not again.
      assert.equal(await r.ops.afterRound({ taskId: t3, projectId: r.w.project, round: 2 }), "reserved");
      r.failing.escalations = 1;
      assert.equal(await r.ops.afterRound({ taskId: t3, projectId: r.w.project, round: 3 }), undefined);
      assert.equal((await r.list()).reservations.find((x) => x.taskId === t3)?.escalatedRound, undefined);
      assert.equal(await r.ops.afterRound({ taskId: t3, projectId: r.w.project, round: 4 }), "escalated");
      assert.equal(await r.ops.afterRound({ taskId: t3, projectId: r.w.project, round: 5 }), undefined);
      const rounds = r.told.filter((t) => t.why === "round");
      assert.deepEqual(rounds.map((t) => t.taskId), [t3]);
      assert.match(rounds[0]!.text, /needed refresh round 4 /);
      assert.equal((await r.list()).reservations.find((x) => x.taskId === t3)?.escalatedRound, 4);
    } finally { await r.close(); }
  });

  // The fairness test. Steady load: new tasks are approved on the branch's current head, two every few minutes. The integrator lands the first place whenever it can. A landing that the host refuses because the branch moved
  // since the approval goes back to its author (the approval is taken back) and the author refreshes onto the new head (one refresh round, told to the queue) and is approved again a few minutes later. Without
  // reservations, every task but one approved on the current head comes back to the end of the queue stale, again and again. With them, each task lands a bounded time after it arrives. One author goes silent
  // after its place is reserved; the director is told once the place holds the branch for the hold time, takes the task out, and the rest goes on.
  test(`${backend.name}: no submission waits forever under steady load: each lands within a bounded time, and a silent author's reserved place goes to the director (card P10, reservations)`, async () => {
    const CAP = 2, ARRIVE = 6, BATCH = 3, REVIEW = 2, TASKS = 24, HOLD = 30 * MIN;
    const r = await rig({ cap: CAP, holdMs: HOLD });
    try {
      const ivy = await r.person("ivy"), dee = await r.person("dee", []);
      r.directors.add(dee.id);
      const tasks: string[] = [];
      const arrived = new Map<string, number>(), landedAt = new Map<string, number>(), rounds = new Map<string, number>(), lastBase = new Map<string, string>();
      const pending: { task: string; id: string; due: number }[] = [];
      let silent: string | undefined;
      let land: ((taskId: string) => Promise<{ state: string; queued?: { submissionId: string } }>) | undefined;
      let maxQueue = 0;
      for (let tick = 0; tick < 400 && landedAt.size + (silent === undefined ? 0 : 1) < TASKS; tick++) {
        r.w.clock.advance(MIN);
        // Steady arrivals, BATCH at a time, each approved on the head as it is then (so all but one of a batch are stale once the first lands).
        for (let b = 0; b < BATCH && tick % ARRIVE === 0 && tasks.length < TASKS; b++) {
          const t = await r.task(`load-${tasks.length}`);
          tasks.push(t); arrived.set(t, tick); lastBase.set(t, r.head());
          land ??= await r.lander(ivy, t);
          await r.ops.queueApproved(r.submit(t, r.head()), `arrive-${t}`);
        }
        // Approvals of refreshed work arrive after the review time.
        for (const p of pending.filter((x) => x.due <= tick)) { pending.splice(pending.indexOf(p), 1); await r.ops.queueApproved(p.id, `rv-${p.id}`); }
        const q = await r.list();
        maxQueue = Math.max(maxQueue, q.items.length + q.reservations.length);
        // The director acts on what it was told: the silent author's task is taken out.
        for (const t of r.told.filter((x) => x.why === "front" && x.taskId === silent)) if (q.reservations.some((x) => x.taskId === t.taskId)) await r.ops.remove(dee, { commandId: `dir-${t.taskId}`, taskId: t.taskId, reason: "its author does not answer" });
        // The integrator lands the first place's entry; while the first place waits for an approval, it tries the oldest entry behind it (and is refused: the branch is held).
        const first = q.front === undefined ? undefined : q.items.find((e) => e.taskId === q.front!.taskId);
        const target = first ?? q.items[0];
        if (target === undefined) continue;
        let outcome: { state: string } | undefined;
        try { outcome = await land!(target.taskId); } catch (error) { if (!(error instanceof DomainError && error.code === "invalid_transition" && first === undefined)) throw error; continue; }
        if (outcome.state === "done") { landedAt.set(target.taskId, tick); continue; }
        // Stale: back to its author, who refreshes onto the current head (a round) and is approved again later; the silent author answers once, then never again.
        r.takeBack(target.submissionId);
        await r.ops.withdrawUnapproved(target.submissionId, `back-${target.submissionId}`);
        if (target.taskId === silent) continue;
        if (lastBase.get(target.taskId) !== r.head()) {
          const n = (rounds.get(target.taskId) ?? 0) + 1;
          rounds.set(target.taskId, n); lastBase.set(target.taskId, r.head());
          await r.ops.afterRound({ taskId: target.taskId, projectId: r.w.project, round: n });
        }
        if (silent === undefined && tasks.indexOf(target.taskId) >= 4 && (await r.list()).reservations.some((x) => x.taskId === target.taskId)) { silent = target.taskId; continue; }
        pending.push({ task: target.taskId, id: r.submit(target.taskId, r.head()), due: tick + REVIEW });
      }
      const stats = JSON.stringify({ landed: tasks.map((t) => (landedAt.has(t) ? landedAt.get(t)! - arrived.get(t)! : null)), rounds: tasks.map((t) => rounds.get(t) ?? 0), silent: silent === undefined ? null : tasks.indexOf(silent), maxQueue, told: r.told.map((t) => [tasks.indexOf(t.taskId), t.why]) });
      assert.ok(silent !== undefined, `the silent author's task was reserved ${stats}`);
      const waits = tasks.filter((t) => t !== silent).map((t) => (landedAt.has(t) ? landedAt.get(t)! - arrived.get(t)! : Infinity));
      // Every other task landed, and none waited longer than the bound: the queue ahead of it (at most `maxQueue`), each place taking at most CAP refresh trips of review time plus the hold time once.
      assert.deepEqual(waits.filter((x) => x === Infinity).length, 0, `tasks that never landed: ${stats}`);
      const bound = maxQueue * (CAP + 1) * (REVIEW + 2) + HOLD / MIN + 10;
      assert.ok(Math.max(...waits) <= bound, `longest wait ${Math.max(...waits)} ticks, bound ${bound}: ${stats}`);
      const end = await r.list();
      assert.deepEqual([end.items.length, end.reservations.length], [0, 0], `the queue drained: ${stats}`);
      // The silent author's place was told to the director once, and taken out by the director.
      assert.deepEqual(r.told.filter((t) => t.why === "front").map((t) => t.taskId), [silent]);
      assert.ok(!landedAt.has(silent!));
      assert.deepEqual((await r.list()).reservations, []);
      // Each reservation that was made did its work: no task needed a round beyond the cap.
      assert.deepEqual(r.told.filter((t) => t.why === "round"), []);
      assert.ok([...rounds.values()].some((n) => n >= CAP), "some task reached the cap, so reservations were used");
    } finally { await r.close(); }
  });

  test(`${backend.name}: a full queue whose first place is reserved still takes that task's re-approval, so the queue cannot stay held (card P10, reservations, second review)`, async () => {
    const store = await backend.open();
    try {
      const w = await buildWorld(store.storage);
      const queue = LandingQueueService.withEpoch(w.storage, w.epoch, { clock: w.clock.now, pause: async () => undefined });
      const tid = (n: number): string => `task-${sbm(n).slice(4)}`;
      const add = (n: number, s: number) => queue.enqueue({ commandId: `add-${n}-${s}`, actor: "owner", projectId: w.project, branch: "main", submissionId: sbm(s), taskId: tid(n), base: oid(1), tree: oid(2), author: "agent:ann" });
      // Task 0 is first and reaches the cap; its approval is taken back (the controller keeps its place), and the queue is then filled to its bound behind it.
      await add(0, 1);
      await queue.reserve({ commandId: "res-0", actor: "service:landing-queue", projectId: w.project, branch: "main", taskId: tid(0), round: 3, cap: 3 });
      await queue.remove({ commandId: "wd-0", actor: "service:landing-queue", projectId: w.project, branch: "main", taskId: tid(0), reason: "approval taken back", allowed: () => true, keepReservation: true });
      for (let n = 1; n <= LANDING_QUEUE_LIMITS.entries; n++) await add(n, 1000 + n);
      const full = await queue.get(w.project, "main");
      assert.equal(full.entries.length, LANDING_QUEUE_LIMITS.entries);
      assert.deepEqual([frontOf(full)?.taskId, frontOf(full)?.entry], [tid(0), undefined], "the reserved place without an entry is first");
      // Another task is refused at the bound; the reserved task's re-approval takes its place (first), so it can land and the queue moves again.
      await refuses("unavailable", () => add(LANDING_QUEUE_LIMITS.entries + 1, 5000), /at most 200/);
      const back = await add(0, 2);
      assert.deepEqual([back.position, back.entry.seq], [1, 1]);
      assert.equal(frontOf(await queue.get(w.project, "main"))?.entry?.submissionId, sbm(2));
    } finally { await store.close(); }
  });
}
