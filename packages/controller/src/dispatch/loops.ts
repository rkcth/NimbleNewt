import type { BudgetService, RequestNotice } from "../budgets/index.js";
import type { WorkspaceOpService } from "../workspace-ops/index.js";
import type { DecisionService } from "../decisions/index.js";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import type { EventService, Waker, WatchService } from "../events/index.js";
import type { ReviewService } from "../review/index.js";
import type { StallService } from "../health/index.js";
import type { AttendanceService, MeetingService } from "../meetings/index.js";
import type { MeetingRecordService } from "../meetings/record.js";
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

/** H05b: reviews are moved along for each project: a waiting review takes a reviewer once one is eligible; one whose reviewer is held or missed the deadline moves on under the project policy (never by approval). */
export function reviewLoops(reviews: Pick<ReviewService, "sweep">, projects: () => Promise<readonly string[]>): DispatcherLoop[] {
  let n = 0;
  const nonce = Math.random().toString(36).slice(2, 10);
  return [{ name: "reviews.sweep", run: async (by) => { for (const projectId of await projects()) await drain(() => reviews.sweep(by, { commandId: `rvs-${nonce}-${++n}`, projectId })); } }];
}

/**
 * L01b: the reconciler's pass (repairs, inbox admission with the pause lookup, effect recovery, wait deadlines) and stall detection. The scan needs the dedicated `recovery.stall-scan` right; a dispatcher
 * without it is told once (`missing`) and the scan is skipped, so the tick does not fail every time.
 */
export function recoveryLoops(stall: Pick<StallService, "scan">, reconciler: { runPass(): Promise<unknown> }, missing: () => Promise<unknown>, renew?: () => Promise<Principal>): DispatcherLoop[] {
  let said = false;
  // The scan continues where the last tick stopped and wraps at the end, so every assignment is reached however many there are.
  let cursor: string | undefined;
  return [
    { name: "recovery.reconcile", run: async () => { await reconciler.runPass(); } },
    { name: "recovery.stall-scan", run: async (tickBy) => {
      // The principal is read again each tick: a right the owner grants or revokes while the controller runs takes effect at the next tick.
      const by = renew === undefined ? tickBy : await renew();
      try {
        for (let round = 0; round < ROUNDS; round++) {
          const r = await stall.scan(by, cursor === undefined ? {} : { afterId: cursor });
          cursor = r.next;
          if (r.next === undefined) break;
        }
        said = false;
      } catch (error) {
        if (!(error instanceof DomainError && error.code === "forbidden")) throw error;
        if (!said) { await missing(); said = true; }
      }
    } },
  ];
}

/** H06b: subscriptions idle past their time are expired and the Notices owed are filed. */
export function eventLoops(events: Pick<EventService, "expireIdle">): DispatcherLoop[] {
  return [{ name: "events.expireIdle", run: (by) => drain(() => events.expireIdle(by)) }];
}

/** H13b: each active watch the dispatcher set up hands its waiting events to the owning agent, once per tick (a watch is dispatched only by the principal that set it up). */
export function watchLoops(watches: { activeOf(by: Principal): Promise<string[]>; dispatchAll(by: Principal, watchIds: readonly string[]): Promise<readonly unknown[]> }): DispatcherLoop[] {
  return [{ name: "events.watch-dispatch", run: async (by) => {
    // Every watch is tried; one that could not be dispatched is reported after the rest, so the loop shows as failing instead of silently never serving it.
    const results = (await watches.dispatchAll(by, await watches.activeOf(by))) as Array<{ watchId: string; error?: string }>;
    const failed = results.filter((r) => r.error !== undefined);
    if (failed.length > 0) throw new Error(`${failed.length} watch(es) could not be dispatched: ${failed.slice(0, 3).map((f) => `${f.watchId}: ${f.error}`).join("; ")}`);
  } }];
}

/** C08: the corrections whose propagation did not finish (a step that failed, a restart) are finished for each project. */
export function decisionLoops(decisions: Pick<DecisionService, "resume">, projects: () => Promise<readonly string[]>): DispatcherLoop[] {
  return [{ name: "decisions.resume", run: async (by) => { for (const projectId of await projects()) await drain(() => decisions.resume(by, { projectId })); } }];
}

/** R05e: the delegated holders who have not yet been told of a request addressed to them are told (filing is idempotent, so a notice filed already is not filed twice). A holder who can no longer be told is skipped; a full inbox is tried again on the next tick. */
export function budgetNoticeLoops(budgets: Pick<BudgetService, "openForHolders">, tell: (notice: RequestNotice) => Promise<unknown>): DispatcherLoop[] {
  return [{ name: "budgets.notifyHolders", run: async () => {
    // One request that cannot be told never holds back the others; the first real fault is reported after all were tried.
    let fault: unknown;
    for (const notice of await budgets.openForHolders()) {
      try { await tell(notice); } catch (error) {
        if (!(error instanceof DomainError && (error.code === "forbidden" || error.code === "unavailable"))) fault ??= error;
      }
    }
    if (fault !== undefined) throw fault;
  } }];
}

/** H12l: a workspace operation the controller was running when it stopped is resolved as unknown and the attempts it froze are released. */
export function workspaceLoops(workspace: Pick<WorkspaceOpService, "recover">): DispatcherLoop[] {
  return [{ name: "workspace.recover", run: (by) => workspace.recover(by) }];
}

/** M02c: votes whose time is up are closed, ties past the casting window fail and meeting records nobody finished are ended, for each project (the lease of `MeetingRecordService.sweep`). */
export function recordLoops(records: Pick<MeetingRecordService, "sweep">, projects: () => Promise<readonly string[]>): DispatcherLoop[] {
  return [{ name: "meeting-records.sweep", run: async (by) => { for (const projectId of await projects()) await records.sweep(by, { projectId }); } }];
}

/** H13c: the agent whose watched event is waiting is told to look at its inbox: the waker reports `woken` once the agent's current attempt will see it, and `deferred` (tried again next tick) when there is none to wake. */
export function wakeLoops(watches: Pick<WatchService, "consumeWakes">, waker: Waker): DispatcherLoop[] {
  return [{ name: "events.wakes", run: async (by) => { await watches.consumeWakes(by, waker); } }];
}

/** The waker of the running controller (card H13c): an attempt that is running reads its inbox at its next boundary, and one waiting for a place reads it when it starts; anything else (no record yet, parked on an approval, finished) is tried again next tick. */
export function attemptWaker(dispatcher: () => { get(by: Principal, attemptId: string): Promise<{ state: string } | undefined> } | undefined, by: Principal): Waker {
  return { wake: async (r) => { const state = (await dispatcher()?.get(by, r.attemptId))?.state; return state === "running" || state === "waiting" ? "woken" : "deferred"; } };
}
