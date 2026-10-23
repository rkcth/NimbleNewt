import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { assignmentIdOf as derivedAssignmentId, type AssignmentBody } from "../domain/assignment-model.js";
import type { BlockerBody } from "../domain/blockers.js";
import { DIFFICULTIES, type ContractBody, type ContractService, type Difficulty } from "../planning/index.js";
import { allows, allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, PrincipalBody, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { ROUTING_LIMITS, selectRoute, type Candidate } from "./policy.js";
import type { RoutingBody, RoutingService } from "./service.js";

/** What one named profile says about how work of some difficulty is run. Every field is the owner's choice: nothing here has a built-in value. */
export interface ExecProfile {
  /** The harness that runs the work (a name from the owner's configuration). */
  readonly harness?: string;
  /** With `model`: the route tried first (`provider/model`, which must be in the routing table). */
  readonly provider?: string;
  readonly model?: string;
  /** A routing-table profile (R01) whose routes follow, in order. At least one of this and provider/model is required. */
  readonly routingProfile?: string;
  readonly reasoning?: { readonly effort?: "none" | "low" | "medium" | "high"; readonly maxThinkingTokens?: number };
  /** The context the work needs, in tokens; a route that supports less is skipped. */
  readonly contextTokens?: number;
  /** Capabilities the route must have. */
  readonly needs?: readonly string[];
  /** Action names the work may use, at most (a ceiling, as the contract's list; enforced by the tool path). */
  readonly tools?: readonly string[];
  /** The most the work may spend, in millionths of the currency. 0 means no paid route is chosen for it. */
  readonly spendLimitMicros?: number;
}

export type MappedLevel = Difficulty | "unrated";
export interface ProfilesBody {
  readonly profiles: Readonly<Record<string, ExecProfile>>;
  /** Which profile each difficulty uses. A difficulty with no entry has no profile: nothing is invented. `unrated` is for a task with no difficulty set. */
  readonly mapping: Readonly<Partial<Record<MappedLevel, string>>>;
  readonly updatedBy: string;
}

/** A task handed to a child: who delegated it (the parent), the child, and the most difficulty the child may raise the task to without asking. */
export interface DelegationBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly parent: string;
  readonly child: string;
  readonly ceiling: Difficulty;
  /** How many requests for the same target level a child may make (a denied request asked again counts). */
  readonly retryBudget: number;
  /** How many escalation requests in all a child may make for this task. */
  readonly totalBudget: number;
  /** Counts every change to the task's escalations, so two at once cannot both pass the checks. */
  readonly touched: number;
  /** Starts at 0; a redelegation, or the parent's decision on a stopped request, begins a new round: the budgets count only the requests of the current round. */
  readonly round?: number;
  readonly setBy: string;
}

export type EscalationState = "applied" | "pending" | "approved" | "denied" | "stopped";
export interface EscalationBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly kind: "blocked" | "failing";
  readonly requestedBy: string;
  readonly from?: Difficulty;
  readonly to: Difficulty;
  readonly reason: string;
  /** What showed the child was blocked or failing: the open blocker, or the attempts admitted so far. */
  readonly evidence: { readonly blockerId?: string; readonly attempts?: number };
  readonly state: EscalationState;
  /** `ceiling`: within what the parent delegated, applied at once. `parent`: above it, so the parent decides. */
  /** Absent on a request that was stopped by a budget (nothing was routed anywhere). */
  readonly route?: "ceiling" | "parent";
  readonly round?: number;
  /** The assignment's admitted attempts when this request changed the difficulty: later 'failing' evidence counts attempts after it. */
  readonly attemptsAtChange?: number;
  readonly decidedBy?: string;
  readonly decisionReason?: string;
  /** For `stopped`: which budget ended the loop. */
  readonly stopReason?: string;
  readonly requestedAt: string;
}

export interface DecisionBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly role: string;
  readonly difficulty?: Difficulty;
  readonly profileName?: string;
  /** The profile as it was at this dispatch; a later change does not touch it. */
  readonly profile?: ExecProfile;
  readonly profilesRevision: number;
  readonly routingRevision?: number;
  readonly outcome: "chosen" | "no-choice";
  readonly route?: string;
  readonly candidates: readonly Candidate[];
  /** Why there is no choice, or why the profile was not usable; empty when a route was chosen. */
  readonly reasons: readonly string[];
  /** What the dispatcher asked for, with the profile's own needs folded in. */
  readonly request: { readonly contextTokens: number; readonly needs: readonly string[]; readonly data: "local-only" | "cloud-allowed"; readonly paidAuthorized: boolean };
  readonly decidedBy: string;
  readonly decidedAt: string;
}

export const DIFFICULTY_LIMITS = { profiles: 20, name: 64, reason: 500, tools: 100, defaultRetry: 2, defaultTotal: 5, maxRetry: 10, maxTotal: 20, failingAttempts: 2, spend: 1e15, thinking: 1_000_000 } as const;

