import { createHash, randomBytes } from "node:crypto";
import { closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "../storage/index.js";
import type { RecoverySource, Watermark } from "./source.js";

/**
 * The artifact and workflow recovery manifest (card K04). A copy of the database (a PostgreSQL standby, or a restored SQLite backup) does not carry the artifact files, and a
 * copy that lags does not carry the newest workflow state. The manifest says what a safe recovery must find: the watermark (epoch and sequence counters), every controller record
 * with its revision, and every artifact blob the records name (digest and size). It is a folder: `aggregates.jsonl`, `blobs.jsonl`, and `manifest.json`, written last, which names the
 * other two with their SHA-256. A folder without a good `manifest.json` is not a manifest. It is separate from the backup folder format and leaves it as it is.
 */
export const RECOVERY_FORMAT = 1;
export const RECOVERY_MANIFEST_FILE = "manifest.json";
export const RECOVERY_AGGREGATES_FILE = "aggregates.jsonl";
export const RECOVERY_BLOBS_FILE = "blobs.jsonl";

export interface RecoveryFileEntry { readonly file: string; readonly rows: number; readonly bytes: number; readonly sha256: string }
export interface BlobRef { readonly digest: string; readonly size: number }

export interface RecoveryManifest {
  readonly format: typeof RECOVERY_FORMAT;
  readonly product: "nimblenewt";
  readonly createdAt: string;
  readonly watermark: Watermark;
  readonly aggregates: RecoveryFileEntry;
  readonly blobs: RecoveryFileEntry;
  readonly notes: readonly string[];
  /** SHA-256 of this manifest's own canonical text without this field. */
  readonly sha256: string;
}

export class RecoveryManifestBad extends Error {
  constructor(message: string) { super(message); this.name = "RecoveryManifestBad"; }
}

const sha256 = (data: string | Buffer): string => createHash("sha256").update(data).digest("hex");
const DIGEST = /^[0-9a-f]{64}$/;
const TOMBSTONE = "tombstone";

/** The blobs an artifact record names (its `entries`), or none when the body is not a readable artifact. */
function blobsOf(body: string | undefined): BlobRef[] {
  if (body === undefined) return [];
  try {
    const entries = (JSON.parse(body) as { entries?: unknown }).entries;
    if (!Array.isArray(entries)) return [];
    return entries.flatMap((e: { digest?: unknown; size?: unknown }) => (typeof e?.digest === "string" && DIGEST.test(e.digest) && Number.isSafeInteger(e.size) ? [{ digest: e.digest, size: e.size as number }] : []));
  } catch { return []; }
}

/**
 * Writes the manifest for what `source` holds now, into `directory` (created). The new files are written and flushed in a staging folder first, so a source that fails leaves the earlier
 * manifest as it was. The swap removes the old `manifest.json` first and puts the new one in last: a crash during the swap leaves no manifest (refused), never a mix. Records of kind `artifact` name
 * the blobs; the reserved `tombstone` records are left out (a removed record is not state a recovery must find).
 */
export async function writeRecoveryManifest(source: RecoverySource, directory: string, options: { readonly now?: () => Date; /** Called with the new manifest once its files are flushed in the staging folder and before anything in `directory` is touched; throwing leaves the earlier manifest as it was. */ readonly beforeSwap?: (manifest: RecoveryManifest) => Promise<void>; /** Called once the new files are in place, before the staging folder is removed, with the folder holding the files they displaced (absent ones are not there): the fenced writer puts a newer manifest that landed in between back from it. */ readonly afterSwap?: (manifest: RecoveryManifest, displaced: string) => Promise<void>; /** Called (synchronously) when another writer put a manifest.json in the folder after this one moved the old one aside: return to replace it, throw to keep it (the aggregates and blobs files it names are put back when this writer had displaced them). Absent: kept, and the write fails. */ readonly slotTaken?: (manifest: RecoveryManifest) => void } = {}): Promise<RecoveryManifest> {
  mkdirSync(directory, { recursive: true });
  // Second review: a random part as well as the process id, so two writers in one process never share (and remove) one staging folder with the files the other displaced.
  const staging = `${resolve(directory)}.partial-${process.pid}-${randomBytes(6).toString("hex")}`;
  mkdirSync(staging);
  try {
    const watermark = await source.watermark();
    const lines: string[] = [];
    const blobs = new Map<string, number>();
    for await (const r of source.aggregates()) {
      if (r.kind === TOMBSTONE) continue;
      lines.push(JSON.stringify({ kind: r.kind, id: r.id, revision: r.revision }));
      if (r.kind === "artifact") for (const b of blobsOf(r.body)) blobs.set(b.digest, b.size);
    }
    const aggregateText = lines.length === 0 ? "" : `${lines.join("\n")}\n`;
    const blobLines = [...blobs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([digest, size]) => JSON.stringify({ digest, size }));
    const blobText = blobLines.length === 0 ? "" : `${blobLines.join("\n")}\n`;
    writeFlushed(join(staging, RECOVERY_AGGREGATES_FILE), aggregateText);
    writeFlushed(join(staging, RECOVERY_BLOBS_FILE), blobText);
    const body = {
      format: RECOVERY_FORMAT as typeof RECOVERY_FORMAT, product: "nimblenewt" as const, createdAt: (options.now?.() ?? new Date()).toISOString(), watermark,
      aggregates: { file: RECOVERY_AGGREGATES_FILE, rows: lines.length, bytes: Buffer.byteLength(aggregateText), sha256: sha256(aggregateText) },
      blobs: { file: RECOVERY_BLOBS_FILE, rows: blobLines.length, bytes: Buffer.byteLength(blobText), sha256: sha256(blobText) },
      notes: ["Blob files are not in PostgreSQL: a standby host must also have every blob listed here, copied by the owner's own means (a backup, a file copy).", "A record or blob removed after this manifest was written shows as missing: write a new manifest after retention or orphan clean-up."],
    };
    const manifest: RecoveryManifest = { ...body, sha256: sha256(canonicalJson(body)) };
    // the manifest file is written last: a folder without it is not a manifest
    writeFlushed(join(staging, RECOVERY_MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`);
    await options.beforeSwap?.(manifest);
    // The files in place are moved aside (not deleted) so the caller can still put them back; the old manifest.json goes first and the new one comes last, as before.
    const displaced = join(staging, "displaced");
    mkdirSync(displaced);
    for (const file of [RECOVERY_MANIFEST_FILE, RECOVERY_AGGREGATES_FILE, RECOVERY_BLOBS_FILE]) {
      try { renameSync(join(directory, file), join(displaced, file)); } catch (error) { if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") throw error; }
    }
    for (const file of [RECOVERY_AGGREGATES_FILE, RECOVERY_BLOBS_FILE]) renameSync(join(staging, file), join(directory, file));
    // Second review: manifest.json goes in only where none is (a hard link fails when the name is taken), so a manifest another writer put in place after the move-aside is never replaced
    // unseen. A file system without hard links falls back to the rename.
    let taken = false;
    try { linkSync(join(staging, RECOVERY_MANIFEST_FILE), join(directory, RECOVERY_MANIFEST_FILE)); } catch (error) {
      // Late-change re-check: any other error (a file system without hard links answers EPERM, ENOTSUP, or on Windows FAT another code) falls back to the rename, but only after a look at
      // the name: one that is taken now goes to the same decision as EEXIST instead of being renamed over (a write between this look and the rename is the documented residual).
      if ((error as NodeJS.ErrnoException)?.code === "EEXIST" || nameTaken(join(directory, RECOVERY_MANIFEST_FILE))) taken = true;
      else renameSync(join(staging, RECOVERY_MANIFEST_FILE), join(directory, RECOVERY_MANIFEST_FILE));
    }
    if (taken) {
      try {
        if (options.slotTaken === undefined) throw new RecoveryManifestBad("another writer put a manifest.json in the folder while this one was put in place; it was left as it is");
        options.slotTaken(manifest);
      } catch (error) {
        // Late-change re-check: a put-back that fails (a file another writer holds open, a manifest.json of JSON null) never hides why the write stopped.
        try { restoreDisplacedOf(directory, displaced, manifest); } catch { /* left as it is: a mix never matches the checksums, so a promotion refuses it */ }
        throw error;
      }
      renameSync(join(staging, RECOVERY_MANIFEST_FILE), join(directory, RECOVERY_MANIFEST_FILE));
    }
    await options.afterSwap?.(manifest, displaced);
    return manifest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

/**
 * The manifest.json now in `directory` is another writer's and is kept: its aggregates and blobs files, when this writer had moved them aside, go back in place of this writer's (only when the file
 * there is still this writer's). Anything that cannot be read is left: a mix of files never matches the checksums, so a promotion refuses it.
 */
function restoreDisplacedOf(directory: string, displaced: string, ours: RecoveryManifest): void {
  let theirs: Record<string, unknown>;
  try { theirs = JSON.parse(readFileSync(join(directory, RECOVERY_MANIFEST_FILE), "utf8")) as Record<string, unknown>; } catch { return; }
  if (typeof theirs !== "object" || theirs === null) return;
  const shaOf = (path: string): string | undefined => { try { return sha256(readFileSync(path)); } catch { return undefined; } };
  for (const [name, key, mine] of [[RECOVERY_AGGREGATES_FILE, "aggregates", ours.aggregates.sha256], [RECOVERY_BLOBS_FILE, "blobs", ours.blobs.sha256]] as const) {
    const want = (theirs[key] as { sha256?: unknown } | undefined)?.sha256;
    if (typeof want !== "string" || shaOf(join(displaced, name)) !== want) continue;
    const now = shaOf(join(directory, name));
    if (now === undefined || now === mine) renameSync(join(displaced, name), join(directory, name));
  }
}

/** Whether `path` names anything now (a link or folder counts as taken). */
function nameTaken(path: string): boolean {
  try { lstatSync(path); return true; } catch (error) { return (error as NodeJS.ErrnoException)?.code !== "ENOENT"; }
}

function writeFlushed(path: string, text: string): void {
  const fd = openSync(path, "w", 0o600);
  try { writeSync(fd, text); fsyncSync(fd); } finally { closeSync(fd); }
}

/** A manifest read back and checked: its own hash, and both files' size and hash. A manifest that does not check is refused; nothing is guessed from it. */
export interface ReadManifest {
  readonly manifest: RecoveryManifest;
  aggregateRefs(): { readonly kind: string; readonly id: string; readonly revision: number }[];
  blobRefs(): BlobRef[];
}

const count = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
/** `manifest.json` is a few hundred bytes; anything far larger is not one this code wrote, and is not read whole. */
export const RECOVERY_MANIFEST_MAX_BYTES = 64 * 1024;

/** The text of `manifest.json`, or `undefined` when there is none. A file over the size bound is refused unread. */
export function readManifestText(directory: string): string | undefined {
  const path = join(directory, RECOVERY_MANIFEST_FILE);
  let size: number;
  try { size = statSync(path).size; } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new RecoveryManifestBad(`the recovery manifest cannot be read (${error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? "unknown") : "unknown"})`);
  }
  if (size > RECOVERY_MANIFEST_MAX_BYTES) throw new RecoveryManifestBad(`the recovery manifest is ${size} bytes, larger than any this version writes`);
  try { return readFileSync(path, "utf8"); } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return undefined;
    throw new RecoveryManifestBad(`the recovery manifest cannot be read (${(error as NodeJS.ErrnoException)?.code ?? "unknown"})`);
  }
}

/**
 * `manifest.json` alone, checked: format, product, its own checksum and the shape of every field a check relies on. The files it names are NOT read (that is `readRecoveryManifest`), so this is cheap
 * enough for a status answer. `undefined` when there is no manifest.
 */
export function readRecoveryManifestHeader(directory: string): RecoveryManifest | undefined {
  const text = readManifestText(directory);
  return text === undefined ? undefined : checkHeader(text);
}

function checkHeader(text: string): RecoveryManifest {
  let manifest: RecoveryManifest;
  try { manifest = JSON.parse(text) as RecoveryManifest; } catch { throw new RecoveryManifestBad("the recovery manifest is not readable JSON"); }
  if (typeof manifest !== "object" || manifest === null || manifest.format !== RECOVERY_FORMAT || manifest.product !== "nimblenewt") throw new RecoveryManifestBad("not a recovery manifest of a format this version reads");
  const { sha256: claimed, ...rest } = manifest;
  if (claimed !== sha256(canonicalJson(rest))) throw new RecoveryManifestBad("the recovery manifest's own checksum does not match: it was changed after it was written");
  // The checksum says the text is as written, not that it was written by this code: every field a check relies on is read only when it has the right shape, so a missing counter can never
  // make the comparison skip it.
  const w = manifest.watermark as unknown as Record<string, unknown> | undefined;
  if (typeof w !== "object" || w === null || !count(w["epoch"]) || !count(w["auditSeq"]) || !count(w["deliverySeq"])) throw new RecoveryManifestBad("the recovery manifest has no readable watermark (epoch and counters)");
  if (typeof manifest.createdAt !== "string" || !Number.isFinite(Date.parse(manifest.createdAt))) throw new RecoveryManifestBad("the recovery manifest has no readable time it was written");
  for (const [entry, name] of [[manifest.aggregates, RECOVERY_AGGREGATES_FILE], [manifest.blobs, RECOVERY_BLOBS_FILE]] as const) {
    const e = entry as unknown as Record<string, unknown> | undefined;
    if (typeof e !== "object" || e === null || e["file"] !== name || !count(e["rows"]) || !count(e["bytes"]) || typeof e["sha256"] !== "string") throw new RecoveryManifestBad(`the recovery manifest's entry for ${name} is not readable`);
  }
  return manifest;
}

export function readRecoveryManifest(directory: string): ReadManifest {
  let text: string | undefined;
  try { text = readManifestText(directory); } catch (error) {
    throw new RecoveryManifestBad(`the recovery manifest in ${directory} cannot be read (${error instanceof Error ? error.message.slice(0, 120) : "unknown"})`);
  }
  if (text === undefined) throw new RecoveryManifestBad(`the recovery manifest in ${directory} cannot be read (there is no ${RECOVERY_MANIFEST_FILE})`);
  const manifest = checkHeader(text);
  const read = (entry: RecoveryFileEntry): string => {
    let text: string;
    try { text = readFileSync(join(directory, entry.file), "utf8"); } catch { throw new RecoveryManifestBad(`${entry.file} is missing`); }
    if (Buffer.byteLength(text) !== entry.bytes || sha256(text) !== entry.sha256) throw new RecoveryManifestBad(`${entry.file} does not match the manifest's size and checksum`);
    return text;
  };
  const parse = <T>(entry: RecoveryFileEntry, text: string, ok: (row: Record<string, unknown>) => boolean): T[] => {
    const rows = text.split("\n").filter((l) => l !== "").map((l, i) => {
      let row: unknown;
      try { row = JSON.parse(l); } catch { throw new RecoveryManifestBad(`${entry.file} line ${i + 1} is not readable`); }
      if (typeof row !== "object" || row === null || !ok(row as Record<string, unknown>)) throw new RecoveryManifestBad(`${entry.file} line ${i + 1} is not a readable entry`);
      return row as T;
    });
    if (rows.length !== entry.rows) throw new RecoveryManifestBad(`${entry.file} has ${rows.length} entries, the manifest says ${entry.rows}`);
    return rows;
  };
  const aggregates = parse<{ kind: string; id: string; revision: number }>(manifest.aggregates, read(manifest.aggregates), (r) => typeof r["kind"] === "string" && typeof r["id"] === "string" && count(r["revision"]));
  const blobs = parse<BlobRef>(manifest.blobs, read(manifest.blobs), (r) => typeof r["digest"] === "string" && DIGEST.test(r["digest"]) && count(r["size"]));
  return {
    manifest,
    aggregateRefs: () => [...aggregates],
    blobRefs: () => [...blobs],
  };
}
