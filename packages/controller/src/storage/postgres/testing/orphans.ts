import { spawnSync } from "node:child_process";
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, type Stats } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

/**
 * Test servers left behind by killed test processes (follow-up of card 19).
 *
 * A test process killed from outside (a per-file time-out, SIGKILL) never stops its embedded PostgreSQL server: the server is re-parented to init and
 * keeps running, and its `nn-test-pg-*` folder stays in the temp directory (a RAM disk on Linux). Each server folder therefore records the process that
 * owns it (`owner.json`: pid, the process's start time, so a reused pid is not mistaken for the owner, and the boot it ran in), and the next test server
 * start sweeps the temp directory: only folders whose recorded owner is provably gone are removed, after their own postgres (checked by its pid file and
 * command line) is stopped. Nothing else is touched (see `sweepOrphanedServers`).
 */

export const OWNER_FILE = "owner.json";
/** mkdtemp's six random characters after the prefix; nothing else is ever looked at. */
const FOLDER_NAME = /^nn-test-pg-[A-Za-z0-9]{6}$/;
/** A folder without an owner record (made by an older harness, or by a start killed before it wrote one) is left alone until it is this old. */
export const UNRECORDED_MIN_AGE_MS = 24 * 60 * 60 * 1000;
const MAX_OWNER_BYTES = 4096;
const MAX_LOG_LINES = 10;

export interface OwnerRecord {
  readonly version: 1;
  readonly pid: number;
  /** Linux: field 22 of /proc/<pid>/stat (clock ticks since boot); macOS: `ps -o lstart=`. */
  readonly startTime: string;
  /** Linux only: /proc/sys/kernel/random/boot_id. A different boot means the owner is gone. */
  readonly bootId?: string;
  /**
   * Linux only: the pid and time namespaces of the owner (`/proc/self/ns/pid`, `/proc/self/ns/time`). A pid, and the start time /proc shows for it,
   * mean something only inside one pid (and time) namespace: a test run in a sandbox with its own pid namespace that shares the temp directory would
   * otherwise look gone to a sweep outside it (and the other way round). A record from another namespace is never judged; a Linux record without these
   * is treated like a folder without a record.
   */
  readonly pidNamespace?: string;
  readonly timeNamespace?: string;
  readonly host: string;
  readonly createdAt: string;
}

type Liveness = { readonly state: "alive"; readonly startTime: string; readonly ppid?: number } | { readonly state: "gone" } | { readonly state: "unknown" };

function readSmall(path: string): string | undefined {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}

function bootId(): string | undefined {
  if (process.platform !== "linux") return undefined;
  return readSmall("/proc/sys/kernel/random/boot_id")?.trim() || undefined;
}

/** Linux: this process's namespace identity (e.g. `pid:[4026531836]`), or undefined when it cannot be read (or the kernel has no such namespace). */
function namespaceOf(kind: "pid" | "time"): string | undefined {
  if (process.platform !== "linux") return undefined;
  try { return readlinkSync(`/proc/self/ns/${kind}`) || undefined; } catch { return undefined; }
}

