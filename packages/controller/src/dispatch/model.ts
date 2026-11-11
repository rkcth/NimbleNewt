import { DomainError } from "../domain/errors.js";
import type { JsonObject } from "../storage/types.js";
import type { TurnEndKind } from "./ports.js";

/**
 * The records of the dispatcher (card H12). A dispatch record is the controller's claim on one attempt: who runs it, on which host, under which route, harness, policy, decision and environment
 * revisions, with a lease that the worker's heartbeats extend. A tool operation is the durable record of one tool call.
 */

export const DISPATCH_KIND = "dispatch";
export const operationKind = (attemptId: string): string => `tool-op-${attemptId}`;

/** `parked`: every call the agent still has to make waits for an approval, the turn ended, and the attempt gave its place back; it goes on (from the checkpoint, in a new run of the same attempt) when a decision comes. */
export type DispatchState = "waiting" | "running" | "parked" | "finished";

/** What the attempt ran under, recorded when it was admitted so a later change is visible as a change (card H12: "the attempt records harness, model route, policy, decision and environment revisions, worker version and expiry"). */
export interface DispatchRevisions {
  /** The routing table's revision the route was chosen under (R01), and the difficulty profiles' (R03). Absent when the route came from a resolver that has none. */
  readonly routing?: number;
  readonly profiles?: number;
  /** The approval policy in force: the installation's revision and the project's. */
  readonly policy: { readonly installation: number; readonly project?: number };
  /** The owner-decision context's version (C08) for the task. */
  readonly decisions: number;
  /** The agent's environment revision pinned for the attempt (A08). Absent when the agent has no environment. */
  readonly environment?: number;
  /** The task contract's version. */
  readonly contract: number;
}

export interface Frozen {
  readonly reason: string;
  readonly at: string;
  /** The freeze of the agent's own ending (card H12n, `work.end`): `release`, `relocate` and a recipe change keep it (only a release that asks for it, after the ending was dropped, lifts it). */
  readonly ending?: true;
}

/** What an attempt's launch was told to limit and how far the host did (card A08d). Plain JSON, bounded. */
export interface LaunchLimitsRecord {
  /** The effective figures given to the host in the dispatch contract (a limit not here is not limited). */
  readonly limits: { readonly cpus?: number; readonly memoryMb?: number; readonly diskMb?: number; readonly processes?: number; readonly wallTimeMs?: number };
  /** Whose each applied figure is: the agent's environment or the installation's. */
  readonly sources: { readonly [limit: string]: "environment" | "installation" };
  /** Figures the environment asked for that the installation's limit cut. */
  readonly capped?: readonly { readonly limit: string; readonly asked: number; readonly applied: number }[];
  /** The environment revision the attempt is pinned to, when it has one. */
  readonly environmentRevision?: number;
  /** Set by the host's launch report: whether the process started or the launch was refused, whether the owner allowed best effort, and how far each limit was enforced. */
  readonly outcome?: "started" | "refused";
  readonly bestEffort?: boolean;
  readonly enforcement?: readonly { readonly limit: string; readonly value: number; readonly enforced: "full" | "partial" | "none"; readonly by?: string; readonly detail: string }[];
  readonly reason?: string;
  readonly at: string;
}

