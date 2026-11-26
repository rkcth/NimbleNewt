import { DomainError, isDomainError } from "../domain/errors.js";
import { EffectRejected, SIMULATED_EFFECT_LABEL, SIMULATION_SCOPE_ID, type EffectBody, type EffectBridge, type EffectService } from "../domain/effects.js";
import { derivedId } from "../domain/ids.js";
import { commandId as checkCommandId, onlyKnown, taskId as checkTaskId } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";
import { canonicalJson } from "../storage/json.js";
import { LIMITS, type AggregateRef, type ControllerStorage, type JsonObject } from "../storage/types.js";
import { checkBody } from "../storage/validate.js";
import { operationBridge } from "../service-ops/service-ops.js";
import { SimulatedServices, type SimulatedFaults, type SimulatedLayout, type SimulatedSnapshot } from "../service-ops/simulated.js";
import type { Observation, ServiceAction, ServiceRef, ServiceTarget } from "../service-ops/target.js";
import type { GrantService } from "../security/grants.js";
import { RUN_LIMITS, ScratchRouter, checkScript, overlaps, providerBridge, type ProviderFailure, type RunStep } from "./workflow.js";

/**
 * Simulation scopes (card P07, first slice). A scope is an isolated place where the owner tries service operations for a task before any real access is used:
 * - it holds its own world, a deterministic in-process stand-in (`SimulatedServices`) built from the layout the owner gives, kept in the scope's own record so it outlives a restart;
 * - every operation in it goes through the effect ledger (card S05) as an effect marked with the scope. The ledger runs such an effect through a simulated bridge only: offered to any
 *   real bridge (a service connector, a tool, a message, a model call), it is settled `failed` with the refusal and nothing is done. So no real write, send or spend is possible in the scope;
 * - every result carries `simulated: true` and the label, and the ledger adds the same label to the effect's evidence, so a simulated result is never shown or accepted as a real one
 *   (an operational outcome cannot name it: `ServiceOperations.checkOutcome`);
 * - it holds no real service target, no tool, no model, no message port and no grant: the owner grants real access separately (`grant.create`), and nothing here reads or changes a grant.
 * A workflow runs in a scope too (`run`, see `workflow.ts`): named stand-in agents, scripted stand-in model providers decided by the real R02 fallback, the scope's stand-in services as tools,
 * and events (a provider failure, a competing edit). Real access is a separate owner step after a simulation (`grant`), which goes through the grant service; nothing else here grants anything.
 * A replay rerun (`activity.replay.simulate`) is recorded in the task's own scope (`replayScope`), the same one each time.
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
  /** The workflow runs of the scope (`simulation-run` records), in order. */
  readonly runs?: readonly string[];
  /** Real access the owner granted after a simulation of this scope (`grant`): the grant service made each one; the scope only notes them. */
  readonly grants?: readonly { readonly grantId: string; readonly grantee: string; readonly action: string; readonly resource: string; readonly runId: string; readonly at: string }[];
  /** Replay reruns of the task recorded in this scope (`replay-simulation` records). */
  readonly replays?: readonly string[];
}

export type RunOutcome = "completed" | "completed-with-problems" | "stopped";
/** One step of a run as it happened. `words` says it plainly; every result is simulated. */
export interface RunStepResult {
  readonly index: number;
  readonly kind: RunStep["kind"];
  readonly outcome: "armed" | "done" | "retried" | "conflict" | "failed" | "stopped" | "not-reached";
  readonly agent?: string;
  readonly target?: string;
  /** The model attempts of an agent step as the R02 fallback decided them (each an effect of the scope, kind model-call). */
  readonly attempts?: readonly { readonly route: string; readonly effectId: string; readonly outcome: "answered" | "failed"; readonly failure?: string }[];
  readonly fallback?: boolean;
  /** The version of the resource the agent read before it asked its model. */
  readonly saw?: string;
  readonly tool?: { readonly effectId: string; readonly status: string };
  readonly edit?: { readonly effectId: string; readonly status: string };
  readonly retry?: { readonly effectId: string; readonly status: string };
  readonly words: string;
  readonly simulated: true;
}
export interface SimulationRunBody {
  readonly scopeId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly by: string;
  readonly startedAt: string;
  readonly providers: readonly string[];
  readonly script: readonly RunStep[];
  readonly state: "running" | "finished";
  readonly outcome?: RunOutcome;
  readonly finishedAt?: string;
  readonly results: readonly RunStepResult[];
  /** Provider failures armed by events and not yet met. */
  readonly armed: readonly { readonly route: string; readonly failure: ProviderFailure; readonly left: number }[];
  readonly effects: readonly string[];
  readonly label: string;
  readonly simulated: true;
}
const RUN_KIND = "simulation-run";
const RUN_ID = /^smr-[a-z2-7]{20}$/;

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
  /** The grant service, used only by `grant`: the owner's separate step after a simulation. Without it that step is unavailable; nothing else in a scope reaches it. */
  readonly grants?: Pick<GrantService, "grant">;
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

/** What an action on `ref` may change (`all`) and the neighbours it must leave alone (`guarded`), as the stand-in's world stands. */
async function reachOf(sim: SimulatedServices, ref: ServiceRef, action: ServiceAction): Promise<{ all: readonly ServiceRef[]; guarded: readonly ServiceRef[] }> {
  const reach = await sim.affects(ref, action);
  const all = reach.some((r) => r.service === ref.service && r.resource === ref.resource) ? reach : [ref, ...reach];
  const guarded = (await sim.neighbours(ref)).filter((n) => !all.some((a) => a.service === n.service && a.resource === n.resource));
  return { all, guarded };
}

