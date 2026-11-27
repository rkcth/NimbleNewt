import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { win32 } from "node:path";
import type { AfterSignOutEvidence, ContainmentReport, NativeWindowsEvidence } from "./containment.js";
import { PACKAGED_CONTROLLER_EXISTS, isAfterSignOutEvidence, isNativeWindowsEvidence } from "./containment.js";
import { parseWorkdirCheck } from "./containment-windows-evidence.js";

/*
 * Card A03b: the `nativeWindows` block of a containment report, from what the run on a real Windows PC itself wrote (owner decision 2026-11-26: the AppContainer launcher, no Windows Sandbox).
 * Read as data, never typed in by hand:
 *   - the launcher's `info` JSON line (`nn-launcher info`, as run-g05.ps1 runs it): elevated, sessionId, the window-object mode and windowStationOk, the throw-away profile created, deleted and gone;
 *   - the launcher's release record (`nn-launcher.record.json` next to the launcher, schema nimblenewt.native-launcher-record/1) and the SHA-256 of the launcher file the backend ran;
 *   - the backend's run records (`<control>\records\*.json`, windows-native-job.ts) of this evidence run, for the grant read-back of every run;
 *   - the count of `NimbleNewtRun-*` profiles left under `%LOCALAPPDATA%\Packages` after the run;
 *   - the account kind and whether the account holds SeCreateSymbolicLinkPrivilege, as run-g05.ps1 found them (`containment-evidence.mjs run --account-kind ... --symlink-right ...`);
 *   - the working-directory check output when one was run; otherwise, while no packaged controller exists (PACKAGED_CONTROLLER_EXISTS), the fact that there is none (`packaged: false`);
 *   - optionally, the sign-out / restart check `run-g05.ps1 -AfterSignIn` wrote (`containment-evidence.mjs after-sign-in`, windows-native-signout.ts): given but unreadable or malformed is no block at all.
 * Anything not given is `not-measured` / `null`, which the release gate refuses, and is named in `notProven`.
 */

export const LAUNCHER_RECORD_SCHEMA = "nimblenewt.native-launcher-record/1";
/** The file `afterSignIn` (windows-native-signout.ts) writes: `{ schema, afterSignOut }`, nothing else. */
export const AFTER_SIGNOUT_SCHEMA = "nimblenewt.g05-after-sign-out/1";
/** Defined with the gate (containment.ts), which refuses `packaged: false` once it is true; while false, a run without the check records `packaged: false`, accepted as "not yet measurable". */
export { PACKAGED_CONTROLLER_EXISTS };
const MAX_INPUT_BYTES = 64 * 1024;
const MAX_RUN_RECORDS = 1000;
const MAX_LAUNCHER_BYTES = 64 * 1024 * 1024;
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const SHA256 = /^[0-9a-f]{64}$/;
const COMMIT = /^[0-9a-f]{40}$/;
/** A per-run profile's folder under %LOCALAPPDATA%\Packages (Windows keeps the moniker in lower case). */
const RUN_PROFILE_FOLDER = /^nimblenewtrun-[0-9a-f]{16}$/i;

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
  /** The working-directory check's output (scripts/g05-workdir-check.mjs), when it was run. */
  readonly workdirRaw?: string;
  /** Tests only: whether a packaged controller exists (default `PACKAGED_CONTROLLER_EXISTS`). */
  readonly packagedControllerExists?: boolean;
  /** The sign-out / restart check file (`AFTER_SIGNOUT_SCHEMA`), when `run-g05.ps1 -AfterSignIn` made one. */
  readonly afterSignOutRaw?: string;
}

