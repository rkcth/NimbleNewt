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
  assert.match(text, /^on:\n {2}workflow_dispatch:\n\n/m, "started by hand only: no push or pull request trigger");
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
