import type { ContainmentReport, NativeWindowsEvidence } from "./containment.js";
import { isNativeWindowsEvidence } from "./containment.js";
import { parseWorkdirCheck } from "./containment-windows-evidence.js";

/*
 * Card A03b: the `nativeWindows` block of a containment report, from what the run on a real Windows PC itself wrote (owner decision 2026-11-26: the AppContainer launcher, no Windows Sandbox).
 * Read as data, never typed in by hand:
 *   - the launcher's `info` JSON line (`nn-launcher info`, as run-g05.ps1 runs it): elevated, sessionId, the window-object mode and windowStationOk, the throw-away profile created, deleted and gone;
 *   - the launcher's release record (`nn-launcher.record.json`, schema nimblenewt.native-launcher-record/1) and the SHA-256 of the launcher file that ran;
 *   - the backend's run records (`<control>\records\*.json`, windows-native-job.ts) for the grant read-back of every run;
 *   - the count of `NimbleNewtRun-*` profiles left afterwards, the account kind, whether the account holds SeCreateSymbolicLinkPrivilege, the working-directory check output and the supervisor-ACL
 *     check, each only when the caller measured it.
 * Anything not given is `not-measured` / `null` / `not-run`, which the release gate refuses, and is named in `notProven`.
 */

export const LAUNCHER_RECORD_SCHEMA = "nimblenewt.native-launcher-record/1";
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RUN_RECORDS = 1000;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;

export interface NativeEvidenceInput {
  /** The launcher's `info` output (its last `nn-appc-launcher` JSON line is read). */
  readonly infoRaw: string;
  readonly recordRaw: string;
  /** SHA-256 (lower-case hex) of the launcher file that ran. */
  readonly launcherSha256: string;
  readonly runRecordsRaw?: readonly string[];
  readonly leftoverProfiles?: number;
  readonly accountKind?: "standard" | "administrator-filtered";
  readonly symlinkRight?: boolean;
  readonly workdirRaw?: string;
  readonly supervisorAcl?: "strict" | "report-only";
}

function lastInfoLine(text: string): Record<string, unknown> | undefined {
  const lines = text.split(/\r?\n/);
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i]!.trim();
    if (!t.startsWith("{")) continue;
    let o: unknown;
    try { o = JSON.parse(t); } catch { continue; }
    if (isObject(o) && o["tool"] === "nn-appc-launcher") return o;
  }
  return undefined;
}

/** The grant read-back over every run record: `clean` only when there is at least one record and every one read back clean with nothing left and no revoke failure. */
export function grantsReadBackOf(records: readonly string[]): { state: "clean" | "left" | "not-measured"; why?: string } {
  if (records.length === 0) return { state: "not-measured", why: "no run record was given" };
  if (records.length > MAX_RUN_RECORDS) return { state: "not-measured", why: `more than ${MAX_RUN_RECORDS} run records` };
  for (const raw of records) {
    if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) return { state: "not-measured", why: "a run record is too large" };
    let r: unknown;
    try { r = JSON.parse(raw); } catch { return { state: "not-measured", why: "a run record is not JSON" }; }
    if (!isObject(r) || r["mode"] !== "native" || !Array.isArray(r["entriesLeft"]) || (r["readBack"] !== "clean" && r["readBack"] !== "left" && r["readBack"] !== "unreadable")) return { state: "not-measured", why: "a run record is not a native run record" };
    if (r["readBack"] === "unreadable") return { state: "not-measured", why: "a run's access lists could not be read back" };
    if (r["readBack"] === "left" || r["entriesLeft"].length > 0 || (isObject(r["failure"]) && r["failure"]["kind"] === "revoke")) return { state: "left" };
  }
  return { state: "clean" };
}

