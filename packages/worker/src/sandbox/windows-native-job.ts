import type { ProcessResult } from "./windows-host.js";
import {
  EXIT_BUSY, EXIT_FAILED, FAILURE_PREFIX, failureKindOf, grantArgs, parseLauncherLine, softRefusals,
  type LauncherLine, type NativeFailure, type NativeGrant, type NativeSettings, type RunFiles,
} from "./windows-native-plan.js";

/** Everything the native backend does to the machine, behind one interface: files, processes and the launcher. The real one is windows-native-real.ts; the unit tests use a simulated one. */
export interface NativeHost {
  readonly platform: string;
  readonly pid: number;
  env(name: string): string | undefined;
  pidAlive(pid: number): boolean;
  exists(path: string): boolean;
  isDirectory(path: string): boolean;
  /** True when the path is, or passes through, a link, a junction or any other reparse point. */
  isLinkOrJunction(path: string): boolean;
  mkdirp(path: string): void;
  /** At most `maxBytes` of the file (default 1 MiB) as text; undefined when it does not exist. */
  readText(path: string, maxBytes?: number): string | undefined;
  writeText(path: string, text: string): void;
  /** Creates the file only if it does not exist yet; false when it does. */
  createExclusive(path: string, text: string): boolean;
  listDir(path: string): string[];
  remove(path: string): void;
  /** The file system of the volume the path is on (`NTFS`), or undefined when it cannot be read. */
  fileSystemOf(path: string): Promise<string | undefined>;
  /** Starts a program (no shell) and waits for it. */
  run(file: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number }): Promise<ProcessResult>;
  /** Every process now, with its parent and its start time, or undefined where that cannot be read. */
  processes(): Promise<readonly { readonly pid: number; readonly parent: number; readonly started: string }[] | undefined>;
}

/** The job file the backend writes (in the supervisor's control directory) and the runner reads. */
export interface NativeJob {
  readonly version: 1;
  readonly runId: string;
  readonly settings: NativeSettings;
  readonly grants: readonly NativeGrant[];
  /** The launcher's `run` argument list, complete. */
  readonly args: readonly string[];
  readonly files: RunFiles;
  readonly workdir: string;
  /** The folders that must be on NTFS (the task's own). */
  readonly volumes: readonly string[];
  /** The checks before the program starts: refuse unless every volume is NTFS. Tests and the health probe may turn it off for a stand-in host. */
  readonly requireNtfs: boolean;
}

export interface JobOutcome { readonly exitCode: number; readonly stdout: string; readonly stderr: string }

/** What the runner leaves for the owner after a run: the grants, what was refused, the failure, the read-back. Holds no environment values and no file contents. */
export interface RunRecord {
  readonly runId: string;
  readonly mode: string;
  readonly container: string;
  readonly startedAt: string;
  readonly childStarted: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly failure?: { readonly kind: NativeFailure; readonly message: string };
  readonly grants: readonly { readonly path: string; readonly mode: string; readonly soft: boolean; readonly applied: boolean; readonly revoked: boolean; readonly errorCode: number | null }[];
  /** Soft grants the launcher refused (read grants on program folders); each is listed, none stops the launch. */
  readonly softRefused: readonly { readonly path: string; readonly mode: string; readonly errorCode: number | null }[];
  /** The read-back after the run: paths that still carried an entry for the container (empty when everything was removed). */
  readonly entriesLeft: readonly string[];
  readonly readBack: "clean" | "left" | "unreadable";
}

export const RECORDS_KEPT = 200;
export const jobsDir = (settings: NativeSettings): string => `${settings.controlDir}\\jobs`;
export const recordsDir = (settings: NativeSettings): string => `${settings.controlDir}\\records`;
export const lockFile = (settings: NativeSettings): string => `${settings.controlDir}\\native.lock`;
export const jobFile = (jobDir: string): string => `${jobDir}\\job.json`;
const statusFile = (jobDir: string): string => `${jobDir}\\status.json`;
const MAX_OUTPUT_READ = 65 * 1024 * 1024;
const LAUNCHER_GRACE_MS = 120_000;
const CHECK_MS = 120_000;

