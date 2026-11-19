import { DomainError } from "../domain/errors.js";
import { SIMULATED_EFFECT_LABEL, SIMULATION_SCOPE_ID, type EffectBridge, type EffectService } from "../domain/effects.js";
import { derivedId } from "../domain/ids.js";
import { commandId as checkCommandId, onlyKnown, taskId as checkTaskId } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";
import { canonicalJson } from "../storage/json.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { operationBridge } from "../service-ops/service-ops.js";
import { SimulatedServices, type SimulatedFaults, type SimulatedLayout, type SimulatedSnapshot } from "../service-ops/simulated.js";
import type { Observation, ServiceAction, ServiceRef, ServiceTarget } from "../service-ops/target.js";

/**
 * Simulation scopes (card P07, first slice). A scope is an isolated place where the owner tries service operations for a task before any real access is used:
 * - it holds its own world, a deterministic in-process stand-in (`SimulatedServices`) built from the layout the owner gives, kept in the scope's own record so it outlives a restart;
 * - every operation in it goes through the effect ledger (card S05) as an effect marked with the scope. The ledger runs such an effect through a simulated bridge only: offered to any
 *   real bridge (a service connector, a tool, a message, a model call), it is settled `failed` with the refusal and nothing is done. So no real write, send or spend is possible in the scope;
 * - every result carries `simulated: true` and the label, and the ledger adds the same label to the effect's evidence, so a simulated result is never shown or accepted as a real one
 *   (an operational outcome cannot name it: `ServiceOperations.checkOutcome`);
 * - it holds no real service target, no tool, no model, no message port and no grant: the owner grants real access separately (`grant.create`), and nothing here reads or changes a grant.
 * What it is NOT yet: a whole workflow run by agents against simulated tools, events and providers, with competing edits (the rest of card P07).
 */
export const SIMULATION_SCOPE_LABEL = "Simulated. This scope works on a stand-in of the services; nothing real is written, sent or spent here, and real access is granted separately.";
export const SIMULATION_SCOPE_LIMITS = { services: 20, resources: 20, stateBytes: 8 * 1024, operations: 200, purpose: 200 } as const;
const KIND = "simulation-scope";
const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const INJECT = ["refuse", "lose-answer", "corrupt", "leak"] as const;
export type SimulationInject = (typeof INJECT)[number];

export interface SimulationScopeBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly purpose?: string;
  readonly state: "open" | "closed";
  readonly closedAt?: string;
  readonly label: string;
  /** What the scope reaches: only its own stand-in. Recorded so a reader sees it. */
  readonly isolation: { readonly world: "stand-in"; readonly realServices: false; readonly tools: false; readonly providers: false; readonly messages: false; readonly grants: false };
  readonly world: SimulatedSnapshot;
  /** The effects of the scope, in order (each an effect of the ledger marked with this scope). */
  readonly effects: readonly string[];
}

export interface SimulationOperateResult {
  readonly scopeId: string;
  readonly effectId: string;
  readonly status: string;
  readonly evidence?: JsonObject;
  readonly note?: string;
  readonly simulated: true;
  readonly label: string;
}

export interface SimulationPorts {
  /** The ledger the scope's effects are written to. It is the same ledger as real work: it is what refuses a real bridge for an effect of a scope. */
  readonly effects: Pick<EffectService, "intend" | "run" | "get">;
}

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
const refKey = (r: ServiceRef): string => `${r.service}/${r.resource}`;

