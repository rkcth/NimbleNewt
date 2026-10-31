import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { classifyFailure } from "../context/budget.js";
import { ROUTING_LIMITS, checkRequest, type RouteRequest } from "./policy.js";
import type { RoutingService } from "./service.js";

export type FailureClass = "credit" | "rate-limit" | "outage" | "auth" | "context-overflow" | "invalid-request" | "unknown";
export interface Attempt {
  readonly route: string;
  readonly at: string;
  readonly outcome: "started" | "succeeded" | "failed" | "abandoned" | "skipped";
  /** When the dispatcher confirmed it was about to send the request (`sent`); a running attempt that was sent is left alone by a later control, one not yet sent is not dispatched to a route that has since been blocked. */
  readonly sentAt?: string;
  /** Why an attempt was abandoned (a cutover, or a route that became unavailable while the call was being dispatched). */
  readonly abandoned?: string;
  /** When it was abandoned. */
  readonly endedAt?: string;
  readonly failure?: { readonly class: FailureClass; readonly message: string };
  readonly usage?: Usage;
}
export interface Usage { readonly inputTokens: number; readonly outputTokens: number; /** Money, in millionths of the account currency; 0 for a local route. */ readonly costMicros: number }
export interface EffectState { readonly id: string; readonly state: "intended" | "uncertain" | "confirmed" | "failed" }
/** A possible or settled charge for an attempt that was abandoned while a paid provider may still have been working on it. */
export interface Charge { readonly attempt: number; readonly route: string; readonly status: "possible" | "confirmed" | "none"; readonly costMicros?: number; readonly at: string }
/** A report that arrived for an attempt that is no longer current; it was not applied. */
export interface LateReport { readonly attempt: number; readonly route: string; readonly kind: "succeeded" | "failed"; readonly at: string; readonly usage?: Usage }
/** The ordered list the call is working through (resolved from the routing table when the call began) and where in it the current attempt is. */
export interface ListPosition { readonly profile: string; readonly routes: readonly string[]; readonly index: number }
/**
 * A rule outside the routing table that every dispatch obeys (card R04: exclusions below the provider, drains and failback). `blocked` says why a route may not be used for new work
 * right now (empty when it may); `failure` lets the gate learn from an availability failure (idempotent by `key`).
 */
export interface RouteGate {
  /** `callId` lets a half-open trial dispatch, once granted to a call, pass for that call. */
  blocked(route: string, callId?: string, claim?: boolean): Promise<readonly string[]>;
  failure?(failure: { route: string; class: FailureClass; at: string; key: string }): Promise<void>;
  /** A call succeeded on a route (a successful half-open trial returns the target). */
  success?(success: { route: string; callId: string }): Promise<void>;
  /** Housekeeping the gate does on a dispatcher's call: expired drains become cutovers and pending cancellations are carried out. */
  tick?(by: Principal): Promise<void>;
}
export interface InFlight { readonly callId: string; readonly taskId: string; readonly route: string; readonly attempt: number; readonly since: string }

export interface CallBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly request: RouteRequest;
  readonly attempts: readonly Attempt[];
  readonly state: "running" | "succeeded" | "waiting" | "failed";
  readonly waiting?: { readonly reason: string; readonly until?: string; readonly why: readonly string[] };
  /** Why a failed call ended. */
  readonly ended?: { readonly reason: string; readonly why: readonly string[] };
  readonly routingRevision: number;
  /** Position in the ordered list, kept so a restart or a later retry continues where this call was. */
  readonly list?: ListPosition;
  readonly charges?: readonly Charge[];
  readonly late?: readonly LateReport[];
  /** Effects reported by the caller; none of them is ever repeated by a fallback. */
  readonly effects: readonly EffectState[];
  readonly createdBy: string;
}
export interface BudgetBody { readonly maxCostMicros?: number; readonly maxTokens?: number; /** How many failed attempts the task may have in all, across calls, routes and rebuilt contexts. */ readonly maxFailedAttempts?: number; readonly setBy: string }
export interface SpendBody { readonly costMicros: number; readonly tokens: number; readonly calls: number; /** Failed attempts (absent in entries written before they were counted). */ readonly failures?: number }
export type Step =
  | { readonly kind: "route"; readonly callId: string; readonly route: string; readonly attempt: number; readonly doNotRepeat: readonly string[] }
  | { readonly kind: "wait"; readonly callId: string; readonly reason: string; readonly until?: string; readonly why: readonly string[] }
  | { readonly kind: "failed"; readonly callId: string; readonly reason: string };

/** Attempts that count toward the limit: those not skipped before being sent. */
const used = (attempts: readonly { readonly outcome: string }[]): number => attempts.filter((a) => a.outcome !== "skipped").length;
export const FALLBACK_LIMITS = { attempts: 4, message: 300, effects: 100, rateLimitSeconds: 60, outageSeconds: 300, late: 20, charges: 10 } as const;
const spendKind = (taskId: string): string => `msp-${taskId}`;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const count = (v: unknown, field: string): number => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= 1e15 ? (v as number) : invalid(field, "must be a whole number from 0"));

