import { createHash, randomBytes } from "node:crypto";
import { chmod, cp, lstat, mkdir, readdir, readFile, readlink, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { SandboxError } from "./errors.js";

/** Failure injection for tests only. */
export interface QuarantineHooks {
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly removeOriginal?: (path: string) => Promise<void>;
  readonly afterMove?: () => Promise<void>;
  readonly afterCopy?: () => Promise<void>;
}

/** What is kept about a quarantined directory (a `manifest.json` beside its content). */
export interface QuarantineRecord {
  readonly id: string;
  /** Where the directory was before the agent lost it. */
  readonly originalPath: string;
  readonly reason: string;
  readonly by: string;
  readonly at: string;
  readonly files: number;
  readonly directories: number;
  readonly symlinks: number;
  readonly bytes: number;
  /** True if the directory had to be copied (it was on another filesystem) rather than moved. */
  readonly copied: boolean;
}

const ID = /^q-[0-9a-f]{20}$/;
const READ_ONLY_FILE = 0o444;
const READ_ONLY_DIR = 0o555;

const within = (parent: string, child: string): boolean => { const r = relative(parent, child); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

interface Tally { files: number; directories: number; symlinks: number; bytes: number; special: number }

async function tally(path: string, out: Tally): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) { out.symlinks += 1; return; }
  if (info.isDirectory()) { out.directories += 1; for (const entry of await readdir(path)) await tally(join(path, entry), out); return; }
  if (!info.isFile()) { out.special += 1; return; }
  out.files += 1; out.bytes += info.size;
}

/** A digest of the whole tree: every name, kind, size, link target and file content, in a fixed order. */
async function digestTree(path: string): Promise<string> {
  const hash = createHash("sha256");
  const walk = async (current: string, name: string): Promise<void> => {
    const info = await lstat(current);
    if (info.isSymbolicLink()) { hash.update(`L\0${name}\0${await readlink(current)}\0`); return; }
    if (info.isDirectory()) { hash.update(`D\0${name}\0`); for (const entry of (await readdir(current)).sort()) await walk(join(current, entry), `${name}/${entry}`); return; }
    hash.update(`F\0${name}\0${info.size}\0`);
    hash.update(await readFile(current));
    hash.update("\0");
  };
  await walk(path, "");
  return hash.digest("hex");
}

async function freeze(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink()) return; // never follow a link: it may point outside, and its target is not ours to change
  if (info.isDirectory()) { for (const entry of await readdir(path)) await freeze(join(path, entry)); await chmod(path, READ_ONLY_DIR); return; }
  // A file with another name elsewhere (a hard link) shares its permissions with that name: changing them would change a file outside the quarantine.
  if (info.nlink > 1) return;
  await chmod(path, READ_ONLY_FILE);
}

/**
 * Work under a path the agent just lost is quarantined (card A03): the directory is moved, never deleted or merged, into `root/<id>/content`, its permissions are reduced to read-only, and a manifest
 * records where it came from, why, by whom and when. Only the owner reads it (through `readQuarantined`), and nothing here puts it back or deletes it: releasing it is a deliberate owner action elsewhere.
 * A move on one filesystem is a rename; across filesystems the tree is copied, checked against what was counted, and only then removed from the old place. Links are kept as links and never followed.
 * The caller must have stopped everything that could write to the directory (the freeze and settle order is H12's).
 */
