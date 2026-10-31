import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, type FileHandle } from "node:fs/promises";
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

/** Windows device names (with or without an extension) cannot be files there; a segment may not end in a dot or a space either. Refused on every platform, so a backup made on one machine restores on any. */
const RESERVED = /^(con|prn|aux|nul|com[0-9\u00b9\u00b2\u00b3]|lpt[0-9\u00b9\u00b2\u00b3])(\..*)?$/i;

/** A relative path inside a store, in the form the backup keeps (forward slashes whatever the platform), checked before any file is made from it. */
export function validRel(rel: unknown): rel is string {
  if (typeof rel !== "string" || rel === "" || rel.length > 500 || rel.includes("\\") || rel.includes("\0") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel)) return false;
  return rel.split("/").every((s) => s !== "" && s !== "." && s !== ".." && !/[:*?"<>|\u0000-\u001f]/.test(s) && !/[. ]$/.test(s) && !RESERVED.test(s));
}

const O_NOFOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const MAX_PROBLEMS = 100;
const COPY_TRIES = 3;

/** What a copy found wrong with a store: reported in the manifest (`problems`), never turned into "the store is empty". */
class Problems {
  readonly list: string[] = [];
  count = 0;
  add(text: string): void { this.count += 1; if (this.list.length < MAX_PROBLEMS) this.list.push(text.slice(0, 300)); }
}

async function* walk(dir: string, base: string, state: { n: number }, problems: Problems, storeId: string): AsyncGenerator<{ path: string; rel: string }> {
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" && dir !== base) return; // a folder removed while the walk runs is gone, not unreadable
    problems.add(`${storeId}: ${relative(base, dir).split(sep).join("/") || "(store)"} cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"}); what it holds is not in the backup`); return;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const e of entries) {
    const path = join(dir, e.name);
    const rel = relative(base, path).split(sep).join("/");
    // Links and special files are not followed or copied: a store is plain files and folders.
    if (e.isDirectory()) { yield* walk(path, base, state, problems, storeId); continue; }
    if (e.isSymbolicLink()) { problems.add(`${storeId}: ${rel} is a link and was not followed`); continue; }
    if (!e.isFile()) { problems.add(`${storeId}: ${rel} is not a plain file and was skipped`); continue; }
    if (!validRel(rel)) { problems.add(`${storeId}: ${rel} has a name a backup cannot keep and was skipped`); continue; }
    if (++state.n > PI_LIMITS.files) throw new Error("a conversation store has too many files to back up");
    yield { path, rel };
  }
}

/** The byte length of a JSON-lines file up to and including its last complete line within the first `size` bytes: a worker that is writing right now may leave half a line at the end, and that half line is not part of the copy. */
async function completeLength(h: FileHandle, size: number): Promise<number> {
  const buf = Buffer.alloc(64 * 1024);
  for (let end = size; end > 0; end -= buf.length) {
    const start = Math.max(0, end - buf.length);
    const { bytesRead } = await h.read(buf, 0, end - start, start);
    if (bytesRead < end - start) return -1; // shorter than it was a moment ago: the file changed under us
    const at = buf.subarray(0, bytesRead).lastIndexOf(10);
    if (at >= 0) return start + at + 1;
  }
  return 0;
}

type Copied = { kind: "ok"; size: number; sha256: string } | { kind: "vanished" } | { kind: "problem"; why: string };

/**
 * Copies one file from ONE open handle: the length, the complete-line cut and the bytes all come from the same file object, which was opened without following a link. If the file shrank or was replaced during the
 * copy it is tried again; if it still changes the file is reported as inconsistent and left out (never recorded as a shorter copy of itself).
 */
/** Tests only: called after the bytes of an attempt were copied and before the file is checked again (so a test can shorten or replace the file at that moment). */
export interface CopyHooks { afterCopy?(path: string, attempt: number): Promise<void> }

