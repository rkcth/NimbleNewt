import type { ContainmentReport, WindowsEvidence } from "./containment.js";
import { scrub, type RedactionNames } from "./windows-redact.js";

/*
 * Card G05: the `windows` block of a containment report, produced from what the real Windows Sandbox tests (windows-real.test.ts, card A03b) found on the owner's Windows machine,
 * instead of being typed in by hand. The tests write summary.json (pass/fail per test, booleans only; the repository is public). This module reads that summary as data and fills in only
 * what the tests actually showed. Everything they cannot show stays false, so the release gate keeps blocking on it:
 *   - launch/exec/results/teardown after logout and after a reboot: no automation exists for that proof (it needs the owner's machine signed out and restarted), so all eight are false;
 *   - the service identity: the account is always written as a placeholder, and the session is what the run saw (`interactive` unless the run was in the service session);
 *   - the mapped-output ACL controls: positive = the guest wrote the mapped checkout and the checkout's ACL was given back exactly; negative = the guest could not write the read-only
 *     input, Git's `.git` folder or a junction to the input, and the ACL was given back. These come from the escape-fixture test, and only when that whole test passed;
 *   - the supervisor-ACL check: `strict` only when the strict rule was the one in use AND its test passed; anything else is `report-only`, which the gate refuses;
 *   - the packaged controller working-directory check: whatever the caller measured (scripts/g05-workdir-check.mjs), or not run;
 *   - `featureEnabledOnly`: true when no test that started a real sandbox passed (only the facts were read), so a run that never confined anything is never counted.
 */

export const WSB_SUMMARY_SCHEMA = "nimblenewt.wsb-summary/1";
export const MAX_WSB_SUMMARY_BYTES = 64 * 1024;
/** The test names in windows-real.test.ts this producer reads. They are the tests' own titles; windows-real.test.ts uses these constants. */
export const WSB_TESTS = {
  facts: "facts: the package, the signature, the working directory, the session, the auto-login flags (booleans only) and the supervisor ACLs",
  health: "health: a real probe sandbox starts, the guest cannot write read-only inputs or .git or reach the network, and everything is torn down",
  escape: "escape fixture: the guest tries to leave and is denied; the launch record shows the mode; the host is unchanged and the ACLs are back as they were",
  exitCode: "the command's exit code and output come back",
  busy: "a second job while one runs is refused as busy, and a hard kill of the first ends its sandbox and gives the ACLs back",
  failClosed: "fail closed: another account at the console, or a client older than asked for, gives no capacity and starts nothing",
  strictAcl: "the strict supervisor-ACL rule on this machine (recorded; asserted only when the strict rule is the one in use)",
} as const;
/** The booleans the escape fixture records (from the guest's own report lines and the host's ACL comparison). */
export const WSB_CONTROLS = ["writesCheckout", "readOnlyInputDenied", "gitDenied", "junctionDenied", "aclsRestored"] as const;
export type WsbControl = (typeof WSB_CONTROLS)[number];

export interface WsbSummary {
  readonly tests: Readonly<Record<string, string>>;
  readonly controls: Partial<Readonly<Record<WsbControl, boolean>>>;
  readonly supervisorAcl: "strict" | "report-only";
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Reads summary.json as data: bounded, the fields this producer relies on checked. Other fields (os, counts, facts) are neither needed nor trusted. */
export function parseWsbSummary(raw: string): { summary: WsbSummary } | { error: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_WSB_SUMMARY_BYTES) return { error: `the summary is larger than ${MAX_WSB_SUMMARY_BYTES} bytes` };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { error: "the summary is not JSON" }; }
  if (!isObject(v) || v["schema"] !== WSB_SUMMARY_SCHEMA) return { error: `not a Windows Sandbox summary (schema ${WSB_SUMMARY_SCHEMA})` };
  const tests = v["tests"];
  if (!isObject(tests) || Object.keys(tests).length > 64 || !Object.values(tests).every((t) => typeof t === "string" && t.length <= 40)) return { error: "tests: a map of test names to results" };
  const controls = v["controls"] ?? {};
  if (!isObject(controls) || Object.keys(controls).some((k) => !(WSB_CONTROLS as readonly string[]).includes(k)) || !Object.values(controls).every((c) => typeof c === "boolean")) return { error: `controls: booleans named ${WSB_CONTROLS.join(", ")}` };
  if (v["supervisorAcl"] !== "strict" && v["supervisorAcl"] !== "report-only") return { error: "supervisorAcl: strict or report-only" };
  return { summary: { tests: tests as Record<string, string>, controls: controls as WsbSummary["controls"], supervisorAcl: v["supervisorAcl"] } };
}

