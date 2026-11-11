import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  CI_SCHEMA, PLATFORMS, SCENARIO_SCHEMA, SIGNOFF_SCHEMA, assessCheckpoint, evidenceDigest, evidenceNames, expectedScenarios, filesFor, isoMillis, judgeTotals, main,
  parseCiRuns, parseQaEvidence, parseScenarioMap, parseScenarioReport, parseSignoff, parseStrictJson, parseTapSummary, readBounded, readEvidenceDir, renderVerdict, runScenarios, show, staleness, writeFileAtomic,
} from "./y02-checkpoint.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const worker = await import(pathToFileURL(join(here, "..", "packages", "worker", "dist", "index.js")).href);
const deps = { parseReport: worker.parseReport, assessRelease: worker.assessRelease };
const mapRaw = readFileSync(join(here, "y02-scenarios.json"), "utf8");
const { map, digest: mapDigest } = parseScenarioMap(mapRaw);
const COMMIT = "a".repeat(40);
const OTHER = "b".repeat(40);
const NOW = new Date("2026-11-11T12:00:00Z");
const T = "2026-11-11T11:00:00.000Z";
const OS_TYPE = { linux: "Linux", darwin: "Darwin", win32: "Windows_NT" };
const clone = (v) => JSON.parse(JSON.stringify(v));
const dir = () => mkdtempSync(join(tmpdir(), "y02-"));

function containment(p) {
  const r = {
    schema: worker.CONTAINMENT_SCHEMA, generatedAt: T, implementationCommit: COMMIT, dirty: false, platform: p, arch: "x64", osVersion: "test 1", backend: "test", capacityAvailable: true, weakerThanLinux: p === "darwin",
    cases: worker.REQUIRED_CASE_IDS.map((id) => ({ id, category: "control", verdict: "pass", detail: "held" })),
    trustedHost: { mode: "trusted-host", authority: "owner", reachesHostFiles: true, refusedWithoutAuthority: true },
  };
  if (p === "darwin") r.macosVersion = "15.1";
  if (p === "win32") {
    const phase = { launch: true, exec: true, results: true, teardown: true };
    r.windows = { serviceIdentity: { account: "svc", session: "service" }, afterLogout: phase, afterReboot: phase, mappedOutputAcl: { positive: true, negative: true }, packagedControllerWorkingDirectory: { packaged: true, passed: true }, supervisorAclCheck: "strict" };
  }
  return r;
}
function scenarios(p) {
  return {
    schema: SCENARIO_SCHEMA, platform: p, osType: OS_TYPE[p], arch: "x64", node: "v22.0.0", commit: COMMIT, dirty: false, generatedAt: T, requireSandbox: true, mapDigest,
    scenarios: expectedScenarios(map, p).map((s) => ({ id: s.id, files: s.files, status: "pass", tests: s.minTests + 3, pass: s.minTests + 3, fail: 0, cancelled: 0, skipped: 0, todo: 0 })),
  };
}
function qa(p) {
  const run = (n) => ({ run: n, passed: true, exitCode: 0, seconds: 1, totals: { tests: 100, pass: 100, fail: 0, cancelled: 0, skipped: 0, todo: 0, blocks: 9 }, markers: {}, problems: [], logFile: `run-${n}.log`, tail: "\u001b[31mcolour\u001b[0m" });
  return { commit: COMMIT, startedAt: T, environment: { os: `${OS_TYPE[p]} 1.0`, platform: p, arch: "x64", node: "v22.0.0", workingTreeClean: true, ci: true }, requestedRuns: 5, runs: [1, 2, 3, 4, 5].map(run), crossRunProblems: [], passed: true };
}
const ciRuns = () => ({ schema: CI_SCHEMA, commit: COMMIT, runs: PLATFORMS.flatMap((p) => ["exhaustive", "qa"].map((workflow, i) => ({ platform: p, workflow, runId: String(1000 + i), conclusion: "success", commit: COMMIT, completedAt: T }))) });

/** A complete, valid evidence set as raw file texts. Each entry can be altered by a test before it is judged. */
function goodSet() {
  const raws = {};
  for (const p of PLATFORMS) {
    raws[evidenceNames(p).containment] = JSON.stringify(containment(p));
    raws[evidenceNames(p).scenarios] = JSON.stringify(scenarios(p));
    raws[evidenceNames(p).qa] = JSON.stringify(qa(p));
  }
  raws["ci-runs.json"] = JSON.stringify(ciRuns());
  return raws;
}
function withSignoff(raws, mutate = () => {}) {
  const files = Object.fromEntries(Object.entries(raws).filter(([, v]) => v !== undefined).map(([k, v]) => [k, { raw: v }]));
  const entries = PLATFORMS.map((p) => ({ platform: p, kind: "signed", by: "owner", at: T, hardware: `test machine for ${p}`, evidenceDigest: evidenceDigest(files, p) }));
  const so = { schema: SIGNOFF_SCHEMA, commit: COMMIT, entries };
  mutate(so);
  files["y02-signoff.json"] = { raw: JSON.stringify(so) };
  return files;
}
const judge = (files, extra = {}) => assessCheckpoint({ files, unexpected: [] , ...extra }, { commit: COMMIT, now: NOW, map, mapDigest, deps });
/** Judges after altering raw files, with a sign-off that quotes the altered evidence (so the sign-off itself is not what fails). */
function judgeAltered(alter, soMutate) {
  const raws = goodSet();
  alter(raws);
  return judge(withSignoff(raws, soMutate));
}
const blocked = (v, re) => assert.ok(v.blockers.some((b) => re.test(b)), `expected a blocker matching ${re}, got:\n${v.blockers.join("\n")}`);

