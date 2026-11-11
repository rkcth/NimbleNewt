import { randomBytes } from "node:crypto";
import { constants as fsc } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";

/**
 * Controller liveness heartbeat (card K02, follow-up to K02a): finds a controller that is still a process but no longer runs its event loop (a hung last known good).
 *
 * The K02a supervisor handles a child that exits, and the startup watchdog handles a start that is never confirmed; but `Launcher.prepare()` pre-marks the start of the last known good as confirmed, so a last known
 * good that hangs after it started was never noticed. This module has two halves that share one small file and nothing else:
 *
 * - `HeartbeatWriter` (in the controller): a timer that, every `intervalMs`, bumps a counter and writes `{v, seq, token, intervalMs}` to a launcher-owned file. The write is asynchronous and never awaited by anything
 *   else; a tick that finds the previous write unfinished only bumps the counter. The timer is `unref`ed (it never keeps the process alive) and the rate is bounded (`HEARTBEAT_INTERVAL_BOUNDS`). The counter is bumped
 *   in the timer callback, so the file only moves while the event loop turns. Nothing here touches the database, and the file carries no path, name, credential or time.
 * - `HeartbeatMonitor` (in the launcher): reads the file and decides, from its own monotonic clock only, whether the counter has stood still for `staleAfterMs` since it last moved. The wall clock is never read.
 *
 * What counts as hung (everything else is "alive" or "unknown", never a restart):
 * - At least one beat of this start (the right token) was seen, and then the counter did not move for the threshold. A file that never appeared is `unsupported` (an older last known good has no writer), unless the
 *   supervisor knows the release writes one and passes `firstBeatMs`.
 * - The threshold is `max(staleAfterMs, 6 * the writer's own interval)`, `staleAfterMs` defaulting to 120 s and never below 30 s (`HEARTBEAT_STALE_BOUNDS`), so a slow machine, a long garbage collection or a heavy synchronous
 *   migration of a few seconds cannot look like a hang.
 * - A file that is missing, unreadable, garbled, too large, not a regular file, a symlink, owned by another user, from another start (token) or with a counter that went backwards is `unknown`; while it is unknown the
 *   quiet time is not counted (after it ends the count starts again from that read).
 * - A gap between two checks of more than half the threshold (the launcher itself was paused, the machine slept, the monotonic clock jumped in either direction) re-starts the count instead of judging.
 *
 * Safety of the file: the directory must be a real directory owned by the same user and not writable by group or others (POSIX; skipped on Windows); the file is created exclusively with mode 0600 beside the target and
 * renamed over it (a rename replaces a symlink, it never follows it); the reader refuses a symlink (`O_NOFOLLOW` and `lstat`), anything but a regular file of at most `HEARTBEAT_MAX_BYTES`, and a file owned by
 * another user. A symlink among the parent directory's own ancestors is not checked (the directory itself is).
 *
 * Supervisor hook: `planLiveness`, wired into `Supervisor` (`supervisor.ts`, option `heartbeat`).
 */

export const HEARTBEAT_ENV = { file: "NIMBLENEWT_HEARTBEAT_FILE", token: "NIMBLENEWT_HEARTBEAT_TOKEN", intervalMs: "NIMBLENEWT_HEARTBEAT_INTERVAL_MS" } as const;
export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const HEARTBEAT_INTERVAL_BOUNDS = { min: 1_000, max: 60_000 } as const;
export const DEFAULT_HEARTBEAT_STALE_MS = 120_000;
export const HEARTBEAT_STALE_BOUNDS = { min: 30_000, max: 3_600_000 } as const;
export const HEARTBEAT_MAX_BYTES = 512;
/** Every record is padded to this size (JSON allows the trailing spaces), so a record can be overwritten in place without the file growing or shrinking. */
export const HEARTBEAT_RECORD_BYTES = 128;
/** The names `planLiveness` gives its files and the writer its temporaries (`sweepHeartbeats` removes leftovers of either). */
const FILE_NAME = /^heartbeat-[0-9a-f]{12}\.json(\.\d{1,10}\.tmp)?$/;
const TOKEN = /^[A-Za-z0-9_-]{8,64}$/;
const getuid = (): number | undefined => (typeof process.getuid === "function" ? process.getuid() : undefined);