export interface DispatchBody {
  readonly attemptId: string;
  readonly taskId: string;
  readonly projectId: string;
  /** The agent principal (`agent:<id>`). */
  readonly agentId: string;
  readonly generation: number;
  readonly state: DispatchState;
  /** Absent for a task that needs no recovery and whose profile names none. */
  readonly harness?: string;
  /** The model route (`provider/model`) chosen by the route resolver, and the role and routing profile it was chosen for (kept to judge the route again at each call). */
  readonly route: string;
  readonly role: string;
  readonly request: { readonly contextTokens: number; readonly needs: readonly string[]; readonly data: "local-only" | "cloud-allowed"; readonly paidAuthorized: boolean };
  /**
   * The model call this attempt's run on its route is (card R04c): begun through the fallback service just before the worker starts, so the owner's routing controls and the routes' health are consulted, a drain report counts it and
   * a cutover cancels it. `sent` once the worker started; `ended` once its end was reported. `modelCallSeq` numbers the calls begun for the attempt, so a new one never reuses an old one's command.
   */
  readonly modelCall?: { readonly callId: string; readonly attempt: number; readonly route: string; /** What the attempt had spent when the call began, so the call is charged only its own part. */ readonly fromCostMicros: number; readonly sent?: boolean; readonly ended?: boolean };
  readonly modelCallSeq?: number;
  readonly revisions: DispatchRevisions;
  readonly hostId: string;
  /** The attempt may start only on this host (card H02: it was relocated there, or parked on the host that owns its native store). Cleared when it starts. */
  readonly pinnedHost?: string;
  /** The H03 request that holds the attempt's place (absent while the attempt holds none, and before the first request), and how many requests were made for it. */
  readonly requestId?: string;
  readonly requests?: number;
  /** What request number `n` asks for, kept BEFORE the request is made so that a replay after a crash asks for exactly the same thing (the request's command digest covers these) and a changed parent or priority cannot make the replay conflict. */
  readonly ask?: { readonly n: number; readonly priority: number; readonly reportsTo?: string };
  readonly claimedAt: string;
  /** After this time the attempt is over whatever the worker says (the attempt's own expiry). Absent: the attempt has no time limit (the worker's lease still has to be kept). */
  readonly expiresAt?: string;
  readonly startedAt?: string;
  readonly workerVersion?: string;
  readonly credentialId?: string;
  /** The worker's lease: it must be extended by a heartbeat before `until`, or the attempt is taken as lost. */
  readonly lease?: { readonly holder: string; readonly until: string };
  /** The primary epoch of the controller that started the running attempt or took it over (card H09b). Only that controller renews its lease: a new primary adopts the attempt (or ends it) before a heartbeat counts. Absent on records from before this field: no controller has taken them over. */
  readonly primaryEpoch?: number;
  readonly adoptedAt?: string;
  readonly heartbeats: number;
  readonly lastHeartbeatAt?: string;
  /** The last time the worker was DOING something (a heartbeat while no call waited for an approval); a heartbeat is a lease timer, so one sent while every call was parked does not move it. Absent on attempts from before this field: the heartbeat stands for it. */
  readonly lastActivityAt?: string;
  readonly frozen?: Frozen;
  /** Set when the attempt was stopped (card L02), by whom, before it was ended; the agent's ending reads it to tell an owner's stop from an attempt that merely ended. */
  readonly stopped?: { readonly by: "owner" | "emergency"; readonly reason: string };
  /** For a parked or resuming attempt: the conversation checkpoint to continue from, and what to tell the agent when it does. */
  readonly resumeFrom?: JsonObject;
  readonly resumeNote?: string;
  /** Operations a resume has been made for (bounded): a decision resumes the attempt once. */
  readonly resumedFor?: readonly string[];
  /** Calls started and not yet settled (at most `DISPATCH_LIMITS.inFlight`), and calls waiting for an approval (at most `DISPATCH_LIMITS.parked`). */
  /** The budget reservation held for the attempt (card R05b), and what it has used so far; settled to the use when the attempt ends, held as uncertain when the worker was lost. */
  readonly reservationId?: string;
  /** How many holds this attempt has given back; the next hold's command ID carries it, so it is not taken for the released one. */
  readonly reserveRound?: number;
  /** A hold being given back: set before the budget is asked to release it, cleared after, so a stopped process can finish it. */
  readonly releasingId?: string;
  /**
   * A place or hold taken for this attempt after it had finished (an advance that was already under way when a stop ended it; card H12q). Written in the same commit as the place or hold is recorded, with the
   * attempt kept in the live list, so a crash or a failed release does not leak it: every tick gives back what it names, and the mark and the live entry go once both are given back.
   */
  readonly lateHeld?: { readonly requestId?: string; readonly reservationId?: string };
  readonly used?: { readonly costMicros: number; readonly computeMs: number };
  /** What the attempt meant to hold, written before the reservation is asked for, so a repeat after a crash asks for exactly the same amounts. */
  readonly reserving?: { readonly costMicros?: number; readonly computeMs?: number };
  /** The usage reports already added to `used` (the last 200, by key and a digest of the report): a resent report adds nothing, a different one under the same key is refused. */
  readonly usedKeys?: readonly { readonly key: string; readonly digest: string }[];
  readonly inFlight: readonly string[];
  readonly parked: readonly string[];
  /** Calls recorded for the attempt, all states. */
  readonly calls: number;
  /** The conversation checkpoint reference taken when the attempt ended or was reconfigured. */
  readonly recipeRevision?: string;
  /** The recipe the attempt runs with now (reach and limits, as the dispatcher last stated them): every start, resume, move and restart builds its recipe from this, never from the defaults. */
  readonly recipe?: { readonly revision: string; readonly reach: readonly string[]; readonly limits?: { readonly cpus?: number; readonly memoryMb?: number; readonly diskMb?: number; readonly processes?: number } };
  /** The limits the attempt's launch ran under (card A08d): the figures, whose each is, what the environment asked for that the installation cut, the environment revision they came from, and (once the host has launched) how far each was enforced. */
  readonly launchLimits?: LaunchLimitsRecord;
  /**
   * How the attempt's last turn ended (card W02): the worker's classification of its last reply (`unknown` when the worker did not say), the length of that reply's visible text when it said, and when the dispatcher recorded it.
   * A completed turn whose kind is not `normal` (and whose agent did not end the attempt with work.end) is a stop before the work was said to be done (card W03, `stoppedEarly`).
   */
  readonly turnEnd?: { readonly endKind: TurnEndKind; readonly visibleChars?: number; readonly at: string; /** Card W04: how many times the worker continued that turn after it yielded without a tool call or work.end (absent: none said). */ readonly nudges?: number; /** Card W08: the plan steps checked in the checkout when the turn ended, as the host reported them (absent: not known). */ readonly plan?: PlanCount };
  /** Card W04: the continuations (nudges) of all this attempt's turns, summed; absent while there were none. Each turn's own count is on `turnEnd` and on its `stoppedEarly` run. */
  readonly nudgesUsed?: number;
  /**
   * The runs of this attempt that stopped early (card W03): a turn that completed without the agent's work.end, or whose end kind is not `normal`. Each run ended `stopped-early`; the first `STOPPED_EARLY_READMITS` of a task were
   * readmitted from the checkpoint on the same conversation and host (`readmitted: true`), and the one after them ended the attempt (its outcome is `stopped-early`). `round` numbers the readmits, and names the turn's request
   * (`cmd:adm:<attempt>:se<round>`), so the conversation takes a new input instead of answering with the one it already holds.
   */
  readonly stoppedEarly?: readonly { readonly endKind: TurnEndKind; readonly visibleChars?: number; readonly at: string; readonly readmitted: boolean; /** Card W04: the nudges that run's turn was given before it stopped. */ readonly nudges?: number; /** Card W08: the plan steps checked when that run stopped (absent: not known). */ readonly plan?: PlanCount }[];
  readonly turnRound?: number;
  /**
   * The checks of the agent's work.end done (card W05), newest last (at most `DONE_VERIFY_LIMITS.kept`). Each is the controller's verdict, never the agent's: `passed`, `failed` (what failed is listed, bounded and redacted),
   * or `unknown` (the checks could not be made, so the done was not taken as verified). `key` is the work.end call it answers (a repeat of that call gets the same verdict), `counted` says it counted toward the task's go-ons
   * (`STOPPED_EARLY_READMITS`), and `exhausted` that they were used up, so the attempt ends blocked with the list.
   */
  readonly verifications?: readonly DoneVerification[];
  /**
   * Card W11: the attempt ended its turn while jobs of its task ran, and parked to wait for them (its place given back, its hold, credential, checkpoint and host kept, as for a parked call) instead of being readmitted at once as a
   * stop before the work was done. The first of those jobs to reach a final state wakes it (the dispatcher's job wakes). The job IDs, at most `JOB_WAKE_LIMITS.waitsOn`.
   */
  readonly waitsOnJobs?: readonly string[];
  /** Card W11: how many times a job's end woke this attempt; it names the turn's request (`...:wk<n>`), so the conversation takes the wake as a new input. */
  readonly wakeRound?: number;
  /** Set when a turn's usage figures could not be charged to accounting: why (redacted). */
  readonly usageError?: string;
  /** Set when the attempt was finished: whether its worker was confirmed stopped (its handle stopped, or the host holding it confirmed the release). Absent: not confirmed. */
  readonly workerStopped?: boolean;
  /** `stopped-early` (card W03): the agent kept stopping before it said its work was done, and its readmits were used up; the task has an `agent_stopped_early` blocker. The assignment records such an attempt `abandoned`. */
  readonly outcome?: { readonly status: "succeeded" | "failed" | "abandoned" | "stopped-early"; readonly summary: string; readonly at: string };
  /**
   * When the attempt held a worker slot (card M03h, the usage sink): one span per run, opened when the record turns `running` and closed when it leaves `running` (it parks, waits after a controller shutdown, or
   * finishes), stamped by the dispatcher's clock in the same commit. A resumed attempt therefore has one span per run, and its waiting between them is not counted. The newest `DISPATCH_LIMITS.slotSpans` are kept;
   * `slotSpansCut` is the end of the newest span let go (for a record that ran before this field and resumed after it, its last heartbeat), so a reader knows that runs before it are not on record. Absent on records from before this field.
   */
  readonly slotSpans?: readonly { readonly from: string; readonly to?: string }[];
  readonly slotSpansCut?: string;
  /**
   * Card W10: the agent's running notes for this attempt (what it did, found, left and could not do), oldest first, written through the bridge (`work.note`), each once by its call. Bounded by `WORK_REPORT_LIMITS`. Kept with the
   * attempt, so a controller restart, a readmit (W03) and a wake (W11) keep them, and the next attempt of the task is told them.
   */
  readonly notes?: readonly WorkNote[];
  /** Card W10: the second agent's questioning of the agent's done (the open one, or the last one closed). See `Interrogation`. */
  readonly interrogation?: Interrogation;
  /** Card W10: the questionings closed before the current one (newest last, at most `WORK_REPORT_LIMITS.history`), each with its verdict and the work.end call that got it. */
  readonly interrogated?: readonly InterrogationSummary[];
  /** Card W10: the report the attempt ended with (the agent's own text and, for a done, the questions and answers and how the questioning went). Its rendering also carries the notes. */
  readonly report?: AttemptReport;
}

