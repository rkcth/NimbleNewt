import type { JobState } from "../jobs/jobs.js";
import type { StopPhase } from "../lifecycle/stop.js";

/**
 * The states a long-running command reports through the state API (card U13): `accepted` (recorded, nothing else has acted yet), `queued` (waiting for a worker or a slot), `running`, `completed`,
 * `blocked` (it cannot go on without someone's decision), `failed` and `outcome_unknown` (it may or may not have taken effect; nothing says it succeeded).
 * The records keep their own finer states (a job's `cancellation_requested`, a stop's `terminating`); these functions only translate them, so every reader says the same thing for the same record.
 */
export const COMMAND_STATES = ["accepted", "queued", "running", "completed", "blocked", "failed", "outcome_unknown"] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

/**
 * A job. ASSUMPTION: `dispatched` (handed to the host, no sign of running yet) counts as `queued`; `cancellation_requested` is still `running` (the stop has not been confirmed); `cancelled` is `failed`, because the
 * command that started the job did not finish what it set out to do (the job's own `state` still says it was cancelled, and the job record says who stopped it).
 */
export function jobCommandState(state: JobState): CommandState {
  switch (state) {
    case "admitted": return "queued";
    case "dispatched": return "queued";
    case "running": return "running";
    case "cancellation_requested": return "running";
    case "completed": return "completed";
    case "failed": return "failed";
    case "cancelled": return "failed";
    case "outcome_unknown": return "outcome_unknown";
    default: return "outcome_unknown";
  }
}

/**
 * A suspension or stop request. A request that ended with something left unresolved (an effect of unknown outcome, a child still running) is `outcome_unknown`, never `completed`: the stop service records that ending as
 * `recovery-required` with the unresolved items in its outcome (a `done` never has any, but one would read the same). ASSUMPTION (card U13 review): `recovery-required` with nothing listed, and `blocked`, wait for a
 * person's decision, so they are `blocked`; a request the owner cancelled is `failed`.
 */
export function stopCommandState(phase: StopPhase, unresolved: number): CommandState {
  switch (phase) {
    case "preparing": return "running";
    case "prepared": return "running";
    case "terminating": return "running";
    case "blocked": return "blocked";
    case "recovery-required": return unresolved > 0 ? "outcome_unknown" : "blocked";
    case "done": return unresolved > 0 ? "outcome_unknown" : "completed";
    case "cancelled": return "failed";
    default: return "outcome_unknown";
  }
}

/**
 * What a recorded `task.assign` or `task.transfer` has come to (card U13 finish). The command is accepted when its new generation of the assignment is recorded; what it was for (the owner's worker taking the task up)
 * happens later, and these are the stored facts that say how far it got. `attempt` is the latest attempt of the command's own generation. `deliveryState` is the state of the outbox message that tells the owner's worker
 * (`pending` and `claimed`: not yet handed over; `delivered`: in the worker's inbox).
 *
 * ASSUMPTIONS (card U13 finish; reversible here): an active attempt is `running`, a succeeded one `completed`, a failed one `failed`. An attempt the owner `abandoned` (it left without saying how it ended), or one that a later
 * transfer or release `superseded` or `released` while it was active, is `outcome_unknown`: its work may have been done in part and nothing says it was not. A generation that was replaced or released before any attempt began is `failed`
 * (it will never take effect). With no attempt yet: a blocked task is `blocked`, a task already done or cancelled is `failed`, a message already in the worker's inbox is `queued`, anything else is `accepted`.
 */
export interface DeferredCommandFacts {
  /** The assignment now: its generation and whether the task is still owned. */
  readonly assignment: { readonly generation: number; readonly state: "assigned" | "released" } | undefined;
  /** The generation the command made. */
  readonly generation: number;
  readonly attempt: { readonly state: "active" | "succeeded" | "failed" | "abandoned" | "superseded" | "released" } | undefined;
  readonly taskState: string | undefined;
  readonly deliveryState: "pending" | "claimed" | "delivered" | undefined;
  /** Attempt records were read only in part, and no attempt of this generation that is certainly its latest was found: nothing can be said about it (checked before the attempt). */
  readonly attemptsPartial?: boolean;
}

export function deferredCommandState(f: DeferredCommandFacts): { readonly state: CommandState; readonly reason: string } {
  if (f.attemptsPartial === true) return { state: "outcome_unknown", reason: "the attempt records could not all be read, so what became of this generation is not known" };
  if (f.attempt !== undefined) {
    switch (f.attempt.state) {
      case "active": return { state: "running", reason: "the owner's worker has an attempt under way" };
      case "succeeded": return { state: "completed", reason: "the owner's attempt finished and succeeded" };
      case "failed": return { state: "failed", reason: "the owner's attempt finished and failed" };
      case "abandoned": return { state: "outcome_unknown", reason: "the owner's attempt was abandoned without a reported outcome; some work may have been done" };
      case "superseded": return { state: "outcome_unknown", reason: "ownership moved on while the attempt was active; its work may or may not have been completed" };
      case "released": return { state: "outcome_unknown", reason: "the task was released while the attempt was active; its work may or may not have been completed" };
      default: return { state: "outcome_unknown", reason: "the attempt is in a state this reader does not know" };
    }
  }
  if (f.assignment === undefined) return { state: "outcome_unknown", reason: "the assignment record is missing" };
  if (f.assignment.generation > f.generation) return { state: "failed", reason: "ownership was replaced before any attempt began; this command's generation never took effect" };
  if (f.assignment.state === "released") return { state: "failed", reason: "the task was released before any attempt began" };
  if (f.taskState === "done" || f.taskState === "cancelled") return { state: "failed", reason: `the task is ${f.taskState}; no attempt began` };
  if (f.taskState === "blocked") return { state: "blocked", reason: "the task is blocked; no attempt can begin until it is unblocked" };
  if (f.deliveryState === "delivered") return { state: "queued", reason: "the owner's worker has been told; no attempt has been admitted yet" };
  return { state: "accepted", reason: "recorded; the owner's worker has not been told yet" };
}
