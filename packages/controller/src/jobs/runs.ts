import { randomBytes } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import type { View } from "../domain/model.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ScriptLaunch } from "../toolbridge/service.js";
import { JOB_LIMITS, type JobBody, type JobService } from "./jobs.js";

/** How a job's process ended, as the launcher saw it. `orphans` names what the stop could not end (process descriptions, never their environment). */
export interface JobProcessEnd {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** `stop` was called before the process ended. */
  readonly stopped: boolean;
  readonly orphans: readonly string[];
  /** The launcher could not start it, or could not clean up after it. */
  readonly problem?: string;
}
/** One running job process. `stop(false)` is the Stop (the whole process tree is ended through the launcher); `stop(true)` the Force Stop, asked again with no grace. Both are safe to call more than once. */
export interface JobProcess { stop(force: boolean): void; readonly ended: Promise<JobProcessEnd> }
/**
 * Starts a job's process in the sandbox (the worker package's `jobLauncher` over the A03 launcher implements it): the same launch a catalogue call has (argv and stdin as data, an empty environment, the manifest's limits and time),
 * with its standard output handed over as it comes. It throws when it cannot start.
 */
export interface JobLauncher { start(launch: ScriptLaunch, onOutput: (text: string) => void): Promise<JobProcess> }

export const JOB_RUN_LIMITS = {
  /** Jobs one task may have running on this machine at once. */
  perTask: 4,
  /** Jobs this machine runs at once for all tasks. */
  total: 16,
  /** How often output is written to the job record, at most. */
  flushMs: 1000,
  /** Output waiting this long is written at once. */
  flushChars: 16 * 1024,
  /** The most output a job may write in all; it is stopped beyond it (the record keeps only the end anyway). */
  outputBytes: 16 * 1024 * 1024,
  /** How long a stop waits for the process to end before it is recorded as not obeyed. */
  graceMs: 10_000,
  /** How often the jobs running here are checked against their tasks: a job whose task has ended is stopped. */
  sweepMs: 30_000,
} as const;

export interface LocalJobRunsDeps {
  readonly jobs: Pick<JobService, "get" | "report" | "finish" | "confirmCancel" | "requestCancel">;
  /**
   * Whether the task has ended (done or cancelled, both final; or gone). Given, every `sweepMs` the jobs running here whose task has ended are stopped (a recorded Stop by the job host): a job belongs to its task and does not outlive
   * it. Absent: nothing is swept.
   */
  readonly taskEnded?: (taskId: string) => Promise<boolean>;
  /** The controller's job host (`service:dispatcher`): it records the progress, the ends and the stops. Absent while the dispatcher is not built: nothing can be started then. */
  readonly principal: () => Principal | undefined;
  readonly launcher: JobLauncher;
  /** Told about a failure to record something (never thrown into a caller). */
  readonly onError?: (error: unknown) => void;
  readonly limits?: Partial<{ -readonly [K in keyof typeof JOB_RUN_LIMITS]: number }>;
}

interface Run {
  readonly jobId: string;
  readonly taskId: string;
  readonly nonce: string;
  proc?: JobProcess;
  stopAsked?: boolean;
  force?: boolean;
  closing?: boolean;
  pending: string;
  bytes: number;
  outputCut: boolean;
  seq: number;
  timer?: ReturnType<typeof setTimeout> | undefined;
  flushing: Promise<void>;
  /** Resolves once the end is recorded. */
  readonly done: Promise<void>;
  finish(): void;
}

/** The longest trailing word a write before the end keeps back (see `#flush`); a longer one is written as it is. */
const HELD_WORD = 1024;
const sleep = (ms: number): Promise<void> => new Promise((resolve) => { setTimeout(resolve, ms).unref(); });
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
/**
 * Text from the launcher that the job's program may have shaped (an orphan's process name, a launch failure's standard error), made fit for the record: control and invisible format characters dropped, so the job service's
 * text checks never refuse the end (a refused end would leave the job running on the record forever).
 */
