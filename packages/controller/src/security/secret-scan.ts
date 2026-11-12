/**
 * Where a secret is in a text, seen the way a reader sees it (the credential-redaction follow-up of U09b and W13). `redactText` and `findCredentialShapes` both use it, so redaction and refusal agree.
 *
 * The text is matched through a folded VIEW, never changed by the fold itself: every code point is NFKC-folded (a fullwidth `ｇｈｐ＿` or a ligature is the plain letters), every dash is a hyphen, and the
 * invisible characters (C0/C1 controls but tab and line breaks, zero-width characters, bidirectional marks, soft hyphens, tags, variation selectors, fillers: `isHidden`) are left out. Each view unit
 * remembers the original code point it came from, so a match is redacted in the ORIGINAL text, invisible characters inside it included, and the rest of the text keeps its own characters.
 *
 * Found in the view:
 * - every shape of `CREDENTIAL_PATTERNS`; the key prefixes (`sk-`, `ghp_`, `github_pat_`, `AKIA`, `xox`, `npm_`) in any letter case;
 * - the prefixed tokens again in a second view where a line break between two token characters is removed (a key wrapped or split over lines);
 * - the base64 lines just above a private key's END line with no BEGIN before it (the rest of a key split over two blocks; the END line itself stays);
 * - a long high-entropy hex or base64 run with no known prefix (`highEntropy`), with a conservative threshold and exemptions for the digests and IDs the product shows.
 * A match that covers a line break is redacted line by line, so redaction never joins two lines (cutNote counts lines).
 */
import { CREDENTIAL_PATTERNS } from "./credential-patterns.js";

export const HIGH_ENTROPY = "high-entropy key";

/**
 * Code points left out of the matching view, and removed by `cleanUntrusted`: C0 controls except tab, newline and carriage return, DEL and C1, soft hyphen, combining grapheme joiner, Arabic letter mark,
 * Mongolian vowel separator, zero-width and bidirectional characters, line and paragraph separators, word joiner and invisible operators, BOM, interlinear annotation, Hangul and Khmer fillers, variation
 * selectors, shorthand format controls, musical formatting, tags. Any other `\p{Cf}` character is hidden as well.
 */
export const HIDDEN_RANGES: readonly (readonly [number, number])[] = [[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], [0x7f, 0x9f], [0xad, 0xad], [0x61c, 0x61c], [0x180e, 0x180e], [0x200b, 0x200f], [0x2028, 0x2029], [0x202a, 0x202e], [0x2060, 0x2069], [0xfeff, 0xfeff], [0xfff9, 0xfffb], [0x34f, 0x34f], [0x115f, 0x1160], [0x17b4, 0x17b5], [0x3164, 0x3164], [0xfe00, 0xfe0f], [0xffa0, 0xffa0], [0x1bca0, 0x1bca3], [0x1d173, 0x1d17a], [0xe0000, 0xe007f], [0xe0100, 0xe01ef]];
const FORMAT = /^\p{Cf}$/u;
export function isHidden(ch: string): boolean {
  const cp = ch.codePointAt(0)!;
  if (cp < 0x80) return (cp <= 0x08 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || cp === 0x7f);
  return HIDDEN_RANGES.some(([a, b]) => cp >= a && cp <= b) || FORMAT.test(ch) || (cp >= 0xd800 && cp <= 0xdfff);
}
/** Dashes NFKC leaves as they are, read as a hyphen. */
const DASHES = new Set([0x2010, 0x2011, 0x2012, 0x2013, 0x2014, 0x2015, 0x2212, 0x2e3a, 0x2e3b, 0xfe58, 0xfe63, 0xff0d]);

/** The matching view: `start`/`end` give the original code point a view unit came from (absent for a plain ASCII text, which is its own view). */
interface View { readonly text: string; readonly start?: readonly number[]; readonly end?: readonly number[] }
const startOf = (v: View, k: number): number => (v.start === undefined ? k : v.start[k]!);
const endOf = (v: View, k: number): number => (v.end === undefined ? k + 1 : v.end[k]!);
const PLAIN = /^[\t\n\r\x20-\x7e]*$/;
/** Combining marks are left out of the matching VIEW only (never removed from the text): an accent put on a key's letter (`ghp_ab\u0301c…`) must not hide the key. */
const MARK = /^\p{M}$/u;

function fold(src: string): View {
  if (PLAIN.test(src)) return { text: src };
  const start: number[] = [];
  const end: number[] = [];
  let text = "";
  let i = 0;
  for (const ch of src) {
    const at = i;
    i += ch.length;
    if (isHidden(ch) || MARK.test(ch)) continue;
    const cp = ch.codePointAt(0)!;
    const n = DASHES.has(cp) ? "-" : cp < 0x80 ? ch : ch.normalize("NFKC");
    for (let k = 0; k < n.length; k++) { start.push(at); end.push(i); }
    text += n;
  }
  return { text, start, end };
}

