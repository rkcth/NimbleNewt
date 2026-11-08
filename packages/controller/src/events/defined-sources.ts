import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import * as nodePath from "node:path";
import { basename, join, resolve } from "node:path";
import { DomainError } from "../domain/errors.js";
import type { JsonObject } from "../storage/types.js";
import { serviceFailureSource, snapshotSource, timerSource, type EventSource, type SnapshotEntry, type SourceType } from "./adapters.js";

/**
 * Event sources the owner defines in settings (card H13f): a timer, a file or folder, a git repository, or a service's health address, each reporting into one project's stream (or one task's).
 * The adapters of H13 do the change detection; this file supplies what they observe from the real world on the controller's machine, and checks what the owner gave.
 *
 * - **Only facts are published.** A file event names the path inside the watched place and its size and modification time; a repository event names the ref and its commit; a service event says
 *   healthy or not with the HTTP status. No file content and no response body is read into an event.
 * - **Bounded.** A folder is walked to at most `DEFINED_SOURCE_LIMITS.entries` files, a repository to as many branches and tags, and what a source remembers must fit `DEFINED_SOURCE_LIMITS.stateBytes` (the saved state is one record of limited size) (symbolic links are not followed; `.git` and `node_modules` are skipped); a health request waits at most
 *   `DEFINED_SOURCE_LIMITS.requestMs` and does not follow redirects; file, repository and service sources are looked at no more often than their `checkSeconds`.
 * - **A changed definition starts again.** The saved position carries a digest of the definition, so a source redefined under the same ID (another path, another address) takes a new
 *   baseline instead of reporting the difference between two different places.
 */
export type DefinedSourceType = "timer" | "file" | "repository" | "service";
export interface SourceDefinition {
  readonly id: string;
  readonly type: DefinedSourceType;
  readonly projectId: string;
  /** Report into this task's stream instead of the project's. */
  readonly taskId?: string;
  /** Timer: fires every this many minutes, counted from when it was defined. */
  readonly everyMinutes?: number;
  /** Timer: fires once at this time. */
  readonly at?: string;
  /** File or repository: an absolute path on the controller's machine. */
  readonly path?: string;
  /** Service: the http(s) address whose answer says whether it is healthy. */
  readonly url?: string;
  /** File, repository or service: how often it is looked at (seconds). */
  readonly checkSeconds?: number;
  readonly definedAt: string;
  readonly definedBy: string;
}

export const DEFINED_SOURCE_LIMITS = { defined: 50, path: 1000, url: 1000, minEveryMinutes: 1, maxEveryMinutes: 43_200, minCheckSeconds: 10, maxCheckSeconds: 86_400, defaultCheckSeconds: 60, requestMs: 10_000, entries: 1000, stateBytes: 200_000 } as const;
export const DEFINED_SOURCE_TYPES: readonly DefinedSourceType[] = ["timer", "file", "repository", "service"];
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
const RECORD_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const SKIPPED_DIRS = new Set([".git", "node_modules"]);

/** The H13 source type a definition reports as. */
export const typeOfDefinition = (type: DefinedSourceType): SourceType => (type === "service" ? "service-failure" : type);
export const streamOfDefinition = (d: Pick<SourceDefinition, "projectId" | "taskId">): string => (d.taskId === undefined ? `project:${d.projectId}` : `task:${d.taskId}`);

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/** The flat fields of a definition as the owner gives them (the API and the chat), checked; `now` refuses a one-off time already past. Fields that do not belong to the type are refused, not ignored. */
/** The path functions of a platform (node:path, or path.posix / path.win32 in tests, so both syntaxes are checked on every machine). */
export type PathApi = Pick<typeof nodePath.posix, "isAbsolute" | "relative" | "resolve" | "sep">;

/**
 * `path` is the controller machine's path module (default node:path). A watched path must be absolute for the machine that will look at it (on Windows `C:\data`, `\\server\share` or a
 * root-relative `/data`; elsewhere `/data`), so a path the controller could never open is refused when it is defined instead of being watched as missing for ever. It is kept exactly as the
 * owner wrote it (not re-resolved), so the setting, the chat's own-words check and what is shown back all read the owner's own text on every platform.
 */
