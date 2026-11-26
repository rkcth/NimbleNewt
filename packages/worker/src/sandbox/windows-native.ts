import { createServer } from "node:net";
import { randomUUID } from "node:crypto";
import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { FILE_CHANNEL_DEFAULTS, FILE_CHANNEL_ENV } from "@nimblenewt/contracts";
import type { BackendHealth, GuestView, PlanOptions, SandboxBackend, SpawnPlan } from "./backend.js";
import { SandboxError } from "./errors.js";
import type { NormalizedRecipe } from "./recipe.js";
import type { ChannelJob } from "./windows-native-channel.js";
import { jobFile, jobsDir, probeProfile, runNativeJob, runProfileFor, sweepLeftoversLocked, type NativeHost, type NativeJob } from "./windows-native-job.js";
import { nativeRealHost } from "./windows-native-real.js";
import {
  DEFAULT_JOB_LIMITS, DEFAULT_MAX_CONCURRENT_RUNS, EXIT_BUSY, LPAC_CAPABILITIES, MAX_CONCURRENT_RUNS_LIMIT, MAX_RUN_MS, NATIVE_BACKEND_NAME, NATIVE_MODE, REFUSED_ROUTE,
  checkNativeRecipe, checkProgramFolder, grantsFor, isWindowStationMode, launcherArgs, nativeEnv, newRunProfileName, programPath,
  type ContainerKind, type NativeSettings,
} from "./windows-native-plan.js";
import { checkWindowsHostPath, overlapsWin } from "./windows-plan.js";

export interface WindowsNativeOptions {
  /** Default: the real Windows implementation. */
  readonly host?: NativeHost;
  /** The launcher program the administrator's install step placed (outside every folder a container can write). */
  readonly launcher: string;
  /** The supervisor's folder: job files, records, the run lock. Never granted to the container. */
  readonly controlDir: string;
  /** Where the health probe's folders go (the probe's task folders are container-writable, so they sit apart from `controlDir`). Default: `<controlDir>-probe`. */
  readonly probeDir?: string;
  readonly nodeExecutable?: string;
  /** Read-and-execute folders besides the task's (soft grants). Default: the folder of the Node program. */
  readonly programFolders?: readonly string[];
  /** The runner script and the node program that runs it. */
  readonly runnerScript?: string;
  /** `lpac` (default: the less privileged container with registryRead and lpacCom) or `appcontainer` (the plain one, the fallback if a later run shows the LPAC unusable). */
  readonly container?: ContainerKind;
  /** RETIRED: every run makes its own container profile (`NimbleNewtRun-<hex>`) and the launcher accepts no other name. Giving this is refused. */
  readonly profileName?: string;
  /** How many confined runs may be in progress at once (1..MAX_CONCURRENT_RUNS_LIMIT). Default 1: one at a time, exactly the behaviour before per-run profiles. More than 1 is UNMEASURED on real Windows (windows-isolation-plan.md 12.4). Two runs never share a workspace. */
  readonly maxConcurrentRuns?: number;
  /** The value of the retired NIMBLENEWT_WIN_PROFILE setting when the environment still carries one (the installer writes it): ignored, and said so in the health notes. */
  readonly ignoredProfileSetting?: string;
  readonly memoryMb?: number;
  readonly activeProcesses?: number;
  readonly maxRunMs?: number;
  /** Refuse unless the task's volumes are NTFS (default true; a test stand-in turns it off). */
  readonly requireNtfs?: boolean;
  /** Bounds of the controller's channel for a streamed run (card A03b, slice 4). Defaults: `FILE_CHANNEL_DEFAULTS`. Tests use small ones. */
  readonly channelLimits?: Partial<Pick<ChannelJob, "maxBytes" | "maxFrames" | "maxPayload" | "windowBytes" | "heartbeatMs" | "stallMs">>;
}

const bad = (message: string): never => { throw new SandboxError("invalid_recipe", message); };
const PROBE_MS_CACHE = 60_000;

