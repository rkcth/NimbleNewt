import { THINKING_REPORT, type ThinkingReport } from "@nimblenewt/contracts";

/** The most blocks one turn reports (the newest); older unsent ones are counted as not reported, never queued without end. */
export const THINKING_PER_TURN = 100;

export interface ThinkingMark { readonly entryId: number; readonly block: number }
export interface StoredBlockLike { readonly entryId: number; readonly provider: string; readonly model: string; readonly text: string; readonly opaque: boolean }

const cut = (text: string): string => {
  if (text.length <= THINKING_REPORT.chars) return text;
  let end = THINKING_REPORT.chars;
  const c = text.charCodeAt(end - 1);
  if (c >= 0xd800 && c <= 0xdbff) end -= 1;
  return text.slice(0, end);
};

/**
 * The thinking a turn has to report (card U09b): the stored blocks after the last one reported, in order, each cut to the channel's bound, the newest `THINKING_PER_TURN` of them in messages of at most `THINKING_REPORT.blocks`.
 * `block` is the block's position among those of its entry. The text is not trusted and not cleaned here: the controller does that. Opaque blocks carry no text. Nothing is reported twice, however often it is called.
 */
export function pendingThinking(all: readonly StoredBlockLike[], sent: ThinkingMark): { readonly messages: ThinkingReport[][]; readonly sent: ThinkingMark } {
  const position = new Map<number, number>();
  const fresh: ThinkingReport[] = [];
  let mark = sent;
  for (const b of all) {
    const block = position.get(b.entryId) ?? 0;
    position.set(b.entryId, block + 1);
    if (b.entryId < sent.entryId || (b.entryId === sent.entryId && block <= sent.block)) continue;
    mark = { entryId: b.entryId, block };
    if (b.provider === "" || b.model === "") continue;
    fresh.push({ entryId: b.entryId, block, provider: b.provider.slice(0, 80), model: b.model.slice(0, 200), text: b.opaque ? "" : cut(b.text), opaque: b.opaque });
  }
  const kept = fresh.slice(-THINKING_PER_TURN);
  const messages: ThinkingReport[][] = [];
  for (let i = 0; i < kept.length; i += THINKING_REPORT.blocks) messages.push(kept.slice(i, i + THINKING_REPORT.blocks));
  return { messages, sent: mark };
}
