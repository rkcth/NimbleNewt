import { randomBytes } from "node:crypto";
import { link, mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { hostname, platform, uptime } from "node:os";
import { join, resolve } from "node:path";
import { DomainError } from "../domain/errors.js";
import { canon } from "./canon.js";

/**
 * The data directory's exclusive lock (card K01h): one controller owns a data directory at a time, and the swap of a restored database into place (`applyPendingRestore`) needs it too, so two starts that overlap cannot
 * both swap, or swap under a running controller. The lock file is made complete (written under a temporary name and linked into place, so no reader sees half of it) and names the process, its start time, the machine's boot,
 * the host and a nonce. Whether a lock is still held:
 *  - this process's own, still in the set it holds: held; this process's own that is not in the set: leaked by a start that failed, taken over;
 *  - the same host: a different boot of the machine is stale (a pid from before a reboot means nothing); else the process must exist, and (where the system tells) have the start time the lock recorded, else the pid was reused: stale.
 *    Where the start time cannot be told (Windows, macOS) the lock's heartbeat decides: a lock not refreshed for twice its refresh period (plus a skew allowance) is stale however alive the pid looks, so a reused pid cannot keep a dead controller's lock for ever;
 *  - another host, or a host name that changed (a container restarted under a new name): the boot id and the pid mean nothing here (other machine, other boot), so ONLY the lock's age decides. The holder refreshes the file's modification time while it holds the lock,
 *    and a lock not refreshed for `staleMinutes` (the owner's setting `dataLockStaleMinutes`, default 10, which the holder writes into the lock; null: never by age) is stale, but never sooner than twice the refresh period plus `LOCK_SKEW_MS`.
 *    The modification time is stamped by the HOLDER's clock (utimes) and read against the reader's: clocks of different hosts may differ, so the margin carries an allowance and the owner can raise the setting.
 * A stale lock is taken over under a short guard file and the winner re-reads the lock to confirm it owns it, so two starts that both find a stale lock do not both own it.
 * Provisional: process start time and boot id are read on Linux (/proc); elsewhere the boot is told from the uptime (two minutes of slack) and the start time is not checked.
 */
export const LOCK_FILE = ".nn-data.lock";
export const LOCK_GUARD_FILE = ".nn-data.lock.takeover";
export const DEFAULT_LOCK_STALE_MINUTES = 10;
/** The allowance for the difference between two hosts' clocks when a lock's age is judged. */
export const LOCK_SKEW_MS = 30_000;
/** Link errors after which an exclusive create is used instead (a file system without hard links; libuv reports ERROR_INVALID_FUNCTION of FAT/exFAT as EISDIR on some versions, and some drivers answer EINVAL). */
export const LINK_FALLBACK_CODES: readonly string[] = ["EPERM", "ENOSYS", "ENOTSUP", "EXDEV", "EOPNOTSUPP", "EISDIR", "EINVAL"];
export interface DataLock {
  readonly path: string;
  release(): Promise<void>;
  /** Tells the lock how long other starts wait for its refresh before calling it stale (null: never by age). */
  setStaleMinutes(minutes: number | null): Promise<void>;
  /** Whether the lock file is still this lock's (it is not after the file was removed, replaced or the lock released). */
  isHeld(): Promise<boolean>;
}
/** A live holder has the lock: the only reason a start may go on without it. */
export class DataLockBusy extends DomainError {
  constructor(message: string, readonly holder: { readonly pid: unknown; readonly host: unknown }) { super("unavailable", message); }
}
/** How often a holder refreshes a lock whose stale time is `minutes`: a quarter of it, between a second and a minute. */
export function refreshMsFor(minutes: number | null): number { return Math.min(60_000, Math.max(1000, minutes === null ? 60_000 : (minutes * 60_000) / 4)); }

/** What the lock asks the system (tests inject all of it). */
export interface LockEnv {
  readonly now?: () => Date;
  readonly pid?: number;
  readonly hostname?: () => string;
  readonly bootId?: () => string | undefined;
  /** An opaque start time of a process (same host), or undefined when it cannot be told. */
  readonly startOf?: (pid: number) => string | undefined;
  readonly alive?: (pid: number) => boolean;
  /** Minutes after which an unrefreshed lock of another host is stale; null: never. Default 10. */
  readonly staleMinutes?: number | null;
  /** How often the holder refreshes the lock (ms); default a quarter of the stale time, at most a minute. */
  readonly heartbeatMs?: number;
  /** Where a problem of a lock that is held (a refresh that fails, a lock that was lost) is told, once per episode. */
  readonly warn?: (message: string) => void;
  /** The hard link (tests inject one that fails the way some file systems do). */
  readonly link?: (existing: string, path: string) => Promise<void>;
}

/** The locks this process holds, by nonce: a lock file of this very process that is not in the set was leaked by a start that failed, and is taken over. */
const heldHere = new Set<string>();

function aliveDefault(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}
function bootDefault(): string | undefined {
  try { if (platform() === "linux") { const id = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); if (id !== "") return id; } } catch { /* fall through */ }
  return `t:${Math.round((Date.now() - uptime() * 1000) / 1000)}`;
}
function startDefault(pid: number): string | undefined {
  if (platform() !== "linux") return undefined;
  try { const text = readFileSync(`/proc/${pid}/stat`, "utf8"); const rest = text.slice(text.lastIndexOf(")") + 2).split(" "); return rest[19]; } catch { return undefined; }
}
/** Whether two boot stamps are of one boot: true, false, or undefined when they cannot be compared. */
export function sameBoot(a: unknown, b: unknown): boolean | undefined {
  if (typeof a !== "string" || typeof b !== "string") return undefined;
  const ta = a.startsWith("t:"), tb = b.startsWith("t:");
  if (ta !== tb) return undefined;
  if (!ta) return a === b;
  return Math.abs(Number(a.slice(2)) - Number(b.slice(2))) <= 120;
}

