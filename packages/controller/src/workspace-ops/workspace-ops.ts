import { setTimeout as sleep } from "node:timers/promises";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { QuiesceCoordinator } from "../dispatch/quiesce.js";
import { QuiesceRefused } from "../dispatch/quiesce.js";
import { landingChecksText, type LandingCheckHost, type LandingChecksRecord } from "../landing/landing-gate.js";
import { allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, Change, JsonObject } from "../storage/types.js";

/**
 * Integration, checkout refresh and quarantine of an agent's work as controller operations (cards H12l and H12d), and the author's own refresh (`reapply`, card H12p: the agent asks for it itself through `work.refresh`, with no quiesce, and the record counts the refresh rounds of the task). The file work lives on the host that holds the checkout (the worker's workspace code), so the controller asks
 * the host through a `WorkspacePort`; this service is what makes that safe and answerable: the caller needs `workspace.manage` on the task's project (the owner always has it; a task credential never does), the request is
 * recorded before anything runs, and the host is asked only while every live attempt of the task is quiet (`QuiesceCoordinator.around`: new calls refused, calls in flight settled, a checkpoint taken). If an attempt cannot be made
 * quiet the operation does not run and the answer says which blocker. One operation runs per task at a time (a second is `unavailable` until the first ends). The attempts this operation may freeze are written into its record before it starts, and each freeze carries the request's ID, so a
 * controller that crashed can release exactly those (`recover`, or the next request for the task). A repeat of a command returns the recorded answer; a request that was recorded but whose outcome was never written is answered `uncertain` and is not run
 * again, because the host may have done it; if the original call then finishes it replaces `uncertain` with what really happened.
 */
export const WORKSPACE_OPERATIONS = ["integration", "landing", "refresh", "reapply", "release", "quarantine"] as const;
export type WorkspaceOperation = (typeof WORKSPACE_OPERATIONS)[number];
export type WorkspaceState = "started" | "done" | "refused" | "failed" | "uncertain";

export const WORKSPACE_LIMITS = { reason: 500, summary: 1000, detailBytes: 4000 } as const;

const RECORD = "workspace-request";
/** One record per task: the request that is open on it, if any (so a leftover is found without reading every request ever made). */
const OPEN = "workspace-open";
/** One record per task: how many refresh rounds the author has made (card H12p), counted in the same write that records the finished request. */
const ROUNDS = "workspace-rounds";
/** The approval a one-agent project records instead of a review (`REVIEW_DISABLED_SINGLE_AGENT` of the submission service): no reviewer judged the work, so it is never a permit. */
const NO_REVIEWER = "review_disabled_single_agent";
/** Whether a submission's recorded approval is a reviewer's (card H12o, permit slice): the only approval that makes its commit a review-gate permit commit. */
const reviewerApproved = (approvedBy: string): boolean => approvedBy !== NO_REVIEWER && approvedBy.length > 0;
/** One record per approved submission that was committed (card H12o). */
const SUBMISSION_COMMIT = "submission-commit";
const SUBMISSION_ID = /^sbm-[a-z2-7]{20}$/;
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const WORKSPACE_ID = /^wsr-[a-z2-7]{20}$/;
/** A freeze set for this request says so in its reason (the quiesce writes the tag); recovery lifts only that one. */
const frozenFor = (reason: string, requestId: string): boolean => /^(integration|landing|refresh|reapply|release|quarantine): the agent's work is being changed \(/.test(reason) && reason.endsWith(`(${requestId})`);

/** What the host is asked, with the attempts that were made quiet for it. */
export interface WorkspaceCall {
  readonly requestId: string;
  readonly operation: WorkspaceOperation;
  readonly taskId: string;
  readonly projectId: string;
  readonly reason: string;
  readonly quietAttempts: readonly string[];
  /** The agent the task is assigned to (the request is recorded against it, and what is carried into the shared workspace is attributed to it). Absent when nobody is assigned. */
  readonly assignee?: string;
  /**
   * A `release` of an approved submission whose approval is a reviewer's (card H12o, permit slice): the host makes the commit a review-gate permit commit. Never set for the single-agent approval (no reviewer judged it) nor
   * for any other operation.
   */
  readonly permit?: true;
  /**
   * The owner's landing policy as the controller read it for this landing (card H12a). Set only by the remote host's port, which reads it fresh from the same reader a local host uses and carries it in the request to a
   * host that cannot read the controller's settings. A local host reads the policy itself and ignores this.
   */
  readonly landing?: CarriedLanding;
  /**
   * A `release` of an approved submission (card H12o): the submission and the base and tree that were approved; the host commits exactly that, once. A `landing` of the oldest queued submission (card P10): the host lands
   * only when the shared head is that base and the checkout's committed work is exactly that tree (any diff beyond the submission is refused).
   */
  readonly submission?: { readonly id: string; readonly base: string; readonly tree: string };
  /** A `landing` only (card P09): the integrated tree the landing's required checks ran on. The host lands only when the checkout's head still has exactly this tree. Absent when the project requires no check. */
  readonly checkedTree?: string;
  /**
   * A `landing` of a submission the integrator re-applied mechanically (card P10, `WorkspacePort.restack`): the base and tree that were approved. `submission` then names the re-applied base and tree; the host proves again
   * that the checkout's committed change is exactly the approved change before it lands anything.
   */
  readonly reappliedFrom?: { readonly base: string; readonly tree: string };
}
/**
 * What a host answers to the integrator's mechanical re-apply of a queued submission (card P10): `current` (the checkout is on the landing branch's head already), `reapplied` (the checkout now holds exactly the approved
 * change on the head: its new base and tree), `overlap` (files the landing branch changed since the base are among the submission's: nothing was written), or a refusal.
 */
export type RestackOutcome =
  | { readonly ok: true; readonly state: "current" }
  | { readonly ok: true; readonly state: "reapplied"; readonly base: string; readonly tree: string; readonly previous?: string; readonly recovered?: boolean; readonly taken?: number }
  | { readonly ok: true; readonly state: "overlap"; readonly paths: readonly string[]; readonly head?: string }
  | { readonly ok: false; readonly reason: string };
/** The owner's landing figures that travel to a remote host: the owner-set values only (branch, whether the commit permit is required, extra protected paths, whether the built-in protected list applies). */
export interface CarriedLanding {
  readonly branch?: string;
  readonly requirePermit?: boolean;
  readonly protectedPaths?: readonly string[];
  readonly protectDefaults?: boolean;
}
export type WorkspaceOutcome = { readonly ok: true; readonly summary: string; readonly detail?: JsonObject } | { readonly ok: false; readonly reason: string };
/**
 * The host side of the operations. A host that cannot do one answers `ok: false` with why (a typed refusal, not a fault). `landingChecks` (card P09, optional): the change a landing would carry and the project's test commands run
 * on exactly its tree in the sandbox; a host without it cannot make a landing that requires checks pass.
 */
export interface WorkspacePort extends LandingCheckHost {
  run(call: WorkspaceCall): Promise<WorkspaceOutcome>;
  /** Card P10 (optional): re-applies the queue's oldest submission onto the landing branch's head when its files are disjoint from what landed since its base. A host without it lands only on the approved base. */
  restack?(call: { readonly requestId: string; readonly taskId: string; readonly projectId: string; readonly quietAttempts: readonly string[]; readonly submission: { readonly id: string; readonly base: string; readonly tree: string } }): Promise<RestackOutcome>;
}

