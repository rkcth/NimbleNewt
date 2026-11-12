import { createHash } from "node:crypto";
import type { BlockerService } from "../domain/blockers.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { assignmentIdOf, attemptId as checkAttemptId, type AssignmentBody, type AttemptBody } from "../domain/assignment-model.js";
import { onlyKnown, taskId as checkTaskId, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { DependencyCheck, DependencyService, Observation } from "../dependencies/dependencies.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { ContinuationBody, ContinuationService, RestoreMethod } from "./continuation.js";
import { RESTORE_METHODS } from "./continuation.js";

export type ResumePhase = "collecting" | "verifying" | "reviewing" | "ready" | "blocked" | "executing" | "done" | "cancelled";
const TERMINAL: readonly ResumePhase[] = ["done", "cancelled"];
const LIVE: readonly ResumePhase[] = ["collecting", "verifying", "reviewing", "ready", "blocked", "executing"];

export interface ResumeVerdict {
  readonly relevant: boolean; readonly rationale: string; /** The status and detail the verdict was given for: a verdict is reused only while the change is still this one. */ readonly digest: string;
  /** Set when no reviewer judged this change (`ReviewNotRun`, card L04d wiring): why. Kept with the verdict, so a check started over keeps saying it of this change whatever later rounds did. */
  readonly notReviewed?: string;
}
export interface DeltaItem { readonly id: string; readonly kind: string; readonly key: string; readonly status: string; readonly detail: string }

/** What a checked resume reads from the rest of the system. Every call must be repeatable. */
export interface ResumePorts {
  /** What the worker sees now for the task's recorded dependencies (by entry ID). Entries it does not report read as `unknown`, never as unchanged. */
  observe(taskId: string): Promise<Readonly<Record<string, Observation>>>;
  /** Names of context the task cannot continue without that is not there (an empty list when it is all present). */
  missingContext(taskId: string, continuation: ContinuationBody & { id: string }): Promise<readonly string[]>;
  /** Earlier effects whose outcome is unknown; they are resolved before work goes on. */
  uncertainEffects(taskId: string, continuation: ContinuationBody & { id: string }): Promise<readonly string[]>;
  /** An independent verdict on whether each change matters to the work, with a reason. May fail; the resume then waits at the review. */
  review(request: { taskId: string; changes: readonly DeltaItem[] }): Promise<Readonly<Record<string, { relevant: boolean; rationale: string }>>>;
}

/**
 * What a review port throws when no reviewer could be asked at all (card L04d wiring): no route is set, the route cannot be used, the daily cap on the controller's own model calls is reached, or every route failed.
 * Unlike any other failure (which blocks the check `review_failed`), this is not a verdict and not a block: the check records that the review did NOT run, and why, and every change it held is treated as
 * relevant, so the resume follows the rule it had before a reviewer existed (every changed resume waits for the owner). It is never passed off as reviewed.
 */
export class ReviewNotRun extends Error {
  constructor(readonly reason: string) { super(reason); this.name = "ReviewNotRun"; }
}

export interface ResumeCheckBody {
  readonly taskId: string;
  readonly projectId: string;
  /**
   * The attempt the check was started for (the dispatcher's checks, card L04c). While it is set, the check stands only while that attempt is the task's active one: once the task is released, transferred or given another
   * attempt, the check is not listed as held, cannot be committed or approved, and the dispatcher cancels it. Absent on a check started through `resume.start`.
   */
  readonly attemptId?: string;
  readonly phase: ResumePhase;
  /** How many times the inputs changed between review and commit and the check started over. */
  readonly round: number;
  /** How many times it has blocked: part of each blocker's command ID, so a retry that blocks again opens a new blocker. */
  readonly blocks: number;
  readonly maxRounds: number;
  readonly model: { readonly provider: string; readonly id: string };
  readonly previousModel?: { readonly provider: string; readonly id: string };
  readonly after: "restart" | "model-change" | "continue";
  readonly continuationId?: string;
  /** The revisions that were verified: the continuation and the digest of every dependency's status. A commit is allowed only while these still hold. */
  readonly revisionSet?: { readonly continuationId: string; readonly digest: string; readonly dependencies: number; readonly unverified: boolean };
  /** What changed, permission-filtered by the checker's own rights; nothing of the content itself. */
  readonly delta?: { readonly changed: readonly DeltaItem[]; readonly unchanged: number };
  readonly verdicts: Readonly<Record<string, ResumeVerdict>>;
  /**
   * Whether the last review of the check's changes was made by a reviewer (`ran`) or could not be (`not-run`, with why: every change it held was then treated as relevant, the owner's to accept). Absent: no
   * review has been asked for yet (or the check predates card L04d wiring).
   */
  readonly review?: { readonly state: "ran" | "not-run"; readonly reason?: string; readonly at: string };
  readonly blocked?: { readonly type: "missing_context" | "resume_churn" | "effects_uncertain" | "review_failed"; readonly reason: string; readonly blockerId?: string } | undefined;
  /** How the earlier context was brought back, and what that cannot promise. */
  readonly restore?: { readonly method: RestoreMethod; readonly limits: readonly string[] };
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly history: readonly { readonly phase: ResumePhase; readonly at: string; readonly by: string; readonly note: string }[];
}

/** Reason code of a cancel the dispatcher makes when a check of another route is superseded; such a cancel does not count toward the restart budget. */
export const STALE_CANCEL = "stale-by-dispatcher" as const;
/** Reason code of a cancel the dispatcher makes when the attempt the check was for ended (released, transferred, replaced or expired) before it started. */
export const ENDED_CANCEL = "attempt-ended" as const;
/** The history note of a check the owner declined (`decline`). */
export const DECLINED = "declined by the owner" as const;
/** A blocked check without a blocker is retried no sooner than this many milliseconds times its number of blocks after it blocked. */
export const RETRY_BACKOFF_MS = 5 * 60_000;
export const RESUME_LIMITS = { rounds: 3, advances: 10, history: 40, note: 300, limits: 10 } as const;
const validRounds = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 1 && n <= 10;
/**
 * Who records the continuation resume of a committed check. The record's command ID is scoped by the recorder, so it must be the same whoever carries the check on: the owner's approval, the dispatcher's
 * commit and the start-up sweep after a crash all record the one resume (card L04c). Who committed is kept in the check's own history.
 */
const RESUMER: Principal = { id: "service:resume-check", kind: "service", name: "resume-check", grants: [] };
const KIND = "resume-check";
/** One record per `resume.decline` command (by its scoped command ID): which check it declined, so the same command again answers as it did. */
const DECLINE_KIND = "resume-decline";
const ORPHANED = "not committed: the attempt this resume check was for is no longer the task's active attempt (the task was released, transferred or given another attempt), so nothing is resumed";
const NOT_APPROVED_ORPHANED = "not approved: the attempt this resume check was for is no longer the task's active attempt (the task was released, transferred or given another attempt), so there is nothing to let go on";
const ACTIVE = "resume-active";
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
const clean = (body: object): JsonObject => JSON.parse(JSON.stringify(body)) as JsonObject;
/** Cut without splitting a surrogate pair: half of one is ill-formed text, refused wherever the note is shown or sent on (a blocker's summary, a notice). */
const short = (value: string): string => { const cut = redactText(value).replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, RESUME_LIMITS.note); return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut; };
const MODEL = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,99}$/;
const checkModel = (v: unknown, field: string): { provider: string; id: string } => {
  if (v === null || typeof v !== "object") return invalid(field, "must be { provider, id }");
  const m = v as Record<string, unknown>;
  if (typeof m["provider"] !== "string" || !MODEL.test(m["provider"]) || typeof m["id"] !== "string" || !MODEL.test(m["id"])) return invalid(field, "must be { provider, id } of plain names");
  return { provider: m["provider"], id: m["id"] };
};

