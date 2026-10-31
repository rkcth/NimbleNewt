import { createReadStream } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { hasherFor, openSink, readPlain, type BackupCipher } from "./crypto.js";
import { PI_FOLDER, PI_INDEX, SEALED_SUFFIX, type BackupPiState, type PiIndexLine } from "./format.js";

/**
 * The agents' own conversation stores (Pi Durable's JSON-lines folders, one per attempt, kept in the agent's home on the host that ran it; card K01h). The controller does not know where they are: whoever composes it
 * lists them. `id` names a store inside the backup (an attempt ID); `dir` is where its files are on this machine. A store on another machine is not here (the remote host's own state is not copied yet).
 */
export interface PiStateStore { readonly id: string; readonly dir: string }
export interface PiStateSource { list(): Promise<readonly PiStateStore[]> }

export const PI_LIMITS = { files: 200_000, stores: 50_000, idLength: 128 } as const;
const ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const validStoreId = (id: unknown): id is string => typeof id === "string" && ID.test(id) && !id.includes("..");

/** A relative path inside a store, in the form the backup keeps (forward slashes whatever the platform), checked before any file is made from it. */
export function validRel(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel === "" || rel.length > 500 || rel.includes("\\") || rel.includes("\0") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split("/").every((s) => s !== "" && s !== "." && s !== ".." && !/[:*?"<>|]/.test(s));
}

async function* walk(dir: string, base = dir, state = { n: 0 }): AsyncGenerator<{ path: string; rel: string }> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    const path = join(dir, e.name);
    // Links and special files are not followed or copied: a store is plain files and folders.
    if (e.isDirectory()) { yield* walk(path, base, state); continue; }
    if (!e.isFile()) continue;
    if (++state.n > PI_LIMITS.files) throw new Error("a conversation store has too many files to back up");
    yield { path, rel: relative(base, path).split(sep).join("/") };
  }
}

/** The byte length of a JSON-lines file up to and including its last complete line: a worker that is writing right now may leave half a line at the end, and that half line is not part of the copy. */
async function completeLength(path: string): Promise<number> {
  const h = await open(path, "r");
  try {
    const size = (await h.stat()).size;
    const buf = Buffer.alloc(64 * 1024);
    for (let end = size; end > 0; end -= buf.length) {
      const start = Math.max(0, end - buf.length);
      const { bytesRead } = await h.read(buf, 0, end - start, start);
      const at = buf.subarray(0, bytesRead).lastIndexOf(10);
      if (at >= 0) return start + at + 1;
    }
    return 0;
  } finally { await h.close(); }
}

/**
 * Copies every file of every store into `staging/pi-state/f-<n>` (sealed when the backup is) and writes the index last. A JSON-lines file is copied up to its last complete line. Files that vanish while the copy runs
 * are left out (a store being deleted is not an error); a write failure fails the whole backup.
 */
export async function copyPiState(source: PiStateSource, staging: string, cipher: BackupCipher | undefined): Promise<BackupPiState> {
  const folder = join(staging, PI_FOLDER);
  await mkdir(folder, { mode: 0o700 });
  const stores = [...await source.list()];
  if (stores.length > PI_LIMITS.stores) throw new Error("too many conversation stores to back up");
  const lines: string[] = [];
  let bytes = 0, count = 0;
  const seen = new Set<string>();
  for (const store of stores) {
    if (!validStoreId(store.id) || seen.has(store.id)) throw new Error("a conversation store has an id that cannot be kept in a backup");
    seen.add(store.id);
    for await (const f of walk(store.dir)) {
      const stored = `f-${count}${cipher === undefined ? "" : SEALED_SUFFIX}`;
      let size: number;
      try { size = f.rel.endsWith(".jsonl") ? await completeLength(f.path) : (await lstat(f.path)).size; } catch { continue; }
      const sink = await openSink(join(folder, stored), cipher, `${PI_FOLDER}/${stored}`);
      const hash = hasherFor(cipher);
      let copied = 0;
      let vanished = false;
      try {
        if (size > 0) {
          try {
            for await (const chunk of createReadStream(f.path, { start: 0, end: size - 1 })) {
              const b = chunk as Buffer;
              hash.update(b);
              await sink.write(b).catch((error) => { throw Object.assign(new Error("write failed"), { writeFailure: error }); });
              copied += b.length;
            }
          } catch (error) { if ((error as { writeFailure?: unknown }).writeFailure !== undefined) throw (error as { writeFailure: unknown }).writeFailure; vanished = true; }
        }
        if (vanished) await sink.abort(); else await sink.finish();
      } catch (error) { await sink.abort().catch(() => undefined); throw error; }
      if (vanished) { await rm(join(folder, stored), { force: true }); continue; }
      lines.push(`${JSON.stringify({ store: store.id, rel: f.rel, size: copied, sha256: hash.digest("hex"), file: stored } satisfies PiIndexLine)}\n`);
      bytes += copied; count += 1;
    }
  }
  const text = Buffer.from(lines.join(""), "utf8");
  const indexFile = cipher === undefined ? PI_INDEX : `${PI_INDEX}${SEALED_SUFFIX}`;
  const index = await openSink(join(staging, indexFile), cipher, indexFile);
  try { await index.write(text); await index.finish(); } catch (error) { await index.abort().catch(() => undefined); throw error; }
  return { index: { file: indexFile, rows: lines.length, bytes: text.length, sha256: hasherFor(cipher).update(text).digest("hex") }, stores: seen.size, files: lines.length, bytes };
}

