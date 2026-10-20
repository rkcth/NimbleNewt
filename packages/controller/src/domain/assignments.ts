import type { AggregateRef, Change, ControllerStorage, JsonObject, OutboxEntry } from "../storage/types.js";
import { DomainError } from "./errors.js";
import { derivedId } from "./ids.js";
import {
  ASSIGNMENT_LIMITS, activityIdOf, assignmentIdOf, attemptId as checkAttemptId, fence as checkFence, generation as checkGeneration, generationIdOf, owner as checkOwner, sameOwner,
  type ActivityBody, type AssignmentBody, type AttemptBody, type AttemptState, type Fence, type GenerationBody, type Owner,
} from "./assignment-model.js";
import { CommandRunner, defined, view, type Built, type CommandMeta, type CommandResult, type RunnerOptions } from "./runner.js";
import { onlyKnown, revision as checkRevision, taskId as checkTaskId, text, type TaskBody, type View } from "./model.js";
import type { FenceGuard, ProjectService, TransitionTask, UpdateTask } from "./service.js";

/** The outbox destination of assignment events (cards S02, S04). */
export const ASSIGNMENT_EVENTS = "assignment-events";

/** What an assignment event says: the assignment of the task is now at `revision`, in this state, with this owner and active attempt. A snapshot, like task events. */
export interface AssignmentEvent {
  readonly taskId: string;
  readonly revision: number;
  readonly generation: number;
  readonly state: string;
  readonly owner?: Owner;
  readonly activeAttemptId?: string;
  readonly change: "assigned" | "transferred" | "released" | "attempt_admitted" | "attempt_finished";
}
export const assignmentEventId = (taskId: string, revision: number): string => `asv:${taskId}:${revision}`;

export interface AssignTask extends CommandMeta {
  readonly taskId: string;
  /** Required exactly when the task has an assignment (released): the assignment's revision. Absent for a task never assigned. */
  readonly expectedRevision?: number;
  readonly owner: Owner;
  readonly reason?: string;
}
export interface TransferTask extends CommandMeta { readonly taskId: string; readonly expectedRevision: number; readonly to: Owner; readonly reason?: string }
export interface ReleaseTask extends CommandMeta { readonly taskId: string; readonly expectedRevision: number; readonly reason?: string }
export interface AdmitAttempt extends CommandMeta {
  readonly taskId: string;
  readonly expectedRevision: number;
  /** The generation the claimant believes is current, and the claimant, which must be that generation's owner. */
  readonly generation: number;
  readonly owner: Owner;
}
export interface FinishAttempt extends CommandMeta {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly fence: Fence;
  readonly outcome: "succeeded" | "failed" | "abandoned";
  readonly summary?: string;
}
export interface ObserveActivity extends CommandMeta {
  readonly taskId: string;
  /** Who was seen (a worker or agent ID). */
  readonly observedBy: string;
  /** The generation that worker said it was working under. */
  readonly generation: number;
  readonly kind: string;
  readonly detail?: string;
}
export type FencedTransition = TransitionTask & { readonly fence: Fence };
export type FencedUpdate = UpdateTask & { readonly fence: Fence };

const FINAL = new Set(["done", "cancelled"]);

/**
 * Who may write to a task, and which attempt (card S02).
 *
 * - **One valid writer.** A task has at most one current assignment (an owner and a generation) and at most one active attempt. Admission
 *   of an attempt is a revision-guarded write of the assignment record, so of two competing admissions exactly one commits; the other is
 *   refused (`stale_revision`, or `invalid_command` once it sees the winner).
 * - **Fencing.** A mutation made on behalf of an owner carries a `Fence` (generation and attempt). It is checked in the same storage
 *   transaction as the task change, guarded by the assignment's revision: after a transfer or release the old fence fails (`fenced`) and
 *   a mutation racing with the transfer either commits before it or fails, never after. The unfenced commands of `ProjectService` are
 *   the controller's own (and the owner's) path; until permissions exist (card A01) nothing stops a caller from using them.
 * - **History.** Every generation is an immutable record, so who owned the task, from when and why, is kept in order.
 * - **Observation is not ownership.** `observeActivity` records that a worker was seen working, whatever generation it claims; it
 *   never changes the assignment, and it is marked `current` only when the generation matches.
 */
