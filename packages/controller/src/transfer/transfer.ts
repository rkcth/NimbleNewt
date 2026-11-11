import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { link, mkdir, open, readFile, rename, rm, statfs } from "node:fs/promises";
import { dirname, join } from "node:path";
import { canon } from "../backup/canon.js";
import { DataLockBusy, acquireDataLock, type DataLock } from "../backup/data-lock.js";
import type { MaintenanceBarrier } from "../backup/barrier.js";
import { DomainError } from "../domain/errors.js";
import { canonicalJson } from "../storage/json.js";
import { ID_PATTERN, KIND_PATTERN, TIMESTAMP_PATTERN, type ControllerStorage } from "../storage/types.js";
import { SNAPSHOT_PAGE_MAX, SNAPSHOT_TABLES, type SnapshotRow, type SnapshotTable, type StorageSnapshot } from "../storage/snapshot.js";

/**
 * Chat-controlled controller database transfer (card F04e): the logical move of the whole controller store from SQLite to PostgreSQL or back, through the same table rows a backup uses (so a body round-trips byte for byte).
 *
 * Order of an apply: the maintenance barrier is raised (new admissions are refused, running attempts must have ended, in-flight work settles); the destination must be empty (a store no controller has owned, same schema version) and have room;
 * the source is read from one consistent snapshot and checked (IDs, sequences, policy records, receipts, effects, timers, artifact and checkpoint references); the rows are copied table by table (claims taken by the drained controller
 * are released: a claimed delivery or timer is pending again); the destination is read back and each table's count and digest must equal what was written; the source is unchanged since the start; the source is FENCED (its epoch is
 * taken, so a deposed controller cannot write); and only then does the authority file name the destination. Everything up to the fence leaves the source exactly as it was (a failure puts the barrier down, empties the destination if the target can, and records why);
 * a failure between the fence and the authority file is finished or abandoned at the next start (`resolveAtStart`). The authority file is what makes the destination the only database a controller will start on: a start whose configured
 * database is not the authoritative one is refused (`assertStorageAuthority`). After the switch the barrier stays up until the controller is restarted on the new database (the host's configuration must point at it).
 * Rollback to the source is allowed only while the destination has recorded nothing since the switch; after that the way back is a reverse transfer, which is the same operation in the other direction.
 */
export const TRANSFER_JOURNAL = "database-transfer-journal.json";
/** The holder a copy carries until the switch: a controller does not start on it, and the transfer's clean-up recognises its own copy by it. */
export const pendingHolder = (transferId: string): string => `transfer-pending:${transferId}`;
export const AUTHORITY_FILE = "storage-authority.json";

export type StorageKind = "sqlite" | "postgres";

/** A database a transfer can write to. It is named by the host's configuration (a PostgreSQL URL holds a password, so it never comes from chat). */
export interface TransferTarget {
  readonly name: string;
  readonly kind: StorageKind;
  /** A stable spelling of the place, without credentials: what the authority file compares. */
  readonly fingerprint: string;
  /** Opens the (new, empty) destination. The caller closes it. */
  open(): Promise<ControllerStorage>;
  /** Bytes free where the database will be written; undefined when that cannot be known (a SQLite destination must know). */
  freeBytes?(): Promise<number | undefined>;
  /** Empties the destination after a failed copy by the transfer `transferId` (the store is closed first); refuses (throws) when what is there may not be only that copy. Absent or refused: the owner is told the destination is not clean. */
  discard?(transferId: string, options?: { readonly leftover?: boolean }): Promise<void>;
  /** Hides what must never be shown from a text that is about to reach the journal, a log or chat (a PostgreSQL address with its password). */
  redact?(text: string): string;
}

export interface TransferSource { readonly kind: StorageKind; readonly fingerprint: string; readonly name: string }
type Place = { readonly kind: StorageKind; readonly fingerprint: string; readonly name: string };

export type TransferPhase = "copying" | "fencing" | "rolling-back" | "switched" | "failed" | "rolled-back" | "abandoned";
const TERMINAL: readonly TransferPhase[] = ["switched", "failed", "rolled-back", "abandoned"];
type Mark = { readonly epoch: number; readonly auditSeq: number; readonly deliverySeq: number };

export interface TransferJournal {
  readonly format: 1;
  readonly id: string;
  readonly direction: string;
  readonly from: Place;
  readonly to: Place;
  readonly phase: TransferPhase;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly sourceMark?: Mark;
  /** The destination's counters right after the copy: a rollback is safe only while they are unchanged. */
  readonly destinationMark?: Mark;
  /** The new database's counters when the controller on it finished starting; a rollback compares with these (the start's own records are not new work). */
  readonly firstStart?: Mark & { /** Digest of the tables a command or an action would change, noted at the first start: a rollback compares them (counters alone miss a write that bumps neither). */ readonly digests?: Readonly<Record<string, string>> };
  /** The command that applied (or rolled back) the transfer: the same command sent again, also to the controller restarted on the new database, is answered with the recorded result instead of being run again. */
  readonly appliedBy?: string;
  readonly rolledBackBy?: string;
  readonly summary?: { readonly to: string; readonly rows: number; readonly direction: string };
  /** What became of the host's restart onto the new database (when the host offered one and the owner has not turned it off). */
  readonly restart?: { readonly requestedAt: string; readonly state: "requested" | "failed"; readonly reason?: string };
  readonly counts?: Readonly<Record<string, number>>;
  readonly failure?: { readonly at: string; readonly phase: string; readonly reason: string; readonly destinationClean: boolean };
  readonly note?: string;
}

export interface StorageAuthority {
  readonly format: 1;
  readonly generation: number;
  readonly active: Place;
  readonly previous?: Place;
  readonly transferId?: string;
  readonly since: string;
}

export interface TransferFinding { readonly severity: "error" | "warning"; readonly text: string }

export interface TransferPlan {
  /** Apply needs exactly this. It is bound to the direction, both places, the schema version and the authority generation. */
  readonly token: string;
  readonly direction: string;
  readonly from: TransferSource;
  readonly to: { readonly name: string; readonly kind: StorageKind };
  readonly schemaVersion: number;
  readonly rows: Readonly<Record<string, number>>;
  readonly totalRows: number;
  readonly bytes: number;
  readonly bytesNeeded: number;
  readonly freeBytes?: number;
  readonly uncertainEffects: number;
  readonly intendedEffects: number;
  readonly claimsReleased: number;
  readonly ok: boolean;
  readonly findings: readonly TransferFinding[];
  readonly steps: readonly string[];
}

/** Checks outside the database: each answers the ones that are MISSING. */
export interface TransferReferences {
  artifacts?(digests: readonly string[]): Promise<readonly string[]>;
  checkpoints?(points: readonly { readonly id: string; readonly attemptId: string; readonly checkpoint: string }[]): Promise<readonly string[]>;
}

export type TransferPoint = "drained" | "validated" | `copy:${SnapshotTable}` | "copied" | "verified" | "before-fence" | "fenced" | "fencing-recorded" | "authority-written" | "rollback:journal" | "rollback:fenced" | "rollback:authority";

export interface TransferOptions {
  readonly storage: Pick<ControllerStorage, "snapshot" | "acquireEpoch">;
  /** ONE fixed folder for the journal and the authority file, independent of any database path. */
  readonly source: TransferSource;
  readonly targets: () => readonly TransferTarget[];
  readonly stateDirectory: string;
  readonly barrier: MaintenanceBarrier;
  readonly references?: TransferReferences;
  readonly now?: () => Date;
  /** Test hook: runs at each stage and may throw, to prove a failure there leaves the source whole. */
  readonly inject?: (point: TransferPoint) => void | Promise<void>;
  /** Told when a switch is done and the controller must be restarted on the new database. */
  readonly onSwitched?: (authority: StorageAuthority) => void;
  readonly pageSize?: number;
  /** The owner's switch `database.transfer.enabled` (installation setting, default on): off refuses preview, apply and rollback. */
  readonly enabled?: () => Promise<boolean>;
  /**
   * The host's opt-in to restarting the controller onto the new database by itself (card F04m). `run` is called a little after the move (or the rollback) was answered, once, with what happened; the host stops this controller and starts
   * it again from its configuration. Absent: the controller waits for the host to be restarted, as before. The owner can turn the restart off with `database.transfer.restart` (`restartEnabled`).
   */
  readonly restart?: { readonly run: (event: RestartEvent) => void | Promise<void>; readonly delayMs?: number };
  readonly restartEnabled?: () => Promise<boolean>;
  /** The owner's settings of this feature, read and written through the configuration. */
  readonly settings?: TransferSettingsPort;
}

export interface RestartEvent { readonly reason: "switched" | "rolled-back"; readonly transferId: string; readonly to: string }
export interface TransferSettings { readonly enabled: boolean; readonly restart: boolean; /** Whether the host offered a restart at all. */ readonly restartOffered: boolean }
export interface TransferSettingsPort {
  get(): Promise<{ readonly enabled: boolean; readonly restart: boolean }>;
  set(by: unknown, patch: { readonly commandId: string; readonly enabled?: boolean; readonly restart?: boolean }): Promise<unknown>;
}

