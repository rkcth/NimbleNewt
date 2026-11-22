import type { Check } from "../policy/integration-policy.js";
import { redactText } from "../security/redact.js";

/**
 * The landing gate (card P09): before a landing writes anything, the project's required checks (the integration policy, read through `IntegrationPolicyService.effective`) are judged against the exact tree the landing would
 * make, and the landing is made only when every one of them passed. What each check means here:
 * - `tests`: the task contract's test commands (`contract.set checks`) are run by the host that holds the checkout, in the sandbox, on a fresh copy of the integrated tree (the tree of the checkout's head commit; a landing is made
 *   only while the checkout's base is the landing branch's head, so that tree is what the branch holds once it has landed). Each result is bound to that tree ID. A contract change the author made itself is not used (its last
 *   version by anyone else is), so an author cannot loosen the checks its own landing runs.
 * - `review`: the landing names the reviewed code submission (`submissionId`). Its newest review must approve it, and the patch ID of its base and tree (computed by the host, and equal to the one the submission names) must
 *   equal the patch ID of the change being landed: an approval carries over to a different tree (a refresh onto a newer base) only while the patch is unchanged; any other change needs a new review. The submitter of that
 *   submission counts as an author too (its own contract versions are not used).
 * - `qa` (P09 third slice): the landing names the code submission (`submissionId`); its QA gate (Q02, independent evidence bound to that submission's tree, criteria and decisions) must pass, read again after the host's run,
 *   and the evidence carries over to the integrated tree only while the patch is unchanged (the same host-computed patch ID rule as `review`). A gate that failed fails the check with its reasons; a gate with no independent
 *   evidence at all is `not_run`. Both count as failed.
 * - `docs` (P09 fourth slice): the landing names the code submission; every documentation obligation (Q03) still kept that describes the task must be verified against that code (its tree) with the QA gate of that code still
 *   passing. Pending documents fail the check and are named; a task no document describes has nothing pending. Read again after the host's run and bound to the landed patch exactly as `qa` is (the evidence is for the
 *   submission's tree). No submission, no reader wired, or an unreadable answer is `not_run`.
 * - `director`: not collected at landing yet, so it is `not_run` (counted as failed) when required.
 * `not_run` counts as failed: the landing passes only when every required check is `pass`. A host that cannot run the checks or read the change makes every required check `not_run`. A project that requires no check is not gated
 * and the host is not asked. When `tests` had no commands to run (none set, or only by the task's authors), the record says so (`testsNeedOwner`) so the owner can be told. When the gate stops waiting for the host, it aborts
 * the call's `signal` so the host stops the checks' processes.
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
  /**
   * `tests` was required but there were no test commands to run, which only someone other than the task's authors can fix: `authors-only` when the only versions that set the contract's checks were stored by its authors
   * (the assignee or the submitter of the landed submission), `no-commands` when no contract names any (or it could not be read). The owner is then told (a needs-you notice), since the author cannot make the checks pass.
   */
  readonly testsNeedOwner?: "authors-only" | "no-commands";
}

/** What the host that holds the checkout answers (the worker package's `LocalWorkspaces.port.landingChecks`); restated here, the controller imports no worker code. */
export interface LandingCheckHostReport {
  readonly checkout: boolean;
  readonly change?: { readonly base: string; readonly head: string; readonly tree: string; readonly patchId?: string };
  readonly problem?: string;
  readonly checks: readonly { readonly name: string; readonly state: "passed" | "failed" | "not-run"; readonly exitCode?: number | null; readonly signal?: string | null; readonly timedOut?: boolean; readonly output?: string; readonly reason?: string; readonly ms?: number }[];
  /** When `reviewed` was asked: the stable patch ID the host computed itself from the reviewed submission's base and tree (the submission's own `patchId` is the submitter's word). */
  readonly reviewedPatchId?: string;
  /** Why `reviewedPatchId` could not be computed. */
  readonly reviewedProblem?: string;
}
export interface LandingCheckHost {
  landingChecks?(call: { readonly taskId: string; readonly projectId: string; readonly checks: readonly { readonly name: string; readonly run: readonly string[]; readonly timeoutMs: number }[]; readonly maxOutputBytes: number; /** The reviewed code submission's base commit and tree: the host computes their patch ID from its own objects. */ readonly reviewed?: { readonly base: string; readonly tree: string }; /** Aborted when the gate stops waiting for the answer: the host then stops the checks' processes and starts no more. */ readonly signal?: AbortSignal }): Promise<LandingCheckHostReport>;
}

