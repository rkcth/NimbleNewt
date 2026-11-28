import { readFileSync } from "node:fs";
import { open, readFile, realpath, stat } from "node:fs/promises";
import { dirname, isAbsolute, join, parse, posix, relative, resolve } from "node:path";
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
 * let work there edit it). Folders are compared after `realpath` (symbolic links and `..` resolved), and also by identity (device and inode of every folder on the way up), so a second spelling of the
 * same folder (a case-folding file system, a second mount of the folder itself or of one above it) is the same folder. The way up is taken by path, so it does not lead from a bind mount back to the folder
 * it shows: on Linux the mount table (`/proc/self/mountinfo`) is read as well, and each folder is also placed by its file system and its path inside that file system, so a bind mount of a folder inside
 * the installation, a mount inside a checkout that shows the installation, and a mount inside the installation that shows a checkout are all caught. A repository's git folder (a `.git` file or link that
 * leads elsewhere, as a `git worktree` makes, and the common folder it names) is judged as one of its places, since git writes there. It fails closed: a place that cannot be read on this machine, a
 * guarded list that is empty, more places than it looks at, a folder deeper than it walks, a file system that gives no folder identity, or a Linux mount table that cannot be read are all "cannot tell",
 * which is not separate.
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
/** One mount of the mount table: its file system (`major:minor`), the folder of that file system it shows (`root`; not a path for a few kernel file systems, such as `mnt:[...]`) and where it is mounted (`point`). */
export interface MountEntry { readonly dev: string; readonly root: string; readonly point: string }
/**
 * The file-system calls the judge makes (tests give their own to show a bind mount or a failing disk). `mounts` gives the mount table, or `undefined` where there is none to read (not Linux); a failure
 * to read it throws. `readText` reads the start of a file (a repository's `.git` file). A port without `mounts` or `readText` skips that part of the check (tests that show only identities).
 */
export interface SeparationFs {
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ readonly dev: bigint; readonly ino: bigint }>;
  mounts?(): Promise<readonly MountEntry[] | undefined>;
  readText?(path: string, maxBytes: number): Promise<string>;
}
export const SEPARATE_LIMITS = { places: 50, guarded: 20, depth: 128, mounts: 50_000, mountTableBytes: 16 * 1024 * 1024 } as const;
export type Separation = { readonly separate: true } | { readonly separate: false; readonly detail: string };

const unescapeMount = (s: string): string => s.replace(/\\([0-7]{3})/g, (_, o: string) => String.fromCharCode(parseInt(o, 8)));
/** The mounts of a `/proc/self/mountinfo` text, in its order (a later mount at the same point is on top). Throws on a line it does not understand or past the limit. */
export function parseMountInfo(text: string): MountEntry[] {
  const out: MountEntry[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (out.length >= SEPARATE_LIMITS.mounts) throw new Error(`the mount table has more than ${SEPARATE_LIMITS.mounts} mounts`);
    const f = line.split(" ");
    if (f.length < 5 || !/^\d+:\d+$/.test(f[2]!) || f[3]! === "" || !f[4]!.startsWith("/")) throw new Error("the mount table has a line that could not be read");
    out.push({ dev: f[2]!, root: unescapeMount(f[3]!), point: unescapeMount(f[4]!) });
  }
  if (out.length === 0) throw new Error("the mount table is empty");
  return out;
}

export const nodeSeparationFs: SeparationFs = {
  realpath: (p) => realpath(p),
  stat: (p) => stat(p, { bigint: true }),
  mounts: async () => {
    if (process.platform !== "linux") return undefined;
    const text = await readFile("/proc/self/mountinfo", "utf8");
    if (text.length > SEPARATE_LIMITS.mountTableBytes) throw new Error("the mount table is too large");
    return parseMountInfo(text);
  },
  readText: async (p, maxBytes) => {
    const h = await open(p, "r");
    try { const buf = Buffer.alloc(maxBytes); const { bytesRead } = await h.read(buf, 0, maxBytes, 0); return buf.subarray(0, bytesRead).toString("utf8"); } finally { await h.close(); }
  },
};

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

/** Whether a `relative` result stays at or below its start (a folder named `..x` is below it; `..` and `../x` are not). */
const staysBelow = (r: string): boolean => r === "" || (r !== ".." && !r.startsWith("../") && !r.startsWith("..\\") && !isAbsolute(r));
/** Whether `inner` is `outer` or below it, comparing paths (case folded where the platform's file systems usually fold case). */
const lexicallyUnder = (inner: string, outer: string, platform: string): boolean => {
  const fold = platform === "win32" || platform === "darwin" ? (s: string) => s.toLowerCase() : (s: string) => s;
  return staysBelow(relative(fold(outer), fold(inner)));
};
/** `lexicallyUnder` for the paths of the mount table and of one file system (Linux: case kept, `/` separated). */
const posixUnder = (inner: string, outer: string): boolean => staysBelow(posix.relative(outer, inner));

