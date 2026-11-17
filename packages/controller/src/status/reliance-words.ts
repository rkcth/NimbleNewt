import type { Reliance, RunningWork } from "../security/reliance.js";
import { quoted, shown } from "./explain.js";

/**
 * Running work that relies on a right, in plain words (follow-up to card T7): lines for the owner's chat answer and for the preview of taking the right back. Names and titles are words someone else
 * wrote, so they are quoted and clipped here; the numbers and states are the controller's. "May rely": the controller does not record which action an attempt will take next, so this is what the right
 * covers, never a claim that it will be used. Each line is bounded (the head under 300 characters, an entry under 200), so a preview line never needs cutting.
 */
export function relianceHead(r: Reliance, inline = 0): string {
  const where = r.project === "*" ? "every project" : shown(r.project, 60);
  const head = `${shown(r.action, 60)} for ${shown(r.grantee, 60)} in ${where} (${shown(r.grantId, 40)})`;
  if (r.state === "revoked") return `${head} is already taken back.`;
  // T7b review: an active right that gives nothing now (ended, lapsed, not started, or resting on a right that no longer holds) has no work relying on it; an answer from before the field said nothing of it.
  if (r.inForce === false) return `${head} is not in force now (it ended, lapsed or has not started), so no running work relies on it now.`;
  if (r.total === 0) return `${head}: no running work relies on it${r.complete ? "" : ", but not every record could be read, so some may not be listed"}.`;
  const some = r.items.slice(0, inline).map((w) => quoted(w.title, 40));
  return `${head}: ${r.total}${r.complete ? "" : " or more"} running ${r.total === 1 && r.complete ? "task" : "tasks"} may rely on it${some.length === 0 ? "" : ` (${some.join(", ")}${r.total > some.length ? ` and ${r.total - some.length} more` : ""})`}. Taking it back may stop ${r.total === 1 && r.complete ? "that work" : "it"} at the next check.`;
}

/** One running task, for the lines under the head. */
export function relianceEntry(w: RunningWork): string {
  return `${quoted(w.title, 60)} is running (task ${shown(w.taskId, 40)}, agent ${shown(w.agentId, 40)}, attempt ${w.attemptNumber}).`;
}

/** The lines of one right: the head, each listed entry, and the count of the rest. At most 12. */
export function relianceLines(r: Reliance): string[] {
  const out = [relianceHead(r)];
  for (const w of r.items) out.push(relianceEntry(w));
  if (r.total > r.items.length) out.push(`${r.total - r.items.length} more running ${r.total - r.items.length === 1 ? "task is" : "tasks are"} not listed.`);
  return out;
}

/**
 * The first line of an answer about every active right (T7b review): how many of the rights looked at have running work, and, when the look was partial, that it was, so the answer never reads as
 * "nothing relies on any of them" when records or rights were left unread. `more`: there were more active rights than were looked at.
 */
export function relianceSummary(items: readonly Reliance[], more: boolean): string {
  const busy = items.filter((r) => r.total > 0).length;
  const partial = items.some((r) => !r.complete) ? "; not every record could be read, so some work may not be listed" : "";
  const which = more ? `the first ${items.length} standing rights looked at (there are more, not checked here; ask about one by its ID)` : `the ${items.length} standing ${items.length === 1 ? "right" : "rights"}`;
  if (items.length === 0 && !more) return "No standing right is active, so no running work relies on one.";
  if (busy === 0) return `No running work relies on any of ${which}${partial}.`;
  return `${busy} of ${which} ${busy === 1 ? "has" : "have"} running work that may rely on ${busy === 1 ? "it" : "them"}${partial}.`;
}
