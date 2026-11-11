import { createHash, randomUUID } from "node:crypto";
import { chmod, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ArchiveError, checkPackagePath, DEFAULT_ARCHIVE_LIMITS, type ArchiveLimits, type PackageFile } from "./archive.js";

/** What the places that write files use, so a test can make the disk full or fail a write: the real functions by default. */
export interface FileIo {
  writeFile(path: string, data: Uint8Array, mode: number): Promise<void>;
  /** Free bytes on the file system holding `path`; `undefined` when it cannot be told (then the space is not pre-checked and a full disk shows as a failed write). */
  freeBytes(path: string): Promise<number | undefined>;
}
export const realIo: FileIo = {
  async writeFile(path, data, mode) { await writeFile(path, data, { mode, flag: "wx" }); await chmod(path, mode); },
  async freeBytes(path) { try { const { statfs } = await import("node:fs/promises"); const s = await statfs(path); return Number(s.bavail) * Number(s.bsize); } catch { return undefined; } },
};

export interface TreeEntry { readonly path: string; readonly executable: boolean; readonly size: number; readonly sha: string }
export interface TreeScan { readonly entries: readonly TreeEntry[]; readonly directories: readonly string[]; readonly bytes: number; readonly digest: string }

const sha = (data: Uint8Array): string => createHash("sha256").update(data).digest("hex");

/** The digest of a tree: its sorted file paths, whether each is executable, sizes and content hashes, and its directories. Owner, times and other mode bits are not part of it. */
export function treeDigestOf(entries: readonly TreeEntry[], directories: readonly string[]): string {
  const h = createHash("sha256");
  for (const d of [...directories].sort()) h.update(`d\0${d}\n`);
  for (const e of [...entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) h.update(`f\0${e.path}\0${e.executable ? "x" : "-"}\0${e.size}\0${e.sha}\n`);
  return `sha256:${h.digest("hex")}`;
}
export function treeOfFiles(files: readonly PackageFile[], directories: readonly string[]): TreeScan {
  const entries = files.map((f) => ({ path: f.path, executable: f.mode === 0o755, size: f.data.length, sha: sha(f.data) }));
  return { entries, directories: [...directories], bytes: files.reduce((n, f) => n + f.data.length, 0), digest: treeDigestOf(entries, directories) };
}

/**
 * Reads a directory that is supposed to be a package tree and refuses it if it holds anything a package may not: a link, a device or other special file, a set-user-ID, set-group-ID or sticky bit, a name the archive reader would refuse,
 * or more than the limits. Used on what comes out of the store, on what an install script left behind, and on a revision before it is activated.
 */
export async function scanTree(dir: string, limits: ArchiveLimits = DEFAULT_ARCHIVE_LIMITS): Promise<TreeScan> {
  const entries: TreeEntry[] = [];
  const directories: string[] = [];
  let bytes = 0;
  const walk = async (absolute: string, relative: string): Promise<void> => {
    for (const item of await readdir(absolute, { withFileTypes: true })) {
      const path = relative === "" ? item.name : `${relative}/${item.name}`;
      checkPackagePath(path, limits);
      const full = join(absolute, item.name);
      const stat = await lstat(full);
      if (stat.isSymbolicLink()) throw new ArchiveError("unsafe_entry", `${path} is a link`);
      if ((stat.mode & 0o7000) !== 0) throw new ArchiveError("unsafe_mode", `${path} has a set-user-ID, set-group-ID or sticky bit`);
      if (stat.isDirectory()) { directories.push(path); if (directories.length + entries.length > limits.maxFiles) throw new ArchiveError("too_large", "the tree has too many entries"); await walk(full, path); continue; }
      if (!stat.isFile()) throw new ArchiveError("unsafe_entry", `${path} is not a plain file or directory`);
      if (stat.nlink > 1) throw new ArchiveError("unsafe_entry", `${path} has more than one name`);
      bytes += stat.size;
      if (bytes > limits.maxUnpackedBytes || directories.length + entries.length + 1 > limits.maxFiles) throw new ArchiveError("too_large", "the tree is larger than the limits allow");
      entries.push({ path, executable: (stat.mode & 0o111) !== 0, size: stat.size, sha: sha(await readFile(full)) });
    }
  };
  const root = await lstat(dir);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new ArchiveError("unsafe_entry", "the package tree is not a plain directory");
  await walk(dir, "");
  return { entries, directories, bytes, digest: treeDigestOf(entries, directories) };
}

/** Writes files and directories under `dest` (which must not exist): files are made new (never over an existing one), with mode 0644 or 0755. */
export async function writeTree(dest: string, files: readonly PackageFile[], directories: readonly string[], io: FileIo): Promise<void> {
  await mkdir(dest, { recursive: false, mode: 0o755 });
  for (const d of [...directories].sort()) await mkdir(join(dest, d), { recursive: true, mode: 0o755 });
  for (const f of files) {
    const target = join(dest, f.path);
    await mkdir(join(target, ".."), { recursive: true, mode: 0o755 });
    await io.writeFile(target, f.data, f.mode);
  }
}

/** Reads a scanned tree back as files (for copying a package into an environment). The caller scanned it first. */
export async function readTree(dir: string, scan: TreeScan): Promise<PackageFile[]> {
  const out: PackageFile[] = [];
  for (const e of scan.entries) out.push({ path: e.path, mode: e.executable ? 0o755 : 0o644, data: await readFile(join(dir, e.path)) });
  return out;
}

/** A private working directory under `base`, named for this process so that a later start can tell it is abandoned. */
export async function makeTemp(base: string, label: string): Promise<string> {
  await mkdir(base, { recursive: true, mode: 0o700 });
  const dir = join(base, `${process.pid}-${label}-${randomUUID()}`);
  await mkdir(dir, { mode: 0o700 });
  return dir;
}

/** Removes a tree whatever mode a script left on its directories. */
export async function removeAll(path: string): Promise<void> {
  const mend = async (p: string): Promise<void> => {
    let stat; try { stat = await lstat(p); } catch { return; }
    if (!stat.isDirectory()) return;
    try { await chmod(p, 0o700); } catch { /* reported by the removal below */ }
    for (const name of await readdir(p).catch(() => [] as string[])) await mend(join(p, name));
  };
  try { await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); } catch { await mend(path); await rm(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 20 }); }
}

/** True when the process that made a working directory (named `<pid>-...`) is gone. */
export function abandoned(name: string): boolean {
  const pid = Number(/^(\d+)-/.exec(name)?.[1]);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  if (pid === process.pid) return false;
  try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}
