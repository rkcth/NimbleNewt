import type { ProcessResult } from "./windows-host.js";
import { ChannelRelay, type ChannelFs, type ChannelJob, type ChannelPorts, type ChannelStats } from "./windows-native-channel.js";
import {
  EXIT_BUSY, EXIT_FAILED, FAILURE_PREFIX, RUN_PROFILE_PREFIX, failureKindOf, grantArgs, isRunProfileName, parseLauncherLine, softRefusals,
  type LauncherLine, type NativeFailure, type NativeGrant, type NativeSettings, type RunFiles, type RunProfile,
} from "./windows-native-plan.js";
import { overlapsWin } from "./windows-plan.js";

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
  /** This run's own container profile (card A03b, per-run profile): the name the backend chose and the record file the launcher writes before it makes the profile. */
  readonly profile: RunProfile;
  /** The task's own folders (workspace, home, scratch): no other run in progress may use the same folder or one inside or around it (see `claimFolders`). */
  readonly claim: readonly string[];
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
  /** This run's own container profile and what became of it: the name, the SID the launcher recorded, whether it was deleted and whether it was found gone afterwards. */
  readonly profile?: { readonly name: string; readonly sid?: string; readonly deleted: boolean; readonly gone: boolean };
  /** A streamed run: how much went through the channel (counts only, never content), and anything the relay noted. */
  readonly channel?: ChannelStats & { readonly note?: string };
}

