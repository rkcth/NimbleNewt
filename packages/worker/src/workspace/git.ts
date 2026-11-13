import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PLAN_FILE } from "@nimblenewt/contracts";
import { WorkspaceBridge, ABSENT, versionOf, type WriteResult } from "./bridge.js";
import { WorkspaceError } from "./errors.js";
import { splitRelative, touchesGit } from "./names.js";
import { NOFOLLOW, openedAt, resolveSafe, sameFile } from "./paths.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

/** Who a work-in-progress commit is by: the platform. The agent is named only in the `Developer` and `Executor` trailers. */
export const WIP_IDENTITY = { name: "NimbleNewt", email: "controller@nimblenewt.invalid" } as const;
/** Every work-in-progress branch lives under this prefix, so it can be told apart from every branch of the project. */
export const WIP_REF_PREFIX = "refs/heads/nn-wip/";
const TRAILER_VALUE = /^[A-Za-z0-9._:@-]{1,120}$/;
const WIP_REF = /^refs\/heads\/nn-wip\/[A-Za-z0-9._-]{1,120}\/[A-Za-z0-9._-]{1,120}$/;
/** A work-in-progress branch is a full ref under the namespace, two plain names deep (project, task); anything else, a protected or target branch included, is refused. */
export function wipRef(ref: string): void {
  if (!WIP_REF.test(ref) || ref.includes("..") || ref.endsWith(".lock") || ref.split("/").some((p) => p.startsWith(".") || p.endsWith("."))) throw new WorkspaceError("invalid_path", `${JSON.stringify(String(ref).slice(0, 80))} is not a work-in-progress branch (refs/heads/nn-wip/<project>/<task>)`);
}
/** The remote is one address or path: no option, no line break, no helper syntax. */
export function wipRemote(remote: string): void {
  if (typeof remote !== "string" || remote.length === 0 || remote.length > 500 || remote.startsWith("-") || /[\s\u0000-\u001f]/.test(remote) || remote.includes("::") || /^ext:/i.test(remote)) throw new WorkspaceError("invalid_path", "the backup remote must be one address or folder with no option, space or helper syntax");
}
/** The local ref that counts the last successful push to this remote and branch. */
const wipLastRef = (remote: string, ref: string): string => `refs/nn/wip-last/${createHash("sha256").update(`${remote}\0${ref}`).digest("hex").slice(0, 32)}`;

export const GIT_LIMITS = { output: 16 * 1024 * 1024, timeoutMs: 120_000, files: 10_000, fileBytes: 8 * 1024 * 1024 } as const;
const COMMIT = /^[0-9a-f]{40}$/;
/** Bounds of `GitBridge.doneState` (card W05): the uncommitted files it names, and the evidence paths it looks at. */
export const DONE_STATE_LIMITS = { named: 20, paths: 30 } as const;
/** Where the commits made through a permit are listed: a file in the checkout's git directory (host side, outside the checkout the agent edits). Text in a commit message proves nothing; a commit counts as permitted only if `commit()` made it and listed it here. */
export const permitLedgerPath = (gitDir: string): string => join(gitDir, "nn-permit-ledger");

/** Where the commits the release operation made are listed (host side, in the checkout's git directory). They are not permit commits: `unpermitted` does not read this file. */
export const releaseLedgerPath = (gitDir: string): string => join(gitDir, "nn-release-ledger");
/** Who a release commit is by: the platform, never the agent. */
export const RELEASE_IDENTITY = { name: "NimbleNewt release", email: "release@nimblenewt.invalid" } as const;

/** A digest of a list of staged files in the one form the controller and the worker both compute: sorted by path, each as {"op","path"}. */
export const filesDigest = (files: readonly { path: string; op: "write" | "delete" }[]): string =>
  createHash("sha256").update(JSON.stringify([...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0)).map((f) => ({ op: f.op, path: f.path })))).digest("hex");

/**
 * Git as the controller runs it against an agent's checkout (card A04, part 2). The checkout is a plain directory of files with **no `.git` in it**: its repository lives in a separate git directory the
 * agent never sees (`--git-dir` and `--work-tree` name both), so there is no `.git` for the agent to write, replace or rename, and a `.git` the agent creates inside the checkout is only a file to
 * be refused. Every command runs with a fixed environment (no system or user configuration, no prompts), hooks pointed at an empty directory, and the settings that would run a program named by a
 * repository turned off on the command line, which wins over any configuration file. Nothing here runs a hook, a filter or an external diff the agent supplied.
 */
export class GitBridge {
  readonly #empty: string;
  readonly #git: string;
  readonly #beforeOpen: ((absolute: string) => Promise<void>) | undefined;

  /** `scratch` is a directory only the controller can write: it holds the empty hooks directory and the empty home. */
  private constructor(scratch: string, git: string, beforeOpen?: (absolute: string) => Promise<void>) { this.#empty = scratch; this.#git = git; this.#beforeOpen = beforeOpen; }

  /** `hooks.beforeOpen` is a test seam (H12o second review): it runs between the check of a checkout file's path and its opening for a read, where a hostile process could swap a name. */
  static async create(options: { scratch: string; git?: string; hooks?: { beforeOpen?: (absolute: string) => Promise<void> } }): Promise<GitBridge> {
    const scratch = await realpath(await mkdir(options.scratch, { recursive: true, mode: 0o700 }).then(() => options.scratch));
    await mkdir(join(scratch, "no-hooks"), { recursive: true, mode: 0o700 });
    await mkdir(join(scratch, "home"), { recursive: true, mode: 0o700 });
    return new GitBridge(scratch, options.git ?? "git", options.hooks?.beforeOpen);
  }

  #env(): NodeJS.ProcessEnv {
    return {
      PATH: process.env["PATH"] ?? "", HOME: join(this.#empty, "home"), USERPROFILE: join(this.#empty, "home"), XDG_CONFIG_HOME: join(this.#empty, "home"),
      GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "echo", SSH_ASKPASS: "echo",
      GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", GIT_AUTHOR_NAME: "NimbleNewt", GIT_AUTHOR_EMAIL: "agent@nimblenewt.invalid", GIT_COMMITTER_NAME: "NimbleNewt", GIT_COMMITTER_EMAIL: "agent@nimblenewt.invalid",
      ...(process.platform === "win32" ? { SystemRoot: process.env["SystemRoot"] ?? "C:\\Windows" } : {}),
    };
  }

  /** Settings given on every command: they override the repository's own configuration file. */
  #flags(): string[] {
    return [
      "-c", `core.hooksPath=${join(this.#empty, "no-hooks")}`, "-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "-c", "core.symlinks=false", "-c", "core.protectNTFS=true", "-c", "core.protectHFS=true",
      "-c", "core.autocrlf=false", "-c", "core.longpaths=true", "-c", "core.pager=cat", "-c", "core.editor=true", "-c", "core.sshCommand=false", "-c", "core.askPass=echo", "-c", "diff.external=", "-c", "protocol.allow=never", "-c", "protocol.file.allow=never",
      "-c", "uploadpack.packObjectsHook=", "-c", "gc.auto=0", "-c", "maintenance.auto=false", "-c", "commit.gpgsign=false", "-c", "tag.gpgsign=false", "-c", "submodule.recurse=false", "-c", "init.defaultBranch=main",
      "-c", "safe.directory=*", "-c", "advice.detachedHead=false",
    ];
  }

  async #run(args: readonly string[], options: { gitDir?: string; workTree?: string; input?: string; allowFile?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
    const locator = [...(options.gitDir === undefined ? [] : ["--git-dir", options.gitDir]), ...(options.workTree === undefined ? [] : ["--work-tree", options.workTree])];
    const flags = this.#flags().map((f) => (options.allowFile === true && f === "protocol.file.allow=never" ? "protocol.file.allow=always" : f === "protocol.allow=never" && options.allowFile === true ? "protocol.allow=user" : f));
    return new Promise((resolveRun, reject) => {
      const child = execFile(this.#git, [...locator, ...flags, ...args], { env: { ...this.#env(), ...(options.env ?? {}) }, maxBuffer: GIT_LIMITS.output, timeout: GIT_LIMITS.timeoutMs, windowsHide: true, encoding: "utf8", cwd: options.workTree ?? this.#empty }, (error, stdout, stderr) => {
        if (error === null) return resolveRun({ stdout, stderr });
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return reject(new WorkspaceError("unavailable", "git is not installed on this host"));
        reject(new WorkspaceError("unavailable", `git ${String(args[0])} failed: ${String(stderr).replace(/\s+/g, " ").slice(0, 200)}`, { cause: error }));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(options.input ?? "");
    });
  }