test("a complete, valid set of evidence is accepted, and the verdict is byte-for-byte deterministic", () => {
  const files = withSignoff(goodSet());
  const a = judge(files);
  assert.deepEqual(a.blockers, []);
  assert.equal(a.complete, true);
  assert.equal(a.automatedPart, "complete");
  assert.equal(a.hardwarePart, "complete");
  for (const p of PLATFORMS) assert.deepEqual({ ...a.platforms[p], evidenceDigest: undefined }, { containment: "ok", scenarios: "ok", qa: "ok", ci: "ok", hardware: "signed", evidenceDigest: undefined });
  assert.equal(renderVerdict(a), renderVerdict(judge(files)));
  assert.ok(a.notVerified.length >= 4, "what the gate cannot prove is always listed");
  assert.equal(a.evaluatedAt, NOW.toISOString());
});

test("nothing at all is not a pass: an empty directory blocks every kind of evidence on every platform", () => {
  const v = judge({});
  assert.equal(v.complete, false);
  for (const p of PLATFORMS) for (const kind of ["containment", "scenarios", "qa"]) blocked(v, new RegExp(`${p}: ${kind === "qa" ? "qa-evidence" : kind === "scenarios" ? "y02-scenarios" : "containment"}-${p}.json .*missing`));
  blocked(v, /ci-runs\.json .*missing/);
  blocked(v, /y02-signoff\.json .*missing/);
  for (const p of PLATFORMS) blocked(v, new RegExp(`${p}: hardware: no sign-off`));
});

test("an unreadable evidence directory, a bad commit and a bad clock each give a single blocker and no pass", () => {
  assert.deepEqual(judge({}, { dirError: "the evidence directory cannot be read" }).blockers, ["the evidence directory cannot be read"]);
  assert.match(assessCheckpoint({ files: {} }, { commit: "xyz", now: NOW, map, mapDigest, deps }).blockers[0], /40 hex/);
  assert.match(assessCheckpoint({ files: {} }, { commit: COMMIT, now: new Date("nope"), map, mapDigest, deps }).blockers[0], /clock/);
  assert.equal(assessCheckpoint({ files: {} }, { commit: COMMIT, now: "2026-11-11", map, mapDigest, deps }).complete, false);
});

test("scenario evidence: every guard has its own refusal", () => {
  const edit = (p, f) => (raws) => { const r = JSON.parse(raws[evidenceNames(p).scenarios]); f(r); raws[evidenceNames(p).scenarios] = JSON.stringify(r); };
  blocked(judgeAltered(edit("linux", (r) => { r.commit = OTHER; })), /linux: scenarios: the evidence is for commit b+/);
  blocked(judgeAltered(edit("linux", (r) => { r.dirty = true; })), /linux: scenarios: .*uncommitted/);
  blocked(judgeAltered(edit("linux", (r) => { r.requireSandbox = false; })), /did not require the sandbox/);
  blocked(judgeAltered(edit("linux", (r) => { r.generatedAt = "2026-09-01T00:00:00Z"; })), /more than 30 days old/);
  blocked(judgeAltered(edit("linux", (r) => { r.generatedAt = "2026-11-12T12:00:00Z"; })), /dated in the future/);
  blocked(judgeAltered(edit("linux", (r) => { r.generatedAt = "2026-02-31T00:00:00Z"; })), /generatedAt: an ISO time/);
  blocked(judgeAltered(edit("linux", (r) => { r.mapDigest = "0".repeat(64); })), /another version of the scenario map/);
  blocked(judgeAltered(edit("linux", (r) => { r.osType = "Darwin"; })), /made on Darwin, not Linux/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios.pop(); })), /scenario idle-subscription-expiry is missing/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios = []; })), /scenario sandbox-escape-refused is missing/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios.push(clone(r.scenarios[0])); })), /appears twice/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios.push({ ...clone(r.scenarios[0]), id: "extra-one" }); })), /not part of the set for this platform/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios[0].files = r.scenarios[0].files.slice(1); })), /other test files than the map names/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios[0].skipped = 1; r.scenarios[0].pass -= 1; r.scenarios[0].status = "fail"; })), /skipped/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios[0].tests = 0; r.scenarios[0].pass = 0; })), /0 tests ran, at least \d+/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios[0].fail = 1; r.scenarios[0].pass -= 1; })), /1 failed/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios[0].status = "fail"; })), /status contradicts its counts/);
  blocked(judgeAltered(edit("linux", (r) => { r.scenarios[1].fail = 1; r.scenarios[1].pass -= 1; r.scenarios[1].status = "pass"; })), /status contradicts its counts/);
  blocked(judgeAltered(edit("linux", (r) => { r.platform = "darwin"; })), /the report is for darwin/);
  blocked(judgeAltered(edit("win32", (r) => { r.scenarios = r.scenarios.filter((s) => s.id !== "sandbox-escape-refused"); })), /win32: scenarios: scenario sandbox-escape-refused is missing/);
});

test("the platform-specific files are part of what a report must have run", () => {
  assert.ok(filesFor(map.scenarios[0], "win32").includes("worker/sandbox/windows-real"));
  assert.ok(!filesFor(map.scenarios[0], "linux").includes("worker/sandbox/windows-real"));
  assert.ok(filesFor(map.scenarios[0], "darwin").includes("worker/sandbox/seatbelt"));
  const v = judgeAltered((raws) => { const r = JSON.parse(raws[evidenceNames("win32").scenarios]); r.scenarios[0].files = filesFor(map.scenarios[0], "linux"); raws[evidenceNames("win32").scenarios] = JSON.stringify(r); });
  blocked(v, /win32: scenarios: scenario sandbox-escape-refused: ran other test files/);
});

