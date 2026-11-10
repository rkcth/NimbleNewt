import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { link, lstat, mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { constants, createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { FileBlobStore } from "../artifacts/index.js";
import { DomainError } from "../domain/errors.js";
import type { LedgerEntry } from "../retention/ledger.js";
import { canonicalJson } from "../storage/json.js";
import type { ControllerStorage } from "../storage/types.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { PostgresStorage, PostgresSwapBusy, asideSchemaOf, postgresRestorePort, stagedSchemaOf, type PostgresRestorePort } from "../storage/postgres/index.js";
import { postgresFingerprint } from "../transfer/transfer.js";
import { UnlockFailed, type BackupKey } from "./crypto.js";
import type { MaintenanceBarrier } from "./barrier.js";
import type { BackupService } from "./service.js";
import { ProofRefused, type UnlockMethod } from "./encryption.js";
import { listBackups } from "./retention.js";
import { RestoreRefused, restoreBackup, type RestoreResult } from "./restore.js";
import { manifestDigestOf, readManifest, verifyBackup } from "./verify.js";
import { tableFile, type BackupManifest } from "./format.js";
import { validStoreId } from "./pi-state.js";
import { acquireDataLocks, LINK_FALLBACK_CODES, type DataLock } from "./data-lock.js";
import { canon, canonSync } from "./canon.js";
export { canon, canonSync };

/**
 * Restoring from inside the running controller (card K01h), for the owner. A running controller owns its database, so a restore cannot write into it: the backup is verified, restored into a NEW database and new
 * conversation-store folders BESIDE the live ones (same folder, so the same device: a rename never crosses a device), the live data is made safe with a pre-restore snapshot, a marker file records the swap, and the
 * maintenance barrier stays up (every command refused) until the controller is started again. The next start (`applyPendingRestore`, before the database is opened, holding the data directory's lock) moves the old
 * database aside (`<db>.before-restore-<stamp>`) and puts the restored one in its place, move by move in a journal: a move that fails (a file in use on Windows, a device boundary) rolls the moves already made back, so
 * the live data is whole again, and the failure is recorded in the marker for the owner to cancel or retry. Nothing is deleted.
 * On PostgreSQL (card K01i) the restore is written into a NEW schema of the same database (`nnrs_<digest>_<stamp>`), and the start swaps it in with one transaction that renames the live schema aside
 * (`<schema>_br_<stamp>`) and the staged one into its name; that transaction is the last move of the same journal (the conversation folders move first), and it is undone the same way. The swap is refused while another
 * controller is connected to the database (by its application name), so a running controller never has its schema renamed under it.
 * Provisional: the controller does not end its own process (the host decides how it is restarted, `onStaged` tells it).
 */
export const PENDING_FILE = "pending-restore.json";
export const JOURNAL_FILE = "restore-journal.json";
export const KEY_FILE = ".nn-restore.key";
/** Kept for callers of the first slice: staging is now beside each target (`<target>.nn-staged-<stamp>`), so this folder is no longer made. */
export const STAGING_DIR = ".nn-restore";
export const DEFAULT_CONFIRM_MINUTES = 30;
/** Counted in recorded audit rows (a busy installation writes several per operation), so the default is generous; the owner sets it (`restoreChangeMargin`, null: not checked). */
export const DEFAULT_CHANGE_MARGIN = 200;

export interface RestorePlan {
  /** The proposal's confirmation: apply needs exactly this. It is bound to the whole manifest of the backup (every file, the artifact and conversation indexes), the installation's epoch and the time it was issued; the expiry is the owner's CURRENT setting applied to that time when it is used, so an approved preview cannot be applied to something else or later than allowed. */
  readonly token: string;
  /** When the token stops being accepted (absent: it does not expire). */
  readonly expiresAt?: string;
  readonly name: string;
  readonly createdAt: string;
  readonly kind: string;
  readonly version: string;
  readonly schemaVersion: number;
  readonly encrypted: boolean;
  readonly rows: number;
  readonly artifactFiles: number;
  readonly piStores: number;
  readonly piFiles: number;
  /** Whether the backup holds the agents' conversation state (and, if it was left incomplete, what could not be copied). */
  readonly piStateIncluded: boolean;
  readonly piStateProblems?: readonly string[];
  /** Records written after this backup was made, which the restore discards (counted from the audit trail at preview time; the apply reports the exact figure at the moment it runs). */
  readonly changesSinceBackup?: number;
  /** Counted from a plain backup; absent for an encrypted one (its rows can only be read after the unlock). */
  readonly effectsToMarkUncertain?: number;
  readonly deliveriesToResend?: number;
  /** What the owner will see happen, in order. */
  readonly steps: readonly string[];
  readonly warnings: readonly string[];
}

export interface PendingRestore {
  readonly format: 2;
  readonly name: string;
  readonly stamp: string;
  readonly preparedAt: string;
  /** `postgres`: `liveDb` is the database's place (server, port, database and schema; never the password) and `stagedDb` the staged schema's name. Absent: SQLite files. */
  readonly database?: "postgres";
  readonly stagedDb: string;
  readonly liveDb: string;
  readonly pi: readonly { readonly id: string; readonly staged: string; readonly target: string }[];
  /** Set when the swap was tried at a start and failed (everything was rolled back, or not: `rolledBack`). The restore is not applied until the owner cancels it and prepares it again. */
  readonly failed?: { readonly at: string; readonly reason: string; readonly rolledBack: boolean };
  /** HMAC of the other fields under the controller's key (`.nn-restore.key` in the data directory): a marker anything else wrote is refused. */
  readonly mac?: string;
}

export interface StagedRestoreOptions {
  readonly backups: BackupService;
  readonly root: string;
  readonly barrier: MaintenanceBarrier;
  /** The live database file (SQLite). Exactly one of this and `postgres` is given. */
  readonly sqlitePath?: string;
  /** The live PostgreSQL schema (card K01i): the address (a secret: it is never shown or written anywhere), the schema, and how a staged schema is opened (default: `PostgresStorage.open` with that schema; the host passes the same server options as the live open). */
  readonly postgres?: PostgresLive["postgres"];
  /** The folder the markers and the key live in (the data directory). */
  readonly dataDirectory: string;
  readonly storage: Pick<ControllerStorage, "currentEpoch" | "snapshot"> & Partial<Pick<ControllerStorage, "listAudit">>;
  readonly blobs?: FileBlobStore;
  /** Where the live conversation store `id` is on this machine; one not known goes to `<data>/restored-pi-state/<id>`. The same function must be given to `applyPendingRestore` (it is the list of places a restore may write to). */
  readonly piFinal?: (id: string) => string | undefined;
  /** The unlock for an encrypted backup (reads a host file; never an argument). */
  readonly unlock?: (method: UnlockMethod) => Promise<BackupKey>;
  readonly deletions?: () => Promise<readonly LedgerEntry[]>;
  readonly onStaged?: (pending: PendingRestore) => void;
  /**
   * How the controller gets restarted once a restore is staged (card K01i). `automatic`: the host's own restart (it closes this controller and starts it again), called `delayMs` after the restore is staged, so the owner's
   * reply goes out first; a failure is shown in the status with the instruction. `instruction`: what the owner must do on this host (default: a generic "stop the controller and start it again"). Without `automatic` the
   * owner restarts it by hand and every reply says how.
   */
  readonly restart?: { readonly automatic?: () => void | Promise<void>; readonly instruction?: string; /** How long after the restore is staged the automatic restart is called, so the owner's reply is sent first (default 1000 ms). */ readonly delayMs?: number };
  readonly now?: () => Date;
  /** How long an approval token is accepted, in minutes: the owner's setting (`restoreConfirmMinutes`); null: no expiry; absent: 30. */
  readonly confirmMinutes?: () => Promise<number | null | undefined>;
  /** How many more recorded changes than the preview showed an apply tolerates before it asks for a new preview (the owner's setting `restoreChangeMargin`); null: not checked; absent: 200 (audit rows, not operations). Provisional. */
  readonly changeMargin?: () => Promise<number | null | undefined>;
  /** Whether the backups made here include the agents' conversation state (false: `piState` is not configured on this installation, and every plan says so). */
  readonly piStateConfigured?: boolean;
  /** The data directory lock this controller keeps: a restore is prepared only while it is held (it is taken now if it is not, or the restore is refused). Absent: not checked (a host that does not lock). */
  readonly lock?: { require(): Promise<void> };
  /** The hard link used to make the key file (tests inject one that fails the way some file systems do). */
  readonly link?: (existing: string, path: string) => Promise<void>;
  /** The device of a path (tests). */
  readonly deviceOf?: (path: string) => Promise<number>;
}

/** The live database of a restore: the SQLite file's path, or a PostgreSQL schema. */
export type RestoreDatabase = string | PostgresLive;
export interface PostgresLive { readonly postgres: { readonly url: string; readonly schema: string; readonly port?: PostgresRestorePort; readonly openStaged?: (schema: string) => Promise<ControllerStorage> } }
interface Live { readonly id: string; readonly dbDir?: string; readonly pg?: { readonly url: string; readonly schema: string; readonly port: PostgresRestorePort; readonly openStaged?: (schema: string) => Promise<ControllerStorage> } }
async function liveOf(db: RestoreDatabase): Promise<Live> {
  if (typeof db === "string") { const id = await canon(db); return { id, dbDir: dirname(id) }; }
  return { id: postgresFingerprint(db.postgres.url, db.postgres.schema), pg: { url: db.postgres.url, schema: db.postgres.schema, port: db.postgres.port ?? postgresRestorePort(db.postgres.url), ...(db.postgres.openStaged === undefined ? {} : { openStaged: db.postgres.openStaged }) } };
}

const stampOf = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
export const BACKUP_NAME = /^backup-[0-9TZ]{16}-(manual|scheduled|pre-upgrade|pre-restore)$/;
const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"] as const;
const STAGED = ".nn-staged-";

/** Whether `p` is a path strictly below `root` (platform-correct: no string prefix test). */
const inside = (root: string, p: string): boolean => { const r = relative(resolve(root), resolve(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };

async function exists(p: string): Promise<boolean> { return stat(p).then(() => true, () => false); }

async function countRows(file: string, test: (row: Record<string, unknown>) => boolean): Promise<number> {
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) { if (line !== "" && test(JSON.parse(line) as Record<string, unknown>)) n += 1; }
  return n;
}

const macOf = (key: Buffer, value: object): string => createHmac("sha256", key).update(canonicalJson(value as never)).digest("hex");
const macEqual = (a: string, b: unknown): boolean => typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
/** The key as the file holds it; a file that is not a plain file (a link is not followed), is empty or is torn counts as no key. */
async function readKeyFile(path: string): Promise<Buffer | undefined> {
  const info = await lstat(path).catch(() => undefined);
  if (info === undefined || !info.isFile()) return undefined;
  let text: string;
  try { const h = await open(path, constants.O_RDONLY | O_NOFOLLOW); try { text = await h.readFile("utf8"); } finally { await h.close(); } } catch { return undefined; }
  return /^[0-9a-f]{64}\s*$/.test(text) ? Buffer.from(text.trim(), "hex") : undefined;
}

/**
 * The key that authenticates the marker and the journal: made on first use (written complete under a temporary name and linked into place, mode 600), readable by the controller's user only. A missing, empty or torn key file
 * is replaced only when no marker or journal depends on it; otherwise it is an error (a new key would make the recorded restore unreadable).
 */
async function markerKey(dataDirectory: string, create: boolean, linkFn: (existing: string, path: string) => Promise<void> = link): Promise<Buffer | undefined> {
  const path = join(dataDirectory, KEY_FILE);
  const have = await readKeyFile(path);
  if (have !== undefined || !create) return have;
  if (await exists(join(dataDirectory, PENDING_FILE)) || await exists(join(dataDirectory, JOURNAL_FILE))) throw new Error(`the restore key file ${KEY_FILE} is missing or damaged while a restore is recorded; the restore was not changed. Cancel the restore or restore the key file from a copy.`);
  if (await lstat(path).then(() => true, () => false)) await rm(path, { force: true });
  const tmp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(tmp, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 });
  try { await linkFn(tmp, path); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "EEXIST") { if (code === undefined || !LINK_FALLBACK_CODES.includes(code)) throw error; if (!(await lstat(path).then(() => true, () => false))) await rename(tmp, path); }
  } finally { await rm(tmp, { force: true }).catch(() => undefined); }
  return readKeyFile(path);
}
async function requireKey(dataDirectory: string, create = false, linkFn?: (existing: string, path: string) => Promise<void>): Promise<Buffer> {
  const key = await markerKey(dataDirectory, create, linkFn);
  if (key === undefined) throw new Error(`the restore key file ${KEY_FILE} is missing or damaged; nothing recorded by a restore can be checked. Cancel the restore or restore the key file from a copy.`);
  return key;
}

const stagedOf = (target: string, stamp: string): string => `${target}${STAGED}${stamp}`;
const asideOf = (target: string, stamp: string): string => `${target}.before-restore-${stamp}`;

/** Reads the marker and checks it is authentic and well-formed (not WHERE it points: `readMarker` does that). undefined when there is none. Throws (a plain Error) for one that is unreadable or forged. */
async function readMarkerRaw(data: string): Promise<PendingRestore | undefined> {
  let parsed: PendingRestore;
  try { parsed = JSON.parse(await readFile(join(data, PENDING_FILE), "utf8")) as PendingRestore; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("the pending restore marker cannot be read; the restore was not applied. Remove the marker file to start without it.");
  }
  const key = await markerKey(data, false);
  const { mac, ...rest } = parsed;
  if (key === undefined || !macEqual(macOf(key, rest), mac)) throw new Error("the pending restore marker is not authentic (it was not written by this controller); the restore was not applied. Remove the marker file to start without it.");
  const bad = (why: string): never => { throw new Error(`the pending restore marker is not valid (${why}); the restore was not applied`); };
  if (parsed.format !== 2 || typeof parsed.stamp !== "string" || !/^[0-9TZ]{16}$/.test(parsed.stamp) || typeof parsed.name !== "string" || !BACKUP_NAME.test(parsed.name) || !Array.isArray(parsed.pi) || typeof parsed.liveDb !== "string" || typeof parsed.stagedDb !== "string") bad("shape");
  return parsed;
}

/** Reads and authenticates the marker and checks it is for THIS installation's places; undefined when there is none. Throws (a plain Error) for one that is unreadable, forged or for another place. */
async function readMarker(dataDirectory: string, db: RestoreDatabase, piFinal: ((id: string) => string | undefined) | undefined): Promise<{ pending: PendingRestore; data: string; live: Live } | undefined> {
  const data = await canon(dataDirectory);
  const live = await liveOf(db);
  const parsed = await readMarkerRaw(data);
  if (parsed === undefined) return undefined;
  const bad = (why: string): never => { throw new Error(`the pending restore marker is not valid (${why}); the restore was not applied`); };
  if (parsed.liveDb !== live.id || (parsed.database === "postgres") !== (live.pg !== undefined)) throw new Error("the pending restore marker is not for this database");
  if (live.pg === undefined ? parsed.stagedDb !== stagedOf(live.id, parsed.stamp) : parsed.stagedDb !== stagedSchemaOf(live.pg.schema, parsed.stamp)) bad("the staged database is not beside the live one");
  for (const p of parsed.pi) {
    if (!validStoreId(p.id) || typeof p.target !== "string") return bad("a conversation store");
    const known = resolve(piFinal?.(p.id) ?? join(data, "restored-pi-state", p.id));
    if (p.target !== await canon(known)) bad(`a conversation folder is not where this installation keeps ${p.id}`);
    if (p.staged !== stagedOf(p.target, parsed.stamp)) bad("a staged conversation folder is not beside its target");
    safeTarget(p.target, data, live.dbDir);
  }
  return { pending: parsed, data, live };
}

/** A restore never replaces the data directory, the database's folder or anything above them (a corrupt id mapping must not make it move a whole tree). */
function safeTarget(target: string, data: string, dbDir: string | undefined): void {
  const dirs = dbDir === undefined ? [data] : [data, dbDir];
  if (dirname(target) === target || dirs.some((d) => d === target || inside(target, d))) throw new DomainError("invalid_command", "a conversation store would replace the data directory or a folder above it");
}

/** A file or folder rename; or, with `aside` (PostgreSQL), the schema swap: `from` is the staged schema, `to` the live one and `aside` where the live one goes, all in one transaction. */
interface Move { readonly from: string; readonly to: string; readonly aside?: string }
/** `done`: every move was made; what is left is to remove the marker and then the journal (so a crash between the two is not mistaken for a swap still to plan). */
interface Journal { readonly stamp: string; readonly mode: "forward" | "back" | "done"; readonly moves: readonly Move[]; /** forward: the next move to make (= how many are made); back: how many moves are still to undo. */ readonly at: number; readonly mac?: string }

async function writeJournal(data: string, key: Buffer, j: Omit<Journal, "mac">): Promise<void> {
  const tmp = join(data, `${JOURNAL_FILE}.tmp`);
  await writeFile(tmp, `${JSON.stringify({ ...j, mac: macOf(key, j) })}\n`, { mode: 0o600 });
  await rename(tmp, join(data, JOURNAL_FILE));
}
async function readJournal(data: string, key: Buffer): Promise<Journal | undefined> {
  let j: Journal;
  try { j = JSON.parse(await readFile(join(data, JOURNAL_FILE), "utf8")) as Journal; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("the restore journal cannot be read; the data directory may be half-swapped"); }
  const { mac, ...rest } = j;
  if (!macEqual(macOf(key, rest), mac)) throw new Error("the restore journal is not authentic; the data directory may be half-swapped");
  return j;
}
/** The marker with `failed` set, written complete under a temporary name and renamed over the old one (a crash leaves the old marker or the new, never half of one). */
async function writeFailedMarker(data: string, key: Buffer, pending: PendingRestore, reason: string, at: Date): Promise<void> {
  const { mac: _old, failed: _f, ...rest } = pending;
  const failed = { ...rest, failed: { at: at.toISOString(), reason, rolledBack: true } };
  const tmp = join(data, `${PENDING_FILE}.tmp`);
  await writeFile(tmp, `${JSON.stringify({ ...failed, mac: macOf(key, failed) }, null, 2)}\n`, { mode: 0o600 });
  await rename(tmp, join(data, PENDING_FILE));
}

export interface ApplyOptions {
  /** The same function the running controller was given (the places a conversation store may be restored to). */
  readonly piFinal?: (id: string) => string | undefined;
  /** A lock the caller already holds on the data directory; otherwise the swap takes (and lets go of) its own. */
  readonly lock?: DataLock;
  /** The rename (tests inject a failing one). */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** Wait before trying a rename again after EBUSY/EPERM/EACCES (a file another program holds open, Windows). Default 150 ms; tries: 4. */
  readonly retryDelayMs?: number;
  readonly now?: () => Date;
  /** Removes a file of the swap's bookkeeping (tests end the process between two removals). */
  readonly remove?: (path: string) => Promise<void>;
  /** PostgreSQL: how long the start waits for another controller's connections to the database to go before it refuses (default 5000 ms; a closed controller's sessions take a moment to leave the server's list). */
  readonly controllersGoneMs?: number;
}

/** A schema is never swapped under a running controller: one connected to the database refuses the start (the restore stays recorded and is applied by a start when it has gone). */
async function noOtherController(port: PostgresRestorePort, live: string, o: ApplyOptions): Promise<void> {
  const until = Date.now() + (o.controllersGoneMs ?? 5000);
  for (;;) {
    const n = await port.controllersConnected(live);
    if (n === 0) return;
    if (Date.now() >= until) throw new Error(`a restore waits to be swapped in, but another controller is connected to this PostgreSQL database (${n} connection(s)); its schema is not renamed under it. Stop the other controller and start again; nothing was changed.`);
    await new Promise((r) => setTimeout(r, 200));
  }
}

async function renameRetry(o: ApplyOptions, from: string, to: string): Promise<void> {
  const mv = o.rename ?? rename;
  for (let attempt = 0; ; attempt++) {
    try { await mv(from, to); return; } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 3 || (code !== "EBUSY" && code !== "EPERM" && code !== "EACCES")) throw error;
      await new Promise((r) => setTimeout(r, (o.retryDelayMs ?? 150) * (attempt + 1)));
    }
  }
}

