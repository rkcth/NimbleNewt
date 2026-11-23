import { basename } from "node:path";
import { filesSealed, type BackupManifest } from "./format.js";
import { manifestDigestOf, readManifest, verifyBackup } from "./verify.js";

/** What a maintenance window records of its checkpoint (card K07): the backup's folder name (never its host path), its manifest digest, whether it checked out, and what was not checked. */
export interface CheckpointCheck { readonly name: string; readonly digest: string; readonly verified: boolean; readonly problems: readonly string[]; readonly note?: string }

/**
 * Checks a backup the controller has just made, for a maintenance window's checkpoint. A plain backup (or one with only its secrets sealed) is checked in full against its manifest. A backup sealed for everything
 * cannot be opened without the owner's passcode or recovery file, which the controller never reads by itself (card K01b: reading it is the owner's own ask): its manifest is read again from disk and must be the one
 * that was written, and the record says plainly that the files were not opened (K07 review: verifying it in full would fail every window of an installation that seals its backups).
 */
export async function checkpointOf(made: { readonly path: string; readonly manifest: BackupManifest }): Promise<CheckpointCheck> {
  const name = basename(made.path);
  const digest = manifestDigestOf(made.manifest);
  if (made.manifest.encryption !== undefined && filesSealed(made.manifest)) {
    const read = await readManifest(made.path);
    if (read.manifest === undefined) return { name, digest, verified: false, problems: read.problems };
    if (manifestDigestOf(read.manifest) !== digest) return { name, digest, verified: false, problems: ["the manifest on disk is not the one that was written"] };
    return { name, digest, verified: true, problems: [], note: "sealed for everything: its manifest was checked, its files were not opened (the passcode is not read by the controller)" };
  }
  const check = await verifyBackup(made.path);
  return { name, digest, verified: check.ok, problems: check.problems };
}
