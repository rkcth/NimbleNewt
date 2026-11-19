import type { Check } from "../policy/integration-policy.js";
import { redactText } from "../security/redact.js";

/**
 * The landing gate (card P09): before a landing writes anything, the project's required checks (the integration policy, read through `IntegrationPolicyService.effective`) are judged against the exact tree the landing would
 * make, and the landing is made only when every one of them passed. What each check means here:
 * - `tests`: the task contract's test commands (`contract.set checks`) are run by the host that holds the checkout, in the sandbox, on a fresh copy of the integrated tree (the tree of the checkout's head commit; a landing is made
 *   only while the checkout's base is the landing branch's head, so that tree is what the branch holds once it has landed). Each result is bound to that tree ID. A contract change the author made itself is not used (its last
 *   version by anyone else is), so an author cannot loosen the checks its own landing runs.
 * - `review`: the landing names the reviewed code submission (`submissionId`). Its newest review must approve it, and its patch ID must equal the patch ID of the change being landed: an approval carries over to a different tree
 *   (a refresh onto a newer base) only while the patch is unchanged; any other change needs a new review.
 * - `qa`, `docs`, `director`: not collected at landing yet, so they are `not_run` (counted as failed) when required.
 * `not_run` counts as failed: the landing passes only when every required check is `pass`. A host that cannot run the checks or read the change makes every required check `not_run`. A project that requires no check is not gated
 * and the host is not asked.
 */
export type LandingCheckResult = "pass" | "fail" | "not_run";
export interface LandingCheckRunShown { readonly name: string; readonly state: "passed" | "failed" | "not-run"; readonly exitCode?: number | null; readonly timedOut?: boolean; readonly ms?: number; /** The end of its output or why it did not run, redacted and cut. */ readonly note?: string }
export interface LandingCheckEntry {
  readonly check: Check;
  readonly result: LandingCheckResult;
  /** The tree the result is about (the integrated tree); absent when the change could not be read. */
  readonly boundTo?: string;
  readonly summary: string;
  /** `tests` only: each command as it ran. */
  readonly runs?: readonly LandingCheckRunShown[];
}
/** What the gate found for one landing, kept on the landing's request record (`checks`). */
export interface LandingChecksRecord {
  readonly required: readonly Check[];
  readonly passed: boolean;
  readonly base?: string;
  /** The integrated tree every result is bound to. */
  readonly tree?: string;
  readonly patchId?: string;
  readonly submissionId?: string;
  /** The contract version whose test commands ran. */
  readonly contractVersion?: number;
  readonly results: readonly LandingCheckEntry[];
  readonly at: string;
}

/** What the host that holds the checkout answers (the worker package's `LocalWorkspaces.port.landingChecks`); restated here, the controller imports no worker code. */
export interface LandingCheckHostReport {
  readonly checkout: boolean;
  readonly change?: { readonly base: string; readonly head: string; readonly tree: string; readonly patchId?: string };
  readonly problem?: string;
  readonly checks: readonly { readonly name: string; readonly state: "passed" | "failed" | "not-run"; readonly exitCode?: number | null; readonly signal?: string | null; readonly timedOut?: boolean; readonly output?: string; readonly reason?: string; readonly ms?: number }[];
}
export interface LandingCheckHost {
  landingChecks?(call: { readonly taskId: string; readonly projectId: string; readonly checks: readonly { readonly name: string; readonly run: readonly string[]; readonly timeoutMs: number }[]; readonly maxOutputBytes: number }): Promise<LandingCheckHostReport>;
}

export interface ContractTests { readonly version: number; readonly checks: readonly { readonly name: string; readonly run: readonly string[]; readonly timeoutSeconds?: number }[] }
export interface ReviewedSubmission { readonly taskId: string; readonly tree: string; readonly patchId?: string; readonly approved: boolean; readonly approvedBy?: string; readonly newest?: "approve" | "changes" | "reject"; readonly reason?: string }
export interface LandingGateDeps {
  /** The project's required checks (`IntegrationPolicyService.effective`). */
  readonly requiredChecks: (projectId: string) => Promise<readonly Check[]>;
  /** The task contract's test commands, leaving out a change the author made itself (`undefined`: no contract). */
  readonly tests: (taskId: string, author: string | undefined) => Promise<ContractTests | undefined>;
  /** Whether a code submission is approved, and its patch ID (`SubmissionService.approvalOf`). */
  readonly approvalOf: (submissionId: string) => Promise<ReviewedSubmission | undefined>;
  readonly now: () => string;
}