/** Whether a process exists, and when it started. "unknown" whenever that cannot be told for certain (then nothing is removed). */
export function processLiveness(pid: number): Liveness {
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: "unknown" };
  let exists = false;
  try { process.kill(pid, 0); exists = true; } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return { state: "gone" };
    if (code !== "EPERM") return { state: "unknown" }; // EPERM: it exists, under another user
    exists = true;
  }
  if (process.platform === "linux") {
    const stat = readSmall(`/proc/${pid}/stat`);
    // The signal said it exists: a /proc that hides it (hidepid) does not make it gone.
    if (stat === undefined) return exists || existsProc(pid) ? { state: "unknown" } : { state: "gone" };
    // The command name (field 2) can hold spaces and parentheses: the fields after the LAST ')' are fixed. Field 3 is the state, field 22 the start time.
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    if (fields[0] === "Z" || fields[0] === "X") return { state: "gone" }; // a zombie runs nothing any more
    const start = fields[19];
    const ppid = Number(fields[1]);
    return start !== undefined && /^\d+$/.test(start) ? { state: "alive", startTime: start, ...(Number.isSafeInteger(ppid) ? { ppid } : {}) } : { state: "unknown" };
  }
  if (process.platform === "darwin") {
    const run = spawnSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
    if (run.error !== undefined || run.status === null) return { state: "unknown" };
    const said = run.stdout.trim();
    if (run.status !== 0 && said === "") return { state: "gone" };
    if (said === "") return { state: "unknown" };
    const parent = spawnSync("ps", ["-o", "ppid=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
    const ppid = parent.status === 0 ? Number(parent.stdout.trim()) : NaN;
    return { state: "alive", startTime: said, ...(Number.isSafeInteger(ppid) && parent.stdout.trim() !== "" ? { ppid } : {}) };
  }
  return { state: "unknown" };
}

function existsProc(pid: number): boolean {
  try { lstatSync(`/proc/${pid}`); return true; } catch { return false; }
}

/** The owner record for the current process, or undefined on a platform where a process's start time cannot be read (then no folder is ever swept). */
export function ownerRecordForThisProcess(): OwnerRecord | undefined {
  const self = processLiveness(process.pid);
  if (self.state !== "alive") return undefined;
  const boot = bootId();
  const pidNamespace = namespaceOf("pid");
  const timeNamespace = namespaceOf("time");
  return {
    version: 1, pid: process.pid, startTime: self.startTime, ...(boot === undefined ? {} : { bootId: boot }),
    ...(pidNamespace === undefined ? {} : { pidNamespace }), ...(timeNamespace === undefined ? {} : { timeNamespace }),
    host: hostname(), createdAt: new Date().toISOString(),
  };
}

/** Writes the record into a server folder, atomically (a reader sees no record or a whole one). */
export function writeOwnerRecord(directory: string, record: OwnerRecord | undefined = ownerRecordForThisProcess()): void {
  if (record === undefined) return;
  const temporary = join(directory, `.${OWNER_FILE}.${process.pid}`);
  writeFileSync(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 });
  renameSync(temporary, join(directory, OWNER_FILE));
}

/** Reads a file only if it is a regular file (a symlink is never followed), small, and owned by this user. */
function readOwnFileNoFollow(path: string, maxBytes: number): string | undefined {
  let fd: number;
  // No-follow (a link is never read through) and non-blocking (a FIFO planted under the name would otherwise block the open).
  try { fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0)); } catch { return undefined; }
  try {
    const stats = fstatSync(fd);
    if (!stats.isFile() || stats.size > maxBytes || !ownedByMe(stats)) return undefined;
    const buffer = Buffer.alloc(stats.size);
    const read = readSync(fd, buffer, 0, stats.size, 0);
    return buffer.subarray(0, read).toString("utf8");
  } catch { return undefined; } finally { closeSync(fd); }
}

function ownedByMe(stats: Stats): boolean {
  return typeof process.getuid !== "function" || stats.uid === process.getuid();
}

function parseOwner(text: string | undefined): OwnerRecord | "malformed" | undefined {
  if (text === undefined) return undefined;
  try {
    const value = JSON.parse(text) as Partial<OwnerRecord>;
    if (value.version !== 1 || !Number.isSafeInteger(value.pid) || typeof value.startTime !== "string" || value.startTime === "" || typeof value.host !== "string") return "malformed";
    if (value.bootId !== undefined && typeof value.bootId !== "string") return "malformed";
    if (value.pidNamespace !== undefined && typeof value.pidNamespace !== "string") return "malformed";
    if (value.timeNamespace !== undefined && typeof value.timeNamespace !== "string") return "malformed";
    return value as OwnerRecord;
  } catch { return "malformed"; }
}

/** Whether the recorded owner is provably gone: another boot, no such process, or a process with the same pid that started at another time. */
function ownerGone(owner: OwnerRecord, liveness: (pid: number) => Liveness): "gone" | "alive" | "unknown" {
  if (owner.host !== hostname()) return "unknown"; // a temp folder shared between machines: not ours to judge
  const boot = bootId();
  if (owner.bootId !== undefined && boot !== undefined && owner.bootId !== boot) return "gone";
  // Another pid (or time) namespace: its pid and start time say nothing here. Either side unreadable: cannot be told.
  if (process.platform === "linux") {
    const pidNs = namespaceOf("pid");
    if (owner.pidNamespace === undefined || pidNs === undefined || owner.pidNamespace !== pidNs) return "unknown";
    if (owner.timeNamespace !== namespaceOf("time")) return "unknown";
  }
  const now = liveness(owner.pid);
  if (now.state === "gone") return "gone";
  if (now.state === "unknown") return "unknown";
  return now.startTime === owner.startTime ? "alive" : "gone";
}

