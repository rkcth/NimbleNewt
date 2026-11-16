import type { PauseScope } from "../lifecycle/pause.js";
import type { Principal } from "../security/principals.js";
import type { ResponsibilityService } from "./responsibilities.js";

/** What the note needs to know about a team or a task (T3): the agents whose gate a team stop reaches, and the responsibilities whose checks a task carried. Absent: that scope is not noted. */
export interface SuspendNotePorts {
  /** The IDs of the agents under a team (its sub-teams included), the ones its gate holds. */
  readonly teamAgents?: (teamId: string) => Promise<readonly string[]>;
  /** The IDs of the responsibilities whose checks this task took up. */
  readonly taskResponsibilities?: (taskId: string) => Promise<readonly string[]>;
}

/** What a finished Suspend or Stop of an agent, or of the whole installation, leaves behind for the responsibilities its agents answer for (card P04h). */
export interface SuspendNoted { readonly noted: readonly { readonly id: string; readonly title: string }[] }

/**
 * The note on a responsibility whose answering agent was suspended or stopped (card P04: "Suspend checkpoints the responsibility without stopping the managed service"). Each affected responsibility gets one `note` in its history
 * (written once per request, so a repeat writes nothing) that says whom it stays with, that NimbleNewt does not stop the service being maintained, that checks and alerts queue until the agent is resumed, and how to move the
 * duty (Suspend and Release, the hand-off, names the new monitor). Scopes: one agent; a team (every responsibility answered by an agent under it, found by `ports.teamAgents`); the installation (every responsibility with an
 * answering agent); a task (the responsibilities whose checks that task took up, found by `ports.taskResponsibilities`, with a note about the check, since the agent itself keeps working). A scope with no port is not noted.
 * A responsibility reached twice in one request (an agent in two listed teams) gets one note. Controller only; a failure of one note does not skip the others (the first is raised after all were tried).
 */
export async function noteSuspendedResponsibilities(duties: Pick<ResponsibilityService, "answeredBy" | "record"> & Partial<Pick<ResponsibilityService, "get">>, by: Principal, event: { intentId: string; scope: PauseScope; mode: "suspend" | "stop" | "force-stop"; outcome: { state: "suspended" | "stopped" | "recovery-required" } }, ports: SuspendNotePorts = {}): Promise<SuspendNoted> {
  const kind = event.scope.kind;
  if (event.outcome.state === "recovery-required") return { noted: [] };
  const verb = event.outcome.state === "suspended" ? "suspended" : "stopped";
  const found = new Map<string, { id: string; title: string; ownerId: string }>();
  let failure: unknown;
  try {
    if (kind === "agent" || kind === "installation") for (const r of await duties.answeredBy(by, kind === "agent" ? event.scope.id : undefined)) found.set(r.id, { id: r.id, title: r.title, ownerId: r.ownerId! });
    else if (kind === "team" && ports.teamAgents !== undefined) {
      // One agent whose responsibilities cannot be read does not cost the others their notes (the first failure is raised after all were tried).
      for (const agent of await ports.teamAgents(event.scope.id)) { try { for (const r of await duties.answeredBy(by, agent)) found.set(r.id, { id: r.id, title: r.title, ownerId: r.ownerId! }); } catch (error) { failure ??= error; } }
    } else if (kind === "task" && ports.taskResponsibilities !== undefined && duties.get !== undefined) {
      for (const id of await ports.taskResponsibilities(event.scope.id)) {
        try { const r = await duties.get(by, id); if (r !== undefined && r.state !== "retired" && r.ownerId !== undefined) found.set(r.id, { id: r.id, title: r.title, ownerId: r.ownerId }); } catch (error) { failure ??= error; }
      }
    }
  } catch (error) { failure = error; }
  const noted: { id: string; title: string }[] = [];
  for (const r of [...found.values()].sort((a, b) => (a.id < b.id ? -1 : 1))) {
    const what = `This responsibility ("${r.title.slice(0, 80)}") stays with ${r.ownerId}. NimbleNewt does not stop the service it maintains`;
    const summary = kind === "task"
      ? `A task that took up one of this responsibility's checks was ${verb}. ${what}: that keeps running, and ${r.ownerId} is not stopped. The check that task carried is not finished and stays owed until a check entry is recorded. To have another agent watch it meanwhile, use Suspend and Release (the hand-off) and name the new monitor.`
      : `${r.ownerId} was ${verb}${kind === "installation" ? " with the whole installation" : kind === "team" ? " with its team" : ""}. ${what}: that keeps running, but nothing watches it until ${r.ownerId} is resumed. Checks and alerts that come due wait and are taken then. To have another agent watch it meanwhile, use Suspend and Release (the hand-off) and name the new monitor.`;
    try {
      await duties.record(by, { commandId: `stop-note-${event.intentId}-${r.id}`.slice(0, 120), responsibilityId: r.id, kind: "note", summary: summary.slice(0, 1000) });
      noted.push({ id: r.id, title: r.title });
    } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
  return { noted };
}
