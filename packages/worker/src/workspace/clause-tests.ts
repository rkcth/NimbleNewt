// Card W09 second slice: the host side of a done check that runs the test files the agent's change adds or changes (a contract check with `changedTests`). Pure helpers: which paths are test files, the built file a
// TypeScript test runs from, and the test names a file declares. Bounded and linear on any input.

/** Bounds: test files listed and run, the bytes of one read for its names, its names and their length, and PLAN.md's bytes. The controller refuses a report over them (`CHANGED_TESTS_REPORT_LIMITS`). */
export const CLAUSE_TEST_LIMITS = { files: 50, path: 1_000, fileBytes: 1024 * 1024, titles: 400, title: 300, planBytes: 64 * 1024 } as const;

/** A test file by its name: `<name>.test.<ext>` or `<name>.spec.<ext>` for a JavaScript or TypeScript extension (not a declaration file). */
const TEST_FILE = /(?:^|\/)[^/]+\.(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/;

/** Whether a checkout-relative `/`-separated path names a test file (and not a `.d.ts` declaration). */
export function isTestFile(path: string): boolean {
  return path.length <= CLAUSE_TEST_LIMITS.path && TEST_FILE.test(path) && !/\.d\.[cm]?ts$/.test(path);
}

/**
 * The file a test is run from: a JavaScript test itself; a TypeScript one (`.ts`, `.mts`, `.cts`, `.tsx`) under a `src/` folder from the same place under the nearest `dist/` (the TypeScript compiler's usual layout, the one this
 * repository uses), with the matching JavaScript extension. `undefined` when a TypeScript test is under no `src/` folder (no rule says where its built file is).
 */
export function builtCandidate(path: string): string | undefined {
  // First review: the paths are appended to the check's command, so one that a program would read as an option (a leading `-`: `node --test` takes `--test-name-pattern=x.test.js` as a filter that skips every test) or as a pattern
  // (`node --test` expands `*`, `?`, `[...]`, `{...}` and extglobs: `a/[x].test.js` runs `a/x.test.js`, not itself) is never run (`--` is no way out: `node --test --` waits on its input). Such a test has no built file (fail closed).
  if (!runnableName(path)) return undefined;
  if (/\.[cm]?js$|\.jsx$/.test(path)) return path;
  const ext = /\.(ts|mts|cts|tsx)$/.exec(path);
  if (ext === null) return undefined;
  const parts = path.split("/");
  const at = parts.lastIndexOf("src");
  if (at < 0 || at === parts.length - 1) return undefined;
  const js = ext[1] === "mts" ? "mjs" : ext[1] === "cts" ? "cjs" : "js";
  return [...parts.slice(0, at), "dist", ...parts.slice(at + 1)].join("/").replace(/\.(ts|mts|cts|tsx)$/, `.${js}`);
}

/** Whether a path may be given to a test runner as it is: not starting with `-` (an option) and holding no pattern or escape character (`* ? [ ] { } ( ) ! \`). */
export function runnableName(path: string): boolean {
  return !path.startsWith("-") && !/[*?[\]{}()!\\]/.test(path);
}

/** After a test's name and its closing quote: an options object, read on a bounded slice, that sets `skip` or `todo` to anything but `false`, `0`, `null`, `undefined` or an empty text. */
const SKIPPED_OPTIONS = /^\s*,\s*\{[^{}]{0,240}?(?<![\w$])["']?(?:skip|todo)["']?\s*:(?!\s*(?:(?:false|0|null|undefined)\b|""|''|``))/;

/**
 * The test names a file declares, as written between the quotes of `test(`, `it(`, `describe(` or `suite(` (also `.only`; not `.skip` or `.todo`, a test whose options skip it, or one on a line that starts as a comment): at most `titles`, each cut to `title` characters, no repeats, in file order. A template
 * name keeps its `${...}` text as written. The patterns are linear: each quoted body excludes its own quote and line ends, and escapes are one character each.
 */
export function testTitles(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const call = /(?<![\w$.])(?:test|it|describe|suite)(?:\.(only|skip|todo))?\s*\(\s*(?:"((?:[^"\\\r\n]|\\.){1,2000})"|'((?:[^'\\\r\n]|\\.){1,2000})'|`((?:[^`\\]|\\[^]){1,2000})`)/g;
  for (const m of text.matchAll(call)) {
    // First review: a test that does not run (`.skip`, `.todo`, or an options object right after the name with `skip` or `todo` set to anything but false) declares no name a clause can be mapped to.
    if (m[1] === "skip" || m[1] === "todo") continue;
    const end = m.index + m[0].length;
    if (SKIPPED_OPTIONS.test(text.slice(end, end + 300))) continue;
    // Nor does a call on a line that starts as a comment (`//`, `/*` or a block comment's `*`), read on at most 200 characters before it (bounded on any line length; a longer line's start is not looked at).
    const back = text.slice(Math.max(0, m.index - 200), m.index);
    const nl = Math.max(back.lastIndexOf("\n"), back.lastIndexOf("\r"));
    if ((nl >= 0 || m.index <= 200) && /^\s*(?:\/\/|\/\*|\*)/.test(nl >= 0 ? back.slice(nl + 1) : back)) continue;
    const raw = (m[2] ?? m[3] ?? m[4])!;
    const title = cutWhole(raw, CLAUSE_TEST_LIMITS.title);
    if (seen.has(title)) continue;
    seen.add(title);
    out.push(title);
    if (out.length >= CLAUSE_TEST_LIMITS.titles) break;
  }
  return out;
}

/** The text cut to at most `max` UTF-16 units between whole characters (a pair is never split). */
export function cutWhole(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const c of text) { if (out.length + c.length > max) break; out += c; }
  return out;
}
