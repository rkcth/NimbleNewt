import { DomainError } from "../domain/errors.js";
import { onlyKnown, taskId as checkTaskId, text } from "../domain/model.js";
import { allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { LANDING_QUEUE_LIMITS, LandingQueueService, frontOf, type LandingQueueEntry, type LandingQueueFront, type LandingReservation } from "./landing-queue.js";

/**
 * Who may put a submission in a branch's landing queue, take one out and read it, and what a landing must show about the queue before it writes (card P10). The queue service itself takes no caller; this is its door.
 *
 * Adding: the owner, an integrator (the exact right `integration.lease` on the project), or the submission's own author; only an approved code submission, and only on the branch the owner's policy names as the project's
 * landing branch. Approved submissions are also queued by the controller itself when the approval is recorded (`queueApproved`). Taking out: the owner or an integrator, or the author of that entry. Reading: the owner or an
 * integrator. A landing (`checkLanding`) lands only the first place's entry, exactly its approved base and tree.
 *
 * Reservations and escalation (card P10): when a task's author reaches the project's refresh-round cap (`integration.refreshRounds`), `afterRound` reserves the task's place; when the reserved task needs yet another
 * round, the director is told (once per reservation). When the first place has held the branch for `holdMs` while another task's landing is refused behind it, the director is told too (once per first place).
 * The project's directors may take an entry out or end a reservation, like the owner and integrators.
 */
/** How long the first place may hold the branch before the director is told, when another landing waits behind it (ASSUMPTION: four hours; reversible as the `holdMs` option). */
export const LANDING_HOLD_MS = 4 * 60 * 60 * 1000;
/** The refresh-round cap when the project's settings cannot be read (the profiles' default). */
export const REFRESH_CAP_DEFAULT = 3;
const SUBMISSION = /^sbm-[a-z2-7]{20}$/;
const refused = (what: string): DomainError => new DomainError("not_found", `${what} does not exist or is not yours to manage`);
/** A branch named by a caller: one line of at most 200 characters (the queue's own bound). */
const branchName = (value: unknown): string => text(value, "branch", { min: 1, max: LANDING_QUEUE_LIMITS.branch, multiline: false });

export interface QueueApproval {
  readonly taskId: string;
  readonly projectId: string;
  readonly base: string;
  readonly tree: string;
  readonly submittedBy: string;
  /** When the submission was recorded: an older submission of a task never takes a newer one's place in the queue. */
  readonly submittedAt?: string;
  readonly approved: boolean;
  readonly reason?: string;
}
export interface LandingQueueOpsOptions {
  /** Whether a code submission is approved (`SubmissionService.approvalOf`). */
  readonly approvalOf: (submissionId: string) => Promise<QueueApproval | undefined>;
  /** The landing branch the owner's policy names for the project; `undefined` when it names none. Throws when the settings cannot be read. */
  readonly landingBranch: (call: { taskId: string; projectId: string }) => Promise<string | undefined>;
  /** The project a task belongs to, or undefined when there is no such task. */
  readonly projectOfTask: (taskId: string) => Promise<string | undefined>;
  /** The project's refresh-round cap (`integration.refreshRounds`). Absent or throwing: `REFRESH_CAP_DEFAULT`. */
  readonly refreshCap?: (projectId: string) => Promise<number>;
  /** Tells the project's director (and the owner) about a landing queue that needs a decision. Best effort: a throw is ignored (the mark stays, so it is not told twice). */
  readonly escalate?: (notice: { readonly commandId: string; readonly projectId: string; readonly taskId: string; readonly branch: string; readonly why: "front" | "round"; readonly text: string }) => Promise<void>;
  /** Whether the caller is a director of the project (it may take entries out and end reservations). Absent: nobody is. */
  readonly isDirector?: (by: Principal, projectId: string) => Promise<boolean>;
  /** See `LANDING_HOLD_MS`. */
  readonly holdMs?: number;
}
export interface QueuedLanding { readonly submissionId: string; readonly base: string; readonly tree: string; readonly branch: string }

export class LandingQueueOps {
  readonly #queue: LandingQueueService;
  readonly #options: LandingQueueOpsOptions;
  constructor(queue: LandingQueueService, options: LandingQueueOpsOptions) { this.#queue = queue; this.#options = options; }

  /** The owner, or an integrator of the project (exact right, no task credential). */
  #integrator(by: Principal, projectId: string): boolean {
    return by.kind === "owner" ? by.taskScope === undefined : by.taskScope === undefined && inTaskScope(by, projectId) && allowsExactly(by, "integration.lease", projectId);
  }

  /** The owner, an integrator, or a director of the project: may take out any entry and end a reservation. */
  async #manager(by: Principal, projectId: string): Promise<boolean> {
    if (this.#integrator(by, projectId)) return true;
    if (by.kind !== "agent" || by.taskScope !== undefined || !inTaskScope(by, projectId) || this.#options.isDirector === undefined) return false;
    try { return await this.#options.isDirector(by, projectId); } catch { return false; }
  }

  async #branch(taskId: string, projectId: string): Promise<string> {
    let branch: string | undefined;
    try { branch = await this.#options.landingBranch({ taskId, projectId }); } catch { throw new DomainError("unavailable", "the landing settings could not be read, so the landing queue's branch is not known"); }
    if (branch === undefined) throw new DomainError("forbidden", "the project names no landing branch, so nothing can be queued to land (the owner sets the landing branch first)");
    return branch;
  }

  /** Puts an approved code submission in the landing queue of its project's landing branch. */
  async add(by: Principal, command: NoActor & { submissionId: string }): Promise<{ entry: LandingQueueEntry; position: number; branch: string; already: boolean; replaced?: string }> {
    onlyKnown(command, ["commandId", "submissionId"]);
    if (typeof command.submissionId !== "string" || !SUBMISSION.test(command.submissionId)) throw new DomainError("invalid_command", "submissionId: is not a submission ID", { field: "submissionId" });
    const a = await this.#options.approvalOf(command.submissionId);
    const author = a !== undefined && by.id === a.submittedBy && (by.taskScope === undefined || by.taskScope.taskId === a.taskId);
    if (a === undefined || !(author || this.#integrator(by, a.projectId))) throw refused(`submission ${command.submissionId}`);
    if (!a.approved) throw new DomainError("review_invalid", `submission ${command.submissionId} is not approved (${redactText(a.reason ?? "no approval").slice(0, 200)}); only approved work is queued to land`, { field: "submissionId" });
    const branch = await this.#branch(a.taskId, a.projectId);
    const r = await this.#queue.enqueue({ commandId: scopedCommandId(by.id, command.commandId), actor: by.id, projectId: a.projectId, branch, submissionId: command.submissionId, taskId: a.taskId, base: a.base, tree: a.tree, author: a.submittedBy, ...(a.submittedAt === undefined ? {} : { submittedAt: a.submittedAt }) });
    return { ...r, branch };
  }

  /**
   * The controller's own queueing of a submission that has just been approved (a reviewer's `approve`, or a code submission that needs no review because no other agent could review it). Best effort: a submission that
   * is not approved, a project with no landing branch, or settings that cannot be read leave the queue as it is (the owner, an integrator or the author can still add it). `cause` names what approved it (the review),
   * so a later approval after a `changes` queues it again.
   */
  async queueApproved(submissionId: string, cause: string): Promise<boolean> {
    try {
      const a = await this.#options.approvalOf(submissionId);
      if (a === undefined || !a.approved) return false;
      const branch = await this.#options.landingBranch({ taskId: a.taskId, projectId: a.projectId });
      if (branch === undefined) return false;
      await this.#queue.enqueue({ commandId: `lq-auto:${cause}`, actor: "service:landing-queue", projectId: a.projectId, branch, submissionId, taskId: a.taskId, base: a.base, tree: a.tree, author: a.submittedBy, ...(a.submittedAt === undefined ? {} : { submittedAt: a.submittedAt }) });
      return true;
    } catch { return false; }
  }

  /** The controller's own: a queued submission whose approval was taken back (a newer review says `changes` or `reject`) leaves the queue, so it does not hold the queue up. Best effort. */
  async withdrawUnapproved(submissionId: string, cause: string): Promise<boolean> {
    try {
      const a = await this.#options.approvalOf(submissionId);
      if (a === undefined || a.approved) return false;
      const branch = await this.#options.landingBranch({ taskId: a.taskId, projectId: a.projectId });
      if (branch === undefined) return false;
      const q = await this.#queue.get(a.projectId, branch);
      if (!q.entries.some((e) => e.submissionId === submissionId)) return false;
      // Judged inside the write: only this very submission leaves. A newer approved submission of the task that took its place at the same moment stays (a take-out by task alone would remove it).
      // A reserved place stays (card P10): the task takes it again when it is approved again.
      await this.#queue.remove({ commandId: `lq-withdraw:${cause}`, actor: "service:landing-queue", projectId: a.projectId, branch, taskId: a.taskId, reason: `submission ${submissionId} is no longer approved`, allowed: (e) => e.submissionId === submissionId, keepReservation: true });
      return true;
    } catch { return false; }
  }

  /**
   * Takes a task's submission out of the landing queue: that of the project's landing branch, or of `branch` when given (P10 polish: an entry left in the queue of a branch that is no longer the landing
   * branch, after the owner named another, can be taken out too). Who may is judged first: a caller who may take nothing out of the project is told nothing exists, also while the project names no landing
   * branch (that configuration fact is told only to the owner and integrators).
   */
  async remove(by: Principal, command: NoActor & { taskId: string; reason: string; branch?: string }): Promise<{ taskId: string; branch: string; removed?: LandingQueueEntry; reservationEnded?: true; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "reason", "branch"]);
    const taskId = checkTaskId(command.taskId);
    const reason = text(command.reason, "reason", { min: 1, max: 300, multiline: false });
    const named = command.branch === undefined ? undefined : branchName(command.branch);
    const projectId = await this.#options.projectOfTask(taskId);
    if (projectId === undefined) throw refused(`task ${taskId}`);
    const integrator = await this.#manager(by, projectId);
    let branch: string;
    try { branch = named ?? await this.#branch(taskId, projectId); } catch (error) {
      if (!integrator && error instanceof DomainError && error.code === "forbidden") throw refused(`task ${taskId}`);
      throw error;
    }
    // The author of the entry may take its own work out, judged on the entry inside the queue's own write (not on an earlier read, which an entry added at the same moment could make stale). A repeat of the caller's
    // own recorded command is answered by the service; anything else is told nothing exists.
    // A director of the project may take any entry out and end a reservation (card P10: escalation goes to the director, who decides).
    const allowed = integrator ? undefined : (e: LandingQueueEntry): boolean => e.author === by.id && (by.taskScope === undefined || by.taskScope.taskId === taskId);
    try {
      return { ...(await this.#queue.remove({ commandId: scopedCommandId(by.id, command.commandId), actor: by.id, projectId, branch, taskId, reason, ...(allowed === undefined ? {} : { allowed }) })), branch };
    } catch (error) {
      if (!integrator && error instanceof DomainError && error.code === "not_found") throw refused(`task ${taskId}`);
      throw error;
    }
  }

  /**
   * The landing queue of the project's landing branch (or of `branch` when given), oldest first, with each entry's position. `landingBranch` is the branch the owner's policy names now (empty when none);
   * `others` lists the project's other branches whose queues still hold entries (a branch that was the landing branch before the owner named another, or a task's own landing branch): nothing there lands
   * on the landing branch, and `branch` reads one of them in full. `partial` says the walk over the queues stopped before the end.
   */
  async list(by: Principal, query: { projectId: string; branch?: string }): Promise<{ branch: string; landingBranch: string; items: (LandingQueueEntry & { position: number; reserved?: true })[]; reservations: LandingReservation[]; front?: LandingQueueFront & { waitingForApproval: boolean }; others: { branch: string; entries: number }[]; partial?: true }> {
    onlyKnown(query, ["projectId", "branch"]);
    if (typeof query.projectId !== "string" || !this.#integrator(by, query.projectId)) throw refused("that project");
    const named = query.branch === undefined ? undefined : branchName(query.branch);
    let landing: string | undefined;
    try { landing = await this.#options.landingBranch({ taskId: "", projectId: query.projectId }); } catch { throw new DomainError("unavailable", "the landing settings could not be read, so the landing queue's branch is not known"); }
    const branch = named ?? landing;
    const q = branch === undefined ? undefined : await this.#queue.get(query.projectId, branch);
    const reservations = [...(q?.reservations ?? [])];
    const items = (q?.entries ?? []).map((e, i) => ({ ...e, position: i + 1, ...(reservations.some((r) => r.taskId === e.taskId) ? { reserved: true as const } : {}) }));
    const first = q === undefined ? undefined : frontOf(q);
    const front = q?.front !== undefined && first !== undefined && q.front.taskId === first.taskId ? { ...q.front, waitingForApproval: first.entry === undefined } : undefined;
    const all = await this.#queue.queuesOf(query.projectId);
    return { branch: branch ?? "", landingBranch: landing ?? "", items, reservations, ...(front === undefined ? {} : { front }), others: all.queues.filter((x) => x.branch !== branch), ...(all.partial ? { partial: true as const } : {}) };
  }

  /**
   * What a landing shows about the queue before it writes (the workspace service asks when the request is made and again right before the host is asked). The task's queued submission must be the OLDEST entry of the
   * landing branch's queue and still approved for the same base and tree; it is answered, and the host is then told to land exactly that tree on exactly that base. `submissionId`, when given, must be that entry.
   * The owner may land a task with nothing queued only while the queue is empty (`undefined`: a landing of the checkout's committed work as before, under the host's own rules); an integrator never: it lands only
   * queued submissions, so it carries no content of its own.
   */
  async checkLanding(by: Principal, call: { taskId: string; projectId: string; submissionId: unknown }): Promise<QueuedLanding | undefined> {
    if (call.submissionId !== undefined && (typeof call.submissionId !== "string" || !SUBMISSION.test(call.submissionId))) throw new DomainError("invalid_command", "submissionId: is not a submission ID", { field: "submissionId" });
    const branch = await this.#branch(call.taskId, call.projectId);
    const q = await this.#queue.get(call.projectId, branch);
    const at = q.entries.findIndex((e) => e.taskId === call.taskId);
    const mine = at < 0 ? undefined : q.entries[at]!;
    if (call.submissionId !== undefined && mine?.submissionId !== call.submissionId) throw new DomainError("invalid_transition", `submission ${call.submissionId} is not the submission task ${call.taskId} has in the landing queue of branch ${branch}`, { field: "submissionId" });
    // The first place: the entry or reserved place with the lowest number (card P10). A reserved place waiting for its task's approval holds the branch: nothing else lands before it.
    const head = frontOf(q);
    const behind = (message: string): Promise<never> => this.#heldTooLong(call.projectId, branch, q.front, head?.entry === undefined).then(() => { throw new DomainError("invalid_transition", message); });
    const firstIs = head === undefined ? "" : head.entry === undefined ? `task ${head.taskId} holds the first place (reserved after its author reached the refresh-round cap) and waits for its approved submission` : `the oldest (${head.entry.submissionId}, task ${head.taskId}${head.reservation === undefined ? "" : ", a reserved place"})`;
    if (mine === undefined) {
      if (by.kind === "owner" && head === undefined) return undefined;
      if (head !== undefined && head.taskId !== call.taskId && by.kind === "owner") return behind(`the landing queue of branch ${branch} is not empty and task ${call.taskId} has nothing in it: ${firstIs}${head.entry === undefined ? "" : " lands first"}`);
      throw new DomainError("invalid_transition", `task ${call.taskId} has no approved submission in the landing queue of branch ${branch}; an integrator lands only queued submissions (landing.queue.add)`);
    }
    if (head!.taskId !== call.taskId) return behind(`task ${call.taskId}'s submission ${mine.submissionId} is number ${q.entries.indexOf(mine) + 1} in the landing queue of branch ${branch}; ${firstIs}${head!.entry === undefined ? "" : " lands first"}`);
    const a = await this.#options.approvalOf(mine.submissionId);
    if (a === undefined || !a.approved || a.base !== mine.base || a.tree !== mine.tree) throw new DomainError("review_invalid", `submission ${mine.submissionId} is no longer approved as queued (${redactText(a?.reason ?? "its base or tree changed").slice(0, 200)}); take it out of the queue (landing.queue.remove) or have it approved again`, { field: "submissionId" });
    return { submissionId: mine.submissionId, base: mine.base, tree: mine.tree, branch };
  }

  /**
   * A landing waits behind the first place (card P10). When that place has been first for `holdMs` or longer, the director is told, once per first place: it holds the branch, and someone decides whether it goes on
   * (its author is approved and it lands) or is taken out. Best effort: a failure to mark or tell never changes the landing's own answer.
   */
  async #heldTooLong(projectId: string, branch: string, front: LandingQueueFront | undefined, waitingForApproval: boolean): Promise<void> {
    if (front === undefined || front.escalated === true || this.#options.escalate === undefined) return;
    const since = Date.parse(front.since), now = Date.parse(this.#queue.now());
    if (!Number.isFinite(since) || !Number.isFinite(now) || now - since < (this.#options.holdMs ?? LANDING_HOLD_MS)) return;
    try {
      if (!(await this.#queue.markEscalated({ kind: "front", projectId, branch, taskId: front.taskId, since: front.since }))) return;
      const hours = Math.floor((now - since) / 3_600_000);
      const text = `Task ${front.taskId} has been first in the landing queue of branch ${branch} since ${front.since} (${hours} h) and has not landed${waitingForApproval ? ": its place is reserved and it waits for an approved submission" : ""}; other work waits behind it. Decide whether it goes on, or take it out with landing.queue.remove.`;
      await this.#options.escalate({ commandId: `lq-held:${LandingQueueService.queueIdOf(projectId, branch)}:${front.taskId}:${front.since}`.slice(0, 120), projectId, taskId: front.taskId, branch, why: "front", text });
    } catch { /* best effort */ }
  }

  /**
   * After a refresh round of a task is counted (card H12p, `WorkspaceOpService` tells this): when the round reaches the project's refresh-round cap, the task's place in its landing branch's queue is reserved; when a
   * reserved task needs a round beyond the cap, the director is told (once per reservation). Best effort: answers what it did, never throws.
   */
  async afterRound(call: { taskId: string; projectId: string; round: number }): Promise<"reserved" | "escalated" | undefined> {
    try {
      let cap = REFRESH_CAP_DEFAULT;
      try { if (this.#options.refreshCap !== undefined) cap = await this.#options.refreshCap(call.projectId); } catch { cap = REFRESH_CAP_DEFAULT; }
      if (!Number.isSafeInteger(cap) || cap < 0) cap = REFRESH_CAP_DEFAULT;
      if (!Number.isSafeInteger(call.round) || call.round < 1 || call.round < cap) return undefined;
      const branch = await this.#options.landingBranch({ taskId: call.taskId, projectId: call.projectId });
      if (branch === undefined) return undefined;
      const q = await this.#queue.get(call.projectId, branch);
      const held = q.reservations?.find((r) => r.taskId === call.taskId);
      if (held === undefined) {
        // Named by the queue's revision too: after a reservation ended, the same round number may reserve again (a repeat at the same revision is the same command).
        await this.#queue.reserve({ commandId: `lq-reserve:${call.taskId}:${call.round}:${q.revision}`, actor: "service:landing-queue", projectId: call.projectId, branch, taskId: call.taskId, round: call.round, cap });
        return "reserved";
      }
      if (call.round <= held.round || held.escalatedRound !== undefined) return undefined;
      if (!(await this.#queue.markEscalated({ kind: "round", projectId: call.projectId, branch, taskId: call.taskId, round: call.round }))) return undefined;
      const text = `Task ${call.taskId} needed refresh round ${call.round} although its place in the landing queue of branch ${branch} was reserved at round ${held.round} (the cap is ${cap}): its work keeps going stale. Decide whether it goes on, or take it out with landing.queue.remove.`;
      try { await this.#options.escalate?.({ commandId: `lq-rounds:${call.taskId}:${held.since}`.slice(0, 120), projectId: call.projectId, taskId: call.taskId, branch, why: "round", text }); } catch { /* best effort */ }
      return "escalated";
    } catch { return undefined; }
  }

  /** The changes that take a landed submission out of the queue, for the landing's own write. */
  landedChanges(projectId: string, branch: string, submissionId: string): ReturnType<LandingQueueService["landedChanges"]> {
    return this.#queue.landedChanges(projectId, branch, submissionId);
  }
}
