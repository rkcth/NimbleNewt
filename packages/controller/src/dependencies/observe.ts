import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, opendir, readlink, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { redactText } from "../security/redact.js";
import { relativePath, scopeAllows } from "../projects/resources.js";
import type { ManifestBody, Observation } from "./dependencies.js";

/**
 * What a resume check may read while it looks at a task's dependencies before the resumed attempt's first turn (card L04d).
 * - `entries` is how many dependencies of a task one probe reads; the rest are left unobserved, so they read `unknown`.
 * - `fileBytes` is the largest file it hashes; a larger one is left unobserved rather than guessed at or half read.
 * - `totalBytes` is how much one probe reads in all; the files after that are left unobserved.
 * - `members` is the largest directory listing it returns; a bigger one is left unobserved, because a cut list would be
 *   reported as members come and gone.
 * - `ms` is how long one probe may take in all (a disk or network mount that hangs); what is not read by then is unobserved.
 */
export const OBSERVE_LIMITS = { entries: 200, fileBytes: 8 * 1024 * 1024, totalBytes: 64 * 1024 * 1024, members: 200, ms: 15_000 } as const;

/** One file read by a probe: its bytes, or why there are none. `where` is the path the open descriptor really names, when the platform can tell. */
export type ProbeRead = { readonly kind: "file"; readonly bytes: Uint8Array; readonly where?: string } | { readonly kind: "not-file" } | { readonly kind: "too-big" };
/** One directory listed by a probe: its names, or why there are none. */
export type ProbeList = { readonly kind: "directory"; readonly names: readonly string[] } | { readonly kind: "not-directory" } | { readonly kind: "too-wide" };

/** The piece of the file system a probe needs. A host may supply its own (a sandboxed view, a test's memory tree). */
export interface ProbeFileSystem {
  /** The real location of a path, following links; throws `ENOENT` when it does not exist. */
  realpath(path: string): Promise<string>;
  /**
   * Reads a regular file at a path that has no link in it, at most `maxBytes` of it. It must not open anything that is not a
   * regular file (a pipe would block, a device may act on being opened), must not follow a link that appeared since the path
   * was resolved, and must not read past `maxBytes + 1` whatever the file's size says.
   */
  readFile(path: string, maxBytes: number): Promise<ProbeRead>;
  /** Lists a directory at a path that has no link in it, reading at most `maxNames + 1` names. */
  readdir(path: string, maxNames: number): Promise<ProbeList>;
}

const NO_FOLLOW = (constants as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;
const NO_BLOCK = (constants as { O_NONBLOCK?: number }).O_NONBLOCK ?? 0;
const moved = (path: string): Error => Object.assign(new Error(`${path} moved while it was read`), { code: "EMOVED" });

/** Where an open descriptor really is, on a platform that says so (Linux's `/proc/self/fd`); `undefined` elsewhere. */
const descriptorPath = async (fd: number): Promise<string | undefined> => {
  if (process.platform !== "linux") return undefined;
  try { return await readlink(`/proc/self/fd/${fd}`); } catch { return undefined; }
};

/** This process's own file system, as a probe reads it. */
export const nodeProbeFileSystem: ProbeFileSystem = {
  realpath: (path) => realpath(path),
  async readFile(path, maxBytes) {
    // Looked at before it is opened: a pipe, a socket or a device is never opened at all.
    if (!(await stat(path)).isFile()) return { kind: "not-file" };
    const handle = await open(path, constants.O_RDONLY | NO_FOLLOW | NO_BLOCK);
    try {
      const info = await handle.stat();
      if (!info.isFile()) return { kind: "not-file" }; // swapped between the look and the open
      if (info.size > maxBytes) return { kind: "too-big" };
      const buffer = Buffer.alloc(Math.min(maxBytes, info.size) + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > maxBytes) return { kind: "too-big" }; // it grew while it was read
        if (length === buffer.length) break;
      }
      // It grew or shrank while it was read: what was read is part of one version and part of another (or a cut-off prefix), never the file.
      if (length !== info.size) throw moved(path);
      const where = await descriptorPath(handle.fd);
      // A part of the path swapped for a link while it was opened: the path no longer names what was read.
      if ((await realpath(path)) !== path) throw moved(path);
      const now = await stat(path);
      if (now.ino !== info.ino || now.dev !== info.dev) throw moved(path);
      return { kind: "file", bytes: buffer.subarray(0, length), ...(where === undefined ? {} : { where }) };
    } finally { await handle.close(); }
  },
  async readdir(path, maxNames) {
    if (!(await stat(path)).isDirectory()) return { kind: "not-directory" };
    const dir = await opendir(path, { bufferSize: 32 });
    const names: string[] = [];
    try {
      for (let entry = await dir.read(); entry !== null; entry = await dir.read()) {
        names.push(entry.name);
        if (names.length > maxNames) return { kind: "too-wide" };
      }
    } finally { await dir.close().catch(() => undefined); }
    if ((await realpath(path)) !== path) throw moved(path);
    return { kind: "directory", names };
  },
};

