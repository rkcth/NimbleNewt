import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readdir, rename, unlink, utimes, chmod } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { ReadWriteLock } from "./lock.js";

export type BlobProblem = "missing" | "corrupt" | "size_mismatch";

export class BlobError extends Error {
  readonly code: "missing" | "corrupt" | "too_large" | "invalid" | "unusable";
  constructor(code: BlobError["code"], message: string) {
    super(message);
    this.name = "BlobError";
    this.code = code;
  }
}

export interface BlobStoreOptions {
  /** The directory that holds the blobs. Created if absent. It must be on local storage and used by one controller. */
  readonly directory: string;
  /** The largest blob accepted, in bytes. Default 1 GiB. */
  readonly maxBlobBytes?: number;
  /** For the crash qualification only: run at an exact point of a `put`, so a test can kill the process there. Never set in production. */
  readonly testHooks?: { readonly afterTempWrite?: () => void; readonly afterRename?: () => void };
}

export interface BlobInfo { readonly digest: string; readonly size: number; readonly modifiedMs: number }

/** One lock per blob directory in this process, however many store objects or services point at it. */
const LOCKS = new Map<string, ReadWriteLock>();

const DIGEST = /^[0-9a-f]{64}$/;
const CHUNK = 1024 * 1024;

export const isDigest = (value: unknown): value is string => typeof value === "string" && DIGEST.test(value);

/**
 * Immutable, content-addressed file storage for artifact bytes (card S06): `blobs/ab/abcdef...` named by the SHA-256 of the content.
 *
 * - **Atomic and durable.** A blob is written to `tmp/`, flushed to disk, then renamed to its final name (and the directory flushed):
 *   a blob is either absent or complete at its final path, and a crash leaves at most a stray file in `tmp/`.
 * - **Immutable.** A name is its content. Putting bytes that are already stored keeps the stored file (after checking it still has
 *   that hash) and only refreshes its modification time, which is what orphan cleanup uses; a stored file that no longer matches its
 *   name is replaced, never trusted. Blobs are made read-only where the platform allows.
 * - **Verified on use.** `read` and `verify` hash the bytes; nothing is returned or accepted on the strength of a name alone.
 * - **Plain files only.** Anything in the store that is not a regular file (a symlink, a directory) is refused, never followed.
 */
export class FileBlobStore {
  readonly directory: string;
  /**
   * Publications of artifacts hold this shared from the first byte stored until their manifest is committed; orphan cleanup holds it
   * exclusive. It belongs to the directory, so every service in this process that uses the store takes part, not just one instance.
   */
  readonly lock: ReadWriteLock;
  readonly #blobs: string;
  readonly #tmp: string;
  readonly #max: number;
  readonly #hooks: BlobStoreOptions["testHooks"];

  private constructor(directory: string, max: number, hooks: BlobStoreOptions["testHooks"]) {
    this.directory = directory;
    this.lock = LOCKS.get(directory) ?? new ReadWriteLock();
    LOCKS.set(directory, this.lock);
    this.#blobs = join(directory, "blobs");
    this.#tmp = join(directory, "tmp");
    this.#max = max;
    this.#hooks = hooks;
  }

