import { createHash } from "node:crypto";
import { readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { relativePath } from "../projects/resources.js";
import type { ManifestBody, Observation } from "./dependencies.js";

/**
 * What a resume check may read while it looks at a task's dependencies before the resumed attempt's first turn (card L04d).
 * - `entries` is how many dependencies of a task one probe reads; the rest are left unobserved, so they read `unknown`.
 * - `fileBytes` is the largest file it hashes; a larger one is left unobserved rather than guessed at or half read.
 * - `members` is the largest directory listing it returns; a bigger one is left unobserved, because a cut list would be
 *   reported as members come and gone.
 */
export const OBSERVE_LIMITS = { entries: 200, fileBytes: 8 * 1024 * 1024, members: 200 } as const;

/** The piece of the file system a probe needs. A host may supply its own (a sandboxed view, a test's memory tree). */
export interface ProbeFileSystem {
  /** The real location of a path, following links; throws `ENOENT` when it does not exist. */
  realpath(path: string): Promise<string>;
  stat(path: string): Promise<{ readonly isFile: () => boolean; readonly isDirectory: () => boolean; readonly size: number }>;
  readFile(path: string): Promise<Uint8Array>;
  readdir(path: string): Promise<readonly string[]>;
}

const nodeFileSystem: ProbeFileSystem = {
  realpath: (path) => realpath(path),
  stat: async (path) => { const s = await stat(path); return { isFile: () => s.isFile(), isDirectory: () => s.isDirectory(), size: s.size }; },
  readFile: (path) => readFile(path),
  readdir: async (path) => await readdir(path),
};

export interface DependencyObserverOptions {
  /** The task's recorded dependencies, or nothing when none were recorded (or the checker may not read the manifest). */
  manifest(taskId: string): Promise<ManifestBody | undefined>;
  /**
   * Where the task's checkout is on this machine, or nothing when it is nowhere this process can read. A probe only ever
   * looks inside what this returns; a dependency naming anything else is left unobserved.
   */
  locate(taskId: string, projectId: string): Promise<string | undefined> | string | undefined;
  /** How many dependencies one probe reads, and the largest file it hashes. Defaults: `OBSERVE_LIMITS`. */
  maxEntries?: number;
  maxBytes?: number;
  /** The file system to read. Default: this process's own. */
  fs?: ProbeFileSystem;
  /** Told of a fault that left something unobserved (an unreadable checkout, a file that could not be read); for the log, never the owner's text. */
  onFault?: (detail: string) => void;
}

/** Dependencies a probe can settle by looking: a file's content, a directory's members. */
const OBSERVED_KINDS: ReadonlySet<string> = new Set(["file", "directory"]);

/** Whether `target` is `root` or below it, on this platform's terms. */
const within = (root: string, target: string): boolean => {
  const rel = relative(root, target);
  return rel.length > 0 && !isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`);
};
const missing = (error: unknown): boolean => (error as { code?: unknown })?.code === "ENOENT" || (error as { code?: unknown })?.code === "ENOTDIR";
const fault = (options: DependencyObserverOptions, detail: string): void => { try { options.onFault?.(detail.slice(0, 300)); } catch { /* a failing log tells nothing */ } };

/**
 * The dependency probe a checked resume asks before the attempt it checks starts (card L04d). `DependencyService.check`
 * judges a file or a directory from an observation of it now; without one it says `unknown`, never "unchanged", so before
 * this card every recorded file of a resumed task waited on the owner. This reads each recorded file again under the task's
 * own checkout and hashes it, and lists each recorded directory's members, so the check says `unchanged`, `changed` or
 * `deleted` as it is.
 *
 * What it will not do:
 * - read outside the checkout the task's records name. A dependency key is text an agent wrote: anything that is not a safe
 *   relative path (absolute, drive-lettered, with `..`), or that resolves through a link to somewhere outside the checkout, is
 *   left unobserved rather than read.
 * - guess. A file too large to read, a directory too large to list, an entry beyond the cap, and anything the probe could not
 *   read are left out of its answer, which is the same as not looking: the check says `unknown`.
 * - settle a `search` (that needs the search made again) or an `external` or `mcp-resource` dependency (that needs a
 *   conditional read of the thing itself), or a `record`, `decision`, `tool-version` or `environment` dependency, which the
 *   controller already judges from its own records. Those are left to the ports a host supplies.
 *
 * It never throws: a checkout that is gone, a disk that will not read, a manifest that cannot be looked up all leave
 * dependencies unobserved, which the check reads as what it is — unknown, and the owner decides.
 */
export function checkoutDependencyObserver(options: DependencyObserverOptions): (taskId: string) => Promise<Readonly<Record<string, Observation>>> {
  const limit = options.maxEntries === undefined || !Number.isSafeInteger(options.maxEntries) || options.maxEntries < 0 ? OBSERVE_LIMITS.entries : options.maxEntries;
  const maxBytes = options.maxBytes === undefined || !Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0 ? OBSERVE_LIMITS.fileBytes : options.maxBytes;
  const fileSystem = options.fs ?? nodeFileSystem;
  return async (taskId: string): Promise<Readonly<Record<string, Observation>>> => {
    const out: Record<string, Observation> = {};
    let manifest: ManifestBody | undefined;
    try { manifest = await options.manifest(taskId); } catch (error) { fault(options, `the manifest of ${taskId} could not be read: ${messageOf(error)}`); return out; }
    const wanted = (manifest?.entries ?? []).filter((e) => OBSERVED_KINDS.has(e.kind)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
    if (wanted.length === 0) return out;
    let root: string | undefined;
    try { root = await options.locate(taskId, manifest!.projectId); } catch (error) { fault(options, `the checkout of ${taskId} could not be found: ${messageOf(error)}`); return out; }
    if (root === undefined || !isAbsolute(root)) return out; // nowhere to look: everything stays unknown
    let base: string;
    try { base = await fileSystem.realpath(root); } catch (error) { fault(options, `the checkout ${root} could not be read: ${messageOf(error)}`); return out; }
    for (const entry of wanted) {
      const key = relativePath(entry.key);
      if (key === undefined) continue; // not a path below the checkout: nothing is looked at, so nothing is claimed
      const target = resolve(join(base, key));
      if (!within(base, target)) continue;
      let real: string;
      try { real = await fileSystem.realpath(target); } catch (error) {
        if (missing(error)) out[entry.id] = { exists: false }; // it is gone: the check says so
        else fault(options, `${key}: ${messageOf(error)}`);
        continue;
      }
      if (!within(base, real)) { fault(options, `${key} is a link to outside the checkout`); continue; }
      try {
        if (entry.kind === "directory") {
          const info = await fileSystem.stat(real);
          if (!info.isDirectory()) { fault(options, `${key} is not a directory now`); continue; }
          const names = await fileSystem.readdir(real);
          if (names.length > OBSERVE_LIMITS.members) { fault(options, `${key} holds more names than a listing carries`); continue; }
          out[entry.id] = { exists: true, members: [...names].sort() };
          continue;
        }
        const info = await fileSystem.stat(real);
        if (!info.isFile()) { fault(options, `${key} is not a file now`); continue; }
        if (info.size > maxBytes) { fault(options, `${key} is bigger than a probe reads`); continue; }
        out[entry.id] = { exists: true, hash: createHash("sha256").update(await fileSystem.readFile(real)).digest("hex") };
      } catch (error) {
        if (missing(error)) out[entry.id] = { exists: false }; // taken away between the look and the read
        else fault(options, `${key}: ${messageOf(error)}`);
      }
    }
    return out;
  };
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);
