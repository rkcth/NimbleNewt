import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { join } from "node:path";
import { SNAPSHOT_TABLES, TABLE_SPECS, type ControllerStorage, type SnapshotRow, type SnapshotTable } from "../storage/index.js";
import type { FileBlobStore } from "../artifacts/index.js";
import { beginSeal, hasherFor, openSink, type BackupCipher, type BackupSeal, type Keyring } from "./crypto.js";
import { ARTIFACT_FOLDER, ARTIFACT_INDEX, BACKUP_FORMAT, BACKUP_NOTES, MANIFEST_FILE, PARTIAL_SUFFIX, SEALED_SUFFIX, tableFile, type BackupArtifacts, type BackupFileEntry, type BackupKind, type BackupManifest } from "./format.js";

export interface BackupOptions {
  /** The folder the backups live in; each backup is a folder of its own inside it. */
  readonly root: string;
  readonly kind: BackupKind;
  /** The version of NimbleNewt (written in the manifest). */
  readonly version: string;
  readonly now?: () => Date;
  /** Rows read from the store at a time. Default 500. */
  readonly pageSize?: number;
  /** The artifact store, when the installation has one: its blobs go into the backup too. */
  readonly blobs?: FileBlobStore;
  /** Encrypt the backup for this key (the public keyring only: no secret is needed, so a scheduled backup runs unattended). */
  readonly encryption?: Keyring;
}

const stamp = (d: Date): string => d.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");

/** The name of the folder a backup made at `at` has. Two made in the same second differ by their kind, and a repeat is refused rather than overwritten. */
export const backupName = (at: Date, kind: BackupKind): string => `backup-${stamp(at)}-${kind}`;

/**
 * Takes a consistent snapshot of the store and writes it as a backup folder. It is written under a `.partial` name, every file is flushed, the manifest is written last, and only then is the
 * folder renamed to its final name: a crash, a full disk or a failed read leaves a `.partial` folder (which is removed here and never mistaken for a backup), never a half-written backup that looks complete.
 */
export function createBackup(storage: Pick<ControllerStorage, "snapshot">, options: BackupOptions): Promise<{ path: string; manifest: BackupManifest }> {
  // The artifact store's shared lock is held from before the database is read until the blobs are copied, so orphan cleanup (which takes it exclusively) cannot delete a blob the copied rows still name.
  return options.blobs === undefined ? write(storage, options) : options.blobs.lock.shared(() => write(storage, options));
}

async function write(storage: Pick<ControllerStorage, "snapshot">, options: BackupOptions): Promise<{ path: string; manifest: BackupManifest }> {
  const at = (options.now ?? (() => new Date()))();
  const name = backupName(at, options.kind);
  const final = join(options.root, name);
  const staging = `${final}${PARTIAL_SUFFIX}`;
  const pageSize = options.pageSize ?? 500;
  const sealing = options.encryption === undefined ? undefined : beginSeal(options.encryption);
  const cipher = sealing?.cipher;
  const snapshot = await storage.snapshot();
  try {
    await mkdir(options.root, { recursive: true, mode: 0o700 });
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { mode: 0o700 });
    const files: BackupFileEntry[] = [];
    let epoch = 0;
    for (const table of SNAPSHOT_TABLES) {
      const file = tableFile(table, cipher !== undefined);
      const handle = await openSink(join(staging, file), cipher, file);
      const hash = hasherFor(cipher);
      let rows = 0;
      let bytes = 0;
      try {
        for (let after: SnapshotRow | undefined; ;) {
          const page = await snapshot.read(table, { ...(after === undefined ? {} : { after }), limit: pageSize });
          if (page.length === 0) break;
          const text = page.map((row) => `${JSON.stringify(Object.fromEntries(TABLE_SPECS[table].columns.map((c) => [c, row[c] ?? null])))}\n`).join("");
          const buffer = Buffer.from(text, "utf8");
          await handle.write(buffer);
          hash.update(buffer);
          rows += page.length;
          bytes += buffer.length;
          if (table === "state") epoch = Number(page[0]!["epoch"]);
          if (table === "state" || page.length < pageSize) break;
          after = page[page.length - 1];
        }
        await handle.finish();
      } catch (error) { await handle.abort().catch(() => undefined); throw error; }
      files.push({ table, file, rows, bytes, sha256: hash.digest("hex") });
    }
    const artifacts = options.blobs === undefined ? undefined : await copyBlobs(options.blobs, staging, cipher);
    const manifest: BackupManifest = { format: BACKUP_FORMAT, product: "nimblenewt", name, createdAt: at.toISOString(), kind: options.kind, version: options.version, schemaVersion: snapshot.schemaVersion, epoch, files, ...(artifacts === undefined ? {} : { artifacts }), ...(sealing === undefined ? {} : { encryption: sealing.seal }), notes: BACKUP_NOTES, complete: true };
    const manifestHandle = await open(join(staging, MANIFEST_FILE), "wx", 0o600);
    try { await manifestHandle.write(`${JSON.stringify(manifest, null, 2)}\n`); await manifestHandle.sync(); } finally { await manifestHandle.close(); }
    await rename(staging, final);
    const dir = await open(options.root, "r").catch(() => undefined);
    if (dir !== undefined) { await dir.sync().catch(() => undefined); await dir.close(); }
    return { path: final, manifest };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  } finally { await snapshot.close(); }
}