/** Sorts a provider failure into the kinds that decide what happens next. Pattern matching on messages and status codes, to be replaced by typed reasons where a provider gives them. */
export function classifyProviderFailure(failure: { message: string; status?: number }): FailureClass {
  const m = failure.message;
  const rate = /rate[ _-]?limit|too many requests|per[ _-]?(?:minute|day|second)|requests? per|tokens per/i.test(m);
  if (classifyFailure(m) === "context_overflow" && !rate) return "context-overflow";
  // Billing wording is credit; a quota that is "per minute" or "per day" is a rate limit, and a bare 429 is a rate limit.
  if (!rate && (failure.status === 402 || /insufficient[ _](?:credit|funds)|credit balance|billing|payment required|out of credits|exceeded your current quota|insufficient_quota/i.test(m))) return "credit";
  if (rate || failure.status === 429) return "rate-limit";
  if (/quota exceeded/i.test(m)) return "credit";
  if (failure.status === 401 || /invalid api key|incorrect api key|unauthori[sz]ed|authentication (?:failed|error|required)|invalid x-api-key/i.test(m)) return "auth";
  if ((failure.status !== undefined && failure.status >= 500) || /overloaded|unavailable|timed? ?out|econnreset|econnrefused|enotfound|socket hang up|bad gateway|service is down|outage/i.test(m)) return "outage";
  if (failure.status === 400 || failure.status === 422 || /invalid[_ ]request|malformed|unsupported/i.test(m)) return "invalid-request";
  return "unknown";
}

/**
 * Provider failure classification, bounded fallback and cumulative budgets for model calls (card R02). A call is one request to a model; the dispatcher asks `begin`, gets a route
 * (chosen by the routing table as it is now, skipping routes already tried), and reports `failed` or `succeeded`. A credit, rate-limit or outage failure moves to the next eligible
 * route, at most four attempts in all; a context overflow, an invalid request or an unknown failure is not retried elsewhere (they would fail the same way, or need a person); an
 * authentication or credit failure also skips the rest of that provider for this call. When nothing eligible is left the call **waits visibly**, saying why and until when, and
 * `resume` tries again when the table or the cooldowns have changed. A fallback never repeats an external effect: the caller reports the effects of the failed attempt; if any is
 * uncertain the call waits for reconciliation instead of trying another route, and the route step lists the effects that must not be done again. Spend is added up per task across
 * every attempt, and a task over its budget does not begin a call.
 */
export class FallbackService {
  readonly #runner: CommandRunner;
  readonly #routing: RoutingService;
  readonly #gate: RouteGate | undefined;

