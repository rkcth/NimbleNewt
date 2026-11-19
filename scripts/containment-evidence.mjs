// Card G05: produce and judge isolation-boundary evidence.
//   node scripts/containment-evidence.mjs run  --out DIR [--allow-unavailable]   run the suite here, write DIR/containment-<platform>.json
//        --allow-unavailable: exit 0 when this Windows host has no sandbox capacity at all (an honest skip; ignored on Linux and macOS, for a CI cell such as a GitHub-hosted Windows runner that cannot run
//        Windows Sandbox). The report still records every case as not_run with the reason, and the gate still blocks on it. A run that had capacity is judged in full.
//        --windows-summary FILE [--workdir-check FILE]: Windows only. Fill the report's `windows` block from the real Windows Sandbox tests' summary.json (windows-real.test.ts) and the
//        working-directory check (scripts/g05-workdir-check.mjs); what they cannot show stays false (packages/worker/src/sandbox/containment-windows-evidence.ts). Without it there is no block.
//        --redact [--local DIR]: the written report has account, machine and home names, SIDs and addresses replaced (windows-redact.ts), for a public artifact; with --local the
//        unredacted report is also written to DIR (keep that folder on the machine). A redacted report that no longer reads as a report is not written.
//   node scripts/containment-evidence.mjs gate --dir DIR --commit SHA   read every containment-*.json in DIR and list what blocks a release
// `run` builds the tree first (tsc --build; the compiled code is not tracked by git, so a stale build would otherwise be reported under HEAD's commit) and needs a committed checkout; the report names the commit and says if the tree was dirty.
// `gate` exits 1 while anything blocks, so a release step can call it. Reports are read as data: size-bounded and shape-checked.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
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
  const usage = "usage: run --out DIR [--allow-unavailable] [--windows-summary FILE [--workdir-check FILE]] [--redact [--local DIR]]";
  const valued = ["--out", "--windows-summary", "--workdir-check", "--local"];
  for (let i = 0; i < rest.length; i++) {
    if (valued.includes(rest[i]) && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) { i++; continue; }
    if (rest[i] === "--allow-unavailable" || rest[i] === "--redact") continue;
    console.error(usage); process.exit(2);
  }
  if (out === undefined || (flag("workdir-check") !== undefined && flag("windows-summary") === undefined) || (flag("local") !== undefined && !rest.includes("--redact"))) { console.error(usage); process.exit(2); }
  let report = await worker.produceReport(root);
  const summaryFile = flag("windows-summary");
  if (summaryFile !== undefined) {
    const read = (f) => { try { return readFileSync(resolve(f), "utf8"); } catch { return undefined; } };
    const summaryRaw = read(summaryFile);
    const workdirRaw = flag("workdir-check") === undefined ? undefined : read(flag("workdir-check"));
    if (summaryRaw === undefined) console.log("  the Windows Sandbox summary could not be read: no windows block (the gate blocks on it)");
    else if (flag("workdir-check") !== undefined && workdirRaw === undefined) console.log("  the working-directory check output could not be read: no windows block (the gate blocks on it)");
    else {
      const made = worker.attachWindowsEvidence(report, { summaryRaw, ...(workdirRaw === undefined ? {} : { workdirRaw }), session: worker.sessionFromEnvironment(process.env) });
      if ("error" in made) console.log(`  no windows block: ${made.error}`);
      else { report = made.report; for (const n of made.notProven) console.log(`  windows block: not proven: ${n}`); }
    }
  }
  mkdirSync(resolve(out), { recursive: true });
  const file = join(resolve(out), `containment-${report.platform}.json`);
  const redact = rest.includes("--redact");
  // With --redact, what is printed is the redacted report too: a job log or summary is as public as the artifact.
  const shown = redact ? worker.redactReport(report) : report;
  if (redact) {
    const local = flag("local");
    if (local !== undefined) { mkdirSync(resolve(local), { recursive: true }); writeFileSync(join(resolve(local), `containment-${report.platform}.json`), `${JSON.stringify(report, null, 2)}\n`); }
    const redacted = `${JSON.stringify(shown, null, 2)}\n`;
    const check = worker.parseReport(redacted);
    if ("error" in check) { console.error(`the redacted report does not read as a report (${check.error}); nothing is written`); process.exit(1); }
    writeFileSync(file, redacted);
  } else writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
  const bad = shown.cases.filter((c) => c.verdict !== "pass");
  console.log(`${shown.platform} (${shown.backend}${shown.backendVersion ? ` ${shown.backendVersion}` : ""}) commit ${shown.implementationCommit.slice(0, 12)}${shown.dirty ? " DIRTY" : ""}: ${shown.cases.length - bad.length}/${shown.cases.length} cases hold -> ${redact ? basename(file) : file}`);
  const outcome = worker.runOutcome(report, { allowUnavailable: rest.includes("--allow-unavailable") });
  if (outcome.skipped) console.log(`  SKIPPED: no sandbox capacity on this host (${shown.capacityReason ?? "unavailable"}); every case is not_run and the release gate blocks on this platform`);
  else for (const c of bad) console.log(`  ${c.verdict} ${c.id}: ${c.detail}`);
  const exception = report.trustedHost !== undefined && report.trustedHost.refusedWithoutAuthority && report.trustedHost.reachesHostFiles;
  if (!exception && !outcome.skipped) console.log("  the trusted-host exception could not be shown");
  process.exit(outcome.exitCode);
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
  console.error("usage: containment-evidence.mjs run --out DIR [--allow-unavailable] | gate --dir DIR --commit SHA");
  process.exit(2);
}
