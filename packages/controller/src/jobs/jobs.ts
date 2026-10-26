import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { PauseService } from "../lifecycle/pause.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { REDACTED, redactText } from "../security/redact.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";

/** What a job is. Cancelling a model request, stopping a tool and stopping a remote job are three different operations, so the kind says which one applies. An MCP operation is a remote job on a server the owner approved. */
export type JobKind = "model_request" | "tool" | "remote" | "mcp";
export const JOB_KINDS: readonly JobKind[] = ["model_request", "tool", "remote", "mcp"];
/** Admitted through outcome-unknown (operational-contracts, attempt/job state). */
export type JobState = "admitted" | "dispatched" | "running" | "completed" | "failed" | "cancellation_requested" | "cancelled" | "outcome_unknown";
export const JOB_STATES: readonly JobState[] = ["admitted", "dispatched", "running", "completed", "failed", "cancellation_requested", "cancelled", "outcome_unknown"];
/** What can be done with the job after a restart. A job record never implies the process can be resumed: only a tool that left a checkpoint can be restarted from it, and only a remote job that is tracked can be followed. */
export type Resumability = "none" | "tool_checkpoint" | "remote_tracked";
export const RESUMABILITY: readonly Resumability[] = ["none", "tool_checkpoint", "remote_tracked"];
export type CancelOperation = "cancel_model_request" | "stop_tool" | "stop_remote_job";
export const cancelOperationOf = (kind: JobKind): CancelOperation => (kind === "model_request" ? "cancel_model_request" : kind === "tool" ? "stop_tool" : "stop_remote_job");

const TERMINAL: readonly JobState[] = ["completed", "failed", "cancelled"];
const NEXT: Readonly<Record<JobState, readonly JobState[]>> = {
  admitted: ["dispatched", "cancellation_requested", "cancelled", "failed"],
  dispatched: ["running", "completed", "failed", "cancellation_requested", "outcome_unknown"],
  running: ["completed", "failed", "cancellation_requested", "outcome_unknown"],
  cancellation_requested: ["cancelled", "completed", "failed", "outcome_unknown"],
  outcome_unknown: ["completed", "failed", "cancelled"],
  completed: [], failed: [], cancelled: [],
};

export type RestartDecision = "complete" | "cancel" | "restart" | "exception";
const DECISIONS: readonly RestartDecision[] = ["complete", "cancel", "restart", "exception"];

export interface ExitStatus { readonly code?: number; readonly signal?: string; readonly reason?: string }
export interface JobOutput { readonly tail: string; readonly bytes: number; readonly truncated: boolean }
export interface JobHistoryEntry { readonly state: JobState; readonly at: string; readonly by: string; readonly note?: string }

export interface JobBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly kind: JobKind;
  readonly label: string;
  /** The caller's stable name of the operation. The same operation on the same task is the same job, so asking twice never starts it twice. */
  readonly operationId: string;
  readonly state: JobState;
  readonly resumability: Resumability;
  /** A permitted background job: it keeps running while its task is paused and records its result without lifting the pause (L01). */
  readonly background: boolean;
  readonly attemptId?: string;
  readonly host?: string;
  /** For `mcp`: the approved server the operation runs on. */
  readonly serverId?: string;
  /** The tool checkpoint a restart continues from. Present only for `tool_checkpoint`. */
  readonly checkpoint?: string;
  readonly exit?: ExitStatus;
  readonly output: JobOutput;
  /** Artifacts that hold the job's logs and its results. */
  readonly logs: readonly string[];
  readonly artifacts: readonly string[];
  /** Child processes the stop could not end, reported by the host. */
  readonly orphans: readonly string[];
  /** `force` is a Force Stop: an explicit, recorded escalation of a stop that was not obeyed (or asked for as such at once). */
  readonly cancel?: { readonly operation: CancelOperation; readonly requestedBy: string; readonly requestedAt: string; readonly reason: string; readonly force?: boolean; readonly uncooperative?: boolean };
  readonly unknown?: { readonly reason: string; readonly since: string };
  /** A live job kept under an explicit owner after a restart, instead of being completed, cancelled or restarted. */
  readonly exception?: { readonly tracker: string; readonly reason: string; readonly at: string };
  readonly restarts: number;
  /** The IDs of the reconciliation records that settled it (outcome-unknown). */
  readonly reconciliations: readonly string[];
  readonly history: readonly JobHistoryEntry[];
  readonly admittedBy: string;
  readonly admittedAt: string;
  readonly finishedAt?: string;
}

export interface ReconciliationBody { readonly jobId: string; readonly from: JobState; readonly to: JobState; readonly evidence: string; readonly by: string; readonly at: string }