const plainLine = (s: string): string => s.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, "").replace(/\t/g, " ");

/**
 * The jobs agents start through the bridge, run on this machine (card T07b). Each job is one process in the sandbox, started by the controller (not by the agent's worker process), so it outlives the worker and its attempt; it never
 * outlives its task's Stop (the stop machinery asks `requestCancel`, which reaches `stop` here), its own time limit or this controller (its process ends with it, and the next controller records it as outcome-unknown).
 *
 * - **Bounded.** At most `perTask` jobs of one task and `total` in all run at once; output is written to the job record at most every `flushMs` (the record keeps the end, redacted), and a job that writes more than `outputBytes`
 *   is stopped and fails.
 * - **Stop and Force Stop** are the job service's two recorded steps; each reaches the process through the launcher (the whole process tree). The end is confirmed with what the launcher could not end (`orphans`); a process that has
 *   not ended within `graceMs` is recorded as not obeying the stop, and the job stays `cancellation_requested` until it ends or is forced.
 */
export class LocalJobRuns {
  readonly #deps: LocalJobRunsDeps;
  readonly #limits: { -readonly [K in keyof typeof JOB_RUN_LIMITS]: number };
  readonly #live = new Map<string, Run>();
  #closed = false;
  readonly #sweeper: ReturnType<typeof setInterval> | undefined;
  #sweeping = false;

  constructor(deps: LocalJobRunsDeps) {
    this.#deps = deps;
    this.#limits = { ...JOB_RUN_LIMITS, ...(deps.limits ?? {}) };
    if (deps.taskEnded !== undefined) {
      this.#sweeper = setInterval(() => { void this.sweep(); }, this.#limits.sweepMs);
      this.#sweeper.unref();
    }
  }

