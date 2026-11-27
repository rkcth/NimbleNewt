import type { ContainmentReport } from "./containment.js";
import { scrub, type RedactionNames } from "./windows-redact.js";

/*
 * Card G05: two helpers for containment evidence that the native Windows path (containment-windows-native-evidence.ts, scripts/containment-evidence.mjs) uses: reading the packaged controller
 * working-directory check's output (scripts/g05-workdir-check.mjs) and redacting a report for a public artifact. The Windows Sandbox era producer of the report's `windows` block (from the real
 * Windows Sandbox tests' summary.json) was removed with that backend (owner decision 2026-11-26); the release gate refuses a Windows report that still carries such a block.
 */

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
/** The working-directory check's output is small: a few booleans and fixed texts. */
export const MAX_WORKDIR_CHECK_BYTES = 64 * 1024;

/** Reads the working-directory check's output (scripts/g05-workdir-check.mjs) as data. Only `packaged` and `passed` are used. */
export function parseWorkdirCheck(raw: string): { packaged: boolean; passed: boolean } | { error: string } {
  if (Buffer.byteLength(raw, "utf8") > MAX_WORKDIR_CHECK_BYTES) return { error: "the working-directory check output is too large" };
  let v: unknown;
  try { v = JSON.parse(raw); } catch { return { error: "the working-directory check output is not JSON" }; }
  if (!isObject(v) || v["schema"] !== "nimblenewt.g05-workdir/1" || typeof v["packaged"] !== "boolean" || typeof v["passed"] !== "boolean") return { error: "not a working-directory check (schema, packaged, passed)" };
  return { packaged: v["packaged"], passed: v["passed"] };
}

/**
 * A copy of a containment report fit for a public artifact: only its free text (OS and backend descriptions, the capacity reason, each case's detail, the trusted-host authority and the
 * account of an old report's Windows Sandbox era `windows` block) goes through `scrub` (account, machine and home names, SIDs, addresses; a field that still looks personal is withheld whole). Identifiers, verdicts, the commit, the
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
