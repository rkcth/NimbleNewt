import { mkdir, readFile, readdir, rename, stat } from "node:fs/promises";
import { join } from "node:path";
import { ArchiveError, DEFAULT_ARCHIVE_LIMITS, METADATA_FILE, digestOf, unpack, validPackageName, validPackageVersion, type ArchiveLimits, type PackageMetadata } from "./archive.js";
import { abandoned, makeTemp, readTree, realIo, removeAll, scanTree, treeOfFiles, writeTree, type FileIo } from "./tree.js";

export class StoreError extends Error {
  constructor(readonly code: "digest_mismatch" | "invalid" | "identity" | "disk" | "corrupt" | "missing" | "unsafe", message: string) { super(message); this.name = "StoreError"; }
}
export const DIGEST_FORM = /^sha256:[0-9a-f]{64}$/;

export interface StoredPackage {
  readonly digest: string; readonly name: string; readonly version: string;
  /** The verified, unpacked files. Never written to: environments copy from here. */
  readonly dir: string;
  readonly treeDigest: string; readonly bytes: number; readonly scripts: PackageMetadata["scripts"];
}
interface Meta { readonly digest: string; readonly name: string; readonly version: string; readonly treeDigest: string; readonly bytes: number; readonly scripts: PackageMetadata["scripts"] }

export interface StoreOptions {
  readonly root: string;
  readonly limits?: ArchiveLimits;
  readonly io?: FileIo;
  /** Space that must stay free after an install (default 16 MiB). */
  readonly reserveBytes?: number;
  /** Called at named points of a write (tests make a crash or a failure there by throwing). */
  readonly failpoint?: (name: string) => void;
}

/**
 * The content-addressed package store (card A09 follow-up): `<root>/store/<sha256 hex>/{meta.json,tree/}`. An archive is put only against the digest the owner approved: the bytes are hashed BEFORE anything is unpacked, a mismatch stores
 * nothing, and what is stored is the unpacked tree plus the tree's own digest. Every `get` scans the tree again and compares it with the recorded digest, so a file changed on disk after the install is found before use. A package is written
 * into a private working directory and moved into place with one rename, so the store holds only whole packages; two writers of the same package end with the one that renamed first and both succeed.
 */
