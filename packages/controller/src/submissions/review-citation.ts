import { DomainError } from "../domain/errors.js";
import { text } from "../domain/model.js";
import type { CommandRunner } from "../domain/runner.js";
import { relianceIdOf, topicIdOf, type OwnerDecisionBody, type RelianceBody, type TopicBody } from "../decisions/records.js";
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
 * The owner's task-level decision that overrides a project-wide decision for this one task (card C08): a decision of the task on the same topic that is not superseded. The project-wide decision stays in force for
 * the other tasks, not for this one, so a verdict or QA evidence of this task is not judged against it, and one that was stops counting. Undefined `by` for a task-level decision or when the task has none on the
 * topic. `check` is the topic record's revision, so a write that relies on the answer is ordered against a decision recorded meanwhile.
 */
export async function overriddenFor(runner: Pick<CommandRunner, "get">, taskId: string, d: OwnerDecisionBody): Promise<{ readonly by?: string; readonly check?: Change }> {
  if (d.taskId !== undefined) return {};
  const found = await runner.get("decision-topic", topicIdOf(d.projectId, d.topic));
  const by = ((found?.body as unknown as TopicBody | undefined)?.entries ?? []).find((e) => e.taskId === taskId && e.state !== "superseded")?.id;
  return { ...(by === undefined ? {} : { by }), ...(found === undefined ? {} : { check: { type: "check", ref: { kind: "decision-topic", id: found.id }, expectedRevision: found.revision } satisfies Change }) };
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
    const over = await overriddenFor(runner, scope.taskId, body!);
    if (over.by !== undefined) bad("decisions", `${d} is the project-wide decision, but for this task the owner's task-level decision ${over.by} overrides it: a verdict is judged against the decisions in force for the task`);
    versions[d] = body!.version;
    changes.push({ type: "check", ref: { kind: "decision", id: d }, expectedRevision: got!.revision }, ...(over.check === undefined ? [] : [over.check]));
  }
  return { versions, changes };
}

/**
 * Card C08 as Q02 asks it: work bound to a superseded decision fails review. Every approval, cited or not, is refused while a decision the task relies on (`decision.link`) is no longer in force: its link was marked
 * superseded, or the decision itself is superseded or disputed (read from the decision, as the C08 guard does, so the time before propagation marks the link is covered too). A rejection or a request for changes is
 * not held to it (it is the right answer to such work). An approval that cites (`named` given) must also name every decision the task relies on. Returns the checks on the reliance record and on each decision read,
 * so a correction or a new link racing the approval lands strictly before or after it, and the decisions the approval was judged against (`relied`, `basisKey` of each link), which the approval keeps so a later
 * correction takes it back (`approvalOutdated`).
 */
export async function readApprovalReliance(runner: Pick<CommandRunner, "get">, taskId: string, named: readonly string[] | undefined): Promise<{ readonly changes: readonly Change[]; readonly relied: readonly string[] }> {
  const found = await runner.get("decision-reliance", relianceIdOf(taskId));
  if (found === undefined) return { changes: [], relied: [] };
  const changes: Change[] = [{ type: "check", ref: { kind: "decision-reliance", id: found.id }, expectedRevision: found.revision }];
  const seen = new Set<string>();
  const relied: string[] = [];
  for (const l of (found.body as unknown as RelianceBody).links ?? []) {
    const got = await runner.get("decision", l.decisionId);
    const d = got?.body as unknown as OwnerDecisionBody | undefined;
    if (got !== undefined && !seen.has(got.id)) { seen.add(got.id); changes.push({ type: "check", ref: { kind: "decision", id: got.id }, expectedRevision: got.revision }); }
    // Fail closed: a relied-on decision that cannot be read (decisions are never removed, so only damaged or partly restored data does this) refuses the approval like one no longer in force.
    if (d === undefined) bad("decisions", `the task relies on decision ${l.decisionId}, which cannot be read: an approval waits until the owner or the task's agent revalidates the work against the current decision (decision.revalidate); a request for changes or a rejection can be recorded now`);
    else if (d.state === "disputed") bad("decisions", `the task relies on decision ${l.decisionId}, which is disputed (the owner's instructions conflict): an approval waits until the owner settles it, and the work is revalidated (decision.revalidate) if another decision is chosen; a request for changes or a rejection can be recorded now`);
    else if (l.state !== "current" || d.state !== "active") {
      const by = d.supersededBy ?? l.supersededBy;
      bad("decisions", `the task relies on decision ${l.decisionId}, which ${d.state === "active" && l.because !== undefined ? `no longer applies to it (${l.because})` : `was superseded${by === undefined ? "" : ` by ${by}`}`}: an approval waits until the owner or the task's agent revalidates the work against the current decision (decision.revalidate); a request for changes or a rejection can be recorded now`);
    }
    if (named !== undefined && !named.includes(l.decisionId)) bad("decisions", `the task relies on decision ${l.decisionId}: name it in decisions (an approval that cites names every decision the task relies on)`);
    const key = basisKey(l.decisionId, l.version);
    if (!relied.includes(key)) relied.push(key);
  }
  return { changes, relied };
}

/** One relied-on decision as an approval's basis keeps it (card Q02, stale approvals): the decision ID and the version the task's link was made against. */
export const basisKey = (decisionId: string, version: number): string => `${decisionId}@${version}`;
