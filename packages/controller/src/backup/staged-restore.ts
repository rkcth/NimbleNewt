import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream, existsSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { FileBlobStore } from "../artifacts/index.js";
import { DomainError } from "../domain/errors.js";
import type { LedgerEntry } from "../retention/ledger.js";
import { canonicalJson } from "../storage/json.js";
import type { ControllerStorage } from "../storage/types.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { UnlockFailed, type BackupKey } from "./crypto.js";
import type { MaintenanceBarrier } from "./barrier.js";
import type { BackupService } from "./service.js";
import { ProofRefused, type UnlockMethod } from "./encryption.js";
import { listBackups } from "./retention.js";
import { RestoreRefused, restoreBackup, type RestoreResult } from "./restore.js";
import { manifestDigestOf, readManifest, verifyBackup } from "./verify.js";
import { tableFile, type BackupManifest } from "./format.js";
import { validStoreId } from "./pi-state.js";
import { acquireDataLock, type DataLock } from "./data-lock.js";

/**
 * Restoring from inside the running controller (card K01h), for the owner. A running controller owns its database, so a restore cannot write into it: the backup is verified, restored into a NEW database and new
 * conversation-store folders BESIDE the live ones (same folder, so the same device: a rename never crosses a device), the live data is made safe with a pre-restore snapshot, a marker file records the swap, and the
 * maintenance barrier stays up (every command refused) until the controller is started again. The next start (`applyPendingRestore`, before the database is opened, holding the data directory's lock) moves the old
 * database aside (`<db>.before-restore-<stamp>`) and puts the restored one in its place, move by move in a journal: a move that fails (a file in use on Windows, a device boundary) rolls the moves already made back, so
 * the live data is whole again, and the failure is recorded in the marker for the owner to cancel or retry. Nothing is deleted.
 * Provisional: the controller does not end its own process (the host decides how it is restarted, `onStaged` tells it); SQLite only (a PostgreSQL schema restore is not staged yet).
 */
export const PENDING_FILE = "pending-restore.json";
export const JOURNAL_FILE = "restore-journal.json";
export const KEY_FILE = ".nn-restore.key";
/** Kept for callers of the first slice: staging is now beside each target (`<target>.nn-staged-<stamp>`), so this folder is no longer made. */
export const STAGING_DIR = ".nn-restore";
export const DEFAULT_CONFIRM_MINUTES = 30;

export interface RestorePlan {
  /** The proposal's confirmation: apply needs exactly this. It is bound to the whole manifest of the backup (every file, the artifact and conversation indexes), the installation's epoch and an expiry, so an approved preview cannot be applied to something else or later than allowed. */
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
  /** The live database file (SQLite). */
  readonly sqlitePath: string;
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
  readonly now?: () => Date;
  /** How long an approval token is accepted, in minutes: the owner's setting (`restoreConfirmMinutes`); null: no expiry; absent: 30. */
  readonly confirmMinutes?: () => Promise<number | null | undefined>;
  /** Whether the backups made here include the agents' conversation state (false: `piState` is not configured on this installation, and every plan says so). */
  readonly piStateConfigured?: boolean;
  /** The device of a path (tests). */
  readonly deviceOf?: (path: string) => Promise<number>;
}

const stampOf = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
export const BACKUP_NAME = /^backup-[0-9TZ]{16}-(manual|scheduled|pre-upgrade|pre-restore)$/;
const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"] as const;
const STAGED = ".nn-staged-";