export const JOB_LIMITS = { label: 200, operationId: 120, tail: 8 * 1024, chunk: 64 * 1024, refs: 20, artifacts: 50, orphans: 20, orphan: 200, reason: 500, evidence: 1000, checkpoint: 200, host: 120, history: 32, page: 100, scan: 1000 } as const;
const LONE_SURROGATE = /[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/g;
const ARTIFACT_ID = /^art-[a-z2-7]{20}$/;
const SERVER_ID = /^mcs-[a-z2-7]{20}$/;
const JOB_ID = /^job-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const clean = (body: object): JsonObject => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as unknown as JsonObject;
const idOf = (value: unknown, field: string): string => (typeof value === "string" && JOB_ID.test(value) ? value : invalid(field, "is not a job ID"));

/** Whether an approved MCP server may be used for a new operation. It throws (or answers false) for an unknown, unapproved or revoked server. */
export interface JobConnections { usable(serverId: string): Promise<boolean> }
/** Records a finished permitted background job where the pause service keeps them (L01). */
export type BackgroundRecorder = (principal: Principal, request: { readonly commandId: string; readonly taskId: string; readonly jobRef: string; readonly outcome: "succeeded" | "failed" | "cancelled"; readonly summary: string }) => Promise<unknown>;

export interface JobOptions extends RunnerOptions {
  readonly connections?: JobConnections;
  readonly background?: BackgroundRecorder;
}

export interface AdmitJob extends NoActor {
  readonly taskId: string;
  readonly kind: JobKind;
  readonly label: string;
  readonly operationId: string;
  readonly resumability?: Resumability;
  readonly background?: boolean;
  readonly attemptId?: string;
  readonly host?: string;
  readonly serverId?: string;
}
export interface ReportJob extends NoActor {
  readonly jobId: string;
  readonly state?: "dispatched" | "running";
  readonly output?: string;
  readonly logs?: readonly string[];
  readonly artifacts?: readonly string[];
  readonly checkpoint?: string;
  readonly host?: string;
}
export interface FinishJob extends NoActor {
  readonly jobId: string;
  readonly outcome: "completed" | "failed";
  readonly exit?: ExitStatus;
  readonly output?: string;
  readonly logs?: readonly string[];
  readonly artifacts?: readonly string[];
  readonly orphans?: readonly string[];
}
export interface CancelJob extends NoActor {
  readonly jobId: string;
  readonly reason: string;
  /** Force Stop: asked for at once, or as the escalation of a stop already requested. It is a separate, recorded step. */
  readonly force?: boolean;
}
export interface ConfirmCancel extends NoActor { readonly jobId: string; readonly result: "stopped" | "uncooperative"; readonly orphans?: readonly string[] }
export interface UnknownJob extends NoActor { readonly jobId: string; readonly reason: string }
export interface ReconcileJob extends NoActor { readonly jobId: string; readonly to: "completed" | "failed" | "cancelled"; readonly evidence: string; readonly exit?: ExitStatus }
export interface RestartJob extends NoActor {
  readonly jobId: string;
  readonly decision: RestartDecision;
  readonly reason: string;
  /** For `complete`: how it ended, from evidence the controller can see. For `exception`: who tracks it. */
  readonly exit?: ExitStatus;
  readonly tracker?: string;
}

/**
 * Durable job records and job control (card T07). A job is a long-running local or remote operation tracked on its own: its handle (the job ID) is derived from the task and the operation ID, so it survives a restart of the worker and of the
 * controller and asking for the same operation twice is the same job. The record has a state machine (admitted through outcome-unknown), a resumability class that says honestly what can be done after a restart, bounded output, and the logs and artifacts
 * it produced as artifact references.
 *
 * - **Three separate stop operations.** A job's kind says which operation cancelling it is (cancel the model request, stop the tool, stop the remote job); the request and the host's confirmation are separate records, and an uncooperative stop is
 *   recorded, never claimed as stopped. Child processes the stop could not end are recorded as orphans.
 * - **Pause.** Admitting foreground work is refused for a paused task; a permitted background job is admitted, keeps running, and its result is recorded without lifting the pause (it is handed to the pause service's background record). Reports and
 *   results are always accepted while a job is live.
 * - **Restart.** `live` lists what was running; `decide` completes a job from evidence, cancels it, restarts it from its tool checkpoint (only if its class says it can) or records it as a tracked exception under a named owner.
 * - **Outcome unknown** is a state, not an error: it holds until `reconcile` records the evidence that settles it, and `unresolved` tells a dependent action that it must wait.
 * - **MCP.** A long-running MCP operation is a job with a server; a server that is not approved (or was revoked) admits no new job.
 */
export class JobService {
  readonly #runner: CommandRunner;
  readonly #pauses: PauseService | undefined;
  readonly #connections: JobConnections | undefined;
  readonly #background: BackgroundRecorder | undefined;

  private constructor(runner: CommandRunner, pauses: PauseService | undefined, options: JobOptions) {
    this.#runner = runner;
    this.#pauses = pauses;
    this.#connections = options.connections;
    this.#background = options.background;
  }

  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: { pauses?: PauseService } = {}, options: JobOptions = {}): JobService {
    return new JobService(new CommandRunner(storage, epoch, options), deps.pauses, options);
  }

  static jobIdOf(taskId: string, operationId: string): string { return derivedId("job", `${taskId}\0${operationId}`); }

  // ---- writing ----------------------------------------------------------------------------------------------------------------

  async admit(principal: Principal, command: AdmitJob): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "kind", "label", "operationId", "resumability", "background", "attemptId", "host", "serverId"]);
    const taskId = checkTaskId(command.taskId);
    if (!(JOB_KINDS as readonly string[]).includes(command.kind)) invalid("kind", `must be one of ${JOB_KINDS.join(", ")}`);
    const kind = command.kind;
    const label = plain(command.label, "label", JOB_LIMITS.label);
    const operationId = plain(command.operationId, "operationId", JOB_LIMITS.operationId);
    const resumability = command.resumability ?? "none";
    if (!(RESUMABILITY as readonly string[]).includes(resumability)) invalid("resumability", `must be one of ${RESUMABILITY.join(", ")}`);
    if (resumability === "tool_checkpoint" && kind !== "tool") invalid("resumability", "only a tool can leave a checkpoint that a restart continues");
    if (resumability === "remote_tracked" && kind !== "remote" && kind !== "mcp") invalid("resumability", "only a remote job or an MCP operation can be tracked remotely");
    if (command.background !== undefined && typeof command.background !== "boolean") invalid("background", "must be true or false");
    const background = command.background === true;
    const attemptId = command.attemptId === undefined ? undefined : plain(command.attemptId, "attemptId", 120);
    const host = command.host === undefined ? undefined : plain(command.host, "host", JOB_LIMITS.host);
    if (kind === "mcp") { if (typeof command.serverId !== "string" || !SERVER_ID.test(command.serverId)) invalid("serverId", "an MCP operation names its server (mcs-...)"); } else if (command.serverId !== undefined) invalid("serverId", "only an MCP operation has a server");
    const serverId = command.serverId;
    const id = JobService.jobIdOf(taskId, operationId);
    return this.#command("job.admit", principal, command.commandId, { taskId, kind, label, operationId, resumability, background, ...(attemptId === undefined ? {} : { attemptId }), ...(host === undefined ? {} : { host }), ...(serverId === undefined ? {} : { serverId }) }, async () => {
      // Checked here, not before the command: a repeated command is answered from its record whatever has changed since (the task is paused or done, the server was revoked).
      const task = await this.#task(taskId);
      this.#requireWrite(principal, task, taskId);
      if (task.state === "done" || task.state === "cancelled") invalid("taskId", `task ${taskId} is ${task.state}; it takes no new job`);
      let guardChanges: readonly Change[] = [];
      if (this.#pauses !== undefined) {
        const guard = await this.#pauses.guard(taskId);
        // The gates are locked by the commit: a pause that lands between this check and the commit makes the admit fail and be decided again.
        guardChanges = guard.changes;
        if (guard.blockedBy.length > 0) {
          if (!background) throw new DomainError("invalid_command", `task ${taskId} is paused; only a permitted background job is admitted`, { field: "pause" });
          if (await this.#pauses.backgroundDenied(taskId)) throw new DomainError("invalid_command", `task ${taskId} is paused with background work denied`, { field: "pause" });
        }
      }
      if (kind === "mcp") {
        if (this.#connections === undefined) invalid("serverId", "cannot be checked: this service has no MCP connection check");
        if (!(await this.#connections!.usable(serverId as string))) throw new DomainError("forbidden", "that MCP server is not approved or was revoked; no new operation is admitted on it");
      }
      const ref: AggregateRef = { kind: "job", id };
      if ((await this.#runner.get(ref.kind, ref.id)) !== undefined) throw new DomainError("command_conflict", `operation ${operationId} of task ${taskId} is already admitted as ${id}`, { field: "operationId" });
      const at = this.#runner.now();
      const body: JobBody = {
        taskId, projectId: task.projectId, kind, label, operationId, state: "admitted", resumability, background, ...(attemptId === undefined ? {} : { attemptId }), ...(host === undefined ? {} : { host }), ...(serverId === undefined ? {} : { serverId }),
        output: { tail: "", bytes: 0, truncated: false }, logs: [], artifacts: [], orphans: [], restarts: 0, reconciliations: [], history: [{ state: "admitted", at, by: principal.id }], admittedBy: principal.id, admittedAt: at,
      };
      return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, ...guardChanges], detail: { taskId, kind, operationId, resumability, background } };
    }).then((r) => ({ id, replayed: r.replayed }));
  }

  /** Progress from the host or worker: moves admitted to dispatched and running, adds output (the end of it is kept, bounded), logs, artifacts and the tool checkpoint. Always accepted while the job is live, paused or not. */
  async report(principal: Principal, command: ReportJob): Promise<{ id: string; state: JobState; replayed: boolean }> {
    onlyKnown(command, ["commandId", "jobId", "state", "output", "logs", "artifacts", "checkpoint", "host"]);
    const jobId = idOf(command.jobId, "jobId");
    if (command.state !== undefined && command.state !== "dispatched" && command.state !== "running") invalid("state", "must be dispatched or running");
    const output = command.output === undefined ? undefined : this.#chunk(command.output);
    const logs = command.logs === undefined ? undefined : this.#refs(command.logs, "logs", JOB_LIMITS.refs);
    const artifacts = command.artifacts === undefined ? undefined : this.#refs(command.artifacts, "artifacts", JOB_LIMITS.artifacts);
    const checkpoint = command.checkpoint === undefined ? undefined : plain(command.checkpoint, "checkpoint", JOB_LIMITS.checkpoint);
    const host = command.host === undefined ? undefined : plain(command.host, "host", JOB_LIMITS.host);
    let state: JobState = "admitted";
    const result = await this.#change("job.report", principal, command.commandId, jobId, "write", { state: command.state ?? null, output: output ?? null, logs: logs ?? null, artifacts: artifacts ?? null, checkpoint: checkpoint ?? null, host: host ?? null }, (job) => {
      if (TERMINAL.includes(job.state)) invalid("jobId", `job ${jobId} is ${job.state}; it takes no more reports`);
      if (job.state === "outcome_unknown") invalid("jobId", `job ${jobId} is outcome-unknown; reconcile it first`);
      if (checkpoint !== undefined && job.resumability !== "tool_checkpoint") invalid("checkpoint", "this job's class does not leave a checkpoint");
      const next = command.state ?? job.state;
      if (next !== job.state && !NEXT[job.state].includes(next)) invalid("state", `a ${job.state} job cannot become ${next}`);
      state = next;
      return { ...this.#move(job, next, principal.id, this.#runner.now()), ...(host === undefined ? {} : { host }), ...(checkpoint === undefined ? {} : { checkpoint }), output: output === undefined ? job.output : this.#append(job.output, output), logs: this.#merge(job.logs, logs, JOB_LIMITS.refs, "logs"), artifacts: this.#merge(job.artifacts, artifacts, JOB_LIMITS.artifacts, "artifacts") };
    }, undefined, async (job) => { await this.#checkRefs(job, logs ?? [], "logs"); await this.#checkRefs(job, artifacts ?? [], "artifacts"); });
    return { id: jobId, state: (result.after?.state ?? state) as JobState, replayed: result.replayed };
  }

  /** The job ended: with an exit status, its last output, the logs and artifacts it produced, and any child process that was left behind. A permitted background job's result is handed to the pause service. */
  async finish(principal: Principal, command: FinishJob): Promise<{ id: string; state: JobState; replayed: boolean }> {
    onlyKnown(command, ["commandId", "jobId", "outcome", "exit", "output", "logs", "artifacts", "orphans"]);
    const jobId = idOf(command.jobId, "jobId");
    if (command.outcome !== "completed" && command.outcome !== "failed") invalid("outcome", "must be completed or failed");
    const outcome = command.outcome;
    const exit = command.exit === undefined ? undefined : this.#exit(command.exit);
    const output = command.output === undefined ? undefined : this.#chunk(command.output);
    const logs = command.logs === undefined ? undefined : this.#refs(command.logs, "logs", JOB_LIMITS.refs);
    const artifacts = command.artifacts === undefined ? undefined : this.#refs(command.artifacts, "artifacts", JOB_LIMITS.artifacts);
    const orphans = command.orphans === undefined ? undefined : this.#orphans(command.orphans);
    const done = await this.#change("job.finish", principal, command.commandId, jobId, "write", { outcome, exit: (exit ?? null) as unknown as JsonObject, output: output ?? null, logs: logs ?? null, artifacts: artifacts ?? null, orphans: orphans ?? null }, (job) => {
      if (job.state === "admitted") invalid("jobId", `job ${jobId} was never dispatched`);
      if (job.state === "outcome_unknown") invalid("jobId", `job ${jobId} is outcome-unknown; reconcile it with evidence instead`);
      if (!NEXT[job.state].includes(outcome)) invalid("outcome", `a ${job.state} job cannot become ${outcome}`);
      const at = this.#runner.now();
      return { ...this.#move(job, outcome, principal.id, at), finishedAt: at, ...(exit === undefined ? {} : { exit }), output: output === undefined ? job.output : this.#append(job.output, output), logs: this.#merge(job.logs, logs, JOB_LIMITS.refs, "logs"), artifacts: this.#merge(job.artifacts, artifacts, JOB_LIMITS.artifacts, "artifacts"), orphans: orphans ?? job.orphans };
    }, undefined, async (job) => { await this.#checkRefs(job, logs ?? [], "logs"); await this.#checkRefs(job, artifacts ?? [], "artifacts"); });
    await this.#recordBackground(principal, jobId, command.commandId);
    return { id: jobId, state: done.after?.state ?? outcome, replayed: done.replayed };
  }

  /** Asks for the job to be stopped, with the operation its kind calls for. A job that already ended is not asked again. */
  async requestCancel(principal: Principal, command: CancelJob): Promise<{ id: string; operation: CancelOperation; replayed: boolean }> {
    onlyKnown(command, ["commandId", "jobId", "reason", "force"]);
    const jobId = idOf(command.jobId, "jobId");
    const reason = plain(command.reason, "reason", JOB_LIMITS.reason);
    let operation: CancelOperation = "stop_tool";
    if (command.force !== undefined && typeof command.force !== "boolean") invalid("force", "must be true or false");
    const force = command.force === true;
    const result = await this.#change("job.cancel", principal, command.commandId, jobId, "control", { reason, force }, (job) => {
      if (job.state === "cancellation_requested" && job.cancel !== undefined && force && job.cancel.force !== true) {
        // Force Stop: the escalation of a stop that was asked for and not obeyed, recorded as its own step.
        operation = job.cancel.operation;
        return { ...job, cancel: { ...job.cancel, force: true }, history: this.#history(job, { state: job.state, at: this.#runner.now(), by: principal.id, note: `force stop: ${reason}`.slice(0, 200) }) };
      }
      if (job.state === "cancellation_requested") invalid("jobId", `job ${jobId} is already being stopped`);
      if (!NEXT[job.state].includes("cancellation_requested")) invalid("jobId", `job ${jobId} is ${job.state}; there is nothing to stop`);
      operation = cancelOperationOf(job.kind);
      const at = this.#runner.now();
      return { ...this.#move(job, "cancellation_requested", principal.id, at, operation), cancel: { operation, requestedBy: principal.id, requestedAt: at, reason, ...(force ? { force: true } : {}) } };
    });
    return { id: jobId, operation: result.after?.cancel?.operation ?? operation, replayed: result.replayed };
  }

  /** The host reports what became of the stop. `stopped` ends the job as cancelled; `uncooperative` is recorded and the job stays in cancellation-requested, so it is never reported as stopped when it is not. */
  async confirmCancel(principal: Principal, command: ConfirmCancel): Promise<{ id: string; state: JobState; replayed: boolean }> {
    onlyKnown(command, ["commandId", "jobId", "result", "orphans"]);
    const jobId = idOf(command.jobId, "jobId");
    if (command.result !== "stopped" && command.result !== "uncooperative") invalid("result", "must be stopped or uncooperative");
    const stopped = command.result === "stopped";
    const orphans = command.orphans === undefined ? undefined : this.#orphans(command.orphans);
    const done = await this.#change("job.cancel.confirm", principal, command.commandId, jobId, "write", { result: command.result, orphans: orphans ?? null }, (job) => {
      if (job.state !== "cancellation_requested" || job.cancel === undefined) invalid("jobId", `job ${jobId} is ${job.state}; no stop was asked for`);
      const at = this.#runner.now();
      const base = stopped ? { ...this.#move(job, "cancelled", principal.id, at), finishedAt: at } : { ...job, history: this.#history(job, { state: job.state, at, by: principal.id, note: "the stop was not obeyed" }) };
      return { ...base, cancel: { ...job.cancel!, ...(stopped ? {} : { uncooperative: true }) }, orphans: orphans ?? job.orphans };
    });
    if (stopped) await this.#recordBackground(principal, jobId, command.commandId);
    return { id: jobId, state: done.after?.state ?? (stopped ? "cancelled" : "cancellation_requested"), replayed: done.replayed };
  }

  /** The host lost the job or its result is ambiguous: the outcome is unknown, and stays so until `reconcile` records the evidence. */
  async markUnknown(principal: Principal, command: UnknownJob): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "jobId", "reason"]);
    const jobId = idOf(command.jobId, "jobId");
    const reason = plain(command.reason, "reason", JOB_LIMITS.reason);
    const result = await this.#change("job.unknown", principal, command.commandId, jobId, "write", { reason }, (job) => {
      if (!NEXT[job.state].includes("outcome_unknown")) invalid("jobId", `a ${job.state} job cannot become outcome-unknown`);
      const at = this.#runner.now();
      return { ...this.#move(job, "outcome_unknown", principal.id, at, reason), unknown: { reason, since: at } };
    });
    return { id: jobId, replayed: result.replayed };
  }

  /** Settles an outcome-unknown job with the evidence found, in a record of its own. Nothing is invented: the evidence is required. */
  async reconcile(principal: Principal, command: ReconcileJob): Promise<{ id: string; reconciliationId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "jobId", "to", "evidence", "exit"]);
    const jobId = idOf(command.jobId, "jobId");
    if (command.to !== "completed" && command.to !== "failed" && command.to !== "cancelled") invalid("to", "must be completed, failed or cancelled");
    const to = command.to;
    const evidence = plain(command.evidence, "evidence", JOB_LIMITS.evidence);
    const exit = command.exit === undefined ? undefined : this.#exit(command.exit);
    const reconciliationId = derivedId("jrc", scopedCommandId(principal.id, command.commandId));
    const done = await this.#change("job.reconcile", principal, command.commandId, jobId, "control", { to, evidence, exit: (exit ?? null) as unknown as JsonObject }, (job) => {
      if (job.state !== "outcome_unknown") invalid("jobId", `job ${jobId} is ${job.state}, not outcome-unknown`);
      const at = this.#runner.now();
      return { ...this.#move(job, to, principal.id, at, "reconciled"), finishedAt: at, reconciliations: [...job.reconciliations, reconciliationId].slice(-JOB_LIMITS.history), ...(exit === undefined ? {} : { exit }) };
    }, (job, at) => [{ type: "create", ref: { kind: "job-reconciliation", id: reconciliationId }, body: clean({ jobId, from: job.state, to, evidence, by: principal.id, at } satisfies ReconciliationBody) }]);
    await this.#recordBackground(principal, jobId, command.commandId);
    return { id: jobId, reconciliationId, replayed: done.replayed };
  }

  /**
   * What becomes of a live job after a restart: `complete` it from evidence, `cancel` it (the stop is then confirmed by the host), `restart` it from its tool checkpoint (only a tool that left one), or keep it as a tracked `exception`
   * under a named owner. A job record never implies the process can be resumed, so a restart of anything else is refused.
   */
  async decide(principal: Principal, command: RestartJob): Promise<{ id: string; state: JobState; replayed: boolean }> {
    onlyKnown(command, ["commandId", "jobId", "decision", "reason", "exit", "tracker"]);
    const jobId = idOf(command.jobId, "jobId");
    if (!(DECISIONS as readonly string[]).includes(command.decision)) invalid("decision", `must be one of ${DECISIONS.join(", ")}`);
    const decision = command.decision;
    const reason = plain(command.reason, "reason", JOB_LIMITS.reason);
    const exit = command.exit === undefined ? undefined : this.#exit(command.exit);
    const tracker = command.tracker === undefined ? undefined : plain(command.tracker, "tracker", 120);
    if (decision === "exception" && tracker === undefined) invalid("tracker", "a tracked exception names who tracks it");
    if (decision === "complete" && exit === undefined) invalid("exit", "completing a job needs how it ended");
    const done = await this.#change("job.decide", principal, command.commandId, jobId, "control", { decision, reason, exit: (exit ?? null) as unknown as JsonObject, tracker: tracker ?? null }, (job) => {
      if (TERMINAL.includes(job.state)) invalid("jobId", `job ${jobId} is ${job.state}; there is nothing to decide`);
      if (job.state === "outcome_unknown" && decision !== "exception") invalid("decision", "an outcome-unknown job is settled by reconcile, with evidence; it can only be kept as a tracked exception here");
      const at = this.#runner.now();
      switch (decision) {
        case "complete":
          if (!NEXT[job.state].includes("completed")) invalid("decision", `a ${job.state} job cannot be completed; reconcile it first`);
          return { ...this.#move(job, "completed", principal.id, at, `restart: ${reason}`), finishedAt: at, exit: exit! };
        case "cancel":
          if (!NEXT[job.state].includes("cancellation_requested")) invalid("decision", `a ${job.state} job cannot be cancelled`);
          return { ...this.#move(job, "cancellation_requested", principal.id, at, `restart: ${reason}`), cancel: { operation: cancelOperationOf(job.kind), requestedBy: principal.id, requestedAt: at, reason } };
        case "restart":
          if (job.resumability !== "tool_checkpoint" || job.checkpoint === undefined) invalid("decision", "only a tool that left a checkpoint can be restarted from it; the job record does not imply the process can be resumed");
          if (job.state === "outcome_unknown" || job.state === "cancellation_requested") invalid("decision", `a ${job.state} job cannot be restarted; settle it first`);
          return { ...this.#move(job, "dispatched", principal.id, at, `restarted from the checkpoint: ${reason}`), restarts: job.restarts + 1 };
        case "exception":
          return { ...job, exception: { tracker: tracker!, reason, at }, history: this.#history(job, { state: job.state, at, by: principal.id, note: `tracked exception: ${reason}` }) };
      }
    });
    if (decision === "complete") await this.#recordBackground(principal, jobId, command.commandId);
    return { id: jobId, state: done.after?.state ?? "admitted", replayed: done.replayed };
  }

  // ---- reading ----------------------------------------------------------------------------------------------------------------

  async get(viewer: Principal, jobId: string): Promise<View<JobBody> | undefined> {
    const id = idOf(jobId, "jobId");
    const found = await this.#runner.get("job", id);
    if (found === undefined) return undefined;
    const job = view<JobBody>(found);
    return this.#mayRead(viewer, job.projectId, job.taskId) ? job : undefined;
  }

  /** The jobs of one task, in ID order, a page at a time. */
  async list(viewer: Principal, taskId: string, page: { afterId?: string; limit?: number } = {}): Promise<{ jobs: View<JobBody>[]; next?: string }> {
    const id = checkTaskId(taskId);
    const found = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
    if (found === undefined && viewer.kind === "owner") throw new DomainError("not_found", `task ${id} does not exist`);
    const task = found;
    if (task === undefined || !this.#mayRead(viewer, task.projectId, id)) throw new DomainError("forbidden", `${viewer.id} may not read the jobs of that task`);
    const limit = Math.min(Math.max(page.limit ?? JOB_LIMITS.page, 1), JOB_LIMITS.page);
    return this.#scan((job) => job.taskId === id, page.afterId, limit);
  }

  /** The jobs that were live when the controller went down (admitted, dispatched, running, being stopped or outcome-unknown). A restart goes through these and `decide`s each. */
  async live(viewer: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ jobs: View<JobBody>[]; next?: string }> {
    const limit = Math.min(Math.max(page.limit ?? JOB_LIMITS.page, 1), JOB_LIMITS.page);
    const found = await this.#scan((job) => !TERMINAL.includes(job.state) && job.exception === undefined && this.#mayRead(viewer, job.projectId, job.taskId), page.afterId, limit);
    return found;
  }

  /** The outcome-unknown jobs of a task: a dependent action or a readiness claim that needs them settled must wait for these. */
  async unresolved(viewer: Principal, taskId: string): Promise<View<JobBody>[]> {
    const all: View<JobBody>[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.list(viewer, taskId, { ...(after === undefined ? {} : { afterId: after }), limit: JOB_LIMITS.page });
      all.push(...page.jobs.filter((j) => j.state === "outcome_unknown"));
      if (page.next === undefined) return all;
      after = page.next;
    }
  }

  async reconciliation(viewer: Principal, jobId: string): Promise<View<ReconciliationBody>[]> {
    const job = await this.get(viewer, jobId);
    if (job === undefined) return [];
    const out: View<ReconciliationBody>[] = [];
    for (const id of job.reconciliations) { const found = await this.#runner.get("job-reconciliation", id); if (found !== undefined) out.push(view<ReconciliationBody>(found)); }
    return out;
  }

  // ---- parts ------------------------------------------------------------------------------------------------------------------

  async #scan(keep: (job: JobBody) => boolean, afterId: string | undefined, limit: number): Promise<{ jobs: View<JobBody>[]; next?: string }> {
    const jobs: View<JobBody>[] = [];
    let after = afterId;
    for (;;) {
      const batch = await this.#runner.storage.listAggregates("job", { ...(after === undefined ? {} : { afterId: after }), limit: JOB_LIMITS.scan });
      for (const a of batch) {
        after = a.id;
        const v = view<JobBody>(a);
        if (!keep(v)) continue;
        jobs.push(v);
        if (jobs.length >= limit) return { jobs, next: v.id };
      }
      if (batch.length < JOB_LIMITS.scan) return { jobs };
    }
  }

  async #task(taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
    return task;
  }

  #mayWrite(p: Principal, task: TaskBody, taskId: string): boolean {
    return p.kind === "owner" || (inTaskScope(p, task.projectId) && allows(p, "job.write", task.projectId, { resource: { kind: "task", id: taskId } }));
  }
  #mayControl(p: Principal, task: TaskBody, taskId: string): boolean {
    return p.kind === "owner" || (inTaskScope(p, task.projectId) && allows(p, "job.control", task.projectId, { resource: { kind: "task", id: taskId } }));
  }
  #mayRead(p: Principal, projectId: string, taskId: string): boolean {
    if (p.kind === "owner") return true;
    if (!inTaskScope(p, projectId)) return false;
    const resource = { resource: { kind: "task", id: taskId } } as const;
    return allows(p, "job.read", projectId, resource) || allows(p, "job.write", projectId, resource) || allows(p, "job.control", projectId, resource);
  }
  #requireWrite(p: Principal, task: TaskBody, taskId: string): void { if (!this.#mayWrite(p, task, taskId)) throw new DomainError("forbidden", `${p.id} may not record jobs for that task`); }

  #chunk(value: unknown): string {
    if (typeof value !== "string") return invalid("output", "must be text");
    if (value.length > JOB_LIMITS.chunk) invalid("output", `must be at most ${JOB_LIMITS.chunk} characters at a time`);
    // NUL cannot be stored by every backend and a lone surrogate is not text; both are dropped or repaired, never refused (output is whatever the process wrote).
    return redactText(value.replaceAll("\u0000", "").replace(LONE_SURROGATE, "\ufffd"));
  }
  #append(before: JobOutput, chunk: string): JobOutput {
    // The pieces are joined and redacted again, so a secret split across two reports is still caught; the end is kept, cut on a character boundary (the limit counts characters).
    // If the stored end already had a secret cut out of it, the first characters of the next piece are the rest of that secret.
    const rest = before.tail.endsWith(REDACTED) ? chunk.replace(/^[A-Za-z0-9._~+/=-]+/, "") : chunk;
    const joined = redactText(before.tail + rest);
    const cut = joined.length > JOB_LIMITS.tail;
    let tail = cut ? joined.slice(joined.length - JOB_LIMITS.tail) : joined;
    if (cut && tail.length > 0 && tail.charCodeAt(0) >= 0xdc00 && tail.charCodeAt(0) <= 0xdfff) tail = tail.slice(1);
    return { tail, bytes: before.bytes + Buffer.byteLength(chunk), truncated: before.truncated || cut };
  }
  /** A log or artifact a job names must exist and, if it belongs to a project, to the job's. Checked inside the command, so a repeat is answered from its record even if an artifact has gone since. */
  async #checkRefs(job: JobBody, ids: readonly string[], field: string): Promise<void> {
    for (const id of ids) {
      const found = (await this.#runner.get("artifact", id))?.body as unknown as { projectId?: string } | undefined;
      if (found === undefined || (found.projectId !== undefined && found.projectId !== job.projectId)) invalid(field, `${id} is not an artifact of this job's project`);
    }
  }

  #refs(value: unknown, field: string, max: number): string[] {
    if (!Array.isArray(value) || value.length > max) return invalid(field, `must be a list of at most ${max} artifact IDs`);
    return value.map((v, i) => (typeof v === "string" && ARTIFACT_ID.test(v) ? v : invalid(`${field}[${i}]`, "is not an artifact ID")));
  }
  #merge(have: readonly string[], add: readonly string[] | undefined, max: number, field: string): readonly string[] {
    if (add === undefined) return have;
    const out = [...have];
    for (const a of add) if (!out.includes(a)) out.push(a);
    if (out.length > max) invalid(field, `a job keeps at most ${max}`);
    return out;
  }
  #orphans(value: unknown): string[] {
    if (!Array.isArray(value) || value.length > JOB_LIMITS.orphans) return invalid("orphans", `must be a list of at most ${JOB_LIMITS.orphans} descriptions`);
    // A description of a left-over process may hold a command line with a token: it is redacted, never a reason for the stop to go unrecorded.
    return value.map((v, i) => redactText(text(v, `orphans[${i}]`, { min: 1, max: JOB_LIMITS.orphan, multiline: true })));
  }
  #exit(value: unknown): ExitStatus {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("exit", "must be an object");
    onlyKnown(value as object, ["code", "signal", "reason"]);
    const e = value as { code?: unknown; signal?: unknown; reason?: unknown };
    if (e.code !== undefined && !(Number.isSafeInteger(e.code))) invalid("exit.code", "must be a whole number");
    return { ...(e.code === undefined ? {} : { code: e.code as number }), ...(e.signal === undefined ? {} : { signal: plain(e.signal, "exit.signal", 40) }), ...(e.reason === undefined ? {} : { reason: plain(e.reason, "exit.reason", JOB_LIMITS.reason) }) };
  }
  #history(job: JobBody, entry: JobHistoryEntry): readonly JobHistoryEntry[] { return [...job.history, entry].slice(-JOB_LIMITS.history); }
  #move(job: JobBody, state: JobState, by: string, at: string, note?: string): JobBody {
    const { unknown: _u, ...rest } = job;
    return { ...rest, state, history: job.state === state && note === undefined ? job.history : this.#history(job, { state, at, by, ...(note === undefined ? {} : { note: note.slice(0, 200) }) }), ...(state === "outcome_unknown" ? { unknown: job.unknown } : {}) } as JobBody;
  }

  /** A permitted background job's result is handed to the pause service once, by a command derived from the job (repeating the call repeats nothing). */
  async #recordBackground(principal: Principal, jobId: string, commandId: string): Promise<void> {
    if (this.#background === undefined) return;
    const job = (await this.#runner.get("job", jobId))?.body as unknown as JobBody | undefined;
    if (job === undefined || !job.background || !TERMINAL.includes(job.state)) return;
    const outcome = job.state === "completed" ? "succeeded" : job.state === "failed" ? "failed" : "cancelled";
    await this.#background(principal, { commandId: `job-bg:${jobId}`, taskId: job.taskId, jobRef: jobId, outcome, summary: `${job.label}: ${job.state}${job.exit?.code === undefined ? "" : ` (exit ${job.exit.code})`}` });
    void commandId;
  }

  async #command(name: string, principal: Principal, commandId: unknown, payload: JsonObject, build: () => Promise<{ ref: AggregateRef; creates: boolean; changes: readonly Change[]; detail: JsonObject }>) {
    return this.#retrying(() => this.#runner.command(name, { commandId: scopedCommandId(principal.id, commandId), actor: principal.id }, async () => ({ payload, build })));
  }

  /** Reads the job, authorizes the caller, applies `change` to its body and commits it (with any extra changes) in one command; a concurrent writer meets a revision check and the command is read and decided again. */
  async #change(name: string, principal: Principal, commandId: unknown, jobId: string, level: "write" | "control", payload: JsonObject, change: (job: JobBody) => JobBody, extra?: (job: JobBody, at: string) => readonly Change[], pre?: (job: JobBody) => Promise<void>) {
    let after: JobBody | undefined;
    const result = await this.#command(name, principal, commandId, { jobId, ...payload }, async () => {
      const ref: AggregateRef = { kind: "job", id: jobId };
      const found = await this.#runner.get(ref.kind, ref.id);
      if (found === undefined) throw new DomainError("not_found", `job ${jobId} does not exist`);
      const job = found.body as unknown as JobBody;
      const task = await this.#task(job.taskId);
      if (level === "write" ? !this.#mayWrite(principal, task, job.taskId) : !this.#mayControl(principal, task, job.taskId)) throw new DomainError("forbidden", `${principal.id} may not ${level === "write" ? "record" : "control"} that job`);
      await pre?.(job);
      const next = change(job);
      after = next;
      return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean(next) } as Change, ...(extra?.(job, this.#runner.now()) ?? [])], detail: { jobId, taskId: job.taskId, from: job.state, to: next.state } };
    });
    if (after === undefined) after = (await this.#runner.get("job", jobId))?.body as unknown as JobBody | undefined;
    return { replayed: result.replayed, after };
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || error.field !== undefined || attempt >= 8) throw error;
      }
    }
  }
}
