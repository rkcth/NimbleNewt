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
 * Reads what a cited verdict names, as the QA evidence record does: the task contract must still be at the cited version (else `stale_revision`: read the current criteria and judge again), each decision must be one of
 * the task or its project and in force, and an approval of work that relies on a decision that was superseded, or on one the review does not name, is refused (card C08: work bound to a superseded decision fails
 * review; a rejection or a request for changes is still allowed, since it is the right answer). Returns the version of each decision cited and the checks that keep the write from running on a decision that changed meanwhile.
 */
export async function readReviewCite(runner: Pick<CommandRunner, "get">, scope: { readonly projectId: string; readonly taskId: string }, cite: ReviewCite, verdict: string): Promise<{ readonly versions: Readonly<Record<string, number>>; readonly changes: readonly Change[] }> {
  const contract = (await runner.get("task-contract", scope.taskId))?.body as unknown as { version?: number } | undefined;
  const version = contract?.version ?? 0;
  if (version !== cite.criteriaRevision) throw new DomainError("stale_revision", `the task contract is at version ${version}, not ${cite.criteriaRevision}: read its acceptance criteria and judge against them`, { currentRevision: version });
  const versions: Record<string, number> = {};
  const changes: Change[] = [];
  for (const d of cite.decisions) {
    const found = await runner.get("decision", d);
    const body = found?.body as unknown as OwnerDecisionBody | undefined;
    if (found === undefined || body === undefined || body.projectId !== scope.projectId || (body.taskId !== undefined && body.taskId !== scope.taskId)) bad("decisions", `${d} is not a decision of this task or its project`);
    if (body!.state !== "active") bad("decisions", `${d} is ${body!.state}${body!.supersededBy === undefined ? "" : ` (the current one is ${body!.supersededBy})`}: a verdict is judged against the decisions in force`);
    versions[d] = body!.version;
    changes.push({ type: "check", ref: { kind: "decision", id: d }, expectedRevision: found!.revision });
  }
  if (verdict === "approve") {
    const reliance = (await runner.get("decision-reliance", relianceIdOf(scope.taskId)))?.body as unknown as RelianceBody | undefined;
    for (const l of reliance?.links ?? []) {
      if (l.state !== "current") bad("decisions", `the task relies on decision ${l.decisionId}, which was superseded: the work is revalidated against the current decision (decision.revalidate) before it can be approved`);
      if (!cite.decisions.includes(l.decisionId)) bad("decisions", `the task relies on decision ${l.decisionId}: name it`);
    }
  }
  return { versions, changes };
}
