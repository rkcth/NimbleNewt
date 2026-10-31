import { createHash, timingSafeEqual } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { SNAPSHOT_TABLES, canonicalJson } from "../storage/index.js";
import { MAX_JSON_BYTES, UnlockFailed, hasherFor, parseKeyring, readPlain, type BackupCipher, type BackupKey } from "./crypto.js";
import { ARTIFACT_FOLDER, BACKUP_FORMAT, MANIFEST_FILE, tableFile, type BackupManifest, type BlobIndexLine } from "./format.js";

export interface BackupCheck { readonly ok: boolean; readonly manifest?: BackupManifest; readonly problems: readonly string[] }

/** Reads and checks a backup's manifest (not the files): the format, the product, the complete mark and a file for every table. */
export async function readManifest(path: string): Promise<{ manifest?: BackupManifest; problems: string[] }> {
  let raw: string;
  try {
    // A manifest is a few kilobytes plus a keyring; one far larger is not read (the folder can be changed by anyone who can write to it).
    if ((await stat(join(path, MANIFEST_FILE))).size > MAX_JSON_BYTES * 4) return { problems: ["the manifest is too large to be a backup's"] };
    raw = await readFile(join(path, MANIFEST_FILE), "utf8");
  } catch { return { problems: ["there is no manifest: the backup was never finished"] }; }
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
  if (problems.length === 0 && manifest.encryption !== undefined) {
    try { parseKeyring(manifest.encryption.keyring); if (manifest.encryption.scope !== "everything" || manifest.encryption.keyId !== manifest.encryption.keyring.keyId) problems.push("the backup's encryption record is not valid"); } catch { problems.push("the backup's encryption record is not valid"); }
  }
  return problems.length > 0 ? { problems } : { manifest, problems };
}

/** The cipher a backup needs: none for a plain backup, the unlocked key's for a sealed one. Refuses a sealed backup when no key was given, and a key that is not the backup's. */
export function cipherOf(manifest: BackupManifest, unlock: BackupKey | undefined): BackupCipher | undefined {
  if (manifest.encryption === undefined) return undefined;
  if (unlock === undefined) throw new UnlockFailed("the backup is encrypted: give the passcode or the recovery file");
  return unlock.cipherFor(manifest.encryption);
}

/** Checks every file of a backup against its manifest: it is there, the size and the SHA-256 are as written, and the rows can be counted. A backup that fails any check is not restored from. */
export async function verifyBackup(path: string, options: { unlock?: BackupKey; /** Refuse a backup that is not encrypted (so a plain copy swapped in for an encrypted one is not accepted). */ requireEncrypted?: boolean } = {}): Promise<BackupCheck> {
  const read = await readManifest(path);
  if (read.manifest === undefined) return { ok: false, problems: read.problems };
  const manifest = read.manifest;
  const problems: string[] = [];
  if (options.requireEncrypted === true && manifest.encryption === undefined) return { ok: false, manifest, problems: ["the backup is not encrypted, and encryption is required"] };
  let cipher: BackupCipher | undefined;
  try { cipher = cipherOf(manifest, options.unlock); } catch (error) { return { ok: false, manifest, problems: [error instanceof Error ? error.message : "the backup cannot be unlocked"] }; }
  const sealed = cipher !== undefined;
  // The manifest's own MAC comes first: everything below (names, counts, digests, notes) is read from a manifest that anyone with the folder could have changed.
  if (cipher !== undefined) {
    const { mac, ...rest } = manifest;
    const expected = Buffer.from(cipher.manifestMac(canonicalJson(rest as never)), "hex");
    const given = typeof mac === "string" && /^[0-9a-f]{64}$/.test(mac) ? Buffer.from(mac, "hex") : undefined;
    if (given === undefined || given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, manifest, problems: ["the manifest was changed or is not the one this backup was made with"] };
  }
  for (const entry of manifest.files) {
    if (entry.file !== tableFile(entry.table, sealed)) { problems.push(`${entry.table}: the file name ${JSON.stringify(entry.file)} is not the table's`); continue; }
    const hash = hasherFor(cipher);
    let bytes = 0;
    let lines = 0;
    try {
      for await (const chunk of readPlain(join(path, entry.file), cipher, entry.file)) {
        const buffer = chunk as Buffer;
        hash.update(buffer);
        bytes += buffer.length;
        for (const byte of buffer) if (byte === 10) lines += 1;
      }
    } catch (error) { problems.push(sealed && error instanceof Error && error.name === "SealedFileBad" ? `${entry.table}: ${error.message}` : `${entry.table}: the file is missing or unreadable`); continue; }
    if (bytes !== entry.bytes) problems.push(`${entry.table}: ${bytes} bytes, the manifest says ${entry.bytes}`);
    else if (hash.digest("hex") !== entry.sha256) problems.push(`${entry.table}: the contents do not match the manifest's SHA-256`);
    else if (lines !== entry.rows) problems.push(`${entry.table}: ${lines} rows, the manifest says ${entry.rows}`);
  }
  if (manifest.artifacts !== undefined) problems.push(...await verifyArtifacts(path, manifest, cipher));
  return { ok: problems.length === 0, manifest, problems };
}

