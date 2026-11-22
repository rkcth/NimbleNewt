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
 * Reservations (card P10, "after the refresh-round cap a reservation"): a task whose author has refreshed onto a moved branch as often as the project's cap allows holds a RESERVED place. The place is the task's number
 * (`seq`) in the queue, and it is kept while the task has no approved entry (its approval was taken back, or its author is refreshing and is approved again): a re-approval takes that place again instead of the back.
 * While a reserved place is the first of the queue and has no approved entry, nothing else lands, so the branch stays where the author refreshed onto. A reservation ends when the task lands or is taken out.
 *
 * The front (`front`): which task is first (an entry or a reserved place), and since when. The door uses it to tell the director when the first task has held the branch too long while other work waits.
 *
 * The service takes no caller: who may add, remove or read is decided by its door (`LandingQueueOps`).
 */
export const LANDING_QUEUE_LIMITS = { entries: 200, reason: 300, branch: 200, landed: 200, reservations: 200, away: 200, returned: 200, returns: 200, paths: 20 } as const;
const KIND = "landing-queue";
/** How many pages of 200 queue records `queuesOf` reads at most: 10,000 queue records over all projects of the controller (every branch that ever held a queue, empty ones included). */
const QUEUE_SCAN_PAGES = 50;
/** The workspace service's records (see `WorkspaceOpService`): one open-request pointer per task, and the requests themselves. Read here only to tell that a task's landing is in progress. */
const OPEN = "workspace-open";
const REQUEST = "workspace-request";
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
/** A reserved place (card P10): the task keeps number `seq` in the queue even while it has no approved entry. */
export interface LandingReservation {
  readonly taskId: string;
  /** The task's place: its entry's number when it was reserved, else the number it had when the controller withdrew it, else the next number then (the back). */
  readonly seq: number;
  readonly since: string;
  /** The refresh round that reached the cap, and the cap then. */
  readonly round: number;
  readonly cap: number;
  /** The round after which the director was told that the task needed another refresh beyond its cap (once per reservation). */
  readonly escalatedRound?: number;
}
/** The first task of the queue (an entry or a reserved place without one) and since when it has been first. `escalated`: the director was told it held the branch too long. */
export interface LandingQueueFront {
  readonly taskId: string;
  readonly since: string;
  readonly escalated?: true;
  /** Since when the first place has had NO approved entry (a reserved place waiting for its task's refreshed work); absent while it has one, and in a record written before it existed (set again at the next write of the queue). The bounded hold of a reserved place counts from here (card P10, eighth slice). */
  readonly idleSince?: string;
}
/**
 * How often a task's queued work went back to its author because it overlapped files that landed since its base (card P10, "overlap returns the work to the author"): each return is one repair cycle of the task (card Q04),
 * counted here and never reset until the task lands. `last` is the last return: when, which submission, and the overlapping paths (at most `LANDING_QUEUE_LIMITS.paths`).
 */
export interface LandingReturns { readonly taskId: string; readonly count: number; readonly last: { readonly at: string; readonly submissionId: string; readonly paths: readonly string[] } }
export interface LandingQueueBody {
  readonly projectId: string;
  readonly branch: string;
  readonly nextSeq: number;
  /** Oldest first. */
  readonly entries: readonly LandingQueueEntry[];
  /** The submissions that landed from this queue, newest last (at most `LANDING_QUEUE_LIMITS.landed`): a landed submission is not queued again (a later review approving it again would put work that is already in the branch at the head). */
  readonly landed?: readonly string[];
  /** Reserved places, by task (card P10). */
  readonly reservations?: readonly LandingReservation[];
  /** The places of entries the controller withdrew because their approval was taken back (newest last, at most `LANDING_QUEUE_LIMITS.away`): a reservation made while the task is away gives it back that place. */
  readonly away?: readonly { readonly taskId: string; readonly seq: number }[];
  readonly front?: LandingQueueFront;
  /** The submissions returned to their authors because they overlapped landed work (newest last, at most `LANDING_QUEUE_LIMITS.returned`): one of these is not queued again (it would overlap again); a refreshed submission is. */
  readonly returned?: readonly string[];
  /** Conflict returns per task (card P10 with Q04), at most `LANDING_QUEUE_LIMITS.returns` tasks (the oldest dropped first). */
  readonly returns?: readonly LandingReturns[];
}
export interface LandingQueue extends LandingQueueBody { readonly queueId: string; readonly revision: number }

