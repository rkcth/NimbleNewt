import type { BudgetService, RequestNotice } from "../budgets/index.js";
import type { WorkspaceOpService } from "../workspace-ops/index.js";
import type { DecisionService } from "../decisions/index.js";
import { DomainError } from "../domain/errors.js";
import type { Principal } from "../security/principals.js";
import type { EventService, EventSource, SourceService, Waker, WatchService } from "../events/index.js";
import type { ReviewService } from "../review/index.js";
import type { StallService } from "../health/index.js";
import type { AttendanceService, MeetingService } from "../meetings/index.js";
import type { MeetingRecordService } from "../meetings/record.js";
import type { AgentMessageService } from "../messaging/index.js";
import type { ProjectService } from "../domain/service.js";
import type { StandupService } from "../standups/index.js";
import type { ControllerStorage } from "../storage/types.js";
import type { CutoverService } from "../routing/cutover.js";
import type { DispatcherLoop } from "./dispatcher.js";

/**
 * The loops the dispatcher's tick runs (card H12). Several services were built with the note "the controller's loop must call this"; each builder below turns one such call into a `DispatcherLoop`, so
 * the composer lists them in `DispatcherDeps.loops` and `tick()` runs them with the dispatcher's service principal. A call that reports `more` is repeated, at most `ROUNDS` times in one tick, so a
 * backlog is worked off over several ticks without one tick running for ever.
 */
/**
 * The health probes of failed-over routes (card R04c). A probe is one small request to a target that is marked down, so that failback can follow its own policy. It runs only when `enabled()` says so: the owner asked for it to stay
 * off while their own model servers are busy, so nothing here is switched on by default, and without a `run` there is no loop at all. A target is probed at most once per `intervalMs`, whatever the tick rate.
 */
export interface RouteProbes {
  readonly enabled: () => boolean;
  /** Sends one small request to the route and says whether it answered well. Never throws for a bad answer; a throw counts as a failed probe. */
  readonly run: (target: { scope: "account" | "endpoint"; route: string }) => Promise<boolean>;
  readonly intervalMs: number;
}

const PROBE_TIMEOUT_MS = 30_000;
export function probeLoops(cutover: Pick<CutoverService, "downTargets" | "probe">, probes: RouteProbes, now: () => number = Date.now): DispatcherLoop[] {
  if (!Number.isSafeInteger(probes.intervalMs) || probes.intervalMs < 1000) throw new RangeError("route probes: intervalMs must be a whole number of at least 1000");
  const probed = new Map<string, number>();
  return [{ name: "routes.probe", run: async (by) => {
    if (!probes.enabled()) return;
    const slot = Math.floor(now() / probes.intervalMs);
    for (const t of await cutover.downTargets()) {
      if (probed.get(`${t.scope}/${t.name}`) === slot) continue; // already probed in this interval: no second request
      probed.set(`${t.scope}/${t.name}`, slot);
      const ok = await Promise.race([probes.run({ scope: t.scope, route: t.route }), new Promise<boolean>((r) => { setTimeout(() => { r(false); }, PROBE_TIMEOUT_MS).unref(); })]).catch(() => false); // a probe that hangs counts as failed and never stalls the tick
      // One probe per target per interval: the command ID names the interval, so a second tick in it records nothing new.
      await cutover.probe(by, { commandId: `prb-${t.scope}-${t.name}-${slot}`.slice(0, 120), scope: t.scope, route: t.route, ok });
    }
  } }];
}

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

/** M03d: the stand-up's decisions on improvements go back to the agents that proposed them, project by project; one that cannot be filed yet stays pending. */
export function improvementOutcomeLoops(improvements: { deliverOutcomes(by: Principal, projectId: string): Promise<unknown> }, projects: () => Promise<readonly string[]>): DispatcherLoop[] {
  return [{ name: "improvements.outcomes", run: async (by) => {
    // One project's trouble does not hold up the others; the failures are named after the rest.
    const failed: string[] = [];
    for (const projectId of await projects()) { try { await improvements.deliverOutcomes(by, projectId); } catch (error) { failed.push(`${projectId}: ${error instanceof Error ? error.message : String(error)}`); } }
    if (failed.length > 0) throw new Error(`improvement outcomes could not be delivered for ${failed.length} project(s): ${failed.slice(0, 3).join("; ")}`);
  } }];
}

