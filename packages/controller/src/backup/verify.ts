import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { SNAPSHOT_TABLES } from "../storage/index.js";
import { BACKUP_FORMAT, MANIFEST_FILE, type BackupManifest } from "./format.js";

export interface BackupCheck { readonly ok: boolean; readonly manifest?: BackupManifest; readonly problems: readonly string[] }

/** Reads and checks a backup's manifest (not the files): the format, the product, the complete mark and a file for every table. */
export async function readManifest(path: string): Promise<{ manifest?: BackupManifest; problems: string[] }> {
  let raw: string;
  try { raw = await readFile(join(path, MANIFEST_FILE), "utf8"); } catch { return { problems: ["there is no manifest: the backup was never finished"] }; }
  let manifest: BackupManifest;
  try { manifest = JSON.parse(raw) as BackupManifest; } catch { return { problems: ["the manifest is not readable"] }; }
  const problems: string[] = [];
  if (manifest === null || typeof manifest !== "object" || manifest.product !== "nimblenewt") problems.push("the manifest is not a NimbleNewt backup's");
  else {
    if (manifest.format !== BACKUP_FORMAT) problems.push(`the backup is in format ${String(manifest.format)}, and this version reads format ${BACKUP_FORMAT}`);
    if (manifest.complete !== true) problems.push("the manifest does not say the backup is complete");
    if (!Array.isArray(manifest.files)) problems.push("the manifest lists no files");
    else for (const table of SNAPSHOT_TABLES) if (!manifest.files.some((f) => f.table === table)) problems.push(`the manifest has no file for ${table}`);
  }
  return problems.length > 0 ? { problems } : { manifest, problems };
}

/** Checks every file of a backup against its manifest: it is there, the size and the SHA-256 are as written, and the rows can be counted. A backup that fails any check is not restored from. */
export async function verifyBackup(path: string): Promise<BackupCheck> {
  const read = await readManifest(path);
  if (read.manifest === undefined) return { ok: false, problems: read.problems };
  const manifest = read.manifest;
  const problems: string[] = [];
  for (const entry of manifest.files) {
    if (entry.file !== `${entry.table}.jsonl`) { problems.push(`${entry.table}: the file name ${JSON.stringify(entry.file)} is not the table's`); continue; }
    const hash = createHash("sha256");
    let bytes = 0;
    let lines = 0;
    try {
      for await (const chunk of createReadStream(join(path, entry.file))) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        bytes += buffer.length;
        for (const byte of buffer) if (byte === 10) lines += 1;
      }
    } catch { problems.push(`${entry.table}: the file is missing or unreadable`); continue; }
    if (bytes !== entry.bytes) problems.push(`${entry.table}: ${bytes} bytes, the manifest says ${entry.bytes}`);
    else if (hash.digest("hex") !== entry.sha256) problems.push(`${entry.table}: the contents do not match the manifest's SHA-256`);
    else if (lines !== entry.rows) problems.push(`${entry.table}: ${lines} rows, the manifest says ${entry.rows}`);
  }
  return { ok: problems.length === 0, manifest, problems };
}
