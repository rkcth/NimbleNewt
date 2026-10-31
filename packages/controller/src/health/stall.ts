import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import type { ActivityBody, AssignmentBody, AttemptBody, Owner } from "../domain/assignment-model.js";
import type { AssignmentService } from "../domain/assignments.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { WaitService } from "../domain/waits.js";
import { AGENT_LIMITS, type AgentBody } from "../agents/agents.js";
import { DEFAULT_LADDER_HOURS } from "./escalation-ladder.js";
import { RECOVERY_ACTIONS, allowedAt, rungOf, type RecoveryAction, type RecoveryEffects, type RecoveryPolicy } from "./recovery-ladder.js";
import { DEFAULT_HOST_STALE_AFTER_MS, hostFreshness, type HostBody } from "../hosts/hosts.js";
import { DEFAULT_CONTRACT, DIFFICULTIES, type ContractBody, type Difficulty } from "../planning/contracts.js";
import { allows, allowsExactly } from "../security/access.js";
import { effectiveOf } from "../security/grants.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import {
  DEFAULT_THRESHOLDS, JOB_STATUSES, STALL_LIMITS, assessStall,
  type Assessment, type EvidenceBody, type HostEvidence, type JobStatus, type StallKind, type StallThresholds, type WindowEntry,
} from "./assess.js";

/** A suspected stall is `suspected` until someone decides: `confirmed` (a failure someone accepted), `dismissed` (judged fine, for a while), or `cleared` (the signals recovered on their own). */
export type ConcernState = "suspected" | "confirmed" | "dismissed" | "cleared";
const STATES: readonly ConcernState[] = ["suspected", "confirmed", "dismissed", "cleared"];

/** Who should look at a concern: the agent's responsible supervisor (card H11), or the installation owner when there is none. */
export interface Route {
  readonly to: { readonly kind: "agent" | "owner"; readonly id: string };
  readonly via: "supervisor" | "owner";
  readonly reason: string;
}

export interface ConcernBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly generation: number;
  readonly kind: StallKind;
  readonly state: ConcernState;
  readonly detail: string;
  readonly difficulty: Difficulty;
  readonly route: Route;
  readonly firstSeenAt: string;
  readonly lastChangedAt: string;
  /** How many times it came back after being cleared or after a dismissal ran out. */
  readonly reopened: number;
  readonly decidedBy?: string;
  readonly decidedAt?: string;
  readonly decision?: string;
  readonly dismissedUntil?: string;
  readonly clearedBecause?: string;
  /** When the concern had waited too long for a decision and was passed on to the owner (card V02b). */
  readonly escalatedAt?: string;
  /** When the owner's notice was sent; the loop offers it again until it is. */
  readonly notifiedAt?: string;
  /** Who holds the concern after its last escalation (owner decision 2026-10-30, supervisor ladder): `agent:<ID>` of a supervisor up the chain, or `owner` at the top. Absent: it is still with the supervisor it was routed to. */
  readonly escalatedTo?: string;
  /** How many times it has climbed the supervisor ladder (0 or absent: none yet). */
  readonly escalationLevel?: number;
  /** The climbs so far, newest last and bounded: the level reached, who got it, when, and the supervisors passed over with the reason each was skipped. */
  readonly escalationTrail?: readonly EscalationStep[];
  /** The rung (index in `RECOVERY_ACTIONS`) of the last recovery step taken (card V02c); the next step must be a higher one. Absent: none taken. */
  readonly recoveryRung?: number;
  /** The recovery steps taken, newest last and bounded (card V02c). */
  readonly recoverySteps?: readonly RecoveryStep[];
}

export interface RecoveryStep { readonly n: number; readonly action: RecoveryAction; readonly by: string; readonly at: string; readonly level: number | "owner"; readonly text?: string; readonly to?: string; readonly warnings?: readonly string[] }

export interface EscalationStep { readonly level: number; readonly to: string; readonly at: string; readonly skipped?: readonly { readonly id: string; readonly reason: string }[] }
const TRAIL_KEEP = 20;
const SKIPPED_KEEP = 10;

export type StallEvent =
  /** `promptTokens` is the estimate made at the start (card V01b), `cachedShare` the share of it the cache adapter expects to be cached, `route` and `hostId` whose speed the request measures. */
  | { readonly type: "request_started"; readonly requestId: string; readonly promptTokens?: number; readonly cachedShare?: number; readonly route?: string; readonly hostId?: string }
  /** The first output of the open request arrived: the reading allowance ends and the event counts as progress. */
  | { readonly type: "first_output"; readonly requestId: string }
  /** The model relay's count of tokens written so far by the open request, at a bounded interval; each report counts as progress. */
  | { readonly type: "output_progress"; readonly requestId: string; readonly tokens: number }
  /** `inputTokens`, `cachedTokens` and `outputTokens` are what the provider reported for the call (card V01b); with them and the first output the controller measures the route's reading and writing speed. */
  | { readonly type: "request_finished"; readonly requestId: string; readonly outcome: "ok" | "error"; readonly inputTokens?: number; readonly cachedTokens?: number; readonly outputTokens?: number }
  | { readonly type: "step"; readonly label: string; readonly actionKey?: string }
  | { readonly type: "error"; readonly errorClass: string; readonly actionKey?: string }
  | { readonly type: "job"; readonly status: JobStatus }
  | { readonly type: "spend"; readonly minutes?: number; readonly cost?: number }
  | { readonly type: "evidence"; readonly item: string };

export interface StallOptions extends RunnerOptions {
  /**
   * A speed declared for a route in its settings (tokens read a second), used until the controller has measured the route (card V01b). Without one, or a measurement, `defaultReadTokensPerSecond` is used and the concern text says so.
   */
  readonly declaredSpeed?: (route: string, hostId: string | undefined) => { readonly readTokensPerSecond?: number } | undefined | Promise<{ readonly readTokensPerSecond?: number } | undefined>;
  /** The cautious speed assumed for a route with no measurement and no declared speed. Provisional default 50 tokens a second. */
  readonly defaultReadTokensPerSecond?: number;
  /** How much longer than the expected reading time, in percent, a request may take before it is suspect. Provisional default 150. */
  readonly readMarginPercent?: number;
  /** Per difficulty, over the provisional defaults. A task with no stated difficulty is assessed as `medium`. */
  readonly thresholds?: Partial<Record<Difficulty, Partial<StallThresholds>>>;
  /** How long a host counts as fresh (default: the one constant `HostService` uses). */
  readonly hostStaleAfterMs?: number;
  /** How long a dismissal silences a concern before a signal that is still bad reopens it. Provisional default 6 hours. */
  readonly dismissForMs?: number;
  /** How long a suspected concern waits at a level of the supervisor ladder before it climbs, when the owner's `escalation.ladder` setting names nothing for that level (the installation's value). Default 24 hours (the owner's decision, owner decision 2026-10-30, supervisor ladder). */
  readonly escalateAfterMs?: number;
  /** The owner's per-level hours (the `escalation.ladder` setting), read at each pass; a throw stops that pass's escalation. */
  readonly ladderHours?: () => Promise<readonly number[]>;
  /** Told, once for each episode of the ladder setting being unreadable (the episode ends when it reads again), so the owner can mend it; the notice's `id` is stable for the episode. */
  /** The installation's recovery action ladder (card V02c), read at each step; a throw refuses the step. Absent: recovery steps are unavailable. */
  readonly recoveryPolicy?: () => Promise<RecoveryPolicy>;
  /** What each recovery action does (nudge, re-brief, reassign, pause, stop), through the existing services. Absent: recovery steps are unavailable. */
  readonly recoveryEffects?: RecoveryEffects;
  readonly ladderDamaged?: (notice: { id: string; detail: string }) => Promise<void>;
  /** Whether a pause gate (card L01) applies to the task. A paused task is assessed as `paused`: its silence is expected, and a concern already suspected is cleared. */
  readonly isPaused?: (taskId: string) => Promise<boolean>;
}

export interface ScanReport { readonly checked: number; readonly opened: number; readonly reopened: number; readonly cleared: number; readonly contended: number; readonly next?: string }

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const safe = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max });
  if (redactText(out) !== out) return invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const amount = (value: unknown, field: string): number | undefined => (value === undefined ? undefined : typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1e12 ? value : invalid(field, "must be a number from 0"));
const tokens = (value: unknown, field: string): number | undefined => (value === undefined ? undefined : typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 1e9 ? value : invalid(field, "must be a whole number of tokens from 0 to 1000000000"));
const pad = (n: number): string => String(n).padStart(10, "0");
const concernId = (taskId: string, generation: number, kind: StallKind): string => `stl-${taskId.slice(5)}-${pad(generation)}-${kind.replace("_", "-")}`;
const prefixOf = (taskId: string): string => `stl-${taskId.slice(5)}-`;