interface Holder { pid?: unknown; host?: unknown; nonce?: unknown; at?: unknown; boot?: unknown; start?: unknown; staleMinutes?: unknown; refreshMs?: unknown }

function normalize(arg: (() => Date) | LockEnv | undefined): Required<Pick<LockEnv, "now" | "pid" | "hostname" | "bootId" | "startOf" | "alive">> & LockEnv {
  const e: LockEnv = typeof arg === "function" ? { now: arg } : arg ?? {};
  return { ...e, now: e.now ?? (() => new Date()), pid: e.pid ?? process.pid, hostname: e.hostname ?? hostname, bootId: e.bootId ?? bootDefault, startOf: e.startOf ?? startDefault, alive: e.alive ?? aliveDefault };
}
type Env = ReturnType<typeof normalize>;

/** Whether the lock `holder` (whose file was last refreshed at `mtimeMs`) is still held. */
export function lockIsLive(holder: Holder, mtimeMs: number, env: LockEnv): boolean {
  const e = normalize(env);
  if (typeof holder.nonce === "string" && heldHere.has(holder.nonce)) return true;
  if (typeof holder.pid !== "number") return true;
  const minutes = holder.staleMinutes === null ? null : typeof holder.staleMinutes === "number" ? holder.staleMinutes : e.staleMinutes === undefined ? DEFAULT_LOCK_STALE_MINUTES : e.staleMinutes;
  const refresh = typeof holder.refreshMs === "number" && holder.refreshMs > 0 ? holder.refreshMs : refreshMsFor(minutes);
  const age = e.now().getTime() - mtimeMs;
  const beatLimit = 2 * refresh + LOCK_SKEW_MS;
  if (holder.host === e.hostname()) {
    // Boot id and pid are only meaningful on the machine that wrote them.
    if (sameBoot(holder.boot, e.bootId()) === false) return false;
    if (holder.pid === e.pid) return false;
    if (!e.alive(holder.pid)) return false;
    const now = e.startOf(holder.pid);
    if (typeof holder.start === "string" && now !== undefined) return now === holder.start;
    // The start time cannot be told: only the heartbeat can say whether this is still the holder.
    return age <= beatLimit;
  }
  if (minutes === null) return true;
  return age <= Math.max(minutes * 60_000, beatLimit);
}

async function readHolder(path: string): Promise<{ holder: Holder; mtimeMs: number } | undefined | "unreadable"> {
  try {
    const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
    const holder = JSON.parse(text) as Holder;
    if (holder === null || typeof holder !== "object" || typeof holder.pid !== "number") return "unreadable";
    return { holder, mtimeMs: info.mtimeMs };
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "unreadable"; }
}

/** Puts the complete file `tmp` at `path` only if nothing is there (a hard link: all or nothing); a file system without links gets an exclusive create. */
async function createExclusive(tmp: string, path: string, text: string, linkFn: (existing: string, path: string) => Promise<void> = link): Promise<boolean> {
  try { await linkFn(tmp, path); return true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") return false;
    if (code === undefined || !LINK_FALLBACK_CODES.includes(code)) throw error;
  }
  try { await writeFile(path, text, { flag: "wx", mode: 0o600 }); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return false; throw error; }
}