/** Room needed relative to the rows' text: indexes, the write-ahead log and slack. Provisional. */
export const CAPACITY_FACTOR = 2;

const bad = (message: string): never => { throw new DomainError("invalid_command", message); };
const sha = (text: string): string => createHash("sha256").update(text).digest("hex");

/** The key that marks the journal and the authority file. It lives beside them, private to the owner of the folder. */
export const INTEGRITY_KEY_FILE = "transfer-integrity.key";
const FILES = [TRANSFER_JOURNAL, AUTHORITY_FILE] as const;

/** Writes a small JSON file whole or not at all (temp file in the same folder, flushed, renamed). */
async function rawWrite(path: string, value: object): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID().slice(0, 8)}.tmp`;
  const handle = await open(temp, "w", 0o600);
  try { await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, path); } catch (error) { await rm(temp, { force: true }); throw error; }
  // The rename itself must survive a power cut (POSIX; Windows cannot open a directory to flush it).
  if (process.platform !== "win32") { const dir = await open(dirname(path), "r").catch(() => undefined); if (dir !== undefined) { try { await dir.sync(); } catch { /* a file system that cannot flush a directory */ } finally { await dir.close(); } } }
}
const markOf = (key: Buffer, body: Record<string, unknown>): string => `hmac-sha256:${createHmac("sha256", key).update(canonicalJson(body as never)).digest("hex")}`;
const withoutMark = (value: object): Record<string, unknown> => { const body = JSON.parse(JSON.stringify(value)) as Record<string, unknown>; delete body["integrity"]; return body; };

/** The key while it is being put in place: files an earlier version wrote are marked with it, then it becomes the key. A start between those steps reads it, so a stop half way never locks the owner out. */
const PENDING_KEY_FILE = `${INTEGRITY_KEY_FILE}.new`;

async function readKey(dir: string, name: string = INTEGRITY_KEY_FILE): Promise<Buffer | undefined> {
  let text: string;
  try { text = await readFile(join(dir, name), "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!/^[0-9a-f]{64}\s*$/.test(text)) throw new DomainError("unavailable", `${join(dir, name)} is not a valid key; the database transfer files cannot be trusted until it is looked at`);
  return Buffer.from(text.trim(), "hex");
}
async function syncDir(dir: string): Promise<void> {
  if (process.platform === "win32") return;
  const handle = await open(dir, "r").catch(() => undefined);
  if (handle !== undefined) { try { await handle.sync(); } catch { /* a file system that cannot flush a directory */ } finally { await handle.close(); } }
}
/** Places a whole key file under `name` only if none is there (written to a temp file, flushed, then linked: the name never shows a half-written key). Returns the key that is there afterwards. */
async function placeKey(dir: string, name: string, key: Buffer): Promise<Buffer> {
  const temp = join(dir, `${name}.${randomUUID().slice(0, 8)}.tmp`);
  const handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(`${key.toString("hex")}\n`, "utf8"); await handle.sync(); } finally { await handle.close(); }
  try { await link(temp, join(dir, name)); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } finally { await rm(temp, { force: true }); }
  await syncDir(dir);
  const there = await readKey(dir, name);
  if (there === undefined) throw new Error(`${join(dir, name)} could not be written`);
  return there;
}
/**
 * The key is made by the first write. Files an earlier version wrote (no mark) are marked then, so an upgrade does not lock the owner out; once the key exists an unmarked file is rejected.
 * In three steps that each survive a stop: a whole pending key is placed (never overwriting one that is there), the unmarked files are marked with it, then it becomes the key. A later write finishes a step left half done.
 */
async function keyForWrite(dir: string): Promise<Buffer> {
  const have = await readKey(dir);
  if (have !== undefined) return have;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const pending = (await readKey(dir, PENDING_KEY_FILE)) ?? (await placeKey(dir, PENDING_KEY_FILE, randomBytes(32)));
  for (const name of FILES) {
    let text: string;
    try { text = await readFile(join(dir, name), "utf8"); } catch { continue; }
    try { const old = JSON.parse(text) as Record<string, unknown>; if (old["integrity"] === undefined) await rawWrite(join(dir, name), { ...old, integrity: markOf(pending, old) }); } catch { /* not JSON: the read will say so */ }
  }
  const key = await placeKey(dir, INTEGRITY_KEY_FILE, pending);
  await rm(join(dir, PENDING_KEY_FILE), { force: true });
  await syncDir(dir);
  return key;
}

/** Writes the file with an integrity mark over its content (HMAC with the folder's key). */
async function writeJson(path: string, value: object): Promise<void> {
  const key = await keyForWrite(dirname(path));
  const body = withoutMark(value);
  await rawWrite(path, { ...body, integrity: markOf(key, body) });
}
async function readJson<T>(path: string): Promise<T | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { throw new DomainError("unavailable", `${path} cannot be read (it is not valid JSON); a database transfer is not started until it is looked at`); }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new DomainError("unavailable", `${path} cannot be read (it is not a JSON object); a database transfer is not started until it is looked at`);
  const body = withoutMark(parsed);
  const mark = (parsed as Record<string, unknown>)["integrity"];
  const key = await readKey(dirname(path));
  // A key being put in place (see keyForWrite): files not yet marked with it are accepted, a mark must match it.
  const pending = key === undefined ? await readKey(dirname(path), PENDING_KEY_FILE) : undefined;
  const changed = (why: string): never => { throw new DomainError("unavailable", `${path} ${why}; it was changed by something other than NimbleNewt, so nothing is done with it until it is looked at (restore it from a backup, or remove it only if you know no database transfer has happened)`); };
  if (key === undefined && pending === undefined) { if (mark !== undefined) changed("carries an integrity mark but its key file is missing"); return body as T; }
  if (key === undefined && mark === undefined) return body as T;
  if (typeof mark !== "string") return changed("has no integrity mark");
  const want = Buffer.from(markOf((key ?? pending)!, body)), got = Buffer.from(mark);
  if (want.length !== got.length || !timingSafeEqual(want, got)) changed("does not match its integrity mark");
  return body as T;
}

/** Writes the authority file with its integrity mark (for tools and tests that must place one; the service writes it itself). */
export const writeAuthority = (stateDirectory: string, authority: StorageAuthority): Promise<void> => writeJson(join(stateDirectory, AUTHORITY_FILE), authority);
export const readAuthority = (stateDirectory: string): Promise<StorageAuthority | undefined> => readJson<StorageAuthority>(join(stateDirectory, AUTHORITY_FILE));
export const readJournal = (stateDirectory: string): Promise<TransferJournal | undefined> => readJson<TransferJournal>(join(stateDirectory, TRANSFER_JOURNAL));

/** The place of a SQLite file, spelled the one way (links resolved) so the same file never looks like two databases. */
export async function sqliteFingerprint(path: string): Promise<string> { return `sqlite:${await canon(path)}`; }
/** PostgreSQL: server (a `host` query parameter, as for a unix socket, counts), port, database and schema; never the user or password. An address that cannot be read is refused: two bad addresses must not look like one place. */
export function postgresFingerprint(url: string, schema = "nimblenewt"): string {
  let u: URL;
  try { u = new URL(url); } catch { throw new Error("the PostgreSQL address cannot be read, so the database cannot be told apart from another"); }
  const host = (u.searchParams.get("host") ?? u.hostname).toLowerCase();
  if (host === "") throw new Error("the PostgreSQL address names no server");
  const port = u.searchParams.get("port") ?? (u.port === "" ? "5432" : u.port);
  return `postgres:${host}:${port}${u.pathname}#${schema}`;
}

type Configured = { readonly fingerprint: string };
const refusal = (text: string): never => { throw new Error(`NimbleNewt will not start: ${text}`); };
const wasTransferred = (h: string | null | undefined): string | undefined => (typeof h === "string" && (h.startsWith("transferred-out:") || h.startsWith("rolled-back:") || h.startsWith("transfer-pending:")) ? h.slice(h.indexOf(":") + 1) : undefined);

/**
 * The start-time guard, before the database is opened. The state directory is ONE fixed place the host names (`StartOptions.transfer.stateDirectory`), never derived from a database path, so every database the installation has
 * lived in is judged by the same two files. First an interrupted transfer is settled from the journal: `switched` must have its authority file (anything else is an error, not "nothing was transferred"); `fencing` is finished on the
 * destination and abandoned on the source; an authority file already written settles the journal. Then: a start on a database the authority file does not name is refused, and so is a start on the destination of a transfer the authority
 * does not name (a partial, failed, abandoned or rolled-back copy: the state row is copied last, so such a store looks empty).
 */
