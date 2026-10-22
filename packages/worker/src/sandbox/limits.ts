import { execFile } from "node:child_process";
import { totalmem, availableParallelism } from "node:os";
import { promisify } from "node:util";
import type { SpawnPlan } from "./backend.js";
import { SandboxError } from "./errors.js";

const run = promisify(execFile);

/** What one agent may use. All optional; an absent limit is not applied (and is not reported). */
export interface ResourceLimits {
  /** Whole CPU cores' worth of time. */
  readonly cpus?: number;
  readonly memoryMb?: number;
  /** Total bytes the agent may write. */
  readonly diskMb?: number;
  /** Processes and threads at once. */
  readonly processes?: number;
}
export type LimitName = keyof ResourceLimits;

/**
 * How a limit was applied. `full`: the mechanism enforces exactly this limit. `partial`: something related is enforced, and `detail` says what it does and does not cover.
 * `none`: the host cannot enforce it, and `detail` says why. Nothing is skipped without appearing here.
 */
export interface LimitEnforcement {
  readonly limit: LimitName;
  readonly value: number;
  readonly enforced: "full" | "partial" | "none";
  readonly by?: string;
  readonly detail: string;
}

/** What this host can do, found once by really trying it. */
export interface LimitCapabilities {
  readonly platform: NodeJS.Platform;
  /** `systemd-run --user --scope` with cgroup limits works (Linux with a user systemd and cgroup v2 delegation). */
  readonly cgroupScope: boolean;
  readonly prlimit: boolean;
  readonly taskset: boolean;
  /** Environment names a user systemd needs to reach its manager. */
  readonly passEnv: Readonly<Record<string, string>>;
}

/** What the controller and the host keep for themselves out of what agents may be given. */
export interface Headroom { readonly cpus: number; readonly memoryMb: number }
export const DEFAULT_HEADROOM: Headroom = { cpus: 1, memoryMb: 1024 };
export const LIMIT_BOUNDS = { cpus: [1, 256], memoryMb: [16, 4_194_304], diskMb: [1, 16_777_216], processes: [1, 100_000] } as const;

const bad = (message: string): never => { throw new SandboxError("invalid_recipe", `limits: ${message}`); };

export function checkLimits(limits: unknown): ResourceLimits {
  if (limits === null || typeof limits !== "object" || Array.isArray(limits)) return bad("must be an object");
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(limits)) {
    if (!(key in LIMIT_BOUNDS)) return bad(`unknown limit ${key.slice(0, 30)}`);
    const [lo, hi] = LIMIT_BOUNDS[key as LimitName];
    if (value === undefined) continue;
    if (!Number.isSafeInteger(value) || (value as number) < lo || (value as number) > hi) return bad(`${key} must be a whole number from ${lo} to ${hi}`);
    out[key] = value as number;
  }
  return out;
}

/** The host's totals, less what is reserved. A limit that asks for more than is left is refused: an agent can never be given the controller's share. */
export function checkHeadroom(limits: ResourceLimits, headroom: Headroom = DEFAULT_HEADROOM, host: { cpus: number; memoryMb: number } = { cpus: availableParallelism(), memoryMb: Math.floor(totalmem() / 1048576) }): void {
  if (limits.cpus !== undefined && limits.cpus > Math.max(host.cpus - headroom.cpus, 0)) bad(`cpus: ${limits.cpus} asked, but only ${Math.max(host.cpus - headroom.cpus, 0)} of ${host.cpus} are left after ${headroom.cpus} is kept for the controller`);
  if (limits.memoryMb !== undefined && limits.memoryMb > Math.max(host.memoryMb - headroom.memoryMb, 0)) bad(`memoryMb: ${limits.memoryMb} asked, but only ${Math.max(host.memoryMb - headroom.memoryMb, 0)} of ${host.memoryMb} are left after ${headroom.memoryMb} is kept for the controller`);
}