async function copyOne(hooks: CopyHooks | undefined, path: string, rel: string, jsonl: boolean, sinkFor: () => Promise<{ write(b: Buffer): Promise<void>; finish(): Promise<void>; abort(): Promise<void> }>, hash: () => { update(b: Buffer): unknown; digest(f: "hex"): string }): Promise<Copied> {
  let lastWhy = "changed while it was copied";
  for (let attempt = 0; attempt < COPY_TRIES; attempt++) {
    let h: FileHandle;
    try { h = await open(path, constants.O_RDONLY | O_NOFOLLOW); } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return { kind: "vanished" };
      return { kind: "problem", why: code === "ELOOP" ? "is a link and was not followed" : `cannot be opened (${code ?? "error"})` };
    }
    try {
      const before = await h.stat();
      if (!before.isFile()) return { kind: "problem", why: "is not a plain file and was skipped" };
      if (before.nlink > 1) return { kind: "problem", why: "has more than one hard link and was skipped (it may be the same file as something outside the store)" };
      const size = jsonl ? await completeLength(h, before.size) : before.size;
      if (size < 0) { lastWhy = "became shorter while it was copied"; continue; }
      const sink = await sinkFor();
      const hasher = hash();
      let copied = 0;
      try {
        const buf = Buffer.alloc(64 * 1024);
        while (copied < size) {
          const { bytesRead } = await h.read(buf, 0, Math.min(buf.length, size - copied), copied);
          if (bytesRead === 0) break;
          const chunk = Buffer.from(buf.subarray(0, bytesRead));
          hasher.update(chunk);
          await sink.write(chunk);
          copied += bytesRead;
        }
        await hooks?.afterCopy?.(path, attempt);
        const after = await h.stat();
        const now = await lstat(path).catch(() => undefined);
        const replaced = now === undefined || now.isSymbolicLink() || (now.ino !== 0 && before.ino !== 0 && (now.ino !== before.ino || now.dev !== before.dev));
        const shrank = copied < size || after.size < size;
        // A file that is not a log must not have been written to at all during the copy.
        const rewritten = !jsonl && (after.size !== before.size || after.mtimeMs !== before.mtimeMs);
        if (replaced || shrank || rewritten) { await sink.abort(); lastWhy = replaced ? "was replaced while it was copied" : shrank ? "became shorter while it was copied" : "was written to while it was copied"; continue; }
        await sink.finish();
      } catch (error) { await sink.abort().catch(() => undefined); throw error; }
      return { kind: "ok", size: copied, sha256: hasher.digest("hex") };
    } finally { await h.close(); }
  }
  return { kind: "problem", why: `is inconsistent: it ${lastWhy} on each of ${COPY_TRIES} tries, so it is not in the backup` };
}

/**
 * Copies every file of every store into `staging/pi-state/f-<n>` (sealed when the backup is) and writes the index last. A JSON-lines file is copied up to its last complete line. Files that vanish while the copy runs
 * are left out (a store being deleted is not an error); what cannot be copied faithfully (a link, a hard-linked or special file, a file that keeps changing, a folder that cannot be read, a store that is a link or is gone)
 * is named in the manifest's `problems`, so a backup never says "complete" about a store it could not read. A write failure fails the whole backup.
 */
export async function copyPiState(source: PiStateSource, staging: string, cipher: BackupCipher | undefined, hooks?: CopyHooks): Promise<BackupPiState> {
  const folder = join(staging, PI_FOLDER);
  await mkdir(folder, { mode: 0o700 });
  const stores = [...await source.list()];
  if (stores.length > PI_LIMITS.stores) throw new Error("too many conversation stores to back up");
  const lines: string[] = [];
  const problems = new Problems();
  let bytes = 0, count = 0;
  const seen = new Set<string>();
  for (const store of stores) {
    if (!validStoreId(store.id) || seen.has(store.id)) throw new Error("a conversation store has an id that cannot be kept in a backup");
    seen.add(store.id);
    const root = await lstat(store.dir).catch((e: NodeJS.ErrnoException) => e);
    if (root instanceof Error) { problems.add(`${store.id}: the store folder cannot be read (${(root as NodeJS.ErrnoException).code ?? "error"})`); continue; }
    if (root.isSymbolicLink()) { problems.add(`${store.id}: the store folder is a link and was not followed`); continue; }
    if (!root.isDirectory()) { problems.add(`${store.id}: the store is not a folder`); continue; }
    for await (const f of walk(store.dir, store.dir, { n: 0 }, problems, store.id)) {
      const stored = `f-${count}${cipher === undefined ? "" : SEALED_SUFFIX}`;
      let writeFailure: unknown;
      const done = await copyOne(hooks, f.path, f.rel, f.rel.endsWith(".jsonl"),
        () => rm(join(folder, stored), { force: true }).then(() => openSink(join(folder, stored), cipher, `${PI_FOLDER}/${stored}`)).then((s) => ({
          write: (b: Buffer) => s.write(b).catch((error: unknown) => { writeFailure = error; throw error; }),
          finish: () => s.finish(), abort: () => s.abort(),
        })), () => hasherFor(cipher)).catch((error: unknown) => { if (writeFailure !== undefined) throw writeFailure; return { kind: "problem", why: `cannot be read (${(error as NodeJS.ErrnoException).code ?? "error"})` } satisfies Copied; });
      if (done.kind === "vanished") { await rm(join(folder, stored), { force: true }); continue; }
      if (done.kind === "problem") { problems.add(`${store.id}: ${f.rel} ${done.why}`); await rm(join(folder, stored), { force: true }); continue; }
      lines.push(`${JSON.stringify({ store: store.id, rel: f.rel, size: done.size, sha256: done.sha256, file: stored } satisfies PiIndexLine)}\n`);
      bytes += done.size; count += 1;
    }
  }
  const text = Buffer.from(lines.join(""), "utf8");
  const indexFile = cipher === undefined ? PI_INDEX : `${PI_INDEX}${SEALED_SUFFIX}`;
  const index = await openSink(join(staging, indexFile), cipher, indexFile);
  try { await index.write(text); await index.finish(); } catch (error) { await index.abort().catch(() => undefined); throw error; }
  return { index: { file: indexFile, rows: lines.length, bytes: text.length, sha256: hasherFor(cipher).update(text).digest("hex") }, stores: seen.size, files: lines.length, bytes, ...(problems.count === 0 ? {} : { problems: problems.list, problemCount: problems.count }) };
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