export interface WorkspaceRecordBody {
  readonly operation: WorkspaceOperation;
  readonly taskId: string;
  readonly projectId: string;
  readonly requestedBy: string;
  readonly reason: string;
  readonly state: WorkspaceState;
  readonly at: string;
  readonly finishedAt?: string;
  readonly summary?: string;
  readonly detail?: JsonObject;
  /** The agent the task was assigned to when the request was made (the request is recorded against it); absent when nobody was. */
  readonly assignee?: string;
  /** The attempts that were quiet while the host worked. */
  readonly quietAttempts?: readonly string[];
  /** The attempts that were told their checkout changed (refresh, integration), and those that were stopped because their checkout was quarantined. */
  readonly told?: readonly string[];
  readonly stopped?: readonly string[];
  /** The attempts this operation froze and has not released yet (kept so a crash cannot leave them frozen). */
  readonly held?: readonly string[];
  /** The blocker opened when an attempt could not be made quiet. */
  readonly blocker?: string;
  /** For a `reapply` that moved the checkout onto a newer head (card H12p): the number of this refresh round for the task (the first is 1). Not set for any other request, nor for a refresh that found the checkout at the head already. */
  readonly round?: number;
  /** The integrator lease a landing, or an integration on a project with a landing branch (card P10, sixth slice), was made under, for the record. */
  readonly lease?: { readonly leaseId: string; readonly fence: number };
  /** A `release` of an approved submission (card H12o): which submission, the base and tree that were approved, and who approved it (a reviewer, or `review_disabled_single_agent`). */
  readonly submission?: { readonly id: string; readonly base: string; readonly tree: string; readonly approvedBy: string };
  /** A `landing` of the oldest submission of the landing branch's queue (card P10): which submission, its approved base and tree, and the branch whose queue it was taken from. The landing gate (card P09) judges this submission. */
  readonly queued?: { readonly submissionId: string; readonly base: string; readonly tree: string; readonly branch: string };
  /** A `landing` made with no landing queue composed that names the reviewed code submission it lands (card P09): the review check is judged against it. With a queue, the submission is `queued.submissionId` instead. */
  readonly landedSubmission?: string;
  /** A `landing` of a project that requires checks (card P09): what each required check came to on the integrated tree, bound to that tree's ID. Absent when the gate was not reached (a refusal before the host was asked). */
  readonly checks?: LandingChecksRecord;
  /** Card P09: the agent told (in its inbox) that its landing was refused by the checks, with the results. */
  readonly toldAuthor?: string;
  /** Card P09 follow-up: the owner was sent a needs-you notice because the required tests had no test commands a landing can use (`checks.testsNeedOwner`), which the author cannot fix itself. */
  readonly toldOwner?: boolean;
  /** Card P10: the queued submission was re-applied mechanically onto the landing branch's head (its files are disjoint from what landed since its base): the base and tree the landing carried instead of the approved ones. */
  readonly reapplied?: { readonly base: string; readonly tree: string };
  /** Card P10: the queued submission overlapped files that landed since its base, so it was returned to its author (taken out of the queue): the overlapping paths, and what the queue answered. */
  readonly returned?: { readonly paths: readonly string[]; readonly to?: string; readonly cycles?: number; readonly limit?: number; readonly escalated?: boolean };
}
/** The commit made for an approved submission (card H12o), one record per submission (record kind `submission-commit`, keyed by the submission's ID): written in the same write as the release that made or found it. */
export interface SubmissionCommitBody { readonly submissionId: string; readonly taskId: string; readonly commitId: string; readonly parent: string; readonly tree: string; readonly requestId: string; readonly at: string; readonly recovered: boolean; /** True only when the controller asked for the permit (a reviewer's approval) and the host made or found the commit as a review-gate permit commit; absent otherwise and on records made before this was kept. */ readonly permitted?: boolean }
export interface WorkspaceAnswer extends WorkspaceRecordBody { readonly id: string; readonly replayed: boolean }

export interface WorkspaceDeps {
  readonly quiesce: Pick<QuiesceCoordinator, "around">;
  /** The host's side for the task's checkout (the host that runs its live attempt, else the one its checkout is pinned to); `undefined` when no host that can do this holds it. */
  readonly portOf: (taskId: string) => Promise<WorkspacePort | undefined>;
  /** The live attempts of a task, what an attempt's freeze says (`undefined`: not frozen), and lifting it. For recovery. `tell` puts a text before a running agent (returns whether it reached a worker) and `stop` ends an attempt (card H12m). */
  readonly attempts?: { live(taskId: string): Promise<string[]>; frozenReason(attemptId: string): Promise<string | undefined>; release(attemptId: string): Promise<void>; tell?(attemptId: string, text: string): Promise<boolean>; stop?(attemptId: string, reason: string): Promise<void> };
  /**
   * Tells the owner (a needs-you notice, once per request): landed files wait uncommitted in the shared tree, or a landing was refused because the tree is not clean. Also (card P09 follow-up, once per task and contract
   * version): a landing was refused because the required tests had no test commands a landing can use (none set, or set only by the task's own authors). The text is at most 200 characters.
   */
  readonly notify?: (notice: { commandId: string; taskId: string; text: string }) => Promise<void>;
  /** An attempt as the dispatcher knows it (card H12p): its task, its agent, whether it is live and whether it was stopped. Needed for `reapply` (the author's own refresh); without it that operation is unavailable. */
  readonly attemptOf?: (attemptId: string) => Promise<{ readonly taskId: string; readonly agentId: string; readonly live: boolean; readonly stopped?: boolean } | undefined>;
  /** Whether the task is paused (card H12p review): the author's own refresh rewrites files, so it is refused while the task is paused, here as well as at the tool bridge (a client that calls the API directly is refused too). */
  readonly paused?: (taskId: string) => Promise<boolean>;
  /** The agent the task is assigned to, if anyone is. */
  readonly assignee?: (taskId: string) => Promise<string | undefined>;
  /**
   * The integrator lease check of a landing (card P10). When given, a `landing` is made only under the project's lease: `request` must name `leaseId` and `fence`, and this is asked when the request is made and again right
   * before the host is asked (a long quiesce may outlast the lease); it throws when the lease is not the caller's live hold on the landing branch. When absent (no lease service composed), landings are not gated here.
   */
  readonly landingLease?: (by: Principal, call: { taskId: string; projectId: string; leaseId: unknown; fence: unknown }) => Promise<{ readonly leaseId: string; readonly fence: number } | void>;
  /**
   * Card P10 (sixth slice): the gate of an `integration`, which writes the checkout's uncommitted work into the shared tree the landing branch's work lands in. Answers `undefined` when the project names no landing
   * branch (nothing is leased or queued there: the integration runs as before); otherwise the integration is made only under the landing branch's integrator lease (the caller's live hold; the owner may leave it out
   * and the live holder's is used) and only by the owner while that branch's landing queue is empty, and the branch and lease used are answered. Throws when refused (settings that cannot be read included). Asked when
   * the request is made and again right before the host is asked, with the lease the first showing used: the second answer must be the same branch and lease. When absent, integrations are not gated here.
   */
  readonly integrationGate?: (by: Principal, call: { taskId: string; projectId: string; leaseId: unknown; fence: unknown }) => Promise<{ readonly branch: string; readonly leaseId: string; readonly fence: number } | undefined>;
  /**
   * Whether a code submission is approved (card H12o, `SubmissionService.approvalOf`). Needed for a `release` that names `submissionId`; without it such a release is `unavailable`. Asked when the request is made and again
   * right before the host is asked (a review may say `changes` while the task is made quiet).
   */
  readonly approvalOf?: (submissionId: string) => Promise<{ readonly taskId: string; readonly base: string; readonly tree: string; readonly approved: boolean; readonly approvedBy?: string; readonly reason?: string; readonly submittedBy?: string } | undefined>;
  /**
   * The landing queue (card P10, `LandingQueueOps`). When given, a `landing` lands only the oldest approved submission of the landing branch's queue (`check` answers it, or `undefined` for the owner's landing of a task
   * with nothing queued while the queue is empty), asked when the request is made and again right before the host is asked; the host is told the submission's base and tree, and a landing the host confirms as exactly
   * that submission takes it out of the queue in the same write that records the landing (`landedChanges`). When absent, landings are not queued.
   */
  readonly landingQueue?: {
    check(by: Principal, call: { taskId: string; projectId: string; submissionId: unknown }): Promise<{ readonly submissionId: string; readonly base: string; readonly tree: string; readonly branch: string } | undefined>;
    landedChanges(projectId: string, branch: string, submissionId: string): Promise<Change[]>;
    /**
     * Card P10 (optional): the queued submission overlaps files that landed since its base, so it goes back to its author: out of the queue (its place remembered), counted as a repair cycle of the task under the Q04
     * cycle limit, the task's current assignee told, and the director and owner told at the limit or when nobody holds the task. Best effort; answers what it did.
     */
    returned?(call: { readonly requestId: string; readonly taskId: string; readonly projectId: string; readonly branch: string; readonly submissionId: string; readonly paths: readonly string[]; readonly assignee?: string }): Promise<{ readonly to?: string; readonly cycles: number; readonly limit: number; readonly escalated: boolean } | undefined>;
  };
  /**
   * The landing gate (card P09, `LandingGate.evaluate`): asked for every `landing`, inside the quiesce after the lease and the queue were shown again and right before the host is asked to land. A landing is made only when it
   * answers `passed`; its answer is kept on the request's record. The submission it judges is the queue's head (card P10) when a queue is composed, else the one the landing names. A throw (the required checks cannot be read)
   * refuses the landing. Absent: landings are not gated (unit rigs).
   */
  readonly landingGate?: (call: { readonly taskId: string; readonly projectId: string; readonly submissionId?: string; readonly author?: string; readonly host: WorkspacePort }) => Promise<LandingChecksRecord>;
  /**
   * Card P10: told after a refresh round of a task is counted (the author's own refresh moved its checkout onto a newer head), with the task's round count; the landing queue reserves the task's place at the
   * refresh-round cap and tells the director when a reserved task needs another round. Best effort: a throw is ignored. Not told on a repeat of the call.
   */
  readonly onRound?: (round: { readonly taskId: string; readonly projectId: string; readonly round: number }) => Promise<void>;
  /** Card P09: tells the author agent (a notice in its inbox, delivered when it next reads) that its landing was refused by the checks, with the results. A throw is recorded as not told. */
  readonly tellAuthor?: (notice: { readonly commandId: string; readonly taskId: string; readonly to: string; readonly text: string }) => Promise<void>;
}
/** The landing queue moved under a landing between its two showings (card P10): told apart from a lease that no longer holds. */
class QueueMoved extends DomainError {}

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const json = (value: object): JsonObject => value as unknown as JsonObject;
const clean = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
/** Text from a host or a fault, bounded and with anything credential-shaped removed. */
const safe = (value: unknown, max: number): string => redactText(typeof value === "string" ? value : String((value as Error)?.message ?? value)).slice(0, max);
/** A refresh's conflict list as the host sent it, with each path that looks like a credential withheld by itself (the whole detail would otherwise be dropped by `boundedDetail`, and the agent would lose the list of what to fix). */
const cleanReapplyDetail = (value: unknown): unknown => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const d = value as { conflicts?: unknown };
  if (!Array.isArray(d.conflicts)) return value;
  return { ...d, conflicts: d.conflicts.map((c) => (c !== null && typeof c === "object" && typeof (c as { path?: unknown }).path === "string" && redactText((c as { path: string }).path) !== (c as { path: string }).path ? { ...(c as object), path: "(a name that looks like a key; look in the checkout)" } : c)) };
};
/** A host's detail, kept only when it is plain JSON of a bounded size with nothing credential-shaped in it. */
const boundedDetail = (value: unknown): JsonObject | undefined => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  try {
    const encoded = JSON.stringify(value);
    return Buffer.byteLength(encoded, "utf8") <= WORKSPACE_LIMITS.detailBytes && redactText(encoded) === encoded ? JSON.parse(encoded) as JsonObject : undefined;
  } catch { return undefined; }
};

