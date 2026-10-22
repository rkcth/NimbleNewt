import { constants } from "node:fs";
import { lstat, mkdir, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { WorkspaceError } from "./errors.js";
import { fold, splitRelative, touchesGit } from "./names.js";

export interface SafePath {
  /** The absolute path, inside the real root. */
  readonly absolute: string;
  /** The names below the root. */
  readonly parts: readonly string[];
  /** Whether the final name exists, and what it is. */
  readonly exists: "file" | "directory" | "missing";
  /** The directory that holds it (real, inside the root). */
  readonly parent: string;
}

const within = (parent: string, child: string): boolean => { const r = relative(parent, child); return r === "" || (!r.startsWith("..") && !isAbsolute(r)); };

/**
 * Resolves a relative path below `root` for a read or a write, refusing everything that could lead outside or into Git's data: each existing name on the way is looked at without following links, and
 * a symbolic link, a Windows junction or any other reparse point is refused; `.git` in any spelling is refused when `protect` is set (the default); a final name that would collide with a different
 * spelling already in its directory (case, Unicode normalisation) is refused; a file with another name elsewhere (a hard link) is refused for writing. The check and the use are not one step, so the
 * caller opens the final file without following links and compares what it opened (`sameFile`); a swap in between is then noticed instead of followed.
 */
export function resolveSafe(root: string, path: string, options: { forWrite?: boolean; forWindows?: boolean; createParents?: boolean } = {}): Promise<SafePath> {
  return resolveInside(root, path, options);
}

/** The same walk, with the option the controller's own reads need: `protect: false` lets it look inside Git's data. Not part of the package's public surface. */
export async function resolveInside(root: string, path: string, options: { protect?: boolean; forWrite?: boolean; forWindows?: boolean; createParents?: boolean } = {}): Promise<SafePath> {
  const realRoot = await realpath(resolve(root)).catch(() => { throw new WorkspaceError("unavailable", "the workspace root does not exist"); });
  // Git's data is recognised before any other check, on a loose split, so that a spelling that is also malformed (a trailing dot, a stream name) is still reported as what it is.
  if (options.protect !== false && typeof path === "string" && touchesGit(path.split(/[\\/]/))) throw new WorkspaceError("protected_path", `${JSON.stringify(path.slice(0, 80))} is or lies inside Git's own data, which no agent change may touch`);
  const parts = splitRelative(path, { forWindows: options.forWindows ?? process.platform === "win32", rootLength: realRoot.length });
  if (options.protect !== false && touchesGit(parts)) throw new WorkspaceError("protected_path", `${JSON.stringify(path.slice(0, 80))} is or lies inside Git's own data, which no agent change may touch`);
  let current = realRoot;
  let exists: SafePath["exists"] = "missing";
  for (let i = 0; i < parts.length; i++) {
    const name = parts[i]!;
    const last = i === parts.length - 1;
    // A different spelling of this name already present is a collision, not the same file.
    let entries: string[];
    try { entries = await readdir(current); } catch { throw new WorkspaceError("not_found", "a directory on the way does not exist"); }
    const same = entries.filter((e) => fold(e) === fold(name));
    const clash = same.find((e) => e !== name);
    if (clash !== undefined) throw new WorkspaceError("collision", `${JSON.stringify(name.slice(0, 40))} collides with ${JSON.stringify(clash.slice(0, 40))}, which is the same name on a case-insensitive or normalising filesystem`);
    const next = join(current, name);
    let info;
    try { info = await lstat(next); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        exists = "missing";
        if (!last && options.createParents === true && options.forWrite === true) {
          // A write into a directory that is not there yet makes it, one name at a time, each checked like any other.
          try { await mkdir(next); } catch { throw new WorkspaceError("unavailable", "a directory on the way could not be made"); }
          current = next; continue;
        }
        if (!last) throw new WorkspaceError("not_found", "a directory on the way does not exist");
        current = next; break;
      }
      throw new WorkspaceError("unavailable", "the path could not be examined");
    }
    if (info.isSymbolicLink()) throw new WorkspaceError("link_refused", `${JSON.stringify(name.slice(0, 40))} is a link or junction`);
    if (!last && !info.isDirectory()) throw new WorkspaceError("invalid_path", `${JSON.stringify(name.slice(0, 40))} is not a directory`);
    if (last) {
      if (info.isDirectory()) exists = "directory";
      else if (info.isFile()) {
        if (options.forWrite === true && info.nlink > 1) throw new WorkspaceError("link_refused", `${JSON.stringify(name.slice(0, 40))} has another name elsewhere (a hard link), so writing it could change a file outside the workspace`);
        exists = "file";
      } else throw new WorkspaceError("invalid_path", `${JSON.stringify(name.slice(0, 40))} is not a plain file or directory`);
    }
    current = next;
  }
  const absolute = current;
  if (!within(realRoot, absolute)) throw new WorkspaceError("invalid_path", "the path leaves the workspace");
  return { absolute, parts, exists, parent: parts.length === 1 ? realRoot : absolute.slice(0, absolute.length - (parts[parts.length - 1]!.length + 1)) };
}

/** Flags for opening a file for reading or writing without following a link at the last name. */
export const NOFOLLOW = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;

/** Whether two stats are the same file (same device and inode). */
export const sameFile = (a: { dev: number | bigint; ino: number | bigint }, b: { dev: number | bigint; ino: number | bigint }): boolean => a.dev === b.dev && a.ino === b.ino;

void sep;
