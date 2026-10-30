import { DomainError } from "../domain/errors.js";
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

/**
 * Puts what the stand-up decided about a topic back where the topic came from (card M03f): on the chat turn that raised it (shown by the chat), or as a controller notice to the agent that asked the inquiry, on the inquiry's task. An outcome
 * that cannot be put back (the turn or inquiry is gone, the notice cannot be filed) stays waiting and is tried again; it never stops the delivery of the others.
 */
export function agendaOutcomeSink(deps: {
  followUp(turnId: string, followUp: { key: string; text: string }): Promise<boolean>;
  inquiry(inquiryId: string): Promise<{ asker: string; taskId: string } | undefined>;
  messages: { noticeFromController(command: { commandId: string; taskId: string; to: string; purpose: string; text: string }): Promise<unknown> };
}): OutcomeSink {
  return {
    deliver: async (n) => {
      if (n.kind !== "agenda-outcome") return false;
      try {
        if (n.to.kind === "chat-turn") return await deps.followUp(n.to.id, { key: `ago:${n.key}`, text: n.text });
        if (n.to.kind === "inquiry") {
          const q = await deps.inquiry(n.to.id);
          if (q === undefined) return false;
          await deps.messages.noticeFromController({ commandId: `ago:${n.key}`, taskId: q.taskId, to: q.asker, purpose: "The stand-up discussed your question", text: n.text });
          return true;
        }
      } catch (error) {
        // An asker that cannot be told at all (not an agent, retired, or not allowed to read the task) will never be told: leaving it waiting would only retry it for ever.
        return error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found" || error.code === "invalid_command") && n.to.kind === "inquiry";
      }
      return false;
    },
  };
}