const failed = (kind: NativeFailure, message: string): JobOutcome => ({ exitCode: EXIT_FAILED, stdout: "", stderr: `${FAILURE_PREFIX}: ${kind}: ${message}\n` });

export interface ReadBack { readonly state: "clean" | "left" | "unreadable"; readonly left: readonly string[]; readonly line?: LauncherLine }

/**
 * Reads the container's entries back from every granted path with the launcher's `check` command. When any is left it asks the launcher to `revoke` them (modes as granted) and reads again.
 * `unreadable` when the launcher says nothing (every path then counts as possibly still granted). Never throws.
 */
export async function revokeAndReadBack(host: NativeHost, settings: NativeSettings, grants: readonly NativeGrant[]): Promise<ReadBack> {
  if (grants.length === 0) return { state: "clean", left: [] };
  const call = async (command: "check" | "revoke"): Promise<LauncherLine | undefined> => {
    try { return parseLauncherLine((await host.run(settings.launcher, [command, "--name", settings.profileName, ...grantArgs(grants)], { timeoutMs: CHECK_MS })).stdout); } catch { return undefined; }
  };
  const dirty = (line: LauncherLine): string[] => grants.filter((g) => { const r = line.grants.find((x) => x.path.toLowerCase() === g.path.toLowerCase()); return r === undefined || r.entriesLeft !== 0; }).map((g) => g.path);
  let line = await call("check");
  if (line === undefined) return { state: "unreadable", left: grants.map((g) => g.path) };
  let left = dirty(line);
  if (left.length === 0) return { state: "clean", left: [], line };
  await call("revoke");
  line = await call("check");
  if (line === undefined) return { state: "unreadable", left };
  left = dirty(line);
  return left.length === 0 ? { state: "clean", left: [], line } : { state: "left", left, line };
}

function writeRecord(host: NativeHost, settings: NativeSettings, record: RunRecord): void {
  try {
    host.mkdirp(recordsDir(settings));
    host.writeText(`${recordsDir(settings)}\\${record.runId}.json`, JSON.stringify(record));
    const names = host.listDir(recordsDir(settings)).sort();
    for (const old of names.slice(0, Math.max(0, names.length - RECORDS_KEPT))) host.remove(`${recordsDir(settings)}\\${old}`);
  } catch { /* the record is evidence for the owner, not a gate: a launch is not undone because it could not be written */ }
}

/** The record of a run, or undefined. */
export function readRecord(host: NativeHost, settings: NativeSettings, runId: string): RunRecord | undefined {
  const text = host.readText(`${recordsDir(settings)}\\${runId}.json`);
  if (text === undefined) return undefined;
  try { return JSON.parse(text) as RunRecord; } catch { return undefined; }
}

/**
 * Whether the process that wrote a lock or a status file at `since` is still running. Windows reuses process numbers (after a restart almost certainly), so a live number whose process started AFTER
 * `since` is a later, unrelated process and the writer is gone. Where the start time cannot be read the number alone decides (as before), so nothing of a live run is ever touched on a guess.
 */
export async function writerAlive(host: NativeHost, pid: number | undefined, since: string | undefined): Promise<boolean> {
  if (pid === undefined || !host.pidAlive(pid)) return false;
  const at = since === undefined ? Number.NaN : Date.parse(since);
  if (Number.isNaN(at)) return true;
  let list: Awaited<ReturnType<NativeHost["processes"]>>;
  try { list = await host.processes(); } catch { return true; }
  const p = list?.find((x) => x.pid === pid);
  const started = p === undefined ? Number.NaN : Date.parse(p.started);
  return Number.isNaN(started) || started <= at;
}

