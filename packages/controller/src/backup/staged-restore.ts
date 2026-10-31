import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { FileBlobStore } from "../artifacts/index.js";
import { DomainError } from "../domain/errors.js";
import type { LedgerEntry } from "../retention/ledger.js";
import { canonicalJson } from "../storage/json.js";
import type { ControllerStorage } from "../storage/types.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import type { BackupKey } from "./crypto.js";
import type { MaintenanceBarrier } from "./barrier.js";
import type { BackupService } from "./service.js";
import type { UnlockMethod } from "./encryption.js";
import { listBackups } from "./retention.js";
import { RestoreRefused, restoreBackup, type RestoreResult } from "./restore.js";
import { readManifest, verifyBackup } from "./verify.js";
import { tableFile, type BackupManifest } from "./format.js";
import { validStoreId } from "./pi-state.js";

/**
 * Restoring from inside the running controller (card K01h), for the owner. A running controller owns its database, so a restore cannot write into it: the backup is verified, restored into a NEW database and new
 * conversation-store folders beside the live ones (staged), the live data is made safe with a pre-restore snapshot, a marker file records the swap, and the maintenance barrier stays up (every command refused) until the
 * controller is started again. The next start (`applyPendingRestore`, before the database is opened) moves the old database aside (`<db>.before-restore-<stamp>`) and puts the restored one in its place. Nothing is deleted.
 * Provisional: the controller does not end its own process (the host decides how it is restarted, `onStaged` tells it); SQLite only (a PostgreSQL schema restore is not staged yet).
 */
export const PENDING_FILE = "pending-restore.json";
export const STAGING_DIR = ".nn-restore";

export interface RestorePlan {
  /** The proposal's confirmation: apply needs exactly this. It changes if the backup, the installation's epoch or the live database changes, so an approved preview cannot be applied to something else. */
  readonly token: string;
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
  /** Counted from a plain backup; absent for an encrypted one (its rows can only be read after the unlock). */
  readonly effectsToMarkUncertain?: number;
  readonly deliveriesToResend?: number;
  /** What the owner will see happen, in order. */
  readonly steps: readonly string[];
  readonly warnings: readonly string[];
}

export interface PendingRestore {
  readonly format: 1;
  readonly name: string;
  readonly stamp: string;
  readonly preparedAt: string;
  readonly stagedDb: string;
  readonly liveDb: string;
  readonly pi: readonly { readonly staged: string; readonly target: string }[];
}

export interface StagedRestoreOptions {
  readonly backups: BackupService;
  readonly root: string;
  readonly barrier: MaintenanceBarrier;
  /** The live database file (SQLite). */
  readonly sqlitePath: string;
  /** The folder the markers and staging live in (the data directory). */
  readonly dataDirectory: string;
  readonly storage: Pick<ControllerStorage, "currentEpoch">;
  readonly blobs?: FileBlobStore;
  /** Where the live conversation store `id` is on this machine; one not known goes to `<data>/restored-pi-state/<id>`. */
  readonly piFinal?: (id: string) => string | undefined;
  /** The unlock for an encrypted backup (reads a host file; never an argument). */
  readonly unlock?: (method: UnlockMethod) => Promise<BackupKey>;
  readonly deletions?: () => Promise<readonly LedgerEntry[]>;
  readonly onStaged?: (pending: PendingRestore) => void;
  readonly now?: () => Date;
}

const stampOf = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
const BACKUP_NAME = /^backup-[0-9TZ]{16}-(manual|scheduled|pre-upgrade)$/;
const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"] as const;

/** Whether `p` is a path strictly below `root` (platform-correct: no string prefix test). */
const inside = (root: string, p: string): boolean => { const r = relative(resolve(root), resolve(p)); return r !== "" && !r.startsWith("..") && !isAbsolute(r); };

async function exists(p: string): Promise<boolean> { return stat(p).then(() => true, () => false); }

async function countRows(file: string, test: (row: Record<string, unknown>) => boolean): Promise<number> {
  let n = 0;
  for await (const line of createInterface({ input: createReadStream(file), crlfDelay: Infinity })) { if (line !== "" && test(JSON.parse(line) as Record<string, unknown>)) n += 1; }
  return n;
}

