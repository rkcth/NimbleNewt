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
  if (/\.[cm]?js$|\.jsx$/.test(path)) return path;
  const ext = /\.(ts|mts|cts|tsx)$/.exec(path);
  if (ext === null) return undefined;
  const parts = path.split("/");
  const at = parts.lastIndexOf("src");
  if (at < 0 || at === parts.length - 1) return undefined;
  const js = ext[1] === "mts" ? "mjs" : ext[1] === "cts" ? "cjs" : "js";
  return [...parts.slice(0, at), "dist", ...parts.slice(at + 1)].join("/").replace(/\.(ts|mts|cts|tsx)$/, `.${js}`);
}

/**
 * The test names a file declares, as written between the quotes of `test(`, `it(`, `describe(` or `suite(` (also `.only`, `.skip`, `.todo`): at most `titles`, each cut to `title` characters, no repeats, in file order. A template
 * name keeps its `${...}` text as written. The patterns are linear: each quoted body excludes its own quote and line ends, and escapes are one character each.
 */
export function testTitles(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const call = /(?<![\w$.])(?:test|it|describe|suite)(?:\.(?:only|skip|todo))?\s*\(\s*(?:"((?:[^"\\\r\n]|\\.){1,2000})"|'((?:[^'\\\r\n]|\\.){1,2000})'|`((?:[^`\\]|\\[^]){1,2000})`)/g;
  for (const m of text.matchAll(call)) {
    const raw = (m[1] ?? m[2] ?? m[3])!;
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