export function checkDefinition(raw: Readonly<Record<string, unknown>>, now: string, by: string, path: PathApi = nodePath): SourceDefinition {
  const id = raw["sourceId"];
  if (typeof id !== "string" || !SOURCE_ID.test(id)) return invalid("sourceId", "must be a source ID: letters, digits, dot, dash, colon or underscore, at most 64");
  const type = raw["type"];
  if (typeof type !== "string" || !(DEFINED_SOURCE_TYPES as readonly string[]).includes(type)) return invalid("type", `must be one of ${DEFINED_SOURCE_TYPES.join(", ")}`);
  const projectId = raw["projectId"];
  if (typeof projectId !== "string" || !RECORD_ID.test(projectId)) return invalid("projectId", "must be a project ID");
  const taskId = raw["taskId"];
  if (taskId !== undefined && (typeof taskId !== "string" || !RECORD_ID.test(taskId))) return invalid("taskId", "must be a task ID");
  const allowed: Record<DefinedSourceType, readonly string[]> = { timer: ["everyMinutes", "at"], file: ["path", "checkSeconds"], repository: ["path", "checkSeconds"], service: ["url", "checkSeconds"] };
  for (const field of ["everyMinutes", "at", "path", "url", "checkSeconds"]) if (raw[field] !== undefined && !allowed[type as DefinedSourceType].includes(field)) invalid(field, `is not used by a ${type} source`);
  const base = { id, type: type as DefinedSourceType, projectId, ...(taskId === undefined ? {} : { taskId }), definedAt: now, definedBy: by };
  const checkSeconds = raw["checkSeconds"];
  if (checkSeconds !== undefined && (!Number.isSafeInteger(checkSeconds) || (checkSeconds as number) < DEFINED_SOURCE_LIMITS.minCheckSeconds || (checkSeconds as number) > DEFINED_SOURCE_LIMITS.maxCheckSeconds)) invalid("checkSeconds", `must be a whole number from ${DEFINED_SOURCE_LIMITS.minCheckSeconds} to ${DEFINED_SOURCE_LIMITS.maxCheckSeconds}`);
  const check = checkSeconds === undefined ? {} : { checkSeconds: checkSeconds as number };
  switch (type as DefinedSourceType) {
    case "timer": {
      const every = raw["everyMinutes"]; const at = raw["at"];
      if ((every === undefined) === (at === undefined)) return invalid("everyMinutes", "give everyMinutes for a repeating timer or at for a single time, not both");
      if (every !== undefined) {
        if (!Number.isSafeInteger(every) || (every as number) < DEFINED_SOURCE_LIMITS.minEveryMinutes || (every as number) > DEFINED_SOURCE_LIMITS.maxEveryMinutes) return invalid("everyMinutes", `must be a whole number from ${DEFINED_SOURCE_LIMITS.minEveryMinutes} to ${DEFINED_SOURCE_LIMITS.maxEveryMinutes}`);
        return { ...base, everyMinutes: every as number };
      }
      if (typeof at !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(at) || !Number.isFinite(Date.parse(at))) return invalid("at", "must be a date and time such as 2026-11-09T09:00:00Z");
      if (Date.parse(at) <= Date.parse(now)) return invalid("at", "is already past");
      return { ...base, at: new Date(Date.parse(at)).toISOString() };
    }
    case "file": case "repository": {
      const where = raw["path"];
      if (typeof where !== "string" || where.length === 0 || where.length > DEFINED_SOURCE_LIMITS.path || where.includes("\0") || !path.isAbsolute(where)) return invalid("path", `must be an absolute path on the controller's machine, of at most ${DEFINED_SOURCE_LIMITS.path} characters`);
      return { ...base, path: where, ...check };
    }
    case "service": {
      const url = raw["url"];
      if (typeof url !== "string" || url.length > DEFINED_SOURCE_LIMITS.url) return invalid("url", "must be an http or https address");
      let parsed: URL;
      try { parsed = new URL(url); } catch { return invalid("url", "must be an http or https address"); }
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return invalid("url", "must be an http or https address");
      // A credential in the address would be stored in the settings and shown back: refused (secrets are referenced, never stored in settings).
      if (parsed.username !== "" || parsed.password !== "") return invalid("url", "must not carry a user name or password");
      return { ...base, url: parsed.toString(), ...check };
    }
  }
}

