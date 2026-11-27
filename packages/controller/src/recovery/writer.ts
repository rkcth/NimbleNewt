import { existsSync, lstatSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import type { ControllerStorage } from "../storage/index.js";
import { RECOVERY_AGGREGATES_FILE, RECOVERY_BLOBS_FILE, RECOVERY_MANIFEST_FILE, RECOVERY_FORMAT, RecoveryManifestBad, readManifestText, writeRecoveryManifest, type RecoveryManifest } from "./manifest.js";
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
 *
 * The last look at the folder is taken after the store's last answer before the swap, and nothing is awaited between it and the swap. A manifest another process (a newer primary on its own copy of
 * the database) puts in place inside that short window is not lost: the files the swap displaced are kept aside, and when the displaced manifest is not the one this writer looked at and is ahead
 * of the new one (or unreadable), it is put back and the write is refused. The folder must be given as an absolute path and must not be, or hold in place of its files, a symbolic link.
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

const MANIFEST_FILES = [RECOVERY_MANIFEST_FILE, RECOVERY_AGGREGATES_FILE, RECOVERY_BLOBS_FILE] as const;

/** The folder is a real folder (or not there yet) named by an absolute path, and each manifest file in it is a plain file: a link could point the swap or the withdrawal somewhere else. */
function checkFolder(directory: string): void {
  if (!isAbsolute(directory)) throw new RangeError("the recovery manifest folder must be given as an absolute path");
  const kind = (path: string): "absent" | "dir" | "file" | "other" => {
    try { const st = lstatSync(path); return st.isSymbolicLink() ? "other" : st.isDirectory() ? "dir" : st.isFile() ? "file" : "other"; } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "absent";
      throw error;
    }
  };
  const d = kind(directory);
  if (d === "absent") return;
  if (d !== "dir") throw new Error("the recovery manifest folder is a symbolic link or not a folder: name the folder itself");
  for (const f of MANIFEST_FILES) {
    const k = kind(join(directory, f));
    if (k !== "absent" && k !== "file") throw new RecoveryWriteRefused("manifest_unreadable", `${f} in the manifest folder is not a plain file (a symbolic link or a folder), so it is left as it is: move it aside to let a new manifest be written`);
  }
}

/** The text and watermark of the manifest already in `directory`: none when there is none; refused when there is one whose watermark cannot be read. */
function existingManifest(directory: string): { readonly text?: string; readonly watermark?: Watermark } {
  let text: string | undefined;
  try { text = readManifestText(directory); } catch (error) {
    throw new RecoveryWriteRefused("manifest_unreadable", `the manifest already in the folder cannot be read (${error instanceof RecoveryManifestBad ? error.message : "unknown"}), so nothing can say it is older; it is left as it is: move it aside to let a new one be written`);
  }
  return text === undefined ? {} : { text, watermark: watermarkOf(text) };
}

function watermarkOf(text: string): Watermark {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { raw = undefined; }
  const o = (typeof raw === "object" && raw !== null ? raw : {}) as Record<string, unknown>;
  const w = (typeof o["watermark"] === "object" && o["watermark"] !== null ? o["watermark"] : {}) as Record<string, unknown>;
  if (o["product"] !== "nimblenewt" || o["format"] !== RECOVERY_FORMAT || !count(w["epoch"]) || !count(w["auditSeq"]) || !count(w["deliverySeq"])) {
    throw new RecoveryWriteRefused("manifest_unreadable", "the manifest already in the folder has no watermark this version reads, so nothing can say it is older; it is left as it is: move it aside to let a new one be written");
  }
  return { epoch: w["epoch"], auditSeq: w["auditSeq"], deliverySeq: w["deliverySeq"] };
}

const ahead = (existing: Watermark, epoch: number, next: Watermark | undefined): boolean =>
  existing.epoch > epoch || (next !== undefined && existing.epoch === epoch && (existing.auditSeq > next.auditSeq || existing.deliverySeq > next.deliverySeq));

/** Whether `manifest.json` in `directory` is still the one with checksum `sha`. */
function stillOurs(directory: string, sha: string): boolean {
  try { const text = readManifestText(directory); return text !== undefined && (JSON.parse(text) as { sha256?: unknown }).sha256 === sha; } catch { return false; }
}

