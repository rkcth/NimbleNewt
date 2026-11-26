import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { REQUIRED_CASE_IDS, assessRelease, isLinkRightInconclusive, parseReport, type CaseResult, type ContainmentReport, type NativeWindowsEvidence } from "./containment.js";
import { attachNativeWindowsEvidence, grantsReadBackOf, nativeWindowsEvidence, type NativeEvidenceInput } from "./containment-windows-native-evidence.js";

// Card A03b: the Windows release gate on AppContainer-era evidence (owner decision 2026-11-26: keep the AppContainer launcher, no Windows Sandbox).
// The fixtures below are the owner's real-PC run (own-hardware run 45881452017, commit 276883c4, Windows 10.0.26200 x64, home-desktop mode), copied byte for byte from its redacted results zip:
// the report containment-win32.json, the launcher's info line (info.stdout.txt) and the bundle's bin/nn-launcher.record.json; the launcher's SHA-256 is that of the bundle's bin/nn-launcher.exe.

const ROB_COMMIT = "276883c4e91a1381be35fe3e648a39c83bdfff43";
const NOW = new Date("2026-11-26T20:00:00Z");
const ROB_REPORT_TEXT = JSON.stringify({
  schema: "nimblenewt.containment/1", generatedAt: "2026-11-26T19:11:02.479Z", implementationCommit: ROB_COMMIT, dirty: false, platform: "win32", arch: "x64", osVersion: "10.0.26200",
  backend: "windows-native", capacityAvailable: true, weakerThanLinux: true,
  cases: [
    { id: "control-write-own-directories", category: "control", verdict: "pass", detail: "held" },
    { id: "control-read-own-decoy", category: "control", verdict: "pass", detail: "held" },
    { id: "deny-write-system", category: "workspace-write", verdict: "pass", detail: "held" },
    { id: "deny-write-host-path", category: "workspace-write", verdict: "pass", detail: "held; the same attempt got through without the sandbox" },
    { id: "deny-symlink-read", category: "symlink-escape", verdict: "inconclusive", detail: "without the sandbox the same attempt did not get through (link-abs-file: skipped not-planted), so a refusal would prove nothing" },
    { id: "deny-symlink-write", category: "symlink-escape", verdict: "inconclusive", detail: "without the sandbox the same attempt did not get through (link-write: skipped not-planted), so a refusal would prove nothing" },
    { id: "deny-credential-read", category: "credential-read", verdict: "pass", detail: "held; the same attempt got through without the sandbox" },
    { id: "deny-controller-data-read", category: "controller-data", verdict: "pass", detail: "held; the same attempt got through without the sandbox" },
    { id: "deny-network-loopback", category: "network-route", verdict: "pass", detail: "held; the same attempt got through without the sandbox" },
    { id: "deny-write-protected-name", category: "protected-name", verdict: "pass", detail: "held; the same attempt got through without the sandbox" },
  ],
  trustedHost: { mode: "trusted-host", authority: "G05 containment evidence (the suite's own test authority)", reachesHostFiles: true, refusedWithoutAuthority: true },
});
const ROB_INFO = `{"tool":"nn-appc-launcher","version":1,"command":"info","elevated":false,"sessionId":1,"lpac":false,"aapPolicy":"none","win32kOff":false,"killOnClose":true,"memoryMb":0,"activeProcessLimit":0,"uiLimits":false,"timeoutMs":120000,"profileName":"NimbleNewtRun-4db40ddb69069943","containerSid":"S-1-15-2-2330348732-3176499392-816954297-2070859299-3906479065-2013341710-3914432234","profile":"created","windowStation":"home-desktop","privateStationError":"window objects: the private window station could not be made (error 5) (Microsoft documents that only members of Administrators may name a window station)","windowStationOk":true,"profileDeleted":true,"profileGone":true,"profileDeleteHr":0,"ok":true}\n`;
const ROB_RECORD = JSON.stringify({
  schema: "nimblenewt.native-launcher-record/1", file: "nn-launcher.exe", size: 320512, sha256: "4e2fed501c995ea123b940ceb78e0099d89c50acf2b926534547ce012221408b", sourceCommit: ROB_COMMIT,
  toolchain: "1.99.1", cargoLockSha256: "5c5fa13a28a4ecc210101a17af8b42f6f6f25935ab12ca8bfa9e27dc95c10743", features: [],
}, null, 2);
const ROB_LAUNCHER_SHA = "4e2fed501c995ea123b940ceb78e0099d89c50acf2b926534547ce012221408b";
/** A run record as windows-native-job.ts writes it after a clean run. */
const cleanRun = (n: number): string => JSON.stringify({ runId: `r${n}`, mode: "native", container: "appcontainer", startedAt: "2026-11-26T19:10:50.000Z", childStarted: true, exitCode: 0, timedOut: false, grants: [], softRefused: [], entriesLeft: [], readBack: "clean", profile: { name: `NimbleNewtRun-${String(n).padStart(16, "0")}`, deleted: true, gone: true }, windowStation: "home-desktop" });

