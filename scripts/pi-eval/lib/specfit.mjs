// Spec fit (card W01): what an acceptance test demands that the agent could not have known.
// Reads the bench's acceptance test files (types stripped, then tokenized) and collects, from inside every assertion, the
// string literals (and the fixed parts of template strings), regular expressions and property names it checks, plus
// the names the file imports. Each one must appear in the prompt the agent is given, in the base commit's source, or
// in the test's own fixtures (text outside the assertions: an input the test itself feeds in). Anything else is flagged,
// and calibration fails until the task's allowlist gives a reason for it.
// Plain Node ESM, no dependencies.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";

/**
 * A small JavaScript tokenizer: enough to find assertion calls and the literals inside them. The TypeScript source is
 * first stripped of its types by Node's own `stripTypeScriptTypes` (positions kept), since the repository's TypeScript
 * (7, native) has no JavaScript API. Tokens: { t: "str"|"tpl"|"re"|"id"|"num"|"p", v, pos }. A template string is one
 * "tpl" token holding its fixed chunks (`parts`) and the tokens of each `${}` (`subs`).
 */
const KEYWORD_BEFORE_REGEX = new Set(["return", "typeof", "case", "do", "else", "in", "of", "new", "delete", "void", "throw", "instanceof", "yield", "await"]);

export function tokenize(src) {
  let i = 0;
  const n = src.length;
  const read = (stopAtBrace) => {
    const toks = [];
    let depth = 0;
    const prevAllowsRegex = () => {
      const p = toks[toks.length - 1];
      if (!p) return true;
      if (p.t === "p") return !(p.v === ")" || p.v === "]");
      if (p.t === "id") return KEYWORD_BEFORE_REGEX.has(p.v);
      return false;
    };
    while (i < n) {
      const c = src[i];
      if (c === " " || c === "\t" || c === "\n" || c === "\r") { i++; continue; }
      if (c === "/" && src[i + 1] === "/") { while (i < n && src[i] !== "\n") i++; continue; }
      if (c === "/" && src[i + 1] === "*") { const e = src.indexOf("*/", i + 2); i = e < 0 ? n : e + 2; continue; }
      const pos = i;
      if (c === '"' || c === "'") {
        let v = ""; i++;
        while (i < n && src[i] !== c) {
          if (src[i] === "\\") { v += unescapeOne(src, i); i += escapeLength(src, i); continue; }
          v += src[i++];
        }
        i++;
        toks.push({ t: "str", v, pos });
        continue;
      }
      if (c === "`") {
        i++;
        const parts = [""], subs = [];
        while (i < n && src[i] !== "`") {
          if (src[i] === "\\") { parts[parts.length - 1] += unescapeOne(src, i); i += escapeLength(src, i); continue; }
          if (src[i] === "$" && src[i + 1] === "{") { i += 2; subs.push(read(true)); parts.push(""); continue; }
          parts[parts.length - 1] += src[i++];
        }
        i++;
        toks.push({ t: "tpl", parts, subs, pos });
        continue;
      }
      if (c === "/" && prevAllowsRegex()) {
        let j = i + 1, inClass = false;
        while (j < n && src[j] !== "\n") {
          if (src[j] === "\\") { j += 2; continue; }
          if (src[j] === "[") inClass = true; else if (src[j] === "]") inClass = false;
          else if (src[j] === "/" && !inClass) break;
          j++;
        }
        if (src[j] === "/") {
          j++;
          while (j < n && /[a-z]/.test(src[j])) j++;
          toks.push({ t: "re", v: src.slice(i, j), pos });
          i = j;
          continue;
        }
      }
      if (/[A-Za-z_$\u0080-￿]/.test(c)) {
        let j = i + 1;
        while (j < n && /[\w$\u0080-￿]/.test(src[j])) j++;
        toks.push({ t: "id", v: src.slice(i, j), pos });
        i = j;
        continue;
      }
      if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
        let j = i + 1;
        while (j < n && /[\w.]/.test(src[j])) j++;
        toks.push({ t: "num", v: src.slice(i, j), pos });
        i = j;
        continue;
      }
      if (stopAtBrace) {
        if (c === "{") depth++;
        else if (c === "}") { if (depth === 0) { i++; return toks; } depth--; }
      }
      const three = src.slice(i, i + 3);
      const v = three === "..." || three === "===" || three === "!==" ? three : ["=>", "?.", "??", "==", "!=", "&&", "||", "<=", ">="].includes(src.slice(i, i + 2)) ? src.slice(i, i + 2) : c;
      toks.push({ t: "p", v, pos });
      i += v.length;
    }
    return toks;
  };
  return read(false);
}

function escapeLength(src, i) {
  const c = src[i + 1];
  if (c === "u" && src[i + 2] === "{") { const e = src.indexOf("}", i); return e < 0 ? 2 : e - i + 1; }
  if (c === "u") return 6;
  if (c === "x") return 4;
  if (c === "\r" && src[i + 2] === "\n") return 3;
  return 2;
}
function unescapeOne(src, i) {
  const c = src[i + 1];
  const simple = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0", "\n": "", "\r": "" };
  if (c in simple) return simple[c];
  if (c === "u" && src[i + 2] === "{") { const e = src.indexOf("}", i); return String.fromCodePoint(parseInt(src.slice(i + 3, e), 16)); }
  if (c === "u") return String.fromCharCode(parseInt(src.slice(i + 2, i + 6), 16));
  if (c === "x") return String.fromCharCode(parseInt(src.slice(i + 2, i + 4), 16));
  return c;
}