/** The sign-out check file read as data: exactly `{ schema, afterSignOut }` with a well-formed block, or why not. */
export function parseAfterSignOut(raw: string): { afterSignOut: AfterSignOutEvidence } | { error: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_INPUT_BYTES) return { error: "the sign-out check file is too large" };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { error: "the sign-out check file is not JSON" }; }
  if (!isObject(v) || Object.keys(v).length !== 2 || v["schema"] !== AFTER_SIGNOUT_SCHEMA || !isAfterSignOutEvidence(v["afterSignOut"])) return { error: `the sign-out check file is not a ${AFTER_SIGNOUT_SCHEMA} with a complete afterSignOut block` };
  return { afterSignOut: v["afterSignOut"] };
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
  let workingDirectory: { packaged: boolean; passed: boolean } | null = (input.packagedControllerExists ?? PACKAGED_CONTROLLER_EXISTS) ? null : { packaged: false, passed: false };
  if (input.workdirRaw !== undefined) {
    const wd = parseWorkdirCheck(input.workdirRaw);
    if ("error" in wd) return { error: wd.error };
    workingDirectory = wd;
  }
  let afterSignOut: AfterSignOutEvidence | undefined;
  if (input.afterSignOutRaw !== undefined) {
    const a = parseAfterSignOut(input.afterSignOutRaw);
    if ("error" in a) return { error: a.error };
    afterSignOut = a.afterSignOut;
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
    ...(afterSignOut === undefined ? {} : { afterSignOut }),
  };
  if (!isNativeWindowsEvidence(evidence)) return { error: "the native Windows evidence would not read back as evidence" };
  const notProven = [
    ...(evidence.accountKind === "not-measured" ? ["the account kind (standard user or administrator with a filtered token)"] : []),
    ...(leftover === null ? ["the count of NimbleNewtRun-* profiles left after the run"] : []),
    ...(grants.state === "not-measured" ? [`the grant read-back after each run (${grants.why ?? "not given"})`] : []),
    ...(evidence.symlinkRight === null ? ["whether the account holds SeCreateSymbolicLinkPrivilege"] : []),
    ...(workingDirectory === null ? ["the controller working-directory check"] : workingDirectory.packaged ? [] : ["the working-directory check on a packaged controller (none exists yet)"]),
    // Present, the check is judged field by field by the gate; absent, it is only listed here (AFTER_SIGNOUT_REQUIRED is false in this slice).
    ...(afterSignOut === undefined ? ["a run attempted after the owner signs out is refused cleanly and leaves nothing (the hold / sign-out step; not required by the gate in this slice)"] : []),
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

export interface NativeEvidenceSources {
  /** The `info` output file run-g05.ps1 wrote (its raw copy). */
  readonly infoFile: string;
  /** The launcher the backend ran (NIMBLENEWT_WIN_LAUNCHER); its release record is `nn-launcher.record.json` in the same folder. */
  readonly launcher: string;
  /** The backend's control folder (NIMBLENEWT_WIN_CONTROL_DIR); its run records are under `records`. */
  readonly controlDir: string;
  /** `%LOCALAPPDATA%\Packages`, where the per-run profiles live. */
  readonly packagesDir: string;
  /** When the evidence run started: only run records from then on are this run's. */
  readonly since: Date;
  readonly accountKind?: "standard" | "administrator-filtered";
  readonly symlinkRight?: boolean;
  readonly workdirRaw?: string;
  /** The sign-out check file `run-g05.ps1 -AfterSignIn` wrote (`--after-sign-out`). Given but unreadable is an error (no block), never "not given". */
  readonly afterSignOutFile?: string;
}

/** The folder of a path written with \ or / (a Windows path on Windows; a POSIX one in the tests). */
function folderOf(p: string): string {
  const i = Math.max(p.lastIndexOf("\\"), p.lastIndexOf("/"));
  return i <= 0 ? "." : p.slice(0, i);
}

/**
 * Reads the files `nativeWindowsEvidence` needs. `join` is win32.join on Windows (the tests pass POSIX paths and join). What cannot be read is left out (and so becomes not measured), except the
 * info line, the release record and the launcher, without which there is no block (`error`). Never throws.
 */
export function collectNativeEvidence(src: NativeEvidenceSources, join: (...parts: string[]) => string = win32.join): NativeEvidenceInput | { error: string } {
  const read = (p: string): string | undefined => { try { const b = readFileSync(p); return b.length > MAX_INPUT_BYTES ? undefined : b.toString("utf8"); } catch { return undefined; } };
  const infoRaw = read(src.infoFile);
  if (infoRaw === undefined) return { error: "the launcher's info output could not be read" };
  let afterSignOutRaw: string | undefined;
  if (src.afterSignOutFile !== undefined) {
    afterSignOutRaw = read(src.afterSignOutFile);
    if (afterSignOutRaw === undefined) return { error: "the sign-out check file could not be read" };
  }
  const recordRaw = read(join(folderOf(src.launcher), "nn-launcher.record.json"));
  if (recordRaw === undefined) return { error: "the launcher's release record (nn-launcher.record.json next to the launcher) could not be read" };
  let launcherSha256: string;
  try {
    const b = readFileSync(src.launcher);
    if (b.length > MAX_LAUNCHER_BYTES) return { error: "the launcher file is too large" };
    launcherSha256 = createHash("sha256").update(b).digest("hex");
  } catch { return { error: "the launcher file could not be read" }; }
  let runRecordsRaw: string[] | undefined;
  try {
    const dir = join(src.controlDir, "records");
    // Every record is looked at (names are random run ids, so no slice by name may stand for "the newest"); more than the bound is not measured.
    const names = readdirSync(dir).filter((n) => /^[A-Za-z0-9._-]{1,100}\.json$/.test(n)).sort();
    runRecordsRaw = [];
    for (const name of names.length > MAX_RUN_RECORDS ? [] : names) {
      const raw = read(join(dir, name));
      if (raw === undefined) { runRecordsRaw = undefined; break; }
      let startedAt: unknown;
      try { startedAt = (JSON.parse(raw) as { startedAt?: unknown }).startedAt; } catch { startedAt = undefined; }
      // Only a record shown to be older than this run is left out; one whose time cannot be read is kept, and grantsReadBackOf judges it.
      const t = typeof startedAt === "string" ? Date.parse(startedAt) : Number.NaN;
      if (Number.isFinite(t) && t < src.since.getTime()) continue;
      runRecordsRaw.push(raw);
    }
    if (names.length > MAX_RUN_RECORDS) runRecordsRaw = undefined;
  } catch { runRecordsRaw = undefined; }
  let leftoverProfiles: number | undefined;
  try { leftoverProfiles = readdirSync(src.packagesDir).filter((n) => RUN_PROFILE_FOLDER.test(n)).length; } catch { leftoverProfiles = undefined; }
  return {
    infoRaw, recordRaw, launcherSha256,
    ...(runRecordsRaw === undefined ? {} : { runRecordsRaw }),
    ...(leftoverProfiles === undefined ? {} : { leftoverProfiles }),
    ...(src.accountKind === undefined ? {} : { accountKind: src.accountKind }),
    ...(src.symlinkRight === undefined ? {} : { symlinkRight: src.symlinkRight }),
    ...(src.workdirRaw === undefined ? {} : { workdirRaw: src.workdirRaw }),
    ...(afterSignOutRaw === undefined ? {} : { afterSignOutRaw }),
  };
}
