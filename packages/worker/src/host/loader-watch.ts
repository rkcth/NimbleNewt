import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, opendir, readlink, stat } from "node:fs/promises";
import { join } from "node:path";

/*
 * Card U11d: the protected loader configuration (the controller-owned, read-only extensions the worker loads, which an agent may not write, replace or link) is looked at when an attempt's sandbox opens, after
 * each of its turns and when it closes. The look is by content: what is on the disk is fingerprinted (type, and a digest of every file's bytes and every link's target), so a write, a deletion, a new entry or a
 * replacement by a link is a change however it was made. A path the embedder names that is itself a link (a deployment's `current` link) is looked at through it too: its target text and what it points to are both
 * fingerprinted; links further down are never followed (so a loop of links cannot be walked). What it cannot see: a change that was put back before the next look, a replacement by a file with the same bytes (nothing
 * the loader would read differs), and the mode bits. A look that meets an error (a file gone while it was read, no permission) or a tree beyond the bounds says nothing: it never guesses. The bounds hold while the
 * tree changes under the look: a folder is read entry by entry and given up past the entry bound, and a file is read only up to the byte bound (a file that grows while it is read is given up, not read in full).
 */

export type LoaderPathType = "absent" | "file" | "dir" | "link" | "other";
export interface LoaderPathState { readonly type: LoaderPathType; readonly digest: string }
export type LoaderChange = "linked" | "removed" | "added" | "changed";

export const LOADER_LOOK_LIMITS = { entries: 2000, bytes: 64 * 1024 * 1024 } as const;
const sha = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");
const CHUNK = 1024 * 1024;
/** Opened without following a link and without waiting (a file swapped for a pipe between the type check and the open is not waited on); the flags a system lacks are left out. */
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/** One fingerprint per path, in the order given; `undefined` when the paths could not be read in full (nothing is then claimed). */
export async function lookAtLoaderConfig(paths: readonly string[], limits: { readonly entries: number; readonly bytes: number } = LOADER_LOOK_LIMITS): Promise<readonly LoaderPathState[] | undefined> {
  let entries = 0;
  let bytes = 0;
  /** The digest of a file's bytes, read at most up to what is left of the byte bound; `undefined` past it. */
  const fileDigest = async (path: string, follow: boolean): Promise<string | undefined> => {
    const handle = await open(path, follow ? READ_FLAGS & ~(constants.O_NOFOLLOW ?? 0) : READ_FLAGS);
    try {
      if (!(await handle.stat()).isFile()) return undefined;
      const h = createHash("sha256");
      const buffer = Buffer.allocUnsafe(CHUNK);
      for (;;) {
        const { bytesRead } = await handle.read(buffer, 0, CHUNK, null);
        if (bytesRead === 0) break;
        bytes += bytesRead;
        if (bytes > limits.bytes) return undefined;
        h.update(buffer.subarray(0, bytesRead));
      }
      return h.digest("hex");
    } finally { await handle.close(); }
  };
  const walk = async (path: string, top: boolean): Promise<LoaderPathState | undefined> => {
    let info;
    try { info = await lstat(path); } catch (error) { return top && (error as NodeJS.ErrnoException).code === "ENOENT" ? { type: "absent", digest: "" } : undefined; }
    if (++entries > limits.entries) return undefined;
    if (info.isSymbolicLink()) {
      const target = await readlink(path);
      if (!top) return { type: "link", digest: sha(`l\0${target}`) };
      // A named path that is a link is looked at through it (once: the walk below never follows a link again).
      let through: LoaderPathState | undefined;
      let targetInfo;
      try { targetInfo = await stat(path); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return undefined; }
      if (targetInfo === undefined) through = { type: "absent", digest: "" };
      else through = await contentOf(path, targetInfo, true);
      if (through === undefined) return undefined;
      return { type: "link", digest: sha(`l\0${target}\0${through.type}\0${through.digest}`) };
    }
    return contentOf(path, info, false);
  };
  const contentOf = async (path: string, info: { isFile(): boolean; isDirectory(): boolean; readonly mode: number }, follow: boolean): Promise<LoaderPathState | undefined> => {
    if (info.isFile()) {
      const digest = await fileDigest(path, follow);
      return digest === undefined ? undefined : { type: "file", digest: sha(`f\0${digest}`) };
    }
    if (info.isDirectory()) {
      const names: string[] = [];
      const folder = await opendir(path);
      // Leaving the loop early closes the folder.
      for await (const one of folder) {
        names.push(one.name);
        // Each name costs an entry when it is walked: more names than the bound has left is given up before they are all held.
        if (entries + names.length > limits.entries) return undefined;
      }
      names.sort();
      const h = createHash("sha256");
      for (const name of names) {
        const inner = await walk(join(path, name), false);
        if (inner === undefined) return undefined;
        h.update(`${inner.type}\0${name}\0${inner.digest}\n`);
      }
      return { type: "dir", digest: h.digest("hex") };
    }
    return { type: "other", digest: sha(`o\0${info.mode}`) };
  };
  try {
    const out: LoaderPathState[] = [];
    for (const path of paths) { const one = await walk(path, true); if (one === undefined) return undefined; out.push(one); }
    return out;
  } catch { return undefined; }
}

/** What differs between two looks at the same paths, as the most serious kind (a link put in place, then a removal, an addition, any other change), or `undefined` when nothing does. */
export function loaderChange(before: readonly LoaderPathState[], after: readonly LoaderPathState[]): { readonly change: LoaderChange; readonly key: string } | undefined {
  if (before.length !== after.length) return undefined;
  let worst: { rank: number; change: LoaderChange; key: string } | undefined;
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!, a = after[i]!;
    if (b.type === a.type && b.digest === a.digest) continue;
    const change: LoaderChange = a.type === "link" && b.type !== "link" ? "linked" : b.type !== "absent" && a.type === "absent" ? "removed" : b.type === "absent" ? "added" : "changed";
    const rank = { linked: 4, removed: 3, added: 2, changed: 1 }[change];
    if (worst === undefined || rank > worst.rank) worst = { rank, change, key: `loader:${change}:${sha(`${i}|${change}|${b.type}|${b.digest}|${a.type}|${a.digest}`).slice(0, 24)}` };
  }
  return worst === undefined ? undefined : { change: worst.change, key: worst.key };
}
