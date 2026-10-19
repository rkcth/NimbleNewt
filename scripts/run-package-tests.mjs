// Runs the compiled tests of the package in the current directory; fails if none are found.
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

function testFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? testFiles(join(dir, e.name)) : e.name.endsWith(".test.js") ? [join(dir, e.name)] : []);
}
const files = existsSync("dist") ? testFiles("dist") : [];
if (files.length === 0) { console.error("no compiled test files found in dist/; did the build run?"); process.exit(1); }
process.exit(spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit" }).status ?? 1);
