import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { appendFile, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { PLAN_FILE } from "@nimblenewt/contracts";
import { WorkspaceBridge, ABSENT, versionOf, type WriteResult } from "./bridge.js";
import { WorkspaceError } from "./errors.js";
import { collisionKey, fold, splitRelative, touchesGit } from "./names.js";
import { BLOCK_REASON, CONTRIBUTION_LIMITS, asksSignOff, instructionKind, instructionOrder, instructionText, isIgnoreRuleFile, isIntended, isNimbleNewtState, readIntended, shortReason, unfitName, type ContributionBlock, type InstructionKind } from "./contribution.js";
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
/** A landing branch name as the owner's `workspace.landing.branch` accepts it (the same shape the controller carries to a remote host). */
const BRANCH_NAME = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
/** A full object ID (SHA-1 or SHA-256). */
const OBJECT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** What `snapshot` says of a name with nothing at it. */
const ABSENT_FILE = "absent";
/** A file's identity, size and times (nanoseconds): any write to it, or its replacement, changes this. */
const stamp = (s: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint; isFile(): boolean; isDirectory(): boolean }): string => `${s.isFile() ? "f" : s.isDirectory() ? "d" : "o"}:${s.dev}:${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`;
/** How a name in the checkout looks now, without following a link at it (`ABSENT_FILE` when nothing is there). */
const snapshot = async (absolute: string): Promise<string> => {
  try { return stamp(await lstat(absolute, { bigint: true })); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ENOTDIR") return ABSENT_FILE; return `error:${String((error as NodeJS.ErrnoException).code)}`; }
};
/** The refusal of a refresh that met a file the agent changed while it ran. */
const changedWhile = (path: string, partial: boolean): string => `${JSON.stringify(path.slice(0, 80))} changed while the refresh ran (something in your attempt is writing it), so it was not overwritten and the refresh stopped${partial ? ": files before it may already hold the landing branch's version, your base is still the old one, and asking again finishes the refresh" : " before writing anything"}; ask again when nothing is writing your checkout`;
/** Bounds of `GitBridge.doneState` (card W05): the uncommitted files it names, and the evidence paths it looks at. */
export const DONE_STATE_LIMITS = { named: 20, paths: 30 } as const;
/** Where the commits made through a permit are listed: a file in the checkout's git directory (host side, outside the checkout the agent edits). Text in a commit message proves nothing; a commit counts as permitted only if `commit()` made it and listed it here. */
export const permitLedgerPath = (gitDir: string): string => join(gitDir, "nn-permit-ledger");

/** Where the commits the release operation made are listed (host side, in the checkout's git directory). They are not permit commits: `unpermitted` does not read this file. */
export const releaseLedgerPath = (gitDir: string): string => join(gitDir, "nn-release-ledger");
/** The approved submission a release commits (card H12o): its ID and the base commit and tree that were submitted and approved. */
export interface ApprovedSubmission { readonly id: string; readonly base: string; readonly tree: string }
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
/** Whether a value is an `ApprovedSubmission` of the controller's form (exactly those three fields). */
export const isApprovedSubmission = (value: unknown): value is ApprovedSubmission => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return Object.keys(o).every((k) => k === "id" || k === "base" || k === "tree") && typeof o["id"] === "string" && /^sbm-[a-z2-7]{20}$/.test(o["id"]) && typeof o["base"] === "string" && OID.test(o["base"]) && typeof o["tree"] === "string" && OID.test(o["tree"]);
};
/** How much of the end of the release ledger is read to find a submission's earlier commit (its newest lines; a line is under 200 bytes). */
const RELEASE_LEDGER_READ = 256 * 1024;
/** The last `max` bytes of a file as text (from the first whole line), or "" when it cannot be read. */
async function readTail(path: string, max: number): Promise<string> {
  let handle;
  try { handle = await open(path, constants.O_RDONLY | NOFOLLOW); } catch { return ""; }
  try {
    const size = (await handle.stat()).size;
    const length = Math.min(size, max);
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, size - length);
    const text = buffer.toString("utf8");
    return size > max ? text.slice(text.indexOf("\n") + 1) : text;
  } catch { return ""; } finally { await handle.close(); }
}
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

  async #run(givenArgs: readonly string[], givenOptions: { gitDir?: string; workTree?: string; input?: string; allowFile?: boolean; env?: NodeJS.ProcessEnv } = {}): Promise<{ stdout: string; stderr: string }> {
    let args = givenArgs;
    let options = givenOptions;
    // Card W09b review: the folder of a submodule entry (gitlink) can hold a repository the agent made in its sandbox. A git that looks into it (a status, or an add once the entry matches that repository's
    // head) starts a git there that reads that repository's own configuration (a clean filter, for one) here on the host, outside the sandbox. So a status over a checkout never looks into a submodule, and
    // an add leaves every gitlink path of its index out (the entry stays as it was; the bridge never carries one). The paths go on standard input, literally.
    if (options.workTree !== undefined && args[0] === "status") args = ["status", "--ignore-submodules=all", ...args.slice(1)];
    if (options.workTree !== undefined && args[0] === "add") {
      if (args.some((a, i) => i > 0 && !a.startsWith("-")) || options.input !== undefined) throw new WorkspaceError("unavailable", "an add over a checkout takes no paths of its own");
      const listed = await this.#run(["ls-files", "-s", "-z"], { ...(options.gitDir === undefined ? {} : { gitDir: options.gitDir }), ...(options.env === undefined ? {} : { env: options.env }) });
      const links = listed.stdout.split("\0").filter((l) => l.startsWith("160000 ")).map((l) => l.slice(l.indexOf("\t") + 1));
      args = [...args, "--pathspec-from-file=-", "--pathspec-file-nul"];
      options = { ...options, input: [".", ...links.map((p) => `:(exclude,literal)${p}`)].map((p) => `${p}\0`).join("") };
    }
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
    // The checkout holds exactly the committed bytes (follow-up of the H12n re-check): without the neutral attribute file an `eol`, `text`, `ident` or `filter` attribute of the base would write converted
    // files, which every later read through the neutral file (`stage`, `submitView`, `doneState`) would then see as changes the agent never made. The file stays in the git directory, so later reads agree.
    await this.#neutralAttributes(options.gitDir);
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
    // Every read of a checkout uses the neutral attribute file (first review of the H12n re-check follow-up), not only the ones that stage: a checkout made before `createCheckout` wrote it would
    // otherwise be read with the base's conversions here, in `refresh` (which writes files after this check), `changes` and `diffStat`, and disagree with `stage`.
    await this.#neutralAttributes(options.gitDir);
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
  async reapply(options: { shared: string; commit: string; gitDir: string; checkout: string; hooks?: { beforeOpen?: (absolute: string) => Promise<void>; /** Tests only: once a file is open for writing and checked, just before it is cut. */ afterOpen?: (absolute: string) => Promise<void> } }): Promise<{ base: string; previous: string; unchanged: boolean; kept: string[]; taken: string[]; merged: string[]; conflicts: { path: string; kind: "overlap" | "deleted-here" | "deleted-there" | "binary" | "both-added" }[] }> {
    if (!COMMIT.test(options.commit)) throw new WorkspaceError("invalid_path", "a refresh goes to a full commit ID");
    const previous = await this.#base(options.gitDir);
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
    // The checkout is LIVE (H12p review): the agent, a job it started or a parallel tool call may write while this runs. Each file this refresh may write or delete is looked at BEFORE the agent's work is
    // read, and looked at again before the first write and on the opened file just before it is written: a file that changed in between is not overwritten (the refresh stops, `stale`), so a write the agent
    // made meanwhile is never lost silently. Files the landing branch did not change are never touched, so writes to them cannot race.
    const seen = new Map<string, string>();
    for (const path of theirs.keys()) seen.set(path, await snapshot(join(options.checkout, path)));
    const mine = new Map((await this.changes(options)).map((c) => [c.path, { op: c.op, modeOnly: c.modeOnly }] as const));
    const result = { base: options.commit, previous, unchanged: previous === options.commit, kept: [...mine.keys()].filter((p) => !theirs.has(p)).sort(), taken: [] as string[], merged: [] as string[], conflicts: [] as { path: string; kind: "overlap" | "deleted-here" | "deleted-there" | "binary" | "both-added" }[] };
    // Nothing to do on the same head: the refs, the index and the agent's own commits stay as they are.
    if (result.unchanged) return result;
    const stage = await mkdtemp(join(options.gitDir, "nn-reapply-"));
    try {
      const steps: { path: string; source?: string; mode?: number; prior?: Buffer }[] = [];
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
        steps.push({ path, source, prior: here, ...(info.mode !== info.oldMode ? { mode: modeOf(info.mode) } : {}) });
        if (outcome.conflicts === 0) result.merged.push(path); else result.conflicts.push({ path, kind: "overlap" });
      }
      // Every path is checked before the first write; a missing directory on the way is made below.
      for (const s of steps) {
        const safe = await resolveSafe(options.checkout, s.path, { forWrite: s.source !== undefined }).catch((error: unknown) => { if (error instanceof WorkspaceError && error.code === "not_found") return undefined; throw error; });
        if (safe?.exists === "directory" && s.source !== undefined) throw new WorkspaceError("invalid_path", `${JSON.stringify(s.path.slice(0, 80))} is a directory in the checkout; nothing was changed`);
      }
      // Nothing is written when a file changed after it was looked at (the agent is writing): the refresh stops before its first write and can be asked again.
      for (const s of steps) if ((await snapshot(join(options.checkout, s.path))) !== seen.get(s.path)) throw new WorkspaceError("stale", changedWhile(s.path, false));
      for (const s of steps) if (s.source !== undefined) await resolveSafe(options.checkout, s.path, { forWrite: true, createParents: true });
      for (const s of steps) {
        const safe = await resolveSafe(options.checkout, s.path, { forWrite: true, createParents: true });
        if (s.source === undefined) {
          if (safe.exists === "file") {
            if ((await snapshot(safe.absolute)) !== seen.get(s.path)) throw new WorkspaceError("stale", changedWhile(s.path, true));
            await rm(safe.absolute);
          }
          continue;
        }
        if (safe.exists === "directory") throw new WorkspaceError("invalid_path", `${JSON.stringify(s.path.slice(0, 80))} is a directory in the checkout; the refresh stopped there`);
        await options.hooks?.beforeOpen?.(safe.absolute);
        // A file that was not there when looked at is created exclusively: one the agent made meanwhile is not overwritten.
        const absent = seen.get(s.path) === ABSENT_FILE;
        let handle;
        try { handle = await open(safe.absolute, constants.O_WRONLY | constants.O_CREAT | (absent ? constants.O_EXCL : 0) | NOFOLLOW, 0o644); } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ELOOP") throw new WorkspaceError("link_refused", `${JSON.stringify(s.path.slice(0, 80))} became a link while the refresh ran; it was not written`, { tamper: true });
          if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new WorkspaceError("stale", changedWhile(s.path, true));
          throw new WorkspaceError("unavailable", `${JSON.stringify(s.path.slice(0, 80))} could not be opened for writing`);
        }
        try {
          const opened = await handle.stat();
          const now = await lstat(safe.absolute).catch(() => undefined);
          const parent = await realpath(dirname(safe.absolute)).catch(() => undefined);
          if (now === undefined || !now.isFile() || !sameFile(opened, now) || opened.nlink > 1 || parent !== safe.parent || !(await openedAt(handle, safe.absolute))) throw new WorkspaceError("link_refused", `${JSON.stringify(s.path.slice(0, 80))} was swapped while the refresh ran; it was not written`, { tamper: true });
          // The opened file must still be the one looked at before the agent's work was read (same file, size and times): otherwise the agent wrote it meanwhile and it is not overwritten.
          if (!absent && stamp(await handle.stat({ bigint: true })) !== seen.get(s.path)) throw new WorkspaceError("stale", changedWhile(s.path, true));
          await options.hooks?.afterOpen?.(safe.absolute);
          await handle.truncate(0);
          if (s.mode !== undefined) await handle.chmod(s.mode);
          // Copied through this handle in chunks (it stays this function's), so a failed write is undone through it too.
          try { await copyInto(s.source, handle); } catch (error) {
            // A merged file holds the agent's work: when its new content could not be written whole (a full disk, a read error), the agent's version is put back, never left cut short.
            // It is written back through the handle that cut the file, not by opening the path again: the same file for certain, and on Windows that second open failed (CI repair round 12:
            // "could NOT be put back"), which left the agent's file cut short.
            if (s.prior === undefined) throw error;
            let back = false;
            try {
              await handle.truncate(0);
              let at = 0;
              while (at < s.prior.length) { const { bytesWritten } = await handle.write(s.prior, at, s.prior.length - at, at); if (bytesWritten <= 0) break; at += bytesWritten; }
              back = at === s.prior.length;
            } catch { back = false; }
            throw new WorkspaceError("unavailable", `${JSON.stringify(s.path.slice(0, 80))} could not be written; ${back ? "your version of it was put back" : "your version of it could NOT be put back, so the file may be cut short"} and the refresh stopped there (ask again)`, { cause: error });
          }
        } finally { await handle.close().catch(() => undefined); }
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
        execFile(this.#git, [...this.#flags(), "--git-dir", gitDir, "merge-file", "-p", "--diff3", "-L", "mine", "-L", "base", "-L", label, join(dir, "mine"), join(dir, "base"), join(dir, "landing")], { env: this.#env(), encoding: "buffer", maxBuffer: GIT_LIMITS.fileBytes * 2, windowsHide: true, cwd: this.#empty, timeout: GIT_LIMITS.timeoutMs }, (error, stdout) => {
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

  /**
   * What a checkout holds at a moment (card P02: the initial working state an attempt starts from): its base, its HEAD, the tree of the checkout as it stands (every file git does not ignore, written through a private
   * index, so the checkout's own index is not touched) and the files that differ from HEAD or are untracked, with their two-letter status. Reads with the same neutral attributes as `doneState` and `stage`, so a
   * conversion attribute cannot hide a change. Ignored files are not part of it.
   */
  async startState(options: { gitDir: string; checkout: string }): Promise<{ base: string; head: string; tree: string; entries: { code: string; path: string }[] }> {
    await this.#neutralAttributes(options.gitDir);
    const base = await this.#base(options.gitDir);
    const head = (await this.#run(["rev-parse", "--verify", "HEAD"], { gitDir: options.gitDir })).stdout.trim();
    const status = (await this.#run(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--no-renames"], { gitDir: options.gitDir, workTree: options.checkout })).stdout;
    const entries = status.split("\0").filter(Boolean).map((e) => ({ code: e.slice(0, 2), path: e.slice(3) }));
    const index = join(options.gitDir, `nn-index-${randomBytes(6).toString("hex")}`);
    let tree: string;
    try {
      await this.#run(["read-tree", head], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } });
      await this.#run(["add", "-A"], { gitDir: options.gitDir, workTree: options.checkout, env: { GIT_INDEX_FILE: index } });
      tree = (await this.#run(["write-tree"], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } })).stdout.trim();
    } finally { await rm(index, { force: true }); }
    if (!/^[0-9a-f]{40,64}$/.test(tree) || !/^[0-9a-f]{40,64}$/.test(head)) throw new WorkspaceError("invalid_path", "the checkout's state could not be read");
    return { base, head, tree, entries };
  }

  /**
   * Card Q04 (second review): `tree` with the agent's plan file at its top (`PLAN_FILE`, in any case, as a plain or executable file) left out. Every agent is told to keep that file in its checkout (the completion rules),
   * so a reviewer that keeps it changes nothing else; who left changes in the checkout is told on this tree. Answers `tree` itself when it holds no such file. Throws when git cannot read or write the tree.
   */
  async withoutPlan(options: { gitDir: string; tree: string }): Promise<string> {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(options.tree)) throw new WorkspaceError("invalid_path", "a tree is named by its full ID");
    const listed = (await this.#run(["ls-tree", "-z", options.tree], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
    const plan = PLAN_FILE.toLowerCase();
    const kept = listed.filter((e) => { const tab = e.indexOf("\t"); return !(/^100(?:644|755) blob /.test(e) && e.slice(tab + 1).toLowerCase() === plan); });
    if (kept.length === listed.length) return options.tree;
    const tree = (await this.#run(["mktree", "-z"], { gitDir: options.gitDir, input: kept.map((e) => `${e}\0`).join("") })).stdout.trim();
    if (!/^[0-9a-f]{40,64}$/.test(tree)) throw new WorkspaceError("invalid_path", "the checkout's state could not be read");
    return tree;
  }

  /** The tree of a commit of the checkout's own repository (card P10: a landing of a queued submission compares the committed work with the approved tree). */
  async treeOf(options: { gitDir: string; commit: string }): Promise<string> {
    if (!/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/.test(options.commit)) throw new WorkspaceError("invalid_path", "a commit is named by its full ID");
    return (await this.#run(["rev-parse", "--verify", `${options.commit}^{tree}`], { gitDir: options.gitDir })).stdout.trim();
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
    await this.#neutralAttributes(options.gitDir);
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
    await this.#neutralAttributes(options.gitDir);
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
    // The same attribute neutralizing as `stage` and `submitView` (W05 follow-up): a `text`, `eol`, `ident` or encoding attribute must not turn a change the submission would carry into "no change" here.
    await this.#neutralAttributes(options.gitDir);
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
  async stage(options: { gitDir: string; checkout: string; /** Asked with the staged files and sizes before the staging is answered; a throw refuses it and the index is put back to the head, as for a refusal here. */ check?: (files: readonly { path: string; op: "write" | "delete" }[], sizes: ReadonlyMap<string, number>) => void }): Promise<{ base: string; tree: string; files: { path: string; op: "write" | "delete" }[]; ignored: string[]; /** The size in bytes of each written file as it was staged (read again without following a link). */ sizes: Map<string, number> }> {
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
    const sizes = new Map<string, number>();
    try {
      for (const f of files) if (f.op === "write") sizes.set(f.path, await this.#sameAsStaged(options.checkout, f.path, blobs.get(f.path)));
      options.check?.(files, sizes);
    } catch (error) {
      await this.#run(["read-tree", base], { gitDir: options.gitDir }).catch(() => undefined);
      throw error;
    }
    const status = await this.status(options);
    return { base, tree, files, ignored: status.entries.filter((e) => e.code === "!!").map((e) => e.path), sizes };
  }

  /**
   * What a submit of the agent's work is checked against (card H12n), read only: the commit the checkout is based on (`refs/nn/base`), the shared repository's head now (the landing branch, as the author's refresh reads it, H12p),
   * the files the agent changed against the base as a submission would carry them (committed or not, not ignored: a throwaway index filled from the base and then with the checkout, as `doneState`), and the files the landing
   * branch changed between the base and its head (read in the shared repository; none when the head is the base). The checkout, its index and its refs are not touched. Too many files on either side refuses.
   * The `base` returned is the commit the staging builds on (the checkout's own head, as `stage` reports it): the same as `refs/nn/base` unless the checkout holds a platform commit that has not landed yet (a release, H12o),
   * whose files then count as the agent's (they are not on the landing branch). Reporting the head keeps it equal to what `stage` reports, which the submit compares (first review).
   */
  async submitView(options: { shared: string; gitDir: string; checkout: string; /** The landing branch's head as the host read it (card H12p follow-up: the owner's landing branch when one is set). Absent: the shared repository's checked-out head, as before. */ head?: string }): Promise<{ base: string; head: string; mine: string[]; landed: string[] }> {
    if (options.head !== undefined && !COMMIT.test(options.head)) throw new WorkspaceError("invalid_path", "a submit is checked against a full commit ID");
    const base = await this.#base(options.gitDir);
    const tip = (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: options.gitDir })).stdout.trim();
    const sharedGit = await this.#sharedGitDir(options.shared);
    const head = options.head ?? (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: sharedGit })).stdout.trim();
    // The same attribute neutralizing as `stage` (second review): without it a `text`, `eol`, `ident` or encoding attribute in the checkout converts a file back to the base's content here while `stage` carries
    // it changed, so a file the submission carries would be missing from `mine` and its overlap with the landing branch unseen.
    await this.#neutralAttributes(options.gitDir);
    const index = join(options.gitDir, `nn-index-${randomBytes(6).toString("hex")}`);
    let mine: string[];
    try {
      await this.#run(["read-tree", base], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } });
      await this.#run(["add", "-A"], { gitDir: options.gitDir, workTree: options.checkout, env: { GIT_INDEX_FILE: index } });
      mine = (await this.#run(["diff", "--cached", "--name-only", "-z", "--no-renames", base], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } })).stdout.split("\0").filter(Boolean);
    } finally { await rm(index, { force: true }); }
    if (mine.length > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files changed in the checkout`);
    const landed = base === head ? [] : (await this.#run(["diff", "--name-only", "-z", "--no-renames", base, head], { gitDir: sharedGit })).stdout.split("\0").filter(Boolean);
    if (landed.length > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files changed on the landing branch`);
    return { base: tip, head, mine: mine.sort(), landed: landed.sort() };
  }

  /**
   * The stable patch ID of what the checkout's index holds against `base` (card H12n): call it right after `stage`, so it names the same change as the staged tree. Binary files are included in full
   * (`--binary`, full object names), so two different binary changes never share an ID. `undefined` when the index holds no change against the base. It is `git patch-id --verbatim` (stable, git 2.39 or later): the plain
   * `--stable` ID strips all whitespace from each line, so a change that only re-indents a line (Python, YAML, Makefiles) or alters the spacing inside a string would keep the ID of what was reviewed, and a review
   * would carry over to it at landing (card P09 second review).
   */
  async patchId(options: { gitDir: string; base: string; /** Card P09: a commit or tree to compare the base with instead of the index (the committed change a landing would carry). The diff has the same form, so the same change gives the same ID. */ to?: string }): Promise<string | undefined> {
    if (!COMMIT.test(options.base)) throw new WorkspaceError("invalid_path", "a patch ID is taken against a full base commit");
    if (options.to !== undefined && !OBJECT.test(options.to)) throw new WorkspaceError("invalid_path", "a patch ID is taken up to a full object ID");
    // The diff is streamed into `patch-id` (second review of the product launcher slice): held in memory it failed past the output buffer (about 50 MB of change) with an empty "git diff failed:" text, so a large change
    // could never be submitted and the owner was told nothing. Both processes are bounded by the same time limit; only the few bytes of `patch-id`'s answer and the start of each error text are kept.
    const diffArgs = ["diff", ...(options.to === undefined ? ["--cached"] : []), "--binary", "--full-index", "--no-renames", "--no-ext-diff", "--no-textconv", "--no-color", options.base, ...(options.to === undefined ? [] : [options.to])];
    const { bytes, out } = await new Promise<{ bytes: number; out: string }>((resolveRun, reject) => {
      const spawnOptions = { env: this.#env(), windowsHide: true, cwd: this.#empty };
      const diff = spawn(this.#git, ["--git-dir", options.gitDir, ...this.#flags(), ...diffArgs], { ...spawnOptions, stdio: ["ignore", "pipe", "pipe"] });
      const ids = spawn(this.#git, ["--git-dir", options.gitDir, ...this.#flags(), "patch-id", "--verbatim"], { ...spawnOptions, stdio: ["pipe", "pipe", "pipe"] });
      let bytes = 0, out = "", diffErr = "", idsErr = "", failed: Error | undefined, pending = 2;
      const codes: { diff?: number | null; ids?: number | null } = {};
      const keep = (text: string, chunk: Buffer): string => (text.length < 400 ? text + chunk.toString("utf8") : text);
      const timer = setTimeout(() => { failed ??= new WorkspaceError("unavailable", `git diff did not finish within ${GIT_LIMITS.timeoutMs} ms`); diff.kill("SIGKILL"); ids.kill("SIGKILL"); }, GIT_LIMITS.timeoutMs);
      const done = (): void => {
        if (--pending > 0) return;
        clearTimeout(timer);
        if (failed !== undefined) return reject(failed);
        if (codes.diff !== 0) return reject(new WorkspaceError("unavailable", `git diff failed: ${diffErr.replace(/\s+/g, " ").slice(0, 200)}`));
        if (codes.ids !== 0) return reject(new WorkspaceError("unavailable", `git patch-id failed: ${idsErr.replace(/\s+/g, " ").slice(0, 200)}`));
        resolveRun({ bytes, out });
      };
      const broke = (error: Error & { code?: string }): void => { failed ??= error.code === "ENOENT" ? new WorkspaceError("unavailable", "git is not installed on this host") : new WorkspaceError("unavailable", `git could not be run: ${error.message.slice(0, 120)}`); };
      diff.on("error", (error) => { broke(error); ids.stdin.end(); }); ids.on("error", broke);
      diff.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; });
      diff.stdout.pipe(ids.stdin);
      ids.stdin.on("error", () => undefined);
      diff.stderr.on("data", (chunk: Buffer) => { diffErr = keep(diffErr, chunk); });
      ids.stderr.on("data", (chunk: Buffer) => { idsErr = keep(idsErr, chunk); });
      ids.stdout.on("data", (chunk: Buffer) => { out = keep(out, chunk); });
      diff.on("close", (code) => { codes.diff = code; done(); });
      ids.on("close", (code) => { codes.ids = code; done(); });
    });
    if (bytes === 0) return undefined;
    const id = out.trim().split(/\s+/)[0] ?? "";
    if (!/^[0-9a-f]{40,64}$/.test(id)) throw new WorkspaceError("unavailable", "git patch-id gave no ID for the staged change");
    return id;
  }

  /** Refuses unless the file at `path` in the checkout, opened without following a link at any name and without blocking, is a plain file whose Git blob ID is `staged`. */
  async #sameAsStaged(checkout: string, path: string, staged: string | undefined): Promise<number> {
    const changed = (): WorkspaceError => new WorkspaceError("link_refused", `${JSON.stringify(path.slice(0, 80))} changed or was replaced by a link while it was being staged; nothing was committed`, { tamper: true });
    if (staged === undefined || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(staged)) throw changed();
    // A name no system-wide path can hold (a control character, `"`, a device name, a trailing dot, too long) or one that is another spelling of a file beside it is refused as what it is, not as a swap (second review of the
    // product launcher slice: it read "changed or was replaced by a link" and was reported as an escape attempt). Neither depends on a race: the name and its neighbours are the agent's own.
    const unfit = (error: WorkspaceError): WorkspaceError => new WorkspaceError(error.code, `${JSON.stringify(path.slice(0, 80))} cannot be carried: ${error.message}; nothing was staged`);
    try { splitRelative(path, { rootLength: (await realpath(checkout)).length }); } catch (error) { throw error instanceof WorkspaceError ? unfit(error) : changed(); }
    const safe = await resolveSafe(checkout, path).catch((error: unknown) => { throw error instanceof WorkspaceError && error.code === "collision" ? unfit(error) : changed(); });
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
      return read;
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
  async release(options: { gitDir: string; checkout: string; requestId: string; taskId: string; attemptId?: string; submission?: ApprovedSubmission; permit?: boolean }): Promise<{ commitId?: string; parent: string; tree: string; files: { path: string; op: "write" | "delete" }[]; ignored: string[]; recovered?: boolean; permitted?: boolean }> {
    if (!/^wsr-[a-z2-7]{20}$/.test(options.requestId)) throw new WorkspaceError("invalid_path", "a release names a request ID of the controller's form");
    if (!/^[A-Za-z0-9._:-]{1,120}$/.test(options.taskId) || (options.attemptId !== undefined && !/^[A-Za-z0-9._:-]{1,120}$/.test(options.attemptId))) throw new WorkspaceError("invalid_path", "a release names a plain task and attempt");
    const submission = options.submission;
    if (submission !== undefined && !isApprovedSubmission(submission)) throw new WorkspaceError("invalid_path", "a release of a submission names a submission ID and a full base commit and tree");
    // Card H12o: a submission's commit is made once. One this checkout already made (listed in the release ledger against the submission, still in the head's history, with the approved parent and tree) is the
    // answer, whatever happened after it (a controller that stopped before it recorded the commit, a retry under another request ID, more work written on top since).
    // Card H12o (permit slice): `permit` is the controller saying a reviewer other than the author approved exactly this submission; it makes the commit a review-gate permit commit (marks and a permit-ledger line). It
    // means nothing without a submission, so it is refused then.
    if (options.permit === true && submission === undefined) throw new WorkspaceError("invalid_path", "a permit commit is made only for an approved submission");
    if (submission !== undefined) {
      const earlier = await this.#releasedFor(options.gitDir, submission);
      if (earlier !== undefined) return { commitId: earlier.commitId, parent: submission.base, tree: submission.tree, files: earlier.files, ignored: [], recovered: true, permitted: (await this.unpermitted({ gitDir: options.gitDir, taskId: options.taskId, range: { base: submission.base, head: earlier.commitId } })).length === 0 };
    }
    const staged = await this.stage(options);
    if (submission !== undefined) {
      // Only the approved tree on the approved base is committed: anything else is other work, which needs its own submission and approval.
      const changed = [staged.base !== submission.base ? "the commit it is based on" : "", staged.tree !== submission.tree ? "its files" : ""].filter(Boolean);
      if (changed.length > 0) throw new WorkspaceError("stale", `the checkout no longer holds the approved work of submission ${submission.id}: ${changed.join(" and ")} changed since it was submitted; nothing was committed (a new submission and a new approval are needed)`);
      if (staged.files.length === 0) throw new WorkspaceError("stale", `submission ${submission.id} holds no change from the commit it is based on; nothing was committed`);
    }
    if (staged.files.length === 0) return { parent: staged.base, tree: staged.tree, files: [], ignored: staged.ignored };
    const permitted = options.permit === true && submission !== undefined && TRAILER_VALUE.test(options.taskId) && TRAILER_VALUE.test(options.requestId);
    const trailers = [`NimbleNewt-Task: ${options.taskId}`, `NimbleNewt-Release: ${options.requestId}`, ...(options.attemptId === undefined ? [] : [`NimbleNewt-Attempt: ${options.attemptId}`]), ...(submission === undefined ? [] : [`NimbleNewt-Submission: ${submission.id}`]), ...(permitted ? [`NimbleNewt-Request: ${options.requestId}`] : [])];
    const message = submission === undefined
      ? `Work of task ${options.taskId}${options.attemptId === undefined ? "" : ` (attempt ${options.attemptId})`}\n\nCommitted by NimbleNewt after the agent reported the work done; ${staged.files.length} file(s). Not a reviewed commit.\n\n${trailers.join("\n")}\n`
      : `Approved submission ${submission.id} of task ${options.taskId}\n\nCommitted by NimbleNewt after the submission was approved; ${staged.files.length} file(s), exactly the submitted tree on the submitted base. ${permitted ? "A permit commit: a reviewer other than its author approved exactly this tree on this base." : "Not a review-gate permit commit."}\n\n${trailers.join("\n")}\n`;
    const env = { GIT_AUTHOR_NAME: RELEASE_IDENTITY.name, GIT_AUTHOR_EMAIL: RELEASE_IDENTITY.email, GIT_COMMITTER_NAME: RELEASE_IDENTITY.name, GIT_COMMITTER_EMAIL: RELEASE_IDENTITY.email };
    const commitId = (await this.#run(["commit-tree", staged.tree, "-p", staged.base, "-F", "-"], { gitDir: options.gitDir, input: message, env })).stdout.trim();
    if (!COMMIT.test(commitId)) throw new WorkspaceError("unavailable", "git did not return a commit ID");
    // The ledger line names the submission (a fourth field), so a later release of the same submission finds this commit instead of making another.
    await appendFile(releaseLedgerPath(options.gitDir), `${commitId} ${options.requestId} ${options.attemptId ?? "-"}${submission === undefined ? "" : ` ${submission.id}`}\n`, { mode: 0o600 });
    // A permit commit is listed in the permit ledger before the head moves, as `commit()` does, so a commit on the branch is always listed.
    if (permitted) await appendFile(permitLedgerPath(options.gitDir), `${commitId} ${options.requestId}\n`, { mode: 0o600 });
    await this.#run(["update-ref", "HEAD", commitId, staged.base], { gitDir: options.gitDir });
    return { commitId, parent: staged.base, tree: staged.tree, files: staged.files, ignored: staged.ignored, ...(submission === undefined ? {} : { recovered: false, permitted }) };
  }

  /**
   * The commit an earlier release made for this submission, if one counts (card H12o): listed in the host-side release ledger against the submission (only the host's `release` writes there; the agent cannot), still in the
   * history of the checkout's head (a commit listed but never reached, a crash between the ledger line and the head move, counts for nothing), with exactly the approved parent and tree and the submission's trailer. The
   * ledger is read from its end, at most `RELEASE_LEDGER_READ` bytes (its newest lines), and at most 20 listed commits are looked at.
   */
  async #releasedFor(gitDir: string, submission: ApprovedSubmission): Promise<{ commitId: string; files: { path: string; op: "write" | "delete" }[] } | undefined> {
    const text = await readTail(releaseLedgerPath(gitDir), RELEASE_LEDGER_READ);
    const listed = text.split("\n").map((l) => l.split(" ")).filter((p) => p.length === 4 && p[3] === submission.id && OID.test(p[0]!)).map((p) => p[0]!).reverse();
    for (const commitId of [...new Set(listed)].slice(0, 20)) {
      const reached = await this.#run(["merge-base", "--is-ancestor", commitId, "HEAD"], { gitDir }).then(() => true, () => false);
      if (!reached) continue;
      const [parents = "", tree = "", ...body] = (await this.#run(["log", "-1", "--format=%P%n%T%n%B", commitId], { gitDir })).stdout.split("\n");
      if (parents.trim() !== submission.base || tree.trim() !== submission.tree || !body.includes(`NimbleNewt-Submission: ${submission.id}`)) continue;
      const diff = (await this.#run(["diff-tree", "-r", "--no-renames", "--name-status", "-z", submission.base, commitId], { gitDir })).stdout.split("\0").filter(Boolean);
      const files: { path: string; op: "write" | "delete" }[] = [];
      for (let i = 0; i + 1 < diff.length; i += 2) files.push({ path: diff[i + 1]!, op: diff[i] === "D" ? "delete" : "write" });
      return { commitId, files };
    }
    return undefined;
  }

  /** Writes the repository's own attribute file (it outranks every attribute file in the checkout): no path may name a filter, an ident expansion, a line-ending conversion or a re-encoding. Replaced atomically, only when it differs. */
  async #neutralAttributes(gitDir: string): Promise<void> {
    const file = join(gitDir, "info", "attributes");
    const text = "* -filter -ident -text -working-tree-encoding\n";
    if (await readFile(file, "utf8").catch(() => undefined) === text) return;
    // A git directory that is not there is not made here (a read of a missing checkout must not leave a directory behind): the git command that follows says it is missing.
    if (!(await stat(gitDir).then((s) => s.isDirectory(), () => false))) return;
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
  /**
   * The committed change a landing would carry (card P09): the checkout's base, its head commit, the head's tree and the stable (verbatim) patch ID of base..head (the same form as `patchId` of a staged change, so an unchanged
   * change keeps its ID across a refresh onto a newer base). A landing is made only while the base is the landing branch's head, so the head's tree is the tree the landing branch holds once it has landed. Only committed
   * objects are read; the working tree is never looked at. `patchId` is absent when the head is the base (nothing to land).
   */
  async committedChange(options: { gitDir: string }): Promise<{ base: string; head: string; tree: string; patchId?: string }> {
    const base = await this.#base(options.gitDir);
    const head = (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: options.gitDir })).stdout.trim();
    const tree = (await this.#run(["rev-parse", "--verify", `${head}^{tree}`], { gitDir: options.gitDir })).stdout.trim();
    if (!OBJECT.test(base) || !OBJECT.test(head) || !OBJECT.test(tree)) throw new WorkspaceError("unavailable", "the checkout's base, head or tree could not be read");
    if (base === head) return { base, head, tree };
    const patchId = await this.patchId({ gitDir: options.gitDir, base, to: head });
    return { base, head, tree, ...(patchId === undefined ? {} : { patchId }) };
  }

  /**
   * Writes exactly the files of `tree` (an object of the checkout's own repository) into the empty folder `into` (card P09: the landing's checks run on a copy of the integrated tree, never on the checkout). A throwaway index
   * in the git directory is used and removed; the neutral attribute file applies, so the files hold the committed bytes; links are written as plain files (`core.symlinks=false`).
   */
  async exportTree(options: { gitDir: string; tree: string; into: string }): Promise<void> {
    if (!OBJECT.test(options.tree)) throw new WorkspaceError("invalid_path", "a tree is exported by its full object ID");
    if ((await readdir(options.into)).length > 0) throw new WorkspaceError("invalid_path", "the folder a tree is exported into must be empty");
    await this.#neutralAttributes(options.gitDir);
    const index = join(options.gitDir, `nn-index-${randomBytes(6).toString("hex")}`);
    try {
      await this.#run(["read-tree", "--reset", "-u", options.tree], { gitDir: options.gitDir, workTree: options.into, env: { GIT_INDEX_FILE: index } });
    } finally { await rm(index, { force: true }); }
    await rm(join(options.into, ".git"), { recursive: true, force: true });
  }

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
  async unpermitted(options: { gitDir: string; taskId: string; range?: { base: string; head: string } }): Promise<string[]> {
    // `range`: exactly these commits (the ones a re-apply replaces, read once), not whatever the base and head are by the time this runs.
    if (options.range !== undefined && (!COMMIT.test(options.range.base) || !COMMIT.test(options.range.head))) throw new WorkspaceError("invalid_path", "a range names full commit IDs");
    const base = options.range?.base ?? (await this.#base(options.gitDir));
    const out = (await this.#run(["log", "--format=%H%x1f%B%x1e", `${base}..${options.range?.head ?? "HEAD"}`], { gitDir: options.gitDir })).stdout.split("\x1e").map((x) => x.trim()).filter(Boolean);
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
   * The change between two commits or trees of the checkout's own repository, entry by entry (card P10): each changed path with its old and new mode and its old and new object ID, sorted by path (`diff --raw --no-abbrev
   * --no-renames`, no rename or copy pairing). Two changes with the same entries carry exactly the same bytes onto the same old bytes.
   */
  async #rawChange(gitDir: string, from: string, to: string): Promise<{ path: string; line: string }[]> {
    const listing = (await this.#run(["diff", "--raw", "--no-abbrev", "-z", "--no-renames", from, to], { gitDir })).stdout.split("\0").filter(Boolean);
    if (listing.length / 2 > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files changed`);
    const out: { path: string; line: string }[] = [];
    for (let i = 0; i + 1 < listing.length; i += 2) out.push({ path: listing[i + 1]!, line: listing[i]! });
    return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /**
   * Whether two changes of the checkout's repository are the same change (card P10, a mechanically re-applied submission): the same paths, each with the same old and new mode and the same old and new object. A change
   * with no entry is never the same as anything (nothing to land).
   */
  async sameChange(options: { gitDir: string; a: { base: string; tree: string }; b: { base: string; tree: string } }): Promise<boolean> {
    for (const v of [options.a.base, options.a.tree, options.b.base, options.b.tree]) if (!OBJECT.test(v)) throw new WorkspaceError("invalid_path", "a change is named by full object IDs");
    const x = await this.#rawChange(options.gitDir, options.a.base, options.a.tree);
    const y = await this.#rawChange(options.gitDir, options.b.base, options.b.tree);
    return x.length > 0 && x.length === y.length && x.every((e, i) => e.path === y[i]!.path && e.line === y[i]!.line);
  }

  /**
   * Card P08 landing re-check (first review): whether `landed` is exactly the `judged` change carried onto `landed.base`. Git's patch ID leaves out line numbers, so the same edit placed in another of two identical
   * blocks of a file keeps the ID on any base; a judgement given on one tree is shown to hold for another only by this. On the same base the trees must be equal. On another base, `judged.base` must be an ancestor of
   * `landed.base`, and a three-way re-apply of `judged.base..judged.tree` onto `landed.base` (`merge-tree`, no rename detection, as the author's refresh and the integrator's re-apply work: file by file) must succeed with no
   * conflict and give exactly `landed.tree`. A conflict, a different tree or a base that is not a later commit answer false; a git that cannot do the re-apply (before 2.40) throws, which the caller counts as not shown.
   * The re-apply writes only objects (a commit for the judged tree, the merged trees and blobs) into the checkout's own repository; no reference and no file of the checkout changes.
   */
  async replays(options: { gitDir: string; judged: { base: string; tree: string }; landed: { base: string; tree: string } }): Promise<boolean> {
    const { judged, landed } = options;
    for (const v of [judged.base, judged.tree, landed.base, landed.tree]) if (!OBJECT.test(v)) throw new WorkspaceError("invalid_path", "a change is named by full object IDs");
    if (judged.base === landed.base) return judged.tree === landed.tree;
    if (!(await this.isAncestor({ gitDir: options.gitDir, older: judged.base, newer: landed.base }))) return false;
    const commit = (await this.#run(["commit-tree", judged.tree, "-p", judged.base, "-m", "nimblenewt landing re-check"], { gitDir: options.gitDir })).stdout.trim();
    if (!OBJECT.test(commit)) throw new WorkspaceError("unavailable", "git commit-tree gave no commit");
    let out: string;
    try {
      out = (await this.#run(["-c", "merge.renames=false", "-c", "merge.directoryRenames=false", "-c", "merge.renormalize=false", "merge-tree", "--write-tree", "--no-messages", "--name-only", `--merge-base=${judged.base}`, landed.base, commit], { gitDir: options.gitDir })).stdout;
    } catch (error) {
      // Exit status 1 is merge-tree's own answer: the re-apply has conflicts. Anything else is a failure to answer.
      if ((error as { cause?: { code?: unknown } }).cause?.code === 1) return false;
      throw error;
    }
    return out.split("\n")[0]!.trim() === landed.tree;
  }

  /** Whether commit `older` is `newer` or one of its ancestors, in the checkout's repository. */
  async isAncestor(options: { gitDir: string; older: string; newer: string }): Promise<boolean> {
    if (!OBJECT.test(options.older) || !OBJECT.test(options.newer)) throw new WorkspaceError("invalid_path", "commits are named by full IDs");
    return this.#run(["merge-base", "--is-ancestor", options.older, options.newer], { gitDir: options.gitDir }).then(() => true, () => false);
  }

  /**
   * The integrator's mechanical re-apply of an approved submission onto the landing branch's head (card P10). The checkout must be at rest (no uncommitted file) and its committed change (base..HEAD) must be exactly the
   * approved change (`submission`: base..tree), either on the approved base or already re-applied onto a later commit of the landing branch. Then:
   * - the checkout's base is `onto` already: `current` (on the approved base) or `reapplied` (an earlier re-apply, answered again), nothing written;
   * - `onto` is not a descendant of the checkout's base (the landing branch was rewritten): refused;
   * - a path the submission changes was changed on the landing branch since the checkout's base (the same path, or a folder of one and a file inside it): `overlap`, with those paths, nothing written;
   * - otherwise the files are disjoint: a new commit is made whose parent is `onto` and whose tree is `onto`'s tree with exactly the submission's entries put in (same modes, same objects), and it is proven to be the same
   *   change as the approved one (`sameChange`) before anything moves. The checkout's files that the landing branch changed are brought up to date (a two-way read-tree of a clean checkout touches only those), and the
   *   base and head move together in one ref transaction. The commit is made by the platform (the release identity). With `permit` (the task and request IDs) it is a review-gate permit commit when, and only when, every commit
   *   it replaces (base..HEAD, read before anything moves) is itself a permit commit for the task: it carries the permit's `NimbleNewt-Request:` and `NimbleNewt-Task:` marks and is listed in the host-side permit ledger
   *   (before the head moves to it), so the permit passes on from the reviewed work to its proven-identical re-apply and never from anything the gate did not permit (a release commit, a commit the agent made).
   * Nothing is merged line by line: content of a file both sides changed is never combined here.
   */
  async restack(options: { shared: string; onto: string; gitDir: string; checkout: string; submission: ApprovedSubmission; permit?: { taskId: string; requestId: string } }): Promise<
    | { state: "current" }
    | { state: "reapplied"; base: string; tree: string; commit: string; previous: string; recovered: boolean; taken: number; permitted: boolean }
    | { state: "overlap"; paths: string[]; head: string }
  > {
    const sub = options.submission;
    if (!isApprovedSubmission(sub)) throw new WorkspaceError("invalid_path", "a re-apply names a submission ID and a full base commit and tree");
    if (!COMMIT.test(options.onto)) throw new WorkspaceError("invalid_path", "a re-apply goes onto a full commit ID");
    const state = await this.status({ gitDir: options.gitDir, checkout: options.checkout });
    if (state.dirty) throw new WorkspaceError("stale", `the checkout holds ${state.entries.length} changed, new or ignored file(s) that are not committed; nothing was re-applied (only committed work lands)`);
    const base = await this.#base(options.gitDir);
    const head = (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: options.gitDir })).stdout.trim();
    const tree = (await this.#run(["rev-parse", "--verify", `${head}^{tree}`], { gitDir: options.gitDir })).stdout.trim();
    if (base === sub.base) {
      if (tree !== sub.tree) throw new WorkspaceError("stale", `the checkout's committed work is not submission ${sub.id}'s approved tree; nothing was re-applied`);
      if (base === options.onto) return { state: "current" };
    } else {
      // Re-applied before (by an earlier landing that did not finish): it counts only as exactly the approved change on a later commit of the approved base's history.
      const proven = (await this.isAncestor({ gitDir: options.gitDir, older: sub.base, newer: base })) && (await this.sameChange({ gitDir: options.gitDir, a: { base: sub.base, tree: sub.tree }, b: { base, tree } }));
      if (!proven) throw new WorkspaceError("stale", `the checkout is based on ${base.slice(0, 12)}, not on submission ${sub.id}'s approved base ${sub.base.slice(0, 12)}, and its committed change is not exactly the approved one; nothing was re-applied`);
      if (base === options.onto) return { state: "reapplied", base, tree, commit: head, previous: sub.base, recovered: true, taken: 0, permitted: options.permit !== undefined && (await this.unpermitted({ gitDir: options.gitDir, taskId: options.permit.taskId, range: { base, head } })).length === 0 };
    }
    const sharedGit = await this.#sharedGitDir(options.shared);
    await this.#run(["fetch", "--no-tags", "--no-recurse-submodules", sharedGit, options.onto], { gitDir: options.gitDir, allowFile: true });
    if (!(await this.isAncestor({ gitDir: options.gitDir, older: base, newer: options.onto }))) throw new WorkspaceError("stale", `the landing branch's head ${options.onto.slice(0, 12)} does not descend from the checkout's base ${base.slice(0, 12)} (the branch was rewritten); nothing was re-applied`);
    const mine = await this.#rawChange(options.gitDir, base, head);
    if (mine.length === 0) throw new WorkspaceError("stale", `submission ${sub.id} holds no change; nothing was re-applied`);
    const theirs = (await this.#rawChange(options.gitDir, base, options.onto)).map((e) => e.path);
    // Disjoint means no shared path, and no path of one side inside a folder the other side changed as a file (a file that became a folder, or the other way round). Paths are compared as the same file would be on a
    // case-insensitive or normalising filesystem (`collisionKey`: case, Unicode normalisation, ignorable characters), so `Foo` and `foo`, or the NFC and NFD spellings of a name, count as one path. A Git attribute file
    // changed on one side overlaps every path of the other side in its folder or below (attributes decide how the files are converted when the landed files are committed: the approved bytes must not be committed under
    // rules the review did not see). A Git ignore file is treated the same way (second review): an ignore rule the branch added can hide a file the work adds, so the landed file would not show as waiting to be
    // committed (`sharedTree` lists no ignored file) and would be left out of the integrator's commit.
    const key = (p: string): string => collisionKey(p.split("/"));
    const inside = (a: string, b: string): boolean => a.startsWith(`${b}/`);
    const attributesOver = (attr: string, p: string): boolean => {
      const parts = attr.split("/");
      const name = fold(parts[parts.length - 1]!);
      if (name !== ".gitattributes" && name !== ".gitignore") return false;
      const folder = parts.slice(0, -1).join("/");
      return folder === "" || inside(p, folder);
    };
    const theirKeys = theirs.map(key);
    const overlap = mine.filter((m) => {
      const k = key(m.path);
      return theirKeys.some((t) => t === k || inside(k, t) || inside(t, k) || attributesOver(t, k) || attributesOver(k, t));
    }).map((m) => m.path);
    if (overlap.length > 0) return { state: "overlap", paths: overlap, head: options.onto };
    for (const m of mine) {
      const [oldMode = "", newMode = ""] = m.line.slice(1).split(" ");
      if (["120000", "160000"].includes(oldMode) || ["120000", "160000"].includes(newMode)) throw new WorkspaceError("link_refused", `${JSON.stringify(m.path.slice(0, 80))} is a link or a submodule entry, which is not re-applied`);
    }
    // The new tree: the head's tree with exactly the submission's entries put in, built in a throwaway index.
    const index = join(options.gitDir, `nn-index-${randomBytes(6).toString("hex")}`);
    let built: string;
    try {
      await this.#run(["read-tree", options.onto], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } });
      const lines = mine.map((m) => {
        const [, newMode = "", , newSha = "", status = ""] = m.line.slice(1).split(" ");
        return status === "D" ? `0 ${"0".repeat(newSha.length)}\t${m.path}` : `${newMode} ${newSha}\t${m.path}`;
      });
      await this.#run(["update-index", "-z", "--index-info"], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index }, input: lines.map((l) => `${l}\0`).join("") });
      built = (await this.#run(["write-tree"], { gitDir: options.gitDir, env: { GIT_INDEX_FILE: index } })).stdout.trim();
    } finally { await rm(index, { force: true }); }
    if (!OBJECT.test(built)) throw new WorkspaceError("unavailable", "git did not return a tree ID");
    // The proof, before anything moves: the change from the head to the new tree is exactly the approved change.
    if (!(await this.sameChange({ gitDir: options.gitDir, a: { base: sub.base, tree: sub.tree }, b: { base: options.onto, tree: built } }))) throw new WorkspaceError("stale", `submission ${sub.id} could not be re-applied as exactly the approved change; nothing was re-applied`);
    // The permit passes on only from permitted work: every commit being replaced must itself be a permit commit of this task.
    const permitted = options.permit !== undefined && TRAILER_VALUE.test(options.permit.taskId) && TRAILER_VALUE.test(options.permit.requestId) && (await this.unpermitted({ gitDir: options.gitDir, taskId: options.permit.taskId, range: { base, head } })).length === 0;
    const marks = permitted ? `NimbleNewt-Request: ${options.permit!.requestId}\nNimbleNewt-Task: ${options.permit!.taskId}\n` : "";
    const message = `Re-applied submission ${sub.id}\n\nRe-applied by NimbleNewt onto ${options.onto} (the landing branch's head), unchanged: exactly the approved change, whose files the landing branch did not change since ${base}. ${permitted ? "A permit commit: the work it carries was committed through the review gate's permit and the change is proven identical." : "Not a review-gate permit commit."}\n\nNimbleNewt-Submission: ${sub.id}\nNimbleNewt-Reapplied-From: ${base}\n${marks}`;
    const env = { GIT_AUTHOR_NAME: RELEASE_IDENTITY.name, GIT_AUTHOR_EMAIL: RELEASE_IDENTITY.email, GIT_COMMITTER_NAME: RELEASE_IDENTITY.name, GIT_COMMITTER_EMAIL: RELEASE_IDENTITY.email };
    const commit = (await this.#run(["commit-tree", built, "-p", options.onto, "-F", "-"], { gitDir: options.gitDir, input: message, env })).stdout.trim();
    if (!COMMIT.test(commit)) throw new WorkspaceError("unavailable", "git did not return a commit ID");
    // Listed before the head moves to it (as `commit()` does): a commit on the branch is always listed; one only listed (a crash between the two) is not reachable and counts for nothing.
    if (permitted) await appendFile(permitLedgerPath(options.gitDir), `${commit} ${options.permit!.requestId}\n`, { mode: 0o600 });
    // The checkout is clean, so a two-way read-tree from the head to the new commit writes only the files the landing branch changed (none of them is one of the submission's).
    await this.#run(["update-index", "-q", "--really-refresh"], { gitDir: options.gitDir, workTree: options.checkout });
    await this.#run(["read-tree", "-m", "-u", head, commit], { gitDir: options.gitDir, workTree: options.checkout });
    // The base and the head move together, each only from what was read (a compare-and-swap in one transaction). When the transaction fails, the checkout's files and index are put back to the head they were read at
    // (the branch's files written above are taken out again), so a failed re-apply does not leave a checkout that looks changed and refuses every later landing or refresh.
    try {
      await this.#run(["update-ref", "--stdin"], { gitDir: options.gitDir, input: `start\nupdate refs/nn/base ${options.onto} ${base}\nupdate HEAD ${commit} ${head}\ncommit\n` });
    } catch (error) {
      await this.#run(["read-tree", "-m", "-u", commit, head], { gitDir: options.gitDir, workTree: options.checkout }).catch(() => undefined);
      throw error;
    }
    return { state: "reapplied", base: options.onto, tree: built, commit, previous: base, recovered: false, taken: theirs.length, permitted };
  }

  /**
   * Backs up the checkout's work in progress to a work-in-progress branch on a remote the owner named (card P02b). Everything is made in the checkout's own git directory (the host's, outside every sandbox): the files go
   * into a TEMPORARY index of its own (`nn-wip-index-*`, started from the head so a tracked file an ignore rule matches is kept), so the agent's index, HEAD, base and branches are never touched; the commit is made with
   * `commit-tree` by the platform as author and committer (the agent's name is only a trailer), with `Developer`, `Executor`, `NimbleNewt-Task` and `NimbleNewt-WIP: unreviewed` and never a `Reviewed-by` or `Reviewed-via`.
   * Before the push every file is read once more without following a link and handed to `scan`: a file the scan names, a link, a submodule entry, a file over the size limit and a file that changed while it was read are
   * LEFT OUT of the commit and listed in `blocked` (a missing scan refuses the whole backup: no scan, no push). The push names one ref under `refs/heads/nn-wip/` and never forces; the remote's own answer is then read
   * back (`ls-remote`) and must be the commit, or the backup failed. The commit is only counted (the local `refs/nn/wip-last/*` ref moves) after that read-back, so a failed push is never a backup; the next commit builds on
   * the last counted one, so successive pushes are fast-forwards; the first one has no parent, so nothing but scanned trees ever reaches the remote (the project's history stays here). Throws a `WorkspaceError` with a plain reason when anything fails; nothing is half-counted.
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
        // The first backup of a branch has NO parent (P02b review): its tree is the whole scanned snapshot, and the checkout's head would carry the project's committed history (files the scan never saw,
        // or saw and left out of this tree) to the remote with it. Later backups build on the last counted one, so the branch holds only scanned trees and successive pushes are fast-forwards.
        commitId = (await this.#run(["commit-tree", tree, ...(last === undefined ? [] : ["-p", last]), "-F", "-"], { gitDir: options.gitDir, input: message, env: who })).stdout.trim();
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
   * The branch carries no project history (P02b review), so the base commit is taken from `baseFrom` (the project's shared workspace or another repository that holds it); when it cannot be had, the restored
   * snapshot itself is the base (`baseFound: false`: every file is there, the changes just do not show against the old base). A branch whose tree holds a link or a submodule entry is refused (a backup never makes one).
   */
  async restoreWip(options: { remote: string; ref: string; gitDir: string; checkout: string; baseFrom?: string; env?: NodeJS.ProcessEnv; expect?: string }): Promise<{ commitId: string; base: string; baseFound: boolean; files: number }> {
    wipRemote(options.remote);
    wipRef(options.ref);
    await mkdir(options.checkout, { recursive: true });
    if ((await readdir(options.checkout)).length > 0) throw new WorkspaceError("invalid_path", "the checkout directory must be empty");
    await this.#run(["init", "--bare", options.gitDir]);
    await this.#run(["fetch", "--no-tags", "--no-recurse-submodules", "--", options.remote, `${options.ref}:refs/nn/wip-restored`], { gitDir: options.gitDir, allowFile: true, env: options.env ?? {} }).catch((error: unknown) => { throw new WorkspaceError("unavailable", `the work-in-progress branch could not be fetched: ${(error as Error).message.slice(0, 180)}`, { cause: error }); });
    const commitId = (await this.#run(["rev-parse", "--verify", "refs/nn/wip-restored^{commit}"], { gitDir: options.gitDir })).stdout.trim();
    if (options.expect !== undefined && options.expect !== commitId) throw new WorkspaceError("invalid_path", "the branch on the remote is not the last backup the controller confirmed (someone else changed it, or a later push was not confirmed); nothing was restored");
    const message = (await this.#run(["log", "-1", "--format=%B", commitId], { gitDir: options.gitDir })).stdout;
    if (!/^NimbleNewt-WIP: unreviewed$/m.test(message)) throw new WorkspaceError("invalid_path", "that branch does not hold a NimbleNewt work-in-progress commit; nothing was restored");
    const base = /^NimbleNewt-Base: ([0-9a-f]{40})$/m.exec(message)?.[1];
    if (base === undefined) throw new WorkspaceError("invalid_path", "the work-in-progress commit names no base commit; nothing was restored");
    const entries = (await this.#run(["ls-tree", "-r", "-z", commitId], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
    if (entries.some((e) => e.startsWith("120000 ") || e.startsWith("160000 "))) throw new WorkspaceError("invalid_path", "that branch holds a link or a submodule entry, which a backup never makes; nothing was restored");
    const has = (id: string): Promise<boolean> => this.#run(["cat-file", "-e", `${id}^{commit}`], { gitDir: options.gitDir }).then(() => true, () => false);
    if (!(await has(base)) && options.baseFrom !== undefined) await this.#run(["fetch", "--no-tags", "--no-recurse-submodules", "--", await this.#sharedGitDir(options.baseFrom), base], { gitDir: options.gitDir, allowFile: true }).catch(() => undefined);
    const baseFound = await has(base);
    const startFrom = baseFound ? base : commitId;
    await this.#neutralAttributes(options.gitDir);
    await this.#run(["read-tree", "--reset", "-u", commitId], { gitDir: options.gitDir, workTree: options.checkout });
    await rm(join(options.checkout, ".git"), { recursive: true, force: true });
    await this.#run(["update-ref", "refs/nn/base", startFrom], { gitDir: options.gitDir });
    await this.#run(["update-ref", "HEAD", startFrom], { gitDir: options.gitDir });
    await this.#run(["read-tree", startFrom], { gitDir: options.gitDir });
    // The branch the restore came from is the last one counted, so the next backup builds on it (a fast-forward), not as a first commit the remote would refuse.
    await this.#run(["update-ref", wipLastRef(options.remote, options.ref), commitId], { gitDir: options.gitDir });
    return { commitId, base: startFrom, baseFound, files: entries.length };
  }

  /** A blob's bytes (never more than the file limit: a larger one is an error). */
  async #blobBuffer(gitDir: string, sha: string): Promise<Buffer> {
    return new Promise((resolveBlob, reject) => {
      execFile(this.#git, [...this.#flags(), "--git-dir", gitDir, "cat-file", "blob", sha], { env: this.#env(), encoding: "buffer", maxBuffer: GIT_LIMITS.fileBytes + 1, windowsHide: true, cwd: this.#empty, timeout: GIT_LIMITS.timeoutMs }, (error, stdout) => (error === null ? resolveBlob(stdout as unknown as Buffer) : reject(new WorkspaceError("invalid_path", "a file could not be read within the size limit"))));
    });
  }

  /**
   * Card P05: the contribution guidance and agent instruction files a repository already has at `commit` (`instructionKind`), read from the commit itself (never from the checkout an agent may have written), so the
   * existing conventions are found without any NimbleNewt file being required or added. At most `CONTRIBUTION_LIMITS.instructionFiles` are read (the rest counted in `more`), each cut to its character bound and all of them
   * to the total; a link, a submodule entry, a file that is not UTF-8 text, and a file the optional `scan` names are listed in `skipped` with the reason and never read out. Nothing is written anywhere.
   */
  async instructions(options: { gitDir: string; commit: string; scan?: (file: { path: string; bytes: Buffer }) => string | undefined | Promise<string | undefined> }): Promise<{ commit: string; files: { path: string; kind: InstructionKind; text: string; cut: boolean }[]; skipped: { path: string; kind: InstructionKind; reason: string }[]; more: number; signOff: boolean; pullRequestTemplate?: string }> {
    if (!OBJECT.test(options.commit)) throw new WorkspaceError("invalid_path", "a commit is named by its full ID");
    const commit = (await this.#run(["rev-parse", "--verify", `${options.commit}^{commit}`], { gitDir: options.gitDir })).stdout.trim();
    const listed = (await this.#run(["ls-tree", "-r", "-z", "-l", "--full-tree", commit], { gitDir: options.gitDir })).stdout.split("\0").filter(Boolean);
    if (listed.length > GIT_LIMITS.files * 10) throw new WorkspaceError("invalid_path", `the repository holds more than ${GIT_LIMITS.files * 10} files; its instructions were not looked for`);
    const found: { path: string; kind: InstructionKind; mode: string; blob: string; size: number }[] = [];
    for (const line of listed) {
      const tab = line.indexOf("\t");
      const path = line.slice(tab + 1);
      const kind = instructionKind(path);
      if (kind === undefined) continue;
      const [mode = "", , blob = "", size = ""] = line.slice(0, tab).split(/\s+/);
      found.push({ path, kind, mode, blob, size: Number(size) });
    }
    found.sort(instructionOrder);
    const files: { path: string; kind: InstructionKind; text: string; cut: boolean }[] = [];
    const skipped: { path: string; kind: InstructionKind; reason: string }[] = [];
    let total = 0; let signOff = false; let pullRequestTemplate: string | undefined;
    const taken = found.slice(0, CONTRIBUTION_LIMITS.instructionFiles);
    for (const entry of taken) {
      if (entry.mode !== "100644" && entry.mode !== "100755") { skipped.push({ path: entry.path, kind: entry.kind, reason: "a link or a submodule entry, not read" }); continue; }
      if (!OBJECT.test(entry.blob)) { skipped.push({ path: entry.path, kind: entry.kind, reason: "could not be read" }); continue; }
      const bytes = await this.#blobPrefix(options.gitDir, entry.blob, CONTRIBUTION_LIMITS.instructionBytes).catch(() => undefined);
      if (bytes === undefined) { skipped.push({ path: entry.path, kind: entry.kind, reason: "could not be read" }); continue; }
      // A cut read can end inside a character: drop the trailing bytes of a partial UTF-8 sequence before decoding.
      let usable = bytes;
      if (entry.size > bytes.length) { let end = usable.length; for (let back = 0; back < 3 && end > 0 && (usable[end - 1]! & 0xc0) === 0x80; back += 1) end -= 1; if (end > 0 && usable[end - 1]! >= 0xc0) end -= 1; usable = usable.subarray(0, end); }
      if (options.scan !== undefined) {
        let verdict: string | undefined;
        try { verdict = await options.scan({ path: entry.path, bytes: usable }); } catch { verdict = "the scan of the file failed"; }
        if (verdict !== undefined) { skipped.push({ path: entry.path, kind: entry.kind, reason: `held back: ${shortReason(verdict)}` }); continue; }
      }
      const room = Math.min(CONTRIBUTION_LIMITS.instructionChars, CONTRIBUTION_LIMITS.instructionTotalChars - total);
      if (room <= 0) { skipped.push({ path: entry.path, kind: entry.kind, reason: "past the total length instructions are read to" }); continue; }
      const text = instructionText(usable, room);
      if (text === undefined) { skipped.push({ path: entry.path, kind: entry.kind, reason: "not UTF-8 text, not read" }); continue; }
      total += text.text.length;
      if (fold(entry.path.split("/").pop() ?? "").startsWith("dco")) signOff = true;
      if (entry.kind !== "pull-request-template" && asksSignOff(text.text)) signOff = true;
      if (entry.kind === "pull-request-template" && pullRequestTemplate === undefined) pullRequestTemplate = entry.path;
      files.push({ path: entry.path, kind: entry.kind, text: text.text, cut: text.cut || entry.size > bytes.length });
    }
    return { commit, files, skipped, more: found.length - taken.length, signOff, ...(pullRequestTemplate === undefined ? {} : { pullRequestTemplate }) };
  }

  /**
   * Card P05: the automated check of a contribution's actual diff before anything is committed for it or offered as a pull request. The diff is `base` (a commit) to `tree` (the submitted tree), read from git's
   * objects, not from a checkout, so the owner's local work in the shared checkout and anything the agent left outside the submitted tree are not part of it. Each changed file is blocked, with its reasons, when it is:
   * not intended (`intended`, `readIntended`), NimbleNewt's own state (`isNimbleNewtState`), an ignore-rule file the task did not name exactly, a link or submodule entry, larger than a file the scan can read, or named by
   * `scan` (its content or its name). `scan` is required: without it nothing is checked (no scan, no contribution). A scan that throws blocks that file. `ok` is true only when nothing is blocked and something changed.
   */
  async contributionCheck(options: { gitDir: string; base: string; tree: string; intended: unknown; scan: (file: { path: string; bytes: Buffer }) => string | undefined | Promise<string | undefined> }): Promise<{ ok: boolean; base: string; tree: string; files: { path: string; op: "write" | "delete" }[]; fileCount: number; blocked: { path: string; kinds: ContributionBlock[]; reasons: string[] }[]; blockedCount: number }> {
    if (typeof options.scan !== "function") throw new WorkspaceError("invalid_path", "a contribution check needs a scan of its files; none was given, so nothing was checked");
    const intended = readIntended(options.intended);
    if (!OBJECT.test(options.base) || !OBJECT.test(options.tree)) throw new WorkspaceError("invalid_path", "a contribution names its base commit and its tree by their full IDs");
    const base = (await this.#run(["rev-parse", "--verify", `${options.base}^{commit}`], { gitDir: options.gitDir })).stdout.trim();
    const kind = (await this.#run(["cat-file", "-t", options.tree], { gitDir: options.gitDir })).stdout.trim();
    if (kind !== "tree") throw new WorkspaceError("invalid_path", "the contribution's tree is not a tree");
    // `--ignore-submodules=none` (first review): an `ignore = all` the base's own `.gitmodules` sets (or a setting of the git directory) would otherwise leave a submodule entry's change out of the list, and so out of the check.
    const raw = (await this.#run(["diff-tree", "-r", "-z", "--no-renames", "--ignore-submodules=none", "--raw", "--no-commit-id", base, options.tree], { gitDir: options.gitDir })).stdout.split("\0");
    const changes: { path: string; op: "write" | "delete"; mode: string; oldMode: string; blob: string }[] = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
      const meta = raw[i]!; const path = raw[i + 1]!;
      if (!meta.startsWith(":")) throw new WorkspaceError("unavailable", "git's list of changes could not be read; the contribution was not checked");
      const [oldMode = "", mode = "", , blob = "", status = ""] = meta.slice(1).split(" ");
      changes.push({ path, op: status.startsWith("D") ? "delete" : "write", mode, oldMode, blob });
      if (changes.length > GIT_LIMITS.files) throw new WorkspaceError("invalid_path", `more than ${GIT_LIMITS.files} files changed; the contribution was not checked`);
    }
    const blocked: { path: string; kinds: ContributionBlock[]; reasons: string[] }[] = [];
    const special = (m: string): boolean => m === "120000" || m === "160000";
    for (const change of changes) {
      const kinds: ContributionBlock[] = []; const reasons: string[] = [];
      const add = (k: ContributionBlock, reason: string): void => { if (!kinds.includes(k)) { kinds.push(k); reasons.push(shortReason(reason)); } };
      const inBase = change.oldMode !== "000000";
      if (isNimbleNewtState(change.path, inBase)) add("nimblenewt-state", BLOCK_REASON["nimblenewt-state"]);
      if (isIgnoreRuleFile(change.path) && !intended.files.has(change.path)) add("ignore-rule", BLOCK_REASON["ignore-rule"]);
      if (!isIntended(change.path, intended)) add("unrelated", BLOCK_REASON.unrelated);
      if (special(change.mode) || special(change.oldMode)) add("link", BLOCK_REASON.link);
      if (unfitName(change.path)) add("unreadable", "a name no checkout takes or that is not UTF-8 text (an empty, '.' or '..' part, or a control character)");
      const scanOne = async (file: { path: string; bytes: Buffer }, label: string): Promise<void> => {
        let verdict: string | undefined;
        try { verdict = await options.scan(file); } catch { verdict = "the scan of the file failed"; }
        if (verdict !== undefined) add("secret", `${label}${verdict}`);
      };
      await scanOne({ path: change.path, bytes: Buffer.from(change.path, "utf8") }, "its name: ");
      if (change.op === "write" && !special(change.mode)) {
        const size = OBJECT.test(change.blob) ? Number((await this.#run(["cat-file", "-s", change.blob], { gitDir: options.gitDir }).catch(() => ({ stdout: "" }))).stdout.trim()) : NaN;
        const bytes = Number.isSafeInteger(size) && size <= GIT_LIMITS.fileBytes ? await this.#blobBuffer(options.gitDir, change.blob).catch(() => undefined) : undefined;
        if (bytes === undefined) add("unreadable", `could not be read for the scan (larger than ${GIT_LIMITS.fileBytes} bytes, or missing)`);
        else await scanOne({ path: change.path, bytes }, "");
      }
      if (kinds.length > 0) blocked.push({ path: change.path, kinds, reasons });
    }
    return {
      ok: changes.length > 0 && blocked.length === 0, base, tree: options.tree,
      files: changes.slice(0, CONTRIBUTION_LIMITS.listed).map((c) => ({ path: c.path, op: c.op })), fileCount: changes.length,
      blocked: blocked.slice(0, CONTRIBUTION_LIMITS.blockedListed), blockedCount: blocked.length,
    };
  }

  /** At most `max` bytes from the start of a blob (an instruction file larger than that is cut, not refused). */
  async #blobPrefix(gitDir: string, sha: string, max: number): Promise<Buffer> {
    return new Promise((resolveBlob, reject) => {
      const child = spawn(this.#git, [...this.#flags(), "--git-dir", gitDir, "cat-file", "blob", sha], { env: this.#env(), windowsHide: true, cwd: this.#empty, stdio: ["ignore", "pipe", "ignore"] });
      const chunks: Buffer[] = []; let size = 0; let done = false;
      // Second review: bounded in time like every other git command here (a git that stops answering is killed and the read refused).
      const timer = setTimeout(() => { child.kill("SIGKILL"); finish(new WorkspaceError("unavailable", "git did not answer in time; a file could not be read")); }, GIT_LIMITS.timeoutMs);
      const finish = (error?: Error): void => { if (done) return; done = true; clearTimeout(timer); if (error !== undefined) reject(error); else resolveBlob(Buffer.concat(chunks).subarray(0, max)); };
      child.stdout.on("data", (chunk: Buffer) => { if (size >= max) return; chunks.push(chunk); size += chunk.length; if (size >= max) { child.kill(); finish(); } });
      child.on("error", (error) => finish(new WorkspaceError("unavailable", "git could not be run", { cause: error })));
      child.on("close", (code) => (code === 0 || size >= max ? finish() : finish(new WorkspaceError("invalid_path", "a file could not be read"))));
    });
  }

  /** The ID of a commit in the shared repository's current head (the controller's own read). */
  async head(shared: string): Promise<string> {
    return (await this.#run(["rev-parse", "--verify", "HEAD^{commit}"], { gitDir: await this.#sharedGitDir(shared) })).stdout.trim();
  }

  /**
   * The commit a named branch of the shared repository points at (card H12p follow-up: the author's refresh and the submit's stale check go to the owner's landing branch, whatever the shared working tree has checked out).
   * Read only. `undefined` when the shared repository has no such branch. A name that is not a plain branch name (the owner's `workspace.landing.branch` shape) is refused, never read as a pattern or an option.
   */
  async branchHead(shared: string, branch: string): Promise<string | undefined> {
    if (typeof branch !== "string" || !BRANCH_NAME.test(branch) || branch.includes("..") || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".lock")) throw new WorkspaceError("invalid_path", "the landing branch is not a plain branch name");
    const want = `refs/heads/${branch}`;
    // `for-each-ref` takes its argument as a pattern (a whole-component prefix: `refs/heads/a` also lists `refs/heads/a/b`), so only the exact name is taken; and only a commit (a branch ref written by hand could hold
    // another kind of object, which a refresh must not be based on).
    const out = (await this.#run(["for-each-ref", "--format=%(refname)%00%(objecttype)%00%(objectname)", want], { gitDir: await this.#sharedGitDir(shared) })).stdout;
    for (const line of out.split("\n")) {
      const [name, type, id] = line.split("\0");
      if (name === want && type === "commit" && id !== undefined && COMMIT.test(id)) return id;
    }
    return undefined;
  }
}

void mkdtemp; void tmpdir; void resolve; void readFile;

/** Copies `source` into the open `target` from its start, in chunks (a taken file can be large), through the handle only. */
async function copyInto(source: string, target: import("node:fs/promises").FileHandle): Promise<void> {
  const from = await open(source, "r");
  try {
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let at = 0;
    for (;;) {
      const { bytesRead } = await from.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      for (let off = 0; off < bytesRead;) { const { bytesWritten } = await target.write(chunk, off, bytesRead - off, at); if (bytesWritten <= 0) throw new Error("the file took no more bytes"); off += bytesWritten; at += bytesWritten; }
    }
  } finally { await from.close().catch(() => undefined); }
}
