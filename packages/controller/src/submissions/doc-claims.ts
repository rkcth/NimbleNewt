import { cacheMaturityOf, CLAUDE_EXPERIMENTAL_NOTICE, STRATA_EXPERIMENTAL_NOTICE } from "../inference-cache/profile.js";
import { DomainError } from "../domain/errors.js";
import { redactText } from "../security/redact.js";

/**
 * Capability claims in documents (card Q03, "no unsupported marketing capability claims"). Two checks, both deterministic and explainable, neither pretending to understand prose:
 *
 * - **Declared claims.** Every claim a document's record lists names a capability ID of the project's capability register. A claim on an `unsupported` capability, or on an `experimental` one whose
 *   words carry no experimental label, is flagged; so is a claim naming no capability or one the register does not know.
 * - **A scan of the document's text.** The submitted document's text (the files of its artifact the controller can read as text) is cut into sentences and searched for the names of capabilities the
 *   register marks `experimental` or `unsupported`. A sentence that names one without a label in the same sentence (an experimental label, or a plain negation such as "not supported") is flagged.
 *   Supported capabilities are not searched for: the scan only looks for what must not be claimed bare.
 *
 * Every flag names its rule and quotes the sentence, cleaned (control, line-separator, direction and zero-width characters removed or made spaces, then redacted and cut), so a hostile document cannot
 * reorder or hide text in the owner's view. Same text, same register: same flags, in the same order.
 */

export const CAPABILITY_MATURITIES = ["supported", "experimental", "unsupported"] as const;
export type CapabilityMaturity = (typeof CAPABILITY_MATURITIES)[number];
export const CAPABILITY_ID = /^[a-z][a-z0-9-]{1,59}$/;
export const CLAIM_LIMITS = { entries: 100, names: 10, name: 80, nameMin: 3, note: 300, flags: 20, quote: 200, files: 50, fileBytes: 256 * 1024, totalBytes: 1024 * 1024 } as const;

/** One capability as the register states it. `source`: `built-in` (the controller's own maturity labels, from the code) or `project` (set by the owner or a director; may override a built-in). */
export interface CapabilityEntry {
  readonly id: string;
  readonly name: string;
  /** The names the text scan looks for (the name included), case-insensitive, whole words; at least 3 characters each. */
  readonly names: readonly string[];
  readonly maturity: CapabilityMaturity;
  readonly note?: string;
  readonly source: "built-in" | "project";
  readonly setBy?: string;
  readonly setAt?: string;
}

/** The project's own entries, as stored (record `doc-capabilities`, ID the project's). */
export interface CapabilityRegisterBody {
  readonly projectId: string;
  readonly entries: readonly Omit<CapabilityEntry, "source">[];
  readonly changedAt: string;
}

const fromCache = (kind: string): CapabilityMaturity => (cacheMaturityOf(kind) === "measured" ? "supported" : "experimental");

/**
 * The controller's own capability labels, taken from the code that states them: the cache maturity of a provider kind (`cacheMaturityOf`: Claude and Strata are experimental, never measured), and the
 * owner's decision of 2026-11-26 that NimbleNewt on Windows requires a signed-in user (no unattended service). A project entry with the same ID replaces one, as a recorded decision.
 */
export function builtInCapabilities(): CapabilityEntry[] {
  return [
    { id: "claude-prompt-caching", name: "Claude prompt caching", names: ["Claude prompt caching", "Claude caching", "Claude cache", "Anthropic prompt caching"], maturity: fromCache("claude"), note: CLAUDE_EXPERIMENTAL_NOTICE, source: "built-in" },
    { id: "strata-caching", name: "Strata caching", names: ["Strata caching", "Strata cache", "Strata prompt caching"], maturity: fromCache("strata"), note: STRATA_EXPERIMENTAL_NOTICE, source: "built-in" },
    { id: "windows-unattended-worker", name: "unattended Windows worker", names: ["unattended Windows", "Windows service", "Session 0", "nobody signed in", "no one signed in", "without a signed-in user"], maturity: "unsupported", note: "Owner decision 2026-11-26: on Windows a worker runs only while a user is signed in; there is no unattended service.", source: "built-in" },
  ];
}

