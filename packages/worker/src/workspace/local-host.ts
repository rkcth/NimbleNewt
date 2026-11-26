import { createHash, randomBytes } from "node:crypto";
import { constants, existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { link, lstat, mkdir, open, readFile, readdir, rename, rm, rmdir, writeFile } from "node:fs/promises";
import { isAbsolute, join, normalize, resolve } from "node:path";
import { PLAN_FILE } from "@nimblenewt/contracts";
import { WorkspaceError } from "./errors.js";
import type { GitBridge } from "./git.js";
import { WipBackupHost, type HostRestoreTarget } from "./wip-host.js";
import { WorkspaceHost, type WorkspaceHostOptions, type CheckoutLocation, type HostWorkspaceCall, type HostWorkspaceOutcome, type HostRestackCall, type HostRestackOutcome, type LandingPolicy } from "./host.js";
import { landingChecks, type LandingCheckCall, type LandingCheckReport, type LandingChecksOptions } from "./landing-checks.js";
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
  /** The worker-side hook for security events (see `WorkspaceHostOptions.security`). */
  readonly security?: WorkspaceHostOptions["security"];
  readonly clock?: () => string;
  /**
   * The sandbox the landing gate's checks run in (card P09): the launcher, the read-only inputs (a language runtime), the environment and the owner's limits. When given, the port answers `landingChecks` (each required test
   * command run on a fresh copy of the tree the landing would make); without it the port has no `landingChecks` and a landing that requires tests is refused by the controller as not run.
   */
  readonly checks?: Omit<LandingChecksOptions, "git" | "locate">;
  /**
   * Card P02: whether the task's workspace may be opened on the project's shared repository (the controller's `workspaceAdmission`: the task's pinned binding, or a binding of that folder, with write access to all of it).
   * Asked at every `ensure`, before a checkout is made or handed out again; a refusal, or a throw, is not opened (fail closed) and its reason is the error's message. Absent: every workspace is opened (tests and
   * hosts that hold no controller records, such as a remote host configured by its operator).
   */
  readonly admit?: (call: { readonly taskId: string; readonly projectId: string; readonly shared: string }) => Promise<WorkspaceAdmissionAnswer>;
}

/** What `admit` answers: the binding that admits the workspace (kept in the attempt's start record), or why not. */
export type WorkspaceAdmissionAnswer =
  | { readonly admitted: true; readonly binding: { readonly resourceId: string; readonly repositoryId?: string; readonly locatorEpoch: number; readonly label?: string; readonly pinned?: boolean } }
  | { readonly admitted: false; readonly reason: string };

/**
 * The initial working state of one attempt (card P02), kept beside the task's checkout (outside the sandbox mount) as `<task>/starts/<attempt>.json`, written once when the attempt's workspace is first handed out: the base
 * commit, HEAD, the tree of the checkout as it stood (so its content can be compared later), the files that differed from HEAD or were untracked (at most `START_STATE_LIMITS.files` named, all counted), a digest over
 * all of that, and the binding that admitted it. A later attempt of the same task gets its own record, so a review sees what each one started from.
 */
export interface StartState {
  readonly attemptId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly recordedAt: string;
  readonly base: string;
  readonly head: string;
  readonly tree: string;
  readonly files: readonly { readonly code: string; readonly path: string }[];
  readonly fileCount: number;
  /** sha256 over base, head, tree and every changed or untracked file with its status (sorted), so two starts compare by one value. */
  readonly digest: string;
  /** The binding that admitted the workspace; absent on a host that asks no admission. */
  readonly binding?: { readonly resourceId: string; readonly repositoryId?: string; readonly locatorEpoch: number };
}
export const START_STATE_LIMITS = { files: 500 } as const;

