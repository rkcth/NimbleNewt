// Measures how long each of the controller's compiled test files takes and writes scripts/test-weights.json, which the exhaustive tier uses to split the files into shards of
// about equal run time (card X11). Run it after a build, on a quiet machine: `node scripts/test-weights.mjs`. Files are run one at a time under the offline guard.
import { spawnSync } from "node:child_process";
import { readdirSync, writeFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const dist = join(root, "packages", "controller", "dist");
const guard = pathToFileURL(join(root, "scripts", "offline-guard.mjs")).href;
const files = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(dir, e.name)) : e.name.endsWith(".test.js") ? [join(dir, e.name)] : []));

const seconds = {};
for (const file of files(dist).sort()) {
  const started = process.hrtime.bigint();
  spawnSync(process.execPath, ["--import", guard, "--test", "--test-timeout=600000", file], { cwd: join(root, "packages", "controller"), stdio: "ignore" });
  const key = relative(dist, file).split(sep).join("/");
  seconds[key] = Math.round(Number(process.hrtime.bigint() - started) / 1e8) / 10;
  console.log(`${seconds[key]}s ${key}`);
}
writeFileSync(join(root, "scripts", "test-weights.json"), JSON.stringify({ comment: "Seconds per controller test file, measured by scripts/test-weights.mjs; the exhaustive tier splits the files into shards by these.", seconds }, null, 2) + "\n");