export interface ResumeCheckDeps {
  readonly continuations: Pick<ContinuationService, "latest" | "resume">;
  readonly dependencies: Pick<DependencyService, "check">;
  readonly blockers: Pick<BlockerService, "openBlocker" | "getBlocker">;
  readonly ports: ResumePorts;
  /** Releases the task whose held resume the owner declined, while `attemptId` is still its active attempt (card L04c). Must be repeatable (a command ID derived from the attempt). Absent: `decline` is unavailable for a dispatcher's check. */
  readonly release?: (by: Principal, taskId: string, attemptId: string) => Promise<void>;
  /** Closes the owner's notice that the check is held (best effort), when the owner approves or declines it. */
  readonly settle?: (checkId: string, projectId: string) => Promise<void>;
}

/**
 * Checked resume (card L04): collect, verify, review, commit. A task is not carried on from its stored context just because the context exists. The check collects the latest complete continuation
 * (C03), verifies every recorded dependency against what is true now (the controller's own state, and the worker's observations; a dependency nobody observed reads `unknown`, never "unchanged"), has an
 * independent reviewer give a verdict with a reason for each change, and only then lets the resume commit. The commit looks again: if the continuation or any dependency changed between review and commit, the
 * check starts over (changes already judged and still the same keep their verdict, so nothing unchanged is rebuilt), and after a bounded number of rounds it stops with a `resume_churn` blocker instead of
 * chasing the inputs for ever. Missing critical context opens a `missing_context` blocker; earlier effects of unknown outcome are resolved before work goes on. The delta packet is made from what the checker
 * is allowed to read, so content that was revoked is never carried into it. The way the context came back (native restore, reconstruction or restart) and what it cannot promise are recorded with the result.
 */
export class ResumeCheckService {
  readonly #runner: CommandRunner;
  /** Checks whose reviewer is being asked in this process now (card L04d follow-up): a second advance of the same check (the dispatcher's sweep while its own job waits for the model, an API call) answers where the check stands instead of asking the model again and counting its tokens twice. */
  readonly #reviewing = new Set<string>();
  readonly #continuations: Pick<ContinuationService, "latest" | "resume">;
  readonly #dependencies: Pick<DependencyService, "check">;
  readonly #blockers: Pick<BlockerService, "openBlocker" | "getBlocker">;
  readonly #ports: ResumePorts;
  readonly #rounds: number | (() => Promise<number>);
  readonly #release: ResumeCheckDeps["release"];
  readonly #settle: ResumeCheckDeps["settle"];

  private constructor(runner: CommandRunner, deps: ResumeCheckDeps, rounds: number | (() => Promise<number>)) {
    this.#runner = runner; this.#continuations = deps.continuations; this.#dependencies = deps.dependencies; this.#blockers = deps.blockers; this.#ports = deps.ports; this.#rounds = rounds; this.#release = deps.release; this.#settle = deps.settle;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: ResumeCheckDeps, options: RunnerOptions & { maxRounds?: number; /** Read once per new check (the owner's setting); wins over `maxRounds`. */ rounds?: () => Promise<number> } = {}): ResumeCheckService {
    // A supplied rounds() is read for each new check; a fixed maxRounds is then ignored, so it is not even validated.
    const rounds = options.rounds ?? options.maxRounds ?? RESUME_LIMITS.rounds;
    if (typeof rounds === "number" && !validRounds(rounds)) throw new RangeError("maxRounds must be a whole number from 1 to 10");
    return new ResumeCheckService(new CommandRunner(storage, epoch, options), deps, rounds);
  }

  // ---- requests ------------------------------------------------------------------------------------------------------------

