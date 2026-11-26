// Cards G05, G06, Y02: the workflow steps that produce hardware-chain evidence keep the properties the evidence relies on. Text checks (the repository has no YAML parser and no
// actionlint); the files are also parsed with PyYAML when the change is made.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (name) => readFileSync(join(root, ".github", "workflows", name), "utf8");
/** The text of one job: from `  <name>:` to the next job at the same indentation. */
function job(text, name) {
  const start = text.indexOf(`\n  ${name}:\n`);
  assert.ok(start >= 0, `job ${name} exists`);
  const rest = text.slice(start + 1);
  const next = rest.slice(3).search(/\n {2}[a-z0-9-]+:\n/);
  return next < 0 ? rest : rest.slice(0, next + 3);
}
/** The text of the step with `id: <id>`, from its `- name:` line to the next step. */
function step(jobText, id) {
  const at = jobText.indexOf(`\n        id: ${id}\n`);
  assert.ok(at >= 0, `step ${id} exists`);
  const begin = jobText.lastIndexOf("\n      - ", at);
  const end = jobText.indexOf("\n      - ", at + 1);
  return jobText.slice(begin, end < 0 ? undefined : end);
}

test("own-hardware: the Windows evidence job runs only by hand from main, every evidence step continues on error, and the outcome step fails the job if any failed", () => {
  const text = read("own-hardware.yml");
  // started by hand only: no push or pull request trigger; the one input (card A03b, the G05 owner bundle) is a boolean that defaults to off
  const on = text.slice(text.indexOf("\non:\n") + 5, text.indexOf("\npermissions:"));
  assert.match(on, /^ {2}workflow_dispatch:\n {4}inputs:\n {6}g05_owner_bundle:\n {8}description: "[^"\n]+"\n {8}type: boolean\n {8}default: false\n$/, "started by hand only, with one boolean input that defaults to false");
  assert.doesNotMatch(text, /^ {2}(push|pull_request|pull_request_target):/m);
  const j = job(text, "sandbox-windows");
  assert.match(j, /if: github\.repository == 'rkcth\/NimbleNewt' && github\.ref == 'refs\/heads\/main'/);
  assert.match(j, /runs-on: \[self-hosted, nimblenewt-windows\]/);
  const ids = ["fs", "wsb", "wd", "g05", "g06", "y02", "cleanup"];
  for (const id of ids) assert.match(step(j, id), /\n {8}continue-on-error: true\n/, id);
  // Every evidence step has its own timeout, so a stuck one ends as a failure and the cleanup, outcome and upload steps still run inside the job's limit.
  for (const id of ids) assert.match(step(j, id), /\n {8}timeout-minutes: \d+\n/, id);
  // ... and the job's own limit is above their sum with room for set-up and uploads (30 minutes), so a job timeout cannot cut off the cleanup or the outcome step.
  const stepSum = ids.reduce((sum, id) => sum + Number(/\n {8}timeout-minutes: (\d+)\n/.exec(step(j, id))[1]), 0);
  assert.ok(Number(/\n {4}timeout-minutes: (\d+)\n/.exec(j)[1]) >= stepSum + 30, `job limit below ${stepSum + 30}`);
  // The leftovers of a step stopped by its timeout are released whatever happened before.
  assert.match(step(j, "cleanup"), /\n {8}if: always\(\)\n/);
  assert.match(step(j, "cleanup"), /node scripts\/wsb-cleanup\.mjs --local "\$RUNNER_TEMP\/g05-local"/);
  assert.ok(j.indexOf("id: cleanup") > j.indexOf("id: y02") && j.indexOf("id: cleanup") < j.indexOf("Job summary and outcome"));
  const outcome = j.slice(j.indexOf("- name: Job summary and outcome"));
  assert.match(outcome, /if: always\(\)/);
  for (const id of ids) assert.match(outcome, new RegExp(`\\$\\{\\{ steps\\.${id}\\.outcome \\}\\}`), id);
  assert.match(outcome, /if \[ "\$o" != "success" \]; then .*exit 1; fi/);
  // The Git Bash fix stays the first thing after the checkout (run 44453704944).
  assert.ok(j.indexOf("Use Git Bash for bash steps") < j.indexOf("id: fs"));
});