const json = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;

/**
 * The first place of a queue: the entry or reserved place with the lowest number. A reserved place counts only while its task has no entry (with an entry, the entry is the place). `entry` is absent for a reserved
 * place that waits for its task's approved submission.
 */
export function frontOf(q: Pick<LandingQueueBody, "entries" | "reservations">): { readonly taskId: string; readonly seq: number; readonly entry?: LandingQueueEntry; readonly reservation?: LandingReservation } | undefined {
  let best: { taskId: string; seq: number; entry?: LandingQueueEntry; reservation?: LandingReservation } | undefined;
  const reservations = q.reservations ?? [];
  for (const e of q.entries) if (best === undefined || e.seq < best.seq) best = { taskId: e.taskId, seq: e.seq, entry: e, ...(reservations.some((r) => r.taskId === e.taskId) ? { reservation: reservations.find((r) => r.taskId === e.taskId)! } : {}) };
  for (const r of reservations) if (!q.entries.some((e) => e.taskId === r.taskId) && (best === undefined || r.seq < best.seq)) best = { taskId: r.taskId, seq: r.seq, reservation: r };
  return best;
}
/** The body with its `front` brought up to date: the same first task keeps its `since` (and its escalation mark); a new first task starts now; an empty queue has none. Optional fields left empty are dropped. */
function settled(next: LandingQueueBody, now: string): LandingQueueBody {
  const { front: before, reservations, landed, away: wasAway, returned, returns, ...rest } = next;
  const away = (wasAway ?? []).filter((a) => !rest.entries.some((e) => e.taskId === a.taskId) && !(reservations ?? []).some((r) => r.taskId === a.taskId));
  const first = frontOf(next);
  // `idleSince`: while the first place has no approved entry it is when that began; with an entry it is dropped (the clock of a reserved place's bounded hold restarts whenever approved work is back).
  const same = before !== undefined && first !== undefined && before.taskId === first.taskId ? before : undefined;
  const { idleSince: wasIdle, ...base } = same ?? { taskId: first?.taskId ?? "", since: now };
  const front = first === undefined ? undefined : { ...base, ...(first.entry === undefined ? { idleSince: wasIdle ?? now } : {}) };
  const sorted = [...rest.entries].sort((a, b) => a.seq - b.seq);
  return { ...rest, entries: sorted, ...(landed === undefined || landed.length === 0 ? {} : { landed }), ...(reservations === undefined || reservations.length === 0 ? {} : { reservations }), ...(away.length === 0 ? {} : { away }), ...(returned === undefined || returned.length === 0 ? {} : { returned }), ...(returns === undefined || returns.length === 0 ? {} : { returns }), ...(front === undefined ? {} : { front }) };
}
/** A lost race on the queue record, built again from what is stored now (never shown to a caller). */
const RACE = "landing queue: lost a race, build again";
/** A command that finds nothing to write (a reservation already held, an escalation already marked): refused inside, answered outside (never shown to a caller). */
const NOTHING = "landing queue: nothing to write";
const nothing = (error: unknown): boolean => error instanceof DomainError && error.code === "invalid_transition" && error.message === NOTHING;
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
   * The queues of a project's branches that hold at least one entry, by branch name (P10 polish: the queue of a branch that is no longer the landing branch, after the owner named another, is not
   * lost from sight). Reads the queue records in pages; at most `QUEUE_SCAN_PAGES` pages of 200 are read, and `partial` says when the walk stopped before the end (`pages` is lowered by tests only).
   */
  async queuesOf(projectId: string, pages: number = QUEUE_SCAN_PAGES): Promise<{ queues: { branch: string; entries: number }[]; partial: boolean }> {
    const queues: { branch: string; entries: number }[] = [];
    let afterId: string | undefined;
    for (let page = 0; page < pages; page++) {
      const batch = await this.#runner.list(KIND, { ...(afterId === undefined ? {} : { afterId }), limit: 200 });
      for (const a of batch) {
        const q = a.body as unknown as LandingQueueBody;
        if (q.projectId === projectId && q.entries.length > 0) queues.push({ branch: q.branch, entries: q.entries.length });
      }
      if (batch.length < 200) return { queues: queues.sort((x, y) => (x.branch < y.branch ? -1 : x.branch > y.branch ? 1 : 0)), partial: false };
      afterId = batch[batch.length - 1]!.id;
    }
    return { queues: queues.sort((x, y) => (x.branch < y.branch ? -1 : x.branch > y.branch ? 1 : 0)), partial: true };
  }

  /**
   * Puts an approved submission in the queue. A submission already queued is left where it is (`already`); a task already queued has its entry's submission replaced in place (it keeps its turn); anything else goes to the
   * back. At most `entries` entries; one more is refused `unavailable`, except a task's re-approval into its reserved place (reservations are bounded on their own, so at most `entries` + `reservations`).
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
        const reservations = q?.reservations ?? [];
        const reserved = reservations.find((r) => r.taskId === taskId);
        const kept = { projectId, branch, ...(landed.length === 0 ? {} : { landed }), ...(reservations.length === 0 ? {} : { reservations }), ...(q?.away === undefined ? {} : { away: q.away }), ...(q?.front === undefined ? {} : { front: q.front }), ...(q?.returned === undefined ? {} : { returned: q.returned }), ...(q?.returns === undefined ? {} : { returns: q.returns }) };
        let next: LandingQueueBody;
        if (landed.includes(command.submissionId)) throw new DomainError("invalid_transition", `submission ${command.submissionId} already landed from the landing queue of branch ${branch}; it is not queued again`);
        // Work returned to its author because it overlapped landed files (card P10) would overlap again: only a refreshed, newly approved submission of the task is queued.
        if ((q?.returned ?? []).includes(command.submissionId)) throw new DomainError("invalid_transition", `submission ${command.submissionId} was returned to its author because it changes files that landed on branch ${branch} after it was approved; it is not queued again (the author refreshes and submits again)`);
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
          // A task with a reserved place is not refused at the bound (second review): while its place is first nothing else lands, so refusing it there would hold the queue until someone took something out.
          // Reservations are bounded on their own, so the queue holds at most `entries` + `reservations` entries.
          if (reserved === undefined && entries.length >= LANDING_QUEUE_LIMITS.entries) throw new DomainError("unavailable", `the landing queue of branch ${branch} already holds ${entries.length} submissions, at most ${LANDING_QUEUE_LIMITS.entries}; land or remove some first`);
          outcome = { already: false };
          // A task with a reserved place takes that place again (card P10): its turn is not lost while it was away from the queue.
          if (reserved !== undefined) {
            entries.push({ seq: reserved.seq, submissionId: command.submissionId, taskId, base: command.base, tree: command.tree, author, queuedAt: now, queuedBy: command.actor, ...(submittedAt === undefined ? {} : { submittedAt }) });
            next = { ...kept, nextSeq, entries };
          } else {
          entries.push({ seq: nextSeq, submissionId: command.submissionId, taskId, base: command.base, tree: command.tree, author, queuedAt: now, queuedBy: command.actor, ...(submittedAt === undefined ? {} : { submittedAt }) });
          next = { ...kept, nextSeq: nextSeq + 1, entries };
          }
        }
        next = settled(next, now);
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
    const listed = q.entries.findIndex((e) => e.submissionId === command.submissionId);
    const at = listed < 0 ? -1 : q.entries.filter((e) => e.seq < q.entries[listed]!.seq).length;
    // A repeat of a command whose entry has since landed or been removed answers what is there now: not in the queue.
    if (listed < 0) throw new DomainError("invalid_transition", `submission ${command.submissionId} is no longer in the landing queue of branch ${branch} (it landed or was taken out)`);
    return { entry: q.entries[listed]!, position: at + 1, ...outcome };
  }

  /**
   * Takes a task's entry out of the queue (the owner or the integrator decided it does not land now). `not_found` when the task has no entry, or when `allowed` (the door's rule for a caller who may take out only
   * its own entry) refuses the entry found: it is judged on the entry inside the same write, so an entry put there by someone else at the same moment is never taken out on the strength of an earlier read.
   */
  async remove(command: { commandId: string; actor: string; projectId: string; branch: string; taskId: string; reason: string; allowed?: (entry: LandingQueueEntry) => boolean; keepReservation?: boolean }): Promise<{ readonly taskId: string; readonly removed?: LandingQueueEntry; readonly reservationEnded?: true; readonly replayed: boolean }> {
    const taskId = checkTaskId(command.taskId);
    const reason = text(command.reason, "reason", { min: 1, max: LANDING_QUEUE_LIMITS.reason });
    const queueId = LandingQueueService.queueIdOf(command.projectId, command.branch);
    let removed: LandingQueueEntry | undefined;
    let ended = false;
    const done = await retried(() => this.#runner.command("landing.queue.remove", { commandId: command.commandId, actor: command.actor }, async () => ({
      payload: { projectId: command.projectId, branch: command.branch, taskId, reason },
      build: async () => {
        const current = await this.#runner.get(KIND, queueId);
        const q = current?.body as unknown as LandingQueueBody | undefined;
        const at = q?.entries.findIndex((e) => e.taskId === taskId) ?? -1;
        // A task with a reserved place and no entry (card P10): taking it out ends the reservation. Only a caller who may take out any entry (no `allowed` rule) may do that.
        const reservedOnly = at < 0 && command.allowed === undefined && command.keepReservation !== true && (q?.reservations ?? []).some((r) => r.taskId === taskId);
        if (current === undefined || q === undefined || (at < 0 && !reservedOnly) || (at >= 0 && command.allowed !== undefined && !command.allowed(q.entries[at]!))) throw new DomainError("not_found", `task ${taskId} has no submission in the landing queue of branch ${command.branch}`);
        const reservations = command.keepReservation === true ? q.reservations ?? [] : (q.reservations ?? []).filter((r) => r.taskId !== taskId);
        // The controller's withdrawal remembers the place, so a reservation made while the task is away gives it back (card P10).
        const away = command.keepReservation === true && at >= 0 ? [...(q.away ?? []).filter((a) => a.taskId !== taskId), { taskId, seq: q.entries[at]!.seq }].slice(-LANDING_QUEUE_LIMITS.away) : (q.away ?? []).filter((a) => a.taskId !== taskId);
        ended = reservations.length !== (q.reservations ?? []).length;
        if (reservedOnly) {
          removed = undefined;
          const ref: AggregateRef = { kind: KIND, id: queueId };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: json(settled({ ...q, reservations, away }, this.#runner.now())) }], detail: { branch: command.branch, taskId, reservationEnded: true, reason }, contention: async () => new DomainError("stale_revision", RACE) };
        }
        removed = q.entries[at];
        // An entry whose landing is on its way to the host (or at it) stays until that landing ends: taking it out would make the next entry the oldest, and its landing could then reach the host too.
        // A landing the index still names as `uncertain` has not ended either: a repeat of its command marks it so while the first call is still at the host (or a stopped controller left it so, until recovery closes it).
        // The task's open-request record is read, and written back unchanged, in this same write: a landing that starts at the same moment changes that record and so loses the race (this write is built again, or that landing fails before the host).
        // A task with no such record yet gets an empty one (what a finished request leaves), created in this write: a landing that starts at the same moment creates it too, so there also exactly one of the two commits.
        const open = await this.#runner.get(OPEN, taskId);
        const openId = (open?.body as unknown as { requestId?: string } | undefined)?.requestId;
        const request = typeof openId === "string" && openId !== "" ? await this.#runner.get(REQUEST, openId) : undefined;
        const rb = request?.body as unknown as { operation?: string; state?: string } | undefined;
        if (open !== undefined && rb?.operation === "landing" && (rb.state === "started" || rb.state === "uncertain")) throw new DomainError("invalid_transition", `task ${taskId}'s submission ${removed!.submissionId} is being landed on branch ${command.branch} right now, so it cannot be taken out of the queue until that landing ends: wait for that landing to end (it ends with a result of its own), then take the submission out if it is still queued`);
        const ref: AggregateRef = { kind: KIND, id: queueId };
        return {
          ref, creates: false,
          changes: [{ type: "update", ref, expectedRevision: current.revision, body: json(settled({ ...q, entries: q.entries.filter((_, i) => i !== at), reservations, away }, this.#runner.now())) }, open === undefined ? { type: "create" as const, ref: { kind: OPEN, id: taskId }, body: json({}) } : { type: "update" as const, ref: { kind: OPEN, id: taskId }, expectedRevision: open.revision, body: open.body as JsonObject }],
          detail: { branch: command.branch, taskId, submissionId: q.entries[at]!.submissionId, reason },
          contention: async () => new DomainError("stale_revision", RACE),
        };
      },
    })));
    // A repeat of the command (recorded already) answers that it was done, without the entry (it is gone).
    return { taskId, ...(removed === undefined ? {} : { removed }), ...(ended && !done.replayed ? { reservationEnded: true as const } : {}), replayed: done.replayed };
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
    // The task that landed no longer holds a reserved place (card P10).
    const task = q.entries.find((e) => e.submissionId === submissionId)?.taskId;
    const reservations = task === undefined ? q.reservations : (q.reservations ?? []).filter((r) => r.taskId !== task);
    // The task landed: its conflict returns are done with (card P10).
    const returns = task === undefined ? q.returns : (q.returns ?? []).filter((r) => r.taskId !== task);
    return [{ type: "update", ref: { kind: KIND, id: queueId }, expectedRevision: current.revision, body: json(settled({ ...q, entries: q.entries.filter((e) => e.submissionId !== submissionId), landed, ...(reservations === undefined ? {} : { reservations }), ...(returns === undefined ? {} : { returns }) }, this.#runner.now())) }];
  }

  /**
   * Returns a queued submission to its author (card P10: it changes files that landed on the branch after it was approved, so it cannot be re-applied mechanically). In one write: its entry leaves the queue (only that very
   * submission: a newer one of the task that took its place stays), its place is remembered as the controller's withdrawals are (a reserved place is kept, so a re-approval takes it again), the submission is noted as
   * returned (it is not queued again), and the task's conflict-return count grows by one. Answers the count; a repeat of the command answers the count as it stands, and `returned: false` when the submission was not
   * the task's entry any more (it landed, was taken out or replaced: nothing to return, nothing counted).
   */
  async returnWork(command: { commandId: string; actor: string; projectId: string; branch: string; taskId: string; submissionId: string; paths: readonly string[] }): Promise<{ readonly returned: boolean; readonly count: number; readonly replayed: boolean }> {
    const taskId = checkTaskId(command.taskId);
    if (typeof command.submissionId !== "string" || !SUBMISSION.test(command.submissionId)) throw new DomainError("invalid_command", "submissionId: is not a submission ID", { field: "submissionId" });
    const paths = (Array.isArray(command.paths) ? command.paths : []).filter((p): p is string => typeof p === "string").slice(0, LANDING_QUEUE_LIMITS.paths).map((p) => p.slice(0, 200));
    const queueId = LandingQueueService.queueIdOf(command.projectId, command.branch);
    let returned = false;
    let done: { replayed: boolean };
    try {
      done = await retried(() => this.#runner.command("landing.queue.return", { commandId: command.commandId, actor: command.actor }, async () => ({
        payload: { projectId: command.projectId, branch: command.branch, taskId, submissionId: command.submissionId, paths },
        build: async () => {
          const current = await this.#runner.get(KIND, queueId);
          const q = current?.body as unknown as LandingQueueBody | undefined;
          const at = q?.entries.findIndex((e) => e.taskId === taskId && e.submissionId === command.submissionId) ?? -1;
          if (current === undefined || q === undefined || at < 0) throw new DomainError("invalid_transition", NOTHING);
          returned = true;
          const now = this.#runner.now();
          const away = [...(q.away ?? []).filter((a) => a.taskId !== taskId), { taskId, seq: q.entries[at]!.seq }].slice(-LANDING_QUEUE_LIMITS.away);
          const before = (q.returns ?? []).find((r) => r.taskId === taskId);
          const returns = [...(q.returns ?? []).filter((r) => r.taskId !== taskId), { taskId, count: (before?.count ?? 0) + 1, last: { at: now, submissionId: command.submissionId, paths } }].slice(-LANDING_QUEUE_LIMITS.returns);
          const list = [...(q.returned ?? []).filter((x) => x !== command.submissionId), command.submissionId].slice(-LANDING_QUEUE_LIMITS.returned);
          const ref: AggregateRef = { kind: KIND, id: queueId };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: json(settled({ ...q, entries: q.entries.filter((_, i) => i !== at), away, returns, returned: list }, now)) }], detail: { branch: command.branch, taskId, submissionId: command.submissionId, count: (before?.count ?? 0) + 1 }, contention: async () => new DomainError("stale_revision", RACE) };
        },
      })));
    } catch (error) {
      if (!nothing(error)) throw error;
      done = { replayed: false };
    }
    const count = (await this.get(command.projectId, command.branch)).returns?.find((r) => r.taskId === taskId)?.count ?? 0;
    return { returned: returned || done.replayed, count, replayed: done.replayed };
  }

  /**
   * Another task of the queue whose landing is on its way to the host or at it (its open request is a `started` or `uncertain` landing), if any (card P10). A reservation can put a task ahead of an entry that was
   * first (a reserved place restored from `away`, or the re-approval that takes it again), which the take-out guard does not see; the landing check asks this, so the first place's landing waits until another entry's
   * landing has ended and the queue never has two landings at the host. A landing records its request before its last check, so of two landings that both pass the first-place check one always sees the other.
   */
  async landingUnderway(projectId: string, branch: string, exceptTaskId: string): Promise<string | undefined> {
    const q = await this.get(projectId, branch);
    for (const e of q.entries) {
      if (e.taskId === exceptTaskId) continue;
      const openId = ((await this.#runner.get(OPEN, e.taskId))?.body as unknown as { requestId?: string } | undefined)?.requestId;
      if (typeof openId !== "string" || openId === "") continue;
      const rb = (await this.#runner.get(REQUEST, openId))?.body as unknown as { operation?: string; state?: string } | undefined;
      if (rb?.operation === "landing" && (rb.state === "started" || rb.state === "uncertain")) return e.taskId;
    }
    return undefined;
  }

  /** The controller's time (the clock the services were built with). */
  now(): string { return this.#runner.now(); }

  /**
   * Reserves the task's place (card P10: its author reached the refresh-round cap). Its place is its entry's number when it is queued, else the number it had when the controller withdrew it (its approval was taken back), else the next number (the back). A task already holding a reservation keeps it as
   * it is (`already`). At most `reservations` reservations; one more is refused `unavailable`.
   */
  async reserve(command: { commandId: string; actor: string; projectId: string; branch: string; taskId: string; round: number; cap: number }): Promise<{ readonly reservation: LandingReservation; readonly already: boolean }> {
    const projectId = text(command.projectId, "projectId", { min: 1, max: 100 });
    const branch = text(command.branch, "branch", { min: 1, max: LANDING_QUEUE_LIMITS.branch });
    const taskId = checkTaskId(command.taskId);
    if (!Number.isSafeInteger(command.round) || command.round < 0 || !Number.isSafeInteger(command.cap) || command.cap < 0) throw new DomainError("invalid_command", "round and cap must be whole numbers");
    const queueId = LandingQueueService.queueIdOf(projectId, branch);
    let already = false;
    try { await retried(() => this.#runner.command("landing.queue.reserve", { commandId: command.commandId, actor: command.actor }, async () => ({
      payload: { projectId, branch, taskId, round: command.round, cap: command.cap },
      build: async () => {
        const current = await this.#runner.get(KIND, queueId);
        const q = (current?.body as unknown as LandingQueueBody | undefined) ?? { projectId, branch, nextSeq: 1, entries: [] };
        const reservations = [...(q.reservations ?? [])];
        already = reservations.some((r) => r.taskId === taskId);
        if (already) throw new DomainError("invalid_transition", NOTHING);
        {
          if (reservations.length >= LANDING_QUEUE_LIMITS.reservations) throw new DomainError("unavailable", `the landing queue of branch ${branch} already holds ${reservations.length} reservations, at most ${LANDING_QUEUE_LIMITS.reservations}`);
          const entry = q.entries.find((e) => e.taskId === taskId);
          const was = (q.away ?? []).find((a) => a.taskId === taskId);
          reservations.push({ taskId, seq: entry?.seq ?? was?.seq ?? q.nextSeq, since: this.#runner.now(), round: command.round, cap: command.cap });
        }
        const fresh = !q.entries.some((e) => e.taskId === taskId) && !(q.away ?? []).some((a) => a.taskId === taskId);
        const next = settled({ ...q, nextSeq: fresh ? q.nextSeq + 1 : q.nextSeq, reservations }, this.#runner.now());
        const ref: AggregateRef = { kind: KIND, id: queueId };
        return {
          ref, creates: current === undefined,
          changes: [current === undefined ? { type: "create", ref, body: json(next) } : { type: "update", ref, expectedRevision: current.revision, body: json(next) }],
          detail: { branch, taskId, round: command.round, cap: command.cap },
          contention: async () => new DomainError("stale_revision", RACE),
        };
      },
    }))); } catch (error) { if (!nothing(error)) throw error; }
    const r = (await this.get(projectId, branch)).reservations?.find((x) => x.taskId === taskId);
    if (r === undefined) throw new DomainError("invalid_transition", `task ${taskId} no longer holds a reserved place in the landing queue of branch ${branch} (it landed or was taken out)`);
    return { reservation: r, already };
  }

  /**
   * Marks that the director was told about the queue (card P10), so it is told once: `front` (the first task, first since `since`, held the branch too long) or `round` (a reserved task needed refresh round `round`
   * beyond its cap, in the reservation made at `since`). Answers whether this call made the mark (false: already marked, a repeat of the same mark, or the queue moved on: another task is first, or the task holds no
   * such reservation).
   */
  async markEscalated(command: { projectId: string; branch: string; taskId: string } & ({ kind: "front"; since: string } | { kind: "round"; round: number; since: string })): Promise<boolean> {
    const queueId = LandingQueueService.queueIdOf(command.projectId, command.branch);
    // The round mark is named by the reservation (its `since`) too: a later reservation of the same task is marked again.
    const key = command.kind === "front" ? `front:${command.since}` : `round:${command.since}:${command.round}`;
    let marked = false;
    try { marked = !(await retried(() => this.#runner.command("landing.queue.escalate", { commandId: `lq-escalate:${queueId}:${command.taskId}:${key}`.slice(0, 120), actor: "service:landing-queue" }, async () => ({
      payload: { projectId: command.projectId, branch: command.branch, taskId: command.taskId, key },
      build: async () => {
        const current = await this.#runner.get(KIND, queueId);
        const q = current?.body as unknown as LandingQueueBody | undefined;
        let next: LandingQueueBody | undefined;
        if (q !== undefined && command.kind === "front" && q.front !== undefined && q.front.taskId === command.taskId && q.front.since === command.since && q.front.escalated !== true) next = { ...q, front: { ...q.front, escalated: true } };
        const r = q?.reservations?.find((x) => x.taskId === command.taskId);
        if (q !== undefined && command.kind === "round" && r !== undefined && r.since === command.since && r.escalatedRound === undefined) next = { ...q, reservations: q.reservations!.map((x) => (x.taskId === command.taskId ? { ...x, escalatedRound: command.round } : x)) };
        if (next === undefined || current === undefined) throw new DomainError("invalid_transition", NOTHING);
        const ref: AggregateRef = { kind: KIND, id: queueId };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: json(next) }], detail: { taskId: command.taskId, key }, contention: async () => new DomainError("stale_revision", RACE) };
      },
    })))).replayed; } catch (error) { if (!nothing(error)) throw error; }
    return marked;
  }

  /**
   * Ends the reserved place of `taskId` when it has held the branch without an approved entry for `olderThanMs` or longer (card P10, eighth slice: no submission waits forever behind a place whose work was returned
   * to its author). The judgment is made INSIDE the write, on the stored record: the task must still be the first place (the same `front.since`), have no entry, hold the reservation, and have been idle since
   * `front.idleSince` for at least `olderThanMs` (a record without it, written before it existed, is not ended). Answers the reservation it ended, or undefined when the queue no longer shows that (another task is first, approved work came back, the
   * place was taken out, the time is not yet up, or a repeat of the same release). A later reservation of the task is a new one.
   */
  async releaseIdle(command: { projectId: string; branch: string; taskId: string; since: string; olderThanMs: number }): Promise<LandingReservation | undefined> {
    const queueId = LandingQueueService.queueIdOf(command.projectId, command.branch);
    let ended: LandingReservation | undefined;
    try { if ((await retried(() => this.#runner.command("landing.queue.release", { commandId: `lq-release:${queueId}:${command.taskId}:${command.since}`.slice(0, 120), actor: "service:landing-queue" }, async () => ({
      payload: { projectId: command.projectId, branch: command.branch, taskId: command.taskId, since: command.since },
      build: async () => {
        ended = undefined;
        const current = await this.#runner.get(KIND, queueId);
        const q = current?.body as unknown as LandingQueueBody | undefined;
        const first = q === undefined ? undefined : frontOf(q);
        // A record written before `idleSince` existed has none: its idle time is unknown, so nothing is ended until a write of the queue starts the clock (the first place's `since` may be a day as an approved entry).
        const idle = q?.front?.idleSince === undefined ? NaN : Date.parse(q.front.idleSince), now = Date.parse(this.#runner.now());
        const r = q?.reservations?.find((x) => x.taskId === command.taskId);
        if (q === undefined || current === undefined || r === undefined || first === undefined || first.taskId !== command.taskId || first.entry !== undefined || q.front?.taskId !== command.taskId || q.front.since !== command.since
          || !Number.isFinite(idle) || !Number.isFinite(now) || now - idle < command.olderThanMs) throw new DomainError("invalid_transition", NOTHING);
        ended = r;
        const ref: AggregateRef = { kind: KIND, id: queueId };
        const away = (q.away ?? []).filter((a) => a.taskId !== command.taskId);
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: json(settled({ ...q, reservations: q.reservations!.filter((x) => x.taskId !== command.taskId), away }, this.#runner.now())) }], detail: { taskId: command.taskId, released: true, since: command.since }, contention: async () => new DomainError("stale_revision", RACE) };
      },
    })))).replayed) ended = undefined; } catch (error) { if (!nothing(error)) throw error; ended = undefined; }
    return ended;
  }
}