function checkLayout(raw: unknown): SimulatedLayout {
  if (!isObject(raw)) return invalid("layout", "must be an object of services, each an object of resources");
  const services = Object.keys(raw);
  if (services.length === 0 || services.length > SIMULATION_SCOPE_LIMITS.services) invalid("layout", `must name 1 to ${SIMULATION_SCOPE_LIMITS.services} services`);
  const known = new Set<string>();
  for (const s of services) {
    if (!NAME.test(s)) invalid("layout", `service ${JSON.stringify(s.slice(0, 64))} must be a name (lower-case letters, digits, . _ -)`);
    const resources = raw[s];
    if (!isObject(resources) || Object.keys(resources).length === 0 || Object.keys(resources).length > SIMULATION_SCOPE_LIMITS.resources) invalid("layout", `service ${s} must hold 1 to ${SIMULATION_SCOPE_LIMITS.resources} resources`);
    for (const r of Object.keys(resources as JsonObject)) { if (!NAME.test(r)) invalid("layout", `resource ${JSON.stringify(r.slice(0, 64))} of ${s} must be a name`); known.add(`${s}/${r}`); }
  }
  const out: Record<string, Record<string, { state: JsonObject; dependents: ServiceRef[] }>> = {};
  for (const s of services) {
    out[s] = {};
    for (const [r, cell] of Object.entries(raw[s] as JsonObject)) {
      if (!isObject(cell)) invalid("layout", `${s}/${r} must be an object like { state?, dependents? }`);
      onlyKnown(cell as JsonObject, ["state", "dependents"]);
      const state = (cell as JsonObject)["state"] ?? {};
      if (!isObject(state)) invalid("layout", `${s}/${r}.state must be an object`);
      if (canonicalJson(state as JsonObject).length > SIMULATION_SCOPE_LIMITS.stateBytes) invalid("layout", `${s}/${r}.state must be at most ${SIMULATION_SCOPE_LIMITS.stateBytes} characters`);
      const deps = (cell as JsonObject)["dependents"] ?? [];
      if (!Array.isArray(deps) || deps.length > SIMULATION_SCOPE_LIMITS.resources) invalid("layout", `${s}/${r}.dependents must be a list of { service, resource }`);
      const dependents = (deps as unknown[]).map((d) => {
        if (!isObject(d) || typeof d["service"] !== "string" || typeof d["resource"] !== "string") return invalid("layout", `${s}/${r}.dependents must be a list of { service, resource }`);
        onlyKnown(d, ["service", "resource"]);
        if (!known.has(`${d["service"]}/${d["resource"]}`)) invalid("layout", `${s}/${r} names a dependent that is not in the layout`);
        return { service: d["service"] as string, resource: d["resource"] as string };
      });
      out[s]![r] = { state: state as JsonObject, dependents };
    }
  }
  return out;
}

/**
 * The scope's stand-in as the effect bridge sees it: every apply that reaches it (or might have, when its answer is lost) is saved to the scope's record before the
 * bridge goes on, so what the ledger later settles is what the record holds.
 */
class ScopeWorld implements ServiceTarget {
  constructor(readonly inner: SimulatedServices, private readonly save: () => Promise<void>) {}
  observe(ref: ServiceRef) { return this.inner.observe(ref); }
  affects(ref: ServiceRef, action: ServiceAction) { return this.inner.affects(ref, action); }
  neighbours(ref: ServiceRef) { return this.inner.neighbours(ref); }
  applied(key: string) { return this.inner.applied(key); }
  verify(ref: ServiceRef, action: ServiceAction, before: Observation, after: Observation) { return this.inner.verify(ref, action, before, after); }
  async apply(key: string, ref: ServiceRef, action: ServiceAction, context?: JsonObject): Promise<void> {
    try { await this.inner.apply(key, ref, action, context); } finally { await this.save(); }
  }
}

export class SimulationService {
  readonly #runner: CommandRunner;
  readonly #ports: SimulationPorts;
  /** One operation at a time per scope in this process (its world is read, changed and saved in turn). */
  readonly #locks = new Map<string, Promise<unknown>>();
  private constructor(runner: CommandRunner, ports: SimulationPorts) { this.#runner = runner; this.#ports = ports; }

  static withEpoch(storage: ControllerStorage, epoch: number, ports: SimulationPorts, options: RunnerOptions = {}): SimulationService {
    return new SimulationService(new CommandRunner(storage, epoch, options), ports);
  }

  #owner(by: Principal, taskId?: string): void {
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner may use a simulation scope");
    if (by.taskScope !== undefined && (taskId === undefined || by.taskScope.taskId !== taskId)) throw new DomainError("forbidden", "a credential confined to a task may use a simulation scope of that task only");
  }

