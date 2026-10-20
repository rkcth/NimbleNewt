// Runs the compiled tests of the package in the current directory under the offline guard;
// fails if none are found.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
const files = existsSync("dist") ? testFiles("dist") : [];
if (files.length === 0) { console.error("no compiled test files found in dist/; did the build run?"); process.exit(1); }
const guard = pathToFileURL(fileURLToPath(new URL("./offline-guard.mjs", import.meta.url))).href;
process.exit(spawnSync(process.execPath, ["--import", guard, "--test", `--test-timeout=${timeoutMs}`, ...files], { stdio: "inherit" }).status ?? 1);
