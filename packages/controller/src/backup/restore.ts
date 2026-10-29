import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import type { FileBlobStore } from "../artifacts/index.js";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { SNAPSHOT_TABLES, canonicalJson, type ControllerStorage, type SnapshotRow } from "../storage/index.js";
import { verifyBackup } from "./verify.js";
import { ARTIFACT_FOLDER, type BackupManifest } from "./format.js";

export class RestoreRefused extends Error {
  constructor(message: string) { super(message); this.name = "RestoreRefused"; }
}

export interface RestoreResult {
  readonly manifest: BackupManifest;
  readonly rows: number;
  /** Effects that were only intended when the copy was taken: they may have happened afterwards, so they are restored as uncertain and left to be reconciled, never run again. */
  readonly effectsMarkedUncertain: number;
  /** Artifact blobs put back into the artifact store. */
  readonly blobsRestored: number;
}

const RESTORED_EVIDENCE = canonicalJson({ restoredFromBackup: true, note: "this effect was intended when the backup was taken; whether it happened afterwards is not known, so it must be reconciled with the outside world and is never run again" });

/**
 * Restores a backup into an empty store (one no controller has owned). The backup is verified first, against its manifest and the store's schema version; nothing is written when it fails. An interrupted restore leaves
 * a partly filled store, which the caller discards (a restore always starts from a new, empty database), because the state row that makes a store look used is written last.
 */
export async function restoreBackup(path: string, storage: ControllerStorage, options: { pageSize?: number; /** Where the backup's artifact blobs go; required when the backup has any. */ blobs?: FileBlobStore } = {}): Promise<RestoreResult> {
  const check = await verifyBackup(path);
  if (!check.ok || check.manifest === undefined) throw new RestoreRefused(`the backup cannot be restored: ${check.problems.join("; ")}`);
  const manifest = check.manifest;
  if (manifest.artifacts !== undefined && manifest.artifacts.blobs > 0 && options.blobs === undefined) throw new RestoreRefused("the backup holds artifact files, and no artifact store was given to put them in");
  if ((await storage.currentEpoch()) !== 0) throw new RestoreRefused("the target is not empty: a controller has already owned it. Restore into a new, empty database.");
  const probe = await storage.snapshot();
  const targetVersion = probe.schemaVersion;
  await probe.close();
  if (targetVersion !== manifest.schemaVersion) throw new RestoreRefused(`the backup has schema version ${manifest.schemaVersion} and the target has ${targetVersion}; restore it with the version of NimbleNewt that made it, then upgrade`);
  let blobs = 0;
  if (manifest.artifacts !== undefined && options.blobs !== undefined) {
    // The artifacts go in first: they are content-addressed, harmless without the rows, and the state row that makes the store look used must still be the last thing written.
    for (const line of (await readFile(join(path, manifest.artifacts.index.file), "utf8")).split("\n")) {
      if (line === "") continue;
      const e = JSON.parse(line) as { digest: string };
      const put = await options.blobs.put(createReadStream(join(path, ARTIFACT_FOLDER, e.digest)));
      if (put.digest !== e.digest) throw new RestoreRefused(`artifact ${e.digest.slice(0, 12)} did not come back as the same bytes`);
      blobs += 1;
    }
  }
  const pageSize = options.pageSize ?? 500;
  let total = 0;
  let marked = 0;
  for (const table of SNAPSHOT_TABLES) {
    const entry = manifest.files.find((f) => f.table === table)!;
    let batch: SnapshotRow[] = [];
    const flush = async (): Promise<void> => { if (batch.length > 0) { await storage.restoreRows(table, batch); total += batch.length; batch = []; } };
    for await (const line of createInterface({ input: createReadStream(join(path, entry.file), "utf8"), crlfDelay: Infinity })) {
      if (line === "") continue;
      let row = JSON.parse(line) as SnapshotRow;
      if (table === "effects" && row["status"] === "intended") { row = { ...row, status: "uncertain", evidence: RESTORED_EVIDENCE }; marked += 1; }
      batch.push(row);
      if (batch.length >= pageSize) await flush();
    }
    await flush();
  }
  return { manifest, rows: total, effectsMarkedUncertain: marked, blobsRestored: blobs };
}