async function takeGuard(dir: string, e: Env): Promise<() => Promise<void>> {
  const path = join(dir, LOCK_GUARD_FILE);
  const mine = `${e.pid} ${randomBytes(6).toString("hex")}\n`;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { await writeFile(path, mine, { flag: "wx", mode: 0o600 }); return async () => { if ((await readFile(path, "utf8").catch(() => "")) === mine) await rm(path, { force: true }); }; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const info = await stat(path).catch(() => undefined);
    // A takeover takes milliseconds: a guard much older than that belongs to a start that died in the middle.
    if (info !== undefined && e.now().getTime() - info.mtimeMs > 30_000) await rm(path, { force: true });
    else throw new DomainError("unavailable", "another start is taking over the data directory lock at this moment; try again in a moment");
  }
  throw new DomainError("unavailable", "the data directory lock could not be taken");
}

export async function acquireDataLock(dataDirectory: string, arg?: (() => Date) | LockEnv): Promise<DataLock> {
  const e = normalize(arg);
  const dir = await canon(dataDirectory);
  const path = join(dir, LOCK_FILE);
  const nonce = randomBytes(12).toString("hex");
  let staleMinutes: number | null = e.staleMinutes === undefined ? DEFAULT_LOCK_STALE_MINUTES : e.staleMinutes;
  const every = (): number => e.heartbeatMs ?? refreshMsFor(staleMinutes);
  const record = (): string => `${JSON.stringify({ pid: e.pid, host: e.hostname(), nonce, at: e.now().toISOString(), boot: e.bootId(), start: e.startOf(e.pid), staleMinutes, refreshMs: every() })}\n`;
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `${LOCK_FILE}.${nonce}.tmp`);
  const text = record();
  await writeFile(tmp, text, { flag: "wx", mode: 0o600 });
  const owns = async (): Promise<boolean> => (await readFile(path, "utf8").catch(() => "")).includes(nonce);
  try {
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await createExclusive(tmp, path, text, e.link) && await owns()) return held();
      const found = await readHolder(path);
      if (found === undefined) continue; // gone in the meantime
      if (found === "unreadable") throw new DomainError("unavailable", `the data directory lock ${path} cannot be read; if no controller is running on this directory, remove the file`);
      if (lockIsLive(found.holder, found.mtimeMs, { ...e, staleMinutes })) throw busy(found.holder);
      // Stale: taken over under the guard, after looking again (another start may have done it already).
      const release = await takeGuard(dir, e);
      try {
        const again = await readHolder(path);
        if (again === "unreadable") throw new DomainError("unavailable", `the data directory lock ${path} cannot be read; if no controller is running on this directory, remove the file`);
        if (again !== undefined) {
          if (again.holder.nonce !== found.holder.nonce) continue;
          await rm(path, { force: true });
        }
        if (await createExclusive(tmp, path, text, e.link) && await owns()) return held();
      } finally { await release(); }
    }
    throw new DomainError("unavailable", "the data directory lock could not be taken");
  } finally { await rm(tmp, { force: true }).catch(() => undefined); }

  function busy(h: Holder): DomainError {
    return new DataLockBusy(`another controller holds this data directory (process ${String(h.pid)} on ${String(h.host)}${typeof h.at === "string" ? `, since ${h.at}` : ""}); stop it first`, { pid: h.pid, host: h.host });
  }
  function held(): DataLock {
    heldHere.add(nonce);
    let released = false;
    let failing = false;
    let timer: NodeJS.Timeout | undefined;
    const say = (m: string): void => { try { e.warn?.(m); } catch { /* the notice failing changes nothing */ } };
    const beat = async (): Promise<void> => {
      if (released) return;
      try {
        if (!(await owns())) throw new Error("the lock file is gone or another controller's");
        const t = e.now();
        await utimes(path, t, t);
        failing = false;
      } catch (error) {
        // Told once per episode; the holder keeps trying (a file that is only unreachable for a while comes back), and a keeper retakes a lock that was lost.
        if (!failing) { failing = true; say(`The data directory lock ${path} could not be refreshed (${error instanceof Error ? error.message : "error"}); another controller may take the directory over while this one runs.`); }
      }
    };
    const arm = (): void => { if (timer !== undefined) clearInterval(timer); timer = setInterval(() => { void beat(); }, every()); timer.unref(); };
    arm();
    return {
      path,
      isHeld: async () => !released && owns(),
      setStaleMinutes: async (minutes) => {
        staleMinutes = minutes;
        if (released) return;
        arm(); // the refresh period follows the new stale time
        if (!(await owns())) return;
        const next = join(dir, `${LOCK_FILE}.${nonce}.new`);
        await writeFile(next, record(), { mode: 0o600 });
        await rename(next, path);
      },
      release: async () => { if (released) return; released = true; if (timer !== undefined) clearInterval(timer); heldHere.delete(nonce); if (await owns()) await rm(path, { force: true }); },
    };
  }
}

