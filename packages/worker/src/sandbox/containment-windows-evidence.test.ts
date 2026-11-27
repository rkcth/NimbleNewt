import assert from "node:assert/strict";
import { test } from "node:test";
import { CONTAINMENT_SCHEMA, REQUIRED_CASE_IDS, assessRelease, parseReport, type ContainmentReport, type WindowsEvidence } from "./containment.js";
import { parseWorkdirCheck, redactReport } from "./containment-windows-evidence.js";

// Card G05: reading the working-directory check's output and redacting a report for a public artifact. Pure rules. (The Windows Sandbox era producer of the `windows` block and its tests were
// removed with that backend, owner decision 2026-11-26; the gate's refusal of such a block is tested in containment.test.ts and containment-native-gate.test.ts.)
const COMMIT = "c".repeat(40);
const raw = (v: unknown): string => JSON.stringify(v);
const winReport = (): ContainmentReport => ({
  schema: CONTAINMENT_SCHEMA, generatedAt: new Date().toISOString(), implementationCommit: COMMIT, dirty: false, platform: "win32", arch: "x64", osVersion: "10.0.26200", backend: "windows-sandbox",
  capacityAvailable: true, weakerThanLinux: false, cases: REQUIRED_CASE_IDS.map((id) => ({ id, category: "control", verdict: "pass", detail: "held" })),
  trustedHost: { mode: "trusted-host", authority: "owner", reachesHostFiles: true, refusedWithoutAuthority: true },
});
/** An old report's Windows Sandbox era block, as such reports carried it (still parsed, so the gate can refuse it by name). */
const oldWindowsBlock = (account = "<user>"): WindowsEvidence => ({
  serviceIdentity: { account, session: "service" },
  afterLogout: { launch: false, exec: false, results: false, teardown: false }, afterReboot: { launch: false, exec: false, results: false, teardown: false },
  mappedOutputAcl: { positive: true, negative: true }, packagedControllerWorkingDirectory: { packaged: false, passed: false }, supervisorAclCheck: "strict", featureEnabledOnly: false,
});
const blockers = (r: ContainmentReport): string[] => [...assessRelease([r], { commit: COMMIT, platforms: ["win32"] }).blockers];

test("the working-directory check is read as data; malformed or oversized output is refused with a reason", () => {
  assert.deepEqual(parseWorkdirCheck(raw({ schema: "nimblenewt.g05-workdir/1", packaged: false, passed: true, problems: [] })), { packaged: false, passed: true });
  for (const bad of ["[", raw({ schema: "nimblenewt.g05-workdir/1", packaged: "no", passed: true }), raw({ packaged: true, passed: true }), raw({ schema: "nimblenewt.g05-workdir/1", packaged: true, passed: true, pad: "x".repeat(70_000) })]) {
    assert.ok("error" in parseWorkdirCheck(bad), bad.slice(0, 60));
  }
});

test("redacting a report hides names in its free text only; the gate judges the redacted report exactly as the original", () => {
  const original: ContainmentReport = {
    ...winReport(), capacityReason: "the console user ACME\\alice.smith is not the owner", osVersion: "10.0.26200",
    cases: winReport().cases.map((c, i) => (i === 0 ? { ...c, detail: "wrote C:\\Users\\alice.smith\\work\\ok.txt from S-1-5-21-1-2-3-1001 at 192.168.1.20" } : c)),
    trustedHost: { mode: "trusted-host", authority: "alice.smith", reachesHostFiles: true, refusedWithoutAuthority: true },
    windows: oldWindowsBlock(),
  };
  const red = redactReport({ ...original, windows: oldWindowsBlock("ACME\\alice.smith") }, { users: ["alice.smith"], hosts: ["ACME"] });
  const text = raw(red);
  for (const leak of ["alice", "smith", "ACME", "1-2-3-1001", "192.168"]) assert.ok(!text.includes(leak), `${leak} is gone`);
  // A machine SID keeps only its class (windows-redact.ts, card A03b): its domain and account numbers go.
  assert.ok(text.includes("S-1-5-21-<domain>-<account>"), text);
  assert.equal(red.windows!.serviceIdentity.account, "<user>");
  assert.deepEqual([red.implementationCommit, red.generatedAt, red.platform, red.osVersion, red.cases.map((c) => [c.id, c.verdict])], [original.implementationCommit, original.generatedAt, original.platform, original.osVersion, original.cases.map((c) => [c.id, c.verdict])]);
  assert.ok("report" in parseReport(text));
  assert.deepEqual(blockers(red), blockers(original));
  assert.ok(blockers(red).some((x) => /Windows Sandbox era evidence block/.test(x)));
});

test("a case detail that redaction makes longer than 400 characters is cut to fit, so the redacted report still reads as a report", () => {
  const detail = "PC\\ab ".repeat(50);
  assert.ok(detail.length <= 400);
  const original: ContainmentReport = { ...winReport(), cases: winReport().cases.map((c) => ({ ...c, detail })) };
  const red = redactReport(original, { users: ["ab"], hosts: ["PC"] });
  assert.ok(red.cases.every((c) => c.detail.length <= 400 && !/\bab\b/.test(c.detail)), red.cases[0]!.detail);
  assert.ok("report" in parseReport(raw(red)), JSON.stringify(parseReport(raw(red))));
});
