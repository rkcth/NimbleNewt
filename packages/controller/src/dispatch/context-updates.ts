import { createHash } from "node:crypto";
import { CONTEXT_UPDATE_LIMITS, type ContextUpdate } from "./ports.js";

/** Cut at `max` characters without leaving half of a surrogate pair at the end (card G09: the selected updates' text). */
export const cutWhole = (text: string, max: number): string => { const cut = text.slice(0, max); return /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut; };

/**
 * A start's selected updates as the order carries them (card G09), oldest first: at most `CONTEXT_UPDATE_LIMITS.items` (the newest), each text cut at `text` and origin at `origin` characters, and together at most
 * `total` characters of text. Past the total the oldest whole updates are left out, never cut, so an update's content under its request ID is the same at every start. In their place one note, first, says how many
 * were left out and where each came from; its request ID is made from theirs, so the same left-out set is noted once, and a new note is placed only when the set changes. The note is placed like an update.
 */
export function boundContextUpdates(list: readonly ContextUpdate[]): ContextUpdate[] {
  const L = CONTEXT_UPDATE_LIMITS;
  const cut = list.slice(-L.items).map((u) => ({ requestId: u.requestId, text: cutWhole(u.text, L.text), origin: cutWhole(u.origin, L.origin) }));
  let used = 0;
  let from = cut.length;
  while (from > 0 && used + cut[from - 1]!.text.length <= L.total) { used += cut[from - 1]!.text.length; from--; }
  if (from === 0) return cut;
  const left = cut.slice(0, from);
  const kept = cut.slice(from);
  const text = `${left.length} earlier ${left.length === 1 ? "update" : "updates"} selected for this task in side lines of work ${left.length === 1 ? "was" : "were"} not placed with this start: together with the newer ones that follow they pass the ${L.total} characters of updates one start places. Any that an earlier start placed is already in this conversation above. Where each came from (read the original there if you need it): ${left.map((u) => u.origin).join("; ")}.`;
  // The newest is always kept (each text is at most `text`, below `total`), so with the note the order still holds at most `items`.
  return [{ requestId: `upd-left:${createHash("sha256").update(left.map((u) => u.requestId).join("\n")).digest("hex").slice(0, 32)}`, text: cutWhole(text, L.text), origin: "the controller: the size limit on the selected updates one start places" }, ...kept];
}
