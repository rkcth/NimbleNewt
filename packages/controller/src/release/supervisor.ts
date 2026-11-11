import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync, unlinkSync } from "node:fs";
import { createConnection, createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { HEARTBEAT_ENV, HEARTBEAT_STALE_BOUNDS, HeartbeatError, planLiveness, sweepHeartbeats, type HungResult, type LivenessPlan } from "./heartbeat.js";
import type { Launcher, WatchdogResult } from "./launcher.js";

/**
 * The launcher's process supervisor (card K02a): runs the release `Launcher.prepare()` chooses as a child process, waits for the child's own confirmation (written into `launcher-state.json` by the controller),
 * runs the startup watchdog (`Launcher.watch()`) beside it, stops a child the watchdog judged failed, falls back, restarts when the child exits, and slows down a crash loop. Deterministic: no model, no network,
 * and it never opens the database: everything it knows comes from the pointer, the release directory and `launcher-state.json`, so it works when the database cannot.
 *
 * Rules, each with a test (`supervisor.test.ts`):
 * - One launcher per release root: `root` takes a lock (an abstract socket on Linux, a named pipe on Windows, a socket file elsewhere) that the operating system releases when the process ends, so a launcher that
 *   was killed leaves nothing stale behind. On POSIX the controller inherits the lock (as file descriptor 3), so a launcher killed with SIGKILL, whose controller runs on as an orphan, does not let a second launcher
 *   start a second controller on the same installation: the second one exits 5 until the orphan is gone.
 * - One child at a time, started from the directory `prepare()` named, with `NIMBLENEWT_RUNNING_RELEASE=<id>` in its environment (the value of `releases.runningRelease`, the release the process was started from).
 * - On POSIX the child leads its own process group. Signals go to that group only, and only while it still has a member: a process group ID stays reserved while any member lives, so a group with members is
 *   still the one this launcher created, never a recycled ID. A pid of 1 or less is never signalled. The leader itself is signalled only before its exit was seen (its exit is seen in the same callback that reaps it).
 * - A stop is SIGTERM to the group, then SIGKILL to what is left of it after `graceMs` (default 10 s). A child that ignores SIGTERM is killed, and so are members that outlive a leader that obeyed. A child that ends
 *   by itself has what is left of its group (a database it started, say) stopped the same way before anything starts again, so the next start does not collide with the remains of the last.
 *   On Windows there are no groups: `taskkill /T /F` ends the child's tree while the child is known to run, `child.kill()` if that is not available (not tested on Windows).
 * - The watchdog verdict `failed` stops the child and the loop calls `prepare()` again, which falls back. `late` (the last known good, or a start with nothing to fall back to) leaves the child running.
 *   The last known good is never quarantined by anything here.
 * - What the controller's exit code means (`CONTROLLER_EXIT`): 0 after its start was confirmed is a stop on purpose (the owner asked the controller to stop): the launcher ends with 0 and starts nothing (a service
 *   manager does not restart a clean exit). 0 before the start was confirmed is a failed start like any other. 75 asks for a restart (after an activation, for example) and any other exit is a crash: both start
 *   again through `prepare()` (an unconfirmed start is judged failed there).
 * - Restarts are rate limited: the n-th consecutive short run waits `min(maxMs, initialMs * 2^(n-1))` first (the first start and the first restart after a long run do not wait), and a run that lasted `stableMs`
 *   or more (on the monotonic clock) resets the count. After `giveUpAfter` consecutive short runs the supervisor writes the owner's notice and exits 4 so the service manager and the owner see a crash loop
 *   instead of a spin (the service manager's own restart delay then applies).
 * - Stopping the supervisor (its `signal`) stops the child the same way and exits 0; the child is not restarted. A start it stopped this way before it was confirmed is recorded as interrupted, not failed, so it
 *   runs again (with a full window) at the next launch.
 * - Logs name release IDs, process IDs, exit codes, signals and the launcher's own reasons only: never the environment, the arguments' values or the child's output (the child's output goes where `stdio` says).
 *
 * - Liveness (card K02 heartbeat, `heartbeat.ts`): every child gets a private heartbeat file under `<root>/run` (`planLiveness`) and a watch beside the startup watchdog. It counts only once the start is
 *   confirmed (the last known good at once, since `prepare()` pre-marks it). A `hung` verdict (the counter stood still for the threshold) stops the child with the same SIGTERM -> SIGKILL ladder, writes the owner's
 *   notice (`Launcher.noteHung`) and starts the same release again through `prepare()`; the hang counts as a short run whatever its length, so a controller that always hangs ends in the crash-loop exit 4. A hang
 *   never quarantines a release and never changes the last known good. A child that never beats is `unsupported` (an older release) and left running, unless `heartbeat.firstBeatMs` says a beat must come.
 *   A heartbeat that cannot be prepared (an unsafe directory) only turns it off for that start. The file and any temporary are removed when the child is gone, on every path.
 *
 * Known gap: a controller whose event loop turns but whose work is stuck (a deadlocked await, a wedged worker thread) is not "hung" by this measure.
 */
export const SUPERVISOR_EXIT = { stopped: 0, blocked: 2, noRelease: 3, crashLoop: 4, locked: 5 } as const;
/** The controller's side of the contract: the exit codes that mean something to the launcher. Any other code (and any signal) is a crash. */
export const CONTROLLER_EXIT = { stop: 0, restart: 75 } as const;
/** The longest wait a timer can take (Node.js fires a longer one at once). */
const MAX_TIMER_MS = 2_147_483_647;

export interface ChildSpec { readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
export interface RunningRelease { readonly releaseId: string; readonly digest: string; readonly dir: string }

export type SupervisorEvent =
  | { readonly kind: "started"; readonly releaseId: string; readonly pid: number | undefined; readonly fellBackFrom?: string }
  | { readonly kind: "exited"; readonly releaseId: string; readonly code: number | null; readonly signal: string | null; readonly spawnFailed: boolean; readonly ranMs: number }
  | { readonly kind: "judged"; readonly releaseId: string; readonly verdict: WatchdogResult["action"]; readonly reason?: string }
  | { readonly kind: "stopping"; readonly releaseId: string; readonly why: "watchdog" | "shutdown" | "hung" }
  | { readonly kind: "hung"; readonly releaseId: string; readonly quietMs: number; readonly thresholdMs: number }
  | { readonly kind: "killed"; readonly releaseId: string }
  | { readonly kind: "leftovers"; readonly releaseId: string; readonly killed: boolean }
  | { readonly kind: "waiting"; readonly ms: number; readonly failures: number }
  | { readonly kind: "ended"; readonly code: number; readonly reason: string };

export interface SupervisorOptions {
  readonly launcher: Launcher;
  /** How to start the controller of the chosen release. */
  readonly child: (release: RunningRelease) => ChildSpec;
  /** The release root: when given, the supervisor holds the root's launcher lock while it runs (see `lockRoot`) and exits 5 when another holds it. */
  readonly root?: string;
  readonly pollMs?: number;
  readonly graceMs?: number;
  readonly backoff?: { readonly initialMs?: number; readonly maxMs?: number; readonly stableMs?: number; readonly giveUpAfter?: number };
  /** Where the child's output goes (default: this process's). */
  readonly stdio?: "inherit" | "ignore";
  /** Stops the supervisor (and its child). */
  readonly signal?: AbortSignal;
  readonly log?: (line: string) => void;
  readonly onEvent?: (event: SupervisorEvent) => void;
  /** A clock that never jumps, in milliseconds (default `performance.now`); the wall clock is never used here. */
  readonly monotonic?: () => number;
  /** Waits between restarts, ending early on abort (replaceable in tests). */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * The liveness heartbeat (on by default; `false` turns it off). `dir` defaults to `<release root>/run`. `staleAfterMs` (default 120 s, at least 30 s) and the writer's `intervalMs` (default 5 s, 1 to 60 s) are
   * bounded in `heartbeat.ts`; `firstBeatMs` (unset by default: a child that never beats is left alone) makes a confirmed start that has not beaten within it count as hung. `monotonic` defaults to this
   * supervisor's clock; `pollMs` to a sixth of the threshold, at most 5 s.
   */
  readonly heartbeat?: false | { readonly dir?: string; readonly staleAfterMs?: number; readonly intervalMs?: number; readonly firstBeatMs?: number; readonly pollMs?: number; readonly monotonic?: () => number };
}

export interface SupervisorResult { readonly code: number; readonly reason: string }

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
  if (signal?.aborted === true) return resolve();
  const done = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, Math.min(MAX_TIMER_MS, Math.max(0, ms)));
  signal?.addEventListener("abort", done, { once: true });
});
const pause = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** A process group ID this launcher may signal: a whole number above 1 (0 would be the launcher's own group, 1 and below would be every process it may signal). */
const signallable = (pgid: number | undefined): pgid is number => pgid !== undefined && Number.isSafeInteger(pgid) && pgid > 1;
/** Whether the group still has a member this launcher may signal. While it has one, its ID cannot have been given to another group. */
const groupAlive = (pgid: number): boolean => { try { process.kill(-pgid, 0); return true; } catch { return false; } };

interface Exit { readonly code: number | null; readonly signal: string | null; readonly spawnFailed: boolean }
type Outcome = { readonly kind: "shutdown" } | { readonly kind: "gone"; readonly exit: Exit; readonly judged: boolean; readonly hung: boolean };

/** The lock that keeps one launcher per release root. `fd` (POSIX only) is handed to the controller so an orphaned controller keeps the root locked. */
export interface RootLock { readonly fd: number | undefined; close(): Promise<void> }

/**
 * Takes the launcher lock of a release root, or answers undefined when another process holds it. The operating system frees it when the holder ends (an abstract socket on Linux, a named pipe on Windows); on
 * other systems it is a socket file under the root (or under the temporary directory when that path would be too long), and a file nobody listens on is stale and replaced. `abstract: false` forces the socket
 * file on Linux (for tests). Two launchers starting at the very same moment on macOS could both replace a stale file; a service manager starts one.
 */
export async function lockRoot(root: string, options: { readonly abstract?: boolean } = {}): Promise<RootLock | undefined> {
  let real: string;
  try { real = realpathSync(root); } catch { real = resolve(root); }
  const key = createHash("sha256").update(real).digest("hex").slice(0, 32);
  const win = process.platform === "win32";
  const abstract = !win && process.platform === "linux" && options.abstract !== false;
  const inRoot = join(real, ".launcher.sock");
  const path = win ? `\\\\.\\pipe\\nimblenewt-launcher-${key}` : abstract ? `\0nimblenewt-launcher-${key}` : Buffer.byteLength(inRoot) < 100 ? inRoot : join(tmpdir(), `nimblenewt-launcher-${key}.sock`);
  const listen = (): Promise<Server | "in-use"> => new Promise((resolveListen, reject) => {
    const server = createServer((socket) => socket.destroy());
    server.once("error", (error: NodeJS.ErrnoException) => { if (error.code === "EADDRINUSE") resolveListen("in-use"); else reject(error); });
    server.listen(path, () => resolveListen(server));
  });
  const answers = (): Promise<boolean> => new Promise((resolveProbe) => {
    const socket = createConnection(path);
    socket.once("connect", () => { socket.destroy(); resolveProbe(true); });
    socket.once("error", (error: NodeJS.ErrnoException) => { socket.destroy(); resolveProbe(!(error.code === "ECONNREFUSED" || error.code === "ENOENT")); });
  });
  for (let tries = 0; tries < 3; tries++) {
    const got = await listen();
    if (got !== "in-use") {
      got.unref();
      const fd = win ? undefined : (got as unknown as { _handle?: { fd?: unknown } })._handle?.fd;
      return { fd: typeof fd === "number" && fd > 2 ? fd : undefined, close: () => new Promise<void>((r) => { got.close(() => r()); }) };
    }
    if (win || abstract) return undefined;
    // A socket file: held while something listens on it; a file left by a launcher that was killed is replaced.
    if (await answers()) return undefined;
    try { unlinkSync(path); } catch { /* another launcher replaced it first */ }
  }
  return undefined;
}

export class Supervisor {
  readonly #o: SupervisorOptions;
  readonly #mono: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  #lockFd: number | undefined;
  constructor(options: SupervisorOptions) {
    this.#o = options;
    this.#mono = options.monotonic ?? ((): number => performance.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  #say(line: string): void { try { this.#o.log?.(line); } catch { /* a failing log never stops the launcher */ } }
  #emit(e: SupervisorEvent): void { try { this.#o.onEvent?.(e); } catch { /* an observer never stops the launcher */ } }
  #end(code: number, reason: string): SupervisorResult { this.#emit({ kind: "ended", code, reason }); this.#say(`launcher ends (${code}): ${reason}`); return { code, reason }; }
  #grace(): number { return Math.min(MAX_TIMER_MS, Math.max(0, this.#o.graceMs ?? 10_000)); }
  #heartbeatDir(): string | undefined { const h = this.#o.heartbeat; return h === false ? undefined : resolve(h?.dir ?? join(this.#o.root ?? this.#o.launcher.root, "run")); }

  /** Prepares the heartbeat for one start; undefined (logged) when it is off or cannot be prepared: the child then runs without it, as an older release would. */
  async #liveness(releaseId: string): Promise<LivenessPlan | undefined> {
    const h = this.#o.heartbeat;
    const dir = this.#heartbeatDir();
    if (h === false || dir === undefined) return undefined;
    try {
      return await planLiveness({ dir, releaseId, monotonic: h?.monotonic ?? this.#mono, ...(h?.staleAfterMs === undefined ? {} : { staleAfterMs: h.staleAfterMs }), ...(h?.intervalMs === undefined ? {} : { intervalMs: h.intervalMs }),
        // A first beat may never be required sooner than a stall would be judged.
        ...(h?.firstBeatMs === undefined ? {} : { firstBeatMs: Math.max(h.firstBeatMs, h.staleAfterMs ?? 0, HEARTBEAT_STALE_BOUNDS.min) }) });
    } catch (error) {
      this.#say(`the liveness heartbeat is off for this start: ${error instanceof HeartbeatError ? error.message : "its directory cannot be prepared"}`);
      return undefined;
    }
  }

  async run(): Promise<SupervisorResult> {
    const o = this.#o;
    let lock: RootLock | undefined;
    if (o.root !== undefined) {
      lock = await lockRoot(o.root);
      if (lock === undefined) return this.#end(SUPERVISOR_EXIT.locked, "another launcher, or a controller a launcher started, is still running for this release root; nothing was started");
      this.#lockFd = lock.fd;
      // Holding the lock, no controller of another launcher writes here: what earlier starts left (a launcher killed outright never cleaned up) goes.
      const dir = this.#heartbeatDir();
      if (dir !== undefined) await sweepHeartbeats(dir).catch(() => 0);
    }
    try { return await this.#loop(); } finally { this.#lockFd = undefined; await lock?.close(); }
  }

  async #loop(): Promise<SupervisorResult> {
    const o = this.#o;
    const initialMs = o.backoff?.initialMs ?? 1000;
    const maxMs = o.backoff?.maxMs ?? 60_000;
    const stableMs = o.backoff?.stableMs ?? 60_000;
    const giveUpAfter = o.backoff?.giveUpAfter ?? 20;
    let failures = 0;
    const aborted = (): boolean => o.signal?.aborted === true;
    for (;;) {
      if (aborted()) return this.#end(SUPERVISOR_EXIT.stopped, "stopped");
      const d = await o.launcher.prepare();
      if (d.action === "none") return this.#end(SUPERVISOR_EXIT.noRelease, d.reason);
      if (d.action === "blocked") return this.#end(SUPERVISOR_EXIT.blocked, d.reason);
      // Told to stop while the decision was being made: the start it recorded never happened, so it is not a failed start.
      if (aborted()) { await this.#interrupted(d.releaseId); return this.#end(SUPERVISOR_EXIT.stopped, "stopped"); }
      const startedAt = this.#mono();
      const outcome = await this.#runOne({ releaseId: d.releaseId, digest: d.digest, dir: d.dir }, d.fellBack?.from);
      if (outcome.kind === "shutdown") return this.#end(SUPERVISOR_EXIT.stopped, "stopped");
      const ranMs = this.#mono() - startedAt;
      const e = outcome.exit;
      if (!e.spawnFailed && !outcome.judged && e.signal === null && e.code === CONTROLLER_EXIT.stop) {
        if (await this.#confirmed(d.releaseId)) return this.#end(SUPERVISOR_EXIT.stopped, `${d.releaseId} stopped on purpose (exit 0 after its start was confirmed); not restarted`);
        this.#say(`${d.releaseId} exited 0 before its start was confirmed: a failed start`);
      } else if (!e.spawnFailed && e.signal === null && e.code === CONTROLLER_EXIT.restart) this.#say(`${d.releaseId} asked to be restarted`);
      // A hang counts as a short run however long the run was: a controller that always hangs after a while is a loop too, and must end in the visible exit 4, not restart forever.
      failures = !outcome.hung && ranMs >= stableMs ? 0 : failures + 1;
      if (failures >= giveUpAfter) {
        const reason = `${failures} runs in a row ended within ${stableMs} ms or hung`;
        try { await o.launcher.noteCrashLoop(d.releaseId, `${failures} times in a row within ${Math.round(stableMs / 1000)} s of starting or by hanging`); } catch { this.#say("the crash-loop notice could not be written"); }
        return this.#end(SUPERVISOR_EXIT.crashLoop, `${reason}; giving up so the loop is visible`);
      }
      if (failures > 0) {
        const ms = Math.min(maxMs, initialMs * 2 ** Math.min(failures - 1, 30));
        this.#emit({ kind: "waiting", ms, failures });
        this.#say(`restart in ${ms} ms (${failures} short run${failures === 1 ? "" : "s"} in a row)`);
        await this.#sleep(ms, o.signal);
      }
    }
  }

  async #confirmed(releaseId: string): Promise<boolean> {
    try {
      const s = await this.#o.launcher.read();
      return s.attempt?.id === releaseId && s.attempt.confirmedAt !== undefined && !s.failed.some((f) => f.id === releaseId);
    } catch { return false; }
  }
  async #interrupted(releaseId: string): Promise<void> {
    try { if (await this.#o.launcher.interrupted(releaseId)) this.#say(`the start of ${releaseId} was interrupted by the stop, not failed; it starts afresh next time`); } catch { this.#say("the interrupted start could not be recorded"); }
  }

  /**
   * Ends what is left of a group whose leader has exited: SIGTERM (unless it was already sent), then SIGKILL after the rest of the grace. Signals only while the group has a member (see `groupAlive`), so a group
   * that has ended is never signalled again, whatever later takes its number. Returns whether SIGKILL was needed.
   */
  async #drainGroup(pgid: number, deadline: number, termed: boolean): Promise<boolean> {
    if (!groupAlive(pgid)) return false;
    if (!termed) { try { process.kill(-pgid, "SIGTERM"); } catch { return false; } }
    while (this.#mono() < deadline) { await pause(Math.max(1, Math.min(50, deadline - this.#mono()))); if (!groupAlive(pgid)) return false; }
    if (!groupAlive(pgid)) return false;
    try { process.kill(-pgid, "SIGKILL"); return true; } catch { return false; }
  }

  /** Starts one child and returns when it is gone (it exited, or was stopped after a verdict or a shutdown), with nothing of its process group left. */
  async #runOne(release: RunningRelease, fellBackFrom: string | undefined): Promise<Outcome> {
    const spec = this.#o.child(release);
    const live = await this.#liveness(release.releaseId);
    try { return await this.#runChild(release, fellBackFrom, spec, live); } finally { await live?.cleanup().catch(() => undefined); }
  }

  async #runChild(release: RunningRelease, fellBackFrom: string | undefined, spec: ChildSpec, live: LivenessPlan | undefined): Promise<Outcome> {
    const o = this.#o;
    const posix = process.platform !== "win32";
    // The heartbeat variables come from this launcher only: inherited ones (from whoever started the launcher) are dropped, so the child never writes where someone else pointed it.
    const env: NodeJS.ProcessEnv = { ...(spec.env ?? process.env) };
    for (const k of Object.values(HEARTBEAT_ENV)) delete env[k];
    Object.assign(env, live?.env ?? {}, { NIMBLENEWT_RUNNING_RELEASE: release.releaseId });
    const startedAt = this.#mono();
    let child: ChildProcess | undefined;
    let exited = false;
    const out = o.stdio ?? "inherit";
    const exit = new Promise<Exit>((resolve) => {
      try {
        child = spawn(spec.command, [...spec.args], { cwd: spec.cwd ?? release.dir, env, stdio: ["ignore", out, out, ...(this.#lockFd === undefined ? [] : [this.#lockFd])], detached: posix, windowsHide: true });
      } catch { exited = true; resolve({ code: null, signal: null, spawnFailed: true }); return; }
      // `exited` is set in the very callback that reaps the child, so the leader is never signalled after its pid could have been given to another process.
      child.once("error", () => { if (!exited) { exited = true; resolve({ code: null, signal: null, spawnFailed: true }); } });
      child.once("exit", (code, signal) => { if (!exited) { exited = true; resolve({ code, signal, spawnFailed: false }); } });
    });
    const pid = child?.pid;
    this.#emit({ kind: "started", releaseId: release.releaseId, pid, ...(fellBackFrom === undefined ? {} : { fellBackFrom }) });
    this.#say(`started ${release.releaseId} (pid ${pid ?? "none"})${fellBackFrom === undefined ? "" : ` after falling back from ${fellBackFrom}`}`);

    /** Ends the child and its group (POSIX) or tree (Windows), only while the child is known to run. */
    const signalRunning = (sig: NodeJS.Signals): void => {
      if (exited || !signallable(pid)) return;
      if (posix) { try { process.kill(-pid, sig); } catch { /* already gone */ } return; }
      const r = spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 10_000 });
      if (r.status !== 0 && !exited) { try { child?.kill(sig); } catch { /* already gone */ } }
    };
    /** SIGTERM to the child's group, SIGKILL to what is left after the grace. */
    const stop = async (why: "watchdog" | "shutdown" | "hung"): Promise<Exit> => {
      this.#emit({ kind: "stopping", releaseId: release.releaseId, why });
      this.#say(`stopping ${release.releaseId} (${why === "watchdog" ? "the startup watchdog judged it failed" : why === "hung" ? "the liveness heartbeat found it hung" : "shutdown"})`);
      const wasGone = exited;
      signalRunning("SIGTERM");
      const grace = this.#grace();
      const deadline = this.#mono() + grace;
      let timer: NodeJS.Timeout | undefined;
      const slow = new Promise<"slow">((resolve) => { timer = setTimeout(() => resolve("slow"), grace); });
      const first = await Promise.race([exit.then(() => "exit" as const), slow]);
      clearTimeout(timer);
      if (first === "slow") {
        // The leader ignored SIGTERM: the whole group is killed while the leader is still known to run.
        this.#emit({ kind: "killed", releaseId: release.releaseId });
        this.#say(`killing ${release.releaseId} (still running after ${grace} ms)`);
        signalRunning("SIGKILL");
      }
      const e = await exit;
      if (posix && wasGone && signallable(pid)) await this.#drainGroup(pid, deadline, false);
      // Members that outlive a leader that obeyed get the rest of the grace, then SIGKILL; a group that has emptied is not signalled.
      if (posix && !wasGone && signallable(pid) && first === "exit" && await this.#drainGroup(pid, deadline, true)) {
        this.#emit({ kind: "killed", releaseId: release.releaseId });
        this.#say(`killing what ${release.releaseId} left running (still running after ${grace} ms)`);
      }
      return e;
    };
    /** After a child ended by itself: what is left of its group is stopped before anything starts again. */
    const leftovers = async (): Promise<void> => {
      if (!posix || !signallable(pid) || !groupAlive(pid)) return;
      this.#say(`stopping what ${release.releaseId} left running (process group ${pid})`);
      const killed = await this.#drainGroup(pid, this.#mono() + this.#grace(), false);
      this.#emit({ kind: "leftovers", releaseId: release.releaseId, killed });
    };

    const shutdownP = new Promise<{ at: "shutdown" }>((resolve) => { if (o.signal?.aborted === true) resolve({ at: "shutdown" }); else o.signal?.addEventListener("abort", () => resolve({ at: "shutdown" }), { once: true }); });
    const controller = new AbortController();
    const onShutdown = (): void => controller.abort();
    o.signal?.addEventListener("abort", onShutdown, { once: true });
    const verdict: Promise<WatchdogResult | undefined> = exited ? Promise.resolve(undefined) : o.launcher.watch({ ...(o.pollMs === undefined ? {} : { pollMs: o.pollMs }), signal: controller.signal }).catch((error: unknown) => {
      this.#say(`the startup watchdog could not run: ${error instanceof Error ? error.name : "error"}`);
      return undefined;
    });
    // The liveness watch: resolves only with a hang (never on abort or an error, which leave the child to the exit and the watchdog).
    const never = new Promise<never>(() => undefined);
    const hungP: Promise<HungResult> = live === undefined || exited ? never : live.watch({ confirmed: () => this.#confirmed(release.releaseId), signal: controller.signal, ...(o.heartbeat === false || o.heartbeat?.pollMs === undefined ? {} : { pollMs: o.heartbeat.pollMs }) })
      .then((h) => h ?? never, () => never);
    const hungStop = async (h: HungResult): Promise<Exit> => {
      this.#emit({ kind: "hung", releaseId: release.releaseId, quietMs: h.quietMs, thresholdMs: h.thresholdMs });
      this.#say(`${release.releaseId} is hung: ${h.reason}`);
      const e = await stop("hung");
      // The owner's notice; never a quarantine, never a change to the last known good: the same release is started again (through the backoff).
      try { await o.launcher.noteHung(release.releaseId, h.reason); } catch { this.#say("the hang notice could not be written"); }
      return e;
    };
    const shutdown = async (): Promise<Outcome> => {
      const result = await stop("shutdown");
      this.#gone(release, result, startedAt);
      await this.#interrupted(release.releaseId);
      return { kind: "shutdown" };
    };
    try {
      const hungAt = hungP.then((h) => ({ at: "hung" as const, h }));
      const first = await Promise.race([exit.then((e) => ({ at: "exit" as const, e })), verdict.then((v) => ({ at: "verdict" as const, v })), shutdownP, hungAt]);
      if (first.at === "shutdown") return await shutdown();
      let result: Exit;
      let judged = false;
      let hung = false;
      if (first.at === "exit") { result = first.e; await leftovers(); }
      else if (first.at === "hung") { judged = true; hung = true; result = await hungStop(first.h); }
      else {
        const v = first.v;
        if (v !== undefined && v.action !== "none") this.#emit({ kind: "judged", releaseId: release.releaseId, verdict: v.action, ...("reason" in v ? { reason: v.reason } : {}) });
        if (v?.action === "failed") {
          judged = true;
          result = await stop("watchdog");
        } else {
          // Confirmed, late, or nothing to judge: the child runs until it ends (or the launcher is told to stop).
          const next = await Promise.race([exit.then((e) => ({ at: "exit" as const, e })), shutdownP, hungAt]);
          if (next.at === "shutdown") return await shutdown();
          if (next.at === "hung") { judged = true; hung = true; result = await hungStop(next.h); }
          else { result = next.e; await leftovers(); }
        }
      }
      this.#gone(release, result, startedAt);
      return { kind: "gone", exit: result, judged, hung };
    } finally {
      controller.abort();
      o.signal?.removeEventListener("abort", onShutdown);
    }
  }

  #gone(release: RunningRelease, e: Exit, startedAt: number): void {
    const ranMs = Math.max(0, this.#mono() - startedAt);
    this.#emit({ kind: "exited", releaseId: release.releaseId, code: e.code, signal: e.signal, spawnFailed: e.spawnFailed, ranMs });
    this.#say(e.spawnFailed ? `${release.releaseId} could not be started` : `${release.releaseId} exited (code ${e.code ?? "none"}, signal ${e.signal ?? "none"}) after ${Math.round(ranMs)} ms`);
  }
}
