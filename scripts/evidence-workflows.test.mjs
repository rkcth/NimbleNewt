// Cards G05, G06, Y02: the workflow steps that produce hardware-chain evidence keep the properties the evidence relies on. Text checks (the repository has no YAML parser and no
// actionlint); the files are also parsed with PyYAML when the change is made.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
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
  const ids = ["fs", "wsb", "wd", "g05", "g06", "y02"];
  for (const id of ids) assert.match(step(j, id), /\n {8}continue-on-error: true\n/, id);
  const outcome = j.slice(j.indexOf("- name: Job summary and outcome"));
  assert.match(outcome, /if: always\(\)/);
  for (const id of ids) assert.match(outcome, new RegExp(`\\$\\{\\{ steps\\.${id}\\.outcome \\}\\}`), id);
  assert.match(outcome, /if \[ "\$o" != "success" \]; then .*exit 1; fi/);
  // The Git Bash fix stays the first thing after the checkout (run 44453704944).
  assert.ok(j.indexOf("Use Git Bash for bash steps") < j.indexOf("id: fs"));
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
