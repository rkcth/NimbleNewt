import type { DecisionService } from "../decisions/index.js";
import type { EventService } from "../events/index.js";
import type { AttendanceService, MeetingService } from "../meetings/index.js";
import type { AgentMessageService } from "../messaging/index.js";
import type { ProjectService } from "../domain/service.js";
import type { StandupService } from "../standups/index.js";
import type { ControllerStorage } from "../storage/types.js";
import type { DispatcherLoop } from "./dispatcher.js";

/**
 * The loops the dispatcher's tick runs (card H12). Several services were built with the note "the controller's loop must call this"; each builder below turns one such call into a `DispatcherLoop`, so
 * the composer lists them in `DispatcherDeps.loops` and `tick()` runs them with the dispatcher's service principal. A call that reports `more` is repeated, at most `ROUNDS` times in one tick, so a
 * backlog is worked off over several ticks without one tick running for ever.
 */
const ROUNDS = 10;
const PAGE = 100;

async function drain(step: () => Promise<{ more?: boolean } | void>): Promise<void> {
  for (let round = 0; round < ROUNDS; round++) { const r = await step(); if (r === undefined || r.more !== true) return; }
}

/** The IDs of every project, a page at a time (nothing is cut off). */
export async function projectIds(projects: Pick<ProjectService, "listProjects">): Promise<string[]> {
  const out: string[] = [];
  for (let after: string | undefined; ;) {
    const page = await projects.listProjects({ ...(after === undefined ? {} : { afterId: after }), limit: PAGE });
    for (const p of page) { out.push(p.id); after = p.id; }
    if (page.length < PAGE) return out;
  }
}

/** The principal IDs of the active agents, a page at a time (the recipients whose held messages `release` retries). */
export async function activeAgents(storage: Pick<ControllerStorage, "listAggregates">): Promise<string[]> {
  const out: string[] = [];
  for (let after: string | undefined; ;) {
    const page = await storage.listAggregates("principal", { ...(after === undefined ? {} : { afterId: after }), limit: PAGE });
    for (const a of page) { after = a.id; if (a.id.startsWith("agent:") && (a.body as unknown as { state?: string }).state === "active") out.push(a.id); }
    if (page.length < PAGE) return out;
  }
}

/** U12: escalations of requests past their deadline, and a retry of the wakes a pause or a resume held back, for each agent. */
export function messageLoops(messages: Pick<AgentMessageService, "release" | "settleDue">, recipients: () => Promise<readonly string[]>): DispatcherLoop[] {
  return [
    { name: "messages.settleDue", run: (by) => messages.settleDue(by) },
    { name: "messages.release", run: async (by) => { for (const recipient of await recipients()) await messages.release(by, { recipient }); } },
  ];
}

/** M04: the waiting returns to work, and the lease on rooms whose meeting was never ended. */
export function attendanceLoops(attendance: Pick<AttendanceService, "sweepReturns">): DispatcherLoop[] {
  return [{ name: "attendance.sweepReturns", run: (by) => attendance.sweepReturns(by) }];
}

/** M03: for each project, the preparation of every planned occurrence (briefs, notices) and the delivery of agenda outcomes to the conversations they came from. */
export function standupLoops(standups: Pick<StandupService, "prepare" | "deliverOutcomes">, meetings: Pick<MeetingService, "planned">, projects: () => Promise<readonly string[]>): DispatcherLoop[] {
  return [
    {
      name: "standups.prepare",
      run: async (by) => {
        for (const projectId of await projects()) {
          for (let after: string | undefined; ;) {
            const page = await meetings.planned(by, projectId, { ...(after === undefined ? {} : { afterId: after }), limit: 20 });
            if (page === undefined) break;
            for (const occurrence of page.items) await standups.prepare(by, occurrence.id);
            if (page.next === undefined) break;
            after = page.next;
          }
        }
      },
    },
    { name: "standups.deliverOutcomes", run: async (by) => { for (const projectId of await projects()) await standups.deliverOutcomes(by, projectId); } },
  ];
}

/**
 * M01: the meeting clock. `tick` makes the occurrence for each schedule that is due (one for the latest slot after any downtime, a catch-up report for the rest), a page of schedules at a time; then, for each
 * project, every planned occurrence has its invitations handed to the sink (once each: the service withholds the paused and the unavailable and sends nothing for a catch-up report or a settled meeting).
 */
export function meetingLoops(meetings: Pick<MeetingService, "tick" | "planned" | "dispatchInvitations">, projects: () => Promise<readonly string[]>): DispatcherLoop[] {
  return [
    {
      name: "meetings.tick",
      run: async (by) => {
        for (let after: string | undefined, rounds = 0; rounds < ROUNDS; rounds++) {
          const r = await meetings.tick(by, { ...(after === undefined ? {} : { afterId: after }), limit: PAGE });
          if (r.next === undefined) break;
          after = r.next;
        }
      },
    },
    {
      name: "meetings.invite",
      run: async (by) => {
        for (const projectId of await projects()) {
          for (let after: string | undefined; ;) {
            const page = await meetings.planned(by, projectId, { ...(after === undefined ? {} : { afterId: after }), limit: 20 });
            if (page === undefined) break;
            for (const occurrence of page.items) await meetings.dispatchInvitations(by, occurrence.id);
            if (page.next === undefined) break;
            after = page.next;
          }
        }
      },
    },
  ];
}

/** H06b: subscriptions idle past their time are expired and the Notices owed are filed. */
export function eventLoops(events: Pick<EventService, "expireIdle">): DispatcherLoop[] {
  return [{ name: "events.expireIdle", run: (by) => drain(() => events.expireIdle(by)) }];
}

/** C08: the corrections whose propagation did not finish (a step that failed, a restart) are finished for each project. */
export function decisionLoops(decisions: Pick<DecisionService, "resume">, projects: () => Promise<readonly string[]>): DispatcherLoop[] {
  return [{ name: "decisions.resume", run: async (by) => { for (const projectId of await projects()) await drain(() => decisions.resume(by, { projectId })); } }];
}
