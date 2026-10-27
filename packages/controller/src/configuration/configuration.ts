import { assignmentIdOf, type AssignmentBody } from "../domain/assignment-model.js";
import { DomainError } from "../domain/errors.js";
import { onlyKnown, revision as checkRevision, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows, allowsExactly } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import { effectiveOf } from "../security/grants.js";
import type { NoActor, Principal, PrincipalBody } from "../security/principals.js";
import type { RoutingService } from "../routing/index.js";
import { canonicalJson } from "../storage/json.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { DEFAULT_COMBINERS, DEFAULT_SETTINGS, LAYER_ORDER, SETTING_KEY, definitionFor, type Combiner, type CombineContext, type Effect, type LayerKind, type SettingDefinition } from "./settings.js";

export interface SettingEntry { readonly value: unknown; readonly locked?: boolean }

export interface HistoryEntry {
  /** The layer's revision after this apply. */
  readonly revision: number;
  readonly at: string;
  readonly by: string;
  readonly set: readonly string[];
  readonly removed: readonly string[];
  readonly locked: readonly string[];
  readonly unlocked: readonly string[];
  /** When each changed setting starts to count. */
  readonly effects: Readonly<Record<string, Effect>>;
}

export interface LayerBody {
  readonly layer: LayerKind;
  readonly scopeId: string;
  /** What is in force. */
  readonly applied: Readonly<Record<string, SettingEntry>>;
  /** Changes staged and not applied: not in force, and never reported as if they were. */
  readonly draft?: { readonly set: Readonly<Record<string, SettingEntry | null>>; readonly by: string; readonly at: string };
  /** The last apply that was refused, and why. The applied values are untouched. */
  readonly lastFailure?: { readonly at: string; readonly by: string; readonly problems: readonly string[] };
  /** The refused applies, by the revision each left the layer at, so a repeat of one is answered with its own reasons (the latest ten). */
  readonly failures?: readonly { readonly revision: number; readonly at: string; readonly by: string; readonly problems: readonly string[] }[];
  readonly history: readonly HistoryEntry[];
}

export interface Scope { readonly agentId?: string; readonly taskId?: string }

export interface ResolvedSetting {
  readonly value: unknown;
  /** The layer the value comes from (`default`: no layer sets it). For a restriction, the layer whose value is the tightest. */
  readonly source: { readonly layer: LayerKind | "default"; readonly id: string };
  /** The layer that locked it, if any: layers below it cannot change it. */
  readonly lockedBy?: { readonly layer: LayerKind; readonly id: string };
  readonly effect: Effect;
  /** Values in lower layers that do not count, and why. */
  readonly ignored: readonly { readonly layer: LayerKind; readonly id: string; readonly reason: string }[];
}

export interface EffectiveConfiguration {
  readonly values: Readonly<Record<string, ResolvedSetting>>;
  /** Problems with the combination of values; an empty list means they fit together. */
  readonly problems: readonly string[];
  /** False when a task was asked about and no agent is working it (or none was named), so the team and agent layers could not be applied. */
  readonly complete: boolean;
}

export interface ConfigurationOptions extends RunnerOptions {
  /** Settings beyond the built-in ones. */
  readonly settings?: readonly SettingDefinition[];
  readonly combiners?: readonly Combiner[];
  /** The routing service the configuration binds to (card R01). */
  readonly routing?: RoutingService;
}

export const CONFIG_LIMITS = { keysPerLayer: 200, history: 40, problems: 20, scan: 1000 } as const;
const TEAM_ID = /^team-[a-z2-7]{20}$/;
const AGENT_ID = /^agt-[a-z2-7]{20}$/;
const TASK_ID = /^task-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const same = (a: unknown, b: unknown): boolean => (a === undefined || b === undefined ? a === b : canonicalJson(a as JsonObject) === canonicalJson(b as JsonObject));
const layerIdOf = (layer: LayerKind, scopeId: string): string => (layer === "installation" ? "installation" : `${layer}.${scopeId}`);

interface Link { readonly layer: LayerKind; readonly id: string; readonly applied: Readonly<Record<string, SettingEntry>>; readonly aggregate: Aggregate | undefined }