/** The data directory's lock and, when the database lives in another folder, that folder's too (one holder per folder, taken in a fixed order; if the second is held the first is let go). The folders are compared by their real places (links followed). */
export async function acquireDataLocks(dirs: readonly string[], arg?: (() => Date) | LockEnv): Promise<DataLock> {
  const unique = [...new Set(await Promise.all(dirs.map((d) => canon(d))))].sort();
  const taken: DataLock[] = [];
  try { for (const d of unique) taken.push(await acquireDataLock(d, arg)); } catch (error) { for (const l of taken) await l.release().catch(() => undefined); throw error; }
  return {
    path: taken[0]!.path,
    release: async () => { for (const l of [...taken].reverse()) await l.release(); },
    setStaleMinutes: async (m) => { for (const l of taken) await l.setStaleMinutes(m); },
    isHeld: async () => (await Promise.all(taken.map((l) => l.isHeld()))).every(Boolean),
  };
}

/** A lock that is kept: taken when possible, retaken when it is lost or when its holder lets go, and demanded (`require`) by whatever must not run without it. */
export interface DataLockKeeper extends DataLock {
  /** Takes the lock now if this process does not hold it; throws (code unavailable, saying who holds it) when it cannot. */
  require(): Promise<void>;
}

/**
 * Holds the data directory lock for the life of a controller. When a LIVE holder has it and `tolerateBusy()` says a start may go on without it (a second controller on the same store, which takes the epoch from the first, card F04i)
 * the keeper starts unlocked, says so once, and tries again every refresh period: when the holder lets go the keeper takes the lock. Every other reason the lock cannot be taken (a torn lock file, a takeover in progress, ...) is an error.
 * A lock that is lost while held (the file removed or replaced) is told once and retaken the same way.
 */
export async function keepDataLocks(dirs: readonly string[], arg?: (() => Date) | LockEnv, options: { tolerateBusy?: () => boolean } = {}): Promise<DataLockKeeper> {
  const e = normalize(arg);
  const say = (m: string): void => { try { e.warn?.(m); } catch { /* ignored */ } };
  let stale: number | null = e.staleMinutes === undefined ? DEFAULT_LOCK_STALE_MINUTES : e.staleMinutes;
  let current: DataLock | undefined;
  let closed = false;
  let unlocked = false;
  let timer: NodeJS.Timeout | undefined;
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T>(f: () => Promise<T>): Promise<T> => { const r = chain.then(f, f); chain = r.catch(() => undefined); return r; };
  const ensure = (): Promise<void> => serial(async () => {
    if (closed) throw new DomainError("unavailable", "the controller is closing");
    if (current !== undefined) {
      if (await current.isHeld()) return;
      const gone = current; current = undefined; unlocked = true;
      await gone.release().catch(() => undefined);
    }
    const taken = await acquireDataLocks(dirs, { ...e, staleMinutes: stale });
    if (closed) { await taken.release(); return; }
    current = taken;
    if (unlocked) { unlocked = false; say("This controller now holds the data directory lock."); }
  });
  const arm = (): void => { if (timer !== undefined) clearInterval(timer); timer = setInterval(() => { void ensure().catch(() => undefined); }, e.heartbeatMs ?? refreshMsFor(stale)); timer.unref(); };
  try { await ensure(); } catch (error) {
    if (!(error instanceof DataLockBusy) || options.tolerateBusy?.() !== true) throw error;
    unlocked = true;
    say(`This controller runs WITHOUT the data directory lock: ${error.message}. It cannot prepare or swap in a restore until it holds the lock, and keeps trying.`);
  }
  arm();
  return {
    get path() { return current?.path ?? join(resolve(dirs[0]!), LOCK_FILE); },
    isHeld: async () => current !== undefined && current.isHeld(),
    setStaleMinutes: async (minutes) => { stale = minutes; arm(); await current?.setStaleMinutes(minutes); },
    release: async () => { closed = true; if (timer !== undefined) clearInterval(timer); await serial(async () => { const c = current; current = undefined; await c?.release(); }); },
    require: async () => {
      try { await ensure(); } catch (error) {
        if (error instanceof DomainError) throw new DomainError("unavailable", `this controller does not hold the data directory lock, so it cannot change the data: ${error.message}`);
        throw error;
      }
    },
  };
}
