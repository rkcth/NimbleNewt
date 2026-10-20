/** Transcript entry kinds that carry an input addressed to the agent and so start a request's segment. */
export const INPUT_KINDS: ReadonlySet<string> = new Set(["pi.user", "nimblenewt.update"]);

export interface BoundaryEntry {
  readonly id: number;
  readonly kind: string;
  readonly model?: readonly unknown[];
}

interface MessageLike {
  readonly role?: string;
  readonly stopReason?: string;
  readonly toolCallId?: string;
  readonly content?: unknown;
}

function toolCallIds(message: MessageLike): string[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((part: unknown) => {
    const p = part as { type?: string; id?: string } | null;
    return p !== null && typeof p === "object" && p.type === "toolCall" && typeof p.id === "string" ? [p.id] : [];
  });
}

/**
 * Entry IDs after which the transcript is a complete turn boundary, in ascending order: a final assistant answer, the
 * last tool result of an assistant message whose tool calls have all been answered, or a compaction summary (Pi places
 * those only when idle or at a turn boundary). Branching at any other entry would leave a tool call without its result,
 * or an input without a response, in the branch's context. A compaction entry counts, because forking before it would
 * give the branch the uncompacted history the task no longer has. But Pi also compacts while preparing a generation,
 * which puts the summary after a still-unanswered input; that is not a boundary, or the branch would inherit the task's
 * pending instruction. In that case the latest boundary is the last answered turn, before the compaction.
 */
export function turnBoundaries(entries: readonly BoundaryEntry[]): number[] {
  const boundaries: number[] = [];
  const open = new Set<string>();
  let sawCalls = false;
  let inputPending = false;
  for (const entry of [...entries].sort((a, b) => a.id - b.id)) {
    const message = (entry.model?.[0] ?? {}) as MessageLike;
    if (entry.kind === "pi.assistant") {
      const calls = toolCallIds(message);
      const failed = message.stopReason === "error" || message.stopReason === "aborted";
      open.clear();
      sawCalls = calls.length > 0;
      for (const id of calls) open.add(id);
      if (calls.length === 0 && !failed && message.stopReason !== "toolUse") { boundaries.push(entry.id); inputPending = false; }
    } else if (entry.kind === "pi.tool-result") {
      if (typeof message.toolCallId === "string") open.delete(message.toolCallId);
      if (sawCalls && open.size === 0) { boundaries.push(entry.id); sawCalls = false; inputPending = false; }
    } else if (entry.kind === "pi.compaction") {
      if (open.size === 0 && !inputPending) boundaries.push(entry.id);
    } else if (INPUT_KINDS.has(entry.kind)) {
      open.clear();
      sawCalls = false;
      inputPending = true;
    }
  }
  return boundaries;
}
