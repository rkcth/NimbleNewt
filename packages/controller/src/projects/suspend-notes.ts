import type { PauseScope } from "../lifecycle/pause.js";
import type { Principal } from "../security/principals.js";
import type { ResponsibilityService } from "./responsibilities.js";

/** What a finished Suspend or Stop of an agent, or of the whole installation, leaves behind for the responsibilities its agents answer for (card P04h). */
export interface SuspendNoted { readonly noted: readonly { readonly id: string; readonly title: string }[] }

/**
 * The note on a responsibility whose answering agent was suspended or stopped (card P04: "Suspend checkpoints the responsibility without stopping the managed service"). Each affected responsibility gets one `note` in its history
 * (written once per request, so a repeat writes nothing) that says whom it stays with, that NimbleNewt does not stop the service being maintained, that checks and alerts queue until the agent is resumed, and how to move the
 * duty (Suspend and Release, the hand-off, names the new monitor). Scopes: one agent, or the installation (every responsibility with an answering agent). A task or team scope is not noted: a responsibility belongs to an agent,
 * and the agents of a team are not listed here. Controller only; a failure of one note does not skip the others (the first is raised after all were tried).
 */
export async function noteSuspendedResponsibilities(duties: Pick<ResponsibilityService, "answeredBy" | "record">, by: Principal, event: { intentId: string; scope: PauseScope; mode: "suspend" | "stop" | "force-stop"; outcome: { state: "suspended" | "stopped" | "recovery-required" } }): Promise<SuspendNoted> {
  if (event.outcome.state === "recovery-required" || (event.scope.kind !== "agent" && event.scope.kind !== "installation")) return { noted: [] };
  const verb = event.outcome.state === "suspended" ? "suspended" : "stopped";
  const noted: { id: string; title: string }[] = [];
  let failure: unknown;
  for (const r of await duties.answeredBy(by, event.scope.kind === "agent" ? event.scope.id : undefined)) {
    try {
      await duties.record(by, { commandId: `stop-note-${event.intentId}-${r.id}`.slice(0, 120), responsibilityId: r.id, kind: "note", summary: `${r.ownerId} was ${verb}${event.scope.kind === "installation" ? " with the whole installation" : ""}. This responsibility ("${r.title.slice(0, 80)}") stays with ${r.ownerId}. NimbleNewt does not stop the service it maintains: that keeps running, but nothing watches it until ${r.ownerId} is resumed. Checks and alerts that come due wait and are taken then. To have another agent watch it meanwhile, use Suspend and Release (the hand-off) and name the new monitor.`.slice(0, 1000) });
      noted.push({ id: r.id, title: r.title });
    } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
  return { noted };
}