test("QA evidence: every guard has its own refusal", () => {
  const edit = (p, f) => (raws) => { const r = JSON.parse(raws[evidenceNames(p).qa]); f(r); raws[evidenceNames(p).qa] = JSON.stringify(r); };
  blocked(judgeAltered(edit("darwin", (r) => { r.commit = OTHER; })), /darwin: qa: the record is for commit/);
  blocked(judgeAltered(edit("darwin", (r) => { r.environment.workingTreeClean = false; })), /working tree was not clean/);
  blocked(judgeAltered(edit("darwin", (r) => { r.environment.platform = "linux"; })), /the record is for linux/);
  blocked(judgeAltered(edit("darwin", (r) => { r.environment.os = "Linux 7.0"; })), /made on Linux 7.0, not Darwin/);
  blocked(judgeAltered(edit("darwin", (r) => { r.startedAt = "2026-09-01T00:00:00Z"; })), /more than 30 days old/);
  blocked(judgeAltered(edit("darwin", (r) => { r.requestedRuns = 2; r.runs = r.runs.slice(0, 2); })), /2 runs were requested, at least 5/);
  blocked(judgeAltered(edit("darwin", (r) => { r.runs = r.runs.slice(0, 4); })), /4 runs are recorded for 5 requested/);
  blocked(judgeAltered(edit("darwin", (r) => { r.runs[2].passed = false; })), /a run did not pass cleanly/);
  blocked(judgeAltered(edit("darwin", (r) => { r.runs[2].problems = ["x"]; })), /a run did not pass cleanly/);
  blocked(judgeAltered(edit("darwin", (r) => { r.runs[2].totals.tests = 0; r.runs[2].totals.pass = 0; })), /a run did not pass cleanly/);
  blocked(judgeAltered(edit("darwin", (r) => { r.runs[2].totals.fail = 1; })), /a run did not pass cleanly/);
  blocked(judgeAltered(edit("darwin", (r) => { r.runs[2].totals.cancelled = 1; })), /a run did not pass cleanly/);
  blocked(judgeAltered(edit("darwin", (r) => { r.runs[2].totals.tests = 99; r.runs[2].totals.pass = 99; })), /different numbers of tests/);
  blocked(judgeAltered(edit("darwin", (r) => { r.crossRunProblems = ["run 2 had 3"]; })), /not consistent with each other/);
  blocked(judgeAltered(edit("darwin", (r) => { r.passed = false; })), /the record itself says it did not pass/);
});

