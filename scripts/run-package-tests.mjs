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
const files = existsSync("dist") ? testFiles("dist") : [];
if (files.length === 0) { console.error("no compiled test files found in dist/; did the build run?"); process.exit(1); }
const guard = pathToFileURL(fileURLToPath(new URL("./offline-guard.mjs", import.meta.url))).href;
process.exit(spawnSync(process.execPath, ["--import", guard, "--test", "--test-timeout=60000", ...files], { stdio: "inherit" }).status ?? 1);
