// What one tool call's arguments name, for the bench's contamination checks (card W01e). Plain Node ESM, no dependencies.
//
// The checks (`foreignPaths` in runner.mjs, `credentialAttempts` in isolation.mjs, the reference marks) read only two
// kinds of text out of a call:
//   commands  the `command`, `cmd` or `script` field of a tool that is not a file tool (bash and the like): searched as a
//             shell command (a push, a remote, the owner's keys) and for absolute paths;
//   paths     every other string field (a file tool's `path`, `file_path`, a search pattern, a working folder), at any
//             depth: searched for the owner's keys and for absolute paths.
// Content fields (file text being written, edit text, notebook source) are data, never a command or a path: code and
// test fixtures may talk about pushing or name a token. Tool results are never read here.
//
// Classification is done on the full parsed arguments (W01 batch 4: a long edit whose `path` came after its edit text was
// cut inside that path, and a cut call that no longer parsed was read whole as a command). Each text is bounded at
// TEXT_LIMIT characters, and a text cut there carries `cut: true` so the checks judge only what is visible of it.
// A stored argument string that is not valid JSON (an older record cut at its size limit) is read with a tolerant
// parser: each complete field is used as above, and a string the cut ends inside is kept with `cut: true` (source
// "visible-text"), so nothing is concluded from a word or path the cut may have shortened.

/** Fields that hold file content or edit text: data, never searched. */
export const CONTENT_FIELDS = new Set(["content", "newText", "oldText", "new_string", "old_string", "edits", "text", "new_source", "old_source", "contents", "patch", "diff"]);
/** Fields that hold a shell command, when the tool is not a file tool. */
export const COMMAND_FIELDS = new Set(["command", "cmd", "script"]);
/** Tools that read, write, edit or list files (Pi's and Claude Code's names): a `command` field there is not run. */
const FILE_TOOLS = /^(?:read|write|edit|multi_?edit|notebook_?edit|notebook_?read|grep|glob|find|ls)$/i;
/** How long one command or path text may be before it is cut (a heredoc can be long; a path never is). */
export const TEXT_LIMIT = 65_536;
/** How many characters of a call's argument JSON the summary stores (the record kept for size). */
export const STORED_ARGS_LIMIT = 2000;
const MAX_TEXTS = 256;
const MAX_DEPTH = 8;

/** A string value a cut ended inside: only its visible start is known. */
class CutString { constructor(text) { this.text = text; } }

/**
 * The command and path texts of one call's parsed arguments.
 *   args      the parsed arguments (an object; a bare string is read as a command, as a plain command line is);
 *   toolName  the tool's name, when known (a file tool's `command` field is a path-like text, not a command).
 * Returns { tool, commands: [{ text, cut }], paths: [{ text, cut }] }.
 */
export function argTexts(args, toolName = null) {
  const tool = typeof toolName === "string" ? toolName : null;
  const runsCommands = !(tool !== null && FILE_TOOLS.test(tool));
  const commands = [], paths = [];
  const add = (list, v) => {
    if (commands.length + paths.length >= MAX_TEXTS) return;
    const cut = v instanceof CutString;
    const s = cut ? v.text : v;
    list.push(s.length > TEXT_LIMIT ? { text: s.slice(0, TEXT_LIMIT), cut: true } : { text: s, cut });
  };
  const walk = (v, key, depth) => {
    if (depth > MAX_DEPTH) return;
    if (typeof v === "string" || v instanceof CutString) {
      add(depth === 1 && runsCommands && COMMAND_FIELDS.has(key) ? commands : paths, v);
      return;
    }
    if (Array.isArray(v)) { for (const x of v) walk(x, key, depth + 1); return; }
    if (v !== null && typeof v === "object") {
      for (const [k, x] of Object.entries(v)) if (!CONTENT_FIELDS.has(k)) walk(x, k, depth + 1);
    }
  };
  if (typeof args === "string" || args instanceof CutString) add(commands, args);
  else walk(args, null, 0);
  return { tool, commands, paths };
}

/**
 * A tolerant reading of JSON text that may have been cut short: complete values are returned as parsed, a string the
 * text ends inside becomes a CutString, an object or array the text ends inside keeps the fields read so far. Returns
 * undefined when the text is not JSON at all (a syntax error before its end).
 */
