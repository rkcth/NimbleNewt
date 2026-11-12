import type { Principal } from "../security/index.js";

/** The parts of the attendance service the gate reads (kept small so the gate can be tested alone). */
export interface GateAttendance {
  meetingOfTask(taskId: string, agent: string): Promise<{ occurrenceId: string; endsAt: string } | undefined>;
  admission(by: Principal, query: { agent: string; expectedMinutes: number }): Promise<{ meeting?: { occurrenceId: string; startsAt: string; endsAt: string } }>;
}
export interface MeetingGateDeps {
  /** The attendance service and the principal that may ask it. Absent (no dispatcher): no meeting room can seat an agent, so nothing is refused. */
  readonly attendance: () => { readonly service: GateAttendance; readonly by: Principal } | undefined;
  /** The agent principal (`agent:agt-...`) that owns the task, or `undefined` when no agent does. May throw: the gate then fails closed. */
  readonly ownerOf: (taskId: string) => Promise<string | undefined>;
}

const AGENT_PRINCIPAL = /^agent:agt-[a-z2-7]{20}$/;

/**
 * The rule "no long-running work during a meeting" (cards M04e, M04g), as the job service's `longRunningGate`.
 *
 * Whose meeting it is: an agent principal asks about itself. A host or service principal (the dispatcher, a worker host) admits or restarts a job for the task's owner agent, so it is held to that agent's meetings exactly as the agent
 * would be (follow-up: a host or service credential used to skip the gate). The owner (a person) is never held; any other principal kind has no meeting. Fails closed: if the task's owner or the meeting check cannot be read, the work is refused
 * with words that say to try again.
 */
export function createMeetingGate(deps: MeetingGateDeps): (principal: Principal, taskId: string) => Promise<string | undefined> {
  return async (principal, taskId) => {
    let agent: string | undefined;
    if (principal.kind === "agent") agent = principal.id;
    else if (principal.kind === "service" || principal.kind === "host") {
      try { agent = await deps.ownerOf(taskId); } catch { return `${principal.id}: whose meeting this task is in could not be checked, so long-running work is not started now; try again`; }
      if (agent === undefined) return undefined;
    } else return undefined;
    const asked = deps.attendance();
    // Without a dispatcher there is no attendance service, so no meeting room can seat an agent and nothing can be near one.
    if (asked === undefined) return undefined;
    let meeting: Awaited<ReturnType<GateAttendance["meetingOfTask"]>>;
    try { meeting = await asked.service.meetingOfTask(taskId, agent); } catch { return `${agent}: whether a meeting is on could not be checked, so long-running work is not started now; try again`; }
    if (meeting !== undefined) return `${agent} is in meeting ${meeting.occurrenceId} (until ${meeting.endsAt}); long-running work is not started during a meeting`;
    // Only an agent made by the controller (agt-...) can be seated in a meeting.
    if (!AGENT_PRINCIPAL.test(agent)) return undefined;
    let near: Awaited<ReturnType<GateAttendance["admission"]>>;
    try { near = await asked.service.admission(asked.by, { agent, expectedMinutes: 1 }); } catch { return `${agent}: whether a meeting is near could not be checked, so long-running work is not started now; try again`; }
    return near.meeting === undefined ? undefined : `${agent} attends meeting ${near.meeting.occurrenceId} (${near.meeting.startsAt} to ${near.meeting.endsAt}); long-running work is not started on any task from the notice before a meeting until it ends`;
  };
}