/** Takes the one run slot (a second run would share the container's SID, so one run's revoke would remove another's grants). A lock whose holder is gone is taken over. */
async function takeLock(host: NativeHost, settings: NativeSettings, runId: string): Promise<boolean> {
  const mine = JSON.stringify({ pid: host.pid, runId, at: new Date().toISOString() });
  if (host.createExclusive(lockFile(settings), mine)) return true;
  let holder: { pid?: number; at?: string } = {};
  try { holder = JSON.parse(host.readText(lockFile(settings)) ?? "{}") as { pid?: number; at?: string }; } catch { holder = {}; }
  if (holder.pid !== undefined && holder.pid !== host.pid && await writerAlive(host, holder.pid, holder.at)) return false;
  host.remove(lockFile(settings));
  return host.createExclusive(lockFile(settings), mine);
}
const dropLock = (host: NativeHost, settings: NativeSettings, runId: string): void => {
  try { const holder = JSON.parse(host.readText(lockFile(settings)) ?? "{}") as { runId?: string }; if (holder.runId === runId) host.remove(lockFile(settings)); } catch { /* not ours to remove */ }
};

/**
 * Runs one job (called by the runner, and by the health probe). Fails closed with a typed reason when a volume is not NTFS, a grant cannot be made, the container or the job cannot be made or the
 * revoke cannot be read back clean; the program's standard output and error come back from the FILES the launcher gave it, and its exit code is passed through. The read-back and the revoke
 * happen on every path out, a failed launch included.
 */
export async function runNativeJob(host: NativeHost, job: NativeJob, stdin: string | undefined, jobDir: string): Promise<JobOutcome> {
  const { settings } = job;
  if (!(await takeLock(host, settings, job.runId))) return { exitCode: EXIT_BUSY, stdout: "", stderr: `${FAILURE_PREFIX}: busy: another native run is in progress; one at a time\n` };
  // The job file stays for the sweep (it needs the grants), but the launcher's argument list carries the recipe's environment values: once read they are not left on disk.
  try { host.writeText(jobFile(jobDir), JSON.stringify({ ...job, args: [] })); } catch { /* the control folder is the supervisor's own; a failed rewrite leaves the file as it was */ }
  const startedAt = new Date().toISOString();
  let line: LauncherLine | undefined;
  let failure: { kind: NativeFailure; message: string } | undefined;
  let applied = false;
  try {
    if (job.requireNtfs) {
      for (const v of job.volumes) {
        const fs = await host.fileSystemOf(v);
        if (fs === undefined || fs.toUpperCase() !== "NTFS") { failure = { kind: "filesystem", message: `${v} is not on NTFS (${fs ?? "unreadable"}); a folder grant needs NTFS` }; break; }
      }
    }
    if (failure === undefined) {
      host.writeText(statusFile(jobDir), JSON.stringify({ runnerPid: host.pid, runId: job.runId, startedAt }));
      host.writeText(job.files.input, stdin ?? "");
      host.writeText(job.files.out, "");
      host.writeText(job.files.err, "");
      applied = true; // from here on grants may exist: the read-back below always runs
      let result: ProcessResult | undefined;
      try { result = await host.run(settings.launcher, job.args, { timeoutMs: settings.maxRunMs + LAUNCHER_GRACE_MS }); } catch (error) { failure = { kind: "launcher", message: `the launcher could not be run: ${(error as Error).message}` }; }
      if (result !== undefined) {
        line = parseLauncherLine(result.stdout);
        if (line === undefined) failure = { kind: "launcher", message: `the launcher gave no answer (exit ${String(result.code)}${result.timedOut ? ", timed out" : ""})` };
        else if (!line.ok && line.childStarted !== true) failure = { kind: failureKindOf(line.stage), message: `${line.stage ?? "launcher"}: ${line.error ?? "failed"}` };
        else if (!line.ok) failure = { kind: failureKindOf(line.stage), message: `${line.stage ?? "launcher"}: ${line.error ?? "failed"} (the program had started)` };
        else if (line.childStarted !== true) failure = { kind: "launcher", message: "the launcher reported success but not that the program started" };
      }
    }
  } finally {
    // Every exit path: the revoke is read back by an independent look (not only the launcher's own report).
    const back: ReadBack = applied ? await revokeAndReadBack(host, settings, job.grants) : { state: "clean", left: [] };
    if (back.state !== "clean" && failure === undefined) failure = { kind: "revoke", message: back.state === "left" ? `the container still has an entry on ${back.left.join(", ")} after the run` : "the access lists could not be read back after the run" };
    else if (back.state !== "clean" && failure !== undefined) failure = { kind: failure.kind, message: `${failure.message}; also ${back.state === "left" ? `an entry for the container is still on ${back.left.join(", ")}` : "the access lists could not be read back"}` };
    const record: RunRecord = {
      runId: job.runId, mode: "native", container: settings.container, startedAt, childStarted: line?.childStarted === true,
      exitCode: line?.childExitCode ?? null, timedOut: line?.timedOut === true, ...(failure === undefined ? {} : { failure }),
      grants: (line?.grants ?? []).map((g) => ({ path: g.path, mode: g.mode, soft: g.soft, applied: g.applied, revoked: g.revoked, errorCode: g.errorCode ?? null })),
      softRefused: line === undefined ? [] : softRefusals(line), entriesLeft: back.left, readBack: back.state,
    };
    writeRecord(host, settings, record);
    // A clean run leaves nothing in the job folder but what is removed here; a run whose revoke could not be read back keeps its job file for the sweep.
    if (back.state === "clean") { host.remove(job.files.input); host.remove(statusFile(jobDir)); }
    dropLock(host, settings, job.runId);
  }
  if (failure !== undefined) return failed(failure.kind, failure.message);
  const out = host.readText(job.files.out, MAX_OUTPUT_READ) ?? "";
  const err = host.readText(job.files.err, MAX_OUTPUT_READ) ?? "";
  host.remove(job.files.out); host.remove(job.files.err);
  return { exitCode: line?.timedOut === true ? 124 : (line?.childExitCode ?? EXIT_FAILED), stdout: out, stderr: err };
}

