// Card W01b: keep the tool-call arguments Pi re-sends valid Unicode JSON.
// Pi 1.5.0's edit tool parses an `edits` argument the model sent as a JSON string into the model's own arguments object
// (prepareEditArguments), so the call kept in the conversation can hold a lone surrogate (from the model's `\ud800`
// escape); pi-ai then re-sends it as `JSON.stringify(tc.arguments)`, which writes the surrogate back as an escape, and a
// strict server refuses the history ("messages[N].tool_calls[0].function.arguments is not JSON"). Every other text field
// is cleaned by pi-ai; tool-call arguments are not.
//
// cleanPayload() is the repair, used by the bench's Pi extension (../arg-clean-extension.mjs). It changes only lone
// surrogates (U+D800..U+DFFF not part of a valid pair), into U+FFFD:
//   - in the JSON text of every tool call's arguments (OpenAI chat `messages[].tool_calls[].function.arguments` and
//     OpenAI responses `input[]` items of type `function_call`): a `\uD800`-style escape that is not half of an escaped
//     pair becomes the escape `\ufffd`, a raw lone surrogate becomes U+FFFD; every other character, escape, pair (both
//     halves escaped, both raw, or one of each) and piece of formatting is left as it was;
//   - in every other string and every object key of the payload, and in an arguments text that is not valid JSON: a raw
//     lone surrogate becomes U+FFFD (an escape-like text there is the author's own text and is left alone).
// Nothing is changed in place: a changed payload is a copy along the changed paths only, so a payload that needs nothing
// is returned as the same object. It never throws (anything unexpected returns the payload as it was).

const isHigh = (u) => u >= 0xd800 && u <= 0xdbff;
const isLow = (u) => u >= 0xdc00 && u <= 0xdfff;
const HEX4 = /^[0-9a-fA-F]{4}$/;
/** The code unit of a `\uXXXX` escape starting at i (the backslash), or -1 when there is none there. */
function escapeAt(s, i) {
  if (s.charCodeAt(i) !== 0x5c || s[i + 1] !== "u") return -1;
  const h = s.slice(i + 2, i + 6);
  return HEX4.test(h) ? Number.parseInt(h, 16) : -1;
}

/** A string with every raw lone surrogate replaced by U+FFFD (pairs kept). */
export function wellFormed(s) {
  if (typeof s.isWellFormed === "function") return s.isWellFormed() ? s : s.toWellFormed();
  return s.replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "�");
}

/**
 * JSON text with every lone surrogate, escaped or raw, replaced by U+FFFD (an escape `\ufffd` for an escape, the
 * character for a raw one). Returns { text, replaced }; text is the same string when nothing was replaced. A pair is kept
 * however its halves are written (JSON decodes escaped, raw and mixed halves alike to the pair). Text that is not valid
 * JSON is not read as escapes: only its raw lone surrogates are replaced, as in any other string.
 */
export function cleanJsonText(s) {
  let out = "";
  let last = 0;
  let replaced = 0;
  for (let i = 0; i < s.length;) {
    const c = s.charCodeAt(i);
    if (c === 0x5c) {
      const u = escapeAt(s, i);
      if (u === -1) { i += 2; continue; } // any other escape, `\\` included: its second character is not looked at again
      if (isHigh(u) && isLow(escapeAt(s, i + 6))) { i += 12; continue; }
      if (isHigh(u) && isLow(s.charCodeAt(i + 6))) { i += 7; continue; } // an escaped high half before a raw low half
      if (isHigh(u) || isLow(u)) { out += `${s.slice(last, i)}\\ufffd`; i += 6; last = i; replaced++; continue; }
      i += 6;
      continue;
    }
    if (isHigh(c) && isLow(s.charCodeAt(i + 1))) { i += 2; continue; }
    if (isHigh(c) && isLow(escapeAt(s, i + 1))) { i += 7; continue; } // a raw high half before an escaped low half
    if (isHigh(c) || isLow(c)) { out += `${s.slice(last, i)}�`; i += 1; last = i; replaced++; continue; }
    i++;
  }
  if (replaced === 0) return { text: s, replaced: 0 };
  try { JSON.parse(s); } catch {
    const w = wellFormed(s);
    return { text: w, replaced: w === s ? 0 : 1 };
  }
  return { text: out + s.slice(last), replaced };
}

const MAX_DEPTH = 64;
const plain = (v) => v !== null && typeof v === "object" && !Array.isArray(v) && [Object.prototype, null].includes(Object.getPrototypeOf(v));

/** Is this string, found at `path` (keys from the payload's root) under `parent`, the JSON text of a tool call's arguments? */
function isArgumentsText(path, parent) {
  const n = path.length;
  if (path[n - 1] !== "arguments") return false;
  // OpenAI chat completions: messages[i].tool_calls[j].function.arguments
  if (n === 6 && path[0] === "messages" && path[2] === "tool_calls" && path[4] === "function") return true;
  // OpenAI responses: input[i] = { type: "function_call", arguments }
  return n === 3 && path[0] === "input" && parent?.type === "function_call";
}

/**
 * The payload with lone surrogates replaced (see the header). Returns { payload, strings, arguments }: the payload (the
 * same object when nothing changed), how many strings were changed, and how many of them were tool-call arguments.
 */
export function cleanPayload(payload) {
  const counts = { strings: 0, arguments: 0 };
  try {
    const walk = (v, path, parent, depth) => {
      if (typeof v === "string") {
        if (isArgumentsText(path, parent)) {
          const r = cleanJsonText(v);
          if (r.replaced > 0) { counts.strings++; counts.arguments++; }
          return r.text;
        }
        const w = wellFormed(v);
        if (w !== v) counts.strings++;
        return w;
      }
      if (depth >= MAX_DEPTH) return v;
      if (Array.isArray(v)) {
        let copy = null;
        for (let i = 0; i < v.length; i++) {
          const n = walk(v[i], [...path, i], v, depth + 1);
          if (n !== v[i]) { copy ??= v.slice(); copy[i] = n; }
        }
        return copy ?? v;
      }
      if (plain(v)) {
        let copy = null;
        const keys = Object.keys(v);
        for (const k of keys) {
          const n = walk(v[k], [...path, k], v, depth + 1);
          if (n !== v[k]) { copy ??= { ...v }; copy[k] = n; }
        }
        // A key is a string too (an Anthropic-style `input` object's own keys): the object is rebuilt in the same order.
        if (keys.some((k) => wellFormed(k) !== k)) {
          const from = copy ?? v;
          const rebuilt = Object.getPrototypeOf(v) === null ? Object.create(null) : {};
          for (const k of keys) {
            const w = wellFormed(k);
            if (w !== k) counts.strings++;
            Object.defineProperty(rebuilt, w, { value: from[k], enumerable: true, writable: true, configurable: true });
          }
          return rebuilt;
        }
        return copy ?? v;
      }
      return v;
    };
    const out = walk(payload, [], null, 0);
    return { payload: out, ...counts };
  } catch {
    return { payload, strings: 0, arguments: 0 };
  }
}

/** True when `text` is JSON whose every string (keys too) is well-formed Unicode: what a strict parser accepts. */
export function strictJson(text) {
  let v;
  try { v = JSON.parse(text); } catch { return false; }
  const ok = (x) => {
    if (typeof x === "string") return wellFormed(x) === x;
    if (Array.isArray(x)) return x.every(ok);
    if (x !== null && typeof x === "object") return Object.entries(x).every(([k, y]) => ok(k) && ok(y));
    return true;
  };
  return ok(v);
}