export const LANDING_GATE_LIMITS = { summary: 300, note: 300, checkOutputBytes: 64 * 1024, defaultCheckSeconds: 600, marginMs: 60_000 } as const;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATCH = /^[0-9a-f]{40,64}$/;
/** The end of a check's output (where a failure is told), cleaned and cut like `clip`. */
const clipEnd = (text: string, max: number): string => { const clean = clip(text, Number.MAX_SAFE_INTEGER); return clean.length <= max ? clean : `...${clean.slice(-(max - 3))}`; };
const clip = (text: string, max: number): string => { const clean = redactText(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim(); return clean.length <= max ? clean : `${clean.slice(0, max - 3)}...`; };

export class LandingGate {
  readonly #deps: LandingGateDeps;
  constructor(deps: LandingGateDeps) { this.#deps = deps; }

  /** Judges one landing. Never throws for what the host or a record says: anything that cannot be looked at is `not_run`. It throws only when the required checks themselves cannot be read (nothing is then landed). */
  async evaluate(call: { readonly taskId: string; readonly projectId: string; readonly submissionId?: string; readonly author?: string; readonly host: LandingCheckHost | undefined }): Promise<LandingChecksRecord> {
    const at = this.#deps.now();
    const required = [...(await this.#deps.requiredChecks(call.projectId))];
    const sub = call.submissionId === undefined ? {} : { submissionId: call.submissionId };
    if (required.length === 0) return { required, passed: true, ...sub, results: [], at };
    const contract = required.includes("tests") ? await this.#deps.tests(call.taskId, call.author) : undefined;
    const commands = (contract?.checks ?? []).slice(0, 10).map((c) => ({ name: c.name, run: [...c.run], timeoutMs: (c.timeoutSeconds ?? LANDING_GATE_LIMITS.defaultCheckSeconds) * 1000 }));
    const none = (why: string): LandingChecksRecord => ({ required, passed: false, ...sub, results: required.map((check) => ({ check, result: "not_run" as const, summary: clip(why, LANDING_GATE_LIMITS.summary) })), at });
    if (call.host?.landingChecks === undefined) return none("the host that holds the task's checkout cannot run landing checks, so nothing about the integrated tree is known");
    let report: LandingCheckHostReport;
    try {
      const limit = commands.reduce((n, c) => n + c.timeoutMs, 0) + LANDING_GATE_LIMITS.marginMs;
      let timer: NodeJS.Timeout | undefined;
      try {
        report = await Promise.race([
          call.host.landingChecks({ taskId: call.taskId, projectId: call.projectId, checks: commands, maxOutputBytes: LANDING_GATE_LIMITS.checkOutputBytes }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the host did not answer within ${Math.round(limit / 1000)} s`)), limit); timer.unref?.(); }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    } catch (error) { return none(`the host could not run the landing checks: ${String((error as Error)?.message ?? error)}`); }
    if (report === null || typeof report !== "object" || report.checkout !== true) return none("the host holds no checkout for the task");
    const change = report.change;
    if (change === undefined || typeof change !== "object" || !OID.test(String(change.tree)) || !OID.test(String(change.base))) return none(`the change the landing would carry could not be read${typeof report.problem === "string" ? `: ${report.problem}` : ""}`);
    const patchId = typeof change.patchId === "string" && PATCH.test(change.patchId) ? change.patchId : undefined;
    const tree = change.tree;
    const bound = { boundTo: tree };
    const results: LandingCheckEntry[] = [];
    for (const check of required) {
      if (patchId === undefined) { results.push({ check, result: "not_run", ...bound, summary: "the checkout holds no committed change against its base, so there is nothing to land" }); continue; }
      if (check === "tests") results.push(this.#tests(contract, commands, report, bound));
      else if (check === "review") results.push(await this.#review(call, tree, patchId, bound));
      else results.push({ check, result: "not_run", ...bound, summary: `the ${check} check is not collected at landing yet, so it has not run for this tree` });
    }
    return { required, passed: results.every((r) => r.result === "pass"), base: change.base, tree, ...(patchId === undefined ? {} : { patchId }), ...sub, ...(contract === undefined ? {} : { contractVersion: contract.version }), results, at };
  }

  #tests(contract: ContractTests | undefined, commands: readonly { name: string }[], report: LandingCheckHostReport, bound: { boundTo: string }): LandingCheckEntry {
    if (commands.length === 0) return { check: "tests", result: "not_run", ...bound, summary: contract === undefined ? "the task has no contract naming test commands (contract.set checks), so no tests ran" : "the task's contract names no test commands (contract.set checks), so no tests ran" };
    const got = Array.isArray(report.checks) ? report.checks : [];
    const runs: LandingCheckRunShown[] = commands.map((c, i) => {
      const r = got[i] !== undefined && got[i]!.name === c.name ? got[i]! : got.find((x) => x?.name === c.name);
      if (r === undefined || !["passed", "failed", "not-run"].includes(r.state)) return { name: clip(c.name, 80), state: "not-run" as const, note: "the host did not report it" };
      const note = r.state === "not-run" ? r.reason : r.output;
      return { name: clip(c.name, 80), state: r.state, ...(r.exitCode === undefined ? {} : { exitCode: r.exitCode }), ...(r.timedOut === true ? { timedOut: true } : {}), ...(typeof r.ms === "number" ? { ms: r.ms } : {}), ...(typeof note === "string" && note.trim() !== "" ? { note: r.state === "not-run" ? clip(note, LANDING_GATE_LIMITS.note) : clipEnd(note.slice(-8000), LANDING_GATE_LIMITS.note) } : {}) };
    });
    const failed = runs.filter((r) => r.state === "failed"), notRun = runs.filter((r) => r.state === "not-run");
    const result: LandingCheckResult = failed.length > 0 ? "fail" : notRun.length > 0 ? "not_run" : "pass";
    const summary = result === "pass" ? `all ${runs.length} test command(s) passed on the integrated tree` : result === "fail" ? `${failed.length} of ${runs.length} test command(s) failed on the integrated tree: ${failed.map((r) => r.name).join(", ")}` : `${notRun.length} of ${runs.length} test command(s) did not run: ${notRun.map((r) => r.name).join(", ")}`;
    return { check: "tests", result, ...bound, summary: clip(summary, LANDING_GATE_LIMITS.summary), runs };
  }

  async #review(call: { readonly taskId: string; readonly submissionId?: string }, tree: string, patchId: string, bound: { boundTo: string }): Promise<LandingCheckEntry> {
    if (call.submissionId === undefined) return { check: "review", result: "not_run", ...bound, summary: "the landing names no reviewed code submission (submissionId), so no review applies to it" };
    let a: ReviewedSubmission | undefined;
    try { a = await this.#deps.approvalOf(call.submissionId); } catch (error) { return { check: "review", result: "not_run", ...bound, summary: clip(`the review could not be read: ${String((error as Error)?.message ?? error)}`, LANDING_GATE_LIMITS.summary) }; }
    if (a === undefined || a.taskId !== call.taskId) return { check: "review", result: "not_run", ...bound, summary: `${call.submissionId} is not a code submission of this task` };
    if (!a.approved) return { check: "review", result: a.newest === undefined ? "not_run" : "fail", ...bound, summary: clip(`${call.submissionId} is not approved (${a.reason ?? "no approval"})`, LANDING_GATE_LIMITS.summary) };
    if (a.patchId !== patchId) return { check: "review", result: "fail", ...bound, summary: clip(`the change differs from what was reviewed: ${call.submissionId} was approved for patch ${String(a.patchId ?? "none").slice(0, 12)}, the landing carries patch ${patchId.slice(0, 12)}; a new review is needed`, LANDING_GATE_LIMITS.summary) };
    const carried = a.tree !== tree;
    return { check: "review", result: "pass", ...bound, summary: clip(carried ? `approved by ${a.approvedBy ?? "a reviewer"} for tree ${a.tree.slice(0, 12)}; carried over to this tree because the patch is unchanged` : `approved by ${a.approvedBy ?? "a reviewer"} for this tree`, LANDING_GATE_LIMITS.summary) };
  }
}

/** The text the author is told when its landing was refused by the gate: each required check, its result and, for a failed or not run test command, the end of its output or the reason. At most `max` characters. */
export function landingChecksText(taskId: string, requestId: string, r: LandingChecksRecord, max = 3800): string {
  const lines = [`Your work on task ${taskId} was not landed: the required checks did not all pass on the integrated tree${r.tree === undefined ? "" : ` ${r.tree.slice(0, 12)}`} (request ${requestId}). A check that did not run counts as failed.`];
  for (const e of r.results) {
    lines.push(`- ${e.check}: ${e.result === "not_run" ? "not run" : e.result === "fail" ? "failed" : "passed"}. ${e.summary}`);
    for (const run of e.runs ?? []) if (run.state !== "passed") lines.push(`  - ${run.name}: ${run.state === "not-run" ? "did not run" : run.timedOut === true ? "timed out" : `exit ${String(run.exitCode ?? "none")}`}${run.note === undefined ? "" : `: ${run.note}`}`);
  }
  lines.push("Fix what failed in your checkout and submit it again; the landing is asked for again after that.");
  const text = lines.join("\n");
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
