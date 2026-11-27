import { isAbsolute } from "node:path";
import type { ControllerStorage } from "../storage/index.js";
import { RecoveryManifestBad, readRecoveryManifestHeader, type RecoveryManifest } from "./manifest.js";
import { snapshotSource, type Watermark } from "./source.js";
import { RecoveryWriteRefused, writeFencedRecoveryManifest, type RecoveryWriteRefusal } from "./writer.js";

/**
 * The recovery watermark kept up to date (card K04): the controller that holds the epoch writes the recovery manifest now and then, and the owner can read how far it reaches. Off unless the
 * installation names the manifest folder at start. Reads and writes only that folder and reads the store; it changes no record.
 *
 * Once a write is refused because this controller is no longer the primary (`stale_epoch`, or a newer manifest in the folder), the service is fenced for the rest of the process: it never tries
 * again, so an old primary that keeps running cannot write a manifest later.
 */
export const RECOVERY_MANIFEST_EVERY_MS_DEFAULT = 15 * 60_000;
export const RECOVERY_MANIFEST_EVERY_MS_MIN = 60_000;
export const RECOVERY_MANIFEST_EVERY_MS_MAX = 24 * 3_600_000;

export interface RecoveryWatermarkOptions {
  readonly storage: ControllerStorage;
  readonly epoch: number;
  readonly directory: string;
  /** How long after a write (or a failed one) the next is due. Whole milliseconds from one minute to one day; default 15 minutes. */
  readonly everyMs?: number;
  readonly now?: () => Date;
}

export type RecoveryRunOutcome = "written" | "not_due" | "refused" | "failed" | "fenced";

/** The last write attempt of this process. `reason` is one bounded sentence, never a path or an address. */
export interface RecoveryAttempt {
  readonly at: string;
  readonly outcome: "written" | "refused" | "failed";
  readonly refusal?: RecoveryWriteRefusal;
  readonly reason?: string;
  readonly withdrawn?: boolean;
}

/** The latest manifest as `manifest.json` says (its own checksum checked; the files it names are checked when a promotion or a restore report reads them). */
export type ManifestState =
  | { readonly state: "absent" }
  | { readonly state: "unreadable"; readonly reason: string }
  | { readonly state: "ok"; readonly createdAt: string; readonly watermark: Watermark; readonly records: number; readonly blobs: number };

/** What the owner can read: what was set, the last attempt, the latest manifest, and how much of the store it does not cover yet. */
export interface RecoveryWatermarkStatus {
  readonly everyMs: number;
  readonly epoch: number;
  /** True once this controller found it is no longer the primary: it writes no more manifests. */
  readonly fenced: boolean;
  readonly last?: RecoveryAttempt;
  readonly manifest: ManifestState;
  /**
   * The store now against the manifest: audit entries and deliveries written after it, and whether it was written under an earlier epoch. A promotion checked against this manifest cannot vouch
   * for them. Absent when there is no readable manifest or the store could not be read.
   */
  readonly notCovered?: { readonly auditEntries: number; readonly deliveries: number; readonly earlierEpoch: boolean };
}

const REASON_MAX = 300;
const reasonOf = (error: unknown): string => (error instanceof Error ? error.message : "unknown").replace(/\s+/g, " ").slice(0, REASON_MAX);
/** A file-system or driver error names the path or the address it failed on: only its code is kept. */
const failureOf = (error: unknown): string => {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Za-z0-9_]{1,40}$/.test(code) ? `the manifest folder or the store could not be used (${code})` : reasonOf(error);
};

export class RecoveryWatermarkService {
  readonly #o: RecoveryWatermarkOptions;
  readonly #everyMs: number;
  #last: RecoveryAttempt | undefined;
  #lastAtMs: number | undefined;
  #fenced = false;
  #running: Promise<RecoveryRunOutcome> | undefined;