/**
 * Layered configuration (card U10). Settings live in layers (installation, team, agent, task); each setting says whether a more specific layer simply overrides (`default`) or may only narrow
 * (`restriction`), and a layer can lock a setting so the layers below it cannot change it. Changes are staged as a draft and applied as a whole after the combination of values is checked;
 * a refused apply leaves what is in force untouched and says why. Every value can be asked for with where it comes from, whether it is locked, and when a change to it starts to count. Applying
 * configuration touches nothing but configuration: assignments, pauses and decisions are not read or written.
 *
 * Who may write: the owner, any layer; anyone else holding `config.write` may stage and apply team, agent and task layers, but never the installation layer, never a lock, and never a
 * value wider than the layers above allow.
 */
export class ConfigurationService {
  readonly #runner: CommandRunner;
  readonly #definitions: readonly SettingDefinition[];
  readonly #combiners: readonly Combiner[];
  readonly #routing: RoutingService | undefined;

  private constructor(runner: CommandRunner, options: ConfigurationOptions) {
    this.#runner = runner;
    this.#definitions = [...DEFAULT_SETTINGS, ...(options.settings ?? [])];
    this.#combiners = [...DEFAULT_COMBINERS, ...(options.combiners ?? [])];
    this.#routing = options.routing;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: ConfigurationOptions = {}): ConfigurationService {
    return new ConfigurationService(new CommandRunner(storage, epoch, options), options);
  }

  /** The settings this service knows. */
  settings(): readonly { key: string; kind: "default" | "restriction"; effect: Effect; description: string }[] {
    return this.#definitions.map((d) => ({ key: d.key, kind: d.kind, effect: d.effect, description: d.description }));
  }

