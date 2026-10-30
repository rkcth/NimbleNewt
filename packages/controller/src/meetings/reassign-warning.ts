import { createHash } from "node:crypto";
import type { ControllerStorage } from "../storage/types.js";

export interface ReassignWarning { readonly commandId: string; readonly agent: string; readonly taskId: string; readonly projectId: string; readonly missing: readonly string[] }

/**
 * The warning for a reassignment decided in a meeting whose new holder lacks rights for the work (owner decision 2026-10-30: the move is made at once, with no accept-first step). It is a controller-set needs-you
 * notification to the owner and a best-effort notice to the meeting's chair, both with command IDs derived from the change's own, so a repeat records nothing new. The text names the agent and the missing rights, never an agent's words.
 */
export function reassignWarningSink(deps: {
  notifications: { emitFromController(command: { commandId: string; kind: "maintenance"; level: "needs-you"; ref: { kind: string; id: string }; projectId?: string; detail: string }): Promise<unknown> };
  storage: Pick<ControllerStorage, "getAggregate">;
  messages?: { noticeFromController(command: { commandId: string; taskId: string; to: string; purpose: string; text: string }): Promise<unknown> };
}): (w: ReassignWarning) => Promise<void> {
  return async (w) => {
    const text = `${w.agent} was given task ${w.taskId} by a meeting decision but lacks ${w.missing.join(", ")}. Grant the right or reassign the task.`;
    const id = createHash("sha256").update(w.commandId).digest("hex").slice(0, 32);
    await deps.notifications.emitFromController({ commandId: `reasn-warn-${id}`, kind: "maintenance", level: "needs-you", ref: { kind: "task", id: w.taskId }, ...(w.projectId === "" ? {} : { projectId: w.projectId }), detail: text.slice(0, 200) });
    const decisionId = w.commandId.split(":")[1];
    if (decisionId === undefined || deps.messages === undefined) return;
    const decision = (await deps.storage.getAggregate({ kind: "meeting-decision", id: decisionId }))?.body as unknown as { recordId?: string } | undefined;
    const chair = decision?.recordId === undefined ? undefined : ((await deps.storage.getAggregate({ kind: "meeting-record", id: decision.recordId }))?.body as unknown as { chair?: string } | undefined)?.chair;
    if (chair !== undefined) await deps.messages.noticeFromController({ commandId: `reasn-chair-${id}`, taskId: w.taskId, to: chair, purpose: "reassignment warning", text }).catch(() => undefined);
  };
}
