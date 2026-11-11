import { spawn, type ChildProcess } from "node:child_process";
import { performance } from "node:perf_hooks";
import type { Launcher, WatchdogResult } from "./launcher.js";

/**
 * The launcher's process supervisor (card K02a): runs the release `Launcher.prepare()` chooses as a child process, waits for the child's own confirmation (written into `launcher-state.json` by the controller),
 * runs the startup watchdog (`Launcher.watch()`) beside it, stops a child the watchdog judged failed, falls back, restarts when the child exits, and slows down a crash loop. Deterministic: no model, no network,
 * and it never opens the database: everything it knows comes from the pointer, the release directory and `launcher-state.json`, so it works when the database cannot.
 *
 * Rules, each with a test (`supervisor.test.ts`):
 * - One child at a time, started from the directory `prepare()` named, with `NIMBLENEWT_RUNNING_RELEASE=<id>` in its environment (the value of `releases.runningRelease`, the release the process was started from).
 * - On POSIX the child leads its own process group. A stop signals that group and nothing else: never a pid the launcher did not start, and never a process that was running before the launcher. A child that
 *   has exited on its own is never signalled (no pid reuse risk); only a stop signals, and the kill that ends a stop goes to the group the launcher created a moment before.
 * - A stop is SIGTERM, then SIGKILL after `graceMs` (default 10 s). A child that ignores SIGTERM is killed. On Windows there are no groups: `child.kill()` is used (not tested on Windows).
 * - The watchdog verdict `failed` stops the child and the loop calls `prepare()` again, which falls back. `late` (the last known good, or a start with nothing to fall back to) leaves the child running.
 *   The last known good is never quarantined by anything here.
 * - A child that exits, whatever its code, is started again through `prepare()` (an unconfirmed start is judged failed there). Restarts are rate limited: the n-th consecutive short run waits
 *   `min(maxMs, initialMs * 2^(n-1))` first (the first start and the first restart after a long run do not wait), and a run that lasted `stableMs` or more resets the count. After `giveUpAfter` consecutive
 *   short runs the supervisor exits with code 4 so the service manager and the owner see a crash loop instead of a spin (the service manager's own restart delay then applies).
 * - Stopping the supervisor (its `signal`) stops the child the same way and exits 0; the child is not restarted.
 * - Logs name release IDs, process IDs, exit codes, signals and the launcher's own reasons only: never the environment, the arguments' values or the child's output (the child's output goes where `stdio` says).
 */
export const SUPERVISOR_EXIT = { stopped: 0, blocked: 2, noRelease: 3, crashLoop: 4 } as const;

export interface ChildSpec { readonly command: string; readonly args: readonly string[]; readonly cwd?: string; readonly env?: NodeJS.ProcessEnv }
export interface RunningRelease { readonly releaseId: string; readonly digest: string; readonly dir: string }

export type SupervisorEvent =
  | { readonly kind: "started"; readonly releaseId: string; readonly pid: number | undefined; readonly fellBackFrom?: string }
  | { readonly kind: "exited"; readonly releaseId: string; readonly code: number | null; readonly signal: string | null; readonly spawnFailed: boolean; readonly ranMs: number }
  | { readonly kind: "judged"; readonly releaseId: string; readonly verdict: WatchdogResult["action"]; readonly reason?: string }
  | { readonly kind: "stopping"; readonly releaseId: string; readonly why: "watchdog" | "shutdown" }
  | { readonly kind: "killed"; readonly releaseId: string }
  | { readonly kind: "waiting"; readonly ms: number; readonly failures: number }
  | { readonly kind: "ended"; readonly code: number; readonly reason: string };

export interface SupervisorOptions {
  readonly launcher: Launcher;
  /** How to start the controller of the chosen release. */
  readonly child: (release: RunningRelease) => ChildSpec;
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
  /** Waits, ending early on abort (replaceable in tests). */
  readonly sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
}

export interface SupervisorResult { readonly code: number; readonly reason: string }