const robReport = (): ContainmentReport => { const p = parseReport(ROB_REPORT_TEXT); assert.ok("report" in p, JSON.stringify(p)); return p.report; };
/**
 * The real files plus the measurements that run did NOT make (it recorded no account kind, no run records, no leftover count as data, no working-directory or supervisor-ACL check). They are
 * supplied here to show the gate's rule for a run of the same shape that does record them; the real run alone is refused (test below).
 */
const fullInput = (over: Partial<NativeEvidenceInput> = {}): NativeEvidenceInput => ({
  infoRaw: ROB_INFO, recordRaw: ROB_RECORD, launcherSha256: ROB_LAUNCHER_SHA,
  runRecordsRaw: [cleanRun(1), cleanRun(2)], leftoverProfiles: 0, accountKind: "standard", symlinkRight: false,
  workdirRaw: JSON.stringify({ schema: "nimblenewt.g05-workdir/1", packaged: true, passed: true }), supervisorAcl: "strict", ...over,
});
function withEvidence(report: ContainmentReport, input: NativeEvidenceInput = fullInput()): ContainmentReport {
  const made = attachNativeWindowsEvidence(report, input);
  assert.ok("report" in made, JSON.stringify(made));
  // What the gate reads is what a file holds: written out and parsed back.
  const p = parseReport(JSON.stringify(made.report));
  assert.ok("report" in p, JSON.stringify(p));
  return p.report;
}
const gate = (r: ContainmentReport, commit = ROB_COMMIT) => assessRelease([r], { commit, now: NOW, platforms: ["win32"] });
const refused = (r: ContainmentReport, pattern: RegExp, commit = ROB_COMMIT): void => {
  const g = gate(r, commit);
  assert.equal(g.ok, false, `must refuse (${pattern})`);
  assert.ok(g.blockers.some((b) => pattern.test(b)), `${pattern}: ${g.blockers.join(" | ")}`);
};
/** The report without one optional field (exactOptionalPropertyTypes: a field set to undefined is not the same as no field). */
const without = (r: ContainmentReport, key: "nativeWindows" | "trustedHost"): ContainmentReport => { const copy: Record<string, unknown> = { ...r }; delete copy[key]; return copy as unknown as ContainmentReport; };
const withNative = (r: ContainmentReport, change: (n: NativeWindowsEvidence) => NativeWindowsEvidence): ContainmentReport => ({ ...r, nativeWindows: change(r.nativeWindows!) });
const withCase = (r: ContainmentReport, id: string, change: (c: CaseResult) => CaseResult | undefined): ContainmentReport =>
  ({ ...r, cases: r.cases.flatMap((c) => (c.id === id ? (change(c) === undefined ? [] : [change(c)!]) : [c])) });
const hosted = (): ContainmentReport => withEvidence({ ...robReport(), cases: robReport().cases.map((c) => ({ ...c, verdict: "pass", detail: "held; the same attempt got through without the sandbox" })) }, fullInput({ symlinkRight: true }));