export class HeartbeatError extends Error { constructor(message: string) { super(message); this.name = "HeartbeatError"; } }

const clamp = (v: number | undefined, def: number, b: { readonly min: number; readonly max: number }): number => (v === undefined || !Number.isFinite(v) ? def : Math.min(b.max, Math.max(b.min, Math.floor(v))));
/** The interval the writer uses for a requested one: the default when absent, otherwise bounded to `HEARTBEAT_INTERVAL_BOUNDS`. */
export const effectiveInterval = (ms?: number): number => clamp(ms, DEFAULT_HEARTBEAT_INTERVAL_MS, HEARTBEAT_INTERVAL_BOUNDS);
/** The staleness threshold for a requested one: the default when absent, otherwise bounded to `HEARTBEAT_STALE_BOUNDS`. */
export const effectiveStaleAfter = (ms?: number): number => clamp(ms, DEFAULT_HEARTBEAT_STALE_MS, HEARTBEAT_STALE_BOUNDS);

export interface HeartbeatRecord { readonly v: 1; readonly seq: number; readonly token: string; readonly intervalMs: number }

export type HeartbeatRead =
  | { readonly kind: "beat"; readonly record: HeartbeatRecord }
  | { readonly kind: "missing" }
  | { readonly kind: "unusable"; readonly why: string };

/** Checks that the directory that holds the file is a real, private directory (POSIX). Throws a HeartbeatError naming the problem. */
async function checkDirectory(dir: string): Promise<void> {
  const st = await lstat(dir).catch(() => undefined);
  if (st === undefined) throw new HeartbeatError("the heartbeat directory does not exist");
  if (st.isSymbolicLink() || !st.isDirectory()) throw new HeartbeatError("the heartbeat directory is not a plain directory");
  const uid = getuid();
  if (uid !== undefined) {
    if (st.uid !== uid) throw new HeartbeatError("the heartbeat directory belongs to another user");
    if ((st.mode & 0o022) !== 0) throw new HeartbeatError("the heartbeat directory can be written by group or others");
  }
}

/** Parses the file's text strictly. Exported for tests. */
export function parseHeartbeat(text: string): HeartbeatRecord | undefined {
  let v: unknown;
  try { v = JSON.parse(text); } catch { return undefined; }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return undefined;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 4 || !["v", "seq", "token", "intervalMs"].every((k) => keys.includes(k))) return undefined;
  if (o.v !== 1 || typeof o.seq !== "number" || !Number.isSafeInteger(o.seq) || o.seq < 1) return undefined;
  if (typeof o.token !== "string" || !TOKEN.test(o.token)) return undefined;
  if (typeof o.intervalMs !== "number" || !Number.isSafeInteger(o.intervalMs) || o.intervalMs < HEARTBEAT_INTERVAL_BOUNDS.min || o.intervalMs > HEARTBEAT_INTERVAL_BOUNDS.max) return undefined;
  return { v: 1, seq: o.seq, token: o.token, intervalMs: o.intervalMs };
}

/** Reads the heartbeat file safely (no symlink, regular file, own user, small). Never throws. */
export async function readHeartbeat(file: string): Promise<HeartbeatRead> {
  try {
    const l = await lstat(file).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? null : e));
    if (l === null) return { kind: "missing" };
    if (l instanceof Error) return { kind: "unusable", why: "the file cannot be examined" };
    if (l.isSymbolicLink()) return { kind: "unusable", why: "the file is a symbolic link" };
    if (!l.isFile()) return { kind: "unusable", why: "the file is not a regular file" };
    // O_NONBLOCK: a FIFO swapped in after the lstat must not block the reader (it is then refused by the fstat below).
    const handle = await open(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0));
    try {
      const st = await handle.stat();
      if (!st.isFile()) return { kind: "unusable", why: "the file is not a regular file" };
      const uid = getuid();
      if (uid !== undefined && st.uid !== uid) return { kind: "unusable", why: "the file belongs to another user" };
      if (st.size > HEARTBEAT_MAX_BYTES) return { kind: "unusable", why: "the file is too large" };
      const buf = Buffer.alloc(HEARTBEAT_MAX_BYTES + 1);
      const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
      if (bytesRead > HEARTBEAT_MAX_BYTES) return { kind: "unusable", why: "the file is too large" };
      const record = parseHeartbeat(buf.subarray(0, bytesRead).toString("utf8"));
      return record === undefined ? { kind: "unusable", why: "the file is not a heartbeat record" } : { kind: "beat", record };
    } finally { await handle.close().catch(() => undefined); }
  } catch { return { kind: "unusable", why: "the file cannot be read" }; }
}

