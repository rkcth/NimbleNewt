import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import type { CommitGateService, CommitPermit } from "./gate.js";

/** A commit found in the agent's checkout: its ID, its single parent and the tree it holds (Git object IDs). */
export interface MadeCommit { readonly commitId: string; readonly parent: string; readonly tree: string }

/**
 * The host side of the commit (card H12o). `find` looks for a commit this request already made (the worker reads the checkout's history for the `NimbleNewt-Request: <id>` trailer the permit
 * carried); `commit` makes the commit the permit allows (the worker's `GitBridge.commit`, which re-stages and refuses unless the tree, base and file list are the reviewed ones).
 */
export interface CommitPort {
  find(requestId: string): Promise<MadeCommit | undefined>;
  commit(permit: CommitPermit): Promise<{ commitId: string; parent: string }>;
}

export interface CommitOnceResult {
  readonly commitId: string;
  /** True when this call found a commit that an earlier call (or a run before a restart) had made and only recorded it. */
  readonly recovered: boolean;
  /** True when the commit was already recorded and nothing was done. */
  readonly alreadyRecorded: boolean;
}

/**
 * Commits an approved request exactly once. The order is: (1) already recorded, answer from the record; (2) look in the checkout for a commit the request already made (a crash or retry
 * between the commit and its record) and record that one, whatever the permit's age; (3) otherwise ask for the permit (the same permit again on a retry), make the commit and record it.
 * A commit that was found but has another tree or base than the approved one is never recorded: it needs a new approval (`review_invalid`). A repeat gives the same commit ID.
 * The caller is the requesting agent or the owner; the gate checks that on every step. Provisional: the request is the submission's commit record until the submission record (Q01b/H12n) exists.
 */
export async function commitOnce(gate: CommitGateService, by: Principal, port: CommitPort, command: { requestId: string; base: string; tree: string; message: string }): Promise<CommitOnceResult> {
  const record = await gate.get(by, command.requestId);
  if (record === undefined) throw new DomainError("forbidden", `${by.id} has no such commit request`);
  if (record.state === "committed") return { commitId: record.commitId!, recovered: false, alreadyRecorded: true };
  const stable = (kind: string) => `commit-once-${kind}-${command.requestId}`;
  const record2 = async (commitId: string, parent: string): Promise<void> => { await gate.recordCommit(by, { commandId: stable("record"), requestId: command.requestId, commitId, parent }); };
  const existing = await port.find(command.requestId);
  if (existing !== undefined) {
    if (existing.parent !== record.base || existing.tree !== record.tree) throw new DomainError("review_invalid", `a commit ${existing.commitId.slice(0, 12)} for request ${command.requestId} exists but is not the approved base and tree; a new approval is needed`, { field: "requestId" });
    if (record.state !== "authorized") throw new DomainError("review_invalid", `a commit exists for request ${command.requestId} that was never authorized; a new approval is needed`, { field: "requestId" });
    await record2(existing.commitId, existing.parent);
    return { commitId: existing.commitId, recovered: true, alreadyRecorded: false };
  }
  const permit = await gate.authorize(by, { commandId: stable("authorize"), requestId: command.requestId, base: command.base, tree: command.tree, message: command.message });
  const made = await port.commit(permit);
  await record2(made.commitId, made.parent);
  return { commitId: made.commitId, recovered: false, alreadyRecorded: false };
}
