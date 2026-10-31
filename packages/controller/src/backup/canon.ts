import { lstat, readlink, realpath } from "node:fs/promises";
import { lstatSync, readlinkSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** An absolute path with every link in its existing part resolved: the one spelling the marker stores and compares, so a relative data directory or a link cannot make the same place look like two. A link that dangles is followed to where it points. */
export async function canon(p: string, depth = 0): Promise<string> {
  const r = resolve(p);
  try { return await realpath(r); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    const info = await lstat(r).catch(() => undefined);
    if (info?.isSymbolicLink() === true && depth < 40) return canon(resolve(dirname(r), await readlink(r)), depth + 1);
    const parent = dirname(r);
    return parent === r ? r : join(await canon(parent, depth), basename(r));
  }
}
/** `canon`, synchronously (the NATIVE realpath, like `fs.promises.realpath`: the JS one keeps 8.3 short names such as RUNNER~1 on Windows, so the two spellings of one place would differ and the marker check would refuse a good restore). (The restore asks for a store's place from a synchronous callback). */
export function canonSync(p: string, depth = 0): string {
  const r = resolve(p);
  try { return realpathSync.native(r); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
    let link = false;
    try { link = lstatSync(r).isSymbolicLink(); } catch { /* not there */ }
    if (link && depth < 40) return canonSync(resolve(dirname(r), readlinkSync(r)), depth + 1);
    const parent = dirname(r);
    return parent === r ? r : join(canonSync(parent, depth), basename(r));
  }
}
