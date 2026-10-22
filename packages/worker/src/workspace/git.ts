import { createHash, randomBytes } from "node:crypto";
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

  /**
   * Stages the checkout for review: everything the agent changed that git does not ignore is added to the checkout's own index, and the tree it makes, the base commit and the list of staged files
   * are returned (with the files an ignore rule keeps out, so that nothing is unseen). A Git-named entry, a link or a submodule entry anywhere refuses the whole thing. The tree ID is what a
   * reviewer approves and what `commit` will insist on.
   */
  async stage(options: { gitDir: string; checkout: string }): Promise<{ base: string; tree: string; files: { path: string; op: "write" | "delete" }[]; ignored: string[] }> {
    await this.#refuseGitData(options.checkout);
    await this.#run(["add", "-A"], { gitDir: options.gitDir, workTree: options.checkout });
    const listing = (await this.#run(["ls-files", "-s", "-z"], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
    for (const line of listing) {
      const mode = line.slice(0, 6);
      const path = line.slice(line.indexOf("\t") + 1);
      if (mode === "120000" || mode === "160000") throw new WorkspaceError("link_refused", `${JSON.stringify(path.slice(0, 80))} is a link or a submodule entry, which a commit through the bridge does not carry`);
    }
    // A commit builds on the checkout's own head (an earlier commit of its own, or the base the checkout started from).
    const base = (await this.#run(["rev-parse", "--verify", "HEAD"], { gitDir: options.gitDir })).stdout.trim();
    const tree = (await this.#run(["write-tree"], { gitDir: options.gitDir })).stdout.trim();
    const diff = (await this.#run(["diff", "--cached", "--name-status", "-z", "--no-renames", base], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
    const files: { path: string; op: "write" | "delete" }[] = [];
    for (let i = 0; i + 1 < diff.length; i += 2) files.push({ path: diff[i + 1]!, op: diff[i] === "D" ? "delete" : "write" });
    if (files.length > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files are staged`);
    const status = await this.status(options);
    return { base, tree, files, ignored: status.entries.filter((e) => e.code === "!!").map((e) => e.path) };
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
    // The checkout's branch moves only from the reviewed base to the new commit.
    await this.#run(["update-ref", "HEAD", commitId, permit.base], { gitDir: options.gitDir });
    return { commitId, parent: permit.base };
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

  /** The ID of a commit in the shared repository's current head (the controller's own read). */
  async head(shared: string): Promise<string> {
    return (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: await this.#sharedGitDir(shared) })).stdout.trim();
  }
}

void mkdtemp; void tmpdir; void resolve; void readFile;
