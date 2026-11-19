import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTAINMENT_SCHEMA, REQUIRED_CASE_IDS, assessRelease, parseReport, type ContainmentReport } from "./containment.js";
import {
  WSB_SUMMARY_SCHEMA, WSB_TESTS, attachWindowsEvidence, controlsFromEscapeOutput, parseWorkdirCheck, parseWsbSummary, redactReport, sessionFromEnvironment, windowsEvidenceFromSummary, type WsbSummary,
} from "./containment-windows-evidence.js";

// Card G05: the Windows block of a containment report, produced from the real Windows Sandbox tests' summary. Pure rules; the real run is own-hardware.yml on the owner's machine.
const COMMIT = "c".repeat(40);
const allPass = Object.fromEntries(Object.values(WSB_TESTS).map((n) => [n, "pass"]));
const goodControls = { writesCheckout: true, readOnlyInputDenied: true, gitDenied: true, junctionDenied: true, aclsRestored: true };
const summary = (extra: Partial<WsbSummary> = {}): WsbSummary => ({ tests: allPass, controls: goodControls, supervisorAcl: "strict", ...extra });
const raw = (v: unknown): string => JSON.stringify(v);
const winReport = (): ContainmentReport => ({
  schema: CONTAINMENT_SCHEMA, generatedAt: new Date().toISOString(), implementationCommit: COMMIT, dirty: false, platform: "win32", arch: "x64", osVersion: "10.0.26200", backend: "windows-sandbox",
  capacityAvailable: true, weakerThanLinux: false, cases: REQUIRED_CASE_IDS.map((id) => ({ id, category: "control", verdict: "pass", detail: "held" })),
  trustedHost: { mode: "trusted-host", authority: "owner", reachesHostFiles: true, refusedWithoutAuthority: true },
});
const blockers = (r: ContainmentReport): string[] => [...assessRelease([r], { commit: COMMIT, platforms: ["win32"] }).blockers];

test("everything the tests showed: ACL controls and the strict check are true; logout and reboot stay false, so the gate still blocks on exactly those", () => {
  const { evidence, notProven } = windowsEvidenceFromSummary(summary(), { session: "service", workingDirectory: { packaged: true, passed: true } });
  assert.deepEqual(evidence.mappedOutputAcl, { positive: true, negative: true });
  assert.equal(evidence.supervisorAclCheck, "strict");
  assert.equal(evidence.featureEnabledOnly, false);
  assert.deepEqual(evidence.serviceIdentity, { account: "<user>", session: "service" });
  assert.deepEqual([evidence.afterLogout, evidence.afterReboot], [{ launch: false, exec: false, results: false, teardown: false }, { launch: false, exec: false, results: false, teardown: false }]);
  assert.deepEqual(notProven, ["launch, exec, results and teardown after logout and after a reboot under the unattended service identity: not automated, recorded as false"]);
  const b = blockers({ ...winReport(), windows: evidence });
  assert.equal(b.length, 8, b.join("\n"));
  assert.ok(b.every((x) => /win32: Windows (launch|exec|results|teardown) not proven after (logout|reboot)/.test(x)), b.join("\n"));
  // The produced report reads back as a report.
  assert.ok("report" in parseReport(raw({ ...winReport(), windows: evidence })));
});

test("each control needs its own observation, the whole escape test passing, and the ACL given back (mutation-style: one fact false at a time)", () => {
  for (const k of Object.keys(goodControls) as (keyof typeof goodControls)[]) {
    const e = windowsEvidenceFromSummary(summary({ controls: { ...goodControls, [k]: false } }), { session: "service" }).evidence.mappedOutputAcl;
    const expectPositive = k !== "aclsRestored" && k !== "writesCheckout";
    const expectNegative = k === "writesCheckout";
    assert.deepEqual(e, { positive: expectPositive, negative: expectNegative }, k);
  }
  const missing = windowsEvidenceFromSummary(summary({ controls: {} }), { session: "service" }).evidence.mappedOutputAcl;
  assert.deepEqual(missing, { positive: false, negative: false }, "no recorded control counts as not shown");
  const failedEscape = windowsEvidenceFromSummary(summary({ tests: { ...allPass, [WSB_TESTS.escape]: "fail" } }), { session: "service" });
  assert.deepEqual(failedEscape.evidence.mappedOutputAcl, { positive: false, negative: false }, "controls count only when the whole escape test (with its host-side checks) passed");
  assert.ok(failedEscape.notProven.some((n) => /positive control/.test(n)) && failedEscape.notProven.some((n) => /negative control/.test(n)));
});