/** The moves of a first run. A staged copy the marker names that is not there is not a swap to skip: it returns what is missing, and nothing is moved. The database goes last (on PostgreSQL, one schema swap). */
async function planMoves(p: PendingRestore, live: Live): Promise<{ moves: Move[] } | { missing: string }> {
  for (const x of p.pi) if (!(await exists(x.staged))) return { missing: `the staged conversation folder ${basename(x.staged)}` };
  if (live.pg !== undefined ? !(await live.pg.port.exists(p.stagedDb)) : !(await exists(p.stagedDb))) return { missing: `the staged database ${basename(p.stagedDb)}` };
  const moves: Move[] = [];
  for (const x of p.pi) {
    if (await exists(x.target)) moves.push({ from: x.target, to: asideOf(x.target, p.stamp) });
    moves.push({ from: x.staged, to: x.target });
  }
  if (live.pg !== undefined) { moves.push({ from: p.stagedDb, to: live.pg.schema, aside: asideSchemaOf(live.pg.schema, p.stamp) }); return { moves }; }
  for (const s of SQLITE_SIDECARS) if (await exists(p.liveDb + s)) moves.push({ from: p.liveDb + s, to: asideOf(p.liveDb, p.stamp) + s });
  for (const s of SQLITE_SIDECARS) if (s !== "" && await exists(p.stagedDb + s)) moves.push({ from: p.stagedDb + s, to: p.liveDb + s });
  moves.push({ from: p.stagedDb, to: p.liveDb });
  return { moves };
}

