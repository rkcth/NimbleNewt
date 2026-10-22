import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import type { GuestView, SandboxBackend, SpawnPlan } from "./backend.js";
import { bubblewrapBackend } from "./linux.js";
import { seatbeltBackend } from "./seatbelt.js";
import { SandboxError } from "./errors.js";
import { DEFAULT_HEADROOM, checkHeadroom, checkLimits, detectLimitCapabilities, limitedPlan, type Headroom, type LimitCapabilities, type LimitEnforcement, type ResourceLimits } from "./limits.js";
import { canonical, normalizeRecipe, protectedPathsFor, sha256, type NormalizedRecipe, type SandboxMode, type SandboxRecipe } from "./recipe.js";

/** What is written to the audit trail before every launch (card A03: the mode is visible there). */
export interface LaunchRecord {
  readonly at: string;
  readonly runId: string;
  readonly mode: SandboxMode;
  readonly backend: string;
  readonly recipeRevision: string;
  /** Digest of the command line (the line itself may carry secrets, so it is not recorded). */
  readonly commandDigest: string;
  /** In trusted-host mode, the authority the owner configured for it. */
  readonly authority?: string;
  /** Protected names that did not exist in the workdir and so could not be bound read-only. */
  readonly unprotectedSubpaths: readonly string[];
  /** How each limit asked for was handled (card A08b): enforced fully, partly or not at all, and by what. A limit is never absent from this list without being absent from the request. */
  readonly limits: readonly LimitEnforcement[];
}

export interface Capacity {
  readonly available: boolean;
  readonly backend?: string;
  readonly version?: string;
  /** When not available: why. */
  readonly reason?: string;
  readonly checkedAt: string;
}

export interface LauncherConfig {
  /** The confinement mechanism. Default: the one for this OS (bubblewrap on Linux); an OS without one has no capacity. */
  readonly backend?: SandboxBackend;
  /** Paths no mount may reach into or contain: this program's own files, the controller's data and anything holding secrets. The service user's credential directories are always protected. */
  readonly protectedPaths: readonly string[];
  /** Allows `trusted-host` launches, which run unconfined as the service user. Absent means they are refused. */
  readonly trustedHost?: { readonly authority: string };
  /** Records a launch. If it throws, the launch does not happen. */
  readonly audit: (record: LaunchRecord) => void | Promise<void>;
  readonly clock?: () => string;
  readonly platform?: NodeJS.Platform;
  /** What is kept back for the controller and the host out of the machine; agents' limits may not exceed the rest. Default 1 core and 1 GiB. */
  readonly headroom?: Headroom;
  /** What this host can enforce. Default: found by trying (at creation and on `recheck`). */
  readonly limitCapabilities?: LimitCapabilities;
}

export interface LaunchRequest {
  readonly recipe: SandboxRecipe;
  /** The program and its arguments, as the sandbox sees paths. */
  readonly command: readonly string[];
  /** The run is killed after this long. 1 ms to 24 hours. */
  readonly timeoutMs: number;
  /** Each of stdout and stderr is cut at this many bytes (1 to 64 MiB). */
  readonly maxOutputBytes: number;
  /** Resource limits for this run. */
  readonly limits?: ResourceLimits;
  /** Refuse the launch unless every limit asked for is enforced in full. Without it a limit the host cannot enforce is reported in the launch record and the run goes ahead. */
  readonly requireEnforced?: boolean;
}

export interface RunResult {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  /** True when `kill` was called (or the launcher was stopped) before the process ended. */
  readonly killed: boolean;
  readonly stdout: string;
  readonly stderr: string;
  /** True when stdout or stderr was cut at the limit. */
  readonly truncated: boolean;
  readonly durationMs: number;
}

export interface SandboxRun {
  readonly runId: string;
  readonly mode: SandboxMode;
  readonly recipeRevision: string;
  /** Where the agent finds its checkout, home, scratch, temporary directory and inputs. */
  readonly guest: GuestView;
  /** Ends the process and everything it started. Safe to call more than once. */
  kill(): void;
  readonly result: Promise<RunResult>;
}

