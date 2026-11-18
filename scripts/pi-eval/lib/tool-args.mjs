// What one tool call's arguments name, for the bench's contamination checks (card W01e). Plain Node ESM, no dependencies.
//
// The checks (`foreignPaths` in runner.mjs, `credentialAttempts` in isolation.mjs, the reference marks) read only two
// kinds of text out of a call:
//   commands  for a tool that is not a file tool: every field named like a command (`command`, `cmd`, `script`,
//             `commands`, `cmdline`, `bash`, `input`, `args`, ... at any depth; a list of strings also joined, as an
//             argv), and for a tool that is named and is not a file tool (bash, powershell, any other), every string it
//             carries, content fields included. Searched as a shell command (a push, a remote, the owner's keys) and
//             for absolute paths;
//   paths     every other string (a file tool's `path`, `file_path`, its `command`, a search pattern, a working folder),
//             at any depth: searched for the owner's keys and for absolute paths.
// A string directly in a content field (file text being written, edit text, notebook source) of a file tool or of a call
// with no tool name is data, never a command or a path: code and test fixtures may talk about pushing or name a token.
// An object inside a content field is still read field by field. Tool results are never read here.
//
// Classification is done on the full parsed arguments (W01 batch 4: a long edit whose `path` came after its edit text was
// cut inside that path, and a cut call that no longer parsed was read whole as a command). The texts are bounded in
// size (TEXT_LIMIT per text, CALL_LIMIT per call, SMALL_CALL_LIMIT per call once a run's calls hold SUMMARY_LIMIT): a
// longer text keeps its head and its tail, texts past a call's room are joined and kept head and tail, and the call is
// marked `textsCut`. Nothing is dropped unread. A text whose end is not known carries `cut: true`, one whose start is
// not known `cutStart: true`.
// A stored argument string that is not valid JSON (an older record cut at its size limit) is read with a tolerant
// parser: each complete field is used as above, and a string the cut ends inside is kept with `cut: true` (source
// "visible-text"); a field the cut ended inside the key of is not known and is left out.

/** Fields that hold file content or edit text: a string directly in one is data, never searched (an object in one is read
 *  field by field, so `edits: [{ path }]` still shows its path). A tool that is named and is not a file tool reads them too. */
export const CONTENT_FIELDS = new Set(["content", "newText", "oldText", "new_string", "old_string", "edits", "text", "new_source", "old_source", "contents", "patch", "diff"]);
/** Fields that hold a shell command (at any depth; a list of strings in one is also read joined, as an argv), when the
 *  tool is not a file tool. A tool that is named and is not a file tool reads every string it carries as a command. */
export const COMMAND_FIELDS = new Set(["command", "cmd", "script", "commands", "cmdline", "commandLine", "command_line", "bash", "sh", "shell", "powershell", "input", "args", "argv", "code", "exec", "run"]);
/** Tools that read, write, edit or list files (Pi's and Claude Code's names): a `command` field there is not run. */
const FILE_TOOLS = /^(?:read|write|edit|multi_?edit|notebook_?edit|notebook_?read|grep|glob|find|ls)$/i;
/** How long one command or path text may be: a longer one keeps its first and last TEXT_LIMIT/2 characters (a push after
 *  a long heredoc is still seen) and the call is marked `textsCut`. */
export const TEXT_LIMIT = 65_536;
/** How many characters all texts of one call may hold, and once a run's calls together hold SUMMARY_LIMIT, how many each
 *  later call may hold. Texts past a call's room are joined and kept head and tail (marked `textsCut`), never dropped. */
export const CALL_LIMIT = 262_144;
export const SMALL_CALL_LIMIT = 4096;
export const SUMMARY_LIMIT = 16_777_216;
/** How many characters of a call's argument JSON the summary stores (the record kept for size). */
export const STORED_ARGS_LIMIT = 2000;
const MAX_TEXTS = 256;
const MAX_DEPTH = 8;
const MIN_PIECE = 256;

/** A string value a cut ended inside: only its visible start is known. */
class CutString { constructor(text) { this.text = text; } }

/**
 * The command and path texts of one call's parsed arguments.
 *   args      the parsed arguments (an object; a bare string is read as a command, as a plain command line is);
 *   toolName  the tool's name, when known (a file tool's `command` field is a path-like text, not a command);
 *   limit     how many characters the texts may hold together (CALL_LIMIT).
 * Returns { tool, commands: [{ text, cut, cutStart? }], paths: [...], chars, textsCut? }: `cut` a text whose end is not
 * known, `cutStart` one whose start is not known (the tail of a text kept head and tail).
 */
