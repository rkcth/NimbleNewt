import { DomainError } from "../domain/errors.js";
import type { NoticeSink, WindowSink } from "./attendance.js";

/**
 * Tells an agent that was away what a meeting decided (card M04c): a notice from the controller filed in its inbox against the first task the decisions touch, which names the other tasks and the time by which the
 * agent must acknowledge. `key` is the command ID, so a retry files it once. A notice with no task to hang on is not sent (nothing the agent was working on is affected, so nothing waits on it).
 * The text of a retry can differ from the notice already filed under the key (a repeated end works the acknowledgement time out again from the clock; a full requirement record folds entries together), and the
 * same command ID with another text is `command_conflict`: the notice was filed, so the agent was told. That counts as sent, not as a failure that would keep the agent "unnotified" and retried for ever (the
 * fix the stand-up sink had in the U03c/M03h close-out review). Every other failure still reaches the attendance service, which keeps the agent in the unnotified list for the sweep.
 */
export function meetingNoticeSink(messages: { noticeFromController(command: { commandId: string; taskId: string; to: string; purpose: string; text: string }): Promise<unknown> }): NoticeSink {
  return {
    notify: async (n) => {
      const [first, ...rest] = n.taskIds;
      if (first === undefined) return;
      const text = `A meeting you were not at (${n.occurrenceId}) decided: ${n.decisions.join("; ") || "(see the meeting record)"}. It affects ${n.taskIds.length === 1 ? `task ${first}` : `tasks ${first}${rest.length === 0 ? "" : `, ${rest.join(", ")}`}`}. Check your next actions against it and acknowledge by ${n.dueAt}.`;
      try { await messages.noticeFromController({ commandId: `mtn:${n.key}`, taskId: first, to: n.agent, purpose: "A meeting decided something that affects your work", text }); } catch (error) {
        if (error instanceof DomainError && error.code === "command_conflict") return;
        throw error;
      }
    },
  };
}

const WINDOW_TEXT = {
  ahead: (o: string) => `A meeting (${o}) is about to start and you are expected in it. It is for quick answers: you keep your tools and your desk, but start no long-running work while it lasts. You will be told when that period begins and when it is over.`,
  begins: (o: string) => `The meeting ${o} has begun, so the no-long-running-work period has begun. Answer from your desk with your tools, but do not start work that will run on after the meeting.`,
  ends: (o: string) => `The meeting ${o} is over, so the no-long-running-work period has ended. You may go back to your work.`,
} as const;

/** The warnings around a meeting's quick-answer period, filed as notices from the controller against the task named (owner decision 2026-10-29). */
export function meetingWindowSink(messages: { noticeFromController(command: { commandId: string; taskId: string; to: string; purpose: string; text: string }): Promise<unknown> }): WindowSink {
  return {
    notify: async (e) => { await messages.noticeFromController({ commandId: `mtw:${e.key}`, taskId: e.taskId, to: e.agent, purpose: "Meeting: no long-running work", text: WINDOW_TEXT[e.phase](e.occurrenceId) }); },
  };
}