export function parseVisible(text) {
  let i = 0;
  const n = text.length;
  const END = Symbol("end");
  const ws = () => { while (i < n && /\s/.test(text[i])) i++; };
  const str = () => {
    i++; // opening quote
    let out = "";
    while (i < n) {
      const ch = text[i];
      if (ch === '"') { i++; return out; }
      if (ch === "\\") {
        if (i + 1 >= n) { i = n; break; }
        const e = text[i + 1];
        if (e === "u") {
          if (i + 6 > n) { i = n; break; }
          const hex = text.slice(i + 2, i + 6);
          if (!/^[0-9a-fA-F]{4}$/.test(hex)) throw new SyntaxError("bad escape");
          out += String.fromCharCode(parseInt(hex, 16)); i += 6; continue;
        }
        const map = { '"': '"', "\\": "\\", "/": "/", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
        if (!(e in map)) throw new SyntaxError("bad escape");
        out += map[e]; i += 2; continue;
      }
      out += ch; i++;
    }
    return new CutString(out);
  };
  const value = () => {
    ws();
    if (i >= n) return END;
    const ch = text[i];
    if (ch === '"') return str();
    if (ch === "{") {
      i++;
      const obj = {};
      for (;;) {
        ws();
        if (i >= n) return obj;
        if (text[i] === "}") { i++; return obj; }
        if (text[i] === ",") { i++; ws(); if (i >= n) return obj; }
        if (text[i] !== '"') throw new SyntaxError("key expected");
        const k = str();
        if (k instanceof CutString) return obj;
        ws();
        if (i >= n) return obj;
        if (text[i] !== ":") throw new SyntaxError("colon expected");
        i++;
        const v = value();
        if (v === END) return obj;
        obj[k] = v;
        if (i >= n) return obj;
      }
    }
    if (ch === "[") {
      i++;
      const arr = [];
      for (;;) {
        ws();
        if (i >= n) return arr;
        if (text[i] === "]") { i++; return arr; }
        if (text[i] === ",") { i++; ws(); if (i >= n) return arr; }
        const v = value();
        if (v === END) return arr;
        arr.push(v);
        if (i >= n) return arr;
      }
    }
    const m = /^(?:-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(i, i + 64));
    if (m === null) {
      // A literal the cut ended inside ("tr", "12") is a value we do not need.
      if (/^(?:-?[\d.eE+-]*|t(?:r(?:u)?)?|f(?:a(?:l(?:s)?)?)?|n(?:u(?:l)?)?)$/.test(text.slice(i))) { i = n; return END; }
      throw new SyntaxError("value expected");
    }
    i += m[0].length;
    // A number that runs to the end of the text may have been shortened by the cut.
    if (i >= n && /^-?\d/.test(m[0])) return END;
    return JSON.parse(m[0]);
  };
  try {
    const v = value();
    return v === END ? undefined : v;
  } catch { return undefined; }
}

/**
 * The texts of one stored call, whatever form it has:
 *   - an entry made by `addEvent` ({ tool, commands, paths }): returned as it is (source "parsed");
 *   - a JSON string of the arguments that parses: read in full (source "parsed");
 *   - a string that starts like a JSON object or array but does not parse (cut at a size limit): read by parseVisible,
 *     so complete fields count and the field the cut ended inside counts only for what is visible (source "visible-text");
 *   - any other string: a command line as it is (source "plain").
 */
export function toolCallTexts(entry) {
  if (entry !== null && typeof entry === "object" && Array.isArray(entry.commands) && Array.isArray(entry.paths)) return { source: "parsed", ...entry };
  const raw = String(entry);
  try { return { source: "parsed", ...argTexts(JSON.parse(raw)) }; } catch { /* not complete JSON */ }
  if (/^\s*[{[]/.test(raw)) {
    const v = parseVisible(raw);
    if (v !== undefined) return { source: "visible-text", ...argTexts(v) };
    // Not JSON even as far as it goes: nothing in it is known to be a field, so it is read as one cut command line.
    return { source: "visible-text", tool: null, commands: [{ text: raw, cut: true }], paths: [] };
  }
  return { source: "plain", tool: null, commands: [{ text: raw, cut: false }], paths: [] };
}

/** Characters that end a word or a path component: a cut text is judged only up to the last of them. */
const BOUNDARY = /[\s/\\"'`;|&<>(){},=:]/;
/** The part of a text that is known whole: all of it, or for a cut text, up to and including its last boundary. */
export function wholePart({ text, cut }) {
  if (!cut) return text;
  for (let k = text.length - 1; k >= 0; k--) if (BOUNDARY.test(text[k])) return text.slice(0, k + 1);
  return "";
}