export class AssignmentService {
  readonly #runner: CommandRunner;
  readonly #projects: ProjectService;

  private constructor(runner: CommandRunner, projects: ProjectService) {
    this.#runner = runner;
    this.#projects = projects;
  }

  /** The service writes under `epoch` (the controller's one epoch, shared with `projects`). */
  static withEpoch(storage: ControllerStorage, epoch: number, projects: ProjectService, options: RunnerOptions = {}): AssignmentService {
    if (projects.epoch !== epoch) throw new DomainError("invalid_command", "epoch: must be the epoch the project service writes under", { field: "epoch" });
    return new AssignmentService(new CommandRunner(storage, epoch, options), projects);
  }

  get epoch(): number { return this.#runner.epoch; }

  // ---- assignment ----------------------------------------------------------------------------------------------------------

  assignTask(command: AssignTask): Promise<CommandResult> {
    return this.#runner.command("task.assign", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "taskId", "expectedRevision", "owner", "reason"]);
      const taskId = checkTaskId(command.taskId);
      const expected = command.expectedRevision === undefined ? undefined : checkRevision(command.expectedRevision);
      const who = checkOwner(command.owner);
      const reason = command.reason === undefined ? undefined : text(command.reason, "reason", { min: 1, max: ASSIGNMENT_LIMITS.reason });
      return {
        payload: defined({ taskId, expectedRevision: expected, owner: who as unknown as JsonObject, reason }),
        build: async (): Promise<Built> => {
          await this.#openTask(taskId);
          const ref: AggregateRef = { kind: "assignment", id: assignmentIdOf(taskId) };
          const current = await this.#runner.get("assignment", ref.id);
          if (current === undefined) {
            if (expected !== undefined) throw new DomainError("not_found", `task ${taskId} has never been assigned, so there is no assignment revision to expect`, { field: "expectedRevision" });
            const body: AssignmentBody = { taskId, generation: 1, state: "assigned", owner: who, attempts: 0 };
            return this.#built(ref, true, taskId, body, 1, "assigned", [{ type: "create", ref, body: body as unknown as JsonObject }],
              this.#generationChange(taskId, 1, who, meta.actor, "assigned", undefined, reason), { owner: who as unknown as JsonObject, generation: 1 });
          }
          const body = current.body as unknown as AssignmentBody;
          if (expected === undefined) throw new DomainError("stale_revision", `task ${taskId} already has an assignment (at revision ${current.revision}); pass its revision to assign it again`, { currentRevision: current.revision, field: "expectedRevision" });
          await this.#runner.existing("assignment", ref.id, expected);
          if (body.state === "assigned") throw new DomainError("invalid_command", `task ${taskId} is assigned to ${body.owner?.kind}:${body.owner?.id}; transfer it or release it first`, { field: "taskId" });
          const next: AssignmentBody = { taskId, generation: body.generation + 1, state: "assigned", owner: who, attempts: body.attempts };
          return this.#built(ref, false, taskId, next, current.revision + 1, "assigned", [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }],
            this.#generationChange(taskId, next.generation, who, meta.actor, "reassigned", undefined, reason), { owner: who as unknown as JsonObject, generation: next.generation });
        },
      };
    });
  }

  transferTask(command: TransferTask): Promise<CommandResult> {
    return this.#runner.command("task.transfer", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "taskId", "expectedRevision", "to", "reason"]);
      const taskId = checkTaskId(command.taskId);
      const expected = checkRevision(command.expectedRevision);
      const to = checkOwner(command.to, "to");
      const reason = command.reason === undefined ? undefined : text(command.reason, "reason", { min: 1, max: ASSIGNMENT_LIMITS.reason });
      return {
        payload: defined({ taskId, expectedRevision: expected, to: to as unknown as JsonObject, reason }),
        build: async (): Promise<Built> => {
          await this.#openTask(taskId);
          const ref: AggregateRef = { kind: "assignment", id: assignmentIdOf(taskId) };
          const current = await this.#runner.existing("assignment", ref.id, expected);
          const body = current.body as unknown as AssignmentBody;
          if (body.state !== "assigned" || body.owner === undefined) throw new DomainError("invalid_command", `task ${taskId} is not assigned, so it cannot be transferred; assign it`, { field: "taskId" });
          const next: AssignmentBody = { taskId, generation: body.generation + 1, state: "assigned", owner: to, attempts: body.attempts };
          const changes: Change[] = [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }, ...this.#generationChange(taskId, next.generation, to, meta.actor, "transferred", body.owner, reason)];
          changes.push(...(await this.#endAttempt(body.activeAttemptId, "superseded")));
          return this.#built(ref, false, taskId, next, current.revision + 1, "transferred", changes, [], { from: body.owner as unknown as JsonObject, to: to as unknown as JsonObject, generation: next.generation });
        },
      };
    });
  }

  releaseTask(command: ReleaseTask): Promise<CommandResult> {
    return this.#runner.command("task.release", command, async () => {
      onlyKnown(command, ["commandId", "actor", "taskId", "expectedRevision", "reason"]);
      const taskId = checkTaskId(command.taskId);
      const expected = checkRevision(command.expectedRevision);
      const reason = command.reason === undefined ? undefined : text(command.reason, "reason", { min: 1, max: ASSIGNMENT_LIMITS.reason });
      return {
        payload: defined({ taskId, expectedRevision: expected, reason }),
        build: async (): Promise<Built> => {
          const ref: AggregateRef = { kind: "assignment", id: assignmentIdOf(taskId) };
          const current = await this.#runner.existing("assignment", ref.id, expected);
          const body = current.body as unknown as AssignmentBody;
          if (body.state !== "assigned") throw new DomainError("invalid_command", `task ${taskId} is already released`, { field: "taskId" });
          const { owner: _o, activeAttemptId: _a, ...rest } = body;
          const next: AssignmentBody = { ...rest, state: "released" };
          const changes: Change[] = [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }, ...(await this.#endAttempt(body.activeAttemptId, "released"))];
          return this.#built(ref, false, taskId, next, current.revision + 1, "released", changes, [], defined({ generation: body.generation, reason }));
        },
      };
    });
  }

  // ---- attempts --------------------------------------------------------------------------------------------------------------

  /** Admits the owner's attempt. Of two competing admissions on the same assignment revision, one commits. */
  admitAttempt(command: AdmitAttempt): Promise<CommandResult> {
    return this.#runner.command("attempt.admit", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "taskId", "expectedRevision", "generation", "owner"]);
      const taskId = checkTaskId(command.taskId);
      const expected = checkRevision(command.expectedRevision);
      const claimedGeneration = checkGeneration(command.generation);
      const who = checkOwner(command.owner);
      return {
        payload: { taskId, expectedRevision: expected, generation: claimedGeneration, owner: who as unknown as JsonObject },
        build: async (): Promise<Built> => {
          const { body: task, revision: taskRevision } = await this.#openTask(taskId);
          if (task.state !== "ready" && task.state !== "in_progress") throw new DomainError("invalid_command", `task ${taskId} is ${task.state}; only a ready or in-progress task can be worked on`, { field: "taskId" });
          const ref: AggregateRef = { kind: "assignment", id: assignmentIdOf(taskId) };
          const current = await this.#runner.existing("assignment", ref.id, expected);
          const body = current.body as unknown as AssignmentBody;
          if (body.state !== "assigned" || body.owner === undefined || body.generation !== claimedGeneration || !sameOwner(body.owner, who)) {
            throw new DomainError("fenced", `generation ${claimedGeneration} of ${who.kind}:${who.id} does not own task ${taskId} now (${body.state === "assigned" ? `generation ${body.generation} is owned by ${body.owner?.kind}:${body.owner?.id}` : `it is ${body.state}`})`, { field: "generation" });
          }
          if (body.activeAttemptId !== undefined) throw new DomainError("invalid_command", `task ${taskId} already has an active attempt ${body.activeAttemptId}`, { field: "taskId" });
          const id = derivedId("att", meta.commandId);
          const attempt: AttemptBody = { taskId, generation: body.generation, owner: body.owner, number: body.attempts + 1, state: "active", admittedBy: meta.actor };
          const next: AssignmentBody = { ...body, activeAttemptId: id, attempts: body.attempts + 1 };
          const attemptRef: AggregateRef = { kind: "attempt", id };
          const built = this.#built(ref, false, taskId, next, current.revision + 1, "attempt_admitted",
            [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }, { type: "create", ref: attemptRef, body: attempt as unknown as JsonObject }, { type: "check", ref: { kind: "task", id: taskId }, expectedRevision: taskRevision }], [], { attemptId: id, number: attempt.number, generation: body.generation });
          // The command's result is the attempt, which is what the caller needs; contention on the assignment is a stale revision, not a command conflict.
          return { ...built, ref: attemptRef, creates: true, contention: () => this.#staleAssignment(ref, taskId) };
        },
      };
    });
  }

  /** Ends the active attempt. Only the generation and attempt that are current may do it (`fenced` otherwise). */
  finishAttempt(command: FinishAttempt): Promise<CommandResult> {
    return this.#runner.command("attempt.finish", command, async () => {
      onlyKnown(command, ["commandId", "actor", "taskId", "expectedRevision", "fence", "outcome", "summary"]);
      const taskId = checkTaskId(command.taskId);
      const expected = checkRevision(command.expectedRevision);
      const fence = checkFence(command.fence);
      if (command.outcome !== "succeeded" && command.outcome !== "failed" && command.outcome !== "abandoned") throw new DomainError("invalid_command", "outcome: must be succeeded, failed or abandoned", { field: "outcome" });
      const outcome = command.outcome;
      const summary = command.summary === undefined ? undefined : text(command.summary, "summary", { min: 1, max: ASSIGNMENT_LIMITS.summary, multiline: true });
      return {
        payload: defined({ taskId, expectedRevision: expected, fence: fence as unknown as JsonObject, outcome, summary }),
        build: async (): Promise<Built> => {
          const ref: AggregateRef = { kind: "assignment", id: assignmentIdOf(taskId) };
          const current = await this.#runner.existing("assignment", ref.id, expected);
          const body = current.body as unknown as AssignmentBody;
          this.#requireFence(body, fence, taskId);
          const attemptAggregate = await this.#runner.get("attempt", fence.attemptId);
          if (attemptAggregate === undefined) throw new DomainError("not_found", `attempt ${fence.attemptId} does not exist`);
          const attempt = attemptAggregate.body as unknown as AttemptBody;
          const { activeAttemptId: _a, ...rest } = body;
          const next: AssignmentBody = rest;
          const ended: AttemptBody = { ...attempt, state: outcome, ...(summary === undefined ? {} : { summary }) };
          return this.#built(ref, false, taskId, next, current.revision + 1, "attempt_finished",
            [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }, { type: "update", ref: { kind: "attempt", id: fence.attemptId }, expectedRevision: attemptAggregate.revision, body: ended as unknown as JsonObject }],
            [], { attemptId: fence.attemptId, outcome });
        },
      };
    });
  }

  // ---- fenced task mutations -------------------------------------------------------------------------------------------------

  /** `ProjectService.transitionTask` made on behalf of an owner: refused with `fenced` unless the fence is current, atomically with the change. */
  transitionTask(command: FencedTransition): Promise<CommandResult> {
    const { fence, ...rest } = command;
    return this.#projects.transitionTask(rest, this.#guard(command.taskId, fence));
  }

  updateTask(command: FencedUpdate): Promise<CommandResult> {
    const { fence, ...rest } = command;
    return this.#projects.updateTask(rest, this.#guard(command.taskId, fence));
  }

  // ---- observed activity -----------------------------------------------------------------------------------------------------

  /** Records that a worker was seen working on a task. Never changes ownership; `current` says whether its generation was the current one. */
  observeActivity(command: ObserveActivity): Promise<CommandResult> {
    return this.#runner.command("task.activity", command, async () => {
      onlyKnown(command, ["commandId", "actor", "taskId", "observedBy", "generation", "kind", "detail"]);
      const taskId = checkTaskId(command.taskId);
      const observedBy = text(command.observedBy, "observedBy", { min: 1, max: ASSIGNMENT_LIMITS.ownerId });
      const claimed = checkGeneration(command.generation);
      const kind = text(command.kind, "kind", { min: 1, max: ASSIGNMENT_LIMITS.activityKind });
      const detail = command.detail === undefined ? "" : text(command.detail, "detail", { min: 0, max: ASSIGNMENT_LIMITS.activityDetail });
      return {
        payload: { taskId, observedBy, generation: claimed, kind, detail },
        build: async (): Promise<Built> => {
          await this.#openTask(taskId);
          const assignment = await this.#runner.get("assignment", assignmentIdOf(taskId));
          const body = assignment?.body as unknown as AssignmentBody | undefined;
          const current = body !== undefined && body.state === "assigned" && body.generation === claimed;
          const ref: AggregateRef = { kind: "activity", id: activityIdOf(taskId) };
          const previous = await this.#runner.get("activity", ref.id);
          const observations = ((previous?.body as unknown as ActivityBody | undefined)?.observations ?? 0) + 1;
          const next: ActivityBody = { taskId, observedBy, generation: claimed, current, kind, detail, observedAt: this.#runner.now(), observations };
          const change: Change = previous === undefined
            ? { type: "create", ref, body: next as unknown as JsonObject }
            : { type: "update", ref, expectedRevision: previous.revision, body: next as unknown as JsonObject };
          return { ref, creates: previous === undefined, changes: [change], detail: { observedBy, generation: claimed, current }, contention: () => this.#staleActivity(ref) };
        },
      };
    });
  }

  // ---- reads -----------------------------------------------------------------------------------------------------------------

  async getAssignment(taskId: string): Promise<View<AssignmentBody> | undefined> {
    const found = await this.#runner.get("assignment", assignmentIdOf(checkTaskId(taskId)));
    return found === undefined ? undefined : view<AssignmentBody>(found);
  }

  async getAttempt(id: string): Promise<View<AttemptBody> | undefined> {
    const found = await this.#runner.get("attempt", checkAttemptId(id));
    return found === undefined ? undefined : view<AttemptBody>(found);
  }

  async getActivity(taskId: string): Promise<View<ActivityBody> | undefined> {
    const found = await this.#runner.get("activity", activityIdOf(checkTaskId(taskId)));
    return found === undefined ? undefined : view<ActivityBody>(found);
  }

  /** Every generation of the task's ownership, oldest first. */
  async history(taskId: string): Promise<View<GenerationBody>[]> {
    const id = checkTaskId(taskId);
    const prefix = `agen-${id.slice(5)}-`;
    const out: View<GenerationBody>[] = [];
    let after = prefix;
    for (;;) {
      const page = await this.#runner.list("assignment-generation", { afterId: after, limit: 200 });
      for (const aggregate of page) {
        if (!aggregate.id.startsWith(prefix)) return out;
        out.push(view<GenerationBody>(aggregate));
        after = aggregate.id;
      }
      if (page.length < 200) return out;
    }
  }

  // ---- plumbing --------------------------------------------------------------------------------------------------------------

  async #openTask(taskId: string): Promise<{ body: TaskBody; revision: number }> {
    const task = await this.#runner.get("task", taskId);
    if (task === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
    const body = task.body as unknown as TaskBody;
    if (FINAL.has(body.state)) throw new DomainError("invalid_command", `task ${taskId} is ${body.state}; it cannot be assigned or worked on`, { field: "taskId" });
    return { body, revision: task.revision };
  }

  #requireFence(body: AssignmentBody, fence: Fence, taskId: string): void {
    if (body.state !== "assigned" || body.generation !== fence.generation || body.activeAttemptId !== fence.attemptId) {
      const now = body.state === "assigned" ? `generation ${body.generation}${body.activeAttemptId === undefined ? " with no active attempt" : ` with attempt ${body.activeAttemptId}`}` : "released";
      throw new DomainError("fenced", `generation ${fence.generation} with attempt ${fence.attemptId} may not write to task ${taskId}: it is ${now}`, { field: "fence" });
    }
  }

  /** The guard that makes a write atomic with the current ownership: used for task writes here and for effects (card S05). */
  guardFor(fence: Fence): FenceGuard { return this.#guard("", fence); }

  #guard(_unused: string, fenceInput: Fence): FenceGuard {
    const fence = checkFence(fenceInput);
    return {
      payload: { fence: fence as unknown as JsonObject },
      check: async (taskId: string): Promise<{ changes: readonly Change[]; detail: JsonObject }> => {
        const ref: AggregateRef = { kind: "assignment", id: assignmentIdOf(taskId) };
        const current = await this.#runner.get("assignment", ref.id);
        if (current === undefined) throw new DomainError("fenced", `task ${taskId} has no assignment, so nothing may write to it on an owner's behalf`, { field: "fence" });
        this.#requireFence(current.body as unknown as AssignmentBody, fence, taskId);
        return { changes: [{ type: "check", ref, expectedRevision: current.revision }], detail: { generation: fence.generation, attemptId: fence.attemptId } };
      },
    };
  }

  /** The active attempt, ended (an update of it), or nothing if there is none. */
  async #endAttempt(id: string | undefined, state: AttemptState): Promise<Change[]> {
    if (id === undefined) return [];
    const found = await this.#runner.get("attempt", id);
    if (found === undefined) throw new DomainError("integrity", `the assignment names active attempt ${id}, which does not exist`);
    const body = found.body as unknown as AttemptBody;
    return [{ type: "update", ref: { kind: "attempt", id }, expectedRevision: found.revision, body: { ...body, state } as unknown as JsonObject }];
  }

  #generationChange(taskId: string, n: number, who: Owner, by: string, cause: GenerationBody["cause"], previous: Owner | undefined, reason: string | undefined): Change[] {
    const body: GenerationBody = { taskId, generation: n, owner: who, assignedBy: by, cause, ...(previous === undefined ? {} : { previousOwner: previous }), ...(reason === undefined ? {} : { reason }) };
    return [{ type: "create", ref: { kind: "assignment-generation", id: generationIdOf(taskId, n) }, body: body as unknown as JsonObject }];
  }

  #built(ref: AggregateRef, creates: boolean, taskId: string, next: AssignmentBody, revision: number, change: AssignmentEvent["change"], changes: readonly Change[], extra: readonly Change[], detail: JsonObject): Built {
    const event: AssignmentEvent = { taskId, revision, generation: next.generation, state: next.state, change, ...(next.owner === undefined ? {} : { owner: next.owner }), ...(next.activeAttemptId === undefined ? {} : { activeAttemptId: next.activeAttemptId }) };
    const entry: OutboxEntry = { deliveryId: assignmentEventId(taskId, revision), destination: ASSIGNMENT_EVENTS, orderingKey: taskId, priority: 5, aggregate: { kind: "assignment", id: assignmentIdOf(taskId) }, payload: event as unknown as JsonObject };
    return { ref, creates, changes: [...changes, ...extra], detail, outbox: [entry], ...(creates && ref.kind === "assignment" ? { contention: () => this.#staleAssignment(ref, taskId) } : {}) };
  }

  async #staleAssignment(ref: AggregateRef, taskId: string): Promise<DomainError> {
    const now = await this.#runner.get(ref.kind, ref.id);
    return new DomainError("stale_revision", now === undefined ? `task ${taskId} has no assignment yet` : `the assignment of task ${taskId} changed meanwhile and is now at revision ${now.revision}`, now === undefined ? {} : { currentRevision: now.revision });
  }

  async #staleActivity(ref: AggregateRef): Promise<DomainError> {
    const now = await this.#runner.get(ref.kind, ref.id);
    return new DomainError("stale_revision", `activity record ${ref.id} changed meanwhile${now === undefined ? "" : ` and is now at revision ${now.revision}`}; send the observation again`, now === undefined ? {} : { currentRevision: now.revision });
  }
}