/** What a definition says it watches, in a few words (the setting's view and the chat). */
export function describeDefinition(d: SourceDefinition): string {
  const into = d.taskId === undefined ? `project ${d.projectId}` : `task ${d.taskId}`;
  const every = (s: number | undefined): string => `every ${s ?? DEFINED_SOURCE_LIMITS.defaultCheckSeconds} s`;
  switch (d.type) {
    case "timer": return d.everyMinutes !== undefined ? `timer every ${d.everyMinutes} min into ${into}` : `timer at ${d.at} into ${into}`;
    case "file": return `file or folder ${d.path} (looked at ${every(d.checkSeconds)}) into ${into}`;
    case "repository": return `git repository ${d.path} (looked at ${every(d.checkSeconds)}) into ${into}`;
    case "service": return `service health ${d.url} (asked ${every(d.checkSeconds)}) into ${into}`;
  }
}

const digestOf = (d: SourceDefinition): string => createHash("sha256").update(JSON.stringify([d.type, d.projectId, d.taskId ?? null, d.everyMinutes ?? null, d.at ?? null, d.path ?? null, d.url ?? null, d.type === "timer" ? d.definedAt : null])).digest("hex").slice(0, 24);
const obj = (value: unknown): Record<string, unknown> => (typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

/** The probes the defined sources use; the defaults look at the real machine. Tests replace them only where the real thing cannot be arranged. */
export interface DefinedSourceProbes {
  readonly files?: (path: string) => Promise<readonly SnapshotEntry[]>;
  readonly refs?: (path: string) => Promise<readonly SnapshotEntry[]>;
  readonly health?: (url: string) => Promise<{ readonly healthy: boolean; readonly detail: string }>;
}

/**
 * The event source for one definition. Its saved state is `{ def, checkedAt?, more?, inner }`: `def` is the definition's digest (a different one starts again from a baseline), `checkedAt` when it
 * was last looked at (it is not looked at again before `checkSeconds`, unless the last look had more to report), `inner` the adapter's own state.
 */
export function definedSource(d: SourceDefinition, probes: DefinedSourceProbes = {}): EventSource {
  const stream = streamOfDefinition(d);
  const key = digestOf(d);
  const inner: EventSource | undefined = d.type === "file" ? snapshotSource({ id: d.id, type: "file", stream, snapshot: () => (probes.files ?? fileSnapshot)(d.path!) })
    : d.type === "repository" ? snapshotSource({ id: d.id, type: "repository", stream, snapshot: () => (probes.refs ?? repositoryRefs)(d.path!) })
    : d.type === "service" ? serviceFailureSource({ id: d.id, services: async () => { const h = await (probes.health ?? httpHealth)(d.url!); return [{ service: d.id, healthy: h.healthy, stream, detail: h.detail }]; } })
    : undefined;
  const intervalMs = d.type === "timer" ? 0 : (d.checkSeconds ?? DEFINED_SOURCE_LIMITS.defaultCheckSeconds) * 1000;
  return {
    id: d.id, type: typeOfDefinition(d.type),
    async poll(input) {
      const saved = obj(input.state);
      const same = input.state !== undefined && saved["def"] === key;
      const nowMs = Date.parse(input.now);
      if (same && typeof saved["checkedAt"] === "number" && saved["more"] !== true && nowMs - saved["checkedAt"] < intervalMs) return { signals: [], state: input.state!, more: false };
      const innerState = same && saved["inner"] !== undefined ? (saved["inner"] as JsonObject) : undefined;
      const source = inner ?? timerSource({ id: d.id, timers: () => timerDue(d, stream, nowMs) });
      const r = await source.poll({ state: innerState, now: input.now, limit: input.limit });
      const state = { def: key, checkedAt: nowMs, inner: r.state, ...(r.more ? { more: true } : {}) };
      // Too much to remember (very long names): refused with a reason the owner can act on, instead of a save that fails.
      if (Buffer.byteLength(JSON.stringify(state)) > DEFINED_SOURCE_LIMITS.stateBytes) throw new Error(`${d.id} has too many or too long names to remember; watch a smaller folder`);
      return { signals: r.signals, more: r.more, state };
    },
  };
}

/** The timer slot that is due now: for a repeating timer only the latest one (after a long pause it fires once, not once for every slot missed), for a single time that time once it has passed. */
function timerDue(d: SourceDefinition, stream: string, nowMs: number): { id: string; dueAt: string; stream: string; text: string }[] {
  if (d.at !== undefined) return Date.parse(d.at) <= nowMs ? [{ id: d.id, dueAt: d.at, stream, text: `timer ${d.id} came due` }] : [];
  const start = Date.parse(d.definedAt); const every = d.everyMinutes! * 60_000;
  const slots = Math.floor((nowMs - start) / every);
  if (slots < 1) return [];
  return [{ id: d.id, dueAt: new Date(start + slots * every).toISOString(), stream, text: `timer ${d.id} came due (every ${d.everyMinutes} min)` }];
}

/** The name of a file inside a watched folder, with `/` between its parts on every platform (event text and saved state do not depend on where the controller runs). */
export function insideName(root: string, full: string, path: PathApi = nodePath): string {
  return path.relative(root, full).split(path.sep).join("/");
}

/**
 * The git directory a `.git` file names (`gitdir: <path>`, as git writes it for a linked worktree or a submodule), resolved against the working copy. On Windows git writes a drive letter with
 * forward slashes (`C:/...`) or a relative path, and either separator is accepted there. Only the first line counts (a CRLF ending and a byte-order mark are dropped). Undefined when it names none.
 */
export function gitDirFromPointer(workingCopy: string, content: string, path: PathApi = nodePath): string | undefined {
  const line = (content.split(/\r?\n/)[0] ?? "").trim(); // trim also drops a byte-order mark
  if (!line.startsWith("gitdir:")) return undefined;
  const named = line.slice("gitdir:".length).trim();
  return named === "" ? undefined : path.resolve(workingCopy, named);
}

/** A file is one entry (its name); a folder is every file under it, named by its path inside the folder. The version is the size and the modification time in nanoseconds. A path that does not exist is empty (so its files read as removed). */
export async function fileSnapshot(path: string): Promise<SnapshotEntry[]> {
  let top;
  try { top = await lstat(path, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
  const version = (s: { size: bigint; mtimeNs: bigint }): string => `${s.size}:${s.mtimeNs}`;
  if (top.isFile()) return [{ name: basename(path) || path, version: version(top) }];
  if (!top.isDirectory()) return [];
  const out: SnapshotEntry[] = [];
  const walk = async (dir: string): Promise<void> => {
    let names: string[];
    try { names = (await readdir(dir)).sort(); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names) {
      const full = join(dir, name);
      let s;
      try { s = await lstat(full, { bigint: true }); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") continue; throw error; }
      if (s.isDirectory()) { if (!SKIPPED_DIRS.has(name)) await walk(full); continue; }
      if (!s.isFile()) continue; // symbolic links and special files are not followed
      if (out.length >= DEFINED_SOURCE_LIMITS.entries) throw new Error(`more than ${DEFINED_SOURCE_LIMITS.entries} files under the watched folder; watch a smaller one`);
      out.push({ name: insideName(path, full), version: version(s) });
    }
  };
  await walk(path);
  return out;
}

const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** The most the repository source reads of one of git's own files: a loose ref, the `.git` file or `commondir`, and `packed-refs`. */
const GIT_FILE_BYTES = { ref: 1024, pointer: 4096, packed: 8 * 1024 * 1024 } as const;
/**
 * A small regular file of the repository, or undefined when it is not one: a symbolic link is not followed, a pipe or a device is not read (a pipe would wait for ever and a device never end,
 * holding the event-source loop), and nothing larger than `max` bytes is read into memory.
 */
const OPEN_FLAGS = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0);
/** `flags` is the open mode (tests pass plain read-only, which is what Windows has, to check that the look before the open alone keeps a link from being followed). */
export async function readSmall(path: string, max: number, flags: number = OPEN_FLAGS): Promise<string | undefined> {
  // Looked at before it is opened, on every platform: Windows has no O_NOFOLLOW or O_NONBLOCK (both read as 0 below), so a link would otherwise be followed by the open. On POSIX the flags
  // also close the gap between this look and the open; after the open the handle is checked again. A missing file is ENOENT, as from the open.
  if (!(await lstat(path)).isFile()) return undefined;
  let handle;
  try { handle = await open(path, flags); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "EMLINK" || code === "ENXIO" || code === "EISDIR") return undefined;
    throw error;
  }
  try {
    const s = await handle.stat();
    if (!s.isFile() || s.size > max) return undefined;
    const buffer = Buffer.alloc(max + 1);
    let length = 0;
    for (let n; length <= max && (n = (await handle.read(buffer, length, max + 1 - length, length)).bytesRead) > 0;) length += n;
    return length > max ? undefined : buffer.subarray(0, length).toString("utf8");
  } finally { await handle.close(); }
}
/** The branches and tags of a git repository at `path` (a working copy, a linked worktree or a bare repository), read from its files: no git program is run. Each is named by its ref and versioned by its commit. */
export async function repositoryRefs(path: string): Promise<SnapshotEntry[]> {
  const exists = async (p: string): Promise<"file" | "dir" | undefined> => { try { const s = await lstat(p); return s.isDirectory() ? "dir" : s.isFile() ? "file" : undefined; } catch { return undefined; } };
  let gitDir: string;
  const dotGit = join(path, ".git");
  const kind = await exists(dotGit);
  if (kind === "dir") gitDir = dotGit;
  else if (kind === "file") {
    const content = await readSmall(dotGit, GIT_FILE_BYTES.pointer);
    const named = content === undefined ? undefined : gitDirFromPointer(path, content);
    if (named === undefined) throw new Error(`${dotGit} does not name a git directory`);
    gitDir = named;
  } else if (await exists(join(path, "HEAD")) === "file" && await exists(join(path, "refs")) === "dir") gitDir = path;
  else throw new Error(`${path} is not a git repository`);
  // A linked worktree keeps its branches in the common directory.
  let common = gitDir;
  if (await exists(join(gitDir, "commondir")) === "file") {
    const named = ((await readSmall(join(gitDir, "commondir"), GIT_FILE_BYTES.pointer))?.split(/\r?\n/)[0] ?? "").trim();
    if (named === "") throw new Error(`${join(gitDir, "commondir")} does not name a git directory`);
    common = resolve(gitDir, named);
  }
  const refs = new Map<string, string>();
  try {
    const packed = await readSmall(join(common, "packed-refs"), GIT_FILE_BYTES.packed);
    if (packed === undefined) throw new Error(`${join(common, "packed-refs")} is not a regular file of at most ${GIT_FILE_BYTES.packed} bytes; this repository cannot be watched`);
    for (const raw of packed.split("\n")) {
      const line = raw.trim();
      if (line === "" || line.startsWith("#") || line.startsWith("^")) continue;
      const [sha, name] = line.split(" ");
      if (sha !== undefined && name !== undefined && SHA.test(sha) && (name.startsWith("refs/heads/") || name.startsWith("refs/tags/"))) refs.set(name, sha);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const walk = async (dir: string, prefix: string): Promise<void> => {
    let names: string[];
    try { names = await readdir(dir); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return; throw error; }
    for (const name of names) {
      const full = join(dir, name);
      const k = await exists(full);
      if (k === "dir") await walk(full, `${prefix}${name}/`);
      else if (k === "file") {
        const sha = (await readSmall(full, GIT_FILE_BYTES.ref))?.trim();
        if (sha !== undefined && SHA.test(sha)) refs.set(`${prefix}${name}`, sha); // a symbolic ref (`ref: ...`), or anything that is not a small file, is not a commit and is left out
      }
      if (refs.size > DEFINED_SOURCE_LIMITS.entries) throw new Error(`more than ${DEFINED_SOURCE_LIMITS.entries} branches and tags; this repository cannot be watched`);
    }
  };
  await walk(join(common, "refs", "heads"), "refs/heads/");
  await walk(join(common, "refs", "tags"), "refs/tags/");
  return [...refs].map(([name, version]) => ({ name, version }));
}

/** One GET to the address: healthy when it answers 2xx or 3xx within the time limit (a redirect is not followed). The body is not read. */
export async function httpHealth(url: string): Promise<{ healthy: boolean; detail: string }> {
  // node:http(s) and not fetch: it never follows a redirect, and the whole exchange (connect and headers) has one deadline.
  return new Promise((done) => {
    let settled = false;
    const finish = (r: { healthy: boolean; detail: string }): void => { if (!settled) { settled = true; clearTimeout(timer); done(r); } };
    let req: ReturnType<typeof httpGet>;
    try {
      req = (url.startsWith("https:") ? httpsGet : httpGet)(url, { headers: { accept: "*/*" } }, (res) => {
        const status = res.statusCode ?? 0;
        res.destroy(); // the body is not read
        finish({ healthy: status >= 200 && status < 400, detail: `answered HTTP ${status}` });
      });
    } catch (error) {
      done({ healthy: false, detail: `could not be reached (${String((error as NodeJS.ErrnoException)?.code ?? "invalid address").slice(0, 60)})` });
      return;
    }
    const timer = setTimeout(() => { finish({ healthy: false, detail: "could not be reached (no answer in time)" }); req.destroy(); }, DEFINED_SOURCE_LIMITS.requestMs);
    timer.unref();
    req.on("error", (error: NodeJS.ErrnoException) => finish({ healthy: false, detail: `could not be reached (${String(error.code ?? error.name).slice(0, 60)})` }));
  });
}
