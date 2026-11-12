import { Readable } from "node:stream";
import type { FileBlobStore } from "../artifacts/index.js";
import { join } from "node:path";
import type { SignatureCheck, SignatureTrust } from "./signing.js";
import { createInterface } from "node:readline";
import { SNAPSHOT_TABLES, canonicalJson, type ControllerStorage, type SnapshotRow } from "../storage/index.js";
import { cipherOf, secretsCipherOf, blobFile, manifestDigestOf, readAll, verifyBackup } from "./verify.js";
import { readSecrets, restoreSecrets, type SecretsRestored, type SecretsSink } from "./secrets.js";
import { parsePiIndex, writePiState } from "./pi-state.js";
import { readPlain, type BackupKey } from "./crypto.js";
import { ledgerFilter, type LedgerEntry } from "../retention/ledger.js";
import { ARTIFACT_FOLDER, type BackupManifest, type BlobIndexLine } from "./format.js";

export class RestoreRefused extends Error {
  constructor(message: string) { super(message); this.name = "RestoreRefused"; }
}

export interface RestoreResult {
  readonly manifest: BackupManifest;
  /** What the signature check found (card K01b3), with the plain statement of what a valid signature does and does not show. */
  readonly signature?: SignatureCheck;
  readonly rows: number;
  /** Effects that were only intended when the copy was taken: they may have happened afterwards, so they are restored as uncertain and left to be reconciled, never run again. */
  readonly effectsMarkedUncertain: number;
  /** Messages and notices that had not been delivered when the copy was taken (or were being delivered): they are sent again, so a recipient may see one it had already received after the copy. */
  readonly deliveriesToResend: number;
  /** Artifact blobs put back into the artifact store. */
  readonly blobsRestored: number;
  /** Records the deletion ledger blanked or removed again, so a backup older than a deletion does not bring the text back (card K06). */
  readonly deletionsReapplied: number;
  /** Conversation stores and files of the agents' own Pi state written back (card K01h). */
  /** Blobs left out because every artifact that held them is on the deletion ledger (a restore does not bring a deleted artifact's files back, card K06). */
  readonly blobsSkippedDeleted: number;
  readonly piStoresRestored: number;
  readonly piFilesRestored: number;
  /** The secret values of an encrypted backup (card K01b): what was done with them; absent when the backup holds none, or when they were left out (`secretsLeftOut` says why). Counts only, never a value. */
  readonly secrets?: SecretsRestored;
  readonly secretsLeftOut?: string;
  /** Things the owner should be told that are not problems. */
  readonly notes?: readonly string[];
}

const RESTORED_EVIDENCE = canonicalJson({ restoredFromBackup: true, note: "this effect was intended when the backup was taken; whether it happened afterwards is not known, so it must be reconciled with the outside world and is never run again" });

/**
 * Restores a backup into an empty store (one no controller has owned). The backup is verified first, against its manifest and the store's schema version; nothing is written when it fails. An interrupted restore leaves
 * a partly filled store, which the caller discards (a restore always starts from a new, empty database), because the state row that makes a store look used is written last.
 */
