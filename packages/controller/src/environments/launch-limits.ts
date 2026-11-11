import { LOCAL_WORKER_LIMIT_BOUNDS, checkLocalWorkerLimits, type LocalWorkerLimits } from "../api/worker-limits.js";

/**
 * The limits one launch of an agent runs under (card A08d): the figures of the agent's environment manifest (A08) cut down by what the owner and the installation allow. The rule is one line: for each figure the smaller of
 * what the environment states and what the installation states wins, and a figure only one of them states is kept. Nothing here can raise a limit: an environment (and so an agent or task) that asks for more than the
 * installation's figure is cut to it, and says so (`capped`). Pure: no storage, no clock.
 */

export const LAUNCH_LIMIT_NAMES = ["cpus", "memoryMb", "diskMb", "processes", "wallTimeMs"] as const;
export type LaunchLimitName = (typeof LAUNCH_LIMIT_NAMES)[number];
/** Where an applied figure came from: the agent's environment, or the installation's (the owner's setting over the start-up configuration). */
export type LimitSource = "environment" | "installation";

/** The unit of each figure, for messages. */
export const LAUNCH_LIMIT_UNITS: Readonly<Record<LaunchLimitName, string>> = { cpus: "cores", memoryMb: "megabytes", diskMb: "megabytes", processes: "processes and threads", wallTimeMs: "milliseconds" };

export interface EffectiveLaunchLimits {
  /** The figures that apply; a limit neither side states is absent (not limited). */
  readonly limits: LocalWorkerLimits;
  /** For each applied figure, whose it is. When both state the same number it is the installation's. */
  readonly sources: Readonly<Partial<Record<LaunchLimitName, LimitSource>>>;
  /** Figures the environment asked for that the installation's figure cut, with what was asked and what applies. */
  readonly capped: readonly { readonly limit: LaunchLimitName; readonly asked: number; readonly applied: number }[];
}

/** A figure of an environment or the installation that cannot be a limit (wrong type, fraction, NaN, out of bounds, unknown name): names the side, the figure, its unit and the bounds. */
export class LaunchLimitError extends Error {
  constructor(message: string) { super(message); this.name = "LaunchLimitError"; }
}

const check = (side: string, value: unknown): LocalWorkerLimits | undefined => {
  if (value === undefined) return undefined;
  try { return checkLocalWorkerLimits(value, side); } catch (error) {
    const message = error instanceof Error ? error.message : "invalid";
    // Names the unit and the bounds of every figure the message names.
    const key = LAUNCH_LIMIT_NAMES.find((k) => message.includes(`${k} must`));
    throw new LaunchLimitError(key === undefined ? message : `${message} (${LAUNCH_LIMIT_UNITS[key]})`);
  }
};

/** The tighter of two limit sets, figure by figure (the same rule as `effectiveLaunchLimits` without sources); both are checked. */
export function tightenLimits(a: unknown, b: unknown): LocalWorkerLimits | undefined {
  const x = check("limits", a); const y = check("limits", b);
  if (x === undefined) return y;
  if (y === undefined) return x;
  const out: Record<string, number> = {};
  for (const key of LAUNCH_LIMIT_NAMES) { const p = x[key]; const q = y[key]; if (p !== undefined || q !== undefined) out[key] = Math.min(p ?? Number.MAX_SAFE_INTEGER, q ?? Number.MAX_SAFE_INTEGER); }
  return out;
}

/**
 * The effective limits of an attempt. `environment` is the `limits` of the manifest the attempt is pinned to (an older manifest has no `wallTimeMs`: the installation's figure applies, or none); `installation` is the
 * owner's setting over the start-up configuration. Both are checked: a figure that is not a whole number inside the bounds of `LOCAL_WORKER_LIMIT_BOUNDS` throws `LaunchLimitError` (a launch is refused, never run with a
 * guessed figure).
 */
export function effectiveLaunchLimits(input: { readonly environment?: unknown; readonly installation?: unknown }): EffectiveLaunchLimits {
  const env = check("the environment's limits", input.environment);
  const inst = check("the installation's limits", input.installation);
  const limits: Record<string, number> = {};
  const sources: Partial<Record<LaunchLimitName, LimitSource>> = {};
  const capped: { limit: LaunchLimitName; asked: number; applied: number }[] = [];
  for (const key of LAUNCH_LIMIT_NAMES) {
    const e = env?.[key]; const i = inst?.[key];
    if (e === undefined && i === undefined) continue;
    if (e !== undefined && (i === undefined || e < i)) { limits[key] = e; sources[key] = "environment"; continue; }
    limits[key] = i!; sources[key] = "installation";
    if (e !== undefined && e > i!) capped.push({ limit: key, asked: e, applied: i! });
  }
  return { limits, sources, capped };
}

/** The bounds, for the places that validate a manifest's figure on entry. */
export const LAUNCH_LIMIT_BOUNDS = LOCAL_WORKER_LIMIT_BOUNDS;