/** Card W10: what a running note is about. */
export const WORK_NOTE_KINDS = ["did", "found", "left", "could-not"] as const;
export type WorkNoteKind = (typeof WORK_NOTE_KINDS)[number];
/** One running note (card W10): its call (the agent-scoped command ID, so the same call again writes nothing), its kind, the agent's text (redacted; quoted whenever shown) and when it was written. */
export interface WorkNote { readonly key: string; readonly kind: WorkNoteKind; readonly text: string; readonly at: string }

/** One round of the questioning (card W10): the work.end call that got the questions, the questions (the second agent's words), and the agent's answers (one per question) with the call that gave them. */
export interface InterrogationRound {
  readonly key: string;
  readonly questions: readonly string[];
  readonly at: string;
  readonly route?: string;
  readonly answers?: readonly string[];
  readonly answerKey?: string;
  readonly answeredAt?: string;
}

/**
 * The second agent's questioning of a done (card W10). `asking`: it put questions and waits for the answers and the next work.end. `supported`: it found the report supported by the work and the contract (it does not approve the work:
 * acceptance stays with the review). `unsupported`: it found the report unsupported or the work incomplete; the done was refused with its questions and counted toward the task's go-ons (`counted`; `exhausted` once they were used up).
 * `not-run`: no second agent could be asked (none is set up, or no route answered within the budget), so the done was taken on the controller's own checks; `why` says so.
 */