export interface SweepResult { readonly released: number; readonly problems: readonly string[] }

/**
 * Ends what a run that never finished (the runner was killed, the machine restarted) may have left: for each job folder whose runner is gone, the container's entries on its granted paths are
 * revoked and read back; a clean folder is removed, one that cannot be cleaned is kept and reported. A folder whose runner is alive is another run's and is left alone. `only` limits the sweep to one folder.
 */
export async function sweepLeftovers(host: NativeHost, settings: NativeSettings, only?: string): Promise<SweepResult> {
  const problems: string[] = [];
  let released = 0;
  const dirs = only === undefined ? host.listDir(jobsDir(settings)).map((n) => `${jobsDir(settings)}\\${n}`) : [only];
  for (const dir of dirs) {
    // A folder with no status file was planned but its runner never started, so no grant was ever made for it (the backend's `release` removes it); a runner that is still alive owns its folder.
    const statusText = host.readText(statusFile(dir));
    // No status file: the runner never got past the lock (planned, refused as busy, or a clean run already removed it), so no grant of this folder's job is on any path. `release` removes the folder
    // without a revoke: the container's SID is shared, so revoking these paths could remove a live run's entries on the same folders.
    if (statusText === undefined) { if (only !== undefined) { host.remove(dir); released++; } continue; }
    let status: { runnerPid?: number; startedAt?: string } = {};
    try { status = JSON.parse(statusText ?? "{}") as { runnerPid?: number; startedAt?: string }; } catch { status = {}; }
    if (status.runnerPid !== undefined && status.runnerPid !== host.pid && await writerAlive(host, status.runnerPid, status.startedAt)) continue;
    const text = host.readText(jobFile(dir));
    let grants: NativeGrant[] = [];
    if (text !== undefined) { try { grants = (JSON.parse(text) as { grants?: NativeGrant[] }).grants ?? []; } catch { problems.push(`${dir}: the job file cannot be read, so its grants are not known`); continue; } }
    const back = await revokeAndReadBack(host, settings, grants);
    if (back.state === "clean") { host.remove(dir); released++; } else problems.push(`${dir}: ${back.state === "left" ? `the container still has an entry on ${back.left.join(", ")}` : "the access lists could not be read back"}`);
  }
  return { released, problems };
}
