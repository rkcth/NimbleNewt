import { createHash, randomUUID } from "node:crypto";
import type { AssignmentService } from "../domain/assignments.js";
import type { BlockerService } from "../domain/blockers.js";
import type { EffectBridge } from "../domain/effects.js";
import { mergeChanges } from "../domain/changes.js";
import type { EffectService } from "../domain/effects.js";
import { DomainError, isDomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { AdmissionService } from "../admission/index.js";
import type { BudgetService } from "../budgets/index.js";
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
import type { Principal } from "../security/principals.js";
import { DISPATCHER_PRINCIPAL, type TaskCredentialService } from "../security/task-credentials.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";
import { DISPATCHER_ACTOR, DISPATCH_KIND, DISPATCH_LIMITS, type DispatchBody, type DispatchRevisions, type Frozen, type ToolIdentity, type ToolOperationBody } from "./model.js";
import { ToolPath, type Loaded } from "./tools.js";
import type { HostProbe, RecipeSummary, ToolGateway, WorkerTurnResult, TurnUsage, WorkOrder, WorkerHandle, WorkerHost } from "./ports.js";

/** The record of live dispatches: the attempts that have a claim and have not finished. Ticks read it instead of scanning every dispatch ever made. */
const LIVE: AggregateRef = { kind: "dispatch-live", id: "live" };
const LIVE_MAX = 600;
/** Where the scan of assignments stopped (card H12c): the next tick, of this process or of one after a restart, goes on from there instead of from the beginning. */
const CURSOR: AggregateRef = { kind: "dispatch-cursor", id: "scan" };
const clip = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 3)}...` : s);
const ATTEMPT = /^att-[a-z2-7]{20}$/;
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
  /** How long an attempt may run (shortened by the contract's `maxMinutes`). Default four hours. */
  readonly attemptMs?: number;
  /** Attempts the dispatcher itself admits after a lost one (contract `maxAttempts` wins). Default 3 in all. */
  readonly maxAttempts?: number;
  /** After this many ticks in a row in which an attempt pinned to a host could not start because that host was unavailable, a blocker names the owner (who can move it). Default 5. */
  readonly pinnedStaleTicks?: number;
  /** Assignments looked at per tick. Default 100. */
  readonly scanPage?: number;
  /** How long the dispatcher expects an attempt to run when the contract says nothing, for the meeting check (M04). Default 30 minutes. */
  readonly expectedMinutes?: number;
  readonly catalog?: ActionCatalog;
  /** The bridge for each effect kind, so an effect that was started before a restart is reconciled without the worker. */
  readonly bridges?: Readonly<Record<string, EffectBridge>>;
}

export type DispatchCheck = "generation" | "checkout" | "pause" | "decision" | "revalidation" | "meeting" | "harness" | "route" | "budget" | "grant" | "host" | "place" | "expired";

export interface TickReport {
  readonly at: string;
  readonly started: readonly string[];
  /** Attempts whose request waits for a place. */
  readonly waiting: readonly string[];
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
  readonly #options: Required<Pick<AttemptDispatcherOptions, "leaseMs" | "attemptMs" | "maxAttempts" | "scanPage" | "expectedMinutes">> & AttemptDispatcherOptions;
  readonly #holder: string;
  readonly #live = new Map<string, Live>();
  readonly #path: ToolPath;
  /** Names this dispatcher in the commands of its updates: two dispatchers that read one revision must not share a command (the second would be answered with the first's result). */
  readonly #instance = randomUUID().slice(0, 8);
  /** Usage reports made per attempt by this dispatcher, so two turns with identical figures are two records. */
  readonly #usageSeq = new Map<string, number>();
  readonly #ending = new Set<Promise<unknown>>();
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
    this.#options = { leaseMs: DISPATCH_LIMITS.leaseMs, attemptMs: DISPATCH_LIMITS.attemptMs, maxAttempts: DISPATCH_LIMITS.maxAttempts, scanPage: DISPATCH_LIMITS.scanPage, expectedMinutes: 30, ...options };
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
    const started: string[] = [], waiting: string[] = [], lost: string[] = [], readmitted: string[] = [];
    const skipped: { taskId: string; attemptId: string; check: DispatchCheck; reason: string }[] = [];
    const blocked: { taskId: string; attemptId: string; check: DispatchCheck; blockerId: string }[] = [];
    const approvals: { attemptId: string; operationId: string; verdict: "approved" | "denied" | "expired" }[] = [];
    const failures: { taskId: string; attemptId: string; error: string }[] = [];
    const live = await this.#liveIds();
    // 1. Leases and time. A worker that stopped beating, or an attempt past its expiry, is over; its calls are settled through the ledger first.
    for (const id of live) {
      const d = await this.#load(id);
      if (d === undefined || (d.body.state !== "running" && d.body.state !== "parked")) continue;
      const expired = d.body.expiresAt <= at;
      if (expired || (d.body.state === "running" && d.body.lease !== undefined && d.body.lease.until <= at)) {
        const result = await this.#end(id, "abandoned", expired ? "the attempt ran past its expiry" : "the worker stopped beating; its lease ran out", { readmit: !expired, lost: !expired });
        lost.push(id);
        if (result.readmitted !== undefined) readmitted.push(result.readmitted);
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
      else if (outcome.kind === "waiting") waiting.push(id);
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
        else if (next.kind === "waiting") waiting.push(found.attemptId);
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
    return { at, started, waiting, skipped, blocked, lost, readmitted, reprioritized, approvals, loops, failures, scanned: scan.scanned, complete: scan.complete };
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
    await this.dropWorkers();
    return { closed, errors };
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
      if (taskId !== undefined) await this.#deps.activity({ commandId: `dpa-act:${attemptId}:${key}`.slice(0, 120), taskId, kind, summary: summary.slice(0, 300), refs });
    } catch { /* the record of a step never changes what happened */ }
  }

  /** The worker is alive: extends its lease. Refused (`fenced`) once the attempt is no longer the task's current one, so a stale worker learns it has lost. */
  async heartbeat(attemptId: string): Promise<{ until: string }> {
    const d = await this.#running(attemptId);
    await this.#assertCurrent(d.body);
    const now = this.#runner.now();
    const until = new Date(Date.parse(now) + this.#options.leaseMs).toISOString();
    await this.#update(attemptId, (b) => ({ ...b, lease: { holder: this.#holder, until }, heartbeats: b.heartbeats + 1, lastHeartbeatAt: now }));
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
  async freeze(by: Principal, attemptId: string, reason: string): Promise<void> {
    const d = await this.#controlled(by, attemptId);
    if (typeof reason !== "string" || reason.length < 1 || reason.length > 300) invalid("reason", "must be 1 to 300 characters");
    const frozen: Frozen = { reason, at: this.#runner.now() };
    await this.#update(d.body.attemptId, (b) => ({ ...b, frozen: b.frozen ?? frozen }));
  }

  /** Lifts a freeze. */
  async release(by: Principal, attemptId: string): Promise<void> {
    const d = await this.#controlled(by, attemptId);
    await this.#update(d.body.attemptId, (b) => { const { frozen: _f, ...rest } = b; void _f; return rest; });
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
    await this.#update(d.body.attemptId, (b) => { const { frozen: _f, ...rest } = b; void _f; return { ...rest, recipeRevision: change.recipe.revision }; });
    return { restarted: true, recipeRevision: change.recipe.revision };
  }

  /**
   * Stops an attempt. An ordinary stop freezes, lets the calls settle, checkpoints and then ends the worker; an emergency stop (`emergency: true`) ends the worker at once, with no settle and no
   * checkpoint, and the calls in flight are recorded from the ledger as they stand (cancelled, or uncertain when an effect had started). The attempt ends `abandoned` and the task is left as it is.
   */
  async stop(by: Principal, attemptId: string, options: { emergency?: boolean; reason: string }): Promise<void> {
    const d = await this.#controlled(by, attemptId);
    if (typeof options.reason !== "string" || options.reason.length < 1 || options.reason.length > 300) invalid("reason", "must be 1 to 300 characters");
    if (options.emergency !== true) {
      await this.freeze(by, attemptId, options.reason);
      await this.settle(by, attemptId, { cancel: true });
      await this.#checkpoint(attemptId, options.reason);
    }
    await this.#end(d.body.attemptId, "abandoned", options.reason, { readmit: false });
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
    await this.#update(attemptId, (x) => {
      const { requestId: _r, lease: _l, frozen: _f, ...rest } = x; void _r; void _l; void _f;
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
    const minutes = contract.maxMinutes === undefined ? this.#options.attemptMs : Math.min(this.#options.attemptMs, contract.maxMinutes * 60_000);
    const body: DispatchBody = {
      attemptId, taskId, projectId: task.projectId, agentId: pre.agentId, generation: attempt.generation, state: "waiting",
      ...(pre.harness === undefined ? {} : { harness: pre.harness }), route: pre.route.route, role: pre.route.role, request: pre.route.request,
      revisions: await this.#revisions(task.projectId, taskId, contract.version, pre.route),
      hostId: pre.host.hostId, claimedAt: now, expiresAt: new Date(Date.parse(now) + minutes).toISOString(), heartbeats: 0, inFlight: [], parked: [], calls: 0,
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
      const advice = await this.#deps.meetings.admission(this.#deps.principal, { agent: agentId, expectedMinutes: (await this.#contractOf(taskId)).maxMinutes ?? this.#options.expectedMinutes, yieldsAtBoundary });
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
    const probe: HostProbe = { attemptId, taskId, projectId: task.projectId, agentId, generation: (await this.#load(attemptId))?.body.generation ?? 0, ...(chosen.harness === undefined ? {} : { harness: chosen.harness }), route: chosen.route, expiresAt: (await this.#load(attemptId))?.body.expiresAt ?? this.#runner.now() };
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

  async #missingGrants(agentId: string, projectId: string, taskId: string, tools: readonly string[]): Promise<string[]> {
    if (tools.length === 0) return [];
    const stored = (await this.#runner.get("principal", agentId))?.body as unknown as { grants: readonly { action: string; project: string; resource?: { kind: string; id: string }; expiresAt?: string }[]; kind: string; state: string } | undefined;
    if (stored === undefined || stored.state !== "active") return tools.slice();
    const held = await this.#agentGrants(agentId);
    return tools.filter((t) => !held(t, projectId, taskId));
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
    const reasons: string[] = [];
    let revoked = 0; let refused = 0;
    // An attempt pinned to a host (it was relocated there, or it parked on it and the host owns its store) goes nowhere else: it waits for that host, and the owner can move it.
    const candidates = pinned === undefined ? this.#deps.workers : this.#deps.workers.filter((w) => w.hostId === pinned);
    if (pinned !== undefined && candidates.length === 0) return { kind: "none", reason: `${pinned} is not a worker host of this dispatcher, and the attempt may run only there`, blocked: false };
    for (const worker of candidates) {
      const status = await this.#deps.hosts.status(this.#deps.principal, worker.hostId);
      if (status === undefined) { reasons.push(`${worker.hostId} is not an enrolled host`); continue; }
      if (status.identity !== "active") { revoked++; reasons.push(`${worker.hostId} is revoked`); continue; }
      if (status.freshness !== "fresh") { reasons.push(`${worker.hostId} has not been heard from recently (${status.freshness})`); continue; }
      if (harness !== undefined && status.capabilities !== undefined && !status.capabilities.harnesses.some((h) => h.name === harness)) { reasons.push(`${worker.hostId} does not have the ${harness} harness`); continue; }
      // A host that would refuse the attempt (policy, what it can do, no connection) is passed over: the next one is tried, and the plan says why this one was not.
      if (worker.refuses !== undefined) {
        // A host that cannot say is tried, and the placement judges it as before; only a clear answer passes it over.
        let why: { readonly reasons: readonly string[]; readonly lasting: boolean } = { reasons: [], lasting: false };
        try { why = await worker.refuses(probe); } catch (error) { this.#options.onError?.(error); }
        if (why.reasons.length > 0) { if (why.lasting) refused++; reasons.push(why.reasons.join('; ')); continue; }
      }
      return { kind: "ok", host: worker };
    }
    return { kind: "none", reason: reasons.length === 0 ? "no worker host is configured" : reasons.join("; "), blocked: candidates.length === 0 || revoked === candidates.length, ...(refused > 0 && refused + revoked === candidates.length ? { refused: true as const } : {}) };
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
    if (b.expiresAt <= this.#runner.now()) { await this.#end(b.attemptId, "abandoned", "the attempt expired before it was started", { readmit: false }); return { kind: "skipped", check: "expired", reason: "the attempt expired before it started" }; }
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
    if (where.state !== "running") return where.state === "waiting" ? { kind: "waiting" } : { kind: "skipped", check: "place", reason: where.state === "withdrawn" ? `the request for a place was withdrawn: ${where.reason}` : "the request for a place is gone" };
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
      const ms = Math.min(this.#options.attemptMs ?? 4 * 3_600_000, contract.maxMinutes === undefined ? Number.MAX_SAFE_INTEGER : contract.maxMinutes * 60_000);
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
    const asked = await this.#deps.admission.request({ commandId: `dpa-req:${d.body.attemptId}:${n}`, actor: DISPATCHER_ACTOR, class: "productive", priority, host: host.hostId, cpus: host.resources.cpus, memoryMb: host.resources.memoryMb });
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
    const credential = await this.#deps.credentials.issueForAttempt(this.#deps.principal, { commandId: `dpa-cred:${b.attemptId}`, attemptId: b.attemptId, expiresAt: b.expiresAt });
    const credentialId = credential.token.slice(0, credential.token.lastIndexOf("."));
    const environment = await this.#pin(b);
    await this.#update(b.attemptId, (x) => ({ ...x, credentialId, revisions: { ...x.revisions, ...(environment === undefined ? {} : { environment }) } }));
    const recipe: RecipeSummary = { revision: `r-${b.attemptId.slice(4, 16)}`, reach: [] };
    const order: WorkOrder = {
      attemptId: b.attemptId, taskId: b.taskId, projectId: b.projectId, agentId: b.agentId, generation: b.generation, ...(b.harness === undefined ? {} : { harness: b.harness }), route: b.route, credential: credential.token, recipe,
      content: await this.#contentOf(b.taskId) + await this.#policyNote(b), requestId: `cmd:adm:${b.attemptId}`, expiresAt: b.expiresAt,
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
  async #end(attemptId: string, outcome: "succeeded" | "failed" | "abandoned", summary: string, options: { readmit: boolean; lost?: boolean }): Promise<{ readmitted?: string }> {
    // `idle()` waits for every end in progress, not only for the turns: an attempt leaves the live list part-way through its end, and the blocker for a failure is opened after that.
    // Two paths can end the same attempt at once (the worker's result and the lease scan): the second joins the first, whose outcome stands. Its own would reuse the first's command IDs with a different summary.
    const already = this.#endingBy.get(attemptId);
    if (already !== undefined) return already;
    // The reason may be a worker's or a model's error text, which the records refuse if it holds control characters or half a character: an attempt must always be able to end.
    const clean = Array.from(summary.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\ud800-\udfff]/g, "?")).slice(0, 1000).join("").trim();
    const ending = this.#endInner(attemptId, outcome, clean === "" ? `the attempt ${outcome}` : clean, options);
    this.#ending.add(ending);
    this.#endingBy.set(attemptId, ending);
    try { return await ending; } finally { this.#ending.delete(ending); if (this.#endingBy.get(attemptId) === ending) this.#endingBy.delete(attemptId); }
  }

  async #endInner(attemptId: string, outcome: "succeeded" | "failed" | "abandoned", summary: string, options: { readmit: boolean; lost?: boolean }): Promise<{ readmitted?: string }> {
    const d = await this.#load(attemptId);
    if (d === undefined || d.body.state === "finished") return {};
    const live = this.#live.get(attemptId);
    if (live !== undefined) await live.handle.stop().catch(() => undefined);
    await this.#path.settle(attemptId, true).catch(() => undefined);
    await this.#path.cancelParked(attemptId).catch(() => undefined);
    const b = (await this.#load(attemptId))!.body;
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
    if (active) await this.#contextAtEnd(b, outcome, summary);
    await this.#update(attemptId, (x) => ({ ...x, state: "finished", inFlight: [], parked: [], outcome: { status: outcome, summary: summary.slice(0, 500), at: this.#runner.now() } }), () => this.#liveChange(attemptId, false));
    this.#live.delete(attemptId);
    this.#usageSeq.delete(attemptId);
    if (outcome === "failed") {
      const opened = await this.#deps.blockers.openBlocker({ commandId: `dpa-blk:failed:${attemptId}`, actor: DISPATCHER_ACTOR, type: "dispatch_blocked", subject: { kind: "task", id: b.taskId }, summary: `Attempt ${attemptId} failed (${summary.slice(0, 300)}); the task is as it was and no further attempt starts by itself.`, resolver: "owner" });
      await this.#deps.notifications?.emitFromController({ commandId: `dpa-ntf:${opened.id}`, kind: "blocker", ref: { kind: "blocker", id: opened.id }, projectId: b.projectId }).catch(() => undefined);
    }
    return options.readmit ? this.#readmit(b) : {};
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
  async #contextAtEnd(b: DispatchBody, outcome: "succeeded" | "failed" | "abandoned", summary: string): Promise<void> {
    const context = this.#deps.context;
    if (context === undefined) return;
    // The reason comes from the worker or the model: control characters become spaces, the cut is on whole characters, and a blank one gets a plain sentence (the context service refuses text it cannot store).
    const clip = (n: number): string => { const t = Array.from(summary.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ").replace(/[\ud800-\udfff]/g, "?")).slice(0, n).join("").trim(); return t === "" ? `the attempt ${outcome}` : t; };
    const guarded = async (step: () => Promise<unknown>): Promise<void> => { try { await step(); } catch (error) { this.#options.onError?.(error); } };
    // An attempt that ran within budget starts the count again; one that failed for want of context is counted. Each step stands on its own: a refusal of one must not skip the hand-off.
    if (outcome === "succeeded") await guarded(() => context.resetOverflow(this.#deps.principal, { taskId: b.taskId, attemptId: b.attemptId }));
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
  async #readmit(b: DispatchBody): Promise<{ readmitted?: string }> {
    const assignment = await this.#deps.assignments.getAssignment(b.taskId);
    if (assignment === undefined || assignment.state !== "assigned" || assignment.generation !== b.generation || assignment.activeAttemptId !== undefined || assignment.owner === undefined) return {};
    const contract = await this.#contractOf(b.taskId);
    const allowed = contract.maxAttempts ?? this.#options.maxAttempts;
    if (assignment.attempts >= allowed) {
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
type AdvanceOutcome = { kind: "started" } | { kind: "waiting" } | { kind: "skipped"; check: DispatchCheck; reason: string } | { kind: "blocked"; check: DispatchCheck; blockerId: string };

/** A limit of 0 states no limit; a limit that is set is used up when what was spent (and what may have been) reaches it. */
const exhausted = (limit: number, used: number): boolean => limit > 0 && used >= limit;
