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
  readonly outcome: "started" | "succeeded" | "failed";
  readonly failure?: { readonly class: FailureClass; readonly message: string };
  readonly usage?: Usage;
}
export interface Usage { readonly inputTokens: number; readonly outputTokens: number; /** Money, in millionths of the account currency; 0 for a local route. */ readonly costMicros: number }
export interface EffectState { readonly id: string; readonly state: "intended" | "uncertain" | "confirmed" | "failed" }
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
  /** Effects reported by the caller; none of them is ever repeated by a fallback. */
  readonly effects: readonly EffectState[];
  readonly createdBy: string;
}
export interface BudgetBody { readonly maxCostMicros?: number; readonly maxTokens?: number; readonly setBy: string }
export interface SpendBody { readonly costMicros: number; readonly tokens: number; readonly calls: number }
export type Step =
  | { readonly kind: "route"; readonly callId: string; readonly route: string; readonly attempt: number; readonly doNotRepeat: readonly string[] }
  | { readonly kind: "wait"; readonly callId: string; readonly reason: string; readonly until?: string; readonly why: readonly string[] }
  | { readonly kind: "failed"; readonly callId: string; readonly reason: string };

export const FALLBACK_LIMITS = { attempts: 4, message: 300, effects: 100, rateLimitSeconds: 60, outageSeconds: 300 } as const;
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

  private constructor(runner: CommandRunner, routing: RoutingService) { this.#runner = runner; this.#routing = routing; }

  static withEpoch(storage: ControllerStorage, epoch: number, routing: RoutingService, options: RunnerOptions = {}): FallbackService {
    return new FallbackService(new CommandRunner(storage, epoch, options), routing);
  }

  /** The owner caps what a task may spend across all calls and fallbacks. */
  async setBudget(owner: Principal, command: NoActor & { taskId: string; maxCostMicros?: number; maxTokens?: number }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner sets a spending budget`);
    onlyKnown(command, ["commandId", "taskId", "maxCostMicros", "maxTokens"]);
    const taskId = checkTaskId(command.taskId);
    const body: BudgetBody = { ...(command.maxCostMicros === undefined ? {} : { maxCostMicros: count(command.maxCostMicros, "maxCostMicros") }), ...(command.maxTokens === undefined ? {} : { maxTokens: count(command.maxTokens, "maxTokens") }), setBy: owner.id };
    const ref: AggregateRef = { kind: "model-budget", id: taskId };
    await this.#runner.command("model.budget", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { taskId, budget: body as unknown as JsonObject },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        return { ref, creates: current === undefined, changes: [current === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { taskId } };
      },
    }));
  }

  /** What a task has spent: the sum of its calls' entries (each call writes only its own, so calls of one task never collide). */
  async spend(taskId: string): Promise<SpendBody> {
    const kind = spendKind(checkTaskId(taskId));
    let total: SpendBody = { costMicros: 0, tokens: 0, calls: 0 };
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(kind, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) { after = a.id; const b = a.body as unknown as SpendBody; total = { costMicros: total.costMicros + b.costMicros, tokens: total.tokens + b.tokens, calls: total.calls + b.calls }; }
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
        const decided = await this.#decide(taskId, request, [], undefined, undefined);
        const body: CallBody = { taskId, projectId: task.projectId, request, attempts: decided.route === undefined ? [] : [{ route: decided.route, at: this.#runner.now(), outcome: "started" }], state: decided.route === undefined ? "waiting" : "running", ...(decided.route === undefined ? { waiting: decided.waiting! } : {}), routingRevision: decided.revision, effects: [], createdBy: by.id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, route: decided.route ?? null } };
      },
    }));
    return this.#step(callId);
  }

  /** The current state of a call as a step. */
  async step(by: Principal, callId: string): Promise<Step> { this.#dispatcher(by); return this.#step(this.#id(callId)); }

  /** The attempt failed. Classifies it and, when a fallback is allowed, chooses the next route; otherwise waits visibly or fails. */
  async failed(by: Principal, command: NoActor & { callId: string; failure: { message: string; status?: number }; usage?: Usage; effects?: readonly EffectState[] }): Promise<Step> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "callId", "failure", "usage", "effects"]);
    const callId = this.#id(command.callId);
    const message = redactText(typeof command.failure?.message === "string" ? command.failure.message : invalid("failure.message", "must be text")).slice(0, FALLBACK_LIMITS.message);
    const status = command.failure.status === undefined ? undefined : count(command.failure.status, "failure.status");
    const cls = classifyProviderFailure({ message, ...(status === undefined ? {} : { status }) });
    const usage = command.usage === undefined ? undefined : this.#usage(command.usage);
    const effects = this.#effects(command.effects ?? []);
    const ref: AggregateRef = { kind: "model-call", id: callId };
    await this.#runner.command("model.failed", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { callId, message, status: status ?? null, cls, usage: (usage ?? null) as unknown as JsonObject, effects: effects as unknown as JsonObject[] },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const call = found?.body as unknown as CallBody | undefined;
        if (found === undefined || call === undefined) throw new DomainError("not_found", "no such call");
        const last = call.attempts.at(-1);
        if (call.state !== "running" || last === undefined || last.outcome !== "started") throw new DomainError("invalid_transition", "that call has no attempt in progress");
        const attempts: Attempt[] = [...call.attempts.slice(0, -1), { ...last, outcome: "failed", failure: { class: cls, message }, ...(usage === undefined ? {} : { usage }) }];
        const allEffects = this.#mergeEffects(call.effects, effects);
        let next: CallBody;
        let extra: Change[] = [];
        if (usage !== undefined) extra = await this.#charge(call.taskId, callId, usage);
        if (allEffects.some((e) => e.state === "uncertain")) {
          next = { ...call, attempts, effects: allEffects, state: "waiting", waiting: { reason: "an effect of the failed attempt is uncertain; it must be reconciled before any other route is tried", why: allEffects.filter((e) => e.state === "uncertain").map((e) => `effect ${e.id} is uncertain`) } };
        } else if (cls === "context-overflow" || cls === "invalid-request" || cls === "unknown") {
          next = { ...call, attempts, effects: allEffects, state: "failed", ended: { reason: cls === "context-overflow" ? "the context did not fit; rebuild it (C07) rather than trying another route" : `${cls} failures are not retried on another route`, why: [message] } };
        } else if (attempts.length >= FALLBACK_LIMITS.attempts) {
          next = { ...call, attempts, effects: allEffects, state: "failed", ended: { reason: `${FALLBACK_LIMITS.attempts} attempts have failed`, why: attempts.map((a) => `${a.route}: ${a.failure?.class ?? a.outcome}`) } };
        } else {
          const decided = await this.#decide(call.taskId, call.request, attempts, usage, undefined);
          next = decided.route === undefined
            ? { ...call, attempts, effects: allEffects, state: "waiting", waiting: decided.waiting! }
            : { ...call, attempts: [...attempts, { route: decided.route, at: this.#runner.now(), outcome: "started" }], effects: allEffects, state: "running", routingRevision: decided.revision };
        }
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...extra], detail: { callId, class: cls, state: next.state } };
      },
    }));
    return this.#step(callId);
  }

  /** The attempt succeeded: its usage is added to the task's spend. */
  async succeeded(by: Principal, command: NoActor & { callId: string; usage: Usage }): Promise<void> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "callId", "usage"]);
    const callId = this.#id(command.callId);
    const usage = this.#usage(command.usage);
    const ref: AggregateRef = { kind: "model-call", id: callId };
    await this.#runner.command("model.succeeded", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { callId, usage: usage as unknown as JsonObject },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const call = found?.body as unknown as CallBody | undefined;
        if (found === undefined || call === undefined) throw new DomainError("not_found", "no such call");
        const last = call.attempts.at(-1);
        if (call.state !== "running" || last === undefined || last.outcome !== "started") throw new DomainError("invalid_transition", "that call has no attempt in progress");
        const next: CallBody = { ...call, attempts: [...call.attempts.slice(0, -1), { ...last, outcome: "succeeded", usage }], state: "succeeded" };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }, ...(await this.#charge(call.taskId, callId, usage))], detail: { callId, route: last.route } };
      },
    }));
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
        if (call.attempts.length >= FALLBACK_LIMITS.attempts) { const { waiting: _w, ...rest } = call; void _w; next = { ...rest, effects: allEffects, state: "failed", ended: { reason: `${FALLBACK_LIMITS.attempts} attempts have failed`, why: call.attempts.map((a) => `${a.route}: ${a.failure?.class ?? a.outcome}`) } }; }
        else if (allEffects.some((e) => e.state === "uncertain")) next = { ...call, effects: allEffects, waiting: { reason: "an effect of the failed attempt is still uncertain", why: allEffects.filter((e) => e.state === "uncertain").map((e) => `effect ${e.id} is uncertain`) } };
        else {
          const decided = await this.#decide(call.taskId, call.request, call.attempts, undefined, new Date(this.#runner.now()).getTime(), by.kind === "owner");
          const { waiting: _old, ...rest } = call;
          void _old;
          next = decided.route === undefined
            ? { ...call, effects: allEffects, waiting: decided.waiting! }
            : { ...rest, attempts: [...call.attempts, { route: decided.route, at: this.#runner.now(), outcome: "started" }], effects: allEffects, state: "running", routingRevision: decided.revision };
        }
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: next as unknown as JsonObject }], detail: { callId, state: next.state } };
      },
    }));
    return this.#step(callId);
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

  async #charge(taskId: string, callId: string, usage: Usage): Promise<Change[]> {
    const ref: AggregateRef = { kind: spendKind(taskId), id: callId };
    const found = await this.#runner.get(ref.kind, ref.id);
    const before = (found?.body as unknown as SpendBody | undefined) ?? { costMicros: 0, tokens: 0, calls: 0 };
    const body: SpendBody = { costMicros: before.costMicros + usage.costMicros, tokens: before.tokens + usage.inputTokens + usage.outputTokens, calls: before.calls + 1 };
    return [found === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }];
  }

  /** The next route for a call: the first eligible one not already tried (or whose cooldown has passed, on a resume), unless the budget is used up. */
  async #decide(taskId: string, request: RouteRequest, attempts: readonly Attempt[], pending: Usage | undefined, resumeAt: number | undefined, clearBlocks = false): Promise<{ route?: string; revision: number; waiting?: NonNullable<CallBody["waiting"]> }> {
    const budget = (await this.#runner.get("model-budget", taskId))?.body as unknown as BudgetBody | undefined;
    const before = await this.spend(taskId);
    const spent = pending === undefined ? before : { costMicros: before.costMicros + pending.costMicros, tokens: before.tokens + pending.inputTokens + pending.outputTokens, calls: before.calls + 1 };
    const selection = await this.#routing.select(request);
    const why: string[] = [];
    if (budget !== undefined && ((budget.maxCostMicros !== undefined && spent.costMicros >= budget.maxCostMicros) || (budget.maxTokens !== undefined && spent.tokens >= budget.maxTokens))) {
      return { revision: selection.revision, waiting: { reason: "the task's budget is used up; the owner can raise it", why: [`spent ${spent.costMicros} micros and ${spent.tokens} tokens`] } };
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
      const ready = cooling.get(c.route);
      const triedOnce = attempts.some((a) => a.route === c.route);
      if (ready !== undefined && ready > now) { why.push(`${c.route}: cooling down until ${new Date(ready).toISOString()}`); until = until === undefined ? ready : Math.min(until, ready); continue; }
      if (triedOnce && resumeAt === undefined) { why.push(`${c.route}: already tried`); continue; }
      return { route: c.route, revision: selection.revision };
    }
    return { revision: selection.revision, waiting: { reason: "no eligible route is left", ...(until === undefined ? {} : { until: new Date(until).toISOString() }), why } };
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
