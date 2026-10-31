import type { JsonObject } from "../storage/types.js";

/** One resource of one service (a queue, a database, a deployment): the unit a repair is scoped to. */
export interface ServiceRef { readonly service: string; readonly resource: string }
/** What the target itself reports about a resource: its version, its state and when it was looked at (UTC ISO). */
export interface Observation { readonly systemVersion: string; readonly state: JsonObject; readonly observedAt: string }
/** What is asked of a resource: a type the target knows and its parameters. */
export interface ServiceAction { readonly type: string; readonly params?: JsonObject }

/**
 * The outside system an operation reaches (card P03). The adapter never trusts a call's own answer: it reads the target back (`observe`) and judges the result (`verify`).
 * The simulated implementation (`SimulatedServices`) is the sandbox of the card; a real system is another implementation of this port.
 */
export interface ServiceTarget {
  /** The resource as the target reports it now; `undefined` when it does not exist. */
  observe(ref: ServiceRef): Promise<Observation | undefined>;
  /** Every resource the action would change, the named one included (a restart of a shared dependency also restarts what depends on it). A repair scoped to one resource must not reach beyond it. */
  affects(ref: ServiceRef, action: ServiceAction): Promise<readonly ServiceRef[]>;
  /** Resources that sit next to this one (the rest of its service and what depends on it) and must be left as they were: the collateral check compares their versions before and after. */
  neighbours(ref: ServiceRef): Promise<readonly ServiceRef[]>;
  /** Applies the action once per `key`: asking again with the same key changes nothing. Throws `EffectRejected` when the target refuses; any other error means the answer was lost. */
  apply(key: string, ref: ServiceRef, action: ServiceAction): Promise<void>;
  /** Whether a key was applied (the target can be asked, so a lost answer is settled by asking, never by doing it again). */
  applied(key: string): Promise<boolean>;
  /** What is wrong with the resource after the action, or `undefined` when it is as the action says it should be. `before` is the observation taken before the action. */
  verify(ref: ServiceRef, action: ServiceAction, before: Observation, after: Observation): string | undefined;
}
