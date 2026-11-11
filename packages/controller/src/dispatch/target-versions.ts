import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { scopeAllows } from "../projects/resources.js";
import type { ControllerStorage } from "../storage/types.js";

/**
 * The controller's own reading of a call's target version (card A05b follow-up). `DispatcherDeps.targetVersion` binds a review to a version token; this builds the token per target kind, under the
 * controller's authority, from the checkout the project bound to the task (never from anything the agent said besides the kind and the ID it named):
 *
 * - `branch` (ID: a branch name) and `ref` (ID: `HEAD` or a full `refs/...` name): the commit it points to, from the shared repository by read-only git commands (no network, no hooks, no configuration of
 *   the repository's that runs a program) that match the full name exactly, never by Git's short-name rules. Detached `HEAD` is a `ref`. A ref that is not there (a branch not made yet, a repository
 *   without a commit) is `absent`; a ref to a missing object is an error.
 * - `file` (ID: a path below the checkout): `sha256:<hex>` of the file's bytes, the same token the workspace bridge (card A04) gives and takes as `expectedVersion`; `absent` when there is no such file. The path is walked
 *   one name at a time without following a link, must lie below the project's access scope, must not touch Git's data, and the file is opened without following a link, must be a plain file and is read only up to a
 *   size cap (bigger is refused, not hashed).
 * - `task` (another task than the one calling), `project`, `task-contract`, `project-resource`: `rev:<revision>` of the stored record, `absent` for a record that is not there or belongs to another project.
 * - any other kind: `undefined`, no version (the call is bound by name only, as before).
 *
 * A task with no bound repository has no checkout on this host to read: `branch`, `ref` and `file` then have no version either (bound by name, as before this hook; the review admits such an operation
 * only while it still has none). Every other outcome is an error, never a version: the hook's caller then refuses the call (fail closed).
 */
export const TARGET_VERSION_LIMITS = { fileBytes: 8 * 1024 * 1024, gitMs: 5_000, totalMs: 8_000, pathChars: 200, pathParts: 40, partChars: 255, gitOutput: 1024, gitProcesses: 4 } as const;
export const ABSENT_VERSION = "absent";

export class TargetVersionError extends Error {
  constructor(readonly code: "unreadable" | "too_large" | "refused" | "timeout", message: string) { super(message); this.name = "TargetVersionError"; }
}
const refuse = (message: string): never => { throw new TargetVersionError("refused", message); };
const unreadable = (message: string): never => { throw new TargetVersionError("unreadable", message); };

export interface TargetVersionOptions {
  /** The largest file read to be hashed (default 8 MiB, the workspace bridge's own limit). A bigger file is refused. */
  readonly fileBytes?: number;
  /** The git program (default `git`). */
  readonly git?: string;
  /** How long the git process may run (default 5 s). */
  readonly gitMs?: number;
  /** How long one whole reading may take (default 8 s, under the dispatcher's own 10 s bound). */
  readonly totalMs?: number;
  /** How many git processes may run at once (default 4); a reading waits its turn within its own time. */
  readonly gitProcesses?: number;
}

export interface TargetVersionDeps {
  readonly storage: Pick<ControllerStorage, "getAggregate">;
  /** Where a task's checkout is, from records alone (`ProjectResourceService.checkoutLocation`). */
  readonly location: (taskId: string) => Promise<{ readonly root: string; readonly paths: readonly string[] } | undefined>;
  readonly options?: TargetVersionOptions;
}

/** Record kinds that have a revision to bind to. Each is read from storage and judged by the project it belongs to; the caller's own task is left out (see `RECORDS`). */
const RECORDS: Readonly<Record<string, "project" | "body">> = { task: "body", project: "project", "task-contract": "body", "project-resource": "body" };

const COMMIT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

/** The rules of `git check-ref-format`, applied before a name goes anywhere near a command: a name that breaks one is not a branch. */
function branchName(name: string): string {
  if (name.length < 1 || name.length > TARGET_VERSION_LIMITS.pathChars) refuse("a branch name is 1 to 200 characters");
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0020\u007f~^:?*[\\]/.test(name) || name.includes("..") || name.includes("@{") || name.includes("//") || name === "@") refuse("that is not a valid branch name");
  if (name.startsWith("/") || name.endsWith("/") || name.endsWith(".") || name.startsWith("-")) refuse("that is not a valid branch name");
  for (const part of name.split("/")) if (part === "" || part.startsWith(".") || part.endsWith(".lock")) refuse("that is not a valid branch name");
  return name;
}

