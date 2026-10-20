export interface BoundaryEntry {
  readonly id: number;
  readonly kind: string;
  readonly model?: readonly unknown[];
  readonly data?: unknown;
}

/** A place-only update: added to context at a boundary without asking the model anything. */
export function isPlacedUpdate(entry: { readonly kind: string; readonly data?: unknown }): boolean {
  return entry.kind === "nimblenewt.update" && (entry.data as { run?: unknown } | undefined)?.run === false;
}

/** An adapter entry that only carries a context edit (framing of an aborted input): it extends the preceding boundary. */
export function isContextEditOnly(entry: { readonly kind: string }): boolean {
  return entry.kind === "nimblenewt.aborted-input";
}

/**
 * Whether an entry is an input addressed to the agent, which starts a request's segment of the transcript. A place-only
 * update is not: it asks nothing, and tool calls around it still belong to the request that was running.
 */
export function startsRequestSegment(entry: { readonly kind: string; readonly data?: unknown }): boolean {
  return entry.kind === "pi.user" || (entry.kind === "nimblenewt.update" && !isPlacedUpdate(entry));
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
    } else if (isPlacedUpdate(entry) || isContextEditOnly(entry)) {
      // Part of the task's context but not a question: a boundary when nothing is waiting for an answer. A context edit
      // must be inherited by a branch taken right after it, or the branch would see what the edit hides from the task.
      if (open.size === 0 && !inputPending) boundaries.push(entry.id);
    } else if (startsRequestSegment(entry)) {
      open.clear();
      sawCalls = false;
      inputPending = true;
    }
  }
  return boundaries;
}
