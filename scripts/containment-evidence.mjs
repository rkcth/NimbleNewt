// Card G05: produce and judge isolation-boundary evidence.
//   node scripts/containment-evidence.mjs run  --out DIR            run the suite here, write DIR/containment-<platform>.json
//   node scripts/containment-evidence.mjs gate --dir DIR --commit SHA   read every containment-*.json in DIR and list what blocks a release
// `run` needs a built tree (npx tsc --build) and a committed checkout; the report names the commit and says if the tree was dirty.
// `gate` exits 1 while anything blocks, so a release step can call it. Reports are read as data: size-bounded and shape-checked.
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const worker = await import(pathToFileURL(join(here, "..", "packages", "worker", "dist", "index.js")).href);

const [command, ...rest] = process.argv.slice(2);
const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

if (command === "run") {
  const out = flag("out");
  if (out === undefined) { console.error("usage: run --out DIR"); process.exit(2); }
  const report = await worker.produceReport(join(here, ".."));
  mkdirSync(resolve(out), { recursive: true });
  const file = join(resolve(out), `containment-${report.platform}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const bad = report.cases.filter((c) => c.verdict !== "pass");
  console.log(`${report.platform} (${report.backend}${report.backendVersion ? ` ${report.backendVersion}` : ""}) commit ${report.implementationCommit.slice(0, 12)}${report.dirty ? " DIRTY" : ""}: ${report.cases.length - bad.length}/${report.cases.length} cases hold -> ${file}`);
  for (const c of bad) console.log(`  ${c.verdict} ${c.id}: ${c.detail}`);
  process.exit(bad.length === 0 && report.capacityAvailable ? 0 : 1);
} else if (command === "gate") {
  const dir = flag("dir");
  const commit = flag("commit");
  if (dir === undefined || commit === undefined) { console.error("usage: gate --dir DIR --commit SHA"); process.exit(2); }
  const reports = [];
  const problems = [];
  for (const name of readdirSync(resolve(dir)).filter((n) => /^containment-[a-z0-9]+\.json$/.test(n)).sort()) {
    const file = join(resolve(dir), name);
    if (statSync(file).size > worker.MAX_REPORT_BYTES) { problems.push(`${name}: larger than ${worker.MAX_REPORT_BYTES} bytes`); continue; }
    const parsed = worker.parseReport(readFileSync(file, "utf8"));
    if ("error" in parsed) problems.push(`${name}: ${parsed.error}`); else reports.push(parsed.report);
  }
  const result = worker.assessRelease(reports, { commit });
  for (const p of problems) console.log(`unreadable report: ${p}`);
  for (const b of result.blockers) console.log(`blocked: ${b}`);
  console.log(result.ok && problems.length === 0 ? "isolation evidence complete for this commit" : "isolation evidence incomplete: the release is blocked");
  process.exit(result.ok && problems.length === 0 ? 0 : 1);
} else {
  console.error("usage: containment-evidence.mjs run --out DIR | gate --dir DIR --commit SHA");
  process.exit(2);
}
