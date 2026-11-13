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