export interface HeartbeatWriterOptions {
  /** Absolute path of the file (the launcher's `NIMBLENEWT_HEARTBEAT_FILE`). */
  readonly file: string;
  /** Names this start; the monitor ignores a file with another one. 8 to 64 of `A-Za-z0-9_-`. */
  readonly token: string;
  readonly intervalMs?: number;
  /** Told once when writing starts failing and once when it works again; the text holds no path. */
  readonly onProblem?: (line: string) => void;
}

/** The controller's side: a timer that proves the event loop turns. */
export class HeartbeatWriter {
  readonly #file: string;
  readonly #token: string;
  readonly #intervalMs: number;
  readonly #say: (line: string) => void;
  #seq = 0;
  #timer: NodeJS.Timeout | undefined;
  #pending: Promise<void> | undefined;
  #failing = false;
  #stopped = false;

  private constructor(o: HeartbeatWriterOptions) {
    this.#file = o.file; this.#token = o.token; this.#intervalMs = effectiveInterval(o.intervalMs); this.#say = o.onProblem ?? ((): void => undefined);
  }

  /**
   * Checks the target (absolute path, no symlink in the way, private directory) and starts the timer; the first beat is written at once but not awaited. Throws a HeartbeatError when the target is unsafe, so the
   * caller can run without a heartbeat (the launcher then sees no file: unknown, never hung).
   */
  static async start(o: HeartbeatWriterOptions): Promise<HeartbeatWriter> {
    if (!isAbsolute(o.file)) throw new HeartbeatError("the heartbeat file must be an absolute path");
    if (!TOKEN.test(o.token)) throw new HeartbeatError("the heartbeat token must be 8 to 64 letters, digits, dashes or underscores");
    await checkDirectory(dirname(resolve(o.file)));
    const existing = await lstat(o.file).catch(() => undefined);
    if (existing !== undefined && (existing.isSymbolicLink() || !existing.isFile())) throw new HeartbeatError("the heartbeat file is a symbolic link or not a regular file");
    const w = new HeartbeatWriter(o);
    w.#tick();
    w.#timer = setInterval(() => w.#tick(), w.#intervalMs);
    w.#timer.unref();
    return w;
  }

