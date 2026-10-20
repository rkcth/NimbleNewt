// Emits GitHub Actions error annotations from a test log, readable without log access:
//   - one annotation per failing test (up to MAX_FAILURES) with its name and error block;
//   - one annotation with the tail of the log.
// Node's test runner prints TAP when it writes to a terminal-less stream on some versions and its "spec" format on others
// (Node 24 pipes the spec format), so both are understood. Annotation commands are escaped as GitHub requires: data (the message)
// escapes %, CR and LF; properties (the title) additionally escape ":" and ",".
// Note: the raw log still passes through the runner unescaped, as before, so test output that itself looks like a workflow
// command (`::add-mask::`, `::stop-commands::`) is not made safer or less safe by this script.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** GitHub shows at most 10 annotations per step; the log tail is always one of them, and the startup timeline is another when there is one. */
const MAX_ANNOTATIONS = 10;
const MAX_TIMELINE_LINES = 60;
const MAX_BLOCK_LINES = 40;
const MAX_BLOCK_CHARS = 3000;

export const escapeData = (text) => text.replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
export const escapeProperty = (text) => escapeData(text).replace(/:/g, "%3A").replace(/,/g, "%2C");

const indentOf = (line) => line.length - line.trimStart().length;

/** Failing tests in TAP output: each `not ok` line with the YAML block that follows it (to its `...` end marker). */
export function tapFailures(lines) {
  const found = [];
  for (let i = 0; i < lines.length; i++) {
    const match = /^(\s*)not ok \d+ - (.*)$/.exec(lines[i]);
    if (match === null) continue;
    const indent = match[1].length;
    const block = [];
    for (let j = i + 1; j < lines.length && block.length < MAX_BLOCK_LINES; j++) {
      const line = lines[j];
      block.push(line);
      if (line.trim() === "..." && indentOf(line) <= indent + 2) break; // end of this test's YAML block
      if (/^\s*(?:not )?ok \d+ - /.test(line) && indentOf(line) <= indent) { block.pop(); break; }
    }
    const text = block.join("\n").slice(0, MAX_BLOCK_CHARS);
    // Node prints a suite's children before the suite's own result and marks a suite that failed only because a child did with
    // `subtestsFailed`; skip those, so each real failure is reported once.
    if (!/failureType: 'subtestsFailed'/.test(text)) found.push({ name: match[2], text });
  }
  return found;
}

/** Failing tests in the spec reporter's closing "failing tests:" section: `test at file:line` then `✖ name (ms)` and the details. */
export function specFailures(lines) {
  const start = lines.findIndex((l) => l.trim() === "✖ failing tests:");
  if (start < 0) return [];
  const found = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (!/^test at /.test(lines[i])) continue;
    const head = /^✖ (.*?) \([\d.]+m?s\)\s*$/.exec(lines[i + 1] ?? "");
    if (head === null) continue;
    const block = [];
    for (let j = i + 2; j < lines.length && block.length < MAX_BLOCK_LINES && !/^test at /.test(lines[j]); j++) block.push(lines[j]);
    found.push({ name: head[1], text: block.join("\n").trim().slice(0, MAX_BLOCK_CHARS) });
  }
  return found;
}

/** A test cancelled only because the process running its file ended is a symptom; the failure that ended it is the cause. */
const isSymptom = (f) => /cancelledByParent|event loop has already resolved/.test(f.text);

/**
 * Failures worth annotating: root causes first, then a single line counting the symptoms (with the first one's name), so a file
 * that dies takes one annotation, not eight.
 */
export const failures = (lines, limit = MAX_ANNOTATIONS - 2) => {
  const spec = specFailures(lines);
  const all = spec.length > 0 ? spec : tapFailures(lines);
  const causes = all.filter((f) => !isSymptom(f));
  const symptoms = all.filter(isSymptom);
  const out = causes.slice(0, Math.max(0, limit - (symptoms.length > 0 ? 1 : 0)));
  if (symptoms.length > 0) {
    out.push({ name: `${symptoms.length} test(s) cancelled because their test file's process ended early`, text: `first: ${symptoms[0].name}\n${symptoms[0].text}` });
  }
  return out;
};

/** Lines the embedded PostgreSQL test server printed about its own startup (kept in the log by the test helper). */
export const timeline = (lines) => lines.filter((l) => l.includes("[embedded-postgres]")).slice(-MAX_TIMELINE_LINES);

export function annotations(log) {
  const lines = log.split(/\r?\n/);
  const startup = timeline(lines);
  const fixed = 1 + (startup.length > 0 ? 1 : 0);
  const out = failures(lines, MAX_ANNOTATIONS - fixed).map((f) => `::error title=${escapeProperty(`Failed - ${f.name}`.slice(0, 200))}::${escapeData(f.text)}`);
  if (startup.length > 0) out.push(`::error title=${escapeProperty("Embedded PostgreSQL startup timeline")}::${escapeData(startup.join("\n"))}`);
  out.push(`::error title=${escapeProperty("Test output (last 80 lines)")}::${escapeData(lines.slice(-80).join("\n"))}`);
  return out;
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  for (const line of annotations(readFileSync(process.argv[2], "utf8"))) console.log(line);
}
