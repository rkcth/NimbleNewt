import type { OutcomeSink } from "../standups/shared.js";

/**
 * Tells a proposer what the evaluation of its lesson found (card B03): a controller notice against the task the lesson is about, as an improvement's outcome is told (M03d). A lesson with no task of its own is
 * not filed here (it would land in an unrelated task's history): it stays pending, is carried in the proposer's next stand-up brief (second slice), is shown on the lessons status view, and the proposer can read
 * it with `lesson.get`; one untold for days is shown to the owner. `key` is the command ID, so a retry files
 * it once; a notice that cannot be filed now (the proposer cannot read the task, is not active, its inbox is full) stays pending and never stops the delivery of the others.
 */
export function lessonOutcomeSink(messages: { noticeFromController(command: { commandId: string; taskId: string; to: string; purpose: string; text: string }): Promise<unknown> }): OutcomeSink {
  return {
    deliver: async (n) => {
      if (n.kind !== "lesson-outcome" || n.to.kind !== "agent" || n.taskId === undefined) return false;
      try { await messages.noticeFromController({ commandId: `lso:${n.key}`, taskId: n.taskId, to: n.to.id, purpose: "Your lesson was evaluated", text: n.text }); } catch { return false; }
      return true;
    },
  };
}