/** The view with line breaks (and the spaces around them) between two token characters removed: `ghp_abc⏎def` reads `ghp_abcdef`. */
const TOKEN_CHAR = /[A-Za-z0-9_.-]/;
function joinLines(v: View): View {
  const start: number[] = [];
  const end: number[] = [];
  let text = "";
  const t = v.text;
  const BREAK = /[ \t]*(?:\r\n?|\n)[ \t]*/y;
  for (let k = 0; k < t.length;) {
    if ((t[k] === "\n" || t[k] === "\r" || t[k] === " " || t[k] === "\t") && k > 0 && TOKEN_CHAR.test(t[k - 1]!)) {
      BREAK.lastIndex = k;
      const m = BREAK.exec(t);
      if (m !== null && /[\r\n]/.test(m[0]) && k + m[0].length < t.length && TOKEN_CHAR.test(t[k + m[0].length]!)) { k += m[0].length; continue; }
    }
    text += t[k]; start.push(startOf(v, k)); end.push(endOf(v, k)); k++;
  }
  return text.length === t.length ? v : { text, start, end };
}

/** Key prefixes matched in any letter case: a model that writes `GHP_…` or `Sk-…` still wrote the key. (The AWS pattern spells its own case-free prefix: its body stays upper case.) */
const CASE_FREE = new Set(["API key (sk-)", "GitHub token", "GitHub fine-grained token", "Slack token", "npm token", "service token"]);
/** Shapes with a fixed prefix and no spaces inside, looked for again with line breaks removed (with the private key block, the only shapes that may honestly cover a line break). */
export const JOINABLE = new Set(["NimbleNewt token", "API key (sk-)", "GitHub token", "GitHub fine-grained token", "AWS access key", "JSON web token", "Slack token", "Google API key", "Stripe key", "npm token", "service token"]);
let folded: { name: string; pattern: RegExp; joinable: boolean; url: boolean }[] | undefined;
/** Compiled on first use: `credential-patterns.ts` imports this module, so the list is not read while the modules load. */
const FOLDED = (): { name: string; pattern: RegExp; joinable: boolean; url: boolean }[] => (folded ??= CREDENTIAL_PATTERNS.map(({ name, pattern }) => ({ name, pattern: new RegExp(pattern.source, CASE_FREE.has(name) && !pattern.flags.includes("i") ? `${pattern.flags}i` : pattern.flags), joinable: JOINABLE.has(name), url: name === "URL with embedded password" })));
/**
 * The base64 lines right above a private key's END line that has no BEGIN in this text (the rest of a key split over two texts). The END line itself is not secret and stays: readers such as the
 * job output store look for it to know a key block that began in an earlier piece has ended. Found by walking back from each END line (linear: a regex with a repeated group before a lookahead
 * took quadratic time over a long base64 dump with no END, about 6 s for 256 KB).
 */
const END_LINE = /^[ \t]*-----END [A-Z ]*PRIVATE KEY-----/gm;
const KEY_LINE = /^[ \t]*[A-Za-z0-9+/=]{4,}[ \t]*\r?$/;
function orphanEnds(text: string): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let floor = 0;
  for (const m of text.matchAll(END_LINE)) {
    let start = m.index;
    while (start > floor) {
      const prev = text.lastIndexOf("\n", start - 2) + 1;
      if (prev < floor || !KEY_LINE.test(text.slice(prev, start - 1))) break;
      start = prev;
    }
    if (start < m.index) out.push({ start, end: m.index });
    floor = m.index + m[0].length;
  }
  return out;
}

/** A run of hex or base64 characters, not part of a longer one and not a sealed cursor (`~` + base64url). */
const RUN = /(?<![A-Za-z0-9+/_~-])[A-Za-z0-9+/_-]{32,}={0,2}(?![A-Za-z0-9+/_=-])/g;
/** A digest written as `label:` + base64 (go.sum `h1:`, `sha256:`), left as it is. */
const DIGEST_BEFORE = /(?:^|[^A-Za-z0-9])(?:h1|sha1|sha224|sha256|sha384|sha512|md5|blake2b|blake3):$/i;
/** An SSH public key's wire format (`ssh-rsa AAAAB3NzaC1yc2E…`, `ssh-ed25519 AAAAC3NzaC1lZDI1NTE5…`, ecdsa `AAAAE2VjZHNh…`): public, shown in authorized_keys and known_hosts. */
const SSH_PUBLIC = /^AAAA(?:B3NzaC1yc2E|C3NzaC1lZDI1NTE5|E2VjZHNhLXNoYTIt|B3NzaC1kc3)/;
/** Hex lengths the product shows as digests or IDs with no label: 32 (MD5-sized digests and the bridge's change IDs), 40 (git SHA-1), 64 (SHA-256, git SHA-256), 128 (SHA-512). */
const HEX_SHOWN = new Set([32, 40, 64, 128]);
const DIGEST_LABEL = /^(?:sha1|sha224|sha256|sha384|sha512|md5|blake2b|blake3)[-_]/i;
const WORDLIKE = /^(?:[a-z]{3,}|[A-Z][a-z]{2,}|[A-Z]{3,}|\d+|[a-z]{3,}\d+|v\d+(?:\.\d+)*)$/;
/** Minimum Shannon entropy (bits per character) and share of neighbouring characters of different classes (upper, lower, digit, other) for a base64 run to count as a key. */
export const ENTROPY_MIN_BITS = 3.7;
export const ENTROPY_MIN_TRANSITIONS = 0.25;
/** Share of a run made of pronounceable words (three or more letters with a vowel) at which it is read as a code name, not a key. */
export const ENTROPY_MAX_WORDS = 0.8;

