import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, test } from "node:test";
import { AFTER_SIGNOUT_REQUIRED, REQUIRED_CASE_IDS, afterSignOutProblems, assessRelease, isLinkRightInconclusive, parseReport, type AfterSignOutEvidence, type CaseResult, type ContainmentReport, type NativeWindowsEvidence } from "./containment.js";
import { redactReport } from "./containment-windows-evidence.js";
import { AFTER_SIGNOUT_SCHEMA, PACKAGED_CONTROLLER_EXISTS, attachNativeWindowsEvidence, collectNativeEvidence, grantsReadBackOf, nativeWindowsEvidence, parseAfterSignOut, type NativeEvidenceInput } from "./containment-windows-native-evidence.js";

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
 * What the new scripts hand the assembler for a run like the owner's (run-g05.ps1 -> containment-evidence.mjs run --native-info ... --account-kind ... --symlink-right no; the collector reads the
 * launcher, its record, this run's records and the leftover profiles): the real info line, record and launcher hash, plus the facts that run did NOT record as data then (account kind, run records,
 * leftover count as a number, the link right). The account kind is not known for the owner's PC: "administrator-filtered" stands in (either kind passes). No working-directory check is run (no
 * packaged controller exists, card K03), so the block says packaged:false and the gate accepts it as "not yet measurable".
 */
const fullInput = (over: Partial<NativeEvidenceInput> = {}): NativeEvidenceInput => ({
  infoRaw: ROB_INFO, recordRaw: ROB_RECORD, launcherSha256: ROB_LAUNCHER_SHA,
  runRecordsRaw: [cleanRun(1), cleanRun(2)], leftoverProfiles: 0, accountKind: "administrator-filtered", symlinkRight: false, ...over,
});
const PACKAGED_OK = JSON.stringify({ schema: "nimblenewt.g05-workdir/1", packaged: true, passed: true });
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
/** What `run-g05.ps1 -AfterSignIn` writes when the sign-out check holds (windows-native-signout.ts afterSignIn): the task stopped by the sign-out, swept, recorded as interrupted. */
const GOOD_AFTER: AfterSignOutEvidence = { held: true, newLogon: true, taskRunningAfter: false, profileLeftBeforeSweep: true, sweepProblems: 0, leftoverAfterSweep: 0, grantsAfter: "clean", interruptedRecorded: true };
const afterRaw = (over: Partial<Record<keyof AfterSignOutEvidence, unknown>> = {}): string => JSON.stringify({ schema: AFTER_SIGNOUT_SCHEMA, afterSignOut: { ...GOOD_AFTER, ...over } });
const hosted = (): ContainmentReport => withEvidence({ ...robReport(), cases: robReport().cases.map((c) => ({ ...c, verdict: "pass", detail: "held; the same attempt got through without the sandbox" })) }, fullInput({ symlinkRight: true }));

