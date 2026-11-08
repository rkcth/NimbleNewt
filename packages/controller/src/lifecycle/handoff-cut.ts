import { quotedLine } from "../decisions/records.js";

/**
 * Cutting a hand-off section to size (card C07j). A section is a list of entries, one per line, oldest first (the sources write them so: decisions in the order they were recorded, then artifacts). A section
 * that does not fit keeps the entries the owner marked and then the most recent ones, says on its first line how many entries were left out or shortened and where the original is kept, and is never cut
 * silently. The original itself is archived by the hand-off service before the cut package is written.
 */

/** The controller's marker: the first line of a cut section, and only there. `left` entries of `total` were left out or shortened; the whole section is in `archive`. */
export const CUT_MARKER = /^\[cut: (\d+) of (\d+) entries, archive ([a-z]+-[a-z2-7]{20})\]/;
const help = (archiveId: string): string => ` Older entries were left out to fit; the whole section is kept: read it with the state API query handoff.archive.read { "archiveId": "${archiveId}" }.`;
const marker = (left: number, total: number, archiveId: string): string => `[cut: ${left} of ${total} entries, archive ${archiveId}]${help(archiveId)}`;
/** Said at the end of an entry that was shortened to fill the room left (it still counts as cut). */
export const SHORTENED = " [... shortened; whole in the archive]";
/** A shortened entry is kept only when at least this much of it fits; less says nothing useful. */
const MIN_SHORT = 40;

const REPLACEMENT = String.fromCharCode(0xfffd);
/** Each lone UTF-16 surrogate becomes U+FFFD, so a text cut elsewhere (or sent broken) is stored as valid Unicode in every store. */
export const wellFormed = (value: string): string => value.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, REPLACEMENT);

/** At most `max` UTF-16 code units of `value`, never ending between the two halves of a surrogate pair. */
export function safeSlice(value: string, max: number): string {
  if (value.length <= max) return value;
  let end = Math.max(0, max);
  const last = value.charCodeAt(end - 1);
  if (end > 0 && last >= 0xd800 && last <= 0xdbff) end--;
  return value.slice(0, end);
}

/**
 * A line a source returned that holds anything like the controller's cut marker (an agent's text can say anything, and some readers break a line at U+2028, U+2029 or U+0085) is quoted as one JSON string,
 * with those characters escaped, so the only marker a reader sees is the one the controller put there.
 */
export const neutralise = (line: string): string => (/\[\s*cut\s*:/i.test(line) ? `(an entry quoted, not a cut marker) ${quotedLine(line)}` : line);

/** Whether an entry holds one of the owner's marks (case does not matter). */
const markedBy = (marks: readonly string[]) => {
  const lower = marks.map((m) => m.toLowerCase()).filter((m) => m.length > 0);
  return (entry: string): boolean => { const e = entry.toLowerCase(); return lower.some((m) => e.includes(m)); };
};

export interface SectionCut {
  /** The section as the recipient is given it: within `limit`. */
  readonly text: string;
  /** Present when the section was cut: entries left out or shortened, of how many. */
  readonly cut?: { readonly left: number; readonly total: number };
}

/**
 * Cuts `text` to at most `limit` characters. Entries the owner marked are kept first (newest first, as many as fit); then the most recent entries, newest first, until one does not fit, which is shortened
 * into the room left (from its start) when enough of it fits. The kept entries stay in their order, below the marker.
 */
export function cutSection(text: string, limit: number, marks: readonly string[], archiveId: string): SectionCut {
  if (text.length <= limit) return { text };
  const entries = text.split("\n");
  const total = entries.length;
  // The marker is sized for its longest form (every entry left out), so the count it finally shows can only make it shorter.
  const room = limit - marker(total, total, archiveId).length - 1;
  if (room < MIN_SHORT + SHORTENED.length) throw new RangeError(`a section limit of ${limit} leaves no room beside the cut marker`);
  const marked = markedBy(marks);
  const chosen = new Map<number, string>();
  let used = 0;
  const cost = (entry: string): number => entry.length + (chosen.size > 0 ? 1 : 0);
  for (let i = total - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (marked(e) && used + cost(e) <= room) { used += cost(e); chosen.set(i, e); }
  }
  let shortened = false;
  for (let i = total - 1; i >= 0; i--) {
    if (chosen.has(i)) continue;
    const e = entries[i]!;
    if (used + cost(e) <= room) { used += cost(e); chosen.set(i, e); continue; }
    // The newest entry that does not fit is shown as far as it goes, and the cut stops there: older entries never jump ahead of a newer one.
    const left = room - used - (chosen.size > 0 ? 1 : 0) - SHORTENED.length;
    if (left >= MIN_SHORT) { chosen.set(i, `${safeSlice(e, left)}${SHORTENED}`); shortened = true; }
    break;
  }
  const whole = chosen.size - (shortened ? 1 : 0);
  const kept = [...chosen.keys()].sort((x, y) => x - y).map((i) => chosen.get(i)!);
  const out = [marker(total - whole, total, archiveId), ...kept].join("\n");
  if (out.length > limit) throw new RangeError(`cut section is ${out.length} characters, over ${limit}`);
  return { text: out, cut: { left: total - whole, total } };
}