  /** Begins a checked resume of a task. One at a time per task; the same command again answers where it stands. Returns after one pass. */
  async start(by: Principal, command: NoActor & { taskId: string; model: unknown; previousModel?: unknown; after: "restart" | "model-change" | "continue"; attemptId?: string }): Promise<View<ResumeCheckBody>> {
    onlyKnown(command, ["commandId", "taskId", "model", "previousModel", "after", "attemptId"]);
    const attemptId = command.attemptId === undefined ? undefined : checkAttemptId(command.attemptId);
    const taskId = checkTaskId(command.taskId);
    const projectId = await this.#authorize(by, taskId);
    if (!["restart", "model-change", "continue"].includes(command.after)) invalid("after", "must be restart, model-change or continue");
    const model = checkModel(command.model, "model");
    const previousModel = command.previousModel === undefined ? undefined : checkModel(command.previousModel, "previousModel");
    const id = derivedId("rck", scopedCommandId(by.id, command.commandId));
    const activeRef: AggregateRef = { kind: ACTIVE, id: derivedId("rck", `active\0${taskId}`) };
    await this.#runner.command("resume.start", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      // The attempt is kept out of the payload: a check started before it was recorded answers the same command again instead of conflicting (the dispatcher's command ID names the attempt anyway).
      payload: { taskId, model: model as unknown as JsonObject, previousModel: (previousModel ?? null) as unknown as JsonObject, after: command.after },
      build: async () => {
        const at = this.#runner.now();
        const maxRounds = typeof this.#rounds === "number" ? this.#rounds : await this.#rounds();
        if (!validRounds(maxRounds)) throw new DomainError("invalid_command", "the resume retry limit is not a whole number from 1 to 10", { field: "maxRounds" });
        const active = await this.#runner.get(ACTIVE, activeRef.id);
        const current = (active?.body as unknown as { checkId?: string } | undefined)?.checkId;
        if (current !== undefined && current !== id) {
          const cur = await this.#runner.get(KIND, current);
          if (cur !== undefined && LIVE.includes((cur.body as unknown as ResumeCheckBody).phase)) throw new DomainError("invalid_command", `task ${taskId} already has a resume check in progress`, { field: "taskId" });
        }
        const ref: AggregateRef = { kind: KIND, id };
        const body: ResumeCheckBody = {
          taskId, projectId, ...(attemptId === undefined ? {} : { attemptId }), phase: "collecting", round: 0, blocks: 0, maxRounds, model, ...(previousModel === undefined ? {} : { previousModel }), after: command.after, verdicts: {},
          requestedBy: by.id, requestedAt: at, history: [{ phase: "collecting", at, by: by.id, note: "resume check started" }],
        };
        const pointer = clean({ checkId: id });
        return {
          ref, creates: true,
          changes: [{ type: "create", ref, body: clean(body) }, active === undefined ? { type: "create", ref: activeRef, body: pointer } : { type: "update", ref: activeRef, expectedRevision: active.revision, body: pointer }],
          detail: { taskId },
        };
      },
    }));
    return this.advance(by, { checkId: id });
  }

  /**
   * Commits: looks once more at the continuation and every dependency. If they are as they were when the check was reviewed, the resume is recorded (`continuation.resume`) with how the context was restored;
   * if anything changed, nothing is committed and the check starts over (or stops as `resume_churn` after its rounds).
   */
  async commit(by: Principal, command: NoActor & { checkId: string; restoredBy?: RestoreMethod; limits?: readonly string[] }): Promise<View<ResumeCheckBody>> {
    onlyKnown(command, ["commandId", "checkId", "restoredBy", "limits"]);
    if (command.restoredBy !== undefined && !RESTORE_METHODS.includes(command.restoredBy)) invalid("restoredBy", "must be native-restore, reconstruction or restart");
    const limits = (command.limits ?? []).map((l) => short(String(l))).slice(0, RESUME_LIMITS.limits);
    const found = await this.#get(by, command.checkId);
    const b = found.body as unknown as ResumeCheckBody;
    if (b.phase === "done" || b.phase === "executing") return this.advance(by, { checkId: command.checkId });
    if (b.phase !== "ready") throw new DomainError("invalid_command", `the resume check is ${b.phase}; it can be committed when it is ready`, { field: "checkId" });
    // A check for an attempt that is no longer the task's active one (released, transferred, replaced) carries nothing on: no resume is recorded for an attempt that will never run. Looked at here to
    // refuse early; what makes it hold is the attempt's revision checked in the very write that commits (below), and again in the one that records the resume.
    if (!(await this.#forCurrentAttempt(b))) throw new DomainError("invalid_transition", ORPHANED);
    // Changes judged to matter are the owner's to accept: neither the dispatcher nor the agent being resumed commits over them (card L04c).
    const matter = relevantChanges(b);
    if (matter.length > 0 && by.kind !== "owner") throw new DomainError("forbidden", `${matter.length} change(s) were judged to matter to the work; only the owner commits the resume (resume.approve)`);
    const now = await this.#verify(by, b);
    if (now.stale !== undefined) {
      // The inputs moved after the review: nothing is committed.
      await this.#restart(by, command.checkId, now.stale);
      return this.advance(by, { checkId: command.checkId });
    }
    const at = this.#runner.now();
    // The check may have been started over and reviewed again since it was read (verdicts change only then, or on a retry): nothing is written unless it is still the check whose hold was judged above.
    // Committed only while the check's attempt is still the task's active one, in the same write: a release, transfer or new attempt while the inputs were looked at again refuses it (ORPHANED).
    await this.#update(command.checkId, (x) => {
      if (x.round !== b.round || x.blocks !== b.blocks || x.revisionSet?.digest !== b.revisionSet?.digest) throw new DomainError("invalid_transition", "the resume check was started over while it was being committed; it is looked at again before anything is committed");
      return { ...x, phase: "executing", restore: { method: command.restoredBy ?? "reconstruction", limits }, history: this.#push(x, "executing", by.id, `committing; restored by ${command.restoredBy ?? "reconstruction"}`) };
    }, ["ready"], this.#attemptGuard(b));
    void at;
    return this.advance(by, { checkId: command.checkId, commandId: String(command.commandId) });
  }

  /**
   * The owner's decision to let a task go on although changes were judged to matter (card L04c). It commits the task's current check when that is ready; a check already done answers as it is (a repeat is safe), anything else is refused
   * with where it stands, so the owner is never told a resume was approved when it was not.
   */
  async approve(by: Principal, command: NoActor & { taskId: string }): Promise<View<ResumeCheckBody>> {
    onlyKnown(command, ["commandId", "taskId"]);
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner approves a resume that holds changes judged to matter");
    const check = await this.forTask(by, command.taskId);
    if (check === undefined) throw new DomainError("not_found", "that task has no resume check");
    if (check.phase === "done") { await this.#settle?.(check.id, check.projectId).catch(() => undefined); return check; }
    if (check.phase !== "ready" && check.phase !== "executing") throw new DomainError("invalid_command", `the task's resume check is ${check.phase}; only a ready one can be approved`, { field: "taskId" });
    if (check.phase === "ready" && !(await this.#forCurrentAttempt(check))) throw new DomainError("invalid_transition", NOT_APPROVED_ORPHANED);
    let after: View<ResumeCheckBody>;
    try {
      // Committed already but not finished (a crash while recording it, or another approval still recording it): carried on, as a commit would, and answered by the same rules below (its attempt may
      // have ended since, and then nothing is recorded and the check ends cancelled).
      after = check.phase === "executing" ? await this.advance(by, { checkId: check.id }) : await this.commit(by, { commandId: `rck-approve-${check.id.slice(4)}`, checkId: check.id });
    } catch (error) {
      // The attempt ended while approving (released, transferred, replaced, or declined): nothing was committed or recorded.
      if (error instanceof DomainError && error.message === ORPHANED) throw new DomainError("invalid_transition", NOT_APPROVED_ORPHANED);
      throw error;
    }
    if (after.phase === "done") { await this.#settle?.(check.id, check.projectId).catch(() => undefined); return after; }
    // Still being recorded by someone else (another approval, the dispatcher or the start-up sweep): not done yet, so the owner is not told it is approved.
    if (after.phase === "executing") throw new DomainError("invalid_transition", "not approved yet: the task's resume is still being committed; try again in a moment");
    // Cancelled meanwhile (declined by the owner, or its attempt ended): nothing was recorded, and the owner is told what happened, not that the inputs moved.
    if (after.phase === "cancelled") {
      const note = after.history.at(-1)?.note;
      throw new DomainError("invalid_transition", note === DECLINED ? "not approved: the resume was declined meanwhile (the task is released), so nothing is resumed" : note === ENDED_CANCEL ? NOT_APPROVED_ORPHANED : "not approved: the task's resume check was cancelled meanwhile, so nothing is resumed");
    }
    if (!(await this.#forCurrentAttempt(after))) throw new DomainError("invalid_transition", NOT_APPROVED_ORPHANED);
    // The inputs moved while approving: the check started over, so what the owner approved is not what would run. Nothing was committed, and the owner is told so.
    throw new DomainError("invalid_transition", `not approved: the task's inputs changed while approving, so its resume check was started over and is ${after.phase}${after.phase === "ready" ? `; ${relevantChanges(after).length} change(s) judged to matter are held, approve again to let it go on` : ""}`);
  }

  /**
   * The owner's decision NOT to let a held task go on (card L04c): the task is released (its waiting attempt ends and nothing works on it until it is assigned again), then the task's check, held for
   * changes judged to matter, is cancelled, and the owner's notice that it is held is closed. Released FIRST: once the attempt has ended, neither the dispatcher nor an approval can commit the check or
   * start the attempt (both require the check's attempt to be the active one), so no gap exists in which the dispatcher could take a cancelled check as a reason to start a new one and go on. A decline
   * that stopped after the release (a crash) is finished by declining again; the same command ID answers as it did the first time (recorded per command, so a retried command never declines a newer check).
   * Refused with where it stands: a check that is not held, one whose attempt was transferred or given another attempt (nothing would be released), one not tied to an attempt (started through
   * `resume.start`: nothing says which attempt to release). Releasing needs the controller's `release` (absent: refused as unavailable).
   */
  async decline(by: Principal, command: NoActor & { taskId: string }): Promise<View<ResumeCheckBody>> {
    onlyKnown(command, ["commandId", "taskId"]);
    if (by.kind !== "owner") throw new DomainError("forbidden", "only the owner declines a resume that holds changes judged to matter");
    const taskId = checkTaskId(command.taskId);
    const scoped = scopedCommandId(by.id, command.commandId);
    const recordId = derivedId("rck", `decline\0${scoped}`);
    // The same command again answers as it did, even after the task was assigned again and has a newer check.
    const prior = await this.#runner.get(DECLINE_KIND, recordId);
    if (prior !== undefined) {
      const p = prior.body as unknown as { taskId: string; checkId: string };
      if (p.taskId !== taskId) throw new DomainError("command_conflict", "this command ID was already used to decline another task's resume");
      return view<ResumeCheckBody>(await this.#get(by, p.checkId));
    }
    const found = await this.forTask(by, taskId);
    if (found === undefined) throw new DomainError("not_found", "that task has no resume check");
    // A commit whose attempt ended before its resume was recorded (an approval racing a release) is carried on first: it ends cancelled, never recorded, and the decline then sees where it stands.
    const check = found.phase === "executing" && found.attemptId !== undefined && await this.#attemptState(found.attemptId) !== "active" ? await this.advance(by, { checkId: found.id }) : found;
    if (check.attemptId === undefined) throw new DomainError("invalid_command", "this resume check is not tied to an attempt, so declining it would release nothing; cancel it with resume.cancel or release the task", { field: "taskId" });
    if (this.#release === undefined) throw new DomainError("unavailable", "declining a held resume needs the task release, which this controller does not run");
    const declined = check.history.some((h) => h.note === DECLINED);
    const notHeld = (): never => {
      if (check.phase === "done") throw new DomainError("invalid_command", "the task's resume check was already approved and committed; there is nothing to decline", { field: "taskId" });
      // An approval that committed and stopped before recording its resume (a crash) while its attempt is still active: the owner's approval stands and is not undone here, nor is it finished here
      // (approving again, a tick or the start-up sweep finishes it). Nothing is released or recorded; to stop the task now, release it.
      if (check.phase === "executing") throw new DomainError("invalid_command", "the task's resume check was already approved and is being committed; there is nothing to decline (approve again to finish it, or release the task to stop it)", { field: "taskId" });
      throw new DomainError("invalid_command", `the task's resume check is ${check.phase}${check.phase === "ready" ? " and holds no change judged to matter" : ""}; only a resume held for changes judged to matter can be declined`, { field: "taskId" });
    };
    const moved = (): never => { throw new DomainError("invalid_transition", "not declined: the attempt this resume check was for is no longer the task's active attempt (the task was transferred or given another attempt), so there is nothing to release; the task is left as it is"); };
    const held = relevantChanges(check).length > 0;
    if (await this.#attemptState(check.attemptId) === "active") {
      if (!declined && (check.phase !== "ready" || !held)) notHeld();
      await this.#release(by, check.taskId, check.attemptId);
      // The release looks at the assignment itself: if the task moved meanwhile nothing was released, and the owner is told so.
      if (!(await this.#releasedFor(check))) moved();
    } else {
      // The attempt ended already. Only a release of that very attempt, with the task still released, means what a decline means: an earlier decline that stopped before the cancel (or the task
      // was released some other way) is finished. A transfer, a new attempt or a task assigned again is refused, and nothing is touched.
      if (!(await this.#releasedFor(check))) moved();
      if (!declined && ((check.phase !== "ready" && check.phase !== "cancelled") || !held)) notHeld();
    }
    // The check is cancelled after the release; if it moved meanwhile (the dispatcher dropped it when the attempt ended, or an approval committed it before the release), the release stands
    // and the attempt never runs: the decline is done either way.
    if (!TERMINAL.includes(check.phase) && check.phase !== "executing") await this.#update(check.id, (x) => ({ ...x, phase: "cancelled", blocked: undefined, history: this.#push(x, "cancelled", by.id, DECLINED) }), ["collecting", "verifying", "reviewing", "ready", "blocked"]);
    // An approval committed just before the release (its attempt was still active then) cannot record its resume now that the attempt has ended: carried on here, it ends cancelled.
    if ((await this.#runner.get(KIND, check.id))?.body["phase"] === "executing") await this.advance(by, { checkId: check.id });
    await this.#settle?.(check.id, check.projectId).catch(() => undefined);
    await this.#runner.command("resume.decline", { commandId: scoped, actor: by.id }, async () => ({
      payload: { taskId },
      build: async () => ({ ref: { kind: DECLINE_KIND, id: recordId }, creates: true, changes: [{ type: "create", ref: { kind: DECLINE_KIND, id: recordId }, body: clean({ taskId, checkId: check.id, attemptId: check.attemptId }) }], detail: { taskId, checkId: check.id } }),
    }));
    return view<ResumeCheckBody>((await this.#runner.get(KIND, check.id))!);
  }

  /** Starts a blocked check over from the beginning, once whoever blocked it has dealt with the reason. */
  async retry(by: Principal, command: { checkId: string }): Promise<View<ResumeCheckBody>> {
    const found = await this.#get(by, command.checkId);
    const b = found.body as unknown as ResumeCheckBody;
    if (b.phase !== "blocked") throw new DomainError("invalid_command", `the resume check is ${b.phase}; only a blocked one is retried`, { field: "checkId" });
    await this.#update(command.checkId, (x) => ({ ...x, phase: "collecting", round: 0, blocked: undefined, history: this.#push(x, "collecting", by.id, "retried after the blocker was dealt with") }), ["blocked"]);
    return this.advance(by, { checkId: command.checkId });
  }

  /**
   * `reason` "stale-by-dispatcher" marks a cancel the dispatcher made because another route took over; it is not a failure of the check (see `cancelledAsStale`). "attempt-ended" marks one the dispatcher made
   * because the attempt the check was for ended before it started.
   */
  async cancel(by: Principal, command: { checkId: string; reason?: typeof STALE_CANCEL | typeof ENDED_CANCEL }): Promise<View<ResumeCheckBody>> {
    const found = await this.#get(by, command.checkId);
    const b = found.body as unknown as ResumeCheckBody;
    if (b.phase === "executing" || b.phase === "done") throw new DomainError("invalid_command", `the resume check is ${b.phase}; it can no longer be cancelled`, { field: "checkId" });
    if (!TERMINAL.includes(b.phase)) await this.#update(command.checkId, (x) => ({ ...x, phase: "cancelled", blocked: undefined, history: this.#push(x, "cancelled", by.id, command.reason ?? "cancelled") }), ["collecting", "verifying", "reviewing", "ready", "blocked"]);
    return view<ResumeCheckBody>((await this.#runner.get(KIND, command.checkId))!);
  }

  // ---- progress ------------------------------------------------------------------------------------------------------------

  /** Takes the check as far as it can go now. Safe to repeat. A check at `ready` waits for `commit`; one at `blocked` waits for `retry`. */
  async advance(by: Principal, command: { checkId: string; commandId?: string }): Promise<View<ResumeCheckBody>> {
    const id = String(command.checkId);
    await this.#get(by, id);
    for (let step = 0; step < RESUME_LIMITS.advances; step++) {
      const found = await this.#get(by, id);
      const b = found.body as unknown as ResumeCheckBody;
      if (TERMINAL.includes(b.phase) || b.phase === "ready" || b.phase === "blocked") return view<ResumeCheckBody>(found);
      if (b.phase === "collecting") {
        const c = await this.#continuations.latest(by, b.taskId);
        if (c === undefined) { await this.#block(by, id, b, "missing_context", "no complete continuation exists for the task, so there is nothing to resume"); continue; }
        const missing = await this.#ports.missingContext(b.taskId, c);
        if (missing.length > 0) { await this.#block(by, id, b, "missing_context", `critical context is missing: ${missing.slice(0, 10).join(", ")}`); continue; }
        await this.#update(id, (x) => ({ ...x, phase: "verifying", continuationId: c.id, history: this.#push(x, "verifying", by.id, `continuation ${c.id} collected`) }), ["collecting"]);
        continue;
      }
      if (b.phase === "verifying") {
        const current = await this.#continuations.latest(by, b.taskId);
        const effects = current === undefined ? [] : await this.#ports.uncertainEffects(b.taskId, current);
        if (effects.length > 0) { await this.#block(by, id, b, "effects_uncertain", `earlier effects of unknown outcome must be settled first: ${effects.slice(0, 10).join(", ")}`); continue; }
        const now = await this.#verify(by, b, true);
        const changed = now.changed;
        const verdicts: Record<string, ResumeVerdict> = {};
        for (const item of changed) { const kept = b.verdicts[item.id]; if (kept !== undefined && kept.digest === digestOf(item)) verdicts[item.id] = kept; }
        const next = changed.every((i) => verdicts[i.id] !== undefined) ? "ready" : "reviewing";
        await this.#update(id, (x) => ({
          ...x, phase: next, continuationId: now.continuationId, revisionSet: { continuationId: now.continuationId, digest: now.digest, dependencies: now.total, unverified: now.unverified },
          delta: { changed, unchanged: now.total - changed.length }, verdicts,
          history: this.#push(x, next, by.id, `${changed.length} of ${now.total} dependencies changed${now.unverified ? " (no dependencies were recorded, so nothing could be verified)" : ""}`),
        }), ["verifying"]);
        continue;
      }
      if (b.phase === "reviewing") {
        const open = (b.delta?.changed ?? []).filter((i) => b.verdicts[i.id] === undefined);
        if (this.#reviewing.has(id)) return view<ResumeCheckBody>(found);
        let got: Awaited<ReturnType<ResumePorts["review"]>>;
        // Guarded until the verdict is written, not only while the reviewer is asked: between the answer and the write the check still reads "reviewing", and another advance of it
        // (the resume sweep beside the dispatcher's own check) would ask the reviewer a second time (CI repair round 7: seen on PostgreSQL on a slow runner, where that write is slow).
        this.#reviewing.add(id);
        try {
        try { got = await this.#ports.review({ taskId: b.taskId, changes: open }); } catch (error) {
          if (error instanceof ReviewNotRun) {
            // No reviewer could be asked: recorded as not run, never as reviewed, and every open change is the owner's to accept (the rule from before a reviewer existed).
            const reason = short(error.reason.trim() === "" ? "no reviewer could be asked" : error.reason);
            const held: Record<string, ResumeVerdict> = { ...b.verdicts };
            for (const item of open) held[item.id] = { relevant: true, rationale: short(`not reviewed: ${reason}; so the owner decides whether it matters`), digest: digestOf(item), notReviewed: reason };
            await this.#update(id, (x) => ({ ...x, phase: "ready", verdicts: held, review: { state: "not-run", reason, at: this.#runner.now() }, history: this.#push(x, "ready", by.id, `${open.length} change(s) not reviewed (${reason}); the owner decides`) }), ["reviewing"]);
            continue;
          }
          await this.#block(by, id, b, "review_failed", `the reviewer could not give a verdict: ${short(error instanceof Error ? error.message : String(error))}`);
          continue;
        }
        const verdicts: Record<string, ResumeVerdict> = { ...b.verdicts };
        for (const item of open) {
          const v = got[item.id];
          if (v === undefined || typeof v.relevant !== "boolean" || typeof v.rationale !== "string" || v.rationale.trim().length === 0) continue; // a change with no reasoned verdict stays open
          verdicts[item.id] = { relevant: v.relevant, rationale: short(v.rationale), digest: digestOf(item) };
        }
        const done = (b.delta?.changed ?? []).every((i) => verdicts[i.id] !== undefined);
        if (!done) { await this.#block(by, id, b, "review_failed", "the reviewer gave no reasoned verdict for every change"); continue; }
        await this.#update(id, (x) => ({ ...x, phase: "ready", verdicts, review: { state: "ran", at: this.#runner.now() }, history: this.#push(x, "ready", by.id, `${open.length} change(s) reviewed`) }), ["reviewing"]);
        continue;
        } finally { this.#reviewing.delete(id); }
      }
      if (b.phase === "executing") {
        // Repeatable: the continuation resume is recorded under this check's own command ID, so a restart records it once.
        // Recorded only while the check's attempt is still the task's active one, in the same write as the record: an attempt that ended after the commit (a release racing it) gets no resume, and the
        // check ends cancelled. A record already made answers as made (a crash after it), whatever happened to the attempt since.
        let r: Awaited<ReturnType<ContinuationService["resume"]>>;
        try {
          r = await this.#continuations.resume(RESUMER, { commandId: `${id}-resume`, taskId: b.taskId, ...(b.continuationId === undefined ? {} : { continuationId: b.continuationId }), model: b.model, ...(b.previousModel === undefined ? {} : { previousModel: b.previousModel }), after: b.after, ...(b.restore === undefined ? {} : { restoredBy: b.restore.method }) }, { guard: this.#attemptGuard(b) });
        } catch (error) {
          if (error instanceof DomainError && error.message === ORPHANED) { await this.#update(id, (x) => ({ ...x, phase: "cancelled", history: this.#push(x, "cancelled", by.id, ENDED_CANCEL) }), ["executing"]); continue; }
          if (error instanceof DomainError && error.code === "stale_revision") continue;
          throw error;
        }
        await this.#update(id, (x) => ({ ...x, phase: "done", history: this.#push(x, "done", by.id, `resumed from ${r.continuation.id}`) }), ["executing"]);
        continue;
      }
    }
    return view<ResumeCheckBody>(await this.#get(by, id));
  }

  /** Carries every unfinished check on after a restart: collecting, verifying, reviewing and executing ones are advanced (a ready or blocked one waits for a person or the committer). */
  async sweep(by: Principal): Promise<{ advanced: string[]; failed: string[] }> {
    if (by.kind !== "owner" && by.kind !== "service" && by.kind !== "host") throw new DomainError("forbidden", `${by.id} may not sweep resume checks`);
    const advanced: string[] = []; const failed: string[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const rec of page) {
        after = rec.id;
        const b = rec.body as unknown as ResumeCheckBody;
        if (TERMINAL.includes(b.phase) || b.phase === "ready" || b.phase === "blocked") continue;
        try { await this.advance(by, { checkId: rec.id }); advanced.push(rec.id); } catch { failed.push(rec.id); }
      }
      if (page.length < 100) break;
    }
    return { advanced, failed };
  }

  /** The task's current check (the one its active pointer names, in any phase), or nothing. */
  async forTask(by: Principal, taskId: string): Promise<View<ResumeCheckBody> | undefined> {
    const tid = checkTaskId(taskId);
    await this.#authorize(by, tid);
    const active = await this.#runner.get(ACTIVE, derivedId("rck", `active\0${tid}`));
    const current = (active?.body as unknown as { checkId?: string } | undefined)?.checkId;
    const found = current === undefined ? undefined : await this.#runner.get(KIND, current);
    return found === undefined ? undefined : view<ResumeCheckBody>(found);
  }

  /**
   * The checks that wait for the owner (card L04c), with the task's title: each task's current check when it is ready, holds changes judged to matter and (for a dispatcher's check) its attempt is still the task's active one. Owner only (anyone else: none). Read through the tasks' check pointers,
   * at most `limit` found and 2000 pointers looked at; `truncated` says there may be more.
   */
  async held(by: Principal, limit: number): Promise<{ items: { checkId: string; taskId: string; title: string; projectId: string; since: string; changes: DeltaItem[]; notReviewed?: string; notReviewedCount?: number }[]; truncated: boolean }> {
    if (by.kind !== "owner") return { items: [], truncated: false };
    const items: { checkId: string; taskId: string; title: string; projectId: string; since: string; changes: DeltaItem[]; notReviewed?: string; notReviewedCount?: number }[] = [];
    let seen = 0;
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(ACTIVE, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const pointer of page) {
        after = pointer.id;
        if (++seen > 2000 || items.length >= limit) return { items, truncated: true };
        const checkId = (pointer.body as unknown as { checkId?: string }).checkId;
        const found = checkId === undefined ? undefined : await this.#runner.get(KIND, checkId);
        const b = found?.body as unknown as ResumeCheckBody | undefined;
        if (found === undefined || b === undefined || b.phase !== "ready") continue;
        const changes = relevantChanges(b);
        // The owner is shown the task's title, never only its ID (an unreadable task reads as its ID).
        if (changes.length > 0 && await this.#forCurrentAttempt(b)) items.push({ checkId: found.id, taskId: b.taskId, title: ((await this.#runner.get("task", b.taskId))?.body as unknown as TaskBody | undefined)?.title ?? b.taskId, projectId: b.projectId, since: b.history.at(-1)?.at ?? b.requestedAt, changes, ...notReviewedOf(b, changes) });
      }
      if (page.length < 200) return { items, truncated: false };
    }
  }

  /** Whether a complete continuation exists for the task at all: a resume with none has nothing to verify (the dispatcher then starts from the checkpoint as before). */
  async hasContinuation(by: Principal, taskId: string): Promise<boolean> {
    await this.#authorize(by, checkTaskId(taskId));
    return (await this.#continuations.latest(by, checkTaskId(taskId))) !== undefined;
  }

  /** The ID the check started with this command ID by this principal has (or would have): lets a caller tell its own check from another one. */
  checkIdFor(by: Principal, commandId: string): string { return derivedId("rck", scopedCommandId(by.id, commandId)); }

  /** Whether the check was cancelled by the dispatcher because another route took over (not a failure). */
  cancelledAsStale(check: View<ResumeCheckBody>): boolean { return check.phase === "cancelled" && check.history.at(-1)?.note === STALE_CANCEL; }

  /**
   * Whether a blocked check can be started over now. With a blocker: only once it is resolved. With none (a failed review, uncertain effects): while it has blocked fewer times than `maxRounds`, and
   * not before a backoff of RETRY_BACKOFF_MS x its blocks has passed since it blocked.
   */
  async retryable(check: View<ResumeCheckBody>): Promise<boolean> {
    if (check.phase !== "blocked") return false;
    const id = check.blocked?.blockerId;
    if (id !== undefined) return (await this.#blockers.getBlocker(id))?.state === "resolved";
    if (check.blocks >= check.maxRounds) return false;
    const since = [...check.history].reverse().find((h) => h.phase === "blocked")?.at;
    const sinceMs = since === undefined ? NaN : Date.parse(since);
    return Number.isFinite(sinceMs) && Date.parse(this.#runner.now()) - sinceMs >= RETRY_BACKOFF_MS * check.blocks;
  }

  /** A blocked check with no blocker whose retries are used up: nothing will move it, so the owner must be told. */
  exhausted(check: View<ResumeCheckBody>): boolean { return check.phase === "blocked" && check.blocked?.blockerId === undefined && check.blocks >= check.maxRounds; }

  async get(by: Principal, checkId: string): Promise<View<ResumeCheckBody> | undefined> {
    try { return view<ResumeCheckBody>(await this.#get(by, checkId)); } catch (error) { if (error instanceof DomainError && error.code === "not_found") return undefined; throw error; }
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  async #authorize(by: Principal, taskId: string): Promise<string> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || !(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }))) throw new DomainError("forbidden", `${by.id} may not resume that task`);
    return task.projectId;
  }

  /**
   * Whether the check still stands for its attempt: one with no attempt always does; one with an attempt only while that attempt is active. Every way an attempt stops being the task's active one
   * (release, transfer, finish, a new generation) ends the attempt in the same write as the assignment, so the attempt's own state is enough.
   */
  async #forCurrentAttempt(b: Pick<ResumeCheckBody, "attemptId">): Promise<boolean> {
    if (b.attemptId === undefined) return true;
    return ((await this.#runner.get("attempt", b.attemptId))?.body as unknown as AttemptBody | undefined)?.state === "active";
  }

  async #attemptState(attemptId: string): Promise<AttemptBody["state"] | undefined> {
    return ((await this.#runner.get("attempt", attemptId))?.body as unknown as AttemptBody | undefined)?.state;
  }

  /** Whether the check's attempt ended by a release and the task is still released (not transferred, not assigned again): what a decline leaves behind. */
  async #releasedFor(b: Pick<ResumeCheckBody, "attemptId" | "taskId">): Promise<boolean> {
    if (b.attemptId === undefined || await this.#attemptState(b.attemptId) !== "released") return false;
    return ((await this.#runner.get("assignment", assignmentIdOf(b.taskId)))?.body as unknown as AssignmentBody | undefined)?.state === "released";
  }

  async #get(by: Principal, checkId: string) {
    const found = await this.#runner.get(KIND, String(checkId));
    if (found === undefined) throw new DomainError("not_found", "no such resume check");
    try { await this.#authorize(by, (found.body as unknown as ResumeCheckBody).taskId); } catch (error) { if (error instanceof DomainError && error.code === "forbidden") throw new DomainError("not_found", "no such resume check"); throw error; }
    return found;
  }

  /** The continuation and every dependency as they are now: what changed (with the checker's rights), and a digest of the whole set. `stale` says why a revision set that was verified before no longer holds. */
  async #verify(by: Principal, b: ResumeCheckBody, collecting = false): Promise<{ continuationId: string; changed: DeltaItem[]; total: number; digest: string; unverified: boolean; stale?: string }> {
    const c = await this.#continuations.latest(by, b.taskId);
    if (c === undefined) throw new DomainError("not_found", "the task's continuation is gone");
    let checks: DependencyCheck[] = [];
    let unverified = false;
    try { checks = await this.#dependencies.check(by, b.taskId, await this.#ports.observe(b.taskId)); } catch (error) { if (error instanceof DomainError && error.code === "not_found") unverified = true; else throw error; }
    const changed: DeltaItem[] = checks.filter((k) => k.status !== "unchanged").map((k) => ({ id: k.id, kind: k.kind, key: k.key, status: k.status, detail: short(k.detail) }));
    const digest = sha(JSON.stringify([c.id, checks.map((k) => [k.id, k.status, k.detail]).sort()]));
    const out = { continuationId: c.id, changed, total: checks.length, digest, unverified };
    if (collecting || b.revisionSet === undefined) return out;
    if (b.revisionSet.continuationId !== c.id) return { ...out, stale: `a newer continuation (${c.id}) was captured after the review` };
    if (b.revisionSet.digest !== digest) return { ...out, stale: "a dependency changed after the review" };
    return out;
  }

  /** The inputs moved after the review: start over, or stop as churn when the rounds are used up. */
  async #restart(by: Principal, id: string, why: string): Promise<void> {
    const b = (await this.#runner.get(KIND, id))!.body as unknown as ResumeCheckBody;
    if (b.round + 1 >= b.maxRounds) { await this.#block(by, id, b, "resume_churn", `the inputs kept changing (${why}); ${b.maxRounds} rounds did not settle`, ["ready"]); return; }
    await this.#update(id, (x) => ({ ...x, phase: "verifying", round: x.round + 1, history: this.#push(x, "verifying", by.id, `started over: ${why}`) }), ["ready"]);
  }

  async #block(by: Principal, id: string, b: ResumeCheckBody, type: NonNullable<ResumeCheckBody["blocked"]>["type"], reason: string, from: readonly ResumePhase[] = LIVE): Promise<void> {
    let blockerId: string | undefined;
    if (type === "missing_context" || type === "resume_churn") {
      const opened = await this.#blockers.openBlocker({ commandId: `${id}-blk-${type}-${b.blocks}`, actor: "system", type, subject: { kind: "task", id: b.taskId }, summary: short(reason), resolver: "owner" });
      blockerId = opened.id;
    }
    await this.#update(id, (x) => ({ ...x, phase: "blocked", blocks: x.blocks + 1, blocked: { type, reason: short(reason), ...(blockerId === undefined ? {} : { blockerId }) }, history: this.#push(x, "blocked", by.id, short(reason)) }), from);
  }

  /**
   * The changes that make a write hold only while the check's attempt is the task's active one: a revision check of the attempt, read now (none for a check with no attempt). Refuses with ORPHANED
   * when it is not active. Every way an attempt stops being the active one ends it in the same write as the assignment, so a write carrying this check cannot land after that.
   */
  #attemptGuard(b: Pick<ResumeCheckBody, "attemptId">): () => Promise<readonly Change[]> {
    return async () => {
      if (b.attemptId === undefined) return [];
      const att = await this.#runner.get("attempt", b.attemptId);
      if (att === undefined || (att.body as unknown as AttemptBody).state !== "active") throw new DomainError("invalid_transition", ORPHANED);
      return [{ type: "check", ref: { kind: "attempt", id: att.id }, expectedRevision: att.revision }];
    };
  }

  /** `guard`: extra changes written together with the update, read again for each try; it may refuse by throwing (see #attemptGuard). */
  async #update(id: string, change: (b: ResumeCheckBody) => ResumeCheckBody, from: readonly ResumePhase[], guard?: () => Promise<readonly Change[]>): Promise<boolean> {
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get(KIND, id);
      if (found === undefined) throw new DomainError("not_found", "no such resume check");
      if (!from.includes((found.body as unknown as ResumeCheckBody).phase)) return false;
      const next = change(found.body as unknown as ResumeCheckBody);
      const digest = sha(JSON.stringify(clean(next))).slice(0, 16);
      try {
        await this.#runner.command("resume.advance", { commandId: `rck-adv-${id.slice(4)}-${found.revision}-${digest}`, actor: "system" }, async () => ({
          payload: { phase: next.phase, revision: found.revision },
          build: async () => ({ ref: { kind: KIND, id }, creates: false, changes: [{ type: "update", ref: { kind: KIND, id }, expectedRevision: found.revision, body: clean(next) }, ...(guard === undefined ? [] : await guard())], detail: { phase: next.phase } }),
        }));
        return true;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 6) throw error;
      }
    }
  }

  #push(b: ResumeCheckBody, phase: ResumePhase, by: string, note: string): ResumeCheckBody["history"] {
    return [...b.history, { phase, at: this.#runner.now(), by, note: short(note) }].slice(-RESUME_LIMITS.history);
  }
}

const digestOf = (item: DeltaItem): string => sha(`${item.status}\0${item.detail}`);
/** Which of the held changes no reviewer judged (each verdict says so itself; a check started over keeps verdicts from earlier rounds), with the first one's reason. Empty when every one was judged. */
const notReviewedOf = (b: Pick<ResumeCheckBody, "verdicts">, changes: readonly DeltaItem[]): { notReviewed?: string; notReviewedCount?: number } => {
  const reasons = changes.map((c) => b.verdicts[c.id]?.notReviewed).filter((r): r is string => r !== undefined);
  return reasons.length === 0 ? {} : { notReviewed: reasons[0]!, notReviewedCount: reasons.length };
};
/** The changes of a check that were judged to matter to the work: while there are any, only the owner commits it. */
export const relevantChanges = (b: Pick<ResumeCheckBody, "delta" | "verdicts">): DeltaItem[] => (b.delta?.changed ?? []).filter((i) => b.verdicts[i.id]?.relevant === true);

