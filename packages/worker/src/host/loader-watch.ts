import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink } from "node:fs/promises";
import { join } from "node:path";

/*
 * Card U11d: the protected loader configuration (the controller-owned, read-only extensions the worker loads, which an agent may not write, replace or link) is looked at when an attempt's sandbox opens, after
 * each of its turns and when it closes. The look is by content: what is on the disk is fingerprinted (type, and a digest of every file's bytes and every link's target), so a write, a deletion, a new entry or a
 * replacement by a link is a change however it was made. What it cannot see: a change that was put back before the next look, a replacement by a file with the same bytes (nothing the loader would read differs),
 * and the mode bits. A look that meets an error (a file gone while it was read, no permission) or a tree beyond the bounds says nothing: it never guesses.
 */

export type LoaderPathType = "absent" | "file" | "dir" | "link" | "other";
export interface LoaderPathState { readonly type: LoaderPathType; readonly digest: string }
export type LoaderChange = "linked" | "removed" | "added" | "changed";

export const LOADER_LOOK_LIMITS = { entries: 2000, bytes: 64 * 1024 * 1024 } as const;
const sha = (data: Uint8Array | string): string => createHash("sha256").update(data).digest("hex");

/** One fingerprint per path, in the order given; `undefined` when the paths could not be read in full (nothing is then claimed). */
export async function lookAtLoaderConfig(paths: readonly string[], limits: { readonly entries: number; readonly bytes: number } = LOADER_LOOK_LIMITS): Promise<readonly LoaderPathState[] | undefined> {
  let entries = 0;
  let bytes = 0;
  const walk = async (path: string, top: boolean): Promise<LoaderPathState | undefined> => {
    let info;
    try { info = await lstat(path); } catch (error) { return top && (error as NodeJS.ErrnoException).code === "ENOENT" ? { type: "absent", digest: "" } : undefined; }
    if (++entries > limits.entries) return undefined;
    if (info.isSymbolicLink()) return { type: "link", digest: sha(`l\0${await readlink(path)}`) };
    if (info.isFile()) {
      bytes += info.size;
      if (bytes > limits.bytes) return undefined;
      return { type: "file", digest: sha(`f\0${sha(await readFile(path))}`) };
    }
    if (info.isDirectory()) {
      const h = createHash("sha256");
      const names = (await readdir(path)).sort();
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