/** The probe program the container runs: it must be able to write its own folder and nothing else (outside file, the protected folder, a rename of it, a connection to the host's listener). */
export const PROBE_SCRIPT = [
  'import { writeFileSync, renameSync } from "node:fs";',
  'import { connect } from "node:net";',
  "const [work, outside, port] = process.argv.slice(2);",
  "const failed = [];",
  'try { writeFileSync(work + "\\\\ok.txt", "x"); } catch { failed.push("own-write"); }',
  'try { writeFileSync(outside, "x"); failed.push("outside-write"); } catch { /* refused: wanted */ }',
  'try { writeFileSync(work + "\\\\.git\\\\denied.txt", "x"); failed.push("protected-write"); } catch { /* refused: wanted */ }',
  'try { renameSync(work + "\\\\.git", work + "\\\\.git-moved"); failed.push("protected-rename"); } catch { /* refused: wanted */ }',
  'const done = () => { console.log(failed.length === 0 ? "confined" : "FAIL " + failed.join(",")); process.exit(0); };',
  'const s = connect(Number(port), "127.0.0.1");',
  's.on("connect", () => { failed.push("network"); s.destroy(); done(); });',
  's.on("error", done);',
  "setTimeout(done, 4000);",
  "",
].join("\n");

/** A backend that never has capacity, carrying the reason (a configuration problem becomes a refusal that names it, never a throw and never an unconfined run). */
export function unavailableNative(reason: string): SandboxBackend {
  return {
    name: NATIVE_BACKEND_NAME,
    health: async (): Promise<BackendHealth> => ({ healthy: false, backend: NATIVE_BACKEND_NAME, reason }),
    plan: () => { throw new SandboxError("unavailable", reason); },
    guestView: (recipe) => ({ workdir: recipe.workdir, home: recipe.home, scratch: recipe.scratch, tmp: recipe.scratch, inputs: [] }),
  };
}

/**
 * The Windows backend (card A03b): the native launcher. One confined program per task in an AppContainer (the less privileged kind) inside a Job Object, with explicit access-list entries for the container's
 * SID only on the task's folders and no network capability. Process-level confinement, weaker than Linux's (as macOS's is), no virtual machine, no Windows Sandbox and no prompt at run time; the one
 * administrator step (placing the launcher, creating the service account, granting it the folders' rights) is a documented install action that this backend never repeats. Every run goes through a supervisor
 * runner that lives outside every folder the container can write.
 */