test("CI run ids: a missing workflow, a failed run beside a good one, another commit, a repeated or malformed id, an old date", () => {
  const edit = (f) => (raws) => { const r = JSON.parse(raws["ci-runs.json"]); f(r); raws["ci-runs.json"] = JSON.stringify(r); };
  blocked(judgeAltered(edit((r) => { r.runs = r.runs.filter((x) => !(x.platform === "win32" && x.workflow === "qa")); })), /win32: ci: no qa run is recorded/);
  blocked(judgeAltered(edit((r) => { r.runs = r.runs.filter((x) => x.platform !== "darwin"); })), /darwin: ci: no exhaustive run is recorded/);
  blocked(judgeAltered(edit((r) => { r.runs.push({ ...r.runs[0], runId: "999", conclusion: "failure" }); })), /linux: ci: a recorded exhaustive run did not succeed/);
  blocked(judgeAltered(edit((r) => { r.runs.push({ ...r.runs[0], runId: "999", conclusion: "cancelled" }); })), /did not succeed/);
  blocked(judgeAltered(edit((r) => { r.runs[0].commit = OTHER; })), /linux: ci: a exhaustive run is for another commit/);
  blocked(judgeAltered(edit((r) => { r.commit = OTHER; })), /ci-runs\.json is for commit b+/);
  blocked(judgeAltered(edit((r) => { r.runs.push({ ...r.runs[0] }); })), /exhaustive run 1000 is listed twice/);
  blocked(judgeAltered(edit((r) => { r.runs[0].runId = "0123"; })), /ci-runs\.json: a CI run's workflow, runId/);
  blocked(judgeAltered(edit((r) => { r.runs[0].runId = "12a"; })), /runId \(digits\)/);
  blocked(judgeAltered(edit((r) => { r.runs[0].completedAt = "2026-08-01T00:00:00Z"; })), /linux: ci: a exhaustive run is dated in the future or more than 30 days old/);
  blocked(judgeAltered(edit((r) => { r.runs[0].extra = 1; })), /ci-runs\.json: a CI run needs/);
  blocked(judgeAltered(edit((r) => { r.runs.push({ ...r.runs[0], platform: "plan9" }); })), /ci-runs\.json/);
});

test("the owner's sign-off: absent, for another commit, on other evidence, duplicated, stale, thin or malformed", () => {
  blocked(judge(withSignoff(goodSet(), (so) => { so.commit = OTHER; })), /y02-signoff\.json is for commit b+/);
  blocked(judge(withSignoff(goodSet(), (so) => { so.entries[0].evidenceDigest = "0".repeat(64); })), /linux: hardware: the sign-off was made on other evidence/);
  blocked(judge(withSignoff(goodSet(), (so) => { so.entries.push(clone(so.entries[0])); })), /linux: hardware: more than one sign-off entry/);
  blocked(judge(withSignoff(goodSet(), (so) => { so.entries[1].at = "2026-08-01T00:00:00Z"; })), /darwin: hardware: the sign-off: more than 30 days old/);
  blocked(judge(withSignoff(goodSet(), (so) => { so.entries[1].hardware = "x"; })), /y02-signoff\.json: the darwin entry/);
  blocked(judge(withSignoff(goodSet(), (so) => { so.entries[1].by = "  "; })), /y02-signoff\.json: the darwin entry/);
  blocked(judge(withSignoff(goodSet(), (so) => { so.entries[1].extra = 1; })), /y02-signoff\.json: the darwin entry/);
  blocked(judge(withSignoff(goodSet(), (so) => { so.entries = so.entries.filter((e) => e.platform !== "win32"); })), /win32: hardware: no sign-off or recorded waiver/);
  blocked(judge(withSignoff(goodSet(), (so) => { so.entries = []; })), /linux: hardware: no sign-off/);
  const odd = withSignoff(goodSet(), (so) => { so.entries[0].kind = "approved\u001b[2K"; });
  blocked(judge(odd), /y02-signoff\.json: an entry needs a platform and kind signed or waived/);
  assert.doesNotMatch(renderVerdict(judge(odd)), /\u001b/u);
  // evidence changed after signing: the digest no longer matches
  const files = withSignoff(goodSet());
  files[evidenceNames("linux").qa] = { raw: `${files[evidenceNames("linux").qa].raw} ` };
  blocked(judge(files), /linux: hardware: the sign-off was made on other evidence/);
});

test("a recorded waiver satisfies the real-hardware part only; the automated part still has to pass", () => {
  const waived = withSignoff(goodSet(), (so) => { so.entries[2] = { platform: "win32", kind: "waived", by: "owner", at: T, reason: "no Windows machine this month", evidenceDigest: so.entries[2].evidenceDigest }; });
  const v = judge(waived);
  assert.equal(v.platforms.win32.hardware, "waived");
  assert.equal(v.complete, true);
  const raws = goodSet();
  delete raws[evidenceNames("win32").scenarios];
  const w2 = withSignoff(raws, (so) => { so.entries[2] = { platform: "win32", kind: "waived", by: "owner", at: T, reason: "no Windows machine this month", evidenceDigest: so.entries[2].evidenceDigest }; });
  const v2 = judge(w2);
  assert.equal(v2.complete, false);
  assert.equal(v2.hardwarePart, "complete");
  assert.equal(v2.automatedPart, "incomplete");
  const thin = withSignoff(goodSet(), (so) => { so.entries[2] = { platform: "win32", kind: "waived", by: "owner", at: T, reason: "n/a", evidenceDigest: so.entries[2].evidenceDigest }; });
  blocked(judge(thin), /the win32 entry: .*reason/);
});

test("containment evidence is judged by the G05 gate: a report for another commit, a dirty one, a failing case and Windows gaps block", () => {
  const edit = (p, f) => (raws) => { const r = JSON.parse(raws[evidenceNames(p).containment]); f(r); raws[evidenceNames(p).containment] = JSON.stringify(r); };
  blocked(judgeAltered(edit("linux", (r) => { r.implementationCommit = OTHER; })), /containment linux: the evidence is for commit b+/);
  blocked(judgeAltered(edit("linux", (r) => { r.dirty = true; })), /containment linux: .*uncommitted/);
  blocked(judgeAltered(edit("linux", (r) => { r.cases[0].verdict = "fail"; })), /containment linux: case /);
  blocked(judgeAltered(edit("linux", (r) => { r.cases[0].verdict = "inconclusive"; })), /containment linux: case .*inconclusive/);
  blocked(judgeAltered(edit("linux", (r) => { r.cases = []; })), /containment linux: case .* is missing/);
  blocked(judgeAltered(edit("win32", (r) => { r.windows.supervisorAclCheck = "report-only"; })), /containment win32: .*strict/);
  blocked(judgeAltered(edit("win32", (r) => { delete r.windows; })), /containment win32: the Windows host evidence is missing/);
  blocked(judgeAltered(edit("darwin", (r) => { r.weakerThanLinux = false; })), /containment darwin: .*weaker/);
  blocked(judgeAltered(edit("linux", (r) => { r.platform = "darwin"; })), /containment-linux\.json is a report for darwin/);
  blocked(judgeAltered(edit("linux", (r) => { r.generatedAt = "2026-09-01T00:00:00Z"; })), /containment linux: .*30 days/);
  const v = judgeAltered(edit("linux", (r) => { r.cases[0].verdict = "fail"; }));
  assert.equal(v.platforms.linux.containment, "blocked");
  assert.equal(v.platforms.darwin.containment, "ok", "one platform's failure does not mark the others");
});

test("hostile and malformed files: duplicate keys, __proto__, BOM, control and direction characters, wrong types, trailing text", () => {
  const set = (name, raw) => (raws) => { raws[name] = raw; };
  const good = goodSet();
  const dup = good[evidenceNames("linux").scenarios].replace('"dirty":false', '"dirty":true,"dirty":false');
  assert.notEqual(dup, good[evidenceNames("linux").scenarios]);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, dup)), /appears twice/);
  const dupC = good[evidenceNames("linux").containment].replace('"dirty":false', '"dirty":true,"dirty":false');
  blocked(judgeAltered(set(evidenceNames("linux").containment, dupC)), /linux: containment-linux\.json: not strict JSON.*appears twice/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, `﻿${good[evidenceNames("linux").scenarios]}`)), /byte-order mark/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, `${good[evidenceNames("linux").scenarios]} x`)), /text after the value/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, good[evidenceNames("linux").scenarios].replace("{", '{"__proto__":{},'))), /__proto__/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, "[]")), /not a Y02 scenario report/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, "null")), /not a Y02 scenario report/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, "")), /not strict JSON/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, "{" + '"a":['.repeat(30))), /not strict JSON/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, good[evidenceNames("linux").scenarios].replace(/"tests":\d+/, '"tests":"4"'))), /whole number/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, good[evidenceNames("linux").scenarios].replace(/"tests":\d+/, '"tests":-1'))), /whole number/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, good[evidenceNames("linux").scenarios].replace(/"tests":\d+/, '"tests":1e999'))), /number out of range/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, good[evidenceNames("linux").scenarios].replace('"arch":"x64"', '"arch":"x64\\u001b[2K\\rblocked: none"'))), /osType, arch, node: short printable text/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, good[evidenceNames("linux").scenarios].replace('"arch":"x64"', '"arch":"x\\u202e64"'))), /short printable text/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, good[evidenceNames("linux").scenarios].replace('"arch":"x64"', '"arch":"x\\ud800"'))), /short printable text/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, good[evidenceNames("linux").scenarios].replace('"arch":"x64"', '"arch":"x\n64"'))), /raw control character/);
  blocked(judgeAltered(set(evidenceNames("linux").scenarios, good[evidenceNames("linux").scenarios].replace("{", '{"extra":1,'))), /not a Y02 scenario report/);
  blocked(judgeAltered(set(evidenceNames("linux").qa, JSON.stringify({ commit: COMMIT }))), /qa-evidence-linux\.json: passed, startedAt and requestedRuns/);
  blocked(judgeAltered(set("ci-runs.json", good["ci-runs.json"].replace(COMMIT, "ZZ"))), /ci-runs\.json: ci runs: schema, commit/);
  // a sign-off with control characters in its free text is refused whole
  const files = withSignoff(goodSet(), (so) => { so.entries[0].by = "owner\u001b[2Kall clear"; });
  blocked(judge(files), /y02-signoff\.json: the linux entry/);
  // a forged "complete" line smuggled through a name never reaches the output unescaped
  assert.equal(show("a\u001b[31mb‮c"), "a\\u{1b}[31mb\\u{202e}c");
  assert.equal(show("x".repeat(500)).length, 83);
});