/** Whether `p` is a path strictly below `root` (platform-correct: no string prefix test). */
const inside = (root: string, p: string): boolean => { const r = relative(resolve(root), resolve(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };

async function exists(p: string): Promise<boolean> { return stat(p).then(() => true, () => false); }

/** An absolute path with every link in its existing part resolved: the one spelling the marker stores and compares, so a relative data directory or a link cannot make the same place look like two. */
export async function canon(p: string): Promise<string> {
  const r = resolve(p);
  try { return await realpath(r); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const parent = dirname(r);
    return parent === r ? r : join(await canon(parent), basename(r));
  }
}

async function countRows(file: string, test: (row: Record<string, unknown>) => boolean): Promise<number> {
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) { if (line !== "" && test(JSON.parse(line) as Record<string, unknown>)) n += 1; }
  return n;
}

const macOf = (key: Buffer, value: object): string => createHmac("sha256", key).update(canonicalJson(value as never)).digest("hex");
const macEqual = (a: string, b: unknown): boolean => typeof b === "string" && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The key that authenticates the marker and the journal: made on first use, readable by the controller's user only. */
async function markerKey(dataDirectory: string, create: boolean): Promise<Buffer | undefined> {
  const path = join(dataDirectory, KEY_FILE);
  if (create) { try { await writeFile(path, `${randomBytes(32).toString("hex")}\n`, { flag: "wx", mode: 0o600 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; } }
  const text = await readFile(path, "utf8").catch(() => undefined);
  return text !== undefined && /^[0-9a-f]{64}\s*$/.test(text) ? Buffer.from(text.trim(), "hex") : undefined;
}

const stagedOf = (target: string, stamp: string): string => `${target}${STAGED}${stamp}`;
const asideOf = (target: string, stamp: string): string => `${target}.before-restore-${stamp}`;

/** Reads and authenticates the marker; undefined when there is none. Throws (a plain Error) for one that is unreadable, forged or for another place. */
async function readMarker(dataDirectory: string, livePath: string, piFinal: ((id: string) => string | undefined) | undefined): Promise<{ pending: PendingRestore; data: string; live: string } | undefined> {
  const data = await canon(dataDirectory);
  const live = await canon(livePath);
  let parsed: PendingRestore;
  try { parsed = JSON.parse(await readFile(join(data, PENDING_FILE), "utf8")) as PendingRestore; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error("the pending restore marker cannot be read; the restore was not applied. Remove the marker file to start without it.");
  }
  const key = await markerKey(data, false);
  const { mac, ...rest } = parsed;
  if (key === undefined || !macEqual(macOf(key, rest), mac)) throw new Error("the pending restore marker is not authentic (it was not written by this controller); the restore was not applied. Remove the marker file to start without it.");
  const bad = (why: string): never => { throw new Error(`the pending restore marker is not valid (${why}); the restore was not applied`); };
  if (parsed.format !== 2 || typeof parsed.stamp !== "string" || !/^[0-9TZ]{16}$/.test(parsed.stamp) || typeof parsed.name !== "string" || !BACKUP_NAME.test(parsed.name) || !Array.isArray(parsed.pi)) bad("shape");
  if (parsed.liveDb !== live) throw new Error("the pending restore marker is not for this database");
  if (parsed.stagedDb !== stagedOf(live, parsed.stamp)) bad("the staged database is not beside the live one");
  for (const p of parsed.pi) {
    if (!validStoreId(p.id) || typeof p.target !== "string") return bad("a conversation store");
    const known = resolve(piFinal?.(p.id) ?? join(data, "restored-pi-state", p.id));
    if (p.target !== await canon(known)) bad(`a conversation folder is not where this installation keeps ${p.id}`);
    if (p.staged !== stagedOf(p.target, parsed.stamp)) bad("a staged conversation folder is not beside its target");
    safeTarget(p.target, data, live);
  }
  return { pending: parsed, data, live };
}

/** A restore never replaces the data directory, the database's folder or anything above them (a corrupt id mapping must not make it move a whole tree). */
function safeTarget(target: string, data: string, live: string): void {
  const dirs = [data, dirname(live)];
  if (dirname(target) === target || dirs.some((d) => d === target || inside(target, d))) throw new DomainError("invalid_command", "a conversation store would replace the data directory or a folder above it");
}

interface Move { readonly from: string; readonly to: string }
interface Journal { readonly stamp: string; readonly mode: "forward" | "back"; readonly moves: readonly Move[]; /** forward: the next move to make (= how many are made); back: how many moves are still to undo. */ readonly at: number; readonly mac?: string }

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

async function planMoves(p: PendingRestore): Promise<Move[]> {
  const moves: Move[] = [];
  for (const x of p.pi) {
    if (!(await exists(x.staged))) continue;
    if (await exists(x.target)) moves.push({ from: x.target, to: asideOf(x.target, p.stamp) });
    moves.push({ from: x.staged, to: x.target });
  }
  if (await exists(p.stagedDb)) {
    for (const s of SQLITE_SIDECARS) if (await exists(p.liveDb + s)) moves.push({ from: p.liveDb + s, to: asideOf(p.liveDb, p.stamp) + s });
    for (const s of SQLITE_SIDECARS) if (s !== "" && await exists(p.stagedDb + s)) moves.push({ from: p.stagedDb + s, to: p.liveDb + s });
    moves.push({ from: p.stagedDb, to: p.liveDb });
  }
  return moves;
}

/** Undoes the moves of a journal, last first, recording progress after each. Throws (with what is left) when one cannot be undone. */
async function rollBack(data: string, key: Buffer, j: Journal, o: ApplyOptions): Promise<void> {
  for (let i = j.at; i > 0; i--) {
    const m = j.moves[i - 1]!;
    if ((await exists(m.to)) && !(await exists(m.from))) {
      try { await renameRetry(o, m.to, m.from); } catch (error) {
        await writeJournal(data, key, { stamp: j.stamp, mode: "back", moves: j.moves, at: i });
        throw new Error(`the restore could not be undone: ${basename(m.to)} could not be moved back to ${basename(m.from)} (${(error as NodeJS.ErrnoException).code ?? "error"}). The data directory is half-swapped; the journal ${JOURNAL_FILE} lists every move. Free the file and start again: the rollback continues from where it stopped.`);
      }
    }
  }
}

/**
 * Finishes a staged restore at start, before the database is opened. Safe to run again after a crash: the moves are journalled, each one is checked against what is already done, and the marker goes last. Returns the
 * restored backup's name, or undefined when there was nothing to do or the swap failed and was rolled back (then the marker records why, `backup.restore.status` shows it and `backup.restore.cancel` clears it, and the
 * controller starts on the data it had). Throws when the data directory is half-swapped and could not be put back, when the marker is not authentic, or when another controller holds the data directory.
 */
export async function applyPendingRestore(dataDirectory: string, livePath: string, print: (line: string) => void = () => undefined, options: ApplyOptions = {}): Promise<string | undefined> {
  const found = await readMarker(dataDirectory, livePath, options.piFinal);
  if (found === undefined) return undefined;
  const { pending, data } = found;
  const lock = options.lock ?? await acquireDataLock(data, options.now);
  try {
    const key = (await markerKey(data, false))!;
    let journal = await readJournal(data, key);
    if (pending.failed !== undefined && journal === undefined) {
      print(`A restore of ${pending.name} was tried and could not be applied (${pending.failed.reason}); the data is as it was. Cancel it (backup.restore.cancel) and prepare it again when the cause is fixed.`);
      return undefined;
    }
    if (journal === undefined) {
      journal = { stamp: pending.stamp, mode: "forward", moves: await planMoves(pending), at: 0 };
      await writeJournal(data, key, journal);
    }
    let failure: unknown;
    if (journal.mode === "forward") {
      for (let i = journal.at; i < journal.moves.length; i++) {
        const m = journal.moves[i]!;
        try {
          // Already made (the process ended between the rename and the journal)?
          if (!(await exists(m.from)) && (await exists(m.to))) { /* done */ } else {
            await mkdir(dirname(m.to), { recursive: true });
            await renameRetry(options, m.from, m.to);
          }
        } catch (error) { failure = error; journal = { ...journal, at: i }; break; }
        journal = { ...journal, at: i + 1 };
        await writeJournal(data, key, journal);
      }
      if (failure === undefined) {
        await rm(join(data, JOURNAL_FILE), { force: true });
        await rm(join(data, PENDING_FILE), { force: true });
        print(`The restore of ${pending.name} was applied: the previous database and conversation folders are kept beside, named .before-restore-${pending.stamp}.`);
        return pending.name;
      }
      journal = { stamp: journal.stamp, mode: "back", moves: journal.moves, at: journal.at };
      await writeJournal(data, key, journal);
    }
    const why = failure === undefined ? "an earlier attempt to put things back was interrupted" : `${(failure as NodeJS.ErrnoException).code ?? "error"} while moving files into place`;
    await rollBack(data, key, journal, options);
    await rm(join(data, JOURNAL_FILE), { force: true });
    const { mac: _old, ...rest } = pending;
    const failed = { ...rest, failed: { at: (options.now ?? (() => new Date()))().toISOString(), reason: why, rolledBack: true } };
    await writeFile(join(data, PENDING_FILE), `${JSON.stringify({ ...failed, mac: macOf(key, failed) }, null, 2)}\n`, { mode: 0o600 });
    print(`The restore of ${pending.name} could not be applied (${why}). Everything it had moved was put back; the controller starts on the data it had. Cancel the restore (backup.restore.cancel) and prepare it again when the cause is fixed.`);
    return undefined;
  } finally { if (options.lock === undefined) await lock.release(); }
}

export interface RestoreStatus { pending?: PendingRestore; barrier: ReturnType<MaintenanceBarrier["state"]>; /** The marker on disk could not be read or is not authentic: the next start refuses until it is removed. */ markerProblem?: string }

export class StagedRestore {
  readonly #o: StagedRestoreOptions;
  #pending: { pending: PendingRestore; release: () => Promise<void> } | undefined;
  #busy = false;
  readonly #sessionKey = randomBytes(32);
  readonly #used = new Set<string>();
  constructor(options: StagedRestoreOptions) { this.#o = options; }
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

  /** The token: a nonce, an expiry and an HMAC (under a key only this process holds) over the whole manifest's digest, the backup's name, the installation's epoch and those two. */
  async #issue(m: BackupManifest): Promise<{ token: string; expiresAt?: string }> {
    const epoch = await this.#o.storage.currentEpoch();
    const ttl = await this.#ttlMs();
    const exp = ttl === null ? 0 : this.#now().getTime() + ttl;
    const nonce = randomBytes(8).toString("hex");
    const mac = macOf(this.#sessionKey, { name: m.name, digest: manifestDigestOf(m), epoch, exp, nonce }).slice(0, 32);
    return { token: `${exp}.${nonce}.${mac}`, ...(ttl === null ? {} : { expiresAt: new Date(exp).toISOString() }) };
  }

  async #checkToken(m: BackupManifest, confirm: unknown): Promise<void> {
    const wrong = (why: string): never => { throw new DomainError("invalid_command", `confirm must be the token of the preview just shown: ${why}`); };
    if (typeof confirm !== "string") return wrong("none was given");
    const parts = /^(\d{1,16})\.([0-9a-f]{16})\.([0-9a-f]{32})$/.exec(confirm);
    if (parts === null) return wrong("it is not a restore token");
    const exp = Number(parts[1]);
    const expected = macOf(this.#sessionKey, { name: m.name, digest: manifestDigestOf(m), epoch: await this.#o.storage.currentEpoch(), exp, nonce: parts[2]! }).slice(0, 32);
    if (!macEqual(expected, parts[3])) return wrong("the preview is out of date, or the approval was for something else (the backup, or the installation, has changed)");
    if (exp !== 0 && this.#now().getTime() > exp) return wrong("it has expired; ask for a new preview");
    if (this.#used.has(confirm)) return wrong("it was already used");
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
        "2. It is restored into a new database and new conversation folders beside the live ones; the live ones are not touched.",
        "3. No agent work may be running. The installation stops accepting commands and a snapshot of the current state is taken (kind pre-restore, kept unless you set how many to keep).",
        "4. The controller must be restarted by you; on that start the old database and conversation folders are moved aside (.before-restore-<time>) and the restored ones take their place. If a move fails, the ones already made are undone and you are told.",
        "5. Actions that were only intended when the backup was taken come back as uncertain and are never run again; undelivered messages are sent again.",
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
    return { ...(await this.#issue(m)), ...plan };
  }

  get pending(): PendingRestore | undefined { return this.#pending?.pending; }

  /** The state for `backup.restore.status`: what this run prepared, or else what the marker on disk says (a restore that waits for a start, or that a start tried and rolled back). */
  async status(): Promise<RestoreStatus> {
    const barrier = this.#o.barrier.state();
    if (this.#pending !== undefined) return { pending: this.#pending.pending, barrier };
    try {
      const found = await readMarker(this.#o.dataDirectory, this.#o.sqlitePath, this.#o.piFinal);
      return { ...(found === undefined ? {} : { pending: found.pending }), barrier };
    } catch (error) { return { barrier, markerProblem: error instanceof Error ? error.message.slice(0, 300) : "the marker cannot be read" }; }
  }

  async #rmStaged(p: { stagedDb: string; pi: readonly { staged: string }[] }): Promise<string[]> {
    const left: string[] = [];
    for (const target of [...SQLITE_SIDECARS.map((s) => p.stagedDb + s), ...p.pi.map((x) => x.staged)]) {
      try { await rm(target, { recursive: true, force: true }); } catch { left.push(target); }
    }
    return left;
  }

  /** Stages the restore and raises the barrier; needs the token the preview gave (the owner approved exactly that). */
  async apply(name: unknown, confirm: unknown, method?: UnlockMethod): Promise<{ plan: RestorePlan; pending: PendingRestore; result: RestoreResult; safetyCopy: string; changesDiscarded?: number }> {
    if (this.#busy || this.#pending !== undefined) throw new DomainError("unavailable", "a restore is already being prepared or waits for the restart");
    this.#busy = true;
    const data = await canon(this.#o.dataDirectory);
    const live = await canon(this.#o.sqlitePath);
    const stamp = stampOf(this.#now());
    const stagedDb = stagedOf(live, stamp);
    const staged: { stagedDb: string; pi: { id: string; staged: string; target: string }[] } = { stagedDb, pi: [] };
    try {
      if (await exists(join(data, PENDING_FILE))) throw new DomainError("unavailable", "a restore is already recorded for the next start (or one that failed is still recorded): cancel it first");
      const { path, manifest } = await this.#find(name);
      await this.#checkToken(manifest, confirm);
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
      const targets = new Map<string, string>();
      const piTarget = (id: string): string => {
        if (!validStoreId(id)) throw new DomainError("invalid_command", "a conversation store has an id that cannot be restored");
        let t = targets.get(id);
        if (t === undefined) { t = resolve(this.#o.piFinal?.(id) ?? join(data, "restored-pi-state", id)); targets.set(id, t); }
        return stagedOf(t, stamp);
      };
      const fresh = await SqliteStorage.open({ path: stagedDb });
      try {
        // The one verification: the restore checks the backup, and the manifest it checked must be the one the approval named.
        result = await restoreBackup(path, fresh, { ...(this.#o.blobs === undefined ? {} : { blobs: this.#o.blobs }), ...(unlock === undefined ? {} : { unlock }), deletions: await this.#o.deletions?.() ?? [], piTarget, expectedManifestDigest: manifestDigestOf(manifest) });
      } catch (error) { await fresh.close().catch(() => undefined); throw error instanceof RestoreRefused ? new DomainError("integrity", error.message) : error; }
      await fresh.close();
      for (const [id, t] of targets) {
        const target = await canon(t);
        safeTarget(target, data, live);
        staged.pi.push({ id, staged: stagedOf(target, stamp), target });
        if (stagedOf(target, stamp) !== stagedOf(t, stamp)) await rename(stagedOf(t, stamp), stagedOf(target, stamp)).catch(() => undefined);
      }
      // Staged beside what it replaces, so every rename stays on one device; checked anyway.
      const dev = this.#o.deviceOf ?? (async (p: string) => (await stat(p)).dev);
      const pairs: (readonly [string, string])[] = [[stagedDb, dirname(live)], ...staged.pi.filter((x) => existsSync(x.staged)).map((x) => [x.staged, dirname(x.target)] as const)];
      for (const [from, to] of pairs) {
        if (await dev(from) !== await dev(to)) throw new DomainError("unavailable", `the restored data and the place it must go are on different devices (${basename(from)}); the swap would not be a single rename. Nothing was changed.`);
      }
      const release = await this.#o.barrier.raise(`restoring ${manifest.name}`);
      try {
        const safety = await this.#o.backups.safetyCopy();
        const lastSeq = await this.#lastAuditSeq();
        const backupSeq = manifest.files.find((f) => f.table === "audit")?.rows;
        const key = (await markerKey(data, true))!;
        const body: Omit<PendingRestore, "mac"> = { format: 2, name: manifest.name, stamp, preparedAt: this.#now().toISOString(), stagedDb, liveDb: live, pi: staged.pi };
        const pending: PendingRestore = { ...body, mac: macOf(key, body) };
        await writeFile(join(data, PENDING_FILE), `${JSON.stringify(pending, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        this.#pending = { pending, release };
        try { this.#o.onStaged?.(pending); } catch { /* the host's notice failing does not undo a staged restore */ }
        const plan: RestorePlan = { token: String(confirm), ...(await this.#plan(path, manifest, false)), ...(result.effectsMarkedUncertain === undefined ? {} : { effectsToMarkUncertain: result.effectsMarkedUncertain }), deliveriesToResend: result.deliveriesToResend };
        return { plan, pending, result, safetyCopy: basename(safety.path), ...(lastSeq === undefined || backupSeq === undefined ? {} : { changesDiscarded: Math.max(0, lastSeq - backupSeq) }) };
      } catch (error) { await release(); throw error; }
    } catch (error) {
      await this.#rmStaged(staged).catch(() => undefined);
      throw error;
    } finally { this.#busy = false; }
  }

  /**
   * Withdraws a restore that no start has applied: the marker and the staged copies are removed and the barrier comes down, whatever else fails (a leftover is reported, not hidden). Also clears a restore a start tried and
   * rolled back, and puts back what a half-done swap had moved (the journal). The live data is as it was.
   */
  async cancel(): Promise<{ cancelled: boolean; leftovers?: string[] }> {
    const mem = this.#pending;
    const data = await canon(this.#o.dataDirectory);
    let disk: PendingRestore | undefined;
    try { disk = (await readMarker(data, this.#o.sqlitePath, this.#o.piFinal))?.pending; } catch { disk = undefined; }
    const p = mem?.pending ?? disk;
    if (p === undefined && !(await exists(join(data, PENDING_FILE)))) return { cancelled: false };
    const leftovers: string[] = [];
    let markerGone = false;
    try {
      const key = await markerKey(data, false);
      const journal = key === undefined ? undefined : await readJournal(data, key).catch(() => undefined);
      if (journal !== undefined && key !== undefined) { await rollBack(data, key, journal, {}); await rm(join(data, JOURNAL_FILE), { force: true }).catch(() => leftovers.push(JOURNAL_FILE)); }
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
