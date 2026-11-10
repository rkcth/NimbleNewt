import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, readdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { PLAN_FILE } from "@nimblenewt/contracts";
import { WorkspaceError } from "./errors.js";
import type { GitBridge } from "./git.js";
import { WorkspaceHost, type WorkspaceHostOptions, type CheckoutLocation, type HostWorkspaceCall, type HostWorkspaceOutcome, type LandingPolicy } from "./host.js";
import { fold, plainName } from "./names.js";
import { NOFOLLOW } from "./paths.js";

/**
 * The production workspace port of a local worker host (card H12q): one folder layout for the checkouts on this machine, shared by the host that makes an attempt's workspace (`ensure`) and the host that answers the
 * controller's integration, landing, refresh and quarantine for it (`port`), so they cannot disagree about where a task's checkout is. Where things live is this machine's own configuration; a request names a task and a project and
 * nothing else (both checked as plain names), so no part of a request reaches a path.
 *
 *   <root>/<project>/<task>/checkout   the agent's checkout (the only part the sandbox mounts)
 *   <root>/<project>/<task>/task.git   the agent's separate git directory (never mounted)
 *   <root>/<project>/<task>/complete   written last: a task folder without it was not finished and is never used
 *   <root>/shared-state/<tree>         the bridge's locks and the changes kept for review, one per shared tree (so two tasks of a project share their locks)
 *   <root>/.making                     where a task folder is built before it is renamed into place
 *   <root>/quarantine                  the owner-only quarantine
 *   <root>/journal                     one record per request ID
 *
 * `busy` is asked just before any work starts: the attempts of the request that have a call in flight on this host. A request is never carried out under one (the controller's quiesce has settled them; this is the host checking it).
 */
export interface LocalWorkspacesOptions {
  /** An absolute folder this host owns for checkouts. */
  readonly root: string;
  /** The shared repository (the landing branch's working tree) of a project, or `undefined` when this host holds none for it. */
  readonly shared: (projectId: string) => string | undefined;
  readonly git: GitBridge;
  /** The attempts that have a call or model call in flight on this host right now (`LocalWorker.busyAttempts`). */
  readonly busy: () => readonly string[] | Promise<readonly string[]>;
  /** The landing policy of a project (see `WorkspaceHostOptions.landing`). */
  readonly landing?: WorkspaceHostOptions["landing"];
  readonly clock?: () => string;
}

/** A project folder cannot take the name of one of the host's own folders. */
const RESERVED = new Set(["journal", "quarantine", "shared-state", ".making"]);
const plain = (value: string): boolean => plainName(value) && !RESERVED.has(fold(value));
/** Whether `name` is an entry of `parent` exactly as spelled (a case-insensitive filesystem would also find another spelling; that is a different task). */
const hasExactly = (parent: string, name: string): boolean => { try { return readdirSync(parent).includes(name); } catch { return false; } };
const collides = (parent: string, name: string): boolean => { try { return readdirSync(parent).some((n) => n !== name && fold(n) === fold(name)); } catch { return false; } };

export class LocalWorkspaces {
  readonly #options: LocalWorkspacesOptions;
  readonly host: WorkspaceHost;
  /** What a `LocalWorker` takes as its `workspace` option (and what a remote worker's responder runs). */
  readonly port: { run(call: HostWorkspaceCall): Promise<HostWorkspaceOutcome> };

