import { DomainError } from "../domain/errors.js";

/**
 * The owner's optional aggregate money cap (card B-agg). There is none unless the owner sets one: no record, or `enabled: false`, means no cap and no effect on any reservation. When on, a reservation that would take
 * the money used in the scope and period above `amountMicros` is refused with a plain reason, and the owner is told once.
 */
export const AGGREGATE_SCOPES = ["installation", "project", "agent"] as const;
export const AGGREGATE_PERIODS = ["day", "month", "none"] as const;
export type AggregateScope = (typeof AGGREGATE_SCOPES)[number];
export type AggregatePeriod = (typeof AGGREGATE_PERIODS)[number];

export interface AggregateBody {
  readonly enabled: boolean;
  /** installation: one cap for everything; project: the same amount for each project; agent: the same amount for each agent (a reservation with no agent counts as `unattributed`). */
  readonly scope?: AggregateScope;
  /** day or month (UTC calendar) restart the count; none counts everything ever recorded. */
  readonly period?: AggregatePeriod;
  readonly amountMicros?: number;
  /** Only money in this currency counts toward the cap (spending in another currency is not summed with it). Default USD when the cap is turned on without one. */
  readonly currency?: string;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export const AGGREGATE_MAX_MICROS = 1e15;

/** The fields a change names, checked. `amountMicros` is a whole number from 0. */
export const DEFAULT_AGGREGATE_CURRENCY = "USD";
export function checkAggregateFields(c: { enabled?: unknown; scope?: unknown; period?: unknown; amountMicros?: unknown; currency?: unknown }): { enabled?: boolean; scope?: AggregateScope; period?: AggregatePeriod; amountMicros?: number; currency?: string } {
  const out: { enabled?: boolean; scope?: AggregateScope; period?: AggregatePeriod; amountMicros?: number; currency?: string } = {};
  if (c.currency !== undefined) { if (typeof c.currency !== "string" || !/^[A-Z]{3,8}$/.test(c.currency)) throw bad("currency", "is a currency code such as USD"); out.currency = c.currency; }
  if (c.enabled !== undefined) { if (typeof c.enabled !== "boolean") throw bad("enabled", "must be true or false"); out.enabled = c.enabled; }
  if (c.scope !== undefined) { if (!(AGGREGATE_SCOPES as readonly unknown[]).includes(c.scope)) throw bad("scope", `must be one of ${AGGREGATE_SCOPES.join(", ")}`); out.scope = c.scope as AggregateScope; }
  if (c.period !== undefined) { if (!(AGGREGATE_PERIODS as readonly unknown[]).includes(c.period)) throw bad("period", `must be one of ${AGGREGATE_PERIODS.join(", ")}`); out.period = c.period as AggregatePeriod; }
  if (c.amountMicros !== undefined) { if (!Number.isSafeInteger(c.amountMicros) || (c.amountMicros as number) < 0 || (c.amountMicros as number) > AGGREGATE_MAX_MICROS) throw bad("amountMicros", "must be a whole number of millionths from 0"); out.amountMicros = c.amountMicros as number; }
  return out;
}

const bad = (field: string, message: string): DomainError => new DomainError("invalid_command", `${field}: ${message}`, { field });

/** The UTC prefix an ISO time must start with (or sort at/after) to be in the period containing `now`; undefined for `none`. */
export function windowStart(period: AggregatePeriod, now: string): string | undefined {
  return period === "day" ? now.slice(0, 10) : period === "month" ? now.slice(0, 7) : undefined;
}

/** Whether a setting is on and complete (a cap exists). An incomplete enabled record cannot be written, but a damaged one is read as a cap that refuses, never as none. */
export function isOn(b: AggregateBody | undefined): b is AggregateBody & { scope: AggregateScope; period: AggregatePeriod; amountMicros: number } {
  return b !== undefined && b.enabled === true;
}

/** off: no record or `enabled: false`; on: `enabled: true`; damaged: any other value of `enabled` (not a boolean) is read as a cap that refuses, never as none. */
export function capState(b: AggregateBody | undefined): "off" | "on" | "damaged" {
  if (b === undefined) return "off";
  const enabled: unknown = b.enabled;
  return enabled === false ? "off" : enabled === true ? "on" : "damaged";
}

/** Whether the figures of an enabled cap can be read. */
export const capReadable = (b: AggregateBody): boolean => (AGGREGATE_SCOPES as readonly string[]).includes(b.scope as string) && (b.period === "day" || b.period === "month" || b.period === "none") && Number.isSafeInteger(b.amountMicros);
