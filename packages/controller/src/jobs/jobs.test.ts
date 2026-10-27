import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PauseService } from "../lifecycle/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { PauseOptions } from "../lifecycle/index.js";
import { JOB_LIMITS, JobService, type JobBody, type JobOptions } from "./index.js";

after(stopServer);

let now = Date.parse("2026-10-26T10:00:00.000Z");
const clock = () => new Date(now).toISOString();
const base = { clock, pause: async () => undefined };
let n = 0;
const cid = (label: string): string => `${label}-${n++}`;
const refuses = async (code: DomainErrorCode, run: () => Promise<unknown>, check?: (error: DomainError) => void): Promise<void> => {
  await assert.rejects(run, (error: unknown) => { assert.ok(error instanceof DomainError, String(error)); assert.equal(error.code, code, error.message); check?.(error); return true; });
};
const art = (label: string): string => derivedId("art", label);
const SERVER = derivedId("mcs", "server-one");

for (const backend of backends) {
  interface Ctx {
    owner: Principal; project: string; other: string; t1: string; t2: string; t3: string;
    worker: Principal; boss: Principal; reader: Principal; stranger: Principal; both: Principal;
    projects: ProjectService; jobs: JobService; pauses: PauseService; recorded: { taskId: string; jobRef: string; outcome: string }[];
    reopen(options?: JobOptions): JobService;
    storage: Parameters<typeof JobService.withEpoch>[0]; epoch: number;
    admit(taskId?: string, extra?: Partial<Parameters<JobService["admit"]>[1]>): Promise<string>;
    read(id: string, as?: Principal): Promise<JobBody>;
    /** An artifact record of the project (or of another one), as the artifact service would have made it. */
    artifact(label: string, projectId?: string): Promise<string>;
  }
  const suite = (name: string, body: (c: Ctx) => Promise<void>, options: JobOptions = {}) =>
    test(`${backend.name}: ${name}`, async () => {
      now = Date.parse("2026-10-26T10:00:00.000Z");
      const world = await backend.open();
      try {
        const projects = await ProjectService.open(world.storage, { holder: "c1", ...base });
        const epoch = projects.epoch;
        const principals = PrincipalService.withEpoch(world.storage, epoch, base);
        void GrantService;
        const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
        const plain = async (nm: string, g: Grant[]) => {
          await principals.enroll(owner, { commandId: cid("e"), kind: "agent", name: nm, grants: g });
          return principals.authenticate((await principals.issueCredential(owner, `agent:${nm}`)).token);
        };
        const project = (await projects.createProject({ commandId: cid("pa"), actor: owner.id, name: "A" })).id;
        const other = (await projects.createProject({ commandId: cid("pb"), actor: owner.id, name: "B" })).id;
        const task = async (title: string, p = project): Promise<string> => {
          const id = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: p, title })).id;
          await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId: id, expectedRevision: 1, to: "ready" });
          return id;
        };
        const worker = await plain("worker", [{ action: "job.write", project }]);
        const boss = await plain("boss", [{ action: "job.control", project }, { action: "job.read", project }]);
        const reader = await plain("reader", [{ action: "job.read", project }]);
        const stranger = await plain("stranger", [{ action: "job.write", project: other }, { action: "job.control", project: other }]);
        const both = await plain("both", [{ action: "job.write", project }, { action: "job.control", project }, { action: "assignment.manage", project }]);
        const pauses = PauseService.withEpoch(world.storage, epoch, {}, base as PauseOptions);
        const recorded: { taskId: string; jobRef: string; outcome: string }[] = [];
        const opts: JobOptions = { ...base, background: async (p, request) => { recorded.push({ taskId: request.taskId, jobRef: request.jobRef, outcome: request.outcome }); return pauses.recordFinishedJob(p, request); }, ...options };
        const jobs = JobService.withEpoch(world.storage, epoch, { pauses }, opts);
        const t1 = await task("one"), t2 = await task("two"), t3 = await task("three", other);
        let op = 0;
        await body({
          owner, project, other, t1, t2, t3, worker, boss, reader, stranger, both, projects, jobs, pauses, recorded, storage: world.storage, epoch,
          reopen: (o = {}) => JobService.withEpoch(world.storage, epoch, { pauses }, { ...opts, ...o }),
          admit: async (taskId = t1, extra = {}) => (await jobs.admit(worker, { commandId: cid("ad"), taskId, kind: "tool", label: "build the project", operationId: `op-${op++}`, ...extra })).id,
          read: async (id, as = owner) => (await jobs.get(as, id))!,
          artifact: async (label, projectId = project) => {
            const id = art(label);
            await world.storage.applyOperation({
              operationId: `art-${label}`, epoch, actor: "test", correlationId: `art-${label}`, at: clock(),
              changes: [{ type: "create", ref: { kind: "artifact", id }, body: { name: label, projectId, entries: [], manifestDigest: "d", totalBytes: 0, createdBy: "test" } }],
              audit: [{ type: "test.artifact", detail: {} }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
            });
            return id;
          },
        });
      } finally { await world.close(); }
    });

  suite("a job has a durable handle, goes admitted, dispatched, running, completed, and keeps bounded redacted output, logs and artifacts", async (c) => {
    for (const label of ["log-1", "log-2", "result"]) await c.artifact(label);
    const id = await c.admit();
    assert.match(id, /^job-[a-z2-7]{20}$/);
    assert.deepEqual(await c.jobs.admit(c.worker, { commandId: "same", taskId: c.t1, kind: "tool", label: "x", operationId: "op-fixed" }).then((r) => r.replayed), false);
    // The same command is the same job; the same operation under a new command is refused, not started twice.
    assert.equal((await c.jobs.admit(c.worker, { commandId: "same", taskId: c.t1, kind: "tool", label: "x", operationId: "op-fixed" })).replayed, true);
    await refuses("command_conflict", () => c.jobs.admit(c.worker, { commandId: cid("ad"), taskId: c.t1, kind: "tool", label: "x", operationId: "op-fixed" }), (e) => assert.match(e.message, /already admitted/));
    assert.equal((await c.read(id)).state, "admitted");
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched", host: "host-1" });
    const secret = "Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD";
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "running", output: `starting\n${secret}\n`, logs: [art("log-1")] });
    const big = "x".repeat(JOB_LIMITS.chunk);
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, output: big });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, output: "the end\n", logs: [art("log-1"), art("log-2")] });
    const running = await c.read(id);
    assert.deepEqual([running.state, running.host, running.output.truncated, running.output.tail.length], ["running", "host-1", true, JOB_LIMITS.tail]);
    assert.ok(running.output.tail.endsWith("the end\n"));
    assert.equal(running.output.bytes > JOB_LIMITS.chunk, true);
    assert.deepEqual(running.logs, [art("log-1"), art("log-2")]);
    await refuses("invalid_command", () => c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, output: "y".repeat(JOB_LIMITS.chunk + 1) }), (e) => assert.match(e.message, /at a time/));
    const done = await c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: id, outcome: "completed", exit: { code: 0 }, artifacts: [art("result")] });
    assert.equal(done.state, "completed");
    const finished = await c.read(id);
    assert.deepEqual([finished.exit, finished.artifacts, finished.finishedAt], [{ code: 0 }, [art("result")], clock()]);
    assert.deepEqual(finished.history.map((h) => h.state), ["admitted", "dispatched", "running", "completed"]);
    const earlier = JSON.stringify((await c.read(id)).output.tail);
    assert.equal(earlier.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), false, "a secret in the output is not kept");
    // Ended: no more reports, no second finish, nothing to stop.
    await refuses("invalid_command", () => c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, output: "late" }), (e) => assert.match(e.message, /completed/));
    await refuses("invalid_command", () => c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: id, outcome: "failed" }));
    await refuses("invalid_command", () => c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: id, reason: "late" }), (e) => assert.match(e.message, /nothing to stop/));
  });

  suite("the time a job took, from its admission to its end, is reported once for the host to charge, whatever way it ended (card R05f)", async (c) => {
    const seen: { commandId: string; taskId: string; background: boolean; computeMs: number }[] = [];
    const jobs = c.reopen({ onUsage: async (u) => { seen.push({ commandId: u.commandId, taskId: u.taskId, background: u.background, computeMs: u.computeMs }); } });
    const id = (await jobs.admit(c.worker, { commandId: cid("ad"), taskId: c.t1, kind: "tool", label: "build", operationId: "op-use-1", background: true })).id;
    await jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched", host: "host-1" });
    await jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "running" });
    assert.equal(seen.length, 0, "nothing is charged while it runs");
    now += 90_000;
    await jobs.finish(c.worker, { commandId: "fin-use", jobId: id, outcome: "completed", exit: { code: 0 } });
    assert.deepEqual(seen, [{ commandId: `job-use:${id}`, taskId: c.t1, background: true, computeMs: 90_000 }]);
    // The same finish again is told again with the same key, so the host's charge counts it once.
    await jobs.finish(c.worker, { commandId: "fin-use", jobId: id, outcome: "completed", exit: { code: 0 } });
    assert.deepEqual(new Set(seen.map((u) => u.commandId)).size, 1);
    // A job that is stopped is charged for the time it ran too; one that is not a background job is charged as well.
    const other = (await jobs.admit(c.worker, { commandId: cid("ad"), taskId: c.t2, kind: "tool", label: "test", operationId: "op-use-2" })).id;
    await jobs.report(c.worker, { commandId: cid("rp"), jobId: other, state: "dispatched", host: "host-1" });
    await jobs.report(c.worker, { commandId: cid("rp"), jobId: other, state: "running" });
    now += 30_000;
    await jobs.finish(c.worker, { commandId: cid("fn"), jobId: other, outcome: "failed", exit: { code: 1 } });
    assert.deepEqual(seen.at(-1), { commandId: `job-use:${other}`, taskId: c.t2, background: false, computeMs: 30_000 });
    // A host that fails to charge does not undo the ending.
    const failing = c.reopen({ onUsage: async () => { throw new Error("ledger down"); } });
    const third = (await failing.admit(c.worker, { commandId: cid("ad"), taskId: c.t1, kind: "tool", label: "x", operationId: "op-use-3" })).id;
    await failing.report(c.worker, { commandId: cid("rp"), jobId: third, state: "dispatched", host: "host-1" });
    await failing.report(c.worker, { commandId: cid("rp"), jobId: third, state: "running" });
    await assert.rejects(failing.finish(c.worker, { commandId: "fin-fail", jobId: third, outcome: "completed", exit: { code: 0 } }), /ledger down/);
    assert.equal((await c.read(third)).state, "completed", "the job is recorded as ended");
  });

  suite("the handle survives a restart of the controller: a new service over the same store reads the job, and a repeated command still answers once", async (c) => {
    const id = await c.admit(c.t1, { resumability: "tool_checkpoint" });
    await c.jobs.report(c.worker, { commandId: "r1", jobId: id, state: "dispatched" });
    await c.jobs.report(c.worker, { commandId: "r2", jobId: id, state: "running", checkpoint: "ckpt-1", output: "half way\n" });
    const again = c.reopen();
    const job = (await again.get(c.owner, id))!;
    assert.deepEqual([job.state, job.checkpoint, job.output.tail], ["running", "ckpt-1", "half way\n"]);
    assert.equal((await again.report(c.worker, { commandId: "r2", jobId: id, state: "running", checkpoint: "ckpt-1", output: "half way\n" })).replayed, true);
    assert.equal((await c.read(id)).output.bytes, "half way\n".length, "the repeated report did not add its output twice");
    assert.deepEqual((await again.list(c.owner, c.t1)).jobs.map((j) => j.id), [id]);
    assert.deepEqual((await again.list(c.owner, c.t2)).jobs, []);
  });

  suite("a job record does not say the process can be resumed: the class is stated, a checkpoint needs a tool, a tracked remote job needs a remote kind", async (c) => {
    await refuses("invalid_command", () => c.admit(c.t1, { kind: "remote", resumability: "tool_checkpoint" }), (e) => assert.equal(e.field, "resumability"));
    await refuses("invalid_command", () => c.admit(c.t1, { kind: "tool", resumability: "remote_tracked" }), (e) => assert.equal(e.field, "resumability"));
    await refuses("invalid_command", () => c.admit(c.t1, { kind: "model_request", resumability: "tool_checkpoint" }));
    const id = await c.admit(c.t1, { kind: "tool" });
    assert.equal((await c.read(id)).resumability, "none");
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched" });
    await refuses("invalid_command", () => c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, checkpoint: "c" }), (e) => assert.equal(e.field, "checkpoint"));
    await c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: id, outcome: "completed" });
    await refuses("invalid_command", () => c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "running" }));
  });

  suite("cancelling a model request, stopping a tool and stopping a remote job are separate recorded operations; an uncooperative stop is not claimed as stopped, and orphans are reported", async (c) => {
    const model = await c.admit(c.t1, { kind: "model_request" });
    const tool = await c.admit(c.t1, { kind: "tool" });
    const remote = await c.admit(c.t1, { kind: "remote", host: "h-9", resumability: "remote_tracked" });
    for (const id of [model, tool, remote]) await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched" });
    assert.equal((await c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: model, reason: "owner changed the plan" })).operation, "cancel_model_request");
    assert.equal((await c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: tool, reason: "stop" })).operation, "stop_tool");
    assert.equal((await c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: remote, reason: "stop" })).operation, "stop_remote_job");
    await refuses("invalid_command", () => c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: tool, reason: "again" }), (e) => assert.match(e.message, /already being stopped/));
    // The request is not the stop: the job is still not cancelled.
    assert.equal((await c.read(tool)).state, "cancellation_requested");
    // An uncooperative tool is recorded, and the job stays in cancellation-requested.
    const unco = await c.jobs.confirmCancel(c.worker, { commandId: cid("cc"), jobId: tool, result: "uncooperative" });
    assert.equal(unco.state, "cancellation_requested");
    assert.equal((await c.read(tool)).cancel?.uncooperative, true);
    // The host later ends it, and reports a child it could not end.
    const stopped = await c.jobs.confirmCancel(c.worker, { commandId: cid("cc"), jobId: tool, result: "stopped", orphans: ["pid 4121 (node) still running"] });
    assert.equal(stopped.state, "cancelled");
    const after = await c.read(tool);
    assert.deepEqual([after.orphans, after.cancel?.operation, after.finishedAt], [["pid 4121 (node) still running"], "stop_tool", clock()]);
    await c.jobs.confirmCancel(c.worker, { commandId: cid("cc"), jobId: model, result: "stopped" });
    await refuses("invalid_command", () => c.jobs.confirmCancel(c.worker, { commandId: cid("cc"), jobId: model, result: "stopped" }), (e) => assert.match(e.message, /no stop was asked for/));
    // Only a controller of the job asks for the stop; a worker records what happened but does not decide.
    await refuses("forbidden", () => c.jobs.requestCancel(c.worker, { commandId: cid("cx"), jobId: remote, reason: "mine" }));
  });

  suite("outcome-unknown holds until the evidence settles it; a dependent action sees what is unresolved; the reconciliation is its own record", async (c) => {
    const id = await c.admit(c.t1, { kind: "remote", resumability: "remote_tracked" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "running" });
    await c.jobs.markUnknown(c.worker, { commandId: cid("uk"), jobId: id, reason: "the host stopped answering before the result arrived" });
    const job = await c.read(id);
    assert.deepEqual([job.state, job.unknown?.reason], ["outcome_unknown", "the host stopped answering before the result arrived"]);
    assert.deepEqual((await c.jobs.unresolved(c.owner, c.t1)).map((j) => j.id), [id]);
    await refuses("invalid_command", () => c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: id, outcome: "completed" }), (e) => assert.match(e.message, /reconcile/));
    await refuses("invalid_command", () => c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, output: "x" }), (e) => assert.match(e.message, /outcome-unknown/));
    await refuses("invalid_command", () => c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: id, reason: "x" }));
    await refuses("forbidden", () => c.jobs.reconcile(c.worker, { commandId: cid("rc"), jobId: id, to: "completed", evidence: "I say so" }));
    await refuses("invalid_command", () => c.jobs.reconcile(c.boss, { commandId: cid("rc"), jobId: id, to: "completed", evidence: "" }));
    const settled = await c.jobs.reconcile(c.boss, { commandId: cid("rc"), jobId: id, to: "completed", evidence: "the remote host's log shows exit 0 at 10:01", exit: { code: 0 } });
    const after = await c.read(id);
    assert.deepEqual([after.state, after.exit, after.unknown], ["completed", { code: 0 }, undefined]);
    const records = await c.jobs.reconciliation(c.owner, id);
    assert.deepEqual(records.map((r) => [r.id, r.from, r.to, r.evidence]), [[settled.reconciliationId, "outcome_unknown", "completed", "the remote host's log shows exit 0 at 10:01"]]);
    assert.deepEqual(await c.jobs.unresolved(c.owner, c.t1), []);
    await refuses("invalid_command", () => c.jobs.reconcile(c.boss, { commandId: cid("rc"), jobId: id, to: "failed", evidence: "again" }), (e) => assert.match(e.message, /not outcome-unknown/));
  });

  suite("after a restart a live job is completed, cancelled, restarted from a tool checkpoint, or kept as a tracked exception; nothing else can be restarted", async (c) => {
    const withCheckpoint = await c.admit(c.t1, { kind: "tool", resumability: "tool_checkpoint" });
    const noCheckpoint = await c.admit(c.t1, { kind: "tool", resumability: "tool_checkpoint" });
    const plainTool = await c.admit(c.t1, { kind: "tool" });
    const remote = await c.admit(c.t1, { kind: "remote", resumability: "remote_tracked" });
    const finished = await c.admit(c.t2, { kind: "tool" });
    for (const id of [withCheckpoint, noCheckpoint, plainTool, remote, finished]) await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: withCheckpoint, checkpoint: "ckpt-7" });
    await c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: finished, outcome: "completed", exit: { code: 0 } });
    // A new process lists what was live; a finished job is not among them.
    const live = await c.reopen().live(c.owner);
    assert.deepEqual(live.jobs.map((j) => j.id).sort(), [withCheckpoint, noCheckpoint, plainTool, remote].sort());
    // Restart: only from a checkpoint a tool left.
    await refuses("invalid_command", () => c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: noCheckpoint, decision: "restart", reason: "try again" }), (e) => assert.match(e.message, /checkpoint/));
    await refuses("invalid_command", () => c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: plainTool, decision: "restart", reason: "try again" }), (e) => assert.match(e.message, /does not imply/));
    await refuses("invalid_command", () => c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: remote, decision: "restart", reason: "try again" }));
    const restarted = await c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: withCheckpoint, decision: "restart", reason: "controller restarted" });
    assert.equal(restarted.state, "dispatched");
    const r = await c.read(withCheckpoint);
    assert.deepEqual([r.restarts, r.checkpoint], [1, "ckpt-7"]);
    // Complete from evidence only; cancel is a stop request the host then confirms; an exception names its owner and leaves the job running.
    await refuses("invalid_command", () => c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: plainTool, decision: "complete", reason: "it was done" }), (e) => assert.equal(e.field, "exit"));
    assert.equal((await c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: plainTool, decision: "complete", reason: "its output file is complete", exit: { code: 0, reason: "found the finished file" } })).state, "completed");
    assert.equal((await c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: noCheckpoint, decision: "cancel", reason: "not worth restarting" })).state, "cancellation_requested");
    await refuses("invalid_command", () => c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: remote, decision: "exception", reason: "owner follows it" }), (e) => assert.equal(e.field, "tracker"));
    await c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: remote, decision: "exception", reason: "the remote job outlives the controller", tracker: "owner" });
    const tracked = await c.read(remote);
    assert.deepEqual([tracked.state, tracked.exception?.tracker], ["dispatched", "owner"]);
    assert.deepEqual((await c.reopen().live(c.owner)).jobs.map((j) => j.id).sort(), [noCheckpoint, withCheckpoint].sort(), "the tracked exception is no longer in the restart queue");
    await refuses("invalid_command", () => c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: finished, decision: "cancel", reason: "x" }), (e) => assert.match(e.message, /nothing to decide/));
  });

  suite("Pause keeps a permitted background job running and records its result without unpausing; foreground jobs are refused while paused; a pause that denies background work admits none", async (c) => {
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: c.t1 }, reason: "hold for the owner" });
    await refuses("invalid_command", () => c.admit(c.t1, { kind: "tool" }), (e) => assert.equal(e.field, "pause"));
    const bg = await c.admit(c.t1, { kind: "tool", background: true });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: bg, state: "dispatched" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: bg, state: "running", output: "indexing\n" });
    assert.equal((await c.pauses.status(c.owner, c.t1))!.paused, true);
    // The worker holds only job.write: its finish is never lost for want of the pause service's own right.
    const done = await c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: bg, outcome: "completed", exit: { code: 0 } });
    assert.equal(done.state, "completed");
    assert.deepEqual(c.recorded.map((r) => [r.taskId, r.jobRef, r.outcome]), [[c.t1, bg, "succeeded"]]);
    assert.equal((await c.pauses.status(c.owner, c.t1))!.paused, true, "the result was recorded and nothing was unpaused");
    // Repeating the finish repeats nothing: the background record is the same one.
    const same = cid("fn2");
    const bg2 = await c.admit(c.t1, { kind: "tool", background: true });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: bg2, state: "dispatched" });
    await c.jobs.finish(c.worker, { commandId: same, jobId: bg2, outcome: "failed", exit: { code: 2 } });
    const repeated = await c.jobs.finish(c.worker, { commandId: same, jobId: bg2, outcome: "failed", exit: { code: 2 } });
    assert.equal(repeated.replayed, true);
    assert.equal((await c.read(bg2)).state, "failed");
    assert.equal((await c.storage.listAggregates("pause-background", { limit: 100 })).length, 2, "two jobs, two records, and the repeated finish added none");
    // A pause that denies background work admits none.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: c.t2 }, reason: "stop everything", background: "deny" });
    await refuses("invalid_command", () => c.admit(c.t2, { kind: "tool", background: true }), (e) => assert.match(e.message, /denied/));
    // After a resume, ordinary foreground work is admitted again.
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "go" });
    await c.admit(c.t1, { kind: "tool" });
  });

  suite("rights: writing, controlling and reading are separate; another project's holder reaches nothing; the owner reaches everything", async (c) => {
    const id = await c.admit();
    await refuses("forbidden", () => c.jobs.admit(c.reader, { commandId: cid("ad"), taskId: c.t1, kind: "tool", label: "x", operationId: "o-r" }));
    await refuses("forbidden", () => c.jobs.admit(c.stranger, { commandId: cid("ad"), taskId: c.t1, kind: "tool", label: "x", operationId: "o-s" }));
    await refuses("forbidden", () => c.jobs.report(c.stranger, { commandId: cid("rp"), jobId: id, state: "dispatched" }));
    await refuses("forbidden", () => c.jobs.report(c.boss, { commandId: cid("rp"), jobId: id, state: "dispatched" }));
    assert.equal((await c.jobs.get(c.reader, id))?.id, id);
    assert.equal(await c.jobs.get(c.stranger, id), undefined);
    await refuses("forbidden", () => c.jobs.list(c.stranger, c.t1));
    assert.deepEqual((await c.jobs.list(c.reader, c.t1)).jobs.map((j) => j.id), [id]);
    await c.jobs.report(c.owner, { commandId: cid("rp"), jobId: id, state: "dispatched" });
    assert.equal((await c.jobs.live(c.stranger)).jobs.length, 0, "a holder in another project sees none of this project's live jobs");
    await refuses("not_found", () => c.jobs.report(c.worker, { commandId: cid("rp"), jobId: derivedId("job", "nobody"), state: "dispatched" }));
    await refuses("invalid_command", () => c.jobs.report(c.worker, { commandId: cid("rp"), jobId: "job-1" as never }));
    await refuses("invalid_command", () => c.jobs.admit(c.worker, { commandId: cid("ad"), taskId: c.t1, kind: "tool", label: "sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789", operationId: "o-x" }), (e) => assert.match(e.message, /credential/));
    await refuses("invalid_command", () => c.jobs.admit(c.worker, { commandId: cid("ad"), taskId: c.t1, kind: "tool", label: "x", operationId: "o-y", extra: 1 } as never));
  });

  suite("an MCP operation is a job on an approved server: no new job on a revoked or unknown server, and with no connection check none at all", async (c) => {
    await refuses("invalid_command", () => c.admit(c.t1, { kind: "mcp", serverId: SERVER, resumability: "remote_tracked" }), (e) => assert.match(e.message, /cannot be checked/));
    let usable = true;
    const jobs = c.reopen({ connections: { usable: async (id) => id === SERVER && usable } });
    const admit = (serverId: string, op: string) => jobs.admit(c.worker, { commandId: cid("ad"), taskId: c.t1, kind: "mcp", label: "long export", operationId: op, serverId, resumability: "remote_tracked" });
    const first = await admit(SERVER, "mcp-1");
    await jobs.report(c.worker, { commandId: cid("rp"), jobId: first.id, state: "dispatched" });
    usable = false;
    await refuses("forbidden", () => admit(SERVER, "mcp-2"), (e) => assert.match(e.message, /revoked/));
    await refuses("forbidden", () => admit(derivedId("mcs", "other"), "mcp-3"));
    await refuses("invalid_command", () => jobs.admit(c.worker, { commandId: cid("ad"), taskId: c.t1, kind: "mcp", label: "x", operationId: "mcp-4", resumability: "remote_tracked" } as never), (e) => assert.equal(e.field, "serverId"));
    await refuses("invalid_command", () => jobs.admit(c.worker, { commandId: cid("ad"), taskId: c.t1, kind: "tool", label: "x", operationId: "t-5", serverId: SERVER }), (e) => assert.equal(e.field, "serverId"));
    // The operation already running is still a job: it is stopped like any remote job, with the same records.
    assert.equal((await jobs.requestCancel(c.both, { commandId: cid("cx"), jobId: first.id, reason: "the server was revoked" })).operation, "stop_remote_job");
  });

  suite("a job of a finished or missing task is not admitted, and a job whose task is gone is still readable by the owner", async (c) => {
    await refuses("not_found", () => c.admit(derivedId("task", "missing")));
    const id = await c.admit(c.t2);
    await c.projects.transitionTask({ commandId: cid("x"), actor: c.owner.id, taskId: c.t2, expectedRevision: 2, to: "cancelled" });
    await refuses("invalid_command", () => c.admit(c.t2), (e) => assert.match(e.message, /takes no new job/));
    assert.equal((await c.read(id)).state, "admitted");
  });
  suite("review fixes: a repeated admit is answered after the task is paused; output is redacted across reports, repaired and cut on a character; an outcome-unknown job is only settled by reconcile; a Force Stop is its own step", async (c) => {
    const first = await c.jobs.admit(c.worker, { commandId: "adm-1", taskId: c.t1, kind: "tool", label: "x", operationId: "op-replay" });
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: c.t1 }, reason: "hold" });
    const again = await c.jobs.admit(c.worker, { commandId: "adm-1", taskId: c.t1, kind: "tool", label: "x", operationId: "op-replay" });
    assert.deepEqual([again.id, again.replayed], [first.id, true], "the repeat is answered from its record, not refused for the pause");
    await c.pauses.resume(c.owner, { commandId: cid("rs"), scope: { kind: "task", id: c.t1 }, reason: "go" });
    // A secret split over two reports; NUL and a lone surrogate; a surrogate pair cut by the limit.
    const id = first.id;
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, output: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, output: "0123456789ABCD\u0000 end \ud800" });
    const out = (await c.read(id)).output.tail;
    assert.equal(out.includes("0123456789ABCD"), false, "the rest of a secret that began in the earlier report is gone too");
    assert.equal(out.includes("abcdefghijklmnopqrstuvwxyz"), false);
    assert.equal(out.includes("\u0000"), false);
    assert.ok(out.endsWith("end \ufffd"));
    // Characters the pattern matched but the old drop class did not, and a key block that goes on over several reports.
    const lk = await c.admit(c.t1, { kind: "tool" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: lk, state: "dispatched" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: lk, output: "password=abcd" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: lk, output: "!ef%gh ok\n-----BEGIN RSA PRIVATE KEY-----\nMIIEabc" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: lk, output: "\nSECONDLINEOFKEY\n-----END RSA PRIVATE KEY-----\nafter" });
    const kept = (await c.read(lk)).output.tail;
    for (const gone of ["!ef%gh", "MIIEabc", "SECONDLINEOFKEY"]) assert.equal(kept.includes(gone), false, gone);
    assert.ok(kept.includes("after"), "output after the key block is kept");
    // A header split over two reports, a certificate after a key, the private mark typed by the process itself, and a block that never ends.
    const sp = await c.admit(c.t1, { kind: "tool" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: sp, state: "dispatched" });
    for (const piece of ["x -----BEGIN RSA PRIV", "ATE KEY-----\nAAAA", "\nLEAK2\n-----END RSA PRIVATE KEY-----\n", "-----BEGIN PRIVATE KEY-----\nBBBB\n-----BEGIN CERTIFICATE-----\nCCCC", "\nLEAK3 \u0001key\u0001key-open-open\n-----END PRIVATE KEY-----\nvisible"]) await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: sp, output: piece });
    const spTail = (await c.read(sp)).output.tail;
    for (const gone of ["AAAA", "LEAK2", "BBBB", "CCCC", "LEAK3", "\u0001"]) assert.equal(spTail.includes(gone), false, gone);
    assert.ok(spTail.includes("visible"));
    const endless = await c.admit(c.t1, { kind: "tool" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: endless, state: "dispatched" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: endless, output: "-----BEGIN PRIVATE KEY-----\n" + "k".repeat(1000) });
    for (let i = 0; i < 17; i++) await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: endless, output: "k".repeat(1000) });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: endless, output: "\nlater output" });
    assert.ok((await c.read(endless)).output.tail.includes("later output"), "an unended block silences the job for a bounded stretch only");
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, output: "a".repeat(JOB_LIMITS.tail - 1) + "\u{1F600}" });
    const cut = (await c.read(id)).output.tail;
    assert.equal(cut.length <= JOB_LIMITS.tail, true);
    assert.equal(/^[\udc00-\udfff]/.test(cut), false, "the cut never starts in the middle of a character");
    // An outcome-unknown job is not completed by a restart decision.
    await c.jobs.markUnknown(c.worker, { commandId: cid("uk"), jobId: id, reason: "lost" });
    await refuses("invalid_command", () => c.jobs.decide(c.boss, { commandId: cid("dc"), jobId: id, decision: "complete", reason: "x", exit: { code: 0 } }), (e) => assert.match(e.message, /reconcile/));
    await c.jobs.reconcile(c.boss, { commandId: cid("rc"), jobId: id, to: "failed", evidence: "the host reports it was killed" });
    // Force Stop: asked for at once, or as the escalation of an unobeyed stop, and only once.
    const stubborn = await c.admit(c.t2, { kind: "tool" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: stubborn, state: "dispatched" });
    await c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: stubborn, reason: "stop it" });
    assert.equal((await c.read(stubborn)).cancel?.force, undefined);
    await c.jobs.confirmCancel(c.worker, { commandId: cid("cc"), jobId: stubborn, result: "uncooperative" });
    await c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: stubborn, reason: "it ignored the stop", force: true });
    const forced = await c.read(stubborn);
    assert.deepEqual([forced.cancel?.force, forced.state, forced.history.at(-1)?.note], [true, "cancellation_requested", "force stop: it ignored the stop"]);
    await refuses("invalid_command", () => c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: stubborn, reason: "again", force: true }), (e) => assert.match(e.message, /already being stopped/));
    const direct = await c.admit(c.t2, { kind: "remote", resumability: "remote_tracked" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: direct, state: "dispatched" });
    await c.jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: direct, reason: "now", force: true });
    assert.equal((await c.read(direct)).cancel?.force, true);
    // An orphan description with a token in it is redacted, not a reason for the stop to go unrecorded.
    await c.jobs.confirmCancel(c.worker, { commandId: cid("cc"), jobId: direct, result: "stopped", orphans: ["pid 77: curl -H 'Authorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD' x"] });
    assert.equal((await c.read(direct)).orphans[0]!.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), false);
  });

  suite("logs and artifacts must exist and belong to the job's project; a missing task reads as forbidden to a stranger; reconciliations are listed from the job", async (c) => {
    const id = await c.admit();
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched" });
    await refuses("invalid_command", () => c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, logs: [art("no-such")] }), (e) => assert.match(e.message, /not an artifact of this job's project/));
    const foreign = await c.artifact("foreign", c.other);
    await refuses("invalid_command", () => c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: id, outcome: "completed", artifacts: [foreign] }));
    await c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: id, outcome: "completed", artifacts: [await c.artifact("mine")] });
    await refuses("forbidden", () => c.jobs.list(c.stranger, derivedId("task", "no-such-task")));
    await refuses("not_found", () => c.jobs.list(c.owner, derivedId("task", "no-such-task")));
    assert.deepEqual(await c.jobs.reconciliation(c.owner, id), [], "a job that was never unknown has none");
    const lost = await c.admit(c.t1, { kind: "remote", resumability: "remote_tracked" });
    await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: lost, state: "dispatched" });
    await c.jobs.markUnknown(c.worker, { commandId: cid("uk"), jobId: lost, reason: "no answer" });
    const settled = await c.jobs.reconcile(c.boss, { commandId: cid("rc"), jobId: lost, to: "failed", evidence: "the host's log shows it was killed" });
    assert.deepEqual((await c.jobs.reconciliation(c.owner, lost)).map((r) => [r.id, r.to]), [[settled.reconciliationId, "failed"]]);
  });

  suite("the pause service records a finished job only for a background job of that task that has ended", async (c) => {
    const bg = await c.admit(c.t1, { kind: "tool", background: true });
    const plain = await c.admit(c.t1, { kind: "tool" });
    for (const id of [bg, plain]) await c.jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched" });
    const ask = (jobRef: string, taskId = c.t1) => c.pauses.recordFinishedJob(c.worker, { commandId: cid("fj"), taskId, jobRef, outcome: "succeeded", summary: "done" });
    await refuses("forbidden", () => ask(bg), (e) => assert.match(e.message, /finished background job/));
    await c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: bg, outcome: "completed" });
    await c.jobs.finish(c.worker, { commandId: cid("fn"), jobId: plain, outcome: "completed" });
    await refuses("forbidden", () => ask(plain));
    await refuses("forbidden", () => ask(bg, c.t2));
    await refuses("forbidden", () => ask(derivedId("job", "nobody")));
  });

}