/** The stand-in's faults for one injected failure (a leak goes into the first guarded neighbour; with none there is nothing to leak into). */
function faultsFor(inject: SimulationInject, guarded: readonly ServiceRef[]): SimulatedFaults {
  switch (inject) {
    case "refuse": return { refuseNext: "the simulated service refused the action (injected)" };
    case "lose-answer": return { loseNextAnswer: true };
    case "corrupt": return { corruptNext: true };
    case "leak": return guarded[0] === undefined ? {} : { leakInto: guarded[0] };
  }
}

/**
 * The scope's stand-in as the effect bridge sees it: every apply that reaches it (or might have, when its answer is lost) is saved to the scope's record before the
 * bridge goes on, so what the ledger later settles is what the record holds.
 */
export class ScopeWorld implements ServiceTarget {
  /** Set when an apply could not be saved to the scope's record: the in-memory stand-in then holds a change the record does not, so it answers nothing more (review: a lost save never reads as confirmed). */
  #unsaved: unknown;
  /** `expect`: the version of one resource the writer read (a workflow run's agent): a change to it is refused, nothing written, when another writer changed it since (a competing edit). */
  constructor(readonly inner: SimulatedServices, private readonly save: () => Promise<void>, private readonly expect?: { readonly ref: ServiceRef; readonly version: string }) {}
  #check(): void { if (this.#unsaved !== undefined) throw new Error(`the simulation scope's record could not be saved, so the stand-in's answer is not trusted (${this.#unsaved instanceof Error ? this.#unsaved.message : String(this.#unsaved)})`); }
  async observe(ref: ServiceRef) { this.#check(); return this.inner.observe(ref); }
  affects(ref: ServiceRef, action: ServiceAction) { return this.inner.affects(ref, action); }
  neighbours(ref: ServiceRef) { return this.inner.neighbours(ref); }
  async applied(key: string) { this.#check(); return this.inner.applied(key); }
  verify(ref: ServiceRef, action: ServiceAction, before: Observation, after: Observation) { return this.inner.verify(ref, action, before, after); }
  async apply(key: string, ref: ServiceRef, action: ServiceAction, context?: JsonObject): Promise<void> {
    if (this.expect !== undefined && !(await this.inner.applied(key))) {
      const now = (await this.inner.observe(this.expect.ref))?.systemVersion ?? "absent";
      if (now !== this.expect.version) throw new EffectRejected(`another writer changed ${refKey(this.expect.ref)} after the agent read it (${this.expect.version} then, ${now} now); nothing was changed`, { competingEdit: true, saw: this.expect.version, found: now });
    }
    try { await this.inner.apply(key, ref, action, context); } finally {
      try { await this.save(); } catch (error) { this.#unsaved = error; throw error; }
    }
  }
}

/** Room kept in a scope's record for what is added after the size check (the effect's ID, the closing time). */
const BODY_RESERVE = 1024;
/** Throws `invalid_command` when a scope's record holding `body` would not fit the store (size or depth), so nothing is recorded or done that the record could not keep. */
function fits(body: SimulationScopeBody, what: string): void {
  let size: number;
  try { checkBody(body, "scope"); size = Buffer.byteLength(canonicalJson(body as unknown as JsonObject), "utf8"); } catch { size = Number.POSITIVE_INFINITY; }
  if (size > LIMITS.bodyBytes - BODY_RESERVE) throw new DomainError("invalid_command", `${what}: a simulation scope keeps its whole stand-in in one record of at most ${LIMITS.bodyBytes - BODY_RESERVE} bytes (nested at most ${LIMITS.bodyDepth} deep), and this would not fit; use smaller states or open another scope`, { field: what });
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
    fits(body, "layout");
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
        if (known.simulation !== scopeId || known.kind !== "service-op" || was["service"] !== ref.service || was["resource"] !== ref.resource || canonicalJson(was["action"] as JsonObject) !== canonicalJson(action as unknown as JsonObject) || was["inject"] !== command.inject) throw new DomainError("command_conflict", `command ID ${commandId} was already used for a different operation`);
        const now = await this.#scope(scopeId);
        // A closed scope runs nothing more: an operation it had not finished is only reported as the ledger has it.
        if (now.body.state !== "open") return this.#result(scopeId, effectId, { status: known.status, ...(known.evidence === undefined ? {} : { evidence: known.evidence }), ...(known.status === "confirmed" || known.status === "failed" ? {} : { note: "the simulation scope is closed, so this operation is not run further" }) });
        await this.#listEffect(scopeId, effectId);
        const world = (await this.#scope(scopeId)).body.world;
        // An operation recorded and never started (the process stopped in between) runs now as it was asked, with its injected failure armed (follow-up to the second
        // review). One that started is only finished: the fault was spent on its first run, and arming it again would misreport what the stand-in did.
        let resumeFaults: SimulatedFaults = {};
        if (known.status === "intended" && known.started === false && command.inject !== undefined) {
          const { guarded } = await reachOf(SimulatedServices.fromSnapshot(world, () => this.#runner.now()), ref, action);
          resumeFaults = faultsFor(command.inject as SimulationInject, guarded);
        }
        return this.#result(scopeId, effectId, await this.#ports.effects.run(effectId, this.#bridge(scopeId, world, resumeFaults)));
      }
      const s = await this.#scope(scopeId);
      if (s.body.state !== "open") throw new DomainError("invalid_command", "the simulation scope is closed");
      if (s.body.effects.length >= SIMULATION_SCOPE_LIMITS.operations) throw new DomainError("invalid_command", `a simulation scope holds at most ${SIMULATION_SCOPE_LIMITS.operations} operations; open another`);
      const sim = SimulatedServices.fromSnapshot(s.body.world, () => this.#runner.now());
      const before = await sim.observe(ref);
      if (before === undefined) throw new DomainError("not_found", `${refKey(ref)} is not in this simulation scope`);
      const { all, guarded } = await reachOf(sim, ref, action);
      const baseline: Record<string, string> = {};
      for (const n of guarded) baseline[refKey(n)] = (await sim.observe(n))?.systemVersion ?? "absent";
      const input: JsonObject = {
        service: ref.service, resource: ref.resource, action: action as unknown as JsonObject, allowed: all.map((r) => ({ service: r.service, resource: r.resource })),
        before: before as unknown as JsonObject, baseline: baseline as unknown as JsonObject, ...(command.inject === undefined ? {} : { inject: command.inject }),
      };
      // The world after the change must fit the scope's record, or the change could be done on the stand-in and not kept: tried first on a copy (worst case of an injected fault).
      const trial = SimulatedServices.fromSnapshot(s.body.world, () => this.#runner.now());
      if (command.inject === "leak" || command.inject === "corrupt") Object.assign(trial.faults, faultsFor(command.inject, guarded));
      try { await trial.apply(effectId, ref, action, { baseline: baseline as unknown as JsonObject }); } catch { /* refused on the copy: it will be refused (and change nothing) for real too */ }
      fits({ ...s.body, world: trial.snapshot(), effects: [...s.body.effects, effectId] }, "action");
      await this.#ports.effects.intend({ commandId: intentId, actor: by.id, kind: "service-op", target: `simulation:${scopeId}/service:${refKey(ref)}`, input, taskId: s.body.taskId, simulation: scopeId });
      await this.#listEffect(scopeId, effectId);
      const faults = command.inject === undefined ? {} : faultsFor(command.inject as SimulationInject, guarded);
      return this.#result(scopeId, effectId, await this.#ports.effects.run(effectId, this.#bridge(scopeId, (await this.#scope(scopeId)).body.world, faults)));
    });
  }

  /** The scope's simulated bridge: the service-operation bridge over the scope's stand-in, marked simulated so the ledger lets it run the scope's effects (and only them). */
  #bridge(scopeId: string, world: SimulatedSnapshot, faults: SimulatedFaults = {}, expect?: { ref: ServiceRef; version: string }): EffectBridge {
    const sim = SimulatedServices.fromSnapshot(world, () => this.#runner.now());
    Object.assign(sim.faults, faults);
    const target = new ScopeWorld(sim, () => this.#saveWorld(scopeId, sim.snapshot()), expect);
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
  // ---- Workflow runs (card P07, the run part) ----

  /**
   * Owner only. Runs a scripted workflow in an open scope (see `workflow.ts`): each agent step reads its resource, asks a stand-in model through the real R02 fallback (each attempt an effect
   * of the scope, kind `model-call`, answered by the stand-in provider) and does its tool call on the scope's stand-in (an effect of the scope, kind `service-op`, refused when another writer
   * changed the resource since the agent read it). A `provider-failure` event makes the next calls to a stand-in route fail as a real provider would; a `competing-edit` event makes another
   * writer change a resource while the next agent works. A competing edit on fields the agent also writes is a conflict left to the owner; otherwise the agent reads again and does it once
   * more. When no stand-in provider is left the run stops and the later steps are not reached. Every effect is the ledger's, marked with the scope, so nothing real is written, sent or
   * spent; every result is labelled simulated. Repeating the command returns the run; a run stopped by a crash part-way goes on from the first step it had not recorded (each effect has a
   * fixed ID, so a step done before the crash is not done twice).
   */
  async run(by: Principal, command: { commandId: string; scopeId: string; steps: unknown; providers?: unknown }): Promise<{ id: string; replayed: boolean; run: SimulationRunBody }> {
    onlyKnown(command, ["commandId", "scopeId", "steps", "providers"]);
    const commandId = checkCommandId(command.commandId);
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner may use a simulation scope");
    const script = checkScript({ steps: command.steps, ...(command.providers === undefined ? {} : { providers: command.providers }) });
    const first = await this.#scope(command.scopeId);
    this.#owner(by, first.body.taskId);
    const scopeId = first.id;
    for (const s of script.steps) if (s.kind !== "provider-failure" && first.body.world.cells[`${s.service}/${s.resource}`] === undefined) throw new DomainError("not_found", `${s.service}/${s.resource} is not in this simulation scope`);
    const scoped = scopedCommandId(by.id, commandId);
    const runId = derivedId("smr", scoped);
    return this.#serial(scopeId, async () => {
      const s = await this.#scope(scopeId);
      const known = await this.#runner.get(RUN_KIND, runId);
      if (known === undefined) {
        if (s.body.state !== "open") throw new DomainError("invalid_command", "the simulation scope is closed");
        if ((s.body.runs ?? []).length >= RUN_LIMITS.runsPerScope) throw new DomainError("invalid_command", `a simulation scope holds at most ${RUN_LIMITS.runsPerScope} runs; open another`);
      }
      const body: SimulationRunBody = { scopeId, taskId: s.body.taskId, projectId: s.body.projectId, by: by.id, startedAt: this.#runner.now(), providers: script.providers, script: script.steps, state: "running", results: [], armed: [], effects: [], label: SIMULATION_SCOPE_LABEL, simulated: true };
      const runRef: AggregateRef = { kind: RUN_KIND, id: runId };
      const scopeRef: AggregateRef = { kind: KIND, id: scopeId };
      const r = await this.#runner.command("simulation.run", { commandId: scoped, actor: by.id }, async () => ({
        payload: { scopeId, steps: script.steps as unknown as JsonObject[], providers: script.providers },
        build: async () => {
          const now = await this.#scope(scopeId);
          return { ref: runRef, creates: true, changes: [{ type: "create" as const, ref: runRef, body: JSON.parse(JSON.stringify(body)) as JsonObject }, { type: "update" as const, ref: scopeRef, expectedRevision: now.revision, body: { ...(now.body as unknown as JsonObject), runs: [...(now.body.runs ?? []), runId] } }], detail: { scopeId, steps: script.steps.length, simulated: true } };
        },
      }));
      await this.#continueRun(runId);
      return { id: runId, replayed: r.replayed, run: (await this.#run(runId)).body };
    });
  }

  async #run(runId: string): Promise<{ revision: number; body: SimulationRunBody }> {
    const found = await this.#runner.get(RUN_KIND, runId);
    if (found === undefined) throw new DomainError("not_found", "no such simulation run");
    return { revision: found.revision, body: found.body as unknown as SimulationRunBody };
  }

  /** Owner only. One run of a scope, as recorded, labelled simulated. Read only. */
  async getRun(by: Principal, runId: string): Promise<{ id: string; run: SimulationRunBody }> {
    if (by.kind !== "owner" || typeof runId !== "string" || !RUN_ID.test(runId)) throw new DomainError("not_found", "no such simulation run");
    const r = await this.#run(runId);
    this.#owner(by, r.body.taskId);
    return { id: runId, run: r.body };
  }

  /** Writes the next result of a run (and, with the last one, its outcome). Each write is its own command keyed by the run and the step, so a repeat writes it once. */
  async #record(runId: string, result: RunStepResult, armed: SimulationRunBody["armed"], effects: readonly string[], finish?: RunOutcome): Promise<void> {
    const r = await this.#run(runId);
    if (r.body.results.length !== result.index) return;
    const ref: AggregateRef = { kind: RUN_KIND, id: runId };
    const next: SimulationRunBody = { ...r.body, results: [...r.body.results, result], armed, effects: [...new Set([...r.body.effects, ...effects])], ...(finish === undefined ? {} : { state: "finished" as const, outcome: finish, finishedAt: this.#runner.now() }) };
    await this.#runner.command("simulation.run.step", { commandId: `smrstep:${runId}:${result.index}`, actor: "simulation" }, async () => ({
      payload: { runId, index: result.index },
      build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: r.revision, body: JSON.parse(JSON.stringify(next)) as JsonObject }], detail: { runId, index: result.index, outcome: result.outcome, simulated: true } }),
    }));
  }

  async #continueRun(runId: string): Promise<void> {
    let router: ScratchRouter | undefined;
    for (;;) {
      const { body } = await this.#run(runId);
      if (body.state === "finished") return;
      const index = body.results.length;
      const scope = await this.#scope(body.scopeId);
      if (scope.body.state !== "open") {
        // A scope closed while a run was part-way: nothing more runs; the rest is recorded as not reached.
        for (let i = index; i < body.script.length; i++) await this.#record(runId, { index: i, kind: body.script[i]!.kind, outcome: "not-reached", words: "not reached: the simulation scope was closed", simulated: true }, body.armed, [], i === body.script.length - 1 ? "stopped" : undefined);
        return;
      }
      // Second review: a run a step stopped goes no further, also when the process stopped before the later steps were recorded `not reached` (a resend would otherwise run them and the run
      // could end `completed`).
      if (body.results.some((x) => x.outcome === "stopped")) {
        for (let i = index; i < body.script.length; i++) await this.#record(runId, { index: i, kind: body.script[i]!.kind, outcome: "not-reached", words: "not reached: the run stopped earlier", simulated: true }, body.armed, [], i === body.script.length - 1 ? "stopped" : undefined);
        return;
      }
      const step = body.script[index]!;
      const last = index === body.script.length - 1;
      const outcomeSoFar = (extra: RunStepResult): RunOutcome => { const all = [...body.results, extra]; return all.some((x) => x.outcome === "stopped" || x.outcome === "not-reached") ? "stopped" : all.some((x) => x.outcome === "conflict" || x.outcome === "failed") ? "completed-with-problems" : "completed"; };
      if (step.kind === "provider-failure") {
        const result: RunStepResult = { index, kind: step.kind, outcome: "armed", target: step.route, words: `the next ${step.times === 1 ? "call" : `${step.times} calls`} to the stand-in provider ${step.route} fail${step.times === 1 ? "s" : ""} with ${step.failure} (injected)`, simulated: true };
        await this.#record(runId, result, [...body.armed, { route: step.route, failure: step.failure, left: step.times }], [], last ? outcomeSoFar(result) : undefined);
        continue;
      }
      if (step.kind === "competing-edit") {
        const result: RunStepResult = { index, kind: step.kind, outcome: "armed", target: `${step.service}/${step.resource}`, words: `another writer changes ${step.service}/${step.resource} while the next agent works on it (injected)`, simulated: true };
        await this.#record(runId, result, body.armed, [], undefined);
        continue;
      }
      router ??= await ScratchRouter.open(body.providers, body.startedAt);
      const { result, armed, effects } = await this.#agentStep(runId, body, index, step, router);
      if (result.outcome === "stopped") {
        await this.#record(runId, result, armed, effects, last ? "stopped" : undefined);
        for (let i = index + 1; i < body.script.length; i++) await this.#record(runId, { index: i, kind: body.script[i]!.kind, outcome: "not-reached", words: "not reached: the run stopped earlier", simulated: true }, armed, [], i === body.script.length - 1 ? "stopped" : undefined);
        return;
      }
      await this.#record(runId, result, armed, effects, last ? outcomeSoFar(result) : undefined);
    }
  }

  /** The competing edit armed for the agent step at `index`, if the step just before it (past armed provider failures) is one. */
  #editFor(script: readonly RunStep[], index: number): Extract<RunStep, { kind: "competing-edit" }> | undefined {
    for (let i = index - 1; i >= 0; i--) {
      const s = script[i]!;
      if (s.kind === "provider-failure") continue;
      return s.kind === "competing-edit" ? s : undefined;
    }
    return undefined;
  }

  async #agentStep(runId: string, body: SimulationRunBody, index: number, step: Extract<RunStep, { kind: "agent" }>, router: ScratchRouter): Promise<{ result: RunStepResult; armed: SimulationRunBody["armed"]; effects: string[] }> {
    const ref: ServiceRef = { service: step.service, resource: step.resource };
    const target = refKey(ref);
    const effects: string[] = [];
    const armed = body.armed.map((a) => ({ ...a }));
    const key = `simrun:${runId}:s${index}`;
    // 1. The agent reads the resource (kept with its tool call, so a rerun after a crash uses what it read then).
    const toolId = derivedId("eff", `${key}:tool`);
    const toolKnown = await this.#ports.effects.get(toolId);
    let saw = typeof toolKnown?.input["expect"] === "string" ? toolKnown.input["expect"] as string : (await SimulatedServices.fromSnapshot((await this.#scope(body.scopeId)).body.world, () => this.#runner.now()).observe(ref))?.systemVersion;
    if (saw === undefined) return { result: { index, kind: "agent", agent: step.agent, target, outcome: "failed", words: `${target} is not in the scope`, simulated: true }, armed, effects };
    // Second review: what the agent read is also kept with each of its model calls. A crash after the competing edit and before the tool call was recorded would otherwise make the rerun read
    // the resource again, after the other writer's change: the edit would go unseen and the agent would write over it, and the run could end `completed` (which the grant step relies on).
    const sawRecorded = toolKnown !== undefined;
    // 2. It asks a model: the real R02 fallback over the stand-in routes decides each attempt; each attempt is an effect of the scope answered by the stand-in provider.
    const attempts: { route: string; effectId: string; outcome: "answered" | "failed"; failure?: string }[] = [];
    let at = await router.begin(key);
    for (;;) {
      if (at.kind !== "route") {
        const why = at.kind === "wait" ? `${at.reason}${at.why.length === 0 ? "" : ` (${at.why.join("; ")})`}` : at.reason;
        return { result: { index, kind: "agent", agent: step.agent, target, outcome: "stopped", attempts, fallback: attempts.length > 1, saw, words: `${step.agent} got no answer from any stand-in provider, so the run stopped here: ${why}`.slice(0, 600), simulated: true }, armed, effects };
      }
      const intentId = `${key}:a${at.attempt}`;
      const effectId = derivedId("eff", intentId);
      const known = await this.#ports.effects.get(effectId);
      if (!sawRecorded && typeof known?.input["saw"] === "string") saw = known.input["saw"] as string;
      const route = at.route;
      const slot = armed.find((a) => a.route === route && a.left > 0);
      const failure = known !== undefined ? (typeof known.input["failure"] === "string" ? known.input["failure"] as ProviderFailure : undefined) : slot?.failure;
      if (failure !== undefined && slot !== undefined) slot.left -= 1;
      if (known === undefined) await this.#ports.effects.intend({ commandId: intentId, actor: `simulation:${step.agent}`, kind: "model-call", target: `simulation:${body.scopeId}/provider:${at.route}`, input: { agent: step.agent, route: at.route, step: index, attempt: at.attempt, costMicros: 0, saw, ...(failure === undefined ? {} : { failure }) }, taskId: body.taskId, simulation: body.scopeId });
      effects.push(effectId);
      const out = await this.#ports.effects.run(effectId, providerBridge());
      if (out.status === "confirmed") { attempts.push({ route: at.route, effectId, outcome: "answered" }); await router.succeeded(key, at.callId, at.attempt); break; }
      attempts.push({ route: at.route, effectId, outcome: "failed", ...(failure === undefined ? {} : { failure }) });
      at = await router.failed(key, at.callId, at.attempt, failure ?? "outage");
    }
    const answeredBy = attempts.at(-1)!.route;
    const fallback = attempts.length > 1;
    const asked = fallback ? `${step.agent} asked ${attempts.slice(0, -1).map((a) => `${a.route} (${a.failure ?? "failed"})`).join(", ")}, then the fallback ${answeredBy} answered` : `${step.agent} asked ${answeredBy}, which answered`;
    // 3. Another writer changes the resource while the agent works (a competing edit armed by the event before this step).
    const edit = this.#editFor(body.script, index);
    let editResult: { effectId: string; status: string } | undefined;
    if (edit !== undefined) {
      const o = await this.#serviceOp(body, `${key}:edit`, "simulation:other-writer", { service: edit.service, resource: edit.resource }, { type: "set", params: { fields: edit.fields } });
      if (o.recorded !== false) effects.push(o.effectId);
      editResult = { effectId: o.effectId, status: o.status };
    }
    // 4. The tool call, judged against the version the agent read.
    const tool = await this.#serviceOp(body, `${key}:tool`, `simulation:${step.agent}`, ref, step.action, saw);
    if (tool.recorded !== false) effects.push(tool.effectId);
    const base = { index, kind: "agent" as const, agent: step.agent, target, attempts, fallback, saw, tool: { effectId: tool.effectId, status: tool.status }, ...(editResult === undefined ? {} : { edit: editResult }), simulated: true as const };
    if (tool.status === "confirmed") return { result: { ...base, outcome: "done", words: `${asked}; ${step.agent} did ${step.action.type} on ${target} (simulated)` }, armed, effects };
    if (tool.evidence?.["competingEdit"] !== true) return { result: { ...base, outcome: "failed", words: `${asked}; ${step.agent}'s ${step.action.type} on ${target} ended ${tool.status}: ${String(tool.evidence?.["reason"] ?? tool.note ?? "")}`.slice(0, 600) }, armed, effects };
    // 5. A competing edit was caught: nothing was written over it. Fields the other writer also changed are the owner's call; otherwise the agent reads again and does it once more.
    if (edit !== undefined && overlaps(step.action, edit.fields) && refKey({ service: edit.service, resource: edit.resource }) === target) {
      return { result: { ...base, outcome: "conflict", words: `${asked}; another writer changed ${target} after ${step.agent} read it, on the same fields, so nothing was written over that change; this is left for you to decide (simulated)` }, armed, effects };
    }
    const keyRetry = derivedId("eff", `${key}:retry`);
    const retryKnown = await this.#ports.effects.get(keyRetry);
    const again = typeof retryKnown?.input["expect"] === "string" ? retryKnown.input["expect"] as string : (await SimulatedServices.fromSnapshot((await this.#scope(body.scopeId)).body.world, () => this.#runner.now()).observe(ref))?.systemVersion ?? "absent";
    const retry = await this.#serviceOp(body, `${key}:retry`, `simulation:${step.agent}`, ref, step.action, again);
    if (retry.recorded !== false) effects.push(retry.effectId);
    const done = retry.status === "confirmed";
    return { result: { ...base, retry: { effectId: retry.effectId, status: retry.status }, outcome: done ? "retried" : "failed", words: `${asked}; another writer changed ${target} after ${step.agent} read it, so its first write was refused with nothing changed; it read ${target} again (${again}) and ${done ? `did ${step.action.type} on the newer version` : `its second try ended ${retry.status}`} (simulated)` }, armed, effects };
  }

  /** One service operation of a run on the scope's stand-in, through the ledger as an effect of the scope; `expect` is the version the writer read. A repeat finishes the recorded one. */
  async #serviceOp(run: SimulationRunBody, intentId: string, actor: string, ref: ServiceRef, action: ServiceAction, expect?: string): Promise<{ effectId: string; status: string; evidence?: JsonObject; note?: string; recorded?: false }> {
    const effectId = derivedId("eff", intentId);
    const known = await this.#ports.effects.get(effectId);
    if (known === undefined) {
      const s = await this.#scope(run.scopeId);
      const sim = SimulatedServices.fromSnapshot(s.body.world, () => this.#runner.now());
      const before = await sim.observe(ref);
      if (before === undefined) throw new DomainError("not_found", `${refKey(ref)} is not in this simulation scope`);
      const { all, guarded } = await reachOf(sim, ref, action);
      const baseline: Record<string, string> = {};
      for (const n of guarded) baseline[refKey(n)] = (await sim.observe(n))?.systemVersion ?? "absent";
      const trial = SimulatedServices.fromSnapshot(s.body.world, () => this.#runner.now());
      try { await trial.apply(effectId, ref, action, { baseline: baseline as unknown as JsonObject }); } catch { /* refused on the copy: refused for real too */ }
      // Review: a change that would not fit the scope's record is not done and not recorded; the step ends failed with why (a throw here would leave the run running for good).
      try { fits({ ...s.body, world: trial.snapshot() }, "steps"); } catch (error) {
        if (!isDomainError(error, "invalid_command")) throw error;
        return { effectId, status: "not-done", note: `the change would not fit the simulation scope's record, so it was not done (${error.message})`.slice(0, 400), recorded: false };
      }
      const input: JsonObject = { service: ref.service, resource: ref.resource, action: action as unknown as JsonObject, allowed: all.map((r) => ({ service: r.service, resource: r.resource })), before: before as unknown as JsonObject, baseline: baseline as unknown as JsonObject, ...(expect === undefined ? {} : { expect }) };
      await this.#ports.effects.intend({ commandId: intentId, actor, kind: "service-op", target: `simulation:${run.scopeId}/service:${refKey(ref)}`, input, taskId: run.taskId, simulation: run.scopeId });
    }
    const world = (await this.#scope(run.scopeId)).body.world;
    const out = await this.#ports.effects.run(effectId, this.#bridge(run.scopeId, world, {}, expect === undefined ? undefined : { ref, version: expect }));
    return { effectId, status: out.status, ...(out.evidence === undefined ? {} : { evidence: out.evidence }), ...(out.note === undefined ? {} : { note: out.note }) };
  }

  // ---- The owner's separate grant of real access after a simulation ----

  /**
   * Owner only, a separate step after a simulation: grants an agent the real access the scope's completed run used, through the grant service (`effect.perform` on each service resource
   * the run changed, narrowed to that one resource, in the scope's project). The scope never grants anything by itself: opening, operating, running and closing reach no grant. A run that
   * stopped or met a conflict or failure grants nothing (simulate again first, or use grant.create). Repeating the command grants once.
   */
  async grant(by: Principal, command: { commandId: string; scopeId: string; grantee: string; basis: string; runId?: string }): Promise<{ scopeId: string; runId: string; grants: { id: string; action: string; project: string; resource: string; replayed: boolean }[]; note: string }> {
    onlyKnown(command, ["commandId", "scopeId", "grantee", "basis", "runId"]);
    const commandId = checkCommandId(command.commandId);
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner grants real access");
    if (this.#ports.grants === undefined) throw new DomainError("unavailable", "granting is not available here");
    const s = await this.#scope(command.scopeId);
    this.#owner(by, s.body.taskId);
    const runs = s.body.runs ?? [];
    if (command.runId !== undefined && !runs.includes(command.runId)) throw new DomainError("not_found", "that run is not a run of this simulation scope");
    const runId = command.runId ?? runs.at(-1);
    if (runId === undefined) throw new DomainError("invalid_transition", "this simulation scope has no run yet; real access is granted after a simulation (simulation.run) has completed");
    const run = (await this.#run(runId)).body;
    // Second review: every step is checked as recorded too, not only the run's outcome: a run whose steps did not all finish cleanly shows nothing a grant could rest on.
    const clean = run.results.length === run.script.length && run.results.every((x) => x.outcome === "armed" || x.outcome === "done" || x.outcome === "retried");
    if (run.state !== "finished" || run.outcome !== "completed" || !clean) throw new DomainError("invalid_transition", `the run ${runId} ${run.state !== "finished" ? "has not finished" : run.outcome !== "completed" ? `ended ${run.outcome}` : "has a step that did not finish cleanly"}, so it does not show the work can be done; nothing was granted (run the simulation again, or grant with grant.create)`);
    const resources = [...new Set(run.results.filter((r) => r.kind === "agent" && (r.outcome === "done" || r.outcome === "retried") && r.target !== undefined).map((r) => r.target!))];
    if (resources.length === 0) throw new DomainError("invalid_transition", "the run changed no service resource, so there is no access to grant");
    const grants: { id: string; action: string; project: string; resource: string; replayed: boolean }[] = [];
    for (const [k, resource] of resources.entries()) {
      // Review: the grant's own command ID is derived from the whole command ID (a cut prefix could make two different commands one grant, or a conflict).
      const g = await this.#ports.grants.grant(by, { commandId: `simgrant:${derivedId("grt", commandId).slice(4)}:${k}`, grantee: command.grantee, action: "effect.perform", project: s.body.projectId, resource: { kind: "service", id: resource }, source: "direct", basis: command.basis });
      grants.push({ id: g.id, action: "effect.perform", project: s.body.projectId, resource, replayed: g.replayed });
    }
    await this.#serial(s.id, async () => {
      const now = await this.#scope(s.id);
      const noted = now.body.grants ?? [];
      const fresh = grants.filter((g) => !noted.some((n) => n.grantId === g.id)).map((g) => ({ grantId: g.id, grantee: command.grantee, action: g.action, resource: g.resource, runId, at: this.#runner.now() }));
      if (fresh.length === 0) return;
      const ref: AggregateRef = { kind: KIND, id: s.id };
      await this.#runner.command("simulation.grant.note", { commandId: `simgrant:${s.id}:${now.revision}`, actor: "simulation" }, async () => ({
        payload: { scopeId: s.id, grants: fresh.map((g) => g.grantId) },
        build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: now.revision, body: { ...(now.body as unknown as JsonObject), grants: [...noted, ...fresh].slice(-RUN_LIMITS.grantsPerScope) as unknown as JsonObject[] } }], detail: { grants: fresh.length } }),
      }));
    });
    return { scopeId: s.id, runId, grants, note: "Real access, granted by you after the simulation through the grant service; the simulation scope itself grants nothing." };
  }

  // ---- What the owner reads in chat ----

  /** Owner only. The newest scopes (of one task, or all), each with its runs, the real access granted after it and its replay reruns. Read only. */
  async list(by: Principal, query: { taskId?: string; limit?: number } = {}): Promise<{ scopes: { id: string; scope: SimulationScopeBody; runs: { id: string; run: SimulationRunBody }[] }[]; truncated: boolean }> {
    if (by.kind !== "owner") throw new DomainError("not_found", "no such simulation scope");
    const taskId = query.taskId === undefined ? undefined : checkTaskId(query.taskId);
    if (by.taskScope !== undefined && taskId !== by.taskScope.taskId) throw new DomainError("forbidden", "a credential confined to a task may read the simulation scopes of that task only");
    if (query.limit !== undefined && !(typeof query.limit === "number" && Number.isSafeInteger(query.limit) && query.limit >= 1 && query.limit <= 20)) invalid("limit", "must be a whole number from 1 to 20");
    const limit = query.limit ?? 5;
    const all: { id: string; scope: SimulationScopeBody }[] = [];
    let scanned = 0;
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) { after = a.id; const b = a.body as unknown as SimulationScopeBody; if (taskId === undefined || b.taskId === taskId) all.push({ id: a.id, scope: b }); }
      scanned += page.length;
      if (page.length < 200 || scanned >= 2000) break;
    }
    all.sort((x, y) => (x.scope.openedAt < y.scope.openedAt ? 1 : x.scope.openedAt > y.scope.openedAt ? -1 : x.id < y.id ? 1 : -1));
    const out = [];
    for (const s of all.slice(0, limit)) {
      const runs = [];
      for (const runId of (s.scope.runs ?? []).slice(-3)) { const r = await this.#runner.get(RUN_KIND, runId); if (r !== undefined) runs.push({ id: runId, run: r.body as unknown as SimulationRunBody }); }
      out.push({ ...s, runs });
    }
    return { scopes: out, truncated: all.length > limit || scanned >= 2000 };
  }

  // ---- Replay reruns use the task's own scope (card U09b tied to P07) ----

  /** The scope a replay rerun of `taskId` is recorded in: the one the owner names (open, of that task), or the task's own replay scope, opened the first time and the same one every time after. */
  async replayScope(by: Principal, taskId: string, scopeId?: string): Promise<string> {
    this.#owner(by, taskId);
    if (scopeId !== undefined) {
      const s = await this.#scope(scopeId);
      if (s.body.taskId !== taskId) throw new DomainError("invalid_command", "scopeId: that simulation scope belongs to another task");
      if (s.body.state !== "open") throw new DomainError("invalid_command", "scopeId: that simulation scope is closed");
      return s.id;
    }
    const opened = await this.open(by, { commandId: `replay-scope:${taskId}`, taskId, layout: { replay: { steps: { state: {} } } }, purpose: "replay reruns of this task" });
    if (opened.scope.state !== "open") throw new DomainError("invalid_command", "this task's replay simulation scope is closed; name another open scope of the task (scopeId)");
    return opened.id;
  }

  /** Notes a replay rerun in the scope it ran in (once). */
  async noteReplay(scopeId: string, simulationId: string): Promise<void> {
    await this.#serial(scopeId, async () => {
      const s = await this.#scope(scopeId);
      const list = s.body.replays ?? [];
      if (list.includes(simulationId)) return;
      const ref: AggregateRef = { kind: KIND, id: scopeId };
      await this.#runner.command("simulation.replay.note", { commandId: `simreplay:${scopeId}:${simulationId}`, actor: "simulation" }, async () => ({
        payload: { scopeId, simulationId },
        build: async () => ({ ref, creates: false, changes: [{ type: "update" as const, ref, expectedRevision: s.revision, body: { ...(s.body as unknown as JsonObject), replays: [...list, simulationId].slice(-RUN_LIMITS.replaysPerScope) } }], detail: { simulationId } }),
      }));
    });
  }

  // ---- The start-up reconciler ----

  /**
   * The simulated bridge for an effect of a scope that a crash left started and unsettled, for the start-up reconciler: a service operation gets the scope's stand-in (judged against the version
   * its writer read, when it had one), a model call the stand-in provider. Anything else, or a real effect, gets none (the reconciler then leaves it, as before).
   */
  async bridgeFor(effectId: string, body: Pick<EffectBody, "kind" | "simulation" | "input">): Promise<EffectBridge | undefined> {
    void effectId;
    if (body.simulation === undefined) return undefined;
    if (body.kind === "model-call") return providerBridge();
    if (body.kind !== "service-op") return undefined;
    const s = await this.#scope(body.simulation).catch(() => undefined);
    if (s === undefined) return undefined;
    const expect = typeof body.input["expect"] === "string" && typeof body.input["service"] === "string" && typeof body.input["resource"] === "string" ? { ref: { service: body.input["service"], resource: body.input["resource"] }, version: body.input["expect"] } : undefined;
    // Review: the reconciler also runs on the dispatcher's ticks, beside the scope's own commands. Each call takes the scope's turn and works on the world as it is then, so its save never
    // writes an older world over a change made in between.
    const fresh = async (): Promise<EffectBridge> => this.#bridge(s.id, (await this.#scope(s.id)).body.world, {}, expect);
    return {
      idempotent: true,
      simulated: true,
      execute: (req) => this.#serial(s.id, async () => (await fresh()).execute(req)),
      reconcile: (req) => this.#serial(s.id, async () => (await fresh()).reconcile!(req)),
    };
  }
}

