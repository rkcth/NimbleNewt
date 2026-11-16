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
