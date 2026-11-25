// The typical test tier (card X11): build, check the package rules, then run the tests of the packages a change touches and the packages that depend
// on them, on the reference store and SQLite only, leaving out the long qualification runs. `--base=<ref>` is what the change is measured against
// (default: the merge base with origin/main, plus uncommitted changes); `--all` tests every package. The exhaustive tier is `npm test` and `npm run test:shard`.
//
// `--shard=<i>/<n>` runs one of n parts of the same tier (CI runs five, in parallel jobs, because the controller's tests alone take longer than a CI job may run): every part with
// work builds, part 1 also runs the root checks and the scripts' own tests, the other packages are spread over the parts, and the controller's test files are split into n slices
// of about equal run time (scripts/test-weights.json), over all the parts but the last, which carries the other packages. Together the n parts run exactly what the unsharded tier runs. `--dry-run` prints the steps of the part.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { affected, packageGraph } from "./affected-packages.mjs";

/**
 * The steps of part `index` of `count` for a selection (`"all"` or a list of package folder names; an empty list means nothing to test but the root checks). A step is `{ npm: [...] }`,
 * `{ node: [...] }`, or `{ npm: [...], env: true }` for package tests, which run with the typical-tier environment. A part with nothing to run returns no steps (and so no build).
 */
export function tierSteps(selected, packages, index = 1, count = 1) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 1 || index > count) throw new Error(`invalid shard ${index}/${count}`);
  const names = selected === "all" ? packages : selected;
  const others = names.filter((n) => n !== "controller");
  const controller = names.includes("controller");
  // With a controller to test and more than one part, the last part carries the other packages (the integration package alone takes minutes) and the controller's test files are split
  // into slices over the parts before it, part 1 also having the root checks; with no controller, the other packages are spread over all the parts.
  const sliced = controller && count > 1;
  const slices = sliced ? count - 1 : 1;
  const tests = [
    ...others.filter((_, k) => (sliced ? count : 1 + (k % count)) === index).map((n) => ({ npm: ["run", "test", "-w", `@nimblenewt/${n}`, "--if-present"], env: true })),
    ...(controller && index <= slices ? [{ npm: ["run", "test", "-w", "@nimblenewt/controller", "--if-present", ...(slices > 1 ? ["--", `--shard=${index}/${slices}`] : [])], env: true }] : []),
  ];
  // The root checks are quick and cover what no package's tests do (package rules, licenses, the plan and roadmap, the scripts' own tests): part 1 always runs them.
  const root = index === 1 ? [{ npm: ["run", "check:deps"] }, { npm: ["run", "licenses:check"] }, { npm: ["run", "roadmap:check"] }, { node: ["--test", "scripts/*.test.mjs"] }] : [];
  // A clean build: a test file deleted from the sources must not keep running from an old build. Nothing to test means no build.
  const build = names.length > 0 && (tests.length > 0) ? [{ npm: ["run", "clean"] }, { npm: ["run", "build"] }] : [];
  return [...build, ...root, ...tests];
}

const isMain = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const root = fileURLToPath(new URL("..", import.meta.url));
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const run = (command, args, env = {}) => spawnSync(command, args, { cwd: root, stdio: "inherit", env: { ...process.env, ...env }, shell: process.platform === "win32" }).status ?? 1;
  const out = (args) => { const r = spawnSync("git", args, { cwd: root, encoding: "utf8" }); return r.status === 0 ? r.stdout.split("\n").filter(Boolean) : undefined; };

  const baseFlag = process.argv.find((a) => a.startsWith("--base="));
  const shardFlag = process.argv.find((a) => a.startsWith("--shard="));
  const shardMatch = shardFlag === undefined ? null : /^--shard=(\d+)\/(\d+)$/.exec(shardFlag);
  if (shardFlag !== undefined && shardMatch === null) { console.error(`invalid ${shardFlag}`); process.exit(2); }
  const [index, count] = shardMatch === null ? [1, 1] : [Number(shardMatch[1]), Number(shardMatch[2])];
  if (index < 1 || index > count) { console.error(`invalid ${shardFlag}`); process.exit(2); }
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
  const part = count === 1 ? "" : ` (part ${index} of ${count})`;
  console.log(selected === "all" ? `TYPICAL TIER${part}: every package (a change outside the packages, or no history to compare with)` : selected.length === 0 ? `TYPICAL TIER${part}: no package is affected (documentation, or files only the root checks look at)` : `TYPICAL TIER${part}: ${selected.join(", ")}`);
  console.log("The typical tier leaves out PostgreSQL, SQLite on a worker thread and the long qualification runs; `npm test` is the exhaustive tier.");

  const env = { NIMBLENEWT_TIER: "typical", NIMBLENEWT_FAST: "1" };
  const steps = tierSteps(selected, [...graph.keys()], index, count);
  if (process.argv.includes("--dry-run")) {
    for (const s of steps) console.log(s.npm === undefined ? `node ${s.node.join(" ")}` : `npm ${s.npm.join(" ")}${s.env ? " [typical tier environment]" : ""}`);
    process.exit(0);
  }
  if (steps.length === 0) console.log("Nothing to run in this part.");
  for (const s of steps) {
    const status = s.npm === undefined ? (spawnSync(process.execPath, s.node, { cwd: root, stdio: "inherit" }).status ?? 1) : run(npm, s.npm, s.env ? env : {});
    if (status !== 0) process.exit(status);
  }
}