/** The schema port a journal's schema swap needs: the live database must be the PostgreSQL schema the move names (a journal for another schema is refused, never applied to this one). */
function portFor(m: Move, live: Live): PostgresRestorePort {
  if (live.pg === undefined || m.to !== live.pg.schema) throw new Error("the restore journal swaps a PostgreSQL schema that is not this installation's database; nothing was changed");
  return live.pg.port;
}
const swapOf = (m: Move): { live: string; staged: string; aside: string } => ({ live: m.to, staged: m.from, aside: m.aside! });
/** Whether a forward move is already made (the process ended between the move and the journal). */
async function made(m: Move, live: Live): Promise<boolean> {
  if (m.aside === undefined) return !(await exists(m.from)) && (await exists(m.to));
  const port = portFor(m, live);
  return !(await port.exists(m.from)) && (await port.exists(m.aside));
}
async function makeMove(o: ApplyOptions, m: Move, live: Live): Promise<void> {
  if (m.aside === undefined) { await mkdir(dirname(m.to), { recursive: true }); await renameRetry(o, m.from, m.to); return; }
  await portFor(m, live).swap(swapOf(m));
}
/** Undoes one move if it is made; a move already undone is skipped. */
async function undoMove(o: ApplyOptions, m: Move, live: Live): Promise<void> {
  if (m.aside === undefined) { if ((await exists(m.to)) && !(await exists(m.from))) await renameRetry(o, m.to, m.from); return; }
  if (await made(m, live)) await portFor(m, live).unswap(swapOf(m));
}

