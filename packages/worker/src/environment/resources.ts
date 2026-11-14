import { lstat, readdir, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

/**
 * The host's named resources (card A09, mount application): a private directory `<root>` holding one sub-directory for each resource an agent's environment may mount, read-only, in its sandbox. The controller knows a resource only by its name;
 * the host path never leaves this class. A resource is mountable when it is a real directory directly inside the root (not a link, not reached through one), holds no link (symbolic or hard), device or other special file anywhere inside it, and is not larger than the
 * walk limit (a resource with more entries than that is refused rather than half-checked). The check is made when a mount is applied and again each time an attempt starts, because the directory can change in between.
 */
export const RESOURCE_NAME = /^[a-z][a-z0-9._-]{0,79}$/;
export const RESOURCE_WALK_LIMIT = 20_000;

export type ResourceCheck = { readonly ok: true; /** The real directory to mount. Used by the host only. */ readonly path: string } | { readonly ok: false; readonly reason: string };

export class LocalResourceStore {
  readonly #root: string;
  readonly #limit: number;
  constructor(root: string, options: { readonly walkLimit?: number } = {}) { this.#root = resolve(root); this.#limit = options.walkLimit ?? RESOURCE_WALK_LIMIT; }
  get root(): string { return this.#root; }

  async resolve(resource: string): Promise<ResourceCheck> {
    if (typeof resource !== "string" || !RESOURCE_NAME.test(resource)) return { ok: false, reason: "not a resource name" };
    let rootReal: string;
    try {
      const st = await lstat(this.#root);
      if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, reason: "the host's resource directory is not a real directory" };
      rootReal = await realpath(this.#root);
    } catch { return { ok: false, reason: "the host holds no resource directory" }; }
    const dir = join(rootReal, resource);
    let st;
    try { st = await lstat(dir); } catch { return { ok: false, reason: "the host holds no resource of that name" }; }
    if (st.isSymbolicLink() || !st.isDirectory()) return { ok: false, reason: "the resource is not a real directory" };
    let real: string;
    try { real = await realpath(dir); } catch { return { ok: false, reason: "the resource cannot be read" }; }
    if (real !== dir || !real.startsWith(rootReal + sep)) return { ok: false, reason: "the resource is not inside the host's resource directory" };
    let seen = 0;
    const walk = async (d: string): Promise<string | undefined> => {
      let names: string[];
      try { names = await readdir(d); } catch { return "the resource cannot be read"; }
      for (const name of names) {
        if (++seen > this.#limit) return `the resource holds more than ${this.#limit} entries, which is more than the host checks`;
        const child = join(d, name);
        let cs;
        try { cs = await lstat(child); } catch { return "the resource cannot be read"; }
        if (cs.isSymbolicLink()) return "the resource holds a link, which a mount does not follow";
        if (cs.isDirectory()) { const why = await walk(child); if (why !== undefined) return why; }
        else if (!cs.isFile()) return "the resource holds a file that is neither a plain file nor a directory";
        // A hard link is a plain file with a second name, which may be outside the resource directory: the mount would show that other file. Refused like a symbolic link.
        else if (cs.nlink > 1) return "the resource holds a file with more than one name (a hard link), which a mount does not take";
      }
      return undefined;
    };
    const why = await walk(real);
    return why === undefined ? { ok: true, path: real } : { ok: false, reason: why };
  }

  /** The controller-facing check: whether the resource can be mounted now, never a path. */
  async check(resource: string): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
    const r = await this.resolve(resource);
    return r.ok ? { ok: true } : { ok: false, reason: r.reason };
  }
}