/** What a model route has shown about its own speed (kind `stall-speed`, one per route and host; card V01b): smoothed tokens a second for reading a prompt and for writing. */
export interface SpeedBody { readonly route: string; readonly hostId: string; readonly readTps?: number; readonly writeTps?: number; readonly readSamples: number; readonly writeSamples: number; readonly updatedAt: string }
/** A request counts toward a route's speed only when it was big and long enough for the speed to dominate its fixed costs. */
export const SPEED_SAMPLE = { minReadTokens: 200, minReadMs: 1000, minWriteTokens: 20, minWriteMs: 1000, keep: 0.7, spread: 2, floor: 0.1, ceiling: 1e6 } as const;
const smooth = (old: number | undefined, sample: number): number => {
  const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
  if (old === undefined) return clamp(sample, SPEED_SAMPLE.floor, SPEED_SAMPLE.ceiling);
  // One slow request cannot pull the figure below half of what it was, nor one fast request above double, before it is averaged in.
  const bounded = clamp(sample, old / SPEED_SAMPLE.spread, old * SPEED_SAMPLE.spread);
  return clamp(old * SPEED_SAMPLE.keep + bounded * (1 - SPEED_SAMPLE.keep), SPEED_SAMPLE.floor, SPEED_SAMPLE.ceiling);
};
const speedId = (route: string, hostId: string): string => derivedId("sps", `${route}\0${hostId}`);

/** Whether the identity that reported is the task's owner (an agent owner `ann` reports as `agent:ann`). */
const isOwner = (owner: Owner | undefined, principalId: string): boolean => owner !== undefined && (owner.id === principalId || `${owner.kind}:${owner.id}` === principalId);

/** Field by field: stored records come back with their keys in another order. */
/** Concerns escalated under the first version of the escalation (escalatedAt, but no holder) went to the owner; they are read as held by the owner. */
const readConcern = <T extends ConcernBody>(c: T): T => (c.escalatedAt !== undefined && c.escalatedTo === undefined ? { ...c, escalatedTo: "owner" } : c);
/** Why a supervisor was passed over is shown to the owner and the current holder only, not to the agent the concern is about or anyone else. */
const forReader = <T extends ConcernBody>(by: Principal, c: T): T => {
  if (by.kind === "owner" || (c.escalatedTo !== undefined && c.escalatedTo === by.id) || c.escalationTrail === undefined) return c;
  return { ...c, escalationTrail: c.escalationTrail.map(({ skipped: _s, ...step }) => step) };
};
const sameRoute = (a: Route, b: Route): boolean => a.via === b.via && a.reason === b.reason && a.to.kind === b.to.kind && a.to.id === b.to.id;

function thresholdsFor(options: StallOptions): Record<Difficulty, StallThresholds> {
  const out = {} as Record<Difficulty, StallThresholds>;
  for (const level of DIFFICULTIES) {
    const merged = { ...DEFAULT_THRESHOLDS[level], ...(options.thresholds?.[level] ?? {}) };
    for (const key of ["requestMs", "silenceMs"] as const) if (!Number.isSafeInteger(merged[key]) || merged[key] < 1000) throw new DomainError("invalid_command", `thresholds.${level}.${key}: must be a whole number of at least 1000`, { field: "thresholds" });
    for (const key of ["repeatedActions", "repeatedErrors"] as const) if (!Number.isSafeInteger(merged[key]) || merged[key] < 2 || merged[key] > STALL_LIMITS.maxRepeat) throw new DomainError("invalid_command", `thresholds.${level}.${key}: must be a whole number from 2 to ${STALL_LIMITS.maxRepeat}`, { field: "thresholds" });
    out[level] = merged;
  }
  return out;
}

function checkEvent(value: unknown): StallEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("event", "must be an object with a type");
  const e = value as Record<string, unknown>;
  const only = (known: readonly string[]): void => { for (const key of Object.keys(e)) if (!known.includes(key)) invalid(`event.${key}`, "is not a field of this event"); };
  const key = (field: string): string | undefined => (e[field] === undefined ? undefined : safe(e[field], `event.${field}`, STALL_LIMITS.key));
  switch (e["type"]) {
    case "request_started": {
      only(["type", "requestId", "promptTokens", "cachedShare", "route", "hostId"]);
      const promptTokens = tokens(e["promptTokens"], "event.promptTokens");
      const cachedShare = e["cachedShare"] === undefined ? undefined : typeof e["cachedShare"] === "number" && Number.isFinite(e["cachedShare"]) && e["cachedShare"] >= 0 && e["cachedShare"] <= 1 ? e["cachedShare"] : invalid("event.cachedShare", "must be a number from 0 to 1");
      const route = key("route"); const hostId = key("hostId");
      return { type: "request_started", requestId: safe(e["requestId"], "event.requestId", STALL_LIMITS.requestId), ...(promptTokens === undefined ? {} : { promptTokens }), ...(cachedShare === undefined ? {} : { cachedShare }), ...(route === undefined ? {} : { route }), ...(hostId === undefined ? {} : { hostId }) };
    }
    case "first_output": only(["type", "requestId"]); return { type: "first_output", requestId: safe(e["requestId"], "event.requestId", STALL_LIMITS.requestId) };
    case "output_progress": {
      only(["type", "requestId", "tokens"]);
      const t = tokens(e["tokens"], "event.tokens");
      if (t === undefined) invalid("event.tokens", "is required");
      return { type: "output_progress", requestId: safe(e["requestId"], "event.requestId", STALL_LIMITS.requestId), tokens: t! };
    }
    case "request_finished": {
      only(["type", "requestId", "outcome", "inputTokens", "cachedTokens", "outputTokens"]);
      if (e["outcome"] !== "ok" && e["outcome"] !== "error") invalid("event.outcome", "must be ok or error");
      const inputTokens = tokens(e["inputTokens"], "event.inputTokens"); const cachedTokens = tokens(e["cachedTokens"], "event.cachedTokens"); const outputTokens = tokens(e["outputTokens"], "event.outputTokens");
      return { type: "request_finished", requestId: safe(e["requestId"], "event.requestId", STALL_LIMITS.requestId), outcome: e["outcome"] as "ok" | "error", ...(inputTokens === undefined ? {} : { inputTokens }), ...(cachedTokens === undefined ? {} : { cachedTokens }), ...(outputTokens === undefined ? {} : { outputTokens }) };
    }
    case "step": { only(["type", "label", "actionKey"]); const k = key("actionKey"); return { type: "step", label: safe(e["label"], "event.label", STALL_LIMITS.label), ...(k === undefined ? {} : { actionKey: k }) }; }
    case "error": { only(["type", "errorClass", "actionKey"]); const k = key("actionKey"); return { type: "error", errorClass: safe(e["errorClass"], "event.errorClass", STALL_LIMITS.key), ...(k === undefined ? {} : { actionKey: k }) }; }
    case "job": {
      only(["type", "status"]);
      if (!(JOB_STATUSES as readonly unknown[]).includes(e["status"])) invalid("event.status", `must be one of ${JOB_STATUSES.join(", ")}`);
      return { type: "job", status: e["status"] as JobStatus };
    }
    case "spend": {
      only(["type", "minutes", "cost"]);
      const minutes = amount(e["minutes"], "event.minutes"); const cost = amount(e["cost"], "event.cost");
      if (minutes === undefined && cost === undefined) invalid("event", "spend must give minutes, cost or both");
      return { type: "spend", ...(minutes === undefined ? {} : { minutes }), ...(cost === undefined ? {} : { cost }) };
    }
    case "evidence": only(["type", "item"]); return { type: "evidence", item: safe(e["item"], "event.item", STALL_LIMITS.label) };
    default: return invalid("event.type", "must be request_started, request_finished, step, error, job, spend or evidence");
  }
}