export interface Interrogation {
  readonly state: "asking" | "supported" | "unsupported" | "not-run";
  readonly rounds: readonly InterrogationRound[];
  readonly at: string;
  /** The work.end call that got the verdict (a repeat of it gets the same answer). */
  readonly verdictKey?: string;
  /** The second agent's reason for `unsupported` (its words), or why it did not run. */
  readonly reason?: string;
  readonly why?: string;
  readonly route?: string;
  readonly counted?: boolean;
  readonly exhausted?: boolean;
  /** Which of the task's go-ons the refusal was (1-based). */
  readonly goOn?: number;
}
export interface InterrogationSummary { readonly state: Interrogation["state"]; readonly verdictKey?: string; readonly reason?: string; readonly questions: readonly string[]; readonly rounds: number; readonly at: string; readonly counted?: boolean; /** Which of the task's go-ons the refusal was (card W10). */ readonly goOn?: number }

/**
 * The report an attempt ended with (card W10): the work.end call, its result, the agent's report (redacted; quoted whenever shown), the questions and answers of the second agent folded in, and how the questioning went
 * (`not-asked` for an ending that is not a done: partial, blocked and abandoned are not questioned).
 */
export interface AttemptReport {
  readonly key: string;
  readonly result: string;
  readonly text: string;
  readonly at: string;
  readonly questioning: "supported" | "unsupported" | "not-run" | "not-asked";
  readonly qa?: readonly { readonly question: string; readonly answer?: string }[];
  readonly reason?: string;
  readonly why?: string;
}