/** Where a canonical path is in its file system: the mount it is under (the deepest; of several at one point, the last, which is on top) and the path inside that file system. */
interface FsLocation { readonly dev: string; readonly path: string }
function locate(mounts: readonly MountEntry[], canon: string): FsLocation {
  let best: MountEntry | undefined;
  for (const m of mounts) if (posixUnder(canon, m.point) && (best === undefined || m.point.length >= best.point.length)) best = m;
  if (best === undefined) throw new CannotTell("it is under no mount of the mount table");
  // A mount whose root is not a folder of a file system (`mnt:[...]`) gives no path to compare: the path stays as written, and `related` compares only paths.
  return { dev: best.dev, path: best.root.startsWith("/") ? posix.join(best.root, posix.relative(best.point, canon)) : best.root };
}
/** The mounts below a canonical folder (not at it), as file-system locations: what a folder holds besides its own file system. */
const mountsBelow = (mounts: readonly MountEntry[], canon: string): { point: string; at: FsLocation }[] =>
  mounts.filter((m) => m.point !== canon && posixUnder(m.point, canon)).map((m) => ({ point: m.point, at: { dev: m.dev, path: m.root } }));
/** Whether `a` is `b` or below it in one file system (only folder paths compare; `undefined` is not known). */
const fsUnder = (a: FsLocation | undefined, b: FsLocation | undefined): boolean => a !== undefined && b !== undefined && a.dev === b.dev && a.path.startsWith("/") && b.path.startsWith("/") && posixUnder(a.path, b.path);
const related = (a: FsLocation, b: FsLocation): boolean => fsUnder(a, b) || fsUnder(b, a);

/**
 * The extra places of a repository at `canon`: where git writes for it when that is not the folder itself. A `.git` link is followed; a `.git` file (a `git worktree`, a submodule) names its git folder,
 * and that folder's `commondir` names the common one (refs, objects, hooks and configuration shared with the main checkout). No `.git` at all: none. Anything else it cannot read: cannot tell.
 */
