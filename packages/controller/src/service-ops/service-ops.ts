import { DomainError } from "../domain/errors.js";
import { EffectRejected, type EffectBridge, type EffectOutcome, type EffectRequest, type EffectService, type Reconciliation } from "../domain/effects.js";
import type { Fence } from "../domain/assignment-model.js";
import { derivedId } from "../domain/ids.js";
import { commandId as checkCommandId, taskId as checkTaskId, onlyKnown, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";
import { sha256, canonicalJson } from "../storage/json.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { Observation, ServiceAction, ServiceRef, ServiceTarget } from "./target.js";

const NAME = /^[a-z][a-z0-9._-]{0,63}$/;
const ACTION = /^[a-z][a-z0-9-]{0,39}$/;
const refKey = (r: ServiceRef): string => `${r.service}/${r.resource}`;
const same = (a: ServiceRef, b: ServiceRef): boolean => a.service === b.service && a.resource === b.resource;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v);
/** The resource a grant names (`kind: service`, `id: <service>/<resource>`): a repair is granted per resource. */
export const serviceResource = (r: ServiceRef): { kind: string; id: string } => ({ kind: "service", id: refKey(r) });

export interface Outcome { readonly reference: string; readonly systemVersion: string; readonly observedAt: string }

export interface OperateCommand {
  readonly commandId: string;
  readonly taskId: string;
  readonly service: string;
  readonly resource: string;
  readonly action: ServiceAction;
}
export interface OperateResult {
  readonly effectId: string;
  /** `confirmed`: applied AND read back from the target as intended. `failed`: refused, nothing changed. `uncertain`: applied or maybe applied, but not verified: a person decides. `pending`: asking the target again is safe. */
  readonly status: EffectOutcome["status"];
  /** Present when confirmed: the three facts a deliverable of type operational-outcome names. */
  readonly outcome?: Outcome;
  readonly evidence?: JsonObject;
  readonly note?: string;
}

export interface ServiceOpsPorts {
  readonly effects: Pick<EffectService, "intend" | "run" | "get">;
  /** The outside system. Absent: operations are unavailable (nothing is done, nothing is recorded). */
  readonly target?: ServiceTarget;
  /** The fence of the task's current attempt when `agentId` is the agent that owns it; `undefined` when it is not. */
  readonly fenceOf: (taskId: string, agentId: string) => Promise<Fence | undefined>;
}

/** Everything the adapter records about a collateral check: versions of resources the action was not supposed to touch. */
type Versions = Record<string, string>;

async function versionsOf(target: ServiceTarget, refs: readonly ServiceRef[]): Promise<Versions> {
  const out: Versions = {};
  for (const r of refs) { const o = await target.observe(r); out[refKey(r)] = o === undefined ? "absent" : o.systemVersion; }
  return out;
}
const drift = (a: Versions, b: Versions): string[] => Object.keys(a).filter((k) => a[k] !== b[k]);

function parseInput(input: JsonObject): { ref: ServiceRef; action: ServiceAction; allowed: ServiceRef[]; before: Observation; baseline: Versions } {
  const refs = (v: unknown): ServiceRef[] => (Array.isArray(v) ? v : []).map((x) => ({ service: String((x as JsonObject)["service"]), resource: String((x as JsonObject)["resource"]) }));
  const action = input["action"] as JsonObject;
  return {
    ref: { service: String(input["service"]), resource: String(input["resource"]) },
    action: { type: String(action["type"]), ...(isObject(action["params"]) ? { params: action["params"] } : {}) },
    allowed: refs(input["allowed"]), before: input["before"] as unknown as Observation, baseline: input["baseline"] as unknown as Versions,
  };
}

/**
 * The bridge that performs a service operation (card P03). It adds to the target's own answer what the ledger needs to call an effect verified: the resource is read back from the target
 * and judged, and the versions of the neighbours that were not in scope are compared before and after. A change that cannot be verified, or that leaked outside the scope, is NOT confirmed:
 * the effect ends `uncertain` (never retried blindly) with the facts in its evidence, so a person decides.
 */
