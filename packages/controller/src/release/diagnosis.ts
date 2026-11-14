import { randomBytes } from "node:crypto";
import { rm, statfs, writeFile } from "node:fs/promises";
import { freemem } from "node:os";
import { join } from "node:path";

/**
 * Telling a release defect from a failure of the machine or of a provider (card K03, "the watchdog distinguishes release defects from provider or host failures").
 *
 * A start that fails is not always the release's fault: a full disk, a data folder that cannot be written, a database server that is down or a machine out of memory stop a perfectly good release, and a model
 * provider that is unreachable stops work, not the controller. Quarantining a release for those would throw away a good release and fall back to an older one for nothing (and the older one fails the same way).
 * So before the launcher blames a release it asks what it can see, deterministically, with no model and no network of its own:
 *
 * 1. The controller's own word: it exits with `CONTROLLER_TROUBLE.host` (76) when it knows the machine is at fault (disk full, no permission on its folders, a port or file taken, out of memory or handles, the
 *    database server not answering) and `CONTROLLER_TROUBLE.provider` (77) when a provider it needs is down. `classifyError` is the one place that decides it from an error.
 * 2. What the launcher observes itself when a start ends or does not confirm: probes of the data folder (free space, writable) and of memory, and anything the host gives (`extra`: a database or provider reachability
 *    check). Any probe that finds a problem names it.
 * 3. Otherwise the release is blamed (an exit with a code of its own, a signal it was not sent, a start that never confirms on a healthy machine).
 *
 * A host or provider cause is never a quarantine; it is counted, the start is tried again after the usual back-off, and after a number of tries in a row (the owner's `hostRetries`) the owner is told the installation,
 * not the release, needs attention.
 */
export const CONTROLLER_TROUBLE = { host: 76, provider: 77 } as const;
export type FailureCause = "release" | "host" | "provider";
export interface Diagnosis { readonly cause: FailureCause; readonly reason: string; readonly evidence: readonly string[] }