/** `HEAD`, or a full name under `refs/` that passes the same rules. */
function refName(name: string): string {
  if (name === "HEAD") return name;
  if (!name.startsWith("refs/")) return refuse("a ref is HEAD or a full name starting with refs/");
  branchName(name);
  return name;
}

/** Whether a path name is Git's own data in any spelling a file system may fold it to (`.git`, `.GIT`, `.git.`, `git~1`, `.git::$DATA`). */
const touchesGit = (part: string): boolean => { const p = part.normalize("NFC").toLowerCase().replace(/[. ]+$/, ""); return p === ".git" || /^git~\d/.test(p) || p.startsWith(".git:") || p.startsWith(".git "); };

function relativeParts(path: string): string[] {
  // eslint-disable-next-line no-control-regex
  if (path.length < 1 || path.length > TARGET_VERSION_LIMITS.pathChars || /[\u0000-\u001f\u007f\\]/.test(path) || isAbsolute(path) || /^[A-Za-z]:/.test(path)) refuse("a file target is a plain relative path below the checkout");
  const parts = path.split("/");
  if (parts.length > TARGET_VERSION_LIMITS.pathParts) refuse("that path is too deep");
  for (const part of parts) {
    if (part === "" || part === "." || part === ".." || part.length > TARGET_VERSION_LIMITS.partChars) refuse("a file target is a plain relative path below the checkout");
    if (touchesGit(part)) refuse("Git's own data is not read");
  }
  return parts;
}

const fold = (name: string): string => name.normalize("NFC").toLowerCase();

