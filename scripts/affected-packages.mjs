// Which packages a change touches (card X11): the packages with changed files and every package that depends on them, through the
// `@nimblenewt/*` entries of the packages' own package.json. A change outside the packages that could affect any of them (the lockfile,
// the root package.json, the TypeScript configuration, the scripts, the workflows) selects every package. Documentation alone selects none.
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

const DOCS_ONLY = /^(docs\/|README\.md$|LICENSE|CHANGELOG|\.gitignore$)/;
/** Documentation that a package's tests read (the plan and the acceptance records are parsed by pi-adapter's capability tests): a change to it selects that package. */
const DOC_READERS = [[/^docs\/nimblenewt\/implementation-plan\//, "pi-adapter"]];

/** The package folders to test for these changed paths (repository-relative, with `/`), in the graph's order, or `"all"`. */
export function affected(changed, graph) {
  const touched = new Set();
  for (const raw of changed) {
    const file = raw.replaceAll("\\", "/");
    const reader = DOC_READERS.find(([pattern]) => pattern.test(file));
    if (reader !== undefined) { if (graph.has(reader[1])) touched.add(reader[1]); continue; }
    if (DOCS_ONLY.test(file)) continue;
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
