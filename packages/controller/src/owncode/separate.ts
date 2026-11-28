import { readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Card B06, third slice: the NimbleNewt development project works in its OWN checkout, never in the files of the running installation.
 *
 * The controller knows two sets of places:
 * - the places the development project would work in, from its records alone (`OwnPlace`): its bound resources (a bound repository's location is the folder a worker host's shared tree must be, card P02)
 *   and the repositories its project record lists;
 * - the places it must never be (`GuardedPlace`): where the running installation's program files are, the Node.js runtime it runs on, its data directory and database file, the transfer state directory
 *   and the release folders (card K02). They are given by the code that builds the controller (`installationGuards`), never by a caller.
 *
 * `judgeSeparate` says whether every local place of the project is apart from every guarded place: not the same folder, not inside one, and not above one (a checkout that holds the installation would
 * let work there edit it). Folders are compared after `realpath` (symbolic links and `..` resolved), and also by identity (device and inode of every folder on the way up), so a bind mount or a second
 * spelling of the same folder (a case-folding file system) is the same folder. It fails closed: a place that cannot be read on this machine, a guarded list that is empty, more places than it looks at, a
 * folder deeper than it walks, or a file system that gives no folder identity are all "cannot tell", which is not separate.
 *
 * The detail names the place and the guarded folder; it is for the owner only. Anyone else is told only that the checkout could not be confirmed separate (`OWNCODE_CHECKOUT_REFUSED`), so the answer
 * says nothing about which folders exist on the controller's machine.
 */
export interface OwnPlace {
  /** The binding's label (or the repository's ID), as the project's records give it. */
  readonly label: string;
  /** `repository` for a checkout; any other resource kind (an output folder, a document) is judged only when its location is a local path. */
  readonly kind: string;
  readonly locator: string;
  /** The binding gives write access (a checkout an agent works in). */
  readonly write: boolean;
}
export interface GuardedPlace {
  /** What it is, in plain words ("the running installation's program files"). */
  readonly what: string;
  readonly path: string;
}
/** The two file-system calls the judge makes (tests give their own to show a bind mount or a failing disk). */
export interface SeparationFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ readonly dev: bigint; readonly ino: bigint }>;
}
export const SEPARATE_LIMITS = { places: 50, guarded: 20, depth: 128 } as const;
export type Separation = { readonly separate: true } | { readonly separate: false; readonly detail: string };

export const nodeSeparationFs: SeparationFs = { realpath: (p) => realpath(p), stat: (p) => stat(p, { bigint: true }) };

const no = (detail: string): Separation => ({ separate: false, detail: detail.slice(0, 400) });
const shown = (s: string, max = 120): string => (s.length <= max ? s : `${s.slice(0, max - 3)}...`);
class CannotTell extends Error {}

/** The folders from `path` up to the root of its file system, each with its identity. `path` must be canonical (from `realpath`). */
async function chainOf(fs: SeparationFs, path: string): Promise<{ readonly path: string; readonly id: string }[]> {
  const out: { path: string; id: string }[] = [];
  for (let at = path; ; at = dirname(at)) {
    if (out.length >= SEPARATE_LIMITS.depth) throw new CannotTell(`it is more than ${SEPARATE_LIMITS.depth} folders deep`);
    const s = await fs.stat(at);
    // A file system that gives no identity (inode 0) cannot tell a second spelling of a folder from another folder.
    if (s.ino === 0n) throw new CannotTell("its file system gives no folder identity");
    out.push({ path: at, id: `${s.dev}:${s.ino}` });
    if (dirname(at) === at) return out;
  }
}

/** A guarded place as it stands: its canonical path and its chain. One that does not exist (yet) is placed under its nearest existing folder, and only that folder's chain is known. */
async function guardOf(fs: SeparationFs, path: string): Promise<{ readonly canon: string; readonly exists: boolean; readonly chain: readonly { readonly path: string; readonly id: string }[] }> {
  let at = resolve(path);
  const rest: string[] = [];
  for (let i = 0; ; i++) {
    if (i >= SEPARATE_LIMITS.depth) throw new CannotTell(`it is more than ${SEPARATE_LIMITS.depth} folders deep`);
    try {
      const real = await fs.realpath(at);
      const chain = await chainOf(fs, real);
      return { canon: rest.length === 0 ? real : join(real, ...rest.reverse()), exists: rest.length === 0, chain };
    } catch (error) {
      if (error instanceof CannotTell) throw error;
      const code = (error as NodeJS.ErrnoException)?.code;
      if ((code !== "ENOENT" && code !== "ENOTDIR") || dirname(at) === at) throw new CannotTell(`it could not be read${typeof code === "string" ? ` (${code})` : ""}`);
      rest.push(parse(at).base);
      at = dirname(at);
    }
  }
}

/** Whether `inner` is `outer` or below it, comparing paths (case folded where the platform's file systems usually fold case). */
const lexicallyUnder = (inner: string, outer: string, platform: string): boolean => {
  const fold = platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s;
  const r = relative(fold(outer), fold(inner));
  return r === "" || (!r.startsWith("..") && !isAbsolute(r));
};

/**
 * Whether the development project's places are all apart from the guarded places (see the module comment). The project must have its own checkout: at least one bound repository it may write in, at a
 * folder on this machine. A repository at a location that is not a local path (an address, a name) cannot be checked here and is refused; any other resource whose location is not a local path is not a
 * folder at all and is not judged.
 */
