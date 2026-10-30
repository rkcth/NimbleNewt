import type { ControllerStorage } from "../storage/types.js";
import type { SourceCite } from "./record-types.js";

/**
 * Kinds of record that belong to a project and are read by its members through project rights (task, review, artifact, plan, blocker, decision, meeting records and so on). A citation of one of these may be shown to a meeting's readers.
 * Anything not listed is not shareable: an agent's desk (`desk-record`), its scratch, chair notes, conversation turns, histories and credentials are private, and a kind nobody classified is refused (default deny).
 */
export const SHAREABLE_KINDS: ReadonlySet<string> = new Set([
  "task", "project", "artifact", "review", "blocker", "dependency", "decision", "plan", "assignment", "attempt", "handoff", "inquiry", "improvement-item",
  "meeting-occurrence", "meeting-record", "meeting-motion", "meeting-decision", "meeting-summary", "meeting-plan",
]);

/** Whether records of this kind may be shared with a meeting's readers. Pure; unknown and private kinds are not. */
export function isShareableKind(kind: string): boolean { return SHAREABLE_KINDS.has(kind); }

/** The `shareable` option of the meeting record service: a project-visible kind whose record exists. A missing record, or any storage failure, is not shareable. */
export function shareableCite(storage: Pick<ControllerStorage, "getAggregate">): (cite: SourceCite) => Promise<boolean> {
  return async (cite) => {
    if (!isShareableKind(cite.kind) || typeof cite.id !== "string" || cite.id.length === 0) return false;
    try { return (await storage.getAggregate({ kind: cite.kind, id: cite.id })) !== undefined; } catch { return false; }
  };
}
