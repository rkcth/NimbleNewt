import type { ProcessResult } from "./windows-host.js";
import { ChannelRelay, type ChannelFs, type ChannelJob, type ChannelPorts, type ChannelStats } from "./windows-native-channel.js";
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
  /** Starts a program (no shell) and waits for it. `signal` ends it early (the run then reports as it would for a program that was killed). */
  run(file: string, args: readonly string[], options: { readonly cwd?: string; readonly timeoutMs: number; readonly signal?: AbortSignal }): Promise<ProcessResult>;
  /** Creates the channel's two files and keeps them open (card A03b, slice 4). Absent: a job with a channel is refused. */
  readonly channelFs?: ChannelFs;
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
  /** Present for a streamed run: the program talks to the controller through two files that the runner relays (see windows-native-channel.ts). */
  readonly channel?: ChannelJob;
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
  /** A streamed run: how much went through the channel (counts only, never content), and anything the relay noted. */
  readonly channel?: ChannelStats & { readonly note?: string };
}

export const RECORDS_KEPT = 200;
export const jobsDir = (settings: NativeSettings): string => `${settings.controlDir}\\jobs`;
export const recordsDir = (settings: NativeSettings): string => `${settings.controlDir}\\records`;
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
 *
 * A seal is lifted LAST and only once every other grant reads back clean: revoking a seal gives the protected folder its inheritance back, so with the workspace's entry still there (a revoke of it
 * that failed) the protected folder would become writable for the container. The launcher's own `revoke` goes through its list backwards, so seals are never sent together with the other grants.
 */
