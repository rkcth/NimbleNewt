import { EffectRejected } from "../domain/effects.js";
import type { JsonObject } from "../storage/types.js";
import { canonicalJson } from "../storage/json.js";
import type { Observation, ServiceAction, ServiceRef, ServiceTarget } from "./target.js";

export interface SimulatedResource {
  readonly state?: JsonObject;
  /** Resources that depend on this one: a restart of it restarts them too (the collateral a scoped repair must not cause). */
  readonly dependents?: readonly ServiceRef[];
}
export type SimulatedLayout = Readonly<Record<string, Readonly<Record<string, SimulatedResource>>>>;

const refKey = (r: ServiceRef): string => `${r.service}/${r.resource}`;
const same = (a: ServiceRef, b: ServiceRef): boolean => a.service === b.service && a.resource === b.resource;

interface Cell { version: number; state: JsonObject; dependents: readonly ServiceRef[] }

/** Faults a test can arm to show how the adapter behaves when the target misbehaves. */
export interface SimulatedFaults {
  /** The next apply succeeds and then throws (the answer is lost): the adapter must ask, not repeat. */
  loseNextAnswer?: boolean;
  /** The next apply also changes this resource (a bug that leaks into a neighbour): the collateral check must notice. */
  leakInto?: ServiceRef;
  /** The next apply is applied wrongly (a field is written with another value): the read-back must notice. */
  corruptNext?: boolean;
  /** The next apply is refused. */
  refuseNext?: string;
}

/**
 * A deterministic, in-memory stand-in for real services (card P03: "simulated service operations"). It reaches nothing outside the process: no network, no files. Actions:
 * - `set` with `params.fields`: writes those fields into the resource's state (changes only that resource);
 * - `restart`: counts a restart in the state (`restarts`) and does the same to every dependent resource, transitively.
 * Every change raises the resource's version, which is the "system version" an outcome names. A key applies at most once.
 */
export class SimulatedServices implements ServiceTarget {
  readonly #cells = new Map<string, Cell>();
  readonly #keys = new Map<string, true>();
  readonly faults: SimulatedFaults = {};
  /** Every apply that reached the target, in order (the tests assert on what a refused call did not do). */
  readonly calls: { key: string; ref: string; action: string; applied: boolean }[] = [];
  #clock: () => string;

  constructor(layout: SimulatedLayout, clock: () => string = () => new Date().toISOString()) {
    this.#clock = clock;
    for (const [service, resources] of Object.entries(layout)) for (const [resource, r] of Object.entries(resources)) this.#cells.set(refKey({ service, resource }), { version: 1, state: { ...(r.state ?? {}) }, dependents: r.dependents ?? [] });
  }

  /** The target's clock, for tests that need a fixed observation time. */
  setClock(clock: () => string): void { this.#clock = clock; }

  async observe(ref: ServiceRef): Promise<Observation | undefined> {
    const c = this.#cells.get(refKey(ref));
    return c === undefined ? undefined : { systemVersion: `v${c.version}`, state: JSON.parse(JSON.stringify(c.state)) as JsonObject, observedAt: this.#clock() };
  }

  /** Test helper: the version number of a resource. */
  versionOf(ref: ServiceRef): number | undefined { return this.#cells.get(refKey(ref))?.version; }
  /** Test helper: the state of a resource. */
  stateOf(ref: ServiceRef): JsonObject | undefined { const c = this.#cells.get(refKey(ref)); return c === undefined ? undefined : JSON.parse(JSON.stringify(c.state)) as JsonObject; }

  #closure(ref: ServiceRef): ServiceRef[] {
    const out: ServiceRef[] = [ref];
    for (let i = 0; i < out.length; i++) for (const d of this.#cells.get(refKey(out[i]!))?.dependents ?? []) if (!out.some((o) => same(o, d))) out.push(d);
    return out;
  }

  async affects(ref: ServiceRef, action: ServiceAction): Promise<readonly ServiceRef[]> {
    if (!this.#cells.has(refKey(ref))) return [ref];
    return action.type === "restart" ? this.#closure(ref) : [ref];
  }

  async neighbours(ref: ServiceRef): Promise<readonly ServiceRef[]> {
    const out: ServiceRef[] = [];
    for (const key of this.#cells.keys()) {
      const [service, resource] = key.split("/") as [string, string];
      if (!(service === ref.service && resource === ref.resource)) out.push({ service, resource });
    }
    return out;
  }

  async apply(key: string, ref: ServiceRef, action: ServiceAction): Promise<void> {
    const cell = this.#cells.get(refKey(ref));
    if (cell === undefined) throw new EffectRejected(`${refKey(ref)} does not exist`);
    if (this.#keys.has(key)) { this.calls.push({ key, ref: refKey(ref), action: action.type, applied: false }); return; }
    const refused = this.faults.refuseNext;
    if (refused !== undefined) { delete this.faults.refuseNext; throw new EffectRejected(refused); }
    if (action.type !== "set" && action.type !== "restart") throw new EffectRejected(`the action ${action.type} is not known to this service`);
    if (action.type === "set") {
      const fields = action.params?.["fields"];
      if (fields === null || typeof fields !== "object" || Array.isArray(fields)) throw new EffectRejected("set needs params.fields");
      cell.state = { ...cell.state, ...(fields as JsonObject) };
      if (this.faults.corruptNext === true) { delete this.faults.corruptNext; cell.state = { ...cell.state, ...Object.fromEntries(Object.keys(fields as object).map((k) => [k, "corrupted"])) }; }
      cell.version += 1;
    } else {
      for (const r of this.#closure(ref)) {
        const c = this.#cells.get(refKey(r));
        if (c === undefined) continue;
        c.state = { ...c.state, restarts: (typeof c.state["restarts"] === "number" ? c.state["restarts"] : 0) + 1 };
        c.version += 1;
      }
    }
    const leak = this.faults.leakInto;
    if (leak !== undefined) {
      delete this.faults.leakInto;
      const l = this.#cells.get(refKey(leak));
      if (l !== undefined) { l.state = { ...l.state, touched: true }; l.version += 1; }
    }
    this.#keys.set(key, true);
    this.calls.push({ key, ref: refKey(ref), action: action.type, applied: true });
    if (this.faults.loseNextAnswer === true) { delete this.faults.loseNextAnswer; throw new Error("the connection dropped before the answer arrived"); }
  }

  async applied(key: string): Promise<boolean> { return this.#keys.has(key); }

  verify(ref: ServiceRef, action: ServiceAction, before: Observation, after: Observation): string | undefined {
    if (action.type === "set") {
      const fields = (action.params?.["fields"] ?? {}) as JsonObject;
      for (const [k, v] of Object.entries(fields)) if (canonicalJson(after.state[k] as never) !== canonicalJson(v as never)) return `${refKey(ref)}.${k} reads ${canonicalJson(after.state[k] as never)} after the change, not ${canonicalJson(v as never)}`;
      return undefined;
    }
    const was = typeof before.state["restarts"] === "number" ? before.state["restarts"] : 0;
    return after.state["restarts"] === was + 1 ? undefined : `${refKey(ref)} reports ${String(after.state["restarts"])} restarts after the restart, expected ${was + 1}`;
  }
}