const STORED = /^f-[0-9]{1,9}(\.enc)?$/;
export const piFileName = (l: PiIndexLine, sealed: boolean): string | undefined => typeof l.file === "string" && STORED.test(l.file) && l.file.endsWith(SEALED_SUFFIX) === sealed ? l.file : undefined;

/** The index lines, each checked for shape (store id, relative path, stored name). `problems` lists what was wrong. */
export function parsePiIndex(text: string, sealed: boolean): { lines: PiIndexLine[]; problems: string[] } {
  const lines: PiIndexLine[] = [];
  const problems: string[] = [];
  const once = new Set<string>();
  for (const raw of text.split("\n")) {
    if (raw === "") continue;
    let l: PiIndexLine;
    try { l = JSON.parse(raw) as PiIndexLine; } catch { problems.push("pi state: the index is not readable"); break; }
    if (l === null || typeof l !== "object" || !validStoreId(l.store) || !validRel(l.rel) || !Number.isSafeInteger(l.size) || l.size < 0 || typeof l.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(l.sha256) || piFileName(l, sealed) === undefined) { problems.push("pi state: the index names something that is not a conversation file"); continue; }
    const key = `${l.store}/${l.rel.toLowerCase()}`;
    if (once.has(key)) { problems.push("pi state: the index names one file twice"); continue; }
    once.add(key);
    lines.push(l);
  }
  return { lines, problems };
}

/** Writes the lines of a verified backup into `targetOf(store)/<rel>`. The target store folder must not exist or must be empty; each file is written under a temporary name and renamed, then checked against its digest. */
export async function writePiState(path: string, lines: readonly PiIndexLine[], cipher: BackupCipher | undefined, targetOf: (store: string) => string): Promise<{ stores: number; files: number }> {
  const stores = new Set<string>();
  for (const l of lines) {
    if (stores.has(l.store)) continue;
    stores.add(l.store);
    const dir = resolve(targetOf(l.store));
    const existing = await readdir(dir).catch((e: NodeJS.ErrnoException) => (e.code === "ENOENT" ? [] : Promise.reject(e)));
    if (existing.length > 0) throw new Error(`the conversation store folder for ${l.store} is not empty`);
  }
  for (const l of lines) {
    const dir = resolve(targetOf(l.store));
    const target = resolve(dir, ...l.rel.split("/"));
    if (relative(dir, target).startsWith("..")) throw new Error("a conversation file would land outside its store");
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const tmp = `${target}.nn-restoring`;
    const sink = await openSink(tmp, undefined, l.rel);
    const hash = hasherFor(cipher);
    let size = 0;
    try {
      for await (const c of readPlain(join(path, PI_FOLDER, l.file!), cipher, `${PI_FOLDER}/${l.file!}`)) { hash.update(c); size += c.length; await sink.write(c); }
      await sink.finish();
    } catch (error) { await sink.abort().catch(() => undefined); await rm(tmp, { force: true }); throw error; }
    if (size !== l.size || hash.digest("hex") !== l.sha256) { await rm(tmp, { force: true }); throw new Error("a conversation file did not come back as the same bytes"); }
    await rename(tmp, target);
  }
  return { stores: stores.size, files: lines.length };
}