test("the strict supervisor-ACL check counts only when strict was in use AND its test passed; an interactive session and a missing working-directory check are named", () => {
  assert.equal(windowsEvidenceFromSummary(summary({ supervisorAcl: "report-only" }), { session: "service" }).evidence.supervisorAclCheck, "report-only");
  assert.equal(windowsEvidenceFromSummary(summary({ tests: { ...allPass, [WSB_TESTS.strictAcl]: "fail" } }), { session: "service" }).evidence.supervisorAclCheck, "report-only");
  assert.equal(windowsEvidenceFromSummary(summary({ tests: { ...allPass, [WSB_TESTS.strictAcl]: "not run or skipped" } }), { session: "service" }).evidence.supervisorAclCheck, "report-only");
  const r = windowsEvidenceFromSummary(summary({ supervisorAcl: "report-only" }), { session: "interactive" });
  assert.deepEqual(r.evidence.packagedControllerWorkingDirectory, { packaged: false, passed: false });
  for (const want of [/interactive session/, /strict supervisor-ACL/, /not run on a packaged controller/]) assert.ok(r.notProven.some((n) => want.test(n)), String(want));
  const b = blockers({ ...winReport(), windows: r.evidence });
  for (const want of [/interactive session/, /report-only/, /not run on the packaged controller/]) assert.ok(b.some((x) => want.test(x)), String(want));
  assert.ok(windowsEvidenceFromSummary(summary(), { session: "service", workingDirectory: { packaged: true, passed: false } }).notProven.some((n) => /working-directory check failed/.test(n)));
});

test("a run where no real sandbox test passed is the feature being present only, and the gate refuses it as such", () => {
  const onlyFacts = Object.fromEntries(Object.values(WSB_TESTS).map((n) => [n, n === WSB_TESTS.facts || n === WSB_TESTS.failClosed ? "pass" : "fail"]));
  const r = windowsEvidenceFromSummary(summary({ tests: onlyFacts }), { session: "service" });
  assert.equal(r.evidence.featureEnabledOnly, true);
  assert.ok(blockers({ ...winReport(), windows: r.evidence }).some((x) => /feature being enabled only/.test(x)));
  // One real confined test passing is enough to not be "feature only"; it does not make anything else true.
  const one = windowsEvidenceFromSummary(summary({ tests: { ...onlyFacts, [WSB_TESTS.exitCode]: "pass" } }), { session: "service" }).evidence;
  assert.deepEqual([one.featureEnabledOnly, one.mappedOutputAcl.positive], [false, false]);
});

test("the summary and the working-directory check are read as data; malformed ones are refused with a reason", () => {
  const good = { schema: WSB_SUMMARY_SCHEMA, os: "10.0", tests: allPass, controls: goodControls, supervisorAcl: "strict", facts: {}, counts: {} };
  assert.ok("summary" in parseWsbSummary(raw(good)));
  for (const [bad, why] of [
    ["{", /not JSON/], [raw({ ...good, schema: "x" }), /schema/], [raw({ ...good, tests: [] }), /tests/], [raw({ ...good, tests: { a: 1 } }), /tests/],
    [raw({ ...good, controls: { writesCheckout: "yes" } }), /controls/], [raw({ ...good, controls: { other: true } }), /controls/], [raw({ ...good, supervisorAcl: "lenient" }), /supervisorAcl/],
    [raw({ ...good, pad: "x".repeat(70_000) }), /larger/],
  ] as const) { const p = parseWsbSummary(bad); assert.ok("error" in p && why.test(p.error), `${bad.slice(0, 40)} -> ${JSON.stringify(p)}`); }
  // Missing controls are allowed (an older summary) and count as not shown.
  const { controls: _c, ...noControls } = good;
  const p = parseWsbSummary(raw(noControls));
  assert.ok("summary" in p && Object.keys(p.summary.controls).length === 0);
  assert.deepEqual(parseWorkdirCheck(raw({ schema: "nimblenewt.g05-workdir/1", packaged: false, passed: true, problems: [] })), { packaged: false, passed: true });
  for (const bad of ["[", raw({ schema: "nimblenewt.g05-workdir/1", packaged: "no", passed: true }), raw({ packaged: true, passed: true })]) assert.ok("error" in parseWorkdirCheck(bad), bad);
});

test("attaching: only to a Windows report; errors name the input; the attached report passes parseReport", () => {
  const summaryRaw = raw({ schema: WSB_SUMMARY_SCHEMA, tests: allPass, controls: goodControls, supervisorAcl: "strict" });
  const workdirRaw = raw({ schema: "nimblenewt.g05-workdir/1", packaged: false, passed: true });
  const ok = attachWindowsEvidence(winReport(), { summaryRaw, workdirRaw, session: "service" });
  assert.ok("report" in ok);
  assert.deepEqual(ok.report.windows!.packagedControllerWorkingDirectory, { packaged: false, passed: true });
  assert.ok("report" in parseReport(raw(ok.report)));
  const linux = attachWindowsEvidence({ ...winReport(), platform: "linux" }, { summaryRaw, session: "service" });
  assert.ok("error" in linux && /only into a Windows report/.test(linux.error));
  const bad = attachWindowsEvidence(winReport(), { summaryRaw: "{}", session: "service" });
  assert.ok("error" in bad && /Windows Sandbox summary/.test(bad.error));
  const badWd = attachWindowsEvidence(winReport(), { summaryRaw, workdirRaw: "{}", session: "service" });
  assert.ok("error" in badWd && /working-directory/.test(badWd.error));
});