export async function guardStart(stateDirectory: string, configured: Configured, now: () => Date = () => new Date()): Promise<{ resolved?: "finished" | "abandoned"; note?: string }> {
  const journal = await readJournal(stateDirectory);
  let authority = await readAuthority(stateDirectory);
  const at = now().toISOString();
  const journalFile = join(stateDirectory, TRANSFER_JOURNAL);
  let result: { resolved?: "finished" | "abandoned"; note?: string } = {};
  let current = journal;
  if (journal !== undefined && journal.phase === "rolling-back") {
    // A rollback that passed its checks is finished whatever stopped it: the previous database is the authoritative one again.
    if (!(authority?.transferId === journal.id && authority.active.fingerprint === journal.from.fingerprint)) {
      authority = { format: 1, generation: (authority?.generation ?? 0) + 1, active: journal.from, previous: journal.to, transferId: journal.id, since: at };
      await writeJson(join(stateDirectory, AUTHORITY_FILE), authority);
    }
    current = { ...journal, phase: "rolled-back", updatedAt: at, note: "a rollback that was stopped part way was finished at the start" };
    await writeJson(journalFile, current);
    result = { resolved: "finished", note: `database transfer ${journal.id}: the rollback was finished at start; the controller database is ${journal.from.name}` };
  } else if (journal !== undefined) {
    const named = authority?.transferId === journal.id && authority.active.fingerprint === journal.to.fingerprint;
    if (journal.phase === "switched" && !named) refuse2(journal);
    if (!TERMINAL.includes(journal.phase)) {
      if (named) {
        current = { ...journal, phase: "switched", updatedAt: at, note: "the authority file was written; the journal was settled at the start" };
        await writeJson(journalFile, current);
        result = { resolved: "finished", note: `database transfer ${journal.id}: settled at start; the controller database is ${journal.to.name}` };
      } else if (journal.phase === "fencing" && journal.to.fingerprint === configured.fingerprint) {
        authority = { format: 1, generation: (authority?.generation ?? 0) + 1, active: journal.to, previous: journal.from, transferId: journal.id, since: at };
        await writeJson(join(stateDirectory, AUTHORITY_FILE), authority);
        current = { ...journal, phase: "switched", updatedAt: at, note: "finished at the start: the copy had been verified and the source fenced" };
        await writeJson(journalFile, current);
        result = { resolved: "finished", note: `database transfer ${journal.id}: finished at start; the controller database is now ${journal.to.name}` };
      } else if (journal.from.fingerprint === configured.fingerprint) {
        const note = journal.phase === "copying" ? "the copy never reached the fence; the destination may hold a partial copy and must be emptied before another transfer" : "stopped after the source was fenced and before the switch; the source is authoritative again";
        current = { ...journal, phase: "abandoned", updatedAt: at, note };
        await writeJson(journalFile, current);
        result = { resolved: "abandoned", note: `database transfer ${journal.id}: abandoned at start (${note})` };
      }
    }
  }
  if (authority !== undefined && authority.active.fingerprint !== configured.fingerprint) refuse2(undefined, authority);
  if (current !== undefined && current.to.fingerprint === configured.fingerprint && !(current.phase === "failed" && current.failure?.destinationClean === true) && !(authority !== undefined && authority.active.fingerprint === configured.fingerprint)) {
    return refusal(`this database is the destination of database transfer ${current.id} (${current.phase}), which did not complete; it may hold only part of the data. Empty it, or point controller.storage at ${authority?.active.name ?? current.from.name}.`);
  }
  return result;
}
function refuse2(journal?: TransferJournal, authority?: StorageAuthority): never {
  if (authority !== undefined) return refusal(`the controller database was moved to ${authority.active.name} (${authority.active.kind}) by a database transfer on ${authority.since}, and this start is configured for another database. Point controller.storage at ${authority.active.name}; or, from a controller running on ${authority.active.name} that has not recorded any work yet, ask in chat to roll the transfer back.`);
  return refusal(`database transfer ${journal!.id} is recorded as switched but the authority file does not name ${journal!.to.name}; the files were changed or lost. Restore ${AUTHORITY_FILE} or look at ${TRANSFER_JOURNAL} before starting.`);
}

/**
 * The lasting fence, checked after the database is opened and before the epoch is taken: a database a transfer left (holder `transferred-out:` or `rolled-back:`) starts only if the authority file names it for that very transfer, or if
 * the transfer was abandoned or failed and this is its source. Without a state directory such a database never starts: nothing can say it is the authoritative one.
 */
export async function assertNotFenced(stateDirectory: string | undefined, configured: Configured, storage: Pick<ControllerStorage, "snapshot">): Promise<number | undefined> {
  const snap = await storage.snapshot();
  let holder: string | null, epoch: number | undefined;
  try { const row = (await snap.read("state", { limit: 1 }))[0]; holder = row === undefined ? null : (row["holder"] as string | null); epoch = row === undefined ? undefined : Number(row["epoch"]); } finally { await snap.close(); }
  const id = wasTransferred(holder);
  if (id === undefined) return epoch;
  if (stateDirectory !== undefined) {
    const authority = await readAuthority(stateDirectory), journal = await readJournal(stateDirectory);
    if (authority?.transferId === id && authority.active.fingerprint === configured.fingerprint) return epoch;
    if (journal?.id === id && (journal.phase === "abandoned" || journal.phase === "failed") && journal.from.fingerprint === configured.fingerprint && !(authority !== undefined && authority.active.fingerprint !== configured.fingerprint)) return epoch;
  }
  return refusal(`this database was left by database transfer ${id} (${holder}) and is not the authoritative one${stateDirectory === undefined ? "; no transfer state directory is configured, so nothing can say otherwise" : ""}. Start the controller on the database the transfer moved to. (A backup restored from before a transfer carries a normal holder: keep transfer.stateDirectory configured so the authority file refuses the old database.)`);
}

/**
 * The start's holder check and its epoch take were two steps: a second start (or a transfer's fence) could slip in between. The storage handed on takes its FIRST epoch with `expectedEpoch` set to the one the check read, so
 * the take fails when anything took the epoch in between (the database is the one the check judged, or the start does not go on). Later takes pass through unchanged.
 */