export function argTexts(args, toolName = null, { limit = CALL_LIMIT } = {}) {
  const tool = typeof toolName === "string" ? toolName : null;
  const fileTool = tool !== null && FILE_TOOLS.test(tool);
  const named = tool !== null && !fileTool;
  const commands = [], paths = [], overflow = { commands: [], paths: [] };
  let chars = 0, textsCut = false;
  const push = (list, s, cutEnd, cap) => {
    if (s.length <= cap) { list.push({ text: s, cut: cutEnd }); chars += s.length; return; }
    const half = Math.floor(cap / 2);
    list.push({ text: s.slice(0, half), cut: true }, { text: s.slice(s.length - half), cut: cutEnd, cutStart: true });
    chars += 2 * half; textsCut = true;
  };
  const add = (kind, v) => {
    const cutEnd = v instanceof CutString;
    const s = cutEnd ? v.text : v;
    const room = Math.min(TEXT_LIMIT, limit - chars);
    if (commands.length + paths.length >= MAX_TEXTS || (room < MIN_PIECE && s.length > room)) { overflow[kind].push(v); return; }
    push(kind === "commands" ? commands : paths, s, cutEnd, room);
  };
  const isText = (v) => typeof v === "string" || v instanceof CutString;
  const walk = (v, key, depth, content) => {
    const asCommand = !fileTool && (named || COMMAND_FIELDS.has(key));
    if (isText(v)) { if (!content || named) add(asCommand ? "commands" : "paths", v); return; }
    if (v === null || typeof v !== "object") return;
    // Deeper than any real tool's arguments: read whole as one text rather than left out.
    if (depth >= MAX_DEPTH) { add(fileTool ? "paths" : "commands", JSON.stringify(v) ?? ""); return; }
    if (Array.isArray(v)) {
      for (const x of v) walk(x, key, depth + 1, content);
      // An argv-style list (`args: ["git", "push"]`) is also read as the command line it makes.
      if (asCommand && (!content || named) && v.length > 1 && v.every(isText)) add("commands", v.map((x) => (x instanceof CutString ? x.text : x)).join(" "));
      return;
    }
    for (const [k, x] of Object.entries(v)) walk(x, k, depth + 1, CONTENT_FIELDS.has(k));
  };
  if (isText(args)) add("commands", args);
  else walk(args, null, 0, false);
  for (const kind of ["commands", "paths"]) {
    if (overflow[kind].length === 0) continue;
    textsCut = true;
    const cutEnd = overflow[kind].at(-1) instanceof CutString;
    push(kind === "commands" ? commands : paths, overflow[kind].map((x) => (x instanceof CutString ? x.text : x)).join("\n"), cutEnd, Math.max(MIN_PIECE, Math.min(TEXT_LIMIT, limit - chars)));
  }
  return { tool, commands, paths, chars, ...(textsCut ? { textsCut: true } : {}) };
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
 * Every string form is bounded as argTexts bounds a call (head and tail kept, `textsCut`).
 */
export function toolCallTexts(entry) {
  if (entry !== null && typeof entry === "object" && Array.isArray(entry.commands) && Array.isArray(entry.paths)) return { source: "parsed", ...entry };
  const raw = String(entry);
  try { return { source: "parsed", ...argTexts(JSON.parse(raw)) }; } catch { /* not complete JSON */ }
  if (/^\s*[{[]/.test(raw)) {
    const v = parseVisible(raw);
    if (v !== undefined) return { source: "visible-text", ...argTexts(v) };
    // Not JSON even as far as it goes: nothing in it is known to be a field, so it is read as one cut command line.
    return { source: "visible-text", ...argTexts(new CutString(raw)) };
  }
  return { source: "plain", ...argTexts(raw) };
}

/** Characters that end a word or a path component: a cut text is judged only up to the last of them. */
const BOUNDARY = /[\s/\\"'`;|&<>(){},=:]/;
/** The part of a text that is known whole: all of it, or for a cut text, up to and including its last boundary. */
export function wholePart({ text, cut }) {
  if (!cut) return text;
  for (let k = text.length - 1; k >= 0; k--) if (BOUNDARY.test(text[k])) return text.slice(0, k + 1);
  return "";
}
