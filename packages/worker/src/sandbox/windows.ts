import { win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { BackendHealth, GuestView, SandboxBackend, SpawnPlan } from "./backend.js";
import { SandboxError } from "./errors.js";
import type { NormalizedRecipe } from "./recipe.js";
import { randomUUID } from "node:crypto";
import { EXIT_BUSY, jobDirFor, jobFile, lockFile, releaseJob, runWindowsJob, type WindowsJob } from "./windows-job.js";
import type { WindowsHost } from "./windows-host.js";
import {
  AUTOLOGON_ACKNOWLEDGEMENT, DEFAULT_MIN_VERSION, GUEST_PATHS, LOCK_TASK_NAME, MICROSOFT_PUBLISHER_ID, SANDBOX_PACKAGE, VM_FALLBACK_DECISION,
  capabilityNotes, checkIdentity, checkWindowsHostPath, checkWindowsProgramPath, compareVersions, guestCommand, guestPathFor, launchScript, overlapsWin, sameAccount, sharesFor, verifyClient, verifySession,
  type WindowsMode, type WindowsSettings,
} from "./windows-plan.js";

export { AUTOLOGON_ACKNOWLEDGEMENT, VM_FALLBACK_DECISION } from "./windows-plan.js";

/** The owner's explicit opt-in to auto-login and lock. Absent means the mode is off: it is never a default. */
export interface AutologonOptIn {
  /** Who decided: recorded in every launch record. */
  readonly authority: string;
  /** Must be exactly AUTOLOGON_ACKNOWLEDGEMENT. */
  readonly acknowledgement: string;
  /** The protected program that the lock task runs; verified to be writable only by administrators. */
  readonly lockHelper: string;
  readonly lockTask?: string;
}

export interface WindowsSandboxOptions {
  /** Default: the real Windows implementation (windows-real.ts). */
  readonly host: WindowsHost;
  /** Supervisor-owned: job files and the sandbox lock. */
  readonly controlDir: string;
  /** Where the supervisor's probe folders go: guest-writable staging, kept apart from everything else. */
  readonly stagingDir: string;
  /** The one account the Sandbox service uses to reach mapped folders. Granted per job, removed afterwards. */
  readonly shareIdentity: string;
  /** The account expected to be signed in at the console. */
  readonly owner: string;
  /** Explicit opt-in to the auto-login and lock mode. Absent: the owner-session mode. */
  readonly autologonLock?: AutologonOptIn;
  readonly minVersion?: string;
  /** The runner script (supervisor code) and the node program that runs it. */
  readonly runnerScript?: string;
  readonly nodeExecutable?: string;
  /** `strict` (default) refuses when the supervisor's folders are writable by the share identity or a broad group. `report-only` is for a developer's checkout and records that it is relaxed. */
  readonly supervisorAcl?: "strict" | "report-only";
}

const bad = (message: string): never => { throw new SandboxError("invalid_recipe", message); };
const ENV_PASSED = ["SystemRoot", "SystemDrive", "windir", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "ProgramData", "ComSpec"];
const PROBE_MS_CACHE = 60_000;

const PROBE_SCRIPT = [
  "@echo off",
  `echo x> ${GUEST_PATHS.work}\\ok.txt`, "if errorlevel 1 exit /b 11",
  `echo x> ${GUEST_PATHS.work.replace("work", "inputs")}\\probe\\denied.txt 2>nul`, "if not errorlevel 1 exit /b 12",
  `echo x> ${GUEST_PATHS.work}\\.git\\denied.txt 2>nul`, "if not errorlevel 1 exit /b 13",
  `"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -Command "try { $c = New-Object Net.Sockets.TcpClient; $c.Connect('1.1.1.1',443); exit 14 } catch { exit 0 }"`, "if errorlevel 1 exit /b 14",
  "echo confined", "",
].join("\r\n");

/**
 * The Windows backend (card A03b): Windows Sandbox through its `wsb` client. Each job gets a fresh sandbox with no network and only its listed folders, started and ended by a
 * supervisor runner process that lives outside everything the guest can write. It is session-dependent: it works only while the owner is signed in at the console (or, by the
 * owner's explicit opt-in, in the auto-login and lock mode), and says so in its health result and every launch record.
 */
export function windowsSandboxBackend(options: WindowsSandboxOptions): SandboxBackend {
  const host = options.host;
  const env = (n: string): string | undefined => host.env(n);
  const mode: WindowsMode = options.autologonLock === undefined ? "owner-session" : "autologon-lock";
  if (options.autologonLock !== undefined) {
    const o = options.autologonLock;
    if (o.acknowledgement !== AUTOLOGON_ACKNOWLEDGEMENT) bad("autologonLock: the acknowledgement sentence is missing or changed; the auto-login and lock mode is only enabled by the owner's explicit opt-in");
    if (typeof o.authority !== "string" || o.authority.trim() === "") bad("autologonLock: the owner's authority for this mode must be named");
    checkWindowsProgramPath("autologonLock.lockHelper", o.lockHelper);
  }
  const controlDir = checkWindowsHostPath("controlDir", options.controlDir, env);
  const stagingDir = checkWindowsHostPath("stagingDir", options.stagingDir, env);
  const runnerScript = options.runnerScript ?? fileURLToPath(new URL("./windows-runner.js", import.meta.url));
  checkWindowsProgramPath("runnerScript", runnerScript);
  const supervisorPaths = [win32.dirname(runnerScript)];
  if (overlapsWin(controlDir, stagingDir)) bad("controlDir and stagingDir overlap: the supervisor's files may not sit in guest-writable staging");
  for (const p of supervisorPaths) if (overlapsWin(p, stagingDir)) bad(`the supervisor's code (${p}) may not sit in guest-writable staging (${stagingDir})`);
  const minVersion = options.minVersion ?? DEFAULT_MIN_VERSION;
  compareVersions(minVersion, "0.0");
  const settings: WindowsSettings = {
    controlDir, shareIdentity: checkIdentity("shareIdentity", options.shareIdentity), owner: checkIdentity("owner", options.owner), minVersion, packageName: SANDBOX_PACKAGE, publisherId: MICROSOFT_PUBLISHER_ID, mode,
    lockTask: options.autologonLock?.lockTask ?? LOCK_TASK_NAME, ...(options.autologonLock === undefined ? {} : { lockHelper: options.autologonLock.lockHelper }),
  };
  const aclPolicy = options.supervisorAcl ?? "strict";
  const node = options.nodeExecutable ?? "C:\\Program Files\\nodejs\\node.exe";
  let clientVersion = "unverified";
  let lastHealthy = 0;

  const guestView = (recipe: NormalizedRecipe): GuestView => ({
    workdir: GUEST_PATHS.work, home: GUEST_PATHS.home, scratch: GUEST_PATHS.scratch, tmp: GUEST_PATHS.tmp,
    inputs: recipe.readOnly.map((m) => ({ host: m.host, guest: guestPathFor(m.guest) ?? m.guest })),
  });

  const plan = (recipe: NormalizedRecipe, command: readonly string[], runId?: string): SpawnPlan => {
    if (host.platform !== "win32") throw new SandboxError("unavailable", "Windows Sandbox exists only on Windows");
    const jobDir = jobDirFor(settings, runId);
    // Everything the guest will be given is checked here, before a job file exists.
    guestCommand(command);
    launchScript(recipe, command);
    const shares = sharesFor(recipe, `${jobDir}\\guest`);
    shares.forEach((s) => { if (s.why !== "job") { checkWindowsHostPath(`share ${s.guest}`, s.host, env); if (host.isLinkOrJunction(s.host)) bad(`${s.host} is a link or junction; give the real path`); } });
    const real = shares.filter((s) => s.why !== "job" && s.why !== "protected");
    for (let i = 0; i < real.length; i++) for (let j = i + 1; j < real.length; j++) if (overlapsWin(real[i]!.host, real[j]!.host)) bad(`${real[i]!.guest} and ${real[j]!.guest} overlap on the host (${real[i]!.host} and ${real[j]!.host})`);
    for (const s of real) for (const p of [controlDir, ...supervisorPaths]) if (overlapsWin(s.host, p)) bad(`${s.host} overlaps the supervisor's own files (${p})`);
    const job: WindowsJob = { version: 1, settings, recipe, command };
    host.mkdirp(jobDir);
    host.writeText(jobFile(jobDir), JSON.stringify(job));
    const passed: Record<string, string> = {};
    for (const name of ENV_PASSED) { const v = env(name); if (v !== undefined) passed[name] = v; }
    return { file: node, args: [runnerScript, jobFile(jobDir)], env: { ...passed, NIMBLENEWT_WSB_JOB: jobDir }, cwd: controlDir };
  };

  const checkHealth = async (): Promise<BackendHealth> => {
    const notes = capabilityNotes(settings);
    const no = (reason: string): BackendHealth => ({ healthy: false, backend: "windows-sandbox", ...(clientVersion === "unverified" ? {} : { version: clientVersion }), reason, notes });
    if (host.platform !== "win32") return no(`Windows Sandbox exists only on Windows, not ${host.platform}`);
    const client = await verifyClient(host, settings);
    if (!client.ok) return no(client.reason);
    clientVersion = client.value.package.version;
    const session = await verifySession(host, settings);
    if (!session.ok) return no(session.reason);
    // The supervisor's files must not be writable by the guest's account or a broad group.
    host.mkdirp(controlDir); host.mkdirp(stagingDir);
    for (const p of [controlDir, ...supervisorPaths]) {
      let writable: readonly string[];
      try { writable = await host.writableBy(p); } catch (error) { return no(`the access list of ${p} could not be read: ${(error as Error).message}`); }
      const risky = writable.filter((w) => sameAccount(w, settings.shareIdentity) || /^(?:everyone|users|authenticated users|builtin\\users|nt authority\\authenticated users|domain users)$/i.test(w) || /\\users$/i.test(w));
      if (risky.length > 0 && aclPolicy === "strict") return no(`the supervisor's folder ${p} can be written by ${risky.join(", ")}; supervisor code must be outside anything the guest account can change`);
    }
    // Another job may be running (then nothing is cleaned up or counted here); otherwise anything left behind is dealt with first.
    const lockText = host.readText(lockFile(settings));
    let running = false;
    try { const holder = lockText === undefined ? {} : JSON.parse(lockText) as { pid?: number }; running = holder.pid !== undefined && holder.pid !== host.pid && host.pidAlive(holder.pid); } catch { running = false; }
    if (!running) {
      for (const leftover of host.listDir(`${controlDir}\\jobs`)) {
        const result = await releaseJob(host, settings, `${controlDir}\\jobs\\${leftover}`);
        if (!result.ok) return no(`a job left changes behind and they could not be undone: ${result.reason}`);
      }
      const listed = await host.run(client.value.wsb, ["list", "--raw"], { cwd: client.value.cwd, timeoutMs: 60_000 }).catch(() => undefined);
      if (listed === undefined || listed.code !== 0) return no("the running sandboxes could not be listed");
      if (/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(listed.stdout)) return no("a Windows Sandbox is already running that this program did not start; capacity is one sandbox at a time");
    }
    // The real test: a sandbox is started and the guest is asked to do what it must not be able to.
    const nonce = randomUUID();
    const probeDir = `${stagingDir}\\probe-${nonce}`;
    const tools = `${probeDir}\\tools`;
    try {
      host.remove(probeDir);
      for (const d of ["work\\.git", "home", "scratch", "tools"]) host.mkdirp(`${probeDir}\\${d}`);
      host.writeText(`${tools}\\probe.cmd`, PROBE_SCRIPT);
      const recipe: NormalizedRecipe = { mode: "sandboxed", workdir: `${probeDir}\\work`, home: `${probeDir}\\home`, scratch: `${probeDir}\\scratch`, readOnly: [{ host: tools, guest: "/inputs/probe" }], network: "none", env: {}, protectedSubpaths: [".git"], revision: "probe", unprotectedSubpaths: [] };
      const command = ["/windows/system32/cmd.exe", "/d", "/c", `${GUEST_PATHS.work.replace("work", "inputs")}\\probe\\probe.cmd`];
      const dir = jobDirFor(settings, `probe-${nonce}`);
      host.mkdirp(dir);
      const job: WindowsJob = { version: 1, settings, recipe, command };
      host.writeText(jobFile(dir), JSON.stringify(job));
      const out = await runWindowsJob(host, job, supervisorPaths, dir);
      if (out.exitCode === EXIT_BUSY) return Date.now() - lastHealthy < PROBE_MS_CACHE ? { healthy: true, backend: "windows-sandbox", version: clientVersion, notes: [...notes, "a job is running; the last confinement probe still stands"] } : no("a job is running, so the confinement probe could not be repeated");
      if (out.exitCode !== 0 || !out.stdout.includes("confined")) {
        const why: Record<number, string> = { 11: "the guest could not write its own checkout", 12: "the guest could write to a read-only input", 13: "the guest could write inside the protected .git", 14: "the guest reached the network" };
        return no(`the confinement probe failed: ${why[out.exitCode] ?? (out.stderr.trim().slice(0, 300) || `exit ${out.exitCode}`)}`);
      }
      if (!host.exists(`${probeDir}\\work\\ok.txt`) || host.exists(`${tools}\\denied.txt`) || host.exists(`${probeDir}\\work\\.git\\denied.txt`)) return no("the confinement probe passed in the guest but the host does not show the expected files");
      lastHealthy = Date.now();
      return { healthy: true, backend: "windows-sandbox", version: clientVersion, notes };
    } catch (error) {
      return no(`the confinement probe could not run: ${(error as Error).message}`);
    } finally {
      host.remove(probeDir);
    }
  };

  // One health check at a time: two at once would share the lock and the probe's folders.
  let queue: Promise<unknown> = Promise.resolve();
  const health = (): Promise<BackendHealth> => { const next = queue.then(checkHealth, checkHealth); queue = next.catch(() => undefined); return next; };

  return {
    name: "windows-sandbox",
    plan,
    guestView,
    health,
    auditDetails: () => ({
      windowsMode: mode,
      sessionDependent: "true",
      ...(mode === "autologon-lock" ? { autologonAuthority: options.autologonLock!.authority, lockChecked: "at admission and again before the command starts" } : { autologon: "off (never a default)" }),
      clientVersion, minClientVersion: minVersion, shareIdentity: settings.shareIdentity, supervisorAcl: aclPolicy, vmFallback: VM_FALLBACK_DECISION.split(":")[0]!,
    }),
    async release(spawnPlan: SpawnPlan): Promise<void> {
      const jobDir = spawnPlan.env["NIMBLENEWT_WSB_JOB"];
      if (jobDir === undefined || !overlapsWin(jobDir, `${controlDir}\\jobs`) || jobDir === `${controlDir}\\jobs`) return;
      const result = await releaseJob(host, settings, jobDir);
      if (!result.ok) throw new Error(`Windows Sandbox cleanup incomplete: ${result.reason}`);
    },
  };
}