/** Undoes the moves of a journal, last first. Each undo is checked against what is on disk (a move already undone is skipped), so a rollback that is interrupted is simply run again; progress is recorded in the journal only when a move cannot be undone. Throws (with what is left) when one cannot be undone. */
async function rollBack(data: string, key: Buffer, j: Journal, o: ApplyOptions, live: Live): Promise<void> {
  for (let i = j.at; i > 0; i--) {
    const m = j.moves[i - 1]!;
    try { await undoMove(o, m, live); } catch (error) {
      await writeJournal(data, key, { stamp: j.stamp, mode: "back", moves: j.moves, at: i });
      throw new Error(`the restore could not be undone: ${basename(m.to)} could not be moved back to ${basename(m.from)} (${(error as NodeJS.ErrnoException).code ?? "error"}). The data directory is half-swapped; the journal ${JOURNAL_FILE} lists every move. Free the file and start again: the rollback continues from where it stopped.`);
    }
  }
}

/**
 * Finishes a staged restore at start, before the database is opened. Safe to run again after a crash: the moves are journalled (with their full, resolved paths), each one is checked against what is already done, and the
 * marker goes last. A journal that exists is resumed or rolled back FIRST, from its own paths, before the marker's places are looked at again (a path that dangles after a crash must not stop the recovery); a journal with no
 * marker is refused, never ignored. Returns the restored backup's name, or undefined when there was nothing to do or the swap did not happen (then the marker records why, `backup.restore.status` shows it and
 * `backup.restore.cancel` clears it, and the controller starts on the data it had). Throws when the data directory is half-swapped and could not be put back, when the marker is not authentic, or when another controller holds the data directory.
 */
export async function applyPendingRestore(dataDirectory: string, db: RestoreDatabase, print: (line: string) => void = () => undefined, options: ApplyOptions = {}): Promise<string | undefined> {
  const data = await canon(dataDirectory);
  if (!(await exists(join(data, PENDING_FILE))) && !(await exists(join(data, JOURNAL_FILE)))) return undefined;
  const live = await liveOf(db);
  const lock = options.lock ?? await acquireDataLocks(live.dbDir === undefined ? [data] : [data, live.dbDir], options.now === undefined ? undefined : { now: options.now });
  const now = (): Date => (options.now ?? (() => new Date()))();
  try {
    const key = await markerKey(data, false);
    const hasJournal = await exists(join(data, JOURNAL_FILE));
    if (hasJournal && key === undefined) throw new Error("the restore journal cannot be checked (the restore key file is missing or damaged); the data directory may be half-swapped. Restore the key file or undo the moves listed in the journal by hand.");
    let journal = hasJournal ? await readJournal(data, key!) : undefined;
    let pending: PendingRestore | undefined;
    const remove = options.remove ?? ((p: string) => rm(p, { force: true }));
    if (journal !== undefined) {
      if (journal.mode === "done") {
        // The swap already happened: the clean-up is finished whether or not the marker can still be read (a marker that fails to authenticate must not leave the data directory looking half-done).
        pending = await readMarkerRaw(data).catch(() => undefined);
        await remove(join(data, PENDING_FILE));
        await remove(join(data, JOURNAL_FILE));
        print(`The restore${pending === undefined ? "" : ` of ${pending.name}`} was applied: the previous database and conversation folders are kept beside, named .before-restore-${journal.stamp}.`);
        return pending?.name;
      }
      pending = await readMarkerRaw(data);
      if (pending === undefined) throw new Error(`a restore journal (${JOURNAL_FILE}) is there but the restore marker is not: the data directory may be half-swapped. Nothing was changed; the journal lists every move, undo them by hand, then remove the journal.`);
    } else {
      const found = await readMarker(dataDirectory, db, options.piFinal);
      if (found === undefined) return undefined;
      pending = found.pending;
      if (pending.failed !== undefined) {
        print(`A restore of ${pending.name} was tried and could not be applied (${pending.failed.reason}); the data is as it was. Cancel it (backup.restore.cancel) and prepare it again when the cause is fixed.`);
        return undefined;
      }
      if (live.pg !== undefined) await noOtherController(live.pg.port, live.pg.schema, options);
      const plan = await planMoves(pending, live);
      if ("missing" in plan) {
        const why = `${plan.missing} is missing, so nothing was moved`;
        await writeFailedMarker(data, (await requireKey(data)), pending, why, now());
        print(`The restore of ${pending.name} could not be applied (${why}); the controller starts on the data it had. Cancel the restore (backup.restore.cancel) and prepare it again.`);
        return undefined;
      }
      journal = { stamp: pending.stamp, mode: "forward", moves: plan.moves, at: 0 };
      await writeJournal(data, key!, journal);
    }
    const k = key!;
    let failure: unknown;
    if (journal.mode === "forward") {
      for (let i = journal.at; i < journal.moves.length; i++) {
        const m = journal.moves[i]!;
        try {
          // Already made (the process ended between the rename and the journal)?
          if (!(await made(m, live))) await makeMove(options, m, live);
        // The failed move is included in what is undone: a rename that failed did not happen (its undo is skipped), but a schema swap whose connection was lost after the commit did (its undo finds it made).
        } catch (error) { failure = error; journal = { ...journal, at: i + 1 }; break; }
        journal = { ...journal, at: i + 1 };
        await writeJournal(data, k, journal);
      }
      if (failure === undefined) {
        // Recorded as done before anything is removed: a crash from here on finishes the clean-up, it is never planned again.
        await writeJournal(data, k, { stamp: journal.stamp, mode: "done", moves: journal.moves, at: journal.moves.length });
        await remove(join(data, PENDING_FILE));
        await remove(join(data, JOURNAL_FILE));
        print(`The restore of ${pending.name} was applied: the previous ${live.pg === undefined ? "database" : `database (schema ${asideSchemaOf(live.pg.schema, pending.stamp)})`} and conversation folders are kept beside, named .before-restore-${pending.stamp}.`);
        return pending.name;
      }
      journal = { stamp: journal.stamp, mode: "back", moves: journal.moves, at: journal.at };
      await writeJournal(data, k, journal);
    }
    const code = (failure as NodeJS.ErrnoException | undefined)?.code;
    const why = failure === undefined ? "an earlier attempt to put things back was interrupted"
      : failure instanceof PostgresSwapBusy ? `the schema was not swapped: ${failure.message}`
      : code === "42501" ? "the PostgreSQL role this controller uses may not rename the schema (it must own it and may create schemas in the database)"
      : `${code ?? "error"} while moving files into place`;
    await rollBack(data, k, journal, options, live);
    // The failure is recorded (atomically) before the journal goes: a crash in between leaves the journal, whose rollback has nothing left to do, and the next start records it again.
    await writeFailedMarker(data, k, pending, why, now());
    await rm(join(data, JOURNAL_FILE), { force: true });
    print(`The restore of ${pending.name} could not be applied (${why}). Everything it had moved was put back; the controller starts on the data it had. Cancel the restore (backup.restore.cancel) and prepare it again when the cause is fixed.`);
    return undefined;
  } finally { if (options.lock === undefined) await lock.release(); }
}

