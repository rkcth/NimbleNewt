import { DomainError } from "../domain/errors.js";
import { cut, type OutcomeSink } from "./shared.js";
import type { OwnerQuestionSink, PreparationSink } from "./standups.js";
import { MEETING_LIMITS } from "../meetings/meetings.js";

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
        // A notice that can never be filed (the task is gone, or the text is not acceptable) is closed rather than retried for ever; a refusal by rights may pass (a grant can come back), so it stays waiting.
        return error instanceof DomainError && (error.code === "not_found" || error.code === "invalid_command") && n.to.kind === "inquiry";
      }
      return false;
    },
  };
}

/**
 * Tells the owner a stand-up asked a question (card M03h): a needs-you notification (the question is the notification's detail, so the owner sees it in the inbox) and, when the topic came from a chat turn, a note on that turn,
 * which the chat shows. Both are keyed by the question, so a repeat files them once. The notification is the part that must succeed; a turn that is gone or full is not a reason to keep the owner from being told.
 */
export function ownerQuestionSink(deps: {
  notify(command: { commandId: string; questionId: string; projectId: string; detail: string }): Promise<unknown>;
  followUp(turnId: string, followUp: { key: string; text: string }): Promise<boolean>;
}): OwnerQuestionSink {
  return {
    raise: async (n) => {
      const text = `The stand-up asks you, about "${cut(n.topic, 80)}": ${cut(n.question, MEETING_LIMITS.ownerQuestion)} Answer in the chat in your own words, for example "the answer to the stand-up's question is ...".`;
      // The notification's detail is short (the inbox keeps 200 characters); the whole question is on the record and in the chat.
      const short = `${cut(`Stand-up asks, on "${cut(n.topic, 40)}":`, 80)} ${cut(n.question, 100)} Answer in chat.`;
      try { await deps.notify({ commandId: `oqn:${n.key}`, questionId: n.questionId, projectId: n.projectId, detail: cut(short, 200) }); } catch { return false; }
      if (n.source?.kind === "chat-turn") { try { await deps.followUp(n.source.id, { key: `oqn:${n.key}`, text }); } catch { /* the notification is filed; the turn note is a convenience */ } }
      return true;
    },
  };
}

/**
 * The advance notice of a stand-up to an agent (card M03h): a controller notice, filed as advice against the task the agent works on, that says when the stand-up is and that its brief is made from the records. It never wakes,
 * starts or resumes anything (the recipient reads it at a boundary). It answers `false` when nothing was filed, so the preparation does not record the agent as told and asks again at its next run: an agent that holds no
 * live task (there is nothing running that needs to reach a boundary; its brief is made all the same), a notice that cannot be filed now (the agent may not read that task, the task is gone) and a recipient whose inbox is
 * full (`unavailable`: an agent that holds a ready or blocked task and is not running reads no notices, and a daily stand-up must not let its full inbox stop the briefs of everyone in the project). Any other failure (a
 * storage error) is raised and the preparation tries again at the next tick. The notice's key is the command ID, so a retry files it once; the same key already used for another task (the agent's task changed between a
 * notice that was filed and a preparation record that was not written) is `command_conflict`, and the agent was told: that is `true`, not a failure that would stop every later preparation.
 */
export function preparationNoticeSink(messages: { noticeFromController(command: { commandId: string; taskId: string; to: string; purpose: string; text: string }): Promise<unknown> }): PreparationSink {
  return {
    notify: async (n) => {
      if (n.taskId === undefined) return false;
      try { await messages.noticeFromController({ commandId: `spn:${n.key}`, taskId: n.taskId, to: n.agent, purpose: "A stand-up is coming", text: n.message }); return true; }
      catch (error) {
        if (error instanceof DomainError && error.code === "command_conflict") return true;
        if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found" || error.code === "invalid_command" || error.code === "unavailable")) return false;
        throw error;
      }
    },
  };
}