test("the escape fixture's report lines become the controls; a line must match exactly (ALLOWED or a near spelling never counts)", () => {
  const out = ["1_write_readonly_input=denied", "2_write_git=denied", "3_write_work=allowed", "4_read_host_path=denied", "8_write_through_junction=denied", "done"].join("\r\n");
  assert.deepEqual(controlsFromEscapeOutput(out, true), goodControls);
  assert.deepEqual(controlsFromEscapeOutput(out, false).aclsRestored, false);
  const leaked = out.replace("2_write_git=denied", "2_write_git=ALLOWED").replace("3_write_work=allowed", "3_write_work=FAILED").replace("8_write_through_junction=denied", "x 8_write_through_junction=denied");
  assert.deepEqual(controlsFromEscapeOutput(leaked, true), { writesCheckout: false, readOnlyInputDenied: true, gitDenied: false, junctionDenied: false, aclsRestored: true });
  // A longer line that only contains the expected text does not count either.
  assert.deepEqual(controlsFromEscapeOutput("13_write_work=allowed\n1_write_readonly_input=denied_not\n", true), { writesCheckout: false, readOnlyInputDenied: false, gitDenied: false, junctionDenied: false, aclsRestored: true });
});

test("the session comes from SESSIONNAME: none or Services is the service session, Console or RDP is interactive", () => {
  assert.equal(sessionFromEnvironment({}), "service");
  assert.equal(sessionFromEnvironment({ SESSIONNAME: "" }), "service");
  assert.equal(sessionFromEnvironment({ SESSIONNAME: "Services" }), "service");
  assert.equal(sessionFromEnvironment({ SESSIONNAME: "Console" }), "interactive");
  assert.equal(sessionFromEnvironment({ SESSIONNAME: "RDP-Tcp#3" }), "interactive");
});

test("redacting a report hides names in its free text only; the gate judges the redacted report exactly as the original", () => {
  const original: ContainmentReport = {
    ...winReport(), capacityReason: "the console user ACME\\alice.smith is not the owner", osVersion: "10.0.26200",
    cases: winReport().cases.map((c, i) => (i === 0 ? { ...c, detail: "wrote C:\\Users\\alice.smith\\work\\ok.txt from S-1-5-21-1-2-3-1001 at 192.168.1.20" } : c)),
    trustedHost: { mode: "trusted-host", authority: "alice.smith", reachesHostFiles: true, refusedWithoutAuthority: true },
    windows: windowsEvidenceFromSummary(summary(), { session: "service" }).evidence,
  };
  const red = redactReport({ ...original, windows: { ...original.windows!, serviceIdentity: { account: "ACME\\alice.smith", session: "service" } } }, { users: ["alice.smith"], hosts: ["ACME"] });
  const text = raw(red);
  for (const leak of ["alice", "smith", "ACME", "1-2-3-1001", "192.168"]) assert.ok(!text.includes(leak), `${leak} is gone`);
  // A machine SID keeps only its class (windows-redact.ts, card A03b): its domain and account numbers go.
  assert.ok(text.includes("S-1-5-21-<domain>-<account>"), text);
  assert.equal(red.windows!.serviceIdentity.account, "<user>");
  assert.deepEqual([red.implementationCommit, red.generatedAt, red.platform, red.osVersion, red.cases.map((c) => [c.id, c.verdict])], [original.implementationCommit, original.generatedAt, original.platform, original.osVersion, original.cases.map((c) => [c.id, c.verdict])]);
  assert.ok("report" in parseReport(text));
  assert.deepEqual(blockers(red), blockers(original));
});

test("a case detail that redaction makes longer than 400 characters is cut to fit, so the redacted report still reads as a report", () => {
  const detail = "PC\\ab ".repeat(50);
  assert.ok(detail.length <= 400);
  const original: ContainmentReport = { ...winReport(), cases: winReport().cases.map((c) => ({ ...c, detail })), windows: windowsEvidenceFromSummary(summary(), { session: "service" }).evidence };
  const red = redactReport(original, { users: ["ab"], hosts: ["PC"] });
  assert.ok(red.cases.every((c) => c.detail.length <= 400 && !/\bab\b/.test(c.detail)), red.cases[0]!.detail);
  assert.ok("report" in parseReport(raw(red)), JSON.stringify(parseReport(raw(red))));
});