const SUPERVISOR_ROOT = fileURLToPath(new URL("../../", import.meta.url)).replace(/\/$/, "");
const EXIT_DRAIN_MS = 2000;
const MAX_TIMEOUT_MS = 24 * 60 * 60 * 1000;
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

function defaultBackend(platform: NodeJS.Platform): SandboxBackend | undefined {
  return platform === "linux" ? bubblewrapBackend() : platform === "darwin" ? seatbeltBackend() : undefined;
}

/**
 * Starts agent processes inside the confinement of the OS (card A03). It reports capacity only after the backend has proved itself with a
 * real confined start, refuses every launch while there is none (nothing ever runs unconfined as a fallback), records each launch before it
 * happens, keeps the supervisor's own files out of anything the agent can write, bounds time and output, and kills the whole process tree.
 */
export class SandboxLauncher {
  readonly #config: LauncherConfig;
  readonly #backend: SandboxBackend | undefined;
  readonly #protectedPaths: readonly string[];
  readonly #clock: () => string;
  #capacity: Capacity;
  #limitCaps: LimitCapabilities | undefined;
  readonly #live = new Set<SandboxRun>();
  #stopped = false;

  private constructor(config: LauncherConfig, backend: SandboxBackend | undefined, capacity: Capacity) {
    this.#config = config;
    this.#backend = backend;
    // The worker package holds the supervisor code: nothing the agent can write may contain or sit inside it.
    this.#protectedPaths = protectedPathsFor([...config.protectedPaths, SUPERVISOR_ROOT]);
    this.#clock = config.clock ?? (() => new Date().toISOString());
    this.#capacity = capacity;
  }

  static async create(config: LauncherConfig): Promise<SandboxLauncher> {
    if (config === null || typeof config !== "object" || !Array.isArray(config.protectedPaths) || typeof config.audit !== "function") {
      throw new SandboxError("invalid_recipe", "a launcher needs protectedPaths and an audit sink");
    }
    const platform = config.platform ?? process.platform;
    const backend = config.backend ?? defaultBackend(platform);
    const launcher = new SandboxLauncher(config, backend, { available: false, reason: "not checked yet", checkedAt: (config.clock ?? (() => new Date().toISOString()))() });
    await launcher.recheck();
    launcher.#limitCaps = config.limitCapabilities ?? await detectLimitCapabilities(platform);
    return launcher;
  }