async function gitPlaces(fs: SeparationFs, canon: string): Promise<string[]> {
  if (fs.readText === undefined) return [];
  const read = fs.readText.bind(fs);
  const dotGit = join(canon, ".git");
  let text: string;
  try {
    text = await read(dotGit, 4096);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") return [];
    if (code === "EISDIR") return [dotGit];
    throw new CannotTell(`its .git could not be read${typeof code === "string" ? ` (${code})` : ""}`);
  }
  const named = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(text)?.[1];
  if (named === undefined) throw new CannotTell("its .git file does not name a git folder");
  const gitDir = resolve(canon, named);
  const out = [gitDir];
  try {
    const common = (await read(join(gitDir, "commondir"), 4096)).trim();
    if (common !== "") out.push(resolve(gitDir, common));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code !== "ENOENT") throw new CannotTell(`its git folder's commondir could not be read${typeof code === "string" ? ` (${code})` : ""}`);
  }
  return out;
}

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
  // The mount table (Linux): read once per judgement. Where there is none (another platform, or a port that does not give one) only identities and paths are compared.
  let mounts: readonly MountEntry[] | undefined;
  try {
    mounts = fs.mounts === undefined ? undefined : await fs.mounts();
  } catch (error) {
    return no(`the mount table of the controller's machine could not be read (${error instanceof Error ? error.message.slice(0, 120) : "failed"}), so the development project's checkout cannot be checked`);
  }
  type Guard = { what: string; path: string; canon: string; exists: boolean; ids: ReadonlySet<string>; self?: string; at?: FsLocation; holds: readonly { point: string; at: FsLocation }[] };
  const guards: Guard[] = [];
  for (const g of guarded) {
    if (typeof g.path !== "string" || !isAbsolute(g.path)) return no(`${g.what} is not given as a full path, so the development project's checkout cannot be checked against it`);
    try {
      const got = await guardOf(fs, g.path);
      const at = mounts === undefined ? undefined : locate(mounts, got.canon);
      guards.push({ what: g.what, path: g.path, canon: got.canon, exists: got.exists, ids: new Set(got.chain.map((c) => c.id)), ...(got.exists ? { self: got.chain[0]!.id } : {}), ...(at === undefined ? {} : { at }), holds: mounts === undefined || !got.exists ? [] : mountsBelow(mounts, got.canon) });
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
    // The place itself, then (a repository) the git folders it writes to elsewhere.
    const looks: { what: string; path: string }[] = [{ what: `the development project's ${name} at ${shown(p.locator)}`, path: resolve(p.locator) }];
    for (let i = 0; i < looks.length; i++) {
      const look = looks[i]!;
      let canon: string;
      let chain: readonly { path: string; id: string }[];
      let at: FsLocation | undefined;
      let holds: readonly { point: string; at: FsLocation }[] = [];
      try {
        canon = await fs.realpath(look.path);
        chain = await chainOf(fs, canon);
        if (mounts !== undefined) { at = locate(mounts, canon); holds = mountsBelow(mounts, canon); }
        if (i === 0 && p.kind === "repository") for (const extra of await gitPlaces(fs, canon)) looks.push({ what: `the git folder of the development project's ${name} (${shown(extra)})`, path: extra });
      } catch (error) {
        const code = (error as NodeJS.ErrnoException)?.code;
        return no(`${look.what} cannot be checked: ${error instanceof CannotTell ? error.message : `it could not be read on the controller's machine${typeof code === "string" ? ` (${code})` : ""}`}`);
      }
      const ids = new Set(chain.map((c) => c.id));
      for (const g of guards) {
        const same = (g.self !== undefined && g.self === chain[0]!.id) || (fsUnder(at, g.at) && fsUnder(g.at, at));
        const inside = (g.self !== undefined && ids.has(g.self)) || lexicallyUnder(canon, g.canon, platform) || fsUnder(at, g.at);
        const above = g.ids.has(chain[0]!.id) || lexicallyUnder(g.canon, canon, platform) || fsUnder(g.at, at);
        if (same || (inside && above)) return no(`${look.what} is the same folder as ${g.what} (${shown(g.path)}); bind a separate checkout`);
        if (inside) return no(`${look.what} is inside ${g.what} (${shown(g.path)}); bind a separate checkout`);
        if (above) return no(`${look.what} holds ${g.what} (${shown(g.path)}); bind a separate checkout`);
        // A mount inside the place that shows the guarded folder (or a folder above or inside it), and a mount inside the guarded folder that shows the place.
        const through = g.at === undefined ? undefined : holds.find((m) => related(m.at, g.at!));
        if (through !== undefined) return no(`${look.what} holds a mount (${shown(through.point)}) of ${g.what} (${shown(g.path)}) or of a folder above or inside it; bind a separate checkout`);
        const shows = at === undefined ? undefined : g.holds.find((m) => related(m.at, at!));
        if (shows !== undefined) return no(`${look.what} is mounted inside ${g.what} (${shown(g.path)}, at ${shown(shows.point)}); bind a separate checkout`);
      }
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

/**
 * The guarded places of a controller, from what builds it. Paths left out are not known to this controller (a PostgreSQL database has no file). A SQLite file brings its companions (`-wal`, `-shm`,
 * `-journal`), which may lie outside a data directory given apart from it. The artifact store and the backup folder are the controller's own records too: a checkout there could change or remove what a
 * check or a restore later reads back into the installation.
 */
export function installationGuards(o: { readonly programRoot: string; readonly runtime?: string; readonly dataDirectory?: string; readonly databaseFile?: string; readonly stateDirectory?: string; readonly releaseRoot?: string; readonly releaseIncoming?: string; readonly artifactDirectory?: string; readonly backupDirectory?: string }): GuardedPlace[] {
  const out: GuardedPlace[] = [{ what: "the running installation's program files", path: o.programRoot }];
  if (o.runtime !== undefined) out.push({ what: "the Node.js runtime the controller runs on", path: o.runtime });
  if (o.dataDirectory !== undefined) out.push({ what: "the controller's data directory", path: o.dataDirectory });
  if (o.databaseFile !== undefined) {
    out.push({ what: "the controller's database file", path: o.databaseFile });
    for (const suffix of ["-wal", "-shm", "-journal"]) out.push({ what: `the controller's database file's ${suffix.slice(1)} file`, path: `${o.databaseFile}${suffix}` });
  }
  if (o.stateDirectory !== undefined) out.push({ what: "the database transfer's state directory", path: o.stateDirectory });
  if (o.releaseRoot !== undefined) out.push({ what: "the release folder the launcher reads", path: o.releaseRoot });
  if (o.releaseIncoming !== undefined) out.push({ what: "the folder builds leave releases in", path: o.releaseIncoming });
  if (o.artifactDirectory !== undefined) out.push({ what: "the controller's artifact store", path: o.artifactDirectory });
  if (o.backupDirectory !== undefined) out.push({ what: "the controller's backup folder", path: o.backupDirectory });
  return out.map((g) => ({ what: g.what, path: isAbsolute(g.path) ? resolve(g.path) : g.path }));
}
