// QA run for one machine: repeats `npm test` on a fresh checkout and writes an evidence record (qa-evidence.json and
// qa-summary.md) that says what machine it ran on, which commit, and what each run did. It is the scripted form of the
// QA checklist in docs/nimblenewt/implementation-plan/g02-acceptance.md (steps 2-4 and 6), run by the QA workflow
// (.github/workflows/qa.yml) or by hand: `node scripts/qa.mjs [--runs=5] [--out=<dir>]`.
// It changes nothing in the repository, uses no network of its own and no credentials. It never accepts anything: a passing
// record is evidence for the owner, who signs the card.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_RUNS = 5;
const MAX_RUNS = 20;
const TAIL_LINES = 80;

/** Sums the totals Node's test runner prints per package (`ℹ tests 12` in spec format, `# tests 12` in TAP). */
export function parseTotals(log) {
  const totals = { tests: 0, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  let blocks = 0;
  for (const line of log.split(/\r?\n/)) {
    const match = /^(?:ℹ|#) (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/.exec(line);
    if (match === null) continue;
    totals[match[1]] += Number(match[2]);
    if (match[1] === "tests") blocks++;
  }
  return { ...totals, blocks };
}

/** Lines of the log that the checklist asks to record: the gate messages and the platform line of the G02 environment test. */
export function markers(log) {
  const lines = log.split(/\r?\n/);
  const find = (re) => lines.find((l) => re.test(l))?.trim() ?? null;
  return {
    packageBoundaries: find(/package boundaries ok/),
    licenseInventory: find(/license inventory ok/),
    g02Environment: find(/^(?:ℹ|#) G02 environment: \S+ node /),
  };
}

/** A run passes only if it exited 0, ran tests, none failed or were cancelled, and left the tracked files as it found them. */
export function judgeRun({ exitCode, totals, lockfileBefore, lockfileAfter, dirtyBefore, dirtyAfter }) {
  const problems = [];
  if (exitCode !== 0) problems.push(`npm test exited with ${exitCode}`);
  if (totals.tests === 0) problems.push("no test totals were found in the output");
  if (totals.fail > 0) problems.push(`${totals.fail} tests failed`);
  if (totals.cancelled > 0) problems.push(`${totals.cancelled} tests were cancelled`);
  if (lockfileBefore !== lockfileAfter) problems.push("package-lock.json changed during the run");
  if (dirtyAfter !== dirtyBefore) problems.push(`tracked files differ from before the run: ${dirtyAfter.split("\n").slice(0, 5).join("; ") || "(clean again)"}`);
  return problems;
}

export function renderSummary(record) {
  const rows = record.runs.map((r) => `| ${r.run} | ${r.passed ? "pass" : "FAIL"} | ${r.seconds} s | ${r.totals.tests} | ${r.totals.pass} | ${r.totals.fail} | ${r.problems.join("; ") || ""} |`);
  const inconsistent = record.crossRunProblems ?? [];
  const verdict = record.passed ? `all ${record.runs.length} runs passed` : `${record.runs.filter((r) => !r.passed).length} of ${record.runs.length} runs FAILED${inconsistent.length ? `, and the runs were not consistent` : ""}`;
  return [
    `# QA run: ${record.environment.os} ${record.environment.arch}, Node ${record.environment.node}`,
    "",
    `**${verdict}.** Commit \`${record.commit}\`${record.environment.workingTreeClean ? "" : " (working tree was not clean at the start)"}; checkout path contains a space: ${record.environment.pathHasSpace ? "yes" : "no"}.`,
    "",
    "| Run | Result | Time | Tests | Pass | Fail | Problems |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    ...inconsistent.map((p) => `Inconsistent: ${p}.`),
    `Platform line from the G02 environment test: ${record.runs[0]?.markers.g02Environment ?? "not found"}`,
    "",
    "This is evidence for the owner, not an acceptance. It was produced by an automated AI-authored script, not a human reviewer.",
    "",
  ].join("\n");
}

/** Changed tracked files and a hash of their content, so a further edit to an already modified file is seen too. */
function trackedState(root) {
  const names = git(["status", "--porcelain", "--untracked-files=no"], root);
  return names === "" ? "" : `${names}\n${createHash("sha256").update(git(["diff", "HEAD"], root)).digest("hex")}`;
}

/** Every run on one machine runs the same tests, so differing totals mean a package or file silently did not run (or is flaky). */
export function crossRunProblems(runs) {
  const shape = (r) => `${r.totals.tests} tests in ${r.totals.blocks} packages`;
  const first = runs[0];
  return first === undefined ? [] : runs.filter((r) => shape(r) !== shape(first)).map((r) => `run ${r.run} had ${shape(r)}, run ${first.run} had ${shape(first)}`);
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "";
}

const sha256 = (path) => createHash("sha256").update(readFileSync(path)).digest("hex");

function filesystemType(dir) {
  if (process.platform === "linux") {
    const r = spawnSync("stat", ["-f", "-c", "%T", dir], { encoding: "utf8" });
    if (r.status === 0) return r.stdout.trim();
  }
  if (process.platform === "darwin") {
    // `df` names the device the folder lives on; `mount` says what file system is mounted there, for example "apfs" or "exfat".
    const df = spawnSync("df", ["-P", dir], { encoding: "utf8" });
    const device = df.status === 0 ? df.stdout.trim().split("\n").pop()?.split(/\s+/)[0] : undefined;
    const mounted = device === undefined ? undefined : spawnSync("mount", [], { encoding: "utf8" }).stdout?.split("\n").find((l) => l.startsWith(`${device} on `));
    const type = mounted === undefined ? undefined : /\(([^,)]+)/.exec(mounted)?.[1];
    // "noowners" (the default on external volumes) changes how permission tests behave, so it is kept in the record.
    if (type !== undefined) return /\bnoowners\b/.test(mounted ?? "") ? `${type} (noowners)` : type;
  }
  return "not detected";
}

function environment(root) {
  return {
    os: `${os.type()} ${os.release()}`,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    npm: spawnSync("npm", ["-v"], { encoding: "utf8", shell: true }).stdout?.trim() ?? "",
    cpus: os.cpus().length,
    memoryGiB: Math.round(os.totalmem() / 2 ** 30),
    checkoutPath: root,
    pathHasSpace: root.includes(" "),
    checkoutFilesystem: filesystemType(root),
    ci: process.env.GITHUB_ACTIONS === "true",
    workingTreeClean: git(["status", "--porcelain"], root) === "",
  };
}

function runOnce(root, outDir, run) {
  const logPath = join(outDir, `run-${run}.log`);
  const lockfileBefore = sha256(join(root, "package-lock.json"));
  const dirtyBefore = trackedState(root);
  const fd = openSync(logPath, "w");
  const started = Date.now();
  // The output goes to a file, not a pipe: a long run cannot stall on a full pipe, and the whole log is kept as evidence.
  const result = spawnSync("npm", ["test"], { cwd: root, stdio: ["ignore", fd, fd], shell: true });
  closeSync(fd);
  const log = readFileSync(logPath, "utf8");
  const totals = parseTotals(log);
  const problems = judgeRun({
    exitCode: result.status ?? -1,
    totals,
    lockfileBefore,
    lockfileAfter: sha256(join(root, "package-lock.json")),
    dirtyBefore,
    dirtyAfter: trackedState(root),
  });
  const lines = log.split(/\r?\n/);
  return {
    run,
    passed: problems.length === 0,
    exitCode: result.status ?? -1,
    seconds: Math.round((Date.now() - started) / 100) / 10,
    totals,
    markers: markers(log),
    problems,
    logFile: `run-${run}.log`,
    ...(problems.length > 0 ? { tail: lines.slice(-TAIL_LINES).join("\n") } : {}),
  };
}

export function main(argv) {
  const flag = (name) => argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
  const runs = flag("runs") === undefined ? DEFAULT_RUNS : Number(flag("runs"));
  if (!Number.isSafeInteger(runs) || runs < 1 || runs > MAX_RUNS) { console.error(`--runs must be an integer from 1 to ${MAX_RUNS}`); return 2; }
  const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const outDir = resolve(flag("out") ?? join(root, "qa-output"));
  mkdirSync(outDir, { recursive: true });
  // Files left by an earlier run in this folder would be read as part of this one (an interrupted run would otherwise sit beside the old evidence).
  for (const f of readdirSync(outDir)) if (/^run-\d+\.log$/.test(f) || f === "qa-evidence.json" || f === "qa-summary.md" || f === "diagnosis.txt") rmSync(join(outDir, f), { force: true });
  const env = environment(root);
  const record = { commit: git(["rev-parse", "HEAD"], root), startedAt: new Date().toISOString(), environment: env, requestedRuns: runs, runs: [], passed: false };
  for (let run = 1; run <= runs; run++) {
    const result = runOnce(root, outDir, run);
    record.runs.push(result);
    console.log(`run ${run}/${runs}: ${result.passed ? "pass" : "FAIL"} in ${result.seconds} s (${result.totals.pass} of ${result.totals.tests} tests)${result.problems.length ? ` - ${result.problems.join("; ")}` : ""}`);
  }
  record.crossRunProblems = crossRunProblems(record.runs);
  for (const p of record.crossRunProblems) console.log(`inconsistent: ${p}`);
  record.passed = record.runs.length === runs && record.runs.every((r) => r.passed) && record.crossRunProblems.length === 0;
  writeFileSync(join(outDir, "qa-evidence.json"), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(outDir, "qa-summary.md"), renderSummary(record));
  console.log(`evidence written to ${outDir}`);
  return record.passed ? 0 : 1;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));
