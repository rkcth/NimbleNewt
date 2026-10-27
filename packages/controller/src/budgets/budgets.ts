import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

/** Provider money in millionths of the tree's currency, and local compute as occupied worker-slot milliseconds. The two are never converted into each other. */
export interface Amounts { readonly costMicros: number; readonly computeMs: number }
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

interface Node {
  readonly taskId: string;
  readonly projectId: string;
  readonly parentId?: string;
  /** The principal who answers for this node and may delegate from it and decide requests made by its children. */
  readonly holder?: string;
  limit: Mutable<Amounts>;
  /** Allowance handed to children (the sum of their limits): moved out of this node, never copied. */
  delegated: Mutable<Amounts>;
  /** Held for calls sent and not yet reported. */
  reserved: Mutable<Amounts>;
  /** Held for calls whose outcome is not known; counted at the full reserved amount until someone reconciles them. */
  uncertain: Mutable<Amounts>;
  spent: Mutable<Amounts>;
  /** What was charged above what had been reserved or was available. Money already spent; it blocks further reservations. */
  overrun: Mutable<Amounts>;
  children: string[];
  openRequests: string[];
}
interface Reservation { readonly id: string; readonly taskId: string; readonly agentId?: string; readonly amounts: Amounts; readonly purpose: string; readonly activity: Activity; readonly by: string; readonly at: string; state: "open" | "uncertain"; uncertainReason?: string }
interface TreeBody { readonly rootTaskId: string; readonly projectId: string; readonly currency: string; nodes: Record<string, Node>; reservations: Record<string, Reservation> }

/** What the endpoint's cache did for one call, as read from its response (cached_tokens, cache_n and prompt_n, cache_read_input_tokens). For Claude, `writtenTokens` is a subset of `computedTokens` (computed, then written to the cache), not an addition. */
export interface CacheUsage { readonly backend: string; readonly route: string; readonly cachedTokens: number; readonly computedTokens: number; readonly writtenTokens: number }
export interface CacheTotals { readonly cachedTokens: number; readonly computedTokens: number; readonly writtenTokens: number; readonly calls: number }

export type Activity = "model-call" | "background-job" | "meeting" | "supervision" | "review";
export interface UsageEntry {
  readonly taskId?: string;
  readonly projectId?: string;
  readonly agentId?: string;
  readonly activity: Activity;
  /** `work`: attributed to the task named. `shared-overhead`: attributed to no task, under an explicit rule that is shown with every figure. */
  readonly category: "work" | "shared-overhead";
  readonly rule?: string;
  readonly costMicros: number;
  readonly computeMs: number;
  readonly currency?: string;
  readonly reservationId?: string;
  readonly reservedCostMicros?: number;
  readonly reservedComputeMs?: number;
  /** Cache figures of the call (card C06), when the response carried them. Tokens, not money: they are never added to the cost or compute figures. */
  readonly cache?: CacheUsage;
  readonly by: string;
  readonly at: string;
}
export interface BudgetRequestBody { readonly taskId: string; readonly treeId: string; readonly requestedBy: string; readonly costMicros: number; readonly computeMs: number; readonly reason: string; readonly to: string; state: "open" | "approved" | "denied"; decidedBy?: string; decidedAt?: string; grantedCostMicros?: number; grantedComputeMs?: number; note?: string; readonly at: string }

/** What the addressee of a request for more budget is told: who asked, for which task, how much, and where it was addressed (`to` is `owner` or the delegated holder's principal). */
export interface RequestNotice { readonly requestId: string; readonly taskId: string; readonly parentTaskId?: string; readonly to: string; readonly requestedBy: string; readonly costMicros: number; readonly computeMs: number }
export type NotifyRequest = (notice: RequestNotice) => Promise<void>;

export interface BudgetReport {
  readonly taskId: string;
  readonly currency: string;
  readonly holder?: string;
  readonly parentId?: string;
  readonly limit: Amounts;
  readonly delegatedToChildren: Amounts;
  readonly reservedInFlight: Amounts;
  readonly uncertain: Amounts;
  readonly spent: Amounts;
  readonly overrun: Amounts;
  /** What a new reservation or delegation could still take: the limit less everything above (never below 0). */
  readonly available: Amounts;
  /** Everything that could still turn into spending: in flight plus uncertain. Shown, not hidden, because it is not yet reconciled. */
  readonly outstanding: Amounts;
  readonly reservations: readonly { id: string; agentId?: string; costMicros: number; computeMs: number; state: "open" | "uncertain"; purpose: string; at: string; uncertainReason?: string }[];
  readonly children: readonly string[];
  readonly pendingRequests: readonly { id: string; costMicros: number; computeMs: number; to: string; reason: string }[];
  /** This task and everything delegated below it: reserved, uncertain and spent in total. */
  readonly subtree: { readonly reserved: Amounts; readonly uncertain: Amounts; readonly spent: Amounts; readonly nodes: number };
  readonly enforcement: typeof BUDGET_ENFORCEMENT;
}
export interface UsageSummary {
  readonly totals: Amounts;
  readonly byCategory: Record<string, Amounts>;
  readonly byActivity: Record<string, Amounts>;
  readonly byAgent: Record<string, Amounts>;
  readonly byTask: Record<string, Amounts>;
  readonly byProject: Record<string, Amounts>;
  /** Cache figures of the entries that reported them: all together and by backend. Entries without cache figures are not counted (unknown is not zero). */
  readonly cache: CacheTotals;
  readonly cacheByBackend: Record<string, CacheTotals>;
  readonly entries: number;
  /** True when more entries matched than the scan limit; the figures are then a lower bound. */
  readonly truncated: boolean;
  /** The rules under which shared overhead was charged, as stated by whoever charged it. */
  readonly overheadRules: readonly string[];
}

/** What the controller can and cannot promise about a spending ceiling. Shown with every report so nobody reads the figures as a provider-side guarantee. */
export const BUDGET_ENFORCEMENT = {
  controllerGate: "The controller refuses to reserve more than a task's allowance before it dispatches a call; that gate is exact for everything dispatched through it.",
  estimates: "A reservation is an estimate. A provider can charge more than was reserved, and a call already sent cannot be recalled: the excess is recorded as overrun and stops further reservations, but it has been spent.",
  providerCeiling: "A hard spending ceiling at the provider (account cap, key limit, prepaid balance) is not set, checked or enforced by the controller. How tightly the total is bounded depends on what the provider supports; without one, the bound is the sum of reservations in flight plus any overrun.",
  childOverrun: "A child's own overrun is passed up: each ancestor's handed-on figure grows by the excess, so a parent's available figure shows what its children really consumed; overrun already incurred cannot be undone by any of this.",
  other: "Work that does not go through a reservation (background jobs, meetings, supervision) is recorded when reported and cannot be refused beforehand.",
} as const;

