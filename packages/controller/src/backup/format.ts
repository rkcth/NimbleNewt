import type { SnapshotTable } from "../storage/index.js";
import type { BackupSeal } from "./crypto.js";

/**
 * A backup is a folder (card K01): one JSON-lines file per table of the store, and `manifest.json`, written last, which names each file with its row count, size and SHA-256. A folder with a
 * manifest is complete; a backup that was interrupted is a `.partial` folder with no manifest and is never listed, restored from or counted. Nothing in it is a live database file.
 */
export const BACKUP_FORMAT = 1;
export const MANIFEST_FILE = "manifest.json";
export const PARTIAL_SUFFIX = ".partial";
export type BackupKind = "manual" | "scheduled" | "pre-upgrade";
export const BACKUP_KINDS: readonly BackupKind[] = ["manual", "scheduled", "pre-upgrade"];

export interface BackupFileEntry { readonly table: SnapshotTable; readonly file: string; readonly rows: number; readonly bytes: number; readonly sha256: string }

/** The artifact bytes in a backup (card K01): `artifacts.jsonl` lists each blob's digest and size, and the blob is the file `artifacts/<digest>`, whose name is the SHA-256 of its content. */
export interface BackupArtifacts { readonly index: BackupIndexEntry; readonly blobs: number; readonly bytes: number; /** Blobs the store listed that were corrupt or vanished while the copy was made, and so are not in it. */ readonly skipped: readonly { readonly digest: string; readonly why: "corrupt" | "missing" }[] }
/** An artifact index line: a sealed backup keeps each blob under a number (`file`), so the digest, which names the content, is only inside the sealed index. */
export interface BlobIndexLine { readonly digest: string; readonly size: number; readonly file?: string }
export interface BackupIndexEntry { readonly file: string; readonly rows: number; readonly bytes: number; readonly sha256: string }
export const ARTIFACT_INDEX = "artifacts.jsonl";
export const ARTIFACT_FOLDER = "artifacts";
export const SEALED_SUFFIX = ".enc";
/** The file a table is kept in: sealed backups add `.enc`. */
export const tableFile = (table: string, sealed: boolean): string => `${table}.jsonl${sealed ? SEALED_SUFFIX : ""}`;

export interface BackupManifest {
  readonly format: typeof BACKUP_FORMAT;
  readonly product: "nimblenewt";
  readonly name: string;
  readonly createdAt: string;
  readonly kind: BackupKind;
  /** The version of NimbleNewt that made it. */
  readonly version: string;
  /** The schema version of the rows: a copy restores only into a store of the same version. */
  readonly schemaVersion: number;
  /** The epoch the store had when the copy was taken (a restored store continues from it). */
  readonly epoch: number;
  readonly files: readonly BackupFileEntry[];
  /** Present when the installation has an artifact store: its blobs are in the backup. */
  readonly artifacts?: BackupArtifacts;
  /** Present when the backup is encrypted (card K01b): the key it was made for, the public ephemeral half and the wrapped copies of the private key. Every table file and blob is sealed; digests below are keyed, not plain SHA-256. */
  readonly encryption?: BackupSeal;
  /** What the owner should know about what is and is not in the copy. */
  readonly notes: readonly string[];
  readonly complete: true;
}

export const BACKUP_NOTES: readonly string[] = [
  "This is a consistent copy of the controller database as of createdAt; nothing written after that is in it.",
  "Secret values kept outside the database (the secret store) are not in this backup.",
  "Effects that were intended but not confirmed at that moment are restored as uncertain: they are reconciled with the outside world, never run again.",
];
