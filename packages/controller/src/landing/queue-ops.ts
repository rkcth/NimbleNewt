import { isAgentOwner, type Owner } from "../domain/assignment-model.js";
import { DomainError } from "../domain/errors.js";
import { onlyKnown, taskId as checkTaskId, text } from "../domain/model.js";
import { allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { LANDING_QUEUE_LIMITS, LandingQueueService, frontOf, type LandingQueueEntry, type LandingQueueFront, type LandingReservation, type LandingReturns } from "./landing-queue.js";

/**
 * Who may put a submission in a branch's landing queue, take one out and read it, and what a landing must show about the queue before it writes (card P10). The queue service itself takes no caller; this is its door.
 *
 * Adding: the owner, an integrator (the exact right `integration.lease` on the project), or the task's own agent (see "the task's own agent" below); only an approved code submission, and only on the branch the owner's
 * policy names as the project's landing branch. Approved submissions are also queued by the controller itself when the approval is recorded (`queueApproved`). Taking out: the owner or an integrator, or the task's own
 * agent. Reading: the owner or an integrator. A landing (`checkLanding`) lands only the first place's entry, exactly its approved base and tree.
 *
 * The task's own agent (card P10, hand-off): the agent that holds the task now (`holderOf`), or the submission's author while no other principal holds the task. After a hand-off the new holder answers for the task's
 * queued work (it is the one that refreshes returned work), and the agent that handed it off no longer adds or takes out the task's work, although the entry still names it as the author (what was approved, by whom).
 *
 * Reservations and escalation (card P10): when a task's author reaches the project's refresh-round cap (`integration.refreshRounds`), `afterRound` reserves the task's place; when the reserved task needs yet another
 * round, the director is told (once per reservation). When the first place has held the branch for `holdMs` while another task's landing is refused behind it, the director is told too (once per first place).
 * The project's directors may take an entry out or end a reservation, like the owner and integrators.
 */
/** How long the first place may hold the branch before the director is told, when another landing waits behind it (ASSUMPTION: four hours; reversible as the `holdMs` option). */
export const LANDING_HOLD_MS = 4 * 60 * 60 * 1000;
/**
 * How long a reserved place may hold the branch with NO approved entry (its work was returned to its author and the refreshed work is not approved yet) before the controller ends the reservation, when another landing
 * waits behind it (card P10, eighth slice). ASSUMPTION: twelve hours, three times the time the director is given to decide (`LANDING_HOLD_MS`); reversible as the `releaseMs` option.
 */
export const LANDING_RESERVATION_RELEASE_MS = 12 * 60 * 60 * 1000;
/** The refresh-round cap when the project's settings cannot be read (the profiles' default). */
export const REFRESH_CAP_DEFAULT = 3;
/** The repair-cycle limit (card Q04, `review.repairCycles`) when the project's settings cannot be read (the setting's default). */
export const REPAIR_CYCLES_DEFAULT = 3;
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
  /**
   * Tells the project's director (and the owner) about a landing queue that needs a decision. It is asked before the queue marks the escalation, so a throw (the owner could not be told) leaves it unmarked and it is
   * asked again at the next refused landing or round; a repeat of the same `commandId` must tell nobody twice.
   */
  readonly escalate?: (notice: { readonly commandId: string; readonly projectId: string; readonly taskId: string; readonly branch: string; readonly why: "front" | "round" | "returns" | "unassigned" | "released"; readonly text: string }) => Promise<void>;
  /** The repair-cycle limit of the project (card Q04, `review.repairCycles`): conflict returns count against it. Absent or throwing: `REPAIR_CYCLES_DEFAULT`. */
  readonly repairCycles?: (projectId: string) => Promise<number>;
  /** Tells an agent (a notice in its inbox) that its task's work came back to it. A repeat of the same `commandId` must tell nobody twice. */
  readonly tell?: (notice: { readonly commandId: string; readonly taskId: string; readonly to: string; readonly text: string; readonly purpose?: string }) => Promise<void>;
  /** Whether an agent is active (not retired): work returned to a task is told to its holder only while that agent is active. Absent: every holder counts as active. */
  readonly activeAgent?: (agentId: string) => Promise<boolean>;
  /** Whether the caller is a director of the project (it may take entries out and end reservations). Absent: nobody is. */
  readonly isDirector?: (by: Principal, projectId: string) => Promise<boolean>;
  /** See `LANDING_HOLD_MS`. */
  readonly holdMs?: number;
  /** See `LANDING_RESERVATION_RELEASE_MS`. */
  readonly releaseMs?: number;
  /**
   * The owner of the task's current assignment as the assignment records it (`{ kind, id }`), or undefined when nobody holds it. Only an agent owner is an agent that holds the task (`isAgentOwner`: the bare or
   * the prefixed ID, and only for an agent principal); a person, role or team owner with the same name holds it for nobody here. Absent: the author rule alone (the submitter adds and takes out its task's work).
   * Throwing: the caller is judged as neither the holder nor an author (fails closed; the owner, integrators and directors are not affected).
   */
  readonly holderOf?: (taskId: string) => Promise<Owner | undefined>;
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

  /**
   * Whether `by` answers for task `taskId`'s queued work as its own agent (no integrator or director right): it holds the task now, or it is `author` while no other principal holds it. A task credential counts
   * only for its own task.
   */
  async #ownAgent(by: Principal, taskId: string): Promise<(author: string) => boolean> {
    if (by.taskScope !== undefined && by.taskScope.taskId !== taskId) return () => false;
    if (this.#options.holderOf === undefined) return (author) => author === by.id;
    let holder: Owner | undefined;
    try { holder = await this.#options.holderOf(taskId); } catch { return () => false; }
    if (holder !== undefined) { const holds = isAgentOwner(holder, by); return () => holds; }
    return (author) => author === by.id;
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
    if (a === undefined) throw refused(`submission ${command.submissionId}`);
    if (!this.#integrator(by, a.projectId) && !(await this.#ownAgent(by, a.taskId))(a.submittedBy)) throw refused(`submission ${command.submissionId}`);
    if (!a.approved) throw new DomainError("review_invalid", `submission ${command.submissionId} is not approved (${redactText(a.reason ?? "no approval").slice(0, 200)}); only approved work is queued to land`, { field: "submissionId" });
    const branch = await this.#branch(a.taskId, a.projectId);
    const r = await this.#queue.enqueue({ commandId: scopedCommandId(by.id, command.commandId), actor: by.id, projectId: a.projectId, branch, submissionId: command.submissionId, taskId: a.taskId, base: a.base, tree: a.tree, author: a.submittedBy, ...(a.submittedAt === undefined ? {} : { submittedAt: a.submittedAt }) });
    return { ...r, branch };
  }

  /**
   * The controller's own queueing of a submission that has just been approved (a reviewer's `approve`, or a code submission that needs no review because no other agent could review it). Best effort: a submission that
   * is not approved, a project with no landing branch, or settings that cannot be read leave the queue as it is (the owner, an integrator or the task's own agent can still add it). `cause` names what approved it (the review),
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
    // The task's own agent may take its work out (the holder now, or the entry's author while nobody else holds the task), judged on the entry inside the queue's own write (not on an earlier read, which an entry
    // added at the same moment could make stale; the holder is read just before, so a hand-off at that very moment is judged on the holder before it). A repeat of the caller's own recorded command is answered by
    // the service; anything else is told nothing exists.
    // A director of the project may take any entry out and end a reservation (card P10: escalation goes to the director, who decides).
    const own = integrator ? undefined : await this.#ownAgent(by, taskId);
    const allowed = own === undefined ? undefined : (e: LandingQueueEntry): boolean => own(e.author);
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
  async list(by: Principal, query: { projectId: string; branch?: string }): Promise<{ branch: string; landingBranch: string; items: (LandingQueueEntry & { position: number; reserved?: true })[]; reservations: LandingReservation[]; front?: LandingQueueFront & { waitingForApproval: boolean }; returns: LandingReturns[]; others: { branch: string; entries: number }[]; partial?: true }> {
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
    return { branch: branch ?? "", landingBranch: landing ?? "", items, reservations, ...(front === undefined ? {} : { front }), returns: [...(q?.returns ?? [])], others: all.queues.filter((x) => x.branch !== branch), ...(all.partial ? { partial: true as const } : {}) };
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
    // A reserved place whose work is away has held the branch too long: the controller ends it and this landing is judged again on the queue as it is then (the place is gone, so this cannot repeat).
    // Only a queued submission waiting behind the place asks for that: a landing of a task with nothing queued (the owner's unqueued landing included) is refused as before and ends nothing.
    if (mine !== undefined && head !== undefined && head.entry === undefined && head.taskId !== call.taskId && await this.#releaseIdle(call.projectId, branch, q.front, head.taskId)) return this.checkLanding(by, call);
    const behind = (message: string): Promise<never> => this.#heldTooLong(call.projectId, branch, q.front, head?.entry === undefined).then(() => { throw new DomainError("invalid_transition", message); });
    const firstIs = head === undefined ? "" : head.entry === undefined ? `task ${head.taskId} holds the first place (reserved after its author reached the refresh-round cap) and waits for its approved submission (the owner, an integrator or a director may take it out with landing.queue.remove, which lets the others land)` : `the oldest (${head.entry.submissionId}, task ${head.taskId}${head.reservation === undefined ? "" : ", a reserved place"})`;
    if (mine === undefined) {
      if (by.kind === "owner" && head === undefined) return undefined;
      if (head !== undefined && head.taskId !== call.taskId && by.kind === "owner") return behind(`the landing queue of branch ${branch} is not empty and task ${call.taskId} has nothing in it: ${firstIs}${head.entry === undefined ? "" : " lands first"}`);
      // The task's own reserved place (card P10): it lands from that place once its submission is approved and queued, never as an unqueued landing (the owner's included).
      if ((q.reservations ?? []).some((r) => r.taskId === call.taskId)) throw new DomainError("invalid_transition", `task ${call.taskId} holds a reserved place in the landing queue of branch ${branch} but has no approved submission there; it lands from that place once its submission is approved (the controller queues it then, or landing.queue.add)`);
      throw new DomainError("invalid_transition", `task ${call.taskId} has no approved submission in the landing queue of branch ${branch}; an integrator lands only queued submissions (landing.queue.add)`);
    }
    if (head!.taskId !== call.taskId) return behind(`task ${call.taskId}'s submission ${mine.submissionId} is number ${q.entries.indexOf(mine) + 1} in the landing queue of branch ${branch}; ${firstIs}${head!.entry === undefined ? "" : " lands first"}`);
    // A reserved place can come ahead of an entry whose landing already passed its own checks (card P10): this one waits until that landing ends, so two landings never reach the host together.
    const underway = await this.#queue.landingUnderway(call.projectId, branch, call.taskId);
    if (underway !== undefined) throw new DomainError("invalid_transition", `task ${underway}'s landing on branch ${branch} is in progress; task ${call.taskId} lands after that landing ends (ask again then)`);
    const a = await this.#options.approvalOf(mine.submissionId);
    if (a === undefined || !a.approved || a.base !== mine.base || a.tree !== mine.tree) throw new DomainError("review_invalid", `submission ${mine.submissionId} is no longer approved as queued (${redactText(a?.reason ?? "its base or tree changed").slice(0, 200)}); take it out of the queue (landing.queue.remove) or have it approved again`, { field: "submissionId" });
    return { submissionId: mine.submissionId, base: mine.base, tree: mine.tree, branch };
  }

  /**
   * What an `integration` (card H12l: the checkout's uncommitted changes written into the shared tree) must show about the landing branch's queue before it writes (card P10, sixth slice). An integration carries work
   * no review approved into the tree the landing branch's work lands in, and the files it leaves there refuse every landing until somebody commits or clears them. So it is made only as the owner's unqueued landing
   * is: by the owner, and only while the queue of `branch` holds nothing (no entry, no reserved place); an integrator or any agent never (it lands only queued submissions, so it carries no content of its own).
   * The workspace service asks when the request is made and again right before the host is asked. Throws `invalid_transition` when refused.
   */
  async checkIntegration(by: Principal, call: { taskId: string; projectId: string; branch: string }): Promise<void> {
    if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("invalid_transition", `on a project with a landing branch (${call.branch.slice(0, 80)}) only the owner shares a task's unreviewed work into the shared tree; an integrator lands only approved submissions from the landing queue (landing.queue.add)`);
    const q = await this.#queue.get(call.projectId, call.branch);
    const head = frontOf(q);
    if (head === undefined) return;
    const waiting = q.entries.length, reserved = (q.reservations ?? []).length;
    throw new DomainError("invalid_transition", `the landing queue of branch ${call.branch.slice(0, 80)} is not empty (${waiting} waiting${reserved === 0 ? "" : `, ${reserved} reserved`}; task ${head.taskId} is first), so task ${call.taskId}'s unreviewed work is not shared into the shared tree now: queued work lands first (landing.queue.list shows it; landing.queue.remove takes work out)`);
  }

  /**
   * A landing waits behind the first place (card P10). When that place has been first for `holdMs` or longer, the director is told, once per first place: it holds the branch, and someone decides whether it goes on
   * (its author is approved and it lands) or is taken out. The notice goes first and the mark after it: a notice that could not be given is given at the next refused landing (the notices are named by command ID,
   * and their text depends only on the first place, so two refusals at the same moment tell once). Best effort: a failure to mark or tell never changes the landing's own answer.
   */
  async #heldTooLong(projectId: string, branch: string, front: LandingQueueFront | undefined, waitingForApproval: boolean): Promise<void> {
    if (front === undefined || front.escalated === true || this.#options.escalate === undefined) return;
    const holdMs = this.#options.holdMs ?? LANDING_HOLD_MS;
    const since = Date.parse(front.since), now = Date.parse(this.#queue.now());
    if (!Number.isFinite(since) || !Number.isFinite(now) || now - since < holdMs) return;
    try {
      const hold = holdMs % 3_600_000 === 0 ? `${holdMs / 3_600_000} h` : `${Math.round(holdMs / 60_000)} min`;
      const text = `Task ${front.taskId} has been first in the landing queue of branch ${branch} since ${front.since} (at least ${hold}) and has not landed${waitingForApproval ? ": its place is reserved and it waits for an approved submission" : ""}; other work waits behind it. Decide whether it goes on, or take it out with landing.queue.remove.`;
      await this.#options.escalate({ commandId: `lq-held:${LandingQueueService.queueIdOf(projectId, branch)}:${front.taskId}:${front.since}${waitingForApproval ? ":waiting" : ""}`.slice(0, 120), projectId, taskId: front.taskId, branch, why: "front", text });
      await this.#queue.markEscalated({ kind: "front", projectId, branch, taskId: front.taskId, since: front.since });
    } catch { /* best effort: unmarked, so the next refused landing tells again */ }
  }

  /**
   * The bounded hold of a reserved place (card P10, eighth slice). A landing waits behind a first place that has no approved entry (its work was returned to its author, or its approval was taken back). When
   * that place has had no approved entry for `releaseMs`, the controller ends the reservation (the queue judges it inside its own write, so a take-out, a landing or approved work coming back at the same moment
   * wins), tells the task's holder (the task goes to the back when its refreshed work is approved) and the director and the owner. Best effort: answers whether the place was ended; a failure leaves the queue as it was.
   */
  async #releaseIdle(projectId: string, branch: string, front: LandingQueueFront | undefined, taskId: string): Promise<boolean> {
    if (front === undefined || front.taskId !== taskId || front.idleSince === undefined) return false;
    const releaseMs = this.#options.releaseMs ?? LANDING_RESERVATION_RELEASE_MS;
    const idle = Date.parse(front.idleSince), now = Date.parse(this.#queue.now());
    if (!Number.isFinite(idle) || !Number.isFinite(now) || now - idle < releaseMs) return false;
    let ended: LandingReservation | undefined;
    try { ended = await this.#queue.releaseIdle({ projectId, branch, taskId, since: front.since, olderThanMs: releaseMs }); } catch { return false; }
    if (ended === undefined) {
      // Not ended by this call: another call may have just ended it (or the place was taken out, or approved work came back); the landing is judged again when the place is no longer that reserved place.
      try { const now2 = frontOf(await this.#queue.get(projectId, branch)); return now2 === undefined || now2.taskId !== taskId || now2.entry !== undefined; } catch { return false; }
    }
    const hours = releaseMs % 3_600_000 === 0 ? `${releaseMs / 3_600_000} h` : `${Math.round(releaseMs / 60_000)} min`;
    const text = `Task ${taskId}'s reserved place in the landing queue of branch ${branch} was released: it had no approved submission for at least ${hours} while other work waited behind it. Its work was not removed; when its refreshed work is approved it takes its turn at the back of the queue.`;
    const id = `lq-released:${LandingQueueService.queueIdOf(projectId, branch)}:${taskId}:${front.since}`.slice(0, 120);
    try {
      const holder = this.#options.holderOf === undefined ? undefined : await this.#options.holderOf(taskId);
      if (holder !== undefined && holder.kind === "agent" && this.#options.tell !== undefined && (this.#options.activeAgent === undefined || await this.#options.activeAgent(holder.id))) await this.#options.tell({ commandId: `${id}:holder`.slice(0, 120), taskId, to: holder.id, text, purpose: "your task's reserved place in the landing queue was released" });
    } catch { /* the director and the owner are still told */ }
    try { await this.#options.escalate?.({ commandId: id, projectId, taskId, branch, why: "released", text }); } catch { /* the place is already ended; nobody could be told */ }
    return true;
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
      // Told first, marked after: a notice that could not be given is given at the task's next round (named by that round, so a repeat is told once).
      const text = `Task ${call.taskId} needed refresh round ${call.round} although its place in the landing queue of branch ${branch} was reserved at round ${held.round} (the cap is ${cap}): its work keeps going stale. Decide whether it goes on, or take it out with landing.queue.remove.`;
      try { await this.#options.escalate?.({ commandId: `lq-rounds:${call.taskId}:${held.since}:${call.round}`.slice(0, 120), projectId: call.projectId, taskId: call.taskId, branch, why: "round", text }); } catch { return undefined; }
      if (!(await this.#queue.markEscalated({ kind: "round", projectId: call.projectId, branch, taskId: call.taskId, round: call.round, since: held.since }))) return undefined;
      return "escalated";
    } catch { return undefined; }
  }

  /**
   * Overlapping work goes back to its author (card P10; the workspace service calls this when the host found that a queued submission changes files that landed on the branch after it was approved). The submission
   * leaves the queue (its place remembered, a reserved place kept) and is not queued again; the return is one repair cycle of the task (card Q04: "a conflict returned to its author counts as a repair cycle"), counted
   * against the project's `review.repairCycles`. Who is told: the agent that holds the task now (`assignee`: after a hand-off, or when the author retired, the task's new holder refreshes, not the submitter), while it is
   * active. When nobody active holds the task, or when the count reaches the limit, the director and the owner are told (they decide: assign the task, let it go on, or take it out). Best effort: answers what it did.
   */
  async returned(call: { readonly requestId: string; readonly taskId: string; readonly projectId: string; readonly branch: string; readonly submissionId: string; readonly paths: readonly string[]; readonly assignee?: string }): Promise<{ readonly to?: string; readonly cycles: number; readonly limit: number; readonly escalated: boolean } | undefined> {
    let r: Awaited<ReturnType<LandingQueueService["returnWork"]>>;
    try { r = await this.#queue.returnWork({ commandId: `lq-return:${call.requestId}`, actor: "service:landing-queue", projectId: call.projectId, branch: call.branch, taskId: call.taskId, submissionId: call.submissionId, paths: call.paths }); } catch { return undefined; }
    if (!r.returned) return undefined;
    let limit = REPAIR_CYCLES_DEFAULT;
    try { if (this.#options.repairCycles !== undefined) limit = await this.#options.repairCycles(call.projectId); } catch { limit = REPAIR_CYCLES_DEFAULT; }
    if (!Number.isSafeInteger(limit) || limit < 1) limit = REPAIR_CYCLES_DEFAULT;
    const files = call.paths.slice(0, 10).map((p) => JSON.stringify(p.slice(0, 100))).join(", ");
    // The holder told: the task's current assignee, while it is an active agent (a retired author's task goes to whoever holds it now; a task nobody holds goes to the director and the owner).
    let to: string | undefined;
    if (call.assignee !== undefined && call.assignee !== "") {
      let active = true;
      try { if (this.#options.activeAgent !== undefined) active = await this.#options.activeAgent(call.assignee.replace(/^agent:/, "")); } catch { active = false; }
      if (active) to = call.assignee;
    }
    if (to !== undefined && this.#options.tell !== undefined) {
      const text = `Task ${call.taskId}: your approved submission ${call.submissionId} could not be landed on branch ${call.branch}: it changes file(s) that also changed there after it was approved (${files}). Nothing was landed, and it was taken out of the landing queue and returned to you. Refresh your checkout onto the landing branch (work.refresh), settle those files, and submit again for review; the new approval is queued by itself. This is conflict return ${r.count} of ${limit} before the director and the owner are asked to decide.`;
      try { await this.#options.tell({ commandId: `lq-told:${call.requestId}`, taskId: call.taskId, to, text }); } catch { to = undefined; }
    } else to = undefined;
    // The director and the owner are told when the cycles reach the limit (each return from then on, named by its count), or when nobody could be told.
    let escalated = false;
    if (this.#options.escalate !== undefined && (r.count >= limit || to === undefined)) {
      const why = r.count >= limit ? ("returns" as const) : ("unassigned" as const);
      const text = why === "returns"
        ? `Task ${call.taskId}'s work was returned to its author ${r.count} time(s) (the limit is ${limit}, review.repairCycles) because it changes files that landed on branch ${call.branch} after it was approved (last: ${files}). Decide whether it goes on, or take it out with landing.queue.remove.`
        : `Task ${call.taskId}'s approved submission ${call.submissionId} changes files that landed on branch ${call.branch} after it was approved (${files}), so it was returned, but no active agent holds the task to refresh it. Assign the task, or take it out with landing.queue.remove.`;
      try { await this.#options.escalate({ commandId: `lq-${why}:${call.taskId}:${r.count}`.slice(0, 120), projectId: call.projectId, taskId: call.taskId, branch: call.branch, why, text }); escalated = true; } catch { escalated = false; }
    }
    return { ...(to === undefined ? {} : { to }), cycles: r.count, limit, escalated };
  }

  /** The changes that take a landed submission out of the queue, for the landing's own write. */
  landedChanges(projectId: string, branch: string, submissionId: string): ReturnType<LandingQueueService["landedChanges"]> {
    return this.#queue.landedChanges(projectId, branch, submissionId);
  }
}