export async function quarantine(options: { root: string; path: string; reason: string; by: string; clock?: () => string; hooks?: QuarantineHooks }): Promise<QuarantineRecord> {
  if (typeof options.reason !== "string" || options.reason.length < 1 || options.reason.length > 500) throw new SandboxError("invalid_recipe", "a quarantine needs a reason of 1 to 500 characters");
  const root = resolve(options.root);
  const source = resolve(options.path);
  let info;
  try { info = await lstat(source); } catch { throw new SandboxError("invalid_recipe", "the path to quarantine does not exist"); }
  if (info.isSymbolicLink() || !info.isDirectory()) throw new SandboxError("invalid_recipe", "only a directory can be quarantined (not a link or a file)");
  const real = await realpath(source);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const realRoot = await realpath(root);
  if (within(real, realRoot) || within(realRoot, real)) throw new SandboxError("invalid_recipe", "the quarantine root and the directory cannot contain one another");
  // A root that others can enter is tightened, or refused if that is not possible: what is in it is the owner's alone.
  if (process.platform !== "win32" && ((await stat(realRoot)).mode & 0o077) !== 0) {
    try { await chmod(realRoot, 0o700); } catch { throw new SandboxError("invalid_recipe", "the quarantine root can be entered by other users and could not be tightened"); }
  }
  const counts: Tally = { files: 0, directories: 0, symlinks: 0, bytes: 0, special: 0 };
  await tally(real, counts);
  const id = `q-${randomBytes(10).toString("hex")}`;
  const home = join(root, id);
  const content = join(home, "content");
  // Everything that can fail without touching the directory happens before it moves.
  const at = (options.clock ?? (() => new Date().toISOString()))();
  const { special, ...kept } = counts;
  const record: QuarantineRecord = { id, originalPath: real, reason: options.reason, by: options.by, at, ...kept, copied: false };
  await mkdir(home, { mode: 0o700 });
  let moved = false;
  try {
    try { await (options.hooks?.rename ?? rename)(real, content); moved = true; await options.hooks?.afterMove?.(); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
      if (special > 0) throw new SandboxError("unavailable", "the directory holds files that are not plain files, directories or links (pipes, sockets, devices) and is on another filesystem, so it cannot be copied; nothing was changed");
      const before = await digestTree(real);
      await cp(real, content, { recursive: true, verbatimSymlinks: true, errorOnExist: true, force: false });
      await options.hooks?.afterCopy?.();
      moved = true; // from here on a copy exists and must never be removed by this function
      if ((await digestTree(content)) !== before || (await digestTree(real)) !== before) throw new SandboxError("unavailable", `the copy in ${content} does not match the original, so the original was left in place and the copy was kept for inspection`);
      try { await (options.hooks?.removeOriginal ?? ((p: string) => rm(p, { recursive: true, force: true })))(real); }
      catch { throw new SandboxError("unavailable", `the directory was copied to ${content} but the original at ${real} could not be fully removed; both are kept`); }
      await writeFile(join(home, "manifest.json"), `${JSON.stringify({ ...record, copied: true }, null, 2)}\n`, { mode: 0o444 });
      await freeze(content);
      return { ...record, copied: true };
    }
    await writeFile(join(home, "manifest.json"), `${JSON.stringify(record, null, 2)}\n`, { mode: 0o444 });
    await freeze(content);
    return record;
  } catch (error) {
    if (!moved) { try { await rm(home, { recursive: true, force: true }); } catch { /* the caller sees the original error */ } }
    else {
      // The work is already in the quarantine: never remove it. Say where it is and leave a manifest marking the record unfinished.
      try { await writeFile(join(home, "manifest.json"), `${JSON.stringify({ ...record, incomplete: true }, null, 2)}\n`, { mode: 0o444, flag: "wx" }); } catch { /* it may exist already */ }
      if (error instanceof SandboxError) throw error;
      throw new SandboxError("unavailable", `the directory was moved to ${content} but quarantining it did not finish (${(error as Error).message}); nothing was deleted`);
    }
    throw error instanceof SandboxError ? error : new SandboxError("unavailable", "the directory could not be quarantined; it was left where it was");
  }
}

/** The quarantined directories under `root`, oldest first. */
export async function listQuarantined(root: string): Promise<QuarantineRecord[]> {
  let names: string[];
  try { names = await readdir(resolve(root)); } catch { return []; }
  const out: QuarantineRecord[] = [];
  for (const name of names.filter((n) => ID.test(n)).sort()) {
    try { out.push(JSON.parse(await readFile(join(resolve(root), name, "manifest.json"), "utf8")) as QuarantineRecord); } catch { /* an unreadable entry is not listed, never guessed at */ }
  }
  return out.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : 0));
}

/** The file list of one quarantined directory (names relative to it), or one file's bytes. A path that leaves the directory, or goes through a link, is refused. */
export async function readQuarantined(root: string, id: string, path = ""): Promise<{ kind: "directory"; entries: string[] } | { kind: "file"; content: Buffer }> {
  if (!ID.test(id)) throw new SandboxError("invalid_recipe", "that is not a quarantine ID");
  const base = join(resolve(root), id, "content");
  const target = resolve(base, path);
  if (!within(base, target)) throw new SandboxError("invalid_recipe", "that path leaves the quarantined directory");
  for (let at = base, parts = relative(base, target).split(sep).filter(Boolean), i = 0; i <= parts.length; at = join(at, parts[i++] ?? "")) {
    const info = await lstat(at).catch(() => undefined);
    if (info === undefined) throw new SandboxError("invalid_recipe", "no such path in the quarantined directory");
    if (info.isSymbolicLink()) throw new SandboxError("invalid_recipe", "a link in the quarantined directory is not followed");
  }
  const info = await lstat(target);
  if (info.isDirectory()) return { kind: "directory", entries: (await readdir(target)).sort() };
  return { kind: "file", content: await readFile(target) };
}