/** Where a task's checkout is, and which paths below it the task's project may use (none named: all of it). */
export type ProbeLocation = string | { readonly root: string; readonly paths?: readonly string[] };

export interface DependencyObserverOptions {
  /** The task's recorded dependencies, or nothing when none were recorded (or the checker may not read the manifest). */
  manifest(taskId: string): Promise<ManifestBody | undefined>;
  /**
   * Where the task's checkout is on this machine, or nothing when it is nowhere this process can read. A probe only ever
   * looks inside what this returns, and only at the paths it names when it names some; a dependency naming anything else is
   * left unobserved.
   */
  locate(taskId: string, projectId: string): Promise<ProbeLocation | undefined> | ProbeLocation | undefined;
  /** How many dependencies one probe reads, the largest file it hashes, how much it reads in all and how long it may take. Defaults: `OBSERVE_LIMITS`. */
  maxEntries?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  /** The file system to read. Default: this process's own. */
  fs?: ProbeFileSystem;
  /** Told of a fault that left something unobserved (an unreadable checkout, a file that could not be read); for the log, never the owner's text. Already redacted and cut. */
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
const fault = (options: DependencyObserverOptions, detail: string): void => { try { options.onFault?.(redactText(detail).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 300)); } catch { /* a failing log tells nothing */ } };
const bound = (value: number | undefined, fallback: number): number => (value === undefined || !Number.isSafeInteger(value) || value < 0 ? fallback : value);

class ProbeTimeout extends Error {}

/**
 * The dependency probe a checked resume asks before the attempt it checks starts (card L04d). `DependencyService.check`
 * judges a file or a directory from an observation of it now; without one it says `unknown`, never "unchanged", so before
 * this card every recorded file of a resumed task waited on the owner. This reads each recorded file again under the
 * checkout the task's repository is bound at and hashes it, and lists each recorded directory's members, so the check says
 * `unchanged`, `changed` or `deleted` as it is.
 *
 * What it will not do:
 * - read outside the checkout the task's records name, or outside the paths its project may use there. A dependency key is
 *   text an agent wrote: anything that is not a safe relative path (absolute, drive-lettered, with `..`), that lies outside the
 *   project's scope, or that resolves through a link to somewhere outside the checkout, is left unobserved rather than read.
 *   A file is opened only when it is a regular file, never through a link that appeared after the path was resolved, and
 *   what was read is kept only while the path still names it.
 * - guess. A file too large to read, a directory too large to list, an entry beyond the cap, a read past the total byte or
 *   time bound, and anything the probe could not read are left out of its answer, which is the same as not looking: the
 *   check says `unknown`.
 * - settle a `search` (that needs the search made again) or an `external` or `mcp-resource` dependency (that needs a
 *   conditional read of the thing itself), or a `record`, `decision`, `tool-version` or `environment` dependency, which the
 *   controller already judges from its own records. Those are left to the ports a host supplies.
 *
 * It never throws: a checkout that is gone, a disk that will not read, a manifest that cannot be looked up all leave
 * dependencies unobserved, which the check reads as what it is — unknown, and the owner decides.
 */