export function windowsNativeBackend(options: WindowsNativeOptions): SandboxBackend {
  const host = options.host ?? nativeRealHost();
  const env = (n: string): string | undefined => host.env(n);
  const container: ContainerKind = options.container ?? "lpac";
  if (container !== "lpac" && container !== "appcontainer") bad(`container: "lpac" or "appcontainer", not ${String(container)}`);
  const controlDir = checkWindowsHostPath("controlDir", options.controlDir, env);
  const probeDir = checkWindowsHostPath("probeDir", options.probeDir ?? `${controlDir}-probe`, env);
  const launcher = checkProgramFolder("launcher", options.launcher);
  const nodeExecutable = checkProgramFolder("nodeExecutable", options.nodeExecutable ?? process.execPath);
  const runnerScript = checkProgramFolder("runnerScript", options.runnerScript ?? fileURLToPath(new URL("./windows-native-runner.js", import.meta.url)));
  const supervisor = { supervisor: [win32.dirname(runnerScript), win32.dirname(launcher)] };
  if (overlapsWin(controlDir, probeDir)) bad("controlDir and probeDir overlap: the supervisor's files may not sit in container-writable probe folders");
  for (const p of supervisor.supervisor) if (overlapsWin(p, probeDir)) bad(`the supervisor's code (${p}) may not sit in the probe's container-writable folder (${probeDir})`);
  if (options.profileName !== undefined) bad("profileName: retired; every run makes its own container profile (NimbleNewtRun-<hex>) and the launcher accepts no other name");
  const maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
  if (!Number.isSafeInteger(maxConcurrentRuns) || maxConcurrentRuns < 1 || maxConcurrentRuns > MAX_CONCURRENT_RUNS_LIMIT) bad(`maxConcurrentRuns: a whole number from 1 to ${MAX_CONCURRENT_RUNS_LIMIT} (default ${DEFAULT_MAX_CONCURRENT_RUNS}; more than 1 is unmeasured on real Windows)`);
  const memoryMb = options.memoryMb ?? DEFAULT_JOB_LIMITS.memoryMb;
  const activeProcesses = options.activeProcesses ?? DEFAULT_JOB_LIMITS.activeProcesses;
  const maxRunMs = options.maxRunMs ?? MAX_RUN_MS;
  for (const [n, v, lo, hi] of [["memoryMb", memoryMb, 16, 4_194_304], ["activeProcesses", activeProcesses, 1, 100_000], ["maxRunMs", maxRunMs, 1000, MAX_RUN_MS]] as const) {
    if (!Number.isSafeInteger(v) || v < lo || v > hi) bad(`${n}: a whole number from ${lo} to ${hi}`);
  }
  const settings: NativeSettings = {
    launcher, controlDir, nodeExecutable, programFolders: (options.programFolders ?? [win32.dirname(nodeExecutable)]).map((f) => checkProgramFolder("program folder", f)),
    systemRoot: env("SystemRoot") ?? "C:\\Windows", container, maxConcurrentRuns, memoryMb, activeProcesses, maxRunMs,
  };
  for (const f of settings.programFolders) for (const g of [controlDir, probeDir]) if (overlapsWin(f, g)) bad(`program folder ${f} overlaps the supervisor's or the probe's folder ${g}`);
  const requireNtfs = options.requireNtfs ?? true;
  let lastHealthy = 0;

  const guestView = (recipe: NormalizedRecipe): GuestView => ({ workdir: recipe.workdir, home: recipe.home, scratch: recipe.scratch, tmp: recipe.scratch, inputs: recipe.readOnly.map((m) => ({ host: m.host, guest: m.host })) });

  const channelLimits = { ...FILE_CHANNEL_DEFAULTS, ...options.channelLimits };
  for (const [n, v] of Object.entries({ maxBytes: channelLimits.maxBytes, maxFrames: channelLimits.maxFrames, maxPayload: channelLimits.maxPayload, windowBytes: channelLimits.windowBytes, heartbeatMs: channelLimits.heartbeatMs, stallMs: channelLimits.stallMs })) {
    if (!Number.isSafeInteger(v) || v < 1) bad(`channelLimits.${n}: a whole number of at least 1`);
  }
  if (channelLimits.windowBytes < channelLimits.maxPayload * 2) bad("channelLimits.windowBytes: at least twice maxPayload (one longest line must never wait on its own acknowledgement)");

  /** The channel of a streamed run: a folder in the task's scratch (container-writable already) with the two files; their paths reach the worker as environment variables. */
  const channelFor = (recipe: NormalizedRecipe, runId: string): ChannelJob => {
    const dir = `${recipe.scratch}\\.nn-ch-${runId.slice(0, 12)}`;
    return { dir, inbox: `${dir}\\to-worker.nnc`, outbox: `${dir}\\from-worker.nnc`, maxBytes: channelLimits.maxBytes, maxFrames: channelLimits.maxFrames, maxPayload: channelLimits.maxPayload, windowBytes: channelLimits.windowBytes, heartbeatMs: channelLimits.heartbeatMs, stallMs: channelLimits.stallMs };
  };

  const buildJob = (recipe: NormalizedRecipe, command: readonly string[], runId: string, jobDir: string, settingsNow: NativeSettings = settings, interactive = false): NativeJob => {
    checkNativeRecipe(recipe, settingsNow, supervisor, env, (p) => host.isLinkOrJunction(p));
    const program = command[0];
    if (program === undefined) return bad("command: a program is needed");
    const exe = programPath(recipe, program, settingsNow.systemRoot);
    const grants = grantsFor(recipe, settingsNow, supervisor);
    const files = { input: `${jobDir}\\in.txt`, out: `${jobDir}\\out.txt`, err: `${jobDir}\\err.txt` };
    // This run's own container profile: a name nobody has used (64 random bits), chosen here and only validated by the launcher.
    const profile = runProfileFor(settingsNow, newRunProfileName());
    const channel = interactive ? channelFor(recipe, runId) : undefined;
    const childEnv = nativeEnv(recipe, settingsNow, (h) => host.isDirectory(h));
    // Set last: nothing the recipe says can name another file for the worker's channel.
    if (channel !== undefined) Object.assign(childEnv, { [FILE_CHANNEL_ENV.inbox]: channel.inbox, [FILE_CHANNEL_ENV.outbox]: channel.outbox, [FILE_CHANNEL_ENV.maxBytes]: String(channel.maxBytes), [FILE_CHANNEL_ENV.maxPayload]: String(channel.maxPayload), [FILE_CHANNEL_ENV.stallMs]: String(channel.stallMs) });
    return {
      version: 1, runId, settings: settingsNow, grants, args: launcherArgs(recipe, exe, command.slice(1), settingsNow, grants, files, childEnv, profile), files, workdir: recipe.workdir, profile,
      claim: [recipe.workdir, recipe.home, recipe.scratch],
      volumes: [recipe.workdir, recipe.home, recipe.scratch, ...recipe.readOnly.map((m) => m.host)], requireNtfs, ...(channel === undefined ? {} : { channel }),
    };
  };

  const plan = (recipe: NormalizedRecipe, command: readonly string[], runId?: string, planOptions?: PlanOptions): SpawnPlan => {
    if (host.platform !== "win32") throw new SandboxError("unavailable", "the native Windows launcher exists only on Windows");
    if (recipe.route !== undefined) bad(REFUSED_ROUTE);
    const id = runId !== undefined && /^[A-Za-z0-9-]{8,64}$/.test(runId) ? runId : randomUUID();
    const jobDir = `${jobsDir(settings)}\\${id}`;
    const job = buildJob(recipe, command, id, jobDir, settings, planOptions?.interactive === true);
    host.mkdirp(jobDir);
    host.writeText(jobFile(jobDir), JSON.stringify(job));
    // The runner's own temporary folder is the supervisor's (inside the control directory), never shared with the container.
    const runnerTemp = `${controlDir}\\tmp`;
    host.mkdirp(runnerTemp);
    const passed: Record<string, string> = {};
    for (const name of ["SystemRoot", "windir"]) { const v = env(name); if (v !== undefined) passed[name] = v; }
    return { file: nodeExecutable, args: [runnerScript, jobFile(jobDir)], env: { ...passed, TEMP: runnerTemp, TMP: runnerTemp, NIMBLENEWT_NATIVE_JOB: jobDir }, cwd: controlDir };
  };

  const checkHealth = async (): Promise<BackendHealth> => {
    const notes = [`mode: ${NATIVE_MODE}`, "the service-account launch from Session 0 with nobody signed in, a non-administrator account, the file relay for the controller's channel inside a real container and Windows Home are not yet proven",
      `each run makes and deletes its own container profile (NimbleNewtRun-<hex>); the cost of that and of the check that the profile is gone are not measured on real Windows; ${maxConcurrentRuns === 1 ? "one confined run at a time" : `up to ${maxConcurrentRuns} confined runs at once (different workspaces only; UNMEASURED on real Windows)`}`];
    if (options.ignoredProfileSetting !== undefined) notes.push("NIMBLENEWT_WIN_PROFILE is set but retired: each run uses its own profile, so the setting is ignored");
    const no = (reason: string): BackendHealth => ({ healthy: false, backend: NATIVE_BACKEND_NAME, reason, notes });
    if (host.platform !== "win32") return no(`the native Windows launcher exists only on Windows, not ${host.platform}`);
    if (!host.exists(launcher)) return no(`the launcher was not found at ${launcher}: the administrator's one-time install step has not been done`);
    if (!host.exists(runnerScript)) return no(`the supervisor's runner script was not found at ${runnerScript}`);
    try { host.mkdirp(controlDir); host.mkdirp(probeDir); } catch (error) { return no(`the supervisor's folders could not be made: ${(error as Error).message}`); }
    if (requireNtfs) {
      for (const v of [controlDir, probeDir]) { const fs = await host.fileSystemOf(v); if (fs === undefined || fs.toUpperCase() !== "NTFS") return no(`${v} is not on NTFS (${fs ?? "unreadable"}); folder grants need NTFS`); }
    }
    const swept = await sweepLeftoversLocked(host, settings);
    if (swept.problems.length > 0) return no(`a run left access-list entries behind and they could not be undone: ${swept.problems.join("; ")}`);
    // The launcher's `info` makes a throw-away per-run profile exactly as a run does, asks the private-window-station question and deletes the profile; a profile that cannot be shown gone is a health failure.
    const probe = await probeProfile(host, settings, newRunProfileName());
    if (probe.error !== undefined) return no(`the launcher could not be run: ${probe.error}`);
    const info = probe.line;
    // A launcher that cannot make the private window station each run needs says so itself (stage "grant", message "window objects: ..."): a service on a host that refuses it would otherwise fail
    // the confinement probe below with an exit code only.
    if (info !== undefined && !info.ok && info.windowStationOk === false) return no(`the launcher could not make a private window station and desktop for the container (${info.windowStationError ?? info.error ?? "no reason given"})`);
    if (info === undefined || !info.ok) return no(`the launcher could not make the container profile (${info?.error ?? "no answer"})`);
    if (probe.problem !== undefined) return no(`the probe's container profile could not be deleted: ${probe.problem}`);
    // A mode this backend does not know is refused (fail closed), whatever else the line says: the launcher must name one of the two private modes, or (an older launcher) nothing at all.
    if (info.windowStation !== undefined && !isWindowStationMode(info.windowStation)) return no(`the launcher reported a window-object mode this backend does not know ("${info.windowStation}")`);
    if (info.windowStationOk === true && info.windowStation === "home-desktop") notes.push(`each run gets a private DESKTOP on the user's own window station (WinSta0), made with its final access list (the launcher made and closed one now; the named private window station was refused: ${info.privateStationError ?? "no reason given"}). The clipboard and the atom table of that station stay shared with the signed-in session (an accepted exposure, owner decision 2026-11-26); the desktop closes the window list, the foreground window, the cursor and the screen pixels`);
    else if (info.windowStationOk === true && info.windowStation === "private") notes.push("each run gets a private window station and desktop made for it (the launcher made and closed one now)");
    else if (info.windowStationOk === true) notes.push("the launcher made and closed its window objects now but did not name their mode (an older launcher): which of the two private modes a run gets is not known");

    // The real test: a node program is started inside the container and asked to do what it must not be able to.
    const nonce = randomUUID();
    const root = `${probeDir}\\p-${nonce}`;
    const dirs = { work: `${root}\\work`, home: `${root}\\home`, scratch: `${root}\\scratch`, tools: `${root}\\tools`, outside: `${root}\\outside` };
    let hits = 0;
    const listener = createServer((socket) => { hits++; socket.destroy(); });
    try {
      host.remove(root);
      for (const d of [dirs.work, `${dirs.work}\\.git`, dirs.home, dirs.scratch, dirs.tools, dirs.outside]) host.mkdirp(d);
      host.writeText(`${dirs.tools}\\probe.mjs`, PROBE_SCRIPT);
      await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(0, "127.0.0.1", resolve); });
      const port = (listener.address() as { port: number }).port;
      const outsideFile = `${dirs.outside}\\denied.txt`;
      const recipe: NormalizedRecipe = {
        mode: "sandboxed", workdir: dirs.work, home: dirs.home, scratch: dirs.scratch, network: "none", env: {}, protectedSubpaths: [".git"], unprotectedSubpaths: [], revision: "probe",
        readOnly: [{ host: dirs.tools, guest: "/inputs/probe" }, { host: win32.dirname(nodeExecutable), guest: "/opt/node" }],
      };
      const runId = `probe-${nonce}`;
      const dir = `${jobsDir(settings)}\\${runId}`;
      host.mkdirp(dir);
      const job = buildJob(recipe, [`/opt/node/${win32.basename(nodeExecutable)}`, `${dirs.tools}\\probe.mjs`, dirs.work, outsideFile, String(port)], runId, dir, { ...settings, programFolders: [] });
      host.writeText(jobFile(dir), JSON.stringify(job));
      const out = await runNativeJob(host, job, undefined, dir);
      host.remove(dir);
      if (out.exitCode === EXIT_BUSY) return Date.now() - lastHealthy < PROBE_MS_CACHE ? { healthy: true, backend: NATIVE_BACKEND_NAME, notes: [...notes, "a run is in progress; the last confinement probe still stands"] } : no("a run is in progress, so the confinement probe could not be repeated");
      if (out.exitCode !== 0 || !out.stdout.includes("confined")) return no(`the confinement probe failed: ${(out.stderr.split("\n")[0] ?? "").slice(0, 300) || out.stdout.trim().slice(0, 300) || `exit ${out.exitCode}`}`);
      if (hits > 0) return no("the confinement probe's program connected to a listener on the host's loopback");
      if (!host.exists(`${dirs.work}\\ok.txt`) || host.exists(outsideFile) || host.exists(`${dirs.work}\\.git\\denied.txt`) || !host.exists(`${dirs.work}\\.git`)) return no("the confinement probe passed in the container but the host does not show the expected files");
      lastHealthy = Date.now();
      return { healthy: true, backend: NATIVE_BACKEND_NAME, notes };
    } catch (error) {
      return no(`the confinement probe could not run: ${(error as Error).message}`);
    } finally {
      await new Promise<void>((resolve) => { listener.close(() => resolve()); });
      host.remove(root);
    }
  };

  // One health check at a time: two at once would share the run lock and the probe's folders.
  let queue: Promise<unknown> = Promise.resolve();
  const health = (): Promise<BackendHealth> => { const next = queue.then(checkHealth, checkHealth); queue = next.catch(() => undefined); return next; };

  return {
    name: NATIVE_BACKEND_NAME,
    // A streamed run (a program that talks to the controller over standard input and output) cannot be given pipes inside the container (every pipe start hung in the measured run), so the supervisor relays the
    // controller's lines through two files (windows-native-channel.ts; card A03b, slice 4). True because that relay is wired end to end through `runNativeJob` and tested with a simulated launcher; how a REAL
    // container treats the files (its read and append access, sharing, caching) is not measured.
    interactiveInput: true,
    plan,
    guestView,
    health,
    auditDetails: () => ({
      windowsMode: "native",
      nativeMode: NATIVE_MODE,
      strength: "process-level, weaker than Linux",
      container: container === "lpac" ? `lpac (capabilities: ${LPAC_CAPABILITIES.join(", ")}; no network capability)` : "appcontainer (no capability)",
      network: "none (no network capability, no loopback exemption)",
      jobLimits: `kill-on-close, memory ${memoryMb} MB, ${activeProcesses} active processes`,
      standardHandles: "files (never the NUL device, never a pipe made inside the container)",
      grants: "the run's own container SID only; task folders required, program folders soft (a refused one is recorded)",
      profile: "one container profile per run, NimbleNewtRun-<64 random bits as hex>, made by the launcher with a record written first, deleted and checked after the run; leftovers are swept from the backend's own records",
      concurrency: maxConcurrentRuns === 1 ? "one confined run at a time (default)" : `up to ${maxConcurrentRuns} confined runs at once, never in the same or an overlapping workspace; unmeasured on real Windows`,
      channel: "streamed runs: the supervisor relays the controller's lines through two files (poll with offsets); the container's own file semantics are unmeasured",
      unproven: "service-account launch in Session 0, non-administrator account, the file relay inside a real container, Windows Home",
    }),
    async descendants(pid: number): Promise<readonly { pid: number; started: string }[]> {
      try {
        const all = (await host.processes()) ?? [];
        const children = new Map<number, { pid: number; started: string }[]>();
        for (const p of all) children.set(p.parent, [...(children.get(p.parent) ?? []), { pid: p.pid, started: p.started }]);
        const found: { pid: number; started: string }[] = [];
        for (const queue2 = [pid]; queue2.length > 0;) { const next = queue2.shift()!; for (const c of children.get(next) ?? []) { found.push(c); queue2.push(c.pid); } }
        return found;
      } catch { return []; }
    },
    async startTimes(pids: readonly number[]): Promise<ReadonlyMap<number, string>> {
      const times = new Map<number, string>();
      try { for (const p of (await host.processes()) ?? []) if (pids.includes(p.pid)) times.set(p.pid, p.started); } catch { /* nothing known: nothing will be ended */ }
      return times;
    },
    async release(spawnPlan: SpawnPlan): Promise<void> {
      const jobDir = spawnPlan.env["NIMBLENEWT_NATIVE_JOB"];
      if (jobDir === undefined || !overlapsWin(jobDir, jobsDir(settings)) || jobDir === jobsDir(settings)) return;
      const result = await sweepLeftoversLocked(host, settings, jobDir);
      if (result.problems.length > 0) throw new Error(`native Windows cleanup incomplete: ${result.problems.join("; ")}`);
    },
  };
}