/** Where an assertion's free-text message starts (it describes, it does not demand). Unlisted methods keep every argument. */
const MESSAGE_ARG = {
  ok: 1, assert: 1, equal: 2, notEqual: 2, strictEqual: 2, notStrictEqual: 2, deepEqual: 2, deepStrictEqual: 2,
  notDeepEqual: 2, notDeepStrictEqual: 2, match: 2, doesNotMatch: 2, throws: 2, doesNotThrow: 2, rejects: 2,
  doesNotReject: 2, fail: 0, ifError: 1, partialDeepStrictEqual: 2,
};

let stripCache;
function stripTypes(text) {
  try {
    stripCache ??= createRequire(import.meta.url)("node:module").stripTypeScriptTypes ?? null;
    if (stripCache) {
      // It warns that it is experimental on first use; the bench's output is not the place for that.
      const warn = process.emitWarning;
      process.emitWarning = () => {};
      try { return stripCache(text, { mode: "strip" }); } finally { process.emitWarning = warn; }
    }
  } catch { /* syntax the stripper refuses (an enum): read the source as it is */ }
  return text;
}

const OPEN = { "(": ")", "[": "]", "{": "}" };

/**
 * Every item an acceptance file's assertions check. Returns { items, fixtureText } where items are
 * { kind: "string"|"regex"|"property"|"import", value, key, line } and fixtureText is the file with the assertions cut out
 * (the test's own inputs and set-up, against which a value it feeds in and then expects back is known).
 */
export function extractDemands(fileName, text) {
  const js = stripTypes(text);
  const toks = tokenize(js);
  const items = [];
  const spans = [];
  const lineAt = (pos) => { let l = 1; for (let k = 0; k < pos && k < js.length; k++) if (js.charCodeAt(k) === 10) l++; return l; };
  const add = (kind, value, pos) => {
    const key = kind === "string" ? JSON.stringify(value) : kind === "regex" ? value : kind === "property" ? `.${value}` : `{${value}}`;
    items.push({ kind, value, key, line: lineAt(pos) });
  };
  const collect = (list) => {
    list.forEach((tk, k) => {
      if (tk.t === "str") add("string", tk.v, tk.pos);
      else if (tk.t === "re") add("regex", tk.v, tk.pos);
      else if (tk.t === "tpl") { for (const p of tk.parts) if (p) add("string", p, tk.pos); for (const s of tk.subs) collect(s); }
      else if (tk.t === "id" && k > 0 && (list[k - 1].v === "." || list[k - 1].v === "?.") && list[k - 1].t === "p") add("property", tk.v, tk.pos);
      // An object key in an expected value: `{ status: "x" }` (also a ternary's `a ? b : c`, which names an identifier the test uses anyway).
      else if (tk.t === "id" && list[k + 1]?.v === ":" && (list[k - 1]?.v === "{" || list[k - 1]?.v === ",")) add("property", tk.v, tk.pos);
    });
  };
  // Imports of the code under test: the names the agent's code must export.
  // Read from the source as written: stripping drops `type` imports, and the agent must export those too.
  for (const m of text.matchAll(/import\s*(?:type\s+)?\{([^}]*)\}\s*from\s*["'](\.[^"']*)["']/g)) {
    for (const part of m[1].split(",")) {
      const name = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/)[0].trim();
      if (name) add("import", name, m.index);
    }
  }
  const matchClose = (k) => {
    const stack = [];
    for (let j = k; j < toks.length; j++) {
      const v = toks[j].t === "p" ? toks[j].v : null;
      if (v && OPEN[v]) stack.push(OPEN[v]);
      else if (v && (v === ")" || v === "]" || v === "}")) { stack.pop(); if (stack.length === 0) return j; }
    }
    return toks.length - 1;
  };
  for (let k = 0; k < toks.length; k++) {
    const tk = toks[k];
    if (tk.t !== "id" || tk.v !== "assert" || (k > 0 && toks[k - 1].v === "." && toks[k - 1].t === "p" && toks[k - 2]?.v !== "t")) continue;
    // assert(…), assert.m(…), assert.strict.m(…), t.assert.m(…)
    let j = k + 1, method = "assert";
    while (toks[j]?.v === "." && toks[j + 1]?.t === "id") { method = toks[j + 1].v; j += 2; }
    if (toks[j]?.v !== "(") continue;
    const close = matchClose(j);
    // Split the arguments at top-level commas.
    const args = [[]];
    let depth = 0;
    for (let q = j + 1; q < close; q++) {
      const v = toks[q].t === "p" ? toks[q].v : null;
      if (v && OPEN[v]) depth++;
      else if (v === ")" || v === "]" || v === "}") depth--;
      if (v === "," && depth === 0) { args.push([]); continue; }
      args[args.length - 1].push(toks[q]);
    }
    const cut = MESSAGE_ARG[method] ?? args.length;
    args.forEach((a, idx) => {
      if (idx >= cut || a.length === 0) return;
      // assert.throws(fn, "text") passes a message, not an expected value.
      if ((method === "throws" || method === "rejects") && idx === 1 && a.length === 1 && (a[0].t === "str" || a[0].t === "tpl")) return;
      collect(a);
    });
    spans.push([toks[k].pos, (toks[close]?.pos ?? js.length) + 1]);
    k = close;
  }
  let fixtureText = "";
  let at = 0;
  for (const [s, e] of spans) { if (s >= at) { fixtureText += js.slice(at, s); at = e; } }
  fixtureText += js.slice(at);
  // The fixtures' values as the test sees them (escapes decoded), so `"a\u2028b"` fed in is known as the text it is.
  const inSpan = (pos) => spans.some(([s, e]) => pos >= s && pos < e);
  for (const tk of toks) if (!inSpan(tk.pos)) { if (tk.t === "str") fixtureText += `\n${tk.v}`; else if (tk.t === "tpl") fixtureText += `\n${tk.parts.join("")}`; }
  return { items, fixtureText };
}