/** Card W10: the bounds of the notes, the report and the questioning. */
export const WORK_REPORT_LIMITS = {
  /** One note, the notes of an attempt, and all their text together. */
  note: 600, notes: 30, notesChars: 12_000,
  /** The agent's report. */
  report: 4000,
  /** The questions of one round, one question, one answer, and the rounds of questions before the second agent must give its verdict. */
  questions: 3, question: 300, answer: 800, rounds: 2,
  reason: 300,
  /** Closed questionings kept on the attempt, and the attempts of a task the task's report record names. */
  history: 3, attempts: 5,
} as const;
/** Card W10: one record per task naming its attempts that wrote notes or a report (newest last), so the next attempt and the owner's view find them. */
export const WORK_REPORT_KIND = "work-report-task";
export interface WorkReportTaskBody { readonly taskId: string; readonly attempts: readonly string[] }

export type OperationState = "awaiting-approval" | "in-progress" | "confirmed" | "failed" | "cancelled" | "uncertain" | "refused";
export const TERMINAL: ReadonlySet<OperationState> = new Set(["confirmed", "failed", "cancelled", "uncertain", "refused"]);

export interface ToolIdentity {
  readonly name: string;
  /** The exact version of the tool (its catalogue version, or the worker's own build for a built-in one). */
  readonly version: string;
  /** `catalog`: a tool from the T01 catalogue, called through the protected bridge (T06). */
  readonly kind: "builtin" | "mcp" | "catalog";
  /** For an MCP tool: the server, with the protocol and catalogue revision the call was pinned to (T03). */
  readonly server?: { readonly id: string; readonly protocolRevision?: string; readonly catalogRevision?: number; /** The T03 call record this operation is. */ readonly callId?: string };
}