/** The block from the run's own files, plus a plain list of what it does not prove. Pure. An `error` when the info line or the release record cannot be read (then there is no block). */
export function nativeWindowsEvidence(input: NativeEvidenceInput): { evidence: NativeWindowsEvidence; notProven: string[] } | { error: string } {
  if (Buffer.byteLength(input.infoRaw, "utf8") > MAX_INPUT_BYTES || Buffer.byteLength(input.recordRaw, "utf8") > MAX_INPUT_BYTES) return { error: "the launcher info or release record is too large" };
  const info = lastInfoLine(input.infoRaw);
  if (info === undefined || info["command"] !== "info") return { error: "the launcher's info output holds no info line" };
  if (info["ok"] !== true) return { error: `the launcher's info did not succeed${typeof info["error"] === "string" ? ` (${info["error"].slice(0, 200)})` : ""}` };
  if (typeof info["elevated"] !== "boolean" || !Number.isSafeInteger(info["sessionId"]) || typeof info["windowStation"] !== "string" || typeof info["windowStationOk"] !== "boolean") {
    return { error: "the launcher's info line does not say elevated, sessionId, windowStation and windowStationOk" };
  }
  let record: unknown;
  try { record = JSON.parse(input.recordRaw); } catch { return { error: "the launcher's release record is not JSON" }; }
  if (!isObject(record) || record["schema"] !== LAUNCHER_RECORD_SCHEMA || typeof record["sourceCommit"] !== "string" || !COMMIT.test(record["sourceCommit"]) || typeof record["sha256"] !== "string" || !SHA256.test(record["sha256"])) {
    return { error: `the launcher's release record is not a ${LAUNCHER_RECORD_SCHEMA} with sourceCommit and sha256` };
  }
  if (!SHA256.test(input.launcherSha256)) return { error: "the launcher file's SHA-256 must be 64 lower-case hex digits" };
  let workingDirectory = { packaged: false, passed: false };
  if (input.workdirRaw !== undefined) {
    const wd = parseWorkdirCheck(input.workdirRaw);
    if ("error" in wd) return { error: wd.error };
    workingDirectory = wd;
  }
  const leftover = input.leftoverProfiles !== undefined && Number.isSafeInteger(input.leftoverProfiles) && input.leftoverProfiles >= 0 ? input.leftoverProfiles : null;
  const grants = input.runRecordsRaw === undefined ? { state: "not-measured" as const, why: "no run record was given" } : grantsReadBackOf(input.runRecordsRaw);
  const evidence: NativeWindowsEvidence = {
    launcher: { recordCommit: record["sourceCommit"], recordSha256: record["sha256"], fileSha256: input.launcherSha256 },
    elevated: info["elevated"],
    accountKind: input.accountKind ?? "not-measured",
    sessionId: info["sessionId"] as number,
    windowStation: info["windowStation"].slice(0, 40),
    windowStationOk: info["windowStationOk"],
    profiles: { created: info["profile"] === "created", deleted: info["profileDeleted"] === true, gone: info["profileGone"] === true, leftover },
    grantsReadBack: grants.state,
    symlinkRight: input.symlinkRight ?? null,
    packagedControllerWorkingDirectory: workingDirectory,
    supervisorAclCheck: input.supervisorAcl ?? "not-run",
  };
  if (!isNativeWindowsEvidence(evidence)) return { error: "the native Windows evidence would not read back as evidence" };
  const notProven = [
    ...(evidence.accountKind === "not-measured" ? ["the account kind (standard user or administrator with a filtered token)"] : []),
    ...(leftover === null ? ["the count of NimbleNewtRun-* profiles left after the run"] : []),
    ...(grants.state === "not-measured" ? [`the grant read-back after each run (${grants.why ?? "not given"})`] : []),
    ...(evidence.symlinkRight === null ? ["whether the account holds SeCreateSymbolicLinkPrivilege"] : []),
    ...(workingDirectory.packaged ? [] : ["the working-directory check on a packaged controller"]),
    ...(evidence.supervisorAclCheck === "strict" ? [] : ["the strict supervisor-ACL check"]),
    "a run attempted after the owner signs out is refused cleanly and leaves nothing (the hold / sign-out step; not required by the gate in this slice)",
  ];
  return { evidence, notProven };
}

/** The report with its `nativeWindows` block filled in. Only a Windows report from the native launcher takes one. Pure. */
export function attachNativeWindowsEvidence<R extends Pick<ContainmentReport, "platform" | "backend">>(report: R, input: NativeEvidenceInput): { report: R & { nativeWindows: NativeWindowsEvidence }; notProven: string[] } | { error: string } {
  if (report.platform !== "win32") return { error: "native Windows evidence goes only into a Windows report" };
  if (report.backend !== "windows-native") return { error: `native Windows evidence goes only into a report from the native launcher (this one is from ${report.backend})` };
  const made = nativeWindowsEvidence(input);
  if ("error" in made) return made;
  return { report: { ...report, nativeWindows: made.evidence }, notProven: made.notProven };
}