export async function restoreBackup(path: string, storage: ControllerStorage, options: { pageSize?: number; /** Where the backup's artifact blobs go; required when the backup has any. */ blobs?: FileBlobStore; /** The unlocked key, for an encrypted backup. */ unlock?: BackupKey; /** The deletions recorded outside the database (`DeletionLedger.read`): applied to the rows as they are restored. */ deletions?: readonly LedgerEntry[]; /** The signing public keys already trusted (card K01b3): the backup must carry a valid signature of one of them. */ signatureTrust?: SignatureTrust; /** Refuse a backup that is not encrypted. */ requireEncrypted?: boolean; /** Where the backup's secret values go (card K01b); required when the backup holds them and a key was given, unless `skipSecrets`. */ secrets?: SecretsSink; /** Take a value that is already in the store over the backup's value (default: keep what is there, a secret changed since the backup is not rolled back). */ overwriteSecrets?: boolean; /** Leave the secret values out on purpose. */ skipSecrets?: boolean; /** Where the conversation store `id` goes (an empty or missing folder); required when the backup has Pi state. */ piTarget?: (id: string) => string; /** The digest of the manifest the caller approved (`manifestDigestOf`): the backup verified here must be exactly that one. */ expectedManifestDigest?: string } = {}): Promise<RestoreResult> {
  const check = await verifyBackup(path, { ...(options.signatureTrust === undefined ? {} : { signatureTrust: options.signatureTrust }), ...(options.unlock === undefined ? {} : { unlock: options.unlock }), ...(options.requireEncrypted === undefined ? {} : { requireEncrypted: options.requireEncrypted }) });
  if (!check.ok || check.manifest === undefined) throw new RestoreRefused(`the backup cannot be restored: ${check.problems.join("; ")}`);
  const manifest = check.manifest;
  if (options.expectedManifestDigest !== undefined && manifestDigestOf(manifest) !== options.expectedManifestDigest) throw new RestoreRefused("the backup is not the one that was approved: it changed after the preview");
  const cipher = cipherOf(manifest, options.unlock);
  const secretsCipher = secretsCipherOf(manifest, options.unlock);
  const wantsSecrets = manifest.secrets !== undefined && manifest.secrets.count > 0 && secretsCipher !== undefined && options.skipSecrets !== true;
  if (wantsSecrets && options.secrets === undefined) throw new RestoreRefused("the backup holds secret values and nowhere was given to put them: give a place for them, or say they are to be left out");
  if (manifest.artifacts !== undefined && manifest.artifacts.blobs > 0 && options.blobs === undefined) throw new RestoreRefused("the backup holds artifact files, and no artifact store was given to put them in");
  if (manifest.piState !== undefined && manifest.piState.files > 0 && options.piTarget === undefined) throw new RestoreRefused("the backup holds the agents' conversation stores, and no folder was given to put them in");
  if ((await storage.currentEpoch()) !== 0) throw new RestoreRefused("the target is not empty: a controller has already owned it. Restore into a new, empty database.");
  const probe = await storage.snapshot();
  const targetVersion = probe.schemaVersion;
  await probe.close();
  if (targetVersion !== manifest.schemaVersion) throw new RestoreRefused(`the backup has schema version ${manifest.schemaVersion} and the target has ${targetVersion}; restore it with the version of NimbleNewt that made it, then upgrade`);
  // The secret values are read and checked before anything is written, and put into the store first (like the artifacts: harmless without the rows, and the state row that makes the store look used is still last).
  let secrets: SecretsRestored | undefined;
  let secretsLeftOut: string | undefined;
  if (manifest.secrets !== undefined && manifest.secrets.count > 0) {
    if (options.skipSecrets === true) secretsLeftOut = "they were left out on request";
    else if (secretsCipher === undefined) secretsLeftOut = "no passcode or recovery file was given, so the sealed secret values were not opened";
    else { const entries = await readSecrets(path, manifest.secrets, secretsCipher).catch(() => { throw new RestoreRefused("the backup cannot be restored: the secret values were changed or cannot be read"); }); secrets = await restoreSecrets(entries, options.secrets!, { ...(options.overwriteSecrets === undefined ? {} : { overwrite: options.overwriteSecrets }) }); }
  }
  let blobs = 0, skippedDeleted = 0;
  // Artifacts on the deletion ledger stay deleted: their files are not put back (unless another artifact that is not deleted holds the same bytes).
  const goneBlobs = new Set<string>();
  const removedArtifacts = new Set((options.deletions ?? []).flatMap((e) => e.removed).filter((r) => r.kind === "artifact").map((r) => r.id));
  if (manifest.artifacts !== undefined && removedArtifacts.size > 0) {
    const agg = manifest.files.find((f) => f.table === "aggregates")!;
    const kept = new Set<string>();
    for await (const line of createInterface({ input: Readable.from(readPlain(join(path, agg.file), cipher, agg.file)), crlfDelay: Infinity })) {
      if (line === "") continue;
      const row = JSON.parse(line) as SnapshotRow;
      if (row["kind"] !== "artifact") continue;
      const digests = ((JSON.parse(String(row["body"])) as { entries?: { digest?: unknown }[] }).entries ?? []).map((e) => e.digest).filter((d): d is string => typeof d === "string");
      for (const d of digests) (removedArtifacts.has(String(row["id"])) ? goneBlobs : kept).add(d);
    }
    for (const d of kept) goneBlobs.delete(d);
  }
  if (manifest.artifacts !== undefined && options.blobs !== undefined) {
    // The artifacts go in first: they are content-addressed, harmless without the rows, and the state row that makes the store look used must still be the last thing written.
    for (const line of (await readAll(join(path, manifest.artifacts.index.file), cipher)).toString("utf8").split("\n")) {
      if (line === "") continue;
      const e = JSON.parse(line) as BlobIndexLine;
      const stored = blobFile(e, cipher !== undefined)!; // verified above
      if (goneBlobs.has(e.digest)) { skippedDeleted += 1; continue; }
      const put = await options.blobs.put(Readable.from(readPlain(join(path, ARTIFACT_FOLDER, stored), cipher, `${ARTIFACT_FOLDER}/${stored}`)));
      if (put.digest !== e.digest) throw new RestoreRefused(`artifact ${e.digest.slice(0, 12)} did not come back as the same bytes`);
      blobs += 1;
    }
  }
  let piStores = 0, piFiles = 0;
  if (manifest.piState !== undefined && options.piTarget !== undefined) {
    const parsed = parsePiIndex((await readAll(join(path, manifest.piState.index.file), cipher)).toString("utf8"), cipher !== undefined);
    if (parsed.problems.length > 0) throw new RestoreRefused(`the backup cannot be restored: ${parsed.problems.join("; ")}`);
    try { const done = await writePiState(path, parsed.lines, cipher, options.piTarget); piStores = done.stores; piFiles = done.files; } catch (error) { throw new RestoreRefused(`the conversation stores could not be restored: ${error instanceof Error ? error.message : "failed"}`); }
  }
  const pageSize = options.pageSize ?? 500;
  let total = 0;
  let marked = 0;
  let resend = 0;
  const ledger = ledgerFilter(options.deletions ?? []);
  for (const table of SNAPSHOT_TABLES) {
    const entry = manifest.files.find((f) => f.table === table)!;
    let batch: SnapshotRow[] = [];
    const flush = async (): Promise<void> => { if (batch.length > 0) { await storage.restoreRows(table, batch); total += batch.length; batch = []; } };
    for await (const line of createInterface({ input: Readable.from(readPlain(join(path, entry.file), cipher, entry.file)), crlfDelay: Infinity })) {
      if (line === "") continue;
      let row = JSON.parse(line) as SnapshotRow;
      if (table === "effects" && row["status"] === "intended") { row = { ...row, status: "uncertain", evidence: RESTORED_EVIDENCE }; marked += 1; }
      if (table === "deliveries" && row["state"] !== "delivered") resend += 1;
      if (table === "aggregates") { const kept = ledger.apply(row); if (kept === undefined) continue; row = kept; }
      batch.push(row);
      if (batch.length >= pageSize) await flush();
    }
    await flush();
  }
  return { manifest, rows: total, effectsMarkedUncertain: marked, deliveriesToResend: resend, blobsRestored: blobs, deletionsReapplied: ledger.touched(), blobsSkippedDeleted: skippedDeleted, piStoresRestored: piStores, piFilesRestored: piFiles, ...(secrets === undefined ? {} : { secrets }), ...(secretsLeftOut === undefined ? {} : { secretsLeftOut }), ...(check.notes === undefined ? {} : { notes: check.notes }), ...(check.signature === undefined ? {} : { signature: check.signature }) };
}