  constructor(options: LocalWorkspacesOptions) {
    if (typeof options.root !== "string" || !isAbsolute(options.root) || normalize(options.root) !== options.root) throw new WorkspaceError("invalid_path", "the workspace root must be an absolute, normalised path");
    this.#options = options;
    this.host = new WorkspaceHost({
      git: options.git,
      journal: join(options.root, "journal"),
      locate: (call) => this.locate(call),
      // Fails closed: a host that cannot say which attempts are busy does not carry the request out (the host treats a throw as not quiet).
      attemptsQuiet: async (attemptIds) => { const busy = new Set(await options.busy()); return !attemptIds.some((id) => busy.has(id)); },
      ...(options.landing === undefined ? {} : { landing: options.landing }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    this.port = { run: (call) => this.host.run(call) };
  }

  /** The folder of a task, when it exists exactly as named, is finished (its `complete` mark is there) and no other spelling of the name stands beside it. */
  #taskDir(call: { readonly taskId: string; readonly projectId: string }): string | undefined {
    if (!plain(call.taskId) || !plain(call.projectId)) return undefined;
    if (!hasExactly(this.#options.root, call.projectId) || collides(this.#options.root, call.projectId)) return undefined;
    const parent = join(this.#options.root, call.projectId);
    if (!hasExactly(parent, call.taskId) || collides(parent, call.taskId)) return undefined;
    const dir = join(parent, call.taskId);
    return existsSync(join(dir, "complete")) ? dir : undefined;
  }

  /** Where the bridge keeps its locks and kept changes for a shared tree: one place per tree, whichever task asks. */
  #stateOf(shared: string): string { return join(this.#options.root, "shared-state", createHash("sha256").update(((): string => { try { return realpathSync(shared); } catch { return resolve(shared); } })()).digest("hex").slice(0, 24)); }

  /** Where the task's checkout is, or `undefined` when this host holds none for it (no shared repository for the project, a malformed name, or nothing made yet). */
  locate(call: { readonly taskId: string; readonly projectId: string }): CheckoutLocation | undefined {
    const shared = plain(call.projectId) ? this.#options.shared(call.projectId) : undefined;
    if (shared === undefined) return undefined;
    const dir = this.#taskDir(call);
    if (dir === undefined) return undefined;
    return { shared, checkout: join(dir, "checkout"), gitDir: join(dir, "task.git"), bridgeState: this.#stateOf(shared), quarantineRoot: join(this.#options.root, "quarantine") };
  }

  /**
   * What a task's checkout holds (card W03, for the blocker of an agent that kept stopping early): the checked and unchecked steps of the agent's `PLAN.md` at the checkout's top (a Markdown checkbox list), and the diff
   * stat of the checkout against the task's base. `PLAN.md` is read only when it is a plain file (not a link) of at most `PROGRESS_LIMITS.planBytes`; steps past `PROGRESS_LIMITS.steps` are left out and each step is cut to
   * `PROGRESS_LIMITS.stepChars`. A part that cannot be read is left out (the controller says it is not known); no checkout at all is `undefined`.
   */
  async progress(call: { readonly taskId: string; readonly projectId: string }): Promise<{ plan?: { done: string[]; open: string[] }; diffStat?: string } | undefined> {
    const where = this.locate(call);
    if (where === undefined) return undefined;
    const plan = await readPlan(join(where.checkout, PLAN_FILE));
    const diffStat = await this.#options.git.diffStat({ gitDir: where.gitDir, checkout: where.checkout }).catch(() => undefined);
    return { ...(plan === undefined ? {} : { plan }), ...(diffStat === undefined ? {} : { diffStat }) };
  }

  /**
   * What a task's checkout holds when its agent says the work is done (card W05, `GitBridge.doneState`): uncommitted files, commits ahead of the base, files changed against the base, and whether each evidence path is a file of the
   * checkout. The agent's plan file (`PLAN_FILE`) is not counted as a change. `agentCommits` is false: in this layout the agent's git directory is outside its sandbox, so the agent cannot commit (its changes are committed after review, H12o) and its work is what the checkout holds against the base.
   * `undefined`: this host holds no checkout for the task.
   */
  async doneState(call: { readonly taskId: string; readonly projectId: string }, paths: readonly string[]): Promise<(Awaited<ReturnType<GitBridge["doneState"]>> & { readonly agentCommits: false }) | undefined> {
    const where = this.locate(call);
    if (where === undefined) return undefined;
    return { ...(await this.#options.git.doneState({ gitDir: where.gitDir, checkout: where.checkout, paths })), agentCommits: false };
  }

  readonly #making = new Map<string, Promise<unknown>>();

  /**
   * The checkout for an attempt's workspace: made from the shared repository's head the first time, found again afterwards (a second attempt of the same task works in the same checkout). It is built in a private folder and
   * renamed into place with a `complete` mark, so a crash part-way leaves nothing that looks like a checkout (the leftover is removed later), and two callers for one task share one making. A checkout that was quarantined
   * is not made again here: the task's folder is still there and its git directory is kept, so this refuses rather than start the agent on an empty folder.
   */
  async ensure(call: { readonly taskId: string; readonly projectId: string }): Promise<{ readonly checkout: string; readonly gitDir: string }> {
    if (!plain(call.taskId) || !plain(call.projectId)) throw new WorkspaceError("invalid_path", "the task or project name is not a plain name");
    const shared = this.#options.shared(call.projectId);
    if (shared === undefined) throw new WorkspaceError("unavailable", "this host holds no shared repository for that project");
    const key = `${call.projectId}/${call.taskId}`;
    const earlier = this.#making.get(key) ?? Promise.resolve();
    const run = earlier.then(() => this.#ensure(call, shared), () => this.#ensure(call, shared));
    const tail = run.catch(() => undefined);
    this.#making.set(key, tail);
    try { return await run; } finally { if (this.#making.get(key) === tail) this.#making.delete(key); }
  }

  async #ensure(call: { readonly taskId: string; readonly projectId: string }, shared: string): Promise<{ readonly checkout: string; readonly gitDir: string }> {
    const parent = join(this.#options.root, call.projectId);
    if (collides(this.#options.root, call.projectId) || collides(parent, call.taskId)) throw new WorkspaceError("invalid_path", "another task or project folder has a name that differs only in case or form; a case-insensitive filesystem would treat them as one, so this one is not made");
    const dir = join(parent, call.taskId);
    const where = { checkout: join(dir, "checkout"), gitDir: join(dir, "task.git") };
    if (hasExactly(parent, call.taskId)) {
      if (!existsSync(join(dir, "complete"))) throw new WorkspaceError("unavailable", "the task's folder is there but was never finished; it is not used (the owner removes it)");
      if (!existsSync(where.checkout)) throw new WorkspaceError("unavailable", "the task's checkout was removed or quarantined; it is not made again over the kept git directory");
      return where;
    }
    const staging = join(this.#options.root, ".making");
    await mkdir(staging, { recursive: true });
    await this.#sweep(staging);
    const building = join(staging, `${randomBytes(8).toString("hex")}`);
    try {
      await mkdir(building);
      await this.#options.git.createCheckout({ shared, commit: await this.#options.git.head(shared), checkout: join(building, "checkout"), gitDir: join(building, "task.git") });
      await writeFile(join(building, "complete"), "1\n");
      await mkdir(parent, { recursive: true });
      try { await rename(building, dir); } catch (error) {
        // Another process finished the same task first: use its folder.
        if (existsSync(join(dir, "complete"))) return where;
        throw new WorkspaceError("unavailable", `the task's folder could not be put in place: ${(error as Error).message.slice(0, 120)}`);
      }
    } finally { await rm(building, { recursive: true, force: true }); }
    return where;
  }

  /** Removes what an earlier, interrupted making left (older than ten minutes, so a making in another process is not touched). */
  async #sweep(staging: string): Promise<void> {
    for (const name of await readdir(staging).catch(() => [] as string[])) {
      const info = await lstat(join(staging, name)).catch(() => undefined);
      if (info !== undefined && Date.now() - info.mtimeMs > 10 * 60_000) await rm(join(staging, name), { recursive: true, force: true }).catch(() => undefined);
    }
  }
}

export const PROGRESS_LIMITS = { planBytes: 256 * 1024, steps: 200, stepChars: 200 } as const;
const STEP = /^\s*(?:[-*+]|\d+[.)])\s+\[([ xX])\]\s+(.*?)\s*$/;

/** The checkbox steps of a plan file, or `undefined` when it is missing, is not a plain file, is too big, or has no checkbox step. Opened without following a link. */
export async function readPlan(path: string): Promise<{ done: string[]; open: string[] } | undefined> {
  let text: string;
  try {
    const info = await lstat(path);
    if (!info.isFile() || info.size > PROGRESS_LIMITS.planBytes) return undefined;
    // Not blocking: a file swapped for a pipe after the look above would otherwise hang the open. What was opened is looked at again (a plain file, within the bound) and read only up to the bound, so a file swapped or
    // grown meanwhile is never read whole.
    const handle = await open(path, constants.O_RDONLY | NOFOLLOW | (typeof constants.O_NONBLOCK === "number" ? constants.O_NONBLOCK : 0));
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.size > PROGRESS_LIMITS.planBytes) return undefined;
      const buffer = Buffer.alloc(PROGRESS_LIMITS.planBytes + 1);
      let length = 0;
      for (;;) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
        if (bytesRead === 0) break;
        length += bytesRead;
        if (length > PROGRESS_LIMITS.planBytes) return undefined;
      }
      text = buffer.subarray(0, length).toString("utf8");
    } finally { await handle.close(); }
  } catch { return undefined; }
  const done: string[] = [], open_: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const m = STEP.exec(line);
    if (m === null) continue;
    if (done.length + open_.length >= PROGRESS_LIMITS.steps) break;
    const step = Array.from(m[2]!).slice(0, PROGRESS_LIMITS.stepChars).join("");
    (m[1] === " " ? open_ : done).push(step);
  }
  return done.length + open_.length === 0 ? undefined : { done, open: open_ };
}