  /**
   * Stages changes to one layer as a draft (nothing is in force yet). Without `expectedRevision` the layer is created; with it, the layer must be at that revision. A value must be valid for
   * its setting, not locked by a layer above, and, for a restriction, no wider than what the layers above allow.
   */
  async stage(by: Principal, command: NoActor & { layer: LayerKind; scopeId?: string; expectedRevision?: number; set?: Readonly<Record<string, unknown>>; remove?: readonly string[]; lock?: readonly string[]; unlock?: readonly string[] }): Promise<{ revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "layer", "scopeId", "expectedRevision", "set", "remove", "lock", "unlock"]);
    const { layer, scopeId } = this.#target(command.layer, command.scopeId);
    const expected = command.expectedRevision === undefined ? undefined : checkRevision(command.expectedRevision);
    const set = command.set ?? {};
    if (set === null || typeof set !== "object" || Array.isArray(set)) invalid("set", "must be an object of setting names and values");
    const remove = this.#keys(command.remove ?? [], "remove");
    const lock = this.#keys(command.lock ?? [], "lock");
    const unlock = this.#keys(command.unlock ?? [], "unlock");
    const setKeys = Object.keys(set);
    if (setKeys.length + remove.length + lock.length + unlock.length === 0) invalid("set", "nothing to stage");
    const fresh = await this.#fresh(by.id, by.taskScope);
    const r = await this.#runner.command("config.stage", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { layer, scopeId, expectedRevision: expected ?? null, set: set as JsonObject, remove, lock, unlock },
      build: async () => {
        this.#mayWrite(by, fresh, layer, lock.length + unlock.length > 0);
        await this.#exists(layer, scopeId);
        const chain = await this.#parents(layer, scopeId);
        const id = layerIdOf(layer, scopeId);
        const current = await this.#runner.get("config-layer", id);
        if ((current === undefined ? undefined : current.revision) !== expected) throw new DomainError("stale_revision", `${id} is at revision ${current?.revision ?? 0}, not ${expected ?? 0}`, ...(current === undefined ? [] : [{ currentRevision: current.revision }]));
        const body = (current?.body as unknown as LayerBody | undefined) ?? { layer, scopeId, applied: {}, history: [] };
        const draftSet: Record<string, SettingEntry | null> = { ...(body.draft?.set ?? {}) };
        const now = this.#runner.now();
        for (const key of setKeys) {
          const def = this.#define(key);
          let value: unknown;
          try { value = def.check(set[key]); } catch (message) { return invalid(`set.${key}`, String(message)); }
          this.#checkAbove(chain, key, def, value, layer);
          const keepLock = draftSet[key]?.locked ?? body.applied[key]?.locked;
          draftSet[key] = { value, ...(keepLock === true ? { locked: true } : {}) };
        }
        for (const key of remove) {
          this.#define(key);
          if (!(key in body.applied) && !(key in draftSet)) invalid("remove", `${key} is not set in this layer`);
          draftSet[key] = null;
        }
        for (const [keys, to] of [[lock, true], [unlock, false]] as const) {
          for (const key of keys) {
            this.#define(key);
            const entry = key in draftSet ? draftSet[key] : body.applied[key];
            if (entry === undefined || entry === null) invalid(to ? "lock" : "unlock", `${key} is not set in this layer`);
            const { locked: _was, ...rest } = entry as SettingEntry;
            draftSet[key] = to ? { ...rest, locked: true } : rest;
          }
        }
        if (Object.keys(draftSet).length > CONFIG_LIMITS.keysPerLayer) invalid("set", `a layer holds at most ${CONFIG_LIMITS.keysPerLayer} settings`);
        const next: LayerBody = { ...body, draft: { set: draftSet, by: by.id, at: now } };
        const ref: AggregateRef = { kind: "config-layer", id };
        const changes: Change[] = [current === undefined ? { type: "create", ref, body: next as unknown as JsonObject } : { type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }, ...this.#guards(chain, id)];
        return { ref, creates: current === undefined, changes, detail: { layer, scopeId, keys: setKeys.length + remove.length + lock.length + unlock.length } };
      },
    }));
    return { revision: r.revision, replayed: r.replayed };
  }

  /** Throws away the staged changes of a layer. */
  async discard(by: Principal, command: NoActor & { layer: LayerKind; scopeId?: string; expectedRevision: number }): Promise<void> {
    onlyKnown(command, ["commandId", "layer", "scopeId", "expectedRevision"]);
    const { layer, scopeId } = this.#target(command.layer, command.scopeId);
    const expected = checkRevision(command.expectedRevision);
    const fresh = await this.#fresh(by.id, by.taskScope);
    await this.#runner.command("config.discard", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { layer, scopeId, expectedRevision: expected },
      build: async () => {
        this.#mayWrite(by, fresh, layer, false);
        const id = layerIdOf(layer, scopeId);
        const current = await this.#runner.existing("config-layer", id, expected);
        const body = current.body as unknown as LayerBody;
        if (body.draft === undefined) throw new DomainError("invalid_command", `${id} has nothing staged`, { field: "layer" });
        const { draft: _gone, ...rest } = body;
        const ref: AggregateRef = { kind: "config-layer", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: rest as unknown as JsonObject }], detail: { layer, scopeId } };
      },
    }));
  }

  /**
   * Puts the staged changes into force as one revision, if the result is sound: every value still valid and no wider than the layers above now allow, nothing locked above, and the whole
   * combination fitting together (floors under ceilings, no circular fallbacks, no tool both allowed and denied). If not, nothing changes except a record of why it was refused, and the
   * staged changes stay for correction. The answer says when each change starts to count.
   */
  async apply(by: Principal, command: NoActor & { layer: LayerKind; scopeId?: string; expectedRevision: number }): Promise<{ applied: boolean; revision: number; problems: string[]; takesEffect: Record<string, Effect> }> {
    onlyKnown(command, ["commandId", "layer", "scopeId", "expectedRevision"]);
    const { layer, scopeId } = this.#target(command.layer, command.scopeId);
    const expected = checkRevision(command.expectedRevision);
    const fresh = await this.#fresh(by.id, by.taskScope);
    let outcome: { applied: boolean; problems: string[]; takesEffect: Record<string, Effect> } = { applied: false, problems: [], takesEffect: {} };
    const r = await this.#runner.command("config.apply", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { layer, scopeId, expectedRevision: expected },
      build: async () => {
        this.#mayWrite(by, fresh, layer, false);
        const id = layerIdOf(layer, scopeId);
        const current = await this.#runner.existing("config-layer", id, expected);
        const body = current.body as unknown as LayerBody;
        if (body.draft === undefined) throw new DomainError("invalid_command", `${id} has nothing staged`, { field: "layer" });
        const chain = await this.#parents(layer, scopeId);
        const now = this.#runner.now();
        const applied: Record<string, SettingEntry> = { ...body.applied };
        const set: string[] = []; const removed: string[] = []; const locked: string[] = []; const unlocked: string[] = [];
        const problems: string[] = [];
        for (const [key, entry] of Object.entries(body.draft.set)) {
          if (entry === null) { delete applied[key]; removed.push(key); continue; }
          const def = this.#define(key);
          try { this.#checkAbove(chain, key, def, entry.value, layer); } catch (error) { problems.push(error instanceof DomainError ? error.message.replace(/^[a-z.]+: /, "") : String(error)); continue; }
          if (!same(body.applied[key]?.value, entry.value) || body.applied[key] === undefined) set.push(key);
          if (entry.locked === true && body.applied[key]?.locked !== true) locked.push(key);
          if (entry.locked !== true && body.applied[key]?.locked === true) unlocked.push(key);
          applied[key] = entry;
        }
        if (problems.length === 0) problems.push(...(await this.#combined([...chain, { layer, id: scopeId, applied, aggregate: current }])).problems);
        const ref: AggregateRef = { kind: "config-layer", id };
        if (problems.length > 0) {
          outcome = { applied: false, problems: problems.slice(0, CONFIG_LIMITS.problems), takesEffect: {} };
          const record = { at: now, by: by.id, problems: outcome.problems };
          const failed: LayerBody = { ...body, lastFailure: record, failures: [...(body.failures ?? []), { revision: current.revision + 1, ...record }].slice(-10) };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: failed as unknown as JsonObject }, ...this.#guards(chain, id)], detail: { layer, scopeId, applied: false, problems: outcome.problems.length } };
        }
        const effects: Record<string, Effect> = {};
        for (const key of [...set, ...removed, ...locked, ...unlocked]) effects[key] = this.#define(key).effect;
        const entry: HistoryEntry = { revision: current.revision + 1, at: now, by: by.id, set, removed, locked, unlocked, effects };
        const { draft: _d, lastFailure: _f, ...rest } = body;
        const next: LayerBody = { ...rest, applied, history: [...body.history, entry].slice(-CONFIG_LIMITS.history) };
        outcome = { applied: true, problems: [], takesEffect: effects };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }, ...this.#guards(chain, id)], detail: { layer, scopeId, applied: true, changed: Object.keys(effects).length } };
      },
    }));
    // A repeat of an earlier apply is answered from what that apply recorded (found by the revision it left the layer at), not from the layer as it is now.
    if (r.replayed) {
      const stored = (await this.#runner.get("config-layer", layerIdOf(layer, scopeId)))?.body as unknown as LayerBody | undefined;
      const entry = stored?.history.find((h) => h.revision === r.revision);
      if (entry !== undefined) return { applied: true, revision: r.revision, problems: [], takesEffect: { ...entry.effects } };
      const refused = stored?.failures?.find((f) => f.revision === r.revision);
      if (refused !== undefined) return { applied: false, revision: r.revision, problems: [...refused.problems], takesEffect: {} };
      return { applied: false, revision: r.revision, problems: ["this apply was recorded, but its details are no longer kept"], takesEffect: {} };
    }
    return { ...outcome, revision: r.revision };
  }

  /** One layer as stored: what is in force, what is staged, the last refusal. For the owner and those who may write or read configuration. */
  async layer(by: Principal, layer: LayerKind, scopeId?: string): Promise<View<LayerBody> | undefined> {
    const target = this.#target(layer, scopeId);
    const fresh = await this.#fresh(by.id, by.taskScope);
    if (!this.#mayRead(by, fresh, target.layer, target.scopeId)) return undefined;
    const found = await this.#runner.get("config-layer", layerIdOf(target.layer, target.scopeId));
    return found === undefined ? undefined : view<LayerBody>(found);
  }

  /** Who changed what and when, newest last. */
  async history(by: Principal, layer: LayerKind, scopeId?: string): Promise<readonly HistoryEntry[] | undefined> {
    return (await this.layer(by, layer, scopeId))?.history;
  }

  /**
   * Every setting as it applies to an agent and/or a task, each with its value, where the value comes from, whether a layer above locked it, when a change to it starts to count, and the values
   * that do not count and why. `problems` lists anything wrong with the combination.
   */
  async effective(by: Principal, scope: Scope = {}): Promise<EffectiveConfiguration | undefined> {
    onlyKnown(scope, ["agentId", "taskId"]);
    if (scope.agentId !== undefined && !AGENT_ID.test(scope.agentId)) invalid("agentId", "is not an agent ID");
    if (scope.taskId !== undefined && !TASK_ID.test(scope.taskId)) invalid("taskId", "is not a task ID");
    const fresh = await this.#fresh(by.id, by.taskScope);
    const ownScope = scope.agentId !== undefined && fresh?.kind === "agent" && by.taskScope === undefined && by.id === `agent:${scope.agentId}`;
    if (!(by.kind === "owner" || ownScope || (fresh !== undefined && (allows(fresh, "config.read", "*") || allows(fresh, "config.write", "*"))))) return undefined;
    const chain: Link[] = [await this.#link("installation", "installation")];
    // A task asked about without an agent is read for the agent now working it, if there is one.
    const agentId = scope.agentId ?? (scope.taskId === undefined ? undefined : await this.#agentOfTask(scope.taskId));
    const complete = scope.taskId === undefined || agentId !== undefined;
    if (agentId !== undefined) {
      const agent = await this.#runner.get("agent", agentId);
      if (agent === undefined) return undefined;
      const teamId = (agent.body as unknown as { teamId?: string }).teamId;
      if (teamId !== undefined) chain.push(await this.#link("team", teamId));
      chain.push(await this.#link("agent", agentId));
    }
    if (scope.taskId !== undefined) {
      if ((await this.#runner.get("task", scope.taskId)) === undefined) return undefined;
      chain.push(await this.#link("task", scope.taskId));
    }
    return { ...(await this.#combined(chain)), complete };
  }

  /** One setting's installation-level value, for the controller's own reading (no rights check: it is not an answer to a caller). `undefined` when the setting is not known or unset. */
  async installationValue(key: string): Promise<unknown> {
    return (await this.#combined([await this.#link("installation", "installation")])).values[key]?.value;
  }

  // ---- routing binding (card R01) -------------------------------------------------------------------------------------------

  /**
   * Loads the configuration document's routing section into the routing table, after checking it against the configuration (fallback profiles must exist and not circle). The same
   * path serves the owner's screen and the coordinator agent: both end in one routing revision. Needs the owner or `routing.write`.
   */
  async bindRouting(by: Principal, command: NoActor & { expectedRevision: number; routing: unknown }): Promise<{ revision: number; replayed: boolean }> {
    const routing = this.#routing ?? invalid("routing", "no routing service is attached");
    onlyKnown(command, ["commandId", "expectedRevision", "routing"]);
    const doc = command.routing;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) invalid("routing", "must be an object with providers, routes, profiles and roles");
    const profiles = Object.keys((doc as { profiles?: Record<string, unknown> }).profiles ?? {});
    const installation = await this.#combined([await this.#link("installation", "installation")], { profiles });
    if (installation.problems.length > 0) throw new DomainError("invalid_command", `the routing document does not fit the configuration: ${installation.problems.join("; ")}`, { field: "routing" });
    return routing.setTable(by, { commandId: command.commandId, expectedRevision: command.expectedRevision, table: doc });
  }

  /**
   * Puts one profile's routes in a new order (the same routes, a different order). The screen's reorder and the coordinator's reorder both come here and so produce the same routing revision.
   * Needs the owner or `routing.write`.
   */
  async reorderProfile(by: Principal, command: NoActor & { expectedRevision: number; profile: string; order: readonly string[] }): Promise<{ revision: number; replayed: boolean }> {
    const routing = this.#routing ?? invalid("routing", "no routing service is attached");
    onlyKnown(command, ["commandId", "expectedRevision", "profile", "order"]);
    const table = await routing.get();
    if (table === undefined) throw new DomainError("not_found", "no routing table is configured");
    if (table.revision !== command.expectedRevision) throw new DomainError("stale_revision", `routing is at revision ${table.revision}, not ${command.expectedRevision}`, { currentRevision: table.revision });
    const current = Object.hasOwn(table.profiles, command.profile) ? table.profiles[command.profile]! : invalid("profile", `${String(command.profile)} is not a profile`);
    if (!Array.isArray(command.order) || command.order.length !== current.length || !command.order.every((r) => current.includes(r)) || new Set(command.order).size !== current.length) invalid("order", "must list exactly the routes the profile has now, in the new order");
    return routing.setTable(by, { commandId: command.commandId, expectedRevision: table.revision, table: { providers: table.providers, routes: table.routes, roles: table.roles, profiles: { ...table.profiles, [command.profile]: [...command.order] } } });
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  #target(layer: unknown, scopeId: unknown): { layer: LayerKind; scopeId: string } {
    if (typeof layer !== "string" || !LAYER_ORDER.includes(layer as LayerKind)) return invalid("layer", "must be installation, team, agent or task");
    const kind = layer as LayerKind;
    if (kind === "installation") { if (scopeId !== undefined) invalid("scopeId", "the installation layer has none"); return { layer: kind, scopeId: "installation" }; }
    const pattern = kind === "team" ? TEAM_ID : kind === "agent" ? AGENT_ID : TASK_ID;
    return typeof scopeId === "string" && pattern.test(scopeId) ? { layer: kind, scopeId } : invalid("scopeId", `is not a ${kind} ID`);
  }

  #keys(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.length > CONFIG_LIMITS.keysPerLayer) return invalid(field, `must be a list of at most ${CONFIG_LIMITS.keysPerLayer} setting names`);
    return [...new Set(value.map((k, i) => (typeof k === "string" && SETTING_KEY.test(k) ? k : invalid(`${field}[${i}]`, "is not a setting name"))))];
  }

  #define(key: string): SettingDefinition {
    return definitionFor(key, this.#definitions) ?? invalid("set", `${key} is not a setting this installation knows`);
  }

  #mayWrite(by: Principal, fresh: Principal | undefined, layer: LayerKind, locking: boolean): void {
    if (by.kind === "owner") return;
    if (fresh === undefined || !allowsExactly(fresh, "config.write", "*")) throw new DomainError("forbidden", `${by.id} may not change configuration; it takes a grant that names config.write`);
    if (layer === "installation") throw new DomainError("forbidden", `${by.id} may not change the installation layer; only the owner does`);
    if (locking) throw new DomainError("forbidden", `${by.id} may not lock or unlock settings; only the owner does`);
  }

  #mayRead(by: Principal, fresh: Principal | undefined, layer: LayerKind, scopeId: string): boolean {
    if (by.kind === "owner") return true;
    if (fresh === undefined) return false;
    if (allows(fresh, "config.read", "*") || allows(fresh, "config.write", "*")) return true;
    return layer === "agent" && fresh.kind === "agent" && by.taskScope === undefined && by.id === `agent:${scopeId}`;
  }

  async #exists(layer: LayerKind, scopeId: string): Promise<void> {
    if (layer === "installation") return;
    if ((await this.#runner.get(layer, scopeId)) === undefined) throw new DomainError("not_found", `${layer} ${scopeId} does not exist`);
  }

  async #link(layer: LayerKind, scopeId: string): Promise<Link> {
    const aggregate = await this.#runner.get("config-layer", layerIdOf(layer, scopeId));
    return { layer, id: scopeId, applied: (aggregate?.body as unknown as LayerBody | undefined)?.applied ?? {}, aggregate };
  }

  /**
   * The layers above one layer, least specific first: for a team, the installation; for an agent, the installation and its team; for a task, the installation and, when an agent is working
   * the task, that agent's team and the agent. A task nobody is working is checked against the installation only; the full check happens when the task is read for an agent.
   */
  async #parents(layer: LayerKind, scopeId: string): Promise<Link[]> {
    const chain: Link[] = [];
    if (layer !== "installation") chain.push(await this.#link("installation", "installation"));
    const agentId = layer === "agent" ? undefined : layer === "task" ? await this.#agentOfTask(scopeId) : undefined;
    const forAgent = layer === "agent" ? scopeId : agentId;
    if (forAgent !== undefined) {
      const teamId = ((await this.#runner.get("agent", forAgent))?.body as unknown as { teamId?: string } | undefined)?.teamId;
      if (teamId !== undefined) chain.push(await this.#link("team", teamId));
      if (layer === "task") chain.push(await this.#link("agent", forAgent));
    }
    return chain;
  }

  /** The agent now working a task, if its assignment names an agent that exists. */
  async #agentOfTask(taskId: string): Promise<string | undefined> {
    const owner = ((await this.#runner.get("assignment", assignmentIdOf(taskId)))?.body as unknown as AssignmentBody | undefined)?.owner;
    if (owner === undefined || owner.kind !== "agent" || !AGENT_ID.test(owner.id)) return undefined;
    return (await this.#runner.get("agent", owner.id)) === undefined ? undefined : owner.id;
  }

  /** Guards on the layers above, so a change above that lands at the same moment makes this one read again. */
  #guards(chain: readonly Link[], self: string): Change[] {
    return chain.filter((l) => l.aggregate !== undefined && l.aggregate.id !== self).map((l) => ({ type: "check", ref: { kind: "config-layer", id: l.aggregate!.id }, expectedRevision: l.aggregate!.revision }));
  }

  /** A value for a layer must not be locked by a layer above and, for a restriction, must be no wider than what they allow. */
  #checkAbove(chain: readonly Link[], key: string, def: SettingDefinition, value: unknown, layer: LayerKind): void {
    for (const above of chain) {
      if (above.applied[key]?.locked === true) invalid("set", `${key} is locked by the ${above.layer} layer; ${layer} cannot change it`);
    }
    if (def.kind !== "restriction") return;
    let bound: unknown;
    for (const above of chain) {
      const e = above.applied[key];
      if (e === undefined) continue;
      bound = bound === undefined ? e.value : def.meet!(bound, e.value);
    }
    const limit = bound ?? def.fallback;
    if (limit !== undefined && !def.within!(value, limit)) invalid("set", `${key} = ${JSON.stringify(value)} is wider than the layers above allow (${JSON.stringify(limit)}); a ${layer} layer can only narrow it`);
  }

  async #combined(chain: readonly Link[], context: CombineContext = {}): Promise<Omit<EffectiveConfiguration, "complete">> {
    const table = this.#routing === undefined || context.profiles !== undefined ? undefined : await this.#routing.get();
    const ctx: CombineContext = context.profiles !== undefined ? context : table === undefined ? {} : { profiles: Object.keys(table.profiles) };
    const keys = new Set<string>(this.#definitions.filter((d) => !d.key.includes("*") && d.fallback !== undefined).map((d) => d.key));
    for (const link of chain) for (const key of Object.keys(link.applied)) keys.add(key);
    const values: Record<string, ResolvedSetting> = {};
    for (const key of [...keys].sort()) {
      const def = definitionFor(key, this.#definitions);
      if (def === undefined) continue;
      let value: unknown = def.fallback;
      let source: ResolvedSetting["source"] = { layer: "default", id: "default" };
      let lockedBy: ResolvedSetting["lockedBy"];
      const ignored: { layer: LayerKind; id: string; reason: string }[] = [];
      for (const link of chain) {
        const e = link.applied[key];
        if (lockedBy !== undefined) { if (e !== undefined) ignored.push({ layer: link.layer, id: link.id, reason: `locked by the ${lockedBy.layer} layer` }); continue; }
        if (e !== undefined) {
          if (def.kind === "default" || value === undefined) { value = e.value; source = { layer: link.layer, id: link.id }; }
          else {
            const met = def.meet!(value, e.value);
            if (!same(met, value) || source.layer === "default") { value = met; source = { layer: link.layer, id: link.id }; }
            else if (!same(met, e.value)) ignored.push({ layer: link.layer, id: link.id, reason: "wider than the layers above allow" });
          }
          if (e.locked === true) lockedBy = { layer: link.layer, id: link.id };
        }
      }
      if (value === undefined) continue;
      values[key] = { value, source, ...(lockedBy === undefined ? {} : { lockedBy }), effect: def.effect, ignored };
    }
    const flat = Object.fromEntries(Object.entries(values).map(([k, v]) => [k, v.value]));
    const problems = this.#combiners.flatMap((c) => c(flat, ctx));
    return { values, problems: problems.slice(0, CONFIG_LIMITS.problems) };
  }

  /** `scope` is passed when the principal is the caller, so a task credential stays inside its task when its grants are looked up again. */
  async #fresh(principalId: string, scope?: Principal["taskScope"]): Promise<Principal | undefined> {
    const found = await this.#runner.get("principal", principalId);
    const body = found?.body as unknown as PrincipalBody | undefined;
    if (found === undefined || body === undefined || body.state !== "active") return undefined;
    return effectiveOf(this.#runner, { id: found.id, kind: body.kind, name: body.name, grants: body.grants, ...(scope === undefined ? {} : { taskScope: scope }) }, this.#runner.now());
  }
}