/** The evidence after one event, at controller time `at`. Throws for an event that contradicts the record (a finish with no open request, spend that goes down). */
function applyEvent(before: EvidenceBody, event: StallEvent, by: string, at: string): EvidenceBody {
  let next: EvidenceBody = { ...before, reportedBy: by, lastReportAt: at, reports: before.reports + 1 };
  // Only these count as progress: a repeated job ping or a spend report proves a process is alive, not that it is getting anywhere.
  const progress = (): void => { next = { ...next, lastProgressAt: at }; };
  const count = (k: string): Readonly<Record<string, number>> => {
    const counts = { ...before.counts };
    if (counts[k] === undefined && Object.keys(counts).length >= STALL_LIMITS.countKeys) {
      let least: string | undefined;
      for (const key of Object.keys(counts)) if (least === undefined || counts[key]! < counts[least]!) least = key;
      if (least !== undefined) delete counts[least];
    }
    counts[k] = (counts[k] ?? 0) + 1;
    return counts;
  };
  const push = (entry: WindowEntry): readonly WindowEntry[] => [...before.window, entry].slice(-STALL_LIMITS.window);
  switch (event.type) {
    case "request_started":
      // Repeating the start of the open request does not make it younger.
      if (before.request?.id !== event.requestId) {
        next = { ...next, request: { id: event.requestId, startedAt: at, ...(event.promptTokens === undefined ? {} : { promptTokens: event.promptTokens }), ...(event.cachedShare === undefined ? {} : { cachedShare: event.cachedShare }), ...(event.route === undefined ? {} : { route: event.route }), ...(event.hostId === undefined ? {} : { hostId: event.hostId }) } };
        progress();
      }
      break;
    case "first_output":
      if (before.request === undefined || before.request.id !== event.requestId) return invalid("event.requestId", "is not the open request");
      // Repeating it does not move the time the first output arrived.
      if (before.request.firstOutputAt === undefined) { next = { ...next, request: { ...before.request, firstOutputAt: at } }; progress(); }
      break;
    case "output_progress": {
      if (before.request === undefined || before.request.id !== event.requestId) return invalid("event.requestId", "is not the open request");
      // Output has started even if the first-output event was lost; the count only grows.
      next = { ...next, request: { ...before.request, firstOutputAt: before.request.firstOutputAt ?? at, outputTokens: Math.max(before.request.outputTokens ?? 0, event.tokens) } };
      progress();
      break;
    }
    case "request_finished": {
      if (before.request === undefined || before.request.id !== event.requestId) return invalid("event.requestId", "is not the open request");
      const { request: _r, ...rest } = next;
      next = { ...rest, lastRequestMs: Math.max(0, Date.parse(at) - Date.parse(before.request.startedAt)) };
      progress();
      break;
    }
    case "step": next = { ...next, steps: before.steps + 1, lastStep: { label: event.label, at }, counts: count(`s:${event.actionKey ?? event.label}`), window: push({ t: "s", key: event.actionKey ?? event.label, at, ev: before.evidenceTotal }) }; progress(); break;
    case "error": next = { ...next, lastError: { errorClass: event.errorClass, at }, counts: count(`e:${event.actionKey === undefined ? event.errorClass : `${event.errorClass}:${event.actionKey}`}`), window: push({ t: "e", key: event.actionKey === undefined ? event.errorClass : `${event.errorClass}:${event.actionKey}`, at, ev: before.evidenceTotal }) }; progress(); break;
    case "job":
      next = { ...next, job: { status: event.status, at: before.job?.status === event.status ? before.job.at : at } };
      if (before.job?.status !== event.status) progress();
      break;
    case "spend": {
      const was = before.spend ?? {};
      if ((event.minutes !== undefined && was.minutes !== undefined && event.minutes < was.minutes) || (event.cost !== undefined && was.cost !== undefined && event.cost < was.cost)) return invalid("event", "spend is cumulative and cannot go down");
      next = { ...next, spend: { ...(event.minutes ?? was.minutes) === undefined ? {} : { minutes: event.minutes ?? was.minutes! }, ...(event.cost ?? was.cost) === undefined ? {} : { cost: event.cost ?? was.cost! } } };
      break;
    }
    case "evidence":
      if (!before.evidence.includes(event.item)) { next = { ...next, evidence: [...before.evidence, event.item].slice(-STALL_LIMITS.evidence), evidenceTotal: before.evidenceTotal + 1, counts: {} }; progress(); }
      break;
  }
  return next;
}

/**
 * Health and progress stall detection (card V01). Workers (through their host, or the owning agent itself) report bounded progress evidence: request start and finish (the
 * controller measures the duration with its own clock), steps, errors, job status, cumulative spend and acceptance evidence produced. `assess` and `scan` turn that, with the
 * task's difficulty, budget, open waits and the host's freshness, into deterministic concerns (loop, repeated errors, silence, stuck request, budget). A concern is only ever
 * *suspected* until the agent's responsible supervisor (or the owner) confirms or dismisses it, and suspected and confirmed ones are kept and listed apart.
 *
 * **Nothing here acts.** No assignment, task or attempt is changed, and the assessment says `takeover.permitted: false` always: a stale timestamp is evidence about a connection, and
 * reassigning is the owner's explicit command (S02). All times are the controller's own clock (injected, like its neighbours); there are no timers: `scan` is called periodically.
 */
export class StallService {
  readonly #runner: CommandRunner;
  readonly #assignments: AssignmentService;
  readonly #waits: WaitService;
  readonly #thresholds: Record<Difficulty, StallThresholds>;
  readonly #hostStaleAfterMs: number;
  readonly #dismissForMs: number;
  readonly #escalateAfterMs: number;
  readonly #ladderHours: (() => Promise<readonly number[]>) | undefined;
  readonly #recoveryPolicy: (() => Promise<RecoveryPolicy>) | undefined;
  readonly #recoveryEffects: RecoveryEffects | undefined;
  readonly #ladderDamaged: ((notice: { id: string; detail: string }) => Promise<void>) | undefined;
  /** The start time of the current episode of an unreadable ladder setting (undefined: the setting reads fine, or the owner has not been told yet). */
  #damageEpisode: string | undefined;
  #damageTold = false;
  readonly #isPaused: ((taskId: string) => Promise<boolean>) | undefined;
  readonly #declared: StallOptions["declaredSpeed"];
  readonly #defaultTps: number;
  readonly #marginPercent: number;

