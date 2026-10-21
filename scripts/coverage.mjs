// Test coverage of the compiled code of one package (default: the controller): runs its tests under Node's built-in coverage and prints the
// overall figures and every file below a line-coverage bar. Information only; nothing fails on a figure. The slow qualification files are
// left out (scripts/slow-tests.json), so the figures are for the fast tier. The TAP reporter is requested explicitly because the default reporter differs between Node versions. Usage: `node scripts/coverage.mjs [package] [--bar=80]` after a build.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** The overall row and the files under `bar` percent line coverage, from Node's coverage report text. */
export function summarise(report, bar) {
  const rows = report.split(/\r?\n/).filter((l) => /^# .*\|/.test(l)).map((l) => l.replace(/^# /, "").split("|").map((c) => c.trim()));
  const num = (c) => (c === undefined || c === "" ? undefined : Number(c));
  const all = rows.find((r) => r[0] === "all files");
  const low = rows.filter((r) => /\.js$/.test(r[0] ?? "") && num(r[1]) !== undefined && num(r[1]) < bar).map((r) => ({ file: r[0], line: num(r[1]), branch: num(r[2]), funcs: num(r[3]) }));
  return { all: all === undefined ? undefined : { line: num(all[1]), branch: num(all[2]), funcs: num(all[3]) }, low };
}

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? testFiles(join(dir, e.name)) : e.name.endsWith(".test.js") ? [join(dir, e.name)] : []));
}

if (process.argv[1] !== undefined && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const name = process.argv.slice(2).find((a) => !a.startsWith("--")) ?? "controller";
  const barFlag = process.argv.find((a) => a.startsWith("--bar="));
  const bar = barFlag === undefined ? 80 : Number(barFlag.slice(6));
  const dir = join(root, "packages", name);
  if (!existsSync(join(dir, "dist"))) { console.error(`no dist/ in packages/${name}; run npm run build first`); process.exit(2); }
  const slow = JSON.parse(readFileSync(join(root, "scripts", "slow-tests.json"), "utf8")).files;
  const files = testFiles(join(dir, "dist")).map((f) => f.slice(dir.length + 1)).filter((f) => !slow.some((s) => ("/" + f.split(sep).join("/")).endsWith("/" + s)));
  const guard = pathToFileURL(join(root, "scripts", "offline-guard.mjs")).href;
  const run = spawnSync(process.execPath, ["--import", guard, "--test", "--test-timeout=600000", "--test-reporter=tap", "--test-reporter-destination=stdout", "--experimental-test-coverage", "--test-coverage-exclude=**/*.test.js", ...files], { cwd: dir, encoding: "utf8", maxBuffer: 1 << 28 });
  const { all, low } = summarise(run.stdout, bar);
  if (all === undefined) { console.error("no coverage report found; the tests may have failed"); console.error(run.stdout.slice(-2000)); process.exit(1); }
  console.log(`${name}: lines ${all.line}%, branches ${all.branch}%, functions ${all.funcs}% (${files.length} test files; ${run.status === 0 ? "tests passed" : "TESTS FAILED"})`);
  for (const f of low) console.log(`  below ${bar}%: ${f.file} lines ${f.line}% branches ${f.branch}% functions ${f.funcs}%`);
  process.exit(run.status === 0 ? 0 : 1);
}
