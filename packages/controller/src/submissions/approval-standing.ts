import type { CommandRunner } from "../domain/runner.js";
import { relianceIdOf, type DisputeBody, type OwnerDecisionBody, type RelianceBody } from "../decisions/records.js";
import { basisKey } from "./review-citation.js";

/**
 * What an approval was judged against (card Q02: "changed dependency invalidates affected review", "work bound to a superseded decision fails review"), kept with the approval in the subject's verdict list:
 * the task contract version in force when it was recorded, and each decision the task relied on then (`basisKey`: the decision ID and the version of the task's link). Approvals recorded before this field have none
 * and are judged by their time instead (`approvalOutdated`).
 */
export interface ApprovalBasis { readonly criteriaRevision: number; readonly decisions: readonly string[] }

/** How many stored contract versions are read, newest first, to find the one in force when an approval without a basis was recorded; past that the approval is not counted (it cannot be told what it was judged on). */
export const APPROVAL_CONTRACT_WALK = 20;
const work = (c: Record<string, unknown> | undefined): Record<string, unknown> => ({ acceptanceCriteria: [], ...(c ?? {}) });
/**
 * The contract fields whose change takes an approval back: the criteria text a reviewer judged the work against. The checks and the required evidence are left out: the landing gate runs the contract's checks itself
 * (`tests`) and the QA gate judges required evidence (`qa`), so the owner adding a test command after a review does not need the review again (card P09 sets checks after the approval).
 */
export const APPROVAL_CRITERIA_FIELDS = ["expectedResult", "acceptanceCriteria"] as const;

/**
 * Why an approval recorded earlier no longer counts, in plain words for the owner and the author (`undefined`: it still counts). Read every time an approval is asked for (`SubmissionService.approvalOf`, which the
 * landing gate, the landing queue, a release, the status views and chat all read), so nothing has to be invalidated by a later write and nothing can be missed by one. It no longer counts when, since it was given:
 * - a decision the task relies on (`decision.link`) was superseded, is disputed, or cannot be read (fail closed);
 * - the task came to rely on a decision it was not judged against (a new link, or the work revalidated against a correcting decision: the approval was given on the old one);
 * - a decision the review cited is no longer in force at the cited version;
 * - the task contract's criteria text (`APPROVAL_CRITERIA_FIELDS`: expected result, acceptance criteria) changed. New checks, required evidence, priority, budget or permissions do not take an approval back (the landing
 *   gate's `tests` and `qa` checks judge checks and evidence themselves); a contract version that cannot be read does (fail closed).
 * A dispute the owner settles by keeping the decision makes it count again (the decision it was judged against is unchanged). A new review judged against the current decisions and criteria is the way back.
 */
export async function approvalOutdated(runner: Pick<CommandRunner, "get">, taskId: string, review: { readonly at: string; readonly cited?: { readonly criteriaRevision: number; readonly decisions: readonly { readonly id: string; readonly version: number }[] }; readonly basis?: ApprovalBasis }): Promise<string | undefined> {
  const reliance = (await runner.get("decision-reliance", relianceIdOf(taskId)))?.body as unknown as RelianceBody | undefined;
  const decisions = new Map<string, OwnerDecisionBody | undefined>();
  const decision = async (id: string): Promise<OwnerDecisionBody | undefined> => {
    if (!decisions.has(id)) decisions.set(id, (await runner.get("decision", id))?.body as unknown as OwnerDecisionBody | undefined);
    return decisions.get(id);
  };
  const gone = async (id: string, d: OwnerDecisionBody | undefined, link?: RelianceBody["links"][number]): Promise<string | undefined> => {
    if (d === undefined) return `owner decision ${id}, which the task relies on, cannot be read`;
    if (d.state === "disputed") {
      const since = d.disputeId === undefined ? undefined : ((await runner.get("decision-dispute", d.disputeId))?.body as unknown as DisputeBody | undefined)?.openedAt;
      return `owner decision ${id} has been disputed${since === undefined ? "" : ` since ${since}`} (two owner instructions conflict) and waits for the owner to settle it`;
    }
    if (d.state !== "active" || (link !== undefined && link.state !== "current")) {
      const by = d.supersededBy ?? link?.supersededBy;
      const at = d.supersededAt ?? link?.markedAt;
      return `owner decision ${id} was superseded${by === undefined ? "" : ` by ${by}`}${at === undefined ? "" : ` at ${at}`}`;
    }
    return undefined;
  };
  for (const l of reliance?.links ?? []) {
    const why = await gone(l.decisionId, await decision(l.decisionId), l);
    if (why !== undefined) return why;
    const judged = review.basis !== undefined ? review.basis.decisions.includes(basisKey(l.decisionId, l.version)) : !(l.linkedAt > review.at);
    if (!judged) return `the task has relied on owner decision ${l.decisionId} since ${l.linkedAt}, which this approval was not judged against`;
  }
  for (const c of review.cited?.decisions ?? []) {
    const d = await decision(c.id);
    const why = await gone(c.id, d);
    if (why !== undefined) return why;
    if (d!.version !== c.version) return `owner decision ${c.id} it cites is now at version ${d!.version}, not ${c.version}`;
  }
  // The criteria: the version it was judged against (kept with it, or cited), else the one in force at its time.
  const now = (await runner.get("task-contract", taskId))?.body as unknown as (Record<string, unknown> & { version?: number }) | undefined;
  const nowVersion = now?.version ?? 0;
  const versions = new Map<number, (Record<string, unknown> & { changedAt?: string }) | undefined>();
  const version = async (n: number): Promise<(Record<string, unknown> & { changedAt?: string }) | undefined> => {
    if (!versions.has(n)) versions.set(n, (await runner.get("task-contract-version", `${taskId}.${n}`))?.body as unknown as (Record<string, unknown> & { changedAt?: string }) | undefined);
    return versions.get(n);
  };
  let then = review.basis?.criteriaRevision ?? review.cited?.criteriaRevision;
  if (then === undefined) {
    for (let n = nowVersion, read = 0; ; n--, read++) {
      if (n <= 0) { then = 0; break; }
      if (read >= APPROVAL_CONTRACT_WALK) return `the task contract has changed more than ${APPROVAL_CONTRACT_WALK} times, so the criteria this approval was judged against cannot be told`;
      const v = await version(n);
      if (v === undefined || typeof v.changedAt !== "string") return `the task contract's version ${n} cannot be read, so the criteria this approval was judged against cannot be told`;
      if (!(v.changedAt > review.at)) { then = n; break; }
    }
  }
  if (then === nowVersion) return undefined;
  const base = then === 0 ? {} : await version(then);
  if (base === undefined || then > nowVersion) return `the task contract's version ${then}, which this approval was judged against, cannot be read (it is now at version ${nowVersion})`;
  const a = work(base), b = work(now);
  const fields = APPROVAL_CRITERIA_FIELDS.filter((f) => JSON.stringify(a[f] ?? null) !== JSON.stringify(b[f] ?? null));
  if (fields.length === 0) return undefined;
  const at = (await version(nowVersion))?.changedAt;
  return `the task contract's ${fields.join(", ")} changed since version ${then} (now version ${nowVersion}${typeof at === "string" ? `, stored at ${at}` : ""})`;
}