export const RECORDS_KEPT = 200;
export const jobsDir = (settings: NativeSettings): string => `${settings.controlDir}\\jobs`;
export const recordsDir = (settings: NativeSettings): string => `${settings.controlDir}\\records`;
export const jobFile = (jobDir: string): string => `${jobDir}\\job.json`;
const statusFile = (jobDir: string): string => `${jobDir}\\status.json`;
export const profilesDir = (settings: NativeSettings): string => `${settings.controlDir}\\profiles`;
export const claimsDir = (settings: NativeSettings): string => `${settings.controlDir}\\claims`;
/** The profile of a run: its name and the record file the LAUNCHER writes (`<name>.sid`, create-new, before it makes the profile). The backend's own record of the run is `<name>.json` next to it. */
export const runProfileFor = (settings: NativeSettings, name: string): RunProfile => ({ name, record: `${profilesDir(settings)}\\${name}.sid` });
const profileJson = (settings: NativeSettings, name: string): string => `${profilesDir(settings)}\\${name}.json`;
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
export async function revokeAndReadBack(host: NativeHost, settings: NativeSettings, grants: readonly NativeGrant[], profile: { readonly name: string; readonly sid?: string }): Promise<ReadBack> {
  if (grants.length === 0) return { state: "clean", left: [] };
  const call = async (command: "check" | "revoke", list: readonly NativeGrant[] = grants): Promise<LauncherLine | undefined> => {
    try { return parseLauncherLine((await host.run(settings.launcher, [command, "--name", profile.name, ...(profile.sid === undefined ? [] : ["--sid", profile.sid]), ...grantArgs(list)], { timeoutMs: CHECK_MS })).stdout); } catch { return undefined; }
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
/** Run slot `index` (0-based). Slot 0 is the folder every earlier version used, so one-at-a-time (the default) behaves exactly as before; slot k > 0 is `locks-<k>`. */
export const slotDir = (settings: NativeSettings, index: number): string => (index === 0 ? locksDir(settings) : `${settings.controlDir}\\locks-${index}`);
const LOCK_NAME = /^\d{1,15}$/;
const lockNumbers = (host: NativeHost, dir: string): number[] => host.listDir(dir).filter((n) => LOCK_NAME.test(n)).map(Number);

/**
 * Takes one run slot in `dir` (a second run in the same slot would share nothing it should: slots are how many confined runs may be in progress at once). The slot is the
 * highest-numbered file in `dir`; a run takes it by creating the NEXT number exclusively, which only one contender can do, then checks that no higher number appeared (a contender that read an older
 * listing backs off). A holder that is gone (see `writerAlive`) or released (`<n>.released` exists) is replaced this way. Every file is created whole (`createExclusive`), so a holder file that cannot be read was
 * changed by something else: busy, never taken over. Returns the number taken.
 */
async function takeLock(host: NativeHost, dir: string, runId: string): Promise<number | undefined> {
  host.mkdirp(dir);
  const mine = JSON.stringify({ pid: host.pid, runId, at: new Date().toISOString() });
  for (let attempt = 0; attempt < 4; attempt++) {
    const n = Math.max(0, ...lockNumbers(host, dir));
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
    const now = lockNumbers(host, dir);
    if (now.some((x) => x > n + 1)) { LIVE_HERE.delete(runId); try { host.remove(`${dir}\\${n + 1}`); } catch { /* a higher number holds the slot either way */ } return undefined; }
    for (const x of now) if (x < n + 1) { try { host.remove(`${dir}\\${x}`); host.remove(`${dir}\\${x}.released`); } catch { /* an old number never decides anything */ } }
    return n + 1;
  }
  return undefined;
}
const dropLock = (host: NativeHost, dir: string, n: number, runId: string): void => {
  // The number stays and a separate `<n>.released` file marks it free (created whole, like the number), so the numbering never starts again from 1 under a contender that read an older listing,
  // and a holder that stops while releasing never leaves a half-written file that would keep every later run busy.
  try { host.createExclusive(`${dir}\\${n}.released`, runId); } catch { /* the holder's process ends soon; it then counts as gone */ }
};

/** A run slot taken: where, and which number. */
export interface Slot { readonly dir: string; readonly n: number }
/**
 * Takes the first free run slot of `settings.maxConcurrentRuns` (default 1: exactly the one slot there always was). Undefined when every slot is held by a run that may still be going.
 * The limit is a count of confined runs at once; it says nothing about whether the machine can bear that many (unmeasured on real Windows).
 */
async function takeSlot(host: NativeHost, settings: NativeSettings, runId: string): Promise<Slot | undefined> {
  for (let i = 0; i < Math.max(1, settings.maxConcurrentRuns); i++) {
    const dir = slotDir(settings, i);
    const n = await takeLock(host, dir, runId);
    if (n !== undefined) return { dir, n };
  }
  return undefined;
}
const dropSlot = (host: NativeHost, slot: Slot, runId: string): void => { LIVE_HERE.delete(runId); dropLock(host, slot.dir, slot.n, runId); };

/** One run's claim on its task folders (`claims\\<id>.json`). */
interface Claim { readonly pid: number; readonly runId: string; readonly owner: string; readonly at: string; readonly folders: readonly string[] }

/**
 * Claims folders for a run so that two runs in progress never share a workspace. Two runs have two container SIDs, but the same workspace folder would be written by both launchers: the protected
 * DACL on the workspace's protected names (the seal) and the workspace entry are made and lifted per run, and one run's revoke would lift the other's seal under a program that is running. So a
 * folder, or one inside or around it, is held by one run at a time; different workspaces do not touch each other. The claim is a file of its own (named by `id`) written FIRST, and only then are the other
 * claims read: of two contenders at least one sees the other, and both backing off is allowed (busy, retry); one that wrote before the other read always wins. A claim whose writer is gone (see
 * `writerAlive`) is not counted (the sweep deals with what it left); claims with the same `owner` are one run's (its own sweep of an earlier run's leftovers may name that run's folders).
 * The claim is created WHOLE (`createExclusive`: a private temporary file linked to the name), like the slot files, so a writer that stops mid-write never leaves a half-written claim that every later
 * run would have to count as held. Never throws: anything that goes wrong is a reason (busy), and the claim is gone again.
 * Returns undefined when the claim is held, otherwise the reason it was refused (and the claim is gone again).
 */
async function claimFolders(host: NativeHost, settings: NativeSettings, id: string, owner: string, folders: readonly string[]): Promise<string | undefined> {
  const dir = claimsDir(settings);
  const file = `${dir}\\${id}.json`;
  const refuse = (reason: string): string => { try { host.remove(file); } catch { /* a claim whose writer is gone is never counted */ } return reason; };
  try {
    host.mkdirp(dir);
    const mine: Claim = { pid: host.pid, runId: owner, owner, at: new Date().toISOString(), folders };
    // `id` is this run's (or this sweep's) own: a file of that name is an earlier attempt of the same id that stopped, never another run's claim.
    host.remove(file);
    if (!host.createExclusive(file, JSON.stringify(mine))) return refuse("the folder claim could not be written (its name was taken meanwhile)");
    for (const name of host.listDir(dir)) {
      if (name.toLowerCase() === `${id}.json`.toLowerCase() || !name.toLowerCase().endsWith(".json")) continue;
      const text = host.readText(`${dir}\\${name}`);
      let other: Claim;
      try { other = JSON.parse(text ?? "") as Claim; if (typeof other !== "object" || other === null || !Array.isArray(other.folders)) throw new Error("not a claim"); } catch { return refuse(`a folder claim (${name}) cannot be read, so it counts as held`); }
      if (other.owner === owner) continue;
      if (!(await writerAlive(host, other.pid, other.at, other.runId))) continue;
      for (const f of folders) for (const g of other.folders) if (overlapsWin(f, g)) return refuse(`another run in progress uses ${g}, which is the same as or inside or around ${f}: one run at a time per workspace`);
    }
    return undefined;
  } catch (error) { return refuse(`the folder claim could not be made: ${(error as Error).message}`); }
}
const dropClaim = (host: NativeHost, settings: NativeSettings, id: string): void => { try { host.remove(`${claimsDir(settings)}\\${id}.json`); } catch { /* a dead claim is never counted */ } };

/** What the backend records about a run's profile BEFORE the launcher makes it (`profiles\\<name>.json`): enough to revoke and delete it without the job folder, after any crash. */
export interface ProfileRecord { readonly version: 1; readonly name: string; readonly runId: string; readonly jobDir: string; readonly pid: number; readonly at: string; readonly grants: readonly NativeGrant[]; readonly folders: readonly string[] }

function writeProfileRecord(host: NativeHost, settings: NativeSettings, record: ProfileRecord): void {
  host.mkdirp(profilesDir(settings));
  host.writeText(profileJson(settings, record.name), JSON.stringify(record));
}
/** A record of this backend, or undefined when absent, unreadable or not of the expected shape (the name inside must be the file's own and a per-run name). */
export function readProfileRecord(host: NativeHost, settings: NativeSettings, name: string): ProfileRecord | undefined {
  if (!isRunProfileName(name)) return undefined;
  const text = host.readText(profileJson(settings, name));
  if (text === undefined) return undefined;
  try {
    const r = JSON.parse(text) as ProfileRecord;
    return r.version === 1 && r.name === name && Array.isArray(r.grants) && Array.isArray(r.folders) && typeof r.pid === "number" ? r : undefined;
  } catch { return undefined; }
}
const SID_FILE = /^nn-run-profile v1\r?\n(NimbleNewtRun-[0-9a-f]{16}) (S-1-15-2(?:-\d{1,10}){7})\r?\n?$/;
/** The SID in the record the LAUNCHER wrote for this profile, or undefined when there is none (the launcher never got as far as making one) or it is not the launcher's format or names another profile. */
export function launcherSid(host: NativeHost, settings: NativeSettings, name: string): string | undefined {
  const text = host.readText(runProfileFor(settings, name).record, 4096);
  const m = text === undefined ? null : SID_FILE.exec(text);
  return m !== null && m[1] === name ? m[2]! : undefined;
}
const removeProfileRecords = (host: NativeHost, settings: NativeSettings, name: string): void => {
  // The launcher's record goes FIRST: a stop between the two then leaves only the backend's record, which the sweep retires (no launcher record: nothing was made or it is gone), never a launcher
  // record with no backend record, which no sweep would ever find.
  for (const f of [runProfileFor(settings, name).record, profileJson(settings, name)]) { try { host.remove(f); } catch { /* kept for the sweep */ } }
};

/**
 * Deletes a run's profile with the launcher's `delete-profile` (the launcher deletes only a per-run name with a record it wrote and the matching SID) and checks the answer: deleted AND gone.
 * Returns undefined when the profile is gone (the records are then removed), otherwise why not (the records stay for the next sweep). Never throws.
 */
async function deleteProfile(host: NativeHost, settings: NativeSettings, name: string, sid: string): Promise<string | undefined> {
  let line: LauncherLine | undefined;
  try { line = parseLauncherLine((await host.run(settings.launcher, ["delete-profile", "--name", name, "--sid", sid, "--profile-record", runProfileFor(settings, name).record], { timeoutMs: CHECK_MS })).stdout); } catch { line = undefined; }
  if (line === undefined) return `the launcher gave no answer to delete-profile for ${name}`;
  if (!line.ok || line.profileDeleted !== true || line.profileGone !== true) return `the container profile ${name} is not known to be gone (${line.error ?? (line.profileDeleted === true ? "it is still there after the delete" : "the delete failed")})`;
  removeProfileRecords(host, settings, name);
  return undefined;
}

/**
 * Ends one run's profile for good: its entries are revoked by SID and read back (the profile need not exist for that), then the profile is deleted and checked, then the records are removed. Anything
 * that cannot be shown done is a problem and the records stay, so the next sweep tries again. A profile with no launcher record never existed (the record is written before the profile), so there is
 * nothing to revoke or delete and the backend's record just goes. Never deletes without the launcher's own record: that is the launcher's proof, and the launcher checks it again.
 */
export async function retireProfile(host: NativeHost, settings: NativeSettings, record: ProfileRecord): Promise<string[]> {
  const sid = launcherSid(host, settings, record.name);
  if (sid === undefined) {
    if (host.exists(runProfileFor(settings, record.name).record)) return [`${record.name}: the launcher's profile record is not in the launcher's format, so nothing is revoked or deleted for it`];
    removeProfileRecords(host, settings, record.name);
    return [];
  }
  const back = await revokeAndReadBack(host, settings, record.grants, { name: record.name, sid });
  if (back.state !== "clean") return [`${record.name}: ${back.state === "left" ? `the container still has an entry on ${back.left.join(", ")}` : "the access lists could not be read back"}`];
  const problem = await deleteProfile(host, settings, record.name, sid);
  return problem === undefined ? [] : [`${record.name}: ${problem}`];
}

/**
 * Runs one job (called by the runner, and by the health probe). Fails closed with a typed reason when a volume is not NTFS, a grant cannot be made, the container or the job cannot be made or the
 * revoke cannot be read back clean; the program's standard output and error come back from the FILES the launcher gave it, and its exit code is passed through. The read-back and the revoke
 * happen on every path out, a failed launch included.
 */
export async function runNativeJob(host: NativeHost, job: NativeJob, stdin: string | undefined, jobDir: string, ports?: ChannelPorts): Promise<JobOutcome> {
  const { settings } = job;
  if (LIVE_HERE.has(job.runId)) return { exitCode: EXIT_BUSY, stdout: "", stderr: `${FAILURE_PREFIX}: busy: this run is already in progress\n` };
  const slot = await takeSlot(host, settings, job.runId);
  if (slot === undefined) return { exitCode: EXIT_BUSY, stdout: "", stderr: `${FAILURE_PREFIX}: busy: ${settings.maxConcurrentRuns > 1 ? `all ${settings.maxConcurrentRuns} native run slots are in use` : "another native run is in progress"}, or the last one's launcher may still be running (or the process list cannot be read to tell); ${settings.maxConcurrentRuns > 1 ? `${settings.maxConcurrentRuns} at a time` : "one at a time"}\n` };
  // The task's folders are claimed before anything else is done to them (a second run on the same or an overlapping workspace is refused as busy: its seal and workspace entries would meet this run's).
  const claimed = await claimFolders(host, settings, job.runId, job.runId, job.claim);
  if (claimed !== undefined) { dropSlot(host, slot, job.runId); return { exitCode: EXIT_BUSY, stdout: "", stderr: `${FAILURE_PREFIX}: busy: ${claimed}\n` }; }
  // The job file stays for the sweep (it needs the grants), but the launcher's argument list carries the recipe's environment values: once read they are not left on disk.
  try { host.writeText(jobFile(jobDir), JSON.stringify({ ...job, args: [] })); } catch { /* the control folder is the supervisor's own; a failed rewrite leaves the file as it was */ }
  const startedAt = new Date().toISOString();
  let line: LauncherLine | undefined;
  let failure: { kind: NativeFailure; message: string } | undefined;
  let applied = false;
  let profileRecorded = false;
  let relay: ChannelRelay | undefined;
  let channelFiles: { close(): void }[] = [];
  let relayEnd: Awaited<ReturnType<ChannelRelay["finish"]>> | undefined;
  const abort = new AbortController();
  try {
    // An earlier run that ended without its cleanup (a kill, a restart) may have left entries on task folders THIS run's program could use (the same workspace) and a container profile: they are revoked
    // by their own SID, read back and the profile deleted first, and the run does not start while any is left or another run may still have a program in the container.
    const earlier = await sweepLeftovers(host, settings, undefined, jobDir, true, job.runId);
    // Other runs in progress are expected when several may run at once (their claims keep a workspace to one run); with one slot, a run that may still be going is a reason not to start (as before).
    if (earlier.problems.length > 0 || (settings.maxConcurrentRuns <= 1 && earlier.live.length > 0)) failure = { kind: "revoke", message: `an earlier run's entries or container profile are not known to be gone, so this run does not start: ${[...earlier.problems, ...earlier.live.map((d) => `${d}: its runner or launcher may still be running`)].join("; ")}` };
    if (failure === undefined && job.requireNtfs) {
      for (const v of job.volumes) {
        const fs = await host.fileSystemOf(v);
        if (fs === undefined || fs.toUpperCase() !== "NTFS") { failure = { kind: "filesystem", message: `${v} is not on NTFS (${fs ?? "unreadable"}); a folder grant needs NTFS` }; break; }
      }
    }
    if (failure === undefined) {
      // The backend's record of this run's profile comes BEFORE the launcher makes the profile (and before anything is granted): it names the profile, the grants and the folders, so any later
      // sweep can revoke and delete without the job folder. A record that cannot be written stops the run.
      try { writeProfileRecord(host, settings, { version: 1, name: job.profile.name, runId: job.runId, jobDir, pid: host.pid, at: startedAt, grants: job.grants, folders: job.claim }); profileRecorded = true; }
      catch (error) { failure = { kind: "profile", message: `the profile record could not be written: ${(error as Error).message}` }; }
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
    // The claim and the slot are given back on EVERY path out of the cleanup below, a throw included: a slot kept by a run that is over would make every later run busy while this process lives.
    try {
      // The program has ended (or never started): the outbox is read to its end and both files are let go before anything is revoked or reported.
      if (relay !== undefined) {
        relayEnd = await relay.finish(line?.ok === true && line.childExitCode === 0 && line.timedOut !== true);
        if (relayEnd.fault !== undefined) failure = { kind: "channel", message: relayEnd.fault + (failure === undefined ? "" : ` (the run was then ended: ${failure.message})`) };
      }
      for (const f of channelFiles) { try { f.close(); } catch { /* released with the process */ } }
      // Every exit path: the revoke is read back by an independent look (not only the launcher's own report). It is made by the run's own SID, which the launcher recorded before it made the profile.
      const sid = launcherSid(host, settings, job.profile.name);
      const back: ReadBack = applied ? await revokeAndReadBack(host, settings, job.grants, { name: job.profile.name, ...(sid === undefined ? {} : { sid }) }) : { state: "clean", left: [] };
      // Then the profile: when the launcher says it deleted it and found it gone, that is that; otherwise (it was killed, it kept the profile because a grant would not revoke, the check was unsure) the
      // backend asks for the delete itself, and only a profile shown gone lets the records go. A profile whose entries are not all gone is kept (a later sweep revokes by SID first).
      let profileProblem: string | undefined;
      let profileGone = false;
      if (profileRecorded) {
        if (sid === undefined) { removeProfileRecords(host, settings, job.profile.name); profileGone = true; } // the launcher never made a profile for this run
        else if (back.state !== "clean") profileProblem = `the container profile ${job.profile.name} is kept because its entries are not all gone`;
        else if (line?.profileDeleted === true && line.profileGone === true) { removeProfileRecords(host, settings, job.profile.name); profileGone = true; }
        else { profileProblem = await deleteProfile(host, settings, job.profile.name, sid); profileGone = profileProblem === undefined; }
      }
      // The channel folder is in the container's scratch, so the container may have put a link or junction in its place: it is removed only after the revoke (nothing of the container may still change it)
      // and without following anything. What cannot be removed that way is left for the task's own cleanup and noted.
      if (job.channel !== undefined && host.channelFs !== undefined) {
        let gone = false;
        try { gone = host.channelFs?.removeFolder(job.channel.dir, [job.channel.inbox, job.channel.outbox]) === true; } catch { /* noted below */ }
        if (!gone && relayEnd !== undefined) relayEnd = { ...relayEnd, note: `${relayEnd.note === undefined ? "" : `${relayEnd.note}; `}the channel folder was left in the scratch folder (it could not be removed without following a link)` };
      }
      if (back.state !== "clean" && failure === undefined) failure = { kind: "revoke", message: back.state === "left" ? `the container still has an entry on ${back.left.join(", ")} after the run` : "the access lists could not be read back after the run" };
      else if (back.state !== "clean" && failure !== undefined) failure = { kind: failure.kind, message: `${failure.message}; also ${back.state === "left" ? `an entry for the container is still on ${back.left.join(", ")}` : "the access lists could not be read back"}` };
      if (profileProblem !== undefined && back.state === "clean") failure = failure === undefined ? { kind: "profile", message: profileProblem } : { kind: failure.kind, message: `${failure.message}; also ${profileProblem}` };
      const record: RunRecord = {
        runId: job.runId, mode: "native", container: settings.container, startedAt, childStarted: line?.childStarted === true,
        exitCode: line?.childExitCode ?? null, timedOut: line?.timedOut === true, ...(failure === undefined ? {} : { failure }),
        grants: (line?.grants ?? []).map((g) => ({ path: g.path, mode: g.mode, soft: g.soft, applied: g.applied, revoked: g.revoked, errorCode: g.errorCode ?? null })),
        softRefused: line === undefined ? [] : softRefusals(line), entriesLeft: back.left, readBack: back.state,
        ...(!profileRecorded ? {} : { profile: { name: job.profile.name, ...(sid === undefined ? {} : { sid }), deleted: profileGone, gone: profileGone } }),
        ...(relayEnd === undefined ? {} : { channel: { ...relayEnd.stats, ...(relayEnd.note === undefined ? {} : { note: relayEnd.note }) } }),
      };
      writeRecord(host, settings, record);
      // A clean run leaves nothing in the job folder but what is removed here; a run whose revoke could not be read back keeps its job file for the sweep.
      if (back.state === "clean" && (profileGone || !profileRecorded)) { host.remove(job.files.input); host.remove(statusFile(jobDir)); }
    } finally {
      dropClaim(host, settings, job.runId);
      dropSlot(host, slot, job.runId);
    }
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

export interface SweepResult { readonly released: number; readonly problems: readonly string[]; /** Folders and profiles whose run may still have a program in the container (left alone). */ readonly live: readonly string[] }

/**
 * Ends what a run that never finished (the runner was killed, the machine restarted) may have left, from the backend's OWN records only: for each job folder whose runner is gone, and for each profile
 * record (`profiles\\<name>.json`, written before the launcher makes a profile) whose writer is gone, the entries of THAT run's container SID are revoked and read back and the profile deleted and checked
 * (`retireProfile`); a clean one is removed, one that cannot be cleaned is kept and reported. Nothing scans the machine's profile list or the registry, and nothing is deleted without a record.
 * A run whose runner is alive is another run's and is left alone, and so is a record whose task folders another run in progress uses (its claim). `only` limits the sweep to one job folder.
 * `owner` is the id of the run (or sweeper) doing this: its own claims never count against it.
 */
export async function sweepLeftovers(host: NativeHost, settings: NativeSettings, only?: string, except?: string, mayRevoke = true, owner: string = `sweep-${host.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`): Promise<SweepResult> {
  const problems: string[] = [];
  const live: string[] = [];
  let released = 0;
  let claims = 0;
  /** Retires one record under a claim on its folders; true when it is clean (gone). */
  const retire = async (record: ProfileRecord, where: string): Promise<boolean> => {
    const id = `${owner}~${claims++}`;
    const held = await claimFolders(host, settings, id, owner, record.folders);
    if (held !== undefined) { problems.push(`${where}: ${held}; its entries are kept for a later sweep`); return false; }
    try {
      const found = await retireProfile(host, settings, record);
      for (const p of found) problems.push(`${where}: ${p}`);
      return found.length === 0;
    } finally { dropClaim(host, settings, id); }
  };
  const handled = new Set<string>();
  const dirs = (only === undefined ? host.listDir(jobsDir(settings)).map((n) => `${jobsDir(settings)}\\${n}`) : [only]).filter((d) => except === undefined || d.toLowerCase() !== except.toLowerCase());
  for (const dir of dirs) {
    // A folder with no status file was planned but its runner never started, so no grant was ever made for it (the backend's `release` removes it); a runner that is still alive owns its folder.
    const statusText = host.readText(statusFile(dir));
    // No status file: the runner never got past the slot (planned, refused as busy, or a clean run already removed it), so no grant of this folder's job is on any path. `release` removes the folder
    // without a revoke: another run's entries may be on the same folders.
    if (statusText === undefined) { if (only !== undefined) { host.remove(dir); released++; } continue; }
    let status: { runnerPid?: number; startedAt?: string; runId?: string } = {};
    try { status = JSON.parse(statusText ?? "{}") as typeof status; } catch { status = {}; }
    // A run that may still have a program in the container (its runner, or the launcher the runner started, is running; or that cannot be told) is never revoked: its seal would be lifted under a
    // live program. For `release` that is a problem to report; the folder stays for a later sweep.
    if (await writerAlive(host, status.runnerPid, status.startedAt, status.runId)) { live.push(dir); if (only !== undefined) problems.push(`${dir}: the run's runner or launcher may still be running, so its entries are kept until it ends (a later health check sweeps them)`); continue; }
    // Revoking needs a run slot: a run that starts meanwhile may apply its grants to the same task folders, and a seal revoke sent late would then lift ITS seal while its workspace entry stays.
    // Without the slot nothing is revoked; the slot's holder swept before it started, and a later sweep takes what is left.
    if (!mayRevoke) { problems.push(`${dir}: another native run holds the run slot, so its entries are kept for a later sweep (nothing is revoked while a run may be starting)`); continue; }
    const text = host.readText(jobFile(dir));
    let job: { grants?: unknown; profile?: { name?: unknown } };
    // The runner had started (the status file says so), so grants may exist: without a readable job file they are not known, which is a problem, never "nothing to revoke".
    try { job = JSON.parse(text ?? "") as typeof job; if (!Array.isArray(job.grants)) throw new Error("no grants"); } catch { problems.push(`${dir}: the job file is missing or cannot be read, so its grants are not known`); continue; }
    const name = typeof job.profile?.name === "string" ? job.profile.name : "";
    const record = readProfileRecord(host, settings, name);
    // Both records gone while the status file is still there: the run was retired (the backend's record is written before the status file and removed only after the read-back was clean and the
    // profile was shown gone, or the launcher never made one), and the runner stopped before it removed its status file. Nothing is left to revoke or delete; the folder goes.
    if (record === undefined && isRunProfileName(name) && !host.exists(profileJson(settings, name)) && !host.exists(runProfileFor(settings, name).record)) { host.remove(dir); released++; continue; }
    // The profile record is the proof of what this run made: without it nothing is revoked or deleted by guess.
    if (record === undefined) { problems.push(`${dir}: the run's profile record (${name || "no profile name in the job file"}) is missing or unreadable, so nothing is revoked or deleted for it`); continue; }
    handled.add(name);
    if (await retire(record, dir)) { host.remove(dir); released++; }
  }
  // Records whose job folder is gone or not listed: a crash between the record and the job folder's status, or a probe's profile.
  if (only === undefined) {
    for (const file of host.listDir(profilesDir(settings))) {
      // Windows file names are case-insensitive, so the prefix may be listed in any case; the name itself must be the exact per-run form (lower-case hex), and the record inside must carry it.
      const stem = file.replace(/\.json$/i, "");
      const name = /^nimblenewtrun-/i.test(stem) ? RUN_PROFILE_PREFIX + stem.slice(RUN_PROFILE_PREFIX.length) : stem;
      if (!/\.json$/i.test(file) || !isRunProfileName(name) || handled.has(name)) continue;
      const record = readProfileRecord(host, settings, name);
      if (record === undefined) { problems.push(`${name}: the profile record is unreadable, so nothing is revoked or deleted for it`); continue; }
      if (record.runId === owner || (except !== undefined && record.jobDir.toLowerCase() === except.toLowerCase())) continue;
      // A record whose job folder was in the list above was dealt with there (retired, or reported as live); only records with no listed job folder are handled here.
      if (record.jobDir !== "" && dirs.some((d) => d.toLowerCase() === record.jobDir.toLowerCase())) continue;
      if (await writerAlive(host, record.pid, record.at, record.runId)) { live.push(name); continue; }
      if (!mayRevoke) { problems.push(`${name}: another native run holds the run slot, so its profile is kept for a later sweep`); continue; }
      if (await retire(record, name)) { released++; if (record.jobDir !== "" && overlapsWin(record.jobDir, jobsDir(settings)) && record.jobDir.toLowerCase() !== jobsDir(settings).toLowerCase()) host.remove(record.jobDir); }
    }
  }
  return { released, problems, live };
}

/**
 * `sweepLeftovers` for callers outside a run (the health check and `release`): a run slot is taken first and held for the sweep, so no revoke of an earlier run's paths can overlap a run that
 * applies its grants to the same folders. While every slot is held by a running run nothing is revoked (a folder that had started is reported, one that never started is still removed by `release`).
 */
export async function sweepLeftoversLocked(host: NativeHost, settings: NativeSettings, only?: string): Promise<SweepResult> {
  const id = `sweep-${host.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const slot = await takeSlot(host, settings, id);
  try { return await sweepLeftovers(host, settings, only, undefined, slot !== undefined, id); } finally {
    if (slot !== undefined) dropSlot(host, slot, id);
  }
}

/** The health probe's own container profile: made and deleted exactly as a run's is (the launcher's `info`), with a record first so a crash is swept like a run's. */
export async function probeProfile(host: NativeHost, settings: NativeSettings, name: string): Promise<{ readonly line: LauncherLine | undefined; readonly problem?: string; readonly error?: string }> {
  const profile = runProfileFor(settings, name);
  const now = new Date().toISOString();
  const probeId = `probe-${name}`;
  // In progress in THIS process for as long as it takes: a sweep that runs meanwhile (a run's own, in this process) must not take its record for a dead run's.
  LIVE_HERE.add(probeId);
  try { return await probeInner(host, settings, name, profile, probeId, now); } finally { LIVE_HERE.delete(probeId); }
}

async function probeInner(host: NativeHost, settings: NativeSettings, name: string, profile: RunProfile, probeId: string, now: string): Promise<{ readonly line: LauncherLine | undefined; readonly problem?: string; readonly error?: string }> {
  try { writeProfileRecord(host, settings, { version: 1, name, runId: probeId, jobDir: "", pid: host.pid, at: now, grants: [], folders: [] }); } catch (error) { return { line: undefined, error: `the profile record could not be written: ${(error as Error).message}` }; }
  let line: LauncherLine | undefined;
  let error: string | undefined;
  try { line = parseLauncherLine((await host.run(settings.launcher, ["info", "--name", name, "--profile-record", profile.record], { timeoutMs: 60_000 })).stdout); } catch (e) { error = (e as Error).message; }
  const sid = launcherSid(host, settings, name);
  let problem: string | undefined;
  if (sid === undefined) removeProfileRecords(host, settings, name); // the launcher never made a profile
  else if (line?.profileDeleted === true && line.profileGone === true) removeProfileRecords(host, settings, name);
  else problem = await deleteProfile(host, settings, name, sid);
  return { line, ...(problem === undefined ? {} : { problem }), ...(error === undefined ? {} : { error }) };
}
