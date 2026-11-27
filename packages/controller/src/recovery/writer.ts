import { rmSync } from "node:fs";
import { join } from "node:path";
import type { ControllerStorage } from "../storage/index.js";
import { RECOVERY_MANIFEST_FILE, RECOVERY_FORMAT, RecoveryManifestBad, readManifestText, writeRecoveryManifest, type RecoveryManifest } from "./manifest.js";
import { snapshotSource, type Watermark } from "./source.js";

/**
 * The fenced writer of the recovery manifest (card K04, recovery watermarks). A manifest says what a promoted standby must hold; a manifest written by a controller that is no longer the primary
 * carries its older, lower watermark and would let a promotion through that the newer state forbids. So only the controller that holds the current epoch writes one, and a manifest never goes back:
 *
 * - the store's current epoch must be the writer's epoch before anything is read, again just before the new files are put in place, and once more afterwards;
 * - the snapshot the manifest is made from must carry that same epoch;
 * - a manifest already in the folder with a higher epoch, or the same epoch and a higher audit or delivery counter, is never replaced;
 * - a `manifest.json` whose watermark cannot be read is never replaced either: nothing can say it is older, so the owner moves it aside;
 * - when the epoch moved while the new files were being put in place, the `manifest.json` this writer put there is taken away again (when it is still the one it wrote): no manifest is refused by a
 *   promotion, an old one could have passed it.
 *
 * The existing manifest's watermark is read from `manifest.json` WITHOUT its checksum or its files: a damaged manifest that names a newer watermark still stops an older writer.
 */
export type RecoveryWriteRefusal = "stale_epoch" | "manifest_newer" | "manifest_unreadable";

export class RecoveryWriteRefused extends Error {
  constructor(readonly reason: RecoveryWriteRefusal, message: string, readonly withdrawn = false) { super(message); this.name = "RecoveryWriteRefused"; }
}

export interface FencedWriteOptions {
  readonly storage: ControllerStorage;
  /** The epoch this controller took at start. */
  readonly epoch: number;
  readonly directory: string;
  readonly now?: () => Date;
}

const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;

/** The watermark of the manifest already in `directory`: `undefined` when there is none; refused when there is one whose watermark cannot be read. */
function existingWatermark(directory: string): Watermark | undefined {
  let text: string | undefined;
  try { text = readManifestText(directory); } catch (error) {
    throw new RecoveryWriteRefused("manifest_unreadable", `the manifest already in the folder cannot be read (${error instanceof RecoveryManifestBad ? error.message : "unknown"}), so nothing can say it is older; it is left as it is: move it aside to let a new one be written`);
  }
  if (text === undefined) return undefined;
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { raw = undefined; }
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const w = (typeof o["watermark"] === "object" && o["watermark"] !== null ? o["watermark"] : {}) as Record<string, unknown>;
  if (o["product"] !== "nimblenewt" || o["format"] !== RECOVERY_FORMAT || !count(w["epoch"]) || !count(w["auditSeq"]) || !count(w["deliverySeq"])) {
    throw new RecoveryWriteRefused("manifest_unreadable", "the manifest already in the folder has no watermark this version reads, so nothing can say it is older; it is left as it is: move it aside to let a new one be written");
  }
  return { epoch: w["epoch"], auditSeq: w["auditSeq"], deliverySeq: w["deliverySeq"] };
}

/** Refuses when `existing` is ahead of a writer at `epoch` whose manifest would carry `next` (only the epoch is compared while `next` is not known yet). */
function refuseIfAhead(existing: Watermark | undefined, epoch: number, next: Watermark | undefined): void {
  if (existing === undefined) return;
  if (existing.epoch > epoch) throw new RecoveryWriteRefused("manifest_newer", `the manifest in the folder was written under epoch ${existing.epoch}, newer than this controller's ${epoch}: this controller is not the primary`);
  if (next !== undefined && existing.epoch === epoch && (existing.auditSeq > next.auditSeq || existing.deliverySeq > next.deliverySeq)) {
    throw new RecoveryWriteRefused("manifest_newer", `the manifest in the folder is ahead of this store (audit ${existing.auditSeq} against ${next.auditSeq}, deliveries ${existing.deliverySeq} against ${next.deliverySeq}) under the same epoch: it is kept`);
  }
}

async function checkEpoch(storage: ControllerStorage, epoch: number, when: string): Promise<void> {
  const current = await storage.currentEpoch();
  if (current > epoch) throw new RecoveryWriteRefused("stale_epoch", `another controller took the epoch (${current}, this one holds ${epoch}) ${when}: this controller is no longer the primary and writes no manifest`);
  if (current !== epoch) throw new RecoveryWriteRefused("stale_epoch", `the store's epoch is ${current}, not this controller's ${epoch} ${when}: no manifest is written`);
}

/** Writes the recovery manifest for the store as this controller holds it, or refuses (`RecoveryWriteRefused`) and leaves the folder as it was (except a withdrawal, see above). */
export async function writeFencedRecoveryManifest(options: FencedWriteOptions): Promise<RecoveryManifest> {
  const { storage, epoch, directory } = options;
  if (!Number.isSafeInteger(epoch) || epoch < 1) throw new RangeError("the writer's epoch must be a whole number of at least 1");
  await checkEpoch(storage, epoch, "before the manifest was read");
  refuseIfAhead(existingWatermark(directory), epoch, undefined);
  const source = snapshotSource(storage);
  let written: RecoveryManifest;
  try {
    written = await writeRecoveryManifest(source, directory, {
      ...(options.now === undefined ? {} : { now: options.now }),
      beforeSwap: async (manifest) => {
        if (manifest.watermark.epoch !== epoch) throw new RecoveryWriteRefused("stale_epoch", `the store's snapshot carries epoch ${manifest.watermark.epoch}, not this controller's ${epoch}: no manifest is written`);
        refuseIfAhead(existingWatermark(directory), epoch, manifest.watermark);
        await checkEpoch(storage, epoch, "while the manifest was made");
      },
    });
  } finally { await source.close(); }
  try { await checkEpoch(storage, epoch, "as the manifest was put in place"); } catch (error) {
    // Taken away only when the file there is still the one this writer put in: a newer controller's manifest is never touched.
    let ours = false;
    try { const text = readManifestText(directory); ours = text !== undefined && (JSON.parse(text) as { sha256?: unknown }).sha256 === written.sha256; } catch { ours = false; }
    if (ours) rmSync(join(directory, RECOVERY_MANIFEST_FILE), { force: true });
    if (error instanceof RecoveryWriteRefused) throw new RecoveryWriteRefused(error.reason, `${error.message}; the manifest it had just put in place ${ours ? "was taken away again" : "had already been replaced and was left alone"}`, ours);
    throw error;
  }
  return written;
}