  /**
   * Stops every job running here whose task has ended (done or cancelled): a job belongs to its task, so it does not run on after the task is over (card T07b review). The stop is the job service's recorded Stop, asked by the job host,
   * and it reaches the process through `onCancel` like any other. Run every `sweepMs`; a sweep already going on is not started again. Answers the jobs it asked to stop.
   */
  async sweep(): Promise<string[]> {
    const ended = this.#deps.taskEnded;
    const host = this.#deps.principal();
    if (ended === undefined || host === undefined || this.#closed || this.#sweeping) return [];
    this.#sweeping = true;
    const asked: string[] = [];
    try {
      const byTask = new Map<string, boolean>();
      for (const run of [...this.#live.values()]) {
        if (run.stopAsked === true || run.closing === true) continue;
        let over = byTask.get(run.taskId);
        if (over === undefined) { try { over = await ended(run.taskId); } catch (error) { this.#deps.onError?.(error); over = false; } byTask.set(run.taskId, over); }
        if (!over) continue;
        try {
          await this.#deps.jobs.requestCancel(host, { commandId: `jend:${run.jobId}:${run.nonce}`, jobId: run.jobId, reason: "its task has ended (done or cancelled); a job does not run on after its task" });
          asked.push(run.jobId);
        } catch (error) {
          // A job that has just ended, or whose stop is already asked, needs nothing more.
          if (!(error instanceof DomainError && error.code === "invalid_command")) this.#deps.onError?.(error);
        }
      }
    } finally { this.#sweeping = false; }
    return asked;
  }

  /** Why a job of the task cannot be started now, or `undefined`. */
  room(taskId: string): string | undefined {
    if (this.#closed) return "the controller is shutting down";
    if (this.#live.size >= this.#limits.total) return `this machine already runs ${this.#limits.total} jobs, the most it runs at once; try again when one has ended`;
    const mine = [...this.#live.values()].filter((r) => r.taskId === taskId).length;
    return mine >= this.#limits.perTask ? `this task already has ${this.#limits.perTask} jobs running, the most one task may run at once; stop one or wait for one to end` : undefined;
  }

  /** The jobs running in this process now. */
  running(): string[] { return [...this.#live.keys()]; }

  /** Resolves once the job's end is recorded here (at once when it does not run here). */
  ended(jobId: string): Promise<void> { return this.#live.get(jobId)?.done ?? Promise.resolve(); }

  /**
   * Starts an admitted job's process. A job that is no longer `admitted` (asking again after it started) or already runs here is left alone. A job that cannot be started (no room, the launcher refused) fails with the reason, never
   * stays admitted.
   */
  async start(jobId: string, taskId: string, launch: ScriptLaunch): Promise<void> {
    if (this.#live.has(jobId)) return;
    const host = this.#deps.principal();
    if (host === undefined) throw new DomainError("unavailable", "the job host is not running");
    const job = await this.#deps.jobs.get(host, jobId);
    if (job === undefined) throw new DomainError("not_found", `job ${jobId} does not exist`);
    if (job.taskId !== taskId) throw new DomainError("forbidden", "the job belongs to another task");
    // A stop asked between the admission and this start (nothing here ran it, so `stop` found nothing): nothing was started, so the stop is confirmed at once instead of leaving the job waiting for a process that never comes.
    if (job.state === "cancellation_requested" && !this.#live.has(jobId) && !job.history.some((h) => h.state === "dispatched" || h.state === "running")) {
      await this.#deps.jobs.confirmCancel(host, { commandId: `jstop:${jobId}:never-started`, jobId, result: "stopped" });
      return;
    }
    if (job.state !== "admitted" || this.#live.has(jobId)) return;
    const full = this.room(taskId);
    let finish!: () => void;
    const done = new Promise<void>((resolve) => { finish = resolve; });
    const run: Run = { jobId, taskId, nonce: randomBytes(4).toString("hex"), pending: "", bytes: 0, outputCut: false, seq: 0, flushing: Promise.resolve(), done, finish };
    // Reserved before anything is awaited, so two starts of one job, or of more jobs than there is room for, cannot both pass.
    this.#live.set(jobId, run);
    try {
      await this.#deps.jobs.report(host, { commandId: `jrun:${jobId}:${run.nonce}:d`, jobId, state: "dispatched" });
      if (full !== undefined) { await this.#end(run, host, { exitCode: null, signal: null, timedOut: false, stopped: false, orphans: [], problem: full }); return; }
      let proc: JobProcess;
      try { proc = await this.#deps.launcher.start(launch, (text) => this.#output(run, text)); } catch (error) {
        await this.#end(run, host, { exitCode: null, signal: null, timedOut: false, stopped: false, orphans: [], problem: `the job could not be started: ${error instanceof Error ? error.message : "the launcher refused it"}` });
        return;
      }
      run.proc = proc;
      // A stop that was asked while the process was being started is honoured now, and so is output past the bound that came before the process was handed over.
      if (run.stopAsked === true || this.#closed || run.outputCut) proc.stop(run.force === true || this.#closed || run.outputCut);
      await this.#deps.jobs.report(host, { commandId: `jrun:${jobId}:${run.nonce}:r`, jobId, state: "running" }).catch((error: unknown) => {
        // A stop that landed first leaves the job cancellation_requested: it cannot become running, and the process is being ended.
        if (!(error instanceof DomainError && error.code === "invalid_command")) this.#deps.onError?.(error);
      });
      void proc.ended.then((end) => this.#end(run, host, end), (error: unknown) => this.#end(run, host, { exitCode: null, signal: null, timedOut: false, stopped: run.stopAsked === true, orphans: [], problem: error instanceof Error ? error.message : "the process was lost" }));
    } catch (error) {
      if (run.proc === undefined) {
        this.#live.delete(jobId);
        // Nothing was launched (recording the dispatch failed: a stop landed first, from the owner, the agent or the sweep, or the store refused). The job never stays admitted or being stopped for a process that never
        // comes: its stop is confirmed, or it is stopped and confirmed (card T07b review).
        let settled = false;
        try { settled = await this.#neverStarted(host, jobId); } catch (problem) { this.#deps.onError?.(problem); }
        run.finish();
        if (settled) return;
      }
      throw error;
    }
  }

  /**
   * A job nothing was launched for: a stop asked of it is confirmed (answers true: the stop is what happened); one still admitted (its dispatch failed otherwise) is stopped and confirmed, and the failure stays the caller's
   * (answers false).
   */
  async #neverStarted(host: Principal, jobId: string): Promise<boolean> {
    const job = await this.#deps.jobs.get(host, jobId);
    if (job === undefined || job.history.some((h) => h.state === "dispatched" || h.state === "running")) return false;
    const asked = job.state === "cancellation_requested";
    if (job.state === "admitted") await this.#deps.jobs.requestCancel(host, { commandId: `jstop:${jobId}:not-dispatched`, jobId, reason: "the job could not be dispatched; nothing was started" });
    else if (!asked) return false;
    await this.#deps.jobs.confirmCancel(host, { commandId: `jstop:${jobId}:never-started`, jobId, result: "stopped" });
    return asked;
  }

  /**
   * The Stop (or, with `force`, the Force Stop) of a job running here: the launcher ends its whole process tree. The end is recorded when the process has ended (`confirmCancel` with what could not be ended); a process still
   * there after the grace time is recorded as not obeying. Nothing runs here for that job: nothing to do (another machine, or an earlier controller, ran it).
   */
  async stop(jobId: string, force: boolean): Promise<void> {
    const run = this.#live.get(jobId);
    if (run === undefined) return;
    run.stopAsked = true;
    if (force) run.force = true;
    run.proc?.stop(force);
    const ended = await Promise.race([run.done.then(() => true), sleep(this.#limits.graceMs).then(() => false)]);
    if (ended) return;
    const host = this.#deps.principal();
    if (host === undefined) return;
    await this.#deps.jobs.confirmCancel(host, { commandId: `jstop:${jobId}:${run.nonce}:${force ? "force" : "ask"}`, jobId, result: "uncooperative" }).catch((error: unknown) => { this.#deps.onError?.(error); });
  }

  /** Ends every job running here (the controller is shutting down) and waits until each end is recorded. */
  async close(): Promise<void> {
    this.#closed = true;
    if (this.#sweeper !== undefined) clearInterval(this.#sweeper);
    const runs = [...this.#live.values()];
    for (const run of runs) { run.closing = true; run.proc?.stop(true); }
    await Promise.race([Promise.all(runs.map((r) => r.done)), sleep(this.#limits.graceMs)]);
  }

  #output(run: Run, text: string): void {
    if (run.outputCut || text.length === 0) return;
    run.bytes += Buffer.byteLength(text, "utf8");
    if (run.bytes > this.#limits.outputBytes) {
      // Beyond the bound the job is stopped and fails; what it wrote up to here is kept.
      run.outputCut = true;
      run.proc?.stop(true);
      return;
    }
    run.pending += text;
    if (run.pending.length >= this.#limits.flushChars) { this.#flush(run); return; }
    if (run.timer === undefined) { run.timer = setTimeout(() => { run.timer = undefined; this.#flush(run); }, this.#limits.flushMs); run.timer.unref(); }
  }

  /**
   * Writes what is waiting to the job record, in pieces the record takes, one write after the other. Before the end (`final` false) a trailing word of at most `HELD_WORD` characters is kept back for the next write: a secret
   * cut there by the timing of a write would otherwise sit in the record, half of it unrecognisable to the redaction, until the rest came (card T07b review 3).
   */
  #flush(run: Run, final = false): Promise<void> {
    if (run.timer !== undefined) { clearTimeout(run.timer); run.timer = undefined; }
    let text = run.pending;
    run.pending = "";
    if (!final) {
      const word = /\S+$/u.exec(text);
      if (word !== null && word[0].length <= HELD_WORD) { run.pending = word[0]; text = text.slice(0, word.index); }
    }
    if (text.length === 0) return run.flushing;
    const host = this.#deps.principal();
    run.flushing = run.flushing.then(async () => {
      if (host === undefined) return;
      for (let at = 0; at < text.length; at += JOB_LIMITS.chunk) {
        let end = Math.min(text.length, at + JOB_LIMITS.chunk);
        // Never cut inside a character.
        if (end < text.length && /[\ud800-\udbff]/.test(text[end - 1] ?? "")) end--;
        const piece = text.slice(at, end);
        at = end - JOB_LIMITS.chunk;
        await this.#deps.jobs.report(host, { commandId: `jout:${run.jobId}:${run.nonce}:${run.seq++}`, jobId: run.jobId, output: piece }).catch((error: unknown) => { this.#deps.onError?.(error); });
      }
    });
    return run.flushing;
  }

  /** Records the end once: the stop confirmed when one was asked, else completed (exit 0) or failed with the reason. */
  async #end(run: Run, host: Principal, end: JobProcessEnd): Promise<void> {
    try {
      await this.#flush(run, true);
      const job = await this.#deps.jobs.get(host, run.jobId);
      const orphans = end.orphans.slice(0, JOB_LIMITS.orphans).map((o) => clip(redactText(plainLine(o)).trim() || "an unnamed process", JOB_LIMITS.orphan));
      if (job === undefined) return;
      if (job.state === "cancellation_requested") {
        await this.#deps.jobs.confirmCancel(host, { commandId: `jstop:${run.jobId}:${run.nonce}:end`, jobId: run.jobId, result: "stopped", orphans });
        return;
      }
      if (job.state !== "dispatched" && job.state !== "running") return;
      const reason = end.problem !== undefined ? end.problem
        : run.outputCut ? `the job wrote more than ${this.#limits.outputBytes} bytes and was stopped`
        : end.timedOut ? "the job ran longer than its tool's time limit and was stopped"
        : run.closing === true ? "the controller shut down and ended the job"
        : end.exitCode === 0 ? undefined
        : end.signal !== null ? `the job was ended by ${end.signal}` : `the job exited with code ${String(end.exitCode)}`;
      const exit = { ...(end.exitCode === null ? {} : { code: end.exitCode }), ...(end.signal === null ? {} : { signal: end.signal }), ...(reason === undefined ? {} : { reason: clip(redactText(plainLine(reason)).trim() || "the job ended", JOB_LIMITS.reason) }) };
      await this.#deps.jobs.finish(host, { commandId: `jrun:${run.jobId}:${run.nonce}:end`, jobId: run.jobId, outcome: reason === undefined ? "completed" : "failed", exit, ...(orphans.length === 0 ? {} : { orphans }) });
    } catch (error) {
      this.#deps.onError?.(error);
    } finally {
      this.#live.delete(run.jobId);
      run.finish();
    }
  }
}

/** What the start-up rule did with each live job (card T07b). */
export interface RestartReport { readonly decided: readonly { readonly jobId: string; readonly rule: "outcome_unknown" | "stopped" | "exception" | "unchanged" }[]; readonly failed: readonly { readonly jobId: string; readonly error: string }[] }

/**
 * The decision every live job gets when a controller starts (card T07b), by a stated rule for its class, so no live job is left without one. Only jobs admitted before this start are judged (`before`); each decision's command ID
 * carries the epoch, so a decision is made once per start and asking again repeats nothing.
 *
 * - A job already **outcome-unknown** keeps waiting for its reconciliation (it is listed by `unresolved`).
 * - A **remote job or MCP operation** that is tracked remotely is kept as a tracked exception (followed where it runs, with the owner as its tracker); an untracked one that never started is stopped, one that started is outcome-unknown.
 * - A job recorded on **another host** than this machine's is kept as a tracked exception under that host, which reports its end.
 * - A local job that **never started** is stopped (nothing ran).
 * - A local **tool that left a checkpoint** is relaunched from it when the composer can (`relaunch`); otherwise, and for **anything else** that was running, the job is outcome-unknown: its process ended with the controller (the
 *   sandbox dies with its parent), so whether it finished is not known, and a dependent action waits for its reconciliation.
 */
export async function decideAtStart(jobs: Pick<JobService, "live" | "markUnknown" | "decide" | "requestCancel" | "confirmCancel">, host: Principal, rule: { readonly epoch: number; readonly before: string; readonly isLocal: (host: string) => boolean; readonly relaunch?: (job: View<JobBody>) => Promise<boolean> }): Promise<RestartReport> {
  const decided: { jobId: string; rule: "outcome_unknown" | "stopped" | "exception" | "unchanged" }[] = [];
  const failed: { jobId: string; error: string }[] = [];
  const cid = (jobId: string, step: string): string => `jrs:${rule.epoch}:${jobId}:${step}`;
  for (let after: string | undefined; ;) {
    const page = await jobs.live(host, { ...(after === undefined ? {} : { afterId: after }), limit: JOB_LIMITS.page });
    for (const job of page.jobs) {
      if (job.admittedAt >= rule.before) continue;
      try {
        const unknown = async (reason: string): Promise<void> => { await jobs.markUnknown(host, { commandId: cid(job.id, "unknown"), jobId: job.id, reason }); decided.push({ jobId: job.id, rule: "outcome_unknown" }); };
        const stopNeverStarted = async (): Promise<void> => {
          if (job.state !== "cancellation_requested") await jobs.requestCancel(host, { commandId: cid(job.id, "cancel"), jobId: job.id, reason: "the controller restarted before the job started; it is not started now" });
          await jobs.confirmCancel(host, { commandId: cid(job.id, "stopped"), jobId: job.id, result: "stopped" });
          decided.push({ jobId: job.id, rule: "stopped" });
        };
        const exception = async (tracker: string, reason: string): Promise<void> => { await jobs.decide(host, { commandId: cid(job.id, "exception"), jobId: job.id, decision: "exception", tracker, reason }); decided.push({ jobId: job.id, rule: "exception" }); };
        if (job.state === "outcome_unknown") { decided.push({ jobId: job.id, rule: "unchanged" }); continue; }
        if (job.kind === "remote" || job.kind === "mcp") {
          if (job.resumability === "remote_tracked") await exception("owner", "the controller restarted; the remote job is tracked where it runs and is followed there");
          else if (job.state === "admitted") await stopNeverStarted();
          else await unknown("the controller restarted while the remote job ran and it is not tracked remotely; whether it finished is not known");
          continue;
        }
        if (job.host !== undefined && !rule.isLocal(job.host)) { await exception(job.host, `the job runs on ${job.host}, not on this controller's machine; that host reports its end`); continue; }
        if (job.state === "admitted") { await stopNeverStarted(); continue; }
        if (job.resumability === "tool_checkpoint" && job.checkpoint !== undefined && job.state !== "cancellation_requested" && rule.relaunch !== undefined && await rule.relaunch(job)) { decided.push({ jobId: job.id, rule: "unchanged" }); continue; }
        await unknown(job.resumability === "tool_checkpoint" && job.checkpoint !== undefined
          ? "the controller restarted while the job ran; it left a checkpoint but cannot be relaunched from it here, so whether it finished is not known (reconcile it, or restart it from its checkpoint)"
          : "the controller restarted while the job ran; its process ended with the controller, so whether it finished is not known");
      } catch (error) {
        failed.push({ jobId: job.id, error: error instanceof Error ? clip(error.message, 200) : "the decision could not be recorded" });
      }
    }
    if (page.next === undefined) break;
    after = page.next;
  }
  return { decided, failed };
}