test("a verdict never contains a control character, whatever the hostile files said", () => {
  const files = withSignoff(goodSet());
  files["containment-linux.json"] = { raw: JSON.stringify({ ...containment("linux"), backend: "x\u001b[2Kcomplete" }) };
  const v = judge(files, { unexpected: ["containment-evil\u001b[2K.json", "y02-scenarios-‮dark.json"] });
  const text = renderVerdict(v);
  assert.doesNotMatch(text, /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/u);
  blocked(v, /unexpected evidence file containment-evil\\u\{1b\}/);
  blocked(v, /unexpected evidence file y02-scenarios-\\u\{202e\}dark/);
  assert.equal(v.complete, false);
});

test("a platform's report cannot be passed off for another: file names bind the platform and the content must agree", () => {
  const raws = goodSet();
  raws[evidenceNames("darwin").scenarios] = raws[evidenceNames("linux").scenarios];
  raws[evidenceNames("darwin").qa] = raws[evidenceNames("linux").qa];
  const v = judge(withSignoff(raws));
  blocked(v, /darwin: scenarios: the report is for linux/);
  blocked(v, /darwin: qa: the record is for linux/);
  assert.equal(v.complete, false);
});

test("the scenario map is read as data and an empty or malformed one is refused", () => {
  assert.ok(map.scenarios.length >= 8);
  const mutate = (f) => { const m = clone(map); f(m); return parseScenarioMap(JSON.stringify(m)); };
  assert.ok("error" in mutate((m) => { m.scenarios = []; }), "an empty set proves nothing");
  assert.match(mutate((m) => { m.scenarios.push(clone(m.scenarios[0])); }).error, /unique/);
  assert.match(mutate((m) => { m.scenarios[0].files = []; }).error, /non-empty/);
  assert.match(mutate((m) => { m.scenarios[0].files = ["worker/../../etc/passwd"]; }).error, /not a package\/path/);
  assert.match(mutate((m) => { m.scenarios[0].files = ["/etc/passwd"]; }).error, /not a package\/path/);
  assert.match(mutate((m) => { m.scenarios[0].files = ["worker/a/../b"]; }).error, /not a package\/path/);
  assert.match(mutate((m) => { m.scenarios[0].files = ["worker/Sandbox"]; }).error, /not a package\/path/);
  assert.match(mutate((m) => { m.scenarios[0].files.push(m.scenarios[0].files[0]); }).error, /listed twice/);
  assert.match(mutate((m) => { m.scenarios[0].minTests = 0; }).error, /minTests/);
  assert.match(mutate((m) => { m.scenarios[0].platforms = []; }).error, /platforms/);
  assert.match(mutate((m) => { m.scenarios[0].platforms = ["plan9"]; }).error, /platforms/);
  assert.match(mutate((m) => { m.scenarios[0].platformFiles = { plan9: ["worker/x"] }; }).error, /platformFiles/);
  assert.match(mutate((m) => { m.scenarios[0].extra = 1; }).error, /a scenario needs/);
  assert.match(mutate((m) => { m.scenarios[0].title = "bad\u001b"; }).error, /printable/);
  assert.match(parseScenarioMap('{"schema":"x","schema":"y"}').error, /not strict JSON/);
  assert.match(parseScenarioMap("{}").error, /schema/);
  // every compiled test file the map names exists as a source file (a renamed test cannot silently leave a scenario vacuous)
  for (const s of map.scenarios) for (const f of [...s.files, ...Object.values(s.platformFiles).flat()]) {
    const [pkg, ...rest] = f.split("/");
    assert.ok(readBounded(join(here, "..", "packages", pkg, "src", `${rest.join("/")}.test.ts`), 4 * 1024 * 1024).raw !== undefined, `${f} has no source test file`);
  }
  assert.notEqual(parseScenarioMap(mapRaw.replace(/"minTests": (\d+)/, (_, n) => `"minTests": ${Number(n) + 1}`)).digest, mapDigest, "the digest follows the file");
});

test("strict JSON: what JSON.parse lets through is refused", () => {
  assert.deepEqual(parseStrictJson('{"a":[1,2,{"b":null}],"c":"\\u00e9"}'), { a: [1, 2, { b: null }], c: "é" });
  for (const bad of ['{"a":1,"a":2}', '{"__proto__":1}', "{'a':1}", '{"a":01}', '{"a":1,}', "[1,]", '{"a":"\\x"}', '{"a":"\\u12"}', "NaN", "-", '"abc', "{}{}", "\t {}", "{\"a\":\"\t\"}"]) assert.throws(() => parseStrictJson(bad), undefined, bad);
  assert.throws(() => parseStrictJson("[".repeat(20) + "]".repeat(20)), /deeply/);
  assert.throws(() => parseStrictJson(`[${"1,".repeat(60000)}1]`), /too many/);
  assert.deepEqual(parseStrictJson(' \n{ "a" : 1 }\r\n'), { a: 1 });
  assert.equal(Object.getPrototypeOf(parseStrictJson('{"a":1}')), Object.prototype);
});