export async function revokeAndReadBack(host: NativeHost, settings: NativeSettings, grants: readonly NativeGrant[]): Promise<ReadBack> {
  if (grants.length === 0) return { state: "clean", left: [] };
  const call = async (command: "check" | "revoke", list: readonly NativeGrant[] = grants): Promise<LauncherLine | undefined> => {
    try { return parseLauncherLine((await host.run(settings.launcher, [command, "--name", settings.profileName, ...grantArgs(list)], { timeoutMs: CHECK_MS })).stdout); } catch { return undefined; }
  };
  const dirty = (line: LauncherLine): string[] => grants.filter((g) => { const r = line.grants.find((x) => x.path.toLowerCase() === g.path.toLowerCase()); return r === undefined || r.entriesLeft !== 0; }).map((g) => g.path);
  const isSeal = (path: string): boolean => grants.some((g) => g.mode === "seal" && g.path.toLowerCase() === path.toLowerCase());
  let line = await call("check");
  if (line === undefined) return { state: "unreadable", left: grants.map((g) => g.path) };
  let left = dirty(line);
  if (left.length === 0) return { state: "clean", left: [], line };
  const open = grants.filter((g) => g.mode !== "seal");
  if (left.some((p) => !isSeal(p))) {
    await call("revoke", open);
    line = await call("check");
    if (line === undefined) return { state: "unreadable", left };
    left = dirty(line);
    if (left.length === 0) return { state: "clean", left: [], line };
    if (left.some((p) => !isSeal(p))) return { state: "left", left, line }; // the seals stay: the folder they protect is narrower with them
  }
  await call("revoke", grants.filter((g) => g.mode === "seal"));
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

/** The runs going on in THIS process (the health probe runs in the controller's own process, so its lock and status file carry the controller's process number). */
const LIVE_HERE = new Set<string>();
/** A launcher started a moment after the lock or status time may show a start time slightly before it (clock rounding): this much earlier still counts as the run's. */
const START_SLACK_MS = 1000;

/**
 * Whether the run that wrote a lock or a status file at `since` may still have a program in the container. That is so while its writer (the runner) is running, AND while any process the writer
 * started after `since` is running: the runner starts the launcher, and a runner that was killed alone (for example when the controller could not read the process tree) leaves the launcher, the
 * Job Object and the container's program running for up to the run's time limit. Every run shares the one container SID, so a later run's grants would reach that program. Windows reuses process
 * numbers, so a live number whose process started after `since` is a later, unrelated process, and only the writer's children started before that one count. The writer's own number in this
 * process counts as alive only while that run is in progress here. Where the process list cannot be read, the run counts as alive: nothing is taken over or revoked on a guess.
 */
export async function writerAlive(host: NativeHost, pid: number | undefined, since: string | undefined, runId?: string): Promise<boolean> {
  if (pid === undefined) return false;
  if (pid === host.pid && runId !== undefined && LIVE_HERE.has(runId)) return true;
  const at = since === undefined ? Number.NaN : Date.parse(since);
  let list: Awaited<ReturnType<NativeHost["processes"]>>;
  try { list = await host.processes(); } catch { list = undefined; }
  // The writer's number: still the writer (alive), a later process (its start bounds the writer's children), or gone.
  let later = Number.POSITIVE_INFINITY;
  if (pid === host.pid || host.pidAlive(pid)) {
    const p = list?.find((x) => x.pid === pid);
    const started = p === undefined ? Number.NaN : Date.parse(p.started);
    if (pid !== host.pid && (Number.isNaN(at) || Number.isNaN(started) || started <= at)) return true;
    if (!Number.isNaN(started)) later = started;
    else if (pid === host.pid) later = Date.now(); // this process: its own children are later than any start it cannot read
  }
  if (list === undefined) return true;
  return list.some((x) => {
    if (x.parent !== pid || x.pid === pid) return false;
    const started = Date.parse(x.started);
    if (Number.isNaN(started)) return true;
    return (Number.isNaN(at) || started >= at - START_SLACK_MS) && started < later;
  });
}

export const locksDir = (settings: NativeSettings): string => `${settings.controlDir}\\locks`;
const LOCK_NAME = /^\d{1,15}$/;
const lockNumbers = (host: NativeHost, settings: NativeSettings): number[] => host.listDir(locksDir(settings)).filter((n) => LOCK_NAME.test(n)).map(Number);

/**
 * Takes the one run slot (a second run would share the container's SID: its program would reach the other run's folders, and one run's revoke would remove the other's grants). The slot is the
 * highest-numbered file in `locks`; a run takes it by creating the NEXT number exclusively, which only one contender can do, then checks that no higher number appeared (a contender that read an older
 * listing backs off). A holder that is gone (see `writerAlive`) or released (`<n>.released` exists) is replaced this way. Every file is created whole (`createExclusive`), so a holder file that cannot be read was
 * changed by something else: busy, never taken over. Returns the number taken.
 */
async function takeLock(host: NativeHost, settings: NativeSettings, runId: string): Promise<number | undefined> {
  const dir = locksDir(settings);
  host.mkdirp(dir);
  const mine = JSON.stringify({ pid: host.pid, runId, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 4; attempt++) {
    const n = Math.max(0, ...lockNumbers(host, settings));
    if (n > 0) {
      const text = host.readText(`${dir}\\${n}`);
      if (text === undefined) continue;
      let holder: { pid?: number; runId?: string; at?: string };
      try { holder = JSON.parse(text) as typeof holder; } catch { return undefined; }
      if (!host.exists(`${dir}\\${n}.released`) && (holder.pid === undefined || await writerAlive(host, holder.pid, holder.at, holder.runId))) return undefined;
    }
    // Marked as in progress here BEFORE the file exists, so another caller in this process never sees the new number without its run.
    LIVE_HERE.add(runId);
    let made: boolean;
    try { made = host.createExclusive(`${dir}\\${n + 1}`, mine); } catch { LIVE_HERE.delete(runId); return undefined; } // the lock cannot be written: busy, nothing runs
    if (!made) { LIVE_HERE.delete(runId); continue; }
    const now = lockNumbers(host, settings);
    if (now.some((x) => x > n + 1)) { LIVE_HERE.delete(runId); try { host.remove(`${dir}\\${n + 1}`); } catch { /* a higher number holds the slot either way */ } return undefined; }
    for (const x of now) if (x < n + 1) { try { host.remove(`${dir}\\${x}`); host.remove(`${dir}\\${x}.released`); } catch { /* an old number never decides anything */ } }
    return n + 1;
  }
  return undefined;
}
const dropLock = (host: NativeHost, settings: NativeSettings, n: number, runId: string): void => {
  // The number stays and a separate `<n>.released` file marks it free (created whole, like the number), so the numbering never starts again from 1 under a contender that read an older listing,
  // and a holder that stops while releasing never leaves a half-written file that would keep every later run busy.
  try { host.createExclusive(`${locksDir(settings)}\\${n}.released`, runId); } catch { /* the holder's process ends soon; it then counts as gone */ }
};

/**
 * Runs one job (called by the runner, and by the health probe). Fails closed with a typed reason when a volume is not NTFS, a grant cannot be made, the container or the job cannot be made or the
 * revoke cannot be read back clean; the program's standard output and error come back from the FILES the launcher gave it, and its exit code is passed through. The read-back and the revoke
 * happen on every path out, a failed launch included.
 */
export async function runNativeJob(host: NativeHost, job: NativeJob, stdin: string | undefined, jobDir: string, ports?: ChannelPorts): Promise<JobOutcome> {
  const { settings } = job;
  if (LIVE_HERE.has(job.runId)) return { exitCode: EXIT_BUSY, stdout: "", stderr: `${FAILURE_PREFIX}: busy: this run is already in progress\n` };
  const lock = await takeLock(host, settings, job.runId);
  if (lock === undefined) return { exitCode: EXIT_BUSY, stdout: "", stderr: `${FAILURE_PREFIX}: busy: another native run is in progress, or the last one's launcher may still be running (or the process list cannot be read to tell); one at a time\n` };
  // The job file stays for the sweep (it needs the grants), but the launcher's argument list carries the recipe's environment values: once read they are not left on disk.
  try { host.writeText(jobFile(jobDir), JSON.stringify({ ...job, args: [] })); } catch { /* the control folder is the supervisor's own; a failed rewrite leaves the file as it was */ }
  const startedAt = new Date().toISOString();
  let line: LauncherLine | undefined;
  let failure: { kind: NativeFailure; message: string } | undefined;
  let applied = false;
  let relay: ChannelRelay | undefined;
  let channelFiles: { close(): void }[] = [];
  let relayEnd: Awaited<ReturnType<ChannelRelay["finish"]>> | undefined;
  const abort = new AbortController();
  try {
    // Every run shares the container's SID, so entries an earlier run left on its own task folders (a kill whose cleanup failed, a restart) would reach THIS run's program: they are revoked and
    // read back first, and the run does not start while any is left or another run may still have a program in the container.
    const earlier = await sweepLeftovers(host, settings, undefined, jobDir);
    if (earlier.problems.length > 0 || earlier.live.length > 0) failure = { kind: "revoke", message: `an earlier run's entries are not known to be gone, so this run does not start: ${[...earlier.problems, ...earlier.live.map((d) => `${d}: its runner or launcher may still be running`)].join("; ")}` };
    if (failure === undefined && job.requireNtfs) {
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
      if (job.channel !== undefined) {
        // The two files are made here, outside the container and before it starts; the handles stay with the supervisor.
        try {
          const made = openChannel(host, job.channel);
          channelFiles = [made.inbox, made.outbox];
          if (ports === undefined) throw new Error("the runner has no pipes of the controller to relay");
          relay = new ChannelRelay({ inbox: made.inbox, outbox: made.outbox, ports, limits: job.channel, drainMs: job.channel.stallMs, onFault: () => { abort.abort(); } });
        } catch (error) { failure = { kind: "channel", message: `the channel could not be set up: ${(error as Error).message}` }; }
      }
    }
    if (failure === undefined) {
      applied = true; // from here on grants may exist: the read-back below always runs
      let result: ProcessResult | undefined;
      relay?.start();
      try { result = await host.run(settings.launcher, job.args, { timeoutMs: settings.maxRunMs + LAUNCHER_GRACE_MS, ...(relay === undefined ? {} : { signal: abort.signal }) }); } catch (error) { failure = { kind: "launcher", message: `the launcher could not be run: ${(error as Error).message}` }; }
      if (result !== undefined) {
        line = parseLauncherLine(result.stdout);
        if (line === undefined) failure = { kind: "launcher", message: `the launcher gave no answer (exit ${String(result.code)}${result.timedOut ? ", timed out" : ""})` };
        else if (!line.ok && line.childStarted !== true) failure = { kind: failureKindOf(line.stage), message: `${line.stage ?? "launcher"}: ${line.error ?? "failed"}` };
        else if (!line.ok) failure = { kind: failureKindOf(line.stage), message: `${line.stage ?? "launcher"}: ${line.error ?? "failed"} (the program had started)` };
        else if (line.childStarted !== true) failure = { kind: "launcher", message: "the launcher reported success but not that the program started" };
      }
    }
  } finally {
    // The program has ended (or never started): the outbox is read to its end and both files are let go before anything is revoked or reported.
    if (relay !== undefined) {
      relayEnd = await relay.finish(line?.ok === true && line.childExitCode === 0 && line.timedOut !== true);
      if (relayEnd.fault !== undefined) failure = { kind: "channel", message: relayEnd.fault + (failure === undefined ? "" : ` (the run was then ended: ${failure.message})`) };
    }
    for (const f of channelFiles) { try { f.close(); } catch { /* released with the process */ } }
    // Every exit path: the revoke is read back by an independent look (not only the launcher's own report).
    const back: ReadBack = applied ? await revokeAndReadBack(host, settings, job.grants) : { state: "clean", left: [] };
    // The channel folder is in the container's scratch, so the container may have put a link or junction in its place: it is removed only after the revoke (nothing of the container may still change it)
    // and without following anything. What cannot be removed that way is left for the task's own cleanup and noted.
    if (job.channel !== undefined && host.channelFs !== undefined) {
      let gone = false;
      try { gone = host.channelFs?.removeFolder(job.channel.dir, [job.channel.inbox, job.channel.outbox]) === true; } catch { /* noted below */ }
      if (!gone && relayEnd !== undefined) relayEnd = { ...relayEnd, note: `${relayEnd.note === undefined ? "" : `${relayEnd.note}; `}the channel folder was left in the scratch folder (it could not be removed without following a link)` };
    }
    if (back.state !== "clean" && failure === undefined) failure = { kind: "revoke", message: back.state === "left" ? `the container still has an entry on ${back.left.join(", ")} after the run` : "the access lists could not be read back after the run" };
    else if (back.state !== "clean" && failure !== undefined) failure = { kind: failure.kind, message: `${failure.message}; also ${back.state === "left" ? `an entry for the container is still on ${back.left.join(", ")}` : "the access lists could not be read back"}` };
    const record: RunRecord = {
      runId: job.runId, mode: "native", container: settings.container, startedAt, childStarted: line?.childStarted === true,
      exitCode: line?.childExitCode ?? null, timedOut: line?.timedOut === true, ...(failure === undefined ? {} : { failure }),
      grants: (line?.grants ?? []).map((g) => ({ path: g.path, mode: g.mode, soft: g.soft, applied: g.applied, revoked: g.revoked, errorCode: g.errorCode ?? null })),
      softRefused: line === undefined ? [] : softRefusals(line), entriesLeft: back.left, readBack: back.state,
      ...(relayEnd === undefined ? {} : { channel: { ...relayEnd.stats, ...(relayEnd.note === undefined ? {} : { note: relayEnd.note }) } }),
    };
    writeRecord(host, settings, record);
    // A clean run leaves nothing in the job folder but what is removed here; a run whose revoke could not be read back keeps its job file for the sweep.
    if (back.state === "clean") { host.remove(job.files.input); host.remove(statusFile(jobDir)); }
    LIVE_HERE.delete(job.runId);
    dropLock(host, settings, lock, job.runId);
  }
  if (failure !== undefined) return failed(failure.kind, failure.message);
  const out = host.readText(job.files.out, MAX_OUTPUT_READ) ?? "";
  const err = host.readText(job.files.err, MAX_OUTPUT_READ) ?? "";
  host.remove(job.files.out); host.remove(job.files.err);
  // A streamed run: the controller's own line stream is the channel, so nothing the program printed on its standard output may reach it (it is untrusted text). It is kept as a clipped note on standard error.
  if (job.channel !== undefined) {
    const printed = out.trim() === "" ? "" : `[program standard output, not relayed] ${out.slice(0, 4000).replace(/\r?\n/g, " | ")}\n`;
    return { exitCode: line?.timedOut === true ? 124 : (line?.childExitCode ?? EXIT_FAILED), stdout: "", stderr: err + printed + (relayEnd?.note === undefined ? "" : `[channel] ${relayEnd.note}\n`) };
  }
  return { exitCode: line?.timedOut === true ? 124 : (line?.childExitCode ?? EXIT_FAILED), stdout: out, stderr: err };
}

/** Makes the channel's folder and its two files (the folder must not exist: a name the container left is removed first, and a link there is never followed). */
function openChannel(host: NativeHost, channel: ChannelJob): { inbox: ReturnType<ChannelFs["create"]> & object; outbox: ReturnType<ChannelFs["create"]> & object } {
  const fs = host.channelFs;
  if (fs === undefined) throw new Error("this host cannot make channel files");
  // A leftover under this name (only a run with the same id could have made one) is removed without following a link; one that cannot be removed that way stops the run.
  if (!fs.removeFolder(channel.dir, [channel.inbox, channel.outbox])) throw new Error("a leftover channel folder could not be removed");
  host.mkdirp(channel.dir);
  if (host.isLinkOrJunction(channel.dir)) throw new Error("the channel folder is a link");
  const inbox = fs.create(channel.inbox);
  if (inbox === undefined) throw new Error("the inbox name is taken");
  let outbox: ReturnType<ChannelFs["create"]>;
  try { outbox = fs.create(channel.outbox); } catch (error) { inbox.close(); throw error; }
  if (outbox === undefined) { inbox.close(); throw new Error("the outbox name is taken"); }
  return { inbox, outbox };
}

export interface SweepResult { readonly released: number; readonly problems: readonly string[]; /** Folders whose run may still have a program in the container (left alone). */ readonly live: readonly string[] }

/**
 * Ends what a run that never finished (the runner was killed, the machine restarted) may have left: for each job folder whose runner is gone, the container's entries on its granted paths are
 * revoked and read back; a clean folder is removed, one that cannot be cleaned is kept and reported. A folder whose runner is alive is another run's and is left alone. `only` limits the sweep to one folder.
 */
export async function sweepLeftovers(host: NativeHost, settings: NativeSettings, only?: string, except?: string, mayRevoke = true): Promise<SweepResult> {
  const problems: string[] = [];
  const live: string[] = [];
  let released = 0;
  const dirs = (only === undefined ? host.listDir(jobsDir(settings)).map((n) => `${jobsDir(settings)}\\${n}`) : [only]).filter((d) => except === undefined || d.toLowerCase() !== except.toLowerCase());
  for (const dir of dirs) {
    // A folder with no status file was planned but its runner never started, so no grant was ever made for it (the backend's `release` removes it); a runner that is still alive owns its folder.
    const statusText = host.readText(statusFile(dir));
    // No status file: the runner never got past the lock (planned, refused as busy, or a clean run already removed it), so no grant of this folder's job is on any path. `release` removes the folder
    // without a revoke: the container's SID is shared, so revoking these paths could remove a live run's entries on the same folders.
    if (statusText === undefined) { if (only !== undefined) { host.remove(dir); released++; } continue; }
    let status: { runnerPid?: number; startedAt?: string; runId?: string } = {};
    try { status = JSON.parse(statusText ?? "{}") as typeof status; } catch { status = {}; }
    // A run that may still have a program in the container (its runner, or the launcher the runner started, is running; or that cannot be told) is never revoked: its seal would be lifted under a
    // live program. For `release` that is a problem to report; the folder stays for a later sweep.
    if (await writerAlive(host, status.runnerPid, status.startedAt, status.runId)) { live.push(dir); if (only !== undefined) problems.push(`${dir}: the run's runner or launcher may still be running, so its entries are kept until it ends (a later health check sweeps them)`); continue; }
    // Revoking needs the run slot: a run that starts meanwhile may apply its grants to the same task folders (one container SID), and a seal revoke sent late would then lift ITS seal while its
    // workspace entry stays. Without the slot nothing is revoked; the slot's holder swept before it started, and a later sweep takes what is left.
    if (!mayRevoke) { problems.push(`${dir}: another native run holds the run slot, so its entries are kept for a later sweep (nothing is revoked while a run may be starting)`); continue; }
    const text = host.readText(jobFile(dir));
    let grants: NativeGrant[];
    // The runner had started (the status file says so), so grants may exist: without a readable job file they are not known, which is a problem, never "nothing to revoke".
    try { const g = (JSON.parse(text ?? "") as { grants?: unknown }).grants; if (!Array.isArray(g)) throw new Error("no grants"); grants = g as NativeGrant[]; } catch { problems.push(`${dir}: the job file is missing or cannot be read, so its grants are not known`); continue; }
    const back = await revokeAndReadBack(host, settings, grants);
    if (back.state === "clean") { host.remove(dir); released++; } else problems.push(`${dir}: ${back.state === "left" ? `the container still has an entry on ${back.left.join(", ")}` : "the access lists could not be read back"}`);
  }
  return { released, problems, live };
}

/**
 * `sweepLeftovers` for callers outside a run (the health check and `release`): the run slot is taken first and held for the sweep, so no revoke of an earlier run's paths can overlap a run that
 * applies its grants to the same folders. While another run holds the slot nothing is revoked (a folder that had started is reported, one that never started is still removed by `release`).
 */
export async function sweepLeftoversLocked(host: NativeHost, settings: NativeSettings, only?: string): Promise<SweepResult> {
  const id = `sweep-${host.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const lock = await takeLock(host, settings, id);
  try { return await sweepLeftovers(host, settings, only, undefined, lock !== undefined); } finally {
    if (lock !== undefined) { LIVE_HERE.delete(id); dropLock(host, settings, lock, id); }
  }
}