  async #scope(id: unknown): Promise<{ id: string; revision: number; body: SimulationScopeBody }> {
    if (typeof id !== "string" || !SIMULATION_SCOPE_ID.test(id)) throw new DomainError("not_found", "no such simulation scope");
    const found = await this.#runner.get(KIND, id);
    if (found === undefined) throw new DomainError("not_found", "no such simulation scope");
    return { id, revision: found.revision, body: found.body as unknown as SimulationScopeBody };
  }

  async #serial<T>(scopeId: string, run: () => Promise<T>): Promise<T> {
    const before = this.#locks.get(scopeId) ?? Promise.resolve();
    const mine = before.then(run, run);
    const tail = mine.catch(() => undefined);
    this.#locks.set(scopeId, tail);
    try { return await mine; } finally { if (this.#locks.get(scopeId) === tail) this.#locks.delete(scopeId); }
  }

  /** Owner only. Opens a scope for a task with its own stand-in world built from `layout` (services, their resources, each resource's state and dependents). Repeating the command opens it once. */
  async open(by: Principal, command: { commandId: string; taskId: string; layout: unknown; purpose?: string }): Promise<{ id: string; replayed: boolean; scope: SimulationScopeBody }> {
    onlyKnown(command, ["commandId", "taskId", "layout", "purpose"]);
    checkCommandId(command.commandId);
    const taskId = checkTaskId(command.taskId);
    this.#owner(by, taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as { projectId: string } | undefined;
    if (task === undefined) throw new DomainError("not_found", "no such task");
    const layout = checkLayout(command.layout);
    if (command.purpose !== undefined && (typeof command.purpose !== "string" || command.purpose.length === 0 || command.purpose.length > SIMULATION_SCOPE_LIMITS.purpose)) invalid("purpose", `must be 1 to ${SIMULATION_SCOPE_LIMITS.purpose} characters`);
    const world = new SimulatedServices(layout, () => this.#runner.now()).snapshot();
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("sms", scoped);
    const ref: AggregateRef = { kind: KIND, id };
    const body: SimulationScopeBody = {
      taskId, projectId: task.projectId, openedBy: by.id, openedAt: this.#runner.now(), ...(command.purpose === undefined ? {} : { purpose: command.purpose }), state: "open", label: SIMULATION_SCOPE_LABEL,
      isolation: { world: "stand-in", realServices: false, tools: false, providers: false, messages: false, grants: false }, world, effects: [],
    };
    const r = await this.#runner.command("simulation.open", { commandId: scoped, actor: by.id }, async () => ({
      payload: { taskId, layout: layout as unknown as JsonObject, ...(command.purpose === undefined ? {} : { purpose: command.purpose }) },
      build: async () => ({ ref, creates: true, changes: [{ type: "create" as const, ref, body: JSON.parse(JSON.stringify(body)) as JsonObject }], detail: { taskId, simulated: true } }),
    }));
    return { id: r.id, replayed: r.replayed, scope: (await this.#scope(r.id)).body };
  }

  /** Owner only. The scope, its stand-in world and the status of each of its effects as the ledger records them. */
  async get(by: Principal, scopeId: string): Promise<{ id: string; scope: SimulationScopeBody; effects: { effectId: string; status: string; target?: string; simulated: true }[] }> {
    if (by.kind !== "owner") throw new DomainError("not_found", "no such simulation scope");
    const s = await this.#scope(scopeId);
    this.#owner(by, s.body.taskId);
    const effects = [];
    for (const effectId of s.body.effects) {
      const e = await this.#ports.effects.get(effectId);
      effects.push({ effectId, status: e?.status ?? "not-recorded", ...(e === undefined ? {} : { target: e.target }), simulated: true as const });
    }
    return { id: s.id, scope: s.body, effects };
  }

  /** Owner only. What the scope's stand-in holds for one resource, labelled simulated. */
  async observe(by: Principal, command: { scopeId: string; service: string; resource: string }): Promise<Observation & { simulated: true; label: string }> {
    onlyKnown(command, ["scopeId", "service", "resource"]);
    if (by.kind !== "owner") throw new DomainError("not_found", "no such simulation scope");
    const s = await this.#scope(command.scopeId);
    this.#owner(by, s.body.taskId);
    const ref = this.#ref(command.service, command.resource);
    const seen = await SimulatedServices.fromSnapshot(s.body.world, () => this.#runner.now()).observe(ref);
    if (seen === undefined) throw new DomainError("not_found", `${refKey(ref)} is not in this simulation scope`);
    return { ...seen, simulated: true, label: SIMULATION_SCOPE_LABEL };
  }

  #ref(service: unknown, resource: unknown): ServiceRef {
    if (typeof service !== "string" || !NAME.test(service)) invalid("service", "must be a service name (lower-case letters, digits, . _ -)");
    if (typeof resource !== "string" || !NAME.test(resource)) invalid("resource", "must be a resource name (lower-case letters, digits, . _ -)");
    return { service: service as string, resource: resource as string };
  }

  #action(raw: unknown): ServiceAction {
    if (!isObject(raw)) return invalid("action", "must be an object like { type, params }");
    onlyKnown(raw, ["type", "params"]);
    if (typeof raw["type"] !== "string" || !/^[a-z][a-z0-9-]{0,39}$/.test(raw["type"])) invalid("action.type", "must be 1 to 40 lower-case letters, digits or hyphens");
    if (raw["params"] !== undefined && !isObject(raw["params"])) invalid("action.params", "must be an object");
    return { type: raw["type"] as string, ...(raw["params"] === undefined ? {} : { params: raw["params"] as JsonObject }) };
  }

  /**
   * Owner only. Does one action on one resource of the scope's stand-in, through the effect ledger as an effect of the scope (simulated bridge only). `inject` makes the stand-in
   * misbehave once, as a real service might: `refuse` (the service says no), `lose-answer` (applied, the answer lost: the ledger asks instead of repeating), `corrupt` (applied wrongly:
   * the read-back catches it) or `leak` (a neighbour changes too: the collateral check catches it). Repeating the command does it once.
   */
  async operate(by: Principal, command: { commandId: string; scopeId: string; service: string; resource: string; action: unknown; inject?: string }): Promise<SimulationOperateResult> {
    onlyKnown(command, ["commandId", "scopeId", "service", "resource", "action", "inject"]);
    const commandId = checkCommandId(command.commandId);
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner may use a simulation scope");
    const ref = this.#ref(command.service, command.resource);
    const action = this.#action(command.action);
    if (command.inject !== undefined && !(INJECT as readonly unknown[]).includes(command.inject)) invalid("inject", `must be one of ${INJECT.join(", ")}`);
    const first = await this.#scope(command.scopeId);
    this.#owner(by, first.body.taskId);
    const scopeId = first.id;
    const intentId = `simop:${scopeId}:${scopedCommandId(by.id, commandId)}`.slice(0, 120);
    const effectId = derivedId("eff", intentId);
    return this.#serial(scopeId, async () => {
      const known = await this.#ports.effects.get(effectId);
      if (known !== undefined) {
        const was = known.input;
        if (known.simulation !== scopeId || known.kind !== "service-op" || was["service"] !== ref.service || was["resource"] !== ref.resource || canonicalJson(was["action"] as JsonObject) !== canonicalJson(action as unknown as JsonObject)) throw new DomainError("command_conflict", `command ID ${commandId} was already used for a different operation`);
        await this.#listEffect(scopeId, effectId);
        return this.#result(scopeId, effectId, await this.#ports.effects.run(effectId, this.#bridge(scopeId, (await this.#scope(scopeId)).body.world)));
      }
      const s = await this.#scope(scopeId);
      if (s.body.state !== "open") throw new DomainError("invalid_command", "the simulation scope is closed");
      if (s.body.effects.length >= SIMULATION_SCOPE_LIMITS.operations) throw new DomainError("invalid_command", `a simulation scope holds at most ${SIMULATION_SCOPE_LIMITS.operations} operations; open another`);
      const sim = SimulatedServices.fromSnapshot(s.body.world, () => this.#runner.now());
      const before = await sim.observe(ref);
      if (before === undefined) throw new DomainError("not_found", `${refKey(ref)} is not in this simulation scope`);
      const reach = await sim.affects(ref, action);
      const all = reach.some((r) => r.service === ref.service && r.resource === ref.resource) ? reach : [ref, ...reach];
      const guarded = (await sim.neighbours(ref)).filter((n) => !all.some((a) => a.service === n.service && a.resource === n.resource));
      const baseline: Record<string, string> = {};
      for (const n of guarded) baseline[refKey(n)] = (await sim.observe(n))?.systemVersion ?? "absent";
      const input: JsonObject = {
        service: ref.service, resource: ref.resource, action: action as unknown as JsonObject, allowed: all.map((r) => ({ service: r.service, resource: r.resource })),
        before: before as unknown as JsonObject, baseline: baseline as unknown as JsonObject, ...(command.inject === undefined ? {} : { inject: command.inject }),
      };
      await this.#ports.effects.intend({ commandId: intentId, actor: by.id, kind: "service-op", target: `simulation:${scopeId}/service:${refKey(ref)}`, input, taskId: s.body.taskId, simulation: scopeId });
      await this.#listEffect(scopeId, effectId);
      const faults: SimulatedFaults = command.inject === "refuse" ? { refuseNext: "the simulated service refused the action (injected)" } : command.inject === "lose-answer" ? { loseNextAnswer: true } : command.inject === "corrupt" ? { corruptNext: true } : command.inject === "leak" && guarded[0] !== undefined ? { leakInto: guarded[0] } : {};
      return this.#result(scopeId, effectId, await this.#ports.effects.run(effectId, this.#bridge(scopeId, (await this.#scope(scopeId)).body.world, faults)));
    });
  }

  /** The scope's simulated bridge: the service-operation bridge over the scope's stand-in, marked simulated so the ledger lets it run the scope's effects (and only them). */
  #bridge(scopeId: string, world: SimulatedSnapshot, faults: SimulatedFaults = {}): EffectBridge {
    const sim = SimulatedServices.fromSnapshot(world, () => this.#runner.now());
    Object.assign(sim.faults, faults);
    const target = new ScopeWorld(sim, () => this.#saveWorld(scopeId, sim.snapshot()));
    return { ...operationBridge(target), simulated: true };
  }

  async #saveWorld(scopeId: string, world: SimulatedSnapshot): Promise<void> {
    const s = await this.#scope(scopeId);
    if (canonicalJson(s.body.world as unknown as JsonObject) === canonicalJson(world as unknown as JsonObject)) return;
    const ref: AggregateRef = { kind: KIND, id: scopeId };
    await this.#runner.command("simulation.world", { commandId: `simworld:${scopeId}:${s.revision}`, actor: "simulation" }, async () => ({
      payload: { scopeId, revision: s.revision, world: world as unknown as JsonObject },
      build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: s.revision, body: { ...(s.body as unknown as JsonObject), world: world as unknown as JsonObject } }], detail: { simulated: true } }),
    }));
  }

  async #listEffect(scopeId: string, effectId: string): Promise<void> {
    const s = await this.#scope(scopeId);
    if (s.body.effects.includes(effectId)) return;
    const ref: AggregateRef = { kind: KIND, id: scopeId };
    await this.#runner.command("simulation.effect", { commandId: `simeff:${scopeId}:${s.revision}`, actor: "simulation" }, async () => ({
      payload: { scopeId, revision: s.revision, effectId },
      build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: s.revision, body: { ...(s.body as unknown as JsonObject), effects: [...s.body.effects, effectId] } }], detail: { effectId, simulated: true } }),
    }));
  }

  #result(scopeId: string, effectId: string, outcome: { status: string; evidence?: JsonObject; note?: string }): SimulationOperateResult {
    return { scopeId, effectId, status: outcome.status, ...(outcome.evidence === undefined ? {} : { evidence: outcome.evidence }), ...(outcome.note === undefined ? {} : { note: outcome.note }), simulated: true, label: SIMULATED_EFFECT_LABEL };
  }

  /** Owner only. Closes the scope: no further operation runs in it; what it recorded stays readable. Repeating it is harmless. */
  async close(by: Principal, command: { commandId: string; scopeId: string }): Promise<{ id: string; scope: SimulationScopeBody }> {
    onlyKnown(command, ["commandId", "scopeId"]);
    checkCommandId(command.commandId);
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner may use a simulation scope");
    const first = await this.#scope(command.scopeId);
    this.#owner(by, first.body.taskId);
    return this.#serial(first.id, async () => {
      const s = await this.#scope(first.id);
      const ref: AggregateRef = { kind: KIND, id: s.id };
      await this.#runner.command("simulation.close", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
        payload: { scopeId: s.id },
        build: async () => {
          const now = await this.#scope(s.id);
          if (now.body.state === "closed") return { ref, creates: false, changes: [{ type: "check" as const, ref, expectedRevision: now.revision }], detail: { already: true } };
          return { ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: now.revision, body: { ...(now.body as unknown as JsonObject), state: "closed", closedAt: this.#runner.now() } }], detail: { simulated: true } };
        },
      }));
      return { id: s.id, scope: (await this.#scope(s.id)).body };
    });
  }
}