export function createTargetVersions(deps: TargetVersionDeps): (target: { readonly kind: string; readonly id: string }, taskId: string) => Promise<string | undefined> {
  const fileCap = deps.options?.fileBytes ?? TARGET_VERSION_LIMITS.fileBytes;
  const gitMs = deps.options?.gitMs ?? TARGET_VERSION_LIMITS.gitMs;
  const totalMs = deps.options?.totalMs ?? TARGET_VERSION_LIMITS.totalMs;
  const git = deps.options?.git ?? "git";
  const gitProcesses = Math.max(1, deps.options?.gitProcesses ?? TARGET_VERSION_LIMITS.gitProcesses);
  let running = 0;
  const waiting: (() => void)[] = [];
  /** A turn to run git: at most `gitProcesses` at once, so many calls at the same moment do not start a process each. Waiting ends with the reading's own time. */
  const turn = (signal: AbortSignal): Promise<() => void> => new Promise((done, fail) => {
    const release = (): void => { running--; waiting.shift()?.(); };
    const go = (): void => { signal.removeEventListener("abort", stop); if (signal.aborted) { waiting.shift()?.(); return fail(new TargetVersionError("timeout", "git did not answer in time")); } running++; done(release); };
    const stop = (): void => { const i = waiting.indexOf(go); if (i >= 0) waiting.splice(i, 1); fail(new TargetVersionError("timeout", "git did not answer in time")); };
    if (signal.aborted) return fail(new TargetVersionError("timeout", "git did not answer in time"));
    if (running < gitProcesses) { running++; return done(release); }
    signal.addEventListener("abort", stop, { once: true });
    waiting.push(go);
  });

  /** The task's bound checkout; `undefined` when the task has no bound repository at all (nothing on this host the target could be read from: the call stays bound by name, as before). */
  const rootOf = async (taskId: string): Promise<{ root: string; paths: readonly string[] } | undefined> => {
    const where = await deps.location(taskId);
    if (where === undefined) return undefined;
    if (typeof where.root !== "string" || !isAbsolute(where.root)) return unreadable("the checkout is not a local directory");
    let root: string;
    try { root = await realpath(resolve(where.root)); } catch { return unreadable("the checkout does not exist"); }
    return { root, paths: where.paths };
  };

  const gitDirOf = async (root: string): Promise<string> => {
    const inside = join(root, ".git");
    const info = await lstat(inside).catch(() => undefined);
    if (info !== undefined) return info.isDirectory() ? inside : unreadable("the repository is not a plain .git directory");
    // A bare repository: the directory itself holds HEAD and the objects.
    const head = await lstat(join(root, "HEAD")).catch(() => undefined);
    const objects = await lstat(join(root, "objects")).catch(() => undefined);
    return head?.isFile() === true && objects?.isDirectory() === true ? root : unreadable("the checkout holds no Git repository");
  };

  const runGit = async (root: string, args: readonly string[], signal: AbortSignal): Promise<{ code: number; stdout: string }> => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env["PATH"] ?? "", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1", LC_ALL: "C",
      ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}),
    };
    const release = await turn(signal);
    try {
      return await new Promise<{ code: number; stdout: string }>((done, fail) => {
        const child = execFile(git, ["--no-replace-objects", "-c", "core.fsmonitor=false", "-c", "core.pager=cat", "-c", "protocol.allow=never", "-c", "safe.directory=*", ...args], { env, cwd: root, timeout: gitMs, killSignal: "SIGKILL", maxBuffer: TARGET_VERSION_LIMITS.gitOutput, windowsHide: true, encoding: "utf8", signal }, (error, stdout) => {
          if (error === null) return done({ code: 0, stdout });
          const e = error as NodeJS.ErrnoException & { killed?: boolean };
          if (e.code === "ENOENT") return fail(new TargetVersionError("unreadable", "git is not installed"));
          if (e.killed === true || e.name === "AbortError") return fail(new TargetVersionError("timeout", "git did not answer in time"));
          if (typeof (e.code as unknown) === "number") return done({ code: e.code as unknown as number, stdout });
          fail(new TargetVersionError("unreadable", "git could not read the repository"));
        });
        child.stdin?.on("error", () => undefined);
        child.stdin?.end();
      });
    } finally { release(); }
  };

  /**
   * The commit a full ref name points to, or `absent`. The name is matched exactly (`for-each-ref` lists names that start with it; only an equal one counts), never by Git's short-name rules, which
   * would read `refs/tags/refs/heads/x` or `refs/refs/heads/x` for a branch `x` that is not there. A ref to an object that is missing, or to something that is not a commit (or a tag of one), is an error.
   */
  const exactRef = async (root: string, gitDir: string, fullName: string, signal: AbortSignal): Promise<string> => {
    const { code, stdout } = await runGit(root, ["--git-dir", gitDir, "for-each-ref", "--count=1", "--sort=refname", "--format=%(refname)%00%(objecttype)%00%(objectname)%00%(*objecttype)%00%(*objectname)", "--", fullName], signal);
    if (code !== 0) return unreadable("git could not read the repository");
    const line = stdout.split("\n")[0] ?? "";
    const [name, type, oid, peeledType, peeled] = line.split("\u0000");
    // Nothing listed, or only a longer name below it (`refs/heads/x/y` for `refs/heads/x`): the name itself is not there. Anything else is not an answer git gives.
    if (line === "" || (name !== fullName && name!.startsWith(`${fullName}/`))) return ABSENT_VERSION;
    if (name !== fullName) return unreadable("git answered something that is not a ref");
    const commit = type === "commit" ? oid : type === "tag" && peeledType === "commit" ? peeled : undefined;
    return commit !== undefined && COMMIT.test(commit) ? commit : unreadable("the ref does not point to a commit");
  };

  /** The commit a full ref name or HEAD points to, or `absent` (a branch not made yet, a repository without a commit). Read-only. */
  const commitOf = async (taskId: string, fullName: string, signal: AbortSignal): Promise<string | undefined> => {
    const where = await rootOf(taskId);
    if (where === undefined) return undefined;
    const gitDir = await gitDirOf(where.root);
    if (fullName !== "HEAD") return exactRef(where.root, gitDir, fullName, signal);
    // HEAD: the branch it names (read exactly, so an unborn HEAD is absent even beside a ref called refs/heads/HEAD), or the commit a detached HEAD holds.
    const symbolic = await runGit(where.root, ["--git-dir", gitDir, "symbolic-ref", "--quiet", "--", "HEAD"], signal);
    if (symbolic.code === 0) {
      const named = symbolic.stdout.trim();
      try { refName(named); } catch { return unreadable("HEAD names something that is not a ref"); }
      if (named === "HEAD") return unreadable("HEAD names something that is not a ref");
      return exactRef(where.root, gitDir, named, signal);
    }
    if (symbolic.code !== 1) return unreadable("git could not read the repository");
    // Detached. Without --quiet, so a HEAD whose commit is missing is an error rather than "absent".
    const detached = await runGit(where.root, ["--git-dir", gitDir, "rev-parse", "--verify", "--end-of-options", "HEAD^{commit}"], signal);
    const out = detached.stdout.trim();
    return detached.code === 0 && COMMIT.test(out) ? out : unreadable("git could not read HEAD");
  };

  /** The digest of a file below the checkout, walking each name without following links. */
  const fileOf = async (taskId: string, path: string, signal: AbortSignal): Promise<string | undefined> => {
    const parts = relativeParts(path);
    const where = await rootOf(taskId);
    if (where === undefined) return undefined;
    const { root, paths } = where;
    if (!scopeAllows({ mode: "read", paths }, { mode: "read", path })) refuse("that path is outside what the project may use of its checkout");
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i]!;
      const last = i === parts.length - 1;
      let entries: string[];
      try { entries = await readdir(current); } catch { return unreadable("a directory on the way could not be read"); }
      // A different spelling of this name in the same directory is a collision, as in the bridge, not the same file.
      if (entries.some((e) => e !== name && fold(e) === fold(name))) refuse("that name collides with another spelling in its directory");
      const next = join(current, name);
      const info = await lstat(next).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined; return unreadable("the path could not be examined"); });
      if (info === undefined) return ABSENT_VERSION;
      if (info.isSymbolicLink()) refuse("a link on the way is not followed");
      if (!last) { if (!info.isDirectory()) return ABSENT_VERSION; current = next; continue; }
      if (info.isDirectory()) refuse("that is a directory");
      if (!info.isFile()) refuse("that is not a plain file");
      if (info.size > fileCap) throw new TargetVersionError("too_large", `the file is larger than ${fileCap} bytes, so its version is not read`);
      // Opened without following a link and without blocking (a file swapped for a pipe after the check must not hold the reading), then compared with what was looked at.
      const handle = await open(next, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK).catch(() => unreadable("the file could not be opened without following a link"));
      try {
        const opened = await handle.stat();
        if (!opened.isFile() || opened.dev !== info.dev || opened.ino !== info.ino) refuse("the file changed while it was being opened");
        // Only the last name is opened without following a link: a directory on the way swapped for a link after it was looked at would lead elsewhere (and the look at the file would then follow it too).
        // What was opened must be where the walk was; on Linux the kernel says where the open file is, elsewhere its real path is asked again.
        const at = process.platform === "linux" ? await readlink(`/proc/self/fd/${handle.fd}`).catch(() => undefined) : undefined;
        if ((at ?? await realpath(next).catch(() => undefined)) !== next) refuse("a directory on the way changed while the file was being opened");
        const hash = createHash("sha256");
        const chunk = Buffer.allocUnsafe(64 * 1024);
        let total = 0;
        for (;;) {
          if (signal.aborted) throw new TargetVersionError("timeout", "reading the file took too long");
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
          if (bytesRead === 0) break;
          total += bytesRead;
          if (total > fileCap) throw new TargetVersionError("too_large", `the file is larger than ${fileCap} bytes, so its version is not read`);
          hash.update(chunk.subarray(0, bytesRead));
        }
        return `sha256:${hash.digest("hex")}`;
      } finally { await handle.close(); }
    }
    return refuse("a file target names a file");
  };

  const recordOf = async (kind: string, id: string, taskId: string): Promise<string | undefined> => {
    const style = Object.hasOwn(RECORDS, kind) ? RECORDS[kind] : undefined;
    if (style === undefined) return undefined;
    // A target that is the calling task itself is what a call without a target names; its revision moves with every status change, so it would void approvals for nothing the review is about.
    if (kind === "task" && id === taskId) return undefined;
    const mine = (await deps.storage.getAggregate({ kind: "task", id: taskId }))?.body["projectId"];
    if (typeof mine !== "string") return unreadable("the calling task has no project");
    const found = await deps.storage.getAggregate({ kind, id });
    if (found === undefined) return ABSENT_VERSION;
    // A record of another project is not this project's to bind to: it reads as not there, which shows nothing about it.
    const owner = style === "project" ? id : found.body["projectId"];
    if (owner !== mine) return ABSENT_VERSION;
    return `rev:${found.revision}`;
  };

  return async (target, taskId) => {
    const { kind, id } = target;
    if (kind !== "branch" && kind !== "ref" && kind !== "file" && !Object.hasOwn(RECORDS, kind)) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), totalMs);
    try {
      const work: Promise<string | undefined> = kind === "branch" ? commitOf(taskId, `refs/heads/${branchName(id)}`, controller.signal)
        : kind === "ref" ? commitOf(taskId, refName(id), controller.signal)
        : kind === "file" ? fileOf(taskId, id, controller.signal)
        : recordOf(kind, id, taskId);
      work.catch(() => undefined); // if the time runs out first, a later failure of the reading is not an unhandled rejection
      return await Promise.race([work, new Promise<never>((_, reject) => { controller.signal.addEventListener("abort", () => reject(new TargetVersionError("timeout", "the reading took too long")), { once: true }); })]);
    } finally { clearTimeout(timer); }
  };
}