/** A project folder cannot take the name of one of the host's own folders. */
const RESERVED = new Set(["journal", "quarantine", "shared-state", ".making", "restored"]);
const plain = (value: string): boolean => plainName(value) && !RESERVED.has(fold(value));
/** Whether `name` is an entry of `parent` exactly as spelled (a case-insensitive filesystem would also find another spelling; that is a different task). */
const hasExactly = (parent: string, name: string): boolean => { try { return readdirSync(parent).includes(name); } catch { return false; } };
const collides = (parent: string, name: string): boolean => { try { return readdirSync(parent).some((n) => n !== name && fold(n) === fold(name)); } catch { return false; } };

export class LocalWorkspaces {
  readonly #options: LocalWorkspacesOptions;
  readonly host: WorkspaceHost;
  /** What a `LocalWorker` takes as its `workspace` option (and what a remote worker's responder runs). */
  readonly port: { run(call: HostWorkspaceCall): Promise<HostWorkspaceOutcome>; /** Card P09: present when `checks` was given. */ landingChecks?(call: LandingCheckCall): Promise<LandingCheckReport>; /** Card P10: the integrator's mechanical re-apply of a queued submission onto the landing branch's head. */ restack(call: HostRestackCall): Promise<HostRestackOutcome> };

  constructor(options: LocalWorkspacesOptions) {
    if (typeof options.root !== "string" || !isAbsolute(options.root) || normalize(options.root) !== options.root) throw new WorkspaceError("invalid_path", "the workspace root must be an absolute, normalised path");
    this.#options = options;
    this.host = new WorkspaceHost({
      git: options.git,
      journal: join(options.root, "journal"),
      locate: (call) => this.locate(call),
      // The platform commits a task's work in its own checkout when asked for `release` (card H12o); the owner's landing policy is read first.
      release: true,
      // Fails closed: a host that cannot say which attempts are busy does not carry the request out (the host treats a throw as not quiet).
      attemptsQuiet: async (attemptIds) => { const busy = new Set(await options.busy()); return !attemptIds.some((id) => busy.has(id)); },
      ...(options.landing === undefined ? {} : { landing: options.landing }),
      ...(options.security === undefined ? {} : { security: options.security }),
      ...(options.clock === undefined ? {} : { clock: options.clock }),
    });
    const checks = options.checks === undefined ? undefined : landingChecks({ ...options.checks, git: options.git, locate: (call) => this.locate(call) });
    this.port = { run: (call) => this.host.run(call), restack: (call) => this.host.restack(call), ...(checks === undefined ? {} : { landingChecks: checks }) };
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
    const attemptId = readAttempt(join(dir, "attempt"));
    return { shared, checkout: join(dir, "checkout"), gitDir: join(dir, "task.git"), bridgeState: this.#stateOf(shared), quarantineRoot: join(this.#options.root, "quarantine"), ...(attemptId === undefined ? {} : { attemptId }) };
  }

  /**
   * What a task's checkout holds (card W03, for the blocker of an agent that kept stopping early): the checked and unchecked steps of the agent's `PLAN.md` at the checkout's top (a Markdown checkbox list), and the diff
   * stat of the checkout against the task's base. `PLAN.md` is read only when it is a plain file (not a link) of at most `PROGRESS_LIMITS.planBytes`; steps past `PROGRESS_LIMITS.steps` are left out and each step is cut to
   * `PROGRESS_LIMITS.stepChars`. A part that cannot be read is left out (the controller says it is not known); no checkout at all is `undefined`.
   */
  async progress(call: { readonly taskId: string; readonly projectId: string; readonly planOnly?: boolean }): Promise<{ plan?: { done: string[]; open: string[] }; diffStat?: string } | undefined> {
    const where = this.locate(call);
    if (where === undefined) return undefined;
    const plan = await readPlan(join(where.checkout, PLAN_FILE));
    // Card W08: asked at every completed turn for the plan alone; the diff stat (which hashes every file of the checkout into the task's git directory) is made only when it is wanted.
    const diffStat = call.planOnly === true ? undefined : await this.#options.git.diffStat({ gitDir: where.gitDir, checkout: where.checkout }).catch(() => undefined);
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

  /**
   * What a submit of the task's work is checked against (card H12n, `GitBridge.submitView`): the checkout's base, the landing branch's head, the files the agent changed and the files the landing branch changed since the base.
   * The landing branch's head is the one the author's refresh goes to (card H12p follow-up, `WorkspaceHost.landingHead`): the owner's landing branch when one is set, else the shared repository's checked-out head. A landing
   * policy that cannot be read, or a landing branch the shared repository does not have, throws `unavailable` (the submit is refused as unavailable). `undefined`: this host holds no checkout for the task.
   */
  async submitView(call: { readonly taskId: string; readonly projectId: string }): Promise<{ base: string; head: string; mine: string[]; landed: string[] } | undefined> {
    const where = this.locate(call);
    if (where === undefined) return undefined;
    const tip = await this.host.landingHead({ taskId: call.taskId, projectId: call.projectId, shared: where.shared }, "the submit could not be checked");
    if ("refuse" in tip) throw new WorkspaceError("unavailable", tip.refuse);
    return this.#options.git.submitView({ shared: where.shared, gitDir: where.gitDir, checkout: where.checkout, head: tip.head });
  }

  /**
   * Stages the task's checkout for a submission (card H12n): `GitBridge.stage` (everything git does not ignore, into the checkout's own index; a link or Git-named entry refuses the whole), then the patch ID of the staged change.
   * Returns the base the staging is on, the tree, the patch ID and the staged files. Refuses when this host holds no checkout for the task, or when nothing differs from the base (there is nothing to submit).
   */
  async stageWork(call: { readonly taskId: string; readonly projectId: string }): Promise<{ base: string; tree: string; patchId: string; files: string[] }> {
    const where = this.locate(call);
    if (where === undefined) throw new WorkspaceError("unavailable", "this host holds no checkout for the task, so its work cannot be staged");
    const staged = await this.#options.git.stage({ gitDir: where.gitDir, checkout: where.checkout });
    const patchId = await this.#options.git.patchId({ gitDir: where.gitDir, base: staged.base });
    if (patchId === undefined || staged.files.length === 0) throw new WorkspaceError("invalid_path", "the checkout holds no change against its base, so there is nothing to submit");
    return { base: staged.base, tree: staged.tree, patchId, files: staged.files.map((f) => f.path) };
  }

  /**
   * The host of the optional work-in-progress backup (card P02b) over THIS layout: the same `locate` as every other request, so a backup reads exactly the checkout the agent works in, and `restoreTarget` below for a restore.
   * `scan` (required: no scan, no push) and `pushEnv` (the credential seam) are the operator's own; see `WipBackupHost`.
   */
  wipHost(options: { readonly scan: ConstructorParameters<typeof WipBackupHost>[0]["scan"]; readonly pushEnv?: ConstructorParameters<typeof WipBackupHost>[0]["pushEnv"] }): WipBackupHost {
    return new WipBackupHost({ git: this.#options.git, locate: (call) => this.locate(call), scan: options.scan, ...(options.pushEnv === undefined ? {} : { pushEnv: options.pushEnv }), restoreTarget: (call) => this.#restoreTarget(call) });
  }

  /** Whether this host holds a finished checkout for the task (the controller asks before it offers the task to a backup). */
  holds(call: { readonly taskId: string; readonly projectId: string }): boolean { return this.locate(call) !== undefined; }

  /**
   * Where a restore of a task goes. A task with NO folder here (its disk was lost) is restored into its own place, built privately and renamed into place with the `complete` mark like `ensure`, so the task goes on in it. A task
   * whose folder is still here is never written over: the backup is restored into a new folder `<root>/restored/<project>/<task>-<random>` that nothing uses, for the owner to compare or copy from.
   */
  async #restoreTarget(call: { readonly taskId: string; readonly projectId: string }): Promise<HostRestoreTarget | { readonly problem: string }> {
    if (!plain(call.taskId) || !plain(call.projectId)) return { problem: "the task or project name is not a plain name" };
    const shared = this.#options.shared(call.projectId);
    const root = this.#options.root;
    const parent = join(root, call.projectId);
    if (collides(root, call.projectId) || collides(parent, call.taskId)) return { problem: "another task or project folder has a name that differs only in case or form, so a restore here could be mistaken for it" };
    const inPlace = !hasExactly(parent, call.taskId);
    if (inPlace && shared === undefined) return { problem: "this host holds no shared repository for that project, so a restored task could not go on here" };
    const stamp = randomBytes(6).toString("hex");
    const building = inPlace ? join(root, ".making", `restore-${stamp}`) : join(root, "restored", call.projectId, `${call.taskId}-${stamp}`);
    await mkdir(building, { recursive: true });
    const target = { checkout: join(building, "checkout"), gitDir: join(building, "task.git") };
    // A failed restore leaves nothing: the folder it made, and the `restored/<project>` and `restored` folders when this restore was what made them (an empty folder is removed; one with earlier restores stays).
    const abandon = async (): Promise<void> => {
      await rm(building, { recursive: true, force: true });
      if (!inPlace) for (const dir of [join(root, "restored", call.projectId), join(root, "restored")]) await rmdir(dir).catch(() => undefined);
    };
    if (!inPlace) return { ...target, ...(shared === undefined ? {} : { baseFrom: shared }), abandon, finish: async () => `into a new folder, ${building}, that nothing uses (the task's own folder is still here and was not touched)` };
    return {
      ...target, ...(shared === undefined ? {} : { baseFrom: shared }), abandon,
      finish: async () => {
        await writeFile(join(building, "complete"), "1\n");
        await mkdir(parent, { recursive: true });
        try { await rename(building, join(parent, call.taskId)); } catch (error) { throw new WorkspaceError("unavailable", `the restored task folder could not be put in place: ${(error as Error).message.slice(0, 120)}`); }
        return "as the task's own checkout on this host";
      },
    };
  }

  readonly #making = new Map<string, Promise<unknown>>();

  /**
   * The checkout for an attempt's workspace: made from the shared repository's head the first time, found again afterwards (a second attempt of the same task works in the same checkout). It is built in a private folder and
   * renamed into place with a `complete` mark, so a crash part-way leaves nothing that looks like a checkout (the leftover is removed later), and two callers for one task share one making. A checkout that was quarantined
   * is not made again here: the task's folder is still there and its git directory is kept, so this refuses rather than start the agent on an empty folder.
   */
  async ensure(call: { readonly taskId: string; readonly projectId: string; /** The attempt that is about to work in the checkout (card H12o): kept beside the checkout, outside it, so a release commit can name it. */ readonly attemptId?: string }): Promise<{ readonly checkout: string; readonly gitDir: string }> {
    if (!plain(call.taskId) || !plain(call.projectId)) throw new WorkspaceError("invalid_path", "the task or project name is not a plain name");
    const shared = this.#options.shared(call.projectId);
    if (shared === undefined) throw new WorkspaceError("unavailable", "this host holds no shared repository for that project");
    // Card P02: the workspace admits only a repository in the task's access scope. Asked every time (a binding can be narrowed or ended between attempts); a throw is a refusal.
    let binding: StartState["binding"];
    if (this.#options.admit !== undefined) {
      let answer: WorkspaceAdmissionAnswer;
      try { answer = await this.#options.admit({ taskId: call.taskId, projectId: call.projectId, shared }); } catch (error) { throw new WorkspaceError("unavailable", `the workspace was not opened: whether the task may use this repository could not be checked (${String((error as Error)?.message ?? error).slice(0, 160)})`); }
      if (answer?.admitted !== true) throw new WorkspaceError("unavailable", `the workspace was not opened: ${String((answer as { reason?: unknown } | undefined)?.reason ?? "the task's access scope does not admit this repository").slice(0, 400)}`);
      const b = answer.binding;
      binding = { resourceId: b.resourceId, ...(b.repositoryId === undefined ? {} : { repositoryId: b.repositoryId }), locatorEpoch: b.locatorEpoch };
    }
    const key = `${call.projectId}/${call.taskId}`;
    const earlier = this.#making.get(key) ?? Promise.resolve();
    const run = earlier.then(() => this.#ensure(call, shared), () => this.#ensure(call, shared));
    const tail = run.catch(() => undefined);
    this.#making.set(key, tail);
    try {
      const made = await run;
      if (call.attemptId !== undefined && ATTEMPT.test(call.attemptId)) {
        await writeAttempt(join(this.#options.root, call.projectId, call.taskId, "attempt"), call.attemptId);
        await this.#recordStart(call as { taskId: string; projectId: string; attemptId: string }, made, binding);
      }
      return made;
    } finally { if (this.#making.get(key) === tail) this.#making.delete(key); }
  }

  /**
   * Writes the attempt's start record once (card P02): built in a private file and linked into place, so a crash leaves either no record or a whole one, and a second hand-out of the same attempt (a resume) keeps the first.
   * A record that cannot be written refuses the workspace: an attempt does not start without a record of what it started from.
   */
  async #recordStart(call: { readonly taskId: string; readonly projectId: string; readonly attemptId: string }, made: { readonly checkout: string; readonly gitDir: string }, binding: StartState["binding"]): Promise<void> {
    const dir = join(this.#options.root, call.projectId, call.taskId, "starts");
    const file = join(dir, `${call.attemptId}.json`);
    if (existsSync(file)) return;
    let temporary: string | undefined;
    try {
      const state = await this.#options.git.startState(made);
      const sorted = [...state.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const digest = createHash("sha256").update(JSON.stringify([state.base, state.head, state.tree, sorted.map((e) => [e.code, e.path])])).digest("hex");
      const record: StartState = {
        attemptId: call.attemptId, taskId: call.taskId, projectId: call.projectId, recordedAt: this.#options.clock?.() ?? new Date().toISOString(), base: state.base, head: state.head, tree: state.tree,
        files: sorted.slice(0, START_STATE_LIMITS.files), fileCount: sorted.length, digest, ...(binding === undefined ? {} : { binding }),
      };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      temporary = join(dir, `.${call.attemptId}.${randomBytes(6).toString("hex")}.tmp`);
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      try { await link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } catch (error) {
      throw new WorkspaceError("unavailable", `the workspace was not opened: the state the attempt starts from could not be recorded (${String((error as Error)?.message ?? error).slice(0, 160)})`);
    } finally { if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => undefined); }
  }

  /** The start record of an attempt of a task (card P02), or `undefined` when there is none here or it is not a whole record. */
  async startState(call: { readonly taskId: string; readonly projectId: string; readonly attemptId: string }): Promise<StartState | undefined> {
    if (!ATTEMPT.test(call.attemptId)) return undefined;
    const dir = this.#taskDir(call);
    if (dir === undefined) return undefined;
    try {
      const file = join(dir, "starts", `${call.attemptId}.json`);
      if (!lstatSync(file).isFile()) return undefined;
      const parsed = JSON.parse(await readFile(file, "utf8")) as StartState;
      return parsed.attemptId === call.attemptId && parsed.taskId === call.taskId && typeof parsed.digest === "string" && typeof parsed.tree === "string" ? parsed : undefined;
    } catch { return undefined; }
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

const ATTEMPT = /^[A-Za-z0-9._:-]{1,120}$/;
/** The attempt last recorded for a task (a plain file beside the checkout, written by the host); anything else, or a name that is not plain, is no attempt. */
function readAttempt(file: string): string | undefined {
  try {
    if (!lstatSync(file).isFile()) return undefined;
    const text = readFileSync(file, "utf8").trim();
    return ATTEMPT.test(text) ? text : undefined;
  } catch { return undefined; }
}
/** Replaces the record atomically; a failure only loses the name (the commit is then made without an attempt trailer), never the work. */
async function writeAttempt(file: string, attemptId: string): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try { await writeFile(temporary, `${attemptId}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, file); } catch { await rm(temporary, { force: true }).catch(() => undefined); }
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
