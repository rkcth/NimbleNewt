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
import { BRIDGE_LIMITS } from "./bridge.js";
import { collisions, fold, plainName, splitRelative } from "./names.js";
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

/**
 * Card Q04 (who left changes in a task's checkout): the task's checkout belongs to the task, so an attempt starts from whatever the attempt before it left there (card P02), and a submission stages all of it. To know
 * which attempts left changes, the host keeps one record per task beside the checkout (outside the sandbox mount), `<task>/handover.json`:
 *
 *   attemptId  the attempt the checkout was last handed to;
 *   expected   the checkout's tree (every file git does not ignore, as `GitBridge.startState` writes it through a private index) as that attempt got it, moved on by every request the platform carried out on the checkout
 *              since (a refresh, re-apply, release, landing, integration or restack: see `WorkspaceHostOptions.tracked`), or `null` when it could not be read;
 *   left       every attempt of the task found to have left the checkout different from what it was handed (at most `HANDOVER_LIMITS.attempts`);
 *   overflow   true when the record cannot name every such attempt (the list was full, the record was damaged, or the checkout held changes before any attempt was recorded).
 *
 * The comparison is made when the checkout is handed to a NEW attempt (`ensure` with another attempt ID), and also before each platform request (the attempt it was handed to changed it before the request ran). A tree that
 * cannot be read, or a record with no tree, counts as changed (fail closed). The submit's staging reports the list (`stageWork`'s `leftBy`), and the controller adds the agents of those attempts to the task's contributors.
 * While a platform request runs, `<task>/handover.during` marks it, so a host that stops part-way through one does not charge the request's change to an attempt (see `#tracked`).
 */