export function operationBridge(target: ServiceTarget): EffectBridge {
  const finish = async (req: EffectRequest, fresh: { before: Observation; baseline: Versions } | undefined): Promise<Reconciliation | JsonObject> => {
    const i = parseInput(req.input);
    const before = fresh?.before ?? i.before;
    const after = await target.observe(i.ref);
    if (after === undefined) return { state: "unknown", evidence: { reason: `${refKey(i.ref)} cannot be read back after the change` } } as Reconciliation;
    const problem = target.verify(i.ref, i.action, before, after);
    const guarded = (await target.neighbours(i.ref)).filter((n) => !i.allowed.some((a) => same(a, n)));
    const moved = drift(fresh?.baseline ?? i.baseline, await versionsOf(target, guarded));
    const evidence: JsonObject = { service: i.ref.service, resource: i.ref.resource, action: i.action.type, target: refKey(i.ref), systemVersion: after.systemVersion, observedAt: after.observedAt, stateDigest: sha256(canonicalJson(after.state)), affected: i.allowed.map(refKey), collateralChecked: guarded.length };
    if (problem !== undefined || moved.length > 0) return { state: "unknown", evidence: { ...evidence, verified: false, ...(problem === undefined ? {} : { problem }), ...(moved.length === 0 ? {} : { collateralMoved: moved }), reason: problem ?? `resources outside the scope changed: ${moved.join(", ")}` } } as Reconciliation;
    return { ...evidence, verified: true, collateralUnchanged: true };
  };
  return {
    idempotent: true,
    async execute(req) {
      const i = parseInput(req.input);
      const reach = await target.affects(i.ref, i.action);
      const outside = reach.filter((r) => !i.allowed.some((a) => same(a, r)));
      if (outside.length > 0) throw new EffectRejected(`the action also changes ${outside.map(refKey).join(", ")}, which the scope does not cover; nothing was changed`, { outside: outside.map(refKey) });
      const before = await target.observe(i.ref);
      if (before === undefined) throw new EffectRejected(`${refKey(i.ref)} does not exist; nothing was changed`);
      const guarded = (await target.neighbours(i.ref)).filter((n) => !i.allowed.some((a) => same(a, n)));
      const baseline = await versionsOf(target, guarded);
      await target.apply(req.key, i.ref, i.action);
      const result = await finish(req, { before, baseline });
      if ((result as JsonObject)["verified"] !== true) throw new Error(`the change to ${refKey(i.ref)} could not be verified: ${String(((result as Reconciliation).evidence ?? {})["reason"])}`);
      return result as JsonObject;
    },
    async reconcile(req): Promise<Reconciliation> {
      if (!(await target.applied(req.key))) return { state: "not_applied" };
      const result = await finish(req, undefined);
      if ((result as JsonObject)["verified"] === true) return { state: "applied", evidence: result as JsonObject };
      return result as Reconciliation;
    },
  };
}

/**
 * Operations on services, for work that is not code (card P03). An agent (or the owner) asks for ONE action on ONE resource of a service for a task:
 * 1. the scope is judged first. The target says every resource the action would change; the caller needs the right `effect.perform` on EACH of them (a grant that names a resource covers
 *    that resource only; a project-wide grant covers all). An action whose reach goes beyond the scope is refused before anything is recorded or done;
 * 2. the intent is recorded in the effect ledger (card S05) with the scope it was judged against, the state before and the versions of everything next to it, under the fence of the
 *    agent's current attempt;
 * 3. the bridge applies it once, reads the resource back, judges it, and checks that nothing outside the scope moved. Only then is the effect `confirmed`, and the outcome
 *    (the effect's ID as the verifiable reference, the system version and observation time the TARGET reported) is what a deliverable of type operational-outcome names. A deliverable
 *    naming anything else is refused (see `AcceptanceService`).
 */