  /**
   * Makes a checkout of `commit` from the shared repository: a repository of its own in `gitDir` (outside the checkout, outside the shared tree) and the files in `checkout`. The checkout
   * has no `.git`, and the repository takes what it needs from the shared one by an explicit local fetch (the only place the file protocol is allowed).
   */
  async createCheckout(options: { shared: string; commit: string; gitDir: string; checkout: string }): Promise<{ base: string }> {
    if (!COMMIT.test(options.commit)) throw new WorkspaceError("invalid_path", "a checkout starts from a full commit ID");
    await mkdir(options.checkout, { recursive: true });
    if ((await readdir(options.checkout)).length > 0) throw new WorkspaceError("invalid_path", "the checkout directory must be empty");
    await this.#run(["init", "--bare", options.gitDir]);
    const sharedGit = await this.#sharedGitDir(options.shared);
    await this.#run(["fetch", "--no-tags", "--no-recurse-submodules", sharedGit, options.commit], { gitDir: options.gitDir, allowFile: true });
    await this.#run(["update-ref", "refs/nn/base", options.commit], { gitDir: options.gitDir });
    await this.#run(["update-ref", "HEAD", options.commit], { gitDir: options.gitDir });
    await this.#run(["read-tree", "--reset", "-u", options.commit], { gitDir: options.gitDir, workTree: options.checkout });
    await rm(join(options.checkout, ".git"), { recursive: true, force: true });
    return { base: options.commit };
  }

