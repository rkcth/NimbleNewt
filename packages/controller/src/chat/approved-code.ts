// Finding the approved code a release request should commit (card D01, release-by-words slice). The owner says "commit the approved parser fix"; the CHAT (never the model) reads the task's code
// submissions and answers which of them are approved and not yet committed. Read-only: it records nothing, and it reads with the caller's own rights (the submission service's own rule).
import type { Principal } from "../security/index.js";
import type { SubmissionService } from "../submissions/index.js";

export interface ApprovedCode {
  readonly id: string;
  readonly submittedAt: string;
  /** The base commit and tree the submission carries (absent only when its record does not name them): two submissions with the same base and tree hold exactly the same code. */
  readonly base?: string;
  readonly tree?: string;
}

/**
 * What the lookup answers: the approved, uncommitted code submissions of the task (newest first); the task's newest code submission whatever its state (the one the task's checkout was last submitted
 * from: the host commits only the approved tree on the approved base when the checkout holds exactly that, so older code is committed only while it is the same base and tree as the newest); and whether the scan
 * stopped before it had seen every stored submission.
 */
export interface ApprovedCodeFound {
  readonly items: readonly ApprovedCode[];
  /** `committed`: a commit is recorded for the newest code itself (the checkout's head then moved past every submission's base). */
  readonly newest?: ApprovedCode & { readonly committed?: boolean };
  readonly truncated: boolean;
}

/** The lookup the chat is given: it throws when it cannot read, and the chat then proposes nothing. */
export type ApprovedCodeLookup = (by: Principal, taskId: string) => Promise<ApprovedCodeFound>;

/** How many `list` calls are made before the answer says it did not see everything (each call reads a bounded part of the submission table and returns at most 100 code submissions). */
export const APPROVED_CODE_PAGES = 5;

const newerFirst = (x: ApprovedCode, y: ApprovedCode): number => (x.submittedAt < y.submittedAt ? 1 : x.submittedAt > y.submittedAt ? -1 : x.id < y.id ? 1 : x.id > y.id ? -1 : 0);

/**
 * Builds the lookup from the services that already know the facts: the submission list and `approvalOf` (what the H12o status view reads) and the recorded commit (`submissionCommit`). A submission counts only when
 * the release itself would accept it (workspace-ops `#approved`): approved by a reviewer other than its author, or the one-agent approval, and with no commit recorded. The scan is partial only when the last call
 * still left a cursor (a call that stopped at its own read bound hands a cursor and the next call goes on from it), as the submissions status view reads it.
 */
export function approvedCodeLookup(deps: { readonly submissions: Pick<SubmissionService, "list" | "approvalOf">; readonly commit: (submissionId: string) => Promise<unknown> }): ApprovedCodeLookup {
  return async (by, taskId) => {
    const codes: ApprovedCode[] = [];
    let cursor: string | undefined;
    for (let call = 0; call < APPROVED_CODE_PAGES; call++) {
      const got = await deps.submissions.list(by, taskId, { kind: "code", limit: 100, ...(cursor === undefined ? {} : { afterId: cursor }) });
      for (const i of got.items) if (i.kind === "code") codes.push({ id: i.id, submittedAt: i.submittedAt });
      cursor = got.next;
      if (cursor === undefined) break;
    }
    codes.sort(newerFirst);
    const items: ApprovedCode[] = [];
    let newest: (ApprovedCode & { committed?: boolean }) | undefined;
    for (const c of codes) {
      const a = await deps.submissions.approvalOf(c.id);
      const known = a === undefined || a.taskId !== taskId ? c : { ...c, base: a.base, tree: a.tree };
      if (c === codes[0]) {
        newest = (await deps.commit(c.id)) === undefined ? known : { ...known, committed: true };
        if (newest.committed === true) continue;
      }
      if (a === undefined || a.taskId !== taskId || !a.approved || a.approvedBy === undefined || a.approvedBy === a.submittedBy) continue;
      if (c !== codes[0] && (await deps.commit(c.id)) !== undefined) continue;
      items.push(known);
    }
    return { items, ...(newest === undefined ? {} : { newest }), truncated: cursor !== undefined };
  };
}