test("own-hardware: the probe job (one run of the whole suite on each own machine) has room for the slower Windows runner; the evidence job keeps its own limit", () => {
  const text = read("own-hardware.yml");
  const probe = job(text, "probe");
  // A Windows run takes about twice the Mac's 21 minutes and one was cancelled at 60 (CI, 2026-11-19).
  assert.equal(Number(/\n {4}timeout-minutes: (\d+)\n/.exec(probe)?.[1]), 150);
  assert.match(probe, /label: \[nimblenewt-mac, nimblenewt-windows\]/);
  assert.equal(Number(/\n {4}timeout-minutes: (\d+)\n/.exec(job(text, "sandbox-windows"))?.[1]), 480);
});

test("own-hardware: the outcome step, run as bash runs it on the runner, passes only when every evidence step succeeded", { skip: process.platform === "win32" ? "runs the step with a POSIX bash" : false }, () => {
  const j = job(read("own-hardware.yml"), "sandbox-windows");
  const from = j.indexOf("- name: Job summary and outcome");
  const block = j.slice(from, j.indexOf("\n      - ", from + 1));
  const lines = block.slice(block.indexOf("        run: |\n") + "        run: |\n".length).split("\n");
  const script = lines.filter((l) => l.startsWith("          ") || l.trim() === "").map((l) => l.slice(10)).join("\n");
  assert.doesNotMatch(script, /\$\{\{/, "the script reads the outcomes from its environment only");
  const dir = mkdtempSync(join(tmpdir(), "nn-evidence-wf-"));
  try {
    const run = (outcomes, logs = {}) => {
      const summary = join(dir, "summary.md");
      writeFileSync(summary, "");
      for (const [f, text] of Object.entries(logs)) { const p = join(dir, f); spawnSync("mkdir", ["-p", dirname(p)]); writeFileSync(p, text); }
      // The runner's own options for `shell: bash`.
      // From the checkout's root, as the runner runs it (the script calls scripts/redact-log.mjs; needs the build).
      const r = spawnSync("bash", ["--noprofile", "--norc", "-eo", "pipefail", "-c", script], { cwd: root, encoding: "utf8", env: { PATH: process.env.PATH, RUNNER_TEMP: dir, GITHUB_STEP_SUMMARY: summary, COMPUTERNAME: "MYPC", ...outcomes } });
      return { status: r.status, summary: readFileSync(summary, "utf8") };
    };
    const ids = ["FS", "WSB", "WD", "G05", "G06", "Y02", "CLEAN"];
    const all = Object.fromEntries(ids.map((k) => [k, "success"]));
    const ok = run(all, { "y02-wsb-local/y02.log": "sandbox-escape-refused: pass (50/50)\n" });
    assert.equal(ok.status, 0, ok.summary);
    assert.match(ok.summary, /\| Y02 scenarios \| success \|/);
    for (const k of ids) for (const bad of ["failure", "skipped", "cancelled", ""]) assert.equal(run({ ...all, [k]: bad }).status, 1, `${k}=${bad}`);
    // A Y02 log without any scenario line (the run stopped early) still reaches the outcome check, and the table is written.
    const early = run({ ...all, Y02: "failure" }, { "y02-wsb-local/y02.log": "the build failed\n" });
    assert.equal(early.status, 1);
    assert.match(early.summary, /\| Y02 scenarios \| failure \|/);
    // Home folders in the copied log lines are replaced.
    const home = run(all, { "y02-wsb-local/y02.log": "sandbox-escape-refused: pass (50/50)\n", "g05-local/g05.log": "wrote C:\\Users\\someone\\x\n", "g05-local/cleanup.log": "the console session belongs to MYPC\\ownername, not the configured owner\n" });
    assert.doesNotMatch(home.summary, /someone/);
    assert.doesNotMatch(home.summary, /ownername/);
    assert.match(home.summary, /<home>/);
    assert.match(home.summary, /\| Leftovers of the Sandbox runs released \| success \|/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("own-hardware: only redacted or data-only evidence is uploaded; the unredacted report and local findings stay on the machine; auto-login is never switched on", () => {
  const j = job(read("own-hardware.yml"), "sandbox-windows");
  const g05 = step(j, "g05");
  assert.match(g05, /containment-evidence\.mjs run --out "\$RUNNER_TEMP\/g05-windows" "\$\{EXTRA\[@\]\}" --redact --local "\$RUNNER_TEMP\/g05-local"/);
  assert.match(g05, /NIMBLENEWT_WSB_SUPERVISOR_ACL: report-only/);
  const uploads = [...j.matchAll(/\n {10}path: (.+)\n/g)].map((m) => m[1]);
  assert.deepEqual([...uploads].sort(), [
    "${{ runner.temp }}/g05-windows/containment-*.json", "${{ runner.temp }}/g06-host", "${{ runner.temp }}/sandbox-windows", "${{ runner.temp }}/sandbox-windows-detail", "${{ runner.temp }}/y02-windows/y02-scenarios-*.json",
  ]);
  for (const u of uploads) assert.doesNotMatch(u, /local/, u);
  assert.doesNotMatch(j, /NIMBLENEWT_REAL_WINDOWS_AUTOLOGON/);
  const y02 = step(j, "y02");
  assert.match(y02, /NIMBLENEWT_REAL_WINDOWS_SANDBOX: "1"/);
  assert.match(y02, /y02-checkpoint\.mjs run --out "\$RUNNER_TEMP\/y02-windows"/);
  // The Sandbox tests run inside the scenario set write to their own folders, never over the uploaded summary.
  assert.doesNotMatch(y02, /NIMBLENEWT_WSB_OUT: \$\{\{ runner\.temp \}\}\/sandbox-windows\n/);
  // The filesystem facts keep only words, not fsutil's text (which can name the checkout path).
  const fs = step(j, "fs");
  assert.match(fs, /function State/);
  assert.doesNotMatch(fs, /VolumeLabel|FileSystemLabel|SerialNumber|USERNAME/);
  assert.match(step(j, "g06"), /packages\/worker\/dist\/workspace\/long-paths\.test\.js/);
  // The job log is public: every step that prints a command's output passes it through the redaction filter (the full text goes to a local file only).
  for (const id of ["wd", "g05", "g06", "y02", "cleanup"]) {
    const run = step(j, id).slice(step(j, id).indexOf("run: |"));
    const printing = run.split("\n").filter((l) => /^\s+node /.test(l));
    assert.ok(printing.length > 0, id);
    for (const l of printing) assert.match(l, /2>&1 \| tee "[^"]+" \| node scripts\/redact-log\.mjs$/, `${id}: ${l}`);
  }
  // The Sandbox tests' own output stays in the local folder.
  assert.match(step(j, "wsb"), /> "\$NIMBLENEWT_WSB_LOCAL\/output\.txt" 2>&1/);
});

test("exhaustive: the Y02 scenario set runs on hosted Linux and macOS with the sandbox and uploads its report", () => {
  const j = job(read("exhaustive.yml"), "y02-scenarios");
  assert.match(j, /os: \[ubuntu-latest, macos-latest\]/);
  assert.match(j, /node scripts\/y02-checkpoint\.mjs run --out "\$RUNNER_TEMP\/y02"/);
  assert.match(j, /apt-get install -y -qq bubblewrap/);
  assert.match(j, /name: y02-scenarios-\$\{\{ runner\.os \}\}/);
  assert.match(j, /persist-credentials: false/);
});

test("every action in the evidence workflows is pinned to a full commit", () => {
  for (const name of ["own-hardware.yml", "exhaustive.yml", "qa.yml"]) {
    for (const m of read(name).matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, `${name}: ${m[1]}`);
  }
});

test("redact-log: account, home and console names are replaced line by line; without the redaction code nothing of the input is shown", { skip: process.platform === "win32" ? "POSIX paths in the check" : false }, () => {
  const input = ["plain line", "C:\\Users\\Jane Doe\\AppData\\Local\\Temp\\nn-g06-x failed", "the console session belongs to MYPC\\janed, not the configured owner", "owner PC\\cfgowner set"].join("\n");
  const r = spawnSync(process.execPath, [join(root, "scripts", "redact-log.mjs")], { input, encoding: "utf8", env: { ...process.env, COMPUTERNAME: "MYPC", NIMBLENEWT_WSB_OWNER: "PC\\cfgowner" } });
  assert.equal(r.status, 0, r.stderr);
  const lines = r.stdout.split("\n");
  assert.equal(lines[0], "plain line");
  assert.doesNotMatch(r.stdout, /Jane|janed|cfgowner|MYPC/);
  assert.match(lines[1], /<home>/);
  assert.equal(lines.length, 5);
  // A copy of the script without the built code next to it: it withholds everything and says so.
  const dir = mkdtempSync(join(tmpdir(), "nn-redact-log-"));
  try {
    spawnSync("mkdir", ["-p", join(dir, "scripts")]);
    writeFileSync(join(dir, "scripts", "redact-log.mjs"), readFileSync(join(root, "scripts", "redact-log.mjs")));
    const off = spawnSync(process.execPath, [join(dir, "scripts", "redact-log.mjs")], { input, encoding: "utf8" });
    assert.equal(off.status, 0);
    assert.equal(off.stdout, "<4 lines withheld: the redaction code could not be loaded>\n");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("wsb-cleanup: bad usage exits 2; off Windows it does nothing and exits 0", () => {
  const usage = spawnSync(process.execPath, [join(root, "scripts", "wsb-cleanup.mjs"), "--bogus"], { encoding: "utf8" });
  assert.equal(usage.status, 2);
  if (process.platform !== "win32") {
    const r = spawnSync(process.execPath, [join(root, "scripts", "wsb-cleanup.mjs")], { encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stdout, /not Windows/);
  }
});

test("own-hardware: the job-context diagnostic (card wsb-console) runs once before the first wsb call, never fails the job, and fits in the job's limit", () => {
  const text = read("own-hardware.yml");
  const j = job(text, "sandbox-windows");
  const s = step(j, "wsbctx");
  assert.match(s, /\n {8}continue-on-error: true\n/);
  // 15 minutes: the context script stops itself at 240 s, the launch variants (card wsb-variants, two task variants since wsb-limited) at 460 s, and a minute for starting node.
  assert.match(s, /\n {8}timeout-minutes: 15\n/);
  assert.ok(240 + 460 + 60 <= 15 * 60);
  assert.match(j, /run level Limited \(the verdict-bearing one\) and the same task at Highest for comparison/);
  assert.match(s, /node scripts\/wsb-job-context\.mjs 2>&1 \| node scripts\/redact-log\.mjs > "\$RUNNER_TEMP\/wsb-job-context\.txt"\n {10}node scripts\/wsb-launch-variants\.mjs 2>&1 \| node scripts\/redact-log\.mjs >> "\$RUNNER_TEMP\/wsb-job-context\.txt"\n/);
  // Only the redacted copy is printed or added to the summary (the variants are appended to the same file, after the context lines).
  assert.doesNotMatch(s.replace(/node scripts\/wsb-job-context\.mjs 2>&1 \| node scripts\/redact-log\.mjs/, "").replace(/node scripts\/wsb-launch-variants\.mjs 2>&1 \| node scripts\/redact-log\.mjs/, ""), /wsb-job-context\.mjs|wsb-launch-variants\.mjs/);
  assert.match(s, /cat "\$RUNNER_TEMP\/wsb-job-context\.txt"; echo '```'; \} >> "\$GITHUB_STEP_SUMMARY"/);
  // After the build, before every step that runs wsb (the Sandbox tests are the first).
  assert.ok(j.indexOf("id: wsbctx") > j.indexOf("npm run build") && j.indexOf("id: wsbctx") < j.indexOf("id: wsb\n"));
  // A record, not evidence: the outcome step does not read it.
  assert.doesNotMatch(j.slice(j.indexOf("- name: Job summary and outcome")), /steps\.wsbctx\./);
  const ids = ["wsbctx", "wsblist", "fs", "wsb", "wd", "g05", "g06", "y02", "cleanup"];
  const stepSum = ids.reduce((sum, id) => sum + Number(/\n {8}timeout-minutes: (\d+)\n/.exec(step(j, id))[1]), 0);
  assert.ok(Number(/\n {4}timeout-minutes: (\d+)\n/.exec(j)[1]) >= stepSum + 30, `job limit below ${stepSum + 30}`);
  // No other job runs it.
  assert.equal(text.split("wsb-job-context.mjs").length - 1, 1);
  assert.equal(text.split("node scripts/wsb-launch-variants.mjs").length - 1, 1);
});

test("own-hardware: the product launcher's one-line wsb list record (card wsb-repair) is a diagnostic: after the context step, before the tests, always exit 0, redacted, not read by the outcome step", () => {
  const j = job(read("own-hardware.yml"), "sandbox-windows");
  const s = step(j, "wsblist");
  assert.match(s, /\n {8}continue-on-error: true\n/);
  assert.match(s, /node scripts\/wsb-list-line\.mjs 2>&1 \| node scripts\/redact-log\.mjs \| tee "\$RUNNER_TEMP\/wsb-list-line\.txt"/);
  assert.ok(j.indexOf("id: wsbctx") < j.indexOf("id: wsblist") && j.indexOf("id: wsblist") < j.indexOf("id: wsb\n"));
  assert.doesNotMatch(j.slice(j.indexOf("- name: Job summary and outcome")), /steps\.wsblist\./);
  assert.equal(read("own-hardware.yml").split("node scripts/wsb-list-line.mjs").length - 1, 1);
});

test("own-hardware (card A03b): the G05 owner bundle runs only when its input is ticked, only from main, alone, built on a hosted runner and checked by hash before anything of it runs on the owner's PC", () => {
  const text = read("own-hardware.yml");
  const guard = "github.repository == 'rkcth/NimbleNewt' && github.ref == 'refs/heads/main'";
  // the usual jobs keep their guards and are skipped when the owner bundle run is asked for
  for (const name of ["probe", "sandbox-windows"]) assert.ok(job(text, name).includes(`    if: ${guard} && inputs.g05_owner_bundle != true\n`), name);
  const build = job(text, "g05-bundle-build");
  const run = job(text, "g05-owner-run");
  assert.ok(build.includes(`    if: \${{ inputs.g05_owner_bundle == true && ${guard} }}\n`), "the hosted build: the input and the same guards");
  assert.match(build, /\n {4}runs-on: windows-latest\n/);
  assert.ok(run.includes(`    if: \${{ !cancelled() && inputs.g05_owner_bundle == true && ${guard} && needs.g05-bundle-build.outputs.sums_sha256 != '' }}\n`), "the owner's runner: the input, the same guards and a bundle hash");
  assert.match(run, /\n {4}needs: g05-bundle-build\n {4}if: [^\n]+\n {4}runs-on: \[self-hosted, nimblenewt-windows\]\n {4}timeout-minutes: 45\n/);
  // the build: the product launcher with the pinned toolchain and --locked, its record, the official node hash, the bundle script, the hash of SHA256SUMS as the job output
  for (const piece of ["rustup toolchain install 1.99.1 --profile minimal", "cargo build --release --locked", "native-launcher.mjs record --file", "native-launcher.mjs verify --file", 'node-version: "22.19.0"', 'NODE_EXE_SHA256: "995a3fb3cefad590cd3f4b321532a4b9582fb9c6575320ed2e3e894caac3e362"', 'test "$(node -p process.version)" = "v22.19.0"', 'node scripts/g05-owner-bundle.mjs make --out "$b"', '--commit "$GITHUB_SHA"', 'echo "sums_sha256=$sums" >> "$GITHUB_OUTPUT"', "sums_sha256: ${{ steps.bundle.outputs.sums_sha256 }}", "ParseFile($f, [ref]$tokens, [ref]$errors)"]) assert.ok(build.includes(piece), piece);
  // the owner's runner: no checkout (only the bundle runs there), the hash check before anything is copied or run, run-g05.ps1 without elevation, the output redacted before the log
  assert.ok(!run.includes("actions/checkout@") && !/npm (ci|run)/.test(run), "no checkout and no build on the owner's PC");
  const code = run.replace(/^\s*#.*$/gm, "");
  const check = code.indexOf("if ($got -cne $env:EXPECT_SUMS)");
  assert.ok(code.includes("EXPECT_SUMS: ${{ needs.g05-bundle-build.outputs.sums_sha256 }}") && code.includes("if ($env:EXPECT_SUMS -cnotmatch '^[0-9a-f]{64}$')") && check > 0);
  for (const later of ["Copy-Item -Path (Join-Path $src '*')", "Invoke-Piped $ps", "(Join-Path $b 'run-g05.ps1')"]) assert.ok(code.indexOf(later) > check, `${later} only after the hash check`);
  assert.ok(code.includes("('-NoProfile -ExecutionPolicy Bypass -File \"' + (Join-Path $b 'run-g05.ps1') + '\"')"));
  assert.ok(code.includes("scripts\\redact-log.mjs") && code.indexOf("Write-Output $red.Text") > code.indexOf("$red = Invoke-Piped") && !/Write-Output \$run\.Text/.test(code), "only the redacted text reaches the log");
  assert.ok(code.includes("$b = Join-Path $env:LOCALAPPDATA 'nn-g05-own-runner'") && code.includes("if ($e.Name -eq 'control') { continue }"), "the control folder of an earlier run is kept for the sweep");
  // every file SHA256SUMS names is checked HERE, in the download (exactly: nothing else, no control or results folder, no link) before anything is copied, and in the copy before anything runs:
  // run-g05.ps1's own check cannot vouch for run-g05.ps1, and node.exe and redact-log.mjs of the bundle run after it whatever it found
  const fn = code.slice(code.indexOf("function Test-Sums"), code.indexOf("$bad = Test-Sums $src $true"));
  for (const piece of ["(Get-Sha256Hex $f) -cne $hash", "ReparsePoint", "$rel -match '^(control|results)(/|$)'", "'..'", "$listed.ContainsKey($rel.ToLowerInvariant())", "extra $rel", "link $rel", "no file listed"]) assert.ok(fn.includes(piece), piece);
  const exact = code.indexOf("$bad = Test-Sums $src $true"), copied = code.indexOf("$bad = Test-Sums $b $false");
  assert.ok(exact > check && code.indexOf("Copy-Item -Path (Join-Path $src '*')") > exact && copied > code.indexOf("Copy-Item -Path (Join-Path $src '*')"));
  assert.ok(/\$bad = Test-Sums \$src \$true\n\s+if \(\$bad\.Count -gt 0\) \{[^\n]*exit 1 \}/.test(code) && /if \(\$bad\.Count -gt 0\) \{ Write-Output "::error::the bundle copied[^\n]*exit 1 \}/.test(code));
  assert.ok(code.includes("if ((Get-Sha256Hex (Join-Path $b 'SHA256SUMS')) -cne $env:EXPECT_SUMS) { $bad.Add('SHA256SUMS') }"), "the copied SHA256SUMS is the one the hosted job made");
  for (const later of ["Invoke-Piped $ps", "Invoke-Piped (Join-Path $b 'node\\node.exe')"]) assert.ok(code.indexOf(later) > copied, `${later} only after both checks`);
  // the earlier copy is deleted without following a link; only a zip written during this step is taken (an older one on the Desktop is never uploaded as this run's)
  assert.ok(!/Remove-Item[^\n]*-Recurse/.test(code) && code.includes("[System.IO.Directory]::Delete($e.FullName, $true)"));
  assert.ok(code.includes("$started = [DateTime]::UtcNow") && code.includes("[System.IO.File]::GetLastWriteTimeUtc($z) -ge $started") && code.includes("[System.Environment]::GetFolderPath('Desktop')"));
  // no secrets, no elevation, nothing installed, no Windows Sandbox in the owner bundle jobs
  for (const j of [build, run]) assert.ok(!/secrets\.|permissions:|RunAs|Install-NimbleNewtLauncher|New-LocalUser|Set-MpPreference|Set-ExecutionPolicy|wsb|deelevate/.test(j.replace(/^\s*#.*$/gm, "")));
  for (const m of (build + run).matchAll(/uses: ([^\s]+)/g)) assert.match(m[1], /@[0-9a-f]{40}$/, m[1]);
  // second review: no dependency install script runs in the build of what runs on the owner's PC; an empty path part is refused by the line check; the zip's last place is the control folder
  assert.ok(build.includes("      - run: npm ci --ignore-scripts\n") && !/- run: npm ci\n/.test(build));
  assert.ok(code.includes("@($rel.Split('/') | Where-Object { $_ -eq '' -or $_ -eq '.' -or $_ -eq '..' }).Count -gt 0"));
  assert.ok(code.includes("foreach ($d in @([System.Environment]::GetFolderPath('Desktop'), (Join-Path $env:USERPROFILE 'Downloads'), (Join-Path $b 'control')))"));
  // no expression is pasted into a script: values reach the shell only through env (EXPECT_SUMS, checked against 64 hex digits first)
  for (const j of [build, run]) for (const block of j.split(/\n {6}- /).filter((b) => /\n {8}run: \|/.test(b) || /^run: /.test(b))) assert.ok(!/\$\{\{/.test(block.slice(block.indexOf("run:"))), `no \${{ }} in a run script: ${block.slice(0, 60)}`);
});

test("windows-appcontainer-experiment (card A03b): the G05 owner bundle steps paste no expression into a script", () => {
  const text = read("windows-appcontainer-experiment.yml");
  const from = text.indexOf("- name: \"G05 owner bundle: parse run-g05.ps1"), to = text.indexOf("exit 0\n", text.indexOf("id: owner_rehearsal"));
  assert.ok(from > 0 && to > from);
  for (const block of text.slice(from, to).split(/\n {6}- /)) if (block.includes("run: |")) assert.ok(!/\$\{\{/.test(block.slice(block.indexOf("run: |"))), block.slice(0, 60));
});