export interface RestoreStatus { pending?: PendingRestore; barrier: ReturnType<MaintenanceBarrier["state"]>; /** The marker on disk could not be read or is not authentic: the next start refuses until it is removed. */ markerProblem?: string; /** While a restore waits for the start that swaps it in: how that start happens (card K01i). */ restart?: RestartNotice; /** PostgreSQL, when any: the schemas earlier restores kept aside. */ kept?: KeptSchemas }

/** PostgreSQL: the schemas earlier restores kept aside (card K01i, second review). NimbleNewt never drops them, so each restore leaves one more; the owner sees them here and removes the ones no longer needed. */
export interface KeptSchemas { readonly schemas: readonly string[]; readonly note: string }
export const KEPT_SCHEMAS_NOTE = "Each restore keeps the database as it was before it in one of these schemas; NimbleNewt never removes them. When you no longer need one, have the database administrator drop it (DROP SCHEMA <name> CASCADE).";

/** What the owner is told about the restart a staged restore needs (card K01i). */
export interface RestartNotice {
  /** True when the host restarts the controller itself (it was asked to); false: the owner must. */
  readonly automatic: boolean;
  /** What happens, or what to do, in plain words. */
  readonly instruction: string;
  /** The automatic restart was asked for and failed: the owner restarts it by hand. */
  readonly failed?: string;
}
export const DEFAULT_RESTART_INSTRUCTION = "Restart NimbleNewt: stop the controller and start it again the way it is normally started (its service, or the command that starts it). Until then every command except the restore's status and cancel is refused; the start swaps the restored data in.";

