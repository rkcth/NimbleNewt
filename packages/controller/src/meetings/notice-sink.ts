import type { NoticeSink } from "./attendance.js";

/**
 * Tells an agent that was away what a meeting decided (card M04c): a notice from the controller filed in its inbox against the first task the decisions touch, which names the other tasks and the time by which the
 * agent must acknowledge. `key` is the command ID, so a retry files it once. A notice with no task to hang on is not sent (nothing the agent was working on is affected, so nothing waits on it).
 */
export function meetingNoticeSink(messages: { noticeFromController(command: { commandId: string; taskId: string; to: string; purpose: string; text: string }): Promise<unknown> }): NoticeSink {
  return {
    notify: async (n) => {
      const [first, ...rest] = n.taskIds;
      if (first === undefined) return;
      const text = `A meeting you were not at (${n.occurrenceId}) decided: ${n.decisions.join("; ") || "(see the meeting record)"}. It affects ${n.taskIds.length === 1 ? `task ${first}` : `tasks ${first}${rest.length === 0 ? "" : `, ${rest.join(", ")}`}`}. Check your next actions against it and acknowledge by ${n.dueAt}.`;
      await messages.noticeFromController({ commandId: `mtn:${n.key}`, taskId: first, to: n.agent, purpose: "A meeting decided something that affects your work", text });
    },
  };
}
