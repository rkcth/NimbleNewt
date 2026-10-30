import { stat } from "node:fs/promises";
import type { FileBlobStore } from "../artifacts/index.js";
import type { ControllerStorage } from "../storage/index.js";
import { type BackupKind, type BackupManifest } from "./format.js";
import { DEFAULT_RETENTION, listBackups, pruneBackups, type BackupInfo } from "./retention.js";
import { createBackup } from "./write.js";

export interface BackupServiceOptions {
  readonly root: string;
  readonly version: string;
  readonly now?: () => Date;
  /** How old the newest scheduled or manual backup may be before the scheduled run makes a new one. Default 24 hours. */
  readonly everyMs?: number;
  /** How long after a failed scheduled run the next one waits. Default one hour. */
  readonly retryAfterMs?: number;
  readonly retention?: { daily: number; weekly: number };
  readonly pageSize?: number;
  /** The artifact store, if the installation has one: its blobs are part of each backup. */
  readonly blobs?: FileBlobStore;
}

export interface BackupStatus { readonly root: string; readonly newest?: { name: string; createdAt: string; kind: BackupKind }; readonly count: number; readonly running: boolean; readonly lastError?: { at: string; message: string } }

/**
 * The first release's built-in backup (card K01): "back up now", a nightly run and the retention rule (7 daily and 4 weekly copies, pre-upgrade snapshots untouched). One backup runs at a time; asking while one
 * runs gets that one. A failed run is remembered and reported by `status`; it never deletes a good backup, because pruning runs only after a backup was written and listed complete.
 */
export class BackupService {
  readonly #storage: ControllerStorage;
  readonly #options: BackupServiceOptions;
  #running: Promise<{ path: string; manifest: BackupManifest }> | undefined;
  #lastError: { at: string; message: string } | undefined;

  constructor(storage: ControllerStorage, options: BackupServiceOptions) {
    this.#storage = storage;
    this.#options = options;
  }

  #now(): Date { return (this.#options.now ?? (() => new Date()))(); }

  /** The last few asks by command ID, so a client that repeats a request after a timeout is given the backup its first ask made (kept in memory: a restart forgets them). */
  readonly #asked = new Map<string, Promise<{ path: string; manifest: BackupManifest }>>();

  /** `backUpNow` for a command: the same command ID gets the same backup, whether it is still running or done. */
  async backUpFor(commandId: string): Promise<{ path: string; manifest: BackupManifest }> {
    const known = this.#asked.get(commandId);
    if (known !== undefined) {
      // A backup the retention rule has since removed is not an answer to give again: the ask gets a new one.
      const made = await known.catch(() => undefined);
      if (made === undefined || await stat(made.path).then(() => true, () => false)) return known;
      if (this.#asked.get(commandId) === known) this.#asked.delete(commandId);
    }
    const run = this.backUpNow("manual");
    this.#asked.set(commandId, run);
    run.catch(() => this.#asked.delete(commandId)); // a failed ask may be tried again
    while (this.#asked.size > 50) this.#asked.delete(this.#asked.keys().next().value as string);
    return run;
  }

  /** Takes a backup now. A backup already running is the answer to a second ask. */
  backUpNow(kind: BackupKind = "manual"): Promise<{ path: string; manifest: BackupManifest }> {
    if (this.#running !== undefined) return this.#running;
    const run = (async () => {
      try {
        const made = await createBackup(this.#storage, { root: this.#options.root, kind, version: this.#options.version, ...(this.#options.now === undefined ? {} : { now: this.#options.now }), ...(this.#options.pageSize === undefined ? {} : { pageSize: this.#options.pageSize }), ...(this.#options.blobs === undefined ? {} : { blobs: this.#options.blobs }) });
        this.#lastError = undefined;
        await pruneBackups(this.#options.root, { ...(this.#options.now === undefined ? {} : { now: this.#options.now }), retention: this.#options.retention ?? DEFAULT_RETENTION }).catch((error) => { this.#lastError = { at: this.#now().toISOString(), message: `old backups could not be removed: ${error instanceof Error ? error.message : String(error)}` }; });
        return made;
      } catch (error) {
        this.#lastError = { at: this.#now().toISOString(), message: error instanceof Error ? error.message.slice(0, 300) : "the backup failed" };
        throw error;
      } finally { this.#running = undefined; }
    })();
    this.#running = run;
    return run;
  }

  /** The nightly run: makes a scheduled backup when the newest scheduled or manual one is older than the interval (or there is none). Returns whether one was made. */
  async runScheduled(): Promise<boolean> {
    if (this.#running !== undefined) return false;
    // After a failed run, wait before trying again: a full disk would otherwise be hit with a new copy every tick.
    if (this.#lastError !== undefined && this.#now().getTime() - Date.parse(this.#lastError.at) < (this.#options.retryAfterMs ?? 3_600_000)) return false;
    let newest;
    try { newest = (await listBackups(this.#options.root)).find((b) => b.manifest.kind !== "pre-upgrade"); } catch (error) {
      // A backups folder that cannot be read is a failed run: it shows in the status and is not retried every tick.
      this.#lastError = { at: this.#now().toISOString(), message: error instanceof Error ? error.message.slice(0, 300) : "the backups folder could not be read" };
      return false;
    }
    const every = this.#options.everyMs ?? 24 * 3_600_000;
    if (newest !== undefined && this.#now().getTime() - Date.parse(newest.manifest.createdAt) < every) return false;
    try { await this.backUpNow("scheduled"); } catch { return false; } // the failure is kept in `status`
    return true;
  }

  /** Resolves when no backup is running (a failure is already in the status). Called at shutdown, so the store is not closed in the middle of a copy. */
  async finish(): Promise<void> { await this.#running?.catch(() => undefined); }

  list(): Promise<BackupInfo[]> { return listBackups(this.#options.root); }

  async status(): Promise<BackupStatus> {
    const all = await listBackups(this.#options.root).catch(() => [] as BackupInfo[]); // an unreadable folder shows as empty, with the reason in lastError
    const newest = all[0];
    return { root: this.#options.root, count: all.length, running: this.#running !== undefined, ...(newest === undefined ? {} : { newest: { name: newest.manifest.name, createdAt: newest.manifest.createdAt, kind: newest.manifest.kind } }), ...(this.#lastError === undefined ? {} : { lastError: this.#lastError }) };
  }
}