export async function judgeSeparate(places: readonly OwnPlace[] | "too-many", guarded: readonly GuardedPlace[], o: { readonly fs?: SeparationFs; readonly platform?: string } = {}): Promise<Separation> {
  const fs = o.fs ?? nodeSeparationFs;
  const platform = o.platform ?? process.platform;
  if (places === "too-many" || places.length > SEPARATE_LIMITS.places) return no(`the development project has more than ${SEPARATE_LIMITS.places} places to check; remove the bindings it does not need`);
  if (guarded.length === 0 || guarded.length > SEPARATE_LIMITS.guarded) return no("this controller was not told where the running installation is, so it cannot tell whether the development project's checkout is apart from it");
  if (!places.some((p) => p.kind === "repository" && p.write && isAbsolute(p.locator))) return no("the development project has no checkout of its own: bind a separate checkout of NimbleNewt's source to it as a repository with write access (resource.bind)");
  const guards: { what: string; path: string; canon: string; exists: boolean; ids: ReadonlySet<string>; self?: string }[] = [];
  for (const g of guarded) {
    if (typeof g.path !== "string" || !isAbsolute(g.path)) return no(`${g.what} is not given as a full path, so the development project's checkout cannot be checked against it`);
    try {
      const got = await guardOf(fs, g.path);
      guards.push({ what: g.what, path: g.path, canon: got.canon, exists: got.exists, ids: new Set(got.chain.map((c) => c.id)), ...(got.exists ? { self: got.chain[0]!.id } : {}) });
    } catch (error) {
      return no(`${g.what} (${shown(g.path)}) cannot be checked: ${error instanceof CannotTell ? error.message : "it could not be read"}`);
    }
  }
  for (const p of places) {
    const name = `${p.kind === "repository" ? "repository" : p.kind} "${shown(p.label, 80)}"`;
    if (!isAbsolute(p.locator)) {
      if (p.kind === "repository") return no(`the development project's ${name} is at ${shown(p.locator)}, which is not a folder on the controller's machine, so it cannot be checked; bind a local checkout instead`);
      continue;
    }
    let canon: string;
    let chain: readonly { path: string; id: string }[];
    try {
      canon = await fs.realpath(resolve(p.locator));
      chain = await chainOf(fs, canon);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException)?.code;
      return no(`the development project's ${name} at ${shown(p.locator)} cannot be checked: ${error instanceof CannotTell ? error.message : `it could not be read on the controller's machine${typeof code === "string" ? ` (${code})` : ""}`}`);
    }
    const ids = new Set(chain.map((c) => c.id));
    for (const g of guards) {
      const same = g.self !== undefined && g.self === chain[0]!.id;
      const inside = (g.self !== undefined && ids.has(g.self)) || lexicallyUnder(canon, g.canon, platform);
      const above = g.ids.has(chain[0]!.id) || lexicallyUnder(g.canon, canon, platform);
      if (same || (inside && above)) return no(`the development project's ${name} at ${shown(p.locator)} is the same folder as ${g.what} (${shown(g.path)}); bind a separate checkout`);
      if (inside) return no(`the development project's ${name} at ${shown(p.locator)} is inside ${g.what} (${shown(g.path)}); bind a separate checkout`);
      if (above) return no(`the development project's ${name} at ${shown(p.locator)} holds ${g.what} (${shown(g.path)}); bind a separate checkout`);
    }
  }
  return { separate: true };
}

/**
 * The folder the running controller's program files are in: the workspace root of the source tree or release it runs from (the nearest folder above this package, at most four up, whose `package.json`
 * declares workspaces), or this package's own folder when there is none. Read once, synchronously, when the controller is built.
 */
export function programRoot(moduleUrl: string = import.meta.url): string {
  // This file is `<package>/dist/owncode/separate.js` (or `src/owncode/separate.ts`): the package is two folders up.
  const pkg = resolve(dirname(fileURLToPath(moduleUrl)), "..", "..");
  let at = pkg;
  for (let i = 0; i < 4; i++) {
    const up = dirname(at);
    if (up === at) break;
    at = up;
    try {
      const manifest = JSON.parse(readFileSync(join(at, "package.json"), "utf8")) as { workspaces?: unknown };
      if (manifest !== null && typeof manifest === "object" && manifest.workspaces !== undefined) return at;
    } catch { /* no package.json here, or not readable: go on up */ }
  }
  return pkg;
}

/** The guarded places of a controller, from what builds it. Paths left out are not known to this controller (a PostgreSQL database has no file). */
export function installationGuards(o: { readonly programRoot: string; readonly runtime?: string; readonly dataDirectory?: string; readonly databaseFile?: string; readonly stateDirectory?: string; readonly releaseRoot?: string; readonly releaseIncoming?: string }): GuardedPlace[] {
  const out: GuardedPlace[] = [{ what: "the running installation's program files", path: o.programRoot }];
  if (o.runtime !== undefined) out.push({ what: "the Node.js runtime the controller runs on", path: o.runtime });
  if (o.dataDirectory !== undefined) out.push({ what: "the controller's data directory", path: o.dataDirectory });
  if (o.databaseFile !== undefined) out.push({ what: "the controller's database file", path: o.databaseFile });
  if (o.stateDirectory !== undefined) out.push({ what: "the database transfer's state directory", path: o.stateDirectory });
  if (o.releaseRoot !== undefined) out.push({ what: "the release folder the launcher reads", path: o.releaseRoot });
  if (o.releaseIncoming !== undefined) out.push({ what: "the folder builds leave releases in", path: o.releaseIncoming });
  return out.map((g) => ({ what: g.what, path: isAbsolute(g.path) ? resolve(g.path) : g.path }));
}