/** Refuses when `existing` is ahead of a writer at `epoch` whose manifest would carry `next` (only the epoch is compared while `next` is not known yet). */
function refuseIfAhead(existing: Watermark | undefined, epoch: number, next: Watermark | undefined): void {
  if (existing === undefined) return;
  if (existing.epoch > epoch) throw new RecoveryWriteRefused("manifest_newer", `the manifest in the folder was written under epoch ${existing.epoch}, newer than this controller's ${epoch}: this controller is not the primary`);
  if (next !== undefined && existing.epoch === epoch && (existing.auditSeq > next.auditSeq || existing.deliverySeq > next.deliverySeq)) {
    throw new RecoveryWriteRefused("manifest_newer", `the manifest in the folder is ahead of this store (audit ${existing.auditSeq} against ${next.auditSeq}, deliveries ${existing.deliverySeq} against ${next.deliverySeq}) under the same epoch: it is kept`);
  }
}

/**
 * After the swap: when the manifest the swap displaced is not the one the last look read, another writer put it there in between. One older than `manifest` stays replaced; one that is ahead of it
 * (or cannot be read) is put back, while the folder still holds this writer's manifest, and the write is refused. Not part of the recovery index: exported for this card's tests only.
 */
export function keepNewerDisplaced(directory: string, displaced: string, looked: string | undefined, epoch: number, manifest: RecoveryManifest): void {
  let text: string | undefined;
  let unreadable = false;
  try { text = readManifestText(displaced); } catch { unreadable = true; }
  if (!unreadable && (text === undefined || text === looked)) return;
  let newer = unreadable;
  if (!unreadable) { try { newer = ahead(watermarkOf(text!), epoch, manifest.watermark); } catch { unreadable = true; newer = true; } }
  if (!newer) return;
  const putBack = stillOurs(directory, manifest.sha256);
  if (putBack) {
    for (const f of [RECOVERY_AGGREGATES_FILE, RECOVERY_BLOBS_FILE]) if (existsSync(join(displaced, f))) renameSync(join(displaced, f), join(directory, f));
    renameSync(join(displaced, RECOVERY_MANIFEST_FILE), join(directory, RECOVERY_MANIFEST_FILE));
  }
  throw new RecoveryWriteRefused(unreadable ? "manifest_unreadable" : "manifest_newer", `another controller put ${unreadable ? "a manifest this version cannot read" : "a newer manifest"} in the folder while this one was put in place; ${putBack ? "it was put back" : "the folder had changed again and was left alone"}`, putBack);
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
  checkFolder(directory);
  await checkEpoch(storage, epoch, "before the manifest was read");
  refuseIfAhead(existingManifest(directory).watermark, epoch, undefined);
  const source = snapshotSource(storage);
  let looked: string | undefined;
  let written: RecoveryManifest;
  try {
    written = await writeRecoveryManifest(source, directory, {
      ...(options.now === undefined ? {} : { now: options.now }),
      beforeSwap: async (manifest) => {
        if (manifest.watermark.epoch !== epoch) throw new RecoveryWriteRefused("stale_epoch", `the store's snapshot carries epoch ${manifest.watermark.epoch}, not this controller's ${epoch}: no manifest is written`);
        await checkEpoch(storage, epoch, "while the manifest was made");
        // The last look, with nothing awaited from here to the swap.
        checkFolder(directory);
        const existing = existingManifest(directory);
        refuseIfAhead(existing.watermark, epoch, manifest.watermark);
        looked = existing.text;
      },
      afterSwap: async (manifest, displaced) => keepNewerDisplaced(directory, displaced, looked, epoch, manifest),
    });
  } finally { await source.close(); }
  try { await checkEpoch(storage, epoch, "as the manifest was put in place"); } catch (error) {
    // Taken away only when the file there is still the one this writer put in: a newer controller's manifest is never touched.
    const ours = stillOurs(directory, written.sha256);
    if (ours) rmSync(join(directory, RECOVERY_MANIFEST_FILE), { force: true });
    if (error instanceof RecoveryWriteRefused) throw new RecoveryWriteRefused(error.reason, `${error.message}; the manifest it had just put in place ${ours ? "was taken away again" : "had already been replaced and was left alone"}`, ours);
    throw error;
  }
  return written;
}