/** The register claims are checked against: the built-in entries, each replaced by a project entry with its ID, then the project's other entries, in ID order. */
export function effectiveRegister(project: CapabilityRegisterBody | undefined): CapabilityEntry[] {
  const own = new Map((project?.entries ?? []).map((e) => [e.id, { ...e, source: "project" as const }]));
  const all = new Map<string, CapabilityEntry>();
  // A project entry replacing a built-in one keeps the built-in names too: a project cannot narrow what the scan looks for under the controller's own label.
  for (const b of builtInCapabilities()) { const o = own.get(b.id); all.set(b.id, o === undefined ? b : { ...o, names: [...new Set([...o.names, ...b.names])] }); }
  for (const [id, e] of own) if (!all.has(id)) all.set(id, e);
  return [...all.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

export const CLAIM_RULES = {
  claim_without_capability: "a claim must name the capability it claims (capabilityId), so it can be checked against the capability register",
  unknown_capability: "a claim names a capability the register does not know",
  unsupported_capability_claimed: "a claim names a capability the register marks unsupported",
  experimental_claim_unlabelled: "a claim names an experimental capability without saying it is experimental",
  unsupported_mention: "the text names an unsupported capability without saying it is not supported, in the same sentence",
  experimental_mention_unlabelled: "the text names an experimental capability without an experimental label or a negation, in the same sentence",
  capability_rated_by_writer: "the capability's rating was set by the agent that wrote or keeps this document: the owner or another director rates it",
  text_unread: "a file named as text was not read (over 50 files, over 256 KiB, over 1 MiB in all, or not UTF-8), so what it says is unchecked: split it or save it as UTF-8",
} as const;
export type ClaimRule = keyof typeof CLAIM_RULES;

export interface ClaimFlag {
  readonly rule: ClaimRule;
  readonly capabilityId?: string;
  /** `claim` (one of the record's claims, by its number) or `text` (a file of the document). */
  readonly source: "claim" | "text";
  readonly where: string;
  /** The sentence (or the claim's words), cleaned and cut. */
  readonly quote: string;
}

/** How many words on each side of a name a negation (or a weak label) may be. */
export const NEAR = 8;

/**
 * The words of a text as the label and negation tests read them (second review): lower case, edge punctuation off, curly apostrophes made plain, hyphenated words split ("non-experimental" is "non"
 * "experimental"). A word inside a link, a path or an address (`x.io/experimental`, `a@b`, `k=v`) is no word of the prose and is kept as an empty place; so is a word in quotation marks (`the
 * "experimental" tag` mentions the word, it does not label anything).
 */
function wordsOf(s: string): string[] {
  const out: string[] = [];
  for (const token of s.split(/\s+/)) {
    if (token === "") continue;
    if (/[/\\@=]|\p{L}\.\p{L}/u.test(token) || /^[^\p{L}\p{N}]*["'`\p{Pi}\p{Pf}]\p{L}.*\p{L}["'`\p{Pi}\p{Pf}][^\p{L}\p{N}]*$/u.test(token)) { out.push(""); continue; }
    const core = token.replace(/\u2019/g, "'").replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, "").toLowerCase();
    for (const w of core.split("-")) out.push(w);
  }
  return out;
}
/** Words that, one or two places before a label, take it back: "not experimental", "no longer experimental", "non-experimental". */
const UNSAYS = new Set(["not", "no", "non", "never", "nor", "isn't", "aren't", "wasn't", "hardly"]);
const unsaid = (w: readonly string[], i: number): boolean => UNSAYS.has(w[i - 1] ?? "") || UNSAYS.has(w[i - 2] ?? "");
/** An experimental label that counts anywhere in its sentence: "experimental", "unmeasured", "untested", "not (yet) measured"; not taken back just before it. */
function plainLabel(s: string): boolean {
  const w = wordsOf(s);
  return w.some((x, i) => ((x === "experimental" || x === "unmeasured" || x === "untested") && !unsaid(w, i))
    || (x === "not" && (w[i + 1] === "measured" || (w[i + 1] === "yet" && w[i + 2] === "measured")) && !unsaid(w, i)));
}
/** Labels that count only near the name (within `NEAR` words): they are common words otherwise ("Preview your bill: X halves it"). */
const weakLabel = (w: readonly string[]): boolean => w.some((x, i) => (x === "preview" || x === "beta") && !unsaid(w, i));
/**
 * Plain negations, counted only near the name (within `NEAR` words before or after it): "Don't worry: X halves your bill" is not a denial of X. "no" alone is not one (too loose: "no setup needed: X
 * does it"); "not just", "not only", "not merely" and "not simply" are not denials either.
 */
const NEGATIONS = new Set(["not", "never", "cannot", "can't", "isn't", "aren't", "doesn't", "don't", "won't", "unsupported", "unavailable"]);
/** A negation that takes back a label ("not experimental", "isn't beta any more") denies the label, not the capability. */
const LABEL_WORDS = new Set(["experimental", "unmeasured", "untested", "beta", "preview"]);
const negated = (w: readonly string[]): boolean => w.some((x, i) => NEGATIONS.has(x) && !(x === "not" && ["just", "only", "merely", "simply"].includes(w[i + 1] ?? "")) && !LABEL_WORDS.has(w[i + 1] ?? "") && !LABEL_WORDS.has(w[i + 2] ?? ""));

/**
 * The form names are matched in (second review): NFKD with every combining mark removed (so `Stra\u0301ta` and variation selectors do not hide a name), every format character removed (zero-width,
 * direction, tag characters, invisible operators), filler characters made spaces, letters of other scripts that look like Latin ones folded to them (Cyrillic `а`, Greek `ο`), and a word broken by a
 * hyphen at a line wrap joined (`Stra- ta`). Only for matching: what the owner sees quoted is the cleaned sentence.
 */
const CONFUSABLE: Readonly<Record<string, string>> = Object.fromEntries([
  ..."аa вb еe кk мm нh оo рp сc тt уy хx іi јj ѕs һh ԁd ԛq ԝw ӏl ѵv ґr".split(" ").map((p) => [p[0], p[1]]),
  ..."АA ВB ЕE КK МM НH ОO РP СC ТT УY ХX ІI ЈJ ЅS ҺH ԚQ ԜW ӀI ѴV".split(" ").map((p) => [p[0], p[1]]),
  ..."αa βb εe ιi κk νv οo ρp τt υu χx ϲc ϳj ΑA ΒB ΕE ΖZ ΗH ΙI ΚK ΜM ΝN ΟO ΡP ΤT ΥY ΧX".split(" ").map((p) => [p[0], p[1]]),
  ..."ıi ȷj ɑa ɡg ɩi ɪi ʏy ʀr ʟl ɴn ʜh ʙb ᴀa ᴄc ᴅd ᴇe ᴊj ᴋk ᴍm ᴏo ᴘp ᴛt ᴜu ᴠv ᴡw ᴢz øo ØO đd ĐD ħh łl ŁL ƚl օo սu հh ոn ԃd".split(" ").map((p) => [p[0], p[1]]),
]);
export function matchForm(s: string): string {
  // eslint-disable-next-line no-control-regex
  if (!/[^\u0000-\u007F]/.test(s)) return s.includes("-") ? s.replace(/(?<=[A-Za-z])-[ \t]+(?=[A-Za-z])/g, "") : s;
  return s.normalize("NFKD").replace(/[\p{M}\p{Cf}]+/gu, "").replace(/[\u115F\u1160\u3164\uFFA0\u2800]/g, " ")
    .replace(/[^\u0000-\u007F]/g, (c) => CONFUSABLE[c] ?? c).replace(/(?<=\p{L})-[ \t]+(?=\p{L})/gu, "");
}

const BLOCK_TAG = /^<\/?(?:p|div|h[1-6]|li|ul|ol|dl|dt|dd|tr|td|th|table|thead|tbody|br|hr|section|article|header|footer|nav|aside|main|blockquote|pre|figure|figcaption|title|option)\b/i;
/** Attributes a reader is shown or read aloud (an image's alt text, a tooltip, an accessible label): their text is scanned, as its own sentence. */
const SHOWN_ATTR = /(?:^|\s)(?:alt|title|aria-label)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi;
/** Joins what it stands between when both sides are letters or digits (a tag or Markdown mark inside a word, `Stra<b>ta</b>`); otherwise a space. A noncharacter, never text. */
const JOIN = "\uFDD0";
/** HTML comments are not shown, so they are removed whole (by search, not a pattern: an unclosed one ends the text, as a browser reads it). */
function withoutComments(s: string): string {
  let out = "";
  let from = 0;
  for (;;) {
    const at = s.indexOf("<!--", from);
    if (at < 0) return out + s.slice(from);
    out += `${s.slice(from, at)}${JOIN}`;
    const end = s.indexOf("-->", at + 4);
    if (end < 0) return out;
    from = end + 3;
  }
}
/** A browser also decodes most references without their `;` (`Strata&nbspcaching`), so the `;` is optional here. */
const ENTITY = /&(#\d{1,7}|#x[0-9a-f]{1,6}|nbsp|amp|lt|gt|quot|apos|shy|zwj|zwnj|ensp|emsp|thinsp|rsquo|lsquo|ndash|mdash|hyphen);?/gi;
const NAMED: Readonly<Record<string, string>> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", shy: "", zwj: "", zwnj: "", ensp: " ", emsp: " ", thinsp: " ", rsquo: "\u2019", lsquo: "\u2018", ndash: "-", mdash: "-", hyphen: "-" };
const entity = (_m: string, e: string): string => {
  const k = e.toLowerCase();
  if (!k.startsWith("#")) return NAMED[k] ?? " ";
  const n = k.startsWith("#x") ? Number.parseInt(k.slice(2), 16) : Number.parseInt(k.slice(1), 10);
  return Number.isSafeInteger(n) && n > 0 && n <= 0x10ffff && (n < 0xd800 || n > 0xdfff) ? String.fromCodePoint(n) : " ";
};

/**
 * Text as the checks read it and the owner sees it quoted: NFKC (so look-alike forms of letters fold); HTML block tags made line breaks and other tags spaces; HTML character references decoded (so
 * `Strata&nbsp;caching` is the name); zero-width characters and soft hyphens removed (so a name cannot be hidden by splitting it); direction marks and overrides removed (so a quote cannot be shown
 * reordered); other control characters made spaces; Markdown marks made spaces; spaces run together. A line break inside a paragraph (hard-wrapped text) is a space, as Markdown reads it; a blank line,
 * or a line that starts a list item, heading, quote, table row or code fence, is a break (a sentence boundary) unless `oneLine`.
 */
export function cleanText(raw: string, oneLine = false): string {
  let s = String(raw).normalize("NFKC");
  s = s.replace(/\r\n?|[\u2028\u0085]/g, "\n").replace(/\u2029/g, "\n\n");
  s = withoutComments(s).replace(/<[^<>]{0,500}>/g, (tag) => {
    const shown = [...tag.matchAll(SHOWN_ATTR)].map((m) => m[1] ?? m[2] ?? "").filter((x) => x.trim() !== "");
    if (shown.length > 0) return `\n\n${shown.join("\n\n")}\n\n`;
    return BLOCK_TAG.test(tag) ? "\n\n" : JOIN;
  });
  s = s.replace(/(?<=[\p{L}\p{N}])\uFDD0+(?=[\p{L}\p{N}])/gu, "").replace(/\uFDD0/g, " ").replace(ENTITY, entity).normalize("NFKC");
  // Format characters (zero-width, soft hyphen, tag characters, invisible operators) and variation selectors are removed: they show nothing and can carry hidden text into the owner's view.
  s = s.replace(/[\p{Cf}\u180B-\u180F\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, "");
  s = s.replace(/\r\n?|[\u2028\u0085]/g, "\n").replace(/\u2029/g, "\n\n");
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/g, " ");
  // A wrapped line goes on its paragraph: a break is kept before a blank line, a list item, a heading, a quote, a table row, a code fence or a setext underline.
  s = s.replace(/([^\s])[ \t]*\n(?![ \t]*(?:\n|$|[-*+#>|=]|```|~~~|\d{1,9}[.)][ \t]))/g, "$1 ");
  // A Markdown link shows its text, not its address; a reference link its text, not its label. A mark inside a word (`Stra**ta**`, `Stra`ta``) joins it, as it is shown.
  s = s.replace(/\]\([^()\n]{0,2000}\)/g, "]").replace(/\]\[[^\]\n]{0,100}\]/g, "]");
  s = s.replace(/(?<=[\p{L}\p{N}])[*`~[\]]+(?=[\p{L}\p{N}])/gu, "");
  s = s.replace(/[*_`~#>|[\]]/g, " ");
  s = s.replace(/[ \t\f\v\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]+/g, " ");
  if (oneLine) s = s.replace(/\s*\n\s*/g, " ");
  return s.replace(/ *\n */g, "\n").trim();
}

/** Sentences: split at `.`, `!` or `?` followed by a space, and at line breaks. */
export function sentencesOf(cleaned: string): string[] {
  return cleaned.split(/\n+|(?<=[.!?])\s+/).map((x) => x.trim()).filter((x) => x !== "");
}

/** On whole characters (a cut through a pair of UTF-16 units leaves none of it). */
const cut = (s: string, n: number): string => (s.length <= n ? s : `${s.slice(0, n - 3).replace(/[\uD800-\uDBFF]$/, "")}...`);
/** What a flag quotes: cleaned to one line, redacted, cut. */
export const quoteOf = (s: string): string => cut(redactText(cleanText(s, true)), CLAIM_LIMITS.quote);

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/**
 * A name as a pattern: case-insensitive, whole words, its words joined by any run of spaces or hyphens or by nothing (a name split by a removed zero-width character still matches); any word may take a
 * possessive (`Claude's prompt caching`) and the last a plural (`Strata caches`, `Windows services`). Compiled once per name.
 */
const PATTERNS = new Map<string, string>();
function patternSource(name: string): string {
  let src = PATTERNS.get(name);
  if (src === undefined) {
    const words = matchForm(cleanText(name, true)).split(/[\s-]+/).filter((w) => w !== "").map(escape);
    src = `(?<![\\p{L}\\p{N}])${words.map((w, i) => `${w}${i === words.length - 1 ? "(?:e?s)?" : ""}(?:['\u2019]s)?`).join("[\\s-]*")}(?![\\p{L}\\p{N}])`;
    if (PATTERNS.size > 5000) PATTERNS.clear();
    PATTERNS.set(name, src);
  }
  return src;
}
const patternOf = (name: string): RegExp => new RegExp(patternSource(name), "giu");
/** "no" or "without" right before a name (at most two words between): "there is no unattended Windows service", "works without Claude caching". Tested on the 120 characters before the name only. */
const DENIED_BEFORE = /(?:^|\s)(no|without)(\s+[\p{L}\p{N}'-]+){0,2}\s*$/iu;
const WINDOW_CHARS = 400;
/** The `NEAR` words before `at` and after `end` in `s` (looked for within a bounded stretch, so a long sentence costs no more per name), not past a `;` (another clause). */
function near(s: string, at: number, end: number): { before: string[]; after: string[] } {
  let b = s.slice(Math.max(0, at - WINDOW_CHARS), at);
  const semi = b.lastIndexOf(";");
  const cutStart = semi >= 0 || at <= WINDOW_CHARS;
  if (semi >= 0) b = b.slice(semi + 1);
  let a = s.slice(end, end + WINDOW_CHARS);
  if (a.includes(";")) a = a.slice(0, a.indexOf(";"));
  const before = b.split(/\s+/).filter((w) => w !== "");
  // A word cut at the stretch's start is dropped: it may be the tail of a longer word.
  if (!cutStart) before.shift();
  return { before: wordsOf(before.slice(-NEAR).join(" ")), after: wordsOf(a.split(/\s+/).filter((w) => w !== "").slice(0, NEAR).join(" ")) };
}

/**
 * Whether `sentence` (in its matching form) carries the label the maturity needs, for every place a name of the capability stands: "no" or "without" directly before it, or a negation (or, for an
 * experimental one, "preview" or "beta") within `NEAR` words of it in the same clause, or (experimental only) a plain experimental label anywhere in the sentence. Labels and negations are whole words of
 * the prose (not inside a link or another word, not quoted, not taken back by "not" or "non-"). Every name of the capability is blanked first (a name such as "nobody signed in" must not count as its own
 * negation). A sentence naming the capability twice must label both places, unless the plain label covers the whole sentence.
 */
function labelled(sentence: string, entry: CapabilityEntry): boolean {
  let blanked = sentence;
  const spots: [number, number][] = [];
  for (const n of entry.names) for (const m of sentence.matchAll(patternOf(n))) spots.push([m.index, m.index + m[0].length]);
  for (const n of entry.names) blanked = blanked.replace(patternOf(n), (m) => " ".repeat(m.length));
  if (entry.maturity === "experimental" && plainLabel(blanked)) return true;
  return spots.every(([at, end]) => {
    const from = Math.max(0, at - 120);
    if (DENIED_BEFORE.test(`${from > 0 ? "x" : ""}${sentence.slice(from, at)}`)) return true;
    const { before, after } = near(blanked, at, end);
    return negated(before) || negated(after) || (entry.maturity === "experimental" && (weakLabel(before) || weakLabel(after)));
  });
}

export interface DeclaredClaim { readonly text: string; readonly taskId: string; readonly capabilityId?: string }

/** The record's claims against the register. */
export function checkDeclared(claims: readonly DeclaredClaim[], register: readonly CapabilityEntry[]): { flags: ClaimFlag[]; capabilities: Record<string, CapabilityMaturity> } {
  const flags: ClaimFlag[] = [];
  const capabilities: Record<string, CapabilityMaturity> = {};
  claims.forEach((c, i) => {
    const where = `claim ${i + 1}`;
    const quote = quoteOf(c.text);
    if (c.capabilityId === undefined) { flags.push({ rule: "claim_without_capability", source: "claim", where, quote }); return; }
    const entry = register.find((e) => e.id === c.capabilityId);
    if (entry === undefined) { flags.push({ rule: "unknown_capability", capabilityId: c.capabilityId, source: "claim", where, quote }); return; }
    capabilities[entry.id] = entry.maturity;
    if (entry.maturity === "unsupported") flags.push({ rule: "unsupported_capability_claimed", capabilityId: entry.id, source: "claim", where, quote });
    else if (entry.maturity === "experimental" && !plainLabel(matchForm(cleanText(c.text, true))) && !weakLabel(wordsOf(matchForm(cleanText(c.text, true))))) flags.push({ rule: "experimental_claim_unlabelled", capabilityId: entry.id, source: "claim", where, quote });
  });
  return { flags, capabilities };
}

/** One text (a file of the document, or anything else to scan) against the register's experimental and unsupported capabilities. `capabilities` lists every one named, labelled or not. */
export function scanText(raw: string, register: readonly CapabilityEntry[], where: string): { flags: ClaimFlag[]; capabilities: Record<string, CapabilityMaturity> } {
  const flags: ClaimFlag[] = [];
  const capabilities: Record<string, CapabilityMaturity> = {};
  if (register.length === 0) return { flags, capabilities };
  // Supported capabilities are looked for too, but only to record that the text names them: a later lower rating then flags the document (card Q03), as it does one that claimed it.
  const any = register.map((e) => new RegExp(e.names.map(patternSource).join("|"), "iu"));
  const cleaned = cleanText(raw);
  // Only the capabilities named somewhere in the text are looked for sentence by sentence (the matching form is per character, so a name in a sentence is a name in the whole text).
  const whole = matchForm(cleaned);
  const present = any.map((r) => r.test(whole));
  if (!present.includes(true)) return { flags, capabilities };
  for (const sentence of sentencesOf(cleaned)) {
    // Matched in its matching form; quoted as it was cleaned.
    const folded = matchForm(sentence);
    for (const [i, entry] of register.entries()) {
      if (!present[i] || !any[i]!.test(folded)) continue;
      capabilities[entry.id] = entry.maturity;
      if (entry.maturity === "supported" || labelled(folded, entry)) continue;
      flags.push({ rule: entry.maturity === "unsupported" ? "unsupported_mention" : "experimental_mention_unlabelled", capabilityId: entry.id, source: "text", where, quote: quoteOf(sentence) });
    }
  }
  return { flags, capabilities };
}

/** Which files of a document artifact are read as text (by name). Others (images, archives) are listed as not read. */
export const TEXT_FILE = /\.(md|markdown|mdx|txt|text|rst|adoc|asciidoc|html?|xhtml|csv|json|ya?ml|po)$/i;

/** Where a flag stands for a file of the document: its path, cleaned to one line, redacted, cut and JSON-quoted (a path is the writer's text, like the sentence). */
// eslint-disable-next-line no-control-regex
export const fileWhere = (path: string): string => `file ${JSON.stringify(cut(redactText(String(path).replace(/[\u0000-\u001F\u007F-\u009F\u2028\u2029\p{Cf}\uFE00-\uFE0F\u{E0100}-\u{E01EF}]/gu, " ")), 120))}`;

/** A flag in plain words, for the owner: the rule, the capability and the quoted sentence. */
export function claimFlagText(f: ClaimFlag): string {
  return `${f.where}${f.capabilityId === undefined ? "" : ` (${f.capabilityId})`}: ${CLAIM_RULES[f.rule]}: ${JSON.stringify(f.quote)}`;
}

/** Order of maturities, for "was it rated higher when the document was verified?". */
export const maturityRank = (m: CapabilityMaturity): number => (m === "supported" ? 2 : m === "experimental" ? 1 : 0);

/** What the reader needs of the artifact service (card S06): the manifest and one file's verified bytes. */
export interface DocumentArtifacts {
  get(id: string): Promise<{ readonly projectId?: string; readonly manifestDigest: string; readonly entries: readonly { readonly path: string; readonly size: number }[] } | undefined>;
  readFile(id: string, path: string, options?: { maxBytes?: number }): Promise<Uint8Array>;
}

/**
 * The `readDocument` port of the documentation obligations (card Q03): the text of the artifact a document change names. Refused (an `invalid_command` naming the reason) when the artifact is missing, of
 * another project, or not the one the submission's digest names (the digest is `sha256:` and the artifact's manifest digest, as the tool bridge records it); a damaged file is the artifact service's
 * `integrity` error. Files are read in path order: those named as text, up to 50 files, 256 KiB each and 1 MiB in all, decoded as UTF-8 (a file that is not is skipped, never guessed at).
 */
export function artifactDocumentReader(artifacts: DocumentArtifacts): (d: { readonly artifactId: string; readonly artifactDigest: string; readonly projectId: string }) => Promise<{ files: { path: string; text: string }[]; skipped: string[]; unread: { path: string; why: string }[] }> {
  const refuse = (why: string): never => { throw new DomainError("invalid_command", `documentSubmissionId: ${why}`, { field: "documentSubmissionId" }); };
  return async (d) => {
    const a = await artifacts.get(d.artifactId);
    if (a === undefined) return refuse(`its artifact ${d.artifactId} is not stored on this controller`);
    // An artifact that names no project is not read: whose text it is cannot be told (every publishing path names one).
    if (a.projectId === undefined) return refuse("its artifact names no project, so it cannot be read for this one");
    if (a.projectId !== d.projectId) return refuse("its artifact belongs to another project");
    if (d.artifactDigest !== `sha256:${a.manifestDigest}` && d.artifactDigest !== a.manifestDigest) return refuse("its artifact's files are not the ones the document change recorded (the digests differ)");
    const files: { path: string; text: string }[] = [];
    const skipped: string[] = [];
    // Files named as text that were not read: the claim check flags each (a document cannot pass by being large or not UTF-8).
    const unread: { path: string; why: string }[] = [];
    let total = 0;
    const decoder = new TextDecoder("utf-8", { fatal: true });
    for (const e of [...a.entries].sort((x, y) => (x.path < y.path ? -1 : x.path > y.path ? 1 : 0))) {
      if (!TEXT_FILE.test(e.path)) { skipped.push(e.path); continue; }
      const why = files.length >= CLAIM_LIMITS.files ? `more than ${CLAIM_LIMITS.files} text files` : e.size > CLAIM_LIMITS.fileBytes ? `larger than ${CLAIM_LIMITS.fileBytes / 1024} KiB` : total + e.size > CLAIM_LIMITS.totalBytes ? `over ${CLAIM_LIMITS.totalBytes / 1024 / 1024} MiB of text in all` : undefined;
      if (why !== undefined) { skipped.push(e.path); unread.push({ path: e.path, why }); continue; }
      const bytes = await artifacts.readFile(d.artifactId, e.path, { maxBytes: CLAIM_LIMITS.fileBytes });
      try { files.push({ path: e.path, text: decoder.decode(bytes) }); total += e.size; } catch { skipped.push(e.path); unread.push({ path: e.path, why: "not UTF-8" }); }
    }
    return { files, skipped, unread };
  };
}
