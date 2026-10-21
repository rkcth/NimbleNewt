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
  const logs = readdirSync(dir).filter((f) => /^run-\d+\.log$/.test(f)).sort().map((f) => readFileSync(join(dir, f), "utf8"));
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