const NAME = /^[A-Za-z][A-Za-z0-9._-]{0,63}$/;
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
const CAPABILITY = /^[a-z][a-z0-9-]{0,39}$/;
const ACTION = /^(?:\*|[a-z][a-z0-9-]*(?:\.[a-z0-9-]+)*(?:\.\*)?)$/;
const EFFORT = ["none", "low", "medium", "high"] as const;
const PROFILES: AggregateRef = { kind: "difficulty-profiles", id: "profiles" };
const ROUTING: AggregateRef = { kind: "routing-table", id: "routing" };
const decisionKind = (taskId: string): string => `rdc-${taskId}`;
const escalationKind = (taskId: string): string => `esc-${taskId}`;
const rank = (d: Difficulty | undefined): number => (d === undefined ? -1 : DIFFICULTIES.indexOf(d));
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const own = <T>(map: Readonly<Record<string, T>>, key: string): T | undefined => (Object.hasOwn(map, key) ? map[key] : undefined);
const whole = (v: unknown, field: string, min: number, max: number): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= min && v <= max ? v : invalid(field, `must be a whole number from ${min} to ${max}`));
const exact = (value: unknown, field: string, keys: readonly string[]): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be an object");
  for (const key of Object.keys(value)) if (!keys.includes(key)) invalid(`${field}.${key}`, "is not a field here");
  return value as Record<string, unknown>;
};
const nameOf = (v: unknown, field: string): string => (typeof v === "string" && NAME.test(v) ? v : invalid(field, "must start with a letter and use letters, digits, '.', '_' or '-' (at most 64 characters)"));
const list = (v: unknown, field: string, max: number, ok: (s: string) => boolean, what: string): string[] => {
  if (!Array.isArray(v) || v.length > max) return invalid(field, `must be a list of at most ${max}`);
  const out = v.map((x, i) => (typeof x === "string" && ok(x) ? x : invalid(`${field}[${i}]`, `must be ${what}`)));
  if (new Set(out).size !== out.length) invalid(field, "lists an entry twice");
  return out;
};
function reasonOf(value: unknown, field = "reason"): string {
  const out = text(value, field, { min: 1, max: DIFFICULTY_LIMITS.reason });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
}

/** Checks a proposal for the profiles and the mapping completely against the routing table of now, and returns a normalised copy. */
export function checkProfiles(value: unknown, table: RoutingBody | undefined): Omit<ProfilesBody, "updatedBy"> {
  const top = exact(value, "profiles", ["profiles", "mapping"]);
  const rawProfiles = top["profiles"];
  if (rawProfiles === null || typeof rawProfiles !== "object" || Array.isArray(rawProfiles)) invalid("profiles.profiles", "must be an object");
  const entries = Object.entries(rawProfiles as object);
  if (entries.length > DIFFICULTY_LIMITS.profiles) invalid("profiles.profiles", `must have at most ${DIFFICULTY_LIMITS.profiles} entries`);
  if (entries.length > 0 && table === undefined) invalid("profiles.profiles", "there is no routing table yet; configure routing first");
  const profiles: Record<string, ExecProfile> = Object.create(null) as Record<string, ExecProfile>;
  for (const [name, raw] of entries) {
    nameOf(name, `profiles.profiles.${name}`);
    const f = `profiles.profiles.${name}`;
    const e = exact(raw, f, ["harness", "provider", "model", "routingProfile", "reasoning", "contextTokens", "needs", "tools", "spendLimitMicros"]);
    const out: Record<string, unknown> = {};
    if (e["harness"] !== undefined) out["harness"] = nameOf(e["harness"], `${f}.harness`);
    if ((e["provider"] === undefined) !== (e["model"] === undefined)) invalid(`${f}.provider`, "provider and model are given together or not at all");
    if (e["provider"] !== undefined) {
      const provider = nameOf(e["provider"], `${f}.provider`);
      const model = typeof e["model"] === "string" && MODEL.test(e["model"]) ? e["model"] : invalid(`${f}.model`, "must be a model name");
      if (own(table!.routes, `${provider}/${model}`) === undefined) invalid(`${f}.model`, `route ${provider}/${model} is not in the routing table`);
      out["provider"] = provider; out["model"] = model;
    }
    if (e["routingProfile"] !== undefined) {
      const rp = nameOf(e["routingProfile"], `${f}.routingProfile`);
      if (own(table!.profiles, rp) === undefined) invalid(`${f}.routingProfile`, `profile ${rp} is not in the routing table`);
      out["routingProfile"] = rp;
    }
    if (out["provider"] === undefined && out["routingProfile"] === undefined) invalid(f, "needs a routingProfile or a provider and model; no route is assumed");
    if (e["reasoning"] !== undefined) {
      const r = exact(e["reasoning"], `${f}.reasoning`, ["effort", "maxThinkingTokens"]);
      const reasoning: Record<string, unknown> = {};
      if (r["effort"] !== undefined) reasoning["effort"] = (EFFORT as readonly unknown[]).includes(r["effort"]) ? r["effort"] : invalid(`${f}.reasoning.effort`, `must be one of ${EFFORT.join(", ")}`);
      if (r["maxThinkingTokens"] !== undefined) reasoning["maxThinkingTokens"] = whole(r["maxThinkingTokens"], `${f}.reasoning.maxThinkingTokens`, 1, DIFFICULTY_LIMITS.thinking);
      out["reasoning"] = reasoning;
    }
    if (e["contextTokens"] !== undefined) out["contextTokens"] = whole(e["contextTokens"], `${f}.contextTokens`, 1, ROUTING_LIMITS.contextTokens);
    if (e["needs"] !== undefined) out["needs"] = list(e["needs"], `${f}.needs`, ROUTING_LIMITS.capabilities, (s) => CAPABILITY.test(s), "a capability name");
    if (e["tools"] !== undefined) out["tools"] = list(e["tools"], `${f}.tools`, DIFFICULTY_LIMITS.tools, (s) => s.length <= 60 && ACTION.test(s), "an action name such as task.create");
    if (e["spendLimitMicros"] !== undefined) out["spendLimitMicros"] = whole(e["spendLimitMicros"], `${f}.spendLimitMicros`, 0, DIFFICULTY_LIMITS.spend);
    profiles[name] = out as ExecProfile;
  }
  const rawMap = top["mapping"];
  if (rawMap === null || typeof rawMap !== "object" || Array.isArray(rawMap)) invalid("profiles.mapping", "must be an object");
  const mapping: Partial<Record<MappedLevel, string>> = Object.create(null) as Partial<Record<MappedLevel, string>>;
  for (const [level, profile] of Object.entries(rawMap as object)) {
    if (level !== "unrated" && !(DIFFICULTIES as readonly string[]).includes(level)) invalid(`profiles.mapping.${level}`, `is not a difficulty (${DIFFICULTIES.join(", ")}, or unrated)`);
    const p = nameOf(profile, `profiles.mapping.${level}`);
    if (own(profiles, p) === undefined) invalid(`profiles.mapping.${level}`, `profile ${p} is not defined`);
    mapping[level as MappedLevel] = p;
  }
  return { profiles, mapping };
}