export interface WindowsEvidenceContext {
  /** The session the run saw: `service` only when it ran in the service session (session 0). */
  readonly session: "service" | "interactive";
  /** The packaged controller working-directory check, when one was run (scripts/g05-workdir-check.mjs). */
  readonly workingDirectory?: { readonly packaged: boolean; readonly passed: boolean };
}

/** The `windows` block from the tests' summary, plus a plain list of what it does not prove. Pure. */
export function windowsEvidenceFromSummary(summary: WsbSummary, context: WindowsEvidenceContext): { evidence: WindowsEvidence; notProven: string[] } {
  const passed = (name: string): boolean => summary.tests[name] === "pass";
  const c = summary.controls;
  const escape = passed(WSB_TESTS.escape);
  const restored = c.aclsRestored === true;
  const positive = escape && c.writesCheckout === true && restored;
  const negative = escape && c.readOnlyInputDenied === true && c.gitDenied === true && c.junctionDenied === true && restored;
  const confinedSomething = [WSB_TESTS.health, WSB_TESTS.escape, WSB_TESTS.exitCode, WSB_TESTS.busy].some(passed);
  const strict = summary.supervisorAcl === "strict" && passed(WSB_TESTS.strictAcl);
  const never = { launch: false, exec: false, results: false, teardown: false };
  const workingDirectory = context.workingDirectory ?? { packaged: false, passed: false };
  const notProven = [
    "launch, exec, results and teardown after logout and after a reboot under the unattended service identity: not automated, recorded as false",
    ...(context.session === "service" ? [] : ["the run was in an interactive session, not the service identity"]),
    ...(positive ? [] : ["the mapped-output ACL positive control (the guest writes the mapped checkout; the ACL is given back)"]),
    ...(negative ? [] : ["the mapped-output ACL negative control (read-only input, .git and a junction refused; the ACL is given back)"]),
    ...(strict ? [] : ["the strict supervisor-ACL check (report-only was in use, or the strict test did not pass)"]),
    ...(workingDirectory.packaged ? (workingDirectory.passed ? [] : ["the packaged controller working-directory check failed"]) : ["the working-directory check was not run on a packaged controller"]),
    ...(confinedSomething ? [] : ["no test that starts a real sandbox passed: this is the feature being present only"]),
  ];
  return {
    evidence: {
      serviceIdentity: { account: "<user>", session: context.session },
      afterLogout: never, afterReboot: never,
      mappedOutputAcl: { positive, negative },
      packagedControllerWorkingDirectory: { packaged: workingDirectory.packaged, passed: workingDirectory.passed },
      supervisorAclCheck: strict ? "strict" : "report-only",
      featureEnabledOnly: !confinedSomething,
    },
    notProven,
  };
}

/**
 * The session a Windows process runs in, from its environment: a service (session 0, no `SESSIONNAME`) or an interactive one (`Console`, or `RDP-Tcp#n`). Only a hint: the gate needs the
 * logout and reboot proof as well, which this does not give.
 */
export function sessionFromEnvironment(env: NodeJS.ProcessEnv): "service" | "interactive" {
  const name = env["SESSIONNAME"];
  return name === undefined || name === "" || /^services$/i.test(name) ? "service" : "interactive";
}

