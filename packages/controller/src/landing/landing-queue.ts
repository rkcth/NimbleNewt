import { setTimeout as sleep } from "node:timers/promises";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { taskId as checkTaskId, text } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

/**
 * The landing queue of a project's landing branch (card P10, "an oldest-first queue"). One record per project and branch holds the approved code submissions waiting to land, oldest first. Each task has at most one
 * place: a newer approved submission of a task that is already queued (the author refreshed and was approved again) takes the old one's place instead of going to the back, so refreshing never costs a task its turn.
 * Only the oldest entry may land (the landing service checks this before it asks a host, and again right before); a landing that the host confirms as exactly that submission removes the entry in the same write that
 * records the landing, so the next one becomes the oldest. Each change is one recorded command: a repeat answers what it did, and two writers at the same moment are both kept (the loser is built again from the record).
 *
 * The service takes no caller: who may add, remove or read is decided by its door (`LandingQueueOps`).
 */
export const LANDING_QUEUE_LIMITS = { entries: 200, reason: 300, branch: 200, landed: 200 } as const;
const KIND = "landing-queue";
const OID = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SUBMISSION = /^sbm-[a-z2-7]{20}$/;

export interface LandingQueueEntry {
  /** Grows by one for every entry ever added to this branch's queue; the order of the queue. A replaced submission keeps its task's number. */
  readonly seq: number;
  readonly submissionId: string;
  readonly taskId: string;
  /** The approved base and tree: what must land, exactly. */
  readonly base: string;
  readonly tree: string;
  /** The principal that submitted the work (its author). */
  readonly author: string;
  readonly queuedAt: string;
  readonly queuedBy: string;
  /** The submission this one replaced in the task's place, when it did. */
  readonly replaced?: string;
  /** When the submission was recorded (`SubmissionService`), when known: an older submission never takes a newer one's place. */
  readonly submittedAt?: string;
}
export interface LandingQueueBody {
  readonly projectId: string;
  readonly branch: string;
  readonly nextSeq: number;
  /** Oldest first. */
  readonly entries: readonly LandingQueueEntry[];
  /** The submissions that landed from this queue, newest last (at most `LANDING_QUEUE_LIMITS.landed`): a landed submission is not queued again (a later review approving it again would put work that is already in the branch at the head). */
  readonly landed?: readonly string[];
}
export interface LandingQueue extends LandingQueueBody { readonly queueId: string; readonly revision: number }

const json = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
/** A lost race on the queue record, built again from what is stored now (never shown to a caller). */
const RACE = "landing queue: lost a race, build again";
async function retried<T>(run: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try { return await run(); } catch (error) {
      if (!(error instanceof DomainError && error.code === "stale_revision" && error.message === RACE)) throw error;
      if (attempt >= 40) throw new DomainError("unavailable", "the landing queue kept changing at the same moment; send the command again");
      // Lost races are built again (at most 40 times). A short, growing, jittered wait so that many writers at once do not keep meeting each other.
      await sleep(Math.round(Math.random() * Math.min(50, 2 * attempt)));
    }
  }
}