describe("A03b Windows release gate: what passes", () => {
  test("the owner's real report (8 pass, the 2 file-link cases inconclusive for want of the link right) passes once the block is complete, and the 2 are listed as accepted, not passed", () => {
    const g = gate(withEvidence(robReport()));
    assert.deepEqual(g.blockers, []);
    assert.equal(g.ok, true);
    assert.equal(g.platforms["win32"], true);
    assert.equal(g.accepted.length, 2);
    assert.ok(g.accepted.every((a) => /inconclusive, accepted: the account lacks SeCreateSymbolicLinkPrivilege/.test(a)), g.accepted.join(" | "));
    assert.ok(g.accepted.some((a) => /deny-symlink-read/.test(a)) && g.accepted.some((a) => /deny-symlink-write/.test(a)));
  });
  test("the hosted de-elevated rehearsal shape (10/10) passes with nothing accepted", () => {
    const g = gate(hosted());
    assert.deepEqual(g.blockers, []);
    assert.deepEqual(g.accepted, []);
  });
  test("the assembler reads the real info line and release record as they are", () => {
    const made = nativeWindowsEvidence(fullInput());
    assert.ok("evidence" in made, JSON.stringify(made));
    const e = made.evidence;
    assert.deepEqual(e.launcher, { recordCommit: ROB_COMMIT, recordSha256: ROB_LAUNCHER_SHA, fileSha256: ROB_LAUNCHER_SHA });
    assert.deepEqual([e.elevated, e.sessionId, e.windowStation, e.windowStationOk], [false, 1, "home-desktop", true]);
    assert.deepEqual(e.profiles, { created: true, deleted: true, gone: true, leftover: 0 });
    assert.equal(e.grantsReadBack, "clean");
    assert.deepEqual(made.notProven, ["a run attempted after the owner signs out is refused cleanly and leaves nothing (the hold / sign-out step; not required by the gate in this slice)"]);
  });
});

describe("A03b Windows release gate: the owner's real run as it is", () => {
  test("the report alone (no native block) is refused, and its file-link cases are not excused without a recorded link right", () => {
    const g = gate(robReport());
    assert.equal(g.ok, false);
    assert.ok(g.blockers.some((b) => /native Windows host evidence is missing/.test(b)), g.blockers.join(" | "));
    assert.ok(g.blockers.some((b) => /deny-symlink-read: inconclusive/.test(b)) && g.blockers.some((b) => /deny-symlink-write: inconclusive/.test(b)));
    assert.deepEqual(g.accepted, []);
  });
  test("with only what that run recorded as data (info line, record, launcher hash) the gate names exactly what is still unmeasured", () => {
    const made = attachNativeWindowsEvidence(robReport(), { infoRaw: ROB_INFO, recordRaw: ROB_RECORD, launcherSha256: ROB_LAUNCHER_SHA });
    assert.ok("report" in made);
    const b = gate(made.report).blockers.map((x) => x.replace(/^win32: /, ""));
    const want = [/^case deny-symlink-read: inconclusive .*recorded that the account lacks/, /^case deny-symlink-write: inconclusive .*recorded that the account lacks/, /kind of account .* is not recorded/,
      /NimbleNewtRun-\* container profiles left after the run were not counted/, /read-back after each run is not recorded/, /not run on the packaged controller/, /supervisor-ACL check was not-run/];
    assert.equal(b.length, want.length, b.join("\n"));
    for (const w of want) assert.ok(b.some((x) => w.test(x)), `${w}: ${b.join(" | ")}`);
    assert.equal(made.notProven.length, 7, made.notProven.join(" | "));
  });
});