  async #sharedGitDir(shared: string): Promise<string> {
    const real = await realpath(shared);
    const inside = join(real, ".git");
    const info = await lstat(inside).catch(() => undefined);
    if (info !== undefined && info.isDirectory()) return inside;
    if (info === undefined) return real; // a bare repository
    throw new WorkspaceError("unavailable", "the shared workspace's repository is not a plain .git directory");
  }

  /** The files that differ from the base, as git sees them: `??` for new files and `!!` for files an ignore rule matches count too (an ignore file is the agent's own and must not hide its work). */
  async status(options: { gitDir: string; checkout: string }): Promise<{ dirty: boolean; entries: { code: string; path: string }[] }> {
    const out = (await this.#run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=traditional", "--no-renames"], { gitDir: options.gitDir, workTree: options.checkout })).stdout;
    const entries = out.split("\0").filter(Boolean).map((e) => ({ code: e.slice(0, 2), path: e.slice(3) }));
    return { dirty: entries.length > 0, entries };
  }

  /**
   * Replaces the checkout's content with another commit, but never over work: when anything is changed or new the call refuses and says so, and the caller keeps the work (it quarantines the checkout, or
   * has it integrated first). Returns the new base.
   */
  async refresh(options: { shared: string; commit: string; gitDir: string; checkout: string }): Promise<{ base: string }> {
    const state = await this.status(options);
    if (state.dirty) throw new WorkspaceError("stale", `the checkout holds ${state.entries.length} changed or new file(s); it was left as it was`);
    // Commits made in the checkout that have not been carried into the shared workspace are work too (they would be lost when the branch moves).
    const head = (await this.#run(["rev-parse", "--verify", "HEAD"], { gitDir: options.gitDir })).stdout.trim();
    if (head !== (await this.#base(options.gitDir))) throw new WorkspaceError("stale", "the checkout holds commits that have not been integrated into the shared workspace; it was left as it was");
    const sharedGit = await this.#sharedGitDir(options.shared);
    await this.#run(["fetch", "--no-tags", "--no-recurse-submodules", sharedGit, options.commit], { gitDir: options.gitDir, allowFile: true });
    // Status does not write the index (optional locks are off), so a file touched but unchanged still looks modified to read-tree: refresh the stat information first.
    await this.#run(["update-index", "-q", "--really-refresh"], { gitDir: options.gitDir, workTree: options.checkout });
    await this.#run(["read-tree", "-m", "-u", (await this.#run(["rev-parse", "--verify", "HEAD"], { gitDir: options.gitDir })).stdout.trim(), options.commit], { gitDir: options.gitDir, workTree: options.checkout });
    await this.#run(["update-ref", "refs/nn/base", options.commit], { gitDir: options.gitDir });
    await this.#run(["update-ref", "HEAD", options.commit], { gitDir: options.gitDir });
    return { base: options.commit };
  }

  /**
   * The author's own refresh (card H12p): a three-way re-apply of the agent's work onto `commit` (the current head of the landing branch). The agent's work is its net difference from the base,
   * committed or not (a change of mode alone counts). For each file: only the agent changed it, it stays; only the landing branch changed it, the checkout takes that version (with the landing
   * mode); both changed it, the two are merged line by line. Overlapping edits are never resolved: the file keeps conflict markers (`<<<<<<< mine`, `||||||| base`, `>>>>>>> landing <commit>`) and is
   * listed. A file one side deleted and the other changed, a file that is not text, and a file added on both sides with different content (listed `both-added`, no markers) are listed too and keep the
   * agent's side. Everything is planned and prepared before the first write: every path is resolved and checked (Git's names, links, hard links, a directory or a file in the wrong place, size of the
   * files that must be merged) and the new content is made in a private directory, so a refusal changes nothing; the parent directories are made before the first file is written. A file already holding
   * this call's markers for the same landing commit (a retry) is not merged again. Files are written without following a link and checked against what was resolved. Afterwards the base is `commit`
   * and what the checkout holds is the agent's work on top of it. When the base already is `commit` nothing at all is done (the agent's own commits stay). Returns the files by outcome.
   */
  async reapply(options: { shared: string; commit: string; gitDir: string; checkout: string; hooks?: { beforeOpen?: (absolute: string) => Promise<void> } }): Promise<{ base: string; previous: string; unchanged: boolean; kept: string[]; taken: string[]; merged: string[]; conflicts: { path: string; kind: "overlap" | "deleted-here" | "deleted-there" | "binary" | "both-added" }[] }> {
    if (!COMMIT.test(options.commit)) throw new WorkspaceError("invalid_path", "a refresh goes to a full commit ID");
    const previous = await this.#base(options.gitDir);
    const mine = new Map((await this.changes(options)).map((c) => [c.path, { op: c.op, modeOnly: c.modeOnly }] as const));
    const sharedGit = await this.#sharedGitDir(options.shared);
    await this.#run(["fetch", "--no-tags", "--no-recurse-submodules", sharedGit, options.commit], { gitDir: options.gitDir, allowFile: true });
    const listing = (await this.#run(["diff", "--raw", "--no-abbrev", "-z", "--no-renames", previous, options.commit], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
    const theirs = new Map<string, { op: "write" | "delete"; mode: string; oldMode: string; sha: string }>();
    for (let i = 0; i + 1 < listing.length; i += 2) {
      const [oldMode = "", newMode = "", , sha = "", status = ""] = listing[i]!.slice(1).split(" ");
      const path = listing[i + 1]!;
      if (touchesGit(path.split("/"))) throw new WorkspaceError("protected_path", `${JSON.stringify(path.slice(0, 80))} on the landing branch is Git's own name; nothing was changed`);
      if (status === "T" || newMode === "120000" || newMode === "160000") throw new WorkspaceError("link_refused", `${JSON.stringify(path.slice(0, 80))} is or became a link or submodule on the landing branch; nothing was changed`);
      theirs.set(path, { op: status === "D" ? "delete" : "write", mode: newMode, oldMode, sha });
    }
    if (theirs.size > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files changed on the landing branch`);
    const result = { base: options.commit, previous, unchanged: previous === options.commit, kept: [...mine.keys()].filter((p) => !theirs.has(p)).sort(), taken: [] as string[], merged: [] as string[], conflicts: [] as { path: string; kind: "overlap" | "deleted-here" | "deleted-there" | "binary" | "both-added" }[] };
    // Nothing to do on the same head: the refs, the index and the agent's own commits stay as they are.
    if (result.unchanged) return result;
    const stage = await mkdtemp(join(options.gitDir, "nn-reapply-"));
    try {
      const steps: { path: string; source?: string; mode?: number }[] = [];
      const marker = `>>>>>>> landing ${options.commit.slice(0, 12)}`;
      let n = 0;
      const modeOf = (mode: string): number => (mode === "100755" ? 0o755 : 0o644);
      for (const [path, info] of [...theirs].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
        const own = mine.get(path);
        if (own === undefined || own.modeOnly) {
          // Only the landing branch changed the content (an agent's mode change is kept: the file keeps its mode).
          if (info.op === "delete") { steps.push({ path }); result.taken.push(path); continue; }
          const source = join(stage, String(n++));
          await this.#blobTo(options.gitDir, info.sha, source);
          steps.push({ path, source, ...(own === undefined ? { mode: modeOf(info.mode) } : {}) }); result.taken.push(path); continue;
        }
        const there = info.op === "delete" ? undefined : await this.#blobAt(options.gitDir, options.commit, path);
        const here = own.op === "delete" ? undefined : await this.#readChecked((await resolveSafe(options.checkout, path)).absolute, path);
        const base = await this.#blobAt(options.gitDir, previous, path);
        if (here === undefined && there === undefined) { result.merged.push(path); continue; }
        if (here !== undefined && there !== undefined && here.equals(there)) { result.merged.push(path); continue; }
        if (here === undefined) { result.conflicts.push({ path, kind: "deleted-here" }); continue; }
        if (there === undefined) { result.conflicts.push({ path, kind: "deleted-there" }); continue; }
        if (here.includes(0) || there.includes(0) || (base?.includes(0) ?? false)) { result.conflicts.push({ path, kind: "binary" }); continue; }
        if (base === undefined) { result.conflicts.push({ path, kind: "both-added" }); continue; }
        if (here.includes(marker)) { result.conflicts.push({ path, kind: "overlap" }); continue; } // a retry: this file was merged already
        const outcome = await this.#mergeText(options.gitDir, base, here, there, `landing ${options.commit.slice(0, 12)}`);
        const source = join(stage, String(n++));
        await writeFile(source, outcome.bytes);
        steps.push({ path, source, ...(info.mode !== info.oldMode ? { mode: modeOf(info.mode) } : {}) });
        if (outcome.conflicts === 0) result.merged.push(path); else result.conflicts.push({ path, kind: "overlap" });
      }
      // Every path is checked before the first write; a missing directory on the way is made below.
      for (const s of steps) {
        const safe = await resolveSafe(options.checkout, s.path, { forWrite: s.source !== undefined }).catch((error: unknown) => { if (error instanceof WorkspaceError && error.code === "not_found") return undefined; throw error; });
        if (safe?.exists === "directory" && s.source !== undefined) throw new WorkspaceError("invalid_path", `${JSON.stringify(s.path.slice(0, 80))} is a directory in the checkout; nothing was changed`);
      }
      for (const s of steps) if (s.source !== undefined) await resolveSafe(options.checkout, s.path, { forWrite: true, createParents: true });
      for (const s of steps) {
        const safe = await resolveSafe(options.checkout, s.path, { forWrite: true, createParents: true });
        if (s.source === undefined) { if (safe.exists === "file") await rm(safe.absolute); continue; }
        if (safe.exists === "directory") throw new WorkspaceError("invalid_path", `${JSON.stringify(s.path.slice(0, 80))} is a directory in the checkout; the refresh stopped there`);
        await options.hooks?.beforeOpen?.(safe.absolute);
        let handle;
        try { handle = await open(safe.absolute, constants.O_WRONLY | constants.O_CREAT | NOFOLLOW, 0o644); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new WorkspaceError("link_refused", `${JSON.stringify(s.path.slice(0, 80))} became a link while the refresh ran; it was not written`, { tamper: true });
          throw new WorkspaceError("unavailable", `${JSON.stringify(s.path.slice(0, 80))} could not be opened for writing`);
        }
        let streamed = false;
        try {
          const opened = await handle.stat();
          const now = await lstat(safe.absolute).catch(() => undefined);
          const parent = await realpath(dirname(safe.absolute)).catch(() => undefined);
          if (now === undefined || !now.isFile() || !sameFile(opened, now) || opened.nlink > 1 || parent !== safe.parent || !(await openedAt(handle, safe.absolute))) throw new WorkspaceError("link_refused", `${JSON.stringify(s.path.slice(0, 80))} was swapped while the refresh ran; it was not written`, { tamper: true });
          await handle.truncate(0);
          if (s.mode !== undefined) await handle.chmod(s.mode);
          streamed = true; // the stream closes the handle
          await pipeline(createReadStream(s.source), handle.createWriteStream({ start: 0 }));
        } finally { if (!streamed) await handle.close().catch(() => undefined); }
      }
    } finally { await rm(stage, { recursive: true, force: true }); }
    await this.#run(["update-ref", "refs/nn/base", options.commit], { gitDir: options.gitDir });
    await this.#run(["update-ref", "HEAD", options.commit], { gitDir: options.gitDir });
    await this.#run(["read-tree", "--reset", options.commit], { gitDir: options.gitDir, workTree: options.checkout });
    result.kept.sort();
    return result;
  }

  /** Streams one blob to a file without holding it in memory. */
  async #blobTo(gitDir: string, sha: string, target: string): Promise<void> {
    const child = spawn(this.#git, [...this.#flags(), "--git-dir", gitDir, "cat-file", "blob", sha], { env: this.#env(), windowsHide: true, cwd: this.#empty, stdio: ["ignore", "pipe", "ignore"] });
    const exited = new Promise<void>((resolveExit, reject) => { child.on("error", () => reject(new WorkspaceError("unavailable", "git could not be run"))); child.on("close", (code) => (code === 0 ? resolveExit() : reject(new WorkspaceError("unavailable", "a file of the landing commit could not be read")))); });
    await Promise.all([pipeline(child.stdout, createWriteStream(target, { mode: 0o600 })), exited]);
  }

  async #blobAt(gitDir: string, commit: string, path: string): Promise<Buffer | undefined> {
    const exists = await this.#run(["cat-file", "-e", `${commit}:${path}`], { gitDir }).then(() => true, () => false);
    if (!exists) return undefined;
    return new Promise((resolveBlob, reject) => {
      execFile(this.#git, [...this.#flags(), "--git-dir", gitDir, "cat-file", "blob", `${commit}:${path}`], { env: this.#env(), encoding: "buffer", maxBuffer: GIT_LIMITS.fileBytes + 1, windowsHide: true, cwd: this.#empty }, (error, stdout) => (error === null ? resolveBlob(stdout as unknown as Buffer) : reject(new WorkspaceError("invalid_path", `${JSON.stringify(path.slice(0, 80))} could not be read at that commit (it may be larger than ${GIT_LIMITS.fileBytes} bytes)`))));
    });
  }

  /** `git merge-file` over three byte strings in a private directory: its exit status is the number of conflicts, and the merged text (with markers) is what it prints. */
  async #mergeText(gitDir: string, base: Buffer, mine: Buffer, theirs: Buffer, label = "landing"): Promise<{ bytes: Buffer; conflicts: number }> {
    const dir = await mkdtemp(join(gitDir, "nn-merge-"));
    try {
      await Promise.all([writeFile(join(dir, "mine"), mine), writeFile(join(dir, "base"), base), writeFile(join(dir, "landing"), theirs)]);
      return await new Promise((resolveMerge, reject) => {
        execFile(this.#git, ["merge-file", "-p", "--diff3", "-L", "mine", "-L", "base", "-L", label, join(dir, "mine"), join(dir, "base"), join(dir, "landing")], { env: this.#env(), encoding: "buffer", maxBuffer: GIT_LIMITS.fileBytes * 2, windowsHide: true, cwd: this.#empty, timeout: GIT_LIMITS.timeoutMs }, (error, stdout) => {
          if (error === null) return resolveMerge({ bytes: stdout as unknown as Buffer, conflicts: 0 });
          const code = (error as { code?: unknown }).code;
          if (typeof code === "number" && code > 0 && code < 128) return resolveMerge({ bytes: stdout as unknown as Buffer, conflicts: code });
          reject(new WorkspaceError("unavailable", "the three-way merge of a file could not be made"));
        });
      });
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  /** The commit the checkout is based on (what a refresh moves and what the agent's work is measured from). */
  async baseOf(gitDir: string): Promise<string> { return this.#base(gitDir); }

  async #base(gitDir: string): Promise<string> {
    return (await this.#run(["rev-parse", "--verify", "refs/nn/base"], { gitDir })).stdout.trim();
  }

  /**
   * What the agent changed, ready to go through the bridge: the checkout's files that differ from the base (added, modified, deleted), checked first. A change that touches Git's data, is a link, is too
   * big, or is one of too many is refused for the whole set, and nothing is staged or written anywhere.
   */
  async changes(options: { gitDir: string; checkout: string }): Promise<{ path: string; op: "write" | "delete"; baseVersion: string; modeOnly: boolean }[]> {
    await this.#refuseGitData(options.checkout);
    const base = await this.#base(options.gitDir);
    // The net difference from the base, committed or not, ignored or not: a throwaway index is filled from the base and then with everything in the checkout.
    const index = join(options.gitDir, `nn-index-${randomBytes(6).toString("hex")}`);
    let listing: string[];
    try {
      await this.#run(["read-tree", base], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } });
      await this.#run(["add", "-A", "-f"], { gitDir: options.gitDir, workTree: options.checkout, env: { GIT_INDEX_FILE: index } });
      listing = (await this.#run(["diff", "--cached", "--name-status", "-z", "--no-renames", base], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } })).stdout.split("\0").filter(Boolean);
      const modes = (await this.#run(["ls-files", "-s", "-z"], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } })).stdout.split("\0").filter(Boolean);
      for (const line of modes) { const mode = line.slice(0, 6); if (mode === "120000" || mode === "160000") throw new WorkspaceError("link_refused", `${JSON.stringify(line.slice(line.indexOf("\t") + 1).slice(0, 80))} is a link or a submodule entry, which the bridge does not carry`); }
    } finally { await rm(index, { force: true }); }
    if (listing.length / 2 > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files changed`);
    const out: { path: string; op: "write" | "delete"; baseVersion: string; modeOnly: boolean }[] = [];
    for (let i = 0; i + 1 < listing.length; i += 2) {
      const code = listing[i]!; const path = listing[i + 1]!;
      if (touchesGit(path.split("/"))) throw new WorkspaceError("protected_path", `${JSON.stringify(path.slice(0, 80))} is or lies inside Git's own data; the whole change was refused`);
      if (code === "T") throw new WorkspaceError("link_refused", `${JSON.stringify(path.slice(0, 80))} changed kind (a file became a link or the reverse)`);
      const deleted = code === "D";
      let baseVersion = ABSENT; let modeOnly = false;
      if (code !== "A") {
        const bytes = await this.#baseBytes(options.gitDir, path, path);
        if (bytes !== undefined) {
          baseVersion = versionOf(bytes);
          if (!deleted) {
            const safe = await resolveSafe(options.checkout, path).catch(() => undefined);
            if (safe?.exists === "file") modeOnly = (await this.#readChecked(safe.absolute, path)).equals(bytes);
          }
        }
      }
      out.push({ path, op: deleted ? "delete" : "write", baseVersion, modeOnly });
    }
    return out;
  }

  /**
   * The diff stat of the agent's work (card W03, for the blocker of an agent that kept stopping early): its net difference from the base, committed or not, new and ignored files included (the same throwaway index as `changes`),
   * as git's one-line summary, and how many commits it is ahead of the base. Reads only: the checkout, its index and its refs are not touched.
   */
  async diffStat(options: { gitDir: string; checkout: string }): Promise<string> {
    const base = await this.#base(options.gitDir);
    const index = join(options.gitDir, `nn-index-${randomBytes(6).toString("hex")}`);
    let short: string;
    try {
      await this.#run(["read-tree", base], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } });
      await this.#run(["add", "-A", "-f"], { gitDir: options.gitDir, workTree: options.checkout, env: { GIT_INDEX_FILE: index } });
      short = (await this.#run(["diff", "--cached", "--shortstat", "--no-renames", base], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } })).stdout.trim();
    } finally { await rm(index, { force: true }); }
    const ahead = Number.parseInt((await this.#run(["rev-list", "--count", `${base}..HEAD`], { gitDir: options.gitDir })).stdout.trim(), 10);
    return `${short === "" ? "no changes" : short} against the task's base; ${Number.isSafeInteger(ahead) ? ahead : "an unknown number of"} commit(s) ahead of the base`;
  }

  /**
   * What the checkout holds when its agent says the work is done (card W05), read only: the files that differ from the last commit or are new (an ignore rule hides a file here, as it does from a commit; at most `DONE_STATE_LIMITS.named`
   * are named), how many commits the head is ahead of the task's base, how many files differ from the base counting what is not committed (what a submit would carry), the agent's plan file at the top (`PLAN_FILE`) left out (card W06
   * second review: every agent writes it first, so it would always make a change; it is a working note, not the work; in any letter case (third review: a `plan.md`, or a
   * case-insensitive disk that keeps a base's `plan.md` name, is the same note), at the top only), and for each evidence path whether it is a plain, non-empty file of the
   * checkout as it stands (the tree a submission would carry: committed or not, not ignored; a link or a folder is not a file). Paths are taken literally (no pattern), and nothing outside the checkout's own repository is read.
   */
  async doneState(options: { gitDir: string; checkout: string; paths: readonly string[] }): Promise<{ uncommitted: string[]; uncommittedCount: number; ahead: number; changed: number; evidence: { path: string; present: boolean; why?: string }[] }> {
    const base = await this.#base(options.gitDir);
    const status = (await this.#run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { gitDir: options.gitDir, workTree: options.checkout })).stdout;
    const uncommitted = status.split("\0").filter(Boolean).map((e) => e.slice(3));
    const ahead = Number.parseInt((await this.#run(["rev-list", "--count", `${base}..HEAD`], { gitDir: options.gitDir })).stdout.trim(), 10);
    const index = join(options.gitDir, `nn-index-${randomBytes(6).toString("hex")}`);
    let changed: number;
    let tree: string;
    try {
      await this.#run(["read-tree", base], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } });
      await this.#run(["add", "-A"], { gitDir: options.gitDir, workTree: options.checkout, env: { GIT_INDEX_FILE: index } });
      changed = (await this.#run(["diff", "--cached", "--name-only", "-z", "--no-renames", base], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } })).stdout.split("\0").filter((p) => p !== "" && p.toLowerCase() !== PLAN_FILE.toLowerCase()).length;
      // The checkout as it stands, as a tree: where the evidence is looked up. The agent cannot commit in this layout (its git directory is outside the sandbox), so its work is what the checkout holds.
      tree = (await this.#run(["write-tree"], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } })).stdout.trim();
    } finally { await rm(index, { force: true }); }
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new WorkspaceError("invalid_path", "the checkout's tree could not be read");
    const evidence: { path: string; present: boolean; why?: string }[] = [];
    for (const path of options.paths.slice(0, DONE_STATE_LIMITS.paths)) {
      const listed = (await this.#run(["--literal-pathspecs", "ls-tree", "-l", "-z", tree, "--", path], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
      // `<mode> <type> <object> <size>\t<path>`: the entry must be this exact path, a plain (or executable) file, and not empty.
      const entry = listed.map((l) => { const tab = l.indexOf("\t"); const [mode, type, , size] = l.slice(0, tab).split(/\s+/); return { mode, type, size: Number.parseInt(size ?? "", 10), path: l.slice(tab + 1) }; }).find((e) => e.path === path);
      if (entry === undefined) evidence.push({ path, present: false, why: "not in the checkout (or ignored)" });
      else if (entry.type !== "blob" || (entry.mode !== "100644" && entry.mode !== "100755")) evidence.push({ path, present: false, why: entry.type === "tree" ? "a folder, not a file" : "not a plain file" });
      else if (!(entry.size > 0)) evidence.push({ path, present: false, why: "empty" });
      else evidence.push({ path, present: true });
    }
    return { uncommitted: uncommitted.slice(0, DONE_STATE_LIMITS.named), uncommittedCount: uncommitted.length, ahead: Number.isSafeInteger(ahead) ? ahead : 0, changed, evidence };
  }

  /**
   * Carries the agent's changes into the shared workspace through the expected-version bridge, file by file: each write names the version of the file at the base commit, so a file someone else changed
   * is not overwritten and the agent's change is kept for review. Returns the outcome per file. The checkout is not touched.
   */
  async integrate(options: { gitDir: string; checkout: string; bridge: WorkspaceBridge; author: string; reason: string }): Promise<{ path: string; result: WriteResult | { status: "skipped"; reason: string } }[]> {
    const changes = await this.changes(options);
    // Everything is read and checked first, so a refusal part-way leaves the shared workspace untouched.
    const ready: { path: string; op: "write" | "delete"; expectedVersion: string; content?: Buffer; skip?: string }[] = [];
    for (const c of changes) {
      if (c.modeOnly) { ready.push({ path: c.path, op: "write", expectedVersion: c.baseVersion, skip: "only the file mode changed, and modes are not carried to the shared workspace" }); continue; }
      const base = await this.#baseBytes(options.gitDir, c.path, c.path);
      const expectedVersion = base === undefined ? ABSENT : versionOf(base);
      if (c.op === "delete") { ready.push({ path: c.path, op: "delete", expectedVersion }); continue; }
      const safe = await resolveSafe(options.checkout, c.path);
      if (safe.exists !== "file") throw new WorkspaceError("invalid_path", `${JSON.stringify(c.path.slice(0, 80))} is not a plain file in the checkout`);
      ready.push({ path: c.path, op: "write", expectedVersion, content: await this.#readChecked(safe.absolute, c.path) });
    }
    const results: { path: string; result: WriteResult | { status: "skipped"; reason: string } }[] = [];
    for (const r of ready) {
      if (r.skip !== undefined) { results.push({ path: r.path, result: { status: "skipped", reason: r.skip } }); continue; }
      // Work that is already in the shared workspace (an integration asked for again, or the same edit made there) is not written again, and no copy is kept for review.
      // A path whose folder is not there either reads as not found: that is ABSENT, the same as a missing file (an unknown failure still means unknown).
      const there = await options.bridge.read(r.path).then((x) => x.version, (e: unknown) => (e instanceof WorkspaceError && e.code === "not_found" ? ABSENT : undefined));
      if (there !== undefined && (r.op === "delete" ? there === ABSENT : there === versionOf(r.content!))) { results.push({ path: r.path, result: { status: "skipped", reason: "the shared workspace already holds exactly this" } }); continue; }
      results.push({ path: r.path, result: r.op === "delete"
        ? await options.bridge.remove({ path: r.path, expectedVersion: r.expectedVersion, author: options.author, reason: options.reason })
        : await options.bridge.write({ path: r.path, expectedVersion: r.expectedVersion, content: r.content!, author: options.author, reason: options.reason }) });
    }
    return results;
  }

  /** A file of the checkout, opened without following a link, as a plain file within the size limit. */
  async #readChecked(absolute: string, shown: string): Promise<Buffer> {
    await this.#beforeOpen?.(absolute);
    const handle = await open(absolute, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0)).catch(() => { throw new WorkspaceError("link_refused", `${JSON.stringify(shown.slice(0, 80))} could not be opened without following a link`); });
    try {
      // A directory on the way swapped for a link is followed by the open (no-follow covers the last name only): the file read must be the one at the checked path (H12o second review).
      if (!(await openedAt(handle, absolute))) throw new WorkspaceError("link_refused", `${JSON.stringify(shown.slice(0, 80))} was reached through a link; it was not read`, { tamper: true });
      const info = await handle.stat();
      if (!info.isFile()) throw new WorkspaceError("invalid_path", `${JSON.stringify(shown.slice(0, 80))} is not a plain file`);
      if (info.size > GIT_LIMITS.fileBytes) throw new WorkspaceError("invalid_path", `${JSON.stringify(shown.slice(0, 80))} is larger than the ${GIT_LIMITS.fileBytes} bytes a change may carry`);
      return await handle.readFile();
    } finally { await handle.close(); }
  }

  /** Walks the checkout without following links and refuses any name that is Git's own, wherever it is: git would treat it as another repository and not list its files. */
  async #refuseGitData(checkout: string): Promise<void> {
    let seen = 0;
    const walk = async (dir: string, depth: number): Promise<void> => {
      if (depth > 64) throw new WorkspaceError("invalid_path", "the checkout is nested too deeply");
      for (const raw of await readdir(dir, { encoding: "buffer" })) {
        if (++seen > 200_000) throw new WorkspaceError("invalid_path", "the checkout holds too many files to check");
        // A name that is not UTF-8 cannot be named back to the file system from text (H12o review: it used to end the walk with an untyped error, leaving the request uncertain).
        const name = raw.toString("utf8");
        if (!Buffer.from(name, "utf8").equals(raw)) throw new WorkspaceError("invalid_path", "the checkout holds a file name that is not valid UTF-8; the whole change was refused");
        if (touchesGit([name])) throw new WorkspaceError("protected_path", `the checkout holds ${JSON.stringify(name.slice(0, 40))}, which is Git's own name; the whole change was refused`);
        const info = await lstat(join(dir, name)).catch((error: NodeJS.ErrnoException) => { if (error.code === "ENOENT") return undefined; throw error; });
        if (info?.isDirectory() === true) await walk(join(dir, name), depth + 1);
      }
    };
    await walk(checkout, 0);
  }

  async #baseBytes(gitDir: string, path: string, shown: string): Promise<Buffer | undefined> {
    const base = await this.#base(gitDir);
    const exists = await this.#run(["cat-file", "-e", `${base}:${path}`], { gitDir }).then(() => true, () => false);
    if (!exists) return undefined;
    return new Promise((resolveBlob, reject) => {
      execFile(this.#git, [...this.#flags(), "--git-dir", gitDir, "cat-file", "blob", `${base}:${path}`], { env: this.#env(), encoding: "buffer", maxBuffer: GIT_LIMITS.fileBytes + 1, windowsHide: true, cwd: this.#empty }, (error, stdout) => (error === null ? resolveBlob(stdout as unknown as Buffer) : reject(new WorkspaceError("invalid_path", `the base version of ${JSON.stringify(shown.slice(0, 80))} could not be read (it may be larger than the ${GIT_LIMITS.fileBytes} bytes a change may carry)`))));
    });
  }

  /**
   * Stages the checkout for review: everything the agent changed that git does not ignore is added to the checkout's own index, and the tree it makes, the base commit and the list of staged files
   * are returned (with the files an ignore rule keeps out, so that nothing is unseen). A Git-named entry, a link or a submodule entry anywhere refuses the whole thing. The tree ID is what a
   * reviewer approves and what `commit` will insist on.
   */
  async stage(options: { gitDir: string; checkout: string }): Promise<{ base: string; tree: string; files: { path: string; op: "write" | "delete" }[]; ignored: string[] }> {
    await this.#neutralAttributes(options.gitDir);
    await this.#refuseGitData(options.checkout);
    await this.#run(["add", "-A"], { gitDir: options.gitDir, workTree: options.checkout });
    const listing = (await this.#run(["ls-files", "-s", "-z"], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
    const blobs = new Map<string, string>();
    for (const line of listing) {
      const mode = line.slice(0, 6);
      const path = line.slice(line.indexOf("\t") + 1);
      if (mode === "120000" || mode === "160000") throw new WorkspaceError("link_refused", `${JSON.stringify(path.slice(0, 80))} is a link or a submodule entry, which a commit through the bridge does not carry`);
      blobs.set(path, line.slice(7, line.indexOf(" ", 7)));
    }
    // A commit builds on the checkout's own head (an earlier commit of its own, or the base the checkout started from).
    const base = (await this.#run(["rev-parse", "--verify", "HEAD"], { gitDir: options.gitDir })).stdout.trim();
    const tree = (await this.#run(["write-tree"], { gitDir: options.gitDir })).stdout.trim();
    const diff = (await this.#run(["diff", "--cached", "--name-status", "-z", "--no-renames", base], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
    const files: { path: string; op: "write" | "delete" }[] = [];
    for (let i = 0; i + 1 < diff.length; i += 2) files.push({ path: diff[i + 1]!, op: diff[i] === "D" ? "delete" : "write" });
    if (files.length > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files are staged`);
    // Git reads a file it saw as plain by opening its path, which follows a link: a file swapped for a link (or a directory on the way swapped for one) between git's look and its read would put the content of a
    // file outside the checkout, read with the host's rights, into the commit. So every written file is read again here without following any link and must be exactly what was staged (H12o review).
    // H12o second review: on a refusal the index is put back to the head, so it no longer names a blob git read from outside the checkout.
    try { for (const f of files) if (f.op === "write") await this.#sameAsStaged(options.checkout, f.path, blobs.get(f.path)); } catch (error) {
      await this.#run(["read-tree", base], { gitDir: options.gitDir }).catch(() => undefined);
      throw error;
    }
    const status = await this.status(options);
    return { base, tree, files, ignored: status.entries.filter((e) => e.code === "!!").map((e) => e.path) };
  }

  /** Refuses unless the file at `path` in the checkout, opened without following a link at any name and without blocking, is a plain file whose Git blob ID is `staged`. */
  async #sameAsStaged(checkout: string, path: string, staged: string | undefined): Promise<void> {
    const changed = (): WorkspaceError => new WorkspaceError("link_refused", `${JSON.stringify(path.slice(0, 80))} changed or was replaced by a link while it was being staged; nothing was committed`, { tamper: true });
    if (staged === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(staged)) throw changed();
    const safe = await resolveSafe(checkout, path).catch(() => { throw changed(); });
    if (safe.exists !== "file") throw changed();
    await this.#beforeOpen?.(safe.absolute);
    const handle = await open(safe.absolute, constants.O_RDONLY | NOFOLLOW | (constants.O_NONBLOCK ?? 0)).catch(() => { throw changed(); });
    try {
      // No-follow covers the last name only: a directory on the way swapped for a link after the walk would lead this read to the same outside file git read, and the hashes would agree (H12o second review).
      if (!(await openedAt(handle, safe.absolute))) throw changed();
      const info = await handle.stat();
      if (!info.isFile()) throw changed();
      const hash = createHash(staged.length === 64 ? "sha256" : "sha1").update(`blob ${info.size}\0`);
      let read = 0;
      for await (const chunk of handle.createReadStream({ autoClose: false, highWaterMark: 1 << 20 }) as AsyncIterable<Buffer>) { read += chunk.length; hash.update(chunk); }
      if (read !== info.size || hash.digest("hex") !== staged) throw changed();
    } finally { await handle.close(); }
  }

  /**
   * Makes the commit a permit allows, and only that one: the checkout is staged again and must make exactly the reviewed tree on exactly the reviewed base. The author, the committer and the
   * trailers are the permit's (they come from the controller's records), so the agent supplies none of them. Returns the commit's ID, whose parent is the base.
   */
  async commit(options: { gitDir: string; checkout: string; permit: { base: string; tree: string; filesDigest: string; message: string; author: { name: string; email: string }; committer: { name: string; email: string }; trailers: readonly string[] } }): Promise<{ commitId: string; parent: string }> {
    const permit = options.permit;
    if (!COMMIT.test(permit.base) || !COMMIT.test(permit.tree)) throw new WorkspaceError("invalid_path", "a permit names a full base commit and tree");
    const staged = await this.stage(options);
    const changed = [staged.base !== permit.base ? "the base commit" : "", staged.tree !== permit.tree ? "the staged tree" : "", filesDigest(staged.files) !== permit.filesDigest ? "the list of files the reviewer was shown" : ""].filter(Boolean);
    if (changed.length > 0) throw new WorkspaceError("stale", `this is not the reviewed commit: ${changed.join(" and ")} changed; nothing was committed`);
    const message = `${permit.message.replace(/\s+$/u, "")}\n\n${permit.trailers.join("\n")}\n`;
    const env = { GIT_AUTHOR_NAME: permit.author.name, GIT_AUTHOR_EMAIL: permit.author.email, GIT_COMMITTER_NAME: permit.committer.name, GIT_COMMITTER_EMAIL: permit.committer.email };
    const commitId = (await this.#run(["commit-tree", permit.tree, "-p", permit.base, "-F", "-"], { gitDir: options.gitDir, input: message, env })).stdout.trim();
    if (!COMMIT.test(commitId)) throw new WorkspaceError("unavailable", "git did not return a commit ID");
    // The commit is listed before the branch moves to it, so a commit that is on the branch is always listed; one that is only listed (a crash between the two) is not reachable and counts for nothing.
    await appendFile(permitLedgerPath(options.gitDir), `${commitId} ${permit.trailers.find((t) => t.startsWith("NimbleNewt-Request: "))?.slice(20) ?? ""}\n`, { mode: 0o600 });
    // The checkout's branch moves only from the reviewed base to the new commit.
    await this.#run(["update-ref", "HEAD", commitId, permit.base], { gitDir: options.gitDir });
    return { commitId, parent: permit.base };
  }

  /**
   * Commits what a task's checkout holds, in the checkout's own git directory and nowhere else (card H12o, the release operation). It is the platform's commit, not the agent's and not a reviewed one: the author, the committer, the
   * message and the trailers are built here from the request, the task and the attempt (all plain names, checked), and the agent supplies none of them. It is **not** a commit made through the review gate's permit: it is not
   * listed in the permit ledger, so a landing that requires the permit still refuses it (the permit rule is the landing policy's, not this commit's). Nothing outside the checkout and its git directory is touched.
   *
   * How it stays safe in a checkout the agent could write: the repository is the host's own (`--git-dir`), no hook runs (`core.hooksPath` is an empty directory, and a commit is made with `commit-tree` and `update-ref`, which run none),
   * no configuration of the user or the system is read, no alias is reachable (argv only), and the attributes the checkout supplies cannot name a filter: the host writes `info/attributes` (which outranks every `.gitattributes`)
   * that unsets `filter`, `ident`, `text` and the working-tree encoding for every path. A Git-named entry, a link or a submodule anywhere refuses the whole commit (`stage`). The head moves from the head it was staged on
   * to the new commit only (a compare-and-swap), and the commit is listed in the release ledger before the head moves. Nothing to commit is not an error: it answers `commitId: undefined`.
   */
  async release(options: { gitDir: string; checkout: string; requestId: string; taskId: string; attemptId?: string }): Promise<{ commitId?: string; parent: string; tree: string; files: { path: string; op: "write" | "delete" }[]; ignored: string[] }> {
    if (!/^wsr-[a-z2-7]{20}$/.test(options.requestId)) throw new WorkspaceError("invalid_path", "a release names a request ID of the controller's form");
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(options.taskId) || (options.attemptId !== undefined && !/^[A-Za-z0-9._:-]{1,120}$/.test(options.attemptId))) throw new WorkspaceError("invalid_path", "a release names a plain task and attempt");
    const staged = await this.stage(options);
    if (staged.files.length === 0) return { parent: staged.base, tree: staged.tree, files: [], ignored: staged.ignored };
    const trailers = [`NimbleNewt-Task: ${options.taskId}`, `NimbleNewt-Release: ${options.requestId}`, ...(options.attemptId === undefined ? [] : [`NimbleNewt-Attempt: ${options.attemptId}`])];
    const message = `Work of task ${options.taskId}${options.attemptId === undefined ? "" : ` (attempt ${options.attemptId})`}\n\nCommitted by NimbleNewt after the agent reported the work done; ${staged.files.length} file(s). Not a reviewed commit.\n\n${trailers.join("\n")}\n`;
    const env = { GIT_AUTHOR_NAME: RELEASE_IDENTITY.name, GIT_AUTHOR_EMAIL: RELEASE_IDENTITY.email, GIT_COMMITTER_NAME: RELEASE_IDENTITY.name, GIT_COMMITTER_EMAIL: RELEASE_IDENTITY.email };
    const commitId = (await this.#run(["commit-tree", staged.tree, "-p", staged.base, "-F", "-"], { gitDir: options.gitDir, input: message, env })).stdout.trim();
    if (!COMMIT.test(commitId)) throw new WorkspaceError("unavailable", "git did not return a commit ID");
    await appendFile(releaseLedgerPath(options.gitDir), `${commitId} ${options.requestId} ${options.attemptId ?? "-"}\n`, { mode: 0o600 });
    await this.#run(["update-ref", "HEAD", commitId, staged.base], { gitDir: options.gitDir });
    return { commitId, parent: staged.base, tree: staged.tree, files: staged.files, ignored: staged.ignored };
  }

  /** Writes the repository's own attribute file (it outranks every attribute file in the checkout): no path may name a filter, an ident expansion, a line-ending conversion or a re-encoding. Replaced atomically, only when it differs. */
  async #neutralAttributes(gitDir: string): Promise<void> {
    const file = join(gitDir, "info", "attributes");
    const text = "* -filter -ident -text -working-tree-encoding\n";
    if (await readFile(file, "utf8").catch(() => undefined) === text) return;
    await mkdir(join(gitDir, "info"), { recursive: true, mode: 0o700 });
    const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
    await writeFile(temporary, text, { mode: 0o600, flag: "wx" });
    await rename(temporary, file);
  }

  /**
   * After the agent's work has been carried into the shared workspace (`integrate`), says so: when everything is committed and every changed file in the shared workspace is now what the checkout
   * holds, the base moves to the checkout's head, so a refresh no longer counts those commits as unintegrated. Returns whether it moved, and the paths still differing when it did not.
   */
  async markIntegrated(options: { gitDir: string; checkout: string; bridge: WorkspaceBridge }): Promise<{ moved: boolean; differing: string[] }> {
    const state = await this.status(options);
    if (state.dirty) return { moved: false, differing: state.entries.map((e) => e.path) };
    const differing: string[] = [];
    for (const c of await this.changes(options)) {
      const shared = await options.bridge.read(c.path).catch(() => ({ content: undefined, version: ABSENT }));
      if (c.op === "delete") { if (shared.version !== ABSENT) differing.push(c.path); continue; }
      const safe = await resolveSafe(options.checkout, c.path);
      const mine = await this.#readChecked(safe.absolute, c.path);
      if (shared.version !== versionOf(mine)) differing.push(c.path);
    }
    if (differing.length > 0) return { moved: false, differing };
    const head = (await this.#run(["rev-parse", "--verify", "HEAD"], { gitDir: options.gitDir })).stdout.trim();
    await this.#run(["update-ref", "refs/nn/base", head], { gitDir: options.gitDir });
    return { moved: true, differing: [] };
  }

  /**
   * The state of the shared working tree that a landing depends on (card H12q review): the branch it is on (`undefined` when detached), its head commit, and every changed or new file that no ignore rule hides. A landing
   * leaves its files uncommitted in this tree and the head does not move, so the head alone cannot say whether another landing came before; this does.
   */
  async sharedTree(shared: string): Promise<{ branch: string | undefined; head: string; entries: { code: string; path: string }[] }> {
    const real = await realpath(shared);
    const gitDir = await this.#sharedGitDir(shared);
    const head = (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir })).stdout.trim();
    const branch = await this.#run(["symbolic-ref", "-q", "--short", "HEAD"], { gitDir }).then((r) => r.stdout.trim() || undefined, () => undefined);
    const out = (await this.#run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { gitDir, workTree: real })).stdout;
    return { branch, head, entries: out.split("\0").filter(Boolean).map((e) => ({ code: e.slice(0, 2), path: e.slice(3) })) };
  }

  /**
   * What a landing would carry, planned once from the checkout's committed objects (card H12q review): the difference between the base commit and the checkout's head commit, with the head's blobs. The live working tree
   * is never read, so a file written after the checks (by a process still running in the sandbox) cannot change what is landed. A Git-named path, a link or submodule, a path with a name problem, a file over the size limit
   * and too many files refuse the whole plan. A change of mode alone is listed as `modeOnly` (not carried).
   */
  async landingPlan(options: { gitDir: string }): Promise<{ base: string; head: string; files: { path: string; op: "write" | "delete"; expectedVersion: string; content?: Buffer; modeOnly: boolean; executable?: boolean }[] }> {
    const base = await this.#base(options.gitDir);
    const head = (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: options.gitDir })).stdout.trim();
    if (base === head) return { base, head, files: [] };
    const listing = (await this.#run(["diff", "--raw", "--no-abbrev", "-z", "--no-renames", base, head], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
    if (listing.length / 2 > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files changed`);
    const files: { path: string; op: "write" | "delete"; expectedVersion: string; content?: Buffer; modeOnly: boolean; executable?: boolean }[] = [];
    let total = 0;
    for (let i = 0; i + 1 < listing.length; i += 2) {
      const [oldMode = "", newMode = "", oldSha = "", newSha = "", status = ""] = listing[i]!.slice(1).split(" ");
      const path = listing[i + 1]!;
      if (touchesGit(path.split("/"))) throw new WorkspaceError("protected_path", `${JSON.stringify(path.slice(0, 80))} is or lies inside Git's own data; the whole change was refused`);
      if (status === "T" || newMode === "120000" || newMode === "160000" || oldMode === "120000" || oldMode === "160000") throw new WorkspaceError("link_refused", `${JSON.stringify(path.slice(0, 80))} is a link or a submodule entry, which the bridge does not carry`);
      try { splitRelative(path, { forWindows: true }); } catch (error) { throw new WorkspaceError("invalid_path", `${JSON.stringify(path.slice(0, 80))} cannot be carried: ${(error as Error).message}`); }
      const baseBytes = status === "A" ? undefined : await this.#blobAt(options.gitDir, base, path);
      const expectedVersion = baseBytes === undefined ? ABSENT : versionOf(baseBytes);
      if (status === "D") { files.push({ path, op: "delete", expectedVersion, modeOnly: false }); continue; }
      if (oldSha === newSha) { files.push({ path, op: "write", expectedVersion, modeOnly: true }); continue; }
      const content = await this.#blobAt(options.gitDir, head, path);
      if (content === undefined) throw new WorkspaceError("invalid_path", `${JSON.stringify(path.slice(0, 80))} could not be read at the checkout's head`);
      total += content.length;
      if (total > 64 * 1024 * 1024) throw new WorkspaceError("invalid_path", "the change is larger than 64 MiB in total");
      files.push({ path, op: "write", expectedVersion, content, modeOnly: false, executable: newMode === "100755" });
    }
    return { base, head, files };
  }

  /** The commits between the base and the checkout's head (oldest last, as git lists them) that were not made through a commit permit for this task (they are not in the host-side permit ledger, or lack the marks): the `NimbleNewt-Request:` and `NimbleNewt-Task:` trailers the review gate adds (A06). */
  async unpermitted(options: { gitDir: string; taskId: string }): Promise<string[]> {
    const base = await this.#base(options.gitDir);
    const out = (await this.#run(["log", "--format=%H%x1f%B%x1e", `${base}..HEAD`], { gitDir: options.gitDir })).stdout.split("\x1e").map((x) => x.trim()).filter(Boolean);
    // The marks in a message are text anybody can type: a commit is permitted only when `commit()` listed it in the host-side ledger as well.
    const listed = new Set((await readFile(permitLedgerPath(options.gitDir), "utf8").catch(() => "")).split("\n").map((l) => l.split(" ")[0]!).filter((x) => COMMIT.test(x)));
    return out.flatMap((entry) => {
      const [sha = "", message = ""] = entry.split("\x1f");
      const request = /^NimbleNewt-Request: \S+$/m.test(message);
      const task = message.split("\n").some((l) => l === `NimbleNewt-Task: ${options.taskId}`);
      return request && task && listed.has(sha) ? [] : [sha];
    });
  }

  /** After a landing was written: the base moves to `commit`, but only if the checkout's head still is `commit` (a compare-and-swap, so nothing is marked that was not landed). */
  async markLanded(options: { gitDir: string; commit: string }): Promise<boolean> {
    if (!COMMIT.test(options.commit)) throw new WorkspaceError("invalid_path", "a landing names a full commit ID");
    const head = (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: options.gitDir })).stdout.trim();
    if (head !== options.commit) return false;
    await this.#run(["update-ref", "refs/nn/base", options.commit], { gitDir: options.gitDir });
    return true;
  }

  /**
   * Backs up the checkout's work in progress to a work-in-progress branch on a remote the owner named (card P02b). Everything is made in the checkout's own git directory (the host's, outside every sandbox): the files go
   * into a TEMPORARY index of its own (`nn-wip-index-*`, started from the head so a tracked file an ignore rule matches is kept), so the agent's index, HEAD, base and branches are never touched; the commit is made with
   * `commit-tree` by the platform as author and committer (the agent's name is only a trailer), with `Developer`, `Executor`, `NimbleNewt-Task` and `NimbleNewt-WIP: unreviewed` and never a `Reviewed-by` or `Reviewed-via`.
   * Before the push every file is read once more without following a link and handed to `scan`: a file the scan names, a link, a submodule entry, a file over the size limit and a file that changed while it was read are
   * LEFT OUT of the commit and listed in `blocked` (a missing scan refuses the whole backup: no scan, no push). The push names one ref under `refs/heads/nn-wip/` and never forces; the remote's own answer is then read
   * back (`ls-remote`) and must be the commit, or the backup failed. The commit is only counted (the local `refs/nn/wip-last/*` ref moves) after that read-back, so a failed push is never a backup; the next commit builds on
   * the last counted one, so successive pushes are fast-forwards. Throws a `WorkspaceError` with a plain reason when anything fails; nothing is half-counted.
   */
  async backupWip(options: { gitDir: string; checkout: string; remote: string; ref: string; taskId: string; projectId: string; developer: string; executor: string; scan: (file: { path: string; bytes: Buffer }) => string | undefined | Promise<string | undefined>; env?: NodeJS.ProcessEnv }): Promise<{ commitId: string; tree: string; base: string; unchanged: boolean; files: number; blocked: { path: string; reason: string }[]; ignored: number }> {
    if (typeof options.scan !== "function") throw new WorkspaceError("invalid_path", "a work-in-progress backup needs a scan of its files; none was given, so nothing was backed up");
    wipRemote(options.remote);
    wipRef(options.ref);
    for (const [name, value] of [["task", options.taskId], ["project", options.projectId], ["developer", options.developer], ["executor", options.executor]] as const) if (!TRAILER_VALUE.test(value)) throw new WorkspaceError("invalid_path", `the ${name} of a backup is a plain name`);
    await this.#neutralAttributes(options.gitDir);
    await this.#refuseGitData(options.checkout);
    const index = join(options.gitDir, `nn-wip-index-${randomBytes(6).toString("hex")}`);
    const env = { GIT_INDEX_FILE: index };
    try {
      const head = (await this.#run(["rev-parse", "--verify", "HEAD"], { gitDir: options.gitDir })).stdout.trim();
      const base = await this.#base(options.gitDir);
      await this.#run(["read-tree", head], { gitDir: options.gitDir, env });
      await this.#run(["add", "-A"], { gitDir: options.gitDir, workTree: options.checkout, env });
      const listing = (await this.#run(["ls-files", "-s", "-z"], { gitDir: options.gitDir, env })).stdout.split("\0").filter(Boolean);
      if (listing.length > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files hold work in progress`);
      const blocked: { path: string; reason: string }[] = [];
      const leaveOut = async (path: string, reason: string): Promise<void> => { blocked.push({ path, reason }); await this.#run(["update-index", "--force-remove", "-z", "--stdin"], { gitDir: options.gitDir, workTree: options.checkout, env, input: `${path}\0` }); };
      for (const line of listing) {
        const mode = line.slice(0, 6);
        const path = line.slice(line.indexOf("\t") + 1);
        const blob = line.slice(7, line.indexOf(" ", 7));
        if (mode === "120000" || mode === "160000") { await leaveOut(path, "a link or a submodule entry"); continue; }
        // A file git saw as plain is read again without following any link: it must still be exactly what git staged.
        const stillThere = await this.#sameAsStaged(options.checkout, path, blob).then(() => true, () => false);
        if (!stillThere) { await leaveOut(path, "the file changed or was replaced by a link while it was read"); continue; }
        const bytes = await this.#blobBuffer(options.gitDir, blob).catch(() => undefined);
        if (bytes === undefined) { await leaveOut(path, `larger than the ${GIT_LIMITS.fileBytes} bytes a backup carries`); continue; }
        let verdict: string | undefined;
        try { verdict = await options.scan({ path, bytes }); } catch { verdict = "the scan of the file failed"; }
        if (verdict !== undefined) await leaveOut(path, verdict);
      }
      const ignored = (await this.#run(["ls-files", "-o", "-i", "--exclude-standard", "--directory", "-z"], { gitDir: options.gitDir, workTree: options.checkout, env })).stdout.split("\0").filter(Boolean).length;
      const tree = (await this.#run(["write-tree"], { gitDir: options.gitDir, env })).stdout.trim();
      const counted = wipLastRef(options.remote, options.ref);
      const last = await this.#run(["rev-parse", "--verify", "-q", `${counted}^{commit}`], { gitDir: options.gitDir }).then((r) => r.stdout.trim(), () => undefined);
      const lastTree = last === undefined ? undefined : (await this.#run(["rev-parse", "--verify", `${last}^{tree}`], { gitDir: options.gitDir })).stdout.trim();
      let commitId: string;
      const unchanged = last !== undefined && lastTree === tree;
      if (unchanged) commitId = last!;
      else {
        const message = `Work in progress of task ${options.taskId} (not reviewed)\n\nBacked up by NimbleNewt; ${listing.length - blocked.length} file(s). Not reviewed work: never merged, integrated or landed.\n\nDeveloper: ${options.developer}\nExecutor: ${options.executor}\nNimbleNewt-Task: ${options.taskId}\nNimbleNewt-Project: ${options.projectId}\nNimbleNewt-Base: ${base}\nNimbleNewt-WIP: unreviewed\n`;
        const who = { GIT_AUTHOR_NAME: WIP_IDENTITY.name, GIT_AUTHOR_EMAIL: WIP_IDENTITY.email, GIT_COMMITTER_NAME: WIP_IDENTITY.name, GIT_COMMITTER_EMAIL: WIP_IDENTITY.email };
        commitId = (await this.#run(["commit-tree", tree, "-p", last ?? head, "-F", "-"], { gitDir: options.gitDir, input: message, env: who })).stdout.trim();
        if (!COMMIT.test(commitId)) throw new WorkspaceError("unavailable", "git did not return a commit ID");
      }
      // Never forced (no plus on the refspec, no force flag): a remote that moved on its own refuses, and that is a failed backup.
      await this.#run(["push", "--no-verify", "--no-follow-tags", "--", options.remote, `${commitId}:${options.ref}`], { gitDir: options.gitDir, allowFile: true, env: options.env ?? {} }).catch((error: unknown) => { throw new WorkspaceError("unavailable", `the push to the backup remote failed: ${(error as Error).message.replace(/^git push failed: /, "").slice(0, 180)}`, { cause: error }); });
      const there = (await this.#run(["ls-remote", "--", options.remote, options.ref], { gitDir: options.gitDir, allowFile: true, env: options.env ?? {} }).catch(() => ({ stdout: "" }))).stdout.split("\n").map((l) => l.split("\t")).find((p) => p[1] === options.ref)?.[0];
      if (there !== commitId) throw new WorkspaceError("unavailable", "the push was accepted but the remote does not show the commit on the work-in-progress branch; it is not counted as a backup");
      await this.#run(["update-ref", counted, commitId], { gitDir: options.gitDir });
      return { commitId, tree, base, unchanged, files: listing.length - blocked.length, blocked, ignored };
    } finally { await rm(index, { force: true }); }
  }

  /**
   * Puts a work-in-progress branch back as a workspace (card P02b): `checkout` must be an empty directory and `gitDir` a repository that does not exist yet. The branch is fetched from `remote`, its tree is written into the
   * checkout and the checkout's base (and head) is the commit the work was based on, so `status` shows exactly the work that was backed up. Only a commit that carries `NimbleNewt-WIP: unreviewed` is restored.
   */
  async restoreWip(options: { remote: string; ref: string; gitDir: string; checkout: string; env?: NodeJS.ProcessEnv }): Promise<{ commitId: string; base: string; files: number }> {
    wipRemote(options.remote);
    wipRef(options.ref);
    await mkdir(options.checkout, { recursive: true });
    if ((await readdir(options.checkout)).length > 0) throw new WorkspaceError("invalid_path", "the checkout directory must be empty");
    await this.#run(["init", "--bare", options.gitDir]);
    await this.#run(["fetch", "--no-tags", "--no-recurse-submodules", "--", options.remote, `${options.ref}:refs/nn/wip-restored`], { gitDir: options.gitDir, allowFile: true, env: options.env ?? {} }).catch((error: unknown) => { throw new WorkspaceError("unavailable", `the work-in-progress branch could not be fetched: ${(error as Error).message.slice(0, 180)}`, { cause: error }); });
    const commitId = (await this.#run(["rev-parse", "--verify", "refs/nn/wip-restored^{commit}"], { gitDir: options.gitDir })).stdout.trim();
    const message = (await this.#run(["log", "-1", "--format=%B", commitId], { gitDir: options.gitDir })).stdout;
    if (!/^NimbleNewt-WIP: unreviewed$/m.test(message)) throw new WorkspaceError("invalid_path", "that branch does not hold a NimbleNewt work-in-progress commit; nothing was restored");
    const base = /^NimbleNewt-Base: ([0-9a-f]{40})$/m.exec(message)?.[1];
    if (base === undefined) throw new WorkspaceError("invalid_path", "the work-in-progress commit names no base commit; nothing was restored");
    await this.#neutralAttributes(options.gitDir);
    await this.#run(["read-tree", "--reset", "-u", commitId], { gitDir: options.gitDir, workTree: options.checkout });
    await rm(join(options.checkout, ".git"), { recursive: true, force: true });
    await this.#run(["update-ref", "refs/nn/base", base], { gitDir: options.gitDir });
    await this.#run(["update-ref", "HEAD", base], { gitDir: options.gitDir });
    await this.#run(["read-tree", base], { gitDir: options.gitDir });
    const files = (await this.#run(["ls-tree", "-r", "--name-only", "-z", commitId], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean).length;
    return { commitId, base, files };
  }

  /** A blob's bytes (never more than the file limit: a larger one is an error). */
  async #blobBuffer(gitDir: string, sha: string): Promise<Buffer> {
    return new Promise((resolveBlob, reject) => {
      execFile(this.#git, [...this.#flags(), "--git-dir", gitDir, "cat-file", "blob", sha], { env: this.#env(), encoding: "buffer", maxBuffer: GIT_LIMITS.fileBytes + 1, windowsHide: true, cwd: this.#empty }, (error, stdout) => (error === null ? resolveBlob(stdout as unknown as Buffer) : reject(new WorkspaceError("invalid_path", "a file could not be read within the size limit"))));
    });
  }

  /** The ID of a commit in the shared repository's current head (the controller's own read). */
  async head(shared: string): Promise<string> {
    return (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: await this.#sharedGitDir(shared) })).stdout.trim();
  }
}

void mkdtemp; void tmpdir; void resolve; void readFile;