export interface ContractTests {
  readonly version: number;
  readonly checks: readonly { readonly name: string; readonly run: readonly string[]; readonly timeoutSeconds?: number }[];
  /** True when the contract's checks were set only by the task's own authors (`checks` is then empty: none of them run). */
  readonly onlyAuthors?: boolean;
}
/** The QA gate of a code submission as the landing gate needs it (`QaEvidenceService.gate`). */
export interface QaGateView { readonly taskId: string; readonly submissionId: string; readonly tree: string; readonly verdict: "passed" | "failed"; readonly reasons: readonly string[]; readonly counts?: { readonly passed: number; readonly failed: number; readonly blocked: number; readonly notRun: number; readonly missing: number } }
/** The documents gate of a code submission as the landing gate needs it (`DocObligationService.landing`): the documents describing the task that are not verified against that code. */
export interface DocsGateView { readonly taskId: string; readonly submissionId: string; readonly tree: string; readonly checked: number; readonly pending: readonly { readonly obligationId: string; readonly title: string; readonly reason: string }[] }
export interface ReviewedSubmission { readonly taskId: string; readonly base: string; readonly tree: string; readonly submittedBy?: string; readonly patchId?: string; readonly approved: boolean; readonly approvedBy?: string; readonly newest?: "approve" | "changes" | "reject"; readonly reason?: string }
export interface LandingGateDeps {
  /** The project's required checks (`IntegrationPolicyService.effective`). */
  readonly requiredChecks: (projectId: string) => Promise<readonly Check[]>;
  /** The task contract's test commands, leaving out a change any of the authors (the assignee and the submitter of the landed submission) made itself (`undefined`: no contract). */
  readonly tests: (taskId: string, authors: readonly string[]) => Promise<ContractTests | undefined>;
  /** Whether a code submission is approved, and its patch ID (`SubmissionService.approvalOf`). */
  readonly approvalOf: (submissionId: string) => Promise<ReviewedSubmission | undefined>;
  /** The QA gate of a code submission (`QaEvidenceService.gate`, read as the controller); absent: the `qa` check is not collected (`not_run`). */
  readonly qaGate?: (submissionId: string) => Promise<QaGateView | undefined>;
  /** The documentation obligations pending for a code submission (`DocObligationService.landing`, read as the controller); absent: the `docs` check is not collected (`not_run`). */
  readonly docsGate?: (taskId: string, submissionId: string) => Promise<DocsGateView | undefined>;
  readonly now: () => string;
}

export const LANDING_GATE_LIMITS = { summary: 300, note: 300, checkOutputBytes: 64 * 1024, defaultCheckSeconds: 600, marginMs: 60_000 } as const;
const OID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const PATCH = /^[0-9a-f]{40,64}$/;
/** The end of a check's output (where a failure is told), cleaned and cut like `clip`. */
const clipEnd = (text: string, max: number): string => { const clean = clip(text, Number.MAX_SAFE_INTEGER); if (clean.length <= max) return clean; let from = clean.length - (max - 3); const c = clean.charCodeAt(from); if (c >= 0xdc00 && c <= 0xdfff) from += 1; return `...${clean.slice(from)}`; };
// Half a surrogate pair is ill-formed text (refused or mangled by readers and stores): one in the input becomes a space, and no cut ends between the two halves of a pair.
const clip = (text: string, max: number): string => { const clean = redactText(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu, " ").replace(/\s+/g, " ").trim(); return clean.length <= max ? clean : `${wholeCut(clean, max - 3)}...`; };
/** At most `max` UTF-16 units of `text`, never ending between the two halves of a surrogate pair. */
const wholeCut = (text: string, max: number): string => { if (text.length <= max) return text; let end = Math.max(0, max); const c = text.charCodeAt(end - 1); if (end > 0 && c >= 0xd800 && c <= 0xdbff) end -= 1; return text.slice(0, end); };