  private constructor(runner: CommandRunner, routing: RoutingService, gate: RouteGate | undefined) { this.#runner = runner; this.#routing = routing; this.#gate = gate; }

  /** `gate` adds the rules of card R04 (exclusions below the provider, drains, health and failback) to every dispatch decision. */
  static withEpoch(storage: ControllerStorage, epoch: number, routing: RoutingService, options: RunnerOptions = {}, gate?: RouteGate): FallbackService {
    return new FallbackService(new CommandRunner(storage, epoch, options), routing, gate);
  }

  /** The owner caps what a task may spend across all calls and fallbacks. */
  async setBudget(owner: Principal, command: NoActor & { taskId: string; maxCostMicros?: number | null; maxTokens?: number | null; maxFailedAttempts?: number | null }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner sets a spending budget`);
    onlyKnown(command, ["commandId", "taskId", "maxCostMicros", "maxTokens", "maxFailedAttempts"]);
    const taskId = checkTaskId(command.taskId);
    // A field left out keeps what the owner set before (raising one limit does not clear the others); a field given as null removes that limit (no limit is the default).
    const previous = (await this.#runner.get("model-budget", taskId))?.body as unknown as BudgetBody | undefined;
    const field = (name: "maxCostMicros" | "maxTokens" | "maxFailedAttempts"): { [k: string]: number } => {
      const given = command[name];
      if (given === null) return {};
      if (given !== undefined) return { [name]: count(given, name) };
      return previous?.[name] === undefined ? {} : { [name]: previous[name] as number };
    };
    const body: BudgetBody = { ...field("maxFailedAttempts"), ...field("maxCostMicros"), ...field("maxTokens"), setBy: owner.id };
    const ref: AggregateRef = { kind: "model-budget", id: taskId };
    await this.#runner.command("model.budget", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { taskId, budget: body as unknown as JsonObject },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        return { ref, creates: current === undefined, changes: [current === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { taskId } };
      },
    }));
  }

  /** The limits the owner set for a task, or undefined. */
  async budget(taskId: string): Promise<BudgetBody | undefined> { return (await this.#runner.get("model-budget", checkTaskId(taskId)))?.body as unknown as BudgetBody | undefined; }

  /** What a task has spent: the sum of its calls' entries (each call writes only its own, so calls of one task never collide). */
  async spend(taskId: string): Promise<SpendBody> {
    const kind = spendKind(checkTaskId(taskId));
    let total: SpendBody = { costMicros: 0, tokens: 0, calls: 0, failures: 0 };
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(kind, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) { after = a.id; const b = a.body as unknown as SpendBody; total = { costMicros: total.costMicros + b.costMicros, tokens: total.tokens + b.tokens, calls: total.calls + b.calls, failures: (total.failures ?? 0) + (b.failures ?? 0) }; }
      if (page.length < 200) return total;
    }
  }

  /** Starts a call: the first eligible route, or a visible wait (no route, or the task's budget is used up). */
  async begin(by: Principal, command: NoActor & { taskId: string; request: unknown }): Promise<Step> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "taskId", "request"]);
    const taskId = checkTaskId(command.taskId);
    const request = checkRequest(command.request);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", "no such task");
    const callId = derivedId("mcl", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: "model-call", id: callId };
    await this.#runner.command("model.begin", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, request: request as unknown as JsonObject },
      build: async () => {
        const decided = await this.#decide(taskId, request, [], undefined, undefined, false, callId);
        const body: CallBody = { taskId, projectId: task.projectId, request, attempts: decided.route === undefined ? [] : [{ route: decided.route, at: this.#runner.now(), outcome: "started" }], state: decided.route === undefined ? "waiting" : "running", ...(decided.route === undefined ? { waiting: decided.waiting! } : {}), routingRevision: decided.revision, ...this.#position(decided, undefined), effects: [], createdBy: by.id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, route: decided.route ?? null } };
      },
    }));
    return this.#checked(by, callId);
  }

  /** The current state of a call as a step. */
  async step(by: Principal, callId: string): Promise<Step> {
    this.#dispatcher(by);
    await this.#gate?.tick?.(by);
    return this.#checked(by, this.#id(callId));
  }

  /** The dispatcher is about to send the request of this attempt. From now on a control does not take the attempt back except by a cutover (which cancels it). */
  async sent(by: Principal, command: NoActor & { callId: string; attempt: number }): Promise<void> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "callId", "attempt"]);
    const callId = this.#id(command.callId);
    const attemptNo = count(command.attempt, "attempt");
    const ref: AggregateRef = { kind: "model-call", id: callId };
    await this.#runner.command("model.sent", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { callId, attempt: attemptNo },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const call = found?.body as unknown as CallBody | undefined;
        if (found === undefined || call === undefined) throw new DomainError("not_found", "no such call");
        const last = call.attempts.at(-1);
        if (call.state !== "running" || last === undefined || last.outcome !== "started" || attemptNo !== call.attempts.length) throw new DomainError("invalid_transition", "that call has no such attempt in progress");
        const next: CallBody = { ...call, attempts: [...call.attempts.slice(0, -1), { ...last, sentAt: last.sentAt ?? this.#runner.now() }] };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { callId, attempt: attemptNo } };
      },
    }));
  }

  /** The attempt failed. Classifies it and, when a fallback is allowed, chooses the next route; otherwise waits visibly or fails. */
  async failed(by: Principal, command: NoActor & { callId: string; attempt?: number; failure: { message: string; status?: number }; usage?: Usage; effects?: readonly EffectState[] }): Promise<Step> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "callId", "attempt", "failure", "usage", "effects"]);
    const attemptNo = command.attempt === undefined ? undefined : count(command.attempt, "attempt");
    const callId = this.#id(command.callId);
    const message = redactText(typeof command.failure?.message === "string" ? command.failure.message : invalid("failure.message", "must be text")).slice(0, FALLBACK_LIMITS.message);
    const status = command.failure.status === undefined ? undefined : count(command.failure.status, "failure.status");
    const cls = classifyProviderFailure({ message, ...(status === undefined ? {} : { status }) });
    const usage = command.usage === undefined ? undefined : this.#usage(command.usage);
    const effects = this.#effects(command.effects ?? []);
    const ref: AggregateRef = { kind: "model-call", id: callId };
    await this.#runner.command("model.failed", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { callId, attempt: attemptNo ?? null, message, status: status ?? null, cls, usage: (usage ?? null) as unknown as JsonObject, effects: effects as unknown as JsonObject[] },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const call = found?.body as unknown as CallBody | undefined;
        if (found === undefined || call === undefined) throw new DomainError("not_found", "no such call");
        const last = call.attempts.at(-1);
        const stale = this.#stale(call, attemptNo);
        if (stale !== undefined) return this.#lateReport(found.revision, ref, call, stale, "failed", usage);
        if (call.state !== "running" || last === undefined || last.outcome !== "started") throw new DomainError("invalid_transition", "that call has no attempt in progress");
        const attempts: Attempt[] = [...call.attempts.slice(0, -1), { ...last, outcome: "failed", failure: { class: cls, message }, ...(usage === undefined ? {} : { usage }) }];
        const allEffects = this.#mergeEffects(call.effects, effects);
        let next: CallBody;
        let extra: Change[] = [];
        // Every failed attempt is counted against the task, with or without a usage report, so a new call or a rebuilt context does not start the count again.
        extra = await this.#charge(call.taskId, callId, usage ?? { inputTokens: 0, outputTokens: 0, costMicros: 0 }, usage !== undefined, 1);
        if (allEffects.some((e) => e.state === "uncertain")) {
          next = { ...call, attempts, effects: allEffects, state: "waiting", waiting: { reason: "an effect of the failed attempt is uncertain; it must be reconciled before any other route is tried", why: allEffects.filter((e) => e.state === "uncertain").map((e) => `effect ${e.id} is uncertain`) } };
        } else if (cls === "context-overflow" || cls === "invalid-request" || cls === "unknown") {
          next = { ...call, attempts, effects: allEffects, state: "failed", ended: { reason: cls === "context-overflow" ? "the context did not fit; rebuild it (C07) rather than trying another route" : `${cls} failures are not retried on another route`, why: [message] } };
        } else if (used(attempts) >= FALLBACK_LIMITS.attempts) {
          next = { ...call, attempts, effects: allEffects, state: "failed", ended: { reason: `${FALLBACK_LIMITS.attempts} attempts have failed`, why: attempts.map((a) => `${a.route}: ${a.failure?.class ?? a.outcome}`) } };
        } else {
          const decided = await this.#decide(call.taskId, call.request, attempts, usage, undefined, false, callId, 1);
          next = decided.route === undefined
            ? { ...call, attempts, effects: allEffects, state: "waiting", waiting: decided.waiting! }
            : { ...call, attempts: [...attempts, { route: decided.route, at: this.#runner.now(), outcome: "started" }], effects: allEffects, state: "running", routingRevision: decided.revision, ...this.#position(decided, call.list) };
        }
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...extra], detail: { callId, class: cls, state: next.state } };
      },
    }));
    await this.#learn(callId, cls);
    return this.#checked(by, callId);
  }

  /** The attempt succeeded: its usage is added to the task's spend. */
  async succeeded(by: Principal, command: NoActor & { callId: string; attempt?: number; usage: Usage }): Promise<{ applied: boolean }> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "callId", "attempt", "usage"]);
    const attemptNo = command.attempt === undefined ? undefined : count(command.attempt, "attempt");
    const callId = this.#id(command.callId);
    const usage = this.#usage(command.usage);
    const ref: AggregateRef = { kind: "model-call", id: callId };
    await this.#runner.command("model.succeeded", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { callId, attempt: attemptNo ?? null, usage: usage as unknown as JsonObject },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const call = found?.body as unknown as CallBody | undefined;
        if (found === undefined || call === undefined) throw new DomainError("not_found", "no such call");
        const last = call.attempts.at(-1);
        const stale = this.#stale(call, attemptNo);
        if (stale !== undefined) return this.#lateReport(found.revision, ref, call, stale, "succeeded", usage);
        if (call.state !== "running" || last === undefined || last.outcome !== "started") throw new DomainError("invalid_transition", "that call has no attempt in progress");
        const next: CallBody = { ...call, attempts: [...call.attempts.slice(0, -1), { ...last, outcome: "succeeded", usage }], state: "succeeded" };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...(await this.#charge(call.taskId, callId, usage))], detail: { callId, route: last.route } };
      },
    }));
    const after = (await this.#runner.get("model-call", callId))?.body as unknown as CallBody | undefined;
    const taken = attemptNo === undefined ? after?.attempts.at(-1) : after?.attempts[attemptNo - 1];
    const applied = taken?.outcome === "succeeded";
    if (applied && this.#gate?.success !== undefined) { try { await this.#gate.success({ route: taken!.route, callId }); } catch { /* a trial that cannot be recorded is simply not counted */ } }
    return { applied };
  }

  /** A waiting call tries again (the table, cooldowns or budget may have changed, or an uncertain effect was reconciled and reported). */
  async resume(by: Principal, command: NoActor & { callId: string; effects?: readonly EffectState[] }): Promise<Step> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "callId", "effects"]);
    const callId = this.#id(command.callId);
    const effects = this.#effects(command.effects ?? []);
    const ref: AggregateRef = { kind: "model-call", id: callId };
    await this.#runner.command("model.resume", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { callId, effects: effects as unknown as JsonObject[] },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const call = found?.body as unknown as CallBody | undefined;
        if (found === undefined || call === undefined) throw new DomainError("not_found", "no such call");
        if (call.state !== "waiting") throw new DomainError("invalid_transition", `that call is ${call.state}, not waiting`);
        const allEffects = this.#mergeEffects(call.effects, effects);
        let next: CallBody;
        if (used(call.attempts) >= FALLBACK_LIMITS.attempts) { const { waiting: _w, ...rest } = call; void _w; next = { ...rest, effects: allEffects, state: "failed", ended: { reason: `${FALLBACK_LIMITS.attempts} attempts have failed`, why: call.attempts.map((a) => `${a.route}: ${a.failure?.class ?? a.outcome}`) } }; }
        else if (allEffects.some((e) => e.state === "uncertain")) next = { ...call, effects: allEffects, waiting: { reason: "an effect of the failed attempt is still uncertain", why: allEffects.filter((e) => e.state === "uncertain").map((e) => `effect ${e.id} is uncertain`) } };
        else {
          const decided = await this.#decide(call.taskId, call.request, call.attempts, undefined, new Date(this.#runner.now()).getTime(), by.kind === "owner", callId);
          const { waiting: _old, ...rest } = call;
          void _old;
          next = decided.route === undefined
            ? { ...call, effects: allEffects, waiting: decided.waiting! }
            : { ...rest, attempts: [...call.attempts, { route: decided.route, at: this.#runner.now(), outcome: "started" }], effects: allEffects, state: "running", routingRevision: decided.revision, ...this.#position(decided, call.list) };
        }
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { callId, state: next.state } };
      },
    }));
    return this.#checked(by, callId);
  }

  /**
   * Gives up the attempt in progress (card R04: an immediate cutover, or a route that became unavailable while the call was being dispatched) and moves the call to the next
   * eligible route, or makes it wait. The abandoned attempt is not a failure of its provider (no cooldown, no block). If it was on a paid provider a possible charge is recorded;
   * a response that still arrives for it is not applied (`succeeded` and `failed` with `attempt`). `attempt` makes the command refuse if the call has already moved on.
   */
  abandon(by: Principal, command: NoActor & { callId: string; attempt?: number; reason: string; effects?: readonly EffectState[] }): Promise<Step> { return this.#abandon(by, command, false); }

  /** `unsent`: the request was never sent (the gate blocked the route after it was chosen), so no charge is possible and the attempt does not count toward the limit of four. It stays in the list as `skipped` so attempt numbers are never reused (a late response naming it is recorded, never applied to a replacement). */
  async #abandon(by: Principal, command: NoActor & { callId: string; attempt?: number; reason: string; effects?: readonly EffectState[] }, unsent: boolean): Promise<Step> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "callId", "attempt", "reason", "effects"]);
    const callId = this.#id(command.callId);
    const attemptNo = command.attempt === undefined ? undefined : count(command.attempt, "attempt");
    const reason = redactText(typeof command.reason === "string" && command.reason.length > 0 ? command.reason : invalid("reason", "must be text")).slice(0, FALLBACK_LIMITS.message);
    const effects = this.#effects(command.effects ?? []);
    const ref: AggregateRef = { kind: "model-call", id: callId };
    await this.#runner.command("model.abandon", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { callId, attempt: attemptNo ?? null, reason, unsent, effects: effects as unknown as JsonObject[] },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const call = found?.body as unknown as CallBody | undefined;
        if (found === undefined || call === undefined) throw new DomainError("not_found", "no such call");
        const last = call.attempts.at(-1);
        if (call.state !== "running" || last === undefined || last.outcome !== "started" || (attemptNo !== undefined && attemptNo !== call.attempts.length)) throw new DomainError("invalid_transition", "that call has no such attempt in progress");
        const table = await this.#routing.get();
        const paid = table?.providers[last.route.slice(0, last.route.indexOf("/"))]?.paid === true;
        const at = this.#runner.now();
        const attempts: Attempt[] = [...call.attempts.slice(0, -1), { ...last, outcome: unsent ? "skipped" : "abandoned", abandoned: reason, endedAt: at }];
        const charges: Charge[] = paid && !unsent ? [...(call.charges ?? []), { attempt: call.attempts.length, route: last.route, status: "possible" as const, at }].slice(-FALLBACK_LIMITS.charges) : [...(call.charges ?? [])];
        const allEffects = this.#mergeEffects(call.effects, effects);
        const base = { ...call, attempts, charges, effects: allEffects };
        let next: CallBody;
        if (allEffects.some((e) => e.state === "uncertain")) {
          next = { ...base, state: "waiting", waiting: { reason: "an effect of the abandoned attempt is uncertain; it must be reconciled before any other route is tried", why: allEffects.filter((e) => e.state === "uncertain").map((e) => `effect ${e.id} is uncertain`) } };
        } else if (used(attempts) >= FALLBACK_LIMITS.attempts) {
          next = { ...base, state: "failed", ended: { reason: `${FALLBACK_LIMITS.attempts} attempts have been used`, why: attempts.map((a) => `${a.route}: ${a.failure?.class ?? a.outcome}`) } };
        } else {
          const decided = await this.#decide(call.taskId, call.request, attempts, undefined, undefined, false, callId);
          next = decided.route === undefined
            ? { ...base, state: "waiting", waiting: decided.waiting! }
            : { ...base, attempts: [...attempts, { route: decided.route, at, outcome: "started" }], state: "running", routingRevision: decided.revision, ...this.#position(decided, call.list) };
        }
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { callId, abandoned: last.route, state: next.state } };
      },
    }));
    return this.#checked(by, callId);
  }

  /** Calls with an attempt in progress (the requests that are in flight), oldest first by ID order. Reads every call record. */
  async inFlight(by: Principal): Promise<InFlight[]> {
    this.#dispatcher(by);
    return (await this.#scan()).flatMap((c) => {
      const last = c.body.attempts.at(-1);
      return c.body.state === "running" && last?.outcome === "started" ? [{ callId: c.id, taskId: c.body.taskId, route: last.route, attempt: c.body.attempts.length, since: last.at }] : [];
    });
  }

  /** The owner settles a possible charge once the provider's invoice says (or a late response reported) what the abandoned attempt cost. */
  async settleCharge(owner: Principal, command: NoActor & { callId: string; attempt: number; outcome: "none" | "confirmed"; costMicros?: number }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner settles a charge`);
    onlyKnown(command, ["commandId", "callId", "attempt", "outcome", "costMicros"]);
    const callId = this.#id(command.callId);
    const attemptNo = count(command.attempt, "attempt");
    const outcome = command.outcome === "none" || command.outcome === "confirmed" ? command.outcome : invalid("outcome", "must be none or confirmed");
    const cost = command.costMicros === undefined ? undefined : count(command.costMicros, "costMicros");
    if ((outcome === "confirmed") !== (cost !== undefined)) invalid("costMicros", "is given exactly when the charge is confirmed");
    const ref: AggregateRef = { kind: "model-call", id: callId };
    await this.#runner.command("model.charge", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { callId, attempt: attemptNo, outcome, cost: cost ?? null },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const call = found?.body as unknown as CallBody | undefined;
        if (found === undefined || call === undefined) throw new DomainError("not_found", "no such call");
        const charge = (call.charges ?? []).find((c) => c.attempt === attemptNo);
        if (charge === undefined) throw new DomainError("not_found", "that attempt has no possible charge");
        if (charge.status !== "possible") throw new DomainError("invalid_transition", `that charge is already ${charge.status}`);
        const next: CallBody = { ...call, charges: (call.charges ?? []).map((c) => (c.attempt === attemptNo ? { ...c, status: outcome, ...(cost === undefined ? {} : { costMicros: cost }) } : c)) };
        const extra = cost === undefined || cost === 0 ? [] : await this.#charge(call.taskId, callId, { inputTokens: 0, outputTokens: 0, costMicros: cost }, false);
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...extra], detail: { callId, attempt: attemptNo, outcome } };
      },
    }));
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  #dispatcher(by: Principal): void { if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} is not the dispatcher; model calls are the controller's and its hosts'`); }
  #id(v: unknown): string { return typeof v === "string" && /^mcl-[a-z2-7]{20}$/.test(v) ? v : invalid("callId", "is not a model call ID"); }
  #usage(v: Usage): Usage { return { inputTokens: count(v?.inputTokens, "usage.inputTokens"), outputTokens: count(v?.outputTokens, "usage.outputTokens"), costMicros: count(v?.costMicros, "usage.costMicros") }; }
  #effects(list: readonly EffectState[]): EffectState[] {
    if (!Array.isArray(list) || list.length > FALLBACK_LIMITS.effects) invalid("effects", `must be a list of at most ${FALLBACK_LIMITS.effects}`);
    return list.map((e, i) => (typeof e?.id === "string" && /^eff-[a-z2-7]{20}$/.test(e.id) && ["intended", "uncertain", "confirmed", "failed"].includes(e.state) ? { id: e.id, state: e.state } : invalid(`effects[${i}]`, "must be { id: an effect ID, state }")));
  }
  #mergeEffects(old: readonly EffectState[], fresh: readonly EffectState[]): EffectState[] {
    const map = new Map(old.map((e) => [e.id, e]));
    for (const e of fresh) map.set(e.id, e);
    return [...map.values()].slice(0, FALLBACK_LIMITS.effects);
  }

  async #charge(taskId: string, callId: string, usage: Usage, countCall = true, failure = 0): Promise<Change[]> {
    const ref: AggregateRef = { kind: spendKind(taskId), id: callId };
    const found = await this.#runner.get(ref.kind, ref.id);
    const before = (found?.body as unknown as SpendBody | undefined) ?? { costMicros: 0, tokens: 0, calls: 0 };
    const body: SpendBody = { costMicros: before.costMicros + usage.costMicros, tokens: before.tokens + usage.inputTokens + usage.outputTokens, calls: before.calls + (countCall ? 1 : 0), failures: (before.failures ?? 0) + failure };
    return [found === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }];
  }

  /** The next route for a call: the first eligible one not already tried (or whose cooldown has passed, on a resume), unless the budget is used up. */
  async #decide(taskId: string, request: RouteRequest, attempts: readonly Attempt[], pending: Usage | undefined, resumeAt: number | undefined, clearBlocks = false, callId?: string, pendingFailures = 0): Promise<{ route?: string; revision: number; list?: { profile: string; routes: readonly string[] }; waiting?: NonNullable<CallBody["waiting"]> }> {
    const budget = (await this.#runner.get("model-budget", taskId))?.body as unknown as BudgetBody | undefined;
    const before = await this.spend(taskId);
    const spent = pending === undefined ? before : { costMicros: before.costMicros + pending.costMicros, tokens: before.tokens + pending.inputTokens + pending.outputTokens, calls: before.calls + 1 };
    const selection = await this.#routing.select(request);
    const list = { profile: selection.profile, routes: selection.candidates.map((c) => c.route) };
    const why: string[] = [];
    if (budget !== undefined && ((budget.maxCostMicros !== undefined && spent.costMicros >= budget.maxCostMicros) || (budget.maxTokens !== undefined && spent.tokens >= budget.maxTokens))) {
      return { revision: selection.revision, list, waiting: { reason: "the task's budget is used up; the owner can raise it", why: [`spent ${spent.costMicros} micros and ${spent.tokens} tokens`] } };
    }
    if (budget?.maxFailedAttempts !== undefined && (before.failures ?? 0) + pendingFailures >= budget.maxFailedAttempts) {
      return { revision: selection.revision, list, waiting: { reason: "the task's retry budget is used up; the owner can raise it", why: [`${(before.failures ?? 0) + pendingFailures} failed attempts of at most ${budget.maxFailedAttempts}`] } };
    }
    const now = resumeAt ?? new Date(this.#runner.now()).getTime();
    let until: number | undefined;
    const blockedProviders = new Set<string>();
    const cooling = new Map<string, number>();
    for (const a of attempts) {
      if (a.outcome !== "failed" || a.failure === undefined) continue;
      const provider = a.route.slice(0, a.route.indexOf("/"));
      const cls = a.failure.class;
      if (cls === "credit" || cls === "auth") { if (!clearBlocks) blockedProviders.add(provider); }
      else {
        const secs = cls === "rate-limit" ? FALLBACK_LIMITS.rateLimitSeconds : FALLBACK_LIMITS.outageSeconds;
        const ready = new Date(a.at).getTime() + secs * 1000;
        cooling.set(a.route, Math.max(cooling.get(a.route) ?? 0, ready));
      }
    }
    for (const c of selection.candidates) {
      if (!c.eligible) { why.push(`${c.route}: ${c.reasons.join("; ")}`); continue; }
      const provider = c.route.slice(0, c.route.indexOf("/"));
      if (blockedProviders.has(provider)) { why.push(`${c.route}: provider ${provider} failed with a credit or authentication problem`); continue; }
      const gated = this.#gate === undefined ? [] : await this.#gate.blocked(c.route, callId);
      if (gated.length > 0) { why.push(`${c.route}: ${gated.join("; ")}`); continue; }
      const ready = cooling.get(c.route);
      const triedOnce = attempts.some((a) => a.route === c.route);
      if (ready !== undefined && ready > now) { why.push(`${c.route}: cooling down until ${new Date(ready).toISOString()}`); until = until === undefined ? ready : Math.min(until, ready); continue; }
      if (triedOnce && resumeAt === undefined) { why.push(`${c.route}: already tried`); continue; }
      // A half-open trial is claimed only for the route actually chosen, after every other check.
      if (this.#gate !== undefined) { const claimed = await this.#gate.blocked(c.route, callId, true); if (claimed.length > 0) { why.push(`${c.route}: ${claimed.join("; ")}`); continue; } }
      return { route: c.route, revision: selection.revision, list };
    }
    return { revision: selection.revision, list, waiting: { reason: "no eligible route is left", ...(until === undefined ? {} : { until: new Date(until).toISOString() }), why } };
  }

  /** The list position to store: the fresh one when a route was chosen (index of that route), else the old one. */
  #position(decided: { route?: string; list?: { profile: string; routes: readonly string[] } }, old: ListPosition | undefined): { list?: ListPosition } {
    if (decided.route !== undefined && decided.list !== undefined && decided.list.routes.includes(decided.route)) return { list: { ...decided.list, index: decided.list.routes.indexOf(decided.route) } };
    return old === undefined ? {} : { list: old };
  }

  /** The attempt a report names when it is not the one in progress (a late response), or undefined when it is. A call that has abandoned an attempt needs the report to name its attempt. */
  #stale(call: CallBody, attempt: number | undefined): number | undefined {
    if (attempt === undefined) {
      if (call.attempts.some((a) => a.outcome === "abandoned" || a.outcome === "skipped")) invalid("attempt", "must name the attempt: this call has abandoned one, and a response from it must not be taken for the current one");
      return undefined;
    }
    if (attempt < 1 || attempt > call.attempts.length) invalid("attempt", "is not an attempt of this call");
    return call.state === "running" && attempt === call.attempts.length && call.attempts[attempt - 1]!.outcome === "started" ? undefined : attempt;
  }

  /** A response for an attempt that is no longer current: nothing is applied except that it is recorded and its cost, if any, is counted (money was spent). */
  async #lateReport(revision: number, ref: AggregateRef, call: CallBody, attempt: number, kind: "succeeded" | "failed", usage: Usage | undefined): Promise<{ ref: AggregateRef; creates: boolean; changes: Change[]; detail: JsonObject }> {
    const route = call.attempts[attempt - 1]!.route;
    const at = this.#runner.now();
    const charges = (call.charges ?? []).map((c) => (c.attempt === attempt && c.status === "possible" && usage !== undefined ? { ...c, status: "confirmed" as const, costMicros: usage.costMicros } : c));
    const next: CallBody = { ...call, charges, late: [...(call.late ?? []), { attempt, route, kind, at, ...(usage === undefined ? {} : { usage }) }].slice(-FALLBACK_LIMITS.late) };
    // Money counts once: a charge the owner already settled (or a late report already confirmed) is in the spend.
    const entry = (call.charges ?? []).find((c) => c.attempt === attempt);
    const extra = usage === undefined || (entry !== undefined && entry.status !== "possible") ? [] : await this.#charge(call.taskId, ref.id, usage);
    return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: revision, body: next as unknown as JsonObject }, ...extra], detail: { callId: ref.id, late: attempt, kind } };
  }

  /** After a dispatch decision: if a rule changed between the decision and now (a cutover, an exclusion), the route is not used; the attempt is abandoned and the next one chosen. */
  async #checked(by: Principal, callId: string): Promise<Step> {
    for (let round = 0; ; round++) {
      const step = await this.#step(callId);
      if (this.#gate === undefined || step.kind !== "route" || round >= FALLBACK_LIMITS.attempts) return step;
      const call = (await this.#runner.get("model-call", callId))?.body as unknown as CallBody | undefined;
      if (call?.state !== "running") return step;
      // An attempt the dispatcher has sent is left alone (a cutover cancels it, a drain lets it finish); one not yet sent must not go to a route blocked since it was chosen.
      if (call.attempts.at(-1)!.sentAt !== undefined) return step;
      const reasons = await this.#gate.blocked(step.route, callId);
      if (reasons.length === 0) return step;
      try { await this.#abandon(by, { commandId: `gate:${callId}:${step.attempt}`, callId, attempt: step.attempt, reason: `the route became unavailable before the request was sent: ${reasons[0]}` }, true); } catch (error) { if (!(error instanceof DomainError) || error.code !== "invalid_transition") throw error; }
    }
  }

  /** Tells the gate about an availability failure just recorded (idempotent by call and attempt). Task errors, bad answers and overflows are not availability failures and teach it nothing. */
  async #learn(callId: string, cls: FailureClass): Promise<void> {
    if (this.#gate?.failure === undefined || !(cls === "credit" || cls === "auth" || cls === "outage" || cls === "rate-limit")) return;
    const call = (await this.#runner.get("model-call", callId))?.body as unknown as CallBody | undefined;
    const index = call?.attempts.findLastIndex((a) => a.outcome === "failed" && a.failure?.class === cls) ?? -1;
    const failed = call?.attempts[index];
    if (failed === undefined) return;
    // The failure is already recorded; what the gate learns from it must never turn that into an error for the dispatcher.
    try { await this.#gate.failure({ route: failed.route, class: cls, at: failed.at, key: `${callId}:${index + 1}` }); } catch { /* the gate learns from the next report */ }
  }

  async #scan(): Promise<{ id: string; body: CallBody }[]> {
    const out: { id: string; body: CallBody }[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("model-call", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) { after = a.id; out.push({ id: a.id, body: a.body as unknown as CallBody }); }
      if (page.length < 200) return out;
    }
  }

  async #step(callId: string): Promise<Step> {
    const call = (await this.#runner.get("model-call", callId))?.body as unknown as CallBody | undefined;
    if (call === undefined) throw new DomainError("not_found", "no such call");
    if (call.state === "running" || call.state === "succeeded") {
      const last = call.attempts.at(-1)!;
      return { kind: "route", callId, route: last.route, attempt: call.attempts.length, doNotRepeat: call.effects.filter((e) => e.state === "intended" || e.state === "confirmed").map((e) => e.id) };
    }
    if (call.state === "waiting") return { kind: "wait", callId, reason: call.waiting!.reason, ...(call.waiting!.until === undefined ? {} : { until: call.waiting!.until }), why: call.waiting!.why };
    return { kind: "failed", callId, reason: call.ended?.reason ?? "failed" };
  }
}
void ROUTING_LIMITS;
type Change = import("../storage/types.js").Change;