/**
 * The backend Windows uses by default (the join point the containment suite and the launcher call): the native one, configured from the environment the administrator's install step sets
 * (NIMBLENEWT_WIN_LAUNCHER, NIMBLENEWT_WIN_CONTROL_DIR, NIMBLENEWT_WIN_CONTAINER = lpac or appcontainer; NIMBLENEWT_WIN_PROFILE is read and ignored: every run has its own profile; and the operator's own
 * NIMBLENEWT_WIN_MAX_RUNS, the number of runs at once, default 1, not written by the installer). Never throws: where it cannot be configured, or off Windows, it has no
 * capacity and says why, so nothing runs unconfined instead. Windows Sandbox is no longer selected here.
 */
export function windowsDefaultBackend(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): SandboxBackend {
  if (platform !== "win32") return unavailableNative(`the native Windows launcher exists only on Windows, not ${platform}`);
  try {
    const programFiles = env["ProgramFiles"] ?? "C:\\Program Files";
    const programData = env["ProgramData"] ?? "C:\\ProgramData";
    const kind = env["NIMBLENEWT_WIN_CONTAINER"];
    if (kind !== undefined && kind !== "" && kind !== "lpac" && kind !== "appcontainer") return unavailableNative(`NIMBLENEWT_WIN_CONTAINER must be lpac or appcontainer, not ${kind}`);
    const rawMax = env["NIMBLENEWT_WIN_MAX_RUNS"];
    const maxRuns = rawMax === undefined || rawMax === "" ? undefined : /^[0-9]{1,3}$/.test(rawMax) ? Number(rawMax) : Number.NaN;
    if (maxRuns !== undefined && !(maxRuns >= 1 && maxRuns <= MAX_CONCURRENT_RUNS_LIMIT)) return unavailableNative(`NIMBLENEWT_WIN_MAX_RUNS must be a whole number from 1 to ${MAX_CONCURRENT_RUNS_LIMIT}, not ${rawMax}`);
    return windowsNativeBackend({
      launcher: env["NIMBLENEWT_WIN_LAUNCHER"] || win32.join(programFiles, "NimbleNewt", "nn-launcher.exe"),
      controlDir: env["NIMBLENEWT_WIN_CONTROL_DIR"] || win32.join(programData, "NimbleNewt", "native"),
      ...(kind === "lpac" || kind === "appcontainer" ? { container: kind } : {}),
      ...(env["NIMBLENEWT_WIN_PROFILE"] ? { ignoredProfileSetting: env["NIMBLENEWT_WIN_PROFILE"] } : {}),
      ...(maxRuns === undefined ? {} : { maxConcurrentRuns: maxRuns }),
    });
  } catch (error) {
    return unavailableNative(`the native Windows backend could not be configured: ${(error as Error).message}`);
  }
}
