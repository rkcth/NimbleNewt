import type { Principal } from "../security/principals.js";
import { allows } from "../security/access.js";
import type { LinkResolver } from "./replay.js";

/**
 * The readers behind a replay's resolved links (card U09b). Each one asks the service that owns the record, as the reader, so the record's own rule decides (a message only for its sender, its recipient or the owner;
 * a submission only for its author, an assigned reviewer or the owner; an approval for its requester, its decider, a reviewer or the owner; a side line for its owner and the installation owner). A record of ANOTHER task
 * than the replay's is never shown through it. What an agent or a reviewer wrote (message text, a review's reason, a comment) is marked untrusted; the diff of a code submission is shown as its identity (the base,
 * the tree and the patch ID the controller recorded), because the line-by-line diff lives in the repository and is not copied into the controller.
 */
export interface ResolverSources {
  readonly messages?: { get(viewer: Principal, id: string): Promise<{ readonly taskId: string; readonly sender: string; readonly to: string; readonly kind: string; readonly class: string; readonly state: string; readonly purpose: string; readonly text: string } | undefined> };
  readonly submissions?: { get(by: Principal, id: string): Promise<{ readonly taskId: string; readonly kind: string; readonly role: string; readonly submittedBy: string; readonly base?: string; readonly tree?: string; readonly patchId?: string; readonly subject?: string; readonly verdict?: string; readonly decision?: string; readonly report?: string; readonly evidence: readonly { readonly check: string; readonly result?: string }[] } | undefined> };
  readonly reviews?: { get(by: Principal, id: string): Promise<{ readonly binding: { readonly taskId: string; readonly requester: string }; readonly operation: { readonly name: string }; readonly state: string; readonly decidedBy?: string; readonly reason?: string } | undefined> };
  readonly artifacts?: { get(id: string): Promise<{ readonly name: string; readonly taskId?: string; readonly projectId?: string; readonly entries: readonly unknown[]; readonly totalBytes: number; readonly createdBy: string } | undefined> };
  readonly branches?: { view(viewer: Principal, id: string): Promise<{ readonly branch: { readonly taskId: string; readonly purpose: string; readonly state: string; readonly owner: string; readonly openedAt: string }; readonly counts: { readonly parent: number; readonly branch: number } } | undefined> };
}

/** The task's own history is already readable by this reader (the replay checked), so metadata of an artifact of the same task needs no more than that; anything else is refused as not found. */
const mayReadTask = (by: Principal, task: { projectId: string; taskId: string }): boolean => by.kind === "owner" || by.kind === "service" || allows(by, "task.read", task.projectId, { resource: { kind: "task", id: task.taskId } });

export function replayResolvers(src: ResolverSources): Readonly<Record<string, LinkResolver>> {
  const out: Record<string, LinkResolver> = {};
  const messages = src.messages; const submissions = src.submissions; const reviews = src.reviews; const artifacts = src.artifacts; const branches = src.branches;
  if (messages !== undefined) {
    out["agent-message"] = async (by, ref, task) => {
      const m = await messages.get(by, ref.id);
      if (m === undefined || m.taskId !== task.taskId) return undefined;
      return { title: `Message from ${m.sender} to ${m.to} (${m.class}, ${m.state})`, lines: [`Purpose: ${m.purpose}`, m.text], untrusted: true };
    };
  }
  if (submissions !== undefined) {
    const one: LinkResolver = async (by, ref, task) => {
      const s = await submissions.get(by, ref.id);
      if (s === undefined || s.taskId !== task.taskId) return undefined;
      if (s.kind === "code") return { title: `Diff of a code submission by ${s.submittedBy} (${s.role})`, lines: [`Base ${s.base ?? "not recorded"}, tree ${s.tree ?? "not recorded"}${s.patchId === undefined ? "" : `, patch ${s.patchId}`}.`, "The line-by-line diff is kept in the repository, not copied here.", ...s.evidence.slice(0, 5).map((e) => `Check ${e.check}${e.result === undefined ? "" : `: ${e.result}`}`)], untrusted: false };
      const verdict = s.verdict ?? s.decision;
      return { title: `Comment: ${s.kind} by ${s.submittedBy} (${s.role})${verdict === undefined ? "" : `, ${verdict}`}`, lines: [...(s.subject === undefined ? [] : [`About submission ${s.subject}.`]), ...(s.report === undefined ? [] : [s.report])], untrusted: true };
    };
    out["submission"] = one;
  }
  if (reviews !== undefined) {
    out["review"] = async (by, ref, task) => {
      const r = await reviews.get(by, ref.id);
      if (r === undefined || r.binding.taskId !== task.taskId) return undefined;
      return { title: `Approval request for ${r.operation.name} by ${r.binding.requester}: ${r.state}`, lines: [...(r.decidedBy === undefined ? [] : [`Decided by ${r.decidedBy}.`]), ...(r.reason === undefined ? [] : [r.reason])], untrusted: r.reason !== undefined };
    };
  }
  if (artifacts !== undefined) {
    out["artifact"] = async (by, ref, task) => {
      const a = await artifacts.get(ref.id);
      if (a === undefined || a.taskId !== task.taskId || (a.projectId !== undefined && a.projectId !== task.projectId) || !mayReadTask(by, task)) return undefined;
      return { title: `Artifact ${a.name}`, lines: [`${a.entries.length} file${a.entries.length === 1 ? "" : "s"}, ${a.totalBytes} bytes, published by ${a.createdBy}.`], untrusted: true };
    };
  }
  if (branches !== undefined) {
    out["context-branch"] = async (by, ref, task) => {
      const b = await branches.view(by, ref.id);
      if (b === undefined || b.branch.taskId !== task.taskId) return undefined;
      return { title: `Side line of work (${b.branch.state}), opened ${b.branch.openedAt} by ${b.branch.owner}`, lines: [`Purpose: ${b.branch.purpose}`, `${b.counts.branch} entr${b.counts.branch === 1 ? "y" : "ies"} of its own, ${b.counts.parent} inherited.`], untrusted: true };
    };
  }
  return out;
}
