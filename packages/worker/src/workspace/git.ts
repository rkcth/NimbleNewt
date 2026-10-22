import { execFile } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { WorkspaceBridge, ABSENT, versionOf, type WriteResult } from "./bridge.js";
import { WorkspaceError } from "./errors.js";
import { touchesGit } from "./names.js";
import { NOFOLLOW, resolveSafe } from "./paths.js";
import { constants } from "node:fs";
import { open } from "node:fs/promises";

export const GIT_LIMITS = { output: 16 * 1024 * 1024, timeoutMs: 120_000, files: 10_000, fileBytes: 8 * 1024 * 1024 } as const;
const COMMIT = /^[0-9a-f]{40}$/;

/**
 * Git as the controller runs it against an agent's checkout (card A04, part 2). The checkout is a plain directory of files with **no `.git` in it**: its repository lives in a separate git directory the
 * agent never sees (`--git-dir` and `--work-tree` name both), so there is no `.git` for the agent to write, replace or rename, and a `.git` the agent creates inside the checkout is only a file to
 * be refused. Every command runs with a fixed environment (no system or user configuration, no prompts), hooks pointed at an empty directory, and the settings that would run a program named by a
 * repository turned off on the command line, which wins over any configuration file. Nothing here runs a hook, a filter or an external diff the agent supplied.
 */
export class GitBridge {
  readonly #empty: string;
  readonly #git: string;

  /** `scratch` is a directory only the controller can write: it holds the empty hooks directory and the empty home. */
  private constructor(scratch: string, git: string) { this.#empty = scratch; this.#git = git; }

  static async create(options: { scratch: string; git?: string }): Promise<GitBridge> {
    const scratch = await realpath(await mkdir(options.scratch, { recursive: true, mode: 0o700 }).then(() => options.scratch));
    await mkdir(join(scratch, "no-hooks"), { recursive: true, mode: 0o700 });
    await mkdir(join(scratch, "home"), { recursive: true, mode: 0o700 });
    return new GitBridge(scratch, options.git ?? "git");
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

  async #run(args: readonly string[], options: { gitDir?: string; workTree?: string; input?: string; allowFile?: boolean } = {}): Promise<{ stdout: string; stderr: string }> {
    const locator = [...(options.gitDir === undefined ? [] : ["--git-dir", options.gitDir]), ...(options.workTree === undefined ? [] : ["--work-tree", options.workTree])];
    const flags = this.#flags().map((f) => (options.allowFile === true && f === "protocol.file.allow=never" ? "protocol.file.allow=always" : f === "protocol.allow=never" && options.allowFile === true ? "protocol.allow=user" : f));
    return new Promise((resolveRun, reject) => {
      const child = execFile(this.#git, [...locator, ...flags, ...args], { env: this.#env(), maxBuffer: GIT_LIMITS.output, timeout: GIT_LIMITS.timeoutMs, windowsHide: true, encoding: "utf8", cwd: options.workTree ?? this.#empty }, (error, stdout, stderr) => {
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
    const sharedGit = await this.#sharedGitDir(options.shared);
    await this.#run(["fetch", "--no-tags", "--no-recurse-submodules", sharedGit, options.commit], { gitDir: options.gitDir, allowFile: true });
    await this.#run(["read-tree", "-m", "-u", await this.#base(options.gitDir), options.commit], { gitDir: options.gitDir, workTree: options.checkout });
    await this.#run(["update-ref", "refs/nn/base", options.commit], { gitDir: options.gitDir });
    await this.#run(["update-ref", "HEAD", options.commit], { gitDir: options.gitDir });
    return { base: options.commit };
  }

  async #base(gitDir: string): Promise<string> {
    return (await this.#run(["rev-parse", "--verify", "refs/nn/base"], { gitDir })).stdout.trim();
  }

  /**
   * What the agent changed, ready to go through the bridge: the checkout's files that differ from the base (added, modified, deleted), checked first. A change that touches Git's data, is a link, is too
   * big, or is one of too many is refused for the whole set, and nothing is staged or written anywhere.
   */
  async changes(options: { gitDir: string; checkout: string }): Promise<{ path: string; op: "write" | "delete"; baseVersion: string; modeOnly: boolean }[]> {
    await this.#refuseGitData(options.checkout);
    const state = await this.status(options);
    if (state.entries.length > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files changed`);
    const base = await this.#base(options.gitDir);
    const out: { path: string; op: "write" | "delete"; baseVersion: string; modeOnly: boolean }[] = [];
    for (const e of state.entries) {
      const parts = e.path.split("/");
      if (touchesGit(parts)) throw new WorkspaceError("protected_path", `${JSON.stringify(e.path.slice(0, 80))} is or lies inside Git's own data; the whole change was refused`);
      const deleted = e.code.includes("D");
      let baseVersion = ABSENT;
      let modeOnly = false;
      if (!e.code.includes("?") && !e.code.includes("!") && !e.code.includes("A")) {
        const bytes = await this.#baseBytes(options.gitDir, e.path, e.path);
        if (bytes !== undefined) {
          baseVersion = versionOf(bytes);
          if (!deleted) {
            const safe = await resolveSafe(options.checkout, e.path).catch(() => undefined);
            if (safe?.exists === "file") modeOnly = (await this.#readChecked(safe.absolute, e.path)).equals(bytes);
          }
        }
      }
      out.push({ path: e.path, op: deleted ? "delete" : "write", baseVersion, modeOnly });
    }
    return out;
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
      results.push({ path: r.path, result: r.op === "delete"
        ? await options.bridge.remove({ path: r.path, expectedVersion: r.expectedVersion, author: options.author, reason: options.reason })
        : await options.bridge.write({ path: r.path, expectedVersion: r.expectedVersion, content: r.content!, author: options.author, reason: options.reason }) });
    }
    return results;
  }

  /** A file of the checkout, opened without following a link, as a plain file within the size limit. */
  async #readChecked(absolute: string, shown: string): Promise<Buffer> {
    const handle = await open(absolute, constants.O_RDONLY | NOFOLLOW).catch(() => { throw new WorkspaceError("link_refused", `${JSON.stringify(shown.slice(0, 80))} could not be opened without following a link`); });
    try {
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
      for (const name of await readdir(dir)) {
        if (++seen > 200_000) throw new WorkspaceError("invalid_path", "the checkout holds too many files to check");
        if (touchesGit([name])) throw new WorkspaceError("protected_path", `the checkout holds ${JSON.stringify(name.slice(0, 40))}, which is Git's own name; the whole change was refused`);
        const info = await lstat(join(dir, name));
        if (info.isDirectory()) await walk(join(dir, name), depth + 1);
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

  /** The ID of a commit in the shared repository's current head (the controller's own read). */
  async head(shared: string): Promise<string> {
    return (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: await this.#sharedGitDir(shared) })).stdout.trim();
  }
}

void mkdtemp; void tmpdir; void resolve; void readFile;