export class WorkspaceOpService {
  readonly #runner: CommandRunner;
  readonly #deps: WorkspaceDeps;
  /** Tasks with an operation running in this process, and the request behind each. One controller holds the epoch, so this is the lock. */
  readonly #busy = new Map<string, string>();
  private constructor(runner: CommandRunner, deps: WorkspaceDeps) { this.#runner = runner; this.#deps = deps; }
  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: WorkspaceDeps, options: RunnerOptions = {}): WorkspaceOpService {
    return new WorkspaceOpService(new CommandRunner(storage, epoch, options), deps);
  }

  /**
   * Asks for the operation on a task's checkout. Answers with the recorded outcome (`done`, `refused`, `failed` or `uncertain`); it throws for a caller who may not ask, a malformed request, or a task that already has an
   * operation running (`unavailable`: ask again when it ends).
   */
  async request(by: Principal, command: NoActor & { operation: WorkspaceOperation; taskId: string; reason: string; leaseId?: string; fence?: number; submissionId?: string }): Promise<WorkspaceAnswer> {
    onlyKnown(command, ["commandId", "operation", "taskId", "reason", "leaseId", "fence", "submissionId"]);
    const operation = (WORKSPACE_OPERATIONS as readonly string[]).includes(command.operation) ? command.operation : invalid("operation", `must be one of ${WORKSPACE_OPERATIONS.join(", ")}`);
    if (operation === "reapply") invalid("operation", "reapply is the author's own refresh: the agent asks for it itself with work.refresh, while it works (to move a clean checkout to the shared head, ask for refresh)");
    const taskId = checkTaskId(command.taskId);
    const reason = text(command.reason, "reason", { min: 1, max: WORKSPACE_LIMITS.reason, multiline: false });
    if (redactText(reason) !== reason) invalid("reason", "looks like a credential or key; those are not recorded");
    const projectId = await this.#authorize(by, taskId);
    return this.#request(by, command, operation, taskId, reason, projectId);
  }

