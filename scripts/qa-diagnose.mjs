// Reads the output of `node scripts/qa.mjs` and prints, in one short block, what failed: each failing test with the number of runs it failed
// in, the first lines of its error, and what the disk holds. It also writes the block to <out>/diagnosis.txt so it can be sent as one file.
// Usage: `node scripts/qa-diagnose.mjs [qa-output-dir]` (default: qa-output in the repository). It only reads; it changes nothing but diagnosis.txt.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { failingNames } from "./postgres-versions.mjs";

/** For each failing test name, in how many runs it failed and the first lines of its error from the last run that failed it. */
export function diagnose(logs) {
  const seen = new Map();
  for (const log of logs) {
    for (const name of failingNames(log)) {
      const at = log.lastIndexOf(name);
      const after = at < 0 ? "" : log.slice(at, at + 1800);
      const window = [];
      for (const line of after.split(/\r?\n/).slice(1, 14)) { if (/^\s*(?:✖|✔|ok \d+|not ok \d+|npm error)/.test(line)) break; window.push(line.trimEnd()); }
      const detail = window.filter((l) => /error|expected|actual|Assertion|ENOENT|EPERM|EACCES|EBUSY|ENOSPC|\+|-  |message/i.test(l)).slice(0, 6);
      const entry = seen.get(name) ?? { name, runs: 0, detail };
      entry.runs += 1;
      entry.detail = detail.length > 0 ? detail : entry.detail;
      seen.set(name, entry);
    }
  }
  return [...seen.values()].sort((a, b) => b.runs - a.runs || a.name.localeCompare(b.name));
}

/** The slowest tests of a log, from Node's spec lines (`✔ name (123.4ms)`) and TAP output (`ok 3 - name` then `duration_ms: 123.4`). A test that contains others also shows, so this is a guide, not a profile. */
export function slowest(log, count = 10) {
  const found = [];
  const lines = log.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const spec = /^\s*[✔✖] (.+?) \(([\d.]+)ms\)\s*$/.exec(lines[i]);
    if (spec !== null) { found.push({ name: spec[1], ms: Number(spec[2]) }); continue; }
    const tap = /^\s*(?:not )?ok \d+ - (.+?)\s*$/.exec(lines[i]);
    if (tap === null) continue;
    for (let j = i + 1; j < Math.min(i + 8, lines.length); j++) {
      const d = /^\s*duration_ms: ([\d.]+)/.exec(lines[j]);
      if (d !== null) { found.push({ name: tap[1], ms: Number(d[1]) }); break; }
      if (/^\s*(?:not )?ok \d+ - /.test(lines[j])) break;
    }
  }
  return found.sort((a, b) => b.ms - a.ms).slice(0, count);
}

