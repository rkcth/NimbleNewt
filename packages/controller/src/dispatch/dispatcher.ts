import { createHash, randomUUID } from "node:crypto";
import type { AssignmentService } from "../domain/assignments.js";
import type { BlockerService } from "../domain/blockers.js";
import { STALE_CANCEL, type ResumeCheckService } from "../continuation/resume.js";
import type { EffectBridge } from "../domain/effects.js";
import { mergeChanges } from "../domain/changes.js";
import type { EffectService } from "../domain/effects.js";
import { DomainError, isDomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { AdmissionService } from "../admission/index.js";
import { BudgetClosedError, type BudgetService } from "../budgets/index.js";
import type { DecisionGuard } from "../decisions/index.js";
import type { EnvironmentService } from "../environments/index.js";
import type { GenerationService } from "../generation/index.js";
import type { HarnessCatalog } from "../harness/index.js";
import type { HostService } from "../hosts/index.js";
import type { PauseGuard } from "../lifecycle/index.js";
import type { McpService } from "../mcp/index.js";
import type { ContextEnforcementService } from "../context/index.js";
import type { HandoffFacts } from "../context/budget.js";
import type { AttendanceService } from "../meetings/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { ContractService } from "../planning/index.js";
import { describePolicyContext, type PolicyService } from "../policy/index.js";
import { ActionCatalog } from "../policy/catalog.js";
import type { ReviewService } from "../review/index.js";
import { selectRoute, type RoutingService } from "../routing/index.js";
import { allows } from "../security/access.js";
import { redactText } from "../security/redact.js";
import { ACTIVITY_LIMITS, clipText } from "../activity/activity.js";
import type { Principal } from "../security/principals.js";
import { DISPATCHER_PRINCIPAL, type TaskCredentialService } from "../security/task-credentials.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";
import { DISPATCHER_ACTOR, DISPATCH_KIND, DISPATCH_LIMITS, type DispatchBody, type DispatchRevisions, type Frozen, type ToolIdentity, type ToolOperationBody } from "./model.js";
import { ToolPath, type Loaded } from "./tools.js";
import type { HostProbe, RecipeSummary, ToolGateway, WorkerTurnResult, TurnUsage, WorkOrder, WorkerHandle, WorkerHost } from "./ports.js";
import { chooseHost, type HostVerdict } from "../hosts/candidates.js";

/** The record of live dispatches: the attempts that have a claim and have not finished. Ticks read it instead of scanning every dispatch ever made. */
const LIVE: AggregateRef = { kind: "dispatch-live", id: "live" };
const LIVE_MAX = 600;
/** Where the scan of assignments stopped (card H12c): the next tick, of this process or of one after a restart, goes on from there instead of from the beginning. */
const CURSOR: AggregateRef = { kind: "dispatch-cursor", id: "scan" };
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const ATTEMPT = /^att-[a-z2-7]{20}$/;

/** A freeze lifted; the agent's own ending's freeze stays unless asked for (card H12n). */
function withoutFreeze(b: DispatchBody, includeEnding: boolean): DispatchBody {
  if (b.frozen === undefined || (b.frozen.ending === true && !includeEnding)) return b;
  const { frozen: _f, ...rest } = b; void _f;
  return rest;
}

/** What the dispatcher tells the agent's ending (`work.end`, card H12n) when it is about to end an attempt for another reason: `handled` means the ending completed the attempt itself; a `summary` replaces the end's own. */
export type EndHook = (attemptId: string, how: { readonly outcome: "succeeded" | "failed" | "abandoned"; readonly summary: string; readonly stopped?: { readonly by: "owner" | "emergency"; readonly reason: string } }) => Promise<{ readonly handled?: true; readonly summary?: string; readonly outcome?: "succeeded" | "failed" | "abandoned"; readonly partial?: true } | undefined>;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** What a route resolver says: the route and harness for a task, or why there is none. The resolver is the owner's configuration read at the moment of dispatch (R03). */
export type RouteChoice =
  | {
    readonly route: string; readonly harness?: string; readonly role: string;
    readonly request: { readonly contextTokens: number; readonly needs: readonly string[]; readonly data: "local-only" | "cloud-allowed"; readonly paidAuthorized: boolean };
    readonly routing?: number; readonly profiles?: number;
  }
  | { readonly none: true; readonly reasons: readonly string[] };
export type RouteResolver = (command: { readonly commandId: string; readonly taskId: string }) => Promise<RouteChoice>;

export interface DispatcherLoop { readonly name: string; run(by: Principal): Promise<unknown> }

export interface DispatcherDeps {
  /** The dispatcher's own service principal (`service:dispatcher`, authenticated). It is the only principal that issues task credentials for admitted attempts. */
  readonly principal: Principal;
  readonly assignments: Pick<AssignmentService, "getAssignment" | "getAttempt" | "finishAttempt" | "admitAttempt" | "guardFor" | "epoch">;
  readonly projects: Pick<ProjectService, "getTask">;
  readonly credentials: Pick<TaskCredentialService, "issueForAttempt" | "principalOf" | "endForAttempt">;
  readonly admission: Pick<AdmissionService, "request" | "release" | "where" | "reprioritize" | "snapshot">;
  /** Who receives the report of a task's attempt (card H10b): the agent of the task that spawned it. Used for the owner's optional fan-in cap; `undefined` means no supervisor. */
  readonly reportsTo?: (taskId: string) => Promise<string | undefined>;
  readonly hosts: Pick<HostService, "status">;
  /** The worker hosts, local or remote, in the order they are tried. They all implement the same contract. */
  readonly workers: readonly WorkerHost[];
  readonly contracts: Pick<ContractService, "priorityOf" | "recoveryOf">;
  readonly harnesses: HarnessCatalog;
  readonly policy: Pick<PolicyService, "evaluate"> & Partial<Pick<PolicyService, "contextFor">>;
  /**
   * Whether a push or a merge changes a protected branch of the project, decided here and not by the worker (card A07f). Without it the worker's own `branchProtected` flag is used as before, so a controller always passes it.
   */
  readonly protectedBranch?: (projectId: string, branch: string | undefined) => Promise<boolean>;
  readonly effects: Pick<EffectService, "intend" | "run" | "get">;
  readonly blockers: Pick<BlockerService, "openBlocker">;
  readonly route: RouteResolver;
  /** The routing table, to judge the chosen route again at each call. Without it the route is not judged again. */
  readonly routing?: Pick<RoutingService, "get">;
  readonly pauses: PauseGuard;
  readonly decisions?: DecisionGuard;
  /** Pins the checkout a task is dispatched against and refuses work whose repository moved or was unbound (card P01). */
  readonly checkouts?: { dispatchCheckout(command: { commandId: string; taskId: string; actor: string; pin: boolean }): Promise<{ kind: "none" } | { kind: "ok" } | { kind: "unbound" | "changed"; reason: string }> };
  /**
   * The prerequisite tasks of `taskId` that are not complete, each as a short description (card L04c). Work whose prerequisites are not done is not started: the attempt waits, with the reason in the tick's report, and nothing fails.
   * Without it prerequisites are not looked at here.
   */
  readonly prerequisites?: (taskId: string) => Promise<readonly string[] | { readonly open: readonly string[]; /** Prerequisites that will not complete by themselves: cancelled or gone. The dependent waits and the owner gets one blocker. */ readonly dead: readonly string[] }>;
  /**
   * The checked resume (card L04c). An attempt that brings earlier work back (it has a checkpoint to continue from: after a restart or a move) starts only once its resume check is done: the dispatcher starts the check,
   * commits it when it is ready and waits while it is open or blocked (a blocked check has opened its own blocker). Without it such an attempt starts as before.
   */
  readonly resumes?: Pick<ResumeCheckService, "start" | "commit" | "advance" | "retry" | "cancel" | "forTask" | "checkIdFor" | "retryable" | "exhausted" | "cancelledAsStale" | "get"> & Partial<Pick<ResumeCheckService, "hasContinuation">>;
  /** `GenerationService.guardFor` is handed to every effect that is started (it adds the generation hold to the pause and decision guards). */
  readonly generation?: Pick<GenerationService, "guardFor">;
  readonly reviews?: Pick<ReviewService, "request" | "admit" | "get">;
  readonly budgets?: Pick<BudgetService, "accounting" | "charge"> & Partial<Pick<BudgetService, "reserve" | "settle" | "markUncertain" | "release">>;
  readonly mcp?: Pick<McpService, "authorizeCall" | "recordOutcome">;
  /** Whether the approved manifest of this exact tool version says a call may be run again after a restart (T06: the catalogue answers, as the agent; the worker never says). Without it no catalogue tool is replay-safe. */
  readonly replaySafe?: (tool: ToolIdentity, agent: Principal, attemptId: string, callId: string) => Promise<boolean>;
  readonly environments?: Pick<EnvironmentService, "pin">;
  readonly meetings?: Pick<AttendanceService, "admission" | "revalidation">;
  /**
   * Puts a step in the task's activity record (card C09d): the model route and harness an attempt started under and every tool call's outcome, each with a reference to the record that holds the detail.
   * Best effort: a step that cannot be recorded never stops the attempt or changes a call's result.
   */
  readonly activity?: (step: { commandId: string; taskId: string; kind: "model-selected" | "harness-selected" | "tool-call"; summary: string; refs: readonly { kind: string; id: string }[] }) => Promise<void>;
  readonly notifications?: Pick<NotificationService, "emitFromController">;
  /**
   * Context enforcement (card C07b) at the end of an attempt: an attempt that failed for want of context is counted (repeated overflow opens a visible blocker), and an attempt that ended without a hand-off gets
   * one written by the controller from `handoffFacts` (default: the task's title, how the attempt ended and the last checkpoint position).
   */
  readonly context?: Pick<ContextEnforcementService, "ensureHandoff" | "reportOverflow" | "resetOverflow"> & Partial<Pick<ContextEnforcementService, "limitTool">>;
  /** The context window of a route, in tokens, or `undefined` when the route does not say (card C07d): an MCP result is cut to that window's share of tool output and the rest is kept to be read in pages. */
  readonly toolWindow?: (route: string) => number | undefined;
  readonly handoffFacts?: (info: { taskId: string; attemptId: string; endedBecause: string }) => Promise<Omit<HandoffFacts, "endedBecause">>;
  /** Called when a checkpoint is taken for an attempt (the composer connects C04's `ContinuationService.capture` here). */
  readonly checkpoints?: (info: { attemptId: string; taskId: string; agentId: string; reason: string; checkpoint: JsonObject }) => Promise<void>;
  /**
   * Where the agent's native store is, and whether another attempt holds it (card H02: the store has one exclusive owner host). With it the dispatcher starts the agent's attempts on that host only, and an
   * attempt whose store is busy waits for the attempt that holds it; without it only the placement itself refuses.
   */
  readonly storeOwner?: (agentId: string, attemptId: string) => Promise<{ readonly hostId: string; readonly busy: boolean } | undefined>;
  /** The loops the dispatcher's tick runs after its own work: the services whose callers were said to be "the controller's loop". */
  readonly loops?: readonly DispatcherLoop[];
}

/** The dispatcher's own limits; a figure that is absent is not limited. */
const DEFAULT_COMPUTE_RESERVE_MS = 4 * 3_600_000;

export interface DispatcherLimitFigures { readonly attemptMs?: number; readonly maxAttempts?: number }

export interface AttemptDispatcherOptions extends RunnerOptions {
  /** Names this dispatcher in the lease. */
  readonly holder?: string;
  /** Told of a failure in bookkeeping that must not stop an attempt from ending (the context hand-off). */
  readonly onError?: (error: unknown) => void;
  /**
   * What an attempt holds back from its task's allowance before it starts (card R05b), as the most it may spend: compute is the contract's `maxMinutes` (or `attemptMs`) in milliseconds, money is this figure
   * (millionths of the tree's currency; default none, so only compute is reserved). Without `budgets.reserve` nothing is reserved. An attempt that cannot reserve waits and is tried again; it is not started.
   */
  readonly reserveCostMicros?: number;
  /** A worker that does not beat within this time is taken as lost. Default one minute. */
  readonly leaseMs?: number;
  /** How long an attempt may run (shortened by the contract's `maxMinutes`). Default: no limit. The owner's dispatcher-limits setting (`limits`) wins over this start-up figure. */
  readonly attemptMs?: number;
  /** Attempts the dispatcher itself admits after a lost one (contract `maxAttempts` wins). Default: no limit. The owner's dispatcher-limits setting (`limits`) wins over this start-up figure. */
  readonly maxAttempts?: number;
  /** The owner's dispatcher-limits setting (card O-limits), read on every claim and every re-admission so a change counts from the next one. It throws when unreadable and the step then fails (nothing starts) rather than running unbounded by mistake. */
  readonly limits?: () => Promise<DispatcherLimitFigures>;
  /** The longest an attempt may run for this task according to configuration (`time.maxMinutes`, minutes); `undefined` when none is set. Read on every claim. */
  readonly configuredMinutes?: (taskId: string) => Promise<number | undefined>;
  /** The compute an attempt holds back when nothing limits its time (no attempt time, no contract `maxMinutes`), in milliseconds. Default four hours. A hold is only as much as is still free. */
  readonly computeReserveMs?: number;
  /** After this many ticks in a row in which an attempt pinned to a host could not start because that host was unavailable, a blocker names the owner (who can move it). Default 5. */
  readonly pinnedStaleTicks?: number;
  /** How long the end hook (the agent's ending) may take before the attempt ends with the dispatcher's own outcome and the hook's delay is reported through `onError`. Default 30 seconds. */
  readonly endHookMs?: number;
  /** How long the ended hook may run before it is cut off (default: `endHookMs`). */
  readonly endedHookMs?: number;
  /** Assignments looked at per tick. Default 100. */
  readonly scanPage?: number;
  /** How long the dispatcher expects an attempt to run when the contract says nothing, for the meeting check (M04). Default 30 minutes. */
  readonly expectedMinutes?: number;
  /**
   * PROVISIONAL (card M04e; owner question open: what makes a long-running operation "safe"). Says whether the work of a task is a safe long-running operation that carries on while its agent attends a meeting.
   * Absent, or throwing, means "not safe" (fails closed: the work is deferred like any long work that cannot yield). No definition is composed yet.
   */
  readonly safeLongRunning?: (taskId: string) => Promise<boolean>;
  readonly catalog?: ActionCatalog;
  /** The bridge for each effect kind, so an effect that was started before a restart is reconciled without the worker. */
  readonly bridges?: Readonly<Record<string, EffectBridge>>;
}

/** How many times a cancelled resume check of an attempt is started again before the owner is told. */
const RESUME_RESTARTS = 3;
/** Room for checks the dispatcher cancelled as stale (route changes), which are not counted. */
const MAX_STALE_RESTARTS = 60;

export type DispatchCheck = "generation" | "checkout" | "pause" | "decision" | "revalidation" | "meeting" | "harness" | "route" | "budget" | "grant" | "host" | "place" | "expired" | "dependency" | "resume";

export interface TickReport {
  readonly at: string;
  readonly started: readonly string[];
  /** Attempts whose request waits for a place. */
  readonly waiting: readonly string[];
  /** Attempts that wait only because a capacity limit is full (not a failure), with why ("waiting for capacity: ..."); they are also in `waiting`. */
  readonly capacityWaits: readonly { readonly attemptId: string; readonly reason: string }[];
  readonly skipped: readonly { readonly taskId: string; readonly attemptId: string; readonly check: DispatchCheck; readonly reason: string }[];
  /** Attempts that cannot be started for a reason waiting does not fix: a blocker names who can change it. */
  readonly blocked: readonly { readonly taskId: string; readonly attemptId: string; readonly check: DispatchCheck; readonly blockerId: string }[];
  readonly lost: readonly string[];
  readonly readmitted: readonly string[];
  readonly reprioritized: number;
  readonly approvals: readonly { readonly attemptId: string; readonly operationId: string; readonly verdict: "approved" | "denied" | "expired" }[];
  readonly loops: readonly { readonly name: string; readonly ok: boolean; readonly error?: string }[];
  /** New attempts whose checks or start threw (an agent record the revalidation cannot read, a store error). The attempt is skipped for this tick and the scan goes on, so one bad attempt cannot stop the rest; the driver records each. */
  readonly failures: readonly { readonly taskId: string; readonly attemptId: string; readonly error: string }[];
  readonly scanned: number;
  /** True when the scan of assignments reached its end in this tick (so it saw every assignment since it began). */
  readonly complete: boolean;
}

export type RecipeChange =
  | { readonly kind: "grants" }
  | { readonly kind: "narrow"; readonly recipe: RecipeSummary }
  | { readonly kind: "widen"; readonly recipe: RecipeSummary; readonly tell: string };

interface Live { readonly handle: WorkerHandle; readonly host: WorkerHost; readonly turn: Promise<void> }

/**
 * The attempt dispatcher (card H12). It takes the attempts the inbox admitted, asks the checks in a fixed order, asks admission (H03) for a place on a fresh host, issues the task credential as the
 * dispatcher's own service principal (the owner is not asked), starts the worker through the dispatch contract and supervises it with a lease the worker's heartbeats extend. Every tool call the
 * worker makes goes through a `ToolGateway` bound to the attempt: the gateway decides, records the call as a durable operation, runs effects through the S05 ledger, and parks a call that needs an
 * approval without holding up anything else.
 *
 * Nothing sleeps and nothing runs by itself: `tick()` is the one step the controller's loop calls, from the injected clock. The order of the checks before a start is: the generation is current
 * (a stale one never dispatches), the pause gates (L01), the owner's decisions and gates (C08), the meeting decisions that need revalidation and a coming meeting (M04), the route and harness
 * with the recovery gate (R03, F08), the budget, the grants the task needs, the host, and last the place (H03). A check that fails for a lasting reason opens a blocker that names who can change it;
 * one that fails for a passing reason only skips the attempt for this tick.
 */
export class DispatcherService {
  readonly #runner: CommandRunner;
  readonly #deps: DispatcherDeps;
  readonly #options: Required<Pick<AttemptDispatcherOptions, "leaseMs" | "scanPage" | "expectedMinutes">> & AttemptDispatcherOptions;
  readonly #holder: string;
  readonly #live = new Map<string, Live>();
  readonly #path: ToolPath;
  /** Names this dispatcher in the commands of its updates: two dispatchers that read one revision must not share a command (the second would be answered with the first's result). */
  readonly #instance = randomUUID().slice(0, 8);
  /** Usage reports made per attempt by this dispatcher, so two turns with identical figures are two records. */
  readonly #usageSeq = new Map<string, number>();
  readonly #ending = new Set<Promise<unknown>>();
  #endHook: EndHook | undefined;
  #endedHook: ((attemptId: string, how: { readonly outcome: "succeeded" | "failed" | "abandoned"; readonly workerStopped: boolean; readonly signal: AbortSignal }) => Promise<void>) | undefined;
  /** Ended hooks still running. Apart from `#ending` on purpose: `idle()` and the blocker for a failure never wait for a hook. */
  readonly #endedRunning = new Set<Promise<unknown>>();
  /** The hook calls themselves, which go on after their timeout (the signal they were given is aborted then; they must stop at their next check). `shutdown` waits for them (bounded: a hook that never answers does not hold it). */
  readonly #endedCalls = new Set<Promise<unknown>>();
  /** The cut-off signals of the hooks now running: `shutdown` aborts them all at once so a hook gives up its claims (an order's lease) before the store closes. */
  readonly #endedAborts = new Set<AbortController>();
  readonly #endingBy = new Map<string, Promise<{ readmitted?: string }>>();
  /** Consecutive ticks an attempt pinned to a host has waited for it (in memory: a restart starts the count again). */
  readonly #pinnedWaits = new Map<string, number>();
  /** Consecutive ticks an attempt was refused by every host that could run it (card H07e). */
  readonly #refusedWaits = new Map<string, number>();
  #ticking: Promise<TickReport> | undefined;
  #scanStartedAt = 0;
  #cursorSavedAt: number | undefined;
  #cursor: string | undefined;
  #cursorKnown = false;

  private constructor(runner: CommandRunner, deps: DispatcherDeps, options: AttemptDispatcherOptions) {
    this.#runner = runner;
    this.#deps = deps;
    this.#options = { leaseMs: DISPATCH_LIMITS.leaseMs, scanPage: DISPATCH_LIMITS.scanPage, expectedMinutes: 30, ...options };
    this.#holder = options.holder ?? "dispatcher";
    this.#path = new ToolPath(runner, deps, {
      catalog: options.catalog ?? ActionCatalog.default,
      ...(options.bridges === undefined ? {} : { bridges: options.bridges }),
      update: (attemptId, mutate, extra) => this.#update(attemptId, mutate, extra),
      load: (attemptId) => this.#load(attemptId),
      handleOf: (attemptId) => this.#live.get(attemptId)?.handle,
    });
  }

  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: DispatcherDeps, options: AttemptDispatcherOptions = {}): DispatcherService {
    if (deps.principal.kind !== "service" || deps.principal.taskScope !== undefined) throw new DomainError("invalid_command", "principal: the dispatcher acts as its service principal", { field: "principal" });
    if (deps.assignments.epoch !== epoch) throw new DomainError("invalid_command", "epoch: must be the epoch the assignment service writes under", { field: "epoch" });
    return new DispatcherService(new CommandRunner(storage, epoch, options), deps, options);
  }

  // ---- the tick ----------------------------------------------------------------------------------------------------------------

  /**
   * One step of the dispatcher, from the injected clock. It: ends the attempts whose lease or time ran out; gives waiting requests the priority their task has now; starts what has got its place;
   * claims the next page of assignments' active attempts; looks at the calls waiting for an approval; and runs the loops. It starts workers and returns: `idle()` waits for the turns it started.
   */
  async tick(): Promise<TickReport> {
    // A second call while a tick runs is the same tick: it waits for it and gets its report.
    if (this.#ticking !== undefined) return this.#ticking;
    const running = this.#tick();
    this.#ticking = running;
    try { return await running; } finally { this.#ticking = undefined; }
  }

  async #tick(): Promise<TickReport> {
    const at = this.#runner.now();
    const started: string[] = [], waiting: string[] = [], capacityWaits: { attemptId: string; reason: string }[] = [], lost: string[] = [], readmitted: string[] = [];
    const skipped: { taskId: string; attemptId: string; check: DispatchCheck; reason: string }[] = [];
    const blocked: { taskId: string; attemptId: string; check: DispatchCheck; blockerId: string }[] = [];
    const approvals: { attemptId: string; operationId: string; verdict: "approved" | "denied" | "expired" }[] = [];
    const failures: { taskId: string; attemptId: string; error: string }[] = [];
    const live = await this.#liveIds();
    // 1. Leases and time. A worker that stopped beating, or an attempt past its expiry, is over; its calls are settled through the ledger first.
    for (const id of live) {
      // One attempt that cannot be ended or checked (a ledger that is down, a record that cannot be read) is told in the report and tried again next tick; it never stops the others from being looked at.
      let taskId = "";
      try {
        const d = await this.#load(id);
        if (d === undefined || (d.body.state !== "running" && d.body.state !== "parked")) continue;
        taskId = d.body.taskId;
        // An attempt that started without a time limit is held to the owner's attempt time from the moment it started running (`startedAt`; the claim time for a record that has none), once that is switched on (provisional: the owner's figure only, not the configuration's or the contract's).
        const cap = d.body.expiresAt === undefined && d.body.state === "running" ? await this.#capNow() : undefined;
        const expired = d.body.expiresAt !== undefined ? d.body.expiresAt <= at : cap !== undefined && Date.parse(d.body.startedAt ?? d.body.claimedAt) + cap <= Date.parse(at);
        if (expired || (d.body.state === "running" && d.body.lease !== undefined && d.body.lease.until <= at)) {
          const result = await this.#end(id, "abandoned", expired ? "the attempt ran past its expiry" : "the worker stopped beating; its lease ran out", { readmit: !expired, lost: !expired });
          lost.push(id);
          if (result.readmitted !== undefined) readmitted.push(result.readmitted);
        }
      } catch (error) {
        if (isDomainError(error, "stale_epoch")) throw error;
        failures.push({ taskId, attemptId: id, error: errorText(error) });
      }
    }
    // 2. The priority the contract has now, for every request that still waits (no stored contract version is rewritten).
    const reprioritized = await this.#reprioritize();
    // 3. Waiting claims: get a request, or start when the place has come.
    for (const id of await this.#liveIds()) {
      const d = await this.#load(id);
      if (d === undefined || d.body.state !== "waiting") continue;
      // One attempt that cannot be advanced (a pin that fails, a ledger that is down) is told in the report and tried again next tick; it never stops the others from starting.
      let outcome: AdvanceOutcome;
      try { outcome = await this.#advance(d); } catch (error) { failures.push({ taskId: d.body.taskId, attemptId: id, error: errorText(error) }); continue; }
      if (outcome.kind === "started") started.push(id);
      else if (outcome.kind === "waiting") { waiting.push(id); if (outcome.reason !== undefined) capacityWaits.push({ attemptId: id, reason: outcome.reason }); }
      else if (outcome.kind === "skipped") skipped.push({ taskId: d.body.taskId, attemptId: id, check: outcome.check, reason: outcome.reason });
      else if (outcome.kind === "blocked") blocked.push({ taskId: d.body.taskId, attemptId: id, check: outcome.check, blockerId: outcome.blockerId });
    }
    // 4. New attempts: a page of assignments from where the last tick stopped.
    const scan = await this.#scan();
    for (const found of scan.found) {
      if (found.outcome.kind === "failed") { failures.push({ taskId: found.taskId, attemptId: found.attemptId, error: found.outcome.error }); continue; }
      if (found.outcome.kind === "claimed") {
        const d = await this.#load(found.attemptId);
        if (d === undefined) continue;
        const next = await this.#advance(d).catch((error: unknown): { kind: "failed"; error: string } => { if (isDomainError(error, "stale_epoch")) throw error; return { kind: "failed", error: errorText(error) }; });
        if (next.kind === "failed") { failures.push({ taskId: found.taskId, attemptId: found.attemptId, error: next.error }); continue; }
        if (next.kind === "started") started.push(found.attemptId);
        else if (next.kind === "waiting") { waiting.push(found.attemptId); if (next.reason !== undefined) capacityWaits.push({ attemptId: found.attemptId, reason: next.reason }); }
        else if (next.kind === "skipped") skipped.push({ taskId: found.taskId, attemptId: found.attemptId, check: next.check, reason: next.reason });
        else if (next.kind === "blocked") blocked.push({ taskId: found.taskId, attemptId: found.attemptId, check: next.check, blockerId: next.blockerId });
      } else if (found.outcome.kind === "skipped") skipped.push({ taskId: found.taskId, attemptId: found.attemptId, check: found.outcome.check, reason: found.outcome.reason });
      else if (found.outcome.kind === "blocked") blocked.push({ taskId: found.taskId, attemptId: found.attemptId, check: found.outcome.check, blockerId: found.outcome.blockerId });
    }
    // 5. Calls waiting for an approval: say how each was decided to the worker, and close those that were denied or ran out.
    for (const id of await this.#liveIds()) {
      const before = await this.#load(id);
      const parked = before?.body.state === "parked";
      const verdicts = await this.#path.sweepParked(id, { includeTold: parked });
      approvals.push(...verdicts);
      // An attempt that gave its place back while its calls waited goes on once for each decision that comes: it asks for a place again and resumes from its checkpoint. A decision already resumed for does not resume it again.
      if (parked && before !== undefined) {
        const fresh = verdicts.filter((v) => !(before.body.resumedFor ?? []).includes(v.operationId));
        if (fresh.length > 0) {
          const note = fresh.map((v) => `call ${v.operationId} was ${v.verdict}`).join("; ");
          await this.#update(id, (b) => ({ ...b, state: "waiting", resumeNote: note.slice(0, 500), resumedFor: [...new Set([...(b.resumedFor ?? []), ...fresh.map((v) => v.operationId)])].slice(-DISPATCH_LIMITS.parked * 4) }));
        }
      }
    }
    // 6. The loops of the services that said "the controller's loop must call it". A loop that fails is reported and does not stop the others.
    const loops: { name: string; ok: boolean; error?: string }[] = [];
    for (const loop of this.#deps.loops ?? []) {
      try { await loop.run(this.#deps.principal); loops.push({ name: loop.name, ok: true }); } catch (error) {
        if (isDomainError(error, "stale_epoch")) throw error;
        loops.push({ name: loop.name, ok: false, error: error instanceof Error ? error.message.slice(0, 200) : "failed" });
      }
    }
    return { at, started, waiting, capacityWaits, skipped, blocked, lost, readmitted, reprioritized, approvals, loops, failures, scanned: scan.scanned, complete: scan.complete };
  }

  /**
   * The controller is shutting down (card H12c). Each attempt that is running here has its calls settled, a checkpoint taken, its worker ended and its place given back, and goes back to `waiting`
   * with the checkpoint to resume from: it is the same attempt, so a restart does not count against the attempts a task is allowed and no blocker is opened. Attempts that are waiting or parked
   * are not touched (a parked attempt's pending approvals stay pending); the next controller finds them in the live list. One attempt that cannot be closed has its error returned; its lease runs
   * out for the next controller.
   */
  async shutdown(): Promise<{ closed: number; errors: string[] }> {
    const errors: string[] = [];
    let closed = 0;
    const by = this.#deps.principal;
    for (const id of await this.#liveIds()) {
      const d = await this.#load(id);
      if (d === undefined || d.body.state !== "running") continue;
      try {
        await this.settle(by, id, { cancel: true }).catch(() => undefined);
        const checkpoint = await this.#checkpoint(id, "the controller shut down").catch(() => undefined);
        const current = (await this.#load(id))!;
        await this.#live.get(id)?.handle.stop().catch(() => undefined);
        this.#path.forget(id, current.body.parked);
        if (current.body.requestId !== undefined) await this.#deps.admission.release({ commandId: `dpa-down:${id}:${current.body.requests ?? 0}`, actor: DISPATCHER_ACTOR, requestId: current.body.requestId, reason: "the controller shut down" }).catch((error: unknown) => { if (!isDomainError(error, "not_found")) throw error; });
        await this.#update(id, (x) => {
          if (x.state !== "running") return x;
          const { requestId: _r, lease: _l, ...rest } = x; void _r; void _l;
          return { ...rest, state: "waiting", resumeNote: "the controller restarted; carry on from the checkpoint", ...(checkpoint === undefined ? {} : { resumeFrom: checkpoint }) };
        });
        closed++;
      } catch (error) {
        errors.push(`${id}: ${errorText(error)}`);
      }
    }
    // Ended hooks still running are told to stop now (they give up what they hold) and get their time (each is cut off by its own timeout too) before the process goes on to close the store.
    for (const c of this.#endedAborts) c.abort();
    await Promise.race([Promise.allSettled([...this.#endedCalls]), new Promise<void>((resolve) => { setTimeout(resolve, (this.#options.endedHookMs ?? this.#options.endHookMs ?? 30_000) + 1000).unref(); })]);
    await this.dropWorkers();
    return { closed, errors };
  }

  /**
   * Whether the worker of a FINISHED attempt is confirmed stopped now. One recorded as stopped is. Otherwise the host that held it is asked to let go again (a release is repeatable); an answer without error is the confirmation and is recorded.
   * An attempt that is not finished, or has no host that can release, is not confirmed. Used by the scratch cleanup's sweep.
   */
  async confirmStopped(_by: Principal, attemptId: string, signal?: AbortSignal): Promise<boolean> {
    const d = await this.#load(attemptId);
    if (d === undefined || d.body.state !== "finished") return false;
    if (d.body.workerStopped === true) return true;
    const host = this.#deps.workers.find((w) => w.hostId === d.body.hostId);
    if (host?.release === undefined) return false;
    const ok = await host.release(attemptId, "confirming the worker of a finished attempt is stopped", signal).then(() => true, () => false);
    if (ok) await this.#update(attemptId, (x) => ({ ...x, workerStopped: true })).catch(() => undefined);
    return ok;
  }

  /** Ends the workers this process holds, with no write to the store (a fenced controller does not own the attempts any more; the new one finds them in the live list and their leases). */
  async dropWorkers(): Promise<void> {
    await Promise.allSettled([...this.#live.values()].map((l) => l.handle.stop()));
  }

  /** Resolves when every turn this dispatcher started has ended. */
  async idle(): Promise<void> {
    while (this.#live.size > 0 || this.#ending.size > 0) await Promise.allSettled([...[...this.#live.values()].map((l) => l.turn), ...this.#ending]);
  }

  // ---- the gateway and the worker's heartbeat -------------------------------------------------------------------------------------

  /** The gateway one attempt's worker calls. Nothing exposes this to an agent or the state API: the worker host holds it. */
  gateway(attemptId: string): ToolGateway {
    if (typeof attemptId !== "string" || !ATTEMPT.test(attemptId)) invalid("attemptId", "is not an attempt ID");
    return {
      attemptId,
      call: async (request, executor) => { const result = await this.#path.call(attemptId, request, executor); await this.#stepOf(attemptId, `call:${createHash("sha256").update(request.callId).digest("hex").slice(0, 24)}:${result.state}`, "tool-call", `Tool ${request.tool.name} ${result.state}${"reason" in result ? `: ${result.reason}` : ""}.`, [{ kind: "tool-operation", id: result.operationId }]); return result; },
      begin: async (request) => {
        const started = await this.#path.begin(attemptId, request);
        // A call decided at once (refused, waiting for approval, already settled) is a step now; one that will run is recorded when it is reported.
        if (!started.run) await this.#stepOf(attemptId, `op:${createHash("sha256").update(started.operationId).digest("hex").slice(0, 24)}:${started.result.state}`, "tool-call", `Tool ${request.tool.name} ${started.result.state}${"reason" in started.result ? `: ${started.result.reason}` : ""}.`, [{ kind: "tool-operation", id: started.operationId }]);
        return started;
      },
      report: async (operationId, outcome) => {
        const result = await this.#path.report(attemptId, operationId, outcome);
        await this.#stepOf(attemptId, `op:${createHash("sha256").update(operationId).digest("hex").slice(0, 24)}:${result.state}`, "tool-call", `Tool call ${result.state}${"reason" in result ? `: ${result.reason}` : ""}.`, [{ kind: "tool-operation", id: operationId }]);
        return result;
      },
      usage: (usage, requestKey) => this.#usage(attemptId, usage, requestKey),
      heartbeat: () => this.heartbeat(attemptId),
      acknowledgeDecisions: () => this.acknowledgeDecisions(attemptId),
    };
  }

  /** Records a step of an attempt in its task's activity (best effort, see `DispatcherDeps.activity`). */
  async #stepOf(attemptId: string, key: string, kind: "model-selected" | "harness-selected" | "tool-call", summary: string, refs: readonly { kind: string; id: string }[]): Promise<void> {
    if (this.#deps.activity === undefined) return;
    try {
      const taskId = (await this.#load(attemptId))?.body.taskId;
      if (taskId !== undefined) await this.#deps.activity({ commandId: `dpa-act:${attemptId}:${key}`.slice(0, 120), taskId, kind, summary: clipText(redactText(summary), ACTIVITY_LIMITS.summary), refs });
    } catch { /* the record of a step never changes what happened */ }
  }

  /** The worker is alive: extends its lease. Refused (`fenced`) once the attempt is no longer the task's current one, so a stale worker learns it has lost. */
  async heartbeat(attemptId: string): Promise<{ until: string }> {
    const d = await this.#running(attemptId);
    await this.#assertCurrent(d.body);
    const now = this.#runner.now();
    const until = new Date(Date.parse(now) + this.#options.leaseMs).toISOString();
    await this.#update(attemptId, (b) => ({ ...b, lease: { holder: this.#holder, until }, heartbeats: b.heartbeats + 1, lastHeartbeatAt: now, lastActivityAt: b.parked.length === 0 ? now : (b.lastActivityAt ?? b.startedAt ?? b.claimedAt) }));
    return { until };
  }

  /** The owner's decisions changed and the worker has put the new context in front of the agent: calls are allowed again under the new version. */
  async acknowledgeDecisions(attemptId: string): Promise<void> {
    const d = await this.#running(attemptId);
    const version = await this.#decisionVersion(d.body.projectId);
    await this.#update(attemptId, (b) => ({ ...b, revisions: { ...b.revisions, decisions: version } }));
  }

  // ---- control: freeze, settle, restart the sandbox, stop ------------------------------------------------------------------------

  /** New calls are refused until `release`. Calls already running are not touched (`settle` waits for them). */
  async freeze(by: Principal, attemptId: string, reason: string, options: { readonly ending?: boolean } = {}): Promise<void> {
    const d = await this.#controlled(by, attemptId);
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 300) invalid("reason", "must be 1 to 300 characters");
    const frozen: Frozen = { reason, at: this.#runner.now(), ...(options.ending === true ? { ending: true as const } : {}) };
    await this.#update(d.body.attemptId, (b) => ({ ...b, frozen: b.frozen ?? frozen }));
  }

  /** Lifts a freeze. */
  async release(by: Principal, attemptId: string, options: { readonly includeEnding?: boolean } = {}): Promise<void> {
    const d = await this.#controlled(by, attemptId);
    // The stop marker goes with the ending's freeze: a stop that failed part-way and a scope that was resumed leave a live attempt that can end itself.
    await this.#update(d.body.attemptId, (b) => { const x = withoutFreeze(b, options.includeEnding === true); if (options.includeEnding !== true || x.stopped === undefined) return x; const { stopped: _s, ...rest } = x; void _s; return rest; });
  }

  /**
   * Lets the calls in flight settle: waits for each (a local call can be told to stop with `cancel`, and then ends `cancelled`; a call on the ledger is never cut: it settles as `confirmed`, `failed` or
   * `uncertain` and the ledger says which). A call that no running executor owns any more (after a restart) is settled from the ledger. When it returns nothing is in flight.
   */
  async settle(by: Principal, attemptId: string, options: { cancel?: boolean; strictMs?: number } = {}): Promise<{ settled: number }> {
    const d = await this.#controlled(by, attemptId);
    return { settled: await this.#path.settle(d.body.attemptId, options.cancel === true, options.strictMs) };
  }

  /**
   * Makes the agent quiet before someone integrates its changes, refreshes its checkout or quarantines its work: new calls are refused, calls in flight settle, and a checkpoint is taken. Call
   * `release` when the other step is done. The checkpoint is handed to the checkpoint hook (C04) and returned.
   */
  async quiesce(by: Principal, attemptId: string, reason: string, options: { strictMs?: number } = {}): Promise<{ checkpoint?: JsonObject }> {
    await this.freeze(by, attemptId, reason);
    await this.settle(by, attemptId, { cancel: true, ...(options.strictMs === undefined ? {} : { strictMs: options.strictMs }) });
    const checkpoint = await this.#checkpoint(attemptId, reason);
    return checkpoint === undefined ? {} : { checkpoint };
  }

  /**
   * A change of the agent's recipe on a running attempt (decision G01, 2026-10-21). A change of the controller's own grants needs nothing: the next call is judged on the grants as they are then and
   * nothing restarts. A narrowing of the sandbox freezes new calls, lets the ones in flight settle, takes a checkpoint and starts the sandbox again with the narrower recipe before the agent's next
   * action; a widening restarts the sandbox from a checkpoint with the wider recipe and tells the agent. The conversation context survives both (the checkpoint is restored). A failure leaves the
   * attempt frozen, never running on the old recipe by mistake.
   */
  async changeRecipe(by: Principal, attemptId: string, change: RecipeChange): Promise<{ restarted: boolean; recipeRevision?: string }> {
    const d = await this.#controlled(by, attemptId);
    if (change.kind === "grants") return { restarted: false };
    const live = this.#live.get(attemptId) ?? invalid("attemptId", "has no running worker on this dispatcher");
    if (change.recipe === null || typeof change.recipe !== "object" || typeof change.recipe.revision !== "string" || change.recipe.revision.length < 1) invalid("recipe", "must name its revision");
    await this.freeze(by, attemptId, change.kind === "narrow" ? "narrowing the sandbox" : "widening the sandbox");
    await this.settle(by, attemptId, { cancel: true });
    const checkpoint = await this.#checkpoint(attemptId, `recipe ${change.kind}`);
    await live.handle.restart(change.recipe, checkpoint ?? {});
    if (change.kind === "widen") await live.handle.tell?.(change.tell);
    await this.#update(d.body.attemptId, (b) => ({ ...withoutFreeze(b, false), recipeRevision: change.recipe.revision }));
    return { restarted: true, recipeRevision: change.recipe.revision };
  }

  /**
   * Stops an attempt. An ordinary stop freezes, lets the calls settle, checkpoints and then ends the worker; an emergency stop (`emergency: true`) ends the worker at once, with no settle and no
   * checkpoint, and the calls in flight are recorded from the ledger as they stand (cancelled, or uncertain when an effect had started). The attempt ends `abandoned` and the task is left as it is.
   */
  async stop(by: Principal, attemptId: string, options: { emergency?: boolean; reason: string }): Promise<void> {
    const d = await this.#controlled(by, attemptId);
    if (typeof options.reason !== "string" || options.reason.length < 1 || options.reason.length > 300) invalid("reason", "must be 1 to 300 characters");
    // Recorded just before the end: the agent's ending reads it, so an owner's stop is told from an attempt that merely ended (card H12n).
    const stopped = { by: options.emergency === true ? "emergency" as const : "owner" as const, reason: options.reason };
    if (options.emergency !== true) {
      await this.freeze(by, attemptId, options.reason);
      await this.settle(by, attemptId, { cancel: true });
      await this.#checkpoint(attemptId, options.reason);
    }
    // Written only once nothing before the end can fail: a stop that failed part-way and a scope that was resumed leave the attempt able to end itself.
    // A stop that comes while another end of the attempt is in progress joins that end and writes nothing: the first stop already recorded the marker, and a write that lands once the end
    // is over could reach storage after it was closed. A marker write that fails because the attempt ended meanwhile does not reject the stop either.
    if (!this.#endingBy.has(d.body.attemptId)) {
      try { await this.#update(d.body.attemptId, (b) => (b.state === "finished" ? b : { ...b, stopped: b.stopped ?? stopped })); }
      catch (error) {
        if (!this.#endingBy.has(d.body.attemptId) && (await this.#load(d.body.attemptId).catch(() => undefined))?.body.state !== "finished") throw error;
      }
    }
    await this.#end(d.body.attemptId, "abandoned", options.reason, { readmit: false, stopped });
  }

  /**
   * Ends an attempt with the agent's own result (card H12n, `work.end`): `done` and `partial` end it `succeeded`, `blocked` and `abandoned` end it `abandoned`; the summary carries the result and the note.
   * The task itself is not touched. Repeating it, or ending an attempt that is already over, does nothing (the end is derived from the attempt, so a repeat reuses its command IDs).
   */
  async finishWith(by: Principal, attemptId: string, end: { readonly result: "done" | "blocked" | "partial" | "abandoned"; readonly note?: string; readonly submissionId?: string; /** Asked once more right before the end; false: something (a stop dropping the ending) took the end back, and nothing is ended. */ readonly confirm?: () => Promise<boolean> }): Promise<boolean> {
    const d = typeof attemptId === "string" && ATTEMPT.test(attemptId) ? await this.#load(attemptId) : undefined;
    if (d === undefined || d.body.state === "finished") return true;
    await this.#controlled(by, attemptId);
    if (end.confirm !== undefined && !(await end.confirm())) return false;
    const summary = `ended by the agent: ${end.result}${end.note === undefined ? "" : `: ${end.note}`}${end.submissionId === undefined ? "" : ` (submission ${end.submissionId})`}`;
    await this.#end(attemptId, end.result === "done" || end.result === "partial" ? "succeeded" : "abandoned", summary, { readmit: false, skipHook: true, ...(end.result === "partial" ? { partial: true } : {}) });
    return true;
  }

  /**
   * Moves an attempt to another worker host (card H02). Only the owner or the dispatcher may. The calls in flight are settled, the place on the old host is given back, and the attempt goes back to
   * waiting pinned to the new host with the checkpoint to continue from: the normal tick then asks admission for a place on that host and starts the worker there, or leaves it waiting (it never
   * falls back to another host). The old worker is ended after the record has changed, so whatever it still returns changes nothing. Repeating the move to the same host is a no-op.
   * This is the owner's override: it checks no policy of its own. The policy (platform, paths, credentials, data location), the integrity checks and the fence on the old host's messages are the remote service's (`RemoteWorkerService.relocate`), which calls this last.
   */
  async relocate(by: Principal, attemptId: string, move: { readonly hostId: string; readonly checkpoint?: JsonObject; readonly note: string }): Promise<void> {
    if (!((by.kind === "owner" || (by.kind === "service" && by.id === DISPATCHER_PRINCIPAL)) && by.taskScope === undefined)) throw new DomainError("forbidden", `${by.id} may not move an attempt to another host`);
    const d = await this.#controlled(by, attemptId);
    if (typeof move.hostId !== "string" || !/^host:[a-z0-9][a-z0-9-]{0,39}$/.test(move.hostId)) invalid("hostId", "must be a host principal ID");
    if (typeof move.note !== "string" || move.note.length > 500) invalid("note", "must be at most 500 characters");
    const b = d.body;
    // Already there: waiting for the host it was pinned to, or running on it.
    if ((b.pinnedHost === move.hostId && b.state !== "running") || (b.state === "running" && b.hostId === move.hostId && b.pinnedHost === undefined)) return;
    if (b.state !== "running" && b.state !== "waiting" && b.state !== "parked") throw new DomainError("invalid_transition", `attempt ${attemptId} is ${b.state} and cannot be moved`);
    await this.#path.settle(attemptId, true);
    const fresh = (await this.#load(attemptId))!.body;
    if (fresh.requestId !== undefined) await this.#deps.admission.release({ commandId: `dpa-move:${attemptId}:${fresh.requests ?? 0}`, actor: DISPATCHER_ACTOR, requestId: fresh.requestId, reason: `the attempt moves to ${move.hostId}` }).catch((error: unknown) => { if (!isDomainError(error, "not_found")) throw error; });
    const old = this.#live.get(attemptId);
    // The old placement's task credential ends now, not when the attempt starts on the new host: a host that was partitioned and comes back cannot present it to the state API in between. The restart issues a new one (a new secret) for the new placement.
    await this.#deps.credentials.endForAttempt(this.#deps.principal, { commandId: `dpa-move-cred:${attemptId}:${fresh.requests ?? 0}`, attemptId, reason: `the attempt moves to ${move.hostId}` }).catch((error: unknown) => { if (!isDomainError(error, "not_found")) throw error; });
    await this.#update(attemptId, (x) => {
      const { requestId: _r, lease: _l, ...kept } = x; void _r; void _l;
      const rest = withoutFreeze(kept, false);
      return { ...rest, state: x.state === "parked" ? "parked" : "waiting", pinnedHost: move.hostId, ...(move.checkpoint === undefined ? {} : { resumeFrom: move.checkpoint }), resumeNote: move.note };
    });
    if (old !== undefined) {
      this.#live.delete(attemptId);
      await old.handle.stop().catch(() => undefined);
    }
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------------

  /** The attempts of a task or an agent that are live now (running, or waiting or parked with their place), for whoever must make them quiet before touching their work (card H12d). Only staff may ask. */
  async liveAttemptsOf(by: Principal, scope: { readonly taskId?: string; readonly agentId?: string }): Promise<string[]> {
    const staff = (by.kind === "owner" || by.kind === "host" || by.kind === "service") && by.taskScope === undefined;
    if (!staff) throw new DomainError("forbidden", `${by.id} may not list live attempts`);
    if (scope.taskId === undefined && scope.agentId === undefined) invalid("scope", "must name a task or an agent");
    const out: string[] = [];
    for (const id of await this.#liveIds()) {
      const d = await this.#load(id);
      if (d === undefined || d.body.state === "finished") continue;
      if ((scope.taskId === undefined || d.body.taskId === scope.taskId) && (scope.agentId === undefined || d.body.agentId === scope.agentId)) out.push(id);
    }
    return out;
  }

  /** Every attempt the dispatcher holds live (not finished) with the dispatcher's state for it, each read once, for the staff passes that look at where work runs (the quiet-host pass). Only staff may ask. */
  async liveAttempts(by: Principal): Promise<{ attemptId: string; state: string }[]> {
    const staff = (by.kind === "owner" || by.kind === "host" || by.kind === "service") && by.taskScope === undefined;
    if (!staff) throw new DomainError("forbidden", `${by.id} may not list live attempts`);
    const out: { attemptId: string; state: string }[] = [];
    for (const id of await this.#liveIds()) {
      const d = await this.#load(id);
      if (d !== undefined && d.body.state !== "finished") out.push({ attemptId: id, state: d.body.state });
    }
    return out;
  }

  async get(by: Principal, attemptId: string): Promise<View<DispatchBody> | undefined> {
    const d = typeof attemptId === "string" && ATTEMPT.test(attemptId) ? await this.#load(attemptId) : undefined;
    if (d === undefined) return undefined;
    return this.#mayRead(by, d.body) ? view<DispatchBody>(d.aggregate) : undefined;
  }

  /** One call's operation by the worker's call ID, for the tool execution service (T06) that pins a call to the version it began with. Service principals and readers of the task only. */
  async toolOperation(by: Principal, attemptId: string, callId: string): Promise<View<ToolOperationBody> | undefined> {
    const d = typeof attemptId === "string" && ATTEMPT.test(attemptId) ? await this.#load(attemptId) : undefined;
    return d === undefined || !this.#mayRead(by, d.body) ? undefined : this.#path.byCallId(attemptId, callId);
  }

  /** The operations of an attempt, in the order they began. */
  async operations(by: Principal, attemptId: string) {
    const d = typeof attemptId === "string" && ATTEMPT.test(attemptId) ? await this.#load(attemptId) : undefined;
    return d === undefined || !this.#mayRead(by, d.body) ? undefined : this.#path.list(attemptId);
  }

  /** Settles every call that a restart left in flight, from the ledger (the dispatcher runs this itself when it ends a lost attempt). */
  async recover(by: Principal, attemptId: string): Promise<{ settled: number }> {
    const d = await this.#controlled(by, attemptId);
    return { settled: await this.#path.settle(d.body.attemptId, false) };
  }

  // ---- internals: loading and writing -----------------------------------------------------------------------------------------

  async #load(attemptId: string) {
    const aggregate = await this.#runner.get(DISPATCH_KIND, derivedId("dpa", attemptId));
    return aggregate === undefined ? undefined : { aggregate, body: aggregate.body as unknown as DispatchBody, revision: aggregate.revision };
  }

  async #running(attemptId: string) {
    const d = typeof attemptId === "string" && ATTEMPT.test(attemptId) ? await this.#load(attemptId) : undefined;
    if (d === undefined || d.body.state !== "running") throw new DomainError("fenced", `attempt ${String(attemptId)} is not running under this dispatcher`, { field: "attemptId" });
    return d;
  }

  async #controlled(by: Principal, attemptId: string) {
    const d = typeof attemptId === "string" && ATTEMPT.test(attemptId) ? await this.#load(attemptId) : undefined;
    if (d === undefined || d.body.state === "finished") throw new DomainError("not_found", `attempt ${String(attemptId)} is not a live dispatch`);
    const staff = (by.kind === "owner" || by.kind === "host" || by.kind === "service") && by.taskScope === undefined;
    if (!staff && !allows(by, "assignment.manage", d.body.projectId, { resource: { kind: "task", id: d.body.taskId }, now: this.#runner.now() })) throw new DomainError("forbidden", `${by.id} may not control that attempt`);
    return d;
  }

  #mayRead(by: Principal, body: DispatchBody): boolean {
    return by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "assignment.read", body.projectId, { resource: { kind: "task", id: body.taskId }, now: this.#runner.now() });
  }

  /**
   * Rewrites the dispatch record of an attempt from what is there now (a lost race reads again), together with any extra changes. `mutate` must be idempotent: a repeat after a crash between the
   * commit and the caller's next step runs it on the result of the first.
   */
  async #update(attemptId: string, mutate: (body: DispatchBody) => DispatchBody, extra?: (body: DispatchBody) => Promise<readonly Change[]>): Promise<DispatchBody> {
    for (let attempt = 1; ; attempt++) {
      const d = await this.#load(attemptId);
      if (d === undefined) throw new DomainError("not_found", `attempt ${attemptId} has no dispatch record`);
      // The extra changes are worked out first: a caller that finds it lost a race (its record already exists) tells `mutate` so by a flag the extra function sets.
      const more = extra === undefined ? [] : await extra(d.body);
      const next = mutate(d.body);
      const ref: AggregateRef = { kind: DISPATCH_KIND, id: d.aggregate.id };
      try {
        await this.#runner.command("dispatch.update", { commandId: `dpa-up:${attemptId}:${d.revision}:${this.#instance}`, actor: DISPATCHER_ACTOR }, async () => ({
          payload: { attemptId, revision: d.revision },
          build: async () => ({ ref, creates: false, changes: mergeChanges([{ type: "update", ref, expectedRevision: d.revision, body: next as unknown as JsonObject }, ...more]), detail: { attemptId, state: next.state } }),
        }));
        return next;
      } catch (error) {
        if (isDomainError(error, "stale_revision") && attempt < 25) continue;
        throw error;
      }
    }
  }

  async #liveIds(): Promise<string[]> {
    const found = await this.#runner.get(LIVE.kind, LIVE.id);
    return found === undefined ? [] : [...(found.body as unknown as { ids: string[] }).ids];
  }

  /** Adds or removes an attempt from the live list in the same commit as the record that makes it so. */
  async #liveChange(attemptId: string, add: boolean): Promise<Change[]> {
    const found = await this.#runner.get(LIVE.kind, LIVE.id);
    const ids = found === undefined ? [] : (found.body as unknown as { ids: string[] }).ids;
    if (add && ids.length >= LIVE_MAX && !ids.includes(attemptId)) throw new DomainError("unavailable", `the dispatcher already holds ${LIVE_MAX} live attempts; none is added until some finish`);
    const next = add ? [...new Set([...ids, attemptId])] : ids.filter((i) => i !== attemptId);
    const body = { ids: next } as unknown as JsonObject;
    return found === undefined ? [{ type: "create", ref: LIVE, body }] : [{ type: "update", ref: LIVE, expectedRevision: found.revision, body }];
  }

  async #assertCurrent(d: DispatchBody): Promise<void> {
    const assignment = await this.#deps.assignments.getAssignment(d.taskId);
    if (assignment === undefined || assignment.state !== "assigned" || assignment.generation !== d.generation || assignment.activeAttemptId !== d.attemptId) {
      throw new DomainError("fenced", `attempt ${d.attemptId} is not the active attempt of its task at the current generation; it may not run`, { field: "attemptId" });
    }
  }

  // ---- internals: finding and claiming attempts -------------------------------------------------------------------------------

  /** The next page of assignments; for each active attempt without a dispatch, runs the checks and claims it. */
  async #scan(): Promise<{ scanned: number; complete: boolean; found: { taskId: string; attemptId: string; outcome: ClaimOutcome }[] }> {
    // The first scan of this process starts from the stored position (a restart goes on from there); after that the position is kept in memory and written to the store from time to time.
    const saved = await this.#runner.get(CURSOR.kind, CURSOR.id);
    const cursor = this.#cursorKnown ? this.#cursor : (saved?.body as unknown as { after?: string } | undefined)?.after;
    const page = await this.#runner.list("assignment", { ...(cursor === undefined ? {} : { afterId: cursor }), limit: this.#options.scanPage });
    const found: { taskId: string; attemptId: string; outcome: ClaimOutcome }[] = [];
    for (const a of page) {
      const body = a.body as unknown as { taskId: string; state: string; activeAttemptId?: string; generation: number; owner?: { kind: string; id: string } };
      if (body.state !== "assigned" || body.activeAttemptId === undefined || body.owner?.kind !== "agent") continue;
      if ((await this.#load(body.activeAttemptId)) !== undefined) continue;
      // One attempt whose checks throw must not stop the page (and, with the cursor not moving, every later tick): it is reported as failed and the others go on. A deposed epoch stops everything.
      const outcome = await this.#claim(body.taskId, body.activeAttemptId).catch((error: unknown): ClaimOutcome => { if (isDomainError(error, "stale_epoch")) throw error; return { kind: "failed", error: errorText(error) }; });
      found.push({ taskId: body.taskId, attemptId: body.activeAttemptId, outcome });
    }
    const complete = page.length < this.#options.scanPage;
    // The cursor moves only after the page was worked, so a crash in between rescans the page (an attempt that has its dispatch is skipped) and never skips one that was not claimed.
    const next = complete ? undefined : page.at(-1)?.id;
    await this.#saveCursor(saved, next, found.length > 0);
    this.#cursor = next;
    this.#cursorKnown = true;
    return { scanned: page.length, complete, found };
  }

  /** Writes where the scan stopped. A lost race (another dispatcher under a newer epoch cannot write; a concurrent tick of this one cannot exist) is read again; nothing is written when it did not move. */
  async #saveCursor(saved: { readonly revision: number; readonly body: unknown } | undefined, after: string | undefined, worked: boolean): Promise<void> {
    const was = (saved?.body as unknown as { after?: string } | undefined)?.after;
    if (was === after) return;
    // Over many assignments the position moves every tick; writing each move would cost a write a tick for ever. The position is written when the page had attempts in it, when a pass ended, and at most once
    // a minute otherwise: a restart that finds an older position scans a few empty pages again, which loses nothing.
    const nowMs = Date.parse(this.#runner.now());
    if (!worked && after !== undefined && this.#cursorSavedAt !== undefined && nowMs - this.#cursorSavedAt < 60_000) return;
    this.#cursorSavedAt = nowMs;
    const body = (after === undefined ? {} : { after }) as unknown as JsonObject;
    await this.#runner.command("dispatch.cursor", { commandId: `dpa-cur:${saved?.revision ?? 0}:${this.#instance}`, actor: DISPATCHER_ACTOR }, async () => ({
      payload: { after: after ?? null, revision: saved?.revision ?? 0 },
      build: async () => ({ ref: CURSOR, creates: saved === undefined, changes: [saved === undefined ? { type: "create" as const, ref: CURSOR, body } : { type: "update" as const, ref: CURSOR, expectedRevision: saved.revision, body }], detail: { after: after ?? null } }),
    }));
  }

  /** Runs the checks that come before a claim, in order; claims the attempt when they pass. */
  async #claim(taskId: string, attemptId: string): Promise<ClaimOutcome> {
    const task = await this.#deps.projects.getTask(taskId);
    const assignment = await this.#deps.assignments.getAssignment(taskId);
    const attempt = await this.#deps.assignments.getAttempt(attemptId);
    if (task === undefined || assignment === undefined || attempt === undefined) return { kind: "skipped", check: "generation", reason: "the task, its assignment or the attempt is missing" };
    const pre = await this.#checks(task, assignment.generation === attempt.generation && assignment.state === "assigned" && assignment.activeAttemptId === attemptId && attempt.state === "active", attemptId, `${attempt.owner.kind === "agent" ? "agent:" : ""}${attempt.owner.id}`);
    if (pre.kind !== "ok") return pre;
    const now = this.#runner.now();
    const contract = await this.#contractOf(taskId);
    const limit = await this.#attemptLimitMs(taskId, contract.maxMinutes);
    const body: DispatchBody = {
      attemptId, taskId, projectId: task.projectId, agentId: pre.agentId, generation: attempt.generation, state: "waiting",
      ...(pre.harness === undefined ? {} : { harness: pre.harness }), route: pre.route.route, role: pre.route.role, request: pre.route.request,
      revisions: await this.#revisions(task.projectId, taskId, contract.version, pre.route),
      hostId: pre.host.hostId, claimedAt: now, ...(limit === undefined ? {} : { expiresAt: new Date(Date.parse(now) + limit).toISOString() }), heartbeats: 0, inFlight: [], parked: [], calls: 0,
    };
    const ref: AggregateRef = { kind: DISPATCH_KIND, id: derivedId("dpa", attemptId) };
    try {
      await this.#runner.command("dispatch.claim", { commandId: `dpa-claim:${attemptId}`, actor: DISPATCHER_ACTOR }, async () => ({
        payload: { attemptId, taskId },
        build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, ...await this.#liveChange(attemptId, true)], detail: { attemptId, taskId, ...(pre.harness === undefined ? {} : { harness: pre.harness }), route: pre.route.route, host: pre.host.hostId } }),
      }));
    } catch (error) {
      // Another tick (or a restart racing this one) claimed it first: that claim stands.
      if (!isDomainError(error, "command_conflict") && !isDomainError(error, "stale_revision")) throw error;
    }
    return { kind: "claimed" };
  }

  /**
   * The checked resume of an attempt that has a checkpoint to continue from. Returns why it waits, or nothing when it may start. A fault in the check is a wait, not a failure of the attempt.
   * The check's key names the attempt, the checkpoint and the model it is about to run on, so a re-chosen route is a different check (the service refuses a command ID reused with other content). A live check of the task that is not this attempt's
   * is stale and is cancelled; a cancelled check of this attempt is started again under a new key, at most RESUME_RESTARTS times, and then the owner gets a blocker; a blocked check whose blocker is dealt with is retried here.
   */
  async #resumeCheck(attemptId: string, taskId: string, route: string): Promise<string | undefined> {
    const resumes = this.#deps.resumes;
    const b = (await this.#load(attemptId))?.body;
    if (resumes === undefined || b === undefined || b.resumeFrom === undefined) return undefined;
    const by = this.#deps.principal;
    // No continuation was ever captured for the task (a move or restart of an attempt that never had one): there is nothing to verify, so the attempt starts from its checkpoint as before rather than waiting for ever on `missing_context`.
    // A continuation that exists is still checked. A fault in asking is a wait, like any fault in the check.
    if (resumes.hasContinuation !== undefined) {
      try { if (!(await resumes.hasContinuation(by, taskId))) return undefined; } catch (error) { return `the resume check could not be run: ${errorText(error)}`.slice(0, 500); }
    }
    const slash = route.indexOf("/");
    const plain = (v: string): string => v.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 80) || "unknown";
    const model = { provider: plain(slash < 0 ? "route" : route.slice(0, slash)), id: plain(slash < 0 ? route : route.slice(slash + 1)) };
    const base = `dpa-rck:${attemptId}:${derivedId("dpa", JSON.stringify([b.resumeFrom, b.resumeNote ?? null, model])).slice(4, 16)}`;
    // A check the dispatcher itself cancelled as stale (the route flapped) does not count toward the restart budget; the key list is long enough for a flapping route.
    const keys = Array.from({ length: RESUME_RESTARTS + 1 + MAX_STALE_RESTARTS }, (_, n) => (n === 0 ? base : `${base}-r${n}`));
    try {
      const mine = new Set(keys.map((k) => resumes.checkIdFor(by, k)));
      // Another check of the task still in progress (an earlier checkpoint, another route) is stale: this attempt's is the one that counts.
      const live = await resumes.forTask(by, taskId);
      if (live !== undefined && !mine.has(live.id) && !["done", "cancelled"].includes(live.phase)) {
        try { await resumes.cancel(by, { checkId: live.id, reason: STALE_CANCEL }); } catch (error) { return `an earlier resume check ${live.id} (${live.phase}) is still in progress and could not be cancelled: ${errorText(error)}`.slice(0, 500); }
      }
      let n = 0;
      let counted = 0;
      for (; n < keys.length; n++) {
        const existing = await resumes.get(by, resumes.checkIdFor(by, keys[n]!));
        if (existing === undefined || existing.phase !== "cancelled") break;
        if (!resumes.cancelledAsStale(existing)) counted++;
        if (counted > RESUME_RESTARTS) { n = keys.length; break; }
      }
      if (n >= keys.length) {
        const opened = await this.#deps.blockers.openBlocker({ commandId: `dpa-blk:resume:${attemptId}`, actor: DISPATCHER_ACTOR, type: "dispatch_blocked", subject: { kind: "task", id: taskId }, summary: `Attempt ${attemptId} cannot start: its resume check was cancelled ${counted} times. Look at why, then assign the task again.`, resolver: "owner" }).catch(() => undefined);
        return `the resume check was cancelled ${counted} times; ${opened === undefined ? "the attempt waits" : `blocker ${opened.id} opened for the owner`}`.slice(0, 500);
      }
      const key = keys[n]!;
      let check = await resumes.start(by, { commandId: key, taskId, model, after: b.resumeNote?.includes("restarted") === true ? "restart" : "continue" });
      if (check.phase === "blocked" && await resumes.retryable(check)) check = await resumes.retry(by, { checkId: check.id });
      if (check.phase === "ready") check = await resumes.commit(by, { commandId: `${key}-commit`, checkId: check.id });
      if (check.phase === "done") return undefined;
      if (check.phase === "blocked" && resumes.exhausted(check)) {
        // No blocker will ever resolve and no retry is left: the owner is told once (the command ID is stable).
        const opened = await this.#deps.blockers.openBlocker({ commandId: `dpa-blk:resume-blocked:${check.id}`, actor: DISPATCHER_ACTOR, type: "dispatch_blocked", subject: { kind: "task", id: taskId }, summary: `Attempt ${attemptId} cannot start: its resume check is blocked (${check.blocked?.type ?? "unknown"}: ${check.blocked?.reason ?? "no reason recorded"}) after ${check.blocks} tries and nothing will retry it. Look at why, then assign the task again.`.slice(0, 900), resolver: "owner" }).catch(() => undefined);
        return `the resume check ${check.id} is blocked and retries are used up; ${opened === undefined ? "the attempt waits" : `blocker ${opened.id} opened for the owner`}`.slice(0, 500);
      }
      if (check.phase === "blocked") return `the resume check ${check.id} is blocked: ${check.blocked?.reason ?? "see its blocker"}`.slice(0, 500);
      if (check.phase === "cancelled") return `the resume check ${check.id} was cancelled; it is started again on the next tick`;
      return `the resume check ${check.id} is ${check.phase}`;
    } catch (error) {
      return `the resume check could not be run: ${errorText(error)}`.slice(0, 500);
    }
  }

  /**
   * The checks before a claim, in their fixed order. `current` says the attempt is the task's active one at the current generation. Returns what the claim needs, or why the attempt is skipped or blocked.
   */
  async #checks(task: View<TaskBody>, current: boolean, attemptId: string, agentId: string): Promise<ClaimOutcome | { kind: "ok"; agentId: string; harness: string | undefined; route: Extract<RouteChoice, { route: string }>; host: WorkerHost & { hostId: string } }> {
    const taskId = task.id;
    const skip = (check: DispatchCheck, reason: string): ClaimOutcome => ({ kind: "skipped", check, reason });
    const block = async (check: DispatchCheck, type: "grant_needed" | "dispatch_blocked", reason: string, resolver = "owner"): Promise<ClaimOutcome> => {
      const summary = `Attempt ${attemptId} was not started: ${reason}`.slice(0, 900);
      const opened = await this.#deps.blockers.openBlocker({ commandId: `dpa-blk:${type}:${taskId}:${check}:${derivedId("dpa", summary).slice(4, 16)}`, actor: DISPATCHER_ACTOR, type, subject: { kind: "task", id: taskId }, summary, resolver });
      await this.#deps.notifications?.emitFromController({ commandId: `dpa-ntf:${opened.id}`, kind: "blocker", ref: { kind: "blocker", id: opened.id }, projectId: task.projectId }).catch(() => undefined);
      return { kind: "blocked", check, blockerId: opened.id };
    };
    // 1. Generation: a stale attempt never dispatches.
    if (!current) return skip("generation", "the attempt is not the task's active attempt at the current generation");
    if (task.state === "done" || task.state === "cancelled" || task.state === "blocked" || task.state === "proposed") return skip("generation", `the task is ${task.state}`);
    // 2. Pause gates.
    const paused = await this.#deps.pauses.guard(taskId);
    if (paused.blockedBy.length > 0) return skip("pause", `paused by ${paused.blockedBy.map((s) => `${s.kind} ${s.id}`).join(", ")}`);
    // 3. The owner's decisions and gates.
    if (this.#deps.decisions !== undefined) {
      const g = await this.#deps.decisions.guard(taskId, "start");
      if (g.blockedBy.length > 0) return skip("decision", g.blockedBy.join("; "));
    }
    // 3a. Prerequisite tasks: work does not start before the tasks it depends on are complete (card L04c). The wait is recorded in the tick's report; it is not a failure.
    if (this.#deps.prerequisites !== undefined) {
      let got: Awaited<ReturnType<NonNullable<DispatcherDeps["prerequisites"]>>>;
      try { got = await this.#deps.prerequisites(taskId); } catch (error) {
        // Too many dependency records to look through, or an unreadable prerequisite: the attempt does not start (fail closed) and the tick goes on.
        if (!isDomainError(error, "unavailable")) throw error;
        return skip("dependency", "dependencies could not be read");
      }
      const open = Array.isArray(got) ? got as readonly string[] : (got as { open: readonly string[] }).open;
      const dead = Array.isArray(got) ? [] : (got as { dead: readonly string[] }).dead;
      if (dead.length > 0) {
        // A cancelled or missing prerequisite never completes by itself: one blocker per dependent task (the same set gives the same command ID) tells the owner.
        const ids = dead.slice(0, 5).join(", ");
        await this.#deps.blockers.openBlocker({ commandId: `dpa-blk:prereq:${taskId}:${derivedId("dpa", JSON.stringify([...dead].sort())).slice(4, 16)}`, actor: DISPATCHER_ACTOR, type: "dispatch_blocked", subject: { kind: "task", id: taskId }, summary: `Task ${taskId} cannot start: its prerequisite ${ids} was cancelled or is gone. Remove the dependency or restore the prerequisite.`.slice(0, 900), resolver: "owner" }).catch(() => undefined);
        return skip("dependency", `prerequisite ${ids} is cancelled or missing; waiting for the owner`.slice(0, 500));
      }
      if (open.length > 0) return skip("dependency", `waiting for ${open.slice(0, 5).join(", ")}${open.length > 5 ? ` and ${open.length - 5} more` : ""} to be complete`.slice(0, 500));
    }
    // 3b. The checkout: a task that names a repository is pinned to the binding and location it has now, and a moved, unbound or re-pointed one does not start until the owner confirms it (card P01).
    if (this.#deps.checkouts !== undefined) {
      let c: Awaited<ReturnType<NonNullable<DispatcherDeps["checkouts"]>["dispatchCheckout"]>>;
      try { c = await this.#deps.checkouts.dispatchCheckout({ commandId: `dpa-pin:${taskId}`, taskId, actor: DISPATCHER_ACTOR, pin: false }); } catch (error) {
        // Too many records to look through safely, or a store fault that is the project's: the task is blocked with a reason the owner sees, not failed on every tick without a word.
        if (!isDomainError(error, "unavailable")) throw error;
        return block("checkout", "dispatch_blocked", `the checkout could not be looked up: ${error.message}`.slice(0, 800));
      }
      if (c.kind === "changed" || c.kind === "unbound") return block("checkout", "dispatch_blocked", c.reason);
    }
    // 4. Meeting decisions that need the agent's acknowledgement, and a meeting about to start.
    if (this.#deps.meetings !== undefined) {
      const need = await this.#deps.meetings.revalidation(this.#deps.principal, taskId);
      if (need?.required === true) return skip("revalidation", "a meeting's decisions must be acknowledged by the agent before it continues");
      // Work yields to a meeting at a safe boundary when every harness this installation ships can stop a conversation (the route, and so the harness, is chosen after this check, so the answer cannot depend on it) (card M04c).
      // With no harness shipped nothing can stop a conversation, so nothing yields (an empty list is not "every harness can").
      const shipped = this.#deps.harnesses.list();
      const yieldsAtBoundary = shipped.length > 0 && shipped.every((h) => h.abort !== "none");
      const safeLongRunning = this.#options.safeLongRunning === undefined ? false : await this.#options.safeLongRunning(taskId).then((v) => v === true, () => false);
      const advice = await this.#deps.meetings.admission(this.#deps.principal, { agent: agentId, expectedMinutes: (await this.#contractOf(taskId)).maxMinutes ?? this.#options.expectedMinutes, yieldsAtBoundary, ...(safeLongRunning ? { safeLongRunning } : {}) });
      if (advice.decision === "defer") return skip("meeting", "a meeting the agent attends starts before this work would end");
    }
    // 5. Route and harness, and the recovery gate: every admission names its harness.
    // The decision is recorded per command ID, so the ID carries the revisions it reads: a change of the owner's route configuration or of the task's contract is a new decision, an unchanged one is the recorded one.
    const key = [(await this.#runner.get("routing-table", "routing"))?.revision ?? 0, (await this.#runner.get("difficulty-profiles", "profiles"))?.revision ?? 0, (await this.#runner.get("task-contract", taskId))?.revision ?? 0].join(".");
    const chosen = await this.#deps.route({ commandId: `dpa-route:${attemptId}:${key}`, taskId });
    if ("none" in chosen) return block("route", "dispatch_blocked", `no model route can be used: ${chosen.reasons.join("; ")}`.slice(0, 800));
    const recovery = await this.#deps.contracts.recoveryOf(taskId);
    const gap = this.#deps.harnesses.checkAttempt(recovery, chosen.harness);
    if (gap !== undefined) return block("harness", "dispatch_blocked", gap);
    // 5b. A checked resume (card L04c): an attempt that carries earlier work back is checked first, with the model it is about to run on.
    const resumed = await this.#resumeCheck(attemptId, taskId, chosen.route);
    if (resumed !== undefined) return skip("resume", resumed);
    // 6. Budget, from accounting.
    if (this.#deps.budgets !== undefined) {
      const report = await this.#deps.budgets.accounting(this.#deps.principal, taskId);
      if (report !== undefined && (exhausted(report.limit.costMicros, report.spent.costMicros + report.uncertain.costMicros) || exhausted(report.limit.computeMs, report.spent.computeMs + report.uncertain.computeMs))) {
        return block("budget", "dispatch_blocked", "the task's budget is used up; raise it or change the task");
      }
      // An attempt that holds nothing yet needs some of a limited allowance to be free; holds that are never settled (a lost worker's uncertain one) would keep it waiting for ever without anyone being told.
      const mine = (await this.#load(attemptId))?.body;
      if (report !== undefined && this.#deps.budgets.reserve !== undefined && mine !== undefined && mine.reservationId === undefined && mine.reserving === undefined
        && ((report.limit.computeMs > 0 && report.available.computeMs === 0) || (report.limit.costMicros > 0 && (this.#options.reserveCostMicros ?? 0) > 0 && report.available.costMicros === 0))) {
        return block("budget", "dispatch_blocked", "none of the task's allowance is free: holds for other work, or for an attempt that was lost and not yet settled, use it all; settle them or raise the budget");
      }
    }
    // 7. Grants: the task's instructions and the standing policy determine them, or the owner is asked.
    const contract = await this.#contractOf(taskId);
    const missing = await this.#missingGrants(agentId, task.projectId, taskId, contract.tools);
    if (missing.length > 0) return block("grant", "grant_needed", `the task needs ${missing.join(", ")} and no one has given ${missing.length === 1 ? "it" : "them"} to ${agentId}`);
    // 8. The host: an enrolled, unrevoked, recently heard-from host that supports the harness.
    let pinned = (await this.#load(attemptId))?.body.pinnedHost;
    if (this.#deps.storeOwner !== undefined) {
      const store = await this.#deps.storeOwner(agentId, attemptId);
      if (store !== undefined) {
        // The native store has one owner host: the agent's attempts run there and one at a time. A busy store is a wait, not a failure.
        if (store.busy) return skip("host", `the native store of ${agentId} is held by another attempt; this one waits for it`);
        pinned ??= store.hostId;
      }
    }
    const expiresAt = (await this.#load(attemptId))?.body.expiresAt;
    const probe: HostProbe = { attemptId, taskId, projectId: task.projectId, agentId, generation: (await this.#load(attemptId))?.body.generation ?? 0, ...(chosen.harness === undefined ? {} : { harness: chosen.harness }), route: chosen.route, ...(expiresAt === undefined ? {} : { expiresAt }) };
    const hostPick = await this.#pickHost(chosen.harness, pinned, probe);
    if (hostPick.kind !== "ok") {
      if (hostPick.blocked) return block("host", "dispatch_blocked", hostPick.reason);
      if (pinned === undefined) {
        if (hostPick.refused !== true) { this.#refusedWaits.delete(attemptId); return skip("host", hostPick.reason); }
        // Every host that could run it refuses it (the placement policy, what the hosts can do): it waits in the plan with the reasons, and the owner is told when it stays so, since only a change of the setting or a new host helps.
        const refusedFor = (this.#refusedWaits.get(attemptId) ?? 0) + 1;
        this.#refusedWaits.set(attemptId, refusedFor);
        if (refusedFor >= (this.#options.pinnedStaleTicks ?? 5)) return block("host", "dispatch_blocked", `no worker host will take the attempt: ${hostPick.reason}`.slice(0, 800));
        return skip("host", hostPick.reason);
      }
      // An attempt that may run only on one host waits for it; if the host stays unavailable the owner is told, since only the owner can move the attempt.
      const waited = (this.#pinnedWaits.get(attemptId) ?? 0) + 1;
      this.#pinnedWaits.set(attemptId, waited);
      if (waited >= (this.#options.pinnedStaleTicks ?? 5)) return block("host", "dispatch_blocked", `${hostPick.reason}; the attempt may run only on ${pinned} and has waited ${waited} ticks: move it to another host or bring ${pinned} back`);
      return skip("host", hostPick.reason);
    }
    this.#pinnedWaits.delete(attemptId);
    this.#refusedWaits.delete(attemptId);
    return { kind: "ok", agentId, harness: chosen.harness, route: chosen, host: hostPick.host };
  }

  /**
   * The rights the attempt cannot run without, as the agent holds them now: `attempt.work` and `task.read` on the task (a task can be handed to an agent that lacks them, e.g. by a meeting decision, and the owner is only warned),
   * and the tools the task's contract names. An agent missing any is not admitted: the normal grant blocker names what is missing, and once the owner grants it the next tick dispatches.
   */
  async #missingGrants(agentId: string, projectId: string, taskId: string, tools: readonly string[]): Promise<string[]> {
    const needed = ["attempt.work", "task.read", ...tools.filter((t) => t !== "attempt.work" && t !== "task.read")];
    const stored = (await this.#runner.get("principal", agentId))?.body as unknown as { grants: readonly { action: string; project: string; resource?: { kind: string; id: string }; expiresAt?: string }[]; kind: string; state: string } | undefined;
    if (stored === undefined || stored.state !== "active") return needed;
    const held = await this.#agentGrants(agentId);
    return needed.filter((t) => !held(t, projectId, taskId));
  }

  /** Whether an action is covered by what the agent holds now: its enrolment grants and its grant records (the same snapshot the credential would carry). */
  async #agentGrants(agentId: string): Promise<(action: string, projectId: string, taskId: string) => boolean> {
    const stored = (await this.#runner.get("principal", agentId))?.body as unknown as { name: string; grants: readonly { action: string; project: string; resource?: { kind: string; id: string }; expiresAt?: string }[] };
    const { effectiveOf } = await import("../security/grants.js");
    const now = this.#runner.now();
    const principal = await effectiveOf(this.#runner, { id: agentId, kind: "agent", name: stored.name, grants: stored.grants as never }, now);
    return (action, projectId, taskId) => allows(principal, action, projectId, { resource: { kind: "task", id: taskId }, now });
  }

  async #pickHost(harness: string | undefined, pinned: string | undefined, probe: HostProbe): Promise<{ kind: "ok"; host: WorkerHost & { hostId: string } } | { kind: "none"; reason: string; blocked: boolean; refused?: true }> {
    // An attempt pinned to a host (it was relocated there, or it parked on it and the host owns its store) goes nowhere else: it waits for that host, and the owner can move it.
    const candidates = pinned === undefined ? this.#deps.workers : this.#deps.workers.filter((w) => w.hostId === pinned);
    if (pinned !== undefined && candidates.length === 0) return { kind: "none", reason: `${pinned} is not a worker host of this dispatcher, and the attempt may run only there`, blocked: false };
    const choice = await chooseHost(candidates, async (worker): Promise<HostVerdict> => {
      const status = await this.#deps.hosts.status(this.#deps.principal, worker.hostId);
      if (status === undefined) return { kind: "refuse", reason: `${worker.hostId} is not an enrolled host`, lasting: false };
      if (status.identity !== "active") return { kind: "refuse", reason: `${worker.hostId} is revoked`, lasting: true, revoked: true };
      if (status.freshness !== "fresh") return { kind: "refuse", reason: `${worker.hostId} has not been heard from recently (${status.freshness})`, lasting: false };
      if (harness !== undefined && status.capabilities !== undefined && !status.capabilities.harnesses.some((h) => h.name === harness)) return { kind: "refuse", reason: `${worker.hostId} does not have the ${harness} harness`, lasting: false };
      // A host that would refuse the attempt (policy, what it can do, no connection) is passed over: the next one is tried, and the plan says why this one was not.
      if (worker.refuses !== undefined) {
        // A host that cannot say is tried, and the placement judges it as before; only a clear answer passes it over.
        let why: { readonly reasons: readonly string[]; readonly lasting: boolean } = { reasons: [], lasting: false };
        try { why = await worker.refuses(probe); } catch (error) { this.#options.onError?.(error); }
        if (why.reasons.length > 0) return { kind: "refuse", reason: why.reasons.join("; "), lasting: why.lasting };
      }
      return { kind: "take" };
    });
    if (choice.kind === "chosen") return { kind: "ok", host: choice.candidate };
    return { kind: "none", reason: choice.reason, blocked: choice.blocked, ...(choice.lastingRefusal ? { refused: true as const } : {}) };
  }

  async #revisions(projectId: string, taskId: string, contract: number, route: Extract<RouteChoice, { route: string }>): Promise<DispatchRevisions> {
    void taskId;
    const installation = (await this.#runner.get("approval-policy", "installation"))?.revision ?? 0;
    const project = (await this.#runner.get("approval-policy", projectId))?.revision;
    return {
      ...(route.routing === undefined ? {} : { routing: route.routing }), ...(route.profiles === undefined ? {} : { profiles: route.profiles }),
      policy: { installation, ...(project === undefined ? {} : { project }) }, decisions: await this.#decisionVersion(projectId), contract,
    };
  }

  async #decisionVersion(projectId: string): Promise<number> {
    return ((await this.#runner.get("decision-context", projectId))?.body as unknown as { version?: number } | undefined)?.version ?? 0;
  }

  /** The figures now: the setting's when a setting is attached (it carries the start-up figures itself), else the start-up options; nothing set is no limit. */
  async #figures(): Promise<DispatcherLimitFigures> {
    const set = this.#options.limits === undefined ? undefined : await this.#options.limits();
    if (set !== undefined) return set; // the setting service already put the start-up figures under the owner's
    return { ...(this.#options.attemptMs === undefined ? {} : { attemptMs: this.#options.attemptMs }), ...(this.#options.maxAttempts === undefined ? {} : { maxAttempts: this.#options.maxAttempts }) };
  }

  /** The owner's attempt time as it is now; `undefined` when none is set or the setting cannot be read (the scan then leaves the attempt alone and looks again next tick). */
  async #capNow(): Promise<number | undefined> { try { return (await this.#figures()).attemptMs; } catch (error) { await this.#limitsDamaged(error); return undefined; } }

  /**
   * The figures for starting and re-admitting attempts. A DAMAGED limits setting must not stop attempts from starting or ending (it would abort every tick for ever, and the owner could not repair it from a running system): they
   * then run with NO limits and the owner is told once per damage episode (the record's revision) that the setting needs repairing. Any other failure (storage down) still throws, so the end is tried again.
   */
  async #figuresOrNone(): Promise<DispatcherLimitFigures> {
    try { return await this.#figures(); } catch (error) { if (!await this.#limitsDamaged(error)) throw error; return {}; }
  }

  readonly #damageNoticed = new Set<number>();
  /** True when the error is a damaged limits setting (and the owner has been told, once per episode: the notice ID carries the damaged record's revision). */
  async #limitsDamaged(error: unknown): Promise<boolean> {
    if (!isDomainError(error, "integrity")) return false;
    const revision = error.currentRevision ?? 0;
    if (this.#damageNoticed.has(revision)) return true;
    try {
      await this.#deps.notifications?.emitFromController({ commandId: `dpa-limits-dmg-${revision}`, kind: "maintenance", level: "needs-you", ref: { kind: "dispatch-limits", id: "main" }, detail: `The dispatcher limits setting is damaged (${error.message.slice(0, 200)}), so attempts run with no time or count limit until it is repaired. Set or clear the limits again (dispatch.limits.change) to repair it.` });
      this.#damageNoticed.add(revision);
    } catch (notifyError) { this.#options.onError?.(notifyError); }
    return true;
  }

  /** How long an attempt of this task may run: the smallest of what is set (owner's figure, configuration, contract); `undefined` when nothing limits it. */
  async #attemptLimitMs(taskId: string, contractMinutes: number | undefined): Promise<number | undefined> {
    const configured = this.#options.configuredMinutes === undefined ? undefined : await this.#options.configuredMinutes(taskId);
    const all = [(await this.#figuresOrNone()).attemptMs, configured === undefined ? undefined : configured * 60_000, contractMinutes === undefined ? undefined : contractMinutes * 60_000].filter((x): x is number => x !== undefined);
    return all.length === 0 ? undefined : Math.min(...all);
  }

  async #contractOf(taskId: string): Promise<{ version: number; maxMinutes?: number; maxAttempts?: number; tools: readonly string[] }> {
    const c = (await this.#runner.get("task-contract", taskId))?.body as unknown as { version: number; budget?: { maxMinutes?: number; maxAttempts?: number }; permissions?: readonly string[] } | undefined;
    return {
      version: c?.version ?? 0, ...(c?.budget?.maxMinutes === undefined ? {} : { maxMinutes: c.budget.maxMinutes }), ...(c?.budget?.maxAttempts === undefined ? {} : { maxAttempts: c.budget.maxAttempts }),
      // Only a tool named in full (no wildcard, no class) is a grant the task is said to need.
      tools: (c?.permissions ?? []).filter((p) => p.startsWith("tool.") && !p.endsWith("*")),
    };
  }

  // ---- internals: places, starts and ends ------------------------------------------------------------------------------------------

  /** Takes a claimed attempt as far as it can go: asks for a place, and starts the worker when it has one. */
  async #advance(d: Loaded): Promise<AdvanceOutcome> {
    // A release a stopped process began is finished before anything is judged: the hold it still shows would count against the task's own allowance.
    if (d.body.releasingId !== undefined) { await this.#giveBack(d); d = (await this.#load(d.body.attemptId)) ?? d; }
    const b = d.body;
    const task = await this.#deps.projects.getTask(b.taskId);
    const assignment = await this.#deps.assignments.getAssignment(b.taskId);
    const attempt = await this.#deps.assignments.getAttempt(b.attemptId);
    if (task === undefined || assignment === undefined || attempt === undefined) return { kind: "skipped", check: "generation", reason: "the task, its assignment or the attempt is missing" };
    const current = assignment.generation === b.generation && assignment.state === "assigned" && assignment.activeAttemptId === b.attemptId && attempt.state === "active";
    // The attempt was superseded, released or finished elsewhere while it waited: the claim is closed, its place given back.
    if (!current) { await this.#end(b.attemptId, "abandoned", "the attempt is no longer the task's active attempt at the current generation", { readmit: false }); return { kind: "skipped", check: "generation", reason: "the attempt was superseded while it waited" }; }
    if (b.expiresAt !== undefined && b.expiresAt <= this.#runner.now()) { await this.#end(b.attemptId, "abandoned", "the attempt expired before it was started", { readmit: false }); return { kind: "skipped", check: "expired", reason: "the attempt expired before it started" }; }
    const pre = await this.#checks(task, true, b.attemptId, b.agentId);
    if (pre.kind === "skipped" || pre.kind === "blocked") {
      // A passing reason gives the place back (nothing waits on a place for work that may not start); a lasting one is already a blocker.
      if (b.requestId !== undefined || b.reservationId !== undefined || b.releasingId !== undefined) await this.#giveBack(d);
      return pre;
    }
    if (pre.kind !== "ok") return { kind: "waiting" };
    // The place. The request ID derives from the dispatch and the number of requests so far, so a repeat after a crash finds the same request.
    const requestId = await this.#request(d, pre.host);
    const where = await this.#deps.admission.where(requestId);
    if (where.state !== "running" && where.state !== "waiting") await this.#giveBack(d);
    if (where.state !== "running") return where.state === "waiting" ? { kind: "waiting", ...(where.reason === undefined ? {} : { reason: where.reason }) } : { kind: "skipped", check: "place", reason: where.state === "withdrawn" ? `the request for a place was withdrawn: ${where.reason}` : "the request for a place is gone" };
    // Card R05b: the allowance is held before the attempt starts, so two attempts of sibling tasks cannot count on the same money or compute. Nothing to reserve with: nothing is held.
    const held = await this.#reserve(d);
    if (held !== undefined) { await this.#giveBack(d); return held; }
    // The place is held and the allowance reserved: the checkout is pinned now, just before the start, so a task that only waited (for a place or an allowance) holds no pin (card P01).
    if (this.#deps.checkouts !== undefined) {
      let pinned: Awaited<ReturnType<NonNullable<DispatcherDeps["checkouts"]>["dispatchCheckout"]>>;
      try { pinned = await this.#deps.checkouts.dispatchCheckout({ commandId: `dpa-pin:${b.taskId}`, taskId: b.taskId, actor: DISPATCHER_ACTOR, pin: true }); } catch (error) {
        // The place and the allowance are held: a pin that could not be written gives them back before the fault goes on, so nothing waits on an attempt that never starts.
        await this.#giveBack(d).catch((e: unknown) => this.#options.onError?.(e));
        throw error;
      }
      if (pinned.kind === "changed" || pinned.kind === "unbound") { await this.#giveBack(d); return { kind: "skipped", check: "checkout", reason: pinned.reason }; }
    }
    return this.#start(d, pre.host, requestId);
  }

  /** Holds the attempt's most possible spend. The amounts are decided once and written to the attempt before the budget is asked, and the reservation's command ID derives from the attempt, so a repeat after a crash (or a second dispatcher) asks for the same thing and finds the same hold. Returns why the attempt cannot start when the allowance is not there. */
  async #reserve(d: Loaded): Promise<AdvanceOutcome | undefined> {
    const budgets = this.#deps.budgets;
    if (budgets?.reserve === undefined) return undefined;
    // A release a stopped process began is finished first, so the new hold is never taken for the old one.
    if (d.body.releasingId !== undefined) { await this.#giveBack(d); d = (await this.#load(d.body.attemptId)) ?? d; }
    if (d.body.reservationId !== undefined) return undefined;
    let want = d.body.reserving;
    if (want === undefined) {
      const report = await budgets.accounting(this.#deps.principal, d.body.taskId);
      if (report === undefined) return undefined; // the task has no budget: nothing is held
      const contract = await this.#contractOf(d.body.taskId);
      // Only a dimension that has a limit is held (a limit of 0 states none), and no more than is still available: the contract's time, the attempt's own expiry and the allowance agree on the smallest.
      // The attempt's own limit as it was set at the claim (none: a bounded slice of `computeReserveMs`, so one attempt does not hold the task's whole free compute and a lost worker does not turn it all uncertain), cut by the contract's time.
      const own = d.body.expiresAt === undefined ? (this.#options.computeReserveMs ?? DEFAULT_COMPUTE_RESERVE_MS) : Math.max(0, Date.parse(d.body.expiresAt) - Date.parse(d.body.claimedAt));
      const ms = Math.min(own, contract.maxMinutes === undefined ? Number.MAX_SAFE_INTEGER : contract.maxMinutes * 60_000);
      const wantCost = this.#options.reserveCostMicros ?? 0;
      const cost = report.limit.costMicros > 0 && wantCost > 0 ? Math.min(wantCost, report.available.costMicros) : 0;
      const compute = report.limit.computeMs > 0 ? Math.min(ms, report.available.computeMs) : 0;
      if (cost === 0 && compute === 0) {
        const limited = (report.limit.computeMs > 0 && report.available.computeMs === 0) || (report.limit.costMicros > 0 && wantCost > 0 && report.available.costMicros === 0);
        return limited ? { kind: "skipped", check: "budget", reason: "none of the task's allowance is free to hold for the attempt" } : undefined;
      }
      const intended = { ...(cost > 0 ? { costMicros: cost } : {}), ...(compute > 0 ? { computeMs: compute } : {}) };
      // Written first; if another caller wrote its own first, that one stands.
      want = (await this.#update(d.body.attemptId, (x) => ({ ...x, reserving: x.reserving ?? intended }))).reserving!;
    }
    let id: string;
    try { id = (await budgets.reserve(this.#deps.principal, { commandId: `dpa-res:${d.body.attemptId}${(d.body.reserveRound ?? 0) === 0 ? "" : `:${d.body.reserveRound}`}`, taskId: d.body.taskId, agentId: d.body.agentId, purpose: `attempt ${d.body.attemptId}`, ...want })).id; } catch (error) {
      if (isDomainError(error, "not_found")) return undefined;
      if (error instanceof BudgetClosedError) {
        // The owner closed the task's budget: nothing can be held for it, now or later, so the owner is told with a blocker rather than the attempt waiting in silence.
        await this.#update(d.body.attemptId, (x) => { if (x.reservationId !== undefined || JSON.stringify(x.reserving) !== JSON.stringify(want)) return x; const { reserving: _r, ...rest } = x; void _r; return rest; });
        const summary = `Attempt ${d.body.attemptId} was not started: ${errorText(error)}`.slice(0, 900);
        const opened = await this.#deps.blockers.openBlocker({ commandId: `dpa-blk:dispatch_blocked:${d.body.taskId}:budget:${derivedId("dpa", summary).slice(4, 16)}`, actor: DISPATCHER_ACTOR, type: "dispatch_blocked", subject: { kind: "task", id: d.body.taskId }, summary, resolver: "owner" });
        await this.#deps.notifications?.emitFromController({ commandId: `dpa-ntf:${opened.id}`, kind: "blocker", ref: { kind: "blocker", id: opened.id }, projectId: d.body.projectId }).catch(() => undefined);
        return { kind: "blocked", check: "budget", blockerId: opened.id };
      }
      if (isDomainError(error, "invalid_command")) {
        // Refused inside the budget's own command, so nothing was held: the amounts are decided again at the next tick (a sibling may have taken part of the allowance meanwhile).
        await this.#update(d.body.attemptId, (x) => { if (x.reservationId !== undefined || JSON.stringify(x.reserving) !== JSON.stringify(want)) return x; const { reserving: _r, ...rest } = x; void _r; return rest; });
        return { kind: "skipped", check: "budget", reason: `the task's allowance cannot hold this attempt: ${errorText(error)}` };
      }
      throw error;
    }
    await this.#update(d.body.attemptId, (x) => ({ ...x, reservationId: id, used: x.used ?? { costMicros: 0, computeMs: 0 } }));
    return undefined;
  }

  async #request(d: Loaded, host: WorkerHost): Promise<string> {
    if (d.body.requestId !== undefined) {
      const where = await this.#deps.admission.where(d.body.requestId);
      if (where.state === "running" || where.state === "waiting") return d.body.requestId;
    }
    const n = d.body.requests ?? 0;
    const priority = await this.#deps.contracts.priorityOf(d.body.taskId);
    // Who the work counts for under the owner's optional caps: its project, its agent and (for a child task) the agent of the task it reports to. A supervisor that cannot be read is simply not counted.
    const reportsTo = this.#deps.reportsTo === undefined ? undefined : await this.#deps.reportsTo(d.body.taskId).catch((e: unknown) => { this.#options.onError?.(e); return undefined; });
    const asked = await this.#deps.admission.request({ commandId: `dpa-req:${d.body.attemptId}:${n}`, actor: DISPATCHER_ACTOR, class: "productive", priority, host: host.hostId, project: d.body.projectId, agent: d.body.agentId, ...(reportsTo === undefined ? {} : { reportsTo }), cpus: host.resources.cpus, memoryMb: host.resources.memoryMb });
    await this.#update(d.body.attemptId, (b) => ({ ...b, requestId: asked.id, requests: Math.max(b.requests ?? 0, n + 1), hostId: host.hostId }));
    return asked.id;
  }

  /**
   * The attempt cannot start now: its place is given back and so is the allowance it held, so nothing waits on work that is not running. The record is read again first (the caller's copy may be older than the
   * request or reservation made in this very advance). A later tick asks for a place and holds the allowance afresh (`reserveRound` keeps the new hold's command apart from the released one).
   */
  async #giveBack(d: Loaded): Promise<void> {
    const fresh = (await this.#load(d.body.attemptId))?.body ?? d.body;
    const id = fresh.requestId;
    if (id !== undefined) {
      await this.#deps.admission.release({ commandId: `dpa-rel:${fresh.attemptId}:${fresh.requests ?? 0}`, actor: DISPATCHER_ACTOR, requestId: id, reason: "the attempt cannot start now" }).catch((error: unknown) => { if (!isDomainError(error, "not_found")) throw error; });
      await this.#update(fresh.attemptId, (b) => { const { requestId: _r, ...rest } = b; void _r; return rest; });
    }
    const budgets = this.#deps.budgets;
    if (budgets?.release === undefined) return;
    // An attempt that already ran keeps its hold: the hold carries what it used (settled when the attempt ends), and `release` is for a hold that was never dispatched.
    if (fresh.releasingId === undefined && ((fresh.used?.costMicros ?? 0) > 0 || (fresh.used?.computeMs ?? 0) > 0)) return;
    // The hold is first moved to `releasingId` (and the round counted) in one write, then released under a command ID that derives from the round, then the mark is cleared: a process that stops in between finds the mark and finishes the release,
    // so an attempt is never started on a hold that was already released.
    let marked = fresh;
    if (fresh.reservationId !== undefined) {
      const held = fresh.reservationId;
      marked = await this.#update(fresh.attemptId, (b) => { if (b.reservationId !== held) return b; const { reservationId: _h, reserving: _w, ...rest } = b; void _h; void _w; return { ...rest, releasingId: held, reserveRound: (b.reserveRound ?? 0) + 1 }; });
    }
    const releasing = marked.releasingId;
    if (releasing === undefined) return;
    try { await budgets.release(this.#deps.principal, { commandId: `dpa-rrel:${marked.attemptId}:${(marked.reserveRound ?? 1) - 1}`, reservationId: releasing }); } catch (error) {
      // Already settled or released, or held as uncertain (which must be settled with what happened, not released): either way there is nothing more to release here. Anything else keeps the mark and goes on, so the next tick tries again.
      if (isDomainError(error, "invalid_transition")) this.#options.onError?.(error);
      else if (!isDomainError(error, "not_found")) throw error;
    }
    await this.#update(marked.attemptId, (b) => { if (b.releasingId !== releasing) return b; const { releasingId: _r, ...rest } = b; void _r; return rest; });
  }

  async #start(d: Loaded, host: WorkerHost, requestId: string): Promise<AdvanceOutcome> {
    const b = d.body;
    // The place, the host and the generation were judged just before (`#advance`, which runs every check again for a claim that waits); here the claim on the attempt is made. The record says "running"
    // before the worker exists, and only one caller can make it: it must still be waiting, with the place this caller holds. If this process dies now, the lease ends and the attempt is taken as lost.
    const now = this.#runner.now();
    const until = new Date(Date.parse(now) + this.#options.leaseMs).toISOString();
    try {
      await this.#update(b.attemptId, (x) => {
        if (x.state !== "waiting" || x.requestId !== requestId) throw new DomainError("invalid_command", `attempt ${b.attemptId} is ${x.state} and was started by another caller`, { field: "attemptId" });
        const { resumeNote: _n, resumeFrom: _f, pinnedHost: _p, ...rest } = x; void _n; void _f; void _p;
        return { ...rest, state: "running", hostId: host.hostId, startedAt: x.startedAt ?? now, lease: { holder: this.#holder, until } };
      });
    } catch (error) {
      if (isDomainError(error, "invalid_command")) return { kind: "skipped", check: "place", reason: "another caller started the attempt" };
      throw error;
    }
    await this.#assertCurrent(b);
    const credential = await this.#deps.credentials.issueForAttempt(this.#deps.principal, { commandId: `dpa-cred:${b.attemptId}`, attemptId: b.attemptId, ...(b.expiresAt === undefined ? {} : { expiresAt: b.expiresAt }) });
    const credentialId = credential.token.slice(0, credential.token.lastIndexOf("."));
    const environment = await this.#pin(b);
    await this.#update(b.attemptId, (x) => ({ ...x, credentialId, revisions: { ...x.revisions, ...(environment === undefined ? {} : { environment }) } }));
    const recipe: RecipeSummary = { revision: `r-${b.attemptId.slice(4, 16)}`, reach: [] };
    const order: WorkOrder = {
      attemptId: b.attemptId, taskId: b.taskId, projectId: b.projectId, agentId: b.agentId, generation: b.generation, ...(b.harness === undefined ? {} : { harness: b.harness }), route: b.route, credential: credential.token, recipe,
      content: await this.#contentOf(b.taskId) + await this.#policyNote(b), requestId: `cmd:adm:${b.attemptId}`, ...(b.expiresAt === undefined ? {} : { expiresAt: b.expiresAt }),
      ...(b.resumeFrom === undefined ? {} : { resumeFrom: b.resumeFrom }), ...(b.resumeNote === undefined ? {} : { resumeNote: b.resumeNote }),
    };
    let handle: WorkerHandle;
    try { handle = await host.start(order); } catch (error) {
      const why = error instanceof Error ? error.message.slice(0, 200) : "failed";
      await this.#end(b.attemptId, "failed", `the worker did not start: ${why}`, { readmit: false });
      // The report says why too (a host that cannot meet a requirement is a visible refusal, not a silent skip).
      return { kind: "skipped", check: "host", reason: `the worker did not start: ${why}` };
    }
    await this.#update(b.attemptId, (x) => ({ ...x, workerVersion: handle.workerVersion, recipeRevision: recipe.revision }));
    await this.#stepOf(b.attemptId, "model", "model-selected", `Attempt ${b.attemptId} runs on route ${b.route}.`, [{ kind: "dispatch", id: b.attemptId }]);
    if (b.harness !== undefined) await this.#stepOf(b.attemptId, "harness", "harness-selected", `Attempt ${b.attemptId} runs in the ${b.harness} harness.`, [{ kind: "dispatch", id: b.attemptId }]);
    // A stop may have landed while the worker was starting (the record says running before the host answers): the attempt is over, so the worker that came up is let go instead of left live and unowned. No await between this check and `#live.set`.
    if ((await this.#load(b.attemptId))?.body.state !== "running") {
      await handle.stop().catch(() => undefined);
      await host.release?.(b.attemptId, "the attempt ended while its worker was starting").catch(() => undefined);
      return { kind: "skipped", check: "host", reason: "the attempt ended while its worker was starting" };
    }
    const turn = this.#run(b.attemptId, handle);
    this.#live.set(b.attemptId, { handle, host, turn });
    return { kind: "started" };
  }

  /** The rules that bind the agent in the project, read now (card U04d): an owner's edit is in the next attempt's context. Not being able to read them never stops the attempt. */
  async #policyNote(b: DispatchBody): Promise<string> {
    if (this.#deps.policy.contextFor === undefined) return "";
    try {
      const agent = await this.#deps.credentials.principalOf(this.#deps.principal, b.attemptId);
      const context = await this.#deps.policy.contextFor(agent, b.projectId);
      return context === undefined ? "" : `\n\n${describePolicyContext(context)}`;
    } catch { return ""; }
  }

  async #contentOf(taskId: string): Promise<string> {
    const task = await this.#deps.projects.getTask(taskId);
    return task === undefined ? "" : `${task.title}${task.description === "" ? "" : `\n\n${task.description}`}`;
  }

  async #pin(b: DispatchBody): Promise<number | undefined> {
    if (this.#deps.environments === undefined) return undefined;
    const agent = await this.#deps.credentials.principalOf(this.#deps.principal, b.attemptId);
    try { return (await this.#deps.environments.pin(agent, { commandId: `dpa-env:${b.attemptId}`, attemptId: b.attemptId, agentId: b.agentId, kind: "attempt" })).revision; } catch (error) {
      // An agent with no environment revision runs without one; the record says so by having none.
      if (isDomainError(error, "invalid_command") && /no active environment/.test(error.message)) return undefined;
      throw error;
    }
  }

  /** Runs the turn and records how it ended. The turn's promise never rejects: a broken worker ends the attempt as failed. */
  #run(attemptId: string, handle: WorkerHandle): Promise<void> {
    const gateway = this.gateway(attemptId);
    const done = (async () => {
      let result: WorkerTurnResult;
      try { result = await handle.run(gateway); } catch (error) { result = { status: "failed", error: error instanceof Error ? error.message.slice(0, 200) : "the worker failed" }; }
      // A turn that was ended by a relocation (or any other change of its worker) is not the attempt's turn any more: whatever it returns changes nothing.
      if (this.#live.get(attemptId)?.handle !== handle) return;
      const d = await this.#load(attemptId);
      if (d === undefined || d.body.state !== "running") return;
      try {
        if (result.usage !== undefined) {
          // A turn's figures that could not be charged are not lost silently: the attempt's record says so (redacted, clipped).
          await this.#usage(attemptId, result.usage).catch(async (error: unknown) => {
            const why = clip(redactText(error instanceof Error ? error.message : String(error)), DISPATCH_LIMITS.diagnostic);
            await this.#update(attemptId, (b) => ({ ...b, usageError: why })).catch(() => undefined);
          });
        }
        // The turn ended with calls still waiting for an approval: the attempt gives its place back instead of holding it while nobody works.
        if (result.status === "completed" && d.body.parked.length > 0) {
          // A call that was decided, the attempt resumed for it, and that the agent did not make again is closed; the attempt yields again only for calls still undecided.
          await this.#path.closeUnmade(attemptId, d.body.resumedFor ?? []);
          if ((await this.#load(attemptId))!.body.parked.length > 0) { await this.#yield(attemptId, result.checkpoint); return; }
        }
        await this.#end(attemptId, result.status === "completed" ? "succeeded" : result.status === "cancelled" ? "abandoned" : "failed", result.status === "completed" ? "the turn completed" : (result.error ?? `the turn ${result.status}`), { readmit: false });
      } catch (error) {
        // The attempt could not be recorded as ended (the epoch was lost, storage was unreachable): the lease will end it; nothing is thrown into the void.
        if (isDomainError(error, "stale_epoch")) return;
      }
    })();
    const turn: Promise<void> = done.finally(() => { if (this.#live.get(attemptId)?.turn === turn) this.#live.delete(attemptId); });
    return turn;
  }

  /** Gives the attempt's place back while its calls wait for an approval; the checkpoint of the turn is kept so the attempt can go on in a new run. */
  async #yield(attemptId: string, checkpoint: JsonObject | undefined): Promise<void> {
    const d = (await this.#load(attemptId))!;
    const b = d.body;
    await this.#live.get(attemptId)?.handle.stop().catch(() => undefined);
    this.#path.forget(attemptId, b.parked);
    if (b.requestId !== undefined) await this.#deps.admission.release({ commandId: `dpa-yield:${attemptId}:${b.requests ?? 0}`, actor: DISPATCHER_ACTOR, requestId: b.requestId, reason: "every call of the attempt waits for an approval" }).catch((error: unknown) => { if (!isDomainError(error, "not_found")) throw error; });
    await this.#update(attemptId, (x) => {
      const { requestId: _r, lease: _l, ...rest } = x; void _r; void _l;
      // The attempt goes on where it was: the native store of its conversation is owned by that host.
      return { ...rest, state: "parked", pinnedHost: x.hostId, ...(checkpoint === undefined ? {} : { resumeFrom: checkpoint }) };
    });
  }

  /**
   * Ends an attempt, whatever the reason: the worker is stopped, the calls still in flight are settled from the ledger, the attempt is finished in the assignment (the task itself is not touched),
   * the place is given back, the credential ends and the dispatch is closed. A lost attempt (not an expired or stopped one) may be admitted again by the dispatcher, within the attempts allowed.
   */
  /** Binds the agent's ending: asked before an attempt ends for any reason (the turn completing, a stop, a lost worker), so an ending the agent asked for is completed or dropped with its true reason. */
  onEnd(hook: EndHook | undefined): void { this.#endHook = hook; }
  /**
   * Called once an attempt is finished (never before), with whether its worker is CONFIRMED stopped (`workerStopped`: its handle stopped, or the host that held it confirmed the release; a stop that failed or a host that cannot release is not a confirmation).
   * It runs apart from the end: after the failure's blocker is open, not awaited by the end or by `idle()`, and cut off after `endedHookMs` (default: `endHookMs`, else 30 s). A failure or a timeout is reported and changes nothing. The scratch cleanup uses it.
   */
  onEnded(hook: ((attemptId: string, how: { readonly outcome: "succeeded" | "failed" | "abandoned"; readonly workerStopped: boolean; readonly signal: AbortSignal }) => Promise<void>) | undefined): void { this.#endedHook = hook; }
  /** Waits for the ended hooks now running (tests and shutdown; each is bounded by its own timeout). */
  async endedIdle(): Promise<void> { while (this.#endedRunning.size > 0) await Promise.allSettled([...this.#endedRunning]); }

  #runEnded(attemptId: string, outcome: "succeeded" | "failed" | "abandoned", workerStopped: boolean): void {
    const hook = this.#endedHook;
    if (hook === undefined) return;
    const limit = this.#options.endedHookMs ?? this.#options.endHookMs ?? 30_000;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), limit); });
    const abort = new AbortController();
    this.#endedAborts.add(abort);
    const call = (async () => hook(attemptId, { outcome, workerStopped, signal: abort.signal }))();
    this.#endedCalls.add(call);
    call.then(() => undefined, (error: unknown) => { this.#options.onError?.(error); }).finally(() => { this.#endedCalls.delete(call); this.#endedAborts.delete(abort); });
    const run: Promise<unknown> = Promise.race([call, timeout]).then((r) => { if (r === "timeout") abort.abort(); if (r === "timeout") this.#options.onError?.(new Error(`the ended hook of attempt ${attemptId} did not answer within ${limit} ms; it is left to the sweep`)); }, () => undefined).finally(() => { if (timer !== undefined) clearTimeout(timer); this.#endedRunning.delete(run); });
    this.#endedRunning.add(run);
  }

  async #end(attemptId: string, outcome: "succeeded" | "failed" | "abandoned", summary: string, options: { readmit: boolean; lost?: boolean; stopped?: { readonly by: "owner" | "emergency"; readonly reason: string }; skipHook?: boolean; partial?: boolean }): Promise<{ readmitted?: string }> {
    // `idle()` waits for every end in progress, not only for the turns: an attempt leaves the live list part-way through its end, and the blocker for a failure is opened after that.
    // Two paths can end the same attempt at once (the worker's result, the lease scan, a stop): the second joins the first, whose outcome stands. Its own would reuse the first's command IDs with a different summary.
    // The end is registered synchronously, before the end hook is awaited, so a second end that comes while the hook runs joins it.
    const already = this.#endingBy.get(attemptId);
    if (already !== undefined) {
      // The agent's own ending, completed inside the hook, finishes the attempt itself (it cannot join the end that is waiting for it).
      if (options.skipHook === true && this.#inHook.has(attemptId)) return this.#endInner(attemptId, outcome, this.#cleanSummary(outcome, summary), options);
      return already;
    }
    const ending = this.#endHooked(attemptId, outcome, summary, options);
    this.#ending.add(ending);
    this.#endingBy.set(attemptId, ending);
    try { return await ending; } finally { this.#ending.delete(ending); if (this.#endingBy.get(attemptId) === ending) this.#endingBy.delete(attemptId); }
  }

  readonly #inHook = new Set<string>();

  #cleanSummary(outcome: string, summary: string): string {
    // The reason may be a worker's or a model's error text, which the records refuse if it holds control characters or half a character: an attempt must always be able to end.
    const clean = Array.from(summary.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\ud800-\udfff]/g, "?")).slice(0, 1000).join("").trim();
    return clean === "" ? `the attempt ${outcome}` : clean;
  }

  async #endHooked(attemptId: string, outcome: "succeeded" | "failed" | "abandoned", summary: string, options: { readmit: boolean; lost?: boolean; stopped?: { readonly by: "owner" | "emergency"; readonly reason: string }; skipHook?: boolean; partial?: boolean }): Promise<{ readmitted?: string }> {
    if (this.#endHook !== undefined && options.skipHook !== true) {
      const hook = this.#endHook;
      this.#inHook.add(attemptId);
      let timer: NodeJS.Timeout | undefined;
      try {
        const limit = this.#options.endHookMs ?? 30_000;
        const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), limit); });
        const call = hook(attemptId, { outcome, summary, ...(options.stopped === undefined ? {} : { stopped: options.stopped }) });
        call.catch(() => undefined);
        const told = await Promise.race([call, timeout]);
        if (told === "timeout") this.#options.onError?.(new Error(`the end hook of attempt ${attemptId} did not answer within ${limit} ms; the attempt ends with the dispatcher's own outcome`));
        else {
          if (told?.handled === true) return {};
          if (told?.summary !== undefined) summary = told.summary;
          if (told?.outcome !== undefined) outcome = told.outcome;
          if (told?.partial === true) options = { ...options, partial: true };
        }
      } catch (error) { this.#options.onError?.(error); } finally { if (timer !== undefined) clearTimeout(timer); this.#inHook.delete(attemptId); }
    }
    return this.#endInner(attemptId, outcome, this.#cleanSummary(outcome, summary), options);
  }

  async #endInner(attemptId: string, outcome: "succeeded" | "failed" | "abandoned", summary: string, options: { readmit: boolean; lost?: boolean; partial?: boolean }): Promise<{ readmitted?: string }> {
    const d = await this.#load(attemptId);
    if (d === undefined || d.body.state === "finished") return {};
    const live = this.#live.get(attemptId);
    // Whether the worker is CONFIRMED gone: its handle stopped without error, or the host that held it confirmed the release. A failed stop, or a host that cannot release, is not a confirmation (the scratch stays).
    let workerStopped: boolean;
    if (live !== undefined) workerStopped = await live.handle.stop().then(() => true, () => false);
    // No handle in this process (the controller restarted since the worker was placed): the host that holds the attempt is told to let go, or a remote placement would stay live for ever and keep the agent's store busy.
    else { const host = this.#deps.workers.find((w) => w.hostId === d.body.hostId); workerStopped = host?.release === undefined ? false : await host.release(attemptId, summary.slice(0, 280)).then(() => true, () => false); }
    await this.#path.settle(attemptId, true).catch(() => undefined);
    await this.#path.cancelParked(attemptId).catch(() => undefined);
    const b = (await this.#load(attemptId))!.body;
    // The owner's figures are read before anything is finished: a setting that cannot be read (storage down) throws here, the attempt stays unfinished and the end is tried again, so the replacement is never lost. A damaged setting is not an obstacle: no limits apply and the owner is told.
    const figures = options.readmit ? await this.#figuresOrNone() : undefined;
    await this.#settleReservation(b, options.lost === true);
    const assignment = await this.#deps.assignments.getAssignment(b.taskId);
    // The attempt is finished in the assignment only if it is still the active one; a superseded attempt was ended by whoever transferred the task.
    const active = assignment !== undefined && assignment.state === "assigned" && assignment.generation === b.generation && assignment.activeAttemptId === attemptId;
    if (assignment !== undefined && active) {
      await this.#deps.assignments.finishAttempt({ commandId: `dpa-fin:${attemptId}`, actor: DISPATCHER_ACTOR, taskId: b.taskId, expectedRevision: assignment.revision, fence: { generation: b.generation, attemptId }, outcome, summary: summary.slice(0, 500) }).catch((error: unknown) => { // command_conflict: another path ending the same attempt (the lease scan and a stop) got there first with its own summary; the assignment is finished either way.
      if (!isDomainError(error, "fenced") && !isDomainError(error, "stale_revision") && !isDomainError(error, "invalid_command") && !isDomainError(error, "command_conflict")) throw error; });
    }
    if (b.requestId !== undefined) await this.#deps.admission.release({ commandId: `dpa-end-rel:${attemptId}`, actor: DISPATCHER_ACTOR, requestId: b.requestId, reason: summary.slice(0, 280) }).catch((error: unknown) => { if (!isDomainError(error, "not_found")) throw error; });
    await this.#deps.credentials.endForAttempt(this.#deps.principal, { commandId: `dpa-end-cred:${attemptId}`, attemptId, reason: summary.slice(0, 280) }).catch((error: unknown) => { if (!isDomainError(error, "not_found")) throw error; });
    // Before the attempt is marked finished, so a crash in between leaves the end to be done again (every command here is derived from the task and the attempt). A superseded attempt does not count against the task or take the hand-off head.
    if (active) await this.#contextAtEnd(b, outcome, summary, options.partial === true);
    await this.#update(attemptId, (x) => ({ ...x, state: "finished", workerStopped, inFlight: [], parked: [], outcome: { status: outcome, summary: summary.slice(0, 500), at: this.#runner.now() } }), () => this.#liveChange(attemptId, false));
    // A worker registered while this end was running (its start answered after the end began) is let go too.
    const late = this.#live.get(attemptId);
    if (late !== undefined && late.handle !== live?.handle && !(await late.handle.stop().then(() => true, () => false))) { workerStopped = false; await this.#update(attemptId, (x) => ({ ...x, workerStopped: false })).catch(() => undefined); }
    this.#live.delete(attemptId);
    this.#usageSeq.delete(attemptId);
    if (outcome === "failed") {
      const opened = await this.#deps.blockers.openBlocker({ commandId: `dpa-blk:failed:${attemptId}`, actor: DISPATCHER_ACTOR, type: "dispatch_blocked", subject: { kind: "task", id: b.taskId }, summary: `Attempt ${attemptId} failed (${summary.slice(0, 300)}); the task is as it was and no further attempt starts by itself.`, resolver: "owner" });
      await this.#deps.notifications?.emitFromController({ commandId: `dpa-ntf:${opened.id}`, kind: "blocker", ref: { kind: "blocker", id: opened.id }, projectId: b.projectId }).catch(() => undefined);
    }
    this.#runEnded(attemptId, outcome, workerStopped);
    return figures !== undefined ? this.#readmit(b, figures) : {};
  }

  /** Settles the attempt's hold to what it used, or holds it as uncertain when the worker was lost (its last calls are not known). Settling is by command ID derived from the attempt, so an end done again settles once. */
  async #settleReservation(b: DispatchBody, lost: boolean): Promise<void> {
    const budgets = this.#deps.budgets;
    // A release that was begun and not finished (the process stopped, or the ledger failed) is finished here, so an attempt that ends first does not leave its hold open for good.
    if (b.releasingId !== undefined && budgets?.release !== undefined) {
      try { await budgets.release(this.#deps.principal, { commandId: `dpa-rrel:${b.attemptId}:${(b.reserveRound ?? 1) - 1}`, reservationId: b.releasingId }); } catch (error) {
        if (!isDomainError(error, "invalid_transition") && !isDomainError(error, "not_found")) this.#options.onError?.(error);
      }
    }
    if (b.reservationId === undefined || budgets?.settle === undefined) return;
    try {
      if (lost && budgets.markUncertain !== undefined) await budgets.markUncertain(this.#deps.principal, { commandId: `dpa-unc:${b.attemptId}`, reservationId: b.reservationId, reason: "the worker was lost; what its last calls cost is not known" });
      else await budgets.settle(this.#deps.principal, { commandId: `dpa-set:${b.attemptId}`, reservationId: b.reservationId, ...(b.used === undefined || b.used.costMicros === 0 ? {} : { costMicros: b.used.costMicros }), ...(b.used === undefined || b.used.computeMs === 0 ? {} : { computeMs: b.used.computeMs }) });
    } catch (error) {
      // Already settled or already uncertain (this end ran before): fine. Anything else is told and does not keep the attempt from ending; the hold stays visible in the task's report.
      if (!isDomainError(error, "invalid_transition") && !isDomainError(error, "command_conflict")) this.#options.onError?.(error);
    }
  }

  /** The context bookkeeping of an ended attempt (card C07b). It never keeps the attempt from ending: a failure here is reported and the end goes on. */
  /** `partial`: the agent ended with part of the work done; the attempt is `succeeded` for the task but did not run within budget as a whole, so the overflow count is not reset (only a `done` does). */
  async #contextAtEnd(b: DispatchBody, outcome: "succeeded" | "failed" | "abandoned", summary: string, partial = false): Promise<void> {
    const context = this.#deps.context;
    if (context === undefined) return;
    // The reason comes from the worker or the model: control characters become spaces, the cut is on whole characters, and a blank one gets a plain sentence (the context service refuses text it cannot store).
    const clip = (n: number): string => { const t = Array.from(summary.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\ud800-\udfff]/g, "?")).slice(0, n).join("").trim(); return t === "" ? `the attempt ${outcome}` : t; };
    const guarded = async (step: () => Promise<unknown>): Promise<void> => { try { await step(); } catch (error) { this.#options.onError?.(error); } };
    // An attempt that ran within budget starts the count again; one that failed for want of context is counted. Each step stands on its own: a refusal of one must not skip the hand-off.
    if (outcome === "succeeded" && !partial) await guarded(() => context.resetOverflow(this.#deps.principal, { taskId: b.taskId, attemptId: b.attemptId }));
    if (outcome === "failed") await guarded(() => context.reportOverflow(this.#deps.principal, { taskId: b.taskId, attemptId: b.attemptId, failure: clip(500) }));
    const ended = clip(280);
    await guarded(async () => {
      const facts = async (taskId: string, attemptId: string): Promise<HandoffFacts> => {
        const given = await this.#deps.handoffFacts?.({ taskId, attemptId, endedBecause: ended });
        if (given !== undefined) return { ...given, endedBecause: ended };
        const task = await this.#deps.projects.getTask(taskId);
        return { task: task?.title ?? taskId, endedBecause: ended, effects: [], artifacts: [], lastKnownState: `the attempt ${outcome}` };
      };
      await context.ensureHandoff(this.#deps.principal, { taskId: b.taskId, attemptId: b.attemptId, endedBecause: ended }, facts);
    });
  }

  /** After a lost attempt the dispatcher admits the next one itself, up to the attempts the contract (or the dispatcher's own limit) allows; beyond that a blocker names the owner. */
  async #readmit(b: DispatchBody, figures: DispatcherLimitFigures): Promise<{ readmitted?: string }> {
    const assignment = await this.#deps.assignments.getAssignment(b.taskId);
    if (assignment === undefined || assignment.state !== "assigned" || assignment.generation !== b.generation || assignment.activeAttemptId !== undefined || assignment.owner === undefined) return {};
    // A call of the ended attempt whose outcome is not known could be repeated by a new attempt (it would ask for the same effect under new IDs): no replacement is admitted until a person has settled what happened.
    const unsure = (await this.#path.list(b.attemptId)).filter((o) => o.state === "uncertain" || o.state === "in-progress");
    if (unsure.length > 0) {
      const opened = await this.#deps.blockers.openBlocker({ commandId: `dpa-blk:uncertain:${b.attemptId}`, actor: DISPATCHER_ACTOR, type: "dispatch_blocked", subject: { kind: "task", id: b.taskId }, summary: `Attempt ${b.attemptId} ended with ${unsure.length} call(s) whose outcome is not known or not settled (${unsure.slice(0, 5).map((o) => o.callId).join(", ")}). A new attempt could repeat them, so none was started. Find out what happened to them; then assign the task again (nothing starts a new attempt by itself).`.slice(0, 500), resolver: "owner" });
      await this.#deps.notifications?.emitFromController({ commandId: `dpa-ntf:${opened.id}`, kind: "blocker", ref: { kind: "blocker", id: opened.id }, projectId: b.projectId }).catch(() => undefined);
      return {};
    }
    const contract = await this.#contractOf(b.taskId);
    // The smaller of the owner's cap and the contract's (a contract cannot lift the owner's cap).
    const caps = [contract.maxAttempts, figures.maxAttempts].filter((x): x is number => x !== undefined);
    const allowed = caps.length === 0 ? undefined : Math.min(...caps);
    if (allowed !== undefined && assignment.attempts >= allowed) {
      const opened = await this.#deps.blockers.openBlocker({ commandId: `dpa-blk:attempts:${b.taskId}:${assignment.attempts}`, actor: DISPATCHER_ACTOR, type: "dispatch_blocked", subject: { kind: "task", id: b.taskId }, summary: `${assignment.attempts} attempts were made and the task allows ${allowed}; no further attempt starts by itself.`, resolver: "owner" });
      await this.#deps.notifications?.emitFromController({ commandId: `dpa-ntf:${opened.id}`, kind: "blocker", ref: { kind: "blocker", id: opened.id }, projectId: b.projectId }).catch(() => undefined);
      return {};
    }
    const next = await this.#deps.assignments.admitAttempt({ commandId: `dpa-readmit:${b.taskId}:${assignment.attempts + 1}`, actor: DISPATCHER_ACTOR, taskId: b.taskId, expectedRevision: assignment.revision, generation: b.generation, owner: assignment.owner, ...(b.harness === undefined ? {} : { harness: b.harness }) });
    return { readmitted: next.id };
  }

  async #reprioritize(): Promise<number> {
    // Only requests whose stored priority differs from the contract's now are sent, and the command names the queue it was worked out from, so a priority that goes back to an earlier value is applied again.
    const snapshot = await this.#deps.admission.snapshot();
    const stored = new Map(snapshot.queue.map((e) => [e.id, e.priority]));
    const changes: { requestId: string; priority: number }[] = [];
    for (const id of await this.#liveIds()) {
      const d = await this.#load(id);
      if (d === undefined || d.body.state !== "waiting" || d.body.requestId === undefined || !stored.has(d.body.requestId)) continue;
      const priority = await this.#deps.contracts.priorityOf(d.body.taskId);
      if (priority !== stored.get(d.body.requestId)) changes.push({ requestId: d.body.requestId, priority });
    }
    let changed = 0;
    for (let i = 0; i < changes.length; i += 100) {
      const batch = changes.slice(i, i + 100);
      const key = `${snapshot.revision}:${i}`;
      changed += (await this.#deps.admission.reprioritize({ commandId: `dpa-prio:${key}`, actor: DISPATCHER_ACTOR, changes: batch })).changed;
    }
    return changed;
  }

  async #checkpoint(attemptId: string, reason: string): Promise<JsonObject | undefined> {
    const live = this.#live.get(attemptId);
    const d = await this.#load(attemptId);
    if (live === undefined || d === undefined) return undefined;
    const checkpoint = await live.handle.checkpoint();
    // Fenced by placement: a checkpoint that comes back after the attempt was moved (or its worker replaced) is the old placement's and is discarded, so it never overwrites the record the new placement continues from.
    const after = await this.#load(attemptId);
    if (this.#live.get(attemptId) !== live || after === undefined || after.body.hostId !== d.body.hostId || after.body.state === "finished") return undefined;
    await this.#deps.checkpoints?.({ attemptId, taskId: d.body.taskId, agentId: d.body.agentId, reason, checkpoint });
    return checkpoint;
  }

  async #usage(attemptId: string, usage: TurnUsage, requestKey?: string): Promise<void> {
    if (this.#deps.budgets === undefined) return;
    const d = await this.#running(attemptId);
    if (usage === null || typeof usage !== "object") invalid("usage", "must be an object");
    onlyKnown(usage, ["turnSeq", "costMicros", "computeMs", "cache"]);
    if (usage.turnSeq !== undefined && !(Number.isSafeInteger(usage.turnSeq) && usage.turnSeq >= 0)) invalid("turnSeq", "must be a whole number from 0");
    // Cache figures alone are a record too (a local server costs nothing but still reports what its cache did).
    if (usage.costMicros === undefined && usage.computeMs === undefined && usage.cache === undefined) return;
    const seq = (this.#usageSeq.get(attemptId) ?? 0) + 1;
    this.#usageSeq.set(attemptId, seq);
    // A worker-side turn sequence is the idempotency key when there is one: the same report sent again is the same charge, and a different report under that number is a conflict.
    // A remote worker's request key (its Idempotency-Key) serves the same way when there is no turn sequence, so a resent request is charged once.
    const key = usage.turnSeq === undefined && requestKey !== undefined ? `k${createHash("sha256").update(requestKey).update("\0").update(JSON.stringify(usage)).digest("hex").slice(0, 32)}` : usage.turnSeq === undefined ? `${d.body.heartbeats}:${this.#instance}:${seq}:${createHash("sha256").update(JSON.stringify(usage)).digest("hex").slice(0, 24)}` : `t${usage.turnSeq}`;
    // While a reservation is held the amounts are added to the attempt's own tally and settled when it ends (the hold already counts against the task); the cache figures are still recorded turn by turn.
    const reserved = d.body.reservationId !== undefined;
    if (reserved) {
      const digest = createHash("sha256").update(JSON.stringify(usage)).digest("hex").slice(0, 24);
      await this.#update(attemptId, (x) => {
        const seen = x.usedKeys?.find((k) => k.key === key);
        if (seen !== undefined) {
          if (seen.digest !== digest) throw new DomainError("command_conflict", `usage report ${key} was already received with different figures`, { field: "turnSeq" });
          return x; // the same report again: counted once
        }
        return { ...x, usedKeys: [...(x.usedKeys ?? []).slice(-199), { key, digest }], used: { costMicros: (x.used?.costMicros ?? 0) + (usage.costMicros ?? 0), computeMs: (x.used?.computeMs ?? 0) + (usage.computeMs ?? 0) } };
      });
      if (usage.cache === undefined) return;
    }
    await this.#deps.budgets.charge(this.#deps.principal, {
      commandId: `dpa-use:${attemptId}:${key}`, activity: "model-call", taskId: d.body.taskId, agentId: d.body.agentId,
      ...(reserved ? {} : { ...(usage.costMicros === undefined ? {} : { costMicros: usage.costMicros }), ...(usage.computeMs === undefined ? {} : { computeMs: usage.computeMs }) }), ...(usage.cache === undefined ? {} : { cache: usage.cache }),
    });
  }
}

const errorText = (error: unknown): string => (error instanceof Error ? error.message : "failed").slice(0, 300);
type ClaimOutcome = { kind: "failed"; error: string } | { kind: "claimed" } | { kind: "skipped"; check: DispatchCheck; reason: string } | { kind: "blocked"; check: DispatchCheck; blockerId: string };
type AdvanceOutcome = { kind: "started" } | { kind: "waiting"; reason?: string } | { kind: "skipped"; check: DispatchCheck; reason: string } | { kind: "blocked"; check: DispatchCheck; blockerId: string };

/** A limit of 0 states no limit; a limit that is set is used up when what was spent (and what may have been) reaches it. */
const exhausted = (limit: number, used: number): boolean => limit > 0 && used >= limit;
