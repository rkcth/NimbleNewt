import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import type { CommitGateService, CommitPermit } from "./gate.js";

/** A commit found in the agent's checkout: its ID, its single parent and the tree it holds (Git object IDs). */
export interface MadeCommit { readonly commitId: string; readonly parent: string; readonly tree: string }

/**
 * The host side of the commit (card H12o). `commit` makes the commit the permit allows (the worker's `GitBridge.commit`, which re-stages and refuses unless the tree, base and file list are the
 * reviewed ones). The commit message carries the `NimbleNewt-Request: <id>` trailer (the permit's trailers do), the stable marker a commit is looked up by.
 *
 * Finding a commit made earlier must not depend on HEAD: a refresh or reapply can move HEAD off the commit. So a real port must (a) write an intent record {requestId, expected tree} durably
 * before it commits, (b) write a made record {requestId, sha} durably after creating the commit object and BEFORE it moves HEAD, and (c) implement `findByRequest` to search reachable history by
 * the trailer AND the made records (an unreferenced commit is found by its recorded sha). `find` is the fallback for a port that only reads reachable history.
 *
 * Exclusion: `commitOnce` serializes calls per request ID inside one process only. Two processes (or two controllers) acting on the same checkout are kept apart only by the port's
 * compare-and-swap on HEAD (the commit moves HEAD from the base to the new commit only if HEAD is still the base); a port must do that.
 */
export interface CommitPort {
  find(requestId: string): Promise<MadeCommit | undefined>;
  /** Optional: finds the request's commit by the trailer in reachable history and by the made record for unreferenced commits. Preferred over `find` when present. */
  findByRequest?(requestId: string): Promise<MadeCommit | undefined>;
  /** Optional: called before `commit` with the request ID and the tree the commit must hold, so the port can write its durable intent record. */
  intend?(requestId: string, tree: string): Promise<void>;
  commit(permit: CommitPermit): Promise<{ commitId: string; parent: string; tree: string }>;
}

export interface CommitOnceResult {
  readonly commitId: string;
  /** True when this call found a commit that an earlier call (or a run before a restart) had made and only recorded it. */
  readonly recovered: boolean;
  /** True when the commit was already recorded and nothing was done. */
  readonly alreadyRecorded: boolean;
}

const locks = new Map<string, Promise<unknown>>();
/** Runs `work` after every earlier call for the same key has finished (an in-process queue; see `CommitPort` for cross-process exclusion). */
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const previous = locks.get(key) ?? Promise.resolve();
  const run = previous.then(work, work);
  const tail = run.catch(() => undefined);
  locks.set(key, tail);
  try { return await run; } finally { if (locks.get(key) === tail) locks.delete(key); }
}

/**
 * Commits an approved request exactly once. Calls for the same request run one after another in this process, so a second concurrent call finds the first one's record and returns its commit ID.
 * The order is: (1) already recorded, answer from the record; (2) look for a commit the request already made (by trailer or made record; a crash, retry or moved HEAD between the commit and its
 * record), check that the approval still stands, and record that one, whatever the permit's age; (3) otherwise ask for the permit (the same permit again on a retry; its command ID includes the
 * permit generation so a re-approval after an expired permit is not replayed), make the commit, check it holds the approved tree and record it.
 * A commit that has another tree or base than the approved one, or whose approval was withdrawn, is never recorded: it needs a new approval (`review_invalid`). A repeat gives the same commit ID.
 * The caller is the requester or the owner for the record steps (the gate checks that on every step); `authorize` is the requester's only. Provisional: the request is the submission's commit record until the submission record (Q01b/H12n) exists.
 */
export function commitOnce(gate: CommitGateService, by: Principal, port: CommitPort, command: { requestId: string; base: string; tree: string; message: string }): Promise<CommitOnceResult> {
  return serialized(command.requestId, () => commitOnceUnlocked(gate, by, port, command));
}

async function commitOnceUnlocked(gate: CommitGateService, by: Principal, port: CommitPort, command: { requestId: string; base: string; tree: string; message: string }): Promise<CommitOnceResult> {
  const record = await gate.get(by, command.requestId);
  if (record === undefined) throw new DomainError("forbidden", `${by.id} has no such commit request`);
  if (record.state === "committed") return { commitId: record.commitId!, recovered: false, alreadyRecorded: true };
  const stable = (kind: string) => `commit-once-${kind}-${command.requestId}`;
  const record2 = async (commitId: string, parent: string): Promise<void> => { await gate.recordCommit(by, { commandId: stable("record"), requestId: command.requestId, commitId, parent }); };
  const existing = await (port.findByRequest ?? port.find).call(port, command.requestId);
  if (existing !== undefined) {
    if (existing.parent !== record.base || existing.tree !== record.tree) throw new DomainError("review_invalid", `a commit ${existing.commitId.slice(0, 12)} for request ${command.requestId} exists but is not the approved base and tree; a new approval is needed`, { field: "requestId" });
    if (record.state !== "authorized") throw new DomainError("review_invalid", `a commit exists for request ${command.requestId} that was never authorized; a new approval is needed`, { field: "requestId" });
    if (command.tree !== record.tree) throw new DomainError("review_invalid", `the staged tree is not the approved tree of request ${command.requestId}; a new approval is needed`, { field: "requestId" });
    const approval = await gate.approvalStands(by, command.requestId);
    if (!approval.stands) throw new DomainError("review_invalid", `a commit ${existing.commitId.slice(0, 12)} exists for request ${command.requestId} but ${approval.reason ?? "its approval was withdrawn"}; it is not recorded and a new approval is needed`, { field: "requestId" });
    await record2(existing.commitId, existing.parent);
    return { commitId: existing.commitId, recovered: true, alreadyRecorded: false };
  }
  // The generation is the permit this request last held (none before the first), so a new approval after an expired permit uses a new command ID instead of replaying the old one.
  const generation = record.attribution?.permitUntil ?? "first";
  const permit = await gate.authorize(by, { commandId: `${stable("authorize")}-${generation}`, requestId: command.requestId, base: command.base, tree: command.tree, message: command.message });
  await port.intend?.(command.requestId, record.tree);
  const made = await port.commit(permit);
  if (made.tree !== undefined && made.tree !== record.tree) throw new DomainError("review_invalid", `the commit ${made.commitId.slice(0, 12)} for request ${command.requestId} holds tree ${made.tree.slice(0, 12)}, not the approved tree; it is not recorded and a new approval is needed`, { field: "requestId" });
  await record2(made.commitId, made.parent);
  return { commitId: made.commitId, recovered: false, alreadyRecorded: false };
}
