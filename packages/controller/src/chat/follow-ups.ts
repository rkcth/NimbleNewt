import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { TurnBody } from "./chat.js";

export const FOLLOW_UP_LIMITS = { kept: 20, text: 1000 } as const;

/**
 * What happened later to something the owner said in chat (card M03f): the stand-up took a topic that came from a chat turn, and its outcome is put back on that turn, where the chat shows it. Each follow-up has a key, so
 * delivering it twice puts it there once; at most `kept` of the latest are kept on a turn. Written by the controller, never by the chat's own commands.
 */
export function chatTurnFollowUps(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): { add(turnId: string, followUp: { key: string; text: string }): Promise<boolean> } {
  const runner = new CommandRunner(storage, epoch, options);
  return {
    add: async (turnId, followUp) => {
      if (typeof followUp.key !== "string" || followUp.key.length < 1 || typeof followUp.text !== "string" || followUp.text.length < 1) throw new DomainError("invalid_command", "a follow-up needs a key and text", { field: "followUp" });
      const text = followUp.text.slice(0, FOLLOW_UP_LIMITS.text);
      try {
        await runner.command("chat.turn.follow-up", { commandId: `ctf:${followUp.key}`.slice(0, 120), actor: "system" }, async () => ({
          payload: { turnId, text },
          build: async () => {
            const found = await runner.get("chat-turn", turnId);
            if (found === undefined) throw new DomainError("not_found", "no such chat turn");
            const body = found.body as unknown as TurnBody & { followUps?: readonly { key: string; text: string; at: string }[] };
            const ref: AggregateRef = { kind: "chat-turn", id: turnId };
            if (body.followUps?.some((f) => f.key === followUp.key)) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: found.revision }], detail: { again: true } };
            const next = [...(body.followUps ?? []), { key: followUp.key, text, at: runner.now() }].slice(-FOLLOW_UP_LIMITS.kept);
            return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: JSON.parse(JSON.stringify({ ...body, followUps: next })) as JsonObject }], detail: { turnId } };
          },
        }));
        return true;
      } catch (error) {
        // A turn that is gone cannot be told; a busy record is tried again by the next delivery.
        if (error instanceof DomainError && (error.code === "not_found" || error.code === "stale_revision" || error.code === "command_conflict")) return false;
        throw error;
      }
    },
  };
}