export interface ToolOperationBody {
  readonly attemptId: string;
  readonly callId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly agentId: string;
  readonly generation: number;
  readonly tool: ToolIdentity;
  /** What was asked, without the payload: a digest of the arguments, their size, and a redacted short summary (nothing at all for a restricted tool). */
  readonly invocation: { readonly argsDigest: string; readonly bytes: number; readonly summary: string; readonly restricted: boolean; /** An effect call's effect (kind, target, input) digest, card H12a. */ readonly effectDigest?: string };
  /** Whether the call only looks (the catalogue puts its tool in the `inspect` class). Judged by the controller, never by the worker's say-so. */
  readonly readOnly: boolean;
  /** The controller-approved manifest of the tool version says a restart may run the call again from the start (card T06). Set by the controller from the catalogue, never by the worker. */
  readonly replaySafe?: boolean;
  readonly state: OperationState;
  readonly startedAt: string;
  readonly endedAt?: string;
  /** Why it was refused, or what went wrong, in words (redacted, short). */
  readonly diagnostics: readonly string[];
  /** What the call used: the time it took by the controller's clock, and the bytes of output; plus what the executor measured. */
  readonly usage?: { readonly durationMs: number; readonly outputBytes: number; readonly cpuMs?: number; readonly memoryMb?: number };
  /** The decision the policy gave, kept so a reader can see why it ran or waited. */
  readonly decision?: { readonly mode: string; readonly via: string; readonly reasons: readonly string[] };
  readonly effectId?: string;
  readonly reviewId?: string;
  /** When the policy sent the call to the owner (not to an agent reviewer), only the owner's approval counts for it. */
  readonly ownerOnly?: boolean;
  /** A short redacted summary of what came back. */
  readonly resultSummary?: string;
  /** The revisions the call was judged under. */
  readonly judgedAt: { readonly policy: { readonly installation: number; readonly project?: number }; readonly decisions: number };
}

/** One check of an agent's done (card W05); see `DispatchBody.verifications`. */
export interface DoneVerification {
  readonly key: string;
  readonly at: string;
  readonly state: "passed" | "failed" | "unknown";
  /** What did not pass, in the controller's words (agent text and check output quoted once, redacted). Empty when passed. */
  readonly failures: readonly string[];
  /** Each check command as the host ran it: name, how it ended and how long it took (its output is only in `failures`). */
  readonly checks: readonly { readonly name: string; readonly state: "passed" | "failed" | "not-run"; readonly exitCode?: number | null; readonly timedOut?: boolean; readonly ms?: number }[];
  /** The contract version checked against. */
  readonly contract: number;
  readonly counted: boolean;
  readonly exhausted: boolean;
}
export const DONE_VERIFY_LIMITS = { kept: 6, failures: 12, failure: 900, message: 6000, output: 600, files: 5, checkOutputBytes: 64 * 1024, waitMarginMs: 60_000 } as const;

/** How many times a task's attempt is readmitted after it stopped early (card W03); the stop after them ends it with a blocker. Counted per task and assignment generation, in storage. */
export const STOPPED_EARLY_READMITS = 2;
/** Card W08: how many of the checkout's PLAN.md checkbox steps were checked, of how many, as the host reported them when a turn ended. */
export interface PlanCount { readonly done: number; readonly total: number }

/**
 * Card W08: one record per task naming the attempts the dispatcher claimed for it (newest last, at most `TASK_ATTEMPTS_LIMIT`), written in the same commit as each claim, so the owner's view of how each attempt ended finds
 * them without a scan. Attempts claimed before this record existed are found through the W10 report record and the W03 count instead.
 */
export const TASK_ATTEMPTS_KIND = "dispatch-task-attempts";
export const TASK_ATTEMPTS_LIMIT = 20;
export interface TaskAttemptsBody { readonly taskId: string; readonly attempts: readonly string[] }