describe("A03b Windows release gate: every refusal (fail closed)", () => {
  const good = (): ContainmentReport => withEvidence(robReport());
  test("provenance: another commit, a dirty tree, a launcher record for another commit, a launcher that is not the recorded one", () => {
    refused(good(), /the evidence is for commit 276883c4e91a, not bbbbbbbbbbbb/, "b".repeat(40));
    refused({ ...good(), dirty: true }, /uncommitted changes/);
    refused(withNative(good(), (n) => ({ ...n, launcher: { ...n.launcher, recordCommit: "c".repeat(40) } })), /release record is for commit cccccccccccc/);
    refused(withNative(good(), (n) => ({ ...n, launcher: { ...n.launcher, fileSha256: "0".repeat(64) } })), /does not match its release record/);
    refused(withEvidence(robReport(), fullInput({ launcherSha256: "1".repeat(64) })), /does not match its release record/);
  });
  test("account and session: elevated, account kind not recorded, the services session, no window objects or an unknown mode", () => {
    refused(withNative(good(), (n) => ({ ...n, elevated: true })), /was elevated/);
    refused(withEvidence(robReport(), fullInput({ infoRaw: ROB_INFO.replace('"elevated":false', '"elevated":true') })), /was elevated/);
    refused(withNative(good(), (n) => ({ ...n, accountKind: "not-measured" })), /kind of account/);
    refused(withNative(good(), (n) => ({ ...n, sessionId: 0 })), /services session \(session 0\)/);
    refused(withEvidence(robReport(), fullInput({ infoRaw: ROB_INFO.replace('"sessionId":1', '"sessionId":0') })), /services session/);
    refused(withNative(good(), (n) => ({ ...n, windowStationOk: false })), /windowStationOk is false/);
    refused(withNative(good(), (n) => ({ ...n, windowStation: "inherited" })), /window-object mode "inherited"/);
  });
  test("lifecycle: info's profile not created, not deleted, not gone; a leftover profile; leftovers not counted; grants left or not read back", () => {
    refused(withNative(good(), (n) => ({ ...n, profiles: { ...n.profiles, created: false } })), /did not create its throw-away/);
    refused(withNative(good(), (n) => ({ ...n, profiles: { ...n.profiles, deleted: false } })), /did not delete its throw-away/);
    refused(withNative(good(), (n) => ({ ...n, profiles: { ...n.profiles, gone: false } })), /did not delete its throw-away/);
    refused(withEvidence(robReport(), fullInput({ infoRaw: ROB_INFO.replace('"profileGone":true', '"profileGone":false') })), /did not delete its throw-away/);
    refused(withNative(good(), (n) => ({ ...n, profiles: { ...n.profiles, leftover: 1 } })), /1 NimbleNewtRun-\* container profile\(s\) were left/);
    refused(withNative(good(), (n) => ({ ...n, profiles: { ...n.profiles, leftover: null } })), /were not counted/);
    refused(withNative(good(), (n) => ({ ...n, grantsReadBack: "left" })), /still present after a run/);
    refused(withNative(good(), (n) => ({ ...n, grantsReadBack: "not-measured" })), /read-back after each run is not recorded/);
  });
  test("kept from the Windows Sandbox era: the packaged working-directory check and the strict supervisor-ACL check", () => {
    refused(withNative(good(), (n) => ({ ...n, packagedControllerWorkingDirectory: { packaged: false, passed: true } })), /not run on the packaged controller/);
    refused(withNative(good(), (n) => ({ ...n, packagedControllerWorkingDirectory: { packaged: true, passed: false } })), /working-directory check failed/);
    refused(withNative(good(), (n) => ({ ...n, supervisorAclCheck: "report-only" })), /supervisor-ACL check was report-only/);
    refused(withNative(good(), (n) => ({ ...n, supervisorAclCheck: "not-run" })), /supervisor-ACL check was not-run/);
  });
  test("cases: every one missing, failing or not_run blocks; a duplicate blocks", () => {
    for (const id of REQUIRED_CASE_IDS) {
      refused(withCase(good(), id, () => undefined), new RegExp(`case ${id} is missing`));
      refused(withCase(good(), id, (c) => ({ ...c, verdict: "fail", detail: "got through" })), new RegExp(`case ${id}: fail`));
      refused(withCase(good(), id, (c) => ({ ...c, verdict: "not_run", detail: "no capacity" })), new RegExp(`case ${id}: not_run`));
    }
    refused({ ...good(), cases: [...good().cases, good().cases[0]!] }, /appears twice/);
  });
  test("inconclusive: only the two file-link cases, only for a FILE link not planted, only when the run recorded the account lacks the right", () => {
    // The right held (or not recorded): a file link not planted is not excused.
    refused(withNative(good(), (n) => ({ ...n, symlinkRight: true })), /deny-symlink-read: inconclusive .*recorded that the account lacks/);
    refused(withNative(good(), (n) => ({ ...n, symlinkRight: null })), /deny-symlink-write: inconclusive .*recorded that the account lacks/);
    // A junction (no privilege needed) not planted is never excused.
    refused(withCase(good(), "deny-symlink-read", (c) => ({ ...c, detail: c.detail.replace("link-abs-file", "link-abs-dir") })), /case deny-symlink-read: inconclusive/);
    refused(withCase(good(), "deny-symlink-write", (c) => ({ ...c, detail: c.detail.replace("link-write", "link-dir") })), /case deny-symlink-write: inconclusive/);
    // Any other inconclusive reason in the same cases blocks.
    refused(withCase(good(), "deny-symlink-read", (c) => ({ ...c, detail: "the attempt timed out" })), /case deny-symlink-read: inconclusive \(the attempt timed out\)/);
    refused(withCase(good(), "deny-symlink-write", (c) => ({ ...c, detail: `${c.detail} ` })), /case deny-symlink-write: inconclusive/);
    // The same wording on any other case blocks.
    for (const id of REQUIRED_CASE_IDS.filter((x) => x !== "deny-symlink-read" && x !== "deny-symlink-write")) {
      refused(withCase(good(), id, (c) => ({ ...c, verdict: "inconclusive", detail: robReport().cases[4]!.detail })), new RegExp(`case ${id}: inconclusive`));
    }
    // A file-link case that FAILED (the link was planted and got through) is a failure, whatever the right.
    refused(withCase(good(), "deny-symlink-read", (c) => ({ ...c, verdict: "fail" })), /case deny-symlink-read: fail/);
    // The exception is Windows-only: the same case on Linux blocks.
    const linux: ContainmentReport = { ...without(hosted(), "nativeWindows"), platform: "linux", backend: "bubblewrap", weakerThanLinux: false, cases: robReport().cases };
    const g = assessRelease([linux], { commit: ROB_COMMIT, now: NOW, platforms: ["linux"] });
    assert.ok(g.blockers.some((b) => /linux: case deny-symlink-read: inconclusive/.test(b)), g.blockers.join(" | "));
    assert.equal(isLinkRightInconclusive(robReport().cases[4]!), true);
    assert.equal(isLinkRightInconclusive(robReport().cases[0]!), false);
  });
  test("the backend, the boundary statement, the trusted-host pairing and the old block", () => {
    refused({ ...good(), backend: "windows-sandbox" }, /only the native AppContainer launcher/);
    refused({ ...good(), weakerThanLinux: false }, /process-level and weaker/);
    refused(without(good(), "trustedHost"), /exception is not recorded/);
    refused({ ...good(), trustedHost: { ...good().trustedHost!, reachesHostFiles: false } }, /was not shown/);
    refused({ ...good(), capacityAvailable: false }, /no capacity/);
    refused(without(good(), "nativeWindows"), /native Windows host evidence is missing/);
    refused({ ...good(), windows: { serviceIdentity: { account: "s", session: "service" }, afterLogout: { launch: true, exec: true, results: true, teardown: true }, afterReboot: { launch: true, exec: true, results: true, teardown: true }, mappedOutputAcl: { positive: true, negative: true }, packagedControllerWorkingDirectory: { packaged: true, passed: true }, supervisorAclCheck: "strict" } }, /Windows Sandbox era evidence block/);
    refused({ ...good(), generatedAt: "2026-10-01T00:00:00Z" }, /more than 30 days/);
  });
  test("nothing is accepted when the gate refuses", () => assert.deepEqual(gate({ ...good(), dirty: true }).accepted, []));
});