describe("A03b Windows release gate: what passes", () => {
  test("the owner's real report (8 pass, the 2 file-link cases inconclusive for want of the link right) as the new scripts produce it passes, with three items accepted, not passed", () => {
    const g = gate(withEvidence(robReport()));
    assert.deepEqual(g.blockers, []);
    assert.equal(g.ok, true);
    assert.equal(g.platforms["win32"], true);
    assert.deepEqual(g.accepted, [
      "win32: case deny-symlink-read inconclusive, accepted: the account lacks SeCreateSymbolicLinkPrivilege, so its file link was not planted and that attempt was not judged (the case's junction attempts were refused)",
      "win32: case deny-symlink-write inconclusive, accepted: the account lacks SeCreateSymbolicLinkPrivilege, so its file link was not planted and that attempt was not judged (the case's junction attempts were refused)",
      "win32: the packaged controller working-directory check: not a pass: not yet measurable (no packaged controller release exists yet)",
    ]);
    // run-g05.ps1 always runs with --redact: the redacted report written to results\ reads back and passes the same way.
    const redacted = parseReport(JSON.stringify(redactReport(withEvidence(robReport()), { users: ["robert"] })));
    assert.ok("report" in redacted && redacted.report.nativeWindows !== undefined);
    assert.deepEqual(gate(redacted.report).accepted, g.accepted);
    // A standard account passes the same way.
    assert.equal(gate(withEvidence(robReport(), fullInput({ accountKind: "standard" }))).ok, true);
  });
  test("the hosted de-elevated rehearsal shape (10/10) passes with only the working-directory item accepted; with a passing packaged check nothing is accepted", () => {
    const g = gate(hosted());
    assert.deepEqual(g.blockers, []);
    assert.deepEqual(g.accepted, ["win32: the packaged controller working-directory check: not a pass: not yet measurable (no packaged controller release exists yet)"]);
    const full = gate(withEvidence(hosted(), fullInput({ symlinkRight: true, workdirRaw: PACKAGED_OK })));
    assert.deepEqual([full.ok, full.accepted], [true, []]);
  });
  test("the working-directory check: packaged:false (no packaged controller) is accepted whatever passed says; packaged and failed is refused; not recorded is refused", () => {
    assert.equal(PACKAGED_CONTROLLER_EXISTS, false, "no packaged controller release is built yet; when one is, this flips and packaged:false is refused");
    for (const passed of [true, false]) assert.equal(gate(withEvidence(robReport(), fullInput({ workdirRaw: JSON.stringify({ schema: "nimblenewt.g05-workdir/1", packaged: false, passed }) }))).ok, true);
    refused(withEvidence(robReport(), fullInput({ workdirRaw: JSON.stringify({ schema: "nimblenewt.g05-workdir/1", packaged: true, passed: false }) })), /packaged controller working-directory check failed/);
    // Once a packaged controller exists, no check output means no measurement: refused.
    refused(withEvidence(robReport(), fullInput({ packagedControllerExists: true })), /working-directory check is not recorded/);
    assert.equal(gate(withEvidence(robReport(), fullInput({ packagedControllerExists: true, workdirRaw: PACKAGED_OK }))).ok, true);
    // And the gate itself: once a packaged controller exists, a report that says packaged:false (made by an older bundle, or written by hand) is refused, not accepted.
    const unpackaged = withEvidence(robReport());
    const g = assessRelease([unpackaged], { commit: ROB_COMMIT, now: NOW, platforms: ["win32"], packagedControllerExists: true });
    assert.equal(g.ok, false);
    assert.ok(g.blockers.some((b) => /was not run on the packaged controller/.test(b)), g.blockers.join(" | "));
  });
  test("the packaged-controller exception cannot outlive the release decision: card D03 (release readiness) is not flipped while PACKAGED_CONTROLLER_EXISTS is false", () => {
    const plan = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../docs/nimblenewt/implementation-plan/task-plan.json", import.meta.url)), "utf8")) as { tasks: { id: string; status: string }[] };
    const d03 = plan.tasks.find((t) => t.id === "D03");
    assert.ok(d03 !== undefined, "card D03 is in task-plan.json");
    if (!PACKAGED_CONTROLLER_EXISTS) assert.equal(d03.status, "planned", "build the packaged controller, run g05-workdir-check.mjs on it in the owner run, and set PACKAGED_CONTROLLER_EXISTS to true before D03");
  });
  test("the assembler reads the real info line and release record as they are", () => {
    const made = nativeWindowsEvidence(fullInput());
    assert.ok("evidence" in made, JSON.stringify(made));
    const e = made.evidence;
    assert.deepEqual(e.launcher, { recordCommit: ROB_COMMIT, recordSha256: ROB_LAUNCHER_SHA, fileSha256: ROB_LAUNCHER_SHA });
    assert.deepEqual([e.elevated, e.sessionId, e.windowStation, e.windowStationOk], [false, 1, "home-desktop", true]);
    assert.deepEqual(e.profiles, { created: true, deleted: true, gone: true, leftover: 0 });
    assert.equal(e.grantsReadBack, "clean");
    assert.equal(e.packagedControllerWorkingDirectory?.packaged, false);
    assert.deepEqual(made.notProven, ["the working-directory check on a packaged controller (none exists yet)", "a run attempted after the owner signs out is refused cleanly and leaves nothing (the hold / sign-out step; not required by the gate in this slice)"]);
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
      /NimbleNewtRun-\* container profiles left after the run were not counted/, /read-back after each run is not recorded/];
    assert.equal(b.length, want.length, b.join("\n"));
    for (const w of want) assert.ok(b.some((x) => w.test(x)), `${w}: ${b.join(" | ")}`);
    assert.equal(made.notProven.length, 6, made.notProven.join(" | "));
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
  test("kept from the Windows Sandbox era: the packaged working-directory check (measured and failed, or not recorded, refuses); the strict supervisor-ACL check is dropped", () => {
    refused(withNative(good(), (n) => ({ ...n, packagedControllerWorkingDirectory: { packaged: true, passed: false } })), /working-directory check failed/);
    refused(withNative(good(), (n) => ({ ...n, packagedControllerWorkingDirectory: null })), /working-directory check is not recorded/);
    assert.ok(!gate(good()).blockers.some((b) => /supervisor-ACL/.test(b)));
    assert.ok(!("supervisorAclCheck" in good().nativeWindows!), "the native block has no supervisor-ACL field");
  });
  test("cases: every one missing, failing or not_run blocks; a duplicate blocks", () => {
    for (const id of REQUIRED_CASE_IDS) {
      refused(withCase(good(), id, () => undefined), new RegExp(`case ${id} is missing`));
      refused(withCase(good(), id, (c) => ({ ...c, verdict: "fail", detail: "got through" })), new RegExp(`case ${id}: fail`));
      refused(withCase(good(), id, (c) => ({ ...c, verdict: "not_run", detail: "no capacity" })), new RegExp(`case ${id}: not_run`));
    }
    refused({ ...good(), cases: [...good().cases, good().cases[0]!] }, /appears twice/);
    // A case the gate does not know blocks (a report holds the required cases only), whatever its verdict.
    for (const verdict of ["pass", "fail"] as const) refused({ ...good(), cases: [...good().cases, { id: "deny-something-else", category: "control", verdict, detail: "held" }] }, /deny-something-else is not one of the required cases/);
    // A spoofed id (case or space changed) is not the required case: the real one is missing.
    refused(withCase(good(), "deny-write-system", (c) => ({ ...c, id: "Deny-write-system" })), /case deny-write-system is missing/);
    refused(withCase(good(), "deny-write-system", (c) => ({ ...c, id: "deny-write-system " })), /case deny-write-system is missing/);
  });
  test("inconclusive: only the two file-link cases, only for a FILE link not planted, only when the run recorded the account lacks the right", () => {
    // The right held (or not recorded): a file link not planted is not excused.
    refused(withNative(good(), (n) => ({ ...n, symlinkRight: true })), /deny-symlink-read: inconclusive .*recorded that the account lacks/);
    refused(withNative(good(), (n) => ({ ...n, symlinkRight: null })), /deny-symlink-write: inconclusive .*recorded that the account lacks/);
    // A junction (no privilege needed) not planted is never excused.
    refused(withCase(good(), "deny-symlink-read", (c) => ({ ...c, detail: c.detail.replace("link-abs-file", "link-abs-dir") })), /case deny-symlink-read: inconclusive/);
    refused(withCase(good(), "deny-symlink-write", (c) => ({ ...c, detail: c.detail.replace("link-write", "link-dir") })), /case deny-symlink-write: inconclusive/);
    // A file link of the OTHER case is not this case's link (each case's own links only).
    refused(withCase(good(), "deny-symlink-write", (c) => ({ ...c, detail: c.detail.replace("link-write", "link-abs-file") })), /case deny-symlink-write: inconclusive/);
    refused(withCase(good(), "deny-symlink-read", (c) => ({ ...c, detail: c.detail.replace("link-abs-file", "link-write") })), /case deny-symlink-read: inconclusive/);
    // The second file link of the read case is accepted the same way.
    assert.equal(gate(withCase(good(), "deny-symlink-read", (c) => ({ ...c, detail: c.detail.replace("link-abs-file", "link-rel-key") }))).ok, true);
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
    bad((n) => { delete n["packagedControllerWorkingDirectory"]; });
    bad((n) => { n["packagedControllerWorkingDirectory"] = { packaged: "no", passed: true }; });
    bad((n) => { n["packagedControllerWorkingDirectory"] = true; });
    // No field the gate does not read, at any level.
    bad((n) => { n["supervisorAclCheck"] = "strict"; });
    bad((n) => { (n["launcher"] as Record<string, unknown>)["trusted"] = true; });
    bad((n) => { (n["profiles"] as Record<string, unknown>)["extra"] = 0; });
    bad((n) => { n["packagedControllerWorkingDirectory"] = { packaged: false, passed: false, note: "x" }; });
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

describe("A03b native Windows evidence: what the evidence run collects from disk", () => {
  /** A stand-in of the bundle, its control folder and %LOCALAPPDATA%\\Packages (POSIX paths: the collector takes the join to use). */
  function layout(t: { after: (fn: () => void) => void }) {
    const root = mkdtempSync(join(tmpdir(), "nn-a03b-native-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin"), control = join(root, "control"), packages = join(root, "Packages");
    for (const d of [bin, join(control, "records"), join(control, "raw"), packages]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, "nn-launcher.exe"), "launcher bytes");
    writeFileSync(join(bin, "nn-launcher.record.json"), ROB_RECORD);
    writeFileSync(join(control, "raw", "info.stdout.txt"), ROB_INFO);
    const src = { infoFile: join(control, "raw", "info.stdout.txt"), launcher: join(bin, "nn-launcher.exe"), controlDir: control, packagesDir: packages, since: new Date("2026-11-26T19:10:00Z") };
    return { root, bin, control, packages, src };
  }
  test("the launcher's own hash, its record, only this run's records and the leftover profiles are read; the two facts pass through", (t) => {
    const l = layout(t);
    writeFileSync(join(l.control, "records", "old.json"), cleanRun(9).replace("2026-11-26T19:10:50.000Z", "2026-11-25T10:00:00.000Z").replace('"readBack":"clean"', '"readBack":"left"'));
    writeFileSync(join(l.control, "records", "r1.json"), cleanRun(1));
    writeFileSync(join(l.packages, "microsoft.windows.photos_8wekyb3d8bbwe"), "");
    const input = collectNativeEvidence({ ...l.src, accountKind: "standard", symlinkRight: false }, join);
    assert.ok(!("error" in input), JSON.stringify(input));
    assert.equal(input.launcherSha256, createHash("sha256").update("launcher bytes").digest("hex"));
    assert.deepEqual([input.runRecordsRaw?.length, input.leftoverProfiles, input.accountKind, input.symlinkRight], [1, 0, "standard", false], "the older run's record (left) is not this run's");
    // The bytes on disk are not the released launcher: the gate refuses the hash.
    refused(withEvidence(robReport(), input), /does not match its release record/);
    // With the released launcher's hash the same collection passes.
    assert.equal(gate(withEvidence(robReport(), { ...input, launcherSha256: ROB_LAUNCHER_SHA })).ok, true);
  });
  test("a leftover profile is counted (case-insensitive moniker); an unreadable records folder or packages folder becomes not measured; no info, record or launcher is no block", (t) => {
    const l = layout(t);
    writeFileSync(join(l.control, "records", "r1.json"), cleanRun(1));
    mkdirSync(join(l.packages, "nimblenewtrun-00000000000000ab"));
    const counted = collectNativeEvidence(l.src, join);
    assert.ok(!("error" in counted) && counted.leftoverProfiles === 1);
    const noDirs = collectNativeEvidence({ ...l.src, controlDir: join(l.root, "absent"), packagesDir: join(l.root, "absent") }, join);
    assert.ok(!("error" in noDirs) && noDirs.runRecordsRaw === undefined && noDirs.leftoverProfiles === undefined);
    const made = attachNativeWindowsEvidence(robReport(), noDirs);
    assert.ok("report" in made && made.report.nativeWindows.grantsReadBack === "not-measured" && made.report.nativeWindows.profiles.leftover === null);
    // An empty records folder: no run of this evidence run recorded, not measured.
    rmSync(join(l.control, "records", "r1.json"));
    const empty = collectNativeEvidence(l.src, join);
    assert.ok(!("error" in empty) && empty.runRecordsRaw?.length === 0);
    // More records than the bound: not measured (names are random run ids, so no subset by name may stand for this run's records). A "left" record among them is never dropped by a slice.
    for (let i = 0; i < 1001; i++) writeFileSync(join(l.control, "records", `r${String(i).padStart(4, "0")}.json`), i === 0 ? cleanRun(i).replace('"readBack":"clean"', '"readBack":"left"') : cleanRun(i));
    const many = collectNativeEvidence(l.src, join);
    assert.ok(!("error" in many) && many.runRecordsRaw === undefined, "over the bound: not measured");
    rmSync(join(l.control, "records", "r1000.json"));
    const bound = collectNativeEvidence(l.src, join);
    assert.ok(!("error" in bound) && bound.runRecordsRaw?.length === 1000 && grantsReadBackOf(bound.runRecordsRaw).state === "left", "at the bound every record is read, the first by name included");
    for (const [change, why] of [[{ infoFile: join(l.root, "none") }, /info output/], [{ launcher: join(l.root, "none", "nn-launcher.exe") }, /release record/]] as const) {
      const r = collectNativeEvidence({ ...l.src, ...change }, join);
      assert.ok("error" in r && why.test(r.error), JSON.stringify(r));
    }
    rmSync(join(l.bin, "nn-launcher.exe"));
    const noExe = collectNativeEvidence(l.src, join);
    assert.ok("error" in noExe && /launcher file/.test(noExe.error));
  });
  test("a record whose time cannot be read is kept and judged; a record that cannot be read makes the read-back not measured (second review)", (t) => {
    const l = layout(t);
    writeFileSync(join(l.control, "records", "r1.json"), cleanRun(1));
    for (const timeless of [cleanRun(2).replace('"startedAt":"2026-11-26T19:10:50.000Z",', ""), cleanRun(2).replace("2026-11-26T19:10:50.000Z", "not a time")]) {
      writeFileSync(join(l.control, "records", "r2.json"), timeless.replace('"readBack":"clean"', '"readBack":"left"'));
      const kept = collectNativeEvidence(l.src, join);
      assert.ok(!("error" in kept) && kept.runRecordsRaw?.length === 2 && grantsReadBackOf(kept.runRecordsRaw).state === "left", JSON.stringify(kept));
    }
    rmSync(join(l.control, "records", "r2.json"));
    mkdirSync(join(l.control, "records", "r3.json"));
    const unreadable = collectNativeEvidence(l.src, join);
    assert.ok(!("error" in unreadable) && unreadable.runRecordsRaw === undefined, "a record that cannot be read is never skipped");
  });
});

describe("A03b native Windows evidence: the info line as the launcher writes it (second review)", () => {
  test("the LAST launcher info line counts, and the throw-away profile is created only when info says created", () => {
    const earlier = ROB_INFO.trim().replace('"elevated":false', '"elevated":true');
    const lastWins = nativeWindowsEvidence(fullInput({ infoRaw: `${ROB_INFO.trim()}\n${earlier}\n` }));
    assert.ok("evidence" in lastWins && lastWins.evidence.elevated === true, "the last line, not the first");
    refused(withEvidence(robReport(), fullInput({ infoRaw: `${ROB_INFO.trim()}\n${earlier}\n` })), /was elevated/);
    for (const profile of ['"profile":"failed"', '"profile":"existing"', '"profile":true']) {
      const m = nativeWindowsEvidence(fullInput({ infoRaw: ROB_INFO.replace('"profile":"created"', profile) }));
      assert.ok("evidence" in m && m.evidence.profiles.created === false, profile);
      refused(withEvidence(robReport(), fullInput({ infoRaw: ROB_INFO.replace('"profile":"created"', profile) })), /did not create its throw-away container profile/);
    }
  });
});

describe("A03b Windows release gate: every single-field change of the owner's real-shape report (table-driven)", () => {
  type Json = null | boolean | number | string | Json[] | { [k: string]: Json };
  /** The fixture fuzzed: the owner's real-shape report, and the same with a sign-out check that holds (`withAfter`). */
  let withAfter = false;
  const base = (): Json => JSON.parse(JSON.stringify(withAfter ? withEvidence(robReport(), fullInput({ afterSignOutRaw: afterRaw() })) : withEvidence(robReport()))) as Json;
  /** Every path to a value of the report (arrays by index). */
  const paths = (v: Json, at: (string | number)[] = []): (string | number)[][] => {
    if (Array.isArray(v)) return v.flatMap((x, i) => [[...at, i], ...paths(x, [...at, i])]);
    if (v !== null && typeof v === "object") return Object.entries(v).flatMap(([k, x]) => [[...at, k], ...paths(x, [...at, k])]);
    return [];
  };
  const getAt = (v: Json, p: readonly (string | number)[]): Json => p.reduce<Json>((o, k) => (o as Record<string, Json>)[k as string]!, v);
  /** The report with the value at `p` replaced (`undefined`: removed). */
  const setAt = (p: readonly (string | number)[], value: Json | undefined): Json => {
    const copy = base();
    const parent = getAt(copy, p.slice(0, -1));
    const k = p[p.length - 1]!;
    if (value === undefined) { if (Array.isArray(parent)) parent.splice(k as number, 1); else delete (parent as Record<string, Json>)[k as string]; }
    else (parent as Record<string, Json>)[k as string] = value;
    return copy;
  };
  const mutations = (v: Json): { name: string; value: Json | undefined }[] => {
    const out: { name: string; value: Json | undefined }[] = [
      { name: "removed", value: undefined }, { name: "null", value: null }, { name: "'false'", value: "false" }, { name: "'true'", value: "true" }, { name: "'0'", value: "0" }, { name: "''", value: "" },
      { name: "true", value: true }, { name: "false", value: false }, { name: "0", value: 0 }, { name: "-1", value: -1 }, { name: "1.5", value: 1.5 }, { name: "2^53", value: 2 ** 53 }, { name: "[]", value: [] }, { name: "{}", value: {} },
      { name: "array of it", value: [v] }, { name: "__proto__ object", value: JSON.parse('{"__proto__":{"ok":true}}') as Json },
    ];
    if (typeof v === "string") {
      out.push({ name: "upper", value: v.toUpperCase() }, { name: "lower", value: v.toLowerCase() }, { name: "trailing space", value: `${v} ` }, { name: "leading space", value: ` ${v}` },
        { name: "shortened", value: v.slice(0, -1) }, { name: "first 12", value: v.slice(0, 12) }, { name: "NUL added", value: `${v}\u0000` }, { name: "very long", value: v.repeat(200) });
    }
    if (typeof v === "number") out.push({ name: "+1", value: v + 1 }, { name: "negated", value: -v - 1 }, { name: "as text", value: String(v) });
    if (typeof v === "boolean") out.push({ name: "flipped", value: !v }, { name: "as text", value: String(v) });
    if (v !== null && typeof v === "object" && !Array.isArray(v)) out.push({ name: "extra key", value: { ...v, unexpected: true } });
    return out;
  };
  /**
   * The fields the gate deliberately does not judge (any well-formed value passes): the platform's machine words, a case's category, a passing case's detail, the trusted-host authority text, the
   * report time within its window, the session number other than 0, the account kind between its two measured values, and whether a check that could not be run (packaged:false) "passed".
   */
  const free = (p: readonly (string | number)[], before: Json, after: Json | undefined): boolean => {
    const key = p.join(".");
    if (JSON.stringify(before) === JSON.stringify(after)) return true;
    if (key === "arch" || key === "osVersion" || key === "trustedHost.authority") return typeof after === "string" && after.trim().length > 0;
    if (key === "generatedAt") return true;
    if (/^cases\.\d+\.category$/.test(key)) return true;
    if (/^cases\.\d+\.detail$/.test(key)) return getAt(base(), [...p.slice(0, -1), "verdict"]) === "pass";
    if (key === "nativeWindows.sessionId") return typeof after === "number" && after !== 0;
    if (key === "nativeWindows.accountKind") return after === "standard" || after === "administrator-filtered";
    if (key === "nativeWindows.packagedControllerWorkingDirectory.passed") return typeof after === "boolean";
    // The sign-out check: optional while AFTER_SIGNOUT_REQUIRED is false (removing it whole is today's report), and whether the held profile was still there before the sweep is not judged.
    if (key === "nativeWindows.afterSignOut") return after === undefined && !AFTER_SIGNOUT_REQUIRED;
    if (key === "nativeWindows.afterSignOut.profileLeftBeforeSweep") return typeof after === "boolean";
    return false;
  };
  test("the unchanged report passes (two link cases and the working-directory check accepted)", () => {
    const p = parseReport(JSON.stringify(base()));
    assert.ok("report" in p);
    const g = gate(p.report);
    assert.deepEqual([g.ok, g.accepted.length], [true, 3]);
  });
  const fuzz = (): { tried: number; refusedCount: number; slipped: string[] } => {
    let tried = 0, refusedCount = 0;
    const slipped: string[] = [];
    for (const p of paths(base())) {
      const before = getAt(base(), p);
      for (const m of mutations(before)) {
        tried++;
        const copy = setAt(p, m.value);
        const parsed = parseReport(JSON.stringify(copy));
        const passed = "report" in parsed && gate(parsed.report).ok;
        if (!passed) { refusedCount++; continue; }
        if (!free(p, before, m.value)) slipped.push(`${p.join(".")} ${m.name}`);
      }
    }
    return { tried, refusedCount, slipped };
  };
  test("every removal or change of one field is refused (by parseReport or by the gate) unless the gate deliberately does not judge that field", () => {
    const { tried, refusedCount, slipped } = fuzz();
    assert.deepEqual(slipped, [], `passed the gate although they should not: ${slipped.join(" | ")}`);
    assert.ok(tried > 1500 && refusedCount > tried * 0.8, `${refusedCount} of ${tried} refused`);
  });
  test("the same over the report with a sign-out check that holds: every change of a judged sign-out field is refused, removing the whole check is today's report", () => {
    withAfter = true;
    try {
      const p = parseReport(JSON.stringify(base()));
      assert.ok("report" in p && p.report.nativeWindows?.afterSignOut !== undefined && gate(p.report).ok, "the base passes");
      const { tried, refusedCount, slipped } = fuzz();
      assert.deepEqual(slipped, [], `passed the gate although they should not: ${slipped.join(" | ")}`);
      assert.ok(tried > 1700 && refusedCount > tried * 0.8, `${refusedCount} of ${tried} refused`);
    } finally { withAfter = false; }
  });
  test("whole-report forms: array, a second report, cases reordered, the report repeated in one file, a huge report", () => {
    assert.ok("error" in parseReport(JSON.stringify([base()])));
    assert.ok("error" in parseReport(`${JSON.stringify(base())}${JSON.stringify(base())}`));
    assert.ok("error" in parseReport(JSON.stringify({ ...(base() as Record<string, Json>), padding: "x".repeat(10) })));
    const big = parseReport(JSON.stringify({ ...(base() as Record<string, Json>), osVersion: "x".repeat(5_000_000) }));
    assert.ok("error" in big);
    const r = withEvidence(robReport());
    assert.equal(gate({ ...r, cases: [...r.cases].reverse() }).ok, true, "order does not matter");
    assert.equal(assessRelease([r, r], { commit: ROB_COMMIT, now: NOW, platforms: ["win32"] }).ok, false, "two reports for one platform");
  });
});

describe("A03b sign-out / restart check in the Windows release gate (optional in this slice, judged when present)", () => {
  const withAfter = (over: Partial<Record<keyof AfterSignOutEvidence, unknown>> = {}): ContainmentReport => withEvidence(robReport(), fullInput({ afterSignOutRaw: afterRaw(over) }));
  test("the owner's report with a check that holds passes with the same three items accepted; without the check it still passes and the check is listed as not proven", () => {
    const g = gate(withAfter());
    assert.deepEqual([g.ok, g.blockers, g.accepted.length], [true, [], 3]);
    assert.deepEqual(withAfter().nativeWindows?.afterSignOut, GOOD_AFTER);
    const made = nativeWindowsEvidence(fullInput({ afterSignOutRaw: afterRaw() }));
    assert.ok("evidence" in made && !made.notProven.some((n) => /signs out/.test(n)), "a check that is there is not 'not proven'");
    const plain = nativeWindowsEvidence(fullInput());
    assert.ok("evidence" in plain && plain.notProven.some((n) => /a run attempted after the owner signs out/.test(n)) && plain.evidence.afterSignOut === undefined);
    assert.equal(gate(withEvidence(robReport())).ok, true, "absent: today's report shape still passes (not retroactive)");
    // The redacted report keeps the block unchanged.
    const redacted = parseReport(JSON.stringify(redactReport(withAfter(), { users: ["robert"] })));
    assert.ok("report" in redacted && gate(redacted.report).ok && redacted.report.nativeWindows?.afterSignOut !== undefined);
    // Either value of profileLeftBeforeSweep is a safe outcome (the runner may have cleaned up itself before Windows ended it).
    assert.equal(gate(withAfter({ profileLeftBeforeSweep: false })).ok, true);
  });
  test("present, every judged field that is bad refuses the report, each with its own reason", () => {
    const table: [Partial<Record<keyof AfterSignOutEvidence, unknown>>, RegExp][] = [
      [{ held: false }, /sign-out check: no confined task was seen running/],
      [{ newLogon: false }, /sign-out check: the logon session did not change/],
      [{ newLogon: null }, /sign-out check: whether the owner signed out .* was not recorded/],
      [{ taskRunningAfter: true }, /sign-out check: the held task was still running/],
      [{ sweepProblems: null }, /sign-out check: the leftover sweep after the sign-in did not run/],
      [{ sweepProblems: 2 }, /sign-out check: the leftover sweep after the sign-in reported 2 problem/],
      [{ leftoverAfterSweep: 1 }, /sign-out check: 1 NimbleNewtRun-\* container profile\(s\) were left after the sweep/],
      [{ leftoverAfterSweep: null }, /sign-out check: the NimbleNewtRun-\* container profiles left after the sweep were not counted/],
      [{ grantsAfter: "left" }, /sign-out check: an entry for the held run's container was still on a granted path/],
      [{ grantsAfter: "not-measured" }, /sign-out check: the held run's grants were not read back/],
      [{ interruptedRecorded: false }, /sign-out check: the held run is not recorded as interrupted/],
    ];
    for (const [over, why] of table) {
      refused(withAfter(over), why);
      assert.deepEqual(gate(withAfter(over)).accepted, [], "nothing accepted when refused");
    }
    // Every field bad at once: one reason per field.
    assert.equal(afterSignOutProblems({ held: false, newLogon: false, taskRunningAfter: true, profileLeftBeforeSweep: false, sweepProblems: 1, leftoverAfterSweep: 1, grantsAfter: "left", interruptedRecorded: false }).length, 7);
  });
  test("AFTER_SIGNOUT_REQUIRED: false in this slice; once true, a report without the check is refused and one with it passes", () => {
    assert.equal(AFTER_SIGNOUT_REQUIRED, false, "not required in this slice: the gate must keep passing the owner's existing report shape");
    const required = (r: ContainmentReport) => assessRelease([r], { commit: ROB_COMMIT, now: NOW, platforms: ["win32"], afterSignOutRequired: true });
    const g = required(withEvidence(robReport()));
    assert.equal(g.ok, false);
    assert.ok(g.blockers.some((b) => /sign-out \/ restart check .* is not recorded/.test(b)), g.blockers.join(" | "));
    assert.equal(required(withAfter()).ok, true);
    assert.equal(required(withAfter({ interruptedRecorded: false })).ok, false);
  });
  test("the open sign-out item cannot outlive the release decision: card D03 (release readiness) is not flipped while AFTER_SIGNOUT_REQUIRED is false", () => {
    const plan = JSON.parse(readFileSync(fileURLToPath(new URL("../../../../docs/nimblenewt/implementation-plan/task-plan.json", import.meta.url)), "utf8")) as { tasks: { id: string; status: string }[] };
    const d03 = plan.tasks.find((t) => t.id === "D03");
    assert.ok(d03 !== undefined, "card D03 is in task-plan.json");
    if (!AFTER_SIGNOUT_REQUIRED) assert.equal(d03.status, "planned", "run run-g05.ps1 -Hold, sign out, -AfterSignIn on the owner's PC, review the report, and set AFTER_SIGNOUT_REQUIRED to true before D03");
  });
  test("read as data: a malformed block is refused by parseReport; a malformed or unreadable check file gives no block at all (never a report without the check)", () => {
    const base = JSON.parse(JSON.stringify(withAfter())) as { nativeWindows: { afterSignOut: Record<string, unknown> } };
    const bad = (change: (a: Record<string, unknown>) => void): void => {
      const copy = JSON.parse(JSON.stringify(base)) as typeof base;
      change(copy.nativeWindows.afterSignOut);
      const p = parseReport(JSON.stringify(copy));
      assert.ok("error" in p && /nativeWindows/.test(p.error), JSON.stringify(copy.nativeWindows.afterSignOut));
    };
    for (const k of Object.keys(GOOD_AFTER)) bad((a) => { delete a[k]; });
    bad((a) => { a["extra"] = true; });
    bad((a) => { a["held"] = "true"; });
    bad((a) => { a["taskRunningAfter"] = null; });
    bad((a) => { a["sweepProblems"] = -1; });
    bad((a) => { a["sweepProblems"] = 0.5; });
    bad((a) => { a["leftoverAfterSweep"] = "0"; });
    bad((a) => { a["leftoverAfterSweep"] = 100_001; });
    bad((a) => { a["grantsAfter"] = "unreadable"; });
    bad((a) => { a["interruptedRecorded"] = 1; });
    bad((a) => { a["newLogon"] = "yes"; });
    // The file: exactly { schema, afterSignOut }.
    for (const raw of ["{", "[]", JSON.stringify({ schema: "other/1", afterSignOut: GOOD_AFTER }), JSON.stringify({ schema: AFTER_SIGNOUT_SCHEMA }), JSON.stringify({ schema: AFTER_SIGNOUT_SCHEMA, afterSignOut: GOOD_AFTER, note: "x" }),
      afterRaw({ held: "yes" }), JSON.stringify({ schema: AFTER_SIGNOUT_SCHEMA, afterSignOut: { ...GOOD_AFTER, extra: 1 } }), "x".repeat(70_000)]) {
      assert.ok("error" in parseAfterSignOut(raw), raw.slice(0, 80));
      const m = nativeWindowsEvidence(fullInput({ afterSignOutRaw: raw }));
      assert.ok("error" in m && /sign-out check file/.test(m.error), raw.slice(0, 80));
    }
  });
  test("the collector reads the file --after-sign-out names; one that cannot be read is an error, not 'not given'", (t) => {
    const root = mkdtempSync(join(tmpdir(), "nn-a03b-after-"));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const bin = join(root, "bin"), control = join(root, "control");
    for (const d of [bin, join(control, "records"), join(control, "hold"), join(root, "Packages")]) mkdirSync(d, { recursive: true });
    writeFileSync(join(bin, "nn-launcher.exe"), "launcher bytes");
    writeFileSync(join(bin, "nn-launcher.record.json"), ROB_RECORD);
    writeFileSync(join(control, "info.txt"), ROB_INFO);
    writeFileSync(join(control, "hold", "after-sign-out.json"), afterRaw());
    const src = { infoFile: join(control, "info.txt"), launcher: join(bin, "nn-launcher.exe"), controlDir: control, packagesDir: join(root, "Packages"), since: new Date("2026-11-26T19:10:00Z") };
    const ok = collectNativeEvidence({ ...src, afterSignOutFile: join(control, "hold", "after-sign-out.json") }, join);
    assert.ok(!("error" in ok) && ok.afterSignOutRaw === afterRaw());
    const missing = collectNativeEvidence({ ...src, afterSignOutFile: join(control, "hold", "none.json") }, join);
    assert.ok("error" in missing && /sign-out check file could not be read/.test(missing.error));
    const none = collectNativeEvidence(src, join);
    assert.ok(!("error" in none) && none.afterSignOutRaw === undefined);
  });
});
