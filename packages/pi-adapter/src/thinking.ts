import type { StoredThinking } from "@nimblenewt/contracts";

/** The shape of a stored entry this module reads; the adapter's own `EntryLike` satisfies it. */
export interface ThinkingEntry { readonly id: number; readonly model?: readonly unknown[] }

/**
 * The thinking blocks kept in a conversation's entries, in order (card C06b). Pi stores what the provider returned inside the assistant message (Anthropic thinking blocks with their signatures, OpenAI reasoning items, redacted
 * thinking), and replays it to the same model on every later request, after a restart too. This reads the readable part for the owner. The signature or encrypted payload is not returned: it is the provider's proof, not
 * something a person reads, and keeping it out of every view means a copy of the view cannot be replayed anywhere.
 */
export function storedThinking(conversationId: number, entries: readonly ThinkingEntry[]): StoredThinking[] {
  const found: StoredThinking[] = [];
  for (const entry of entries) {
    for (const message of entry.model ?? []) {
      const m = message as { role?: string; provider?: string; model?: string; content?: unknown };
      if (m.role !== "assistant" || !Array.isArray(m.content)) continue;
      for (const block of m.content as { type?: string; thinking?: unknown; redacted?: unknown; thinkingSignature?: unknown }[]) {
        if (block?.type !== "thinking") continue;
        const opaque = block.redacted === true;
        found.push({
          conversationId, entryId: entry.id,
          provider: typeof m.provider === "string" ? m.provider : "", model: typeof m.model === "string" ? m.model : "",
          text: opaque ? "" : typeof block.thinking === "string" ? block.thinking : "",
          opaque,
        });
      }
    }
  }
  return found;
}
