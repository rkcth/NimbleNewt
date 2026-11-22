// Finding the approved code a release request should commit (card D01, release-by-words slice). The owner says "commit the approved parser fix"; the CHAT (never the model) reads the task's code
// submissions and answers which of them are approved and not yet committed. Read-only: it records nothing, and it reads with the caller's own rights (the submission service's own rule).
import type { Principal } from "../security/index.js";
import type { SubmissionService } from "../submissions/index.js";

export interface ApprovedCode {
  readonly id: string;
  readonly submittedAt: string;
}

/** What the lookup answers: the approved, uncommitted code submissions of the task (newest first), and whether the scan stopped before it had seen every stored submission. */
export interface ApprovedCodeFound {
  readonly items: readonly ApprovedCode[];
  readonly truncated: boolean;
}

/** The lookup the chat is given: it throws when it cannot read, and the chat then proposes nothing. */
export type ApprovedCodeLookup = (by: Principal, taskId: string) => Promise<ApprovedCodeFound>;

/** How many submissions the owner is asked to choose between. */
export const APPROVED_CODE_ASKED = 5;

/** How many pages (of 100 submissions) are read before the answer says it did not see everything. */
export const APPROVED_CODE_PAGES = 5;

/**
 * Builds the lookup from the services that already know the facts: the submission list and `approvalOf` (what the H12o status view reads) and the recorded commit (`submissionCommit`). A submission counts only when
 * the release itself would accept it: approved by a reviewer other than its author, or the one-agent approval, and with no commit recorded.
 */
export function approvedCodeLookup(deps: { readonly submissions: Pick<SubmissionService, "list" | "approvalOf">; readonly commit: (submissionId: string) => Promise<unknown> }): ApprovedCodeLookup {
  return async (by, taskId) => {
    const codes: { id: string; submittedAt: string }[] = [];
    let cursor: string | undefined;
    let truncated = false;
    for (let page = 0; ; page++) {
      if (page >= APPROVED_CODE_PAGES) { truncated = true; break; }
      const got = await deps.submissions.list(by, taskId, { kind: "code", limit: 100, ...(cursor === undefined ? {} : { afterId: cursor }) });
      for (const i of got.items) if (i.kind === "code") codes.push({ id: i.id, submittedAt: i.submittedAt });
      if (got.scanLimited === true) truncated = true;
      cursor = got.next;
      if (cursor === undefined) break;
    }
    const items: ApprovedCode[] = [];
    for (const c of codes) {
      const a = await deps.submissions.approvalOf(c.id);
      if (a === undefined || a.taskId !== taskId || !a.approved || a.approvedBy === undefined || a.approvedBy === a.submittedBy) continue;
      if ((await deps.commit(c.id)) !== undefined) continue;
      items.push(c);
    }
    items.sort((x, y) => (x.submittedAt < y.submittedAt ? 1 : x.submittedAt > y.submittedAt ? -1 : x.id < y.id ? 1 : -1));
    return { items, truncated };
  };
}