  get intervalMs(): number { return this.#intervalMs; }
  /** How many ticks the event loop has run so far. */
  get ticks(): number { return this.#seq; }

  #tick(): void {
    if (this.#stopped) return;
    this.#seq++;
    if (this.#pending !== undefined) return;
    this.#pending = this.#write().then(() => {
      if (this.#failing) { this.#failing = false; this.#say("the liveness heartbeat can be written again"); }
    }, (error: unknown) => {
      if (!this.#failing) { this.#failing = true; this.#say(`the liveness heartbeat cannot be written (${(error as NodeJS.ErrnoException).code ?? "error"}); the launcher cannot tell that this process is alive`); }
    }).finally(() => { this.#pending = undefined; });
  }

  async #write(): Promise<void> {
    const json = JSON.stringify({ v: 1, seq: this.#seq, token: this.#token, intervalMs: this.#intervalMs });
    const text = `${json.padEnd(HEARTBEAT_RECORD_BYTES - 1, " ")}\n`;
    try { await this.#replace(text); } catch (error) {
      // A full disk (or a directory that no longer takes new files) cannot hold a new file, but the record already there can be overwritten in place: the same size, so no new space is needed. Without this a
      // controller on a full disk would look hung and be restarted again and again, while it may be the one telling the owner that the disk is full.
      if (!(await this.#overwrite(text))) throw error;
    }
  }

  /** The usual write: a new file created exclusively (never through a link), then renamed over the target (a rename replaces a link, it never follows it). */
  async #replace(text: string): Promise<void> {
    const tmp = `${this.#file}.${process.pid}.tmp`;
    const stale = await lstat(tmp).catch(() => undefined);
    if (stale !== undefined) { if (!stale.isFile()) throw Object.assign(new Error("tmp"), { code: "EEXIST" }); await unlink(tmp); }
    // Exclusive creation with O_NOFOLLOW: never writes through a link someone put there.
    const handle = await open(tmp, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW ?? 0), 0o600);
    try {
      try { await handle.writeFile(text); } finally { await handle.close(); }
      await rename(tmp, this.#file);
    } catch (error) { await unlink(tmp).catch(() => undefined); throw error; }
  }

  /** The fallback: overwrites the existing record in place, only when it is a regular file of this user with one link and exactly one record's size (the file this writer put there). */
  async #overwrite(text: string): Promise<boolean> {
    let handle;
    try { handle = await open(this.#file, fsc.O_WRONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_NONBLOCK ?? 0)); } catch { return false; }
    try {
      const st = await handle.stat();
      const uid = getuid();
      if (!st.isFile() || st.nlink !== 1 || (uid !== undefined && st.uid !== uid) || st.size !== Buffer.byteLength(text)) return false;
      const { bytesWritten } = await handle.write(text, 0, "utf8");
      return bytesWritten === Buffer.byteLength(text);
    } catch { return false; } finally { await handle.close().catch(() => undefined); }
  }

  /** Stops the timer and waits for a write in progress. The file is left (the launcher removes it). */
  async stop(): Promise<void> {
    this.#stopped = true;
    if (this.#timer !== undefined) clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#pending?.catch(() => undefined);
  }
}

export type HeartbeatVerdict =
  | { readonly state: "alive"; readonly seq: number }
  | { readonly state: "unsupported"; readonly reason: string }
  | { readonly state: "unknown"; readonly reason: string }
  | { readonly state: "hung"; readonly quietMs: number; readonly thresholdMs: number; readonly lastSeq: number };

export interface HeartbeatMonitorOptions {
  readonly file: string;
  /** Only a file with this token counts. */
  readonly token: string;
  /** The quiet time that means hung (default 120 s; bounded to 30 s to 1 h). The writer's interval can raise it, never lower it (6 intervals). */
  readonly staleAfterMs?: number;
  /** When the supervisor knows this release writes a heartbeat: how long after `begin()` the first beat may take before the process counts as hung. Without it no beat is never hung. */
  readonly firstBeatMs?: number;
  /** A clock that never jumps back, in milliseconds (default `performance.now`). The wall clock is never used. */
  readonly monotonic?: () => number;
  readonly read?: (file: string) => Promise<HeartbeatRead>;
}

/** The launcher's side. Call `begin()` when the controller has confirmed, then `check()` every few seconds. */
export class HeartbeatMonitor {
  readonly #o: HeartbeatMonitorOptions;
  readonly #staleMs: number;
  #beganAt: number | undefined;
  #lastCheck: number | undefined;
  #lastSeq: number | undefined;
  #lastAdvance = 0;
  #interval = 0;
  #blind = false;

  constructor(o: HeartbeatMonitorOptions) {
    if (!TOKEN.test(o.token)) throw new HeartbeatError("the heartbeat token must be 8 to 64 letters, digits, dashes or underscores");
    this.#o = o; this.#staleMs = effectiveStaleAfter(o.staleAfterMs);
  }
  #now(): number { return (this.#o.monotonic ?? (() => performance.now()))(); }
  /** The quiet time that is judged hung with the interval the writer announced. */
  thresholdMs(): number { return Math.max(this.#staleMs, 6 * this.#interval); }
  /** Starts (or restarts) the count: the controller has confirmed now. */
  begin(): void { this.#beganAt = this.#now(); this.#lastCheck = undefined; this.#lastSeq = undefined; this.#blind = false; }

  async check(): Promise<HeartbeatVerdict> {
    if (this.#beganAt === undefined) this.begin();
    const r = await (this.#o.read ?? readHeartbeat)(this.#o.file).catch((): HeartbeatRead => ({ kind: "unusable", why: "the file cannot be read" }));
    const now = this.#now();
    const gap = this.#lastCheck === undefined ? 0 : now - this.#lastCheck;
    this.#lastCheck = now;
    if (r.kind !== "beat") {
      if (this.#lastSeq === undefined) {
        // Nothing of this start was ever seen: an old release without a writer, or one that has not begun to write.
        const limit = this.#o.firstBeatMs;
        if (limit !== undefined) {
          // The same rule as for a counter that stands still: a pause of this checker or a clock jump (either way) starts the wait again instead of judging.
          if (gap < 0 || gap > limit / 2 || now < this.#beganAt!) this.#beganAt = now;
          else if (now - this.#beganAt! >= limit) return { state: "hung", quietMs: Math.round(now - this.#beganAt!), thresholdMs: limit, lastSeq: 0 };
        }
        return { state: "unsupported", reason: r.kind === "missing" ? "no heartbeat file" : r.why };
      }
      this.#blind = true;
      return { state: "unknown", reason: r.kind === "missing" ? "the heartbeat file is gone" : r.why };
    }
    const rec = r.record;
    if (rec.token !== this.#o.token) { if (this.#lastSeq !== undefined) this.#blind = true; return { state: "unknown", reason: "the file belongs to another start" }; }
    this.#interval = rec.intervalMs;
    if (this.#lastSeq === undefined || rec.seq > this.#lastSeq) { this.#lastSeq = rec.seq; this.#lastAdvance = now; this.#blind = false; return { state: "alive", seq: rec.seq }; }
    // Backwards (a torn read, say): the new value is the baseline from now on, or a later hang below the old value would never be judged; the quiet time is counted again.
    if (rec.seq < this.#lastSeq) { this.#lastSeq = rec.seq; this.#blind = true; return { state: "unknown", reason: "the counter went backwards" }; }
    // Unchanged. A jump of the clock (either way) or a pause of this checker: count again from here.
    const threshold = this.thresholdMs();
    if (gap < 0 || gap > threshold / 2 || this.#blind || now < this.#lastAdvance) {
      this.#lastAdvance = now; this.#blind = false;
      return { state: "unknown", reason: "the quiet time cannot be trusted (a pause or a clock jump, or the file was unreadable); counting again" };
    }
    const quiet = now - this.#lastAdvance;
    if (quiet >= threshold) return { state: "hung", quietMs: Math.round(quiet), thresholdMs: threshold, lastSeq: this.#lastSeq };
    return { state: "alive", seq: this.#lastSeq };
  }
}

export interface HungResult { readonly releaseId: string; readonly quietMs: number; readonly thresholdMs: number; readonly reason: string }

export interface LivenessOptions {
  /** A launcher-owned directory (created 0700 when absent) for the heartbeat file; for example `<release root>/run`. */
  readonly dir: string;
  readonly releaseId: string;
  readonly staleAfterMs?: number;
  readonly intervalMs?: number;
  readonly firstBeatMs?: number;
  readonly monotonic?: () => number;
  readonly read?: (file: string) => Promise<HeartbeatRead>;
}

export interface LivenessPlan {
  /** Added to the child's environment (`NIMBLENEWT_HEARTBEAT_FILE`, `_TOKEN`, `_INTERVAL_MS`). Holds no secret: the token only tells this start's file from a stale one. */
  readonly env: Readonly<Record<string, string>>;
  readonly monitor: HeartbeatMonitor;
  /**
   * Resolves with a result when the child is judged hung, or with `undefined` when `signal` aborts. Race it against the child's exit like `Launcher.watch()`. It starts counting only once `confirmed()` is true; errors
   * from `confirmed` or the read are treated as "not yet". Polls every `pollMs` (default a sixth of the threshold, at most 5 s).
   */
  watch(o: { readonly confirmed: () => Promise<boolean>; readonly signal?: AbortSignal; readonly pollMs?: number; readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void> }): Promise<HungResult | undefined>;
  /** Removes the file (and a leftover temporary); call when the child has ended. */
  cleanup(): Promise<void>;
}

const sleepFor = (ms: number, signal?: AbortSignal): Promise<void> => new Promise((resolveSleep) => {
  if (signal?.aborted === true) { resolveSleep(); return; }
  const t = setTimeout(done, ms);
  function done(): void { clearTimeout(t); signal?.removeEventListener("abort", done); resolveSleep(); }
  signal?.addEventListener("abort", done, { once: true });
});

/**
 * Supervisor hook (wired in `Supervisor.#runOne`). For each child the supervisor starts:
 *
 * ```ts
 * const live = await planLiveness({ dir: join(root, "run"), releaseId });
 * spawn(..., { env: { ...spec.env, ...live.env } });
 * const hung = live.watch({ confirmed: async () => (await launcher.read()).attempt?.confirmedAt !== undefined, signal: controller.signal });
 * // race `hung` with the exit and the startup verdict; when it wins:
 * //   await stop("hung");                      // the same SIGTERM -> SIGKILL ladder
 * //   count the run as short for the crash-loop backoff (it ended `hung.quietMs` after the last beat)
 * //   await launcher.noteHung(releaseId, reason); // K02f notice; never quarantines
 * // after the child ended: await live.cleanup();
 * ```
 * The last known good is never quarantined for a hang: the supervisor just restarts it (through the backoff), and `giveUpAfter` ends a loop of hangs like a loop of crashes.
 */
export async function planLiveness(o: LivenessOptions): Promise<LivenessPlan> {
  const dir = resolve(o.dir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await checkDirectory(dir);
  const token = randomBytes(16).toString("hex");
  const file = join(dir, `heartbeat-${token.slice(0, 12)}.json`);
  const interval = effectiveInterval(o.intervalMs);
  const monitor = new HeartbeatMonitor({ file, token, ...(o.staleAfterMs === undefined ? {} : { staleAfterMs: o.staleAfterMs }), ...(o.firstBeatMs === undefined ? {} : { firstBeatMs: o.firstBeatMs }), ...(o.monotonic === undefined ? {} : { monotonic: o.monotonic }), ...(o.read === undefined ? {} : { read: o.read }) });
  return {
    env: { [HEARTBEAT_ENV.file]: file, [HEARTBEAT_ENV.token]: token, [HEARTBEAT_ENV.intervalMs]: String(interval) },
    monitor,
    async watch(w) {
      const sleep = w.sleep ?? sleepFor;
      const pollMs = w.pollMs ?? Math.min(5_000, Math.max(100, Math.floor(monitor.thresholdMs() / 6)));
      let armed = false;
      const aborted = (): boolean => w.signal?.aborted === true;
      while (!aborted()) {
        await sleep(pollMs, w.signal);
        if (aborted()) break;
        if (!armed) {
          armed = await w.confirmed().catch(() => false);
          if (armed) monitor.begin();
          continue;
        }
        const v = await monitor.check();
        if (v.state === "hung") return { releaseId: o.releaseId, quietMs: v.quietMs, thresholdMs: v.thresholdMs, reason: v.lastSeq === 0 ? `no sign of life within ${Math.round(v.thresholdMs / 1000)} s of the start being confirmed` : `no sign of life for ${Math.round(v.quietMs / 1000)} s (limit ${Math.round(v.thresholdMs / 1000)} s)` };
      }
      return undefined;
    },
    async cleanup() {
      // The file and any temporary the writer left (a controller killed in the middle of a write leaves `<file>.<pid>.tmp`).
      const base = basename(file);
      for (const name of await readdir(dir).catch((): string[] => [])) {
        if (name !== base && !(name.startsWith(`${base}.`) && name.endsWith(".tmp"))) continue;
        const st = await lstat(join(dir, name)).catch(() => undefined);
        if (st !== undefined && !st.isDirectory()) await unlink(join(dir, name)).catch(() => undefined);
      }
    },
  };
}

/**
 * Removes heartbeat files and temporaries left in `dir` by earlier starts (a launcher killed outright never ran `cleanup`). Only the launcher that holds the release root's lock may call it: no controller of another
 * launcher can then be writing there. Touches only names this module makes, never a directory. Returns how many were removed.
 */
export async function sweepHeartbeats(dir: string): Promise<number> {
  let removed = 0;
  for (const name of await readdir(dir).catch((): string[] => [])) {
    if (!FILE_NAME.test(name)) continue;
    const st = await lstat(join(dir, name)).catch(() => undefined);
    if (st === undefined || st.isDirectory()) continue;
    try { await unlink(join(dir, name)); removed++; } catch { /* gone already */ }
  }
  return removed;
}