/** The command line of a process, as its arguments; undefined when it cannot be read. */
function commandLine(pid: number): string[] | undefined {
  if (process.platform === "linux") {
    const raw = readSmall(`/proc/${pid}/cmdline`);
    if (raw === undefined || raw === "") return undefined;
    return raw.replace(/\0$/, "").split("\0");
  }
  if (process.platform === "darwin") {
    const run = spawnSync("ps", ["-ww", "-o", "command=", "-p", String(pid)], { encoding: "utf8", timeout: 10_000 });
    if (run.error !== undefined || run.status !== 0) return undefined;
    return run.stdout.trim().split(/\s+/);
  }
  return undefined;
}

/**
 * The postgres server running on this folder's data, if any: the pid named by `data/postmaster.pid`, only if that file names this data directory and the
 * process with that pid is a `postgres` whose `-D` is this data directory. "stale" when the pid file names a process that is gone or is something else
 * (a reused pid): nothing to stop. "unsure" when it cannot be told (then the folder is kept).
 */
export function folderServer(folder: string, command: (pid: number) => string[] | undefined = commandLine, liveness: (pid: number) => Liveness = processLiveness): { readonly state: "none" | "stale" | "unsure" } | { readonly state: "running"; readonly pid: number; readonly startTime: string; readonly ppid?: number } {
  const dataDirectory = join(folder, "data");
  const pidFile = readOwnFileNoFollow(join(dataDirectory, "postmaster.pid"), 64 * 1024);
  if (pidFile === undefined) {
    // No pid file (never started, stopped cleanly) or one we may not read: a server that is running always has a readable one of ours.
    try { lstatSync(join(dataDirectory, "postmaster.pid")); return { state: "unsure" }; } catch { return { state: "none" }; }
  }
  const [pidLine, dataLine] = pidFile.split("\n");
  const pid = Number(pidLine?.trim());
  if (!Number.isSafeInteger(pid) || pid <= 1) return { state: "unsure" };
  if (dataLine === undefined || !samePath(dataLine.trim(), dataDirectory)) return { state: "unsure" };
  const alive = liveness(pid);
  if (alive.state === "gone") return { state: "stale" };
  if (alive.state === "unknown") return { state: "unsure" };
  const argv = command(pid);
  if (argv === undefined) return { state: "unsure" };
  // The command line belongs to the process seen before it only if that process is still the same one after (a pid reused in between is not ours).
  const after = liveness(pid);
  if (after.state !== "alive" || after.startTime !== alive.startTime) return { state: "unsure" };
  const isPostgres = argv.length > 0 && basename(argv[0]!) === "postgres";
  const dIndex = argv.indexOf("-D");
  const ourData = dIndex >= 0 && argv[dIndex + 1] !== undefined && samePath(argv[dIndex + 1]!, dataDirectory);
  if (isPostgres && ourData) return { state: "running", pid, startTime: alive.startTime, ...(alive.ppid === undefined ? {} : { ppid: alive.ppid }) };
  return { state: "stale" }; // the pid now belongs to another program (or another server): the server of this folder is not running
}