/**
 * Difficulty profiles and escalation (card R03). Difficulty is a task's own field (S10), separate from priority: this service never reads priority, and priority never reads
 * difficulty. The owner keeps one record of named execution profiles (harness, provider and model, reasoning, context needs, tool permissions, spending limit) and which profile each
 * difficulty uses; there are no built-in profiles and no tier implies a provider, a model or whether it runs locally. At each dispatch `resolve` reads the difficulty and the mapping
 * as they are now, applies the routing policy (R01) and **persists the decision with the reasons**, so a later change of the mapping touches only the next dispatch.
 *
 * A task can be delegated to a child agent (`delegate`): the delegator is the parent and sets a ceiling. The parent may set the task's difficulty without any grant; anyone else
 * needs `task.difficulty.write`. A child that is blocked (an open blocker on the task) or failing (attempts admitted repeatedly) asks `escalate` for a higher difficulty: within the
 * ceiling it is applied at once, above it the request waits for the parent. A retry budget (the same target asked again) and a total budget end an escalation loop, and the ending
 * is itself recorded.
 */
export class DifficultyService {
  readonly #runner: CommandRunner;
  readonly #routing: RoutingService;
  readonly #contracts: ContractService;

  private constructor(runner: CommandRunner, routing: RoutingService, contracts: ContractService) { this.#runner = runner; this.#routing = routing; this.#contracts = contracts; }

  static withEpoch(storage: ControllerStorage, epoch: number, routing: RoutingService, contracts: ContractService, options: RunnerOptions = {}): DifficultyService {
    return new DifficultyService(new CommandRunner(storage, epoch, options), routing, contracts);
  }

  // ---- the owner's profiles and mapping ---------------------------------------------------------------------------------------

  /** Replaces the profiles and the mapping in one validated step (the owner, or someone given `routing.write`). Applies to the next dispatch. */
  async setProfiles(by: Principal, command: NoActor & { expectedRevision: number; profiles: unknown }): Promise<{ revision: number; replayed: boolean }> {
    if (!allowsExactly(by, "routing.write", "*")) throw new DomainError("forbidden", `${by.id} may not change difficulty profiles; only the owner, or someone the owner gave routing.write`);
    const r = await this.#runner.command("difficulty.profiles.set", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "expectedRevision", "profiles"]);
      const expected = command.expectedRevision === 0 ? 0 : checkRevision(command.expectedRevision);
      return {
        payload: { expectedRevision: expected, profiles: JSON.parse(JSON.stringify(command.profiles ?? null)) as JsonObject },
        build: async () => {
          const table = (await this.#routing.get()) as RoutingBody | undefined;
          const checked = checkProfiles(command.profiles, table);
          const current = await this.#runner.get(PROFILES.kind, PROFILES.id);
          if ((current?.revision ?? 0) !== expected) throw new DomainError("stale_revision", `difficulty profiles are at revision ${current?.revision ?? 0}, not ${expected}`, { currentRevision: current?.revision ?? 0 });
          const body: ProfilesBody = { ...checked, updatedBy: by.id };
          const change: Change = current === undefined ? { type: "create", ref: PROFILES, body: body as unknown as JsonObject } : { type: "update", ref: PROFILES, expectedRevision: current.revision, body: body as unknown as JsonObject };
          return { ref: PROFILES, creates: current === undefined, changes: [change], detail: { profiles: Object.keys(checked.profiles).length, mapped: Object.keys(checked.mapping).length } };
        },
      };
    });
    return { revision: r.revision, replayed: r.replayed };
  }

  /** The profiles and mapping in force. Needs `routing.write` or `config.read`. */
  async profiles(by: Principal): Promise<(ProfilesBody & { id: string; revision: number }) | undefined> {
    if (!allows(by, "routing.write", "*") && !allows(by, "config.read", "*")) throw new DomainError("forbidden", `${by.id} may not read difficulty profiles`);
    const found = await this.#runner.get(PROFILES.kind, PROFILES.id);
    return found === undefined ? undefined : view<ProfilesBody>(found);
  }

  // ---- the dispatch decision --------------------------------------------------------------------------------------------------