/** Errors that say the machine, not the program, failed (Node `code` values and the storage layer's connection errors). */
const HOST_CODES = new Set(["ENOSPC", "EDQUOT", "EROFS", "EACCES", "EPERM", "EMFILE", "ENFILE", "ENOMEM", "EADDRINUSE", "EBUSY", "ENOTCONN", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN"]);
const HOST_TEXT = /(no space left|disk (is )?full|read-only file system|out of memory|too many open files|database (is )?(unavailable|unreachable)|could not connect to (the )?(database|server)|the database could not be opened)/i;
const PROVIDER_TEXT = /(provider (is )?(down|unreachable|unavailable|rate.?limited)|model (server|provider) (is )?(down|unreachable)|rate limit)/i;

/** Decides, from an error that stopped a start, whether the machine or a provider is at fault. Pure. */
export function classifyError(error: unknown): Diagnosis | undefined {
  const seen = new Set<unknown>();
  for (let e: unknown = error; e !== undefined && e !== null && typeof e === "object" && !seen.has(e); e = (e as { cause?: unknown }).cause) {
    seen.add(e);
    const code = (e as { code?: unknown }).code;
    const message = String((e as { message?: unknown }).message ?? "");
    if (typeof code === "string" && HOST_CODES.has(code)) return { cause: "host", reason: `${code}: the machine, not the release, stopped the start`, evidence: [code] };
    if (PROVIDER_TEXT.test(message)) return { cause: "provider", reason: "a provider the controller needs is not available", evidence: ["provider text"] };
    if (HOST_TEXT.test(message)) return { cause: "host", reason: "the machine (disk, memory or database server) stopped the start", evidence: ["host text"] };
    // The storage layer reports a database that cannot be reached as `unavailable`.
    if ((e as { kind?: unknown }).kind === "unavailable" && /connect|reach|timed out|ECONN/i.test(message)) return { cause: "host", reason: "the database server could not be reached", evidence: ["storage unavailable"] };
  }
  return undefined;
}

export interface ProbeResult { readonly cause: "host" | "provider"; readonly problem: string }
export type Probe = () => Promise<ProbeResult | undefined>;

export interface HostProbeOptions {
  /** The data folder the controller writes (disk space and write access are checked here). */
  readonly dataDir?: string;
  /** Free bytes below which the disk counts as full (default 256 MiB). */
  readonly minFreeBytes?: number;
  /** Free memory in bytes below which the machine counts as out of memory (default 64 MiB). */
  readonly minFreeMemory?: number;
  /** Replaceable in tests. */
  readonly freeBytes?: (dir: string) => Promise<number>;
  readonly freeMemory?: () => number;
  readonly writable?: (dir: string) => Promise<boolean>;
}

const freeOf = async (dir: string): Promise<number> => { const s = await statfs(dir); return Number(s.bavail) * Number(s.bsize); };
async function canWrite(dir: string): Promise<boolean> {
  const file = join(dir, `.nn-probe-${randomBytes(6).toString("hex")}`);
  try { await writeFile(file, "x", { flag: "wx" }); return true; } catch { return false; } finally { await rm(file, { force: true }).catch(() => undefined); }
}

/** The probes the launcher can make by itself: the data folder's free space and write access, and free memory. A probe that cannot run finds nothing (it never blames the machine for its own failure). */
export function hostProbes(o: HostProbeOptions): Probe[] {
  const probes: Probe[] = [];
  const minFree = o.minFreeBytes ?? 256 * 1024 * 1024;
  if (o.dataDir !== undefined) {
    const dir = o.dataDir;
    probes.push(async () => {
      let free: number | undefined;
      try { free = await (o.freeBytes ?? freeOf)(dir); } catch { free = undefined; }
      return free !== undefined && free < minFree ? { cause: "host" as const, problem: `the data folder's disk has ${Math.floor(free / 1024 / 1024)} MiB free (less than ${Math.floor(minFree / 1024 / 1024)} MiB)` } : undefined;
    });
    probes.push(async () => {
      let ok: boolean;
      try { ok = await (o.writable ?? canWrite)(dir); } catch { ok = true; }
      return ok ? undefined : { cause: "host" as const, problem: "the data folder cannot be written" };
    });
  }
  probes.push(async () => {
    const free = (o.freeMemory ?? freemem)();
    return free < (o.minFreeMemory ?? 64 * 1024 * 1024) ? { cause: "host" as const, problem: `only ${Math.floor(free / 1024 / 1024)} MiB of memory is free` } : undefined;
  });
  return probes;
}

export interface ExitFacts { readonly code: number | null; readonly signal: string | null; readonly spawnFailed?: boolean }

/**
 * Decides who is at fault for a start or a run that ended badly. `probes` are run all (a failing probe finds nothing). A start that could not be spawned at all stays the release's (as before K02a: a release whose program cannot be started falls back) unless a probe finds the machine at fault.
 * Precedence: the controller's own exit code, then the probes (host before provider), then the release. Never throws.
 */
export async function diagnoseFailure(exit: ExitFacts, probes: readonly Probe[]): Promise<Diagnosis> {
  if (exit.code === CONTROLLER_TROUBLE.host) return { cause: "host", reason: "the controller reported that the machine stopped it (exit 76)", evidence: ["exit 76"] };
  if (exit.code === CONTROLLER_TROUBLE.provider) return { cause: "provider", reason: "the controller reported that a provider is unavailable (exit 77)", evidence: ["exit 77"] };
  const found: ProbeResult[] = [];
  for (const p of probes) { try { const r = await p(); if (r !== undefined) found.push(r); } catch { /* a probe that fails finds nothing */ } }
  const host = found.find((f) => f.cause === "host") ?? found[0];
  if (host !== undefined) return { cause: host.cause, reason: host.problem, evidence: found.map((f) => f.problem) };
  const how = exit.spawnFailed === true ? "a program that could not be started" : exit.signal !== null ? `signal ${exit.signal}` : `exit code ${exit.code ?? "none"}`;
  return { cause: "release", reason: `ended with ${how} while the machine and the providers looked healthy`, evidence: [how] };
}