/** Lines of a log that look like trouble even when no test failed (warnings from the test helpers, locked files, errors printed by tools), each once with a count, most frequent first. */
export function noisy(log, count = 8) {
  const seen = new Map();
  for (const line of log.split(/\r?\n/)) {
    if (!/could not remove|EBUSY|EPERM|EACCES|ENOSPC|ENOTEMPTY|npm (?:error|warn)|\bERR_|Error:|\bwarn(?:ing)?\b|timed out|FATAL|panic/i.test(line)) continue;
    const key = line.replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, "").replace(/\s+/g, " ").trim().slice(0, 200);
    // Not trouble: test names, Node's own notice about experimental SQLite, the test names that contain the word, and the test PostgreSQL servers' log (the suites provoke FATAL and ERROR lines on purpose).
    if (key === "" || /^[✔✖]|^ok \d|^not ok \d|^# Subtest|\(Use `node|ExperimentalWarning|^# \[embedded-postgres\] server:/.test(key)) continue;
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  return [...seen.entries()].sort((a, b) => b[1] - a[1]).slice(0, count).map(([text, times]) => ({ text, times }));
}

function diskInfo(directory) {
  // `diskutil info` wants the volume, not a folder inside it: on macOS find the device with `df` first.
  const device = process.platform === "darwin" ? spawnSync("df", ["-P", directory], { encoding: "utf8" }).stdout?.trim().split("\n").pop()?.split(/\s+/)[0] : undefined;
  const attempts = process.platform === "darwin" ? (device === undefined ? [] : [["diskutil", ["info", device]]]) : process.platform === "win32" ? [] : [["df", ["-T", directory]]];
  for (const [command, args] of attempts) {
    const result = spawnSync(command, args, { encoding: "utf8" });
    if (result.status !== 0) continue;
    const all = result.stdout.split("\n");
    // `df` prints a header and one data line (whatever it starts with); `diskutil` prints many "Name: value" lines, of which these matter for tests that need permissions and fsync.
    const lines = command === "df" ? all.slice(0, 2) : all.filter((l) => /file system|type name|mount point|volume name|read-only|owners|protocol|personality/i.test(l));
    const kept = lines.map((l) => l.trim()).filter((l) => l !== "");
    if (kept.length > 0) return kept.slice(0, 10);
  }
  return ["(could not read the file system information)"];
}

export function main(argv) {
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const dir = resolve(argv[0] ?? join(root, "qa-output"));
  if (!existsSync(dir)) { console.error(`no such folder: ${dir}`); return 2; }
  // Only the logs of the run the evidence describes: a folder reused by an earlier run can hold older logs (an older `qa.mjs` did not clear them).
  let listed;
  try { listed = JSON.parse(readFileSync(join(dir, "qa-evidence.json"), "utf8")).runs?.map((r) => r.logFile); } catch { listed = undefined; }
  const names = (Array.isArray(listed) && listed.length > 0 ? listed : readdirSync(dir).filter((f) => /^run-\d+\.log$/.test(f)).sort()).filter((f) => existsSync(join(dir, f)));
  const logs = names.map((f) => readFileSync(join(dir, f), "utf8"));
  const found = diagnose(logs);
  let evidence;
  try { evidence = existsSync(join(dir, "qa-evidence.json")) ? JSON.parse(readFileSync(join(dir, "qa-evidence.json"), "utf8")) : undefined; } catch { evidence = null; }
  const out = [
    `QA diagnosis of ${dir}`,
    evidence === undefined ? "(no qa-evidence.json)" : evidence === null ? "(qa-evidence.json is unreadable)" : `${evidence.environment?.os} ${evidence.environment?.arch}, Node ${evidence.environment?.node}, commit ${String(evidence.commit ?? "").slice(0, 7)}, ${evidence.runs?.filter((r) => !r.passed).length} of ${evidence.runs?.length} runs failed`,
    `runs read: ${logs.length}`,
    "",
    found.length === 0 ? "No failing test names were found in the logs." : "Failing tests (runs failed / name):",
    ...found.flatMap((f) => [`  ${f.runs}/${logs.length}  ${f.name}`, ...f.detail.map((l) => `        ${l}`)]),
    "",
    "Lines that look like trouble, even where no test failed (count / line):",
    ...(() => { const lines = noisy(logs.join("\n")); return lines.length === 0 ? ["  none"] : lines.map((n) => `  ${String(n.times).padStart(4)}  ${n.text}`); })(),
    "",
    ...(evidence === undefined || evidence === null ? ["The run did not finish writing its summary, so here is the end of the last log (what was on screen):", ...(logs.length === 0 ? ["  (no logs)"] : (logs[logs.length - 1] ?? "").trimEnd().split(/\r?\n/).slice(-18).map((l) => `  | ${l.slice(0, 200)}`)), ""] : []),
    "Slowest tests in the first run (seconds; a test that contains others also shows):",
    ...(logs[0] === undefined ? [] : slowest(logs[0]).map((t) => `  ${(t.ms / 1000).toFixed(1).padStart(7)}  ${t.name.slice(0, 110)}`)),
    "",
    "Disk holding the folder:",
    ...(evidence?.environment?.checkoutFilesystem === undefined ? [] : [`  recorded by the QA run: ${JSON.stringify(evidence.environment.checkoutFilesystem)}`]),
    ...diskInfo(dir).map((l) => `  ${l}`),
  ].join("\n");
  writeFileSync(join(dir, "diagnosis.txt"), `${out}\n`);
  console.log(out);
  console.log(`\n(also written to ${join(dir, "diagnosis.txt")})`);
  return 0;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
