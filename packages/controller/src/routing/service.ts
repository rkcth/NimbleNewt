import { DomainError } from "../domain/errors.js";
import { onlyKnown, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allowsExactly } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { EMPTY_TOPOLOGY, TOPOLOGY_REF, assertLists, checkTopology, type ListRules, type Topology } from "./lists.js";
import { ROUTING_LIMITS, checkRequest, checkTable, selectRoute, type Exclusion, type RouteBudget, type RouteRequest, type RoutingTable, type Selection } from "./policy.js";

const ROUTING: AggregateRef = { kind: "routing-table", id: "routing" };
const EMPTY: RoutingTable = { providers: {}, routes: {}, profiles: {}, roles: {}, exclusions: [] };
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

const budgetOf = (entry: RouteBudget): RouteBudget => ({ ...(entry.maxTokens === undefined ? {} : { maxTokens: entry.maxTokens }), ...(entry.reasoningTokens === undefined ? {} : { reasoningTokens: entry.reasoningTokens }) });

export interface RoutingBody extends RoutingTable {
  readonly updatedBy: string;
}

export interface Target extends NoActor {
  readonly kind: "provider" | "route";
  readonly name: string;
  readonly reason: string;
}

function reasonOf(value: unknown): string {
  const out = text(value, "reason", { min: 1, max: ROUTING_LIMITS.reason });
  if (redactText(out) !== out) invalid("reason", "looks like a credential or key; those are not recorded");
  return out;
}

/**
 * Model routing and capability policy (card R01). The owner keeps one routing table: providers (enabled, paid, local or cloud), routes (`provider/model` with their context size and
 * capabilities), ordered profiles, and which profile each role uses; plus exclusions of whole providers or single routes. Every dispatch (a first attempt, a retry, a helper call) asks
 * `select`, which reads the table as it is **now**, so a disabled provider or a new exclusion applies to the next dispatch with no cache to wait out. The table has a revision; a
 * selection reports the revision it used so an attempt can record it. Changes are the owner's only and are audited with who and why.
 *
 * `select` is the controller's own call (the dispatcher's); it is not exposed to workers or agents.
 */
export class RoutingService {
  readonly #runner: CommandRunner;
  readonly #rules: ListRules | undefined;

  private constructor(runner: CommandRunner, rules: ListRules | undefined) {
    this.#runner = runner;
    this.#rules = rules;
  }