export class LandingGate {
  readonly #deps: LandingGateDeps;
  readonly #marginMs: number;
  /** `marginMs` (tests only): how long past the commands' own time the gate waits for the host (default `LANDING_GATE_LIMITS.marginMs`). */
  constructor(deps: LandingGateDeps, options: { readonly marginMs?: number } = {}) { this.#deps = deps; this.#marginMs = options.marginMs ?? LANDING_GATE_LIMITS.marginMs; }

  /** Judges one landing. Never throws for what the host or a record says: anything that cannot be looked at is `not_run`. It throws only when the required checks themselves cannot be read (nothing is then landed). */
  async evaluate(call: { readonly taskId: string; readonly projectId: string; readonly submissionId?: string; readonly author?: string; readonly host: LandingCheckHost | undefined }): Promise<LandingChecksRecord> {
    const at = this.#deps.now();
    const required = [...(await this.#deps.requiredChecks(call.projectId))];
    const sub = call.submissionId === undefined ? {} : { submissionId: call.submissionId };
    if (required.length === 0) return { required, passed: true, ...sub, results: [], at };
    // The reviewed submission is read first: the host computes the patch ID of its base and tree, and its submitter is an author whose own contract versions are not used.
    let reviewed: ReviewedSubmission | undefined;
    let reviewProblem: string | undefined;
    if (call.submissionId !== undefined) { try { reviewed = await this.#deps.approvalOf(call.submissionId); } catch (error) { reviewProblem = String((error as Error)?.message ?? error); } }
    if (reviewed !== undefined && reviewed.taskId !== call.taskId) reviewed = undefined;
    const authors = [...new Set([call.author, reviewed?.submittedBy].filter((a): a is string => typeof a === "string" && a !== ""))];
    const contract = required.includes("tests") ? await this.#deps.tests(call.taskId, authors) : undefined;
    const commands = (contract?.checks ?? []).slice(0, 10).map((c) => ({ name: c.name, run: [...c.run], timeoutMs: (c.timeoutSeconds ?? LANDING_GATE_LIMITS.defaultCheckSeconds) * 1000 }));
    const none = (why: string): LandingChecksRecord => ({ required, passed: false, ...sub, results: required.map((check) => ({ check, result: "not_run" as const, summary: clip(why, LANDING_GATE_LIMITS.summary) })), at });
    if (call.host?.landingChecks === undefined) return none("the host that holds the task's checkout cannot run landing checks, so nothing about the integrated tree is known");
    let report: LandingCheckHostReport;
    // When the gate stops waiting, the host is told (the signal is aborted) so it stops the checks' processes instead of leaving them running on their copies after the landing was refused.
    const stop = new AbortController();
    try {
      const limit = commands.reduce((n, c) => n + c.timeoutMs, 0) + this.#marginMs;
      let timer: NodeJS.Timeout | undefined;
      try {
        report = await Promise.race([
          call.host.landingChecks({ taskId: call.taskId, projectId: call.projectId, checks: commands, maxOutputBytes: LANDING_GATE_LIMITS.checkOutputBytes, ...(reviewed === undefined || !(required.includes("review") || required.includes("qa") || required.includes("docs")) ? {} : { reviewed: { base: reviewed.base, tree: reviewed.tree } }), signal: stop.signal }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`the host did not answer within ${Math.round(limit / 1000)} s`)), limit); timer.unref?.(); }),
        ]);
      } finally { if (timer !== undefined) clearTimeout(timer); }
    } catch (error) { stop.abort(error); /* gave up waiting, or the call failed: the host stops what it still runs */ return none(`the host could not run the landing checks: ${String((error as Error)?.message ?? error)}`); }
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
      else if (check === "review") results.push(await this.#review(call, tree, patchId, bound, reviewed, reviewProblem, report));
      else if (check === "qa") results.push(await this.#qa(call, tree, patchId, bound, reviewed, reviewProblem, report));
      else if (check === "docs") results.push(await this.#docs(call, tree, patchId, bound, reviewed, reviewProblem, report));
      else results.push({ check, result: "not_run", ...bound, summary: `the ${check} check is not collected at landing yet, so it has not run for this tree` });
    }
    const needOwner = patchId !== undefined && required.includes("tests") && commands.length === 0 ? { testsNeedOwner: contract?.onlyAuthors === true ? ("authors-only" as const) : ("no-commands" as const) } : {};
    return { required, passed: results.every((r) => r.result === "pass"), base: change.base, tree, ...(patchId === undefined ? {} : { patchId }), ...sub, ...(contract === undefined ? {} : { contractVersion: contract.version }), results, at, ...needOwner };
  }

  #tests(contract: ContractTests | undefined, commands: readonly { name: string }[], report: LandingCheckHostReport, bound: { boundTo: string }): LandingCheckEntry {
    if (commands.length === 0) return { check: "tests", result: "not_run", ...bound, summary: contract?.onlyAuthors === true ? "the task's test commands (contract.set checks) were set only by its own authors, which a landing does not use, so no tests ran; the owner (or another agent that may change the contract) has to set or accept them" : contract === undefined ? "the task has no contract naming test commands (contract.set checks), or its versions could not be read, so no tests ran" : "the task's contract names no test commands (contract.set checks), so no tests ran" };
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

  async #qa(call: { readonly taskId: string; readonly submissionId?: string }, tree: string, patchId: string, bound: { boundTo: string }, before: ReviewedSubmission | undefined, problem: string | undefined, report: LandingCheckHostReport): Promise<LandingCheckEntry> {
    const no = (result: LandingCheckResult, why: string): LandingCheckEntry => ({ check: "qa", result, ...bound, summary: clip(why, LANDING_GATE_LIMITS.summary) });
    if (call.submissionId === undefined) return no("not_run", "the landing names no code submission (submissionId), so no QA evidence applies to it");
    if (this.#deps.qaGate === undefined) return no("not_run", "the qa check is not collected at landing yet, so it has not run for this tree");
    if (problem !== undefined) return no("not_run", `the submission could not be read: ${problem}`);
    // Read again after the host's run: evidence can be invalidated while the tests ran; the submission's base and tree never change.
    let a: ReviewedSubmission | undefined;
    let g: QaGateView | undefined;
    try { a = await this.#deps.approvalOf(call.submissionId); g = await this.#deps.qaGate(call.submissionId); } catch (error) { return no("not_run", `the QA gate could not be read: ${String((error as Error)?.message ?? error)}`); }
    if (a === undefined || a.taskId !== call.taskId || before === undefined) return no("not_run", `${call.submissionId} is not a code submission of this task`);
    if (g === undefined || g.submissionId !== call.submissionId || g.taskId !== call.taskId || g.tree !== a.tree) return no("not_run", `the QA gate of ${call.submissionId} could not be read for the tree it names`);
    if (g.verdict !== "passed") {
      const reasons = g.reasons.join(", ") || "no reason given";
      // No independent evidence at all is not run; the contract's required checks are then each `missing` too (`check_missing`), which says the same. Anything else failed.
      const none = g.reasons.includes("no_evidence") && g.reasons.every((r) => r === "no_evidence" || r === "check_missing");
      return no(none ? "not_run" : "fail",`the QA gate of ${call.submissionId} (tree ${g.tree.slice(0, 12)}) did not pass: ${reasons}`);
    }
    // Evidence is bound to the submission's tree; it counts for the integrated tree only while the patch is the one the host computes from that base and tree.
    const computed = typeof report.reviewedPatchId === "string" && PATCH.test(report.reviewedPatchId) && a.base === before.base && a.tree === before.tree ? report.reviewedPatchId : undefined;
    if (computed === undefined) return no("not_run", `the host could not compute the patch ID of what was checked in ${call.submissionId}${typeof report.reviewedProblem === "string" ? `: ${report.reviewedProblem}` : ""}`);
    if (a.patchId !== computed) return no("fail", `${call.submissionId} names patch ${String(a.patchId ?? "none").slice(0, 12)}, but its base and tree make patch ${computed.slice(0, 12)}; new QA evidence on a new submission is needed`);
    if (computed !== patchId) return no("fail", `the change differs from what QA checked: the evidence is for patch ${computed.slice(0, 12)}, the landing carries patch ${patchId.slice(0, 12)}; new QA evidence is needed`);
    return no("pass", a.tree !== tree ? `independent QA evidence passed for tree ${a.tree.slice(0, 12)}; carried over to this tree because the patch is unchanged` : "independent QA evidence passed for this tree");
  }

  async #docs(call: { readonly taskId: string; readonly submissionId?: string }, tree: string, patchId: string, bound: { boundTo: string }, before: ReviewedSubmission | undefined, problem: string | undefined, report: LandingCheckHostReport): Promise<LandingCheckEntry> {
    const no = (result: LandingCheckResult, why: string): LandingCheckEntry => ({ check: "docs", result, ...bound, summary: clip(why, LANDING_GATE_LIMITS.summary) });
    if (call.submissionId === undefined) return no("not_run", "the landing names no code submission (submissionId), so no documentation applies to it");
    if (this.#deps.docsGate === undefined) return no("not_run", "the docs check is not collected at landing yet, so it has not run for this tree");
    if (problem !== undefined) return no("not_run", `the submission could not be read: ${problem}`);
    // Read again after the host's run (a document can be flagged while the tests ran); the submission's base and tree never change.
    let a: ReviewedSubmission | undefined;
    let g: DocsGateView | undefined;
    try { a = await this.#deps.approvalOf(call.submissionId); g = await this.#deps.docsGate(call.taskId, call.submissionId); } catch (error) { return no("not_run", `the documentation could not be read: ${String((error as Error)?.message ?? error)}`); }
    if (a === undefined || a.taskId !== call.taskId || before === undefined) return no("not_run", `${call.submissionId} is not a code submission of this task`);
    if (g === undefined || g.submissionId !== call.submissionId || g.taskId !== call.taskId || g.tree !== a.tree || !Array.isArray(g.pending) || typeof g.checked !== "number" || g.checked < g.pending.length) return no("not_run", `the documentation of ${call.submissionId} could not be read for the tree it names`);
    if (g.pending.length > 0) {
      // Up to five documents are named whole while they fit the summary (the first always, shortened if it must be); the rest are counted, so the author knows how many remain.
      const head = `${g.pending.length} of ${g.checked} document(s) describing this task are not verified against ${call.submissionId} (tree ${g.tree.slice(0, 12)}): `;
      const room = LANDING_GATE_LIMITS.summary - 20;
      let names = "";
      let shown = 0;
      for (const p of g.pending.slice(0, 5)) {
        const part = `${String(p.title)} (${String(p.reason)})`;
        const next = shown === 0 ? part : `${names}; ${part}`;
        if (head.length + next.length > room) {
          if (shown === 0) { names = `${wholeCut(part, room - head.length - 3)}...`; shown = 1; }
          break;
        }
        names = next;
        shown += 1;
      }
      const more = g.pending.length - shown;
      return no("fail", `${head}${names}${more > 0 ? `; and ${more} more` : ""}`);
    }
    // The documents were verified against the submission's tree; that counts for the integrated tree only while the patch is the one the host computes from that base and tree.
    const computed = typeof report.reviewedPatchId === "string" && PATCH.test(report.reviewedPatchId) && a.base === before.base && a.tree === before.tree ? report.reviewedPatchId : undefined;
    if (computed === undefined) return no("not_run", `the host could not compute the patch ID of what the documents were checked against in ${call.submissionId}${typeof report.reviewedProblem === "string" ? `: ${report.reviewedProblem}` : ""}`);
    if (a.patchId !== computed) return no("fail", `${call.submissionId} names patch ${String(a.patchId ?? "none").slice(0, 12)}, but its base and tree make patch ${computed.slice(0, 12)}; a new submission and a new documentation check are needed`);
    if (computed !== patchId) return no("fail", `the change differs from the code the documents were checked against: that is patch ${computed.slice(0, 12)}, the landing carries patch ${patchId.slice(0, 12)}; the documents must be verified against the new code`);
    return no("pass", g.checked === 0 ? "no documentation obligation describes this task" : `all ${g.checked} document(s) describing this task are verified against ${a.tree !== tree ? `tree ${a.tree.slice(0, 12)} (carried over to this tree because the patch is unchanged)` : "this tree"}`);
  }

  async #review(call: { readonly taskId: string; readonly submissionId?: string }, tree: string, patchId: string, bound: { boundTo: string }, before: ReviewedSubmission | undefined, problem: string | undefined, report: LandingCheckHostReport): Promise<LandingCheckEntry> {
    if (call.submissionId === undefined) return { check: "review", result: "not_run", ...bound, summary: "the landing names no reviewed code submission (submissionId), so no review applies to it" };
    if (problem !== undefined) return { check: "review", result: "not_run", ...bound, summary: clip(`the review could not be read: ${problem}`, LANDING_GATE_LIMITS.summary) };
    // Read again after the host's run (a review may have asked for changes while the tests ran); the submission's base and tree never change.
    let a: ReviewedSubmission | undefined;
    try { a = await this.#deps.approvalOf(call.submissionId); } catch (error) { return { check: "review", result: "not_run", ...bound, summary: clip(`the review could not be read: ${String((error as Error)?.message ?? error)}`, LANDING_GATE_LIMITS.summary) }; }
    if (a === undefined || a.taskId !== call.taskId || before === undefined) return { check: "review", result: "not_run", ...bound, summary: `${call.submissionId} is not a code submission of this task` };
    if (!a.approved) return { check: "review", result: a.newest === undefined ? "not_run" : "fail", ...bound, summary: clip(`${call.submissionId} is not approved (${a.reason ?? "no approval"})`, LANDING_GATE_LIMITS.summary) };
    // The patch ID compared is the one the host computed from the reviewed base and tree, never only the submitter's word for it.
    const computed = typeof report.reviewedPatchId === "string" && PATCH.test(report.reviewedPatchId) && a.base === before.base && a.tree === before.tree ? report.reviewedPatchId : undefined;
    if (computed === undefined) return { check: "review", result: "not_run", ...bound, summary: clip(`the host could not compute the patch ID of what was reviewed in ${call.submissionId}${typeof report.reviewedProblem === "string" ? `: ${report.reviewedProblem}` : ""}`, LANDING_GATE_LIMITS.summary) };
    if (a.patchId !== computed) return { check: "review", result: "fail", ...bound, summary: clip(`${call.submissionId} names patch ${String(a.patchId ?? "none").slice(0, 12)}, but its base and tree make patch ${computed.slice(0, 12)}; a new submission and review are needed`, LANDING_GATE_LIMITS.summary) };
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
  if (r.testsNeedOwner !== undefined) lines.push("The task has no test commands a landing can use, which you cannot change yourself (your own contract changes do not count); the owner was told.");
  lines.push("Fix what failed in your checkout and submit it again; the landing is asked for again after that.");
  const text = lines.join("\n");
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}
