import { DomainError } from "../domain/errors.js";
import { text } from "../domain/model.js";
import type { CommandRunner } from "../domain/runner.js";
import { relianceIdOf, type OwnerDecisionBody, type RelianceBody } from "../decisions/records.js";
import { redactText } from "../security/redact.js";
import type { Change } from "../storage/types.js";

/** What a reviewer's verdict may cite (card Q02, sixth slice): the task contract version it judged against, the owner decisions in force, and, for a rejection, the owner requirement that is not met. */
export interface ReviewCite { readonly criteriaRevision: number; readonly decisions: readonly string[]; readonly unmet?: string }

/** The most decisions one verdict cites, and the longest text of an unmet requirement. */
export const REVIEW_CITE_LIMITS = { decisions: 20, unmet: 500 } as const;
const DEC = /^dec-[a-z2-7]{20}$/;
const bad = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/**
 * The shape of what a review cites, before anything is read. Nothing cited is the old, uncited review (undefined). Decisions or an unmet requirement without a criteria version are refused (a verdict that cites
 * anything cites the version of the acceptance criteria it judged against); a rejection that cites must say which owner requirement is unmet, and no other verdict may carry one.
 */
export function shapeReviewCite(c: { readonly criteriaRevision?: unknown; readonly decisions?: unknown; readonly unmet?: unknown }, verdict: string | undefined): ReviewCite | undefined {
  if (c.criteriaRevision === undefined) {
    if (c.decisions !== undefined) bad("decisions", "name the criteria version you judged against too (criteriaRevision)");
    if (c.unmet !== undefined) bad("unmet", "name the criteria version you judged against too (criteriaRevision)");
    return undefined;
  }
  if (typeof c.criteriaRevision !== "number" || !Number.isSafeInteger(c.criteriaRevision) || c.criteriaRevision < 0) bad("criteriaRevision", "must be the task contract version you judged against (0 when it has none)");
  const decisions = c.decisions === undefined ? [] : c.decisions;
  if (!Array.isArray(decisions) || decisions.length > REVIEW_CITE_LIMITS.decisions || decisions.some((d) => typeof d !== "string" || !DEC.test(d)) || new Set(decisions).size !== decisions.length) bad("decisions", `must be a list of at most ${REVIEW_CITE_LIMITS.decisions} different decision IDs`);
  if (verdict !== "reject" && c.unmet !== undefined) bad("unmet", "only a rejection names the owner requirement it found unmet");
  if (verdict === "reject" && c.unmet === undefined) bad("unmet", "a rejection that cites the criteria names the owner requirement (a criterion or a decision) that is not met");
  const unmet = c.unmet === undefined ? undefined : redactText(text(c.unmet, "unmet", { min: 1, max: REVIEW_CITE_LIMITS.unmet, multiline: true }));
  return { criteriaRevision: c.criteriaRevision as number, decisions: [...decisions as string[]], ...(unmet === undefined ? {} : { unmet }) };
}

/**
 * Reads what a cited verdict names, as the QA evidence record does: the task contract must still be at the cited version (else `stale_revision`: read the current criteria and judge again), and each decision must be
 * one of the task or its project and in force. Returns the version of each decision cited and the checks that keep the write from running on a contract or a decision that changed meanwhile.
 */
export async function readReviewCite(runner: Pick<CommandRunner, "get">, scope: { readonly projectId: string; readonly taskId: string }, cite: ReviewCite): Promise<{ readonly versions: Readonly<Record<string, number>>; readonly changes: readonly Change[] }> {
  const found = await runner.get("task-contract", scope.taskId);
  const version = (found?.body as unknown as { version?: number } | undefined)?.version ?? 0;
  if (version !== cite.criteriaRevision) throw new DomainError("stale_revision", `the task contract is at version ${version}, not ${cite.criteriaRevision}: read its acceptance criteria and judge against them`, { currentRevision: version });
  const versions: Record<string, number> = {};
  const changes: Change[] = found === undefined ? [] : [{ type: "check", ref: { kind: "task-contract", id: scope.taskId }, expectedRevision: found.revision }];
  for (const d of cite.decisions) {
    const got = await runner.get("decision", d);
    const body = got?.body as unknown as OwnerDecisionBody | undefined;
    if (got === undefined || body === undefined || body.projectId !== scope.projectId || (body.taskId !== undefined && body.taskId !== scope.taskId)) bad("decisions", `${d} is not a decision of this task or its project`);
    if (body!.state !== "active") bad("decisions", `${d} is ${body!.state}${body!.supersededBy === undefined ? "" : ` (the current one is ${body!.supersededBy})`}: a verdict is judged against the decisions in force`);
    versions[d] = body!.version;
    changes.push({ type: "check", ref: { kind: "decision", id: d }, expectedRevision: got!.revision });
  }
  return { versions, changes };
}

/**
 * Card C08 as Q02 asks it: work bound to a superseded decision fails review. Every approval, cited or not, is refused while a decision the task relies on (`decision.link`) is no longer in force: its link was marked
 * superseded, or the decision itself is superseded or disputed (read from the decision, as the C08 guard does, so the time before propagation marks the link is covered too). A rejection or a request for changes is
 * not held to it (it is the right answer to such work). An approval that cites (`named` given) must also name every decision the task relies on. Returns the checks on the reliance record and on each decision read,
 * so a correction or a new link racing the approval lands strictly before or after it.
 */
export async function readApprovalReliance(runner: Pick<CommandRunner, "get">, taskId: string, named: readonly string[] | undefined): Promise<readonly Change[]> {
  const found = await runner.get("decision-reliance", relianceIdOf(taskId));
  if (found === undefined) return [];
  const changes: Change[] = [{ type: "check", ref: { kind: "decision-reliance", id: found.id }, expectedRevision: found.revision }];
  const seen = new Set<string>();
  for (const l of (found.body as unknown as RelianceBody).links ?? []) {
    const got = await runner.get("decision", l.decisionId);
    const d = got?.body as unknown as OwnerDecisionBody | undefined;
    if (got !== undefined && !seen.has(got.id)) { seen.add(got.id); changes.push({ type: "check", ref: { kind: "decision", id: got.id }, expectedRevision: got.revision }); }
    if (l.state !== "current" || (d !== undefined && d.state !== "active")) {
      const now = d?.state === "disputed" ? "is disputed" : `was superseded${(d?.supersededBy ?? l.supersededBy) === undefined ? "" : ` by ${d?.supersededBy ?? l.supersededBy}`}`;
      bad("decisions", `the task relies on decision ${l.decisionId}, which ${now}: the work is revalidated against the current decision (decision.revalidate) before it can be approved`);
    }
    if (named !== undefined && !named.includes(l.decisionId)) bad("decisions", `the task relies on decision ${l.decisionId}: name it`);
  }
  return changes;
}
