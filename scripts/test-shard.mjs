// The exhaustive tier, one shard of it (card X11): `node scripts/test-shard.mjs <i>/<n>`. Every shard builds; shard 1 also runs the root checks (package rules, licenses,
// roadmap, script tests) and every package except the controller; each shard runs its i-th slice of the controller's test files, balanced by recorded run time
// (scripts/test-weights.json). Together the n shards run exactly what `npm test` runs. All backends and the long qualification runs are included.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { packageGraph } from "./affected-packages.mjs";

/** The steps of shard `index` of `count`: what `npm test` runs, with the controller's test files split. Shard 1 carries the root checks and every other package. */
export function shardSteps(index, count, packages) {
  const steps = [["run", "clean"], ["run", "build"]];
  if (index === 1) steps.push(["run", "check:deps"], ["run", "licenses:check"], ["run", "roadmap:check"], { node: ["--test", "scripts/*.test.mjs"] });
  for (const name of packages) {
    if (name === "controller") steps.push(["run", "test", "-w", "@nimblenewt/controller", "--", `--shard=${index}/${count}`]);
    else if (index === 1) steps.push(["run", "test", "-w", `@nimblenewt/${name}`, "--if-present"]);
  }
  return steps;
}

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
const m = /^(\d+)\/(\d+)$/.exec(process.argv[2] ?? "");
if (isMain && m === null) { console.error("usage: node scripts/test-shard.mjs <i>/<n>"); process.exit(2); }
const [index, count] = m === null ? [0, 0] : [Number(m[1]), Number(m[2])];
const run = (step) => (step.node === undefined ? spawnSync(npm, step, { cwd: root, stdio: "inherit", shell: process.platform === "win32" }) : spawnSync(process.execPath, step.node, { cwd: root, stdio: "inherit" })).status ?? 1;
if (isMain) {
  const steps = shardSteps(index, count, [...packageGraph(root).keys()]);
  for (const step of steps) { const s = run(step); if (s !== 0) process.exit(s); }
}
