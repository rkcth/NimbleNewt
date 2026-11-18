// Card W01b. pi-ai 1.3.0 cleans lone surrogates out of every text it sends (`sanitizeSurrogates`) except the arguments of
// earlier tool calls, which it re-sends as `JSON.stringify(arguments)` (openai-completions.js line 1041,
// openai-responses-shared.js line 242; anthropic-messages.js line 1176 sends the object as `input`). A model whose tool-call
// arguments decode to a lone surrogate (its JSON held `\ud800` without the other half) therefore gets the rest of its
// conversation refused by a strict server: the arguments text is no longer valid Unicode JSON. The bench met it through Pi's
// edit tool (W01 night batch); here it needs no such tool, only those arguments.
//
// cleanPayload() is applied to every request body pi-ai builds for the adapter's models (cache-shaping.ts, onPayload). It
// changes only lone surrogates (U+D800..U+DFFF not part of a valid pair), into U+FFFD:
//   - in the JSON text of every tool call's arguments (OpenAI chat `messages[].tool_calls[].function.arguments`, OpenAI
//     responses `input[]` items of type `function_call`): an escape that is not half of a pair becomes `\ufffd`,
//     a raw lone surrogate becomes U+FFFD; a pair written half escaped, half raw has its raw half written as the escape (the same pair once decoded,
//     and no lone surrogate left in the text, a string of the request body); every other character, escape, pair and
//     piece of formatting stays as it was;
//   - in every other string and every object key (Anthropic's `input` objects among them), and in an arguments text that is
//     not valid JSON: a raw lone surrogate becomes U+FFFD.
// It copies only along changed paths and returns the same object when nothing needs it. It never throws.
// The bench's Pi extension carries the same rules in JavaScript (scripts/pi-eval/lib/arg-clean.mjs).

const isHigh = (u: number): boolean => u >= 0xd800 && u <= 0xdbff;
const isLow = (u: number): boolean => u >= 0xdc00 && u <= 0xdfff;
const HEX4 = /^[0-9a-fA-F]{4}$/;
function escapeAt(s: string, i: number): number {
  if (s.charCodeAt(i) !== 0x5c || s[i + 1] !== "u") return -1;
  const h = s.slice(i + 2, i + 6);
  return HEX4.test(h) ? Number.parseInt(h, 16) : -1;
}

/** The six-character JSON escape of a code unit (a surrogate: always four hex digits). */
const hexEscape = (u: number): string => `\\u${u.toString(16).padStart(4, "0")}`;

/** A string with every raw lone surrogate replaced by U+FFFD (pairs kept); the same string when there is none. */
export function wellFormed(s: string): string {
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/**
 * JSON text with every lone surrogate, escaped or raw, replaced by U+FFFD. `text` is the same string when `replaced` is 0.
 * A pair is kept however its halves are written; one written half escaped, half raw gets its raw half written as the escape
 * (the same pair once decoded, and no lone surrogate in the text itself, which is sent as a string of the request body).
 * Text that is not valid JSON is not read as escapes: only its raw lone surrogates are replaced, as in any other string.
 */
export function cleanJsonText(s: string): { text: string; replaced: number } {
  let out = "";
  let last = 0;
  let replaced = 0;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) {
      const u = escapeAt(s, i);
      if (u === -1) { i += 2; continue; }
      if (isHigh(u) && isLow(escapeAt(s, i + 6))) { i += 12; continue; }
      // An escaped high half before a raw low half: JSON decodes them to the pair, but the raw half alone in the text is a
      // lone surrogate where the text itself is sent (a string of the request body), so it is written as its escape.
      if (isHigh(u) && isLow(s.charCodeAt(i + 6))) { out += `${s.slice(last, i + 6)}${hexEscape(s.charCodeAt(i + 6))}`; i += 7; last = i; replaced++; continue; }
      if (isHigh(u) || isLow(u)) { out += `${s.slice(last, i)}\\ufffd`; i += 6; last = i; replaced++; continue; }
      i += 6;
      continue;
    }
    if (isHigh(c) && isLow(s.charCodeAt(i + 1))) { i += 2; continue; }
    // A raw high half before an escaped low half: the raw half is written as its escape, as above.
    if (isHigh(c) && isLow(escapeAt(s, i + 1))) { out += `${s.slice(last, i)}${hexEscape(c)}${s.slice(i + 1, i + 7)}`; i += 7; last = i; replaced++; continue; }
    if (isHigh(c) || isLow(c)) { out += `${s.slice(last, i)}�`; i += 1; last = i; replaced++; continue; }
    i++;
  }
  // The scan skips the character after any backslash, so a raw lone surrogate there (text that is not JSON) is caught here.
  if (replaced === 0) { const w = wellFormed(s); return { text: w, replaced: w === s ? 0 : 1 }; }
  try { JSON.parse(s); } catch {
    const w = wellFormed(s);
    return { text: w, replaced: w === s ? 0 : 1 };
  }
  return { text: out + s.slice(last), replaced };
}

const MAX_DEPTH = 64;
const isPlain = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

function isArgumentsText(path: readonly (string | number)[], parent: unknown): boolean {
  const n = path.length;
  if (path[n - 1] !== "arguments") return false;
  if (n === 6 && path[0] === "messages" && path[2] === "tool_calls" && path[4] === "function") return true;
  return n === 3 && path[0] === "input" && isPlain(parent) && parent["type"] === "function_call";
}

export interface CleanResult { readonly payload: unknown; readonly strings: number; readonly arguments: number }

/** The payload with lone surrogates replaced (see the header), and how many strings (and of them tool-call arguments) changed. */
export function cleanPayload(payload: unknown): CleanResult {
  let strings = 0;
  let args = 0;
  try {
    const walk = (v: unknown, path: (string | number)[], parent: unknown, depth: number): unknown => {
      if (typeof v === "string") {
        if (isArgumentsText(path, parent)) {
          const r = cleanJsonText(v);
          if (r.replaced > 0) { strings++; args++; }
          return r.text;
        }
        const w = wellFormed(v);
        if (w !== v) strings++;
        return w;
      }
      if (depth >= MAX_DEPTH) return v;
      if (Array.isArray(v)) {
        let copy: unknown[] | undefined;
        for (let i = 0; i < v.length; i++) {
          const n = walk(v[i], [...path, i], v, depth + 1);
          if (n !== v[i]) { copy ??= v.slice(); copy[i] = n; }
        }
        return copy ?? v;
      }
      if (isPlain(v)) {
        let copy: Record<string, unknown> | undefined;
        const keys = Object.keys(v);
        for (const k of keys) {
          const n = walk(v[k], [...path, k], v, depth + 1);
          if (n !== v[k]) { copy ??= { ...v }; copy[k] = n; }
        }
        // A key is a string too (an Anthropic `input` object's own keys): the object is rebuilt in the same order when one changes.
        if (keys.some((k) => wellFormed(k) !== k)) {
          const from = copy ?? v;
          const rebuilt = (Object.getPrototypeOf(v) === null ? Object.create(null) : {}) as Record<string, unknown>;
          for (const k of keys) {
            const w = wellFormed(k);
            if (w !== k) strings++;
            Object.defineProperty(rebuilt, w, { value: from[k], enumerable: true, writable: true, configurable: true });
          }
          return rebuilt;
        }
        return copy ?? v;
      }
      return v;
    };
    return { payload: walk(payload, [], undefined, 0), strings, arguments: args };
  } catch {
    return { payload, strings: 0, arguments: 0 };
  }
}
