import { setTimeout as sleep } from "node:timers/promises";
import { commitOperation } from "../storage/commit.js";
import { isStorageError } from "../storage/errors.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject, OperationInput, OutboxEntry, TimerClaim } from "../storage/types.js";
import type { AssignmentService } from "./assignments.js";
import { fence as checkFence, type Fence } from "./assignment-model.js";
import { DomainError } from "./errors.js";
import { taskEventEntry } from "./events.js";
import { derivedId } from "./ids.js";
import { TRANSITIONS, onlyKnown, revision as checkRevision, taskId as checkTaskId, text, type TaskBody, type TaskState, type View } from "./model.js";
import { CommandRunner, mapStorageError, view, type Built, type CommandMeta, type CommandResult, type RunnerOptions } from "./runner.js";

/** Why a task is waiting. */
export type WaitReason = "inquiry" | "approval" | "review" | "external" | "dependency" | "input";
export const WAIT_REASONS: readonly WaitReason[] = ["inquiry", "approval", "review", "external", "dependency", "input"];
/** What happens when the deadline passes: put the task back to ready, cancel it, or leave it blocked and make the overdue wait visible. */
export type OnDeadline = "resume" | "cancel" | "escalate";
export const ON_DEADLINE: readonly OnDeadline[] = ["resume", "cancel", "escalate"];
export type WaitState = "open" | "answered" | "timed_out" | "cancelled";

/**
 * A typed wait (card S08): a task is blocked for a stated reason, on a named resolver, with either a deadline and what happens at it, or
 * an explicit indefinite hold with its owner. Every wait also says what happens when it is answered (`nextAction`), so a waiting task
 * always has a next action or an owner who has taken it on.
 */
export interface WaitBody {
  readonly taskId: string;
  readonly reason: WaitReason;
  /** Who can answer: a principal or role ID. */
  readonly resolver: string;
  readonly summary: string;
  /** What happens when it is answered. */
  readonly nextAction: string;
  readonly state: WaitState;
  readonly deadline?: string;
  readonly onDeadline?: OnDeadline;
  /** An explicit indefinite hold: the owner who has taken it on. */
  readonly indefinite?: { readonly owner: string };
  readonly openedBy: string;
  readonly openedAt: string;
  readonly closedAt?: string;
  readonly answer?: string;
  readonly answeredBy?: string;
  /** How a closed wait ended: `resumed` (answered), `timed_out_resumed`, `timed_out_cancelled`, `timed_out_escalated`, `cancelled`. */
  readonly outcome?: string;
}

interface SlotBody { readonly taskId: string; readonly openId?: string; /** The wait that closed last, so "why is this task still blocked" has an answer after the wait is over. */ readonly lastId?: string }

export interface OpenWait extends CommandMeta {
  readonly taskId: string;
  readonly reason: WaitReason;
  readonly resolver: string;
  readonly summary: string;
  readonly nextAction: string;
  /** With `onDeadline`; or give `indefinite` instead, never both. */
  readonly deadline?: string;
  readonly onDeadline?: OnDeadline;
  readonly indefinite?: { readonly owner: string };
  /** If the wait is opened on an attempt's behalf. */
  readonly fence?: Fence;
}
export interface AnswerWait extends CommandMeta { readonly waitId: string; readonly expectedRevision: number; readonly resolverId: string; readonly answer: string }
export interface CancelWait extends CommandMeta {
  readonly waitId: string;
  readonly expectedRevision: number;
  readonly reason: string;
  /** What becomes of the task: `cancel` it (the operation is cancelled), put it back to `resume`, or `leave` it exactly as it is. */
  readonly task: "cancel" | "resume" | "leave";
}

export const WAIT_LIMITS = { resolver: 120, summary: 1000, nextAction: 500, answer: 4000, reason: 500, owner: 120 } as const;
const WAIT_ID = /^wait-[a-z2-7]{20}$/;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const slotIdOf = (taskId: string): string => `ws-${taskId.slice(5)}`;
const timerIdOf = (waitId: string): string => `wt:${waitId}`;

export interface DueReport { readonly timedOut: number; readonly resumed: number; readonly cancelled: number; readonly escalated: number; readonly alreadyClosed: number }

