import assert from "node:assert/strict";
import { after, test } from "node:test";
import { DomainError, type DomainErrorCode } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { ProjectService } from "../domain/service.js";
import { backends, stopServer } from "../domain/testing/backends.js";
import { PauseService } from "../lifecycle/index.js";
import { GrantService, PrincipalService, type Grant, type Principal } from "../security/index.js";
import type { PauseOptions } from "../lifecycle/index.js";
import { JOB_LIMITS, JobService, LocalJobRuns, decideAtStart, type JobBody, type JobLauncher, type JobOptions, type JobProcessEnd } from "./index.js";
import type { ScriptLaunch } from "../toolbridge/index.js";
import { callToolAsJob, type McpJobCall, type RemoteToolResult } from "../mcp/index.js";

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

  suite("long-running work is asked of the host's gate before it is admitted; short work is not (card M04e)", async (c) => {
    const asked: string[] = [];
    const jobs = c.reopen({ longRunningGate: async (_p, taskId) => { asked.push(taskId); return taskId === c.t2 ? "in a meeting" : undefined; } });
    const go = (taskId: string, extra: object) => jobs.admit(c.worker, { commandId: cid("a"), taskId, kind: "tool", label: "x", operationId: cid("op"), ...extra } as never);
    await go(c.t2, {});
    assert.deepEqual(asked, [], "short work is not asked about");
    await refuses("invalid_command", () => go(c.t2, { longRunning: true }), (e) => assert.match(e.message, /in a meeting/));
    await refuses("invalid_command", () => go(c.t2, { background: true }));
    await go(c.t1, { longRunning: true });
    await go(c.t1, { background: true });
    assert.deepEqual(asked, [c.t2, c.t2, c.t1, c.t1]);
    await refuses("invalid_command", () => go(c.t1, { longRunning: "yes" }));
  });

  suite("the controller's own list of a task's unfinished jobs needs no viewer's rights, skips ended jobs and reads past one page (card L02c)", async (c) => {
    await c.admit(c.t1);
    for (let i = 0; i < JOB_LIMITS.page + 5; i++) await c.admit(c.t1);
    await c.admit(c.t2);
    const found = await c.jobs.unfinishedOf(c.t1);
    assert.equal(found.length, JOB_LIMITS.page + 6, "every unfinished job of the task, past the first page, and none of another task");
    assert.ok(found.every((j) => !["completed", "failed", "cancelled"].includes(j.state)));
    await refuses("forbidden", () => c.jobs.list(c.stranger, c.t1));
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
    // A job that is not a background job is charged as well, and one that failed.
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

  suite("every way a job ends is reported once for charging: a stop that was obeyed, a reconciliation, a restart decision of complete; nothing else is (card R05f)", async (c) => {
    const seen: string[] = [];
    const jobs = c.reopen({ onUsage: async (u) => { seen.push(`${u.jobId}:${u.computeMs}`); } });
    const go = async (kind: "tool" | "remote", extra: Record<string, unknown> = {}): Promise<string> => {
      const id = (await jobs.admit(c.worker, { commandId: cid("ad"), taskId: c.t1, kind, label: "x", operationId: `op-e-${cid("o")}`, ...(kind === "remote" ? { resumability: "remote_tracked" as const } : {}), ...extra })).id;
      await jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "dispatched", host: "h-1" });
      await jobs.report(c.worker, { commandId: cid("rp"), jobId: id, state: "running" });
      now += 10_000;
      return id;
    };
    // A stop asked for and not obeyed charges nothing; the obeyed stop does.
    const stopped = await go("tool");
    await jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: stopped, reason: "stop" });
    await jobs.confirmCancel(c.worker, { commandId: cid("cc"), jobId: stopped, result: "uncooperative" });
    assert.deepEqual(seen, []);
    await jobs.confirmCancel(c.worker, { commandId: cid("cc"), jobId: stopped, result: "stopped" });
    assert.deepEqual(seen, [`${stopped}:10000`]);
    // An outcome that was unknown is charged when the evidence settles it, not before.
    const unknown = await go("remote");
    await jobs.markUnknown(c.worker, { commandId: cid("uk"), jobId: unknown, reason: "the host stopped answering" });
    assert.equal(seen.length, 1);
    now += 5_000;
    await jobs.reconcile(c.boss, { commandId: cid("rc"), jobId: unknown, to: "completed", evidence: "the log shows exit 0", exit: { code: 0 } });
    assert.deepEqual(seen.at(-1), `${unknown}:15000`);
    // A restart decision of complete is charged; restart, exception and a request to cancel are not (the job goes on).
    const complete = await go("tool");
    const restart = await go("tool", { resumability: "tool_checkpoint" });
    await jobs.report(c.worker, { commandId: cid("rp"), jobId: restart, checkpoint: "ckpt-1" });
    const tracked = await go("remote");
    const before = seen.length;
    await jobs.decide(c.boss, { commandId: cid("dc"), jobId: restart, decision: "restart", reason: "controller restarted" });
    await jobs.decide(c.boss, { commandId: cid("dc"), jobId: tracked, decision: "exception", reason: "outlives the controller", tracker: "owner" });
    assert.equal(seen.length, before, "a job that goes on is not charged yet");
    await jobs.decide(c.boss, { commandId: cid("dc"), jobId: complete, decision: "complete", reason: "its output is complete", exit: { code: 0, reason: "found the finished file" } });
    assert.equal(seen.length, before + 1);
    assert.match(seen.at(-1)!, new RegExp(`^${complete}:\\d+$`));
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

  // ---- card T07b ------------------------------------------------------------------------------------------------------------------

  const HOST = "service:dispatcher";
  const hostOf = (): Principal => ({ id: HOST, kind: "service", name: "dispatcher", grants: [] });
  const scoped = (p: Principal, projectId: string, taskId: string): Principal => ({ ...p, taskScope: { projectId, taskId } });

  suite("the controller's job host records and controls any job; a task credential stops only its own task's jobs, with job.write there; every stop is told to the host once committed (card T07b)", async (c) => {
    const told: [string, boolean][] = [];
    const jobs = c.reopen({ host: HOST, onCancel: (id, force) => { told.push([id, force]); throw new Error("a failing host never fails the request"); } });
    const host = hostOf();
    // Another service, or one with the host's name but another kind, is nobody.
    const impostor: Principal = { ...host, kind: "agent" };
    const other: Principal = { ...host, id: "service:other" };
    const id = await c.admit(c.t1);
    for (const p of [impostor, other]) await refuses("forbidden", () => jobs.report(p, { commandId: cid("rp"), jobId: id, state: "dispatched" }));
    assert.equal(await jobs.get(other, id), undefined);
    await jobs.report(host, { commandId: cid("rp"), jobId: id, state: "dispatched" });
    await jobs.report(host, { commandId: cid("rp"), jobId: id, state: "running", output: "step 1\n" });
    assert.equal((await jobs.get(host, id))?.state, "running");
    // A credential of task two may not stop task one's job, even holding job.write on the project; one of task one may.
    await refuses("forbidden", () => jobs.requestCancel(scoped(c.worker, c.project, c.t2), { commandId: cid("cx"), jobId: id, reason: "not mine" }));
    await refuses("forbidden", () => jobs.requestCancel(scoped(c.reader, c.project, c.t1), { commandId: cid("cx"), jobId: id, reason: "only reads" }));
    assert.deepEqual(told, [], "a refused stop is not told to the host");
    const own = scoped(c.worker, c.project, c.t1);
    await jobs.requestCancel(own, { commandId: "own-stop", jobId: id, reason: "done with it" });
    await jobs.requestCancel(own, { commandId: "own-stop", jobId: id, reason: "done with it" });
    await jobs.requestCancel(own, { commandId: cid("cx"), jobId: id, reason: "it ignored me", force: true });
    assert.deepEqual(told, [[id, false], [id, false], [id, true]], "the stop, its repeat and the Force Stop each reach the host");
    // Without job.control, a task credential still cannot take restart decisions or reconcile.
    await refuses("forbidden", () => jobs.decide(own, { commandId: cid("dc"), jobId: id, decision: "exception", reason: "x", tracker: "me" }));
    await jobs.confirmCancel(host, { commandId: cid("cc"), jobId: id, result: "stopped", orphans: ["pid 9 (sleep 600)"] });
    assert.deepEqual([(await c.read(id)).state, (await c.read(id)).orphans], ["cancelled", ["pid 9 (sleep 600)"]]);
    // A decision to cancel is told too.
    const two = await c.admit(c.t1);
    await jobs.decide(host, { commandId: cid("dc"), jobId: two, decision: "cancel", reason: "after a restart" });
    assert.deepEqual(told.at(-1), [two, false]);
  });

  suite("at start every live job gets a decision by the rule for its class, once, and jobs admitted after the start are left alone (card T07b)", async (c) => {
    const jobs = c.reopen({ host: HOST });
    const host = hostOf();
    const running = await c.admit(c.t1);
    await jobs.report(host, { commandId: cid("rp"), jobId: running, state: "dispatched", host: "host:here" });
    const never = await c.admit(c.t1);
    const stopping = await c.admit(c.t1);
    await jobs.report(host, { commandId: cid("rp"), jobId: stopping, state: "dispatched", host: "host:here" });
    await jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: stopping, reason: "stop" });
    const remoteTracked = await c.admit(c.t2, { kind: "remote", resumability: "remote_tracked" });
    await jobs.report(host, { commandId: cid("rp"), jobId: remoteTracked, state: "running" as never }).catch(() => undefined);
    await jobs.report(host, { commandId: cid("rp"), jobId: remoteTracked, state: "dispatched" });
    const remoteLoose = await c.admit(c.t2, { kind: "remote" });
    await jobs.report(host, { commandId: cid("rp"), jobId: remoteLoose, state: "dispatched" });
    const elsewhere = await c.admit(c.t2);
    await jobs.report(host, { commandId: cid("rp"), jobId: elsewhere, state: "dispatched", host: "host:far" });
    const checkpointed = await c.admit(c.t1, { resumability: "tool_checkpoint" });
    await jobs.report(host, { commandId: cid("rp"), jobId: checkpointed, state: "dispatched", checkpoint: "ckpt-1", host: "host:here" });
    const unknownAlready = await c.admit(c.t1);
    await jobs.report(host, { commandId: cid("rp"), jobId: unknownAlready, state: "dispatched" });
    await jobs.markUnknown(host, { commandId: cid("uk"), jobId: unknownAlready, reason: "lost" });
    const finished = await c.admit(c.t1);
    await jobs.report(host, { commandId: cid("rp"), jobId: finished, state: "dispatched" });
    await jobs.finish(host, { commandId: cid("fn"), jobId: finished, outcome: "completed" });
    now += 1000;
    const before = clock();
    now += 1000;
    const late = await c.admit(c.t1);
    const relaunched: string[] = [];
    const rule = { epoch: 7, before, isLocal: (h: string) => h === "host:here" };
    const report = await decideAtStart(jobs, host, rule);
    assert.deepEqual(report.failed, []);
    const ruleOf = new Map(report.decided.map((d) => [d.jobId, d.rule]));
    assert.deepEqual([running, never, stopping, remoteTracked, remoteLoose, elsewhere, checkpointed, unknownAlready].map((j) => ruleOf.get(j)), ["outcome_unknown", "stopped", "outcome_unknown", "exception", "outcome_unknown", "exception", "outcome_unknown", "unchanged"]);
    assert.equal(ruleOf.has(finished), false, "a finished job is not live");
    assert.equal(ruleOf.has(late), false, "a job admitted after the start is not judged");
    const states = async (ids: string[]) => Promise.all(ids.map(async (j) => (await c.read(j)).state));
    assert.deepEqual(await states([running, never, stopping, remoteLoose, checkpointed, late]), ["outcome_unknown", "cancelled", "outcome_unknown", "outcome_unknown", "outcome_unknown", "admitted"]);
    assert.deepEqual([(await c.read(remoteTracked)).exception?.tracker, (await c.read(elsewhere)).exception?.tracker], ["owner", "host:far"]);
    assert.match((await c.read(checkpointed)).unknown!.reason, /checkpoint/);
    // No live job is left without a decision: what is still live is either the late one or waiting for a reconciliation.
    const left = (await jobs.live(c.owner)).jobs.map((j) => [j.id, j.state]);
    assert.deepEqual(left.filter(([, s]) => s !== "outcome_unknown").map(([j]) => j), [late]);
    // Asking again (the same start) repeats nothing; a relauncher is asked for a tool that left a checkpoint.
    assert.deepEqual((await decideAtStart(jobs, host, rule)).decided.filter((d) => d.rule !== "unchanged"), []);
    const fresh = await c.admit(c.t1, { resumability: "tool_checkpoint" });
    await jobs.report(host, { commandId: cid("rp"), jobId: fresh, state: "dispatched", checkpoint: "ckpt-2", host: "host:here" });
    now += 1000;
    const again = await decideAtStart(jobs, host, { epoch: 8, before: clock(), isLocal: rule.isLocal, relaunch: async (j) => { relaunched.push(j.id); return true; } });
    assert.deepEqual(relaunched, [fresh]);
    assert.equal(again.decided.find((d) => d.jobId === fresh)?.rule, "unchanged");
    assert.deepEqual([again.decided.find((d) => d.jobId === late)?.rule, (await c.read(late)).state], ["stopped", "cancelled"], "the next start judges what the last one left alone");
    // A principal without the rights fails each decision, and the run says which.
    const unseen = await c.admit(c.t1);
    now += 1000;
    const refused = await decideAtStart(jobs, c.reader, { epoch: 9, before: clock(), isLocal: () => true });
    assert.ok(refused.failed.some((f) => f.jobId === unseen), JSON.stringify(refused));
    assert.equal((await c.read(unseen)).state, "admitted");
  });

  suite("a long-running MCP operation is a job: admitted only on an approved server, called once, ended with the server's answer, failed when refused before sending and outcome-unknown when no answer came (card T07b)", async (c) => {
    const approved = new Set([SERVER]);
    const jobs = c.reopen({ host: HOST, connections: { usable: async (id) => approved.has(id) } });
    const host = hostOf();
    const calls: string[] = [];
    let answer: () => Promise<RemoteToolResult> = async () => ({ content: [{ type: "text", text: `found 3 pages; Authorization: Bearer ${"abcdefghijklmnopqrstuvwxyz0123456789ABCD"}` }], isError: false });
    const client = { callTool: async (serverId: string, name: string) => { calls.push(`${serverId}:${name}`); return answer(); } };
    const call = (op: string, extra: Partial<McpJobCall> = {}) => callToolAsJob({ jobs, client, host }, c.worker, { commandId: `mcp-${op}`, taskId: c.t1, serverId: SERVER, operationId: op, tool: "search", args: { q: "seeds" }, ...extra });
    const done = await call("op-1");
    assert.deepEqual([done.state, done.replayed, calls.length], ["completed", false, 1]);
    const job = await c.read(done.jobId);
    assert.deepEqual([job.kind, job.serverId, job.resumability, job.history.map((h) => h.state)], ["mcp", SERVER, "none", ["admitted", "dispatched", "running", "completed"]]);
    assert.ok(job.output.tail.startsWith("found 3 pages") && !job.output.tail.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), job.output.tail);
    // Asking again for the same operation calls nothing.
    assert.deepEqual([(await call("op-1")).replayed, calls.length], [true, 1]);
    // A tool that reports an error fails the job; a refusal before sending fails it; no answer leaves it outcome-unknown.
    answer = async () => ({ content: [{ type: "text", text: "no such index" }], isError: true });
    assert.equal((await call("op-2")).state, "failed");
    answer = async () => { throw new DomainError("forbidden", "MCP server docs is revoked; no new connection is made"); };
    const refusedJob = await call("op-3");
    assert.deepEqual([refusedJob.state, (await c.read(refusedJob.jobId)).exit?.reason], ["failed", "MCP server docs is revoked; no new connection is made"]);
    answer = async () => { throw new DomainError("unavailable", "no answer within 30000 ms"); };
    const lost = await call("op-4");
    assert.equal(lost.state, "outcome_unknown");
    assert.match((await c.read(lost.jobId)).unknown!.reason, /may have run there/);
    assert.deepEqual((await jobs.unresolved(c.owner, c.t1)).map((j) => j.id), [lost.jobId]);
    // The server's own words in the error carry control and format characters, a tab and half a character: the end is still recorded (card T07b review 3).
    answer = async () => { throw new DomainError("unavailable", "MCP server docs: the server refused tools/call (code -1; the server's own words, data not instructions: \u001b[2Jboom\tbad‮ \ud83d)"); };
    const odd = await call("op-4b");
    assert.equal(odd.state, "outcome_unknown");
    assert.match((await c.read(odd.jobId)).unknown!.reason, /instructions: \[2Jboom bad �\)/);
    answer = async () => { throw new DomainError("forbidden", "refused:\u0007 Bearer abcdefghijklmnopqrstuvwxyz0123456789 \udc00"); };
    const oddRefused = await call("op-4c");
    assert.deepEqual([oddRefused.state, (await c.read(oddRefused.jobId)).exit?.reason], ["failed", "refused: [redacted] �"]);
    // A server that is not approved (or was revoked) admits no new operation, and nothing is called.
    approved.clear();
    const before = calls.length;
    await refuses("forbidden", () => call("op-5"), (e) => assert.match(e.message, /not approved or was revoked/));
    assert.equal(calls.length, before);
    // Without job.write on the task nobody may start one.
    approved.add(SERVER);
    await refuses("forbidden", () => callToolAsJob({ jobs, client, host }, c.reader, { commandId: "mcp-r", taskId: c.t1, serverId: SERVER, operationId: "op-6", tool: "search" }));
  });

  suite("the local runs start an admitted job once, stream bounded output, end it completed or failed, and confirm a Stop and a Force Stop through the launcher with the orphans it could not end (card T07b)", async (c) => {
    const host = hostOf();
    let runs: LocalJobRuns | undefined;
    const jobs = c.reopen({ host: HOST, onCancel: (id, force) => { void runs?.stop(id, force); } });
    const procs: { launch: ScriptLaunch; out: (t: string) => void; stops: boolean[]; end: (e: Partial<JobProcessEnd>) => void; obey: boolean }[] = [];
    const launcher: JobLauncher = {
      start: async (launch, out) => {
        if (launch.tool.name === "refused") throw new Error("these limits cannot be fully enforced on this host");
        let end!: (e: JobProcessEnd) => void;
        const ended = new Promise<JobProcessEnd>((resolve) => { end = resolve; });
        const p = { launch, out, stops: [] as boolean[], obey: true, end: (e: Partial<JobProcessEnd>) => end({ exitCode: null, signal: null, timedOut: false, stopped: false, orphans: [], ...e }) };
        procs.push(p);
        return { stop: (force) => { p.stops.push(force); if (p.obey || force) p.end({ signal: "SIGKILL", stopped: true, orphans: force ? ["pid 41 (sleep 600)"] : [] }); }, ended };
      },
    };
    runs = new LocalJobRuns({ jobs, principal: () => host, launcher, limits: { perTask: 2, total: 3, flushMs: 5, flushChars: 64, outputBytes: 4096, graceMs: 50 } });
    const launch = (name = "a_x.build"): ScriptLaunch => ({ program: "node", argv: ["main.js"], stdin: "{}", source: "", tool: { name, version: "1.0.0", digest: "d" }, interpreterVersion: "22", maxOutputBytes: 1024, limits: { cpus: 1, memoryMb: 64, seconds: 60 }, env: {} });
    // Waits by the clock, not by a number of looks (a slow Windows worker thread reads the store much more slowly).
    const waitFor = async (ok: () => Promise<boolean>): Promise<void> => { const end = Date.now() + 20_000; while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
    const settle = async (id: string, state: string) => { await waitFor(async () => (await c.read(id)).state === state); assert.equal((await c.read(id)).state, state); };

    // Completed: output arrives in pieces, redacted, kept at the end; started once however often it is asked.
    const ok = await c.admit(c.t1);
    await Promise.all([runs.start(ok, c.t1, launch()), runs.start(ok, c.t1, launch())]);
    assert.equal(procs.length, 1, "one process for one job");
    await runs.start(ok, c.t1, launch());
    assert.equal(procs.length, 1);
    await refuses("forbidden", () => runs!.start(ok, c.t2, launch()).then(() => { throw new DomainError("forbidden", "the job is running already"); }));
    procs[0]!.out("line one\nAuthorization: Bearer abcdefghijklmnopqrstuvwxyz0123456789ABCD\n");
    procs[0]!.out("line two\n");
    procs[0]!.end({ exitCode: 0 });
    await settle(ok, "completed");
    const done = await c.read(ok);
    assert.ok(done.output.tail.includes("line two"), JSON.stringify(done.output));
    assert.equal(done.output.tail.includes("abcdefghijklmnopqrstuvwxyz0123456789ABCD"), false);
    assert.deepEqual(done.history.map((h) => h.state), ["admitted", "dispatched", "running", "completed"]);
    assert.deepEqual(runs.running(), []);

    // Failed: a non-zero exit, a time limit, too much output, a launcher refusal; each with its reason.
    const failed = async (end: Partial<JobProcessEnd> | "flood" | "refused", reason: RegExp) => {
      const id = await c.admit(c.t1);
      await runs!.start(id, c.t1, launch(end === "refused" ? "refused" : undefined));
      if (end === "flood") { procs.at(-1)!.out("y".repeat(5000)); } else if (end !== "refused") procs.at(-1)!.end(end);
      await settle(id, "failed");
      assert.match((await c.read(id)).exit?.reason ?? "", reason);
    };
    await failed({ exitCode: 3 }, /exited with code 3/);
    await failed({ timedOut: true, signal: "SIGKILL" }, /longer than its tool's time limit/);
    await failed("flood", /wrote more than 4096 bytes/);
    await failed("refused", /could not be started: these limits/);

    // Stop: the launcher ends the process; the stop is confirmed (cancelled). Force Stop of a process that ignored the Stop: recorded as not obeyed first, then cancelled with the orphans the launcher reported.
    const polite = await c.admit(c.t1);
    await runs.start(polite, c.t1, launch());
    await jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: polite, reason: "enough" });
    await settle(polite, "cancelled");
    assert.deepEqual(procs.at(-1)!.stops, [false]);
    const stubborn = await c.admit(c.t1);
    await runs.start(stubborn, c.t1, launch());
    procs.at(-1)!.obey = false;
    await jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: stubborn, reason: "enough" });
    await waitFor(async () => (await c.read(stubborn)).cancel?.uncooperative === true);
    assert.deepEqual([(await c.read(stubborn)).state, (await c.read(stubborn)).cancel?.uncooperative], ["cancellation_requested", true]);
    await jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: stubborn, reason: "now", force: true });
    await settle(stubborn, "cancelled");
    assert.deepEqual([procs.at(-1)!.stops, (await c.read(stubborn)).orphans], [[false, true], ["pid 41 (sleep 600)"]]);

    // Bounded: two per task, three in all; a job beyond them fails with the reason and is never left admitted.
    const a1 = await c.admit(c.t1), a2 = await c.admit(c.t1), a3 = await c.admit(c.t1), b1 = await c.admit(c.t2), b2 = await c.admit(c.t2);
    await runs.start(a1, c.t1, launch()); await runs.start(a2, c.t1, launch());
    assert.match(runs.room(c.t1) ?? "", /this task already has 2 jobs/);
    await runs.start(a3, c.t1, launch());
    await settle(a3, "failed");
    await runs.start(b1, c.t2, launch());
    assert.match(runs.room(c.t2) ?? "", /already runs 3 jobs/);
    await runs.start(b2, c.t2, launch());
    await settle(b2, "failed");
    // Closing ends what runs and records why.
    await runs.close();
    for (const id of [a1, a2, b1]) { await settle(id, "failed"); assert.match((await c.read(id)).exit?.reason ?? "", /controller shut down/); }
    assert.match(runs.room(c.t1) ?? "", /shutting down/);
  });

  suite("the local runs stop the jobs of a task that has ended, confirm a stop asked before the process started, and record an end whose orphan names and reason carry control characters (card T07b review)", async (c) => {
    const host = hostOf();
    let runs: LocalJobRuns | undefined;
    const jobs = c.reopen({ host: HOST, onCancel: (id, force) => { void runs?.stop(id, force); } });
    const procs: { stops: boolean[]; end: (e: Partial<JobProcessEnd>) => void }[] = [];
    const launcher: JobLauncher = {
      start: async () => {
        let end!: (e: JobProcessEnd) => void;
        const ended = new Promise<JobProcessEnd>((resolve) => { end = resolve; });
        const p = { stops: [] as boolean[], end: (e: Partial<JobProcessEnd>) => end({ exitCode: null, signal: null, timedOut: false, stopped: false, orphans: [], ...e }) };
        procs.push(p);
        return { stop: (force) => { p.stops.push(force); p.end({ signal: "SIGKILL", stopped: true }); }, ended };
      },
    };
    const ended = new Set<string>();
    // A long sweep period: the test sweeps by hand.
    runs = new LocalJobRuns({ jobs, principal: () => host, launcher, taskEnded: async (taskId) => ended.has(taskId), limits: { flushMs: 5, graceMs: 50, sweepMs: 3_600_000 } });
    const launch: ScriptLaunch = { program: "node", argv: ["main.js"], stdin: "{}", source: "", tool: { name: "a_x.build", version: "1.0.0", digest: "d" }, interpreterVersion: "22", maxOutputBytes: 1024, limits: { cpus: 1, memoryMb: 64, seconds: 60 }, env: {} };
    const waitFor = async (ok: () => Promise<boolean>): Promise<void> => { const end = Date.now() + 20_000; while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
    const settle = async (id: string, state: string) => { await waitFor(async () => (await c.read(id)).state === state); assert.equal((await c.read(id)).state, state); };

    // The task of one job ends (cancelled, final); the other task goes on. A sweep stops only the job of the ended task, as a recorded Stop by the job host.
    const mine = await c.admit(c.t2), theirs = await c.admit(c.t1);
    await runs.start(mine, c.t2, launch); await runs.start(theirs, c.t1, launch);
    await settle(mine, "running"); await settle(theirs, "running");
    assert.deepEqual(await runs.sweep(), [], "no task has ended: nothing is stopped");
    await c.projects.transitionTask({ commandId: cid("end"), actor: c.owner.id, taskId: c.t2, expectedRevision: 2, to: "cancelled" });
    ended.add(c.t2);
    assert.deepEqual(await runs.sweep(), [mine]);
    await settle(mine, "cancelled");
    assert.deepEqual([procs[0]!.stops, (await c.read(mine)).cancel?.requestedBy, (await c.read(mine)).cancel?.reason], [[false], HOST, "its task has ended (done or cancelled); a job does not run on after its task"]);
    assert.equal((await c.read(theirs)).state, "running", "a job of a task that goes on runs on");
    assert.deepEqual(await runs.sweep(), [], "asking again stops nothing more");

    // A stop asked after the admission and before the process was started: nothing started, so the stop is confirmed at once and no process is launched.
    const early = await c.admit(c.t1);
    await jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: early, reason: "not needed after all" });
    const launched = procs.length;
    await runs.start(early, c.t1, launch);
    await settle(early, "cancelled");
    assert.equal(procs.length, launched, "nothing was launched for it");

    // The job's program can rename a process it leaves behind (and a launch failure carries text it shaped): control characters never keep the end from being recorded.
    procs[1]!.end({ exitCode: 2, orphans: ["pid 7 (\u001b[2Jevil\u0007)", "\u0000\u0001"], problem: "the job could not be started: \u001b]0;title\u0007 bad\tthing‮" });
    await settle(theirs, "failed");
    const failedJob = await c.read(theirs);
    assert.deepEqual(failedJob.orphans, ["pid 7 ([2Jevil)", "an unnamed process"]);
    assert.equal(failedJob.exit?.reason, "the job could not be started: ]0;title bad thing");
    await runs.close();
  });

  suite("the local runs settle a job whose dispatch could not be recorded (a stop landed first, or the store refused), never take a failed task check for an ended task, and stop a job whose output passed the bound before its process was handed over (card T07b review 3)", async (c) => {
    const host = hostOf();
    let runs: LocalJobRuns | undefined;
    const real = c.reopen({ host: HOST, onCancel: (id, force) => { void runs?.stop(id, force); } });
    // Before the dispatch is recorded: `beforeDispatch` runs (a stop from the owner, the agent or the sweep lands there), or the store refuses it.
    let beforeDispatch: ((jobId: string) => Promise<void>) | undefined;
    const jobs: Pick<JobService, "get" | "report" | "finish" | "confirmCancel" | "requestCancel"> = {
      get: (...a) => real.get(...a), finish: (...a) => real.finish(...a), confirmCancel: (...a) => real.confirmCancel(...a), requestCancel: (...a) => real.requestCancel(...a),
      report: async (p, cmd) => { if (cmd.state === "dispatched" && beforeDispatch !== undefined) await beforeDispatch(cmd.jobId); return real.report(p, cmd); },
    };
    const procs: { out: (t: string) => void; stops: boolean[]; end: (e: Partial<JobProcessEnd>) => void }[] = [];
    let burst: string | undefined;
    const launcher: JobLauncher = {
      start: async (_launch, out) => {
        let end!: (e: JobProcessEnd) => void;
        const ended = new Promise<JobProcessEnd>((resolve) => { end = resolve; });
        const p = { out, stops: [] as boolean[], end: (e: Partial<JobProcessEnd>) => end({ exitCode: null, signal: null, timedOut: false, stopped: false, orphans: [], ...e }) };
        procs.push(p);
        // Output that arrives before the launcher has handed the process over.
        if (burst !== undefined) out(burst);
        return { stop: (force) => { p.stops.push(force); p.end({ signal: "SIGKILL", stopped: true }); }, ended };
      },
    };
    let taskCheck: (taskId: string) => Promise<boolean> = async () => false;
    const errors: unknown[] = [];
    runs = new LocalJobRuns({ jobs, principal: () => host, launcher, taskEnded: (taskId) => taskCheck(taskId), onError: (e) => { errors.push(e); }, limits: { flushMs: 5, graceMs: 5_000, outputBytes: 4096, sweepMs: 3_600_000 } });
    const launch: ScriptLaunch = { program: "node", argv: ["main.js"], stdin: "{}", source: "", tool: { name: "a_x.build", version: "1.0.0", digest: "d" }, interpreterVersion: "22", maxOutputBytes: 1024, limits: { cpus: 1, memoryMb: 64, seconds: 60 }, env: {} };
    const waitFor = async (ok: () => Promise<boolean>): Promise<void> => { const end = Date.now() + 20_000; while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
    const settle = async (id: string, state: string) => { await waitFor(async () => (await c.read(id)).state === state); assert.equal((await c.read(id)).state, state); };

    // A stop lands while the start is recording the dispatch: nothing is launched, the stop is confirmed (the job is cancelled, never left being stopped), and the start answers quietly.
    const raced = await c.admit(c.t1);
    beforeDispatch = async (jobId) => { await real.requestCancel(c.boss, { commandId: cid("cx"), jobId, reason: "stopped while it was being started" }); };
    await runs.start(raced, c.t1, launch);
    beforeDispatch = undefined;
    assert.equal(procs.length, 0, "nothing was launched for it");
    await settle(raced, "cancelled");
    assert.deepEqual(runs.running(), []);
    // The store refuses the dispatch: the error reaches the caller, and the job does not stay admitted for ever (stopped and confirmed, nothing launched).
    const refused = await c.admit(c.t1);
    beforeDispatch = async () => { throw new Error("the store is unavailable"); };
    await assert.rejects(runs.start(refused, c.t1, launch), /the store is unavailable/);
    beforeDispatch = undefined;
    assert.equal(procs.length, 0);
    await settle(refused, "cancelled");

    // A task check that fails is not an ended task: nothing is stopped (fail-safe), and the failure is told.
    const kept = await c.admit(c.t1);
    await runs.start(kept, c.t1, launch);
    await settle(kept, "running");
    // A secret the program is in the middle of writing when a write to the record is due: its first part is held back (alone it is not recognisable as a secret), and the whole of it is redacted once the rest comes.
    procs[0]!.out("first line\nthe key is AKIA0123456789AB");
    await waitFor(async () => (await c.read(kept)).output.tail.includes("the key is"));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal((await c.read(kept)).output.tail, "first line\nthe key is ", "the unfinished word is held back");
    procs[0]!.out("CDEF in use\n");
    await waitFor(async () => (await c.read(kept)).output.tail.includes("in use"));
    assert.equal((await c.read(kept)).output.tail, "first line\nthe key is [redacted] in use\n");
    // A word held back when the job ends is written with its end.
    const last = await c.admit(c.t2);
    await runs.start(last, c.t2, launch);
    procs.at(-1)!.out("all done");
    procs.at(-1)!.end({ exitCode: 0 });
    await settle(last, "completed");
    assert.equal((await c.read(last)).output.tail, "all done");
    taskCheck = async () => { throw new Error("the store is unavailable"); };
    assert.deepEqual(await runs.sweep(), []);
    assert.equal((await c.read(kept)).state, "running");
    assert.deepEqual(procs[0]!.stops, []);
    assert.ok(errors.some((e) => e instanceof Error && /store is unavailable/.test(e.message)), "the failed check is told");
    // A task that has merely been paused has not ended: its job runs on.
    await c.pauses.pause(c.owner, { commandId: cid("pz"), scope: { kind: "task", id: c.t1 }, reason: "a pause is not an end" });
    taskCheck = async (taskId) => { const t = await c.projects.getTask(taskId); return t === undefined || t.state === "done" || t.state === "cancelled"; };
    assert.deepEqual(await runs.sweep(), []);
    assert.equal((await c.read(kept)).state, "running");

    // Output past the bound before the launcher handed the process over: the process is stopped once it is, and the job fails for its output.
    burst = "z".repeat(5000);
    const flood = await c.admit(c.t2);
    await runs.start(flood, c.t2, launch);
    burst = undefined;
    await settle(flood, "failed");
    assert.deepEqual([procs.at(-1)!.stops, (await c.read(flood)).exit?.reason], [[true], "the job wrote more than 4096 bytes and was stopped"]);
    await runs.close();
  });

  suite("a task credential never decides or reconciles a job, even its own task's with job.control, and never stops another task's job; the same agent without the task scope may (card T07b review)", async (c) => {
    const scoped: Principal = { ...c.both, taskScope: { taskId: c.t1, projectId: c.project } };
    const own = await c.admit(c.t1), others = await c.admit(c.t2), unknown = await c.admit(c.t1);
    await c.jobs.report(c.worker, { commandId: cid("d"), jobId: unknown, state: "dispatched" });
    await c.jobs.markUnknown(c.worker, { commandId: cid("u"), jobId: unknown, reason: "the controller restarted" });
    await refuses("forbidden", () => c.jobs.decide(scoped, { commandId: cid("dx"), jobId: own, decision: "exception", tracker: "owner", reason: "keep it" }), (e) => assert.match(e.message, /task credential may not decide/));
    await refuses("forbidden", () => c.jobs.reconcile(scoped, { commandId: cid("rc"), jobId: unknown, to: "completed", evidence: "I say it finished" }));
    await refuses("forbidden", () => c.jobs.requestCancel(scoped, { commandId: cid("cx"), jobId: others, reason: "not mine" }));
    assert.equal((await c.jobs.requestCancel(scoped, { commandId: cid("cx"), jobId: own, reason: "mine" })).operation, "stop_tool", "its own task's job it may stop");
    // The same agent, not bound to a task (a supervisor), may.
    await c.jobs.reconcile(c.both, { commandId: cid("rc"), jobId: unknown, to: "completed", evidence: "the build log shows it finished" });
    assert.equal((await c.read(unknown)).state, "completed");
    await c.jobs.requestCancel(c.both, { commandId: cid("cx"), jobId: others, reason: "a supervisor's stop" });
    assert.equal((await c.read(others)).state, "cancellation_requested");
  });

  suite("the local runs never record a line of a multi-line private key or a spaced secret written across many writes, and a job stopped in the middle of one writes its held-back end redacted (card T07b review 4)", async (c) => {
    const host = hostOf();
    let runs: LocalJobRuns | undefined;
    const jobs = c.reopen({ host: HOST, onCancel: (id, force) => { void runs?.stop(id, force); } });
    const procs: { out: (t: string) => void; end: (e: Partial<JobProcessEnd>) => void }[] = [];
    const launcher: JobLauncher = {
      start: async (_launch, out) => {
        let end!: (e: JobProcessEnd) => void;
        const ended = new Promise<JobProcessEnd>((resolve) => { end = resolve; });
        const p = { out, end: (e: Partial<JobProcessEnd>) => end({ exitCode: null, signal: null, timedOut: false, stopped: false, orphans: [], ...e }) };
        procs.push(p);
        return { stop: () => { p.end({ signal: "SIGKILL", stopped: true }); }, ended };
      },
    };
    runs = new LocalJobRuns({ jobs, principal: () => host, launcher, limits: { flushMs: 5, graceMs: 5_000, sweepMs: 3_600_000 } });
    const launch: ScriptLaunch = { program: "node", argv: ["main.js"], stdin: "{}", source: "", tool: { name: "a_x.build", version: "1.0.0", digest: "d" }, interpreterVersion: "22", maxOutputBytes: 1024, limits: { cpus: 1, memoryMb: 64, seconds: 60 }, env: {} };
    const waitFor = async (ok: () => Promise<boolean>): Promise<void> => { const end = Date.now() + 20_000; while (!(await ok()) && Date.now() < end) await new Promise((r) => setTimeout(r, 10)); };
    // Pieces of the secrets below, each of which must never be in the record.
    const fragments = ["MIIEowIBAAKC", "secretlineone", "Zm9vYmFyc2Vj", "cmV0bGluZXR3bw", "hunter2", "abcdefghijklmnop", "qrstuvwxyz0123456789ABCD", "sk-abcdef", "ghijklmnopqrst", "lastpass"];
    const leaks = (tail: string): string[] => fragments.filter((s) => tail.includes(s));
    const seen: string[] = [];
    // Every write the record takes is looked at: no piece of a secret may be there at any moment, not only at the end.
    const watch = async (id: string): Promise<void> => { const tail = (await c.read(id)).output.tail; seen.push(...leaks(tail).map((s) => `${s} in ${JSON.stringify(tail)}`)); };
    const id = await c.admit(c.t1);
    await runs.start(id, c.t1, launch);
    const pieces = ["build started\n-----BEGIN RSA", " PRIVATE", " KEY-----\nMIIEowIBAAKCAQEA", "secretlineone\nZm9vYmFyc2Vj", "cmV0bGluZXR3bw\n-----END RSA PRIVATE KEY-----\nstep 2\npassword:", " hunter2", "hunter2\nAuthorization: Bearer", " abcdefghijklmnop", "qrstuvwxyz0123456789ABCD\nkey sk-abcdef", "ghijklmnopqrst in use\nstep 3\n-----BEGIN PRIVATE KEY-----\nMIIEowIBAAKC"];
    const write = async (piece: string): Promise<void> => {
      procs.at(-1)!.out(piece);
      // Long enough for the write due after each piece to happen.
      await new Promise((r) => setTimeout(r, 30));
      await watch(procs.length === 1 ? id : second);
    };
    let second = "";
    for (const piece of pieces) await write(piece);
    // Stopped in the middle of the second key: the end is recorded, the key's start never is.
    await jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: id, reason: "enough" });
    await waitFor(async () => (await c.read(id)).state === "cancelled");
    await watch(id);
    const tail = (await c.read(id)).output.tail;
    for (const visible of ["build started", "step 2", "step 3"]) assert.ok(tail.includes(visible), tail);
    // A job stopped while its last word (a secret) is held back: the word is written at the end, redacted.
    second = await c.admit(c.t2);
    await runs.start(second, c.t2, launch);
    await write("step 4 password:lastpass99");
    await jobs.requestCancel(c.boss, { commandId: cid("cx"), jobId: second, reason: "enough" });
    await waitFor(async () => (await c.read(second)).state === "cancelled");
    await watch(second);
    assert.equal((await c.read(second)).output.tail, "step 4 [redacted]");
    assert.deepEqual(seen, [], "no part of a secret was in the record at any moment");
    await runs.close();
  });

}