export class ServiceOperations {
  readonly #runner: CommandRunner;
  readonly #ports: ServiceOpsPorts;
  private constructor(runner: CommandRunner, ports: ServiceOpsPorts) { this.#runner = runner; this.#ports = ports; }

  static withEpoch(storage: ControllerStorage, epoch: number, ports: ServiceOpsPorts, options: RunnerOptions = {}): ServiceOperations {
    return new ServiceOperations(new CommandRunner(storage, epoch, options), ports);
  }

  #target(): ServiceTarget {
    if (this.#ports.target === undefined) throw new DomainError("unavailable", "no service is connected to this controller, so no operation can be done or checked");
    return this.#ports.target;
  }

  async #task(by: Principal, taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    const hidden = (): never => { throw new DomainError("not_found", "no such task"); };
    if (task === undefined) return hidden();
    if (by.kind !== "owner" && by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not operate services`);
    if (by.kind === "agent" && ((by.taskScope !== undefined && (!inTaskScope(by, task.projectId) || by.taskScope.taskId !== taskId)) || !allows(by, "task.read", task.projectId, { resource: { kind: "task", id: taskId } }))) return hidden();
    return task;
  }

  #ref(service: unknown, resource: unknown): ServiceRef {
    if (typeof service !== "string" || !NAME.test(service)) invalid("service", "must be a service name (lower-case letters, digits, . _ -)");
    if (typeof resource !== "string" || !NAME.test(resource)) invalid("resource", "must be a resource name (lower-case letters, digits, . _ -)");
    return { service: service as string, resource: resource as string };
  }

  #action(raw: unknown): ServiceAction {
    if (!isObject(raw)) return invalid("action", "must be an object like { type, params }");
    onlyKnown(raw, ["type", "params"]);
    if (typeof raw["type"] !== "string" || !ACTION.test(raw["type"])) invalid("action.type", "must be 1 to 40 lower-case letters, digits or hyphens");
    if (raw["params"] !== undefined && !isObject(raw["params"])) invalid("action.params", "must be an object");
    return { type: raw["type"] as string, ...(raw["params"] === undefined ? {} : { params: raw["params"] as JsonObject }) };
  }

  /** Reads a resource from the target. Needs the right that an operation on it would need. */
  async observe(by: Principal, command: { taskId: string; service: string; resource: string }): Promise<Observation> {
    onlyKnown(command, ["taskId", "service", "resource"]);
    const taskId = checkTaskId(command.taskId);
    const ref = this.#ref(command.service, command.resource);
    const task = await this.#task(by, taskId);
    if (!allows(by, "effect.perform", task.projectId, { resource: serviceResource(ref) })) throw new DomainError("forbidden", `${by.id} has no right to look at ${refKey(ref)}`);
    const seen = await this.#target().observe(ref);
    if (seen === undefined) throw new DomainError("not_found", `${refKey(ref)} does not exist`);
    return seen;
  }

  async operate(by: Principal, command: OperateCommand): Promise<OperateResult> {
    onlyKnown(command, ["commandId", "taskId", "service", "resource", "action"]);
    const commandId = checkCommandId(command.commandId);
    const taskId = checkTaskId(command.taskId);
    const ref = this.#ref(command.service, command.resource);
    const action = this.#action(command.action);
    const task = await this.#task(by, taskId);
    if (task.state === "cancelled") throw new DomainError("invalid_command", "the task is cancelled");
    const target = this.#target();
    let fence: Fence | undefined;
    if (by.kind === "agent") {
      fence = await this.#ports.fenceOf(taskId, by.id);
      if (fence === undefined) throw new DomainError("forbidden", `${by.id} does not own the current attempt of this task, so it cannot operate a service for it`);
    }
    const reach = await target.affects(ref, action);
    const all = reach.some((r) => same(r, ref)) ? reach : [ref, ...reach];
    // The scope: the right on the named resource, then on every other resource the action would change.
    if (!allows(by, "effect.perform", task.projectId, { resource: serviceResource(ref) })) throw new DomainError("forbidden", `${by.id} may not operate ${refKey(ref)}`);
    const outside = all.filter((r) => !allows(by, "effect.perform", task.projectId, { resource: serviceResource(r) }));
    if (outside.length > 0) throw new DomainError("forbidden", `the action ${action.type} on ${refKey(ref)} also changes ${outside.map(refKey).join(", ")}, which ${by.id} may not operate; nothing was changed`);
    const intentId = `svcop:${scopedCommandId(by.id, commandId)}`.slice(0, 120);
    const effectId = derivedId("eff", intentId);
    const known = await this.#ports.effects.get(effectId);
    if (known !== undefined) {
      // The same command again (its answer was lost, or a person repeats it): the same operation, finished or recovered, never a new one. The state it was judged against has moved on, so only its identity is compared.
      const was = known.input as JsonObject;
      if (known.kind !== "service-op" || known.taskId !== taskId || was["service"] !== ref.service || was["resource"] !== ref.resource || canonicalJson(was["action"] as JsonObject) !== canonicalJson(action as unknown as JsonObject)) throw new DomainError("command_conflict", `command ID ${commandId} was already used for a different operation`);
      return this.#result(effectId, await this.#ports.effects.run(effectId, operationBridge(target)));
    }
    const before = await target.observe(ref);
    if (before === undefined) throw new DomainError("not_found", `${refKey(ref)} does not exist`);
    const guarded = (await target.neighbours(ref)).filter((n) => !all.some((a) => same(a, n)));
    const baseline = await versionsOf(target, guarded);
    const input: JsonObject = {
      service: ref.service, resource: ref.resource, action: action as unknown as JsonObject,
      allowed: all.map((r) => ({ service: r.service, resource: r.resource })), before: before as unknown as JsonObject, baseline: baseline as unknown as JsonObject,
    };
    const intent = await this.#ports.effects.intend({ commandId: intentId, actor: by.id, kind: "service-op", target: `service:${refKey(ref)}`, input, taskId, ...(fence === undefined ? {} : { fence }) });
    return this.#result(intent.id, await this.#ports.effects.run(intent.id, operationBridge(target)));
  }

  #result(effectId: string, outcome: EffectOutcome): OperateResult {
    const evidence = outcome.evidence;
    const verified = outcome.status === "confirmed" && evidence !== undefined && evidence["verified"] === true;
    return {
      effectId, status: outcome.status,
      ...(verified ? { outcome: { reference: effectId, systemVersion: String(evidence!["systemVersion"]), observedAt: String(evidence!["observedAt"]) } } : {}),
      ...(evidence === undefined ? {} : { evidence }), ...(outcome.note === undefined ? {} : { note: outcome.note }),
    };
  }

  /**
   * Whether an operational outcome names a real, verified operation of this task: the reference is an effect of the ledger, made for this task, confirmed AND verified against the target,
   * and the system version and observation time are the ones the target reported. Throws `invalid_command` otherwise. Used by the acceptance service when a version is drafted, revised or submitted.
   */
  async checkOutcome(taskId: string, outcome: Outcome): Promise<void> {
    const bad = (why: string): never => invalid("outcome.reference", why);
    if (typeof outcome.reference !== "string" || !/^eff-[a-z2-7]{20}$/.test(outcome.reference)) return bad("must be the ID of an operation done through service.operate (eff-...), not free text");
    const e = await this.#ports.effects.get(outcome.reference);
    if (e === undefined || e.kind !== "service-op") return bad("is not a service operation of this controller");
    if (e.taskId !== taskId) return bad("is an operation done for another task");
    if (e.status !== "confirmed") return bad(`is an operation that is ${e.status}, not confirmed`);
    const ev = e.evidence;
    if (ev === undefined || ev["verified"] !== true) return bad("is an operation whose result was not verified against the target");
    if (ev["systemVersion"] !== outcome.systemVersion || ev["observedAt"] !== outcome.observedAt) return bad(`was observed at ${String(ev["observedAt"])} on system version ${String(ev["systemVersion"])}, not as the outcome says`);
  }
}