export function checkoutDependencyObserver(options: DependencyObserverOptions): (taskId: string) => Promise<Readonly<Record<string, Observation>>> {
  const limit = bound(options.maxEntries, OBSERVE_LIMITS.entries);
  const maxBytes = bound(options.maxBytes, OBSERVE_LIMITS.fileBytes);
  const maxTotal = bound(options.maxTotalBytes, OBSERVE_LIMITS.totalBytes);
  const timeoutMs = bound(options.timeoutMs, OBSERVE_LIMITS.ms);
  const fileSystem = options.fs ?? nodeProbeFileSystem;
  // File-system calls an earlier probe gave up on that have still not come back. Node runs them on a small shared thread pool, so a
  // mount that hangs would take one more thread at every probe until the whole process's file work stalls: while one is still out,
  // no probe starts another call, and everything is left unobserved.
  let hung = 0;
  return async (taskId: string): Promise<Readonly<Record<string, Observation>>> => {
    const out: Record<string, Observation> = {};
    const deadline = Date.now() + timeoutMs;
    // One file-system call, cut off at the probe's deadline. A call that hangs past it is abandoned: what it would have said is not used.
    const timed = async <T>(start: () => Promise<T>): Promise<T> => {
      if (hung > 0 || deadline - Date.now() <= 0) throw new ProbeTimeout();
      const step = start();
      const left = deadline - Date.now();
      let timer: ReturnType<typeof setTimeout> | undefined;
      let late = false;
      try {
        return await Promise.race([step, new Promise<never>((_, reject) => { timer = setTimeout(() => { late = true; reject(new ProbeTimeout()); }, Math.max(0, left)); })]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
        if (late) { hung++; step.then(() => { hung--; }, () => { hung--; }); } else step.catch(() => undefined);
      }
    };
    let manifest: ManifestBody | undefined;
    try { manifest = await options.manifest(taskId); } catch (error) { fault(options, `the manifest of ${taskId} could not be read: ${messageOf(error)}`); return out; }
    const wanted = (manifest?.entries ?? []).filter((e) => OBSERVED_KINDS.has(e.kind)).sort((a, b) => (a.id < b.id ? -1 : 1)).slice(0, limit);
    if (wanted.length === 0) return out;
    let located: ProbeLocation | undefined;
    try { located = await options.locate(taskId, manifest!.projectId); } catch (error) { fault(options, `the checkout of ${taskId} could not be found: ${messageOf(error)}`); return out; }
    const root = typeof located === "string" ? located : located?.root;
    const scope = { mode: "read" as const, paths: typeof located === "object" ? [...(located.paths ?? [])] : [] };
    if (root === undefined || !isAbsolute(root)) return out; // nowhere to look: everything stays unknown
    let base: string;
    try { base = await timed(() => fileSystem.realpath(root)); } catch (error) { fault(options, error instanceof ProbeTimeout ? (hung > 0 ? `an earlier probe's read has not come back, so ${root} is not read again until it does` : `the checkout ${root} did not answer in time`) : `the checkout ${root} could not be read: ${messageOf(error)}`); return out; }
    let read = 0;
    for (const entry of wanted) {
      const key = relativePath(entry.key);
      if (key === undefined) continue; // not a path below the checkout: nothing is looked at, so nothing is claimed
      if (!scopeAllows(scope, { mode: "read", path: key })) continue; // a path the project may not use is not looked at either
      const target = resolve(join(base, key));
      if (!within(base, target)) continue;
      try {
        let real: string;
        try { real = await timed(() => fileSystem.realpath(target)); } catch (error) {
          if (missing(error)) out[entry.id] = { exists: false }; // it is gone: the check says so
          else throw error;
          continue;
        }
        if (!within(base, real)) { fault(options, `${key} is a link to outside the checkout`); continue; }
        // A link inside the checkout to a part the project may not use is not followed there either.
        if (scope.paths.length > 0 && !scopeAllows(scope, { mode: "read", path: relative(base, real).split(sep).join("/") })) { fault(options, `${key} is a link to outside the project's paths`); continue; }
        if (entry.kind === "directory") {
          const listed = await timed(() => fileSystem.readdir(real, OBSERVE_LIMITS.members));
          if (listed.kind === "not-directory") { fault(options, `${key} is not a directory now`); continue; }
          if (listed.kind === "too-wide") { fault(options, `${key} holds more names than a listing carries`); continue; }
          out[entry.id] = { exists: true, members: [...listed.names].sort() };
          continue;
        }
        const budget = Math.min(maxBytes, maxTotal - read);
        const got = await timed(() => fileSystem.readFile(real, budget));
        if (got.kind === "not-file") { fault(options, `${key} is not a file now`); continue; }
        if (got.kind === "too-big") { fault(options, budget < maxBytes ? `${key} is past what one probe reads in all` : `${key} is bigger than a probe reads`); continue; }
        if (got.where !== undefined && !within(base, got.where)) { fault(options, `${key} was opened outside the checkout`); continue; }
        read += got.bytes.byteLength;
        out[entry.id] = { exists: true, hash: createHash("sha256").update(got.bytes).digest("hex") };
      } catch (error) {
        if (error instanceof ProbeTimeout) { fault(options, `the probe of ${taskId} ran out of time at ${key}; the rest is left unobserved`); break; }
        if (missing(error)) out[entry.id] = { exists: false }; // taken away between the look and the read
        else fault(options, `${key}: ${messageOf(error)}`);
      }
    }
    return { ...out };
  };
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error);

/**
 * Whether a controller probes by default (card L04d review): yes on one machine; with remote hosts only when the operator said so,
 * because the resumed attempt's host is chosen after the check and this machine's disk says nothing about another's.
 */
export function resumeProbeEnabled(option: boolean | object | undefined, remoteHosts: number): boolean {
  return option === undefined ? remoteHosts === 0 : option !== false;
}

/**
 * A `locate` that answers only for a task last placed on a host of this machine: a task placed on a remote host, or never placed in
 * an installation that has remote hosts, is nowhere the probe can look, so its files stay `unknown` and the owner decides.
 */
export function locallyPlaced(remoteHostIds: ReadonlySet<string>, placedHostOf: (taskId: string) => Promise<string | undefined>, locate: (taskId: string) => Promise<ProbeLocation | undefined>): (taskId: string) => Promise<ProbeLocation | undefined> {
  return async (taskId) => {
    if (remoteHostIds.size > 0) {
      const placed = await placedHostOf(taskId);
      if (placed === undefined || remoteHostIds.has(placed)) return undefined;
    }
    return await locate(taskId);
  };
}