/** M03e: a decision on an improvement that has gone untold for some days is shown to the owner (once per decision), project by project. */
export function untoldImprovementLoops(improvements: { untold(by: Principal, projectId: string, olderThanMs: number): Promise<readonly { id: string; revision: number; title: string; disposition: string; decidedAt: string }[]> }, projects: () => Promise<readonly string[]>, tell: (notice: { readonly key: string; readonly projectId: string; readonly itemId: string; readonly text: string }) => Promise<unknown>, days = 7): DispatcherLoop[] {
  if (!Number.isFinite(days) || days <= 0) throw new Error("days must be above zero");
  return [{ name: "improvements.untold", run: async (by) => {
    const failed: string[] = [];
    for (const projectId of await projects()) {
      try {
        for (const item of await improvements.untold(by, projectId, days * 86_400_000)) await tell({ key: `imu:${item.id}:${item.revision}`, projectId, itemId: item.id, text: `The decision on the improvement "${item.title.length > 60 ? `${item.title.slice(0, 59)}…` : item.title}" (${item.disposition}, decided ${item.decidedAt.slice(0, 10)}) has not reached its proposer for ${days} days or more.` });
      } catch (error) { failed.push(`${projectId}: ${error instanceof Error ? error.message : String(error)}`); }
    }
    if (failed.length > 0) throw new Error(`untold improvement decisions could not be shown for ${failed.length} project(s): ${failed.slice(0, 3).join("; ")}`);
  } }];
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
export function recoveryLoops(stall: Pick<StallService, "scan"> & Partial<Pick<StallService, "escalateUndecided" | "markEscalationNotified">>, reconciler: { runPass(): Promise<unknown> }, missing: () => Promise<unknown>, renew?: () => Promise<Principal>, notifyEscalation?: (concern: { id: string; taskId: string; projectId: string; kind: string; detail: string; escalatedAt?: string; escalatedTo?: string; escalationLevel?: number }) => Promise<void>): DispatcherLoop[] {
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
        // A concern its supervisor left undecided is passed on to the owner; a notice that could not be sent is offered again next tick (card V02b).
        if (notifyEscalation !== undefined && stall.escalateUndecided !== undefined && stall.markEscalationNotified !== undefined) {
          // One concern whose notice cannot be sent does not hold back the others; the first failure is raised after all were tried.
          let failure: unknown;
          for (const c of await stall.escalateUndecided(by)) { try { await notifyEscalation(c); await stall.markEscalationNotified(by, c.id); } catch (error) { failure ??= error; } }
          if (failure !== undefined) throw failure;
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

/**
 * H13d: polls the external event sources the controller was given, once per tick, and publishes what they found. A source that fails is reported after the rest, so the loop shows as failing and one bad source does not stop the others.
 * Sources are given by the caller; none is built in, so without any there is no loop and nothing is polled.
 */
export interface SourceLoopOptions {
  /** Tells the owner something (a stable `id` so the same thing is not told twice). */
  readonly tell?: (notice: { readonly id: string; readonly text: string }) => Promise<unknown>;
  /** Records a failure that does not stop the tick. */
  readonly log?: (message: string) => void;
  /** Consecutive failed reads of the setting before the owner is told (default 5). */
  readonly unreadableAfter?: number;
}

export function sourceLoops(sources: Pick<SourceService, "run">, list: readonly EventSource[], disabled?: () => Promise<ReadonlySet<string>>, options: SourceLoopOptions = {}): DispatcherLoop[] {
  if (list.length === 0) return [];
  const limit = options.unreadableAfter ?? 5;
  let lastGood: ReadonlySet<string> | undefined;
  let failures = 0;
  let episode = 0;
  return [{ name: "events.sources", run: async (by) => {
    // H13f: the owner's choice is read at every tick. When it cannot be read, the last choice that could be read is used (fail open on what the owner last said, with the failure logged); with no such choice nothing is polled and the loop shows as failing.
    let off: ReadonlySet<string> | undefined;
    if (disabled !== undefined) {
      try { off = await disabled(); lastGood = off; if (failures >= limit) episode++; failures = 0; } catch (error) {
        failures++;
        options.log?.(`event source setting could not be read (${failures} in a row): ${error instanceof Error ? error.message : String(error)}`);
        if (failures === limit) await options.tell?.({ id: `event-sources-unreadable:${episode}`, text: "Event watching is not running: the source setting cannot be read." }).catch(() => undefined);
        if (lastGood === undefined) throw error;
        off = lastGood;
      }
    }
    const chosen = off === undefined || off.size === 0 ? list : list.filter((s) => !off.has(s.id));
    if (chosen.length === 0) return;
    const runs = await sources.run(by, chosen);
    // A source whose saved position is older than what it can still see lost events: told once per gap (the notice id names the source and where the gap began).
    for (const r of runs) if (r.gap !== undefined) await options.tell?.({ id: `event-gap:${r.source}:${r.gap.from}`.replace(/[^A-Za-z0-9._:-]/g, "-").slice(0, 120), text: `Events from ${r.source} between ${r.gap.from} and ${r.gap.to} were not watched; it starts again from now.` }).catch(() => undefined);
    const failed = runs.filter((r) => r.error !== undefined);
    if (failed.length > 0) throw new Error(`${failed.length} event source(s) could not be polled: ${failed.slice(0, 3).map((f) => `${f.source}: ${f.error}`).join("; ")}`);
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

/** The task of a project that an agent holds now (the first by id), which anchors a controller notice to the agent: a notice is filed about a task the recipient can read. Absent when it holds none there. */
export async function assignedTaskIn(storage: Pick<ControllerStorage, "listAggregates" | "getAggregate">, projectId: string, agentId: string): Promise<string | undefined> {
  for (let after: string | undefined; ;) {
    const page = await storage.listAggregates("assignment", { ...(after === undefined ? {} : { afterId: after }), limit: PAGE });
    for (const a of page) {
      after = a.id;
      const b = a.body as unknown as { taskId?: string; state?: string; owner?: { id: string } };
      if (b.state !== "assigned" || b.owner?.id !== agentId || b.taskId === undefined) continue;
      if (((await storage.getAggregate({ kind: "task", id: b.taskId }))?.body as unknown as { projectId?: string } | undefined)?.projectId === projectId) return b.taskId;
    }
    if (page.length < PAGE) return undefined;
  }
}

/** P04: checks that came due are recorded and open incidents past their escalation time are escalated, for every project, on each tick. */
export function responsibilityLoops(checks: { generate(by: Principal, projectId: string): Promise<unknown> }, incidents: { escalate(by: Principal, projectId: string): Promise<unknown>; untold(by: Principal, projectId: string): Promise<readonly { id: string; projectId: string; escalatedTo?: string; signature: string; responsibilityId: string; count: number }[]>; markNotified(by: Principal, incidentId: string): Promise<void> }, projects: () => Promise<readonly string[]>, notify?: (escalated: { id: string; projectId: string; escalatedTo?: string; signature: string; responsibilityId: string; count: number }) => Promise<void>): DispatcherLoop[] {
  // One project's failure does not skip the others this tick; the first error is raised after all have been tried.
  return [{ name: "responsibilities.checks", run: async (by) => {
    let failure: unknown;
    for (const projectId of await projects()) {
      try {
        await checks.generate(by, projectId);
        await incidents.escalate(by, projectId);
        // A notice that could not be sent is offered again next tick: an escalation is told once it has been told, not once it was recorded.
        // One incident whose notice fails does not hold back the others of the project; the first error is raised after all have been tried.
        if (notify !== undefined) for (const e of await incidents.untold(by, projectId)) { try { try { await notify(e); } catch (error) { if (!(error instanceof DomainError && error.code === "command_conflict")) throw error; /* the notice was already committed under this id: it is sent */ } await incidents.markNotified(by, e.id); } catch (error) { failure ??= error; } }
      } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  } }];
}

/**
 * P04: the coverage sweep, once a tick for the whole installation (a bounded slice of the responsibilities, not one scan of every project): it keeps when each lapse was first seen and returns at most one notice per project
 * for lapses beyond the owner's period (nothing is told while the setting is off). A notice is marked told only after it was sent; an already-sent id (`command_conflict`) counts as sent. One failing notice does not skip the others.
 */
export function coverageLoops(coverage: { sweep(by: Principal): Promise<readonly CoverageNoticeLike[]>; markTold(by: Principal, notice: CoverageNoticeLike): Promise<void> }, notify: (notice: CoverageNoticeLike) => Promise<void>): DispatcherLoop[] {
  return [{ name: "responsibilities.coverage", run: async (by) => {
    let failure: unknown;
    for (const n of await coverage.sweep(by)) {
      try {
        try { await notify(n); } catch (error) { if (!(error instanceof DomainError && error.code === "command_conflict")) throw error; /* already told under this id */ }
        await coverage.markTold(by, n);
      } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  } }];
}
export interface CoverageNoticeLike { readonly alertId: string; readonly projectId: string; readonly count: number; readonly items: readonly { readonly responsibilityId: string; readonly title: string; readonly reasons: readonly string[]; readonly since: string; readonly lapsedMinutes: number }[]; readonly covered: readonly string[] }

/** K06: old resolved incidents are soft-archived, per project, so one project's failure does not skip the others. Not wired into the controller yet. */
export function archiveLoops(incidents: { archive(by: Principal, options: { projectId?: string }): Promise<number> }, projects: () => Promise<readonly string[]>): DispatcherLoop[] {
  return [{ name: "responsibilities.archive", run: async (by) => {
    let failure: unknown;
    for (const projectId of await projects()) {
      try { await incidents.archive(by, { projectId }); } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
  } }];
}

/** H13c: the agent whose watched event is waiting is told to look at its inbox: the waker reports `woken` once the agent's current attempt will see it, and `deferred` (tried again next tick) when there is none to wake. */
export function wakeLoops(watches: Pick<WatchService, "consumeWakes">, waker: Waker): DispatcherLoop[] {
  return [{ name: "events.wakes", run: async (by) => { await watches.consumeWakes(by, waker); } }];
}

/** The waker of the running controller (card H13c): an attempt that is running reads its inbox at its next boundary, and one waiting for a place reads it when it starts; anything else (no record yet, parked on an approval, finished) is tried again next tick. */
export function attemptWaker(dispatcher: () => { get(by: Principal, attemptId: string): Promise<{ state: string } | undefined> } | undefined, by: Principal): Waker {
  return { wake: async (r) => { const state = (await dispatcher()?.get(by, r.attemptId))?.state; return state === "running" || state === "waiting" ? "woken" : "deferred"; } };
}
