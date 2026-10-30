/**
 * What one local agent may use (card H12k): the figures an operator sets in `dispatch.local.limits`. The worker's sandbox enforces them (`checkLimits` there holds the same bounds);
 * the controller checks them at start so a bad figure refuses the start rather than the first attempt. Absent: no limit is applied, as before.
 */
export interface LocalWorkerLimits {
  /** Whole CPU cores' worth of time. */
  readonly cpus?: number;
  readonly memoryMb?: number;
  /** Total megabytes the agent may write. */
  readonly diskMb?: number;
  /** Processes and threads at once. */
  readonly processes?: number;
}

export const LOCAL_WORKER_LIMIT_BOUNDS = { cpus: [1, 256], memoryMb: [16, 4_194_304], diskMb: [1, 16_777_216], processes: [1, 100_000] } as const;

/** The limits as a plain object of valid whole numbers; anything else throws, naming the key. An empty object is the same as none. */
export function checkLocalWorkerLimits(limits: unknown, label = "dispatch.local.limits"): LocalWorkerLimits | undefined {
  if (limits === undefined) return undefined;
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) throw new Error(`${label} must be an object`);
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits)) {
    if (!Object.hasOwn(LOCAL_WORKER_LIMIT_BOUNDS, key)) throw new Error(`${label}: unknown limit ${key.slice(0, 30)}`);
    if (value === undefined) continue;
    const [lo, hi] = LOCAL_WORKER_LIMIT_BOUNDS[key as keyof typeof LOCAL_WORKER_LIMIT_BOUNDS];
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < lo || value > hi) throw new Error(`${label}: ${key} must be a whole number from ${lo} to ${hi}`);
    out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** The default limits for a local agent's workspace (card H12k), controller-owned and pure: the owner's setting wins per figure over the start-up configuration; a figure neither gives is not limited. `undefined` when no figure is set at all. */
export function defaultWorkspaceLimits(startup: LocalWorkerLimits | undefined, setting: LocalWorkerLimits | undefined): LocalWorkerLimits | undefined {
  return checkLocalWorkerLimits({ ...(startup ?? {}), ...(setting ?? {}) });
}