function samePath(a: string, b: string): boolean {
  if (resolve(a) === resolve(b)) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

export interface StopSteps {
  readonly graceMs: number;
  readonly immediateMs: number;
  readonly killMs: number;
}
const STOP_STEPS: StopSteps = { graceMs: 10_000, immediateMs: 5_000, killMs: 5_000 };

const pause = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/** Fast shutdown (SIGINT), then immediate (SIGQUIT), then SIGKILL, each bounded. True when the process is gone (or its pid now names another process). */
async function stopServer(pid: number, startTime: string, steps: StopSteps, liveness: (pid: number) => Liveness): Promise<boolean> {
  const gone = (): boolean => { const now = liveness(pid); return now.state === "gone" || (now.state === "alive" && now.startTime !== startTime); };
  const waitGone = async (ms: number): Promise<boolean> => {
    for (const deadline = Date.now() + ms; ;) {
      if (gone()) return true;
      if (Date.now() >= deadline) return false;
      await pause(50);
    }
  };
  for (const [signal, ms] of [["SIGINT", steps.graceMs], ["SIGQUIT", steps.immediateMs], ["SIGKILL", steps.killMs]] as const) {
    if (gone()) return true;
    try { process.kill(pid, signal); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return true; return false; }
    if (await waitGone(ms)) return true;
  }
  return false;
}

export interface SweepEntry {
  readonly folder: string;
  readonly action: "removed" | "kept" | "would-remove";
  readonly reason: string;
  readonly stoppedPid?: number;
}

export interface SweepOptions {
  /** The folder whose `nn-test-pg-*` children are looked at. Must be the system temp directory or inside it. Default: the system temp directory. */
  readonly root?: string;
  /** "remove" (default), "report" (decide and log, change nothing), or "off". The environment variable NIMBLENEWT_TEST_PG_SWEEP overrides the default. */
  readonly mode?: "remove" | "report" | "off";
  readonly unrecordedMinAgeMs?: number;
  readonly now?: number;
  readonly steps?: StopSteps;
  readonly log?: (line: string) => void;
  /** Tests only: how processes are seen. */
  readonly liveness?: (pid: number) => Liveness;
  readonly command?: (pid: number) => string[] | undefined;
}

function insideTemp(root: string): boolean {
  let real: string;
  let temp: string;
  try { real = realpathSync(root); temp = realpathSync(tmpdir()); } catch { return false; }
  return real === temp || real.startsWith(temp.endsWith(sep) ? temp : temp + sep);
}

/** The newest change among the folder, its data folder and the pid file: a running server changes them; the folder alone would look old. */
function newestChange(folder: string): number {
  let newest = 0;
  for (const path of [folder, join(folder, "data"), join(folder, "data", "postmaster.pid"), join(folder, "data", "global", "pg_control"), join(folder, "data", "pg_wal")]) {
    try { const s = lstatSync(path); newest = Math.max(newest, s.mtimeMs, s.ctimeMs); } catch { /* not there */ }
  }
  return newest;
}

/**
 * Looks at every `nn-test-pg-XXXXXX` folder directly in `root` and removes only those whose owner is provably gone:
 * - the folder is a real directory owned by this user (a symlink is never followed), named exactly like mkdtemp's folders, and `root` is the system temp
 *   directory or inside it;
 * - its owner record names a process on this host that no longer exists, or a pid now used by a process that started at another time, or another boot;
 *   a live owner, or an owner that cannot be checked, keeps the folder;
 * - a folder without a record (older harness, or a start killed in the first moment) only once nothing in it changed for `unrecordedMinAgeMs` (24 h),
 *   and then its server only if that server itself started before then too;
 * - a server still running on the folder is stopped first (fast, immediate, then kill, bounded), and only after its pid file names this data folder and
 *   its command line is `postgres -D <this data folder>`. If it cannot be stopped, or that cannot be told, the folder is kept.
 * Every decision about a folder that is not plainly someone's live server is logged.
 */
export async function sweepOrphanedServers(options: SweepOptions = {}): Promise<SweepEntry[]> {
  const envMode = process.env["NIMBLENEWT_TEST_PG_SWEEP"];
  const mode = options.mode ?? (envMode === "off" || envMode === "report" ? envMode : "remove");
  if (mode === "off") return [];
  const root = options.root ?? tmpdir();
  const log = options.log ?? ((line: string) => { process.stderr.write(`[embedded-postgres] ${line}\n`); });
  const liveness = options.liveness ?? processLiveness;
  const command = options.command ?? commandLine;
  const steps = options.steps ?? STOP_STEPS;
  const now = options.now ?? Date.now();
  const minAge = options.unrecordedMinAgeMs ?? UNRECORDED_MIN_AGE_MS;
  if (process.platform === "win32" || !insideTemp(root)) return [];
  let names: string[];
  try { names = readdirSync(root); } catch { return []; }
  const entries: SweepEntry[] = [];
  for (const name of names) {
    if (!FOLDER_NAME.test(name)) continue;
    const folder = join(root, name);
    let stats: Stats;
    try { stats = lstatSync(folder); } catch { continue; }
    if (!stats.isDirectory() || stats.isSymbolicLink() || !ownedByMe(stats)) continue;
    const read = parseOwner(readOwnFileNoFollow(join(folder, OWNER_FILE), MAX_OWNER_BYTES));
    // A Linux record without the owner's pid namespace (written before it was recorded) cannot be judged by its pid: like no record.
    const owner = typeof read === "object" && process.platform === "linux" && read.pidNamespace === undefined ? "malformed" : read;
    let why: string;
    if (owner === undefined || owner === "malformed") {
      const age = now - newestChange(folder);
      if (age < minAge) continue; // young, or changing: possibly a server being started by a harness that writes no record
      why = `${owner === "malformed" ? "an unreadable" : "no"} owner record, unchanged for ${Math.round(age / 3_600_000)} h`;
    } else {
      const verdict = ownerGone(owner, liveness);
      if (verdict !== "gone") continue;
      why = `its owner process ${owner.pid} (started ${owner.startTime}) is gone`;
    }
    const server = folderServer(folder, command, liveness);
    if (server.state === "unsure") { entries.push({ folder, action: "kept", reason: `${why}, but whether its server still runs cannot be told` }); continue; }
    let serverStart: string | undefined;
    if (server.state === "running") {
      serverStart = server.startTime;
      // A server left by a killed test process has been taken over by init (pid 1). One whose parent still runs is someone's live server, whatever
      // the record says (a misjudged owner never gets it stopped); a parent that cannot be seen cannot be told either.
      const parent = server.ppid === undefined ? undefined : server.ppid === 1 ? "init" : liveness(server.ppid).state;
      if (parent !== "init" && parent !== "gone") { entries.push({ folder, action: "kept", reason: `${why}, but its server ${server.pid} is still the child of a running process (${server.ppid ?? "unknown"})` }); continue; }
      if (owner === undefined || owner === "malformed") {
        // Without a record only a server that is itself old: its pid file was written when it started.
        let pidFileAge = 0;
        try { pidFileAge = now - lstatSync(join(folder, "data", "postmaster.pid")).mtimeMs; } catch { /* gone meanwhile */ }
        if (pidFileAge < minAge) { entries.push({ folder, action: "kept", reason: `${why}, but its server ${server.pid} started recently` }); continue; }
      }
    }
    if (mode === "report") { entries.push({ folder, action: "would-remove", reason: why, ...(server.state === "running" ? { stoppedPid: server.pid } : {}) }); continue; }
    if (server.state === "running") {
      const stopped = await stopServer(server.pid, serverStart!, steps, liveness);
      if (!stopped) { entries.push({ folder, action: "kept", reason: `${why}, but its server ${server.pid} did not stop` }); continue; }
    }
    try {
      // Check once more that the path is still the same real folder (not swapped for a link) right before removing it; rmSync never follows links inside.
      const again = lstatSync(folder);
      if (!again.isDirectory() || again.ino !== stats.ino || again.dev !== stats.dev) { entries.push({ folder, action: "kept", reason: `${why}, but the folder changed while it was looked at` }); continue; }
      rmSync(folder, { recursive: true, force: true, maxRetries: 4, retryDelay: 100 });
      entries.push({ folder, action: "removed", reason: why, ...(server.state === "running" ? { stoppedPid: server.pid } : {}) });
    } catch (error) {
      entries.push({ folder, action: "kept", reason: `${why}, but removing it failed: ${error instanceof Error ? error.message : String(error)}` });
    }
  }
  // At most this many lines per sweep: every test process sweeps once, and a temp directory full of leftovers would otherwise repeat them all in each.
  for (const entry of entries.slice(0, MAX_LOG_LINES)) {
    const verb = entry.action === "removed" ? "removed orphaned test server folder" : entry.action === "would-remove" ? "would remove orphaned test server folder (report mode)" : "kept test server folder";
    log(`${verb} ${entry.folder}: ${entry.reason}${entry.stoppedPid !== undefined ? `; ${entry.action === "removed" ? "stopped" : "would stop"} its postgres ${entry.stoppedPid}` : ""}`);
  }
  const rest = entries.slice(MAX_LOG_LINES);
  if (rest.length > 0) log(`... and ${rest.length} more test server folders (${rest.filter((e) => e.action === "removed").length} removed, ${rest.filter((e) => e.action === "would-remove").length} would be removed, ${rest.filter((e) => e.action === "kept").length} kept)`);
  return entries;
}

const sweptRoots = new Set<string>();

/** Runs the sweep once per process and root, never failing the caller's start. */
export async function sweepOnce(root: string = tmpdir()): Promise<void> {
  const key = resolve(root);
  if (sweptRoots.has(key)) return;
  sweptRoots.add(key);
  try { await sweepOrphanedServers({ root }); } catch (error) {
    process.stderr.write(`[embedded-postgres] the orphaned test server sweep failed (ignored): ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