  /**
   * The dispatcher's step at each dispatch: the task's difficulty now selects a profile through the mapping now, and the routing policy picks the route. The decision (what was
   * asked, the profile as it was, the route or why there is none, every candidate's reasons, the revisions used) is stored and returned; repeating the command ID returns the same
   * decision. Nothing is invented: no mapping for the difficulty, no routing table or no eligible route is a `no-choice` decision with the reasons, not a default.
   */
  async resolve(by: Principal, command: NoActor & { taskId: string; role: string; contextTokens?: number; needs?: readonly string[]; data: "local-only" | "cloud-allowed"; paidAuthorized: boolean }): Promise<DecisionBody & { id: string; revision: number }> {
    this.#dispatcher(by);
    onlyKnown(command, ["commandId", "taskId", "role", "contextTokens", "needs", "data", "paidAuthorized"]);
    const taskId = checkTaskId(command.taskId);
    const role = nameOf(command.role, "role");
    const contextTokens = command.contextTokens === undefined ? 0 : whole(command.contextTokens, "contextTokens", 0, ROUTING_LIMITS.contextTokens);
    const needs = command.needs === undefined ? [] : list(command.needs, "needs", ROUTING_LIMITS.capabilities, (s) => CAPABILITY.test(s), "a capability name");
    const data = command.data === "local-only" || command.data === "cloud-allowed" ? command.data : invalid("data", "must be local-only or cloud-allowed");
    const paid = typeof command.paidAuthorized === "boolean" ? command.paidAuthorized : invalid("paidAuthorized", "must be true or false");
    const id = derivedId("rdc", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: decisionKind(taskId), id };
    await this.#runner.command("route.decide", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, role, contextTokens, needs, data, paidAuthorized: paid },
      build: async () => {
        const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
        if (task === undefined) throw new DomainError("not_found", "no such task");
        // The difficulty, the mapping and the routing table, all as they are at this commit (a change in between fails the check and the dispatcher asks again).
        const contract = await this.#runner.get("task-contract", taskId);
        const difficulty = (contract?.body as unknown as ContractBody | undefined)?.difficulty;
        const stored = await this.#runner.get(PROFILES.kind, PROFILES.id);
        const maps = stored?.body as unknown as ProfilesBody | undefined;
        const routingFound = await this.#runner.get(ROUTING.kind, ROUTING.id);
        const table = routingFound?.body as unknown as RoutingBody | undefined;
        const checks: Change[] = [contract, stored, routingFound].flatMap((a, i) => (a === undefined ? [] : [{ type: "check" as const, ref: [{ kind: "task-contract", id: taskId }, PROFILES, ROUTING][i]!, expectedRevision: a.revision }]));
        const level: MappedLevel = difficulty ?? "unrated";
        const profileName = maps === undefined ? undefined : own(maps.mapping as Record<string, string>, level);
        const profile = profileName === undefined ? undefined : own(maps!.profiles, profileName);
        const reasons: string[] = [];
        let candidates: Candidate[] = [];
        let route: string | undefined;
        const effective = { contextTokens: Math.max(contextTokens, profile?.contextTokens ?? 0), needs: [...new Set([...needs, ...(profile?.needs ?? [])])], data, paidAuthorized: paid && profile?.spendLimitMicros !== 0 };
        if (maps === undefined) reasons.push("no difficulty profiles are configured");
        else if (profileName === undefined || profile === undefined) reasons.push(`no profile is configured for ${difficulty === undefined ? "a task with no difficulty" : `difficulty ${difficulty}`}`);
        else if (table === undefined) reasons.push("no routing table is configured");
        else {
          const first = profile.provider === undefined ? [] : [`${profile.provider}/${profile.model}`];
          const rest = profile.routingProfile === undefined ? [] : [...(own(table.profiles, profile.routingProfile) ?? [])];
          const order = [...new Set([...first, ...rest])];
          if (order.length === 0) reasons.push(`profile ${profile.routingProfile ?? "?"} lists no routes`);
          else {
            // The table is the policy: the profile's route list stands in for one routing profile, and every rule of R01 applies to each candidate.
            const synthetic = { ...table, profiles: { ...table.profiles, ["resolved"]: order }, roles: {} };
            const selection = selectRoute(synthetic, { role, profile: "resolved", ...effective });
            candidates = [...selection.candidates];
            route = selection.chosen;
            if (route === undefined) reasons.push("no configured route is eligible", ...candidates.map((c) => `${c.route}: ${c.reasons.join("; ")}`));
          }
        }
        const body: DecisionBody = {
          taskId, projectId: task.projectId, role, ...(difficulty === undefined ? {} : { difficulty }), ...(profileName === undefined ? {} : { profileName }), ...(profile === undefined ? {} : { profile }),
          profilesRevision: stored?.revision ?? 0, ...(routingFound === undefined ? {} : { routingRevision: routingFound.revision }),
          outcome: route === undefined ? "no-choice" : "chosen", ...(route === undefined ? {} : { route }), candidates, reasons, request: effective, decidedBy: by.id, decidedAt: this.#runner.now(),
        };
        return { ref, creates: true, changes: [...checks, { type: "create", ref, body: body as unknown as JsonObject }], detail: { taskId, difficulty: difficulty ?? null, profile: profileName ?? null, route: route ?? null } };
      },
    }));
    const found = (await this.#runner.get(ref.kind, ref.id))!;
    return view<DecisionBody>(found);
  }

  /** The routing decisions of a task, a page at a time (in the order the store keeps them; each carries `decidedAt`). Hidden as for a missing task when the caller may not read it. */
  async decisions(by: Principal, taskId: string, page: { afterId?: string; limit?: number } = {}): Promise<{ items: (DecisionBody & { id: string; revision: number })[]; next?: string }> {
    const id = checkTaskId(taskId);
    if ((await this.#visible(by, id)) === undefined) return { items: [] };
    const limit = page.limit ?? 50;
    const rows = await this.#runner.list(decisionKind(id), { ...(page.afterId === undefined ? {} : { afterId: page.afterId }), limit });
    return { items: rows.map((r) => view<DecisionBody>(r)), ...(rows.length === limit ? { next: rows[rows.length - 1]!.id } : {}) };
  }

  /** One decision by ID. */
  async decision(by: Principal, taskId: string, decisionId: string): Promise<(DecisionBody & { id: string; revision: number }) | undefined> {
    const id = checkTaskId(taskId);
    if ((await this.#visible(by, id)) === undefined) return undefined;
    const found = typeof decisionId === "string" && decisionId.length <= 60 ? await this.#runner.get(decisionKind(id), decisionId) : undefined;
    return found === undefined ? undefined : view<DecisionBody>(found);
  }

  // ---- delegation and who sets difficulty -------------------------------------------------------------------------------------

  /**
   * Hands a task to a child agent with a ceiling. The caller needs `task.difficulty.write` on the task (the authority over difficulty is what the parent role carries; `task.contract.write` alone is not enough) and becomes the task's parent; a later change is the parent's (or the owner's) and begins a new budget round.
   * The child must be an active agent other than the parent. Delegation moves no task assignment and grants nothing: it only says who may escalate and who decides.
   */
  async delegate(by: Principal, command: NoActor & { taskId: string; child: string; ceiling: Difficulty; retryBudget?: number; totalBudget?: number }): Promise<{ id: string; revision: number; replayed: boolean }> {
    const r = await this.#runner.command("difficulty.delegate", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "taskId", "child", "ceiling", "retryBudget", "totalBudget"]);
      const taskId = checkTaskId(command.taskId);
      const child = typeof command.child === "string" && command.child.length <= 120 ? command.child : invalid("child", "must be an agent principal ID");
      const ceiling = (DIFFICULTIES as readonly string[]).includes(command.ceiling) ? command.ceiling : invalid("ceiling", `must be one of ${DIFFICULTIES.join(", ")}`);
      const retryBudget = command.retryBudget === undefined ? DIFFICULTY_LIMITS.defaultRetry : whole(command.retryBudget, "retryBudget", 1, DIFFICULTY_LIMITS.maxRetry);
      const totalBudget = command.totalBudget === undefined ? DIFFICULTY_LIMITS.defaultTotal : whole(command.totalBudget, "totalBudget", 1, DIFFICULTY_LIMITS.maxTotal);
      return {
        payload: { taskId, child, ceiling, retryBudget, totalBudget },
        build: async () => {
          const task = await this.#readable(by, taskId);
          if (task === undefined || !allows(by, "task.difficulty.write", task.projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${by.id} may not delegate ${taskId}; that needs authority over its difficulty`);
          const who = (await this.#runner.get("principal", child))?.body as unknown as PrincipalBody | undefined;
          if (who === undefined || who.kind !== "agent" || who.state !== "active") invalid("child", "must be an active agent");
          const found = await this.#runner.get("task-delegation", taskId);
          const before = found?.body as unknown as DelegationBody | undefined;
          if (before !== undefined && before.parent !== by.id && by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the parent of ${taskId}`);
          const parent = before?.parent ?? by.id;
          if (child === parent) invalid("child", "a task cannot be delegated to its own parent");
          const ref: AggregateRef = { kind: "task-delegation", id: taskId };
          const body: DelegationBody = { taskId, projectId: task.projectId, parent, child, ceiling: ceiling as Difficulty, retryBudget, totalBudget, touched: (before?.touched ?? 0) + 1, round: before === undefined ? 0 : (before.round ?? 0) + 1, setBy: by.id };
          return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { taskId, child, ceiling } };
        },
      };
    });
    return r;
  }

  /** The owner replaces a task's parent (for example when the parent agent is retired). The new parent must be an active agent other than the child. Recorded in the audit and in `setBy`. */
  async reassignParent(by: Principal, command: NoActor & { taskId: string; parent: string }): Promise<{ id: string; revision: number; replayed: boolean }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the owner; only the owner replaces a task's parent`);
    return this.#runner.command("difficulty.reassign-parent", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "taskId", "parent"]);
      const taskId = checkTaskId(command.taskId);
      const parent = typeof command.parent === "string" && command.parent.length <= 120 ? command.parent : invalid("parent", "must be an agent principal ID");
      return {
        payload: { taskId, parent },
        build: async () => {
          const found = await this.#runner.get("task-delegation", taskId);
          const before = found?.body as unknown as DelegationBody | undefined;
          if (found === undefined || before === undefined) throw new DomainError("not_found", "no such delegated task");
          const who = (await this.#runner.get("principal", parent))?.body as unknown as PrincipalBody | undefined;
          if (who === undefined || who.kind !== "agent" || who.state !== "active") invalid("parent", "must be an active agent");
          if (parent === before.child) invalid("parent", "the child cannot be its own parent");
          if (parent === before.parent) invalid("parent", "is already the parent");
          const ref: AggregateRef = { kind: "task-delegation", id: taskId };
          const body: DelegationBody = { ...before, parent, touched: before.touched + 1, setBy: by.id };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { taskId, from: before.parent, to: parent } };
        },
      };
    });
  }

  /** The delegation of a task (who is the parent and the child, the ceiling and budgets). Hidden as for a missing task when the caller cannot see the task. */
  async delegation(by: Principal, taskId: string): Promise<(DelegationBody & { id: string; revision: number }) | undefined> {
    const id = checkTaskId(taskId);
    const found = await this.#runner.get("task-delegation", id);
    if (found === undefined) return undefined;
    return (await this.#visible(by, id, found.body as unknown as DelegationBody)) === undefined ? undefined : view<DelegationBody>(found);
  }

  /**
   * Sets (or clears, with `null`) a task's difficulty. The task's parent may do it with no grant; anyone else needs `task.difficulty.write` (the S10 rule, unchanged). It changes
   * nothing but the difficulty, so the profile follows at the next dispatch only, and never touches priority.
   */
  async setDifficulty(by: Principal, command: NoActor & { taskId: string; expectedVersion: number; difficulty: Difficulty | null }): Promise<{ id: string; revision: number; replayed: boolean }> {
    const taskId = checkTaskId(command.taskId);
    const delegation = (await this.#runner.get("task-delegation", taskId))?.body as unknown as DelegationBody | undefined;
    if (delegation?.parent !== by.id) {
      // Not the parent: the ordinary contract path decides, with the ordinary grant.
      return this.#contracts.setContract(by, { commandId: command.commandId, taskId, expectedVersion: command.expectedVersion, difficulty: command.difficulty });
    }
    return this.#runner.command("difficulty.set", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => {
      onlyKnown(command, ["commandId", "taskId", "expectedVersion", "difficulty"]);
      if (!Number.isSafeInteger(command.expectedVersion) || command.expectedVersion < 0) invalid("expectedVersion", "must be 0 or the version you read");
      const difficulty = command.difficulty === null ? null : (DIFFICULTIES as readonly string[]).includes(command.difficulty) ? command.difficulty : invalid("difficulty", `must be one of ${DIFFICULTIES.join(", ")} or null`);
      return {
        payload: { taskId, expectedVersion: command.expectedVersion, difficulty },
        build: async () => {
          const task = await this.#readable(by, taskId);
          if (task === undefined) throw new DomainError("forbidden", `${by.id} may not change the difficulty of ${taskId}`);
          const change = await this.#contracts.difficultyChanges(by.id, taskId, difficulty, command.expectedVersion);
          if (change === undefined) invalid("difficulty", "the task already has this difficulty");
          const ref: AggregateRef = { kind: "task-contract", id: taskId };
          return { ref, creates: false, changes: change!.changes, detail: { task: taskId, version: change!.version, difficulty, by: "parent" }, contention: async () => new DomainError("stale_revision", `the contract of ${taskId} changed meanwhile; read it again`) };
        },
      };
    });
  }

  // ---- escalation -------------------------------------------------------------------------------------------------------------

  /**
   * The child of a delegated task asks for a higher difficulty because it is `blocked` (it names an open blocker of the task) or `failing` (at least two attempts have been admitted).
   * The target is the next level up unless `to` names a higher one. Within the ceiling the difficulty is set at once; above it the request waits for the parent's `decide`. Only one
   * request waits at a time, the same target may be asked `retryBudget` times, and `totalBudget` requests are allowed in all; the request that would pass a budget is stored as `stopped`
   * with the reason (once), and later ones are refused. Every request is a stored, queryable record with its reason.
   */
  async escalate(by: Principal, command: NoActor & { taskId: string; kind: "blocked" | "failing"; reason: string; blockerId?: string; to?: Difficulty }): Promise<EscalationBody & { id: string; revision: number }> {
    onlyKnown(command, ["commandId", "taskId", "kind", "reason", "blockerId", "to"]);
    const taskId = checkTaskId(command.taskId);
    const kind = command.kind === "blocked" || command.kind === "failing" ? command.kind : invalid("kind", "must be blocked or failing");
    const reason = reasonOf(command.reason);
    const to = command.to === undefined ? undefined : (DIFFICULTIES as readonly string[]).includes(command.to) ? command.to : invalid("to", `must be one of ${DIFFICULTIES.join(", ")}`);
    const blockerId = command.blockerId === undefined ? undefined : typeof command.blockerId === "string" && /^blk-[a-z2-7]{20}$/.test(command.blockerId) ? command.blockerId : invalid("blockerId", "is not a blocker ID");
    const id = derivedId("esc", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: escalationKind(taskId), id };
    await this.#runner.command("difficulty.escalate", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, kind, reason, blockerId: blockerId ?? null, to: to ?? null },
      build: async () => {
        const found = await this.#runner.get("task-delegation", taskId);
        const delegation = found?.body as unknown as DelegationBody | undefined;
        const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
        if (task === undefined || found === undefined || delegation === undefined || !inTaskScope(by, task.projectId)) throw new DomainError("not_found", "no such delegated task");
        if (delegation.child !== by.id) {
          throw new DomainError(allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } }) ? "forbidden" : "not_found", allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } }) ? `${by.id} is not the child this task was delegated to; only the child escalates` : "no such delegated task");
        }
        const contract = await this.#runner.get("task-contract", taskId);
        const from = (contract?.body as unknown as ContractBody | undefined)?.difficulty;
        const target: Difficulty = to === undefined ? DIFFICULTIES[rank(from) + 1] ?? invalid("to", "the task is already at the highest difficulty") : (to as Difficulty);
        if (rank(target) <= rank(from)) invalid("to", `must be above the current difficulty${from === undefined ? "" : ` (${from})`}`);
        // Evidence that the child really is blocked or failing: a stored fact, not the child's word.
        const allRecords = await this.#escalations(taskId);
        if (allRecords.some((r) => r.state === "pending")) throw new DomainError("invalid_transition", "an escalation request is already waiting for the parent");
        const evidence: EscalationBody["evidence"] = kind === "blocked" ? await this.#blocked(taskId, blockerId, allRecords) : await this.#failing(taskId, allRecords);
        const round = delegation.round ?? 0;
        const records = allRecords.filter((r) => (r.round ?? 0) === round);
        if (records.some((r) => r.state === "stopped")) throw new DomainError("invalid_transition", "escalation for this task has stopped (its budget was used up); the parent decides what happens next");
        const total = records.length;
        const sameTarget = records.filter((r) => r.to === target).length;
        const stopReason = total >= delegation.totalBudget ? `the total budget of ${delegation.totalBudget} escalation requests is used up` : sameTarget >= delegation.retryBudget ? `${target} has been asked for ${sameTarget} times; the retry budget is ${delegation.retryBudget}` : undefined;
        const within = rank(target) <= rank(delegation.ceiling);
        const state: EscalationState = stopReason !== undefined ? "stopped" : within ? "applied" : "pending";
        const body: EscalationBody = {
          taskId, projectId: task.projectId, kind, requestedBy: by.id, ...(from === undefined ? {} : { from }), to: target, reason, evidence, state, round,
          ...(stopReason === undefined ? { route: within ? "ceiling" as const : "parent" as const } : { stopReason }), ...(state === "applied" ? { attemptsAtChange: await this.#attempts(taskId) } : {}), requestedAt: this.#runner.now(),
        };
        const touch: Change = { type: "update", ref: { kind: "task-delegation", id: taskId }, expectedRevision: found.revision, body: { ...delegation, touched: delegation.touched + 1 } as unknown as JsonObject };
        const changes: Change[] = [touch, { type: "create", ref, body: body as unknown as JsonObject }];
        if (state === "applied") {
          // The version read above: a change that landed since (the parent's own) fails here instead of being overwritten by a lower step.
          const set = await this.#contracts.difficultyChanges(by.id, taskId, target, (contract?.body as unknown as ContractBody | undefined)?.version ?? 0);
          if (set !== undefined) changes.push(...set.changes);
          else if (contract !== undefined) changes.push({ type: "check", ref: { kind: "task-contract", id: taskId }, expectedRevision: contract.revision });
        } else if (contract !== undefined) changes.push({ type: "check", ref: { kind: "task-contract", id: taskId }, expectedRevision: contract.revision });
        return { ref, creates: true, changes, detail: { taskId, from: from ?? null, to: target, state, route: body.route ?? null }, contention: async () => new DomainError("stale_revision", `the escalations of ${taskId} changed meanwhile; read them again`) };
      },
    }));
    return view<EscalationBody>((await this.#runner.get(ref.kind, ref.id))!);
  }

  /**
   * The parent (the owner, or a holder of `task.difficulty.write` for the task) approves or denies a waiting request. Approving sets the difficulty to the target (and raises the
   * ceiling to it, so the child's next ask within it needs no one); a denial is recorded with its reason. Nothing else about the task changes.
   */
  async decide(by: Principal, command: NoActor & { taskId: string; escalationId: string; approve: boolean; reason: string }): Promise<EscalationBody & { id: string; revision: number }> {
    onlyKnown(command, ["commandId", "taskId", "escalationId", "approve", "reason"]);
    const taskId = checkTaskId(command.taskId);
    const escalationId = typeof command.escalationId === "string" && /^esc-[a-z2-7]{20}$/.test(command.escalationId) ? command.escalationId : invalid("escalationId", "is not an escalation ID");
    const approve = typeof command.approve === "boolean" ? command.approve : invalid("approve", "must be true or false");
    const reason = reasonOf(command.reason);
    const ref: AggregateRef = { kind: escalationKind(taskId), id: escalationId };
    await this.#runner.command("difficulty.decide", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, escalationId, approve, reason },
      build: async () => {
        const found = await this.#runner.get("task-delegation", taskId);
        const delegation = found?.body as unknown as DelegationBody | undefined;
        const task = await this.#readable(by, taskId);
        if (task === undefined || found === undefined || delegation === undefined) throw new DomainError("not_found", "no such delegated task");
        if (!(delegation.parent === by.id || allows(by, "task.difficulty.write", task.projectId, { resource: { kind: "task", id: taskId } }))) throw new DomainError("forbidden", `${by.id} is not the parent of ${taskId} and has no authority over its difficulty`);
        const esc = await this.#runner.get(ref.kind, ref.id);
        const before = esc?.body as unknown as EscalationBody | undefined;
        if (esc === undefined || before === undefined) throw new DomainError("not_found", "no such escalation request");
        if (before.state !== "pending" && before.state !== "stopped") throw new DomainError("invalid_transition", `that request is ${before.state}, not waiting`);
        const wasStopped = before.state === "stopped";
        const contract = await this.#runner.get("task-contract", taskId);
        const cbody = contract?.body as unknown as ContractBody | undefined;
        const current = cbody?.difficulty;
        const sets = approve && rank(before.to) > rank(current);
        const next: EscalationBody = { ...before, state: approve ? "approved" : "denied", route: "parent", decidedBy: by.id, decisionReason: reason, ...(sets ? { attemptsAtChange: await this.#attempts(taskId) } : {}) };
        // The parent's decision on a stopped request begins a new round: the budgets start again.
        const delegationNext: DelegationBody = { ...delegation, touched: delegation.touched + 1, ...(wasStopped ? { round: (delegation.round ?? 0) + 1 } : {}), ...(approve && rank(before.to) > rank(delegation.ceiling) ? { ceiling: before.to } : {}) };
        const changes: Change[] = [
          { type: "update", ref: { kind: "task-delegation", id: taskId }, expectedRevision: found.revision, body: delegationNext as unknown as JsonObject },
          { type: "update", ref, expectedRevision: esc.revision, body: next as unknown as JsonObject },
        ];
        if (sets) changes.push(...((await this.#contracts.difficultyChanges(by.id, taskId, before.to, cbody?.version ?? 0))?.changes ?? []));
        else if (contract !== undefined) changes.push({ type: "check", ref: { kind: "task-contract", id: taskId }, expectedRevision: contract.revision });
        return { ref, creates: false, changes, detail: { taskId, to: before.to, approved: approve }, contention: async () => new DomainError("stale_revision", `the escalations of ${taskId} changed meanwhile; read them again`) };
      },
    }));
    return view<EscalationBody>((await this.#runner.get(ref.kind, ref.id))!);
  }

  /** The escalation requests of a task, with their reasons and outcomes. Visible to whoever can read the task, the parent and the child. */
  async escalations(by: Principal, taskId: string): Promise<(EscalationBody & { id: string; revision: number })[]> {
    const id = checkTaskId(taskId);
    if ((await this.#visible(by, id)) === undefined) return [];
    return (await this.#escalationRows(id)).map((r) => view<EscalationBody>(r)).sort((a, b) => a.requestedAt.localeCompare(b.requestedAt) || a.id.localeCompare(b.id));
  }

  // ---- internals --------------------------------------------------------------------------------------------------------------

  #dispatcher(by: Principal): void { if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} is not the dispatcher; routing decisions are the controller's and its hosts'`); }

  async #readable(by: Principal, taskId: string): Promise<(TaskBody & { revision: number }) | undefined> {
    const found = await this.#runner.get("task", taskId);
    if (found === undefined) return undefined;
    const body = found.body as unknown as TaskBody;
    return allows(by, "task.read", body.projectId, { resource: { kind: "task", id: taskId } }) ? { ...body, revision: found.revision } : undefined;
  }

  /** Who may see a task's decisions and escalations: those who can read the task, and its parent and child. */
  async #visible(by: Principal, taskId: string, known?: DelegationBody): Promise<TaskBody | undefined> {
    const found = await this.#runner.get("task", taskId);
    if (found === undefined) return undefined;
    const body = found.body as unknown as TaskBody;
    if (!inTaskScope(by, body.projectId)) return undefined;
    if (allows(by, "task.read", body.projectId, { resource: { kind: "task", id: taskId } })) return body;
    const d = known ?? (await this.#runner.get("task-delegation", taskId))?.body as unknown as DelegationBody | undefined;
    return d !== undefined && (d.parent === by.id || d.child === by.id) ? body : undefined;
  }

  async #escalationRows(taskId: string): Promise<import("../storage/types.js").Aggregate[]> {
    const out: import("../storage/types.js").Aggregate[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(escalationKind(taskId), { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      out.push(...page);
      if (page.length < 200) return out;
      after = page[page.length - 1]!.id;
    }
  }
  async #escalations(taskId: string): Promise<EscalationBody[]> { return (await this.#escalationRows(taskId)).map((r) => r.body as unknown as EscalationBody); }

  async #attempts(taskId: string): Promise<number> {
    return ((await this.#runner.get("assignment", derivedAssignmentId(taskId)))?.body as unknown as AssignmentBody | undefined)?.attempts ?? 0;
  }
  /** An open blocker of this task, one that no earlier request of the task used: a blocker is evidence once. */
  async #blocked(taskId: string, blockerId: string | undefined, earlier: readonly EscalationBody[]): Promise<EscalationBody["evidence"]> {
    if (blockerId === undefined) return invalid("blockerId", "a blocked child names the open blocker of the task");
    const b = (await this.#runner.get("blocker", blockerId))?.body as unknown as BlockerBody | undefined;
    if (b === undefined || b.state !== "open" || b.subject.kind !== "task" || b.subject.id !== taskId) return invalid("blockerId", "must be an open blocker on this task");
    if (earlier.some((r) => r.evidence.blockerId === blockerId)) return invalid("blockerId", "was already used for an earlier request; a new request needs new evidence");
    return { blockerId };
  }
  /** Attempts admitted since the last time an escalation changed the difficulty (all of them, before the first). */
  async #failing(taskId: string, earlier: readonly EscalationBody[]): Promise<EscalationBody["evidence"]> {
    const attempts = await this.#attempts(taskId);
    const since = attempts - Math.max(0, ...earlier.map((r) => r.attemptsAtChange ?? 0));
    if (since < DIFFICULTY_LIMITS.failingAttempts) return invalid("kind", `a failing child has had at least ${DIFFICULTY_LIMITS.failingAttempts} attempts admitted since the last change; this task has had ${since}`);
    return { attempts };
  }
}