test("times: a real calendar date, a real clock, and freshness in both directions", () => {
  assert.ok(Number.isFinite(isoMillis("2026-11-11T12:00:00Z")));
  assert.ok(Number.isFinite(isoMillis("2026-11-11T12:00:00.123456789+05:30")));
  for (const bad of ["2026-02-31T00:00:00Z", "2026-13-01T00:00:00Z", "2026-11-11T24:00:00Z", "2026-11-11T12:60:00Z", "2026-11-11T12:00:60Z", "2026-11-11 12:00:00Z", "2026-11-11", "2026-11-11T12:00:00", "2026-11-11T12:00:00+25:00", "now", 5, undefined, "2026-11-11T12:00:00Z".repeat(3)]) assert.ok(Number.isNaN(isoMillis(bad)), String(bad));
  assert.ok(Number.isFinite(isoMillis("2028-02-29T00:00:00Z")));
  assert.ok(Number.isNaN(isoMillis("2027-02-29T00:00:00Z")));
  const now = NOW.getTime();
  assert.equal(staleness(T, now, "x"), undefined);
  assert.match(staleness("2026-10-01T00:00:00Z", now, "x"), /30 days/);
  assert.match(staleness("2026-11-11T13:00:00Z", now, "x"), /future/);
  assert.equal(staleness("2026-11-11T12:03:00Z", now, "x"), undefined, "small clock skew is tolerated");
  assert.match(staleness("garbage", now, "x"), /valid ISO/);
});