/** Whether one run (see RUN) is a key with no known prefix. Exported for tests. */
export function highEntropy(run: string): boolean {
  const s = run.replace(/=+$/, "");
  if (s.length < 32 || DIGEST_LABEL.test(s) || SSH_PUBLIC.test(s)) return false;
  if (/^[0-9a-f]+$/.test(s) || /^[0-9A-F]+$/.test(s)) return /\d/.test(s) && /[a-f]/i.test(s) && !HEX_SHOWN.has(s.length);
  if (!/[A-Z]/.test(s) || !/[a-z]/.test(s) || !/\d/.test(s)) return false;
  // An absolute path from the root of a file system, such as macOS's per-user temporary folder (`/var/folders/0t/k_8g3pzs4gn5b0g8l2h6xw8m0000gn/T/nn-tv-AbC123`, whose generated names are not words): it
  // starts with "/" and a word (`var`, `Users`, `private`, `home`), has three or more names, and none of its names is a key by itself. A key that sits in a path as one name is still found.
  if (s.startsWith("/")) {
    const names = s.slice(1).split("/");
    if (names.length >= 3 && WORDLIKE.test(names[0]!) && names.every((n) => !highEntropy(n))) return false;
  }
  // A path, a URL's path or a name made of words (`backup-20261028T100000Z-scheduled`): most of its pieces are words.
  const pieces = s.split(/[/_-]+/).filter((p) => p.length > 0);
  if (pieces.length >= 3 && pieces.filter((p) => WORDLIKE.test(p)).length * 2 >= pieces.length) return false;
  // A code name (`ThinkingCollectionBodyRevision2UpdatedAt`): most of it is pronounceable words of three or more letters. Random keys of 32+ characters stayed below 0.79 in 150,000 samples.
  let words = 0;
  for (const m of s.matchAll(/[A-Z]?[a-z]{2,}/g)) if (m[0].length >= 3 && /[aeiouy]/i.test(m[0])) words += m[0].length;
  if (words / s.length >= ENTROPY_MAX_WORDS) return false;
  const cls = (c: string): number => (c >= "A" && c <= "Z" ? 0 : c >= "a" && c <= "z" ? 1 : c >= "0" && c <= "9" ? 2 : 3);
  let changes = 0;
  const freq = new Map<string, number>();
  for (let i = 0; i < s.length; i++) {
    if (i > 0 && cls(s[i]!) !== cls(s[i - 1]!)) changes++;
    freq.set(s[i]!, (freq.get(s[i]!) ?? 0) + 1);
  }
  let bits = 0;
  for (const n of freq.values()) { const p = n / s.length; bits -= p * Math.log2(p); }
  return bits >= ENTROPY_MIN_BITS && changes / (s.length - 1) >= ENTROPY_MIN_TRANSITIONS;
}

/**
 * A match of the line-joined view that took the next line's first word: the part before the line break is already a whole token of the same shape and what follows the break is a plain word
 * (`…sk-live-…1234⏎step 011`). The token is redacted from the plain view; the word is the next line's own. (A key whose wrapped tail happens to be a plain word keeps that tail: see the notes.)
 */
function runsOnIntoWord(text: string, start: number, end: number, pattern: RegExp): boolean {
  const piece = text.slice(start, end);
  const brk = piece.search(/\r\n?|\n/);
  if (brk < 0) return false;
  const tail = piece.slice(Math.max(piece.lastIndexOf("\n"), piece.lastIndexOf("\r")) + 1).trim();
  if (!WORDLIKE.test(tail)) return false;
  const first = new RegExp(`^(?:${pattern.source})$`, pattern.flags.replace("g", ""));
  return first.test(piece.slice(0, brk).replace(/[ \t]+$/, ""));
}

export interface SecretSpan { readonly start: number; readonly end: number; readonly name: string }

