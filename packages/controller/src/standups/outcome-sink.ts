import type { OutcomeSink } from "./shared.js";

/**
 * Tells a proposer what the stand-up decided about its improvement (card M03d, owner decision 2026-10-29): a controller notice against the task the outcome is about. An outcome with no task of its own is not filed here
 * (it would land in an unrelated task's history): it stays pending and is carried to the agent another way (the next stand-up brief). `key` is the command ID, so a retry files it once.
 */
export function improvementOutcomeSink(messages: { noticeFromController(command: { commandId: string; taskId: string; to: string; purpose: string; text: string }): Promise<unknown> }): OutcomeSink {
  return {
    deliver: async (n) => {
      if (n.kind !== "improvement-outcome" || n.to.kind !== "agent" || n.taskId === undefined) return false;
      // A notice that cannot be filed (the proposer cannot read the task, is no longer active, or its inbox is full) leaves the outcome waiting for the brief; it never stops the delivery of the others.
      try { await messages.noticeFromController({ commandId: `imo:${n.key}`, taskId: n.taskId, to: n.to.id, purpose: "The stand-up decided about your improvement", text: n.text }); } catch { return false; }
      return true;
    },
  };
}