  static async open(options: BlobStoreOptions): Promise<FileBlobStore> {
    if (typeof options.directory !== "string" || options.directory.length === 0) throw new BlobError("invalid", "directory: must be a path");
    const max = options.maxBlobBytes ?? 1024 ** 3;
    if (!Number.isSafeInteger(max) || max < 1) throw new BlobError("invalid", "maxBlobBytes: must be a positive whole number");
    const directory = resolve(options.directory);
    const store = new FileBlobStore(directory, max, options.testHooks);
    await mkdir(store.#blobs, { recursive: true, mode: 0o700 });
    await mkdir(store.#tmp, { recursive: true, mode: 0o700 });
    return store;
  }

  pathOf(digest: string): string {
    if (!isDigest(digest)) throw new BlobError("invalid", "a blob name is 64 lower-case hexadecimal characters");
    return join(this.#blobs, digest.slice(0, 2), digest);
  }

  /** The blob's path, after checking that its two-character folder, if present, is a real directory and not a link to somewhere else. */
  async #safePath(digest: string): Promise<string> {
    const path = this.pathOf(digest);
    let stat;
    try { stat = await lstat(dirname(path)); } catch (error) { if (isMissing(error)) return path; throw error; }
    if (!stat.isDirectory()) throw new BlobError("unusable", `${dirname(path)} is not a directory`);
    return path;
  }

  /** Stores the bytes and returns their digest. `existed` is true when identical content was already stored (and still verified). */
  async put(content: Uint8Array | AsyncIterable<Uint8Array>): Promise<{ digest: string; size: number; existed: boolean }> {
    const temp = join(this.#tmp, randomBytes(12).toString("hex"));
    const hash = createHash("sha256");
    let size = 0;
    const file = await open(temp, "wx", 0o600);
    try {
      for await (const chunk of chunksOf(content)) {
        size += chunk.byteLength;
        if (size > this.#max) throw new BlobError("too_large", `a blob may be at most ${this.#max} bytes`);
        hash.update(chunk);
        for (let written = 0; written < chunk.byteLength;) written += (await file.write(chunk, written, chunk.byteLength - written)).bytesWritten;
      }
      await file.sync();
    } catch (error) {
      await file.close().catch(() => undefined);
      await unlink(temp).catch(() => undefined);
      throw error;
    }
    await file.close();
    this.#hooks?.afterTempWrite?.();
    const digest = hash.digest("hex");
    await mkdir(dirname(this.pathOf(digest)), { recursive: true, mode: 0o700 });
    const final = await this.#safePath(digest);
    // What is at the final name now: nothing, the right bytes, or something else (damaged, or left by a faulty program).
    const inspect = async (): Promise<"absent" | "good" | "bad"> => {
      const existing = await regularFile(final);
      if (existing === undefined) return "absent";
      const actual = await hashOf(final).catch((error: unknown) => (isMissing(error) ? undefined : "unreadable"));
      if (actual === undefined) return "absent"; // removed while we looked
      return existing.size === size && actual === digest ? "good" : "bad";
    };
    // Keeping an existing file is only safe if its age can be refreshed: orphan cleanup judges a blob by its age, and a publication that has
    // adopted an old file must not leave it looking old. If the time cannot be set, the file is replaced by the fresh copy instead.
    const adopt = async (): Promise<{ digest: string; size: number; existed: boolean } | undefined> => {
      const now = new Date();
      try { await utimes(final, now, now); } catch { return undefined; }
      await unlink(temp).catch(() => undefined);
      return { digest, size, existed: true };
    };
    if ((await inspect()) === "good") { const kept = await adopt(); if (kept !== undefined) return kept; }
    try {
      await rename(temp, final); // replaces a damaged file atomically where the platform allows
    } catch (error) {
      const now = await inspect();
      if (now === "good") { const kept = await adopt(); if (kept !== undefined) return kept; throw error; } // a concurrent put of the same bytes won
      if (now === "bad") {
        // The platform will not rename over a file (Windows): remove the damaged one, which this inspection has just shown is not its name's content.
        await chmod(final, 0o666).catch(() => undefined);
        await unlink(final).catch(() => undefined);
        try { await rename(temp, final); } catch (again) { await unlink(temp).catch(() => undefined); throw again; }
      } else {
        await unlink(temp).catch(() => undefined);
        throw error;
      }
    }
    await syncDirectory(dirname(final));
    await chmod(final, 0o444).catch(() => undefined);
    this.#hooks?.afterRename?.();
    return { digest, size, existed: false };
  }

  async has(digest: string): Promise<boolean> {
    return (await regularFile(await this.#safePath(digest))) !== undefined;
  }

  /** Hashes the stored bytes. Reads the file in full, in chunks. */
  async verify(digest: string, expectedSize?: number): Promise<"ok" | BlobProblem> {
    const path = await this.#safePath(digest);
    const stat = await regularFile(path);
    if (stat === undefined) return "missing";
    if (expectedSize !== undefined && stat.size !== expectedSize) return "size_mismatch";
    return (await hashOf(path).catch(() => undefined)) === digest ? "ok" : "corrupt";
  }

  /** The verified bytes. Throws `missing` or `corrupt` rather than return what does not match its name. */
  async read(digest: string, options: { maxBytes?: number } = {}): Promise<Uint8Array> {
    const path = await this.#safePath(digest);
    const stat = await regularFile(path);
    if (stat === undefined) throw new BlobError("missing", `blob ${digest} is not in the store`);
    const limit = options.maxBytes ?? 64 * 1024 * 1024;
    if (stat.size > limit) throw new BlobError("too_large", `blob ${digest} is ${stat.size} bytes, more than the ${limit} allowed for one read`);
    const file = await open(path, "r");
    try {
      const bytes = new Uint8Array(stat.size);
      let at = 0;
      while (at < bytes.length) {
        const { bytesRead } = await file.read(bytes, at, bytes.length - at, at);
        if (bytesRead === 0) break;
        at += bytesRead;
      }
      if (at !== bytes.length || createHash("sha256").update(bytes).digest("hex") !== digest) throw new BlobError("corrupt", `blob ${digest} does not match its hash`);
      return bytes;
    } finally {
      await file.close();
    }
  }

  /** Every regular file stored under a valid blob name. Junk, symlinks and directories are not listed. */
  async list(): Promise<BlobInfo[]> {
    const out: BlobInfo[] = [];
    for (const prefix of await readdir(this.#blobs)) {
      if (!/^[0-9a-f]{2}$/.test(prefix)) continue;
      const directory = join(this.#blobs, prefix);
      if (!(await lstat(directory)).isDirectory()) continue;
      for (const name of await readdir(directory)) {
        if (!isDigest(name) || !name.startsWith(prefix)) continue;
        const stat = await regularFileOrNothing(join(directory, name));
        if (stat !== undefined) out.push({ digest: name, size: stat.size, modifiedMs: stat.mtimeMs });
      }
    }
    return out.sort((a, b) => (a.digest < b.digest ? -1 : 1));
  }

  /** Deletes a blob. Only for orphan cleanup, which has proved nothing refers to it. */
  async remove(digest: string): Promise<boolean> {
    const path = await this.#safePath(digest);
    if ((await regularFile(path)) === undefined) return false;
    await chmod(path, 0o666).catch(() => undefined);
    await unlink(path);
    return true;
  }

  /** Deletes files in `tmp/` last modified before `cutoffMs` (left by a put that never finished). Returns how many. */
  async sweepTemp(cutoffMs: number): Promise<number> {
    let removed = 0;
    for (const name of await readdir(this.#tmp)) {
      const stat = await regularFileOrNothing(join(this.#tmp, name));
      if (stat !== undefined && stat.mtimeMs < cutoffMs) { await unlink(join(this.#tmp, name)).catch(() => undefined); removed += 1; }
    }
    return removed;
  }
}

async function* chunksOf(content: Uint8Array | AsyncIterable<Uint8Array>): AsyncGenerator<Uint8Array> {
  if (content instanceof Uint8Array) {
    for (let at = 0; at < content.byteLength; at += CHUNK) yield content.subarray(at, Math.min(at + CHUNK, content.byteLength));
    return;
  }
  for await (const chunk of content) {
    if (!(chunk instanceof Uint8Array)) throw new BlobError("invalid", "content must be bytes");
    yield chunk;
  }
}

/** The file's stats if it is a regular file, undefined if it does not exist; anything else (a link, a directory) is refused. */
async function regularFile(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  let stat;
  try { stat = await lstat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  if (!stat.isFile()) throw new BlobError("unusable", `${path} is not a regular file`);
  return { size: stat.size, mtimeMs: stat.mtimeMs };
}

/** Like `regularFile`, but anything that is not a regular file counts as nothing (for listing and cleanup, which must skip it and never follow it). */
async function regularFileOrNothing(path: string): Promise<{ size: number; mtimeMs: number } | undefined> {
  try { return await regularFile(path); } catch (error) { if (error instanceof BlobError) return undefined; throw error; }
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

async function hashOf(path: string): Promise<string> {
  const hash = createHash("sha256");
  const file = await open(path, "r");
  try {
    const buffer = new Uint8Array(CHUNK);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await file.close();
  }
  return hash.digest("hex");
}

/** Flushes a directory entry to disk. Not possible on every platform (Windows cannot open a directory), where it is skipped. */
async function syncDirectory(path: string): Promise<void> {
  try {
    const directory = await open(path, "r");
    try { await directory.sync(); } finally { await directory.close(); }
  } catch { /* the platform does not allow it */ }
}