export class StagedRestore {
  readonly #o: StagedRestoreOptions;
  #pending: { pending: PendingRestore; release: () => Promise<void> } | undefined;
  #busy = false;
  constructor(options: StagedRestoreOptions) { this.#o = options; }
  #now(): Date { return (this.#o.now ?? (() => new Date()))(); }
  get #markerPath(): string { return join(this.#o.dataDirectory, PENDING_FILE); }

  async #find(name: unknown): Promise<{ path: string; manifest: BackupManifest }> {
    if (typeof name !== "string" || !BACKUP_NAME.test(name)) throw new DomainError("invalid_command", "name must be the name of a backup, as backup.list shows it");
    const found = (await listBackups(this.#o.root)).find((b) => basename(b.path) === name);
    if (found === undefined) throw new DomainError("not_found", `there is no complete backup named ${name}`);
    return { path: found.path, manifest: found.manifest };
  }

  async #tokenFor(m: BackupManifest): Promise<string> {
    const epoch = await this.#o.storage.currentEpoch();
    return createHash("sha256").update(canonicalJson({ name: m.name, createdAt: m.createdAt, mac: m.mac ?? null, files: m.files.map((f) => f.sha256), epoch } as never)).digest("hex").slice(0, 32);
  }

  /** What restoring this backup would do, exactly. Changes nothing and needs no secret. */
  async preview(name: unknown): Promise<RestorePlan> {
    const { path, manifest: m } = await this.#find(name);
    const read = await readManifest(path);
    if (read.manifest === undefined) throw new DomainError("integrity", `the backup cannot be restored: ${read.problems.join("; ")}`);
    const encrypted = m.encryption !== undefined;
    const warnings: string[] = [];
    let effects: number | undefined, deliveries: number | undefined;
    if (!encrypted) {
      const check = await verifyBackup(path);
      if (!check.ok) throw new DomainError("integrity", `the backup cannot be restored: ${check.problems.join("; ")}`);
      effects = await countRows(join(path, tableFile("effects", false)), (r) => r["status"] === "intended");
      deliveries = await countRows(join(path, tableFile("deliveries", false)), (r) => r["state"] !== "delivered");
    } else warnings.push("This backup is encrypted: it is checked and opened with the passcode or recovery file when you approve, before anything is changed.");
    if (m.piState === undefined) warnings.push("This backup holds no agent conversation state; the agents' conversations on this machine stay as they are, and work that was in progress will resume from the restored records.");
    warnings.push("Everything written after this backup was made is replaced by it. The current database and conversation folders are kept beside, never deleted.");
    return {
      token: await this.#tokenFor(m), name: m.name, createdAt: m.createdAt, kind: m.kind, version: m.version, schemaVersion: m.schemaVersion, encrypted,
      rows: m.files.reduce((n, f) => n + f.rows, 0), artifactFiles: m.artifacts?.blobs ?? 0, piStores: m.piState?.stores ?? 0, piFiles: m.piState?.files ?? 0,
      ...(effects === undefined ? {} : { effectsToMarkUncertain: effects }), ...(deliveries === undefined ? {} : { deliveriesToResend: deliveries }),
      steps: [
        "1. The backup is checked against its manifest (and opened, if encrypted).",
        "2. It is restored into a new database and new conversation folders beside the live ones; the live ones are not touched.",
        "3. No agent work may be running. The installation stops accepting commands and a snapshot of the current state is taken (kind pre-upgrade, kept by retention).",
        "4. The controller must be restarted by you; on that start the old database and conversation folders are moved aside (.before-restore-<time>) and the restored ones take their place.",
        "5. Actions that were only intended when the backup was taken come back as uncertain and are never run again; undelivered messages are sent again.",
      ],
      warnings,
    };
  }

  get pending(): PendingRestore | undefined { return this.#pending?.pending; }

  /** The state for `backup.restore.status`, also after a restart that finds a marker it did not make (the swap has not run: the controller was started without applying it). */
  async status(): Promise<{ pending?: PendingRestore; barrier: ReturnType<MaintenanceBarrier["state"]> }> {
    return { ...(this.#pending === undefined ? {} : { pending: this.#pending.pending }), barrier: this.#o.barrier.state() };
  }

  /** Stages the restore and raises the barrier; needs the token the preview gave (the owner approved exactly that). */
  async apply(name: unknown, confirm: unknown, method?: UnlockMethod): Promise<{ plan: RestorePlan; pending: PendingRestore; result: RestoreResult; safetyCopy: string }> {
    if (this.#busy || this.#pending !== undefined) throw new DomainError("unavailable", "a restore is already being prepared or waits for the restart");
    this.#busy = true;
    const stamp = stampOf(this.#now());
    const staging = join(this.#o.dataDirectory, STAGING_DIR, stamp);
    try {
      const plan = await this.preview(name);
      if (typeof confirm !== "string" || confirm !== plan.token) throw new DomainError("invalid_command", "confirm must be the token of the preview just shown: the preview is out of date, or the approval was for something else");
      const { path, manifest } = await this.#find(name);
      let unlock: BackupKey | undefined;
      if (manifest.encryption !== undefined) {
        if (this.#o.unlock === undefined) throw new DomainError("unavailable", "the backup is encrypted and no unlock method is set up on this host");
        unlock = await this.#o.unlock(method ?? "passcode");
      }
      const check = await verifyBackup(path, { ...(unlock === undefined ? {} : { unlock }) });
      if (!check.ok) throw new DomainError("integrity", `the backup cannot be restored: ${check.problems.join("; ")}`);
      await rm(staging, { recursive: true, force: true });
      await mkdir(staging, { recursive: true, mode: 0o700 });
      const stagedDb = join(staging, "controller.sqlite");
      const piRoot = join(staging, "pi");
      let result: RestoreResult;
      const fresh = await SqliteStorage.open({ path: stagedDb });
      try {
        result = await restoreBackup(path, fresh, { ...(this.#o.blobs === undefined ? {} : { blobs: this.#o.blobs }), ...(unlock === undefined ? {} : { unlock }), deletions: await this.#o.deletions?.() ?? [], piTarget: (id) => join(piRoot, id) });
      } catch (error) { await fresh.close().catch(() => undefined); throw error instanceof RestoreRefused ? new DomainError("integrity", error.message) : error; }
      await fresh.close();
      const release = await this.#o.barrier.raise(`restoring ${manifest.name}`);
      try {
        const safety = await this.#o.backups.safetyCopy();
        const stores = await readdir(piRoot).catch(() => [] as string[]);
        const pi = stores.filter(validStoreId).map((id) => ({ staged: join(piRoot, id), target: resolve(this.#o.piFinal?.(id) ?? join(this.#o.dataDirectory, "restored-pi-state", id)) }));
        const pending: PendingRestore = { format: 1, name: manifest.name, stamp, preparedAt: this.#now().toISOString(), stagedDb, liveDb: resolve(this.#o.sqlitePath), pi };
        await writeFile(this.#markerPath, `${JSON.stringify(pending, null, 2)}\n`, { flag: "wx", mode: 0o600 });
        this.#pending = { pending, release };
        try { this.#o.onStaged?.(pending); } catch { /* the host's notice failing does not undo a staged restore */ }
        return { plan, pending, result, safetyCopy: basename(safety.path) };
      } catch (error) { await release(); throw error; }
    } catch (error) {
      await rm(staging, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    } finally { this.#busy = false; }
  }

  /** Withdraws a staged restore that has not been applied by a start: the marker and staging are removed and the barrier comes down. The live data was never touched. */
  async cancel(): Promise<{ cancelled: boolean }> {
    const p = this.#pending;
    if (p === undefined) return { cancelled: false };
    await rm(this.#markerPath, { force: true });
    await rm(join(this.#o.dataDirectory, STAGING_DIR, p.pending.stamp), { recursive: true, force: true });
    this.#pending = undefined;
    await p.release();
    return { cancelled: true };
  }
}

/**
 * Finishes a staged restore at start, before the database is opened. Safe to run again after a crash: every step checks what is already done, and the marker goes last. Returns the restored backup's name, or undefined when there was nothing to do.
 */
export async function applyPendingRestore(dataDirectory: string, livePath: string, print: (line: string) => void = () => undefined): Promise<string | undefined> {
  const marker = join(dataDirectory, PENDING_FILE);
  let pending: PendingRestore;
  try { pending = JSON.parse(await readFile(marker, "utf8")) as PendingRestore; } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; print("A restore marker is present but cannot be read; the restore was not applied. Remove the marker file to start without it."); throw new Error("the pending restore marker cannot be read"); }
  if (pending.format !== 1 || typeof pending.stamp !== "string" || !/^[0-9TZ]{16}$/.test(pending.stamp) || resolve(pending.liveDb) !== resolve(livePath) || !Array.isArray(pending.pi)) throw new Error("the pending restore marker is not for this database");
  const staging = join(dataDirectory, STAGING_DIR, pending.stamp);
  if (resolve(pending.stagedDb) !== join(staging, "controller.sqlite")) throw new Error("the pending restore marker names files outside its staging folder");
  const aside = (p: string): string => `${p}.before-restore-${pending.stamp}`;
  for (const p of pending.pi) {
    if (!inside(staging, p.staged) || typeof p.target !== "string") throw new Error("the pending restore marker names a conversation folder outside its staging folder");
    if (!(await exists(p.staged))) continue;
    if (await exists(p.target)) await rename(p.target, aside(p.target));
    await mkdir(dirname(p.target), { recursive: true });
    await rename(p.staged, p.target);
  }
  if (await exists(pending.stagedDb)) {
    for (const suffix of SQLITE_SIDECARS) if (await exists(livePath + suffix)) await rename(livePath + suffix, aside(livePath) + suffix);
    for (const suffix of SQLITE_SIDECARS) if (suffix !== "" && await exists(pending.stagedDb + suffix)) await rename(pending.stagedDb + suffix, livePath + suffix);
    await rename(pending.stagedDb, livePath);
  }
  await rm(marker, { force: true });
  await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  print(`The restore of ${pending.name} was applied: the previous database and conversation folders are kept beside, named .before-restore-${pending.stamp}.`);
  return pending.name;
}
