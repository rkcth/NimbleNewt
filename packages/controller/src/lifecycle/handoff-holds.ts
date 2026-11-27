import { allowsExactly, inTaskScope } from "../security/access.js";
import type { Principal } from "../security/principals.js";
import { safeSlice } from "./handoff-cut.js";

/**
 * The integrator-lease and workspace lines of a hand-off package's locks section (card L03j), limited to what the recipient may see.
 *
 * The recipient is told every kind of hold, always: that the sender holds integrator leases for the task (how many) and that the checkout is frozen by a workspace operation (and which kind), since both change what the
 * recipient can do next. The details (branch, fence, expiry; the request, who started it and since when, how many attempts are frozen) are given only to a recipient that could read them through their own doors: the
 * exact `integration.lease` right on the project for leases (as `IntegratorLeaseOps`), the exact `workspace.manage` right on the task for workspace requests (as `WorkspaceOpService`). A task credential sees neither.
 * Every value comes from a stored record and is put on one line of bounded length, so a damaged record cannot add lines of its own to the section.
 */

/** A live lease the sender holds for the task. */
export interface SenderLease { readonly branch: string; readonly fence: number; readonly expiresAt: string }
/** A workspace operation open on the task's checkout (`WorkspaceOpService.openFor`). */
export interface OpenWorkspaceOp { readonly requestId: string; readonly operation: string; readonly requestedBy: string; readonly at: string }
/** A workspace request that ended but still holds attempts frozen (`WorkspaceOpService.heldFor`). */
export interface FrozenWorkspaceOp { readonly requestId: string; readonly operation: string; readonly held: readonly string[] }

/** A source that could not be read: its part is a gap, said so, never an absence. */
export const UNREADABLE = Symbol("unreadable");
type Read<T> = T | typeof UNREADABLE;

export interface HoldFacts {
  readonly taskId: string;
  /** The sender's agent ID (without `agent:`) and principal ID. */
  readonly sender: string;
  readonly senderPrincipal: string;
  readonly leases: Read<readonly SenderLease[]>;
  readonly open: Read<OpenWorkspaceOp | undefined>;
  readonly frozen: Read<FrozenWorkspaceOp | undefined>;
}

/** At most this many leases are named one by one (the lease service keeps at most 8 live leases per task); any beyond are counted. */
export const NAMED_LEASES = 8;

/**
 * One line of at most `max` characters: control characters and line breaks become spaces, so a stored value cannot start a line of its own; invisible format characters (bidi controls, zero-width
 * characters) are dropped, so a stored value cannot reorder or hide the controller's words around it. The cut never ends between the two halves of a surrogate pair.
 */
export function oneLine(value: unknown, max = 120): string {
  const s = (typeof value === "string" ? value : typeof value === "number" && Number.isFinite(value) ? String(value) : "?").replace(/\p{Cf}+/gu, "").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  return s.length === 0 ? "?" : s.length > max ? `${safeSlice(s, max - 3)}...` : s;
}

/** What the recipient may see in detail, by the same exact rights the lease and workspace doors use. An unknown recipient sees no details. */
export function recipientSees(recipient: Principal | undefined, projectId: string, taskId: string): { readonly leases: boolean; readonly workspace: boolean } {
  if (recipient === undefined || recipient.taskScope !== undefined || !inTaskScope(recipient, projectId)) return { leases: false, workspace: false };
  return {
    leases: allowsExactly(recipient, "integration.lease", projectId),
    workspace: allowsExactly(recipient, "workspace.manage", projectId, { resource: { kind: "task", id: taskId } }),
  };
}

const MOVE = "released when the task moves, unless the owner moves it to the recipient on completing the hand-off (moveIntegratorLease)";

/** The lease and workspace lines, in this order: leases, a freeze left by an ended request, the operation open on the checkout. Empty when the sender holds none of them. */
export function holdLines(facts: HoldFacts, sees: { readonly leases: boolean; readonly workspace: boolean }): string[] {
  const out: string[] = [];
  const task = oneLine(facts.taskId, 80);
  if (facts.leases === UNREADABLE) out.push("integrator leases: could not be read just now, so any the sender holds are missing from this section, not absent");
  else if (facts.leases.length > 0) {
    if (sees.leases) {
      for (const l of facts.leases.slice(0, NAMED_LEASES)) out.push(`integrator lease on branch ${oneLine(l.branch, 200)}: held by ${oneLine(facts.sender, 100)} (the sender, fence ${oneLine(l.fence, 20)}, until ${oneLine(l.expiresAt, 40)}); ${MOVE}`);
      if (facts.leases.length > NAMED_LEASES) out.push(`integrator leases: ${facts.leases.length - NAMED_LEASES} more held by the sender for this task, not named here`);
    } else {
      const n = facts.leases.length;
      out.push(`integrator leases: ${n} held by the sender for this task; ${n === 1 ? "it is" : "each is"} ${MOVE}; branch, fence and expiry withheld, the recipient may not see integrator leases`);
    }
  }
  if (facts.frozen === UNREADABLE) out.push("workspace holds: could not be read just now, so any on the checkout are missing from this section, not absent");
  else if (facts.frozen !== undefined) {
    const f = facts.frozen;
    out.push(sees.workspace
      ? `checkout of ${task}: ${oneLine(f.operation, 40)} request ${oneLine(f.requestId, 80)} ended but still holds ${f.held.length} attempt(s) frozen; the recovery loop lifts them, the hand-off does not`
      : `checkout of ${task}: a workspace request (${oneLine(f.operation, 40)}) ended but still holds attempts frozen; the recovery loop lifts them, the hand-off does not; the request is withheld, the recipient may not see workspace requests`);
  }
  if (facts.open === UNREADABLE) out.push("workspace operations: could not be read just now, so one open on the checkout is missing from this section, not absent");
  else if (facts.open !== undefined) {
    const o = facts.open;
    out.push(sees.workspace
      ? `checkout of ${task}: ${oneLine(o.operation, 40)} in progress, started by ${o.requestedBy === facts.senderPrincipal ? `${oneLine(facts.sender, 100)} (the sender)` : oneLine(o.requestedBy, 100)} (request ${oneLine(o.requestId, 80)}, since ${oneLine(o.at, 40)}); the checkout stays frozen for whoever holds the task until it ends or is settled by recovery`
      : `checkout of ${task}: a workspace operation (${oneLine(o.operation, 40)}) is in progress; the checkout stays frozen for whoever holds the task until it ends or is settled by recovery; who started it and the request are withheld, the recipient may not see workspace requests`);
  }
  return out;
}