const defaultSleep = (ms: number, signal?: AbortSignal): Promise<void> => new Promise<void>((resolve) => {
  if (signal?.aborted === true) return resolve();
  const done = (): void => { clearTimeout(timer); signal?.removeEventListener("abort", done); resolve(); };
  const timer = setTimeout(done, ms);
  signal?.addEventListener("abort", done, { once: true });
});

interface Exit { readonly code: number | null; readonly signal: string | null; readonly spawnFailed: boolean }

export class Supervisor {
  readonly #o: SupervisorOptions;
  readonly #mono: () => number;
  readonly #sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  constructor(options: SupervisorOptions) {
    this.#o = options;
    this.#mono = options.monotonic ?? ((): number => performance.now());
    this.#sleep = options.sleep ?? defaultSleep;
  }

  #say(line: string): void { try { this.#o.log?.(line); } catch { /* a failing log never stops the launcher */ } }
  #emit(e: SupervisorEvent): void { try { this.#o.onEvent?.(e); } catch { /* an observer never stops the launcher */ } }
  #end(code: number, reason: string): SupervisorResult { this.#emit({ kind: "ended", code, reason }); this.#say(`launcher ends (${code}): ${reason}`); return { code, reason }; }

  async run(): Promise<SupervisorResult> {
    const o = this.#o;
    const initialMs = o.backoff?.initialMs ?? 1000;
    const maxMs = o.backoff?.maxMs ?? 60_000;
    const stableMs = o.backoff?.stableMs ?? 60_000;
    const giveUpAfter = o.backoff?.giveUpAfter ?? 20;
    let failures = 0;
    for (;;) {
      if (o.signal?.aborted === true) return this.#end(SUPERVISOR_EXIT.stopped, "stopped");
      const d = await o.launcher.prepare();
      if (d.action === "none") return this.#end(SUPERVISOR_EXIT.noRelease, d.reason);
      if (d.action === "blocked") return this.#end(SUPERVISOR_EXIT.blocked, d.reason);
      const startedAt = this.#mono();
      const outcome = await this.#runOne({ releaseId: d.releaseId, digest: d.digest, dir: d.dir }, d.fellBack?.from);
      if (outcome === "shutdown") return this.#end(SUPERVISOR_EXIT.stopped, "stopped");
      const ranMs = this.#mono() - startedAt;
      failures = ranMs >= stableMs ? 0 : failures + 1;
      if (failures >= giveUpAfter) return this.#end(SUPERVISOR_EXIT.crashLoop, `${failures} runs in a row ended within ${stableMs} ms; giving up so the loop is visible`);
      if (failures > 0) {
        const ms = Math.min(maxMs, initialMs * 2 ** Math.min(failures - 1, 30));
        this.#emit({ kind: "waiting", ms, failures });
        this.#say(`restart in ${ms} ms (${failures} short run${failures === 1 ? "" : "s"} in a row)`);
        await this.#sleep(ms, o.signal);
      }
    }
  }

  /** Starts one child and returns when it is gone (it exited, or was stopped after a verdict or a shutdown). */
  async #runOne(release: RunningRelease, fellBackFrom: string | undefined): Promise<"gone" | "shutdown"> {
    const o = this.#o;
    const spec = o.child(release);
    const posix = process.platform !== "win32";
    const startedAt = this.#mono();
    let child: ChildProcess | undefined;
    let exited = false;
    const exit = new Promise<Exit>((resolve) => {
      try {
        child = spawn(spec.command, [...spec.args], { cwd: spec.cwd ?? release.dir, env: { ...(spec.env ?? process.env), NIMBLENEWT_RUNNING_RELEASE: release.releaseId }, stdio: ["ignore", o.stdio ?? "inherit", o.stdio ?? "inherit"], detached: posix, windowsHide: true });
      } catch { resolve({ code: null, signal: null, spawnFailed: true }); return; }
      child.once("error", () => { if (!exited) { exited = true; resolve({ code: null, signal: null, spawnFailed: true }); } });
      child.once("exit", (code, signal) => { if (!exited) { exited = true; resolve({ code, signal, spawnFailed: false }); } });
    });
    const pid = child?.pid;
    this.#emit({ kind: "started", releaseId: release.releaseId, pid, ...(fellBackFrom === undefined ? {} : { fellBackFrom }) });
    this.#say(`started ${release.releaseId} (pid ${pid ?? "none"})${fellBackFrom === undefined ? "" : ` after falling back from ${fellBackFrom}`}`);

    const signalGroup = (sig: NodeJS.Signals): void => {
      if (pid === undefined) return;
      try { if (posix) process.kill(-pid, sig); else child?.kill(sig); } catch { /* already gone */ }
    };
    /** SIGTERM to the child's group, SIGKILL to it after the grace. The group is the one this launcher created, so nothing else is touched. */
    const stop = async (why: "watchdog" | "shutdown"): Promise<Exit> => {
      this.#emit({ kind: "stopping", releaseId: release.releaseId, why });
      this.#say(`stopping ${release.releaseId} (${why === "watchdog" ? "the startup watchdog judged it failed" : "shutdown"})`);
      const wasGone = exited;
      if (!wasGone) signalGroup("SIGTERM");
      const grace = Math.max(0, o.graceMs ?? 10_000);
      let timer: NodeJS.Timeout | undefined;
      const slow = new Promise<"slow">((resolve) => { timer = setTimeout(() => resolve("slow"), grace); });
      const first = await Promise.race([exit.then(() => "exit" as const), slow]);
      clearTimeout(timer);
      // A leader that ignored SIGTERM, and members of the group that outlive a leader that obeyed it, are killed now. A child that was already gone when the stop began is not signalled at all.
      if (first === "slow") { this.#emit({ kind: "killed", releaseId: release.releaseId }); this.#say(`killing ${release.releaseId} (still running after ${grace} ms)`); }
      if (!wasGone) signalGroup("SIGKILL");
      return exit;
    };

    const shutdownP = new Promise<{ at: "shutdown" }>((resolve) => { if (o.signal?.aborted === true) resolve({ at: "shutdown" }); else o.signal?.addEventListener("abort", () => resolve({ at: "shutdown" }), { once: true }); });
    const controller = new AbortController();
    const onShutdown = (): void => controller.abort();
    o.signal?.addEventListener("abort", onShutdown, { once: true });
    const verdict: Promise<WatchdogResult | undefined> = exited ? Promise.resolve(undefined) : o.launcher.watch({ ...(o.pollMs === undefined ? {} : { pollMs: o.pollMs }), signal: controller.signal }).catch((error: unknown) => {
      this.#say(`the startup watchdog could not run: ${error instanceof Error ? error.name : "error"}`);
      return undefined;
    });
    try {
      const first = await Promise.race([exit.then((e) => ({ at: "exit" as const, e })), verdict.then((v) => ({ at: "verdict" as const, v })), shutdownP]);
      let result: Exit;
      if (first.at === "shutdown") {
        result = await stop("shutdown");
        this.#gone(release, result, startedAt);
        return "shutdown";
      }
      if (first.at === "exit") result = first.e;
      else {
        const v = first.v;
        if (v !== undefined && v.action !== "none") this.#emit({ kind: "judged", releaseId: release.releaseId, verdict: v.action, ...("reason" in v ? { reason: v.reason } : {}) });
        if (v?.action === "failed") {
          result = await stop("watchdog");
        } else {
          // Confirmed, late, or nothing to judge: the child runs until it ends (or the launcher is told to stop).
          const next = await Promise.race([exit.then((e) => ({ at: "exit" as const, e })), shutdownP]);
          if (next.at === "shutdown") { result = await stop("shutdown"); this.#gone(release, result, startedAt); return "shutdown"; }
          result = next.e;
        }
      }
      this.#gone(release, result, startedAt);
      return "gone";
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