export class LandingQueueService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): LandingQueueService {
    return new LandingQueueService(new CommandRunner(storage, epoch, options));
  }

  static queueIdOf(projectId: string, branch: string): string { return derivedId("lqu", `queue\0${projectId}\0${branch}`); }

  /** The queue of a project's branch (an empty one when nothing was ever queued there). */
  async get(projectId: string, branch: string): Promise<LandingQueue> {
    const queueId = LandingQueueService.queueIdOf(projectId, branch);
    const found = await this.#runner.get(KIND, queueId);
    if (found === undefined) return { queueId, projectId, branch, nextSeq: 1, entries: [], revision: 0 };
    return { ...(found.body as unknown as LandingQueueBody), queueId, revision: found.revision };
  }

  /**
   * Puts an approved submission in the queue. A submission already queued is left where it is (`already`); a task already queued has its entry's submission replaced in place (it keeps its turn); anything else goes to the
   * back. At most `entries` entries; one more is refused `unavailable`.
   */
  async enqueue(command: { commandId: string; actor: string; projectId: string; branch: string; submissionId: string; taskId: string; base: string; tree: string; author: string; submittedAt?: string }): Promise<{ entry: LandingQueueEntry; position: number; already: boolean; replaced?: string }> {
    const projectId = text(command.projectId, "projectId", { min: 1, max: 100 });
    const branch = text(command.branch, "branch", { min: 1, max: LANDING_QUEUE_LIMITS.branch });
    const taskId = checkTaskId(command.taskId);
    if (typeof command.submissionId !== "string" || !SUBMISSION.test(command.submissionId)) throw new DomainError("invalid_command", "submissionId: is not a submission ID", { field: "submissionId" });
    if (!OID.test(command.base) || !OID.test(command.tree)) throw new DomainError("invalid_command", "submission: must name a base commit and a tree", { field: "submissionId" });
    const author = text(command.author, "author", { min: 1, max: 200 });
    const submittedAt = typeof command.submittedAt === "string" && command.submittedAt.length <= 40 ? command.submittedAt : undefined;
    const queueId = LandingQueueService.queueIdOf(projectId, branch);
    let outcome: { already: boolean; replaced?: string } = { already: false };
    await retried(() => this.#runner.command("landing.queue.add", { commandId: command.commandId, actor: command.actor }, async () => ({
      payload: { projectId, branch, submissionId: command.submissionId, taskId, base: command.base, tree: command.tree, author },
      build: async () => {
        const current = await this.#runner.get(KIND, queueId);
        const q = current?.body as unknown as LandingQueueBody | undefined;
        const entries = [...(q?.entries ?? [])];
        const nextSeq = q?.nextSeq ?? 1;
        const now = this.#runner.now();
        const landed = q?.landed ?? [];
        const same = entries.findIndex((e) => e.submissionId === command.submissionId);
        const ofTask = entries.findIndex((e) => e.taskId === taskId);
        const kept = { projectId, branch, ...(landed.length === 0 ? {} : { landed }) };
        let next: LandingQueueBody;
        if (landed.includes(command.submissionId)) throw new DomainError("invalid_transition", `submission ${command.submissionId} already landed from the landing queue of branch ${branch}; it is not queued again`);
        if (same >= 0) {
          outcome = { already: true };
          next = { ...kept, nextSeq, entries };
        } else if (ofTask >= 0) {
          const old = entries[ofTask]!;
          // Only a newer submission takes the task's place: an older one approved late (or added by hand) would put superseded work back at the task's turn.
          if (submittedAt !== undefined && old.submittedAt !== undefined && submittedAt < old.submittedAt) throw new DomainError("invalid_transition", `task ${taskId} already has a newer submission (${old.submissionId}) in the landing queue of branch ${branch}; an older one does not take its place (take that one out first)`);
          outcome = { already: false, replaced: old.submissionId };
          entries[ofTask] = { seq: old.seq, submissionId: command.submissionId, taskId, base: command.base, tree: command.tree, author, queuedAt: old.queuedAt, queuedBy: command.actor, replaced: old.submissionId, ...(submittedAt === undefined ? {} : { submittedAt }) };
          next = { ...kept, nextSeq, entries };
        } else {
          if (entries.length >= LANDING_QUEUE_LIMITS.entries) throw new DomainError("unavailable", `the landing queue of branch ${branch} already holds ${entries.length} submissions, at most ${LANDING_QUEUE_LIMITS.entries}; land or remove some first`);
          outcome = { already: false };
          entries.push({ seq: nextSeq, submissionId: command.submissionId, taskId, base: command.base, tree: command.tree, author, queuedAt: now, queuedBy: command.actor, ...(submittedAt === undefined ? {} : { submittedAt }) });
          next = { ...kept, nextSeq: nextSeq + 1, entries };
        }
        const ref: AggregateRef = { kind: KIND, id: queueId };
        return {
          ref, creates: current === undefined,
          changes: [current === undefined ? { type: "create", ref, body: json(next) } : { type: "update", ref, expectedRevision: current.revision, body: json(next) }],
          detail: { branch, submissionId: command.submissionId, taskId },
          contention: async () => new DomainError("stale_revision", RACE),
        };
      },
    })));
    const q = await this.get(projectId, branch);
    const at = q.entries.findIndex((e) => e.submissionId === command.submissionId);
    // A repeat of a command whose entry has since landed or been removed answers what is there now: not in the queue.
    if (at < 0) throw new DomainError("invalid_transition", `submission ${command.submissionId} is no longer in the landing queue of branch ${branch} (it landed or was taken out)`);
    return { entry: q.entries[at]!, position: at + 1, ...outcome };
  }

  /**
   * Takes a task's entry out of the queue (the owner or the integrator decided it does not land now). `not_found` when the task has no entry, or when `allowed` (the door's rule for a caller who may take out only
   * its own entry) refuses the entry found: it is judged on the entry inside the same write, so an entry put there by someone else at the same moment is never taken out on the strength of an earlier read.
   */
  async remove(command: { commandId: string; actor: string; projectId: string; branch: string; taskId: string; reason: string; allowed?: (entry: LandingQueueEntry) => boolean }): Promise<{ readonly taskId: string; readonly removed?: LandingQueueEntry; readonly replayed: boolean }> {
    const taskId = checkTaskId(command.taskId);
    const reason = text(command.reason, "reason", { min: 1, max: LANDING_QUEUE_LIMITS.reason });
    const queueId = LandingQueueService.queueIdOf(command.projectId, command.branch);
    let removed: LandingQueueEntry | undefined;
    const done = await retried(() => this.#runner.command("landing.queue.remove", { commandId: command.commandId, actor: command.actor }, async () => ({
      payload: { projectId: command.projectId, branch: command.branch, taskId, reason },
      build: async () => {
        const current = await this.#runner.get(KIND, queueId);
        const q = current?.body as unknown as LandingQueueBody | undefined;
        const at = q?.entries.findIndex((e) => e.taskId === taskId) ?? -1;
        if (current === undefined || q === undefined || at < 0 || (command.allowed !== undefined && !command.allowed(q.entries[at]!))) throw new DomainError("not_found", `task ${taskId} has no submission in the landing queue of branch ${command.branch}`);
        removed = q.entries[at];
        const ref: AggregateRef = { kind: KIND, id: queueId };
        return {
          ref, creates: false,
          changes: [{ type: "update", ref, expectedRevision: current.revision, body: json({ ...q, entries: q.entries.filter((_, i) => i !== at) }) }],
          detail: { branch: command.branch, taskId, submissionId: q.entries[at]!.submissionId, reason },
          contention: async () => new DomainError("stale_revision", RACE),
        };
      },
    })));
    // A repeat of the command (recorded already) answers that it was done, without the entry (it is gone).
    return { taskId, ...(removed === undefined ? {} : { removed }), replayed: done.replayed };
  }

  /**
   * The change that takes a landed submission out of the queue, for the landing's own write (the workspace service records the landing and this in one write, so a landing is never recorded without its entry leaving the
   * queue, nor the other way round). The submission is also noted as landed, so that it is not queued again (also when it was taken out meanwhile); nothing when it is noted already or the queue was never written.
   */
  async landedChanges(projectId: string, branch: string, submissionId: string): Promise<Change[]> {
    const queueId = LandingQueueService.queueIdOf(projectId, branch);
    const current = await this.#runner.get(KIND, queueId);
    const q = current?.body as unknown as LandingQueueBody | undefined;
    const queued = q?.entries.some((e) => e.submissionId === submissionId) === true;
    if (current === undefined || q === undefined || (!queued && (q.landed ?? []).includes(submissionId))) return [];
    const landed = [...(q.landed ?? []).filter((s) => s !== submissionId), submissionId].slice(-LANDING_QUEUE_LIMITS.landed);
    return [{ type: "update", ref: { kind: KIND, id: queueId }, expectedRevision: current.revision, body: json({ ...q, entries: q.entries.filter((e) => e.submissionId !== submissionId), landed }) }];
  }
}