export interface HandoverState {
  readonly attemptId: string;
  readonly expected: string | null;
  readonly left: readonly string[];
  readonly overflow?: true;
}
export const HANDOVER_LIMITS = { attempts: 64 } as const;
/** What the staging of a submission says about the attempts that left changes in the checkout (card Q04): `complete` is false when the host cannot name every one (see `HandoverState.overflow`, or no record). */
export interface LeftBy { readonly attempts: readonly string[]; readonly complete: boolean }

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
      tracked: (where, work) => this.#tracked(where, work),
    });
    const checks = options.checks === undefined ? undefined : landingChecks({ ...options.checks, git: options.git, locate: (call) => this.locate(call) });
    this.port = { run: (call) => this.#run(call), restack: (call) => this.host.restack(call), ...(checks === undefined ? {} : { landingChecks: checks }) };
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
    // In the checkout's turn (first review of the product launcher slice): a re-apply, release or landing on the same checkout finishes before this reads it, and none starts while it reads.
    return this.host.exclusive(where.checkout, async () => {
      const now = this.#stillHere(call, where.checkout, "the submit could not be checked");
      await this.#submitAdmitted(call, now.shared);
      const tip = await this.host.landingHead({ taskId: call.taskId, projectId: call.projectId, shared: now.shared }, "the submit could not be checked");
      if ("refuse" in tip) throw new WorkspaceError("unavailable", tip.refuse);
      return this.#options.git.submitView({ shared: now.shared, gitDir: now.gitDir, checkout: now.checkout, head: tip.head });
    }).catch((error: unknown) => { throw plainError(error, where, this.#options.root); });
  }

  /**
   * The task's location again, inside the checkout's turn (second review of the product launcher slice): the wait may have been behind a quarantine of the checkout, and the project's shared repository may have been
   * changed meanwhile, so the location found before the wait is not used. A checkout that is gone, or is now another one, refuses (`unavailable`).
   */
  #stillHere(call: { readonly taskId: string; readonly projectId: string }, checkout: string, what: string): CheckoutLocation {
    const now = this.locate(call);
    if (now === undefined || now.checkout !== checkout || !existsSync(now.checkout)) throw new WorkspaceError("unavailable", `${what}: the task's checkout is no longer on this host as it was (it was moved, quarantined or removed)`);
    return now;
  }

  /**
   * Stages the task's checkout for a submission (card H12n): `GitBridge.stage` (everything git does not ignore, into the checkout's own index; a link or Git-named entry refuses the whole), then the patch ID of the staged change.
   * Returns the base the staging is on, the tree, the patch ID and the staged files. Refuses when this host holds no checkout for the task, or when nothing differs from the base (there is nothing to submit).
   */
  async stageWork(call: { readonly taskId: string; readonly projectId: string }): Promise<{ base: string; tree: string; patchId: string; files: string[]; /** Card Q04: the attempts that left changes in this checkout. */ leftBy: LeftBy }> {
    const where = this.locate(call);
    if (where === undefined) throw new WorkspaceError("unavailable", "this host holds no checkout for the task, so its work cannot be staged");
    // In the checkout's turn, as the view: the index, the head and the files cannot be changed by another request of this host between the staging and the patch ID.
    return this.host.exclusive(where.checkout, async () => {
      const now = this.#stillHere(call, where.checkout, "the work cannot be staged");
      await this.#submitAdmitted(call, now.shared);
      const staged = await this.#options.git.stage({ gitDir: now.gitDir, checkout: now.checkout, check: landable });
      if (staged.files.length === 0) throw new WorkspaceError("invalid_path", "the checkout holds no change against its base, so there is nothing to submit");
      const patchId = await this.#options.git.patchId({ gitDir: now.gitDir, base: staged.base });
      if (patchId === undefined) throw new WorkspaceError("invalid_path", "the checkout holds no change against its base, so there is nothing to submit");
      // Read in the same turn as the staging: no hand-out or platform request changes the record between the two.
      const record = await readHandover(join(now.checkout, "..", "handover.json"));
      const leftBy: LeftBy = record === undefined || record === "damaged" ? { attempts: [], complete: false } : { attempts: [...record.left], complete: record.overflow !== true };
      return { base: staged.base, tree: staged.tree, patchId, files: staged.files.map((f) => f.path), leftBy };
    }).catch((error: unknown) => { throw plainError(error, where, this.#options.root); });
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
      const answer = await this.#admission({ taskId: call.taskId, projectId: call.projectId, shared });
      if ("refused" in answer) throw new WorkspaceError("unavailable", `the workspace was not opened: ${answer.refused}`);
      binding = answer.binding;
    }
    const key = `${call.projectId}/${call.taskId}`;
    const earlier = this.#making.get(key) ?? Promise.resolve();
    const run = earlier.then(() => this.#ensure(call, shared), () => this.#ensure(call, shared));
    const tail = run.catch(() => undefined);
    this.#making.set(key, tail);
    try {
      const made = await run;
      if (call.attemptId !== undefined && ATTEMPT.test(call.attemptId)) {
        const attempt = call as { taskId: string; projectId: string; attemptId: string };
        // In the checkout's turn (card Q04): a platform request on the checkout (which keeps the record too) finishes before the checkout is compared and handed out, and none starts meanwhile.
        await this.host.exclusive(made.checkout, async () => {
          let state: Awaited<ReturnType<GitBridge["startState"]>>;
          try { state = await this.#options.git.startState(made); } catch (error) {
            throw new WorkspaceError("unavailable", `the workspace was not opened: the state the attempt starts from could not be recorded (${String((error as Error)?.message ?? error).slice(0, 160)})`);
          }
          await this.#handOver(attempt, state);
          await writeAttempt(join(this.#options.root, attempt.projectId, attempt.taskId, "attempt"), attempt.attemptId);
          await this.#recordStart(attempt, made, binding, state);
        });
      }
      return made;
    } finally { if (this.#making.get(key) === tail) this.#making.delete(key); }
  }

  /**
   * A submit's view and its staging (card H12n, product launcher follow-up): with `admit` given, the task's repository must still be bound to its project with write access to all of it (card P02), asked again on the shared
   * folder the checkout came from. A binding unbound, moved or narrowed since the workspace opened refuses (`unavailable`); nothing is read or staged. Without `admit` (a host that asks no admission) nothing changes.
   */
  async #submitAdmitted(call: { readonly taskId: string; readonly projectId: string }, shared: string): Promise<void> {
    if (this.#options.admit === undefined) return;
    const answer = await this.#admission({ taskId: call.taskId, projectId: call.projectId, shared });
    if ("refused" in answer) throw new WorkspaceError("unavailable", `the work cannot be submitted: ${answer.refused}`.slice(0, 500));
  }

  /** The `admit` hook's answer as a binding or a plain refusal (a throw, or an answer that is not an admission, is a refusal). */
  async #admission(call: { readonly taskId: string; readonly projectId: string; readonly shared: string }): Promise<{ readonly binding: NonNullable<StartState["binding"]> } | { readonly refused: string }> {
    let answer: WorkspaceAdmissionAnswer;
    try { answer = await this.#options.admit!(call); } catch (error) { return { refused: `whether the task may use this repository could not be checked (${String((error as Error)?.message ?? error).slice(0, 160)})` }; }
    if (answer?.admitted !== true) return { refused: String((answer as { reason?: unknown } | undefined)?.reason ?? "the task's access scope does not admit this repository").slice(0, 400) };
    const b = answer.binding;
    return { binding: { resourceId: b.resourceId, ...(b.repositoryId === undefined ? {} : { repositoryId: b.repositoryId }), locatorEpoch: b.locatorEpoch } };
  }

  /**
   * Card P02 review: an integration or a landing writes the project's shared repository, so with `admit` given it is asked again first, on the shared folder the request would write. A binding unbound, moved, narrowed to
   * reading or to some paths, or a shared folder that is no longer the task's admitted repository, refuses the request with nothing written (the checkout and its work stay). The other operations write only the task's own
   * checkout and are not asked.
   */
  async #run(call: HostWorkspaceCall): Promise<HostWorkspaceOutcome> {
    if (this.#options.admit !== undefined && call !== null && typeof call === "object" && (call.operation === "integration" || call.operation === "landing")) {
      const where = this.locate(call);
      if (where !== undefined) {
        const answer = await this.#admission({ taskId: call.taskId, projectId: call.projectId, shared: where.shared });
        if ("refused" in answer) return { ok: false, reason: `nothing was written to the shared repository: ${answer.refused}`.slice(0, 500) };
      }
    }
    return this.host.run(call);
  }

  /**
   * Writes the attempt's start record once (card P02): built in a private file and linked into place, so a crash leaves either no record or a whole one, and a second hand-out of the same attempt (a resume) keeps the first.
   * A record that cannot be written refuses the workspace: an attempt does not start without a record of what it started from.
   */
  async #recordStart(call: { readonly taskId: string; readonly projectId: string; readonly attemptId: string }, made: { readonly checkout: string; readonly gitDir: string }, binding: StartState["binding"], known?: Awaited<ReturnType<GitBridge["startState"]>>): Promise<void> {
    const dir = join(this.#options.root, call.projectId, call.taskId, "starts");
    const file = join(dir, startFileName(call.attemptId));
    if (existsSync(file)) return;
    let temporary: string | undefined;
    try {
      const state = known ?? await this.#options.git.startState(made);
      const sorted = [...state.entries].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
      const digest = createHash("sha256").update(JSON.stringify([state.base, state.head, state.tree, sorted.map((e) => [e.code, e.path])])).digest("hex");
      const record: StartState = {
        attemptId: call.attemptId, taskId: call.taskId, projectId: call.projectId, recordedAt: this.#options.clock?.() ?? new Date().toISOString(), base: state.base, head: state.head, tree: state.tree,
        files: sorted.slice(0, START_STATE_LIMITS.files), fileCount: sorted.length, digest, ...(binding === undefined ? {} : { binding }),
      };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      temporary = join(dir, `.start.${randomBytes(6).toString("hex")}.tmp`);
      await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
      try { await link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
    } catch (error) {
      throw new WorkspaceError("unavailable", `the workspace was not opened: the state the attempt starts from could not be recorded (${String((error as Error)?.message ?? error).slice(0, 160)})`);
    } finally { if (temporary !== undefined) await rm(temporary, { force: true }).catch(() => undefined); }
  }

  /**
   * Card Q04: the checkout is handed to `call.attemptId`. When the attempt it was handed to before is another one, that attempt is added to `left` if the checkout is not what it was handed (or that cannot be told). A
   * resume (the same attempt again) changes nothing. A record that cannot be written refuses the workspace, as the start record does. Runs in the checkout's turn.
   */
  async #handOver(call: { readonly taskId: string; readonly projectId: string; readonly attemptId: string }, state: { readonly tree: string; readonly entries: readonly unknown[] }): Promise<void> {
    const dir = join(this.#options.root, call.projectId, call.taskId);
    const file = join(dir, "handover.json");
    const prior = await readHandover(file);
    const whole = prior !== undefined && prior !== "damaged" ? prior : undefined;
    // First review: a host that stopped part-way through a platform request left the mark (see `#tracked`); what the checkout holds now is that request's, and no attempt has run since (each starts here).
    const marker = join(dir, INTERRUPTED);
    const interrupted = whole !== undefined && isMarked(marker);
    if (whole?.attemptId === call.attemptId) {
      if (!interrupted) return;
      try { await writeHandover(file, { ...whole, expected: state.tree }); } catch (error) {
        throw new WorkspaceError("unavailable", `the workspace was not opened: the record of who changed the checkout could not be written (${String((error as Error)?.message ?? error).slice(0, 160)})`);
      }
      await rm(marker, { force: true }).catch(() => undefined);
      return;
    }
    // The attempt before: the record's, else (a task folder from before the record) the attempt file's, whose start record holds the tree it was handed.
    const previous = whole?.attemptId ?? readAttempt(join(dir, "attempt"));
    let expected: string | null = interrupted ? state.tree : whole?.expected ?? null;
    if (whole === undefined && previous !== undefined) expected = (await this.startState({ taskId: call.taskId, projectId: call.projectId, attemptId: previous }))?.tree ?? null;
    const left = new Set(whole?.left ?? []);
    // A damaged record has lost its list; a checkout that already holds changes with no attempt recorded holds someone's unrecorded work.
    let overflow = whole?.overflow === true || prior === "damaged" || (prior === undefined && previous === undefined && state.entries.length > 0);
    if (previous !== undefined && previous !== call.attemptId && (expected === null || expected !== state.tree)) overflow = addLeft(left, previous) || overflow;
    try { await writeHandover(file, { attemptId: call.attemptId, expected: state.tree, left: [...left], ...(overflow ? { overflow: true as const } : {}) }); } catch (error) {
      throw new WorkspaceError("unavailable", `the workspace was not opened: the record of who changed the checkout could not be written (${String((error as Error)?.message ?? error).slice(0, 160)})`);
    }
    await rm(marker, { force: true }).catch(() => undefined);
  }

  /**
   * Card Q04: a platform request on a checkout (`WorkspaceHostOptions.tracked`). Before it, a checkout that is not what its attempt was handed (or cannot be read) adds that attempt to `left`; after it (whatever it
   * answered), the tree it left becomes the expected one, so what the request itself changed is never charged to an attempt. A checkout with no record (none was handed to an attempt here) is not tracked. A record that
   * cannot be written afterwards keeps the earlier expected tree, so the change is charged to the attempt at the next hand-out (fail closed).
   *
   * A host that stops part-way through the request (first review): the charge found before it is written before the request starts, and then the mark `<task>/handover.during`; the mark is removed when the request
   * ends (also when the record could not be written then, so that the earlier tree still counts). A mark found later means the request did not end: what the checkout holds is the request's, not the attempt's (no
   * attempt runs before the next hand-out, which reads the mark), so it becomes the expected tree. When the record or the mark cannot be written before the request, the request still runs (fail closed: the attempt
   * is charged with its change at the next hand-out).
   */
  async #tracked<T>(where: CheckoutLocation, work: () => Promise<T>): Promise<T> {
    const file = join(where.checkout, "..", "handover.json");
    const marker = join(where.checkout, "..", INTERRUPTED);
    const prior = await readHandover(file);
    if (prior === undefined || prior === "damaged") return work();
    const tree = async (): Promise<string | undefined> => { try { return (await this.#options.git.startState({ checkout: where.checkout, gitDir: where.gitDir })).tree; } catch { return undefined; } };
    const left = new Set(prior.left);
    let overflow = prior.overflow === true;
    const before = await tree();
    const expected = isMarked(marker) ? before ?? null : prior.expected;
    if (before === undefined || expected === null || before !== expected) overflow = addLeft(left, prior.attemptId) || overflow;
    const record = (tree: string | null): HandoverState => ({ attemptId: prior.attemptId, expected: tree, left: [...left], ...(overflow ? { overflow: true as const } : {}) });
    let marked = false;
    try { await writeHandover(file, record(before ?? null)); await writeFile(marker, "", { mode: 0o600 }); marked = true; } catch { await rm(marker, { force: true }).catch(() => undefined); }
    try { return await work(); } finally {
      const after = await tree();
      await writeHandover(file, record(after ?? null)).catch(() => undefined);
      if (marked) await rm(marker, { force: true }).catch(() => undefined);
    }
  }

  /** The start record of an attempt of a task (card P02), or `undefined` when there is none here or it is not a whole record. */
  async startState(call: { readonly taskId: string; readonly projectId: string; readonly attemptId: string }): Promise<StartState | undefined> {
    if (!ATTEMPT.test(call.attemptId)) return undefined;
    const dir = this.#taskDir(call);
    if (dir === undefined) return undefined;
    try {
      const file = join(dir, "starts", startFileName(call.attemptId));
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

/**
 * Refuses a staging that a landing could never carry (second review of the product launcher slice), so a submission is not reviewed and approved only to fail at its landing: the landing writes the change through the
 * bridge as one set (`WorkspaceBridge.writeSet`), which takes at most `BRIDGE_LIMITS.setFiles` files, `BRIDGE_LIMITS.fileBytes` bytes per file and `BRIDGE_LIMITS.setBytes` in all, only names every system can hold
 * (`splitRelative`), and no two names that are one file on a case-insensitive or normalising filesystem. Before this a change of about 50 MB failed with an empty "git diff failed:" text, and a larger set was approved but
 * could not land. The reason says which bound and names at most one file (cut).
 */
function landable(files: readonly { readonly path: string; readonly op: "write" | "delete" }[], sizes: ReadonlyMap<string, number>): void {
  const shown = (path: string): string => JSON.stringify(path.slice(0, 120));
  if (files.length > BRIDGE_LIMITS.setFiles) throw new WorkspaceError("invalid_path", `the change touches ${files.length} files; a landing carries at most ${BRIDGE_LIMITS.setFiles} as one step, so it cannot be submitted (split the work into smaller tasks)`);
  let total = 0;
  for (const f of files) {
    try { splitRelative(f.path); } catch (error) { throw new WorkspaceError("invalid_path", `the change holds ${shown(f.path)}, which a landing cannot write (${(error as Error).message.slice(0, 160)}); rename it before submitting`); }
    const size = sizes.get(f.path) ?? 0;
    if (size > BRIDGE_LIMITS.fileBytes) throw new WorkspaceError("invalid_path", `${shown(f.path)} is ${size} bytes; a landing carries at most ${BRIDGE_LIMITS.fileBytes} bytes per file, so the change cannot be submitted`);
    total += size;
  }
  if (total > BRIDGE_LIMITS.setBytes) throw new WorkspaceError("invalid_path", `the change's files hold ${total} bytes; a landing carries at most ${BRIDGE_LIMITS.setBytes} bytes as one step, so it cannot be submitted`);
  const clash = collisions(files.map((f) => f.path))[0];
  if (clash !== undefined) throw new WorkspaceError("collision", `the change holds ${clash.slice(0, 2).map(shown).join(" and ")}, which are one file on a case-insensitive or normalising filesystem; a landing cannot write both, so it cannot be submitted`);
}

/**
 * A submit's error as the owner reads it (second review of the product launcher slice): the same code and tamper mark, with this host's folders named by what they are instead of by their path (git's own text names
 * them, for example an `index.lock` left in the task's git directory), and any other absolute path replaced. A thrown value that is not a workspace error becomes `unavailable`.
 */
function plainError(error: unknown, where: CheckoutLocation, root: string): WorkspaceError {
  const message = String((error as Error)?.message ?? error);
  const real = (p: string): string => { try { return realpathSync(p); } catch { return p; } };
  const labels: [string, string][] = [
    [where.gitDir, "the task's git directory"], [where.checkout, "the checkout"], [join(where.checkout, ".."), "the task's folder"], [where.shared, "the shared repository"], [root, "the host's workspace folder"],
  ];
  const named = labels.flatMap(([p, label]): [string, string][] => [[real(p), label], [p, label]]).filter(([p]) => p.length > 1).sort((a, b) => b[0].length - a[0].length);
  let text = message;
  for (const [p, label] of named) text = text.split(p).join(label);
  text = text.replace(/(?<![\w.~-])(?:\/[^\s'"`]+|[A-Za-z]:\\[^\s'"`]+)/g, "<a host path>");
  if (error instanceof WorkspaceError) {
    if (text === message) return error;
    return new WorkspaceError(error.code, text, { cause: error, ...(error.tamper === true ? { tamper: true as const } : {}), ...(error.detail === undefined ? {} : { detail: error.detail }) });
  }
  return new WorkspaceError("unavailable", text.slice(0, 500), { cause: error });
}

const ATTEMPT = /^[A-Za-z0-9._:-]{1,120}$/;
/**
 * The file name of an attempt's start record (card P02 review): the attempt ID itself when it is lower-case letters, digits, `_`, `-` and inner dots, so it means the same file on every filesystem; otherwise (a capital letter,
 * which a case-insensitive filesystem would fold onto another attempt's record, a `:`, which Windows reads as a stream name, or an end dot, which Windows drops) a digest of the ID. The record names its attempt either way.
 */
const startFileName = (attemptId: string): string => (/^[a-z0-9_-](?:[a-z0-9._-]*[a-z0-9_-])?$/.test(attemptId) ? `${attemptId}.json` : `~${createHash("sha256").update(attemptId).digest("hex").slice(0, 40)}.json`);
/** Card Q04 (first review): the mark, beside the handover record, that a platform request on the checkout is under way (see `LocalWorkspaces.#tracked`). */
const INTERRUPTED = "handover.during";
/** Whether the mark is there (anything at that name counts; one that cannot be looked at does not). */
function isMarked(file: string): boolean { try { lstatSync(file); return true; } catch { return false; } }
/** Adds an attempt to the list unless it is full; answers true when it could not be added (the list then does not name every attempt). */
function addLeft(left: Set<string>, attemptId: string): boolean {
  if (left.has(attemptId)) return false;
  if (left.size >= HANDOVER_LIMITS.attempts) return true;
  left.add(attemptId);
  return false;
}
/** The handover record (card Q04): `undefined` when there is none, `"damaged"` when there is a file that is not a whole record (or not a plain file). */
async function readHandover(file: string): Promise<HandoverState | "damaged" | undefined> {
  let text: string;
  try {
    if (!lstatSync(file).isFile()) return "damaged";
    text = await readFile(file, "utf8");
  } catch (error) { return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : "damaged"; }
  try {
    const r = JSON.parse(text) as Partial<HandoverState>;
    const tree = (v: unknown): boolean => typeof v === "string" && /^[0-9a-f]{40,64}$/.test(v);
    if (r === null || typeof r !== "object" || typeof r.attemptId !== "string" || !ATTEMPT.test(r.attemptId) || !(r.expected === null || tree(r.expected)) || !Array.isArray(r.left) || r.left.length > HANDOVER_LIMITS.attempts || !r.left.every((a) => typeof a === "string" && ATTEMPT.test(a)) || (r.overflow !== undefined && r.overflow !== true)) return "damaged";
    return { attemptId: r.attemptId, expected: r.expected as string | null, left: r.left, ...(r.overflow === true ? { overflow: true as const } : {}) };
  } catch { return "damaged"; }
}
/** Replaces the handover record atomically (a private file renamed into place). Throws when it cannot. */
async function writeHandover(file: string, record: HandoverState): Promise<void> {
  const temporary = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  try { await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" }); await rename(temporary, file); } catch (error) { await rm(temporary, { force: true }).catch(() => undefined); throw error; }
}
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