/**
 * Typed waits and deadline settlement (card S08).
 *
 * - **Opening** blocks the task in the same transaction (the task event is written too) and schedules the deadline timer; a wait without
 *   both a deadline with its outcome and, failing that, an explicit indefinite owner is refused. One open wait per task.
 * - **Answering** is allowed only for the named resolver while the wait is open; it releases the task and cancels the timer in one
 *   transaction. An answer to a wait that has closed (timed out, cancelled) or whose task has been cancelled is refused (`wait_closed`) and
 *   changes nothing, so a late answer can never revive cancelled work.
 * - **Deadlines** are settled by `settleDue`: the timer is claimed, then completed in the same transaction that closes the wait and
 *   applies `onDeadline` to the task. An answer and a deadline racing are decided by the storage revision: one commits.
 * - **Nothing waits invisibly.** `findUnexplainedBlocks` lists blocked tasks that have neither an open wait nor an open blocker.
 */
export class WaitService {
  readonly #runner: CommandRunner;
  readonly #assignments: AssignmentService | undefined;
  readonly #options: RunnerOptions;

  private constructor(runner: CommandRunner, assignments: AssignmentService | undefined, options: RunnerOptions) {
    this.#runner = runner;
    this.#assignments = assignments;
    this.#options = options;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, assignments: AssignmentService | undefined, options: RunnerOptions = {}): WaitService {
    return new WaitService(new CommandRunner(storage, epoch, options), assignments, options);
  }

