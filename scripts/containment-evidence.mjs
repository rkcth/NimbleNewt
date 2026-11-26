// Card G05: produce and judge isolation-boundary evidence.
//   node scripts/containment-evidence.mjs run  --out DIR [--allow-unavailable]   run the suite here, write DIR/containment-<platform>.json
//        --allow-unavailable: exit 0 when this Windows host has no sandbox capacity at all (an honest skip; ignored on Linux and macOS, for a CI cell such as a GitHub-hosted Windows runner where the
//        native launcher is not installed). The report still records every case as not_run with the reason, and the gate still blocks on it. A run that had capacity is judged in full.
//        --windows-summary FILE [--workdir-check FILE]: SUPERSEDED (Windows Sandbox era; the release gate refuses that block since card A03b). Fill the report's `windows` block from the real Windows Sandbox tests' summary.json (windows-real.test.ts) and the
//        working-directory check (scripts/g05-workdir-check.mjs); what they cannot show stays false (packages/worker/src/sandbox/containment-windows-evidence.ts). Without it there is no block.
//        --native-info FILE [--account-kind standard|administrator-filtered] [--symlink-right yes|no]: Windows, native launcher only (card A03b). Fill the report's `nativeWindows` block for the
//        release gate from the launcher's `info` output FILE, the launcher NIMBLENEWT_WIN_LAUNCHER and its nn-launcher.record.json, this run's records under NIMBLENEWT_WIN_CONTROL_DIR\records, the
//        NimbleNewtRun-* profiles left under %LOCALAPPDATA%\Packages, and the two facts run-g05.ps1 measured (packages/worker/src/sandbox/containment-windows-native-evidence.ts). What is missing
//        is recorded as not measured, which the gate refuses. Without --native-info a native Windows report has no block (the gate blocks on it).
//        --redact [--local DIR]: the written report has account, machine and home names, SIDs and addresses replaced (windows-redact.ts), for a public artifact; with --local the
//        unredacted report is also written to DIR (keep that folder on the machine). A redacted report that no longer reads as a report is not written.
//   node scripts/containment-evidence.mjs gate --dir DIR --commit SHA   read every containment-*.json in DIR and list what blocks a release
//        --prebuilt: the owner bundle (card A03b, experiments/windows-appcontainer/owner/run-g05.ps1): no tsc and no git. The compiled code is the bundle's, built by CI; the commit is read from the file COMMIT at the
//        bundle's root (next to scripts/), which must hold exactly 40 lower-case hex digits (one trailing line break allowed), else exit 2 before anything runs. The report says dirty: false (the bundle's files are
//        checked against its SHA256SUMS by run-g05.ps1 before this starts).
// `run` builds the tree first (tsc --build; the compiled code is not tracked by git, so a stale build would otherwise be reported under HEAD's commit) and needs a committed checkout; the report names the commit and says if the tree was dirty.
// `gate` exits 1 while anything blocks, so a release step can call it. What it accepted without a pass (card A03b: a file-link case inconclusive for want of the symbolic-link right) is printed.
// A Windows report needs the native AppContainer block `nativeWindows`, which `run --native-info` fills (run-g05.ps1 passes it). Reports are read as data: size-bounded and shape-checked.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const [command, ...rest] = process.argv.slice(2);
const prebuilt = command === "run" && rest.includes("--prebuilt");
/** --prebuilt: the commit CI wrote into the bundle. Checked before the worker is loaded, so a bad file stops the run before any code of the bundle runs. */
let provenance;
if (prebuilt) {
  let text;
  try { text = readFileSync(join(root, "COMMIT"), "latin1"); } catch { text = undefined; }
  const commit = text === undefined ? undefined : text.replace(/\r?\n$/, "");
  if (commit === undefined || !/^[0-9a-f]{40}$/.test(commit)) { console.error("--prebuilt: the COMMIT file next to scripts/ is missing or does not hold exactly 40 lower-case hex digits; nothing was run"); process.exit(2); }
  provenance = { implementationCommit: commit, dirty: false };
}
if (command === "run" && !prebuilt) {
  try { execFileSync(process.execPath, [join(root, "node_modules", "typescript", "bin", "tsc"), "--build"], { cwd: root, stdio: "inherit" }); } catch { console.error("the build failed: no evidence is produced from code that does not compile"); process.exit(1); }
}
const worker = await import(pathToFileURL(join(root, "packages", "worker", "dist", "index.js")).href);

const flag = (name) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

