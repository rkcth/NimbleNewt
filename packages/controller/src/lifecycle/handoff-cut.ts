import { quotedLine } from "../decisions/records.js";

/**
 * Cutting a hand-off section to size (card C07j). A section is a list of entries, one per line, oldest first (the sources write them so: artifacts, then decisions in the order they were recorded, so the newest decision is the last entry). A section
 * that does not fit keeps the entries the owner marked and then the most recent ones, says on its first line how many entries were left out or shortened and where the original is kept, and is never cut
 * silently. The original itself is archived by the hand-off service before the cut package is written.
 */

/** The controller's marker: the first line of a cut section, and only there. `left` entries of `total` were left out or shortened; the whole section is in `archive`. */
export const CUT_MARKER = /^\[cut: (\d+) of (\d+) entries, archive ([a-z]+-[a-z2-7]{20})\]/;
const FIT = "Entries were left out to fit (the owner's marked ones and the newest are kept)";
const help = (archiveId: string, archivedChars: number | undefined, why: string = FIT): string => ` ${why}; ${archivedChars === undefined ? "the whole section is kept" : `the first ${archivedChars} characters of the section are kept (it was longer than an archive holds)`}: read it with the state API query handoff.archive.read { "archiveId": "${archiveId}" }.`;
const marker = (left: number, total: number, archiveId: string, archivedChars: number | undefined, why?: string): string => `[cut: ${left} of ${total} entries, archive ${archiveId}]${help(archiveId, archivedChars, why)}`;
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
export const neutralise = (line: string): string => (looksLikeMarker(line) ? `(an entry quoted, not a cut marker) ${quotedLine(line)}` : line);

/**
 * Read as a reader would see the line: invisible format characters (zero-width spaces and joiners, bidi controls, soft hyphens) are dropped and compatibility forms folded (a full-width bracket or letter is
 * the plain one), so `[\u200Bcut:` or `\uFF3B\uFF43\uFF55\uFF54:` is caught. Beside the marker's opening, a line with the marker's `archive hnd-` or its count wording is quoted too (a look-alike letter in `cut` does not hide it).
 * The quoted form escapes those format characters, so what an agent hid is visible.
 */