  get epoch(): number { return this.#runner.epoch; }

  openWait(command: OpenWait): Promise<CommandResult> {
    return this.#runner.command("wait.open", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "taskId", "reason", "resolver", "summary", "nextAction", "deadline", "onDeadline", "indefinite", "fence"]);
      const taskId = checkTaskId(command.taskId);
      const reason = (WAIT_REASONS as readonly string[]).includes(command.reason) ? command.reason : invalid("reason", `must be one of ${WAIT_REASONS.join(", ")}`);
      const resolver = text(command.resolver, "resolver", { min: 1, max: WAIT_LIMITS.resolver });
      const summary = text(command.summary, "summary", { min: 1, max: WAIT_LIMITS.summary, multiline: true });
      const nextAction = text(command.nextAction, "nextAction", { min: 1, max: WAIT_LIMITS.nextAction });
      const timed = command.deadline !== undefined || command.onDeadline !== undefined;
      if (timed === (command.indefinite !== undefined)) invalid("deadline", "a wait needs either a deadline with what happens at it (onDeadline), or an explicit indefinite hold with its owner, and not both");
      let deadline: string | undefined;
      let onDeadline: OnDeadline | undefined;
      let indefinite: { owner: string } | undefined;
      if (timed) {
        deadline = typeof command.deadline === "string" && TIMESTAMP.test(command.deadline) ? command.deadline : invalid("deadline", "must be a UTC timestamp such as 2026-10-20T12:00:00.000Z");
        onDeadline = (ON_DEADLINE as readonly string[]).includes(command.onDeadline as string) ? command.onDeadline : invalid("onDeadline", `must be one of ${ON_DEADLINE.join(", ")}`);
      } else {
        const hold = command.indefinite as { owner?: unknown };
        if (hold === null || typeof hold !== "object" || Array.isArray(hold)) invalid("indefinite", "must be an object with an owner");
        for (const key of Object.keys(hold)) if (key !== "owner") invalid(`indefinite.${key}`, "is not a field of an indefinite hold");
        indefinite = { owner: text(hold.owner, "indefinite.owner", { min: 1, max: WAIT_LIMITS.owner }) };
      }
      const fence = command.fence === undefined ? undefined : checkFence(command.fence);
      if (fence !== undefined && this.#assignments === undefined) invalid("fence", "cannot be checked: this service has no assignment service");
      return {
        payload: { taskId, reason, resolver, summary, nextAction, ...(deadline === undefined ? {} : { deadline }), ...(onDeadline === undefined ? {} : { onDeadline }), ...(indefinite === undefined ? {} : { indefinite }), ...(fence === undefined ? {} : { fence: fence as unknown as JsonObject }) } as JsonObject,
        build: async () => {
          const task = await this.#runner.get("task", taskId);
          if (task === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
          const taskBody = task.body as unknown as TaskBody;
          if (taskBody.state !== "ready" && taskBody.state !== "in_progress") throw new DomainError("invalid_command", `task ${taskId} is ${taskBody.state}; only a ready or in-progress task can start waiting`, { field: "taskId" });
          const slotRef: AggregateRef = { kind: "wait-slot", id: slotIdOf(taskId) };
          const slot = await this.#runner.get(slotRef.kind, slotRef.id);
          const openId = (slot?.body as unknown as SlotBody | undefined)?.openId;
          if (openId !== undefined) throw new DomainError("invalid_command", `task ${taskId} is already waiting (${openId}); answer or cancel that wait first`, { field: "taskId" });
          const guard = fence === undefined ? undefined : await this.#assignments!.guardFor(fence).check(taskId);
          const id = derivedId("wait", meta.commandId);
          const ref: AggregateRef = { kind: "wait", id };
          const body: WaitBody = { taskId, reason, resolver, summary, nextAction, state: "open", ...(deadline === undefined ? {} : { deadline }), ...(onDeadline === undefined ? {} : { onDeadline }), ...(indefinite === undefined ? {} : { indefinite }), openedBy: meta.actor, openedAt: this.#runner.now() };
          const blocked: TaskBody = { ...taskBody, state: "blocked" };
          const nextSlot: SlotBody = { taskId, openId: id };
          const changes: Change[] = [
            { type: "create", ref, body: body as unknown as JsonObject },
            slot === undefined ? { type: "create", ref: slotRef, body: nextSlot as unknown as JsonObject } : { type: "update", ref: slotRef, expectedRevision: slot.revision, body: nextSlot as unknown as JsonObject },
            { type: "update", ref: { kind: "task", id: taskId }, expectedRevision: task.revision, body: blocked as unknown as JsonObject },
            ...(guard?.changes ?? []),
          ];
          return {
            ref, creates: true, changes,
            detail: { taskId, reason, resolver, ...(deadline === undefined ? { indefinite: true } : { deadline, onDeadline: onDeadline as string }), ...(guard?.detail ?? {}) },
            outbox: [taskEventEntry(taskId, blocked, task.revision + 1, "transitioned", taskBody.state)],
            ...(deadline === undefined ? {} : { timers: [{ timerId: timerIdOf(id), dueAt: deadline, aggregate: ref, payload: { waitId: id } }] }),
            contention: async () => new DomainError("stale_revision", `task ${taskId} changed or started waiting meanwhile; read it again`),
          };
        },
      };
    });
  }

  /** The named resolver answers an open wait: the task is released and the deadline cancelled. */
  answerWait(command: AnswerWait): Promise<CommandResult> {
    return this.#runner.command("wait.answer", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "waitId", "expectedRevision", "resolverId", "answer"]);
      const waitId = this.#waitId(command.waitId);
      const expected = checkRevision(command.expectedRevision);
      const resolverId = text(command.resolverId, "resolverId", { min: 1, max: WAIT_LIMITS.resolver });
      const answer = text(command.answer, "answer", { min: 1, max: WAIT_LIMITS.answer, multiline: true });
      return {
        payload: { waitId, expectedRevision: expected, resolverId, answer },
        build: async () => {
          const current = await this.#runner.existing("wait", waitId, expected);
          const wait = current.body as unknown as WaitBody;
          if (wait.state !== "open") throw new DomainError("wait_closed", `wait ${waitId} is ${wait.state}; the answer was not applied`, { field: "waitId" });
          if (wait.resolver !== resolverId) throw new DomainError("invalid_command", `wait ${waitId} is for ${wait.resolver}, not ${resolverId}`, { field: "resolverId" });
          const task = await this.#runner.get("task", wait.taskId);
          const taskBody = task?.body as unknown as TaskBody | undefined;
          if (task === undefined || taskBody === undefined || taskBody.state !== "blocked") throw new DomainError("wait_closed", `task ${wait.taskId} is ${taskBody?.state ?? "missing"}, not waiting; the answer was not applied`, { field: "waitId" });
          const next: WaitBody = { ...wait, state: "answered", answer, answeredBy: meta.actor, closedAt: this.#runner.now(), outcome: "resumed" };
          return this.#close(waitId, current.revision, next, wait.taskId, task.revision, taskBody, "ready", { answeredBy: meta.actor });
        },
      };
    });
  }

  /** Cancels an open wait and either cancels the task (the operation is cancelled) or resumes it. Later answers are refused. */
  cancelWait(command: CancelWait): Promise<CommandResult> {
    return this.#runner.command("wait.cancel", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "waitId", "expectedRevision", "reason", "task"]);
      const waitId = this.#waitId(command.waitId);
      const expected = checkRevision(command.expectedRevision);
      const reason = text(command.reason, "reason", { min: 1, max: WAIT_LIMITS.reason });
      if (command.task !== "cancel" && command.task !== "resume" && command.task !== "leave") invalid("task", "must be cancel, resume or leave");
      const taskOutcome = command.task;
      return {
        payload: { waitId, expectedRevision: expected, reason, task: taskOutcome },
        build: async () => {
          const current = await this.#runner.existing("wait", waitId, expected);
          const wait = current.body as unknown as WaitBody;
          if (wait.state !== "open") throw new DomainError("wait_closed", `wait ${waitId} is already ${wait.state}`, { field: "waitId" });
          const task = await this.#runner.get("task", wait.taskId);
          const taskBody = task?.body as unknown as TaskBody | undefined;
          const next: WaitBody = { ...wait, state: "cancelled", closedAt: this.#runner.now(), outcome: "cancelled" };
          return this.#close(waitId, current.revision, next, wait.taskId, task?.revision, taskBody, taskOutcome === "cancel" ? "cancelled" : taskOutcome === "resume" ? "ready" : undefined, { reason, cancelledBy: meta.actor });
        },
      };
    });
  }

