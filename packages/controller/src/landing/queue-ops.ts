import { DomainError } from "../domain/errors.js";
import { onlyKnown, taskId as checkTaskId, text } from "../domain/model.js";
import { allowsExactly, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { LandingQueueService, type LandingQueueEntry } from "./landing-queue.js";

/**
 * Who may put a submission in a branch's landing queue, take one out and read it, and what a landing must show about the queue before it writes (card P10). The queue service itself takes no caller; this is its door.
 *
 * Adding: the owner, an integrator (the exact right `integration.lease` on the project), or the submission's own author; only an approved code submission, and only on the branch the owner's policy names as the project's
 * landing branch. Approved submissions are also queued by the controller itself when the approval is recorded (`queueApproved`). Taking out: the owner or an integrator, or the author of that entry. Reading: the owner or an
 * integrator. A landing (`checkLanding`) lands only the oldest entry, exactly its approved base and tree.
 */
const SUBMISSION = /^sbm-[a-z2-7]{20}$/;
const refused = (what: string): DomainError => new DomainError("not_found", `${what} does not exist or is not yours to manage`);

export interface QueueApproval {
  readonly taskId: string;
  readonly projectId: string;
  readonly base: string;
  readonly tree: string;
  readonly submittedBy: string;
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
    const r = await this.#queue.enqueue({ commandId: scopedCommandId(by.id, command.commandId), actor: by.id, projectId: a.projectId, branch, submissionId: command.submissionId, taskId: a.taskId, base: a.base, tree: a.tree, author: a.submittedBy });
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
      await this.#queue.enqueue({ commandId: `lq-auto:${cause}`, actor: "service:landing-queue", projectId: a.projectId, branch, submissionId, taskId: a.taskId, base: a.base, tree: a.tree, author: a.submittedBy });
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
      await this.#queue.remove({ commandId: `lq-withdraw:${cause}`, actor: "service:landing-queue", projectId: a.projectId, branch, taskId: a.taskId, reason: `submission ${submissionId} is no longer approved`, allowed: (e) => e.submissionId === submissionId });
      return true;
    } catch { return false; }
  }

  /** Takes a task's submission out of the landing queue. */
  async remove(by: Principal, command: NoActor & { taskId: string; reason: string }): Promise<{ taskId: string; branch: string; removed?: LandingQueueEntry; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "reason"]);
    const taskId = checkTaskId(command.taskId);
    const reason = text(command.reason, "reason", { min: 1, max: 300, multiline: false });
    const projectId = await this.#options.projectOfTask(taskId);
    if (projectId === undefined) throw refused(`task ${taskId}`);
    const branch = await this.#branch(taskId, projectId);
    const integrator = this.#integrator(by, projectId);
    // The author of the entry may take its own work out, judged on the entry inside the queue's own write (not on an earlier read, which an entry added at the same moment could make stale). A repeat of the caller's
    // own recorded command is answered by the service; anything else is told nothing exists.
    const allowed = integrator ? undefined : (e: LandingQueueEntry): boolean => e.author === by.id && (by.taskScope === undefined || by.taskScope.taskId === taskId);
    try {
      return { ...(await this.#queue.remove({ commandId: scopedCommandId(by.id, command.commandId), actor: by.id, projectId, branch, taskId, reason, ...(allowed === undefined ? {} : { allowed }) })), branch };
    } catch (error) {
      if (!integrator && error instanceof DomainError && error.code === "not_found") throw refused(`task ${taskId}`);
      throw error;
    }
  }

  /** The landing queue of the project's landing branch, oldest first, with each entry's position. */
  async list(by: Principal, query: { projectId: string }): Promise<{ branch: string; items: (LandingQueueEntry & { position: number })[] }> {
    onlyKnown(query, ["projectId"]);
    if (typeof query.projectId !== "string" || !this.#integrator(by, query.projectId)) throw refused("that project");
    let branch: string | undefined;
    try { branch = await this.#options.landingBranch({ taskId: "", projectId: query.projectId }); } catch { throw new DomainError("unavailable", "the landing settings could not be read, so the landing queue's branch is not known"); }
    if (branch === undefined) return { branch: "", items: [] };
    const q = await this.#queue.get(query.projectId, branch);
    return { branch, items: q.entries.map((e, i) => ({ ...e, position: i + 1 })) };
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
    const head = q.entries[0];
    if (mine === undefined) {
      if (by.kind === "owner" && head === undefined) return undefined;
      if (head !== undefined && by.kind === "owner") throw new DomainError("invalid_transition", `the landing queue of branch ${branch} is not empty and task ${call.taskId} has nothing in it: the oldest submission (${head.submissionId}, task ${head.taskId}) lands first`);
      throw new DomainError("invalid_transition", `task ${call.taskId} has no approved submission in the landing queue of branch ${branch}; an integrator lands only queued submissions (landing.queue.add)`);
    }
    if (head!.taskId !== call.taskId) throw new DomainError("invalid_transition", `task ${call.taskId}'s submission ${mine.submissionId} is number ${at + 1} in the landing queue of branch ${branch}; the oldest (${head!.submissionId}, task ${head!.taskId}) lands first`);
    const a = await this.#options.approvalOf(mine.submissionId);
    if (a === undefined || !a.approved || a.base !== mine.base || a.tree !== mine.tree) throw new DomainError("review_invalid", `submission ${mine.submissionId} is no longer approved as queued (${redactText(a?.reason ?? "its base or tree changed").slice(0, 200)}); take it out of the queue (landing.queue.remove) or have it approved again`, { field: "submissionId" });
    return { submissionId: mine.submissionId, base: mine.base, tree: mine.tree, branch };
  }

  /** The changes that take a landed submission out of the queue, for the landing's own write. */
  landedChanges(projectId: string, branch: string, submissionId: string): ReturnType<LandingQueueService["landedChanges"]> {
    return this.#queue.landedChanges(projectId, branch, submissionId);
  }
}
