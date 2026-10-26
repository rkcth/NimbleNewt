// The typical test tier (card X11): build, check the package rules, then run the tests of the packages a change touches and the packages that depend
// on them, on the reference store and SQLite only, leaving out the long qualification runs. `--base=<ref>` is what the change is measured against
// (default: the merge base with origin/main, plus uncommitted changes); `--all` tests every package. The exhaustive tier is `npm test` and `npm run test:shard`.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { affected, packageGraph } from "./affected-packages.mjs";

const root = fileURLToPath(new URL("..", import.meta.url));
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const run = (command, args, env = {}) => spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" }).status ?? 1;
const out = (args) => { const r = spawnSync("git", args, { cwd: root, encoding: "utf8" }); return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : undefined; };

const baseFlag = process.argv.find((a) => a.startsWith("--base="));
let changed;
if (process.argv.includes("--all")) changed = ["package.json"];
else {
  const base = baseFlag?.slice("--base=".length) ?? out(["merge-base", "HEAD", "origin/main"])?.[0];
  const committed = base === undefined ? undefined : out(["diff", "--name-only", "--no-renames", `${base}`, "HEAD"]);
  const dirty = out(["status", "--porcelain"])?.map((l) => l.slice(3));
  // Without git history to measure against, everything is tested rather than nothing.
  changed = committed === undefined || dirty === undefined ? ["package.json"] : [...committed, ...dirty];
}
const graph = packageGraph(root);
const selected = affected(changed, graph);
console.log(selected === "all" ? "TYPICAL TIER: every package (a change outside the packages, or no history to compare with)" : selected.length === 0 ? "TYPICAL TIER: no package is affected (documentation only)" : `TYPICAL TIER: ${selected.join(", ")}`);
console.log("The typical tier leaves out PostgreSQL, SQLite on a worker thread and the long qualification runs; `npm test` is the exhaustive tier.");

const env = { NIMBLENEWT_TIER: "typical", NIMBLENEWT_FAST: "1" };
const none = selected !== "all" && selected.length === 0;
// The root checks are quick and cover what no package's tests do (package rules, licenses, the plan and roadmap, the scripts' own tests): they always run.
const steps = [];
// A clean build: a test file deleted from the sources must not keep running from an old build.
if (!none) steps.push(["run", "clean"], ["run", "build"]);
steps.push(["run", "check:deps"], ["run", "licenses:check"], ["run", "roadmap:check"]);
for (const step of steps) { const s = run(npm, step); if (s !== 0) process.exit(s); }
{ const s = spawnSync(process.execPath, ["--test", "scripts/*.test.mjs"], { cwd: root, stdio: "inherit" }).status ?? 1; if (s !== 0) process.exit(s); }
if (none) process.exit(0);
if (selected === "all") process.exit(run(npm, ["run", "test", "--workspaces", "--if-present"], env));
for (const name of selected) { const s = run(npm, ["run", "test", "-w", `@nimblenewt/${name}`, "--if-present"], env); if (s !== 0) process.exit(s); }