  /** What the host may advertise: available only while the last health check passed. */
  get capacity(): Capacity { return this.#capacity; }

  /** Runs the health check again (after an update, a reboot or a failure) and returns the new capacity. */
  async recheck(): Promise<Capacity> {
    const checkedAt = this.#clock();
    if (this.#backend === undefined) {
      this.#capacity = { available: false, reason: `there is no sandbox backend for ${this.#config.platform ?? process.platform} yet`, checkedAt };
      return this.#capacity;
    }
    try {
      const health = await this.#backend.health();
      this.#capacity = health.healthy
        ? { available: true, backend: health.backend, ...(health.version === undefined ? {} : { version: health.version }), checkedAt }
        : { available: false, backend: health.backend, ...(health.version === undefined ? {} : { version: health.version }), reason: health.reason ?? "the health check failed", checkedAt };
    } catch (error) {
      this.#capacity = { available: false, backend: this.#backend.name, reason: `the health check failed: ${(error as Error).message}`, checkedAt };
    }
    return this.#capacity;
  }

  async launch(request: LaunchRequest): Promise<SandboxRun> {
    if (this.#stopped) throw new SandboxError("unavailable", "the launcher has been stopped");
    if (request === null || typeof request !== "object") throw new SandboxError("invalid_recipe", "a launch request is an object");
    const { command, timeoutMs, maxOutputBytes } = request;
    if (!Array.isArray(command) || command.length === 0 || command.some((a) => typeof a !== "string" || a.includes("\0"))) throw new SandboxError("invalid_recipe", "command: a non-empty list of strings");
    if (typeof command[0] === "string" && !command[0].startsWith("/")) throw new SandboxError("invalid_recipe", "command: the program must be an absolute path as the sandbox sees it");
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > MAX_TIMEOUT_MS) throw new SandboxError("invalid_recipe", "timeoutMs: a whole number from 1 ms to 24 hours");
    if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > MAX_OUTPUT_BYTES) throw new SandboxError("invalid_recipe", "maxOutputBytes: a whole number from 1 to 64 MiB");
    const recipe = normalizeRecipe(request.recipe, this.#protectedPaths);
    const limits = request.limits === undefined ? {} : checkLimits(request.limits);
    checkHeadroom(limits, this.#config.headroom ?? DEFAULT_HEADROOM);

    let makePlan: () => SpawnPlan;
    let backendName: string;
    let authority: string | undefined;
    if (recipe.mode === "trusted-host") {
      authority = this.#config.trustedHost?.authority;
      if (authority === undefined || authority.trim() === "") throw new SandboxError("not_authorized", "trusted-host mode is not enabled: the owner has configured no authority for it");
      backendName = "trusted-host";
      makePlan = () => ({ file: command[0]!, args: command.slice(1), env: { ...recipe.env, HOME: recipe.home, PATH: "/usr/bin:/bin", TMPDIR: recipe.scratch }, cwd: recipe.workdir });
    } else {
      if (this.#backend === undefined || !this.#capacity.available) throw new SandboxError("unavailable", `no confined launch is possible: ${this.#capacity.reason ?? "no capacity"}`);
      backendName = this.#backend.name;
      const backend = this.#backend;
      makePlan = () => backend.plan(recipe, command);
    }

    const runId = randomUUID();
    const caps = this.#limitCaps ?? { platform: this.#config.platform ?? process.platform, cgroupScope: false, prlimit: false, taskset: false, passEnv: {} };
    const limited = limitedPlan(makePlan(), limits, caps);
    if (request.requireEnforced === true) {
      const weak = limited.report.filter((r) => r.enforced !== "full");
      if (weak.length > 0) throw new SandboxError("unavailable", `these limits cannot be fully enforced on this host: ${weak.map((r) => `${r.limit} (${r.detail})`).join("; ")}`);
    }
    const record: LaunchRecord = {
      limits: limited.report,
      at: this.#clock(), runId, mode: recipe.mode, backend: backendName, recipeRevision: recipe.revision,
      commandDigest: sha256(canonical(command)), ...(authority === undefined ? {} : { authority }), unprotectedSubpaths: recipe.unprotectedSubpaths,
    };
    try { await this.#config.audit(record); } catch (error) { throw new SandboxError("audit_failed", `the launch could not be recorded, so it did not happen: ${(error as Error).message}`, { cause: error }); }
    // Planned only now, after the record is written, so the checks the plan repeats run as close to the start as possible.
    return this.#start(runId, recipe, limitedPlan(makePlan(), limits, caps).plan, recipe.mode === "sandboxed" ? this.#backend : undefined, timeoutMs, maxOutputBytes);
  }

  #start(runId: string, recipe: NormalizedRecipe, plan: SpawnPlan, backend: SandboxBackend | undefined, timeoutMs: number, maxOutputBytes: number): SandboxRun {
    const started = Date.now();
    const child = spawn(plan.file, [...plan.args], { env: { ...plan.env }, ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }), stdio: ["ignore", "pipe", "pipe"], detached: true, windowsHide: true });
    const chunks = { out: [] as Buffer[], err: [] as Buffer[] };
    const sizes = { out: 0, err: 0 };
    let truncated = false;
    const take = (which: "out" | "err") => (data: Buffer): void => {
      const room = maxOutputBytes - sizes[which];
      if (data.length > room) truncated = true;
      if (room > 0) { chunks[which].push(data.subarray(0, room)); sizes[which] += Math.min(room, data.length); }
    };
    child.stdout.on("data", take("out"));
    child.stderr.on("data", take("err"));
    let killed = false;
    let timedOut = false;
    let ended = false;
    const finalKill = (): void => {
      // The process group first (it holds the launcher's own children), then the child itself; a sandbox with a private process list ends with its first process.
      if (child.pid !== undefined) { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } }
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
    };
    // Without a private process list, every descendant seen while the run goes is remembered with its start time, so one whose parent has since exited (and was handed to launchd) is still
    // found at the end. A process id can be reused by an unrelated program, so a remembered process is ended only if it is still the one that was seen (same start time).
    const seen = new Map<number, string>();
    const track = async (): Promise<void> => {
      if (child.pid === undefined || backend?.descendants === undefined) return;
      for (const p of await backend.descendants(child.pid).catch(() => [] as readonly { pid: number; started: string }[])) seen.set(p.pid, p.started);
    };
    const sweep = async (): Promise<void> => {
      if (seen.size === 0 || backend?.startTimes === undefined) return;
      const now = await backend.startTimes([...seen.keys()]).catch(() => new Map<number, string>());
      for (const [p, started] of [...seen].reverse()) {
        if (now.get(p) === started) { try { process.kill(p, "SIGKILL"); } catch { /* already gone */ } }
      }
      seen.clear();
    };
    const poller = backend?.descendants === undefined ? undefined : setInterval(() => { void track(); }, 250);
    poller?.unref();
    const killTree = (): void => {
      if (ended) return;
      if (child.pid === undefined || backend?.descendants === undefined) { finalKill(); return; }
      void track().then(sweep).catch(() => undefined).finally(finalKill);
    };
    const timer = setTimeout(() => { timedOut = true; killTree(); }, timeoutMs);

    const result = new Promise<RunResult>((resolve) => {
      let settled = false;
      const finish = (exitCode: number | null, signal: string | null): void => {
        if (settled) return;
        settled = true;
        ended = true;
        clearTimeout(timer);
        if (poller !== undefined) clearInterval(poller);
        // Nothing the run started is left running after it; the result is given once that is done.
        // A process that outlived the run may still hold the output pipes; closing our ends lets the launcher's own process exit instead of waiting on it for ever.
        child.stdout.destroy(); child.stderr.destroy();
        void sweep().catch(() => undefined).then(() => resolve({ exitCode, signal, timedOut, killed, stdout: Buffer.concat(chunks.out).toString("utf8"), stderr: Buffer.concat(chunks.err).toString("utf8"), truncated, durationMs: Date.now() - started }));
      };
      child.once("close", finish);
      // A trusted-host child that started its own session can outlive its parent and keep the output pipes open; after a short drain the result is given anyway.
      child.once("exit", (code, signal) => { setTimeout(() => finish(code, signal), EXIT_DRAIN_MS).unref(); });
      child.once("error", (error) => { ended = true; clearTimeout(timer); if (poller !== undefined) clearInterval(poller); resolve({ exitCode: null, signal: null, timedOut, killed, stdout: "", stderr: `could not start: ${error.message}`, truncated: false, durationMs: Date.now() - started }); });
    });
    const guest: GuestView = backend?.guestView(recipe) ?? { workdir: recipe.workdir, home: recipe.home, scratch: recipe.scratch, tmp: recipe.scratch, inputs: recipe.readOnly.map((m) => ({ host: m.host, guest: m.host })) };
    const run: SandboxRun = { runId, mode: recipe.mode, recipeRevision: recipe.revision, guest, kill: () => { killed = true; killTree(); }, result };
    this.#live.add(run);
    void result.then(() => this.#live.delete(run));
    return run;
  }

  /** Kills every run still going and refuses new launches. */
  async stop(): Promise<void> {
    this.#stopped = true;
    const live = [...this.#live];
    for (const run of live) run.kill();
    await Promise.all(live.map((r) => r.result));
  }
}