/**
 * Copies every blob of the artifact store into `staging/artifacts/<digest>` (the caller holds the store's shared lock: orphan cleanup, which takes it exclusively, waits), hashing each as it is copied: a blob whose bytes are not
 * its name is not copied and is listed as corrupt, and one that vanished is listed as missing. The index of what was copied is written last.
 */
class CopyWriteError extends Error { constructor(override readonly cause: unknown) { super("write failed"); } }

async function copyBlobs(blobs: FileBlobStore, staging: string, cipher: BackupCipher | undefined): Promise<BackupArtifacts> {
  const folder = join(staging, ARTIFACT_FOLDER);
  await mkdir(folder, { mode: 0o700 });
  return (async () => {
    const lines: string[] = [];
    const skipped: { digest: string; why: "corrupt" | "missing" }[] = [];
    let bytes = 0;
    for (const info of await blobs.list()) {
      // A sealed backup names a blob by its number, not its digest (the digest names the content); the digest is only in the sealed index.
      const stored = cipher === undefined ? info.digest : `blob-${lines.length + skipped.length}${SEALED_SUFFIX}`;
      const target = await openSink(join(folder, stored), cipher, `${ARTIFACT_FOLDER}/${stored}`);
      const hash = createHash("sha256");
      let size = 0;
      let why: "corrupt" | "missing" | undefined;
      try {
        try {
          // Only a failure to read the blob means it is missing; a failure to write the copy (a full disk) fails the whole backup.
          for await (const chunk of createReadStream(blobs.pathOf(info.digest))) { const buffer = chunk as Buffer; hash.update(buffer); await target.write(buffer).catch((error) => { throw new CopyWriteError(error); }); size += buffer.length; }
        } catch (error) { if (error instanceof CopyWriteError) throw error.cause; why = "missing"; }
        if (why === undefined && hash.digest("hex") !== info.digest) why = "corrupt";
        if (why === undefined) await target.finish(); else await target.abort();
      } catch (error) { await target.abort().catch(() => undefined); throw error; }
      if (why !== undefined) { await rm(join(folder, stored), { force: true }); skipped.push({ digest: info.digest, why }); continue; }
      lines.push(`${JSON.stringify(cipher === undefined ? { digest: info.digest, size } : { digest: info.digest, size, file: stored })}\n`);
      bytes += size;
    }
    const text = Buffer.from(lines.join(""), "utf8");
    const indexFile = cipher === undefined ? ARTIFACT_INDEX : `${ARTIFACT_INDEX}${SEALED_SUFFIX}`;
    const index = await openSink(join(staging, indexFile), cipher, indexFile);
    try { await index.write(text); await index.finish(); } catch (error) { await index.abort().catch(() => undefined); throw error; }
    return { index: { file: indexFile, rows: lines.length, bytes: text.length, sha256: hasherFor(cipher).update(text).digest("hex") }, blobs: lines.length, bytes, skipped };
  })();
}

export type { SnapshotTable };
