import { createHash } from "node:crypto";
import { WORK_END_TOOL } from "../bridge.js";

/**
 * The nudge that continues a turn that yielded without a tool call and without work.end (card W04). It is fixed text: it names no plan step (the process cannot read the checkout; the agent can), quotes nothing the agent wrote, and tells the agent
 * how to end. A reply cut off at the output limit gets the same nudge with a first sentence that says so (W07 gives a length stop its own words).
 */
export const NUDGE_TEXT = `Remaining: the unchecked steps of your PLAN.md. Make the next tool call now. When every step is done and committed, end with ${WORK_END_TOOL} as your last call; a reply without a tool call does not end the work.`;
export const LENGTH_NUDGE_LEAD = "Your last reply was cut off at the output limit.";

export function nudgeText(stopReason: string): string {
  return stopReason === "length" ? `${LENGTH_NUDGE_LEAD} ${NUDGE_TEXT}` : NUDGE_TEXT;
}

/** The bridge call ID of continuation `n` of a turn: the same for the same turn and number, so a restarted process that asks again is the same request. */
export function nudgeCallId(turn: string, n: number): string {
  return `nudge:${createHash("sha256").update(turn).digest("hex").slice(0, 32)}:${n}`;
}