/** The per-task count of those readmits (one record per task). Card W11 counts the job wakes of the task in the same record (`wakes`, `wakeTimes`, `noticeTimes`), so the two together are bounded. */
export const STOPPED_EARLY_KIND = "dispatch-stopped-early";

export const DISPATCH_LIMITS = { inFlight: 32, parked: 20, summary: 300, diagnostic: 300, diagnostics: 10, name: 80, version: 80, callId: 120, leaseMs: 60_000, scanPage: 100, resultSummary: 300, slotSpans: 64 } as const;
export const DISPATCHER_ACTOR = "dispatcher";

/**
 * The usage sink (card M03h): `next` with its slot spans brought up to date for the move from `prev`. Entering `running` opens a span at `now`; leaving it closes the open one at `now`; any other move leaves the spans
 * as they are, so a repeat of the same rewrite (the dispatcher's `mutate` is replayed on its own result) adds nothing. Spans past the bound are let go oldest first and the cut remembered.
 * A run that leaves `running` after its lease ran out (its worker or controller was gone and the attempt is ended as lost, perhaps hours later when a controller comes back) is closed when the lease ran out,
 * not when the loss was noticed. A span never opens before the end of the one before it (a clock set back), so spans do not overlap. A record that ran before the sink and opens its first span now has
 * runs that are not on record: its cut is set, so the review says so rather than counting only the newer runs as the whole.
 */
export function withSlotSpans(prev: DispatchBody, next: DispatchBody, now: string): DispatchBody {
  const was = prev.state === "running", is = next.state === "running";
  if (was === is) return next;
  const spans = [...(next.slotSpans ?? prev.slotSpans ?? [])];
  let cut = next.slotSpansCut ?? prev.slotSpansCut;
  if (is) {
    const last = spans[spans.length - 1];
    if (last !== undefined && last.to === undefined) return next; // already open
    if (last === undefined && prev.slotSpans === undefined && prev.startedAt !== undefined && cut === undefined) cut = prev.lastHeartbeatAt ?? now; // it ran before the sink
    spans.push({ from: last?.to !== undefined && last.to > now ? last.to : now });
  } else {
    const last = spans[spans.length - 1];
    if (last === undefined || last.to !== undefined) return next; // a run from before the sink: nothing to close
    const lapsed = prev.lease !== undefined && prev.lease.until < now ? prev.lease.until : now;
    spans[spans.length - 1] = { from: last.from, to: lapsed < last.from ? last.from : lapsed };
  }
  while (spans.length > DISPATCH_LIMITS.slotSpans) { const gone = spans.shift()!; cut = gone.to ?? gone.from; }
  return { ...next, slotSpans: spans, ...(cut === undefined ? {} : { slotSpansCut: cut }) };
}

const TOOL_NAME = /^[a-z][a-z0-9-]{0,39}(?:\.[a-z0-9-]{1,39})?$/;
const CALL_ID = /^[A-Za-z0-9._:-]{1,120}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

export const checkToolName = (value: unknown, field = "tool.name"): string => (typeof value === "string" && TOOL_NAME.test(value) ? value : invalid(field, "must be a tool name: lower-case words joined by hyphens (so that tool.<name> is an action)"));
export const checkCallId = (value: unknown): string => (typeof value === "string" && CALL_ID.test(value) ? value : invalid("callId", "must be 1 to 120 letters, digits or . _ : -"));

/** A bounded, JSON-safe copy of a value for a record: strings are cut, depth and width are bounded. */
export function boundedJson(value: unknown, depth = 0): JsonObject[string] {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value as never;
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}...` : value;
  if (depth >= 3) return "[...]";
  if (Array.isArray(value)) return value.slice(0, 10).map((v) => boundedJson(v, depth + 1)) as never;
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 10).map(([k, v]) => [k, boundedJson(v, depth + 1)])) as never;
  return null;
}