  /**
   * Settles waits whose deadline has passed: claims due timers (`now` is the service clock) and, for each, in one transaction completes the
   * timer, closes the wait as timed out and applies its `onDeadline` to the task. A timer whose wait has meanwhile closed is just completed.
   */
  async settleDue(options: { limit?: number; leaseMs?: number; claimant?: string } = {}): Promise<DueReport> {
    let claims: TimerClaim[];
    const now = this.#runner.now();
    try {
      claims = await this.#runner.storage.claimDueTimers({ epoch: this.#runner.epoch, claimant: options.claimant ?? "waits", now, leaseMs: options.leaseMs ?? 60_000, limit: options.limit ?? 50 });
    } catch (error) { throw mapStorageError(error); }
    let timedOut = 0, resumed = 0, cancelled = 0, escalated = 0, alreadyClosed = 0;
    for (const claim of claims) {
      const waitId = (claim.payload as { waitId?: string }).waitId;
      if (typeof waitId !== "string" || !WAIT_ID.test(waitId)) { await this.#completeOnly(claim); alreadyClosed++; continue; }
      for (let tries = 0; tries < 5; tries++) {
        const wait = await this.#runner.get("wait", waitId);
        const body = wait?.body as unknown as WaitBody | undefined;
        if (wait === undefined || body === undefined || body.state !== "open") { await this.#completeOnly(claim); alreadyClosed++; break; }
        const task = await this.#runner.get("task", body.taskId);
        const taskBody = task?.body as unknown as TaskBody | undefined;
        const onDeadline = body.onDeadline ?? "escalate";
        const next: WaitBody = { ...body, state: "timed_out", closedAt: now, outcome: `timed_out_${onDeadline === "resume" ? "resumed" : onDeadline === "cancel" ? "cancelled" : "escalated"}` };
        const targetState: TaskState | undefined = onDeadline === "resume" ? "ready" : onDeadline === "cancel" ? "cancelled" : undefined;
        const built = await this.#close(waitId, wait.revision, next, body.taskId, task?.revision, taskBody, targetState, { onDeadline });
        const input: OperationInput = {
          operationId: `due:${waitId}`, epoch: this.#runner.epoch, actor: options.claimant ?? "waits", correlationId: `due:${waitId}`, at: now,
          changes: built.changes, audit: [{ type: "wait.deadline", subject: built.ref, detail: { onDeadline, ...built.detail } }],
          outbox: built.outbox ?? [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [],
          completeTimers: [{ timerId: claim.timerId, claimToken: claim.claimToken }], settleEffects: [],
        };
        try {
          await commitOperation(this.#runner.storage, input, { attempts: 5, pause: this.#options.pause ?? ((n) => sleep(Math.min(200, 10 * 2 ** n))) });
        } catch (error) {
          if (isStorageError(error, "revision_conflict")) continue; // the wait or task moved (an answer won): look again
          if (isStorageError(error, "state_conflict") || isStorageError(error, "not_found")) break; // the timer was cancelled or taken over
          throw mapStorageError(error);
        }
        timedOut++;
        if (onDeadline === "resume") resumed++; else if (onDeadline === "cancel") cancelled++; else escalated++;
        break;
      }
    }
    return { timedOut, resumed, cancelled, escalated, alreadyClosed };
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------------

  async getWait(id: string): Promise<View<WaitBody> | undefined> {
    const found = await this.#runner.get("wait", this.#waitId(id));
    return found === undefined ? undefined : view<WaitBody>(found);
  }

  /** The open wait of a task, if any. */
  async openFor(taskId: string): Promise<View<WaitBody> | undefined> {
    const slot = await this.#runner.get("wait-slot", slotIdOf(checkTaskId(taskId)));
    const openId = (slot?.body as unknown as SlotBody | undefined)?.openId;
    return openId === undefined ? undefined : this.getWait(openId);
  }

  /** The wait of this task that closed most recently, if any. */
  async lastFor(taskId: string): Promise<View<WaitBody> | undefined> {
    const slot = await this.#runner.get("wait-slot", slotIdOf(checkTaskId(taskId)));
    const lastId = (slot?.body as unknown as SlotBody | undefined)?.lastId;
    return lastId === undefined ? undefined : this.getWait(lastId);
  }

  /** Waits in ID order after `afterId`, optionally only the given states. */
  async list(query: { afterId?: string; limit: number; states?: readonly WaitState[] }): Promise<{ items: View<WaitBody>[]; next?: string }> {
    const items: View<WaitBody>[] = [];
    let after = query.afterId;
    for (let reads = 0; reads < 20; reads++) {
      const page = await this.#runner.list("wait", { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const aggregate of page) {
        after = aggregate.id;
        if (query.states !== undefined && !query.states.includes((aggregate.body as unknown as WaitBody).state)) continue;
        items.push(view<WaitBody>(aggregate));
        if (items.length >= query.limit) return { items, next: aggregate.id };
      }
      if (page.length < 500) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }

  // ---- plumbing --------------------------------------------------------------------------------------------------------------

  #waitId(value: unknown): string {
    return typeof value === "string" && WAIT_ID.test(value) ? value : invalid("waitId", "is not a wait ID");
  }

  /** The changes that close a wait: the wait, its slot, the task (to `target`, if it is blocked and a target is given) and the timer. */
  async #close(waitId: string, waitRevision: number, next: WaitBody, taskId: string, taskRevision: number | undefined, task: TaskBody | undefined, target: TaskState | undefined, detail: JsonObject): Promise<Built> {
    const ref: AggregateRef = { kind: "wait", id: waitId };
    const slotRef: AggregateRef = { kind: "wait-slot", id: slotIdOf(taskId) };
    const slot = await this.#runner.get(slotRef.kind, slotRef.id);
    const { openId, ...rest } = (slot?.body ?? {}) as unknown as SlotBody;
    const cleared: SlotBody = { ...rest, lastId: waitId };
    if (slot === undefined || openId !== waitId) {
      // Either a concurrent command closed this wait between our read of it and our read of the slot (a lost race), or the records disagree.
      const now = await this.#runner.get("wait", waitId);
      if (now === undefined || now.revision !== waitRevision) throw new DomainError("wait_closed", `wait ${waitId} was closed meanwhile`, { field: "waitId" });
      throw new DomainError("integrity", `wait ${waitId} is open but the slot of task ${taskId} names ${openId ?? "no wait"}`);
    }
    const changes: Change[] = [
      { type: "update", ref, expectedRevision: waitRevision, body: next as unknown as JsonObject },
      { type: "update", ref: slotRef, expectedRevision: slot.revision, body: cleared as unknown as JsonObject },
    ];
    const outbox: OutboxEntry[] = [];
    if (task !== undefined && taskRevision !== undefined && task.state === "blocked" && target !== undefined && (TRANSITIONS.blocked as readonly string[]).includes(target)) {
      const moved: TaskBody = { ...task, state: target };
      changes.push({ type: "update", ref: { kind: "task", id: taskId }, expectedRevision: taskRevision, body: moved as unknown as JsonObject });
      outbox.push(taskEventEntry(taskId, moved, taskRevision + 1, "transitioned", "blocked"));
    }
    return { ref, creates: false, changes, detail: { waitId, state: next.state, ...detail }, outbox, cancelTimers: next.deadline === undefined ? [] : [timerIdOf(waitId)] };
  }

  async #completeOnly(claim: TimerClaim): Promise<void> {
    const input: OperationInput = {
      operationId: `due-closed:${claim.timerId}`, epoch: this.#runner.epoch, actor: "waits", correlationId: `due-closed:${claim.timerId}`, at: this.#runner.now(),
      changes: [], audit: [{ type: "wait.timer.closed", detail: { timerId: claim.timerId } }], outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [],
      completeTimers: [{ timerId: claim.timerId, claimToken: claim.claimToken }], settleEffects: [],
    };
    try { await commitOperation(this.#runner.storage, input, { attempts: 5 }); } catch (error) {
      if (isStorageError(error, "state_conflict") || isStorageError(error, "not_found") || isStorageError(error, "idempotency_conflict")) return;
      throw mapStorageError(error);
    }
  }
}