describe("A03b native Windows evidence: read as data", () => {
  test("a malformed block is refused by parseReport (each field)", () => {
    const base = JSON.parse(JSON.stringify(withEvidence(robReport()))) as Record<string, unknown>;
    const bad = (change: (n: Record<string, unknown>) => void): void => {
      const copy = JSON.parse(JSON.stringify(base)) as { nativeWindows: Record<string, unknown> };
      change(copy.nativeWindows);
      const p = parseReport(JSON.stringify(copy));
      assert.ok("error" in p && /nativeWindows/.test(p.error), JSON.stringify(copy.nativeWindows).slice(0, 200));
    };
    bad((n) => { delete n["launcher"]; });
    bad((n) => { (n["launcher"] as Record<string, unknown>)["fileSha256"] = ROB_LAUNCHER_SHA.toUpperCase(); });
    bad((n) => { (n["launcher"] as Record<string, unknown>)["recordCommit"] = "abc"; });
    bad((n) => { n["elevated"] = "no"; });
    bad((n) => { n["accountKind"] = "admin"; });
    bad((n) => { n["sessionId"] = -1; });
    bad((n) => { n["sessionId"] = 1.5; });
    bad((n) => { n["windowStation"] = "home\u202e"; });
    bad((n) => { (n["profiles"] as Record<string, unknown>)["leftover"] = -1; });
    bad((n) => { delete (n["profiles"] as Record<string, unknown>)["gone"]; });
    bad((n) => { n["grantsReadBack"] = "unreadable"; });
    bad((n) => { n["symlinkRight"] = "no"; });
    bad((n) => { delete n["supervisorAclCheck"]; });
    bad((n) => { delete n["packagedControllerWorkingDirectory"]; });
  });
  test("the assembler refuses what it cannot read, and only fills a native Windows report", () => {
    const err = (input: Partial<NativeEvidenceInput>, pattern: RegExp): void => { const m = nativeWindowsEvidence(fullInput(input)); assert.ok("error" in m && pattern.test(m.error), JSON.stringify(m)); };
    err({ infoRaw: "launcher printed nothing useful" }, /no info line/);
    err({ infoRaw: ROB_INFO.replace('"command":"info"', '"command":"run"') }, /no info line/);
    err({ infoRaw: ROB_INFO.replace('"ok":true', '"ok":false') }, /did not succeed/);
    err({ infoRaw: ROB_INFO.replace('"sessionId":1,', "") }, /does not say elevated, sessionId/);
    err({ recordRaw: "{" }, /not JSON/);
    err({ recordRaw: ROB_RECORD.replace("native-launcher-record/1", "other/1") }, /release record is not/);
    err({ launcherSha256: "xyz" }, /64 lower-case hex/);
    err({ workdirRaw: "{}" }, /working-directory/);
    assert.ok("error" in attachNativeWindowsEvidence({ ...robReport(), platform: "linux" }, fullInput()));
    assert.ok("error" in attachNativeWindowsEvidence({ ...robReport(), backend: "windows-sandbox" }, fullInput()));
    // A launcher's last info line counts (an earlier line of another tool or a broken line is skipped).
    const m = nativeWindowsEvidence(fullInput({ infoRaw: `{"tool":"other","command":"info"}\n{broken\n${ROB_INFO}` }));
    assert.ok("evidence" in m);
  });
  test("grant read-back over the run records: clean only when every record is clean", () => {
    assert.equal(grantsReadBackOf([cleanRun(1), cleanRun(2)]).state, "clean");
    assert.equal(grantsReadBackOf([]).state, "not-measured");
    assert.equal(grantsReadBackOf([cleanRun(1), cleanRun(2).replace('"readBack":"clean"', '"readBack":"left"')]).state, "left");
    assert.equal(grantsReadBackOf([cleanRun(1).replace('"entriesLeft":[]', '"entriesLeft":["C:\\\\x"]')]).state, "left");
    assert.equal(grantsReadBackOf([cleanRun(1).replace('"timedOut":false', '"timedOut":false,"failure":{"kind":"revoke","message":"m"}')]).state, "left");
    assert.equal(grantsReadBackOf([cleanRun(1).replace('"readBack":"clean"', '"readBack":"unreadable"')]).state, "not-measured");
    assert.equal(grantsReadBackOf([cleanRun(1).replace('"mode":"native"', '"mode":"wsb"')]).state, "not-measured");
    assert.equal(grantsReadBackOf(["{"]).state, "not-measured");
    const m = nativeWindowsEvidence(fullInput({ runRecordsRaw: [cleanRun(1).replace('"readBack":"clean"', '"readBack":"left"')] }));
    assert.ok("evidence" in m && m.evidence.grantsReadBack === "left");
  });
});