async function works(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<boolean> {
  try { await run(file, args, { timeout: 8000, env }); return true; } catch { return false; }
}

/** Finds out, by trying, what limits this host can apply. */
export async function detectLimitCapabilities(platform: NodeJS.Platform = process.platform): Promise<LimitCapabilities> {
  if (platform !== "linux") return { platform, cgroupScope: false, prlimit: false, taskset: false, passEnv: {} };
  const passEnv: Record<string, string> = {};
  for (const name of ["XDG_RUNTIME_DIR", "DBUS_SESSION_BUS_ADDRESS"]) { const v = process.env[name]; if (v !== undefined) passEnv[name] = v; }
  const cgroupScope = await works("systemd-run", ["--user", "--scope", "--quiet", "--collect", "-p", "TasksMax=100", "-p", "MemoryMax=64M", "--", "/bin/true"], { ...passEnv, PATH: "/usr/bin:/bin" });
  return { platform, cgroupScope, prlimit: await works("prlimit", ["--nofile=64", "--", "/bin/true"], { PATH: "/usr/bin:/bin" }), taskset: await works("taskset", ["-c", "0", "/bin/true"], { PATH: "/usr/bin:/bin" }), passEnv };
}

export interface LimitedPlan { readonly plan: SpawnPlan; readonly report: readonly LimitEnforcement[] }

/**
 * Wraps a spawn plan so the limits are applied to the process and everything it starts, and says exactly how each was handled. On Linux with a user systemd the cgroup carries memory (swap
 * off), process count and CPU time; without one, memory falls back to an address-space cap and CPUs to a core-affinity mask, and the process count is not enforced (the OS limit counts all of the
 * service user's processes, so it would also stop the service). Disk is only ever a per-file size cap here: a total needs a quota on the filesystem, which a worker does not own, so it is reported
 * as partial. Other operating systems have no per-process limits wired in yet and report every limit as not enforced.
 */
export function limitedPlan(plan: SpawnPlan, limits: ResourceLimits, caps: LimitCapabilities): LimitedPlan {
  const report: LimitEnforcement[] = [];
  const names = (Object.keys(limits) as LimitName[]).filter((k) => limits[k] !== undefined).sort();
  if (names.length === 0) return { plan, report };
  if (caps.platform !== "linux") {
    for (const limit of names) report.push({ limit, value: limits[limit]!, enforced: "none", detail: `no way to limit ${limit} is wired in for ${caps.platform} yet` });
    return { plan, report };
  }
  const scope: string[] = [];
  const prl: string[] = [];
  let affinity: number | undefined;
  for (const limit of names) {
    const value = limits[limit]!;
    switch (limit) {
      case "memoryMb":
        if (caps.cgroupScope) { scope.push("-p", `MemoryMax=${value}M`, "-p", "MemorySwapMax=0"); report.push({ limit, value, enforced: "full", by: "cgroup memory.max (swap off)", detail: "the process group is killed by the kernel past the limit" }); }
        else if (caps.prlimit) { prl.push(`--as=${value * 1048576}`); report.push({ limit, value, enforced: "partial", by: "RLIMIT_AS", detail: "caps address space per process, not the group's resident memory" }); }
        else report.push({ limit, value, enforced: "none", detail: "neither a user systemd scope nor prlimit is available" });
        break;
      case "processes":
        if (caps.cgroupScope) { scope.push("-p", `TasksMax=${value}`); report.push({ limit, value, enforced: "full", by: "cgroup pids.max", detail: "counts every process and thread in the group" }); }
        else report.push({ limit, value, enforced: "none", detail: "RLIMIT_NPROC counts all of the service user's processes, so it cannot be used; a user systemd scope is not available" });
        break;
      case "cpus":
        if (caps.cgroupScope) { scope.push("-p", `CPUQuota=${value * 100}%`); report.push({ limit, value, enforced: "full", by: "cgroup cpu.max", detail: "time is throttled to the quota" }); }
        else if (caps.taskset) { affinity = value; report.push({ limit, value, enforced: "full", by: "CPU affinity mask", detail: `restricted to ${value} core(s)` }); }
        else report.push({ limit, value, enforced: "none", detail: "neither a user systemd scope nor taskset is available" });
        break;
      case "diskMb":
        if (caps.prlimit) { prl.push(`--fsize=${value * 1048576}`); report.push({ limit, value, enforced: "partial", by: "RLIMIT_FSIZE", detail: "caps the size of any one file the agent writes; the total is not limited without a filesystem quota" }); }
        else report.push({ limit, value, enforced: "none", detail: "no filesystem quota is available and prlimit is not installed" });
        break;
    }
  }
  let file = plan.file; let args = [...plan.args]; let env = { ...plan.env };
  if (prl.length > 0) { args = [...prl, "--", file, ...args]; file = "prlimit"; }
  if (affinity !== undefined) { args = ["-c", Array.from({ length: affinity }, (_, i) => i).join(","), file, ...args]; file = "taskset"; }
  // systemd expands $NAME and ${NAME} in a command line, so a literal dollar sign is written $$.
  if (scope.length > 0) { args = ["--user", "--scope", "--quiet", "--collect", ...scope, "--", file, ...args].map((a, i, all) => (i > all.indexOf("--") ? a.replaceAll("$", "$$$$") : a)); file = "systemd-run"; env = { ...env, ...caps.passEnv, PATH: "/usr/bin:/bin" }; }
  else if (file !== plan.file) env = { ...env, PATH: "/usr/bin:/bin" };
  return { plan: { ...plan, file, args, env }, report };
}