export function expectEpochOnFirstTake<S extends Pick<ControllerStorage, "acquireEpoch">>(storage: S, seen: number | undefined): S {
  if (seen === undefined) return storage;
  let first = true;
  return new Proxy(storage, {
    get(target, property, receiver) {
      if (property === "acquireEpoch") {
        return async (input: Parameters<ControllerStorage["acquireEpoch"]>[0]) => {
          if (!first || input.expectedEpoch !== undefined) return target.acquireEpoch(input);
          try { const r = await target.acquireEpoch({ ...input, expectedEpoch: seen }); first = false; return r; } catch (error) {
            if ((error as { kind?: string }).kind === "stale_epoch") throw new Error("NimbleNewt will not start: another start or a database transfer took this database while this one was starting; start it again");
            throw error;
          }
        };
      }
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** The tables whose every record is work a rollback would lose: commands (with their results) and effects. The counters alone miss a write that bumps neither the audit nor the delivery counter. Timers and aggregates are not compared: loops rewrite them on their own. */
export const WORK_TABLES: readonly SnapshotTable[] = ["operations", "effects"];
/** Count and SHA-256 of each table's records, read from one snapshot. */
export async function digestTables(storage: Pick<ControllerStorage, "snapshot">, tables: readonly SnapshotTable[] = WORK_TABLES, pageSize = SNAPSHOT_PAGE_MAX): Promise<Record<string, string>> {
  const snap = await storage.snapshot();
  const out: Record<string, string> = {};
  try {
    for (const table of tables) {
      let after: SnapshotRow | undefined, count = 0;
      const hash = createHash("sha256");
      for (;;) {
        const page = await snap.read(table, { ...(after === undefined ? {} : { after }), limit: pageSize });
        for (const row of page) hash.update(`${canonicalJson(row)}\n`);
        count += page.length;
        if (page.length < pageSize) break;
        after = page[page.length - 1];
      }
      out[table] = `${count}:${hash.digest("hex")}`;
    }
  } finally { await snap.close(); }
  return out;
}

/** What a start writes before its loops run (host record, settings): more than this since the copy is work, not a start. Provisional. */
export const START_WRITES_MAX = { audit: 1000, deliveries: 100 } as const;

/**
 * Notes the counters of the new database when the controller on it has taken its epoch and written its own start-up records, before any loop (dispatcher, maintenance, transport) runs. Only the FIRST start after the switch
 * records (the epoch is the copied one plus one): a start without the state directory in between, or growth beyond what a start writes, leaves nothing recorded and a rollback is then refused.
 */
export async function recordFirstStart(stateDirectory: string, configured: Configured, storage: Pick<ControllerStorage, "snapshot">, now: () => Date = () => new Date()): Promise<boolean> {
  const journal = await readJournal(stateDirectory);
  if (journal === undefined || journal.phase !== "switched" || journal.to.fingerprint !== configured.fingerprint || journal.firstStart !== undefined || journal.destinationMark === undefined) return false;
  const snap = await storage.snapshot();
  try {
    const s = (await snap.read("state", { limit: 1 }))[0];
    const mark = { epoch: Number(s?.["epoch"] ?? 0), auditSeq: Number(s?.["audit_seq"] ?? 0), deliverySeq: Number(s?.["delivery_seq"] ?? 0) };
    const was = journal.destinationMark;
    if (mark.epoch !== was.epoch + 1 || mark.auditSeq - was.auditSeq > START_WRITES_MAX.audit || mark.deliverySeq - was.deliverySeq > START_WRITES_MAX.deliveries) return false;
    const digests = await digestTables(storage);
    await writeJson(join(stateDirectory, TRANSFER_JOURNAL), { ...journal, updatedAt: now().toISOString(), firstStart: { ...mark, digests } } satisfies TransferJournal);
    return true;
  } finally { await snap.close(); }
}

/**
 * The journal and the authority file have one writer at a time, across processes: a lock file in the state folder (the data directory lock's machinery: live holders, stale takeover, refresh). A start waits for it (a transfer
 * or another start is short); an apply or rollback that finds it taken is refused at once.
 */
export async function acquireStateLock(stateDirectory: string, options: { wait: boolean; env?: Parameters<typeof acquireDataLock>[1] } = { wait: false }): Promise<() => Promise<void>> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  // In its own sub-folder: the state folder may be the data directory, whose lock file the running controller keeps.
  const lockFolder = join(stateDirectory, ".transfer-lock");
  for (let waited = 0; ; waited += 250) {
    try { const lock = await acquireDataLock(lockFolder, options.env); return async () => { await lock.release().catch(() => undefined); }; } catch (error) {
      if (!(error instanceof DataLockBusy) || !options.wait || waited > 300_000) throw error instanceof DataLockBusy ? new DomainError("unavailable", `another start or database transfer is using the transfer state folder (${stateDirectory}); try again when it is over`) : error;
      await new Promise((r) => setTimeout(r, 250));
    }
  }
}
export async function withStateLock<T>(stateDirectory: string, work: () => Promise<T>, options: { wait: boolean; env?: Parameters<typeof acquireDataLock>[1] } = { wait: false }): Promise<T> {
  const release = await acquireStateLock(stateDirectory, options);
  try { return await work(); } finally { await release(); }
}

/** A SQLite target for a file: free space from the file system the file will be on. */
export async function sqliteTarget(input: { name: string; path: string; open: () => Promise<ControllerStorage>; discard?: () => Promise<void> }): Promise<TransferTarget> {
  const fingerprint = await sqliteFingerprint(input.path);
  return {
    name: input.name, kind: "sqlite", fingerprint, open: input.open, ...(input.discard === undefined ? {} : { discard: input.discard }),
    freeBytes: async () => {
      let probe = await canon(dirname(input.path));
      for (;;) {
        try { const s = await statfs(probe); return Number(s.bavail) * Number(s.bsize); } catch (error) {
          const parent = dirname(probe);
          if (parent === probe || (error as NodeJS.ErrnoException).code !== "ENOENT") return undefined;
          probe = parent;
        }
      }
    },
  };
}

type ApplyResult = { id: string; direction: string; to: string; rows: number; claimsReleased: number; uncertainEffects: number; restartRequired: true; restart: RestartState; replayed?: true; findings: readonly TransferFinding[] };
/** `scheduled`: the host restarts the controller onto the new database by itself shortly; `off`: the host offered it and the owner turned it off; `not-offered`: the host restarts it when it chooses. */
export type RestartState = "scheduled" | "off" | "not-offered";
export interface WipePlan { readonly token: string; readonly target: { readonly name: string; readonly kind: StorageKind }; readonly leftoverOf: string; readonly cleanable: boolean; readonly findings: readonly TransferFinding[]; readonly steps: readonly string[] }
interface CopyStats { rows: Record<string, number>; digests: Record<string, string> }
interface ScanReport { digests: Record<string, string>; rows: Record<string, number>; bytes: number; findings: TransferFinding[]; uncertain: number; intended: number; claims: number }

export class DatabaseTransferService {
  readonly #o: TransferOptions;
  #running = false;
  #wrote = false;
  #release: (() => Promise<void>) | undefined;
  #restartTimer: ReturnType<typeof setTimeout> | undefined;
  constructor(options: TransferOptions) { this.#o = options; }

  /** Stops a restart that is waiting to be made (the controller is closing). */
  dispose(): void { if (this.#restartTimer !== undefined) clearTimeout(this.#restartTimer); this.#restartTimer = undefined; }

  async settings(): Promise<TransferSettings> {
    const s = await (this.#o.settings?.get() ?? Promise.resolve({ enabled: true, restart: true }));
    return { ...s, restartOffered: this.#o.restart !== undefined };
  }
  async setSettings(by: unknown, patch: { commandId: string; enabled?: unknown; restart?: unknown }): Promise<TransferSettings> {
    if (this.#o.settings === undefined) throw new DomainError("unavailable", "the database transfer settings are not available on this installation");
    for (const key of ["enabled", "restart"] as const) if (patch[key] !== undefined && typeof patch[key] !== "boolean") bad(`${key} must be true or false`);
    if (patch.enabled === undefined && patch.restart === undefined) bad("say what to change: enabled (whether the database may be moved at all) or restart (whether the host restarts the controller by itself after a move)");
    await this.#o.settings.set(by, { commandId: patch.commandId, ...(patch.enabled === undefined ? {} : { enabled: patch.enabled as boolean }), ...(patch.restart === undefined ? {} : { restart: patch.restart as boolean }) });
    return this.settings();
  }

  #now(): string { return (this.#o.now ?? (() => new Date()))().toISOString(); }
  #journalPath(): string { return join(this.#o.stateDirectory, TRANSFER_JOURNAL); }
  #size(): number { return this.#o.pageSize ?? SNAPSHOT_PAGE_MAX; }

  /** The databases a transfer may go to (never the one in use). */
  targets(): readonly { name: string; kind: StorageKind; direction: string }[] {
    return this.#o.targets().filter((t) => t.fingerprint !== this.#o.source.fingerprint).map((t) => ({ name: t.name, kind: t.kind, direction: `${this.#o.source.kind} to ${t.kind}` }));
  }
  #target(name: unknown): TransferTarget {
    if (typeof name !== "string" || name.length === 0) return bad("say which database to move to, by the name database.transfer.status lists");
    const found = this.#o.targets().find((t) => t.name === name);
    if (found === undefined) return bad(`no database called ${name.slice(0, 60)} is configured as a transfer target`);
    if (found.fingerprint === this.#o.source.fingerprint) return bad("that is the database in use now");
    return found;
  }

  async status(): Promise<{ authority?: StorageAuthority; journal?: TransferJournal; source: TransferSource; barrier: boolean; targets: ReturnType<DatabaseTransferService["targets"]> }> {
    const authority = await readAuthority(this.#o.stateDirectory), journal = await readJournal(this.#o.stateDirectory);
    return { ...(authority === undefined ? {} : { authority }), ...(journal === undefined ? {} : { journal }), source: this.#o.source, barrier: this.#o.barrier.held, targets: this.targets() };
  }

  #token(target: TransferTarget, schemaVersion: number, generation: number): string {
    return sha(canonicalJson({ direction: `${this.#o.source.kind}>${target.kind}`, from: this.#o.source.fingerprint, to: target.fingerprint, schemaVersion, generation })).slice(0, 32);
  }

  /** Reads the source and the destination and says what an apply would do, with every finding. Changes nothing (the destination is opened and closed). */
  async preview(targetName: unknown): Promise<TransferPlan> {
    await this.#enabled();
    const target = this.#target(targetName);
    const authority = await readAuthority(this.#o.stateDirectory);
    if (authority !== undefined && authority.active.fingerprint !== this.#o.source.fingerprint) bad(`the authoritative database is ${authority.active.name}, not the one in use; a transfer starts from the authoritative database`);
    const findings: TransferFinding[] = [];
    const journal = await readJournal(this.#o.stateDirectory);
    if (journal !== undefined && !TERMINAL.includes(journal.phase)) findings.push({ severity: "error", text: `transfer ${journal.id} is not finished (${journal.phase}); it is settled at the next start` });
    const snap = await this.#o.storage.snapshot();
    let report: ScanReport, schemaVersion: number;
    try { schemaVersion = snap.schemaVersion; report = await this.scan(snap); } finally { await snap.close(); }
    findings.push(...report.findings);
    const bytesNeeded = Math.ceil(report.bytes * CAPACITY_FACTOR);
    const destination = await target.open();
    try {
      const probe = await destination.snapshot();
      try {
        if (probe.schemaVersion !== schemaVersion) findings.push({ severity: "error", text: `the destination has schema version ${probe.schemaVersion} and the source ${schemaVersion}` });
      } finally { await probe.close(); }
      const occupied = await this.#inspect(destination, target);
      if (occupied !== undefined) findings.push(occupied.leftover === undefined ? { severity: "error", text: occupied.text } : { severity: "warning", text: `${occupied.text}; it will be emptied first, then the move goes on` });
    } catch (error) {
      // What the destination's store says about itself goes to the owner: the target hides its address from it (a PostgreSQL target's open already does).
      if (target.redact !== undefined && error instanceof Error && target.redact(error.message) !== error.message) throw new Error(target.redact(error.message));
      throw error;
    } finally { await destination.close(); }
    let freeBytes: number | undefined;
    try { freeBytes = await target.freeBytes?.(); } catch { freeBytes = undefined; }
    if (freeBytes === undefined) findings.push(target.kind === "sqlite" ? { severity: "error", text: "the free room where the SQLite file will be written cannot be read, so a transfer back to SQLite is not started (capacity must be checked)" } : { severity: "warning", text: `the free room on the PostgreSQL server is not checked from here; make sure it has about ${bytesNeeded} bytes free` });
    else if (freeBytes < bytesNeeded) findings.push({ severity: "error", text: `not enough room at the destination: about ${bytesNeeded} bytes are needed (the rows are ${report.bytes} bytes; indexes and the log are counted) and ${freeBytes} are free` });
    const direction = `${this.#o.source.kind} to ${target.kind}`;
    return {
      token: this.#token(target, schemaVersion, authority?.generation ?? 0), direction, from: this.#o.source, to: { name: target.name, kind: target.kind }, schemaVersion, rows: report.rows,
      totalRows: Object.values(report.rows).reduce((a, b) => a + b, 0), bytes: report.bytes, bytesNeeded, ...(freeBytes === undefined ? {} : { freeBytes }),
      uncertainEffects: report.uncertain, intendedEffects: report.intended, claimsReleased: report.claims, ok: !findings.some((f) => f.severity === "error"), findings,
      steps: [
        "This preview opens the destination to check it; a database that is new gets its empty tables created. Nothing of yours is changed.",
        "New work is refused and the controller waits for running work to settle (agent attempts must have ended).",
        `Every record is copied from ${this.#o.source.name} to ${target.name} and read back; counts and digests must match.`,
        "Delivery and timer claims held by this controller are released (they are pending again); uncertain actions stay uncertain and are never run again.",
        "The current database is fenced (no controller can write to it) and the destination becomes the only database a controller will start on.",
        "The controller then stops serving until it is restarted with controller.storage pointing at the new database. Until the new database records anything, the transfer can be rolled back.",
      ],
    };
  }

  /** The checks over one snapshot, and the sizes. Reads everything once; nothing is kept. */
  async scan(snap: StorageSnapshot): Promise<ScanReport> {
    const findings: TransferFinding[] = [];
    const rows: Record<string, number> = {}, hashes: Record<string, string> = {};
    let bytes = 0, uncertain = 0, intended = 0, claims = 0;
    const err = (text: string): void => { if (findings.filter((f) => f.severity === "error").length < 20) findings.push({ severity: "error", text }); };
    const state = (await snap.read("state", { limit: 1 }))[0];
    if (state === undefined) { err("the source has no state record"); return { digests: hashes, rows, bytes, findings, uncertain, intended, claims }; }
    const artifactIds = new Set<string>(), digests = new Set<string>(), points: { id: string; attemptId: string; checkpoint: string; artifactId: string; taskId: string }[] = [];
    const taskIds = new Set<string>(), attemptIds = new Set<string>();
    let maxAudit = 0, maxDelivery = 0, auditPrev = 0, policyRecords = 0;
    const ids = (table: string, row: SnapshotRow, columns: readonly string[]): void => { for (const c of columns) { const v = row[c]; if (typeof v !== "string" || !ID_PATTERN.test(v)) err(`${table}: ${c} ${JSON.stringify(String(v).slice(0, 40))} is not a valid ID`); } };
    const stamp = (table: string, row: SnapshotRow, columns: readonly string[]): void => { for (const c of columns) { const v = row[c]; if (v !== null && v !== undefined && (typeof v !== "string" || !TIMESTAMP_PATTERN.test(v))) err(`${table}: ${c} ${JSON.stringify(String(v).slice(0, 40))} is not a timestamp`); } };
    const json = (table: string, row: SnapshotRow, column: string): Record<string, unknown> | undefined => {
      try { const v = JSON.parse(String(row[column])) as unknown; if (v === null || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object"); return v as Record<string, unknown>; } catch { err(`${table}: ${column} of ${String(row["id"] ?? row["operation_id"] ?? row["delivery_id"] ?? row["timer_id"] ?? row["seq"]).slice(0, 80)} is not a JSON object`); return undefined; }
    };
    for (const table of SNAPSHOT_TABLES) {
      let after: SnapshotRow | undefined, count = 0;
      const tableHash = createHash("sha256");
      for (;;) {
        const page = await snap.read(table, { ...(after === undefined ? {} : { after }), limit: this.#size() });
        for (const row of page) {
          count += 1;
          tableHash.update(`${canonicalJson(row)}\n`);
          for (const v of Object.values(row)) bytes += typeof v === "string" ? Buffer.byteLength(v) : v === null ? 0 : 8;
          if (table === "operations") { ids(table, row, ["operation_id", "correlation_id"]); json(table, row, "result"); }
          else if (table === "aggregates") {
            const kind = String(row["kind"]), id = String(row["id"]);
            if (!KIND_PATTERN.test(kind)) err(`aggregates: kind ${JSON.stringify(kind.slice(0, 40))} is not valid`);
            ids(table, row, ["id"]);
            if (typeof row["revision"] !== "number" || row["revision"] < 1) err(`aggregates: ${kind}/${id} has no revision`);
            const body = json(table, row, "body");
            if (kind === "policy" || kind.endsWith("-policy")) policyRecords += 1;
            if (body === undefined) continue;
            if (kind === "artifact") { artifactIds.add(id); for (const e of (Array.isArray(body["entries"]) ? body["entries"] : []) as { digest?: unknown }[]) if (typeof e?.digest === "string") digests.add(e.digest); }
            else if (kind === "task") taskIds.add(id);
            else if (kind === "attempt") attemptIds.add(id);
            else if (kind === "recovery-point") points.push({ id, attemptId: String(body["attemptId"]), taskId: String(body["taskId"]), artifactId: String(body["artifactId"]), checkpoint: canonicalJson((body["checkpoint"] ?? null) as never) });
          } else if (table === "audit") {
            ids(table, row, ["operation_id"]); stamp(table, row, ["at"]); json(table, row, "detail");
            const seq = Number(row["seq"]);
            if (seq <= auditPrev) err(`audit: sequence ${seq} is not above the one before it`);
            auditPrev = seq; maxAudit = Math.max(maxAudit, seq);
          } else if (table === "deliveries") {
            ids(table, row, ["delivery_id"]); stamp(table, row, ["next_attempt_at", "claimed_until", "delivered_at"]); json(table, row, "payload");
            maxDelivery = Math.max(maxDelivery, Number(row["seq"]));
            const name = String(row["delivery_id"]).slice(0, 60);
            if (row["state"] === "delivered") { if (row["receipt"] === null || row["receipt"] === undefined) err(`deliveries: ${name} is delivered and has no receipt`); else json(table, row, "receipt"); }
            else if (row["receipt"] !== null && row["receipt"] !== undefined) err(`deliveries: ${name} has a receipt but is not delivered`);
            if (row["state"] === "claimed") claims += 1;
          } else if (table === "effects") {
            ids(table, row, ["effect_id", "operation_id"]);
            if (row["status"] === "uncertain") uncertain += 1; else if (row["status"] === "intended") intended += 1;
            if (typeof row["input_digest"] !== "string" || !/^[0-9a-f]{64}$/.test(row["input_digest"])) err(`effects: ${String(row["effect_id"]).slice(0, 60)} has no valid input digest`);
          } else if (table === "timers") {
            ids(table, row, ["timer_id"]); stamp(table, row, ["due_at", "claimed_until"]); json(table, row, "payload");
            if (row["state"] === "claimed") claims += 1;
          }
        }
        if (page.length < this.#size() || table === "state") break;
        after = page[page.length - 1];
      }
      rows[table] = count; hashes[table] = tableHash.digest("hex");
    }
    if (maxAudit !== Number(state["audit_seq"])) err(`the audit counter is ${String(state["audit_seq"])} and the last audit record is ${maxAudit}`);
    if (maxDelivery > Number(state["delivery_seq"])) err(`a delivery has sequence ${maxDelivery}, above the counter ${String(state["delivery_seq"])}`);
    if (policyRecords === 0) findings.push({ severity: "warning", text: "the source holds no policy record: the destination will start from the built-in policy, as the source does" });
    if (uncertain + intended > 0) findings.push({ severity: "warning", text: `${uncertain} uncertain and ${intended} intended actions are carried over as they are; they are reconciled with the outside world and never run again by the transfer` });
    for (const p of points) {
      if (!artifactIds.has(p.artifactId)) err(`recovery point ${p.id} names artifact ${p.artifactId}, which is not in the source`);
      if (!taskIds.has(p.taskId)) err(`recovery point ${p.id} names task ${p.taskId}, which is not in the source`);
      if (!attemptIds.has(p.attemptId)) err(`recovery point ${p.id} names attempt ${p.attemptId}, which is not in the source`);
    }
    if (this.#o.references?.artifacts !== undefined && digests.size > 0) {
      let missing: readonly string[] = [];
      try { missing = await this.#o.references.artifacts([...digests]); } catch (error) { err(`artifact files could not be checked: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); }
      for (const d of missing.slice(0, 10)) err(`artifact file ${d.slice(0, 16)} is not in the artifact store`);
      if (missing.length > 10) err(`${missing.length - 10} more artifact files are missing`);
    } else if (digests.size > 0) findings.push({ severity: "warning", text: `${digests.size} artifact files are referenced; the artifact store is not checked here (it is not moved by a database transfer)` });
    if (this.#o.references?.checkpoints !== undefined && points.length > 0) {
      let missing: readonly string[] = [];
      try { missing = await this.#o.references.checkpoints(points.map((p) => ({ id: p.id, attemptId: p.attemptId, checkpoint: p.checkpoint }))); } catch (error) { err(`conversation checkpoints could not be checked: ${error instanceof Error ? error.message.slice(0, 120) : "failed"}`); }
      for (const id of missing.slice(0, 10)) err(`checkpoint of recovery point ${id} is not in the conversation store, or does not match it`);
    }
    return { digests: hashes, rows, bytes, findings, uncertain, intended, claims };
  }

  async #enabled(): Promise<void> {
    if (this.#o.enabled !== undefined && !(await this.#o.enabled())) throw new DomainError("unavailable", "database transfer is switched off (database.transfer.enabled); the owner can switch it on in chat");
  }

  async #holder(storage: Pick<ControllerStorage, "snapshot">): Promise<string | null> {
    const snap = await storage.snapshot();
    try { const row = (await snap.read("state", { limit: 1 }))[0]; return row === undefined ? null : (row["holder"] as string | null); } finally { await snap.close(); }
  }

  /**
   * Says why a destination is not a new, empty database (undefined: it is). A copy left by a transfer that did not finish is told apart: its holder carries that transfer's pending mark, or (the state row is copied last) the latest journal says the
   * copy of that transfer was started into this very destination and never completed. Such a leftover is `leftover: <transfer id>` when it may be emptied: the database is not the one the authority file names, the transfer was never
   * switched, and the target can empty it. Anything else (a database a controller has owned, a copy of a switched transfer) is only ever refused.
   */
  async #inspect(dest: ControllerStorage, target: TransferTarget, prior?: { readonly journal: TransferJournal | undefined }): Promise<{ text: string; leftover?: string } | undefined> {
    const probe = await dest.snapshot();
    let state: SnapshotRow | undefined, other: string | undefined;
    try {
      state = (await probe.read("state", { limit: 1 }))[0];
      if (state !== undefined && Number(state["epoch"]) === 0) for (const table of SNAPSHOT_TABLES) if (table !== "state" && (await probe.read(table, { limit: 1 })).length > 0) { other = table; break; }
    } finally { await probe.close(); }
    if (state !== undefined && Number(state["epoch"]) === 0 && other === undefined && (state["holder"] === null || state["holder"] === undefined)) return undefined;
    const holder = typeof state?.["holder"] === "string" ? state["holder"] : undefined;
    let id: string | undefined;
    if (holder !== undefined && holder.startsWith("transfer-pending:")) id = holder.slice("transfer-pending:".length);
    else if (state !== undefined && Number(state["epoch"]) === 0) {
      const journal = prior !== undefined ? prior.journal : await readJournal(this.#o.stateDirectory);
      if (journal !== undefined && journal.to.fingerprint === target.fingerprint && (journal.phase === "abandoned" || journal.phase === "copying" || (journal.phase === "failed" && journal.failure?.destinationClean === false))) id = journal.id;
    }
    if (id === undefined) return { text: state === undefined || Number(state["epoch"]) !== 0 ? "the destination is not empty: a controller has already owned it. A transfer goes into a new, empty database." : `the destination already holds ${other ?? "state"} records (a partial copy?); empty it first` };
    const what = `the destination holds a copy left by a transfer that did not finish (${id}); it is not a database in use`;
    const authority = await readAuthority(this.#o.stateDirectory), journal = prior !== undefined ? prior.journal : await readJournal(this.#o.stateDirectory);
    if (authority?.active.fingerprint === target.fingerprint) return { text: `${what}, but the authority file names it as the controller database, so it is not touched` };
    if (journal?.id === id && !(journal.phase === "failed" || journal.phase === "abandoned" || journal.phase === "copying")) return { text: `${what}, but that transfer is ${journal.phase}, so it is not touched` };
    if (target.discard === undefined) return { text: `${what}; this destination cannot be emptied from here, so empty it by hand before another transfer there` };
    return { text: what, leftover: id };
  }

  /** Empties a leftover copy (the destination is closed first by the caller). A refusal is told with the address hidden. */
  async #empty(target: TransferTarget, id: string): Promise<void> {
    try { await target.discard!(id, { leftover: true }); } catch (error) {
      const why = error instanceof Error ? error.message : "it could not be emptied";
      throw new DomainError("unavailable", `the copy left by transfer ${id} was not removed from the destination (${(target.redact !== undefined ? target.redact(why) : why).slice(0, 300)}); empty it by hand before another transfer there`);
    }
  }

  /** What the owner's wipe of a leftover copy would do, with the token to approve it. Changes nothing (the destination is opened and closed). */
  async wipePreview(targetName: unknown): Promise<WipePlan> {
    await this.#enabled();
    const target = this.#target(targetName);
    const dest = await target.open();
    let occupied: { text: string; leftover?: string } | undefined;
    try { occupied = await this.#inspect(dest, target); } finally { await dest.close(); }
    if (occupied === undefined) throw new DomainError("invalid_transition", `the destination ${target.name} is empty; there is nothing to remove`);
    const token = sha(canonicalJson({ wipe: target.fingerprint, leftover: occupied.leftover ?? null, text: occupied.text }));
    return {
      token: token.slice(0, 32), target: { name: target.name, kind: target.kind }, leftoverOf: occupied.leftover ?? "", cleanable: occupied.leftover !== undefined,
      findings: [{ severity: occupied.leftover === undefined ? "error" : "warning", text: occupied.text }],
      steps: ["Only the copy a database transfer left is removed: the controller tables of that copy and, for PostgreSQL, the empty schema they were in. A database a controller has used is never touched.", "The controller database in use is not changed."],
    };
  }

  /** Removes a copy left by a transfer that did not finish, at the owner's request (`confirm` is the token of `wipePreview`). */
  async wipe(targetName: unknown, confirm: unknown): Promise<{ target: string; removed: string }> {
    await this.#enabled();
    return withStateLock(this.#o.stateDirectory, async () => {
      if (this.#running || this.#o.barrier.held) throw new DomainError("unavailable", "a transfer or another maintenance operation is running");
      const target = this.#target(targetName);
      const plan = await this.wipePreview(targetName);
      if (typeof confirm !== "string" || confirm !== plan.token) bad("the confirmation does not match the plan; ask for the preview again and approve that");
      if (!plan.cleanable) throw new DomainError("invalid_transition", plan.findings.map((f) => f.text).join("; "));
      await this.#empty(target, plan.leftoverOf);
      const journal = await readJournal(this.#o.stateDirectory);
      if (journal !== undefined && journal.id === plan.leftoverOf && journal.to.fingerprint === target.fingerprint && (journal.phase === "failed" || journal.phase === "abandoned" || journal.phase === "copying")) {
        await this.#journal(journal, { phase: "failed", failure: { at: this.#now(), phase: "wiped", reason: "the partial copy was removed at the owner's request", destinationClean: true } });
      }
      return { target: target.name, removed: plan.leftoverOf };
    });
  }

  async #at(point: TransferPoint): Promise<void> { await this.#o.inject?.(point); }

  async #journal(journal: TransferJournal, patch: Partial<TransferJournal>): Promise<TransferJournal> {
    const next = { ...journal, ...patch, updatedAt: this.#now() } as TransferJournal;
    await writeJson(this.#journalPath(), next);
    return next;
  }

  /** Whether the host will restart the controller onto the database it now runs on, and the journal's note of the request. */
  async #planRestart(): Promise<{ state: RestartState; journal?: NonNullable<TransferJournal["restart"]> }> {
    if (this.#o.restart === undefined) return { state: "not-offered" };
    let on = true;
    try { on = this.#o.restartEnabled === undefined ? true : await this.#o.restartEnabled(); } catch { on = true; }
    return on ? { state: "scheduled", journal: { requestedAt: this.#now(), state: "requested" } } : { state: "off" };
  }

  /** The host's restart runs once, after the answer had time to reach the owner. A refusal by the host is written to the journal and the controller then waits to be restarted by hand, as without an opt-in. */
  #scheduleRestart(event: RestartEvent): void {
    const restart = this.#o.restart;
    if (restart === undefined) return;
    if (this.#restartTimer !== undefined) clearTimeout(this.#restartTimer);
    this.#restartTimer = setTimeout(() => {
      this.#restartTimer = undefined;
      void (async () => {
        try { await restart.run(event); } catch (error) {
          const reason = (error instanceof Error ? error.message : "the host could not restart the controller").slice(0, 300);
          await withStateLock(this.#o.stateDirectory, async () => {
            const journal = await readJournal(this.#o.stateDirectory);
            if (journal?.id === event.transferId) await this.#journal(journal, { restart: { requestedAt: journal.restart?.requestedAt ?? this.#now(), state: "failed", reason } });
          }, { wait: true }).catch(() => undefined);
        }
      })();
    }, restart.delayMs ?? 1500);
    // Not unref'd: a restart the owner was told about keeps the process alive until it is made (dispose cancels it).
  }

  /** Streams every table of `snap` into `dest` (claims released) and returns what was written, per table. */
  async #copy(snap: StorageSnapshot, dest: ControllerStorage, pending: string): Promise<CopyStats> {
    const stats: CopyStats = { rows: {}, digests: {} };
    for (const table of SNAPSHOT_TABLES) {
      await this.#at(`copy:${table}`);
      let after: SnapshotRow | undefined, count = 0;
      const hash = createHash("sha256");
      for (;;) {
        const page = await snap.read(table, { ...(after === undefined ? {} : { after }), limit: this.#size() });
        const out = page.map((row) => releaseClaim(table, row, pending));
        if (out.length > 0) { await dest.restoreRows(table, out); this.#wrote = true; for (const row of out) hash.update(`${canonicalJson(row)}\n`); }
        count += out.length;
        if (page.length < this.#size() || table === "state") break;
        after = page[page.length - 1];
      }
      stats.rows[table] = count; stats.digests[table] = hash.digest("hex");
    }
    return stats;
  }

  async #readBack(dest: ControllerStorage, stats: CopyStats): Promise<void> {
    const snap = await dest.snapshot();
    try {
      for (const table of SNAPSHOT_TABLES) {
        let after: SnapshotRow | undefined, count = 0;
        const hash = createHash("sha256");
        for (;;) {
          const page = await snap.read(table, { ...(after === undefined ? {} : { after }), limit: this.#size() });
          for (const row of page) hash.update(`${canonicalJson(row)}\n`);
          count += page.length;
          if (page.length < this.#size() || table === "state") break;
          after = page[page.length - 1];
        }
        if (count !== stats.rows[table]) throw new Error(`${table}: ${count} records read back and ${String(stats.rows[table])} written`);
        if (hash.digest("hex") !== stats.digests[table]) throw new Error(`${table}: the records read back differ from the ones written`);
      }
    } finally { await snap.close(); }
  }

  async #changedSince(noted: Readonly<Record<string, string>>): Promise<string[]> {
    const now = await digestTables(this.#o.storage, Object.keys(noted) as SnapshotTable[], this.#size());
    return Object.keys(noted).filter((t) => now[t] !== noted[t]);
  }

  async #mark(storage: Pick<ControllerStorage, "snapshot">): Promise<Mark> {
    const snap = await storage.snapshot();
    try { const s = (await snap.read("state", { limit: 1 }))[0]; return { epoch: Number(s?.["epoch"] ?? 0), auditSeq: Number(s?.["audit_seq"] ?? 0), deliverySeq: Number(s?.["delivery_seq"] ?? 0) }; } finally { await snap.close(); }
  }

  /** Moves the whole store to `targetName`. `confirm` is the token of the preview the owner approved. */
  async apply(targetName: unknown, confirm: unknown, commandId?: string): Promise<ApplyResult> {
    await this.#enabled();
    // The same command sent again (a message resent after the restart, a proposal applied twice) is answered with what was recorded, also by the controller that now runs on the new database.
    const done = commandId === undefined ? undefined : await readJournal(this.#o.stateDirectory);
    if (done !== undefined && commandId !== undefined && done.appliedBy === commandId && done.phase === "switched" && done.summary !== undefined) {
      return { id: done.id, direction: done.summary.direction, to: done.summary.to, rows: done.summary.rows, claimsReleased: 0, uncertainEffects: 0, restartRequired: true, restart: done.restart?.state === "requested" ? "scheduled" : "not-offered", replayed: true, findings: [] };
    }
    return withStateLock(this.#o.stateDirectory, () => this.#apply(targetName, confirm, commandId));
  }

  async #apply(targetName: unknown, confirm: unknown, commandId?: string): Promise<ApplyResult> {
    const target = this.#target(targetName);
    this.#wrote = false;
    if (this.#running || this.#o.barrier.held) throw new DomainError("unavailable", "a transfer or another maintenance operation is already running");
    this.#running = true;
    try {
      const prior = { journal: await readJournal(this.#o.stateDirectory) };
      const plan = await this.preview(targetName);
      if (typeof confirm !== "string" || confirm !== plan.token) bad("the confirmation does not match the plan; ask for the preview again and approve that");
      if (!plan.ok) throw new DomainError("invalid_transition", `the transfer is not started: ${plan.findings.filter((f) => f.severity === "error").map((f) => f.text).join("; ")}`);
      const id = `xfer-${this.#now().replace(/[-:.]/g, "").slice(0, 15)}-${randomUUID().slice(0, 6)}`;
      let journal: TransferJournal = { format: 1, id, direction: plan.direction, from: { ...this.#o.source }, to: { kind: target.kind, fingerprint: target.fingerprint, name: target.name }, phase: "copying", startedAt: this.#now(), updatedAt: this.#now(), ...(commandId === undefined ? {} : { appliedBy: commandId }) };
      await writeJson(this.#journalPath(), journal);
      let stage = "draining";
      let release: (() => Promise<void>) | undefined;
      let dest: ControllerStorage | undefined;
      let snap: StorageSnapshot | undefined;
      let fenced = false, deposed = false;
      let notClean = "";
      const originalHolder = await this.#holder(this.#o.storage);
      try {
        release = await this.#o.barrier.raise("a database transfer is running");
        await this.#at("drained");
        stage = "validating";
        const before = await this.#mark(this.#o.storage);
        snap = await this.#o.storage.snapshot();
        const report = await this.scan(snap);
        const errors = report.findings.filter((f) => f.severity === "error");
        if (errors.length > 0) throw new Error(`the source did not pass the checks: ${errors.map((f) => f.text).join("; ")}`);
        await this.#at("validated");
        journal = await this.#journal(journal, { sourceMark: before, counts: report.rows });
        stage = "copying";
        dest = await target.open();
        let occupied = await this.#inspect(dest, target, prior);
        if (occupied?.leftover !== undefined) {
          // A copy an earlier transfer left is emptied here, not by the owner: the plan the owner approved said so.
          this.#wrote = true;
          await dest.close(); dest = undefined;
          await this.#empty(target, occupied.leftover);
          this.#wrote = false;
          dest = await target.open();
          occupied = await this.#inspect(dest, target);
        }
        if (occupied !== undefined) throw new Error(occupied.text);
        const stats = await this.#copy(snap, dest, pendingHolder(id));
        await this.#at("copied");
        stage = "verifying";
        await this.#readBack(dest, stats);
        await this.#at("verified");
        const destinationMark = await this.#mark(dest);
        const now = await this.#mark(this.#o.storage);
        if (now.epoch !== before.epoch || now.auditSeq !== before.auditSeq || now.deliverySeq !== before.deliverySeq) throw new Error("the source recorded something while it was being copied; nothing was switched");
        // The counters can agree while a record was changed in place: every table is read again and must have the digest it had when it was checked.
        const again = await this.#o.storage.snapshot();
        try { const second = await this.scan(again); for (const t of SNAPSHOT_TABLES) if (second.digests[t] !== report.digests[t]) throw new Error(`the source changed while it was being copied (${t}); nothing was switched`); } finally { await again.close(); }
        await dest.close(); dest = undefined;
        await snap.close(); snap = undefined;
        stage = "fencing";
        await this.#at("before-fence");
        // The fence comes FIRST: only a source that is already fenced may be written down as fenced. A crash before the journal says so leaves `copying` and a fenced source, which a start on the source abandons.
        try { await this.#o.storage.acquireEpoch({ holder: `transferred-out:${id}`, at: this.#now(), expectedEpoch: before.epoch }); } catch (error) {
          // The commit may have happened and the answer been lost: the database itself says whether it is fenced.
          if ((await this.#holder(this.#o.storage).catch(() => undefined)) !== `transferred-out:${id}`) throw error;
        }
        fenced = true;
        await this.#at("fenced");
        // Writes between the last check and the fence were committed under the old epoch; none can commit now, so the source is read once more: it must be what was copied.
        const settled = await this.#mark(this.#o.storage);
        let late: string | undefined;
        if (settled.auditSeq !== before.auditSeq || settled.deliverySeq !== before.deliverySeq) late = "records were written";
        else {
          const final = await this.#o.storage.snapshot();
          try { const third = await this.scan(final); for (const t of SNAPSHOT_TABLES) if (t !== "state" && third.digests[t] !== report.digests[t]) { late = `${t} changed`; break; } } finally { await final.close(); }
        }
        if (late !== undefined) {
          // Take the epoch back with the holder it had; this controller's services still hold the old epoch, so they are deposed and a restart follows.
          await this.#o.storage.acquireEpoch({ holder: originalHolder ?? "controller", at: this.#now() });
          fenced = false; deposed = true;
          throw new Error(`the source changed between the last check and the fence (${late}); nothing was switched. The fence was lifted and the controller must be restarted`);
        }
        journal = await this.#journal(journal, { phase: "fencing", destinationMark });
        await this.#at("fencing-recorded");
        stage = "switching";
        const previous = await readAuthority(this.#o.stateDirectory);
        const authority: StorageAuthority = { format: 1, generation: (previous?.generation ?? 0) + 1, active: journal.to, previous: journal.from, transferId: id, since: this.#now() };
        await writeJson(join(this.#o.stateDirectory, AUTHORITY_FILE), authority);
        await this.#at("authority-written");
        const restart = await this.#planRestart();
        journal = await this.#journal(journal, { phase: "switched", summary: { to: target.name, rows: plan.totalRows, direction: plan.direction }, ...(restart.journal === undefined ? {} : { restart: restart.journal }) });
        this.#release = release;
        try { this.#o.onSwitched?.(authority); } catch { /* the host's notice must not undo a switch */ }
        if (restart.state === "scheduled") this.#scheduleRestart({ reason: "switched", transferId: id, to: target.name });
        return { id, direction: plan.direction, to: target.name, rows: plan.totalRows, claimsReleased: plan.claimsReleased, uncertainEffects: plan.uncertainEffects, restartRequired: true, restart: restart.state, findings: plan.findings };
      } catch (error) {
        // Redacted whole, then cut: cutting first could leave the start of a password at the cut, which the redaction no longer recognises.
        const reason = (target.redact !== undefined ? target.redact(error instanceof Error ? error.message : "the transfer failed") : error instanceof Error ? error.message : "the transfer failed").slice(0, 500);
        if (snap !== undefined) await snap.close().catch(() => undefined);
        if (dest !== undefined) await dest.close().catch(() => undefined);
        if (!fenced) {
          // The source was never touched: the barrier comes down and the controller goes on.
          let clean = !this.#wrote;
          let left = "";
          if (this.#wrote) {
            if (target.discard === undefined) left = " The partial copy is still at the destination; empty it by hand before another transfer there.";
            else try { await target.discard(id); clean = true; } catch (refusal) {
              const why = refusal instanceof Error ? refusal.message : "it could not be emptied";
              left = ` The partial copy was not removed from the destination (${(target.redact !== undefined ? target.redact(why) : why).slice(0, 300)}); empty it by hand before another transfer there.`;
            }
          }
          await this.#journal(journal, { phase: "failed", failure: { at: this.#now(), phase: stage, reason, destinationClean: clean } }).catch(() => undefined);
          notClean = left;
          if (release !== undefined && !deposed) await release().catch(() => undefined); else this.#release = release;
        } else this.#release = release; // fenced and not switched: the barrier stays up; the next start settles it from the journal
        if (error instanceof DomainError) throw error;
        throw new DomainError("unavailable", `the database transfer failed while ${stage}: ${reason}. ${fenced ? "The current database was fenced; restart the controller to settle the transfer." : deposed ? "The controller must be restarted." : "The current database is as it was and work goes on."}${notClean}`);
      }
    } finally { this.#running = false; }
  }

  /**
   * Run on the controller that is running on the NEW database: puts the previous database back as the only one a controller will start on. Refused once this database has recorded work: its counters (audit and delivery records)
   * must equal those noted when the controller finished starting (`firstStart`; the start's own records and its epoch are not work). Then this database is fenced (`rolled-back:<id>`), the authority file names the previous
   * database again for the same transfer and the controller waits for a restart there. After work was recorded the way back is a reverse transfer.
   */
  async rollback(commandId?: string): Promise<{ id: string; to: string; restartRequired: true; restart: RestartState; replayed?: true }> {
    await this.#enabled();
    const done = commandId === undefined ? undefined : await readJournal(this.#o.stateDirectory);
    if (done !== undefined && commandId !== undefined && done.rolledBackBy === commandId && done.phase === "rolled-back") return { id: done.id, to: done.from.name, restartRequired: true, restart: done.restart?.state === "requested" ? "scheduled" : "not-offered", replayed: true };
    return withStateLock(this.#o.stateDirectory, () => this.#rollback(commandId));
  }

  async #rollback(commandId?: string): Promise<{ id: string; to: string; restartRequired: true; restart: RestartState }> {
    if (this.#running) throw new DomainError("unavailable", "a transfer is running");
    const journal = await readJournal(this.#o.stateDirectory), authority = await readAuthority(this.#o.stateDirectory);
    if (journal === undefined || journal.phase !== "switched" || authority === undefined || authority.transferId !== journal.id) throw new DomainError("invalid_transition", "there is no switched transfer to roll back");
    if (authority.active.fingerprint !== journal.to.fingerprint || this.#o.source.fingerprint !== journal.to.fingerprint) throw new DomainError("invalid_transition", "a transfer is rolled back by the controller running on its new database, and only the most recent switch can be rolled back");
    const mark = journal.firstStart;
    if (mark === undefined) throw new DomainError("invalid_transition", "no clean record of the new database's first start exists (it was started without the transfer state folder, wrote more than a start does, or the record could not be written), so nothing can be said about work on it; use a reverse transfer");
    this.#running = true;
    let release: (() => Promise<void>) | undefined;
    let fenced = false;
    let restart: { state: RestartState; journal?: NonNullable<TransferJournal["restart"]> } = { state: "not-offered" };
    try {
      release = await this.#o.barrier.raise("a database transfer is being rolled back");
      const holder = await this.#holder(this.#o.storage);
      const now = await this.#mark(this.#o.storage);
      if (now.auditSeq !== mark.auditSeq || now.deliverySeq !== mark.deliverySeq) throw new DomainError("invalid_transition", `the new database has recorded work since it started (${now.auditSeq - mark.auditSeq} audit records, ${now.deliverySeq - mark.deliverySeq} messages), so going back would lose it. Use a reverse transfer to move it back with its records.`);
      // Writes that bump neither counter are found by the records themselves.
      const changedTables = mark.digests === undefined ? [] : await this.#changedSince(mark.digests);
      if (changedTables.length > 0) throw new DomainError("invalid_transition", `the new database has recorded work since it started (${changedTables.join(", ")} changed), so going back would lose it. Use a reverse transfer to move it back with its records.`);
      // From here the rollback is finished by any start, whatever stops it (the journal says so before the database is touched).
      const rolling = await this.#journal(journal, { phase: "rolling-back" });
      await this.#at("rollback:journal");
      try { await this.#o.storage.acquireEpoch({ holder: `rolled-back:${journal.id}`, at: this.#now(), expectedEpoch: now.epoch }); } catch (error) { if ((await this.#holder(this.#o.storage).catch(() => undefined)) !== `rolled-back:${journal.id}`) { await this.#journal(rolling, { phase: "switched" }); throw error; } }
      fenced = true;
      await this.#at("rollback:fenced");
      // Anything committed between the check and the fence is found now (epoch-checked writes cannot commit any more) and the fence is lifted.
      const after = await this.#mark(this.#o.storage);
      const lateTables = mark.digests === undefined ? [] : await this.#changedSince(mark.digests);
      if (after.auditSeq !== mark.auditSeq || after.deliverySeq !== mark.deliverySeq || lateTables.length > 0) {
        await this.#o.storage.acquireEpoch({ holder: holder ?? "controller", at: this.#now() });
        await this.#journal(rolling, { phase: "switched" });
        fenced = false;
        throw new DomainError("invalid_transition", "work was recorded on the new database while the rollback was being made, so it was not rolled back. The fence was lifted and the controller must be restarted");
      }
      await writeJson(join(this.#o.stateDirectory, AUTHORITY_FILE), { format: 1, generation: authority.generation + 1, active: journal.from, previous: journal.to, transferId: journal.id, since: this.#now() } satisfies StorageAuthority);
      await this.#at("rollback:authority");
      restart = await this.#planRestart();
      // The move's restart note is replaced by the rollback's own (or dropped): a rollback with the restart off must not read as one the host was asked to make.
      const { restart: _moveRestart, ...rolled } = rolling;
      await this.#journal(rolled as TransferJournal, { phase: "rolled-back", note: "rolled back by the owner before the new database recorded any work", ...(commandId === undefined ? {} : { rolledBackBy: commandId }), ...(restart.journal === undefined ? {} : { restart: restart.journal }) });
    } catch (error) {
      if (release !== undefined && !fenced) { /* a refusal before the fence leaves the controller running; a lifted fence leaves it deposed */
        if (!(error instanceof DomainError && /must be restarted/.test(error.message))) await release().catch(() => undefined); else this.#release = release;
      } else this.#release = release;
      throw error;
    } finally { this.#running = false; }
    this.#release = release;
    if (restart.state === "scheduled") this.#scheduleRestart({ reason: "rolled-back", transferId: journal.id, to: journal.from.name });
    return { id: journal.id, to: journal.from.name, restartRequired: true, restart: restart.state };
  }

  /** Lets the maintenance barrier go (a switched transfer keeps it up until the process ends). For tests and hosts that stay up. */
  async releaseBarrier(): Promise<void> { const r = this.#release; this.#release = undefined; if (r !== undefined) await r(); }
}

/** A claim belongs to the controller that took it; the drained controller holds none the new one could honour, so they are pending again. */
function releaseClaim(table: SnapshotTable, row: SnapshotRow, pending: string): SnapshotRow {
  // Until the switch is made the copy does not look like a database a controller may start on: its holder says it is pending.
  if (table === "state") return { ...row, holder: pending };
  if ((table === "deliveries" || table === "timers") && row["state"] === "claimed") return { ...row, state: "pending", claimed_until: null, token: null };
  return row;
}