  constructor(options: RecoveryWatermarkOptions) {
    const every = options.everyMs ?? RECOVERY_MANIFEST_EVERY_MS_DEFAULT;
    if (!Number.isSafeInteger(every) || every < RECOVERY_MANIFEST_EVERY_MS_MIN || every > RECOVERY_MANIFEST_EVERY_MS_MAX) throw new RangeError("recovery.everyMs: whole milliseconds from 60000 (one minute) to 86400000 (one day)");
    if (!Number.isSafeInteger(options.epoch) || options.epoch < 1) throw new RangeError("the recovery manifest writer needs this controller's epoch (at least 1)");
    if (typeof options.directory !== "string" || options.directory.length === 0 || !isAbsolute(options.directory)) throw new RangeError("recovery.manifestDirectory: an absolute path is required");
    this.#o = options;
    this.#everyMs = every;
  }

  #now(): Date { return this.#o.now?.() ?? new Date(); }

  get fenced(): boolean { return this.#fenced; }

  /** The scheduled run: writes when none was tried in this process yet or the last try is `everyMs` old. One at a time; a call while one runs waits for it. */
  async runDue(): Promise<RecoveryRunOutcome> {
    if (this.#fenced) return "fenced";
    if (this.#running !== undefined) return this.#running;
    const nowMs = this.#now().getTime();
    if (this.#lastAtMs !== undefined && nowMs - this.#lastAtMs < this.#everyMs) return "not_due";
    return this.writeNow();
  }

  /** Writes now (the schedule's next run is counted from here). Never throws: the outcome and its reason are kept for `status`. */
  async writeNow(): Promise<RecoveryRunOutcome> {
    if (this.#fenced) return "fenced";
    if (this.#running !== undefined) return this.#running;
    const run = (async (): Promise<RecoveryRunOutcome> => {
      const at = this.#now();
      try {
        await writeFencedRecoveryManifest({ storage: this.#o.storage, epoch: this.#o.epoch, directory: this.#o.directory, now: () => this.#now() });
        this.#last = { at: at.toISOString(), outcome: "written" };
        return "written";
      } catch (error) {
        if (error instanceof RecoveryWriteRefused) {
          if (error.reason === "stale_epoch" || error.reason === "manifest_newer") this.#fenced = true;
          this.#last = { at: at.toISOString(), outcome: "refused", refusal: error.reason, reason: reasonOf(error), ...(error.withdrawn ? { withdrawn: true } : {}) };
          return this.#fenced ? "fenced" : "refused";
        }
        this.#last = { at: at.toISOString(), outcome: "failed", reason: failureOf(error) };
        return "failed";
      } finally { this.#lastAtMs = at.getTime(); }
    })();
    this.#running = run;
    try { return await run; } finally { this.#running = undefined; }
  }

  /** Read only: the folder's latest manifest (header only) and the store's counters now. */
  async status(): Promise<RecoveryWatermarkStatus> {
    let manifest: ManifestState;
    let header: RecoveryManifest | undefined;
    try {
      header = readRecoveryManifestHeader(this.#o.directory);
      manifest = header === undefined ? { state: "absent" } : { state: "ok", createdAt: header.createdAt, watermark: { ...header.watermark }, records: header.aggregates.rows, blobs: header.blobs.rows };
    } catch (error) {
      manifest = { state: "unreadable", reason: error instanceof RecoveryManifestBad ? reasonOf(error) : "the manifest folder cannot be read" };
    }
    let notCovered: RecoveryWatermarkStatus["notCovered"];
    if (header !== undefined) {
      const source = snapshotSource(this.#o.storage);
      try {
        const now = await source.watermark();
        notCovered = { auditEntries: Math.max(0, now.auditSeq - header.watermark.auditSeq), deliveries: Math.max(0, now.deliverySeq - header.watermark.deliverySeq), earlierEpoch: header.watermark.epoch < now.epoch };
      } catch { notCovered = undefined; } finally { await source.close().catch(() => undefined); }
    }
    return { everyMs: this.#everyMs, epoch: this.#o.epoch, fenced: this.#fenced, ...(this.#last === undefined ? {} : { last: { ...this.#last } }), manifest, ...(notCovered === undefined ? {} : { notCovered }) };
  }
}