/** The artifact index matches the manifest, and every blob it lists is there with the size it says and the SHA-256 that is its name. */
async function verifyArtifacts(path: string, manifest: BackupManifest, cipher: BackupCipher | undefined): Promise<string[]> {
  const a = manifest.artifacts!;
  const problems: string[] = [];
  let text: Buffer;
  if (a.index.file !== (cipher === undefined ? "artifacts.jsonl" : "artifacts.jsonl.enc")) return ["artifacts: the index file name is not the expected one"];
  try { text = await readAll(join(path, a.index.file), cipher); } catch { return ["artifacts: the index is missing or was changed"]; }
  if (text.length !== a.index.bytes || hasherFor(cipher).update(text).digest("hex") !== a.index.sha256) return ["artifacts: the index does not match the manifest"];
  const entries = text.toString("utf8").split("\n").filter((l) => l !== "").map((l) => JSON.parse(l) as BlobIndexLine);
  if (entries.length !== a.index.rows) problems.push(`artifacts: ${entries.length} blobs listed, the manifest says ${a.index.rows}`);
  for (const e of entries) {
    if (!/^[0-9a-f]{64}$/.test(e.digest)) { problems.push("artifacts: the index names something that is not a blob"); continue; }
    const stored = blobFile(e, cipher !== undefined);
    if (stored === undefined) { problems.push("artifacts: the index names a file that is not a blob's"); continue; }
    const hash = createHash("sha256");
    let size = 0;
    try { for await (const chunk of readPlain(join(path, ARTIFACT_FOLDER, stored), cipher, `${ARTIFACT_FOLDER}/${stored}`)) { const b = chunk as Buffer; hash.update(b); size += b.length; } } catch { problems.push(`artifacts: blob ${e.digest.slice(0, 12)} is missing`); continue; }
    if (size !== e.size || hash.digest("hex") !== e.digest) problems.push(`artifacts: blob ${e.digest.slice(0, 12)} is not what its name says`);
  }
  return problems;
}

/** The stored file name of a blob: its digest in a plain backup, a `blob-<n>.enc` name in a sealed one (a name from the index is checked, never trusted as a path). */
export const blobFile = (e: BlobIndexLine, sealed: boolean): string | undefined => sealed ? (typeof e.file === "string" && /^blob-[0-9]{1,9}\.enc$/.test(e.file) ? e.file : undefined) : (typeof e.digest === "string" && /^[0-9a-f]{64}$/.test(e.digest) ? e.digest : undefined);

export async function readAll(file: string, cipher: BackupCipher | undefined): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const c of readPlain(file, cipher, cipher === undefined ? file : file.slice(file.lastIndexOf("/") + 1))) parts.push(c);
  return Buffer.concat(parts);
}