const TEXT_FILE = /\.(?:ts|mts|cts|tsx|js|mjs|cjs|json|md|txt|sql|ya?ml)$/i;
const SKIP_DIR = new Set(["node_modules", "dist", ".git", "coverage"]);

/** The text of every source and document file under `dir` (a checkout), skipping dependencies and build output. */
export function readCorpus(dir, { maxFileBytes = 2_000_000 } = {}) {
  const parts = [];
  const walk = (d) => {
    let names;
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      if (n.isDirectory()) { if (!SKIP_DIR.has(n.name)) walk(join(d, n.name)); continue; }
      if (!n.isFile() || !TEXT_FILE.test(n.name)) continue;
      const p = join(d, n.name);
      try { if (statSync(p).size <= maxFileBytes) parts.push(readFileSync(p, "utf8")); } catch { /* unreadable */ }
    }
  };
  walk(dir);
  return parts.join("\n\u0000\n");
}

/** Trivial items are never flagged: very short strings, strings with no letter, regexes with no two letters in a row (escapes like \\d aside). */
const trivial = (it) => (it.kind === "string" && (it.value.trim().length < 3 || !/\p{L}/u.test(it.value))) || (it.kind === "regex" && !/\p{L}{2}/u.test(it.value.replace(/\\[a-zA-Z]|\/[a-z]*$/g, "")));

function regexOf(src) {
  const m = /^\/(.*)\/([a-z]*)$/s.exec(src);
  if (!m) return null;
  try { return new RegExp(m[1], m[2].replace(/[gy]/g, "")); } catch { return null; }
}

/**
 * Checks each demand against the places the agent could have learnt it from. Returns the flagged items (deduplicated
 * by key), each { kind, key, line, file, allowed, reason }.
 *   known: { prompt, corpus, fixtures } texts. allow: { key: reason }.
 */
export function checkDemands(demands, { prompt, corpus, fixtures = "", allow = {} }) {
  const words = new Set(`${prompt}\n${corpus}\n${fixtures}`.match(/[A-Za-z_$][\w$]*/g) ?? []);
  const flagged = new Map();
  for (const it of demands) {
    if (trivial(it) || flagged.has(it.key)) continue;
    let known;
    // A template's fixed chunk usually ends in the space before its `${}`: compared without its outer spaces.
    if (it.kind === "string") { const v = it.value.trim(); known = prompt.includes(v) || fixtures.includes(v) || corpus.includes(v); }
    else if (it.kind === "regex") {
      const re = regexOf(it.value);
      known = re === null ? false : re.test(prompt) || re.test(fixtures) || re.test(corpus);
    } else known = words.has(it.value);
    if (known) continue;
    flagged.set(it.key, { kind: it.kind, key: it.key, line: it.line, file: it.file, allowed: Object.hasOwn(allow, it.key), reason: allow[it.key] ?? null });
  }
  return [...flagged.values()];
}

/**
 * The whole spec-fit check of one task: files = [{ name, text }] (its acceptance files), prompt = the task text the agent
 * reads, corpus = the base checkout's text. ok when every flagged item is allowlisted with a non-empty reason.
 * Allowlist entries that no longer match a flagged item are reported as stale (they do not fail the check).
 */
export function specFit({ files, prompt, corpus, allow = {} }) {
  const demands = [];
  let fixtures = "";
  for (const f of files) {
    const { items, fixtureText } = extractDemands(f.name, f.text);
    for (const it of items) demands.push({ ...it, file: f.name });
    fixtures += `\n${fixtureText}`;
  }
  const flagged = checkDemands(demands, { prompt, corpus, fixtures, allow });
  const unjustified = flagged.filter((f) => !f.allowed || typeof f.reason !== "string" || f.reason.trim() === "");
  const stale = Object.keys(allow).filter((k) => !flagged.some((f) => f.key === k));
  return { ok: unjustified.length === 0, demands: demands.length, flagged, unjustified, stale };
}
