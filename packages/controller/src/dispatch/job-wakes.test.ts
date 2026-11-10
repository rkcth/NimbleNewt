import assert from "node:assert/strict";
import { after, test } from "node:test";
import { backends, stopServer } from "../domain/testing/backends.js";
import { JobService } from "../jobs/jobs.js";
import { JOB_WAKE_KIND, JOB_WAKE_LIMITS, JOB_WAKES_INDEX, wakeIdOf, type JobWakeBody, type JobWakesIndex } from "../jobs/wakes.js";
import { NotificationService } from "../notifications/notifications.js";
import { buildWorld, workGrants, type DispatchWorld } from "./testing/world.js";
import type { WorkerTurnResult, WorkOrder } from "./ports.js";
import { STOPPED_EARLY_KIND } from "./model.js";

after(stopServer);

// Card W11: a job that belongs to a task wakes the task when it reaches a final state. The attempt that ended its turn while the job ran parks for it and is readmitted (or a new attempt of the same assignment is admitted), once
// per final state, durably, bounded per task per hour and counted with W03's go-ons; a stopped, finished or reassigned task is not woken, a paused one is woken when the pause is lifted; the owner is told once.

interface Rig {
  readonly w: DispatchWorld;
  readonly jobs: JobService;
  readonly notifications: NotificationService;
  /** The job each started turn admitted, by attempt and run. */
  readonly started: { attemptId: string; jobId: string; order: WorkOrder }[];
  tick(): Promise<Awaited<ReturnType<DispatchWorld["dispatcher"]["tick"]>>>;
  wake(taskId: string): Promise<JobWakeBody[]>;
  stopped: Set<string>;
}

let seq = 0;
async function rig(storage: Parameters<typeof buildWorld>[0]): Promise<Rig> {
  const w = await buildWorld(storage);
  const notifications = NotificationService.withEpoch(storage, w.epoch, { clock: w.clock.now });
  const jobs = JobService.withEpoch(storage, w.epoch, { pauses: w.pauses }, { clock: w.clock.now, pause: async () => undefined, host: w.dispatcherPrincipal.id, wakes: true });
  const stopped = new Set<string>();
  w.dispatcher = w.restart({ notifications, jobWakes: { waitable: (taskId) => jobs.waitable(taskId), stopped: async (taskId) => stopped.has(taskId) } });
  const started: Rig["started"] = [];
  const r: Rig = {
    w, jobs, notifications, started, stopped,
    tick: async () => { await w.heartbeatHost(); const report = await w.dispatcher.tick(); await w.dispatcher.idle(); return report; },
    wake: async (taskId) => {
      const out: JobWakeBody[] = [];
      for (const a of await storage.listAggregates(JOB_WAKE_KIND, { limit: 1000 })) { const b = a.body as unknown as JobWakeBody; if (b.taskId === taskId) out.push(b); }
      return out;
    },
  };
  return r;
}

/** A turn that starts a job (as the bridge does: admitted for the task with the attempt, then dispatched and running) and ends without work.end, as an agent told it is woken when the job ends. */
const startsJob = (r: Rig, label: string, options: { background?: boolean } = {}) => async ({ order }: { order: WorkOrder }): Promise<WorkerTurnResult> => {
  const admitted = await r.jobs.admit(r.w.owner, { commandId: `adm-${++seq}`, taskId: order.taskId, kind: "tool", label, operationId: `op-${seq}`, attemptId: order.attemptId, longRunning: true, ...(options.background === true ? { background: true } : {}) });
  await r.jobs.report(r.w.dispatcherPrincipal, { commandId: `dsp-${seq}`, jobId: admitted.id, state: "dispatched" });
  await r.jobs.report(r.w.dispatcherPrincipal, { commandId: `run-${seq}`, jobId: admitted.id, state: "running" });
  r.started.push({ attemptId: order.attemptId, jobId: admitted.id, order });
  return { status: "completed", text: "The build runs; I will read it when I am woken.", endKind: "no-work-end", visibleChars: 40, checkpoint: { run: r.w.worker.starts.length } };
};
/** A turn that reads the note and ends properly. */
const finishes = async (): Promise<WorkerTurnResult> => ({ status: "completed", text: "read the job; done", endKind: "normal", visibleChars: 18 });
const host = (r: Rig) => r.w.dispatcherPrincipal;

