// Runs the compiled tests of the package in the current directory under the offline guard;
// fails if none are found.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? testFiles(join(dir, e.name)) : e.name.endsWith(".test.js") ? [join(dir, e.name)] : []);
}
// Each test file is itself a test with this bound. 60 s suits the packages that run in memory; a package whose files start real
// servers and run on slow CI machines passes a larger one: `run-package-tests.mjs --timeout=300000`.
const timeoutFlag = process.argv.find((a) => a.startsWith("--timeout="));
const timeoutMs = timeoutFlag === undefined ? 60000 : Number(timeoutFlag.slice("--timeout=".length));
if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1000) { console.error(`invalid ${timeoutFlag}`); process.exit(2); }
// The fast tier (`node scripts/test-fast.mjs`, or NIMBLENEWT_FAST=1) leaves out the test files named in scripts/slow-tests.json: the long
// qualification and workload runs. The full run (`npm test`) is the one that counts for release and QA evidence; the fast tier is for the
// edit-and-check loop, and it prints how many files it left out so that it is never mistaken for the full run.
const fast = process.env.NIMBLENEWT_FAST === "1";
const slow = fast ? JSON.parse(readFileSync(fileURLToPath(new URL("./slow-tests.json", import.meta.url)), "utf8")).files : [];
const all = existsSync("dist") ? testFiles("dist") : [];
const files = all.filter((f) => !slow.some((name) => ("/" + f.split(sep).join("/")).endsWith("/" + name)));
if (fast && files.length !== all.length) console.log(`FAST TIER: ${all.length - files.length} slow test file(s) left out of ${all.length}; run \`npm test\` for the full suite`);
if (files.length === 0) { console.error("no compiled test files found in dist/; did the build run?"); process.exit(1); }
const guard = pathToFileURL(fileURLToPath(new URL("./offline-guard.mjs", import.meta.url))).href;
process.exit(spawnSync(process.execPath, ["--import", guard, "--test", `--test-timeout=${timeoutMs}`, ...files], { stdio: "inherit" }).status ?? 1);