/** The guest's report lines of the escape fixture (`<n>_<what>=<outcome>`) turned into the controls; the ACL comparison is the host's. Pure; used by windows-real.test.ts. */
export function controlsFromEscapeOutput(stdout: string, aclsRestored: boolean): Record<WsbControl, boolean> {
  const has = (line: string): boolean => stdout.split(/\r?\n/).some((l) => l.trim() === line);
  return {
    writesCheckout: has("3_write_work=allowed"),
    readOnlyInputDenied: has("1_write_readonly_input=denied"),
    gitDenied: has("2_write_git=denied"),
    junctionDenied: has("8_write_through_junction=denied"),
    aclsRestored,
  };
}

/** Reads the working-directory check's output (scripts/g05-workdir-check.mjs) as data. Only `packaged` and `passed` are used. */
export function parseWorkdirCheck(raw: string): { packaged: boolean; passed: boolean } | { error: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_WSB_SUMMARY_BYTES) return { error: "the working-directory check output is too large" };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { error: "the working-directory check output is not JSON" }; }
  if (!isObject(v) || v["schema"] !== "nimblenewt.g05-workdir/1" || typeof v["packaged"] !== "boolean" || typeof v["passed"] !== "boolean") return { error: "not a working-directory check (schema, packaged, passed)" };
  return { packaged: v["packaged"], passed: v["passed"] };
}

/**
 * The report with its `windows` block filled from the real tests' summary (and the working-directory check, when given). Only a Windows report takes one. Pure.
 */
export function attachWindowsEvidence<R extends { readonly platform: string; readonly windows?: WindowsEvidence }>(report: R, input: { readonly summaryRaw: string; readonly workdirRaw?: string; readonly session: "service" | "interactive" }): { report: R; notProven: string[] } | { error: string } {
  if (report.platform !== "win32") return { error: "Windows evidence goes only into a Windows report" };
  const parsed = parseWsbSummary(input.summaryRaw);
  if ("error" in parsed) return { error: `the Windows Sandbox summary: ${parsed.error}` };
  let workingDirectory: { packaged: boolean; passed: boolean } | undefined;
  if (input.workdirRaw !== undefined) {
    const wd = parseWorkdirCheck(input.workdirRaw);
    if ("error" in wd) return { error: wd.error };
    workingDirectory = wd;
  }
  const made = windowsEvidenceFromSummary(parsed.summary, { session: input.session, ...(workingDirectory === undefined ? {} : { workingDirectory }) });
  return { report: { ...report, windows: made.evidence }, notProven: made.notProven };
}

/**
 * A copy of a containment report fit for a public artifact: only its free text (OS and backend descriptions, the capacity reason, each case's detail, the trusted-host authority and the
 * Windows account) goes through `scrub` (account, machine and home names, SIDs, addresses; a field that still looks personal is withheld whole). Identifiers, verdicts, the commit, the
 * time and every boolean are kept exactly, so the gate judges the redacted report as it would the original. Pure apart from the running machine's own names, which `scrub` adds.
 */
export function redactReport(report: ContainmentReport, names: RedactionNames = {}): ContainmentReport {
  const s = (v: string): string => scrub(v, names, 400);
  const optional = (k: "macosVersion" | "backendVersion" | "capacityReason") => (report[k] === undefined ? {} : { [k]: s(report[k]!) });
  return {
    ...report,
    arch: s(report.arch), osVersion: s(report.osVersion), backend: s(report.backend), ...optional("macosVersion"), ...optional("backendVersion"), ...optional("capacityReason"),
    cases: report.cases.map((c) => ({ ...c, detail: s(c.detail) })),
    ...(report.trustedHost === undefined ? {} : { trustedHost: { ...report.trustedHost, authority: s(report.trustedHost.authority) } }),
    ...(report.windows === undefined ? {} : { windows: { ...report.windows, serviceIdentity: { ...report.windows.serviceIdentity, account: "<user>" } } }),
  };
}