function looksLikeMarker(line: string): boolean {
  const seen = line.replace(/\p{Cf}/gu, "").normalize("NFKC");
  return opensLikeMarker(seen) || /\[\s*cut\s*:/i.test(seen) || /archive\W{0,3}hnd-/i.test(seen) || /\d+\s+of\s+\d+\s+entries/i.test(seen);
}

/** What a reader does not see at the start of a line: spaces, combining marks, controls and the blank letters (Hangul fillers, the blank Braille pattern). */
const UNSEEN_LEAD = /^[\s\p{Z}\p{M}\p{Cc}ᅟᅠㅤﾠ⠀]+/u;
/**
 * The marker's opening is reserved (card C07j review, round 3): a source line whose first visible character is a square or other opening bracket (any `Ps` character but the round and curly ones, and the
 * bracket pieces that draw one) is quoted, whatever letters follow. Look-alike letters can spell `cut` and its wording in endless ways, but none of them makes a quoted line start with a bracket, so the
 * only line of a section a reader sees opening like the marker is the controller's.
 */
function opensLikeMarker(seen: string): boolean {
  const first = seen.replace(UNSEEN_LEAD, "").codePointAt(0);
  if (first === undefined) return false;
  const c = String.fromCodePoint(first);
  return (c !== "(" && c !== "{" && /\p{Ps}/u.test(c)) || /[⎡-⎣⎧-⎩⌜⌞]/u.test(c);
}

/** Whether an entry holds one of the owner's marks (case does not matter). */
const markedBy = (marks: readonly string[]) => {
  const lower = marks.map((m) => m.toLowerCase()).filter((m) => m.length > 0);
  return (entry: string): boolean => { const e = entry.toLowerCase(); return lower.some((m) => e.includes(m)); };
};

export interface CutOptions {
  /** The section's first line is its heading (a brief's title, what a responsibilities list means): kept after the newest entry and before the marked ones, when it fits whole. */
  readonly heading?: boolean;
  /** The entries as the source wrote them, one per line of `text`: marks are looked for in these (a line `neutralise` quoted has its quotes and backslashes escaped). */
  readonly matchOn?: readonly string[];
}

export interface SectionCut {
  /** The section as the recipient is given it: within `limit`. */
  readonly text: string;
  /** Present when the section was cut: entries left out or shortened, of how many. */
  readonly cut?: { readonly left: number; readonly total: number };
}

/**
 * Cuts `text` to at most `limit` characters. The newest entry is kept first (whole when it fits; otherwise room is held for its start), then the heading line when `options.heading` is set, then the entries the owner marked (newest first, as many as fit),
 * then the most recent entries, newest first, until one does not fit, which is shortened into the room left (from its start) when enough of it fits. The kept entries stay in their order, below the marker.
 */
export function cutSection(text: string, limit: number, marks: readonly string[], archiveId: string, /** Set when the archive holds only the first this many characters of the section. */ archivedChars?: number, options: CutOptions = {}): SectionCut {
  if (text.length <= limit) return { text };
  const entries = text.split("\n");
  const total = entries.length;
  // The marker is sized for its longest form (every entry left out), so the count it finally shows can only make it shorter.
  const room = limit - marker(total, total, archiveId, archivedChars).length - 1;
  if (room < MIN_SHORT + SHORTENED.length) throw new RangeError(`a section limit of ${limit} leaves no room beside the cut marker`);
  const marked = markedBy(marks);
  const chosen = new Map<number, string>();
  let used = 0;
  const cost = (entry: string): number => entry.length + (chosen.size > 0 ? 1 : 0);
  // The newest entry is never crowded out by marked ones (an agent's text can hold a mark's words): it is kept first when it fits whole, and otherwise room is held back to show its start.
  const newest = entries[total - 1]!;
  if (newest.length <= room) { used = newest.length; chosen.set(total - 1, newest); }
  const reserve = chosen.has(total - 1) ? 0 : MIN_SHORT + SHORTENED.length + 1;
  if (options.heading === true && total > 1 && used + cost(entries[0]!) + reserve <= room) { used += cost(entries[0]!); chosen.set(0, entries[0]!); }
  const matchOn = options.matchOn !== undefined && options.matchOn.length === total ? options.matchOn : entries;
  for (let i = total - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (!chosen.has(i) && marked(matchOn[i]!) && used + cost(e) + reserve <= room) { used += cost(e); chosen.set(i, e); }
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
  const out = [marker(total - whole, total, archiveId, archivedChars), ...kept].join("\n");
  if (out.length > limit) throw new RangeError(`cut section is ${out.length} characters, over ${limit}`);
  return { text: out, cut: { left: total - whole, total } };
}

/** The kinds of entry a digest counts by the label the source puts before each (`Decision: ...`); any other entry counts as an entry. */
const KINDS: readonly (readonly [string, string, string])[] = [["Decision: ", "decision", "decisions"], ["Artifact: ", "artifact", "artifacts"]];
const counted = (entries: readonly string[]): string => {
  const n = new Map<string, number>();
  for (const e of entries) { const k = KINDS.find(([p]) => e.startsWith(p)); const key = k === undefined ? "" : k[0]; n.set(key, (n.get(key) ?? 0) + 1); }
  const parts = KINDS.filter(([p]) => n.has(p)).map(([p, one, many]) => `${n.get(p)} ${n.get(p) === 1 ? one : many}`);
  const other = n.get("");
  if (other !== undefined) parts.push(`${other} other entr${other === 1 ? "y" : "ies"}`);
  return parts.join(" and ");
};

/**
 * Card C07k: a section that only grows across hand-offs (the run's completed work: every artifact and decision it has recorded) is summarised so the package does not grow with the number of hand-offs.
 * Its newest `keep` entries are shown whole, with the entries the owner marked (newest first, while the section stays within `limit`); the older ones are counted by kind on the marker line, which names the
 * archive that keeps the whole section, so every decision is still found by its reference there. The marker is the C07j cut marker, so every reader of a cut reads a digest the same way. A section of `keep`
 * entries or fewer is given whole; one whose newest entries do not fit `limit` beside the marker is cut as `cutSection` cuts it.
 */
export function digestSection(text: string, keep: number, limit: number, marks: readonly string[], archiveId: string, archivedChars?: number, options: CutOptions = {}): SectionCut {
  if (!Number.isSafeInteger(keep) || keep < 1) throw new RangeError("a digest keeps at least the newest entry");
  const entries = text.split("\n");
  const total = entries.length;
  if (total <= keep) return cutSection(text, limit, marks, archiveId, archivedChars, options);
  const why = (left: readonly string[]): string => `Older entries are summarised so the package does not grow with every hand-off: ${counted(left)} left out (the owner's marked ones and the newest ${keep} are kept)`;
  const matchOn = options.matchOn !== undefined && options.matchOn.length === total ? options.matchOn : entries;
  const chosen = new Set<number>();
  for (let i = total - keep; i < total; i++) chosen.add(i);
  const render = (): string => {
    const left = entries.filter((_, i) => !chosen.has(i));
    return [marker(left.length, total, archiveId, archivedChars, why(left)), ...entries.filter((_, i) => chosen.has(i))].join("\n");
  };
  if (render().length > limit) return cutSection(text, limit, marks, archiveId, archivedChars, options);
  const marked = markedBy(marks);
  for (let i = total - keep - 1; i >= 0; i--) {
    if (!marked(matchOn[i]!)) continue;
    chosen.add(i);
    if (render().length > limit) chosen.delete(i);
  }
  const out = render();
  return { text: out, cut: { left: total - chosen.size, total } };
}