test("the test runner's summary: only the final block counts, and a test printing a fake summary is refused", () => {
  const summary = (t, p, f = 0, c = 0, s = 0, td = 0) => `1..${t}\n# tests ${t}\n# suites 0\n# pass ${p}\n# fail ${f}\n# cancelled ${c}\n# skipped ${s}\n# todo ${td}\n# duration_ms 12.5\n`;
  assert.deepEqual(parseTapSummary(`TAP version 13\nok 1 - a\n${summary(1, 1)}`).totals, { tests: 1, suites: 0, pass: 1, fail: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.ok("error" in parseTapSummary(""));
  assert.ok("error" in parseTapSummary("ok 1 - a\n"));
  assert.ok("error" in parseTapSummary(`# tests 9\n# pass 9\n${summary(1, 1)}`), "a second tests line anywhere is refused");
  assert.ok("error" in parseTapSummary(`${summary(1, 1)}# a trailing comment\n`), "text after the summary is refused");
  assert.ok("error" in parseTapSummary(summary(1, 1).replace("# fail 0", "# fail 0 extra")));
  assert.ok("error" in parseTapSummary(summary(1, 1).replace("# pass 1", "# pass x")));
  assert.ok("error" in parseTapSummary(summary(1, 1).replace("# duration_ms 12.5", "# duration_ms")));
  assert.ok("error" in parseTapSummary(summary(1, 1).replace(/# suites 0\n/, "")));
});

test("judging counts: a skipped, todo, cancelled or failed test, or too few tests, is never a pass", () => {
  const ok = { tests: 5, pass: 5, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  assert.deepEqual(judgeTotals(ok, 5), []);
  assert.match(judgeTotals({ ...ok, tests: 0, pass: 0 }, 1).join(), /0 tests ran/);
  assert.match(judgeTotals(ok, 6).join(), /at least 6/);
  assert.match(judgeTotals({ ...ok, pass: 4, fail: 1 }, 1).join(), /4 of 5.*1 failed/);
  assert.match(judgeTotals({ ...ok, pass: 4, cancelled: 1 }, 1).join(), /1 cancelled/);
  assert.match(judgeTotals({ ...ok, pass: 4, skipped: 1 }, 1).join(), /skipped/);
  assert.match(judgeTotals({ ...ok, todo: 1 }, 1).join(), /todo/);
});

test("the producer: runScenarios records real counts, refuses a missing test file, a failing run, a vacuous run and a tree the tests changed", () => {
  const root = dir();
  try {
    const tiny = { schema: SCENARIO_SCHEMA, note: "n", scenarios: [{ id: "one", title: "t", clause: "c", platforms: ["linux"], files: ["pkga/x", "pkgb/y"], platformFiles: {}, minTests: 2 }, { id: "two", title: "t", clause: "c", platforms: ["linux", "darwin"], files: ["pkga/z"], platformFiles: { darwin: ["pkga/mac"] }, minTests: 1 }] };
    const parsed = parseScenarioMap(JSON.stringify(tiny));
    for (const f of ["pkga/dist/x.test.js", "pkgb/dist/y.test.js", "pkga/dist/z.test.js"]) { mkdirSync(dirname(join(root, "packages", f)), { recursive: true }); writeFileSync(join(root, "packages", f), ""); }
    const tap = (t, p, extra = {}) => { const o = { fail: 0, cancelled: 0, skipped: 0, todo: 0, ...extra }; return `# tests ${t}\n# suites 0\n# pass ${p}\n# fail ${o.fail}\n# cancelled ${o.cancelled}\n# skipped ${o.skipped}\n# todo ${o.todo}\n# duration_ms 1\n`; };
    const calls = [];
    const run = (exec, extra = {}) => runScenarios({ root, map: parsed.map, mapDigest: parsed.digest, platform: "linux", now: NOW.getTime(), exec, getHead: () => COMMIT, getStatus: () => "", ...extra });
    const good = run((cwd, files) => { calls.push([cwd.split("/").pop(), files]); return { status: 0, output: tap(files.length, files.length) }; });
    assert.deepEqual(calls, [["pkga", ["dist/x.test.js"]], ["pkgb", ["dist/y.test.js"]], ["pkga", ["dist/z.test.js"]]]);
    assert.deepEqual(good.scenarios.map((s) => [s.id, s.status, s.tests]), [["one", "pass", 2], ["two", "pass", 1]]);
    assert.equal(good.commit, COMMIT);
    assert.equal(good.requireSandbox, true);
    assert.equal(good.dirty, false);
    assert.equal(parseScenarioReport(JSON.stringify(good)).report.mapDigest, parsed.digest, "the producer's output is accepted by the gate's own parser");
    assert.deepEqual(good.scenarios.map((s) => s.files), expectedScenarios(parsed.map, "linux").map((s) => s.files));
    // a Mac run adds the Mac-only file, and so asks for a file that does not exist here
    assert.match(JSON.stringify(runScenarios({ root, map: parsed.map, mapDigest: parsed.digest, platform: "darwin", now: 0, exec: () => ({ status: 0, output: tap(1, 1) }), getHead: () => COMMIT, getStatus: () => "" }).scenarios), /"status":"fail"/);
    assert.equal(run(() => ({ status: 1, output: tap(2, 2) })).scenarios[0].status, "fail", "a non-zero exit is a failure whatever the summary says");
    assert.equal(run(() => ({ status: null, output: tap(2, 2) })).scenarios[0].status, "fail", "a killed run is a failure");
    assert.equal(run(() => ({ status: 0, output: "no summary" })).scenarios[0].status, "fail");
    assert.equal(run(() => ({ status: 0, output: tap(0, 0) })).scenarios[0].status, "fail", "zero tests is vacuous");
    assert.equal(run(() => ({ status: 0, output: tap(2, 1, { skipped: 1 }) })).scenarios[0].status, "fail", "skipped tests are not evidence");
    assert.equal(run((cwd) => ({ status: 0, output: cwd.endsWith("pkga") ? tap(1, 1) : tap(0, 0) })).scenarios[0].status, "fail", "the floor applies to the scenario's total");
    let n = 0;
    assert.equal(run(() => ({ status: 0, output: tap(2, 2) }), { getStatus: () => (n++ === 0 ? "" : " M file") }).dirty, true, "a tree the tests changed is dirty");
    let h = 0;
    assert.equal(run(() => ({ status: 0, output: tap(2, 2) }), { getHead: () => (h++ === 0 ? COMMIT : OTHER) }).dirty, true, "a moved HEAD is dirty");
    assert.equal(run(() => ({ status: 0, output: tap(2, 2) }), { getStatus: () => " M x" }).dirty, true);
    rmSync(join(root, "packages", "pkgb", "dist", "y.test.js"));
    assert.match(JSON.stringify(run(() => ({ status: 0, output: tap(2, 2) })).scenarios[0]), /"status":"fail"/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("reading the directory: links, directories, oversize files and look-alike names are refused", () => {
  const d = dir();
  const raws = goodSet();
  for (const [n, raw] of Object.entries(raws)) writeFileSync(join(d, n), raw);
  const outside = join(dir(), "elsewhere.json");
  writeFileSync(outside, raws["containment-linux.json"]);
  rmSync(join(d, "containment-linux.json"));
  symlinkSync(outside, join(d, "containment-linux.json"));
  rmSync(join(d, "qa-evidence-darwin.json"));
  mkdirSync(join(d, "qa-evidence-darwin.json"));
  assert.match(readEvidenceDir(d).files["qa-evidence-darwin.json"].error, /not a regular file/);
  rmSync(join(d, "qa-evidence-darwin.json"), { recursive: true, force: true });
  writeFileSync(join(d, "qa-evidence-darwin.json"), "x".repeat(5 * 1024 * 1024));
  writeFileSync(join(d, "containment-linux2.json"), "{}");
  writeFileSync(join(d, "y02-scenarios-mac.json"), "{}");
  writeFileSync(join(d, "notes.txt"), "ignored");
  writeFileSync(join(d, "y02-verdict.json"), "{}");
  const read = readEvidenceDir(d);
  assert.match(read.files["containment-linux.json"].error, /symbolic link/);
  assert.match(read.files["qa-evidence-darwin.json"].error, /larger than/);
  assert.deepEqual(read.unexpected, ["containment-linux2.json", "y02-scenarios-mac.json"]);
  const v = judge(read.files, { unexpected: read.unexpected });
  blocked(v, /linux: containment-linux\.json is a symbolic link/);
  blocked(v, /darwin: qa-evidence-darwin\.json is larger than/);
  blocked(v, /unexpected evidence file containment-linux2\.json/);
  assert.match(readBounded(d, 10).error, /not a regular file/);
  assert.match(readBounded(join(d, "none"), 10).error, /missing/);
  writeFileSync(join(d, "bad.bin"), Buffer.from([0xff, 0xfe, 0x41]));
  assert.match(readBounded(join(d, "bad.bin"), 10).error, /UTF-8/);
  assert.match(readEvidenceDir(join(d, "nothing-here")).error, /cannot be read/);
  rmSync(d, { recursive: true, force: true });
});

test("the digest changes with any file it covers and not with files it does not", () => {
  const files = withSignoff(goodSet());
  const base = evidenceDigest(files, "linux");
  assert.match(base, /^[0-9a-f]{64}$/);
  for (const n of [evidenceNames("linux").containment, evidenceNames("linux").scenarios, evidenceNames("linux").qa, "ci-runs.json"]) assert.notEqual(evidenceDigest({ ...files, [n]: { raw: `${files[n].raw}\n` } }, "linux"), base, n);
  assert.equal(evidenceDigest({ ...files, [evidenceNames("darwin").qa]: { raw: "changed" } }, "linux"), base, "another platform's file is not covered");
  assert.notEqual(evidenceDigest(files, "darwin"), base);
  assert.notEqual(evidenceDigest({ ...files, "ci-runs.json": { error: "is missing" } }, "linux"), base);
});

test("parsers reject wrong shapes without throwing", () => {
  for (const f of [parseScenarioReport, parseQaEvidence, parseCiRuns, parseSignoff]) for (const raw of ["", "null", "[]", "5", '"x"', "{}", '{"schema":1}', "\u0000"]) assert.ok("error" in f(raw), `${f.name} ${JSON.stringify(raw)}`);
  assert.ok("error" in parseQaEvidence(JSON.stringify({ ...qa("linux"), runs: [null] })));
  assert.ok("error" in parseQaEvidence(JSON.stringify({ ...qa("linux"), runs: Array(60).fill(qa("linux").runs[0]) })));
  assert.ok("error" in parseQaEvidence(JSON.stringify({ ...qa("linux"), environment: { ...qa("linux").environment, os: "bad\u001bx" } })));
  assert.ok("report" in parseScenarioReport(JSON.stringify(scenarios("linux"))));
  assert.ok("qa" in parseQaEvidence(JSON.stringify(qa("linux"))), "log tails with terminal colours in the QA record are neither read nor printed");
});

test("writing the verdict: atomic, replaces an old file, refuses a directory, leaves no temporary file", () => {
  const d = dir();
  try {
    const target = join(d, "sub", "y02-verdict.json");
    writeFileAtomic(target, "one\n");
    writeFileAtomic(target, "two\n");
    assert.equal(readFileSync(target, "utf8"), "two\n");
    mkdirSync(join(d, "adir"));
    assert.throws(() => writeFileAtomic(join(d, "adir"), "x"), /not a regular file/);
    assert.deepEqual(readEvidenceDir(join(d, "sub")).unexpected, [], "no temporary file is left behind");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("the command line: usage errors exit 2, an incomplete directory exits 1 and says why, a complete one exits 0 and writes the same verdict twice", async () => {
  const io = () => { const out = []; const err = []; return { out: (s) => out.push(s), err: (s) => err.push(s), lines: out, errors: err }; };
  for (const argv of [[], ["nope"], ["gate"], ["gate", "--dir", "x"], ["gate", "--commit", COMMIT], ["gate", "--dir", "x", "--commit", COMMIT, "--bogus", "1"], ["gate", "--dir", "x", "--commit", COMMIT, "--dir", "y"], ["gate", "--dir", "x", "--commit", COMMIT, "--now", "tomorrow"], ["digest", "--dir", "x", "--platform", "plan9"], ["run"], ["run", "--dir", "x"], ["gate", "--dir", "--commit", COMMIT]]) {
    const i = io();
    assert.equal(await main(argv, i), 2, JSON.stringify(argv));
    assert.match(i.errors.join(), /usage/);
  }
  const empty = dir();
  const i1 = io();
  assert.equal(await main(["gate", "--dir", empty, "--commit", COMMIT, "--now", NOW.toISOString()], i1), 1);
  assert.match(i1.lines.join("\n"), /blocked: linux: containment-linux\.json is missing/);
  assert.match(i1.lines.at(-1), /incomplete: automated part incomplete, hardware part incomplete/);
  const bad = io();
  assert.equal(await main(["gate", "--dir", join(empty, "none"), "--commit", COMMIT], bad), 1);
  assert.match(bad.lines.join("\n"), /blocked: the evidence directory cannot be read/);
  const raws = goodSet();
  for (const [n, raw] of Object.entries(raws)) writeFileSync(join(empty, n), raw);
  const read = readEvidenceDir(empty);
  const digestIo = io();
  assert.equal(await main(["digest", "--dir", empty, "--platform", "linux"], digestIo), 0);
  assert.equal(digestIo.lines[0], evidenceDigest(read.files, "linux"));
  const so = { schema: SIGNOFF_SCHEMA, commit: COMMIT, entries: PLATFORMS.map((p) => ({ platform: p, kind: "signed", by: "owner", at: T, hardware: `test machine for ${p}`, evidenceDigest: evidenceDigest(read.files, p) })) };
  writeFileSync(join(empty, "y02-signoff.json"), JSON.stringify(so));
  const out1 = join(empty, "out", "verdict-1.json");
  const out2 = join(empty, "out", "verdict-2.json");
  const i2 = io();
  assert.equal(await main(["gate", "--dir", empty, "--commit", COMMIT, "--now", NOW.toISOString(), "--out", out1], i2), 0, i2.lines.join("\n"));
  assert.equal(i2.lines.at(-1), "Y02 checkpoint evidence complete for this commit");
  assert.equal(await main(["gate", "--dir", empty, "--commit", COMMIT, "--now", NOW.toISOString(), "--out", out2], io()), 0);
  assert.equal(readFileSync(out1, "utf8"), readFileSync(out2, "utf8"));
  assert.equal(JSON.parse(readFileSync(out1, "utf8")).complete, true);
  // an incomplete verdict is written too, with its blockers, and the exit code is 1
  rmSync(join(empty, "qa-evidence-win32.json"));
  const out3 = join(empty, "out", "verdict-3.json");
  assert.equal(await main(["gate", "--dir", empty, "--commit", COMMIT, "--now", NOW.toISOString(), "--out", out3], io()), 1);
  const v3 = JSON.parse(readFileSync(out3, "utf8"));
  assert.equal(v3.complete, false);
  assert.ok(v3.blockers.some((b) => /win32: qa-evidence-win32\.json is missing/.test(b)));
  // a wrong commit blocks everything bound to the commit
  const i4 = io();
  assert.equal(await main(["gate", "--dir", empty, "--commit", OTHER, "--now", NOW.toISOString()], i4), 1);
  assert.match(i4.lines.join("\n"), /scenarios: the evidence is for commit a+/);
  // an output path that is a directory is a usage-level failure, not a pass
  mkdirSync(join(empty, "adir"));
  const i5 = io();
  assert.equal(await main(["gate", "--dir", empty, "--commit", COMMIT, "--now", NOW.toISOString(), "--out", join(empty, "adir")], i5), 2);
  rmSync(empty, { recursive: true, force: true });
});