if (command === "run") {
  const out = flag("out");
  const usage = "usage: run --out DIR [--prebuilt] [--allow-unavailable] [--windows-summary FILE [--workdir-check FILE]] [--native-info FILE [--account-kind standard|administrator-filtered] [--symlink-right yes|no]] [--redact [--local DIR]]";
  const valued = ["--out", "--windows-summary", "--workdir-check", "--local", "--native-info", "--account-kind", "--symlink-right"];
  for (let i = 0; i < rest.length; i++) {
    if (valued.includes(rest[i]) && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) { i++; continue; }
    if (rest[i] === "--allow-unavailable" || rest[i] === "--redact" || rest[i] === "--prebuilt") continue;
    console.error(usage); process.exit(2);
  }
  const accountKind = flag("account-kind");
  const symlinkRight = flag("symlink-right");
  if (out === undefined || (flag("workdir-check") !== undefined && flag("windows-summary") === undefined) || (flag("local") !== undefined && !rest.includes("--redact"))
    || (accountKind !== undefined && accountKind !== "standard" && accountKind !== "administrator-filtered") || (symlinkRight !== undefined && symlinkRight !== "yes" && symlinkRight !== "no")
    || ((accountKind !== undefined || symlinkRight !== undefined) && flag("native-info") === undefined) || (flag("native-info") !== undefined && flag("windows-summary") !== undefined)) { console.error(usage); process.exit(2); }
  // Windows: the account signed in at the console, only so redaction can hide its name too (card A03b: the native launcher runs as this signed-in account; nothing here is Windows Sandbox).
  const consoleUser = await worker.windowsConsoleUser();
  const since = new Date();
  let report = await worker.produceReport(root, {}, provenance);
  // Card A03b: the native launcher's host evidence for the release gate. Only a Windows report from the native launcher takes it.
  const nativeInfo = flag("native-info");
  if (nativeInfo !== undefined) {
    const env = process.env;
    if (report.platform !== "win32" || report.backend !== "windows-native") console.log(`  --native-info is for a Windows report from the native launcher; this one is ${report.platform} (${report.backend}): no nativeWindows block`);
    else if (!env["NIMBLENEWT_WIN_LAUNCHER"] || !env["NIMBLENEWT_WIN_CONTROL_DIR"] || !env["LOCALAPPDATA"]) console.log("  NIMBLENEWT_WIN_LAUNCHER, NIMBLENEWT_WIN_CONTROL_DIR and LOCALAPPDATA must be set: no nativeWindows block (the gate blocks on it)");
    else {
      const input = worker.collectNativeEvidence({
        infoFile: resolve(nativeInfo), launcher: env["NIMBLENEWT_WIN_LAUNCHER"], controlDir: env["NIMBLENEWT_WIN_CONTROL_DIR"], packagesDir: join(env["LOCALAPPDATA"], "Packages"), since,
        ...(accountKind === undefined ? {} : { accountKind }), ...(symlinkRight === undefined ? {} : { symlinkRight: symlinkRight === "yes" }),
      });
      const made = "error" in input ? input : worker.attachNativeWindowsEvidence(report, input);
      if ("error" in made) console.log(`  no nativeWindows block: ${made.error} (the gate blocks on it)`);
      else { report = made.report; for (const n of made.notProven) console.log(`  nativeWindows block: not proven: ${n}`); }
    }
  }
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
  // On Windows the account at the console (and a configured owner or share account) is often not the account this runs as, so it is not among the names redaction knows by
  // itself: look it up and hide it too. A failed lookup leaves the general rules (any `<machine>\account`, home folders, SIDs).
  const names = { users: [process.env["NIMBLENEWT_WSB_OWNER"], process.env["NIMBLENEWT_WSB_SHARE_IDENTITY"]].filter((n) => typeof n === "string" && n.length >= 2) };
  if (redact && consoleUser !== undefined) names.users.push(consoleUser);
  const shown = redact ? worker.redactReport(report, names) : report;
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
  for (const a of result.accepted) console.log(`accepted (not a pass): ${a}`);
  console.log(result.ok && problems.length === 0 ? "isolation evidence complete for this commit" : "isolation evidence incomplete: the release is blocked");
  process.exit(result.ok && problems.length === 0 ? 0 : 1);
} else {
  console.error("usage: containment-evidence.mjs run --out DIR [--prebuilt] [--allow-unavailable] | gate --dir DIR --commit SHA");
  process.exit(2);
}
