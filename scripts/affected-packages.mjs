// Which packages a change touches (card X11): the packages with changed files and every package that depends on them, through the
// `@nimblenewt/*` entries of the packages' own package.json. A change outside the packages that could affect any of them (the lockfile,
// the root package.json, the TypeScript configuration, the scripts that the packages' tests run or read, the workflows) selects every package. Documentation alone selects none,
// and so do the files that only the root checks and the scripts' own tests (`scripts/*.test.mjs`, which every run executes) look at.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Package folder name -> folder names of the product packages it depends on. */
export function packageGraph(root) {
  const graph = new Map();
  for (const name of readdirSync(join(root, "packages"))) {
    const file = join(root, "packages", name, "package.json");
    if (!existsSync(file)) continue;
    const json = JSON.parse(readFileSync(file, "utf8"));
    const deps = Object.keys({ ...json.dependencies, ...json.devDependencies, ...json.peerDependencies }).filter((d) => d.startsWith("@nimblenewt/")).map((d) => d.slice("@nimblenewt/".length));
    graph.set(name, deps);
  }
  return graph;
}

const DOCS_ONLY = /^(docs\/|README\.md$|CONTRIBUTING\.md$|SECURITY\.md$|LICENSE|CHANGELOG|\.gitignore$)/;
/**
 * Files outside the packages that no package's sources or tests run, read or import: the scripts' own tests and the helpers of the tiers, the evidence and the diagnosis tools. The root checks
 * and `node --test scripts/*.test.mjs` run on every change and are what covers them, so a change to one of them selects no package. scripts/affected-packages.test.mjs keeps this list honest:
 * it fails if a package source (or another script that is not itself listed) names one of these files. Anything not listed here and not in a package selects every package.
 */
export const ROOT_ONLY = [
  // (a package's drift test reads copy-credential-scan.test.mjs, so that one still selects everything)
  /^scripts\/(?!copy-credential-scan\.test\.mjs$)[^/]+\.test\.mjs$/,
  /^scripts\/(affected-packages|test-changed|test-shard|ci-annotate|coverage|qa-diagnose|seatbelt-diagnose|license-inventory|roadmap|check-package-boundaries|y02-checkpoint|wsb-cleanup|wsb-job-context|wsb-launch-variants|wsb-list-line)\.mjs$/,
  /^scripts\/y02-scenarios\.json$/,
  /^scripts\/generate_task_plan\.py$/,
  // The other workflows are read by scripts/evidence-workflows.test.mjs (a script test); only ci.yml is read by a package's test (the minimum Node); own-hardware.yml and qa.yml are named in package or script sources.
  /^\.github\/workflows\/(exhaustive|postgres-versions|sandbox-diagnose|windows-appcontainer-experiment)\.yml$/,
];
/** Documentation that a package's tests read (the plan and the acceptance records are parsed by pi-adapter's capability tests): a change to it selects that package. */
const DOC_READERS = [
  [/^docs\/nimblenewt\/implementation-plan\//, "pi-adapter"],
  // The Windows launcher experiment's Cargo.toml is read by the worker's contract test.
  [/^experiments\/windows-appcontainer\//, "worker"],
  // The Windows launcher crate's sources and manifest are read by the worker's contract test; its installer and other scripts are covered by scripts/native-launcher.test.mjs.
  [/^native\//, "worker"],
];

/** The package folders to test for these changed paths (repository-relative, with `/`), in the graph's order, or `"all"`. */
export function affected(changed, graph) {
  const touched = new Set();
  for (const raw of changed) {
    const file = raw.replaceAll("\\", "/");
    const reader = DOC_READERS.find(([pattern]) => pattern.test(file));
    if (reader !== undefined) { if (graph.has(reader[1])) touched.add(reader[1]); continue; }
    if (DOCS_ONLY.test(file) || ROOT_ONLY.some((p) => p.test(file))) continue;
    const m = /^packages\/([^/]+)\//.exec(file);
    if (m === null) return "all";
    if (!graph.has(m[1])) return "all";
    touched.add(m[1]);
  }
  // Dependents, to a fixed point.
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, deps] of graph) if (!touched.has(name) && deps.some((d) => touched.has(d))) { touched.add(name); grew = true; }
  }
  return [...graph.keys()].filter((n) => touched.has(n));
}