export class StagedRestore {
  readonly #o: StagedRestoreOptions;
  #pending: { pending: PendingRestore; release: () => Promise<void> } | undefined;
  #busy = false;
  /** The discard count each preview showed, by token nonce (a restore asks for a new preview when the count grew by more than the owner's margin). */
  readonly #previewed = new Map<string, number | undefined>();
  readonly #sessionKey = randomBytes(32);
  readonly #used = new Set<string>();
  #restartFailed: string | undefined;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(options: StagedRestoreOptions) {
    if ((options.sqlitePath === undefined) === (options.postgres === undefined)) throw new Error("a staged restore needs exactly one live database: sqlitePath or postgres");
    this.#o = options;
  }
  /** The live database, as the swap and the marker name it. */
  get #db(): RestoreDatabase { return this.#o.postgres === undefined ? this.#o.sqlitePath! : { postgres: this.#o.postgres }; }
  #now(): Date { return (this.#o.now ?? (() => new Date()))(); }

  async #find(name: unknown): Promise<{ path: string; manifest: BackupManifest }> {
    if (typeof name !== "string" || !BACKUP_NAME.test(name)) throw new DomainError("invalid_command", "name must be the name of a backup, as backup.list shows it");
    const found = (await listBackups(this.#o.root)).find((b) => basename(b.path) === name);
    if (found === undefined) throw new DomainError("not_found", `there is no complete backup named ${name}`);
    return { path: found.path, manifest: found.manifest };
  }

  async #ttlMs(): Promise<number | null> {
    const minutes = await this.#o.confirmMinutes?.().catch(() => undefined);
    return minutes === null ? null : (minutes ?? DEFAULT_CONFIRM_MINUTES) * 60_000;
  }

  async #marginOf(): Promise<number | null> {
    const m = await this.#o.changeMargin?.().catch(() => undefined);
    return m === null ? null : m ?? DEFAULT_CHANGE_MARGIN;
  }

  /** The token: the time it was issued, a nonce and an HMAC (under a key only this process holds) over the whole manifest's digest, the backup's name, the installation's epoch and those two. How long it stays good is the owner's setting at the moment it is used. */
  async #issue(m: BackupManifest, changes: number | undefined): Promise<{ token: string; expiresAt?: string }> {
    const epoch = await this.#o.storage.currentEpoch();
    const ttl = await this.#ttlMs();
    const iat = this.#now().getTime();
    const nonce = randomBytes(8).toString("hex");
    const mac = macOf(this.#sessionKey, { name: m.name, digest: manifestDigestOf(m), epoch, iat, nonce }).slice(0, 32);
    this.#previewed.set(nonce, changes);
    while (this.#previewed.size > 200) this.#previewed.delete(this.#previewed.keys().next().value as string);
    return { token: `${iat}.${nonce}.${mac}`, ...(ttl === null ? {} : { expiresAt: new Date(iat + ttl).toISOString() }) };
  }

  async #checkToken(m: BackupManifest, confirm: unknown): Promise<string> {
    const wrong = (why: string): never => { throw new DomainError("invalid_command", `confirm must be the token of the preview just shown: ${why}`); };
    if (typeof confirm !== "string") return wrong("none was given");
    const parts = /^(\d{1,16})\.([0-9a-f]{16})\.([0-9a-f]{32})$/.exec(confirm);
    if (parts === null) return wrong("it is not a restore token");
    const iat = Number(parts[1]);
    const expected = macOf(this.#sessionKey, { name: m.name, digest: manifestDigestOf(m), epoch: await this.#o.storage.currentEpoch(), iat, nonce: parts[2]! }).slice(0, 32);
    if (!macEqual(expected, parts[3])) return wrong("the preview is out of date, or the approval was for something else (the backup, or the installation, has changed)");
    const ttl = await this.#ttlMs();
    if (ttl !== null && this.#now().getTime() - iat > ttl) return wrong("it has expired; ask for a new preview");
    if (this.#used.has(confirm)) return wrong("it was already used");
    return parts[2]!;
  }

  async #lastAuditSeq(): Promise<number | undefined> {
    const list = this.#o.storage.listAudit?.bind(this.#o.storage);
    if (list === undefined) return undefined;
    try {
      let hi = 1;
      while ((await list({ afterSeq: hi - 1, limit: 1 })).length > 0) { hi *= 2; if (hi > 2 ** 40) return undefined; }
      let lo = 0; // the last seq is in [lo, hi): audit seq are gap-free
      while (hi - lo > 1) { const mid = Math.floor((lo + hi) / 2); if ((await list({ afterSeq: mid - 1, limit: 1 })).length > 0) lo = mid; else hi = mid; }
      return lo;
    } catch { return undefined; }
  }

  /** The plan without its token. `verify`: check a plain backup and count its effects and deliveries (a preview does; the apply verifies once, in the restore itself). */
  async #plan(path: string, m: BackupManifest, verify: boolean): Promise<Omit<RestorePlan, "token" | "expiresAt">> {
    const probe = await this.#o.storage.snapshot();
    const live = probe.schemaVersion;
    await probe.close();
    if (live !== m.schemaVersion) throw new DomainError("invalid_command", `the backup has schema version ${m.schemaVersion} and this installation has ${live}; restore it with the version of NimbleNewt that made it, then upgrade`);
    const encrypted = m.encryption !== undefined;
    const warnings: string[] = [];
    let effects: number | undefined, deliveries: number | undefined;
    if (!encrypted && verify) {
      const check = await verifyBackup(path);
      if (!check.ok) throw new DomainError("integrity", `the backup cannot be restored: ${check.problems.join("; ")}`);
      effects = await countRows(join(path, tableFile("effects", false)), (r) => r["status"] === "intended");
      deliveries = await countRows(join(path, tableFile("deliveries", false)), (r) => r["state"] !== "delivered");
    } else if (encrypted) warnings.push("This backup is encrypted: it is checked and opened with the passcode or recovery file when you approve, before anything is changed.");
    if (m.piState === undefined) warnings.push("Pi state is NOT included in this backup: the agents' own conversation memory on this machine stays as it is, so it may be AHEAD of the restored records (an agent may remember work the restored records do not show). Work that was in progress resumes from the restored records.");
    else if ((m.piState.problemCount ?? 0) > 0) warnings.push(`Some of the agents' conversation files could not be copied when this backup was made (${m.piState.problemCount}); those are not restored. First: ${m.piState.problems?.[0] ?? "see the backup's manifest"}.`);
    if (this.#o.piStateConfigured === false) warnings.push("Backups on this installation do not include the agents' conversation state at all (no conversation folders are set up), so the safety copy taken before the restore does not either.");
    const last = await this.#lastAuditSeq();
    const backupSeq = m.files.find((f) => f.table === "audit")?.rows;
    const changes = last === undefined || backupSeq === undefined ? undefined : Math.max(0, last - backupSeq);
    warnings.push(`Everything written after this backup was made is replaced by it${changes === undefined ? "" : ` (about ${changes} recorded change${changes === 1 ? "" : "s"} since, which are discarded from the running data and kept only in the safety copy)`}. The current database and conversation folders are kept beside, never deleted.`);
    return {
      name: m.name, createdAt: m.createdAt, kind: m.kind, version: m.version, schemaVersion: m.schemaVersion, encrypted,
      rows: m.files.reduce((n, f) => n + f.rows, 0), artifactFiles: m.artifacts?.blobs ?? 0, piStores: m.piState?.stores ?? 0, piFiles: m.piState?.files ?? 0, piStateIncluded: m.piState !== undefined,
      ...(m.piState?.problems === undefined ? {} : { piStateProblems: m.piState.problems }),
      ...(changes === undefined ? {} : { changesSinceBackup: changes }),
      ...(effects === undefined ? {} : { effectsToMarkUncertain: effects }), ...(deliveries === undefined ? {} : { deliveriesToResend: deliveries }),
      steps: [
        "1. The backup is checked against its manifest (and opened, if encrypted).",
        this.#o.postgres === undefined ? "2. It is restored into a new database and new conversation folders beside the live ones; the live ones are not touched." : "2. It is restored into a new schema of the same PostgreSQL database and new conversation folders beside the live ones; the live ones are not touched.",
        "3. No agent work may be running. The installation stops accepting commands and a snapshot of the current state is taken (kind pre-restore, kept unless you set how many to keep).",
        this.#o.restart?.automatic === undefined ? `4. You restart the controller: ${this.#o.restart?.instruction ?? DEFAULT_RESTART_INSTRUCTION}` : "4. The controller restarts itself (this host restarts it automatically once the restore is prepared).",
        this.#o.postgres === undefined
          ? "5. On that start the old database and conversation folders are moved aside (.before-restore-<time>) and the restored ones take their place. If a move fails, the ones already made are undone and you are told."
          : `5. On that start (no other controller may be connected to the database) the conversation folders are moved aside (.before-restore-<time>), the live schema is renamed to ${this.#o.postgres.schema}_br_<time> and the restored schema takes its name, in one transaction. If a step fails, the ones already made are undone and you are told.`,
        "6. Actions that were only intended when the backup was taken come back as uncertain and are never run again; undelivered messages are sent again.",
      ],
      warnings,
    };
  }

  /** What restoring this backup would do, exactly. Changes nothing and needs no secret. */
  async preview(name: unknown): Promise<RestorePlan> {
    const { path, manifest: m } = await this.#find(name);
    const read = await readManifest(path);
    if (read.manifest === undefined) throw new DomainError("integrity", `the backup cannot be restored: ${read.problems.join("; ")}`);
    const plan = await this.#plan(path, m, true);
    return { ...(await this.#issue(m, plan.changesSinceBackup)), ...plan };
  }

  get pending(): PendingRestore | undefined { return this.#pending?.pending; }

  /** How the restart a staged restore waits for happens (the host's automatic restart, or the owner's by hand), and whether an automatic one failed. */
  restartNotice(): RestartNotice {
    const r = this.#o.restart;
    const manual = r?.instruction ?? DEFAULT_RESTART_INSTRUCTION;
    if (r?.automatic === undefined) return { automatic: false, instruction: manual };
    if (this.#restartFailed !== undefined) return { automatic: false, instruction: manual, failed: this.#restartFailed };
    return { automatic: true, instruction: "The controller restarts itself now to swap the restored data in; it is unavailable for a moment. If it does not come back, start it the way it is normally started." };
  }

  /** The state for `backup.restore.status`: what this run prepared, or else what the marker on disk says (a restore that waits for a start, or that a start tried and rolled back). */
  async status(): Promise<RestoreStatus> {
    const kept = await this.#kept();
    const k = kept === undefined ? {} : { kept };
    const barrier = this.#o.barrier.state();
    if (this.#pending !== undefined) return { pending: this.#pending.pending, barrier, restart: this.restartNotice(), ...k };
    try {
      const found = await readMarker(this.#o.dataDirectory, this.#db, this.#o.piFinal);
      // A marker on disk that this run did not prepare and that has not failed also waits for a start (the restart was not made, or the swap was refused at a start).
      return { ...(found === undefined ? {} : { pending: found.pending }), barrier, ...(found === undefined || found.pending.failed !== undefined ? {} : { restart: { automatic: false, instruction: this.#o.restart?.instruction ?? DEFAULT_RESTART_INSTRUCTION } }), ...k };
    } catch (error) { return { barrier, markerProblem: error instanceof Error ? error.message.slice(0, 300) : "the marker cannot be read", ...k }; }
  }

  /** The kept schemas, best effort (a server that cannot be asked leaves them out of the status; it never fails it). */
  async #kept(): Promise<KeptSchemas | undefined> {
    const pg = this.#o.postgres;
    if (pg === undefined) return undefined;
    const port = pg.port ?? postgresRestorePort(pg.url);
    if (port.keptSchemas === undefined) return undefined;
    const schemas = await port.keptSchemas(pg.schema).catch(() => undefined);
    return schemas === undefined || schemas.length === 0 ? undefined : { schemas, note: KEPT_SCHEMAS_NOTE };
  }

  async #rmStaged(p: { stagedDb: string; pi: readonly { staged: string }[] }): Promise<string[]> {
    const left: string[] = [];
    const pg = this.#o.postgres;
    if (pg !== undefined && p.stagedDb !== "") {
      try { await (pg.port ?? postgresRestorePort(pg.url)).dropStaged(pg.schema, p.stagedDb); } catch { left.push(`schema ${p.stagedDb}`); }
    }
    for (const target of [...(pg === undefined ? SQLITE_SIDECARS.map((s) => p.stagedDb + s) : []), ...p.pi.map((x) => x.staged)]) {
      try { await rm(target, { recursive: true, force: true }); } catch { left.push(target); }
    }
    return left;
  }

  /** The owner approved a preview that showed some number of discarded changes: much more than that since is a different decision. Checked before the work and again after the backup was written out (which takes time, and the installation keeps running meanwhile). */
  async #checkMargin(manifest: BackupManifest, margin: number | null, shown: number | undefined): Promise<void> {
    if (margin === null || shown === undefined) return;
    const last = await this.#lastAuditSeq();
    const backupRows = manifest.files.find((f) => f.table === "audit")?.rows;
    if (last === undefined || backupRows === undefined) return;
    const now = Math.max(0, last - backupRows);
    if (now > shown + margin) throw new DomainError("invalid_command", `${now - shown} more recorded changes (audit rows) than the preview showed were written since it (it showed ${shown}, and ${margin} more are tolerated); ask for a new preview and approve it again`);
  }

  /** Stages the restore and raises the barrier; needs the token the preview gave (the owner approved exactly that). */
  async apply(name: unknown, confirm: unknown, method?: UnlockMethod): Promise<{ plan: RestorePlan; pending: PendingRestore; result: RestoreResult; safetyCopy: string; changesDiscarded?: number; restart: RestartNotice }> {
    if (this.#busy || this.#pending !== undefined) throw new DomainError("unavailable", "a restore is already being prepared or waits for the restart");
    // The swap at the next start needs this controller to be the one that holds the data directory: if another controller holds it, a restore prepared here would be swapped in under it.
    if (this.#o.lock !== undefined) await this.#o.lock.require();
    this.#busy = true;
    // Where this attempt put staged copies, so a failure at any point removes all of them (the targets are known before the backup is written out).
    const targets = new Map<string, string>();
    let stamp = "";
    let stagedDb = "";
    let markerPath: string | undefined;
    const leftovers = (): { stagedDb: string; pi: { staged: string }[] } => ({ stagedDb, pi: [...targets.values()].map((t) => ({ staged: stagedOf(t, stamp) })) });
    try {
      const data = await canon(this.#o.dataDirectory);
      const liveDb = await liveOf(this.#db);
      const live = liveDb.id;
      stamp = stampOf(this.#now());
      stagedDb = liveDb.pg === undefined ? stagedOf(live, stamp) : stagedSchemaOf(liveDb.pg.schema, stamp);
      const staged: { stagedDb: string; pi: { id: string; staged: string; target: string }[] } = { stagedDb, pi: [] };
      if (await exists(join(data, PENDING_FILE))) throw new DomainError("unavailable", "a restore is already recorded for the next start (or one that failed is still recorded): cancel it first");
      const { path, manifest } = await this.#find(name);
      const nonce = await this.#checkToken(manifest, confirm);
      const margin = await this.#marginOf();
      const shown = this.#previewed.get(nonce);
      await this.#checkMargin(manifest, margin, shown);
      // PostgreSQL: a role that may not rename the live schema would stage a restore that no start can swap in; it is refused now, plainly (the driver's own error may name the server, so it is not shown).
      if (liveDb.pg?.port.swapRefusal !== undefined) {
        const why = await liveDb.pg.port.swapRefusal(liveDb.pg.schema).catch((error: unknown) => `the PostgreSQL server could not be asked whether this controller's role may swap a restore in (${(error as NodeJS.ErrnoException).code ?? "error"}); nothing was changed`);
        if (why !== undefined) throw new DomainError("unavailable", why);
      }
      let unlock: BackupKey | undefined;
      if (manifest.encryption !== undefined) {
        if (this.#o.unlock === undefined) throw new DomainError("unavailable", "the backup is encrypted and no unlock method is set up on this host");
        try { unlock = await this.#o.unlock(method ?? "passcode"); } catch (error) {
          if (error instanceof ProofRefused) throw new DomainError(error.code === "failed" || error.code === "rate_limited" ? "invalid_command" : "unavailable", error.message);
          if (error instanceof UnlockFailed) throw new DomainError("invalid_command", error.message);
          throw error;
        }
      }
      this.#used.add(String(confirm));
      await this.#rmStaged(staged);
      let result: RestoreResult;
      // The target is resolved (links followed) BEFORE anything is written, so the copy is made beside the real folder and never needs to be moved afterwards.
      const piTarget = (id: string): string => {
        if (!validStoreId(id)) throw new DomainError("invalid_command", "a conversation store has an id that cannot be restored");
        let t = targets.get(id);
        if (t === undefined) { t = canonSync(this.#o.piFinal?.(id) ?? join(data, "restored-pi-state", id)); safeTarget(t, data, liveDb.dbDir); targets.set(id, t); }
        return stagedOf(t, stamp);
      };
      const fresh: ControllerStorage = liveDb.pg === undefined ? await SqliteStorage.open({ path: stagedDb }) : await (liveDb.pg.openStaged ?? ((schema: string) => PostgresStorage.open({ connectionString: liveDb.pg!.url, schema })))(stagedDb);
      try {
        // The one verification: the restore checks the backup, and the manifest it checked must be the one the approval named.
        result = await restoreBackup(path, fresh, { ...(this.#o.blobs === undefined ? {} : { blobs: this.#o.blobs }), ...(unlock === undefined ? {} : { unlock }), deletions: await this.#o.deletions?.() ?? [], piTarget, expectedManifestDigest: manifestDigestOf(manifest) });
      } catch (error) { await fresh.close().catch(() => undefined); throw error instanceof RestoreRefused ? new DomainError("integrity", error.message) : error; }
      await fresh.close();
      await this.#checkMargin(manifest, margin, shown);
      for (const [id, target] of targets) {
        const folder = stagedOf(target, stamp);
        // Every staged folder the marker will name must be there: a swap that skipped one would put the database in place without its conversation state.
        if (!(await exists(folder))) throw new DomainError("integrity", `the restored conversation folder for ${id} was not made; nothing was changed`);
        staged.pi.push({ id, staged: folder, target });
      }
      // Staged beside what it replaces, so every rename stays on one device; checked anyway.
      const dev = this.#o.deviceOf ?? (async (p: string) => (await stat(p)).dev);
      const pairs: (readonly [string, string])[] = [...(liveDb.dbDir === undefined ? [] : [[stagedDb, liveDb.dbDir] as const]), ...staged.pi.map((x) => [x.staged, dirname(x.target)] as const)];
      for (const [from, to] of pairs) {
        if (await dev(from) !== await dev(to)) throw new DomainError("unavailable", `the restored data and the place it must go are on different devices (${basename(from)}); the swap would not be a single rename. Nothing was changed.`);
      }
      const release = await this.#o.barrier.raise(`restoring ${manifest.name}`);
      try {
        const safety = await this.#o.backups.safetyCopy();
        const lastSeq = await this.#lastAuditSeq();
        const backupSeq = manifest.files.find((f) => f.table === "audit")?.rows;
        const key = await requireKey(data, true, this.#o.link);
        const body: Omit<PendingRestore, "mac"> = { format: 2, name: manifest.name, stamp, preparedAt: this.#now().toISOString(), ...(liveDb.pg === undefined ? {} : { database: "postgres" as const }), stagedDb, liveDb: live, pi: staged.pi };
        const pending: PendingRestore = { ...body, mac: macOf(key, body) };
        markerPath = join(data, PENDING_FILE);
        await writeFile(markerPath, `${JSON.stringify(pending, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        this.#pending = { pending, release };
        try { this.#o.onStaged?.(pending); } catch { /* the host's notice failing does not undo a staged restore */ }
        this.#restartFailed = undefined;
        const plan: RestorePlan = { token: String(confirm), ...(await this.#plan(path, manifest, false)), ...(result.effectsMarkedUncertain === undefined ? {} : { effectsToMarkUncertain: result.effectsMarkedUncertain }), deliveriesToResend: result.deliveriesToResend };
        const automatic = this.#o.restart?.automatic;
        // A moment after the reply (the API records the command's outcome first): the host closes this controller and starts it again. A failure is kept for the status, and the owner restarts by hand.
        // Scheduled last, once nothing else here can fail: an apply that fails withdraws the restore, and no restart is made for it.
        if (automatic !== undefined) this.#restartTimer = setTimeout(() => { this.#restartTimer = undefined; void (async () => { try { await automatic(); } catch (error) { this.#restartFailed = (error instanceof Error ? error.message : String(error)).slice(0, 300); } })(); }, this.#o.restart?.delayMs ?? 1000);
        return { plan, pending, result, safetyCopy: basename(safety.path), ...(lastSeq === undefined || backupSeq === undefined ? {} : { changesDiscarded: Math.max(0, lastSeq - backupSeq) }), restart: this.restartNotice() };
      } catch (error) {
        // A failure after the marker was written withdraws it too: the staged copies it names are removed below.
        if (markerPath !== undefined && this.#pending !== undefined) { await rm(markerPath, { force: true }).catch(() => undefined); this.#pending = undefined; }
        await release();
        throw error;
      }
    } catch (error) {
      if (stagedDb !== "") await this.#rmStaged(leftovers()).catch(() => undefined);
      throw error;
    } finally { this.#busy = false; }
  }

  /**
   * Withdraws a restore that no start has applied: the marker and the staged copies are removed and the barrier comes down, whatever else fails (a leftover is reported, not hidden). Also clears a restore a start tried and
   * rolled back, and puts back what a half-done swap had moved (the journal). The live data is as it was.
   */
  async cancel(): Promise<{ cancelled: boolean; leftovers?: string[] }> {
    // A restart not yet made is not made for a withdrawn restore.
    if (this.#restartTimer !== undefined) { clearTimeout(this.#restartTimer); this.#restartTimer = undefined; }
    const mem = this.#pending;
    const data = await canon(this.#o.dataDirectory);
    // A journal that cannot be read or checked is not a swap that is over: say so and keep it (the next start refuses it too), instead of reporting the restore cancelled.
    if (await exists(join(data, JOURNAL_FILE))) {
      const key = await markerKey(data, false);
      try { if (key === undefined) throw new Error("the restore key file is missing or damaged"); await readJournal(data, key); } catch (error) {
        throw new DomainError("unavailable", `the restore was not cancelled: the journal ${JOURNAL_FILE} of a half-done swap cannot be checked (${error instanceof Error ? error.message : "error"}). Nothing was changed; undo the moves it lists by hand, then remove the journal and the marker.`);
      }
    }
    let disk: PendingRestore | undefined;
    try { disk = (await readMarker(data, this.#db, this.#o.piFinal))?.pending; } catch { disk = await readMarkerRaw(data).catch(() => undefined); }
    const p = mem?.pending ?? disk;
    if (p === undefined && !(await exists(join(data, PENDING_FILE))) && !(await exists(join(data, JOURNAL_FILE)))) return { cancelled: false };
    const leftovers: string[] = [];
    let markerGone = false;
    try {
      const key = await markerKey(data, false);
      const journal = key === undefined ? undefined : await readJournal(data, key);
      // A swap that was finished (journal "done") is not undone by a cancel: only its leftovers are cleared.
      if (journal !== undefined && key !== undefined) { if (journal.mode !== "done") await rollBack(data, key, journal, {}, await liveOf(this.#db)); await rm(join(data, JOURNAL_FILE), { force: true }).catch(() => leftovers.push(JOURNAL_FILE)); }
      try { await rm(join(data, PENDING_FILE), { force: true }); markerGone = true; } catch { leftovers.push(PENDING_FILE); }
      if (p !== undefined) leftovers.push(...await this.#rmStaged(p));
    } finally {
      if (markerGone) this.#pending = undefined;
      if (mem !== undefined) await mem.release();
    }
    if (!markerGone) throw new DomainError("unavailable", `the restore could not be withdrawn: ${PENDING_FILE} could not be removed, so the next start would still apply it. The maintenance barrier is down; remove the file and try again.`);
    return { cancelled: true, ...(leftovers.length === 0 ? {} : { leftovers }) };
  }
}