  /**
   * The controller's own release of a submission that has just been approved (card H12o, automatic release): the platform commit (a review-gate permit commit when a reviewer approved it) is made
   * without anybody asking, so reviewed work is committed and can land. Best effort and never an error: it answers `undefined` when it did nothing (not approved, no submissions known, the task has a
   * live attempt, is paused, already committed, or anything threw); a refusal or failure of the host is the recorded answer. It is the same `release` request the owner may make (the same checks, the
   * quiesce, the exactly-once record), under the controller's own service identity and the command ID `rel-auto:<cause>`, where `cause` names the approval (so a later approval after a `changes` tries
   * again, and a repeat of the same approval does nothing more). A task with a live attempt is left alone: the release would freeze it.
   */
  async releaseApproved(submissionId: string, cause: string): Promise<WorkspaceAnswer | undefined> {
    try {
      if (this.#deps.approvalOf === undefined || typeof submissionId !== "string" || !SUBMISSION_ID.test(submissionId) || typeof cause !== "string" || !/^[A-Za-z0-9_.:-]{1,120}$/.test(cause)) return undefined;
      const a = await this.#deps.approvalOf(submissionId);
      if (a === undefined || !a.approved) return undefined;
      const taskId = checkTaskId(a.taskId);
      const projectId = ((await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined)?.projectId;
      if (projectId === undefined) return undefined;
      if ((await this.submissionCommit(submissionId)) !== undefined) return undefined;
      if (((await this.#deps.attempts?.live(taskId)) ?? []).length > 0) return undefined;
      if ((await this.#deps.paused?.(taskId)) === true) return undefined;
      const by = { id: "service:workspace-release", kind: "service", grants: [] } as unknown as Principal;
      const reason = `submission ${submissionId} was approved, so the platform commits it in the task's own checkout`;
      return await this.#request(by, { commandId: `rel-auto:${cause}`, operation: "release", taskId, reason, submissionId } as NoActor & { operation: WorkspaceOperation; taskId: string; reason: string; submissionId?: string }, "release", taskId, reason, projectId);
    } catch { return undefined; }
  }

  async #request(by: Principal, command: NoActor & { operation: WorkspaceOperation; taskId: string; reason: string; leaseId?: string; fence?: number; submissionId?: string }, operation: WorkspaceOperation, taskId: string, reason: string, projectId: string): Promise<WorkspaceAnswer> {
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("wsr", scoped);

    const replay = await this.#replayOf(by, id, scoped, taskId);
    if (replay !== undefined) return replay;
    // A landing is made only under the project's integrator lease (card P10): checked before anything is recorded or frozen, and again right before the host is asked.
    // The check may answer the lease it used (the owner may leave it out); the second showing checks that same hold, never a lease taken in between.
    let leased: { leaseId: unknown; fence: unknown } | undefined = operation === "landing" && this.#deps.landingLease !== undefined ? { leaseId: command.leaseId, fence: command.fence } : undefined;
    // An integration writes the same shared tree (card P10, sixth slice): on a project with a landing branch it is made under that branch's lease too, by the owner, while the branch's landing queue is empty.
    const integrationGate = operation === "integration" ? this.#deps.integrationGate : undefined;
    let integratedOn: string | undefined;
    if (leased !== undefined) { const shown = await this.#deps.landingLease!(by, { taskId, projectId, ...leased }); if (shown !== undefined) leased = { leaseId: shown.leaseId, fence: shown.fence }; }
    else if (integrationGate !== undefined) {
      const shown = await integrationGate(by, { taskId, projectId, leaseId: command.leaseId, fence: command.fence });
      if (shown !== undefined) { leased = { leaseId: shown.leaseId, fence: shown.fence }; integratedOn = shown.branch; }
      else if (command.leaseId !== undefined || command.fence !== undefined) invalid("leaseId", "the project names no landing branch, so no integrator lease covers this integration");
    }
    else if (command.leaseId !== undefined || command.fence !== undefined) invalid("leaseId", "only a landing (and, on a project with a landing branch, an integration) is made under an integrator lease");
    // A release may name an approved submission of the task (card H12o): checked before anything is recorded or frozen, and again right before the host is asked.
    let submission: WorkspaceRecordBody["submission"];
    const queue = operation === "landing" ? this.#deps.landingQueue : undefined;
    let landedSubmission: string | undefined;
    if (command.submissionId !== undefined) {
      if (operation === "release") submission = await this.#approved(command.submissionId, taskId);
      // A landing without a queue may name the reviewed code submission it lands (card P09): only that it is one of this task's is checked here; whether its review applies is the landing gate's judgement on the integrated tree.
      // With a queue the named submission must be the task's queued one (the queue's check below refuses any other), and the gate judges that one.
      else if (operation === "landing") { if (queue === undefined) landedSubmission = await this.#codeOfTask(command.submissionId, taskId); }
      else invalid("submissionId", "only a release commits a submission, and only a landing names the submission it lands");
    }
    // A landing lands only the oldest approved submission of the landing branch's queue (card P10), exactly its base and tree: checked after the lease, before anything is recorded or frozen, and again right before the host is asked.
    const queued: WorkspaceRecordBody["queued"] = queue === undefined ? undefined : await queue.check(by, { taskId, projectId, submissionId: command.submissionId });
    // One operation per task: two would race on the same checkout and one's release would lift the other's freeze.
    if (this.#busy.has(taskId)) throw new DomainError("unavailable", `task ${taskId} already has a workspace operation running; ask again when it ends`);
    this.#busy.set(taskId, id);
    try {
      // What an earlier controller left open on this task is resolved first, so its freeze cannot be taken for ours.
      await this.#resolveOpen(taskId);
      const intended = (await this.#deps.attempts?.live(taskId)) ?? [];
      let assignee: string | undefined;
      try { assignee = await this.#deps.assignee?.(taskId); } catch { assignee = undefined; }
      const make: WorkspaceRecordBody = { operation, taskId, projectId, requestedBy: by.id, reason, state: "started", at: this.#runner.now(), ...(assignee === undefined ? {} : { assignee }), ...(intended.length === 0 ? {} : { held: intended }), ...(leased === undefined ? {} : { lease: { leaseId: leased.leaseId as string, fence: leased.fence as number } }), ...(submission === undefined ? {} : { submission }), ...(queued === undefined ? {} : { queued: { submissionId: queued.submissionId, base: queued.base, tree: queued.tree, branch: queued.branch } }), ...(landedSubmission === undefined ? {} : { landedSubmission }) };
      await this.#recordStart(id, () => this.#write(by.id, scoped, "workspace.request", id, { creates: true, payload: { operation, taskId, reason, ...(leased === undefined ? {} : { leaseId: leased.leaseId as string, fence: leased.fence as number }), ...(submission === undefined ? {} : { submissionId: submission.id }), ...(queued === undefined ? {} : { submissionId: queued.submissionId }), ...(landedSubmission === undefined ? {} : { submissionId: landedSubmission }) }, body: () => make, also: () => this.#openChange(taskId, id) }));
      const started = (await this.#get(id))!;
      const pinned = leased;
      const approvedNow = submission;
      const queuedNow = queued;
      // The second showing: the same lease, the same approval, and the same place in the queue (the oldest, the same submission; or, for the owner's landing of nothing queued, a queue that is still empty).
      const again = pinned === undefined && approvedNow === undefined && queue === undefined && integrationGate === undefined ? undefined : async () => {
        // An integration (card P10, sixth slice): the same answer as at the first showing (no landing branch then and now, or the same branch under the same hold), and the queue still empty.
        if (integrationGate !== undefined) {
          const now = await integrationGate(by, { taskId, projectId, leaseId: pinned?.leaseId, fence: pinned?.fence });
          if (now?.branch !== integratedOn || now?.leaseId !== pinned?.leaseId || now?.fence !== pinned?.fence) throw new DomainError("fenced", "the landing branch or its integrator lease changed while the task was made quiet");
          return;
        }
        if (pinned !== undefined) await this.#deps.landingLease!(by, { taskId, projectId, ...pinned });
        if (approvedNow !== undefined) await this.#stillApproved(approvedNow, taskId);
        if (queue !== undefined) {
          let now: Awaited<ReturnType<typeof queue.check>>;
          try { now = await queue.check(by, { taskId, projectId, submissionId: queuedNow?.submissionId }); } catch (error) { throw new QueueMoved("invalid_transition", error instanceof Error ? error.message : String(error)); }
          if ((now === undefined) !== (queuedNow === undefined) || (now !== undefined && (now.submissionId !== queuedNow!.submissionId || now.base !== queuedNow!.base || now.tree !== queuedNow!.tree || now.branch !== queuedNow!.branch))) throw new QueueMoved("invalid_transition", "the landing queue changed while the task was made quiet");
        }
      };
      const outcome = await this.#run(id, started.body, again);
      return await this.#settle(by.id, scoped, id, outcome);
    } finally { this.#busy.delete(taskId); }
  }

  /**
   * A repeat finds the record: a finished one is returned as it was. One still running here is `uncertain` for the repeat (the first call goes on, keeps its freeze and writes the real outcome). One left by a stopped controller
   * is resolved: its freeze lifted, then it is `uncertain`.
   */
  async #replayOf(by: Principal, id: string, scoped: string, taskId: string): Promise<WorkspaceAnswer | undefined> {
    const existing = await this.#get(id);
    if (existing === undefined) return undefined;
    if (existing.body.state !== "started") return { ...existing.body, id, replayed: true };
    if (this.#busy.get(taskId) === id) {
      const marked = await this.#markUncertain(by.id, id, existing, "it is not known whether the host did this (the first call has not finished); check the checkout before asking again", `${scoped}:finish:uncertain`, false);
      return { ...marked, id, replayed: true };
    }
    await this.#resolveLeft(id, existing, `${scoped}:finish:uncertain`);
    return { ...(await this.#get(id))!.body, id, replayed: true };
  }

  /**
   * The author's own refresh (card H12p, the agent's `work.refresh`): the host re-applies the agent's work three-way onto the shared workspace's current head. Only the agent of a live attempt asks (a task credential only for its own
   * task); the owner's `request` refuses this operation. There is NO quiesce: the caller is the attempt itself, in the middle of its own tool call, so nothing is frozen and nothing is told afterwards (the answer is the telling). The attempt
   * must not be frozen (an ending or another workspace operation has it), and one operation runs per task at a time: a refresh while another operation is open is `unavailable`, never queued. The request is recorded before the host is asked, a
   * repeat of the call returns the recorded answer, and a call that was recorded but never finished is `uncertain` and not run again. The answer names what was kept, taken and merged and lists each conflict (never resolved here). A refresh that
   * moved the checkout to a newer head is one refresh ROUND of the task, counted in the same write that records the outcome and read by `refreshRounds` (the submission carries it); a refresh at the head already, a refusal, a failure and an
   * `uncertain` one are not counted.
   */
  async reapply(by: Principal, command: NoActor & { attemptId: string }): Promise<WorkspaceAnswer> {
    onlyKnown(command, ["commandId", "attemptId"]);
    if (by.kind !== "agent") throw new DomainError("forbidden", `${by.id} may not refresh an attempt's checkout: only the author's agent does`);
    const attemptId = text(command.attemptId, "attemptId", { min: 1, max: 200 });
    const lookup = this.#deps.attemptOf;
    if (lookup === undefined) throw new DomainError("unavailable", "the attempts are not known to this controller, so a refresh cannot be made now");
    const attempt = await lookup(attemptId);
    // The ID is the caller's text: it is shown back only with anything credential-shaped removed.
    const shown = redactText(attemptId).slice(0, 80);
    if (attempt === undefined || attempt.agentId !== by.id || (by.taskScope !== undefined && by.taskScope.taskId !== attempt.taskId)) throw new DomainError("not_found", `attempt ${shown} does not exist or is not yours`);
    if (!attempt.live || attempt.stopped === true) throw new DomainError("invalid_transition", `attempt ${shown} is no longer running`);
    const taskId = checkTaskId(attempt.taskId);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("wsr", scoped);
    const replay = await this.#replayOf(by, id, scoped, taskId);
    if (replay !== undefined) return replay;
    if ((await this.#deps.paused?.(taskId)) === true) throw new DomainError("unavailable", `task ${taskId} is paused; your checkout is not refreshed until it is resumed`);
    const why = await this.#deps.attempts?.frozenReason(attemptId);
    if (why !== undefined) throw new DomainError("unavailable", `your attempt is held right now (${redactText(why).slice(0, 120)}); a refresh is not made while it is`);
    if (this.#busy.has(taskId)) throw new DomainError("unavailable", `task ${taskId} already has a workspace operation running; ask again when it ends`);
    this.#busy.set(taskId, id);
    try {
      await this.#resolveOpen(taskId);
      if ((await this.openFor(taskId)) !== undefined) throw new DomainError("unavailable", `task ${taskId} has a workspace operation open; ask again when it ends`);
      let assignee: string | undefined;
      try { assignee = await this.#deps.assignee?.(taskId); } catch { assignee = undefined; }
      const make: WorkspaceRecordBody = { operation: "reapply", taskId, projectId: task.projectId, requestedBy: by.id, reason: `the author of attempt ${attemptId} refreshes its checkout onto the landing branch's head`, state: "started", at: this.#runner.now(), ...(assignee === undefined ? {} : { assignee }) };
      await this.#recordStart(id, () => this.#write(by.id, scoped, "workspace.request", id, { creates: true, payload: { operation: "reapply", taskId, attemptId }, body: () => make, also: () => this.#openChange(taskId, id) }));
      const started = (await this.#get(id))!;
      const outcome = await this.#run(id, started.body);
      const settledAnswer = await this.#settle(by.id, scoped, id, outcome);
      // A counted round may reserve the task's place in the landing queue, or tell the director (card P10). Best effort, after the round is recorded.
      if (settledAnswer.round !== undefined && !settledAnswer.replayed && this.#deps.onRound !== undefined) { try { await this.#deps.onRound({ taskId, projectId: task.projectId, round: settledAnswer.round }); } catch { /* best effort */ } }
      return settledAnswer;
    } finally { this.#busy.delete(taskId); }
  }

  /** The approved submission a release names (card H12o): a code submission of this very task whose newest review approves it. Anything else is refused before anything is recorded. */
  async #approved(value: unknown, taskId: string): Promise<NonNullable<WorkspaceRecordBody["submission"]>> {
    if (typeof value !== "string" || !SUBMISSION_ID.test(value)) return invalid("submissionId", "is not a submission ID");
    if (this.#deps.approvalOf === undefined) throw new DomainError("unavailable", "submissions are not known to this controller, so an approved submission cannot be committed now");
    const a = await this.#deps.approvalOf(value);
    if (a === undefined || a.taskId !== taskId) throw new DomainError("not_found", `submission ${value} is not a code submission of task ${taskId}`);
    if (!a.approved || a.approvedBy === undefined) throw new DomainError("review_invalid", `submission ${value} is not approved (${redactText(a.reason ?? "no approval").slice(0, 200)}); it is committed only once a reviewer approves it`, { field: "submissionId" });
    // The submission service refuses a review of one's own submission when it is recorded (card Q01b); an approval that still names the author is not an approval (card H12o, permit slice: it would open the review gate).
    if (a.submittedBy !== undefined && a.approvedBy === a.submittedBy) throw new DomainError("review_invalid", `submission ${value} is approved only by its own author; it is committed only once another reviewer approves it`, { field: "submissionId" });
    if (!OID.test(a.base) || !OID.test(a.tree)) throw new DomainError("invalid_command", `submission ${value} does not name a base commit and a tree`, { field: "submissionId" });
    return { id: value, base: a.base, tree: a.tree, approvedBy: a.approvedBy.slice(0, 200) };
  }

  /** The code submission a landing names (card P09): a code submission of this very task, approved or not (the gate judges its review). */
  async #codeOfTask(value: unknown, taskId: string): Promise<string> {
    if (typeof value !== "string" || !SUBMISSION_ID.test(value)) return invalid("submissionId", "is not a submission ID");
    if (this.#deps.approvalOf === undefined) throw new DomainError("unavailable", "submissions are not known to this controller, so a landing cannot name one now");
    const a = await this.#deps.approvalOf(value);
    if (a === undefined || a.taskId !== taskId) throw new DomainError("not_found", `submission ${value} is not a code submission of task ${taskId}`);
    return value;
  }

  /** Right before the host is asked: the submission is still approved, for the same base and tree. */
  async #stillApproved(s: NonNullable<WorkspaceRecordBody["submission"]>, taskId: string): Promise<void> {
    const now = await this.#approved(s.id, taskId);
    if (now.base !== s.base || now.tree !== s.tree) throw new DomainError("review_invalid", `submission ${s.id} changed`, { field: "submissionId" });
    // The permit is asked from the first showing's approval (card H12o, permit slice): it holds only while a reviewer's approval still approves it.
    if (reviewerApproved(s.approvedBy) && !reviewerApproved(now.approvedBy)) throw new DomainError("review_invalid", `submission ${s.id} is no longer approved by a reviewer`, { field: "submissionId" });
  }

  /** The commit made for an approved submission (card H12o), when one was recorded. It takes no caller, so it is not an API operation (the release's own record, `workspace.get`, names it to whoever may read that). */
  async submissionCommit(submissionId: string): Promise<SubmissionCommitBody | undefined> {
    if (typeof submissionId !== "string" || !SUBMISSION_ID.test(submissionId)) return undefined;
    return (await this.#runner.get(SUBMISSION_COMMIT, submissionId))?.body as unknown as SubmissionCommitBody | undefined;
  }

  /** How many refresh rounds the task's author has made so far (card H12p). It takes no caller, so it is not an API operation: the code that builds the services passes it to the submission. */
  async refreshRounds(taskId: string): Promise<number> {
    const n = ((await this.#runner.get(ROUNDS, checkTaskId(taskId)))?.body as unknown as { rounds?: unknown } | undefined)?.rounds;
    return typeof n === "number" && Number.isSafeInteger(n) && n >= 0 ? n : 0;
  }

  /** Whether an operation is running or left open on the task's checkout: the dispatcher does not start an attempt of such a task until it ends (card H12m). */
  async isBusy(taskId: string): Promise<boolean> {
    return this.#busy.has(taskId) || (await this.openFor(taskId)) !== undefined;
  }

  /**
   * The operation open on a task's checkout right now, if any, for code that builds the services (the hand-off package names it as a hold): who asked, what, since when. It takes no caller, so it is not an API
   * operation. A request that finished, or one left open by a stopped controller and not yet resolved, is told as the index has it (the latter reads as `started`; recovery settles it).
   */
  async openFor(taskId: string): Promise<{ readonly requestId: string; readonly operation: WorkspaceOperation; readonly requestedBy: string; readonly at: string } | undefined> {
    const open = ((await this.#runner.get(OPEN, checkTaskId(taskId)))?.body as unknown as { requestId?: string } | undefined)?.requestId;
    if (open === undefined) return undefined;
    const rec = await this.#get(open);
    if (rec === undefined || (rec.body.state !== "started" && rec.body.state !== "uncertain")) return undefined;
    return { requestId: open, operation: rec.body.operation, requestedBy: rec.body.requestedBy, at: rec.body.at };
  }

  /**
   * A request that ended but whose freeze could not be lifted (card L03j): the attempts it still holds frozen until the recovery loop lifts them. Only the request itself may lift them (each freeze names it), so a hand-off
   * names this hold and never lifts it. Like `openFor`, it takes no caller.
   */
  async heldFor(taskId: string): Promise<{ readonly requestId: string; readonly operation: WorkspaceOperation; readonly requestedBy: string; readonly held: readonly string[]; readonly finishedAt?: string } | undefined> {
    const open = ((await this.#runner.get(OPEN, checkTaskId(taskId)))?.body as unknown as { requestId?: string } | undefined)?.requestId;
    if (open === undefined) return undefined;
    const rec = await this.#get(open);
    if (rec === undefined || rec.body.state === "started" || rec.body.state === "uncertain" || (rec.body.held ?? []).length === 0) return undefined;
    return { requestId: open, operation: rec.body.operation, requestedBy: rec.body.requestedBy, held: rec.body.held!, ...(rec.body.finishedAt === undefined ? {} : { finishedAt: rec.body.finishedAt }) };
  }

  /** One recorded request. Readable by the caller who could have asked for it. */
  async get(by: Principal, requestId: string): Promise<WorkspaceAnswer | undefined> {
    if (typeof requestId !== "string" || !WORKSPACE_ID.test(requestId)) return undefined;
    const found = await this.#get(requestId);
    if (found === undefined) return undefined;
    try { await this.#authorize(by, found.body.taskId); } catch { return undefined; }
    return { ...found.body, id: requestId, replayed: false };
  }

  /**
   * After a restart: requests that were open when the controller stopped are `uncertain` (the host may have acted) and the attempts they froze are released. Only the open index is read, and a task with an operation running in
   * this process is left to that operation. For the controller's own loop; not an API operation. Returns the requests it resolved.
   */
  async recover(by: Principal): Promise<string[]> {
    if (!((by.kind === "owner" || by.kind === "service" || by.kind === "host") && by.taskScope === undefined)) throw new DomainError("forbidden", `${by.id} may not recover workspace requests`);
    const resolved: string[] = [];
    let failed: unknown;
    for (let after: string | undefined;;) {
      const page = await this.#runner.list(OPEN, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const a of page) {
        after = a.id;
        const open = (a.body as unknown as { requestId?: string }).requestId;
        if (open === undefined) continue;
        try { if (await this.#resolveOpen(a.id)) resolved.push(open); } catch (error) { failed ??= error; }
      }
      if (page.length < 100) { if (failed !== undefined) throw failed; return resolved; }
    }
  }

  /** Resolves the request left open on a task by a controller that stopped, if there is one. */
  async #resolveOpen(taskId: string): Promise<boolean> {
    const open = ((await this.#runner.get(OPEN, taskId))?.body as unknown as { requestId?: string } | undefined)?.requestId;
    if (open === undefined) return false;
    const rec = await this.#get(open);
    if (rec === undefined || this.#busy.get(taskId) === open) return false;
    if (rec.body.state === "started") { await this.#resolveLeft(open, rec, `${open}:recovered`); return true; }
    // A repeat marked it `uncertain` while its first call was running here and that process stopped: the freeze is still its, and the index still names it.
    await this.#release(await this.#toRelease(rec.body), open);
    const ref: AggregateRef = { kind: OPEN, id: taskId };
    await this.#runner.command("workspace.close", { commandId: `${open}:closed`, actor: "controller" }, async () => ({
      payload: { requestId: open },
      build: async () => ({ ref, creates: false, changes: await this.#openChange(taskId, null, open), detail: { taskId } , contention: async () => new DomainError("stale_revision", "the workspace request changed at the same moment") }),
    })).catch((error: unknown) => { if (!(error instanceof DomainError && error.code === "stale_revision")) throw error; });
    return true;
  }

  /** The request was left running by a controller that stopped: its freeze is lifted first (if that fails it stays open and is tried again), then it is recorded as `uncertain`. */
  async #resolveLeft(id: string, rec: { readonly body: WorkspaceRecordBody; readonly revision: number }, commandId: string): Promise<void> {
    await this.#release(await this.#toRelease(rec.body), id);
    await this.#markUncertain("controller", id, rec, "the controller stopped while the host worked; check the checkout before asking again", commandId);
  }

  async #markUncertain(actor: string, id: string, rec: { readonly body: WorkspaceRecordBody; readonly revision: number }, summary: string, commandId: string, clearOpen = true): Promise<WorkspaceRecordBody> {
    const body: WorkspaceRecordBody = { ...rec.body, state: "uncertain", finishedAt: this.#runner.now(), summary };
    // A lost race on the open index alone (the landing queue's take-out rewrites it unchanged, card P10) is built again; one on the request itself means another writer settled it, and that is what is answered.
    for (let attempt = 1; ; attempt++) {
      try {
        await this.#write(actor, commandId, "workspace.finish", id, { creates: false, payload: { state: "uncertain" }, body: () => body, expectedRevision: rec.revision, also: () => clearOpen ? this.#openChange(rec.body.taskId, null, id) : Promise.resolve([]) });
        return body;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
        const now = await this.#get(id);
        if (now === undefined || now.revision !== rec.revision || attempt >= 5) return now?.body ?? body;
      }
    }
  }

  /** Records a request as started. A lost race on the task's open index alone (the landing queue's take-out rewrites it unchanged, card P10) is built again, so that it is not answered `stale_revision` before anything was done. */
  async #recordStart(id: string, write: () => Promise<unknown>): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try { await write(); return; } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision") || attempt >= 5 || (await this.#get(id)) !== undefined) throw error;
      }
    }
  }

  /** The attempts a left request may have frozen: those it recorded, and any that started after (the tag keeps this from lifting anything that is not its own). */
  async #toRelease(body: WorkspaceRecordBody): Promise<string[]> {
    const live = (await this.#deps.attempts?.live(body.taskId)) ?? [];
    return [...new Set([...(body.held ?? []), ...live])];
  }

  async #release(attempts: readonly string[], requestId: string): Promise<void> {
    const control = this.#deps.attempts;
    if (control === undefined) return;
    for (const attemptId of attempts) {
      try {
        const why = await control.frozenReason(attemptId);
        if (why !== undefined && frozenFor(why, requestId)) await control.release(attemptId);
      } catch (error) { if (!(error instanceof DomainError && error.code === "not_found")) throw error; }
    }
  }

  async #run(id: string, body: WorkspaceRecordBody, stillLeased?: () => Promise<void>): Promise<WorkspaceRecordBody> {
    const status = { unreleased: [] as string[] };
    const done = (state: WorkspaceState, more: Partial<WorkspaceRecordBody>): WorkspaceRecordBody => {
      const { held: _held, ...rest } = body; void _held;
      // A freeze that could not be lifted stays in the record (and the open index), so recovery lifts it later and it is never left unseen.
      return clean({ ...rest, state, finishedAt: this.#runner.now(), ...(status.unreleased.length === 0 ? {} : { held: [...new Set(status.unreleased)] }), ...more });
    };
    // An approved submission already committed (card H12o) is answered from its record: the host is not asked and nothing is made quiet, so asking again never makes a second commit.
    if (body.operation === "release" && body.submission !== undefined) {
      const made = await this.submissionCommit(body.submission.id);
      if (made !== undefined) return done("done", { summary: `submission ${body.submission.id} was already committed as ${made.commitId.slice(0, 12)} (request ${made.requestId})${made.permitted === true ? " as a review-gate permit commit" : ""}; nothing was done`, detail: json({ committed: true, alreadyRecorded: true, commit: made.commitId, parent: made.parent, tree: made.tree, submission: made.submissionId, permitted: made.permitted === true, changed: false }) });
    }
    let port: WorkspacePort | undefined;
    try { port = await this.#deps.portOf(body.taskId); } catch (error) { return done("failed", { summary: `no host could be found: ${safe(error, WORKSPACE_LIMITS.summary)}` }); }
    if (port === undefined) return done("refused", { summary: "no host that can do this holds the checkout of that task, so nothing was done" });
    // The author's own refresh (card H12p) is asked for by the attempt itself, in the middle of its own call: nothing is made quiet or frozen, and nothing is told afterwards (the answer is the telling).
    if (body.operation === "reapply") {
      try {
        const answer = await port.run({ requestId: id, operation: "reapply", taskId: body.taskId, projectId: body.projectId, reason: body.reason, quietAttempts: [], ...(body.assignee === undefined ? {} : { assignee: body.assignee }) });
        if (answer !== null && typeof answer === "object" && answer.ok === true) {
          const detail = boundedDetail(cleanReapplyDetail(answer.detail));
          return done("done", { summary: safe(answer.summary, WORKSPACE_LIMITS.summary), ...(detail === undefined ? {} : { detail }) });
        }
        return done("refused", { summary: `the host did not do it: ${safe((answer as { reason?: unknown } | undefined)?.reason ?? "no reason given", WORKSPACE_LIMITS.summary)}` });
      } catch (error) {
        // The host was asked and failed, or the answer was lost: it may have changed the checkout, so this is not a clean failure.
        return done("failed", { summary: safe(error, WORKSPACE_LIMITS.summary) });
      }
    }
    let quietAttempts: readonly string[] = [];
    const stopped: string[] = [];
    const told: string[] = [];
    let changed = false;
    let notLanded: string | undefined;
    // The landing gate's answer (card P09), kept on the record whatever the outcome.
    let gated: LandingChecksRecord | undefined;
    let gateRefused = false;
    // Card P10: what the mechanical re-apply came to (the base and tree the landing carries instead of the approved ones), or the paths that overlapped.
    let reapplied: { base: string; tree: string } | undefined;
    let overlap: string[] | undefined;
    try {
      const outcome = await this.#deps.quiesce.around({ taskId: body.taskId }, body.operation, async (quiet) => {
        quietAttempts = quiet.attempts.map((a) => a.attemptId);
        // The quiesce may have taken a while: the lease is shown once more right before the host writes anything, and a lease that is no longer the caller's live hold means nothing is asked of the host.
        if (stillLeased !== undefined) {
          try { await stillLeased(); } catch (error) { return { ok: false as const, reason: body.operation === "release" ? `the submission is no longer approved, so nothing was committed: ${safe(error, 300)}` : body.operation === "integration" ? `the landing branch's integrator lease or landing queue no longer allows this integration, so nothing was written to the shared workspace: ${safe(error, 300)}` : error instanceof QueueMoved ? `the submission is no longer the oldest approved one in the landing queue, so nothing was landed: ${safe(error, 300)}` : `the integrator lease no longer holds, so nothing was landed: ${safe(error, 300)}` }; }
        }
        // The integrator's mechanical re-apply (card P10): a queued submission approved on an older commit of the landing branch is moved onto its head when none of its files changed there since (exactly the approved
        // change, proven by the host), so the checks below run on the tree that would land. Overlapping files: nothing is written, nothing lands, and the work goes back to its author (below, after the quiesce).
        if (body.operation === "landing" && body.queued !== undefined && port!.restack !== undefined) {
          const r = await port!.restack({ requestId: id, taskId: body.taskId, projectId: body.projectId, quietAttempts, submission: { id: body.queued.submissionId, base: body.queued.base, tree: body.queued.tree } });
          if (r === null || typeof r !== "object" || r.ok !== true) return { ok: false as const, reason: `the submission could not be re-applied onto the landing branch's head, so nothing was landed: ${safe((r as { reason?: unknown } | undefined)?.reason ?? "no reason given", 300)}` };
          if (r.state === "overlap") {
            overlap = (Array.isArray(r.paths) ? r.paths : []).filter((p): p is string => typeof p === "string").slice(0, 20).map((p) => p.slice(0, 200));
            return { ok: false as const, reason: `submission ${body.queued.submissionId} changes file(s) that also changed on the landing branch since it was approved (${overlap.slice(0, 5).map((p) => JSON.stringify(p.slice(0, 80))).join(", ")}${overlap.length > 5 ? ", ..." : ""}), so nothing was landed and the work goes back to its author to refresh and submit again` };
          }
          if (r.state === "reapplied") {
            if (!OID.test(String(r.base)) || !OID.test(String(r.tree))) return { ok: false as const, reason: "the host's answer to the re-apply is not of the controller's form, so nothing was landed" };
            reapplied = { base: r.base, tree: r.tree };
          }
        }
        // The required checks (card P09), judged on the exact tree the landing would make, after the lease and the queue were shown again and before anything is written. Not all passed (not run counts as failed): nothing is
        // landed, and a queued submission stays in the queue. The submission judged is the queue's head when there is a queue (the same one the host is told), else the one the landing named.
        const judged = body.queued?.submissionId ?? body.landedSubmission;
        if (body.operation === "landing" && this.#deps.landingGate !== undefined) {
          try { gated = await this.#deps.landingGate({ taskId: body.taskId, projectId: body.projectId, ...(judged === undefined ? {} : { submissionId: judged }), ...(body.assignee === undefined ? {} : { author: body.assignee }), host: port! }); } catch (error) { return { ok: false as const, reason: `the project's required checks could not be read, so nothing was landed: ${safe(error, 300)}` }; }
          if (!gated.passed) {
            gateRefused = true;
            const failed = gated.results.filter((r) => r.result !== "pass").map((r) => `${r.check} ${r.result === "fail" ? "failed" : "not run"}`);
            return { ok: false as const, reason: `the required checks did not all pass on the integrated tree${gated.tree === undefined ? "" : ` ${gated.tree.slice(0, 12)}`} (${failed.join(", ")}; a check that did not run counts as failed), so nothing was landed${body.queued === undefined ? "" : ` and submission ${body.queued.submissionId} stays in the landing queue`}; the author was sent the results${gated.testsNeedOwner === undefined ? "" : gated.testsNeedOwner === "authors-only" ? "; the task's test commands were set only by its own authors, so the owner is asked to set or accept them" : "; the task has no test commands, so the owner is asked to set them"}` };
          }
          // The checks may have run for a while: the lease, the approval and the queue are shown once more, so a lease that ran out or a queue that moved during the checks still lands nothing.
          if (gated.required.length > 0 && stillLeased !== undefined) {
            try { await stillLeased(); } catch (error) { return { ok: false as const, reason: error instanceof QueueMoved ? `the submission is no longer the oldest approved one in the landing queue, so nothing was landed: ${safe(error, 300)}` : `the integrator lease no longer holds, so nothing was landed: ${safe(error, 300)}` }; }
          }
        }
        // The host is told both what the queue says lands (card P10: base == head, exactly that tree) and the tree the checks ran on (card P09); it lands only when both hold.
        const answer = await port!.run({ requestId: id, operation: body.operation, taskId: body.taskId, projectId: body.projectId, reason: body.reason, quietAttempts, ...(body.assignee === undefined ? {} : { assignee: body.assignee }), ...(body.submission === undefined ? {} : { submission: { id: body.submission.id, base: body.submission.base, tree: body.submission.tree } }), ...(body.operation === "release" && body.submission !== undefined && reviewerApproved(body.submission.approvedBy) ? { permit: true as const } : {}), ...(body.queued === undefined ? {} : reapplied === undefined ? { submission: { id: body.queued.submissionId, base: body.queued.base, tree: body.queued.tree } } : { submission: { id: body.queued.submissionId, base: reapplied.base, tree: reapplied.tree }, reappliedFrom: { base: body.queued.base, tree: body.queued.tree } }), ...(gated?.tree === undefined || gated.required.length === 0 ? {} : { checkedTree: gated.tree }) });
        if (answer !== null && typeof answer === "object" && answer.ok === true) {
          const found = (answer.detail ?? {}) as { changed?: unknown; landed?: unknown; written?: unknown; kept?: unknown; keptFiles?: unknown; partial?: unknown };
          changed = found.changed !== false;
          // A landing that did not land is not told as landed: the agent hears exactly what was written and what was kept (done can mean not landed).
          if (body.operation === "landing" && found.landed !== true) {
            const names = Array.isArray(found.keptFiles) ? found.keptFiles.flatMap((k) => (k !== null && typeof k === "object" && typeof (k as { path?: unknown }).path === "string" ? [(k as { path: string }).path] : [])).slice(0, 5) : [];
            const written = typeof found.written === "number" ? found.written : 0, kept = typeof found.kept === "number" ? found.kept : 0;
            if (written > 0 || kept > 0) notLanded = `was NOT landed: ${written} file(s) were written to the shared workspace and ${kept} were kept for the owner's review${names.length === 0 ? "" : ` (${names.join(", ")})`}${found.partial === true ? "; the shared workspace changed during the landing or could not be fully restored after a failure, so the owner checks it" : "; a landing is all or nothing, so the rest needs the owner's decision or a new landing"}`;
            changed = false;
          }
          // A quarantined checkout is gone from under the agent: while it is still quiet its attempt is stopped (it would only fail on a missing folder), and the task is left as it is.
          if (body.operation === "quarantine" && this.#deps.attempts?.stop !== undefined) {
            for (const attemptId of quietAttempts) {
              try { await this.#deps.attempts.stop(attemptId, `its checkout was quarantined (${id}); the work is kept for the owner`); stopped.push(attemptId); } catch { /* it ended meanwhile, or stays frozen and fails on the missing checkout; the record says which were stopped */ }
            }
          }
        }
        return answer;
      }, async (attemptId) => {
        if (gateRefused && gated !== undefined && this.#deps.attempts?.tell !== undefined) { if (await this.#deps.attempts.tell(attemptId, `[workspace] ${landingChecksText(body.taskId, id, gated, 1500)}`)) told.push(attemptId); return; }
        if (notLanded !== undefined && this.#deps.attempts?.tell !== undefined) { if (await this.#deps.attempts.tell(attemptId, `[workspace] Your checkout ${notLanded} (request ${id}).`)) told.push(attemptId); return; }
        if (!changed || body.operation === "quarantine" || this.#deps.attempts?.tell === undefined) return;
        const what = body.operation === "refresh" ? "was refreshed to the shared workspace's current head: files in it may differ from what you read earlier, so read them again before you rely on them" : body.operation === "landing" ? "was landed on the landing branch (the landed files wait, uncommitted, to be committed by the integrator or owner)" : body.operation === "release" ? "was committed by the platform in the task's own history (your files did not change)" : "was integrated into the shared workspace";
        if (await this.#deps.attempts.tell(attemptId, `[workspace] Your checkout ${what} (request ${id}).`)) told.push(attemptId);
      }, id, status);
      // A landing leaves its files uncommitted in the shared tree, and refuses while an earlier one's files wait there: somebody has to commit or clear them, so the owner is told (the integrator is whoever holds that role; the notice goes to the owner's inbox).
      if (body.operation === "landing" && this.#deps.notify !== undefined) {
        const waiting = outcome !== null && typeof outcome === "object" && outcome.ok === true && (outcome.detail as { waitingToCommit?: unknown } | undefined)?.waitingToCommit === true;
        const dirty = outcome !== null && typeof outcome === "object" && outcome.ok === false && /uncommitted file\(s\)/.test(String((outcome as { reason?: unknown }).reason ?? ""));
        const mixed = outcome !== null && typeof outcome === "object" && outcome.ok === true && Array.isArray((outcome.detail as { notRestored?: unknown } | undefined)?.notRestored) && ((outcome.detail as { notRestored: unknown[] }).notRestored.length > 0);
        if (waiting || dirty || mixed) {
          const text = mixed ? `Task ${body.taskId}: a landing failed part-way and some files in the shared workspace could not be put back (${String(((outcome as unknown as { detail: { notRestored: unknown[] } }).detail.notRestored).slice(0, 5))}). The shared workspace needs your attention before another landing.` : waiting ? `Task ${body.taskId}: its work was landed in the shared workspace and waits there, uncommitted. Commit or clear those files so the next landing can go ahead.` : `Task ${body.taskId}: a landing was refused because the shared workspace holds uncommitted files (an earlier landing's, or other work). Commit or clear them, then ask again.`;
          try { await this.#deps.notify({ commandId: `wsn-${id}`, taskId: body.taskId, text: text.slice(0, 400) }); } catch { /* the outcome is recorded either way; the notice is retried by a repeat of the request only */ }
        }
      }
      // A landing the checks refused goes back to its author (card P09): the agent that submitted the reviewed code, else the agent the task is assigned to, gets the results in its inbox.
      let toldAuthor: string | undefined;
      if (gateRefused && gated !== undefined && this.#deps.tellAuthor !== undefined) {
        let author: string | undefined;
        const judged = body.queued?.submissionId ?? body.landedSubmission;
        if (judged !== undefined) { try { author = (await this.#deps.approvalOf?.(judged))?.submittedBy; } catch { author = undefined; } }
        author ??= body.assignee;
        if (author !== undefined) { try { await this.#deps.tellAuthor({ commandId: `lgc-${id}`, taskId: body.taskId, to: author, text: landingChecksText(body.taskId, id, gated) }); toldAuthor = author; } catch { /* recorded as not told */ } }
      }
      // Required tests with no test commands a landing can use cannot be fixed by the author (its own contract changes do not count): the owner gets a needs-you notice, once per task and contract version (a repeat of the
      // landing, or the next one, while nothing changed is not told again).
      let toldOwner = false;
      if (gateRefused && gated?.testsNeedOwner !== undefined && this.#deps.notify !== undefined) {
        const text = gated.testsNeedOwner === "authors-only" ? `Task ${body.taskId} cannot land: its test commands were set only by its own agents, which a landing does not run. Set or accept them (contract.set checks).` : `Task ${body.taskId} cannot land: its project requires tests but the task has no test commands. Set them (contract.set checks) or change the required checks.`;
        try { await this.#deps.notify({ commandId: `lgo-${body.taskId}-v${gated.contractVersion ?? 0}-${gated.testsNeedOwner}`, taskId: body.taskId, text: text.slice(0, 200) }); toldOwner = true; } catch { /* recorded as not told */ }
      }
      // Overlapping work goes back to its author (card P10): out of the queue, counted as a repair cycle, the task's holder told (best effort; the record says what was done).
      let returned: WorkspaceRecordBody["returned"];
      if (overlap !== undefined && body.queued !== undefined) {
        let r: Awaited<ReturnType<NonNullable<NonNullable<WorkspaceDeps["landingQueue"]>["returned"]>>>;
        try { r = await this.#deps.landingQueue?.returned?.({ requestId: id, taskId: body.taskId, projectId: body.projectId, branch: body.queued.branch, submissionId: body.queued.submissionId, paths: overlap, ...(body.assignee === undefined ? {} : { assignee: body.assignee }) }); } catch { r = undefined; }
        returned = { paths: overlap, ...(r === undefined ? {} : { ...(r.to === undefined ? {} : { to: r.to }), cycles: r.cycles, limit: r.limit, escalated: r.escalated }) };
      }
      const more: Partial<WorkspaceRecordBody> = { quietAttempts, ...(reapplied === undefined ? {} : { reapplied }), ...(returned === undefined ? {} : { returned }), ...(told.length === 0 ? {} : { told }), ...(stopped.length === 0 ? {} : { stopped }), ...(gated === undefined ? {} : { checks: gated }), ...(toldAuthor === undefined ? {} : { toldAuthor }), ...(toldOwner ? { toldOwner } : {}) };
      if (outcome !== null && typeof outcome === "object" && outcome.ok === true) {
        const detail = boundedDetail(outcome.detail);
        // A queued submission leaves the queue only when the host confirms it landed exactly that submission (card P10); a landing it does not confirm is said so, and the entry stays.
        // Also a landing that wrote files but could not mark the checkout, or found nothing to land: the entry stays at the head until it is taken out (a repeat is refused by the host while the landed files wait uncommitted,
        // and after they are committed the branch is no longer at the submission's base).
        const unconfirmed = body.operation === "landing" && body.queued !== undefined && !this.#landedExactly(body.queued, detail, reapplied);
        const summary = `${safe(outcome.summary, unconfirmed ? WORKSPACE_LIMITS.summary - 220 : WORKSPACE_LIMITS.summary)}${unconfirmed ? `; the host did not confirm that exactly submission ${body.queued!.submissionId} landed, so it stays in the landing queue (landing.queue.remove takes it out)` : ""}`;
        return done("done", { summary, ...(detail === undefined ? {} : { detail }), ...more });
      }
      return done("refused", { summary: `${gateRefused || returned !== undefined ? "" : "the host did not do it: "}${safe((outcome as { reason?: unknown } | undefined)?.reason ?? "no reason given", WORKSPACE_LIMITS.summary)}`, quietAttempts, ...(reapplied === undefined ? {} : { reapplied }), ...(returned === undefined ? {} : { returned }), ...(gated === undefined ? {} : { checks: gated }), ...(toldAuthor === undefined ? {} : { toldAuthor }), ...(toldOwner ? { toldOwner } : {}), ...(told.length === 0 ? {} : { told }) });
    } catch (error) {
      if (error instanceof QuiesceRefused) return done("refused", { summary: safe(error.message, WORKSPACE_LIMITS.summary), ...(error.blockerId === undefined ? {} : { blocker: error.blockerId }) });
      // The host was asked and failed, or the answer was lost: it may have changed the checkout, so this is not a clean failure.
      return done("failed", { summary: safe(error, WORKSPACE_LIMITS.summary), ...(quietAttempts.length === 0 ? {} : { quietAttempts }), ...(stopped.length === 0 ? {} : { stopped }), ...(gated === undefined ? {} : { checks: gated }) });
    }
  }

  /** Writes the outcome. A repeat that arrived while the host worked marked the record `uncertain`; the real outcome replaces that. */
  async #settle(actor: string, scoped: string, id: string, outcome: WorkspaceRecordBody): Promise<WorkspaceAnswer> {
    // The outcome is written with other records (the refresh-round count, a submission's commit, and for a landing the landing queue, which approvals and other writers change at any moment, card P10), so a lost race
    // is built again from what is stored now, after a short jittered wait, rather than leaving a confirmed landing unrecorded.
    for (let attempt = 0; attempt < 20; attempt++) {
      if (attempt > 0) await sleep(Math.round(Math.random() * Math.min(50, 5 * attempt)));
      const current = (await this.#get(id))!;
      // A refresh that moved the checkout onto a newer head is one round of the task; the count and the record are written together, so one is never without the other.
      const counts = outcome.operation === "reapply" && outcome.state === "done" && (outcome.detail as { changed?: unknown } | undefined)?.changed === true;
      const counter = counts ? await this.#runner.get(ROUNDS, outcome.taskId) : undefined;
      const round = counts ? ((counter?.body as unknown as { rounds?: number } | undefined)?.rounds ?? 0) + 1 : undefined;
      const final: WorkspaceRecordBody = round === undefined ? outcome : { ...outcome, round };
      try {
        await this.#write(actor, `${scoped}:finish:${outcome.state}`, "workspace.finish", id, { creates: false, payload: { state: outcome.state }, body: () => final, expectedRevision: current.revision, also: async () => [...(round === undefined ? [] : this.#roundChange(final.taskId, round, counter?.revision)), ...(await this.#commitChange(id, final)), ...(await this.#dequeueChange(final)), ...(final.held !== undefined && final.held.length > 0 ? [] : await this.#openChange(final.taskId, null, id))] });
        return { ...final, id, replayed: false };
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "stale_revision")) throw error;
      }
    }
    throw new DomainError("unavailable", "the outcome of the workspace operation could not be recorded; the request says uncertain");
  }

  /**
   * The record of an approved submission's commit (card H12o), written with the release that made or found it: only when the host answered for this very submission with a commit whose parent and tree are the approved base and
   * tree (a host that dropped the submission and made a plain release commit is not taken as having committed it). Written once: a record already there is left as it is.
   */
  async #commitChange(requestId: string, final: WorkspaceRecordBody): Promise<Change[]> {
    const s = final.submission;
    if (final.operation !== "release" || s === undefined || final.state !== "done") return [];
    const d = (final.detail ?? {}) as { committed?: unknown; alreadyRecorded?: unknown; commit?: unknown; parent?: unknown; tree?: unknown; submission?: unknown; recovered?: unknown; permitted?: unknown };
    if (d.committed !== true || d.alreadyRecorded === true || d.submission !== s.id || typeof d.commit !== "string" || !OID.test(d.commit) || d.parent !== s.base || d.tree !== s.tree) return [];
    if ((await this.#runner.get(SUBMISSION_COMMIT, s.id)) !== undefined) return [];
    const body: SubmissionCommitBody = { submissionId: s.id, taskId: final.taskId, commitId: d.commit, parent: s.base, tree: s.tree, requestId, at: this.#runner.now(), recovered: d.recovered === true, ...(d.permitted === true && reviewerApproved(s.approvedBy) ? { permitted: true } : {}) };
    return [{ type: "create", ref: { kind: SUBMISSION_COMMIT, id: s.id }, body: json(body) }];
  }

  /** Whether the host's detail confirms that exactly the queued submission landed: the same submission, base and tree. */
  #landedExactly(q: NonNullable<WorkspaceRecordBody["queued"]>, detail: JsonObject | undefined, reapplied?: { readonly base: string; readonly tree: string }): boolean {
    if (detail === undefined || detail["landed"] !== true || detail["submission"] !== q.submissionId) return false;
    // A re-applied submission (card P10): the host landed the re-applied base and tree, and says it held them against the approved ones.
    if (reapplied !== undefined) {
      const from = detail["reappliedFrom"] as { base?: unknown; tree?: unknown } | undefined;
      return detail["base"] === reapplied.base && detail["tree"] === reapplied.tree && from !== null && typeof from === "object" && from.base === q.base && from.tree === q.tree;
    }
    return detail["base"] === q.base && detail["tree"] === q.tree;
  }

  /** The change that takes a landed submission out of the landing queue (card P10), in the same write as the landing's outcome; only when the host confirmed exactly that submission landed. */
  async #dequeueChange(final: WorkspaceRecordBody): Promise<Change[]> {
    const q = final.queued;
    if (final.operation !== "landing" || q === undefined || final.state !== "done" || this.#deps.landingQueue === undefined || !this.#landedExactly(q, final.detail, final.reapplied)) return [];
    return this.#deps.landingQueue.landedChanges(final.projectId, q.branch, q.submissionId);
  }

  /** The write of a task's refresh-round count: created at the first round, then updated against the revision that was read. */
  #roundChange(taskId: string, rounds: number, revision: number | undefined): Change[] {
    const ref: AggregateRef = { kind: ROUNDS, id: taskId };
    return [revision === undefined ? { type: "create", ref, body: json({ rounds }) } : { type: "update", ref, expectedRevision: revision, body: json({ rounds }) }];
  }

  /** The open index of a task: set to `requestId`, or cleared (only when it still names `from`). */
  async #openChange(taskId: string, requestId: string | null, from?: string): Promise<Change[]> {
    const ref: AggregateRef = { kind: OPEN, id: taskId };
    const current = await this.#runner.get(OPEN, taskId);
    if (requestId === null) {
      if (current === undefined || (current.body as unknown as { requestId?: string }).requestId !== from) return [];
      return [{ type: "update", ref, expectedRevision: current.revision, body: json({}) }];
    }
    return [current === undefined ? { type: "create", ref, body: json({ requestId }) } : { type: "update", ref, expectedRevision: current.revision, body: json({ requestId }) }];
  }

  async #authorize(by: Principal, taskId: string): Promise<string> {
    const found = await this.#runner.get("task", taskId);
    const projectId = (found?.body as unknown as TaskBody | undefined)?.projectId;
    const refused = (): DomainError => new DomainError("not_found", `task ${taskId} does not exist or is not yours to manage`);
    // Exact: a wildcard grant is not enough to change another's checkout.
    if (projectId === undefined || by.taskScope !== undefined || !inTaskScope(by, projectId) || !allowsExactly(by, "workspace.manage", projectId, { resource: { kind: "task", id: taskId } })) throw refused();
    return projectId;
  }

  async #get(id: string): Promise<{ readonly body: WorkspaceRecordBody; readonly revision: number } | undefined> {
    const found: Aggregate | undefined = await this.#runner.get(RECORD, id);
    return found === undefined ? undefined : { body: found.body as unknown as WorkspaceRecordBody, revision: found.revision };
  }

  async #write(actor: string, commandId: string, type: string, id: string, w: { creates: boolean; payload: JsonObject; body: () => WorkspaceRecordBody; expectedRevision?: number; also?: () => Promise<Change[]> }) {
    const ref: AggregateRef = { kind: RECORD, id };
    return this.#runner.command(type, { commandId, actor }, async () => ({
      payload: w.payload,
      build: async () => ({
        ref, creates: w.creates,
        changes: [w.creates ? { type: "create" as const, ref, body: json(w.body()) } : { type: "update" as const, ref, expectedRevision: w.expectedRevision!, body: json(w.body()) }, ...(w.also === undefined ? [] : await w.also())],
        detail: { operation: w.body().operation, taskId: w.body().taskId },
        contention: async () => new DomainError("stale_revision", "the workspace request changed at the same moment"),
      }),
    }));
  }
}
