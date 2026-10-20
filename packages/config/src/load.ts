import { validateConfig, type NimbleNewtConfig } from "./config.js";
import { migrateConfig, type ConfigMigration, CONFIG_MIGRATIONS } from "./migrate.js";
import type { ConfigError } from "./schema.js";

export type LoadResult =
  | { readonly ok: true; readonly config: NimbleNewtConfig; /** True if the document was in an older layout and was upgraded in memory. */ readonly migrated: boolean; readonly fromVersion: number }
  | { readonly ok: false; readonly errors: ConfigError[] };

const MAX_TEXT = 5 * 1024 * 1024;
const MAX_SYNTAX_DEPTH = 128;

/**
 * Finds the first JSON syntax error and says only where it is and what kind. This is our own scanner on purpose: the
 * engine's error messages quote part of the input, and a mistyped line can contain a secret.
 */
function syntaxProblem(text: string): { offset: number; reason: string } | null {
  let i = 0;
  const n = text.length;
  const stop = (reason: string): never => { throw { offset: i, reason }; };
  const space = () => { while (i < n && (text[i] === " " || text[i] === "\t" || text[i] === "\n" || text[i] === "\r")) i++; };
  const string = () => {
    i++;
    while (i < n) {
      const c = text.charCodeAt(i);
      if (c === 0x22) { i++; return; }
      if (c < 0x20) stop("a line break or control character inside a string");
      if (c === 0x5c) {
        const e = text[i + 1];
        if (e === "u") { if (!/^[0-9a-fA-F]{4}$/.test(text.slice(i + 2, i + 6))) { i += 2; stop("an invalid \\u escape"); } i += 6; continue; }
        if (e === undefined || !'"\\/bfnrt'.includes(e)) { i += 1; stop("an invalid escape sequence"); }
        i += 2;
        continue;
      }
      i++;
    }
    stop("an unterminated string");
  };
  const value = (depth: number): void => {
    if (depth > MAX_SYNTAX_DEPTH) stop("nesting that is too deep");
    space();
    const c = text[i];
    if (c === "{") {
      i++; space();
      if (text[i] === "}") { i++; return; }
      for (;;) {
        space();
        if (text[i] !== '"') stop("a property name in double quotes was expected");
        string(); space();
        if (text[i] !== ":") stop("a ':' was expected");
        i++; value(depth + 1); space();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "}") { i++; return; }
        stop("a ',' or '}' was expected");
      }
    }
    if (c === "[") {
      i++; space();
      if (text[i] === "]") { i++; return; }
      for (;;) {
        value(depth + 1); space();
        if (text[i] === ",") { i++; continue; }
        if (text[i] === "]") { i++; return; }
        stop("a ',' or ']' was expected");
      }
    }
    if (c === '"') return string();
    const literal = /true|false|null/y; literal.lastIndex = i;
    if (literal.test(text)) { i = literal.lastIndex; return; }
    const number = /-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/y; number.lastIndex = i;
    if (number.test(text)) { i = number.lastIndex; return; }
    stop(i >= n ? "the document ends too soon" : "a value was expected here");
  };
  try {
    value(0); space();
    if (i < n) stop("unexpected content after the end of the document");
    return null;
  } catch (e) {
    if (typeof e === "object" && e !== null && "offset" in e && "reason" in e) return e as { offset: number; reason: string };
    throw e;
  }
}

/** Turns a syntax problem into line and column. Never includes any of the text. */
function locate(text: string, problem: { offset: number; reason: string }): ConfigError {
  const lines = text.slice(0, problem.offset).split("\n");
  return { path: "", message: `not valid JSON at line ${lines.length}, column ${lines[lines.length - 1]!.length + 1}: ${problem.reason}` };
}

/**
 * Reads configuration from JSON text or an already parsed value: upgrades an older layout, then validates. Every problem
 * is reported with its path; secret values are never echoed. Nothing is written anywhere.
 */
export function loadConfig(source: string | unknown, migrations: readonly ConfigMigration[] = CONFIG_MIGRATIONS): LoadResult {
  let parsed = source;
  if (typeof source === "string") {
    if (source.length > MAX_TEXT) return { ok: false, errors: [{ path: "", message: `the configuration text is larger than ${MAX_TEXT / 1024 / 1024} MiB and is refused` }] };
    const problem = syntaxProblem(source);
    if (problem !== null) return { ok: false, errors: [locate(source, problem)] };
    try {
      parsed = JSON.parse(source);
    } catch {
      return { ok: false, errors: [{ path: "", message: "not valid JSON" }] };
    }
  }
  const migrated = migrateConfig(parsed, migrations);
  if (!migrated.ok) return migrated;
  const checked = validateConfig(migrated.document);
  return checked.ok ? { ok: true, config: checked.config, migrated: migrated.steps > 0, fromVersion: migrated.fromVersion } : checked;
}

/** One line per problem, for logs and terminals. */
export function formatErrors(errors: readonly ConfigError[]): string {
  return errors.map((e) => (e.path === "" ? e.message : `${e.path}: ${e.message}`)).join("\n");
}
