import type { ControllerStorage } from "../storage/index.js";
import { compareToManifest, describeProblem, type BlobCheck, type Comparison } from "./assess.js";
import { readRecoveryManifest } from "./manifest.js";
import { snapshotSource } from "./source.js";

/**
 * What a restore from a backup (SQLite, or any backend) brought back compared with the recovery manifest written before the loss (card K04). SQLite has no standby: its recovery is the
 * last good backup, and the loss is whatever happened after it. The manifest is what turns "restored" into a statement: this many audit entries, these records and these artifact files
 * are not in the restored store. Unlike a promotion this does not block anything: the backup restore is the owner's decision; this only says what it costs.
 */
export interface RestoredReport {
  /** True only when nothing the manifest lists is missing. */
  readonly complete: boolean;
  readonly comparison: Comparison;
  readonly text: string;
}

export async function reportRestoredStore(options: { readonly manifestDirectory: string; readonly storage: ControllerStorage; readonly blobs: BlobCheck | undefined }): Promise<RestoredReport> {
  const manifest = readRecoveryManifest(options.manifestDirectory);
  const source = snapshotSource(options.storage);
  try {
    const comparison = await compareToManifest(manifest, source, options.blobs);
    const lost = comparison.lost;
    const complete = comparison.problems.length === 0;
    const text = complete
      ? `Nothing listed in the recovery manifest of ${manifest.manifest.createdAt} is missing from the restored store.`
      : `Compared with the recovery manifest of ${manifest.manifest.createdAt}, the restored store lacks ${lost.auditEntries} audit entr${lost.auditEntries === 1 ? "y" : "ies"}, ${lost.records} record${lost.records === 1 ? "" : "s"}, ${lost.staleRecords} record${lost.staleRecords === 1 ? "" : "s"} at an older revision and ${lost.blobs} artifact file${lost.blobs === 1 ? "" : "s"}. First: ${comparison.problems.slice(0, 3).map(describeProblem).join("; ")}.`;
    return { complete, comparison, text };
  } finally { await source.close(); }
}