for (const backend of backends) {
  test(`${backend.name}: a job started by an attempt that ends its turn parks the attempt; the job's end readmits it once with a note naming the job; the owner gets one Notice; repeated ends and ticks give one wake`, async () => {
    const store = await backend.open();
    try {
      const r = await rig(store.storage);
      const { w } = r;
      const ann = await w.agent("ann", workGrants(w.project, []));
      const { taskId, attemptId } = await w.task("Write the manual", ann);
      w.worker.script = async (c) => (c.order.resumeNote === undefined ? startsJob(r, "build the ‮docs")(c) : finishes());

      await r.tick();
      let d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.state, "parked", `the attempt waits for its job instead of going on at once: ${JSON.stringify(d.outcome)}`);
      assert.deepEqual(d.waitsOnJobs, [r.started[0]!.jobId]);
      assert.equal(d.stoppedEarly, undefined, "waiting for a job is not a stop before the work was done");
      assert.deepEqual(d.resumeFrom, { run: 1 });
      assert.equal(await store.storage.getAggregate({ kind: STOPPED_EARLY_KIND, id: taskId }), undefined, "no W03 readmit was counted");

      await r.tick();
      assert.equal(w.worker.starts.length, 1, "nothing starts while the job runs");

      const jobId = r.started[0]!.jobId;
      w.clock.advance(5000);
      await r.jobs.finish(host(r), { commandId: "fin-1", jobId, outcome: "completed", exit: { code: 0 } });
      // The same final state recorded again (a repeated command) writes nothing more.
      await r.jobs.finish(host(r), { commandId: "fin-1", jobId, outcome: "completed", exit: { code: 0 } });
      assert.equal((await r.wake(taskId)).length, 1);

      const report = await r.tick();
      assert.deepEqual(report.woken, [attemptId]);
      assert.equal(w.worker.starts.length, 2, "readmitted and started in the same tick");
      const order = w.worker.starts[1]!;
      assert.equal(order.attemptId, attemptId, "the same attempt goes on");
      assert.equal(order.requestId, `cmd:adm:${attemptId}:wk1`, "a new request in the same conversation");
      assert.deepEqual(order.resumeFrom, { run: 1 });
      assert.match(order.resumeNote ?? "", new RegExp(`the job "build the \\\\u202edocs" \\(${jobId}\\) completed`), "the label quoted once, its control escaped");
      assert.match(order.resumeNote ?? "", /nimblenewt__job-status/);
      assert.match(order.resumeNote ?? "", /nimblenewt__job-output/);
      assert.ok((order.resumeNote ?? "").length < 700, "the note is bounded");
      d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.state, "finished");
      assert.equal(d.outcome?.status, "succeeded");
      assert.equal(d.waitsOnJobs, undefined);

      const [wake] = await r.wake(taskId);
      assert.equal(wake!.status, "woken");
      assert.equal(wake!.woke, attemptId);
      assert.deepEqual(wake!.notice, { sent: true });
      assert.deepEqual(((await store.storage.getAggregate(JOB_WAKES_INDEX))!.body as unknown as JobWakesIndex).due, []);
      const count = (await store.storage.getAggregate({ kind: STOPPED_EARLY_KIND, id: taskId }))!.body as { wakes?: number; readmits: number };
      assert.equal(count.wakes, 1);
      assert.equal(count.readmits, 0);

      const items = (await r.notifications.inbox(w.owner)).items.filter((i) => i.ref.kind === "job");
      assert.equal(items.length, 1, "one notification");
      assert.equal(items[0]!.level, "notice", "a completed job is a Notice");
      assert.match(items[0]!.label, /^Job "build the \\u202edocs" completed$/);
      assert.match(items[0]!.detail ?? "", /Task "Write the manual": the job completed\. The agent was woken to read it\./);

      await r.tick();
      await r.tick();
      assert.equal(w.worker.starts.length, 2, "one wake, not more");
      assert.equal((await r.notifications.inbox(w.owner)).items.filter((i) => i.ref.kind === "job")[0]!.count, 1, "told once");
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: failed, cancelled and outcome-unknown jobs wake the task the same way with the state named (failed and unknown as Needs you); a reconciled unknown job wakes a new attempt of the same assignment`, async () => {
    const store = await backend.open();
    try {
      const r = await rig(store.storage);
      const { w } = r;
      const ann = await w.agent("ann", workGrants(w.project, []));
      const seen = new Map<string, string>();
      w.worker.script = async (c) => { if (c.order.resumeNote !== undefined) { seen.set(c.order.taskId, c.order.resumeNote); return finishes(); } return startsJob(r, `job of ${c.order.taskId.slice(-4)}`)(c); };
      const failed = await w.task("fails", ann);
      const cancelled = await w.task("cancelled", ann);
      const unknown = await w.task("unknown", ann);
      await r.tick();
      for (const t of [failed, cancelled, unknown]) assert.equal((await w.dispatcher.get(w.owner, t.attemptId!))!.state, "parked");
      const jobOf = (attemptId: string) => r.started.find((s) => s.attemptId === attemptId)!.jobId;
      await r.jobs.finish(host(r), { commandId: "f", jobId: jobOf(failed.attemptId!), outcome: "failed", exit: { code: 2, reason: "the job exited with code 2" } });
      await r.jobs.requestCancel(w.owner, { commandId: "c", jobId: jobOf(cancelled.attemptId!), reason: "not needed" });
      await r.jobs.confirmCancel(host(r), { commandId: "cc", jobId: jobOf(cancelled.attemptId!), result: "stopped" });
      await r.jobs.markUnknown(host(r), { commandId: "u", jobId: jobOf(unknown.attemptId!), reason: "the controller restarted while it ran" });
      await r.tick();
      assert.match(seen.get(failed.taskId) ?? "", /\) failed\./);
      assert.match(seen.get(cancelled.taskId) ?? "", /\) was cancelled \(stopped\)\./);
      assert.match(seen.get(unknown.taskId) ?? "", /\) ended with an outcome nobody knows/);
      const levels = new Map((await r.notifications.inbox(w.owner)).items.filter((i) => i.ref.kind === "job").map((i) => [i.ref.id, i.level]));
      assert.equal(levels.get(jobOf(failed.attemptId!)), "needs-you");
      assert.equal(levels.get(jobOf(unknown.attemptId!)), "needs-you");
      assert.equal(levels.get(jobOf(cancelled.attemptId!)), "notice");

      // The owner settles the unknown job; the task's attempt has finished meanwhile, so the wake admits a new attempt of the same assignment (and only one), whose first run is told.
      assert.equal((await w.dispatcher.get(w.owner, unknown.attemptId!))!.state, "finished");
      const before = (await w.assignments.getAssignment(unknown.taskId))!;
      await r.jobs.reconcile(w.owner, { commandId: "rc", jobId: jobOf(unknown.attemptId!), to: "completed", evidence: "the report file is complete" });
      const report = await r.tick();
      const after_ = (await w.assignments.getAssignment(unknown.taskId))!;
      assert.equal(after_.generation, before.generation, "the same assignment");
      assert.equal(after_.attempts, before.attempts + 1, "one new attempt");
      assert.equal(report.woken?.length, 1);
      const fresh = w.worker.starts.at(-1)!;
      assert.notEqual(fresh.attemptId, unknown.attemptId);
      assert.equal(fresh.taskId, unknown.taskId);
      assert.match(fresh.resumeNote ?? "", /had an unknown outcome, which was settled: it completed/);
      const wakes = await r.wake(unknown.taskId);
      assert.deepEqual(wakes.map((x) => [x.phase, x.status]).sort(), [["end", "woken"], ["reconciled", "woken"]]);
      assert.equal(wakes.find((x) => x.phase === "reconciled")!.notice, undefined, "the owner settled it: no notification for that");
      await r.tick();
      assert.equal((await w.assignments.getAssignment(unknown.taskId))!.attempts, before.attempts + 1, "never a second one");
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: no wake for a stopped, cancelled or reassigned task; a paused task's background job records its end without lifting the pause and the task is woken when the pause is lifted`, async () => {
    const store = await backend.open();
    try {
      const r = await rig(store.storage);
      const { w } = r;
      const ann = await w.agent("ann", workGrants(w.project, []));
      const bob = await w.agent("bob", workGrants(w.project, []));
      w.worker.script = async (c) => (c.order.resumeNote === undefined ? startsJob(r, "long build", { background: true })(c) : finishes());
      const stoppedT = await w.task("stopped", ann);
      const cancelledT = await w.task("cancelled", ann);
      const reassignedT = await w.task("reassigned", ann);
      const pausedT = await w.task("paused", ann);
      await r.tick();
      const jobOf = (attemptId: string) => r.started.find((s) => s.attemptId === attemptId)!.jobId;
      const startsBefore = w.worker.starts.length;

      r.stopped.add(stoppedT.taskId);
      const task = (await w.projects.getTask(cancelledT.taskId))!;
      await w.projects.transitionTask({ commandId: "cx", actor: w.owner.id, taskId: cancelledT.taskId, expectedRevision: task.revision, to: "cancelled" });
      const asg = (await w.assignments.getAssignment(reassignedT.taskId))!;
      await w.assignments.transferTask({ commandId: "tr", actor: w.owner.id, taskId: reassignedT.taskId, expectedRevision: asg.revision, to: { kind: "agent", id: bob.aid } });
      await w.pauses.pause(w.owner, { commandId: "pz", scope: { kind: "task", id: pausedT.taskId }, reason: "look at it" });

      for (const t of [stoppedT, cancelledT, reassignedT, pausedT]) await r.jobs.finish(host(r), { commandId: `f-${t.taskId}`, jobId: jobOf(t.attemptId!), outcome: "completed", exit: { code: 0 } });
      assert.equal(await w.pauses.isPaused(pausedT.taskId), true, "the background job's end does not lift the pause");
      assert.equal((await r.jobs.get(w.owner, jobOf(pausedT.attemptId!)))!.state, "completed", "its result is recorded while paused");
      await r.tick();
      await r.tick();
      const startedAfter = w.worker.starts.slice(startsBefore).filter((o) => o.taskId !== reassignedT.taskId);
      assert.deepEqual(startedAfter.map((o) => o.taskId), [], "none of them woken");
      const status = async (t: { taskId: string }) => (await r.wake(t.taskId))[0]!;
      assert.equal((await status(stoppedT)).status, "skipped");
      assert.match((await status(stoppedT)).reason!, /the task is stopped/);
      assert.match((await status(cancelledT)).reason!, /the task is cancelled/);
      assert.match((await status(reassignedT)).reason!, /reassigned/);
      assert.equal((await status(pausedT)).status, "due", "the paused one waits");
      assert.equal((await w.dispatcher.get(w.owner, cancelledT.attemptId!))!.state, "finished", "an attempt parked for a job of a task that ended does not stay parked");
      assert.equal((await w.dispatcher.get(w.owner, pausedT.attemptId!))!.state, "parked");
      const paused = (await r.notifications.inbox(w.owner)).items.find((i) => i.ref.id === jobOf(pausedT.attemptId!));
      assert.match(paused?.detail ?? "", /woken to read it when the task's pause is lifted/);
      assert.equal((await r.notifications.inbox(w.owner)).items.filter((i) => i.ref.id === jobOf(stoppedT.attemptId!)).length, 1, "the owner is told of a skipped wake too");

      await w.pauses.resume(w.owner, { commandId: "pr", scope: { kind: "task", id: pausedT.taskId }, reason: "go on" });
      const report = await r.tick();
      assert.deepEqual(report.woken, [pausedT.attemptId]);
      assert.equal((await status(pausedT)).status, "woken");
      assert.equal(w.worker.starts.at(-1)!.attemptId, pausedT.attemptId);
      assert.equal((await r.notifications.inbox(w.owner)).items.filter((i) => i.ref.id === jobOf(pausedT.attemptId!))[0]!.count, 1, "told once, not again at the wake");
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: a controller restart between the job's end and the wake still wakes the task exactly once`, async () => {
    const store = await backend.open();
    try {
      const r = await rig(store.storage);
      const { w } = r;
      const ann = await w.agent("ann", workGrants(w.project, []));
      w.worker.script = async (c) => (c.order.resumeNote === undefined ? startsJob(r, "index")(c) : finishes());
      const { attemptId } = await w.task("restart", ann);
      await r.tick();
      await r.jobs.finish(host(r), { commandId: "f", jobId: r.started[0]!.jobId, outcome: "completed" });
      // The controller goes down before any tick looks at the wake; a new one (a new dispatcher and job service over the same store) finds it due.
      const jobs2 = JobService.withEpoch(store.storage, w.epoch, { pauses: w.pauses }, { clock: w.clock.now, host: w.dispatcherPrincipal.id, wakes: true });
      w.dispatcher = w.restart({ notifications: r.notifications, jobWakes: { waitable: (t) => jobs2.waitable(t) } });
      const report = await r.tick();
      assert.deepEqual(report.woken, [attemptId]);
      // And another restart after the wake does nothing more.
      w.dispatcher = w.restart({ notifications: r.notifications, jobWakes: { waitable: (t) => jobs2.waitable(t) } });
      await r.tick();
      await r.tick();
      assert.equal(w.worker.starts.filter((o) => o.attemptId === attemptId).length, 2);
      assert.equal((await r.notifications.inbox(w.owner)).items.filter((i) => i.ref.kind === "job").length, 1);
    } finally { await store.close(); }
  });
}

for (const backend of backends) {
  test(`${backend.name}: wakes are bounded per task per hour and counted with W03's go-ons; when they are used up the parked attempt ends with W03's blocker and nothing starts by itself`, async () => {
    const store = await backend.open();
    try {
      const r = await rig(store.storage);
      const { w } = r;
      const ann = await w.agent("ann", workGrants(w.project, []));
      // The first run stops early with no job (a W03 go-on, counted); every run after it starts a job and ends its turn.
      let runs = 0;
      w.worker.script = async (c) => (++runs === 1 ? { status: "completed", text: "thinking", endKind: "no-work-end", visibleChars: 8, checkpoint: { run: 1 } } : startsJob(r, `step ${runs}`)(c));
      const { taskId, attemptId } = await w.task("loop", ann);
      await r.tick(); // run 1: early stop, readmitted (W03)
      await r.tick(); // run 2: starts a job and parks
      const finishLast = async () => { const last = r.started.at(-1)!; await r.jobs.finish(host(r), { commandId: `f-${last.jobId}`, jobId: last.jobId, outcome: "completed" }); };
      let woken = 0, hourWaits = 0;
      for (let round = 0; round < 60 && woken < JOB_WAKE_LIMITS.goOns - 1; round++) {
        const d = (await w.dispatcher.get(w.owner, attemptId!))!;
        if (d.state === "finished") break;
        if (d.state === "parked" && (await r.wake(taskId)).every((x) => x.status !== "due")) await finishLast();
        const report = await r.tick();
        if ((report.woken?.length ?? 0) > 0) { woken += report.woken!.length; continue; }
        // Nothing woken while a wake is due: the hour's wakes are used up. Within the hour nothing starts.
        const due = (await r.wake(taskId)).filter((x) => x.status === "due");
        if (due.length > 0) {
          const count = (await store.storage.getAggregate({ kind: STOPPED_EARLY_KIND, id: taskId }))!.body as { wakeTimes: string[] };
          assert.equal(count.wakeTimes.filter((t) => Date.parse(t) > Date.parse(w.clock.now()) - 3_600_000).length, JOB_WAKE_LIMITS.perHour);
          hourWaits++;
          w.clock.advance(61 * 60_000);
        }
      }
      const count = (await store.storage.getAggregate({ kind: STOPPED_EARLY_KIND, id: taskId }))!.body as { wakes: number; readmits: number };
      assert.equal(hourWaits, 2, "four wakes an hour: the eleven wakes waited for the hour twice");
      assert.equal(count.readmits, 1, "the W03 go-on");
      assert.equal(count.wakes, JOB_WAKE_LIMITS.goOns - 1, "the wakes make up the rest of the go-ons");
      // The next job's end finds the go-ons used up: no wake, and the parked attempt ends with the blocker.
      await finishLast();
      await r.tick();
      const d = (await w.dispatcher.get(w.owner, attemptId!))!;
      assert.equal(d.state, "finished");
      assert.equal(d.outcome?.status, "stopped-early");
      const blocker = await w.blockers.openFor("agent_stopped_early", { kind: "task", id: taskId });
      assert.match(blocker?.summary ?? "", /wake-ups ran out/);
      const last = (await r.wake(taskId)).find((x) => x.jobId === r.started.at(-1)!.jobId)!;
      assert.equal(last.status, "skipped");
      assert.match(last.reason!, /wake-ups are used up/);
      const n = w.worker.starts.length;
      await r.tick();
      assert.equal(w.worker.starts.length, n, "nothing starts by itself");
    } finally { await store.close(); }
  });
}