/** The secrets of `text` as spans of the original text (UTF-16 offsets, end exclusive), possibly overlapping. */
export function scanSecrets(text: string): SecretSpan[] {
  const out: SecretSpan[] = [];
  const a = fold(text);
  // A span ends after any combining marks on its last character (left out of the view, they belong to that character).
  const markEnd = (at: number): number => { let k = at; for (;;) { const cp = text.codePointAt(k); if (cp === undefined || !MARK.test(String.fromCodePoint(cp))) return k; k += cp > 0xffff ? 2 : 1; } };
  const push = (v: View, s: number, e: number, name: string): void => { if (e > s) out.push({ start: startOf(v, s), end: v.start === undefined ? endOf(v, e - 1) : markEnd(endOf(v, e - 1)), name }); };
  // Only a text with a line break can have a token split over lines.
  const b = /[\r\n]/.test(a.text) ? joinLines(a) : a;
  for (const { name, pattern, joinable, url } of FOLDED()) {
    for (const v of joinable && b !== a ? [a, b] : [a]) {
      pattern.lastIndex = 0;
      for (const m of v.text.matchAll(pattern)) {
        if (v === b && runsOnIntoWord(text, startOf(b, m.index), endOf(b, m.index + m[0].length - 1), pattern)) continue;
        if (url) { const colon = m[0].lastIndexOf(":"); push(v, m.index + colon + 1, m.index + m[0].length - 1, name); } else push(v, m.index, m.index + m[0].length, name);
      }
    }
  }
  for (const o of orphanEnds(a.text)) push(a, o.start, o.end, "private key block");
  for (const m of a.text.matchAll(RUN)) if (highEntropy(m[0]) && !DIGEST_BEFORE.test(a.text.slice(Math.max(0, m.index - 8), m.index))) push(a, m.index, m.index + m[0].length, HIGH_ENTROPY);
  return out;
}

/**
 * A key or password given in plain words by a person (card U14c review): "my password is Tr0ub4dor&3", "the api key for openrouter is 9f8e…", "here is the key: abcdEFGH1234…". No shape of
 * `CREDENTIAL_PATTERNS` catches these (they have no prefix, and a short or hex value is not a high-entropy run). Read in the same folded view as `scanSecrets` (zero-width characters left out, fullwidth
 * letters folded). The value must be one piece of eight or more characters with a letter and a digit, so "the token is expired" and "my key is in the secret store" are not keys, and a value written
 * like a secret's NAME (lower-case pieces joined by `-`, `_` or `.`, none longer than 15 characters: `backup-key2`) is the name the owner is asked to give, not a key. Only the chat refuses with it; it
 * is not a redaction rule, because a person's words are the one place a label like "password is" is reliably about a value that follows.
 */
const LABELLED = /(?<![a-z0-9])(?:pass(?:word|wd|phrase|code)|api[-_ ]?key|access[-_ ]?(?:key|token)|secret(?:[-_ ]?key)?|private[-_ ]?key|auth[-_ ]?token|token|key)s?(?:\s+(?:for|of|to|on|at)\s+[^\s.,;:!?]+){0,2}\s*(?:(?:is|was|=|:=|:)\s*)+["'`]?([^\s"'`]{8,})/giu;
const SECRET_NAME = /^[a-z][a-z0-9]*(?:[-_.][a-z0-9]+)+$/;
export function labelledSecret(text: string): boolean {
  if (typeof text !== "string") return false;
  for (const m of fold(text).text.matchAll(LABELLED)) {
    const value = m[1]!.replace(/[.,;:!?)\]]+$/, "");
    if (value.length < 8 || !/\p{L}/u.test(value) || !/\d/.test(value)) continue;
    if (SECRET_NAME.test(value) && value.split(/[-_.]/).every((p) => p.length <= 15)) continue;
    return true;
  }
  return false;
}

/** `text` with each span replaced by `mark`, line by line (a span over a line break leaves the break and marks each line's part), and a span that is already only `mark` left alone. */
export function replaceSpans(text: string, spans: readonly SecretSpan[], mark: string): string {
  if (spans.length === 0) return text;
  const sorted = [...spans].sort((x, y) => x.start - y.start || y.end - x.end);
  const merged: { start: number; end: number }[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last !== undefined && s.start <= last.end) last.end = Math.max(last.end, s.end); else merged.push({ start: s.start, end: s.end });
  }
  let result = "";
  let at = 0;
  for (const { start, end } of merged) {
    const piece = text.slice(start, end);
    result += text.slice(at, start);
    result += piece === mark ? piece : piece.split(/(\r?\n|\r)/).map((p, i) => (i % 2 === 1 || p.trim() === "" ? p : mark)).join("");
    at = end;
  }
  return result + text.slice(at);
}