  private constructor(runner: CommandRunner, assignments: AssignmentService, waits: WaitService, options: StallOptions) {
    this.#runner = runner;
    this.#assignments = assignments;
    this.#waits = waits;
    this.#thresholds = thresholdsFor(options);
    this.#hostStaleAfterMs = options.hostStaleAfterMs ?? DEFAULT_HOST_STALE_AFTER_MS;
    this.#dismissForMs = options.dismissForMs ?? 6 * 3_600_000;
    this.#escalateAfterMs = options.escalateAfterMs ?? DEFAULT_LADDER_HOURS * 3_600_000;
    this.#ladderHours = options.ladderHours;
    this.#ladderDamaged = options.ladderDamaged;
    this.#recoveryPolicy = options.recoveryPolicy;
    this.#recoveryEffects = options.recoveryEffects;
    if (!Number.isSafeInteger(this.#escalateAfterMs) || this.#escalateAfterMs < 1000) throw new DomainError("invalid_command", "escalateAfterMs: must be a whole number of at least 1000", { field: "escalateAfterMs" });
    this.#isPaused = options.isPaused;
    if (!Number.isSafeInteger(this.#hostStaleAfterMs) || this.#hostStaleAfterMs < 1000) throw new DomainError("invalid_command", "hostStaleAfterMs: must be a whole number of at least 1000", { field: "hostStaleAfterMs" });
    this.#declared = options.declaredSpeed;
    this.#defaultTps = options.defaultReadTokensPerSecond ?? 50;
    this.#marginPercent = options.readMarginPercent ?? 150;
    if (!(this.#defaultTps >= 1 && this.#defaultTps <= 1e6)) throw new DomainError("invalid_command", "defaultReadTokensPerSecond: must be a number from 1 to 1000000", { field: "defaultReadTokensPerSecond" });
    if (!Number.isSafeInteger(this.#marginPercent) || this.#marginPercent < 100 || this.#marginPercent > 10_000) throw new DomainError("invalid_command", "readMarginPercent: must be a whole number from 100 to 10000", { field: "readMarginPercent" });
    if (!Number.isSafeInteger(this.#dismissForMs) || this.#dismissForMs < 1000) throw new DomainError("invalid_command", "dismissForMs: must be a whole number of at least 1000", { field: "dismissForMs" });
  }

  static withEpoch(storage: ControllerStorage, epoch: number, assignments: AssignmentService, waits: WaitService, options: StallOptions = {}): StallService {
    return new StallService(new CommandRunner(storage, epoch, options), assignments, waits, options);
  }

  // ---- evidence ---------------------------------------------------------------------------------------------------------------

  /**
   * A worker reports one event about a task under the generation it believes is current. The owner, a host with `attempt.work` in the task's project, or the owning agent itself
   * (another agent is refused) may report; a task the caller cannot work on reads like a missing one. A generation that is not the assignment's current one is refused (`fenced`), so
   * a superseded worker's reports never count as the owner's liveness. The reporter sends no times: durations and timestamps are the controller's.
   */
  async report(by: Principal, command: NoActor & { taskId: string; generation: number; event: StallEvent }): Promise<{ id: string; revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "generation", "event"]);
    const taskId = checkTaskId(command.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    const assignment = (await this.#assignments.getAssignment(taskId));
    const mayReport = task !== undefined && (by.kind === "owner" || ((by.kind === "host" || by.kind === "agent") && allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } })));
    if (task === undefined || !mayReport) throw new DomainError("forbidden", `${by.id} may not report on that task`);
    // An agent reports only for itself: it must be the assignment's owner.
    if (by.kind === "agent" && !isOwner(assignment?.owner, by.id)) throw new DomainError("forbidden", `${by.id} may not report on that task`);
    if (!Number.isSafeInteger(command.generation) || command.generation < 1) invalid("generation", "must be a whole number of at least 1");
    return this.#record(by.id, by.kind === "host" ? by.id : undefined, command, task);
  }

  /**
   * The controller's own report of a model call it relayed (card V01b): the request started, its first output, progress, its end. It has no principal, is not reachable from the state API, and is fenced by attempt as well as generation; the evidence keeps the worker's own `reportedBy` (the relay is
   * not a second reporter), and a task that is not assigned at that generation is refused (`fenced`) like any report. Never call it with an event the caller did not see happen.
   */
  async reportFromRelay(command: NoActor & { taskId: string; generation: number; attemptId: string; event: StallEvent }): Promise<{ id: string; revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "generation", "attemptId", "event"]);
    const taskId = checkTaskId(command.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", "no such task");
    // Attempts of one generation share it, so the relay of an attempt that is not the active one (abandoned, left running) reports nothing.
    const assignment = await this.#assignments.getAssignment(taskId);
    if (assignment === undefined || assignment.activeAttemptId !== command.attemptId) throw new DomainError("fenced", "that attempt is not the task's active attempt");
    const { attemptId: _attempt, ...rest } = command;
    return this.#record("controller", undefined, rest, task, true);
  }

  async #record(actorId: string, reporterHost: string | undefined, command: NoActor & { taskId: string; generation: number; event: StallEvent }, task: TaskBody, relayed = false): Promise<{ id: string; revision: number; replayed: boolean }> {
    const taskId = command.taskId;
    const assignment = await this.#assignments.getAssignment(taskId);
    if (!Number.isSafeInteger(command.generation) || command.generation < 1) invalid("generation", "must be a whole number of at least 1");
    const event = checkEvent(command.event);
    if (assignment === undefined || assignment.state !== "assigned") throw new DomainError("fenced", "the task is not assigned, so there is no one to report for");
    if (assignment.generation !== command.generation) throw new DomainError("fenced", `generation ${command.generation} is not the current one (${assignment.generation}); read the assignment`);
    const ref: AggregateRef = { kind: "stall-evidence", id: taskId };
    for (let attempt = 1; ; attempt++) {
      try {
        return await this.#runner.command("stall.report", { commandId: scopedCommandId(actorId, command.commandId), actor: actorId }, async () => ({
          payload: { taskId, generation: command.generation, event: event as unknown as JsonObject },
          build: async () => {
            const current = await this.#runner.get(ref.kind, ref.id);
            const stored = current?.body as unknown as EvidenceBody | undefined;
            const at = this.#runner.now();
            // A late report of an earlier generation must not overwrite the newer generation's evidence (the check before the command can be overtaken).
            if (stored !== undefined && stored.generation > command.generation) throw new DomainError("fenced", `generation ${command.generation} is no longer current; read the assignment`);
            // A new generation starts its evidence again: what the previous owner did says nothing about this one.
            const base: EvidenceBody = stored !== undefined && stored.generation === command.generation
              ? stored
              : { taskId, projectId: task.projectId, generation: command.generation, since: at, reportedBy: actorId, lastReportAt: at, lastProgressAt: at, reports: 0, steps: 0, window: [], counts: {}, evidence: [], evidenceTotal: 0 };
            const next = applyEvent(base, event, relayed && stored !== undefined && stored.generation === command.generation ? stored.reportedBy : actorId, at);
            const change: Change = current === undefined
              ? { type: "create", ref, body: next as unknown as JsonObject }
              : { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject };
            const changes: Change[] = [change];
            // A finished request that read a big prompt or wrote a long reply tells the route's speed (card V01b).
            if (event.type === "request_finished" && event.outcome === "ok" && base.request?.id === event.requestId && base.request.route !== undefined) {
              const request = base.request;
              const hostId = request.hostId ?? reporterHost ?? "-";
              const readMs = request.firstOutputAt === undefined ? 0 : Date.parse(request.firstOutputAt) - Date.parse(request.startedAt);
              const writeMs = request.firstOutputAt === undefined ? 0 : Date.parse(at) - Date.parse(request.firstOutputAt);
              const readTokens = Math.max(0, (event.inputTokens ?? 0) - (event.cachedTokens ?? 0));
              const readSample = readMs >= SPEED_SAMPLE.minReadMs && readTokens >= SPEED_SAMPLE.minReadTokens ? readTokens / (readMs / 1000) : undefined;
              const writeSample = writeMs >= SPEED_SAMPLE.minWriteMs && (event.outputTokens ?? 0) >= SPEED_SAMPLE.minWriteTokens ? event.outputTokens! / (writeMs / 1000) : undefined;
              if (readSample !== undefined || writeSample !== undefined) {
                const sref: AggregateRef = { kind: "stall-speed", id: speedId(request.route!, hostId) };
                const old = await this.#runner.get(sref.kind, sref.id);
                const was = old?.body as unknown as SpeedBody | undefined;
                const speed: SpeedBody = {
                  route: request.route!, hostId, readSamples: (was?.readSamples ?? 0) + (readSample === undefined ? 0 : 1), writeSamples: (was?.writeSamples ?? 0) + (writeSample === undefined ? 0 : 1), updatedAt: at,
                  ...(readSample === undefined ? (was?.readTps === undefined ? {} : { readTps: was.readTps }) : { readTps: smooth(was?.readTps, readSample) }),
                  ...(writeSample === undefined ? (was?.writeTps === undefined ? {} : { writeTps: was.writeTps }) : { writeTps: smooth(was?.writeTps, writeSample) }),
                };
                changes.push(old === undefined ? { type: "create", ref: sref, body: speed as unknown as JsonObject } : { type: "update", ref: sref, expectedRevision: old.revision, body: speed as unknown as JsonObject });
              }
            }
            return { ref, creates: current === undefined, changes, detail: { taskId, generation: command.generation, event: event.type } };
          },
        }));
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 6) throw error;
      }
    }
  }

  /** The bounded evidence recorded for a task, for those who may read its concerns. */
  async evidence(by: Principal, taskId: string): Promise<View<EvidenceBody> | undefined> {
    const id = checkTaskId(taskId);
    const found = await this.#runner.get("stall-evidence", id);
    if (found === undefined) return undefined;
    const body = found.body as unknown as EvidenceBody;
    return (await this.#mayRead(by, body.projectId, id)) ? view<EvidenceBody>(found) : undefined;
  }

  // ---- assessment -------------------------------------------------------------------------------------------------------------

  /** The assessment of a task now, with its signals and who a concern would be routed to. Nothing is written. A task the caller may not read reads like a missing one. */
  async assess(by: Principal, taskId: string): Promise<(Assessment & { taskId: string; generation?: number; difficulty: Difficulty; route?: Route }) | undefined> {
    const id = checkTaskId(taskId);
    const task = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !(await this.#mayRead(by, task.projectId, id))) return undefined;
    const facts = await this.#facts(id, task);
    return { ...facts.assessment, taskId: id, difficulty: facts.difficulty, ...(facts.generation === undefined ? {} : { generation: facts.generation }), ...(facts.route === undefined ? {} : { route: facts.route }) };
  }

  /**
   * One pass over assignments (a page of `limit`, from `afterId`): suspected concerns are opened, refreshed or cleared to match the signals, a dismissed concern whose time has run
   * out and is still true is reopened, and concerns of a task that is no longer running, or of an earlier generation, are cleared. Confirmed concerns are never changed here. For the
   * owner or a service holding `recovery.stall-scan` (which permits this scan and nothing else) or `recovery.read` everywhere. A pass changes only concern records; it repeats safely (each change is its own command, keyed by concern and revision).
   */
  async scan(by: Principal, page: { afterId?: string; limit?: number } = {}): Promise<ScanReport> {
    if (!(by.kind === "owner" || (by.kind === "service" && (allowsExactly(by, "recovery.stall-scan", "*") || allowsExactly(by, "recovery.read", "*"))))) throw new DomainError("forbidden", `${by.id} may not run stall detection`);
    const limit = page.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > STALL_LIMITS.scan) invalid("limit", `must be a whole number from 1 to ${STALL_LIMITS.scan}`);
    const records = await this.#runner.list("assignment", { ...(page.afterId === undefined ? {} : { afterId: page.afterId }), limit });
    const counts = { checked: 0, opened: 0, reopened: 0, cleared: 0, contended: 0 };
    for (const record of records) {
      const taskId = (record.body as unknown as AssignmentBody).taskId;
      const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
      if (task === undefined) continue;
      counts.checked++;
      const facts = await this.#facts(taskId, task);
      const wanted = new Map(facts.assessment.concerns.map((c) => [c.kind, c] as const));
      const existing = await this.#concernsOf(taskId);
      const now = Date.parse(this.#runner.now());
      for (const [kind, concern] of wanted) {
        if (facts.generation === undefined || facts.route === undefined) continue;
        const id = concernId(taskId, facts.generation, kind);
        const found = existing.find((c) => c.id === id);
        try {
          if (found === undefined) { await this.#write(by, id, undefined, { taskId, projectId: task.projectId, generation: facts.generation, kind, state: "suspected", detail: concern.detail, difficulty: facts.difficulty, route: facts.route, firstSeenAt: this.#runner.now(), lastChangedAt: this.#runner.now(), reopened: 0 }); counts.opened++; continue; }
          const body = found;
          if (body.state === "confirmed") continue;
          if (body.state === "dismissed" && (body.dismissedUntil === undefined || Date.parse(body.dismissedUntil) > now)) continue;
          if (body.state === "suspected") {
            // Only a change of route rewrites a suspected concern: the stored detail does not vary with time, so a supervisor's revision stays good across scans.
            if (sameRoute(body.route, facts.route)) continue;
            // The ladder starts again for the new route: a holder up the old chain (or a mark of an escalation) must not stay on a concern routed elsewhere.
            const { escalatedAt: _ea, notifiedAt: _na, escalatedTo: _et, escalationLevel: _el, escalationTrail: _tr, recoveryRung: _rr, recoverySteps: _rs, ...fresh } = body;
            await this.#write(by, id, found.revision, { ...fresh, route: facts.route, lastChangedAt: this.#runner.now() });
            continue;
          }
          // Cleared, or a dismissal that has run out: it came back.
          const { dismissedUntil: _d, clearedBecause: _c, decidedBy: _b, decidedAt: _a, decision: _n, escalatedAt: _e, notifiedAt: _f, escalatedTo: _g, escalationLevel: _h, escalationTrail: _i, recoveryRung: _j, recoverySteps: _k, ...rest } = body;
          await this.#write(by, id, found.revision, { ...rest, state: "suspected", detail: concern.detail, difficulty: facts.difficulty, route: facts.route, lastChangedAt: this.#runner.now(), reopened: body.reopened + 1 });
          counts.reopened++;
        } catch (error) { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict")) counts.contended++; else throw error; }
      }
      // A confirmed concern is archived (state cleared, with the reason) once its task is done or cancelled or its generation has moved on; a dismissed one is left to run out.
      for (const found of existing) {
        if (found.state !== "confirmed") continue;
        const ended = task.state === "done" || task.state === "cancelled";
        const moved = facts.generation !== undefined && found.generation !== facts.generation;
        if (!ended && !moved) continue;
        try {
          await this.#write(by, found.id, found.revision, { ...found, state: "cleared", clearedBecause: ended ? `archived: the task is ${task.state}` : "archived: the task has a new owner", lastChangedAt: this.#runner.now() });
          counts.cleared++;
        } catch (error) { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict")) counts.contended++; else throw error; }
      }
      // Suspected concerns the signals no longer support (or that belong to another generation, or a task that is not running) are cleared.
      for (const found of existing) {
        const body = found;
        if (body.state !== "suspected") continue;
        const stillTrue = body.generation === facts.generation && wanted.has(body.kind);
        if (stillTrue) continue;
        const status = facts.assessment.status;
        const because = body.generation !== facts.generation ? "the task has a new owner or is no longer assigned" : status === "waiting" ? "the task is waiting on purpose" : status === "paused" ? "the task is paused on purpose" : status === "not_running" ? "the task is not running" : "the signals recovered";
        try {
          await this.#write(by, found.id, found.revision, { ...body, state: "cleared", clearedBecause: because, lastChangedAt: this.#runner.now() });
          counts.cleared++;
        } catch (error) { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict")) counts.contended++; else throw error; }
      }
    }
    const last = records.at(-1);
    return { ...counts, ...(records.length === limit && last !== undefined ? { next: last.id } : {}) };
  }

  // ---- decisions and reads ----------------------------------------------------------------------------------------------------

  /**
   * The agent's responsible supervisor, the installation owner, or a holder of `assignment.manage` in the project confirms the suspicion as a failure or dismisses it (for
   * `dismissForMs`; a signal that is still bad after that reopens it). The task's own owner may not decide on its own concern. Neither changes the task or its assignment.
   */
  async decide(by: Principal, command: NoActor & { concernId: string; expectedRevision: number; decision: "confirm" | "dismiss"; reason: string }): Promise<{ id: string; revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "concernId", "expectedRevision", "decision", "reason"]);
    const found = await this.#concern(command.concernId);
    if (found === undefined || !(await this.#mayRead(by, found.projectId, found.taskId, found.escalatedTo))) throw new DomainError("not_found", "no such concern");
    if (command.decision !== "confirm" && command.decision !== "dismiss") invalid("decision", "must be confirm or dismiss");
    const reason = safe(command.reason, "reason", 500);
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) invalid("expectedRevision", "must be a whole number of at least 1");
    const assignment = await this.#assignments.getAssignment(found.taskId);
    const supervisor = (found.route.via === "supervisor" && `agent:${found.route.to.id}` === by.id) || found.escalatedTo === by.id;
    const manager = by.kind === "owner" || allows(by, "assignment.manage", found.projectId);
    if (!(by.kind === "owner" || (!isOwner(assignment?.owner, by.id) && (supervisor || manager)))) throw new DomainError("forbidden", `${by.id} may not decide on that concern`);
    const ref: AggregateRef = { kind: "stall-concern", id: found.id };
    // The revision and state are checked inside the command, so a repeat of one that already applied is answered with its recorded result, not refused as stale.
    return this.#runner.command(`stall.${command.decision}`, { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { concernId: found.id, expectedRevision: command.expectedRevision, decision: command.decision, reason },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        if (current === undefined) throw new DomainError("not_found", "no such concern");
        if (current.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the concern is at revision ${current.revision}`, { currentRevision: current.revision });
        const body = current.body as unknown as ConcernBody;
        if (body.state !== "suspected") throw new DomainError("invalid_transition", `the concern is ${body.state}; only a suspected one can be decided`);
        const at = this.#runner.now();
        const next: ConcernBody = command.decision === "confirm"
          ? { ...body, state: "confirmed", decidedBy: by.id, decidedAt: at, decision: reason, lastChangedAt: at }
          : { ...body, state: "dismissed", decidedBy: by.id, decidedAt: at, decision: reason, dismissedUntil: new Date(Date.parse(at) + this.#dismissForMs).toISOString(), lastChangedAt: at };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { taskId: body.taskId, kind: body.kind, state: next.state, generation: body.generation } };
      },
    }));
  }

  /**
   * One step of the recovery action ladder on a concern (card V02c): `nudge` (a message to the agent), `rebrief` (a new brief), `reassign` (to another agent, at once, with a warning naming rights the new holder lacks), `pause` or `stop` the agent,
   * `hand-to-owner`. Who may: the same people who may decide the concern (never the task's own owner on its own concern, except the owner). The step must be the next rung up: the lowest action the installation allows at the concern's
   * level (`recovery.ladder`: level = how often it climbed, or the owner's level) above the last step taken; the owner is not held to the level lists or the on/off switch, but still only goes up. The effect is made through the existing
   * services as the caller (their own rights checks apply), under a key made from the command, inside the command that records the step: a repeat of the command does it once and is answered as recorded, and an effect that fails records nothing.
   * Only a suspected or confirmed concern. At most one step per revision of the concern.
   */
  async recover(by: Principal, command: NoActor & { concernId: string; expectedRevision: number; action: RecoveryAction; text?: string; to?: string }): Promise<{ id: string; revision: number; replayed: boolean; step?: RecoveryStep }> {
    onlyKnown(command, ["commandId", "concernId", "expectedRevision", "action", "text", "to"]);
    if (this.#recoveryPolicy === undefined || this.#recoveryEffects === undefined) throw new DomainError("unavailable", "recovery steps are not available");
    const found = await this.#concern(command.concernId);
    if (found === undefined || !(await this.#mayRead(by, found.projectId, found.taskId, found.escalatedTo))) throw new DomainError("not_found", "no such concern");
    if (typeof command.action !== "string" || !(RECOVERY_ACTIONS as readonly string[]).includes(command.action)) invalid("action", `must be one of ${RECOVERY_ACTIONS.join(", ")}`);
    const action = command.action;
    if (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 1) invalid("expectedRevision", "must be a whole number of at least 1");
    const noText = action === "hand-to-owner" && command.text === undefined;
    const reason = noText ? undefined : safe(command.text, "text", 500);
    if (action === "reassign") { if (typeof command.to !== "string" || !/^agent:[A-Za-z0-9_.-]{1,64}$/.test(command.to)) invalid("to", "reassign names the agent to give the task to, such as agent:ann"); } else if (command.to !== undefined) invalid("to", "only a reassignment names an agent");
    const assignment = await this.#assignments.getAssignment(found.taskId);
    const supervisor = (found.route.via === "supervisor" && `agent:${found.route.to.id}` === by.id) || found.escalatedTo === by.id;
    const manager = by.kind === "owner" || allows(by, "assignment.manage", found.projectId);
    if (!(by.kind === "owner" || (!isOwner(assignment?.owner, by.id) && (supervisor || manager)))) throw new DomainError("forbidden", `${by.id} may not take recovery steps on that concern`);
    const policy = await this.#recoveryPolicy();
    if (by.kind !== "owner" && !policy.enabled) throw new DomainError("forbidden", "recovery steps by agents are switched off (the owner can switch them on)");
    const ref: AggregateRef = { kind: "stall-concern", id: found.id };
    const effects = this.#recoveryEffects;
    return this.#runner.command("stall.recover", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { concernId: found.id, expectedRevision: command.expectedRevision, action, text: reason ?? null, to: command.to ?? null },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        if (current === undefined) throw new DomainError("not_found", "no such concern");
        if (current.revision !== command.expectedRevision) throw new DomainError("stale_revision", `the concern is at revision ${current.revision}`, { currentRevision: current.revision });
        const body = readConcern(current.body as unknown as ConcernBody);
        if (body.state !== "suspected" && body.state !== "confirmed") throw new DomainError("invalid_transition", `the concern is ${body.state}; only a suspected or confirmed one can be acted on`);
        const level: number | "owner" = body.escalatedTo === "owner" || body.route.via === "owner" ? "owner" : body.escalationLevel ?? 0;
        const last = body.recoveryRung ?? -1;
        const allowed = allowedAt(policy, level);
        const rung = rungOf(action);
        if (by.kind !== "owner") {
          const next = RECOVERY_ACTIONS.find((a) => rungOf(a) > last && allowed.includes(a));
          if (!allowed.includes(action)) throw new DomainError("forbidden", `${action} is not allowed at ${level === "owner" ? "the owner's level" : `level ${level}`}${next === undefined ? "; no further step is allowed there" : `; the next step there is ${next}`}`);
          if (action !== next) throw new DomainError("invalid_transition", `the next step is ${next ?? "none"}, not ${action}`);
        } else if (rung <= last) throw new DomainError("invalid_transition", `${RECOVERY_ACTIONS[last]} was already taken; take a higher step`);
        const at = this.#runner.now();
        const key = createHash("sha256").update(`${scopedCommandId(by.id, command.commandId)}|${found.id}`).digest("hex").slice(0, 32);
        let warnings: readonly string[] | undefined;
        if (action !== "hand-to-owner") warnings = (await effects.run(action, { by, key: `rec-${key}`, taskId: body.taskId, projectId: body.projectId, concernId: found.id, text: reason!, ...(command.to === undefined ? {} : { to: command.to }) })).warnings;
        const n = (body.recoverySteps?.at(-1)?.n ?? 0) + 1;
        const step: RecoveryStep = { n, action, by: by.id, at, level, ...(reason === undefined ? {} : { text: reason }), ...(command.to === undefined ? {} : { to: command.to }), ...(warnings === undefined || warnings.length === 0 ? {} : { warnings: warnings.slice(0, 5).map((w) => w.slice(0, 200)) }) };
        let next: ConcernBody = { ...body, recoveryRung: rung, recoverySteps: [...(body.recoverySteps ?? []), step].slice(-TRAIL_KEEP), lastChangedAt: at };
        // Handing the concern to the owner parks it there and has the owner told once (the same notice as a climb to the owner, keyed by the time and level).
        if (action === "hand-to-owner" && body.escalatedTo !== "owner") {
          const { notifiedAt: _n, ...rest } = next;
          const climb: EscalationStep = { level: (body.escalationLevel ?? 0) + 1, to: "owner", at };
          next = { ...rest, escalatedAt: at, escalatedTo: "owner", escalationLevel: climb.level, escalationTrail: [...(body.escalationTrail ?? []), climb].slice(-TRAIL_KEEP) };
        }
        const { id: _i, revision: _r, ...stored } = next as ConcernBody & { id?: string; revision?: number };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: stored as unknown as JsonObject }], detail: { taskId: body.taskId, kind: body.kind, state: body.state, generation: body.generation, action, step: n } };
      },
    }));
  }

  /**
   * Climbs the supervisor ladder (card V02b and the owner decision of 2026-10-30). A suspected concern starts with the supervisor it is routed to. When it has gone undecided for the level's time (the owner's `escalation.ladder` hours for that
   * level, else the installation's `escalateAfterMs`, default 24 hours), it passes to the supervisor of the current holder, and the level and the holder are recorded; a supervisor who is retired, cannot see the task,
   * or is the task's own owner is passed over with the reason recorded, and a loop or an over-deep chain ends at the owner. With no supervisor left it goes to the owner, which is the top: it climbs no further.
   * One step a concern a pass (the next waits its own level time), each keyed by concern and revision so a pass repeated after a crash is the same step. Returns the escalated concerns whose notice has not been
   * recorded as sent, oldest first, so a notice that failed is offered again. Needs the same right as the scan.
   *
   * Who may decide a concern once it has climbed (the rule): the owner; whoever holds `assignment.manage` in the project; the supervisor it was first routed to; and the one current holder (`escalatedTo`), only while it still can see the task.
   * Supervisors it climbed past, and earlier holders, no longer see it; the task's own owner never decides on its own concern. A concern that cannot be told to its holder is parked with the owner. The skipped-supervisor reasons are shown only to
   * the owner and the current holder. A change of route (the agent's supervisor changed or retired) starts the ladder again for the new route. An unreadable ladder setting stops only the climbing, never the untold notices.
   */
  async escalateUndecided(by: Principal, limit = 100): Promise<(ConcernBody & { id: string; revision: number })[]> {
    this.#mayScan(by);
    // The owner's setting is read first. When it cannot be read nothing climbs (no escalation at a time nobody set), but the notices already owed are still returned, and the owner is told once about the damage.
    let hours: readonly number[] | undefined;
    try { hours = (await this.#ladderHours?.()) ?? []; this.#damageEpisode = undefined; this.#damageTold = false; } catch (error) {
      this.#damageEpisode ??= this.#runner.now();
      if (!this.#damageTold && this.#ladderDamaged !== undefined) {
        const why = error instanceof Error ? error.message : String(error);
        await this.#ladderDamaged({ id: `stall-ladder-damaged-${createHash("sha256").update(this.#damageEpisode).digest("hex").slice(0, 24)}`, detail: `The escalation ladder setting cannot be read, so stuck concerns are not climbing the supervisor chain: ${why}`.slice(0, 200) });
        this.#damageTold = true;
      }
    }
    // One read of the concerns a tick (the marks written here are applied to this list), not two.
    const all = await this.#suspected(limit);
    for (const [i, c] of (hours === undefined ? [] : all).entries()) {
      // A concern routed to the owner, or already with the owner, has no supervisor to wait for.
      if (c.route.via !== "supervisor" || c.escalatedTo === "owner") continue;
      const level = c.escalationLevel ?? 0;
      const waitMs = hours![level] === undefined ? this.#escalateAfterMs : hours![level]! * 3_600_000;
      if (Date.parse(this.#runner.now()) - Date.parse(c.escalatedAt ?? c.lastChangedAt) < waitMs) continue;
      const escalatedAt = this.#runner.now();
      const next = await this.#nextHolder(c);
      const { notifiedAt: _n, ...kept } = c;
      const step: EscalationStep = { level: level + 1, to: next.to, at: escalatedAt, ...(next.skipped.length === 0 ? {} : { skipped: next.skipped.slice(0, SKIPPED_KEEP) }) };
      const body: ConcernBody = { ...kept, escalatedAt, escalatedTo: next.to, escalationLevel: level + 1, escalationTrail: [...(c.escalationTrail ?? []), step].slice(-TRAIL_KEEP) };
      try { const w = await this.#write(by, c.id, c.revision, body); all[i] = { ...body, id: c.id, revision: w.revision }; } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict"))) throw error; }
    }
    return all.filter((c) => c.escalatedAt !== undefined && c.notifiedAt === undefined).sort((a, b) => (a.escalatedAt! < b.escalatedAt! ? -1 : 1));
  }

  /**
   * The notice to a supervisor failed because it can no longer see the task: the concern is parked with the owner (it holds it from now on, so it does not stay with an agent who cannot see it, and does not climb back down). The climb's
   * level, time and trail are kept (the owner's notice has the same id as the one the supervisor would have had). Needs the same right as the scan.
   */
  async holdWithOwner(by: Principal, concernId: string): Promise<void> {
    this.#mayScan(by);
    const found = await this.#concern(concernId);
    if (found === undefined || found.state !== "suspected" || found.escalatedTo === "owner") return;
    try { await this.#write(by, found.id, found.revision, { ...found, escalatedTo: "owner" }); } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict"))) throw error; }
  }

  /**
   * The next holder above the concern's current one: walks up the reporting chain (each agent's supervisor), passing over, with the reason, any agent that is retired, has no live identity, cannot see the task
   * (needs `task.read`, `assignment.read` or `assignment.manage` on it) or is the task's own owner. A repeat in the chain, a missing agent record or a chain past the limit ends at the owner, with the reason.
   */
  async #nextHolder(c: ConcernBody): Promise<{ to: string; skipped: { id: string; reason: string }[] }> {
    const skipped: { id: string; reason: string }[] = [];
    const skip = (id: string, reason: string): void => { skipped.push({ id, reason: reason.slice(0, 120) }); };
    const assignment = await this.#assignments.getAssignment(c.taskId);
    const holder = c.escalatedTo ?? `agent:${c.route.to.id}`;
    const holderId = holder.startsWith("agent:") ? holder.slice(6) : holder;
    const bare = (id: string): string => (id.startsWith("agent:") ? id.slice(6) : id);
    // The holders already visited (the one now, the one it was routed to, and those of earlier climbs): reaching one again is a loop. The task's owner is not among them; it is passed over on its own reason below.
    const seen = new Set<string>([holderId, c.route.to.id, ...(c.escalationTrail ?? []).map((x) => bare(x.to))]);
    let at = ((await this.#runner.get("agent", holderId))?.body as unknown as AgentBody | undefined)?.supervisorId;
    for (let hops = 0; at !== undefined; hops++) {
      if (hops >= AGENT_LIMITS.chain) { skip(at, "the reporting chain is too deep"); break; }
      if (seen.has(at)) { skip(at, "the reporting chain loops back to an agent already tried"); break; }
      seen.add(at);
      const agent = (await this.#runner.get("agent", at))?.body as unknown as AgentBody | undefined;
      if (agent === undefined) { skip(at, "has no agent record"); break; }
      const reason = agent.state !== "active" ? "is retired" : isOwner(assignment?.owner, `agent:${at}`) ? "is the task's own owner" : await this.#cannotSee(at, c);
      if (reason === undefined) return { to: `agent:${at}`, skipped };
      skip(at, reason);
      at = agent.supervisorId;
    }
    return { to: "owner", skipped };
  }

  /** Why the agent cannot take a concern on this task (no live identity, or no right to see the task); `undefined` when it can. */
  async #cannotSee(agentId: string, c: ConcernBody): Promise<string | undefined> {
    const stored = (await this.#runner.get("principal", `agent:${agentId}`))?.body as unknown as PrincipalBody | undefined;
    if (stored === undefined || stored.state !== "active") return "has no active identity";
    const now = this.#runner.now();
    const principal = await effectiveOf(this.#runner, { id: `agent:${agentId}`, kind: "agent", name: stored.name, grants: stored.grants }, now);
    const scope = { resource: { kind: "task", id: c.taskId }, now } as const;
    return ["task.read", "assignment.read", "assignment.manage"].some((a) => allows(principal, a, c.projectId, scope)) ? undefined : "cannot see the task";
  }

  /** The suspected concerns, read as the controller (no per-reader filter: the caller is the owner or the recovery service), at most `limit`. */
  async #suspected(limit: number): Promise<(ConcernBody & { id: string; revision: number })[]> {
    const out: (ConcernBody & { id: string; revision: number })[] = [];
    for (let after: string | undefined; out.length < limit;) {
      const rows = await this.#runner.list("stall-concern", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const row of rows) {
        after = row.id;
        const b = readConcern(row.body as unknown as ConcernBody);
        if (b.state !== "suspected") continue;
        // A concern with nothing left to do (parked with the owner, or routed to it, and with no notice owed) is left out before the limit, so it cannot crowd out the ones that can still climb.
        const nothingToClimb = b.route.via !== "supervisor" || b.escalatedTo === "owner";
        if (nothingToClimb && (b.escalatedAt === undefined || b.notifiedAt !== undefined)) continue;
        out.push({ ...b, id: row.id, revision: row.revision });
      }
      if (rows.length < 200) break;
    }
    return out.slice(0, limit);
  }

  /** Records that an escalation's notice was sent. */
  async markEscalationNotified(by: Principal, concernId: string): Promise<void> {
    this.#mayScan(by);
    const found = await this.#concern(concernId);
    if (found === undefined || found.notifiedAt !== undefined) return;
    try { await this.#write(by, found.id, found.revision, { ...found, notifiedAt: this.#runner.now() }); } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict"))) throw error; }
  }

  #mayScan(by: Principal): void {
    if (!(by.kind === "owner" || (by.kind === "service" && (allowsExactly(by, "recovery.stall-scan", "*") || allowsExactly(by, "recovery.read", "*"))))) throw new DomainError("forbidden", `${by.id} may not escalate stall concerns`);
  }

  async get(by: Principal, id: string): Promise<View<ConcernBody> | undefined> {
    const found = await this.#concern(id);
    return found === undefined || !(await this.#mayRead(by, found.projectId, found.taskId, found.escalatedTo)) ? undefined : (forReader(by, found) as unknown as View<ConcernBody>);
  }

  /** Concerns of one state (default `suspected`), a page at a time, only those the caller may read. */
  async list(by: Principal, query: { state?: ConcernState; taskId?: string; afterId?: string; limit?: number } = {}): Promise<{ items: View<ConcernBody>[]; next?: string }> {
    const state = query.state ?? "suspected";
    if (!STATES.includes(state)) invalid("state", `must be one of ${STATES.join(", ")}`);
    const limit = query.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) invalid("limit", "must be a whole number from 1 to 1000");
    const items: View<ConcernBody>[] = [];
    let after = query.afterId;
    const prefix = query.taskId === undefined ? undefined : prefixOf(checkTaskId(query.taskId));
    if (after === undefined && prefix !== undefined) after = prefix;
    for (let pages = 0; pages < 50; pages++) {
      const rows = await this.#runner.list("stall-concern", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const row of rows) {
        after = row.id;
        if (prefix !== undefined && !row.id.startsWith(prefix)) return { items };
        const body = readConcern(row.body as unknown as ConcernBody);
        if (body.state !== state || !(await this.#mayRead(by, body.projectId, body.taskId, body.escalatedTo))) continue;
        items.push({ ...view<ConcernBody>(row), ...forReader(by, body) } as View<ConcernBody>);
        if (items.length === limit) return { items, next: row.id };
      }
      if (rows.length < 200) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }

  /** Suspected stalls and confirmed failures, side by side but never mixed: two lists, each bounded. */
  async overview(by: Principal, limit = 100): Promise<{ suspected: View<ConcernBody>[]; confirmed: View<ConcernBody>[] }> {
    return { suspected: (await this.list(by, { state: "suspected", limit })).items, confirmed: (await this.list(by, { state: "confirmed", limit })).items };
  }

  // ---- internals --------------------------------------------------------------------------------------------------------------

  async #concern(id: string): Promise<(ConcernBody & { id: string; revision: number }) | undefined> {
    if (typeof id !== "string" || !/^stl-[a-z2-7]{20}-\d{10}-[a-z-]{4,20}$/.test(id)) return undefined;
    const found = await this.#runner.get("stall-concern", id);
    return found === undefined ? undefined : { ...readConcern(found.body as unknown as ConcernBody), id: found.id, revision: found.revision };
  }

  /** Every concern of a task, in order (all generations). */
  async #concernsOf(taskId: string): Promise<(ConcernBody & { id: string; revision: number })[]> {
    const prefix = prefixOf(taskId);
    const out: (ConcernBody & { id: string; revision: number })[] = [];
    let after = prefix;
    for (;;) {
      const rows = await this.#runner.list("stall-concern", { afterId: after, limit: 200 });
      for (const row of rows) {
        if (!row.id.startsWith(prefix)) return out;
        out.push({ ...readConcern(row.body as unknown as ConcernBody), id: row.id, revision: row.revision });
        after = row.id;
      }
      if (rows.length < 200) return out;
    }
  }

  async #write(by: Principal, id: string, expected: number | undefined, body: ConcernBody): Promise<{ id: string; revision: number; replayed: boolean }> {
    const ref: AggregateRef = { kind: "stall-concern", id };
    // The records we read carry their id and revision; the stored body does not.
    const { id: _i, revision: _r, ...stored } = body as ConcernBody & { id?: string; revision?: number };
    body = stored;
    const change: Change = expected === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: expected, body: body as unknown as JsonObject };
    // Keyed by concern and the revision it was read at, so a pass repeated after a crash is the same command and a later state is a different one.
    return this.#runner.command("stall.concern", { commandId: `stall:${id}:${expected ?? 0}:${body.state}`, actor: by.id }, async () => ({
      payload: { id, state: body.state, kind: body.kind, detail: body.detail },
      build: async () => ({ ref, creates: expected === undefined, changes: [change], detail: { taskId: body.taskId, kind: body.kind, state: body.state, generation: body.generation } }),
    }));
  }

  /** Owner, the agent a concern is about, the supervisor it is routed to, and holders of `assignment.read` or `assignment.manage` in the project. */
  async #mayRead(by: Principal, projectId: string, taskId: string, escalatedTo?: string): Promise<boolean> {
    // An escalated-to supervisor sees and decides the one concern only while it can still see the task (a right it lost since is not kept by the escalation).
    if (escalatedTo !== undefined && escalatedTo === by.id && by.kind === "agent" && ["task.read", "assignment.read", "assignment.manage"].some((a) => allows(by, a, projectId, { resource: { kind: "task", id: taskId } }))) return true;
    const scope = { resource: { kind: "task", id: taskId } } as const;
    if (by.kind === "owner" || allows(by, "assignment.read", projectId, scope) || allows(by, "assignment.manage", projectId, scope)) return true;
    const assignment = await this.#assignments.getAssignment(taskId);
    if (isOwner(assignment?.owner, by.id)) return true;
    const route = await this.#route(assignment?.owner);
    return route.via === "supervisor" && `agent:${route.to.id}` === by.id;
  }

  /** The agent's supervisor when it has an active one (card H11); otherwise the installation owner, with the reason. */
  async #route(owner: Owner | undefined): Promise<Route> {
    const toOwner = (reason: string): Route => ({ to: { kind: "owner", id: "owner" }, via: "owner", reason });
    if (owner === undefined) return toOwner("the task has no owner");
    if (owner.kind !== "agent") return toOwner(`the owner (${owner.kind}) is not an agent`);
    const id = owner.id.startsWith("agent:") ? owner.id.slice(6) : owner.id;
    const agent = (await this.#runner.get("agent", id))?.body as unknown as AgentBody | undefined;
    if (agent === undefined) return toOwner("the owning agent has no agent record (enrolled by hand), so it has no supervisor");
    if (agent.supervisorId === undefined) return toOwner("the owning agent has no supervisor");
    const supervisor = (await this.#runner.get("agent", agent.supervisorId))?.body as unknown as AgentBody | undefined;
    if (supervisor === undefined || supervisor.state !== "active") return toOwner("the owning agent's supervisor is not an active agent");
    return { to: { kind: "agent", id: agent.supervisorId }, via: "supervisor", reason: `${supervisor.friendlyName} supervises the owning agent` };
  }

  async #host(reporter: string): Promise<HostEvidence | undefined> {
    if (!reporter.startsWith("host:")) return undefined;
    const pbody = (await this.#runner.get("principal", reporter))?.body as unknown as PrincipalBody | undefined;
    if (pbody === undefined || pbody.kind !== "host") return undefined;
    const record = (await this.#runner.get("host-record", reporter))?.body as unknown as HostBody | undefined;
    const identity = pbody.state === "active" ? "active" as const : "revoked" as const;
    return { hostId: reporter, identity, freshness: hostFreshness(record?.lastSeenAt, this.#runner.now(), this.#hostStaleAfterMs) };
  }

  /** The speed to judge a reading request by: what the route has been measured at, else what its settings declare, else the cautious default (card V01b). */
  async #readingSpeed(route: string | undefined, hostId: string): Promise<{ tokensPerSecond: number; source: "measured" | "declared" | "default"; marginPercent: number }> {
    if (route !== undefined) {
      const measured = ((await this.#runner.get("stall-speed", speedId(route, hostId)))?.body as unknown as SpeedBody | undefined)?.readTps;
      if (measured !== undefined && measured > 0) return { tokensPerSecond: measured, source: "measured", marginPercent: this.#marginPercent };
      const declared = (await this.#declared?.(route, hostId === "-" ? undefined : hostId))?.readTokensPerSecond;
      if (declared !== undefined && declared > 0) return { tokensPerSecond: declared, source: "declared", marginPercent: this.#marginPercent };
    }
    return { tokensPerSecond: this.#defaultTps, source: "default", marginPercent: this.#marginPercent };
  }

  /** What a route has shown about its speed on a host (owner or staff only through the caller's right to read concerns is not needed: it carries no task data). */
  async speed(by: Principal, route: string, hostId: string): Promise<View<SpeedBody> | undefined> {
    if (by.kind !== "owner" && by.kind !== "service") throw new DomainError("forbidden", `${by.id} may not read route speeds`);
    const found = await this.#runner.get("stall-speed", speedId(route, hostId));
    return found === undefined ? undefined : view<SpeedBody>(found);
  }

  async #facts(taskId: string, task: TaskBody): Promise<{ assessment: Assessment; difficulty: Difficulty; generation?: number; route?: Route }> {
    const assignment = await this.#assignments.getAssignment(taskId);
    const contract = (await this.#runner.get("task-contract", taskId))?.body as unknown as ContractBody | undefined;
    const difficulty = contract?.difficulty ?? "medium";
    const wait = await this.#waits.openFor(taskId);
    const assigned = assignment !== undefined && assignment.state === "assigned" && assignment.owner !== undefined;
    const attempt = assigned && assignment.activeAttemptId !== undefined ? await this.#assignments.getAttempt(assignment.activeAttemptId) as View<AttemptBody> | undefined : undefined;
    const running = assigned && attempt !== undefined && attempt.state === "active" && task.state === "in_progress";
    const waiting = assigned && wait !== undefined;
    const paused = assigned && this.#isPaused !== undefined && (await this.#isPaused(taskId));
    const stored = (await this.#runner.get("stall-evidence", taskId))?.body as unknown as EvidenceBody | undefined;
    const evidence = stored !== undefined && assigned && stored.generation === assignment.generation ? stored : undefined;
    // Observed activity (card H01) counts as the owner's only when it is the owner, or the one who has been reporting, and under the current generation.
    let activityAt: number | undefined;
    if (assigned) {
      const activity = (await this.#assignments.getActivity(taskId)) as View<ActivityBody> | undefined;
      if (activity !== undefined && activity.current && activity.generation === assignment.generation && (isOwner(assignment.owner, activity.observedBy) || activity.observedBy === evidence?.reportedBy)) activityAt = Date.parse(activity.observedAt);
    }
    const host = evidence === undefined ? undefined : await this.#host(evidence.reportedBy);
    const reading = evidence?.request?.promptTokens === undefined ? undefined : await this.#readingSpeed(evidence.request.route, evidence.request.hostId ?? (host === undefined ? "-" : host.hostId));
    const fields = { ...DEFAULT_CONTRACT, ...(contract ?? {}) };
    const assessment = assessStall({
      now: Date.parse(this.#runner.now()), running, waiting, paused, difficulty, thresholds: this.#thresholds[difficulty],
      attemptStart: attempt === undefined ? 0 : Date.parse(attempt.createdAt), ...(activityAt === undefined ? {} : { activityAt }),
      ...(evidence === undefined ? {} : { evidence }), budget: { ...(fields.budget.maxMinutes === undefined ? {} : { maxMinutes: fields.budget.maxMinutes }), ...(fields.budget.maxCost === undefined ? {} : { maxCost: fields.budget.maxCost }) },
      requiredEvidence: fields.requiredEvidence.length, ...(host === undefined ? {} : { host }), ...(reading === undefined ? {} : { reading }),
    });
    const route = assigned ? await this.#route(assignment.owner) : undefined;
    return { assessment, difficulty, ...(assigned ? { generation: assignment.generation } : {}), ...(route === undefined ? {} : { route }) };
  }
}