export const BUDGET_LIMITS = { nodes: 200, depth: 8, reservations: 500, openRequestsPerTask: 5, purpose: 200, reason: 1000, rule: 300, scan: 5000, page: 200, max: 1e15 } as const;
const TREE = "budget-tree";
const LINK = "budget-link";
const ENTRY = "budget-entry";
const REQUEST = "budget-request";
const PRINCIPAL = /^(?:owner|agent|host):[a-z0-9][a-z0-9-]{0,39}$/;
const ACTIVITIES: readonly Activity[] = ["model-call", "background-job", "meeting", "supervision", "review"];
const CURRENCY = /^[A-Z]{3,8}$/;
const BACKEND_NAME = /^[a-z][a-z0-9-]{0,39}$/;
const cacheUsage = (value: unknown): CacheUsage | undefined => {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("cache", "must be an object");
  const v = value as Record<string, unknown>;
  for (const k of Object.keys(v)) if (!["backend", "route", "cachedTokens", "computedTokens", "writtenTokens"].includes(k)) invalid(`cache.${k}`, "is not a field here");
  if (typeof v["backend"] !== "string" || !BACKEND_NAME.test(v["backend"])) invalid("cache.backend", "must be a backend kind such as llama-cpp");
  if (typeof v["route"] !== "string" || !/^[A-Za-z][A-Za-z0-9._-]{0,63}\/[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/.test(v["route"])) invalid("cache.route", "must be provider/model");
  return { backend: v["backend"] as string, route: v["route"] as string, cachedTokens: whole(v["cachedTokens"], "cache.cachedTokens"), computedTokens: whole(v["computedTokens"], "cache.computedTokens"), writtenTokens: whole(v["writtenTokens"], "cache.writtenTokens") };
};
const zero = (): Mutable<Amounts> => ({ costMicros: 0, computeMs: 0 });
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const whole = (v: unknown, field: string): number => (Number.isSafeInteger(v) && (v as number) >= 0 && (v as number) <= BUDGET_LIMITS.max ? (v as number) : invalid(field, "must be a whole number from 0"));
const amounts = (c: { costMicros?: unknown; computeMs?: unknown }, positive: boolean): Amounts => {
  const a = { costMicros: c.costMicros === undefined ? 0 : whole(c.costMicros, "costMicros"), computeMs: c.computeMs === undefined ? 0 : whole(c.computeMs, "computeMs") };
  if (positive && a.costMicros === 0 && a.computeMs === 0) invalid("costMicros", "give a cost, a compute time or both (more than 0)");
  return a;
};
const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const principalId = (v: unknown, field: string): string => (typeof v === "string" && PRINCIPAL.test(v) ? v : invalid(field, "is not a principal ID"));
const clone = <T>(v: T): T => structuredClone(v);
const sum = (...parts: Amounts[]): Amounts => parts.reduce((t, p) => ({ costMicros: t.costMicros + p.costMicros, computeMs: t.computeMs + p.computeMs }), { costMicros: 0, computeMs: 0 });
const free = (n: Node): Amounts => ({ costMicros: Math.max(0, n.limit.costMicros - n.delegated.costMicros - n.reserved.costMicros - n.uncertain.costMicros - n.spent.costMicros), computeMs: Math.max(0, n.limit.computeMs - n.delegated.computeMs - n.reserved.computeMs - n.uncertain.computeMs - n.spent.computeMs) });
/** How far a node's spending plus what it handed on is above its limit, per dimension. Holds (in flight, uncertain) are left out: they are not spending, and a hold that is later released must not leave overrun behind. `free()` still counts them, so further reservations stay blocked. */
const over = (n: Node): Amounts => ({ costMicros: Math.max(0, n.spent.costMicros + n.delegated.costMicros - n.limit.costMicros), computeMs: Math.max(0, n.spent.computeMs + n.delegated.computeMs - n.limit.computeMs) });
const increase = (after: Amounts, before: Amounts): Amounts => ({ costMicros: Math.max(0, after.costMicros - before.costMicros), computeMs: Math.max(0, after.computeMs - before.computeMs) });
const fits = (want: Amounts, have: Amounts): boolean => want.costMicros <= have.costMicros && want.computeMs <= have.computeMs;
const addTo = (target: Mutable<Amounts>, a: Amounts): void => { target.costMicros += a.costMicros; target.computeMs += a.computeMs; if (target.costMicros > BUDGET_LIMITS.max || target.computeMs > BUDGET_LIMITS.max) invalid("costMicros", "the total would be too large"); };
const subFrom = (target: Mutable<Amounts>, a: Amounts): void => { target.costMicros -= a.costMicros; target.computeMs -= a.computeMs; };
const short = (a: Amounts, have: Amounts): string => `needs ${a.costMicros} micros and ${a.computeMs} ms; ${have.costMicros} micros and ${have.computeMs} ms are available`;

/**
 * Cost and resource attribution and delegated budgets (card R05). Money (provider spend, in millionths of one currency per tree) and local compute (occupied worker-slot milliseconds)
 * are tracked as two separate figures, never converted.
 *
 * **One record per task tree.** The root's allowance and every delegated sub-allowance live in a single `budget-tree` record, so a reservation, a delegation or a decision is one guarded
 * step on the whole tree: two children asking at once for the same allowance meet a revision check, the loser reads again and finds it gone (tested). Delegating moves allowance from the parent
 * to the child (the parent's available figure falls by what the child gets), so handing work down never multiplies what may be spent.
 *
 * **Reserve, then reconcile.** The dispatcher `reserve`s before it sends a call; the reservation counts against the task's own allowance. `settle` reports the actual use, which replaces the
 * estimate (a lower actual returns the difference; a higher one is recorded as overrun and blocks further reservations). A reservation whose outcome is unknown is marked `uncertain` and is
 * held at its full amount until reconciled by `settle`. Both in-flight and uncertain amounts are shown by `report`. Each settled reservation becomes one entry in the usage ledger, which also
 * takes direct `charge`s for work that is not reserved (background jobs, meetings, supervision).
 *
 * **Attribution.** An entry names its task, agent and project. A meeting, supervision or background cost either names the work it served (then it counts against that task) or is charged as
 * shared overhead under a written rule; there is no silent default.
 *
 * **More budget.** A task that needs more asks (`requestMore`); the request goes to the holder of its parent node, or to the owner when there is none. The owner's approval adds new money to the task
 * and to every ancestor on the path; a delegated holder's approval moves allowance from its own available (it cannot create any).
 *
 * The honest limit on ceilings is in `BUDGET_ENFORCEMENT` and appears in every report.
 */
export class BudgetService {
  readonly #runner: CommandRunner;
  readonly #pause: (attempt: number) => Promise<void>;

  readonly #notify: NotifyRequest | undefined;

  private constructor(runner: CommandRunner, pause: (attempt: number) => Promise<void>, notify: NotifyRequest | undefined) { this.#runner = runner; this.#pause = pause; this.#notify = notify; }

  /** `notify` tells the addressee of a new request for more budget (the owner, or the delegated holder); a failing notice never fails the request, which is stored and shown by `pending` whatever happens. */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { notify?: NotifyRequest } = {}): BudgetService {
    return new BudgetService(new CommandRunner(storage, epoch, options), options.pause ?? ((attempt) => new Promise((resolve) => setTimeout(resolve, Math.random() * Math.min(25, attempt * 2)))), options.notify);
  }

  /** The owner gives a task a root allowance of its own (new money). The task must exist and not already be in a budget tree. */
  async open(owner: Principal, command: NoActor & { taskId: string; currency: string; costMicros?: number; computeMs?: number; holder?: string }): Promise<{ id: string; replayed: boolean }> {
    this.#owner(owner, "opens a budget");
    onlyKnown(command, ["commandId", "taskId", "currency", "costMicros", "computeMs", "holder"]);
    const taskId = checkTaskId(command.taskId);
    const currency = typeof command.currency === "string" && CURRENCY.test(command.currency) ? command.currency : invalid("currency", "is a currency code such as USD");
    const limit = amounts(command, false);
    const holder = command.holder === undefined ? undefined : principalId(command.holder, "holder");
    const projectId = await this.#projectOf(taskId);
    const treeRef: AggregateRef = { kind: TREE, id: taskId };
    const linkRef: AggregateRef = { kind: LINK, id: taskId };
    const result = await this.#retrying(() => this.#runner.command("budget.open", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { taskId, currency, limit: limit as unknown as JsonObject, holder: holder ?? null },
      build: async () => {
        if ((await this.#runner.get(LINK, taskId)) !== undefined) throw new DomainError("invalid_command", "that task already has a budget", { field: "taskId" });
        const node: Node = { taskId, projectId, ...(holder === undefined ? {} : { holder }), limit: { ...limit }, delegated: zero(), reserved: zero(), uncertain: zero(), spent: zero(), overrun: zero(), children: [], openRequests: [] };
        const tree: TreeBody = { rootTaskId: taskId, projectId, currency, nodes: { [taskId]: node }, reservations: {} };
        return { ref: treeRef, creates: true, changes: [{ type: "create", ref: treeRef, body: tree as unknown as JsonObject }, { type: "create", ref: linkRef, body: { treeId: taskId } }], detail: { taskId }, contention: async () => new DomainError("stale_revision", "the budget changed meanwhile") };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * Hands part of a task's allowance to another task of the same project as that task's own budget. The caller is the owner, or the holder of the parent node with `budget.manage`.
   * What the child gets leaves the parent's available figure in the same step.
   */
  async delegate(by: Principal, command: NoActor & { parentTaskId: string; childTaskId: string; costMicros?: number; computeMs?: number; holder?: string }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "parentTaskId", "childTaskId", "costMicros", "computeMs", "holder"]);
    const parentId = checkTaskId(command.parentTaskId);
    const childId = checkTaskId(command.childTaskId);
    if (parentId === childId) invalid("childTaskId", "cannot be the parent itself");
    const give = amounts(command, true);
    const holder = command.holder === undefined ? undefined : principalId(command.holder, "holder");
    const parentLink = await this.#runner.get(LINK, parentId);
    const treeId = (parentLink?.body as unknown as { treeId: string } | undefined)?.treeId;
    const refused = (): DomainError => new DomainError("forbidden", `${by.id} may not delegate from that task's budget`);
    if (treeId === undefined) throw refused();
    const treeRef: AggregateRef = { kind: TREE, id: treeId };
    const result = await this.#retrying(() => this.#runner.command("budget.delegate", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { parentId, childId, give: give as unknown as JsonObject, holder: holder ?? null },
      build: async () => {
        const found = await this.#tree(treeId);
        const tree = clone(found.body);
        const parent = tree.nodes[parentId];
        if (parent === undefined || !this.#manages(by, parent)) throw refused();
        // Looked up only after the caller is known to hold the parent, so a caller without rights cannot tell a missing task from an existing one.
        if ((await this.#projectOf(childId)) !== tree.projectId) invalid("childTaskId", "must be a task of the same project");
        if ((await this.#runner.get(LINK, childId)) !== undefined) invalid("childTaskId", "already has a budget");
        if (Object.keys(tree.nodes).length >= BUDGET_LIMITS.nodes) invalid("childTaskId", `a budget tree has at most ${BUDGET_LIMITS.nodes} tasks`);
        if (this.#depth(tree, parentId) + 1 > BUDGET_LIMITS.depth) invalid("childTaskId", `a budget tree is at most ${BUDGET_LIMITS.depth} levels deep`);
        const have = free(parent);
        if (!fits(give, have)) throw new DomainError("invalid_command", `budget: the parent cannot give that (${short(give, have)})`, { field: "costMicros" });
        addTo(parent.delegated, give);
        parent.children.push(childId);
        tree.nodes[childId] = { taskId: childId, projectId: tree.projectId, parentId, ...(holder === undefined ? {} : { holder }), limit: { ...give }, delegated: zero(), reserved: zero(), uncertain: zero(), spent: zero(), overrun: zero(), children: [], openRequests: [] };
        const link: AggregateRef = { kind: LINK, id: childId };
        return { ref: treeRef, creates: false, changes: [{ type: "update", ref: treeRef, expectedRevision: found.revision, body: tree as unknown as JsonObject }, { type: "create", ref: link, body: { treeId } }], detail: { parentId, childId, ...give }, contention: async () => new DomainError("stale_revision", "the budget changed meanwhile") };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  /** The owner adds new money to a task and, so that nobody's available figure falls, to each ancestor above it. */
  async raise(owner: Principal, command: NoActor & { taskId: string; costMicros?: number; computeMs?: number }): Promise<void> {
    this.#owner(owner, "adds budget");
    onlyKnown(command, ["commandId", "taskId", "costMicros", "computeMs"]);
    const taskId = checkTaskId(command.taskId);
    const add = amounts(command, true);
    const treeId = await this.#treeIdOf(taskId, () => new DomainError("not_found", "that task has no budget"));
    const treeRef: AggregateRef = { kind: TREE, id: treeId };
    await this.#retrying(() => this.#runner.command("budget.raise", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { taskId, add: add as unknown as JsonObject },
      build: async () => {
        const found = await this.#tree(treeId);
        const tree = clone(found.body);
        this.#grow(tree, taskId, add);
        return { ref: treeRef, creates: false, changes: [{ type: "update", ref: treeRef, expectedRevision: found.revision, body: tree as unknown as JsonObject }], detail: { taskId, ...add } };
      },
    })));
  }

  /** Takes back what a finished child has not used: its limit falls to what it has spent, holds and handed on, and the parent's available figure rises by the difference. */
  async reclaim(by: Principal, command: NoActor & { taskId: string }): Promise<Amounts> {
    onlyKnown(command, ["commandId", "taskId"]);
    const taskId = checkTaskId(command.taskId);
    const treeId = await this.#treeIdOf(taskId, () => new DomainError("forbidden", `${by.id} may not reclaim from that task's budget`));
    const treeRef: AggregateRef = { kind: TREE, id: treeId };
    let returned: Amounts = { costMicros: 0, computeMs: 0 };
    await this.#retrying(() => this.#runner.command("budget.reclaim", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId },
      build: async () => {
        const found = await this.#tree(treeId);
        const tree = clone(found.body);
        const node = tree.nodes[taskId];
        const parent = node?.parentId === undefined ? undefined : tree.nodes[node.parentId];
        if (node === undefined || parent === undefined || !this.#manages(by, parent)) throw new DomainError("forbidden", `${by.id} may not reclaim from that task's budget`);
        returned = free(node);
        subFrom(node.limit, returned);
        subFrom(parent.delegated, returned);
        return { ref: treeRef, creates: false, changes: [{ type: "update", ref: treeRef, expectedRevision: found.revision, body: tree as unknown as JsonObject }], detail: { taskId, ...returned } };
      },
    })));
    return returned;
  }

  /**
   * Reserves an estimate against a task's own allowance before a call is dispatched. Refused (`invalid_command`, field `costMicros`, message beginning "budget:") when the task cannot cover it
   * or when earlier overrun has used it up; the dispatcher then waits or calls `requestMore`. A task with no budget is `not_found`: whether to dispatch it anyway is the dispatcher's policy.
   */
  async reserve(by: Principal, command: NoActor & { taskId: string; costMicros?: number; computeMs?: number; agentId?: string; purpose: string; activity?: Activity }): Promise<{ id: string; replayed: boolean }> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "taskId", "costMicros", "computeMs", "agentId", "purpose", "activity"]);
    const activity: Activity = command.activity === undefined ? "model-call" : ACTIVITIES.includes(command.activity) ? command.activity : invalid("activity", `must be one of ${ACTIVITIES.join(", ")}`);
    const taskId = checkTaskId(command.taskId);
    const want = amounts(command, true);
    const agentId = command.agentId === undefined ? undefined : principalId(command.agentId, "agentId");
    const purpose = plain(command.purpose, "purpose", BUDGET_LIMITS.purpose);
    const treeId = await this.#treeIdOf(taskId, () => new DomainError("not_found", "that task has no budget"));
    const treeRef: AggregateRef = { kind: TREE, id: treeId };
    const id = derivedId("bgr", scopedCommandId(by.id, command.commandId));
    const result = await this.#retrying(() => this.#runner.command("budget.reserve", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, want: want as unknown as JsonObject, agentId: agentId ?? null, purpose, activity },
      build: async () => {
        const found = await this.#tree(treeId);
        const tree = clone(found.body);
        const node = tree.nodes[taskId];
        if (node === undefined) throw new DomainError("not_found", "that task has no budget");
        if (Object.keys(tree.reservations).length >= BUDGET_LIMITS.reservations) throw new DomainError("invalid_command", `budget: ${BUDGET_LIMITS.reservations} reservations are already open in this tree; settle some`, { field: "costMicros" });
        const have = free(node);
        if (!fits(want, have)) throw new DomainError("invalid_command", `budget: task ${taskId} cannot reserve that (${short(want, have)}); ask for more with requestMore`, { field: "costMicros" });
        addTo(node.reserved, want);
        tree.reservations[id] = { id, taskId, ...(agentId === undefined ? {} : { agentId }), amounts: want, purpose, activity, by: by.id, at: this.#runner.now(), state: "open" };
        return { ref: treeRef, creates: false, changes: [{ type: "update", ref: treeRef, expectedRevision: found.revision, body: tree as unknown as JsonObject }, { type: "create", ref: { kind: "budget-reservation", id }, body: { treeId } }], detail: { taskId, reservationId: id, ...want }, contention: async () => new DomainError("stale_revision", "the budget changed meanwhile") };
      },
    })));
    return { id, replayed: result.replayed };
  }

  /** The outcome of the call is not known (the dispatcher lost it). The reservation is held at its full amount and shown as uncertain until `settle`. */
  async markUncertain(by: Principal, command: NoActor & { reservationId: string; reason: string }): Promise<void> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "reservationId", "reason"]);
    const id = this.#resId(command.reservationId);
    const reason = plain(command.reason, "reason", BUDGET_LIMITS.purpose);
    const found0 = await this.#reservationTree(id);
    const treeRef: AggregateRef = { kind: TREE, id: found0 };
    await this.#retrying(() => this.#runner.command("budget.uncertain", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { id, reason },
      build: async () => {
        const found = await this.#tree(found0);
        const tree = clone(found.body);
        const res = tree.reservations[id];
        if (res === undefined) throw new DomainError("invalid_transition", "that reservation is already settled or released");
        if (res.state === "uncertain") throw new DomainError("invalid_transition", "that reservation is already uncertain");
        const node = tree.nodes[res.taskId]!;
        subFrom(node.reserved, res.amounts);
        addTo(node.uncertain, res.amounts);
        res.state = "uncertain";
        res.uncertainReason = reason;
        return { ref: treeRef, creates: false, changes: [{ type: "update", ref: treeRef, expectedRevision: found.revision, body: tree as unknown as JsonObject }], detail: { reservationId: id } };
      },
    })));
  }

  /**
   * Reconciles a reservation to actual use (open or uncertain): the hold is released, the actual amounts become spending of the task and one ledger entry is written. Use above the reservation is
   * recorded as overrun. Settling nothing (0 and 0) is how a call that provably never happened gives its hold back.
   */
  async settle(by: Principal, command: NoActor & { reservationId: string; costMicros?: number; computeMs?: number; cache?: CacheUsage }): Promise<void> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "reservationId", "costMicros", "computeMs", "cache"]);
    const id = this.#resId(command.reservationId);
    const actual = amounts(command, false);
    const cache = cacheUsage(command.cache);
    const treeId = await this.#reservationTree(id);
    const treeRef: AggregateRef = { kind: TREE, id: treeId };
    await this.#retrying(() => this.#runner.command("budget.settle", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { id, actual: actual as unknown as JsonObject, cache: (cache ?? null) as unknown as JsonObject },
      build: async () => {
        const found = await this.#tree(treeId);
        const tree = clone(found.body);
        const res = tree.reservations[id];
        if (res === undefined) throw new DomainError("invalid_transition", "that reservation is already settled");
        const node = tree.nodes[res.taskId]!;
        // Overrun is the increase in how far the node's commitments are above its limit across this step, so a use above the reservation counts once however many other holds are open.
        this.#step(tree, node.taskId, () => { subFrom(res.state === "open" ? node.reserved : node.uncertain, res.amounts); addTo(node.spent, actual); });
        delete tree.reservations[id];
        const entry: UsageEntry = { taskId: res.taskId, projectId: tree.projectId, ...(res.agentId === undefined ? {} : { agentId: res.agentId }), activity: res.activity ?? "model-call", category: "work", ...actual, currency: tree.currency, reservationId: id, reservedCostMicros: res.amounts.costMicros, reservedComputeMs: res.amounts.computeMs, ...(cache === undefined ? {} : { cache }), by: by.id, at: this.#runner.now() };
        const ref: AggregateRef = { kind: ENTRY, id };
        return { ref: treeRef, creates: false, changes: [{ type: "update", ref: treeRef, expectedRevision: found.revision, body: tree as unknown as JsonObject }, { type: "create", ref, body: entry as unknown as JsonObject }], detail: { reservationId: id, taskId: res.taskId, ...actual } };
      },
    })));
  }

  /** Gives back a reservation that was never dispatched (open only; an uncertain one must be settled with what actually happened). */
  async release(by: Principal, command: NoActor & { reservationId: string }): Promise<void> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "reservationId"]);
    const id = this.#resId(command.reservationId);
    const treeId = await this.#reservationTree(id);
    const treeRef: AggregateRef = { kind: TREE, id: treeId };
    await this.#retrying(() => this.#runner.command("budget.release", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { id },
      build: async () => {
        const found = await this.#tree(treeId);
        const tree = clone(found.body);
        const res = tree.reservations[id];
        if (res === undefined) throw new DomainError("invalid_transition", "that reservation is already settled or released");
        if (res.state === "uncertain") throw new DomainError("invalid_transition", "an uncertain reservation is settled with what actually happened, not released");
        subFrom(tree.nodes[res.taskId]!.reserved, res.amounts);
        delete tree.reservations[id];
        return { ref: treeRef, creates: false, changes: [{ type: "update", ref: treeRef, expectedRevision: found.revision, body: tree as unknown as JsonObject }], detail: { reservationId: id } };
      },
    })));
  }

  /**
   * Records use that was not reserved (a background job, a meeting, supervision, a review, or a call made without a reservation). Name the work it served with `taskId`, or give the `rule`
   * under which it is shared overhead; exactly one of the two. Work charged to a task that has a budget counts as its spending (and as overrun where it exceeds what was free).
   */
  async charge(by: Principal, command: NoActor & { activity: Activity; taskId?: string; sharedOverheadRule?: string; projectId?: string; agentId?: string; costMicros?: number; computeMs?: number; cache?: CacheUsage }): Promise<{ id: string; replayed: boolean }> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "activity", "taskId", "sharedOverheadRule", "projectId", "agentId", "costMicros", "computeMs", "cache"]);
    const cache = cacheUsage(command.cache);
    if (!ACTIVITIES.includes(command.activity)) invalid("activity", `must be one of ${ACTIVITIES.join(", ")}`);
    if ((command.taskId === undefined) === (command.sharedOverheadRule === undefined)) invalid("taskId", "name the work this served (taskId) or the rule it is shared overhead under (sharedOverheadRule), not both and not neither");
    const used = amounts(command, false);
    const agentId = command.agentId === undefined ? undefined : principalId(command.agentId, "agentId");
    const rule = command.sharedOverheadRule === undefined ? undefined : plain(command.sharedOverheadRule, "sharedOverheadRule", BUDGET_LIMITS.rule);
    let taskId: string | undefined;
    let projectId: string | undefined;
    if (command.taskId !== undefined) { taskId = checkTaskId(command.taskId); projectId = await this.#projectOf(taskId); if (command.projectId !== undefined && command.projectId !== projectId) invalid("projectId", "is not the task's project"); }
    else if (command.projectId !== undefined) { projectId = command.projectId; if (!/^proj-[a-z2-7]{20}$/.test(projectId) || (await this.#runner.get("project", projectId)) === undefined) invalid("projectId", "is not a project"); }
    const id = derivedId("bgl", scopedCommandId(by.id, command.commandId));
    const entryRef: AggregateRef = { kind: ENTRY, id };
    let guarded = false;
    const result = await this.#retrying(() => this.#runner.command("budget.charge", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { activity: command.activity, taskId: taskId ?? null, rule: rule ?? null, projectId: projectId ?? null, agentId: agentId ?? null, used: used as unknown as JsonObject, cache: (cache ?? null) as unknown as JsonObject },
      build: async () => {
        const changes: Change[] = [];
        let currency: string | undefined;
        const link = taskId === undefined ? undefined : (await this.#runner.get(LINK, taskId))?.body as unknown as { treeId: string } | undefined;
        guarded = link !== undefined;
        if (link !== undefined && taskId !== undefined) {
          const found = await this.#tree(link.treeId);
          const tree = clone(found.body);
          const node = tree.nodes[taskId]!;
          this.#step(tree, taskId, () => addTo(node.spent, used));
          currency = tree.currency;
          changes.push({ type: "update", ref: { kind: TREE, id: link.treeId }, expectedRevision: found.revision, body: tree as unknown as JsonObject });
        }
        const entry: UsageEntry = { ...(taskId === undefined ? {} : { taskId }), ...(projectId === undefined ? {} : { projectId }), ...(agentId === undefined ? {} : { agentId }), activity: command.activity, category: taskId === undefined ? "shared-overhead" : "work", ...(rule === undefined ? {} : { rule }), ...used, ...(currency === undefined ? {} : { currency }), ...(cache === undefined ? {} : { cache }), by: by.id, at: this.#runner.now() };
        changes.push({ type: "create", ref: entryRef, body: entry as unknown as JsonObject });
        return { ref: entryRef, creates: true, changes, detail: { activity: command.activity, taskId: taskId ?? null, category: entry.category }, contention: async () => (!guarded ? new DomainError("command_conflict", "this command ID was used by something else") : new DomainError("stale_revision", "the budget changed meanwhile")) };
      },
    })));
    return { id, replayed: result.replayed };
  }

  /** A task asks for more budget. It goes to the holder of the parent node, or to the owner (a root, or a parent with no holder). */
  async requestMore(by: Principal, command: NoActor & { taskId: string; costMicros?: number; computeMs?: number; reason: string }): Promise<{ id: string; to: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "costMicros", "computeMs", "reason"]);
    const taskId = checkTaskId(command.taskId);
    const want = amounts(command, true);
    const reason = plain(command.reason, "reason", BUDGET_LIMITS.reason);
    const refused = (): DomainError => new DomainError("forbidden", `${by.id} may not ask for budget for that task`);
    // A missing task, a task with no budget and a task the caller may not act on are all the same refusal.
    const treeId = await this.#treeIdOf(taskId, refused);
    const treeRef: AggregateRef = { kind: TREE, id: treeId };
    const id = derivedId("bgq", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: REQUEST, id };
    let to = "owner";
    const result = await this.#retrying(() => this.#runner.command("budget.request", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, want: want as unknown as JsonObject, reason },
      build: async () => {
        const found = await this.#tree(treeId);
        const tree = clone(found.body);
        const node = tree.nodes[taskId];
        if (node === undefined || !inTaskScope(by, node.projectId) || !(allows(by, "attempt.work", node.projectId, { resource: { kind: "task", id: taskId } }) || allows(by, "budget.manage", node.projectId, { resource: { kind: "task", id: taskId } }))) throw refused();
        if (node.openRequests.length >= BUDGET_LIMITS.openRequestsPerTask) throw new DomainError("invalid_command", `that task already has ${BUDGET_LIMITS.openRequestsPerTask} open requests for more budget`, { field: "taskId" });
        const parent = node.parentId === undefined ? undefined : tree.nodes[node.parentId];
        to = parent?.holder ?? "owner";
        node.openRequests.push(id);
        const body: BudgetRequestBody = { taskId, treeId, requestedBy: by.id, ...want, reason, to, state: "open", at: this.#runner.now() };
        return { ref, creates: true, changes: [{ type: "update", ref: treeRef, expectedRevision: found.revision, body: tree as unknown as JsonObject }, { type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, to, ...want }, contention: async () => new DomainError("stale_revision", "the budget changed meanwhile") };
      },
    })));
    if (result.replayed) to = ((await this.#runner.get(REQUEST, id))?.body as unknown as BudgetRequestBody).to;
    else if (this.#notify !== undefined) {
      const tree = (await this.#tree(treeId)).body;
      try { await this.#notify({ requestId: id, taskId, ...(tree.nodes[taskId]?.parentId === undefined ? {} : { parentTaskId: tree.nodes[taskId]!.parentId! }), to, requestedBy: by.id, costMicros: want.costMicros, computeMs: want.computeMs }); } catch { /* the request is stored; `pending` shows it */ }
    }
    return { id, to, replayed: result.replayed };
  }

  /**
   * Decides a request. The owner may approve (new money added along the path to the root) or deny any request. The holder the request was addressed to, with `budget.manage`, may approve
   * only by moving allowance from its own node, so it cannot grant what it does not have. `granted` may be less than asked.
   */
  async decide(by: Principal, command: NoActor & { requestId: string; approve: boolean; costMicros?: number; computeMs?: number; note?: string }): Promise<void> {
    onlyKnown(command, ["commandId", "requestId", "approve", "costMicros", "computeMs", "note"]);
    if (typeof command.requestId !== "string" || !/^bgq-[a-z2-7]{20}$/.test(command.requestId)) invalid("requestId", "is not a budget request ID");
    if (typeof command.approve !== "boolean") invalid("approve", "must be true or false");
    const note = command.note === undefined ? undefined : plain(command.note, "note", BUDGET_LIMITS.reason);
    const requestId = command.requestId;
    const first = (await this.#runner.get(REQUEST, requestId))?.body as unknown as BudgetRequestBody | undefined;
    const refused = (): DomainError => new DomainError("forbidden", `${by.id} may not decide that request`);
    if (first === undefined) throw refused();
    const treeRef: AggregateRef = { kind: TREE, id: first.treeId };
    const reqRef: AggregateRef = { kind: REQUEST, id: requestId };
    const grant0 = command.approve ? amounts({ costMicros: command.costMicros ?? first.costMicros, computeMs: command.computeMs ?? first.computeMs }, true) : undefined;
    await this.#retrying(() => this.#runner.command("budget.decide", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { requestId, approve: command.approve, grant: (grant0 ?? null) as unknown as JsonObject, note: note ?? null },
      build: async () => {
        const reqFound = await this.#runner.get(REQUEST, requestId);
        const req = reqFound?.body as unknown as BudgetRequestBody | undefined;
        if (reqFound === undefined || req === undefined) throw refused();
        const found = await this.#tree(req.treeId);
        const tree = clone(found.body);
        const node = tree.nodes[req.taskId];
        const parent = node?.parentId === undefined ? undefined : tree.nodes[node.parentId];
        const owner = by.kind === "owner";
        const delegated = !owner && req.to === by.id && parent !== undefined && this.#manages(by, parent);
        if (node === undefined || !(owner || delegated)) throw refused();
        if (req.state !== "open") throw new DomainError("invalid_transition", `that request is already ${req.state}`);
        if (grant0 !== undefined && (grant0.costMicros > req.costMicros || grant0.computeMs > req.computeMs)) invalid("costMicros", "cannot grant more than was asked for");
        node.openRequests = node.openRequests.filter((r) => r !== requestId);
        const next: BudgetRequestBody = { ...req, state: grant0 === undefined ? "denied" : "approved", decidedBy: by.id, decidedAt: this.#runner.now(), ...(grant0 === undefined ? {} : { grantedCostMicros: grant0.costMicros, grantedComputeMs: grant0.computeMs }), ...(note === undefined ? {} : { note }) };
        if (grant0 !== undefined) {
          if (owner) this.#grow(tree, req.taskId, grant0);
          else {
            const have = free(parent!);
            if (!fits(grant0, have)) throw new DomainError("invalid_command", `budget: the parent cannot give that (${short(grant0, have)}); it must ask for more itself`, { field: "costMicros" });
            addTo(parent!.delegated, grant0);
            addTo(node.limit, grant0);
          }
        }
        return { ref: reqRef, creates: false, changes: [{ type: "update", ref: reqRef, expectedRevision: reqFound.revision, body: next as unknown as JsonObject }, { type: "update", ref: treeRef, expectedRevision: found.revision, body: tree as unknown as JsonObject }], detail: { requestId, decision: next.state }, contention: async () => new DomainError("stale_revision", "the budget changed meanwhile") };
      },
    })));
  }

  /**
   * The open requests addressed to the caller (the owner: all that went to the owner), found without knowing their tasks. Scans at most 5000 request records in storage order (which is by
   * ID hash, not by age), so when `truncated` is true the list is a partial sample and older open requests may be missing; a caller that must not miss any also reads each task's `report`.
   */
  async pending(by: Principal): Promise<{ requests: (BudgetRequestBody & { id: string })[]; truncated: boolean }> {
    const to = by.kind === "owner" ? "owner" : by.id;
    const requests: (BudgetRequestBody & { id: string })[] = [];
    let scanned = 0, truncated = false;
    for (let after: string | undefined; !truncated;) {
      const page = await this.#runner.list(REQUEST, { ...(after === undefined ? {} : { afterId: after }), limit: BUDGET_LIMITS.page });
      for (const a of page) {
        after = a.id;
        if (++scanned > BUDGET_LIMITS.scan) { truncated = true; break; }
        const r = a.body as unknown as BudgetRequestBody;
        if (r.state === "open" && r.to === to) requests.push({ ...r, id: a.id });
      }
      if (page.length < BUDGET_LIMITS.page) break;
    }
    return { requests, truncated };
  }

  /** One request. Readable by its requester, the addressee and the owner; anyone else sees nothing. */
  async request(by: Principal, requestId: string): Promise<(BudgetRequestBody & { id: string }) | undefined> {
    const found = (await this.#runner.get(REQUEST, typeof requestId === "string" ? requestId : ""))?.body as unknown as BudgetRequestBody | undefined;
    if (found === undefined) return undefined;
    return by.kind === "owner" || by.id === found.requestedBy || by.id === found.to ? { ...found, id: requestId } : undefined;
  }

  /** A task's budget: limit, delegated, in flight, uncertain, spent, overrun and available, separately for money and compute, with the reservations and requests behind them. Unreadable reads like missing. */
  async report(by: Principal, taskId: string): Promise<BudgetReport | undefined> {
    const id = checkTaskId(taskId);
    const task = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !this.#mayRead(by, task.projectId, id)) return undefined;
    return this.#reportOf(id);
  }

  /**
   * The same report for the controller's own dispatcher (card H12), which holds the owner's authority for the controller's routine steps: owner, host or service only, never an agent or a task credential.
   * It is how the policy gets the spend so far and how a tool call is refused when the budget is used up: from accounting, not from what the agent says.
   */
  async accounting(by: Principal, taskId: string): Promise<BudgetReport | undefined> {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service") || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not read budget accounting for the dispatcher`);
    return this.#reportOf(checkTaskId(taskId));
  }

  async #reportOf(id: string): Promise<BudgetReport | undefined> {
    const link = (await this.#runner.get(LINK, id))?.body as unknown as { treeId: string } | undefined;
    if (link === undefined) return undefined;
    const tree = (await this.#tree(link.treeId)).body;
    const node = tree.nodes[id];
    if (node === undefined) return undefined;
    const subtree = { reserved: zero(), uncertain: zero(), spent: zero(), nodes: 0 };
    const stack = [node];
    for (let n = stack.pop(); n !== undefined; n = stack.pop()) {
      subtree.nodes++;
      addTo(subtree.reserved, n.reserved); addTo(subtree.uncertain, n.uncertain); addTo(subtree.spent, n.spent);
      for (const c of n.children) { const child = tree.nodes[c]; if (child !== undefined) stack.push(child); }
    }
    const pendingRequests: BudgetReport["pendingRequests"][number][] = [];
    for (const rid of node.openRequests) { const r = (await this.#runner.get(REQUEST, rid))?.body as unknown as BudgetRequestBody | undefined; if (r !== undefined) pendingRequests.push({ id: rid, costMicros: r.costMicros, computeMs: r.computeMs, to: r.to, reason: r.reason }); }
    return {
      taskId: id, currency: tree.currency, ...(node.holder === undefined ? {} : { holder: node.holder }), ...(node.parentId === undefined ? {} : { parentId: node.parentId }),
      limit: { ...node.limit }, delegatedToChildren: { ...node.delegated }, reservedInFlight: { ...node.reserved }, uncertain: { ...node.uncertain }, spent: { ...node.spent }, overrun: { ...node.overrun }, available: free(node), outstanding: sum(node.reserved, node.uncertain),
      reservations: Object.values(tree.reservations).filter((r) => r.taskId === id).map((r) => ({ id: r.id, ...(r.agentId === undefined ? {} : { agentId: r.agentId }), ...r.amounts, state: r.state, purpose: r.purpose, at: r.at, ...(r.uncertainReason === undefined ? {} : { uncertainReason: r.uncertainReason }) })),
      children: [...node.children], pendingRequests, subtree, enforcement: BUDGET_ENFORCEMENT,
    };
  }

  /**
   * Totals from the usage ledger, by category, activity, agent, task and project, with money and compute side by side but never added together. With `projectId` the caller needs `budget.read` for
   * it; without any filter on project, `budget.read` for every project (a grant for `*`) is needed, because shared overhead belongs to no project. Scans at most 5000 entries.
   */
  async usage(by: Principal, filter: { projectId?: string; taskId?: string; agentId?: string; category?: "work" | "shared-overhead" } = {}): Promise<UsageSummary> {
    onlyKnown(filter, ["projectId", "taskId", "agentId", "category"]);
    if (filter.projectId !== undefined && !(typeof filter.projectId === "string" && /^proj-[a-z2-7]{20}$/.test(filter.projectId))) invalid("projectId", "is not a project ID");
    if (filter.taskId !== undefined) checkTaskId(filter.taskId);
    if (filter.agentId !== undefined) principalId(filter.agentId, "agentId");
    if (filter.category !== undefined && filter.category !== "work" && filter.category !== "shared-overhead") invalid("category", "is work or shared-overhead");
    if (!allows(by, "budget.read", filter.projectId) || (filter.projectId === undefined && by.taskScope !== undefined)) throw new DomainError("forbidden", `${by.id} may not read usage${filter.projectId === undefined ? " across projects" : " of that project"}`);
    const totals = zero();
    const group = (): Record<string, Mutable<Amounts>> => ({});
    const byCategory = group(), byActivity = group(), byAgent = group(), byTask = group(), byProject = group();
    const bump = (m: Record<string, Mutable<Amounts>>, key: string, e: UsageEntry): void => { const t = (m[key] ??= zero()); t.costMicros += e.costMicros; t.computeMs += e.computeMs; };
    const rules = new Set<string>();
    const cache = { cachedTokens: 0, computedTokens: 0, writtenTokens: 0, calls: 0 };
    const cacheByBackend: Record<string, typeof cache> = {};
    let entries = 0, scanned = 0, truncated = false;
    for (let after: string | undefined; !truncated;) {
      const page = await this.#runner.list(ENTRY, { ...(after === undefined ? {} : { afterId: after }), limit: BUDGET_LIMITS.page });
      for (const a of page) {
        after = a.id;
        if (++scanned > BUDGET_LIMITS.scan) { truncated = true; break; }
        const e = a.body as unknown as UsageEntry;
        if ((filter.projectId !== undefined && e.projectId !== filter.projectId) || (filter.taskId !== undefined && e.taskId !== filter.taskId) || (filter.agentId !== undefined && e.agentId !== filter.agentId) || (filter.category !== undefined && e.category !== filter.category)) continue;
        entries++;
        totals.costMicros += e.costMicros; totals.computeMs += e.computeMs;
        bump(byCategory, e.category, e); bump(byActivity, e.activity, e); bump(byAgent, e.agentId ?? "unattributed", e); bump(byTask, e.taskId ?? "none", e); bump(byProject, e.projectId ?? "none", e);
        if (e.rule !== undefined) rules.add(e.rule);
        if (e.cache !== undefined) {
          const b = (cacheByBackend[e.cache.backend] ??= { cachedTokens: 0, computedTokens: 0, writtenTokens: 0, calls: 0 });
          for (const t of [cache, b]) { t.cachedTokens += e.cache.cachedTokens; t.computedTokens += e.cache.computedTokens; t.writtenTokens += e.cache.writtenTokens; t.calls++; }
        }
      }
      if (page.length < BUDGET_LIMITS.page) break;
    }
    return { totals, byCategory, byActivity, byAgent, byTask, byProject, cache, cacheByBackend, entries, truncated, overheadRules: [...rules].sort() };
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  #owner(by: Principal, what: string): void { if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the owner; only the owner ${what}`); }
  #dispatcher(by: Principal): void { if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} is not the dispatcher; reservations and charges are the controller's and its hosts'`); }
  #resId(v: unknown): string { return typeof v === "string" && /^bgr-[a-z2-7]{20}$/.test(v) ? v : invalid("reservationId", "is not a reservation ID"); }
  #manages(by: Principal, node: Node): boolean { return by.kind === "owner" || (node.holder === by.id && allows(by, "budget.manage", node.projectId, { resource: { kind: "task", id: node.taskId } }) && inTaskScope(by, node.projectId)); }
  #mayRead(by: Principal, projectId: string, taskId: string): boolean { return inTaskScope(by, projectId) && (allows(by, "budget.read", projectId, { resource: { kind: "task", id: taskId } }) || allows(by, "budget.manage", projectId, { resource: { kind: "task", id: taskId } })); }

  async #projectOf(taskId: string): Promise<string> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", "no such task");
    return task.projectId;
  }
  async #treeIdOf(taskId: string, otherwise: () => DomainError): Promise<string> {
    const link = (await this.#runner.get(LINK, taskId))?.body as unknown as { treeId: string } | undefined;
    if (link === undefined) throw otherwise();
    return link.treeId;
  }
  async #tree(treeId: string): Promise<{ body: TreeBody; revision: number }> {
    const found = await this.#runner.get(TREE, treeId);
    if (found === undefined) throw new DomainError("not_found", "no such budget");
    return { body: found.body as unknown as TreeBody, revision: found.revision };
  }
  /** The tree holding a reservation, from the small link record `reserve` leaves (it stays after settlement, so a repeated settle is recognised as a repeat or refused as already settled). */
  async #reservationTree(id: string): Promise<string> {
    const found = (await this.#runner.get("budget-reservation", id))?.body as unknown as { treeId: string } | undefined;
    if (found === undefined) throw new DomainError("not_found", "no such reservation");
    return found.treeId;
  }
  /** Applies a change to a node and records any increase in its overrun; the excess is passed up (each ancestor's handed-on figure grows by it) so a parent sees what its children really consumed. */
  #step(tree: TreeBody, taskId: string, mutate: () => void): void {
    const node = tree.nodes[taskId]!;
    const before = over(node);
    mutate();
    let excess = increase(over(node), before);
    addTo(node.overrun, excess);
    for (let n = node; (excess.costMicros > 0 || excess.computeMs > 0) && n.parentId !== undefined;) {
      const parent = tree.nodes[n.parentId]!;
      const was = over(parent);
      addTo(parent.delegated, excess);
      excess = increase(over(parent), was);
      addTo(parent.overrun, excess);
      n = parent;
    }
  }
  #depth(tree: TreeBody, taskId: string): number { let d = 1; for (let n = tree.nodes[taskId]; n?.parentId !== undefined; n = tree.nodes[n.parentId]) d++; return d; }
  /** New money for a task: its limit and every ancestor's limit and delegated rise together, so no available figure above it falls. */
  #grow(tree: TreeBody, taskId: string, add: Amounts): void {
    const node = tree.nodes[taskId]!;
    addTo(node.limit, add);
    for (let n = node; n.parentId !== undefined;) { const p = tree.nodes[n.parentId]!; addTo(p.limit, add); addTo(p.delegated, add); n = p; }
  }

  /** The tree is one record, so concurrent decisions take turns: the loser reads again and decides again (up to 80 tries, with a short random pause). */
  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    let conflicts = 0;
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        const race = error instanceof DomainError && error.code === "stale_revision";
        const first = error instanceof DomainError && error.code === "command_conflict" && ++conflicts <= 3;
        if (!(race || first) || attempt >= 80) throw error;
        await this.#pause(attempt);
      }
    }
  }
}