export class ContentStore {
  readonly #root: string;
  readonly #limits: ArchiveLimits;
  readonly #io: FileIo;
  readonly #reserve: number;
  readonly #fail: (name: string) => void;
  constructor(options: StoreOptions) {
    this.#root = options.root; this.#limits = options.limits ?? DEFAULT_ARCHIVE_LIMITS; this.#io = options.io ?? realIo; this.#reserve = options.reserveBytes ?? 16 * 1024 * 1024; this.#fail = options.failpoint ?? ((): void => undefined);
  }
  get limits(): ArchiveLimits { return this.#limits; }
  get tmp(): string { return join(this.#root, "tmp"); }
  #dir(digest: string): string { if (!DIGEST_FORM.test(digest)) throw new StoreError("invalid", "a digest has the form sha256:<64 hex digits>"); return join(this.#root, "store", digest.slice(7)); }

  /** Removes working directories that a process which has since died left behind. */
  async recover(): Promise<number> {
    let n = 0;
    for (const base of [this.tmp, join(this.#root, "trials")]) for (const name of await readdir(base).catch(() => [] as string[])) if (abandoned(name)) { await removeAll(join(base, name)); n++; }
    return n;
  }

  async has(digest: string): Promise<boolean> { try { await this.get(digest); return true; } catch { return false; } }

  /** The verified package for a digest. Throws `missing` when it is not stored and `corrupt` when what is on disk no longer matches what was recorded. */
  async get(digest: string): Promise<StoredPackage> {
    const base = this.#dir(digest);
    let meta: Meta;
    try {
      const raw = await readFile(join(base, "meta.json"), "utf8");
      if (raw.length > 64 * 1024) throw new StoreError("corrupt", "the record of a stored package is too large");
      meta = JSON.parse(raw) as Meta;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new StoreError("missing", `no package with digest ${digest} is stored here`);
      if (error instanceof StoreError) throw error;
      throw new StoreError("corrupt", "the record of a stored package cannot be read");
    }
    if (meta.digest !== digest || !validPackageName(meta.name) || !validPackageVersion(meta.version) || typeof meta.treeDigest !== "string") throw new StoreError("corrupt", "the record of a stored package does not match its digest");
    let scan;
    try { scan = await scanTree(join(base, "tree"), this.#limits); } catch (error) { throw new StoreError("corrupt", `a stored package is no longer a safe tree: ${(error as Error).message}`); }
    if (scan.digest !== meta.treeDigest) throw new StoreError("corrupt", `the files of ${meta.name}@${meta.version} changed after they were stored`);
    return { digest, name: meta.name, version: meta.version, dir: join(base, "tree"), treeDigest: meta.treeDigest, bytes: meta.bytes, scripts: meta.scripts };
  }

  /** Reads a stored package back as files (verified first). */
  async files(digest: string): ReturnType<typeof readTree> { const p = await this.get(digest); return readTree(p.dir, await scanTree(p.dir, this.#limits)); }

  /**
   * Stores an archive that must hash to `expected.digest` and be the package `expected.name`@`expected.version`. The digest is checked first: bytes that do not match are never unpacked and nothing is written.
   * Returns the stored package; a package already stored (and intact) is returned as it is.
   */
  async put(bytes: Uint8Array, expected: { readonly digest: string; readonly name: string; readonly version: string }): Promise<StoredPackage> {
    const final = this.#dir(expected.digest);
    if (digestOf(bytes) !== expected.digest) throw new StoreError("digest_mismatch", "the archive does not match the approved digest, so nothing was installed");
    try { const found = await this.get(expected.digest); if (found.name === expected.name && found.version === expected.version) return found; throw new StoreError("identity", `the stored package with this digest is ${found.name}@${found.version}, not ${expected.name}@${expected.version}`); }
    catch (error) {
      if (error instanceof StoreError && error.code === "identity") throw error;
      if (error instanceof StoreError && error.code === "corrupt") await removeAll(final); // a damaged copy is replaced by this verified one
    }
    let unpacked;
    try { unpacked = unpack(bytes, this.#limits); } catch (error) { if (error instanceof ArchiveError) throw new StoreError(error.code === "metadata" ? "invalid" : "unsafe", `the archive is refused: ${error.message}`); throw error; }
    const { metadata } = unpacked;
    if (metadata.name !== expected.name || metadata.version !== expected.version) throw new StoreError("identity", `the archive is ${metadata.name}@${metadata.version} (its ${METADATA_FILE}), not the approved ${expected.name}@${expected.version}`);
    const free = await this.#io.freeBytes(this.#root);
    if (free !== undefined && free < unpacked.bytes * 2 + this.#reserve) throw new StoreError("disk", `not enough free disk space for ${expected.name}@${expected.version} (${unpacked.bytes} bytes to unpack, ${free} free)`);
    const tree = treeOfFiles(unpacked.files, unpacked.directories);
    const work = await makeTemp(this.tmp, "put");
    try {
      try {
        await writeTree(join(work, "tree"), unpacked.files, unpacked.directories, this.#io);
        this.#fail("store:written");
        const meta: Meta = { digest: expected.digest, name: metadata.name, version: metadata.version, treeDigest: tree.digest, bytes: unpacked.bytes, scripts: metadata.scripts };
        await this.#io.writeFile(join(work, "meta.json"), Buffer.from(JSON.stringify(meta)), 0o644);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOSPC") throw new StoreError("disk", "the disk filled up while the package was written; nothing was installed");
        throw error;
      }
      this.#fail("store:before-rename");
      await mkdir(join(this.#root, "store"), { recursive: true, mode: 0o700 });
      try { await rename(work, final); } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOTEMPTY" && code !== "EEXIST") throw error;
        // Another writer put the same package first: what is there is what counts, once it verifies.
      }
      return await this.get(expected.digest);
    } finally { await removeAll(work); }
  }

  async list(): Promise<string[]> { return (await readdir(join(this.#root, "store")).catch(() => [] as string[])).filter((n) => /^[0-9a-f]{64}$/.test(n)).map((n) => `sha256:${n}`); }
  async exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
}
