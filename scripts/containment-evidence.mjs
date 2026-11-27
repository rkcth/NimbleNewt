// Card G05: produce and judge isolation-boundary evidence.
//   node scripts/containment-evidence.mjs run  --out DIR [--allow-unavailable]   run the suite here, write DIR/containment-<platform>.json
//        --allow-unavailable: exit 0 when this Windows host has no sandbox capacity at all (an honest skip; ignored on Linux and macOS, for a CI cell such as a GitHub-hosted Windows runner where the
//        native launcher is not installed). The report still records every case as not_run with the reason, and the gate still blocks on it. A run that had capacity is judged in full.
//        --native-info FILE [--account-kind standard|administrator-filtered] [--symlink-right yes|no]: Windows, native launcher only (card A03b). Fill the report's `nativeWindows` block for the
//        release gate from the launcher's `info` output FILE, the launcher NIMBLENEWT_WIN_LAUNCHER and its nn-launcher.record.json, this run's records under NIMBLENEWT_WIN_CONTROL_DIR\records, the
//        NimbleNewtRun-* profiles left under %LOCALAPPDATA%\Packages, and the two facts run-g05.ps1 measured (packages/worker/src/sandbox/containment-windows-native-evidence.ts). What is missing
//        is recorded as not measured, which the gate refuses. Without --native-info a native Windows report has no block (the gate blocks on it).
//        --after-sign-out FILE (with --native-info): the sign-out / restart check `after-sign-in` wrote; it becomes nativeWindows.afterSignOut, judged by the gate. Unreadable or malformed: no block.
//        --redact [--local DIR]: the written report has account, machine and home names, SIDs and addresses replaced (windows-redact.ts), for a public artifact; with --local the
//        unredacted report is also written to DIR (keep that folder on the machine). A redacted report that no longer reads as a report is not written.
//   node scripts/containment-evidence.mjs gate --dir DIR --commit SHA   read every containment-*.json in DIR and list what blocks a release
//        --prebuilt: the owner bundle (card A03b, experiments/windows-appcontainer/owner/run-g05.ps1): no tsc and no git. The compiled code is the bundle's, built by CI; the commit is read from the file COMMIT at the
//        bundle's root (next to scripts/), which must hold exactly 40 lower-case hex digits (one trailing line break allowed), else exit 2 before anything runs. The report says dirty: false (the bundle's files are
//        checked against its SHA256SUMS by run-g05.ps1 before this starts).
//   node scripts/containment-evidence.mjs hold [--minutes N] [--log FILE]   Windows, native launcher (card A03b, run-g05.ps1 -Hold): start ONE confined idle task through the backend's own runner, detached, with the
//        launcher's time limit at N minutes (default and most 30), wait until the program itself runs in the container, record <control>\hold\state.json and return. Exit 0 held, 1 started with a
//        problem (the state is still written), 2 refused (nothing started). --log FILE: the lines go to FILE, not to standard output (run-g05.ps1 starts this with no pipe: the detached runner
//        could inherit one and keep it open for the whole hold).
//   node scripts/containment-evidence.mjs after-sign-in --new-logon yes|no|unknown   (run-g05.ps1 -AfterSignIn, after the owner signed out and in, or restarted): read the state, check that nothing
//        of the held run still runs, run the backend's leftover sweep, read back the held grants, count leftover profiles and read the held run's record; write <control>\hold\after-sign-out.json.
//        Exit 0 written, 3 the held task still runs (written, nothing swept), 2 no or unreadable state.
// `run` builds the tree first (tsc --build; the compiled code is not tracked by git, so a stale build would otherwise be reported under HEAD's commit) and needs a committed checkout; the report names the commit and says if the tree was dirty.
// `gate` exits 1 while anything blocks, so a release step can call it. What it accepted without a pass (card A03b: a file-link case inconclusive for want of the symbolic-link right) is printed.
// A Windows report needs the native AppContainer block `nativeWindows`, which `run --native-info` fills (run-g05.ps1 passes it). Reports are read as data: size-bounded and shape-checked.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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
  const usage = "usage: run --out DIR [--prebuilt] [--allow-unavailable] [--native-info FILE [--account-kind standard|administrator-filtered] [--symlink-right yes|no] [--after-sign-out FILE]] [--redact [--local DIR]]";
  const valued = ["--out", "--local", "--native-info", "--account-kind", "--symlink-right", "--after-sign-out"];
  for (let i = 0; i < rest.length; i++) {
    if (valued.includes(rest[i]) && rest[i + 1] !== undefined && !rest[i + 1].startsWith("--")) { i++; continue; }
    if (rest[i] === "--allow-unavailable" || rest[i] === "--redact" || rest[i] === "--prebuilt") continue;
    console.error(usage); process.exit(2);
  }
  const accountKind = flag("account-kind");
  const symlinkRight = flag("symlink-right");
  if (out === undefined || (flag("local") !== undefined && !rest.includes("--redact"))
    || (accountKind !== undefined && accountKind !== "standard" && accountKind !== "administrator-filtered") || (symlinkRight !== undefined && symlinkRight !== "yes" && symlinkRight !== "no")
    || ((accountKind !== undefined || symlinkRight !== undefined || flag("after-sign-out") !== undefined) && flag("native-info") === undefined)) { console.error(usage); process.exit(2); }
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
        ...(flag("after-sign-out") === undefined ? {} : { afterSignOutFile: resolve(flag("after-sign-out")) }),
      });
      const made = "error" in input ? input : worker.attachNativeWindowsEvidence(report, input);
      if ("error" in made) console.log(`  no nativeWindows block: ${made.error} (the gate blocks on it)`);
      else {
        report = made.report;
        for (const n of made.notProven) console.log(`  nativeWindows block: not proven: ${n}`);
        if (report.nativeWindows.afterSignOut !== undefined) {
          const p = worker.afterSignOutProblems(report.nativeWindows.afterSignOut);
          console.log(p.length === 0 ? "  nativeWindows block: the sign-out check holds" : `  nativeWindows block: the sign-out check does NOT hold: ${p.join("; ")}`);
        }
      }
    }
  }
  mkdirSync(resolve(out), { recursive: true });
  const file = join(resolve(out), `containment-${report.platform}.json`);
  const redact = rest.includes("--redact");
  // With --redact, what is printed is the redacted report too: a job log or summary is as public as the artifact.
  // On Windows the account at the console may not be the account this runs as, so it is not among the names redaction knows by itself: look it up and hide it too.
  // A failed lookup leaves the general rules (any `<machine>\account`, home folders, SIDs).
  const names = { users: [] };
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
} else if (command === "hold" || command === "after-sign-in") {
  // Card A03b, the sign-out / restart check (windows-native-signout.ts). Windows and the native launcher only; the two settings run-g05.ps1 sets name the launcher and the control folder.
  const env = process.env;
  const usage = command === "hold" ? "usage: hold [--minutes N] [--log FILE]" : "usage: after-sign-in --new-logon yes|no|unknown";
  const allowed = command === "hold" ? ["--minutes", "--log"] : ["--new-logon"];
  for (let i = 0; i < rest.length; i += 2) if (!allowed.includes(rest[i]) || rest[i + 1] === undefined || rest[i + 1].startsWith("--")) { console.error(usage); process.exit(2); }
  if (process.platform !== "win32") { console.error(`${command}: Windows only (the native launcher); nothing was run`); process.exit(2); }
  const launcher = env["NIMBLENEWT_WIN_LAUNCHER"], controlDir = env["NIMBLENEWT_WIN_CONTROL_DIR"];
  if (!launcher || !controlDir || !env["LOCALAPPDATA"]) { console.error(`${command}: NIMBLENEWT_WIN_LAUNCHER, NIMBLENEWT_WIN_CONTROL_DIR and LOCALAPPDATA must be set; nothing was run`); process.exit(2); }
  const host = worker.nativeRealHost();
  if (command === "hold") {
    // With --log the lines are written to that file at the end (node opens it itself, so the detached runner never inherits it); otherwise printed.
    const lines = [];
    const log = flag("log");
    const say = (line) => { if (log === undefined) console.log(line); else lines.push(line); };
    const end = (code) => { if (log !== undefined) { try { writeFileSync(resolve(log), `${lines.join("\n")}\n`); } catch { /* the exit code still tells */ } } process.exit(code); };
    const raw = flag("minutes");
    const minutes = raw === undefined ? undefined : /^[0-9]{1,2}$/.test(raw) ? Number(raw) : Number.NaN;
    if (minutes !== undefined && !(minutes >= 1 && minutes <= worker.MAX_HOLD_MINUTES)) { say(`${usage} (N from 1 to ${worker.MAX_HOLD_MINUTES})`); end(2); }
    // The task's folders: a new folder under TEMP by its long name (the Windows path rules refuse a short 8.3 name in a granted path).
    let root;
    try { root = realpathSync.native(mkdtempSync(join(tmpdir(), "nn-g05hold-"))); } catch (error) { say(`hold: REFUSED: the task's folder under TEMP could not be made (${error.message}); nothing was started`); end(2); }
    const result = await worker.startHold({
      host, launcher, controlDir, nodeExecutable: process.execPath, root, ...(minutes === undefined ? {} : { minutes }),
      // DETACHED: the runner must outlive this process and the PowerShell window; it is the backend's own runner, with the plan's environment only (as SandboxLauncher starts it).
      spawnRunner: (plan) => { const child = spawn(plan.file, [...plan.args], { env: { ...plan.env }, ...(plan.cwd === undefined ? {} : { cwd: plan.cwd }), stdio: "ignore", detached: true, windowsHide: true }); child.on("error", () => undefined); child.unref(); return child.pid; },
    });
    if ("error" in result) {
      // Nothing was started in these folders (no grant was ever made on them): they go again. A runner that did start keeps them; -AfterSignIn removes them after its sweep.
      if (!result.started) { try { rmSync(root, { recursive: true, force: true }); } catch { /* an empty folder under TEMP */ } }
      say(`hold: REFUSED: ${result.error}${result.started ? " (the runner had started: the launcher still ends the task by its time limit; run -AfterSignIn later to sweep)" : ""}`);
      end(2);
    }
    const s = result.state;
    say(`hold: run ${s.runId}, container profile ${s.profileName}, ${s.grants.length} granted path(s), ${s.processes.length} process(es) recorded`);
    say(`hold: the confined program is running: ${s.childSeen ? "yes" : "NO"}; the launcher ends it by itself at ${s.until} (after ${s.minutes} minutes) at the latest`);
    for (const p of result.problems) say(`hold: problem: ${p}`);
    end(s.childSeen && result.problems.length === 0 ? 0 : 1);
  }
  const nl = flag("new-logon");
  if (nl !== "yes" && nl !== "no" && nl !== "unknown") { console.error(usage); process.exit(2); }
  const result = await worker.afterSignIn({ host, launcher, controlDir, packagesDir: join(env["LOCALAPPDATA"], "Packages"), newLogon: nl === "unknown" ? null : nl === "yes" });
  if ("error" in result) { console.log(`after-sign-in: REFUSED: ${result.error}`); process.exit(2); }
  for (const [k, v] of Object.entries(result.afterSignOut)) console.log(`after-sign-in: ${k}=${v}`);
  console.log(`after-sign-in: the held run's record says: ${result.outcome}`);
  for (const n of result.notes) console.log(`after-sign-in: note: ${n}`);
  const problems = worker.afterSignOutProblems(result.afterSignOut);
  console.log(problems.length === 0 ? "after-sign-in: the sign-out check holds" : `after-sign-in: the sign-out check does NOT hold: ${problems.join("; ")}`);
  process.exit(result.running ? 3 : 0);
} else {
  console.error("usage: containment-evidence.mjs run --out DIR [--prebuilt] [--allow-unavailable] | gate --dir DIR --commit SHA | hold [--minutes N] | after-sign-in --new-logon yes|no|unknown");
  process.exit(2);
}
