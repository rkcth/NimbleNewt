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

/** The most characters of an update's request ID (the worker channel's own bound, `CHANNEL_UPDATES.requestId` in `@nimblenewt/contracts`, restated: the controller does not depend on that package). */
export const CONTEXT_UPDATE_REQUEST_ID_CHARS = 200;

/**
 * Why a work order's `contextUpdates` are not what `boundContextUpdates` gives (card G09, the remote path); undefined: they are. Absent is fine. Otherwise a list of at most `CONTEXT_UPDATE_LIMITS.items` objects with exactly
 * `requestId` (1 to 200 characters), `text` (at most `text`) and `origin` (at most `origin`), and their texts together at most `total` characters and the one note on left-out updates (a request ID given twice is placed once, as on a local host). Pure, so the controller (before it offers an order to a
 * remote host) and the remote worker (before it starts one) apply the same rule.
 */
export function contextUpdatesProblem(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  const L = CONTEXT_UPDATE_LIMITS;
  if (!Array.isArray(value) || value.length > L.items) return `must be a list of at most ${L.items} updates`;
  let total = 0;
  for (const u of value as unknown[]) {
    if (u === null || typeof u !== "object" || Array.isArray(u)) return "each update must be an object";
    const r = u as Record<string, unknown>;
    for (const k of Object.keys(r)) if (k !== "requestId" && k !== "text" && k !== "origin") return `${k.slice(0, 30)} is not a field of an update`;
    const id = r["requestId"], text = r["text"], origin = r["origin"];
    if (typeof id !== "string" || id.length < 1 || id.length > CONTEXT_UPDATE_REQUEST_ID_CHARS) return `requestId must be 1 to ${CONTEXT_UPDATE_REQUEST_ID_CHARS} characters`;
    if (typeof text !== "string" || text.length > L.text) return `text must be at most ${L.text} characters`;
    if (typeof origin !== "string" || origin.length > L.origin) return `origin must be at most ${L.origin} characters`;
    total += text.length;
  }
  // The note `boundContextUpdates` adds for left-out updates is counted too; it is at most `text` characters, so the limit is the total and one note.
  if (total > L.total + L.text) return `the texts together must be at most ${L.total + L.text} characters`;
  return undefined;
}
