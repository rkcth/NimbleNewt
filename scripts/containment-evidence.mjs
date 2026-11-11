// Card G05: produce and judge isolation-boundary evidence.
//   node scripts/containment-evidence.mjs run  --out DIR            run the suite here, write DIR/containment-<platform>.json
//   node scripts/containment-evidence.mjs gate --dir DIR --commit SHA   read every containment-*.json in DIR and list what blocks a release
// `run` builds the tree first (tsc --build; the compiled code is not tracked by git, so a stale build would otherwise be reported under HEAD's commit) and needs a committed checkout; the report names the commit and says if the tree was dirty.
// `gate` exits 1 while anything blocks, so a release step can call it. Reports are read as data: size-bounded and shape-checked.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [command, ...rest] = process.argv.slice(2);
if (command === "run") {
  try { execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--build"], { cwd: root, stdio: "inherit" }); } catch { console.error("the build failed: no evidence is produced from code that does not compile"); process.exit(1); }
}
const worker = await import(pathToFileURL(join(root, "packages", "worker", "dist", "index.js")).href);

const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

if (command === "run") {
  const out = flag("out");
  if (out === undefined) { console.error("usage: run --out DIR"); process.exit(2); }
  const report = await worker.produceReport(root);
  mkdirSync(resolve(out), { recursive: true });
  const file = join(resolve(out), `containment-${report.platform}.json`);
  writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const bad = report.cases.filter((c) => c.verdict !== "pass");
  console.log(`${report.platform} (${report.backend}${report.backendVersion ? ` ${report.backendVersion}` : ""}) commit ${report.implementationCommit.slice(0, 12)}${report.dirty ? " DIRTY" : ""}: ${report.cases.length - bad.length}/${report.cases.length} cases hold -> ${file}`);
  for (const c of bad) console.log(`  ${c.verdict} ${c.id}: ${c.detail}`);
  const exception = report.trustedHost !== undefined && report.trustedHost.refusedWithoutAuthority && report.trustedHost.reachesHostFiles;
  if (!exception) console.log("  the trusted-host exception could not be shown");
  process.exit(bad.length === 0 && report.capacityAvailable && exception ? 0 : 1);
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