  /** With `rules` (card R04), a table is refused unless every model-using role has a valid fallback list (see `checkLists`). Without them the table is judged as before. */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}, rules?: ListRules): RoutingService {
    return new RoutingService(new CommandRunner(storage, epoch, options), rules);
  }

  /** Replaces providers, routes, profiles and roles in one validated step. Exclusions are untouched. Nothing is applied unless the whole proposal is valid. */
  async setTable(owner: Principal, command: NoActor & { expectedRevision: number; table: unknown }): Promise<{ revision: number; replayed: boolean }> {
    this.#requireOwner(owner);
    const r = await this.#runner.command("routing.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "expectedRevision", "table"]);
      const table = checkTable(command.table);
      // 0 means "there is no table yet"; otherwise the revision the proposal was made against, so two editors cannot silently overwrite each other.
      const expected = command.expectedRevision === 0 ? 0 : checkRevision(command.expectedRevision);
      return {
        payload: { table: table as unknown as JsonObject, expectedRevision: expected },
        build: async () => {
          const current = await this.#runner.get(ROUTING.kind, ROUTING.id);
          const stored = (await this.#runner.get(TOPOLOGY_REF.kind, TOPOLOGY_REF.id))?.body as unknown as Topology | undefined;
          // The route topology (aliases, endpoints, accounts) must keep describing routes that exist.
          const topology = stored === undefined ? EMPTY_TOPOLOGY : checkTopology({ targets: stored.targets, aliases: stored.aliases, services: stored.services }, table);
          assertLists(table, topology, this.#rules);
          if ((current === undefined ? 0 : current.revision) !== expected) throw new DomainError("stale_revision", `routing is at revision ${current?.revision ?? 0}, not ${expected}`, { currentRevision: current?.revision ?? 0 });
          const keep = current === undefined ? [] : (current.body as unknown as RoutingBody).exclusions;
          // An exclusion must keep pointing at something: a table that drops or renames an excluded provider or route would quietly stop it applying.
          for (const x of keep) {
            const present = x.target.kind === "provider" ? Object.hasOwn(table.providers, x.target.name) : Object.hasOwn(table.routes, x.target.name);
            if (!present) throw new DomainError("invalid_command", `${x.target.kind} ${x.target.name} is excluded but is not in the new table; lift the exclusion first, or keep the name`, { field: "table" });
          }
          const body: RoutingBody = { ...table, exclusions: keep, updatedBy: owner.id };
          const change: Change = current === undefined
            ? { type: "create", ref: ROUTING, body: body as unknown as JsonObject }
            : { type: "update", ref: ROUTING, expectedRevision: current.revision, body: body as unknown as JsonObject };
          return { ref: ROUTING, creates: current === undefined, changes: [change], detail: { providers: Object.keys(table.providers).length, routes: Object.keys(table.routes).length, profiles: Object.keys(table.profiles).length } };
        },
      };
    });
    return { revision: r.revision, replayed: r.replayed };
  }

  /** Excludes a provider or a route from every later dispatch (retries and helper calls included) until lifted. */
  exclude(owner: Principal, command: Target): Promise<{ revision: number; replayed: boolean }> {
    return this.#changeExclusion(owner, "routing.exclude", command, (list, target, reason) => {
      if (list.some((x) => x.target.kind === target.kind && x.target.name === target.name)) throw new DomainError("invalid_command", `${target.kind} ${target.name} is already excluded`, { field: "name" });
      if (list.length >= ROUTING_LIMITS.exclusions) throw new DomainError("invalid_command", `at most ${ROUTING_LIMITS.exclusions} exclusions are kept; lift one first`, { field: "name" });
      return [...list, { target, reason, excludedBy: owner.id, at: this.#runner.now() }];
    });
  }

  /** Lifts an exclusion. */
  lift(owner: Principal, command: Target): Promise<{ revision: number; replayed: boolean }> {
    return this.#changeExclusion(owner, "routing.lift", command, (list, target) => {
      if (!list.some((x) => x.target.kind === target.kind && x.target.name === target.name)) throw new DomainError("invalid_command", `${target.kind} ${target.name} is not excluded`, { field: "name" });
      return list.filter((x) => !(x.target.kind === target.kind && x.target.name === target.name));
    });
  }

  async #changeExclusion(owner: Principal, type: string, command: Target, apply: (list: readonly Exclusion[], target: Exclusion["target"], reason: string) => readonly Exclusion[]): Promise<{ revision: number; replayed: boolean }> {
    this.#requireOwner(owner);
    const r = await this.#runner.command(type, { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "kind", "name", "reason"]);
      const kind = command.kind === "provider" || command.kind === "route" ? command.kind : invalid("kind", "must be provider or route");
      const name = typeof command.name === "string" && command.name.length >= 1 && command.name.length <= 200 ? command.name : invalid("name", "must be a provider or provider/model name");
      const reason = reasonOf(command.reason);
      return {
        payload: { kind, name, reason },
        build: async () => {
          const current = await this.#runner.get(ROUTING.kind, ROUTING.id);
          const before = (current?.body as unknown as RoutingBody | undefined) ?? { ...EMPTY, updatedBy: owner.id };
          // The target must exist in the table now, so a misspelt name does not silently exclude nothing.
          const exists = kind === "provider" ? Object.hasOwn(before.providers, name) : Object.hasOwn(before.routes, name);
          if (type === "routing.exclude" && !exists) throw new DomainError("not_found", `${kind} ${name} is not in the routing table`, { field: "name" });
          const body: RoutingBody = { ...before, exclusions: apply(before.exclusions, { kind, name }, reason), updatedBy: owner.id };
          const change: Change = current === undefined
            ? { type: "create", ref: ROUTING, body: body as unknown as JsonObject }
            : { type: "update", ref: ROUTING, expectedRevision: current.revision, body: body as unknown as JsonObject };
          return { ref: ROUTING, creates: current === undefined, changes: [change], detail: { kind, name, reason } };
        },
      };
    });
    return { revision: r.revision, replayed: r.replayed };
  }

  /**
   * Sets a route's length and reasoning budget (card W07): `maxTokens`, the most tokens one reply may hold, and `reasoningTokens`, the most of them it may spend reasoning. A field left out keeps its value; null removes it (the call then
   * keeps what the agent's runtime asks for). The whole table is checked again, so the bounds are the table's. It applies from the next model call of the route: the relay reads the table at every call.
   */
  async setRouteBudget(owner: Principal, command: NoActor & { route: string; maxTokens?: number | null; reasoningTokens?: number | null }): Promise<{ revision: number; replayed: boolean; budget: RouteBudget }> {
    this.#requireOwner(owner);
    const r = await this.#runner.command("routing.budget.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => {
      onlyKnown(command, ["commandId", "route", "maxTokens", "reasoningTokens"]);
      const route = typeof command.route === "string" && command.route.length >= 1 && command.route.length <= 200 ? command.route : invalid("route", "must be a provider/model route name");
      if (command.maxTokens === undefined && command.reasoningTokens === undefined) invalid("maxTokens", "give maxTokens, reasoningTokens or both (null removes one)");
      const asked = { ...(command.maxTokens === undefined ? {} : { maxTokens: command.maxTokens }), ...(command.reasoningTokens === undefined ? {} : { reasoningTokens: command.reasoningTokens }) };
      return {
        payload: { route, ...asked } as unknown as JsonObject,
        build: async () => {
          const current = await this.#runner.get(ROUTING.kind, ROUTING.id);
          if (current === undefined) throw new DomainError("not_found", "no routing table is configured", { field: "route" });
          const before = current.body as unknown as RoutingBody;
          const entry = Object.hasOwn(before.routes, route) ? before.routes[route]! : undefined;
          if (entry === undefined) throw new DomainError("not_found", `route ${route} is not in the routing table`, { field: "route" });
          const next: Record<string, unknown> = { ...entry };
          for (const key of ["maxTokens", "reasoningTokens"] as const) {
            const v = command[key];
            if (v === null) delete next[key];
            else if (v !== undefined) next[key] = v;
          }
          // The whole table is checked again, so a budget is bounded exactly as one given with the table.
          const table = checkTable({ providers: before.providers, routes: { ...before.routes, [route]: next }, profiles: before.profiles, roles: before.roles });
          const body: RoutingBody = { ...table, exclusions: before.exclusions, updatedBy: owner.id };
          const budget = budgetOf(table.routes[route]!);
          return { ref: ROUTING, creates: false, changes: [{ type: "update", ref: ROUTING, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { route, ...budget } as unknown as JsonObject };
        },
      };
    });
    const now = await this.get();
    const entry = now !== undefined && Object.hasOwn(now.routes, command.route) ? now.routes[command.route]! : undefined;
    return { revision: r.revision, replayed: r.replayed, budget: entry === undefined ? {} : budgetOf(entry) };
  }

  /** A route's length and reasoning budget as the relay applies it (card W07); `undefined` when there is no table or no such route. Read at every call, so a change applies to the next call. */
  async budget(route: string): Promise<RouteBudget | undefined> {
    const table = await this.get();
    const entry = table !== undefined && Object.hasOwn(table.routes, route) ? table.routes[route]! : undefined;
    return entry === undefined ? undefined : budgetOf(entry);
  }

  async get(): Promise<View<RoutingBody> | undefined> {
    const found = await this.#runner.get(ROUTING.kind, ROUTING.id);
    return found === undefined ? undefined : view<RoutingBody>(found);
  }

  /**
   * The route for a dispatch, judged against the table as it is now, with the revision used. With no table, or no eligible route, there is no choice and the reasons say why;
   * nothing is invented and no paid provider is picked unless the request says spending is authorized.
   */
  async select(request: RouteRequest): Promise<Selection & { revision: number }> {
    const checked = checkRequest(request);
    const found = await this.#runner.get(ROUTING.kind, ROUTING.id);
    if (found === undefined) throw new DomainError("not_found", "no routing table is configured");
    return { ...selectRoute(found.body as unknown as RoutingBody, checked), revision: found.revision };
  }

  /** The owner, or a principal the owner gave `routing.write` (for example the coordinator agent); nobody else changes routing. */
  #requireOwner(principal: Principal): void {
    if (!allowsExactly(principal, "routing.write", "*")) throw new DomainError("forbidden", `${principal.id} may not change routing; only the owner, or someone the owner gave routing.write`);
  }
}
