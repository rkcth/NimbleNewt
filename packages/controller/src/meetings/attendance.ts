import { DomainError } from "../domain/errors.js";
import { assignmentIdOf, type AssignmentBody } from "../domain/assignment-model.js";
import type { AssignmentService } from "../domain/assignments.js";
import { derivedId } from "../domain/ids.js";
import { commandId as checkCommandId, onlyKnown, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { AgentService } from "../agents/agents.js";
import type { Availability } from "../conversations/index.js";
import type { HistoryService } from "../context/histories.js";
import { PAUSE_EXEMPTION_KIND, PauseService, exemptionIdOf, type PauseExemptionBody, type PauseGateBody, type PauseScope } from "../lifecycle/index.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, JsonObject } from "../storage/types.js";
import { MEETING_LIMITS, type AgendaBody, type MeetingService, type OccurrenceBody, type ParticipantRecord } from "./meetings.js";

/** What the room shows for each invited agent (README 570): preparing to join, present, unavailable, or blocked by an operation it cannot safely interrupt. */
export type AttendanceState = "preparing" | "present" | "unavailable" | "blocked";
export type RoomKind = "scheduled" | "urgent" | "immediate";
export type RoomPhase = "gathering" | "open" | "ended";
/** `resumed`, `kept` and `ownership-changed` are final; `deferred` and `revalidating` wait (the attendance is in the pending-return list until they settle). */
export type ReturnKind = "resumed" | "kept" | "ownership-changed" | "deferred" | "revalidating";
export type KeptReason = "paused-before-meeting" | "requested-during-meeting" | "pause-replaced" | "already-resumed";

/** One assignment that was interrupted for the meeting: it keeps its owner and generation throughout; only its task-level gate is touched, and only when this attendance made it. */
export interface InterruptedWork {
  readonly taskId: string;
  /** The assignment generation when preparation began: return compares against it. */
  readonly generation: number;
  /** The task's own gate was paused by this attendance (and not before). Only such a pause is ever resumed by the return. */
  readonly pausedByUs: boolean;
  readonly pauseRequestId?: string;
  readonly alreadyPausedBy?: readonly PauseScope[];
  readonly outcome?: ReturnKind;
  readonly outcomeAt?: string;
  readonly outcomeDetail?: string;
  readonly deferUntil?: string;
  readonly stillPausedBy?: readonly PauseScope[];
}

export interface AttendanceEvent { readonly seq: number; readonly kind: string; readonly at: string; readonly by: string; readonly note?: string }

export interface ReturnPlan {
  /** Tasks (of this agent) that a decision of the meeting supersedes: the agent revalidates before its pause is lifted. */
  readonly superseded: readonly string[];
  /** A new priority: the return of these tasks waits until the time given, without moving the assignment. */
  readonly defer: readonly { readonly taskId: string; readonly until: string; readonly reason: string }[];
  readonly decisions: readonly string[];
}

export interface AttendanceBody {
  readonly occurrenceId: string;
  readonly projectId: string;
  /** The principal: `agent:agt-...`, or the owner's for the owner's own presence. */
  readonly who: string;
  readonly isOwner: boolean;
  readonly state: AttendanceState;
  readonly reason?: string;
  /** A paused agent the owner invited by hand: it attends this meeting only; everything else stays paused. */
  readonly bounded: boolean;
  /** The owner authorized waking or recovering a suspended or stopped agent for this meeting. */
  readonly wake?: { readonly by: string; readonly at: string };
  /** The agent's runtime reported an operation it cannot safely interrupt. */
  readonly reportedBlock?: { readonly reason: string; readonly at: string };
  /** `prepare` has been called (with the tasks the agent leaves, or an explicit empty list). A join needs it. */
  readonly prepared?: boolean;
  readonly interrupted: readonly InterruptedWork[];
  readonly meetingTaskId?: string;
  readonly joinedAt?: string;
  readonly joinedLate?: boolean;
  readonly leftAt?: string;
  /** Tasks the owner (or a task manager) asked to keep paused after the meeting: the return will not resume them. */
  readonly retain: readonly string[];
  readonly plan?: ReturnPlan;
  /** The return has been looked at for every interrupted task and nothing waits. */
  readonly returned: boolean;
  readonly brief?: { readonly text: string; readonly savedAt: string };
  readonly events: readonly AttendanceEvent[];
  readonly eventCount: number;
}

export interface RoomBody {
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly kind: RoomKind;
  readonly scope?: { readonly kind: "project" | "team"; readonly id: string };
  readonly title: string;
  /** The meeting conversation (C01 history of type meeting), when a history service is composed. */
  readonly historyId?: string;
  readonly roster: readonly string[];
  /** "Everyone required": the discussion waits for the whole roster until this time, then goes ahead and says who is missing. */
  readonly requireAll?: { readonly minutes: number; readonly timeoutAt: string };
  /** The only automatic return: assignments this meeting paused for attendance resume when it ends. Everything else is kept. */
  readonly returnPolicy: "attendance-pauses-only";
  readonly state: "open" | "ended";
  readonly openedBy: string;
  readonly openedAt: string;
  readonly ownerAttendance?: string;
  readonly discussion?: { readonly startedAt: string; readonly startedBy: string; readonly startedWith: readonly string[]; readonly missing: readonly string[]; readonly fullAttendance: boolean };
  readonly endedAt?: string;
  readonly endedBy?: string;
}

interface PendingBody { readonly ids: readonly string[] }
export interface RevalidationEntry {
  readonly occurrenceIds: readonly string[];
  readonly projectId: string;
  readonly taskIds: readonly string[];
  readonly decisions: readonly string[];
  readonly createdAt: string;
  readonly dueAt: string;
  /** The agent was in the meeting (its own pause is held until it acknowledges), or was absent and was notified. */
  readonly attended: boolean;
  readonly notifiedAt?: string;
  /** More than the entry can list: every task of the agent needs revalidation until it acknowledges. */
  readonly allTasks?: boolean;
}
export interface RevalidationBody { readonly agent: string; readonly entries: readonly RevalidationEntry[] }

export interface MeetingDecision {
  readonly ref: string;
  readonly summary?: string;
  /** Tasks whose plan this decision supersedes: their agents must revalidate their next actions before continuing. */
  readonly supersedes?: readonly string[];
  /** A new priority: these interrupted tasks are not returned to work yet (the assignment is not moved). */
  readonly defers?: readonly string[];
  readonly deferMinutes?: number;
}

/** Wakes or recovers a suspended or stopped agent (L02 and L03 supply it). Called only after the owner authorized it, once per key. */
export interface WakeSink { wake(request: { readonly key: string; readonly agent: string; readonly occurrenceId: string; readonly projectId: string }): Promise<void> }
/**
 * Warns an agent about the meeting's quick-answer period (owner decision 2026-10-29): a meeting is a context switch for quick answers with the agent's tools and desk, not for long-running work. `ahead` is sent when the agent is
 * asked to prepare, `begins` when it joins, `ends` when it is returned to its work. Idempotent by `key`; best effort (a failure never changes the attendance).
 */
export interface WindowSink { notify(event: { readonly key: string; readonly phase: "ahead" | "begins" | "ends"; readonly agent: string; readonly occurrenceId: string; readonly taskId: string }): Promise<void> }
/** Tells an absent agent what a meeting decided (a conversation message). Must be idempotent by `key`. */
export interface NoticeSink { notify(notice: { readonly key: string; readonly agent: string; readonly occurrenceId: string; readonly projectId: string; readonly decisions: readonly string[]; readonly taskIds: readonly string[]; readonly dueAt: string }): Promise<void> }

export interface AttendanceOptions extends RunnerOptions {
  /** Whether an agent may be reached (the pause service's `availability`, with L02/L03's suspended and stopped). Required. Fails closed: a missing or failing hook reads as `stopped`. */
  readonly availability: (principalId: string) => Promise<Availability>;
  readonly wake?: WakeSink;
  readonly notices?: NoticeSink;
  /** Warnings about the no-long-running-work period of a meeting. */
  readonly window?: WindowSink;
}

export const ATTENDANCE_LIMITS = {
  interrupted: 5, events: 50, brief: 4000, note: 300, reason: 500, timeoutMax: 1440, deferMax: 20160, revalidateMax: 10080, revalidateDefault: 1440,
  pending: 200, rooms: 200, decisions: 20, decisionTasks: 20, affectedTasks: 100, revalidationEntries: 50, revalidationTasks: 100, revalidationOccurrences: 25, timeline: 200, expectedMax: 1440, retries: 8,
} as const;

const AGENT = /^agent:(agt-[a-z2-7]{20})$/;
const OCCURRENCE_ID = /^mto-[a-z2-7]{20}$/;
const PENDING = "all";
const ROOMS = "all";
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const whole = (value: unknown, field: string, min: number, max: number): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(field, `must be a whole number from ${min} to ${max}`));
const clean = <T extends object>(body: T): JsonObject => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as unknown as JsonObject;
const staff = (p: Principal): boolean => (p.kind === "owner" || p.kind === "host" || p.kind === "service") && p.taskScope === undefined;
const ms = (iso: string): number => Date.parse(iso);
const forbidden = (by: Principal, what: string): DomainError => new DomainError("forbidden", `${by.id} may not ${what}`);
const roomIdOf = (occurrenceId: string): string => derivedId("mrm", occurrenceId);
const attendanceIdOf = (occurrenceId: string, who: string): string => derivedId("mat", `${occurrenceId}\0${who}`);
const agentIdOf = (principal: string): string => AGENT.exec(principal)?.[1] ?? invalid("agent", "is not an agent principal");
const sameScope = (a: PauseScope, b: PauseScope): boolean => a.kind === b.kind && a.id === b.id;

export type AdmissionAdvice =
  | { readonly decision: "start"; readonly reason: string; readonly meeting?: { readonly occurrenceId: string; readonly startsAt: string; readonly endsAt: string }; /** The work is a safe long-running operation and carries on while the agent attends. */ readonly continuesDuringMeeting?: boolean }
  | { readonly decision: "defer"; readonly reason: string; readonly until: string; readonly meeting: { readonly occurrenceId: string; readonly startsAt: string; readonly endsAt: string } };

export interface ParticipantView {
  readonly who: string;
  readonly isOwner: boolean;
  readonly state: AttendanceState;
  readonly reason?: string;
  readonly bounded: boolean;
  readonly joinedAt?: string;
  readonly joinedLate?: boolean;
  readonly leftAt?: string;
  /** The interrupted tasks that have not yet reached a safe boundary, with what the executor reports. */
  readonly waitingOn: readonly { readonly taskId: string; readonly observed: string }[];
  /** An unavailable participant whose presence matters (everyone is required, or an agenda item names it): the question for the owner. */
  readonly ownerQuestion?: string;
  readonly meetingTaskId?: string;
  readonly returned: boolean;
  readonly interrupted: readonly InterruptedWork[];
  readonly eventCount: number;
}
export interface RoomStatus {
  readonly room: View<RoomBody>;
  readonly occurrence: { readonly id: string; readonly title: string; readonly startsAt: string; readonly endsAt: string; readonly state: string };
  readonly phase: RoomPhase;
  /** The discussion may begin: the room is not waiting on a required roster. */
  readonly discussionMay: boolean;
  readonly deadline?: string;
  /** Everyone on the roster is present now. Never claimed for a meeting that went ahead without someone. */
  readonly fullAttendance: boolean;
  readonly missing: readonly string[];
  readonly ownerPresent: boolean;
  readonly participants: readonly ParticipantView[];
  /** The state so far for a late joiner: every join, leave and change, oldest first (the last 200; `timelineCount` is exact). */
  readonly timeline: readonly (AttendanceEvent & { readonly who: string })[];
  readonly timelineCount: number;
  readonly agenda: readonly View<AgendaBody>[];
}

/**
 * Meeting attendance and return to work (card M04). It decides who is in a meeting room, what happens to the work they leave, and what comes back afterwards. The meeting procedure (chair, motions, ballots, summaries) is M05 and M06.
 *
 * - **Rooms.** `openRoom` makes the room for a scheduled or urgent occurrence of M01; `callNow` makes an immediate one scoped to a project's participants or a named team (and asks, creating nothing, when the scope is unclear). Each participant shows as
 *   `preparing`, `present`, `unavailable` or `blocked`. A room starts at once with whoever is available; "everyone required" waits under a visible timeout and then goes ahead saying who is missing.
 * - **Joining.** `prepare` pauses the interrupted tasks at task scope only (L01) and `join` happens at their safe boundary: a separate bounded meeting task is created and assigned to the agent; the interrupted assignment, its owner and its background work are not touched.
 *   Nothing here suspends, hands off, releases or force-stops anything. A paused agent attends only when the owner invited it by hand (M01) and then only through that one meeting task (a `pause-exemption` that expires); a suspended or stopped agent
 *   is woken only by the owner's `authorizeWake`.
 * - **Return.** `endMeeting` ends the room and returns each attendee: a pause this meeting made for attendance is resumed; a pause that predated it, was requested during it or was replaced, and every suspension and stop, stays. The return checks the assignment
 *   (owner and generation as at preparation), waits for an agent whose work a decision supersedes to revalidate, and can be deferred by a new priority; none of it moves an assignment. Absent affected agents get a durable notice and revalidate before continuing.
 */
export class AttendanceService {
  readonly #runner: CommandRunner;
  readonly #meetings: MeetingService;
  readonly #pauses: PauseService;
  readonly #projects: ProjectService;
  readonly #charge: AttendanceDeps["charge"];
  readonly #onChargeError: AttendanceDeps["onChargeError"];
  readonly #leadMinutes: AttendanceDeps["leadMinutes"];
  readonly #assignments: AssignmentService;
  readonly #agents: AgentService | undefined;
  readonly #histories: HistoryService | undefined;
  readonly #availability: AttendanceOptions["availability"];
  readonly #wake: WakeSink | undefined;
  readonly #notices: NoticeSink | undefined;
  readonly #window: WindowSink | undefined;

  private constructor(runner: CommandRunner, deps: AttendanceDeps, options: AttendanceOptions) {
    this.#runner = runner;
    this.#meetings = deps.meetings;
    this.#pauses = deps.pauses;
    this.#projects = deps.projects;
    this.#assignments = deps.assignments;
    this.#agents = deps.agents;
    this.#histories = deps.histories;
    this.#charge = deps.charge;
    this.#onChargeError = deps.onChargeError;
    this.#leadMinutes = deps.leadMinutes;
    this.#availability = options.availability;
    this.#wake = options.wake;
    this.#notices = options.notices;
    this.#window = options.window;
  }

  static withEpoch(storage: ConstructorParameters<typeof CommandRunner>[0], epoch: number, deps: AttendanceDeps, options: AttendanceOptions): AttendanceService {
    if (deps.projects.epoch !== epoch || deps.assignments.epoch !== epoch) invalid("epoch", "must be the epoch the project and assignment services write under");
    return new AttendanceService(new CommandRunner(storage, epoch, options), deps, options);
  }

  // ---- admission near a meeting ----------------------------------------------------------------------------------------------------

  /**
   * Whether work may start now for an agent with a meeting coming: work that cannot yield before the meeting is deferred until it ends, while work that finishes before the meeting starts, work that reaches a safe boundary on request and a
   * safe long-running operation (a detached job that carries on while the agent attends) all start. It sees the meetings that already exist, which M01 makes at the start of each schedule's preparation lead (so the lead is how far ahead it can look). Advisory and read-only: the dispatcher asks before it asks H03 for a place. Looks at the meetings waiting to be held (at most 1000, M01's cap), and only
   * at those the agent will attend (eligible, or a paused agent the owner invited). For the owner, host or service principal, or the agent itself.
   */
  async admission(by: Principal, query: { agent: string; expectedMinutes: number; yieldsAtBoundary?: boolean; safeLongRunning?: boolean }): Promise<AdmissionAdvice> {
    onlyKnown(query, ["agent", "expectedMinutes", "yieldsAtBoundary", "safeLongRunning"]);
    const agent = typeof query.agent === "string" && AGENT.test(query.agent) ? query.agent : invalid("agent", "is not an agent principal");
    const expected = whole(query.expectedMinutes, "expectedMinutes", 1, ATTENDANCE_LIMITS.expectedMax);
    if (!(staff(by) || (by.kind === "agent" && by.id === agent && by.taskScope === undefined))) throw forbidden(by, "ask about that agent's admission");
    const nowMs = ms(this.#runner.now());
    const horizon = nowMs + expected * 60_000;
    // Only a meeting the agent will really attend holds its work back: reachable now, or paused with the owner's direct invitation.
    const live = await this.#reach(agent);
    const lead = await this.#lead();
    let nearest: { id: string; body: OccurrenceBody; from: number } | undefined;
    const global = (await this.#runner.get("meeting-open", "all"))?.body as unknown as { projects?: string[] } | undefined;
    for (const projectId of global?.projects ?? []) {
      const open = (await this.#runner.get("meeting-open", projectId))?.body as unknown as { ids?: string[] } | undefined;
      for (const id of open?.ids ?? []) {
        const body = (await this.#runner.get("meeting-occurrence", id))?.body as unknown as OccurrenceBody | undefined;
        if (body === undefined || body.state !== "planned" || body.mode !== "live" || ms(body.endsAt) <= nowMs) continue;
        const seat = body.participants.find((p) => p.id === agent);
        if (seat === undefined || !(live === "available" || (live === "paused" && seat.status === "owner-invited"))) continue;
        // The work would still be running when the meeting starts (or the meeting is on): that is the conflict. The occurrence exists from its preparation lead, so the lead is how far ahead this can see.
        const from = ms(body.startsAt);
        if (from >= horizon && !(lead > 0 && from - nowMs <= lead * 60_000)) continue;
        if (nearest === undefined || from < nearest.from) nearest = { id, body, from };
      }
    }
    if (nearest === undefined) return { decision: "start", reason: "no meeting this agent will attend falls within the work's expected time" };
    const meeting = { occurrenceId: nearest.id, startsAt: nearest.body.startsAt, endsAt: nearest.body.endsAt };
    // The lead before a meeting: the agent is kept free, so even work that would end before the meeting, or could yield at a boundary, waits for it (only a safe long-running operation carries on).
    const kept = lead > 0 && nearest.from - nowMs <= lead * 60_000;
    if (kept && query.safeLongRunning !== true) return { decision: "defer", reason: `the agent is kept free for the meeting that starts at ${meeting.startsAt} (${lead} minutes' notice)`, until: nearest.body.endsAt, meeting };
    if (query.safeLongRunning === true) return { decision: "start", reason: "a safe long-running operation carries on while the agent attends", meeting, continuesDuringMeeting: true };
    if (query.yieldsAtBoundary === true) return { decision: "start", reason: "the work reaches a safe boundary on request, so it can yield to the meeting", meeting };
    return { decision: "defer", reason: "the work cannot yield before the meeting and would not finish first", until: nearest.body.endsAt, meeting };
  }

  async #lead(): Promise<number> {
    try {
      const v = await this.#leadMinutes?.();
      return typeof v === "number" && Number.isInteger(v) && v > 0 ? Math.min(v, MEETING_LIMITS.leadMax) : 0;
    } catch { return 0; }
  }

  // ---- rooms -------------------------------------------------------------------------------------------------------------------------------

  /**
   * Opens the room of a scheduled or urgent occurrence (M01): one attendance record per roster member, decided now from what the lifecycle says (a paused agent stays out unless the owner invited it; a suspended or stopped one is not woken), and the
   * meeting conversation when a history service is composed. Needs `meeting.manage` in the project, or the owner, host or service. Repeating it returns the room.
   */
  async openRoom(by: Principal, command: NoActor & { occurrenceId: string; requireAll?: { timeoutMinutes: number } }): Promise<{ roomId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "occurrenceId", "requireAll"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const requireAll = command.requireAll === undefined ? undefined : this.#requireAll(command.requireAll);
    const found = await this.#runner.get("meeting-occurrence", occurrenceId);
    const occ = found?.body as unknown as OccurrenceBody | undefined;
    if (found === undefined || occ === undefined || !this.#mayRun(by, occ.projectId)) throw forbidden(by, "open that meeting's room");
    return this.#open(by, command.commandId, occurrenceId, occ.kind, undefined, requireAll);
  }

  async #open(by: Principal, commandId: unknown, occurrenceId: string, kind: RoomKind, scope: RoomBody["scope"], requireAll: { timeoutMinutes: number } | undefined): Promise<{ roomId: string; replayed: boolean }> {
    const roomId = roomIdOf(occurrenceId);
    const result = await this.#retrying(() => this.#runner.command("meeting.room.open", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: clean({ occurrenceId, kind, scope: scope as unknown as JsonObject | undefined, requireAll: requireAll as unknown as JsonObject | undefined }),
      build: async () => {
        const found = await this.#runner.get("meeting-occurrence", occurrenceId);
        const occ = found?.body as unknown as OccurrenceBody | undefined;
        if (found === undefined || occ === undefined || !this.#mayRun(by, occ.projectId)) throw forbidden(by, "open that meeting's room");
        if (occ.state !== "planned" || occ.mode !== "live") throw new DomainError("invalid_command", `meeting ${occurrenceId} is not waiting to be held`, { field: "occurrenceId" });
        const existing = await this.#runner.get("meeting-room", roomId);
        const ref: AggregateRef = { kind: "meeting-room", id: roomId };
        if (existing !== undefined) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: existing.revision }], detail: { occurrenceId, projectId: occ.projectId, reopened: true } };
        const nowIso = this.#runner.now();
        const open = await this.#runner.get("meeting-room-open", ROOMS);
        const openIds = (open?.body as unknown as PendingBody | undefined)?.ids ?? [];
        if (openIds.length >= ATTENDANCE_LIMITS.rooms) throw new DomainError("unavailable", `${ATTENDANCE_LIMITS.rooms} meeting rooms are already open; end some first`);
        const room: RoomBody = {
          occurrenceId, projectId: occ.projectId, kind, ...(scope === undefined ? {} : { scope }), title: occ.title, roster: occ.participants.map((p) => p.id),
          ...(requireAll === undefined ? {} : { requireAll: { minutes: requireAll.timeoutMinutes, timeoutAt: new Date(ms(nowIso) + requireAll.timeoutMinutes * 60_000).toISOString() } }),
          returnPolicy: "attendance-pauses-only", state: "open", openedBy: by.id, openedAt: nowIso,
        };
        const listRef: AggregateRef = { kind: "meeting-room-open", id: ROOMS };
        const listBody = { ids: [...openIds, occurrenceId] } as unknown as JsonObject;
        const changes: Change[] = [
          { type: "check", ref: { kind: "meeting-occurrence", id: occurrenceId }, expectedRevision: found.revision }, { type: "create", ref, body: clean(room) },
          open === undefined ? { type: "create", ref: listRef, body: listBody } : { type: "update", ref: listRef, expectedRevision: open.revision, body: listBody },
        ];
        for (const p of occ.participants) {
          const decided = await this.#decide(p.id, p);
          const body: AttendanceBody = {
            occurrenceId, projectId: occ.projectId, who: p.id, isOwner: false, state: decided.state, ...(decided.reason === undefined ? {} : { reason: decided.reason }), bounded: decided.bounded,
            interrupted: [], retain: [], returned: false, events: [{ seq: 1, kind: decided.state === "unavailable" ? "unavailable" : "invited", at: nowIso, by: by.id, ...(decided.reason === undefined ? {} : { note: decided.reason }) }], eventCount: 1,
          };
          changes.push({ type: "create", ref: { kind: "meeting-attendance", id: attendanceIdOf(occurrenceId, p.id) }, body: clean(body) });
        }
        return { ref, creates: true, changes, detail: { occurrenceId, projectId: occ.projectId, kind, participants: occ.participants.length } };
      },
    })));
    await this.#ensureHistory(by, occurrenceId);
    return { roomId, replayed: result.replayed };
  }

  /**
   * Where a participant stands right now: reachable, paused (it attends only by the owner's direct invitation, and only if every gate holding it was placed before that invitation and none is the installation's: the emergency brake is never overridden), or
   * suspended or stopped (never woken here). `covers` lists the gates the invitation covers, with the request that paused each.
   */
  async #decide(who: string, seat?: ParticipantRecord): Promise<{ state: AttendanceState; reason?: string; bounded: boolean; covers?: PauseExemptionBody["covers"] }> {
    const availability = await this.#reach(who);
    if (availability === "available") return { state: "preparing", bounded: false };
    if (availability === "paused") {
      const out = (reason: string) => ({ state: "unavailable" as const, reason, bounded: false });
      if (seat?.status !== "owner-invited" || seat.ownerInvitedAt === undefined) return out("paused: a schedule or a request does not wake a paused agent; its saved brief is available");
      const holds = await this.#pauses.agentHolds(agentIdOf(who));
      if (holds.some((h) => h.scope.kind === "installation")) return out("the whole installation is paused; an invitation never overrides that. Its saved brief is available");
      if (holds.some((h) => h.pausedAt > (seat.ownerInvitedAt as string))) return out("it was paused again after the owner's invitation; the owner invites it again if it should attend. Its saved brief is available");
      return { state: "preparing", bounded: true, covers: holds.map((h) => ({ kind: h.scope.kind as "agent" | "team", id: h.scope.id, requestId: h.requestId })) };
    }
    return { state: "unavailable", reason: `${availability}: it stays ${availability} unless the owner authorizes waking or recovering it; its saved brief is available`, bounded: false };
  }

  async #ensureHistory(by: Principal, occurrenceId: string): Promise<void> {
    if (this.#histories === undefined) return;
    const roomId = roomIdOf(occurrenceId);
    const room = await this.#runner.get("meeting-room", roomId);
    const body = room?.body as unknown as RoomBody | undefined;
    if (room === undefined || body === undefined || body.historyId !== undefined || !allows(by, "history.append", body.projectId)) return;
    const opened = await this.#histories.openScope(by, { commandId: `room-history:${occurrenceId}`, type: "meeting", projectId: body.projectId, participants: body.roster });
    for (let attempt = 1; ; attempt++) {
      const cur = await this.#runner.get("meeting-room", roomId);
      const b = cur?.body as unknown as RoomBody | undefined;
      if (cur === undefined || b === undefined || b.historyId !== undefined) return;
      try {
        await this.#runner.command("meeting.room.history", { commandId: scopedCommandId(by.id, `room-history-link:${occurrenceId}:${cur.revision}`), actor: by.id }, async () => ({
          payload: { occurrenceId, historyId: opened.id },
          build: async () => { const ref: AggregateRef = { kind: "meeting-room", id: roomId }; return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: cur.revision, body: clean({ ...b, historyId: opened.id }) }], detail: { occurrenceId } }; },
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= ATTENDANCE_LIMITS.retries) throw error;
      }
    }
  }

  /**
   * "Bring everyone into a meeting now": an immediate meeting scoped to the project's participants or to a named team. If the scope is not given (or names nobody), nothing is created and nobody is interrupted: the answer is a question with the choices
   * (`needs-scope`). Otherwise the occurrence (M01's urgent meeting, with a high-priority invitation for each available agent) and its room exist at once; agents that cannot come show as unavailable, preparing or blocked. Needs `meeting.manage`.
   */
  async callNow(by: Principal, command: NoActor & { projectId: string; title: string; reason: string; scope?: { kind: "project" } | { kind: "team"; teamId: string }; requireAll?: { timeoutMinutes: number }; durationMinutes?: number }): Promise<
    { status: "started"; occurrenceId: string; roomId: string; replayed: boolean } | { status: "needs-scope"; question: string; choices: readonly { kind: "project" | "team"; id: string; label: string; agents: number }[] } | { status: "too-large"; agents: number; limit: number }
  > {
    onlyKnown(command, ["commandId", "projectId", "title", "reason", "scope", "requireAll", "durationMinutes"]);
    const projectId = typeof command.projectId === "string" ? command.projectId : invalid("projectId", "is not a project ID");
    if (!allows(by, "meeting.manage", projectId) || (await this.#runner.get("project", projectId)) === undefined) throw forbidden(by, "call a meeting in that project");
    const title = plain(command.title, "title", MEETING_LIMITS.title);
    const reason = plain(command.reason, "reason", MEETING_LIMITS.reason);
    const requireAll = command.requireAll === undefined ? undefined : this.#requireAll(command.requireAll);
    const given = checkCommandId(command.commandId);
    const scope = command.scope;
    const participants = ((await this.#runner.get("project", projectId))?.body as unknown as { participants?: { principalId: string }[] } | undefined)?.participants ?? [];
    const projectAgents = await this.#activeAgents(participants.map((x) => x.principalId));
    const choices: { kind: "project" | "team"; id: string; label: string; agents: number }[] = [];
    if (projectAgents.length > 0) choices.push({ kind: "project", id: projectId, label: "this project's participants", agents: projectAgents.length });
    if (scope === undefined) {
      return { status: "needs-scope", question: "Which agents should be brought in: this project's participants, or a named team? Nobody has been interrupted.", choices };
    }
    let roster: string[];
    let roomScope: NonNullable<RoomBody["scope"]>;
    if (scope.kind === "project") {
      onlyKnown(scope, ["kind"]);
      if (projectAgents.length === 0) return { status: "needs-scope", question: "This project has no participants to bring in. Name a team. Nobody has been interrupted.", choices };
      roster = projectAgents;
      roomScope = { kind: "project", id: projectId };
    } else if (scope.kind === "team") {
      onlyKnown(scope, ["kind", "teamId"]);
      const teamId = typeof scope.teamId === "string" ? scope.teamId : invalid("scope.teamId", "is not a team ID");
      if (this.#agents === undefined || (await this.#runner.get("team", teamId)) === undefined) return { status: "needs-scope", question: "That team is not known. Which team, or this project's participants? Nobody has been interrupted.", choices };
      const members: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page: Awaited<ReturnType<AgentService["list"]>> = await this.#agents.list(by, { teamId, state: "active", limit: 50, ...(after === undefined ? {} : { afterId: after }) });
        for (const a of page.items) members.push(a.principalId);
        if (page.next === undefined || page.next === after) break;
        after = page.next;
        if (members.length > MEETING_LIMITS.roster) break;
      }
      if (members.length === 0) return { status: "needs-scope", question: "That team has no active agents. Which team, or this project's participants? Nobody has been interrupted.", choices };
      roster = [...new Set(members)].sort();
      roomScope = { kind: "team", id: teamId };
    } else return invalid("scope.kind", "must be project or team");
    if (roster.length > MEETING_LIMITS.roster) return { status: "too-large", agents: roster.length, limit: MEETING_LIMITS.roster };
    const called = await this.#meetings.callUrgent(by, {
      commandId: `now-${given}`, projectId, title, reason, roster, ...(command.durationMinutes === undefined ? {} : { durationMinutes: command.durationMinutes }),
    });
    const room = await this.#open(by, `now-room-${given}`, called.id, "immediate", roomScope, requireAll);
    // The high-priority request goes out through the invitation sink (only the owner, host or service may send it; a manager's room waits for one of them).
    if (staff(by)) await this.#meetings.dispatchInvitations(by, called.id);
    return { status: "started", occurrenceId: called.id, roomId: room.roomId, replayed: called.replayed && room.replayed };
  }

  /** The agent principals (active agents only) among the given ones, sorted and without repeats. Records of other kinds and retired agents are left out. */
  /**
   * Whether `taskId` is the bounded meeting task of `agent` while that agent is present in a live meeting: the meeting it is in, or `undefined`. The jobs service asks this before it admits long-running work (card M04e), so the rule
   * "no long-running work during a meeting" is kept by the controller and not only told to the agent. Looks at the meetings waiting to be held (M01's cap), like `admission`.
   */
  async meetingOfTask(taskId: string, agent: string): Promise<{ occurrenceId: string; endsAt: string } | undefined> {
    if (!AGENT.test(agent)) return undefined;
    const global = (await this.#runner.get("meeting-open", "all"))?.body as unknown as { projects?: string[] } | undefined;
    for (const projectId of global?.projects ?? []) {
      const open = (await this.#runner.get("meeting-open", projectId))?.body as unknown as { ids?: string[] } | undefined;
      for (const id of open?.ids ?? []) {
        const att = await this.#attendance(id, agent);
        if (att === undefined || att.body.state !== "present" || att.body.leftAt !== undefined || att.body.meetingTaskId !== taskId) continue;
        const occ = (await this.#runner.get("meeting-occurrence", id))?.body as unknown as OccurrenceBody | undefined;
        if (occ !== undefined && occ.state === "planned") return { occurrenceId: id, endsAt: occ.endsAt };
      }
    }
    return undefined;
  }

  async #activeAgents(principals: readonly string[]): Promise<string[]> {
    const out: string[] = [];
    for (const p of [...new Set(principals)].sort()) {
      const id = AGENT.exec(p)?.[1];
      const agent = id === undefined ? undefined : (await this.#runner.get("agent", id))?.body as unknown as { state?: string } | undefined;
      if (agent?.state === "active") out.push(p);
    }
    return out;
  }

  // ---- reading the room ------------------------------------------------------------------------------------------------------------------

  /**
   * The room as this viewer may see it: who is preparing, present, unavailable or blocked and why, what each interrupted task is waiting on, the timeline so far (what a late joiner needs), the agenda, and whether the discussion may begin. A viewer who
   * may not see the meeting (not a reader of the project's meetings, not on its roster) gets `undefined`, as for a room that does not exist.
   */
  async status(viewer: Principal, occurrenceId: string): Promise<RoomStatus | undefined> {
    const id = this.#occurrenceId(occurrenceId);
    const seen = await this.#meetings.occurrence(viewer, id);
    const room = await this.#runner.get("meeting-room", roomIdOf(id));
    if (seen === undefined || room === undefined) return undefined;
    const body = room.body as unknown as RoomBody;
    const occ = seen.occurrence as unknown as OccurrenceBody;
    const nowMs = ms(this.#runner.now());
    const who = [...body.roster, ...(body.ownerAttendance === undefined ? [] : [body.ownerAttendance])];
    const participants: ParticipantView[] = [];
    const timeline: (AttendanceEvent & { who: string })[] = [];
    let timelineCount = 0;
    for (const w of who) {
      const att = await this.#attendance(id, w);
      if (att === undefined) continue;
      const waitingOn = await this.#waiting(att.body);
      const effective = this.#effective(att.body, waitingOn);
      const agenda = seen.agenda as unknown as View<AgendaBody>[];
      const necessary = effective.state === "unavailable" && !att.body.isOwner && (body.requireAll !== undefined || agenda.some((a) => a.participants.includes(w)));
      participants.push({
        who: w, isOwner: att.body.isOwner, state: effective.state, ...(effective.reason === undefined ? {} : { reason: effective.reason }), bounded: att.body.bounded,
        ...(att.body.joinedAt === undefined ? {} : { joinedAt: att.body.joinedAt }), ...(att.body.joinedLate === true ? { joinedLate: true } : {}), ...(att.body.leftAt === undefined ? {} : { leftAt: att.body.leftAt }),
        waitingOn: waitingOn.map((x) => ({ taskId: x.taskId, observed: x.observed })),
        ...(necessary ? { ownerQuestion: `${w} cannot attend (${effective.reason ?? effective.state}). Its participation matters here: authorize waking or recovering it, or go ahead without it?` } : {}),
        ...(att.body.meetingTaskId === undefined ? {} : { meetingTaskId: att.body.meetingTaskId }), returned: att.body.returned, interrupted: att.body.interrupted, eventCount: att.body.eventCount,
      });
      timelineCount += att.body.eventCount;
      for (const e of att.body.events) timeline.push({ ...e, who: w });
    }
    timeline.sort((a, b) => (a.at < b.at ? -1 : a.at > b.at ? 1 : a.who < b.who ? -1 : a.who > b.who ? 1 : a.seq - b.seq));
    const roster = participants.filter((p) => !p.isOwner);
    const missing = roster.filter((p) => p.state !== "present").map((p) => p.who);
    const fullAttendance = missing.length === 0;
    const phase: RoomPhase = body.state === "ended" ? "ended" : body.requireAll !== undefined && !fullAttendance && nowMs < ms(body.requireAll.timeoutAt) ? "gathering" : "open";
    return {
      room: view<RoomBody>(room), occurrence: { id, title: occ.title, startsAt: occ.startsAt, endsAt: occ.endsAt, state: occ.state }, phase, discussionMay: phase === "open",
      ...(body.requireAll === undefined ? {} : { deadline: body.requireAll.timeoutAt }), fullAttendance, missing, ownerPresent: participants.some((p) => p.isOwner && p.state === "present"),
      participants, timeline: timeline.slice(-ATTENDANCE_LIMITS.timeline), timelineCount, agenda: seen.agenda,
    };
  }

  /**
   * Records that the discussion begins, with whoever is present: at once for an ordinary room, and for "everyone required" only when the roster is complete or the visible timeout has passed (the record then names who is missing and says the attendance
   * was not full). Late joiners may still come in. At least one participant must be present. Owner, host, service, or `meeting.manage`.
   */
  async beginDiscussion(by: Principal, command: NoActor & { occurrenceId: string }): Promise<{ startedWith: readonly string[]; missing: readonly string[]; fullAttendance: boolean; replayed: boolean }> {
    onlyKnown(command, ["commandId", "occurrenceId"]);
    const id = this.#occurrenceId(command.occurrenceId);
    const room = await this.#runner.get("meeting-room", roomIdOf(id));
    const rb = room?.body as unknown as RoomBody | undefined;
    if (room === undefined || rb === undefined || !this.#mayRun(by, rb.projectId)) throw forbidden(by, "begin that discussion");
    let out: { startedWith: readonly string[]; missing: readonly string[]; fullAttendance: boolean } = { startedWith: [], missing: [], fullAttendance: false };
    const result = await this.#retrying(() => this.#runner.command("meeting.room.begin", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { occurrenceId: id },
      build: async () => {
        const cur = await this.#runner.get("meeting-room", roomIdOf(id));
        const b = cur?.body as unknown as RoomBody | undefined;
        if (cur === undefined || b === undefined || !this.#mayRun(by, b.projectId)) throw forbidden(by, "begin that discussion");
        if (b.state !== "open") throw new DomainError("invalid_command", `the room of meeting ${id} has ended`, { field: "occurrenceId" });
        const ref: AggregateRef = { kind: "meeting-room", id: cur.id };
        if (b.discussion !== undefined) { out = b.discussion; return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: cur.revision }], detail: { occurrenceId: id, again: true } }; }
        const present: string[] = [];
        const missing: string[] = [];
        const checks: Change[] = [];
        for (const w of b.roster) {
          const att = await this.#attendance(id, w);
          if (att !== undefined) checks.push({ type: "check", ref: { kind: "meeting-attendance", id: att.id }, expectedRevision: att.revision });
          if (att?.body.state === "present") present.push(w); else missing.push(w);
        }
        const ownerAtt = b.ownerAttendance === undefined ? undefined : await this.#attendance(id, b.ownerAttendance);
        if (ownerAtt !== undefined) checks.push({ type: "check", ref: { kind: "meeting-attendance", id: ownerAtt.id }, expectedRevision: ownerAtt.revision });
        const ownerPresent = ownerAtt?.body.state === "present";
        const full = missing.length === 0;
        if (b.requireAll !== undefined && !full && ms(this.#runner.now()) < ms(b.requireAll.timeoutAt)) {
          throw new DomainError("invalid_command", `everyone is required; waiting for ${missing.join(", ")} until ${b.requireAll.timeoutAt}`, { field: "occurrenceId" });
        }
        if (present.length === 0 && !ownerPresent) throw new DomainError("invalid_command", "no one is present yet", { field: "occurrenceId" });
        const discussion = { startedAt: this.#runner.now(), startedBy: by.id, startedWith: [...present, ...(ownerPresent ? [b.ownerAttendance as string] : [])], missing, fullAttendance: full };
        out = discussion;
        return { ref, creates: false, changes: [...checks, { type: "update", ref, expectedRevision: cur.revision, body: clean({ ...b, discussion }) }], detail: { occurrenceId: id, present: present.length, missing: missing.length } };
      },
    })));
    return { ...out, replayed: result.replayed };
  }

  // ---- preparing and joining ---------------------------------------------------------------------------------------------------------

  /**
   * Asks an agent to come to a safe boundary: pauses the tasks it will leave at task scope only (L01 `pause`, with the caller's own authority, never Suspend), and records for each whether this attendance made the pause. Up to five tasks, each assigned to
   * the agent. Repeating it after a crash finishes what is missing. The agent's runtime then reports the boundary (`PauseService.observe`); `join` waits for it. Needs `meeting.manage` (or the owner, host or service) and the pause authority of L01.
   */
  async prepare(by: Principal, command: NoActor & { occurrenceId: string; agent: string; interrupted?: readonly string[] }): Promise<{ state: AttendanceState; waitingOn: readonly { taskId: string; observed: string }[] }> {
    onlyKnown(command, ["commandId", "occurrenceId", "agent", "interrupted"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const agent = typeof command.agent === "string" ? command.agent : invalid("agent", "is not an agent principal");
    const agentId = agentIdOf(agent);
    const tasks = this.#taskList(command.interrupted ?? [], "interrupted", ATTENDANCE_LIMITS.interrupted);
    const room = await this.#roomFor(occurrenceId);
    if (room === undefined || !this.#mayRun(by, room.body.projectId)) throw forbidden(by, "prepare for that meeting");
    if (room.body.state !== "open") throw new DomainError("invalid_command", `the room of meeting ${occurrenceId} has ended`, { field: "occurrenceId" });
    const attId = attendanceIdOf(occurrenceId, agent);
    const current = await this.#attendance(occurrenceId, agent);
    if (current === undefined) throw forbidden(by, "prepare for that meeting");
    if (current.body.state === "present") throw new DomainError("invalid_command", `${agent} is already in the meeting`, { field: "agent" });
    if (current.body.leftAt !== undefined) throw new DomainError("invalid_command", `${agent} has left that meeting`, { field: "agent" });
    // Re-decide: a resumed agent has become reachable, an owner invitation has been recorded since the room opened.
    const decided = await this.#redecide(current.body, occurrenceId);
    if (decided.state === "unavailable") {
      await this.#update(by, "prepare", attId, (b) => ({ ...b, state: "unavailable", ...(decided.reason === undefined ? {} : { reason: decided.reason }), bounded: decided.bounded }), "unavailable");
      throw new DomainError("invalid_command", `${agent} is unavailable: ${decided.reason ?? "not reachable"}`, { field: "agent" });
    }
    const plan: InterruptedWork[] = [];
    for (const taskId of tasks) {
      const asg = (await this.#runner.get("assignment", assignmentIdOf(taskId)))?.body as unknown as AssignmentBody | undefined;
      if (asg === undefined || asg.state !== "assigned" || asg.owner?.kind !== "agent" || asg.owner.id !== agentId) invalid("interrupted", `${taskId} is not assigned to ${agent}`);
      const keep = current.body.interrupted.find((x) => x.taskId === taskId);
      plan.push(keep ?? { taskId, generation: (asg as AssignmentBody).generation, pausedByUs: false });
    }
    const done: InterruptedWork[] = [];
    for (const item of plan) {
      if (item.pauseRequestId !== undefined || item.alreadyPausedBy !== undefined) { done.push(item); continue; }
      const scope: PauseScope = { kind: "task", id: item.taskId };
      try {
        const paused = await this.#pauses.pause(by, { commandId: `attend-pause:${attId}:${item.taskId}`, scope, reason: `attending meeting ${occurrenceId}; resumes when it ends unless paused for another reason` });
        done.push({ ...item, pausedByUs: true, pauseRequestId: paused.requestId });
      } catch (error) {
        // Already paused (before this meeting, or by another caller of this attendance): not ours, so the return leaves it paused.
        if (!(error instanceof DomainError) || error.code !== "invalid_command" || error.field !== "scope") throw error;
        const gate = (await this.#runner.get("pause-gate", PauseService.gateIdOf(scope)))?.body as unknown as PauseGateBody | undefined;
        if (gate?.intent !== "pause") throw error;
        // A crash between the pause and the write of this attendance leaves the pause ours: the request on the gate carries this attendance's operation ID and the same caller.
        const req = gate.requestId === undefined ? undefined : (await this.#runner.get("pause-request", gate.requestId))?.body as unknown as { operationId?: string; actor?: string } | undefined;
        if (req?.operationId === `attend-pause:${attId}:${item.taskId}` && req.actor === by.id) done.push({ ...item, pausedByUs: true, pauseRequestId: gate.requestId as string });
        else done.push({ ...item, pausedByUs: false, alreadyPausedBy: [scope] });
      }
    }
    await this.#update(by, "prepare", attId, (b) => ({
      ...b, state: decided.state, bounded: decided.bounded, prepared: true, ...(decided.reason === undefined ? {} : { reason: decided.reason }),
      // A concurrent prepare may have recorded the pause as ours already: that record wins.
      interrupted: [...b.interrupted.filter((x) => !done.some((d) => d.taskId === x.taskId)), ...done.map((d) => b.interrupted.find((x) => x.taskId === d.taskId && x.pauseRequestId !== undefined) ?? d)],
    }), "preparing");
    const after = (await this.#attendance(occurrenceId, agent))!;
    if (tasks[0] !== undefined) await this.#warn("ahead", after.id, agent, occurrenceId, tasks[0]);
    const waitingOn = await this.#waiting(after.body);
    return { state: this.#effective(after.body, waitingOn).state, waitingOn: waitingOn.map((x) => ({ taskId: x.taskId, observed: x.observed })) };
  }

  /**
   * An agent that cannot safely interrupt what it is doing says so (or says it can again): the room then shows `blocked` instead of `preparing`. Nothing is stopped, suspended or forced. The agent itself, or someone who runs the meeting.
   */
  async reportBlocked(by: Principal, command: NoActor & { occurrenceId: string; agent: string; blocked: boolean; reason?: string }): Promise<void> {
    onlyKnown(command, ["commandId", "occurrenceId", "agent", "blocked", "reason"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const agent = typeof command.agent === "string" ? command.agent : invalid("agent", "is not an agent principal");
    agentIdOf(agent);
    if (typeof command.blocked !== "boolean") invalid("blocked", "must be true or false");
    const reason = command.blocked ? plain(command.reason, "reason", ATTENDANCE_LIMITS.reason) : undefined;
    const room = await this.#roomFor(occurrenceId);
    const att = room === undefined ? undefined : await this.#attendance(occurrenceId, agent);
    if (room === undefined || att === undefined || !(this.#mayRun(by, room.body.projectId) || this.#isSelf(by, agent, room.body.projectId))) throw forbidden(by, "report on that attendance");
    if (att.body.state === "present" || att.body.state === "unavailable") throw new DomainError("invalid_command", `${agent} is ${att.body.state}`, { field: "agent" });
    const nowIso = this.#runner.now();
    await this.#update(by, "block", att.id, (b) => {
      const { reportedBlock: _r, ...rest } = b;
      void _r;
      return { ...rest, ...(command.blocked ? { reportedBlock: { reason: reason as string, at: nowIso } } : {}) };
    }, command.blocked ? "blocked" : "unblocked", reason);
  }

  /**
   * The agent joins at its safe boundary: every interrupted task must be paused and reported `paused`; otherwise nothing changes and the answer says what it is waiting on (or that it is blocked). On success a separate bounded meeting task is created and
   * assigned to the agent (the interrupted assignment, its owner, generation and background work are untouched), the join is recorded as a durable event, and, for a paused agent the owner invited by hand, a permission that lets only this task run. A late joiner
   * is welcome while the room is open. The agent itself or someone who runs the meeting; never Suspend, handoff or Force Stop.
   */
  async join(by: Principal, command: NoActor & { occurrenceId: string; agent: string }): Promise<{ joined: boolean; state: AttendanceState; meetingTaskId?: string; waitingOn: readonly { taskId: string; observed: string }[]; reason?: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "occurrenceId", "agent"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const agent = typeof command.agent === "string" ? command.agent : invalid("agent", "is not an agent principal");
    const agentId = agentIdOf(agent);
    const room = await this.#roomFor(occurrenceId);
    const first = room === undefined ? undefined : await this.#attendance(occurrenceId, agent);
    if (room === undefined || first === undefined || !(this.#mayRun(by, room.body.projectId) || this.#isSelf(by, agent, room.body.projectId))) throw forbidden(by, "join that meeting for that agent");
    if (first.body.state === "present") {
      // A join that was cut off before its warning was sent still gets it on the repeat (same key, filed once).
      if (first.body.meetingTaskId !== undefined) await this.#warn("begins", first.id, agent, occurrenceId, first.body.meetingTaskId);
      return { joined: true, state: "present", ...(first.body.meetingTaskId === undefined ? {} : { meetingTaskId: first.body.meetingTaskId }), waitingOn: [], replayed: true };
    }
    if (first.body.leftAt !== undefined) throw new DomainError("invalid_command", `${agent} has left that meeting`, { field: "agent" });
    if (room.body.state !== "open") throw new DomainError("invalid_command", `the room of meeting ${occurrenceId} has ended`, { field: "occurrenceId" });
    const attId = first.id;
    const occ = (await this.#runner.get("meeting-occurrence", occurrenceId))?.body as unknown as OccurrenceBody | undefined;
    if (occ === undefined || occ.state !== "planned") throw new DomainError("invalid_command", `meeting ${occurrenceId} is not waiting to be held`, { field: "occurrenceId" });
    // Reachability first: a paused agent attends only by the owner's invitation, a suspended or stopped one only once woken.
    const seat = occ.participants.find((p) => p.id === agent);
    const decided = await this.#redecide(first.body, occurrenceId, seat);
    if (decided.state === "unavailable") {
      await this.#update(by, "join", attId, (b) => ({ ...b, state: "unavailable", ...(decided.reason === undefined ? {} : { reason: decided.reason }), bounded: false }), "unavailable");
      return { joined: false, state: "unavailable", waitingOn: [], ...(decided.reason === undefined ? {} : { reason: decided.reason }), replayed: false };
    }
    if (first.body.prepared !== true) throw new DomainError("invalid_command", `prepare ${agent} first (with an empty list of tasks if it has nothing to leave)`, { field: "agent" });
    const waitingOn = await this.#waiting({ ...first.body, bounded: decided.bounded });
    const effective = this.#effective({ ...first.body, state: "preparing", bounded: decided.bounded }, waitingOn);
    if (effective.state !== "preparing" || waitingOn.length > 0) {
      await this.#update(by, "join", attId, (b) => ({ ...b, state: effective.state === "blocked" ? "blocked" : "preparing", bounded: decided.bounded, ...(effective.reason === undefined ? {} : { reason: effective.reason }) }), effective.state === "blocked" ? "blocked" : "preparing", effective.reason);
      return { joined: false, state: effective.state, waitingOn: waitingOn.map((x) => ({ taskId: x.taskId, observed: x.observed })), ...(effective.reason === undefined ? {} : { reason: effective.reason }), replayed: false };
    }
    // The bounded meeting task: derived IDs, so a repeat after a crash finds and finishes it.
    const taskCommand = `attend-task:${attId}`;
    const taskId = derivedId("task", taskCommand);
    const title = `Meeting: ${occ.title}`.slice(0, 200);
    // Each step is skipped when it is already done, and a loss to a concurrent join of the same attendance (another caller's identical step) is not an error when the step's result is there.
    const step = async (done: () => Promise<boolean>, run: () => Promise<unknown>): Promise<void> => {
      if (await done()) return;
      try { await run(); } catch (error) {
        if (!(error instanceof DomainError) || !(await done())) throw error;
      }
    };
    const stateIs = async (...states: string[]): Promise<boolean> => states.includes((await this.#runner.get("task", taskId))?.body !== undefined ? ((await this.#runner.get("task", taskId))!.body as unknown as TaskBody).state : "");
    await step(async () => (await this.#runner.get("task", taskId)) !== undefined, () => this.#projects.createTask({ commandId: taskCommand, actor: by.id, projectId: occ.projectId, title, description: `The bounded meeting task of ${agent} for meeting ${occurrenceId}. It ends with the meeting and does not replace or advance any other task of the agent.` }));
    await step(async () => !(await stateIs("proposed")), async () => this.#projects.transitionTask({ commandId: `attend-ready:${attId}`, actor: by.id, taskId, expectedRevision: (await this.#runner.get("task", taskId))!.revision, to: "ready" }));
    await step(async () => (await this.#runner.get("assignment", assignmentIdOf(taskId))) !== undefined, () => this.#assignments.assignTask({ commandId: `attend-assign:${attId}`, actor: by.id, taskId, owner: { kind: "agent", id: agentId }, reason: `attends meeting ${occurrenceId}` }));
    await step(async () => !(await stateIs("ready")), async () => this.#projects.transitionTask({ commandId: `attend-start:${attId}`, actor: by.id, taskId, expectedRevision: (await this.#runner.get("task", taskId))!.revision, to: "in_progress" }));
    const result = await this.#retrying(() => this.#runner.command("meeting.join", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { occurrenceId, agent, taskId },
      build: async () => {
        const cur = await this.#attendance(occurrenceId, agent);
        const rm = await this.#roomFor(occurrenceId);
        const occNow = await this.#runner.get("meeting-occurrence", occurrenceId);
        if (cur === undefined || rm === undefined || occNow === undefined) throw new DomainError("not_found", `meeting ${occurrenceId} does not exist`);
        const ref: AggregateRef = { kind: "meeting-attendance", id: cur.id };
        if (cur.body.state === "present") return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: cur.revision }], detail: { occurrenceId, again: true } };
        if (cur.body.leftAt !== undefined) throw new DomainError("invalid_command", `${agent} has left that meeting`, { field: "agent" });
        if (rm.body.state !== "open" || (occNow.body as unknown as OccurrenceBody).state !== "planned") throw new DomainError("invalid_command", `the room of meeting ${occurrenceId} has ended`, { field: "occurrenceId" });
        // Reachability and the owner's invitation are decided again inside the commit (the occurrence revision is checked with it), so a pause or an invitation landing after the early check is not missed.
        const seatNow = (occNow.body as unknown as OccurrenceBody).participants.find((p) => p.id === agent);
        const decidedNow = await this.#redecide(cur.body, occurrenceId, seatNow);
        if (decidedNow.state === "unavailable") throw new DomainError("invalid_command", `${agent} is unavailable: ${decidedNow.reason ?? "not reachable"}`, { field: "agent" });
        const nowIso = this.#runner.now();
        const late = rm.body.discussion !== undefined;
        const { reason: _r, reportedBlock: _b, ...rest } = cur.body;
        void _r; void _b;
        const body: AttendanceBody = {
          ...rest, state: "present", bounded: decidedNow.bounded, meetingTaskId: taskId, joinedAt: nowIso, ...(late ? { joinedLate: true } : {}),
          ...this.#event(cur.body, late ? "joined-late" : "joined", by.id, decidedNow.bounded ? "attends this meeting only; its other work stays paused" : undefined),
        };
        const changes: Change[] = [
          { type: "check", ref: { kind: "meeting-room", id: rm.id }, expectedRevision: rm.revision }, { type: "check", ref: { kind: "meeting-occurrence", id: occurrenceId }, expectedRevision: occNow.revision },
          { type: "update", ref, expectedRevision: cur.revision, body: clean(body) },
        ];
        if (decidedNow.bounded) {
          const exRef: AggregateRef = { kind: PAUSE_EXEMPTION_KIND, id: exemptionIdOf(taskId) };
          const had = await this.#runner.get(exRef.kind, exRef.id);
          // An ended permission is never made active again; a join can only create it.
          if (had !== undefined) throw new DomainError("invalid_command", `${agent} has already used its attendance permission`, { field: "agent" });
          const exemption: PauseExemptionBody = {
            taskId, agentId, occurrenceId, grantedBy: seatNow?.invitedBy ?? by.id, grantedAt: nowIso, state: "active", covers: decidedNow.covers ?? [],
            expiresAt: new Date(ms((occNow.body as unknown as OccurrenceBody).endsAt) + MEETING_LIMITS.graceMinutes * 60_000).toISOString(),
          };
          changes.push({ type: "create", ref: exRef, body: clean(exemption) });
        }
        return { ref, creates: false, changes, detail: { occurrenceId, agent, meetingTaskId: taskId, bounded: decidedNow.bounded, late } };
      },
    })));
    await this.#warn("begins", attId, agent, occurrenceId, taskId);
    return { joined: true, state: "present", meetingTaskId: taskId, waitingOn: [], replayed: result.replayed };
  }

  /** The owner takes part in the room (no pause, no task). The meeting never depends on it: a room runs without the owner, and the owner can come in late and read the state so far. */
  async joinAsOwner(by: Principal, command: NoActor & { occurrenceId: string }): Promise<{ replayed: boolean }> {
    onlyKnown(command, ["commandId", "occurrenceId"]);
    if (by.kind !== "owner" || by.taskScope !== undefined) throw forbidden(by, "join as the owner");
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const roomId = roomIdOf(occurrenceId);
    const result = await this.#retrying(() => this.#runner.command("meeting.join.owner", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { occurrenceId },
      build: async () => {
        const room = await this.#runner.get("meeting-room", roomId);
        const rb = room?.body as unknown as RoomBody | undefined;
        if (room === undefined || rb === undefined) throw new DomainError("not_found", `meeting ${occurrenceId} has no room`);
        if (rb.state !== "open") throw new DomainError("invalid_command", `the room of meeting ${occurrenceId} has ended`, { field: "occurrenceId" });
        const attId = attendanceIdOf(occurrenceId, by.id);
        const had = await this.#runner.get("meeting-attendance", attId);
        const nowIso = this.#runner.now();
        const late = rb.discussion !== undefined;
        const prior = had?.body as unknown as AttendanceBody | undefined;
        const base: AttendanceBody = prior ?? { occurrenceId, projectId: rb.projectId, who: by.id, isOwner: true, state: "preparing", bounded: false, interrupted: [], retain: [], returned: true, events: [], eventCount: 0 };
        const { leftAt: _l, reason: _r, ...kept } = base;
        void _l; void _r;
        const body: AttendanceBody = { ...kept, state: "present", joinedAt: nowIso, ...(late ? { joinedLate: true } : {}), ...this.#event(base, late ? "joined-late" : "joined", by.id) };
        const ref: AggregateRef = { kind: "meeting-attendance", id: attId };
        const roomRef: AggregateRef = { kind: "meeting-room", id: roomId };
        return {
          ref, creates: had === undefined,
          changes: [had === undefined ? { type: "create", ref, body: clean(body) } : { type: "update", ref, expectedRevision: had.revision, body: clean(body) }, { type: "update", ref: roomRef, expectedRevision: room.revision, body: clean({ ...rb, ownerAttendance: by.id }) }],
          detail: { occurrenceId, late },
        };
      },
    })));
    return { replayed: result.replayed };
  }

  /** The owner authorizes waking or recovering a suspended or stopped agent for this meeting (nothing else does). The wake sink (L02, L03) is asked once; the agent is `preparing` until it is reachable. Without a sink there is nothing to wake with and this is refused. */
  async authorizeWake(by: Principal, command: NoActor & { occurrenceId: string; agent: string }): Promise<void> {
    onlyKnown(command, ["commandId", "occurrenceId", "agent"]);
    if (by.kind !== "owner" || by.taskScope !== undefined) throw forbidden(by, "authorize waking an agent");
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const agent = typeof command.agent === "string" ? command.agent : invalid("agent", "is not an agent principal");
    agentIdOf(agent);
    const att = await this.#attendance(occurrenceId, agent);
    const room = att === undefined ? undefined : await this.#roomFor(occurrenceId);
    if (att === undefined || room === undefined) throw new DomainError("not_found", `${agent} is not in that meeting's room`);
    if (room.body.state !== "open") throw new DomainError("invalid_command", `the room of meeting ${occurrenceId} has ended`, { field: "occurrenceId" });
    if (this.#wake === undefined) throw new DomainError("invalid_command", "waking an agent is not available here: no wake path is composed", { field: "agent" });
    if (att.body.state === "present") return;
    const availability = await this.#reach(agent);
    if (availability !== "suspended" && availability !== "stopped") throw new DomainError("invalid_command", `${agent} is ${availability}; only a suspended or stopped agent needs the owner's wake`, { field: "agent" });
    await this.#wake.wake({ key: `${occurrenceId}:${agent}`, agent, occurrenceId, projectId: room.body.projectId });
    const nowIso = this.#runner.now();
    await this.#update(by, "wake", att.id, (b) => {
      const { reason: _r, ...rest } = b;
      void _r;
      return { ...rest, state: "preparing", wake: { by: by.id, at: nowIso } };
    }, "wake-authorized", availability);
  }

  /**
   * Re-reads the lifecycle for the participants that are not in the room: a resumed agent becomes `preparing`, an agent the owner has invited since becomes `preparing` (bounded), one paused or stopped since becomes `unavailable`. Nothing is woken or resumed.
   * Owner, host, service or `meeting.manage`.
   */
  async refresh(by: Principal, occurrenceId: string): Promise<void> {
    const id = this.#occurrenceId(occurrenceId);
    const room = await this.#roomFor(id);
    if (room === undefined || !this.#mayRun(by, room.body.projectId)) throw forbidden(by, "refresh that room");
    const occ = (await this.#runner.get("meeting-occurrence", id))?.body as unknown as OccurrenceBody | undefined;
    for (const w of room.body.roster) {
      const att = await this.#attendance(id, w);
      if (att === undefined || att.body.state === "present" || att.body.leftAt !== undefined) continue;
      const seat = occ?.participants.find((p) => p.id === w);
      const decided = await this.#redecide(att.body, id, seat);
      if (decided.state === att.body.state && decided.bounded === att.body.bounded && decided.reason === att.body.reason) continue;
      await this.#update(by, "refresh", att.id, (b) => {
        const { reason: _r, ...rest } = b;
        void _r;
        return { ...rest, state: decided.state === "preparing" && b.state === "blocked" ? "blocked" : decided.state, bounded: decided.bounded, ...(decided.reason === undefined ? {} : { reason: decided.reason }) };
      }, decided.state === "unavailable" ? "unavailable" : "preparing", decided.reason);
    }
  }

  // ---- leaving, ending, returning to work ----------------------------------------------------------------------------------------------------

  /** An agent (or the owner) leaves the meeting: its meeting task is finished and any bounded permission ends. The work it left is not resumed here: that is the return at the end of the meeting. The agent itself or someone who runs the meeting. */
  async leave(by: Principal, command: NoActor & { occurrenceId: string; agent: string }): Promise<void> {
    onlyKnown(command, ["commandId", "occurrenceId", "agent"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const agent = typeof command.agent === "string" ? command.agent : invalid("agent", "is not an agent principal");
    const room = await this.#roomFor(occurrenceId);
    const att = room === undefined ? undefined : await this.#attendance(occurrenceId, agent);
    const owner = att?.body.isOwner === true;
    if (room === undefined || att === undefined || !(this.#mayRun(by, room.body.projectId) || (owner ? by.kind === "owner" && by.id === agent : this.#isSelf(by, agent, room.body.projectId)))) throw forbidden(by, "make that participant leave");
    await this.#leave(by, att.id, "left");
  }

  async #leave(by: Principal, attId: string, kind: "left" | "left-at-end"): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const att = await this.#runner.get("meeting-attendance", attId);
      const body = att?.body as unknown as AttendanceBody | undefined;
      if (att === undefined || body === undefined) throw new DomainError("not_found", "that attendance does not exist");
      if (body.state !== "present" && body.joinedAt === undefined) {
        // Never in: nothing to finish. A pending preparation just stays as it is; the return policy still looks at the pauses it made.
        return;
      }
      if (body.leftAt !== undefined) { await this.#chargePresence(attId); return; }
      const taskId = body.meetingTaskId;
      if (taskId !== undefined) {
        const task = await this.#runner.get("task", taskId);
        if (task !== undefined && (task.body as unknown as TaskBody).state === "in_progress") await this.#projects.transitionTask({ commandId: `attend-done:${attId}`, actor: by.id, taskId, expectedRevision: task.revision, to: "done" });
      }
      try {
        await this.#runner.command("meeting.leave", { commandId: scopedCommandId(by.id, `leave:${attId}:${att.revision}`), actor: by.id }, async () => ({
          payload: { attendanceId: attId },
          build: async () => {
            const cur = await this.#runner.get("meeting-attendance", attId);
            const b = cur?.body as unknown as AttendanceBody | undefined;
            if (cur === undefined || b === undefined) throw new DomainError("not_found", "that attendance does not exist");
            const ref: AggregateRef = { kind: "meeting-attendance", id: attId };
            if (b.leftAt !== undefined) return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: cur.revision }], detail: { again: true } };
            const nowIso = this.#runner.now();
            const { reportedBlock: _rb, ...rest } = b;
            void _rb;
            const next: AttendanceBody = { ...rest, state: "unavailable", reason: "left the meeting", leftAt: nowIso, ...this.#event(b, kind, by.id) };
            const changes: Change[] = [{ type: "update", ref, expectedRevision: cur.revision, body: clean(next) }];
            if (b.meetingTaskId !== undefined) {
              const ex = await this.#runner.get(PAUSE_EXEMPTION_KIND, exemptionIdOf(b.meetingTaskId));
              const exb = ex?.body as unknown as PauseExemptionBody | undefined;
              if (ex !== undefined && exb !== undefined && exb.state === "active") changes.push({ type: "update", ref: { kind: PAUSE_EXEMPTION_KIND, id: ex.id }, expectedRevision: ex.revision, body: clean({ ...exb, state: "ended", endedAt: nowIso }) });
            }
            return { ref, creates: false, changes, detail: { occurrenceId: b.occurrenceId, who: b.who, kind } };
          },
        }));
        await this.#chargePresence(attId);
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= ATTENDANCE_LIMITS.retries) throw error;
      }
    }
  }

  /** The presence of one agent, charged once (the command ID is the attendance's): a leave that is repeated, or finished by the sweep, charges the same amount again as the same command. */
  async #chargePresence(attId: string): Promise<void> {
    if (this.#charge === undefined) return;
    try {
      const body = (await this.#runner.get("meeting-attendance", attId))?.body as unknown as AttendanceBody | undefined;
      if (body?.joinedAt === undefined || body.leftAt === undefined) return;
      const room = await this.#roomFor(body.occurrenceId);
      // Only an agent has a budget: the owner's presence ("owner:...") is charged to nobody.
      if (room === undefined || !body.who.startsWith("agent:")) return;
      const computeMs = Math.max(0, ms(body.leftAt) - ms(body.joinedAt));
      await this.#charge({ commandId: `att-use:${attId}`, projectId: room.body.projectId, agentId: body.who, computeMs, ...(body.meetingTaskId === undefined ? {} : { taskId: body.meetingTaskId }) });
    } catch (error) {
      this.#onChargeError?.(error);
    }
  }

  /** The owner (or someone who may pause the task) asks that an interrupted task stay paused after the meeting: the return will not resume it. L01 refuses a second pause on a gate that is already paused, so this is how a pause requested during the meeting is kept. */
  async keepPaused(by: Principal, command: NoActor & { occurrenceId: string; agent: string; taskId: string }): Promise<void> {
    onlyKnown(command, ["commandId", "occurrenceId", "agent", "taskId"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const agent = typeof command.agent === "string" ? command.agent : invalid("agent", "is not an agent principal");
    const taskId = checkTaskId(command.taskId);
    const att = await this.#attendance(occurrenceId, agent);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (att === undefined || task === undefined || !this.#mayControlTask(by, taskId, task.projectId)) throw forbidden(by, "keep that task paused");
    if (!att.body.interrupted.some((x) => x.taskId === taskId)) throw new DomainError("invalid_command", `${taskId} was not interrupted for that meeting`, { field: "taskId" });
    await this.#update(by, "keep", att.id, (b) => (b.retain.includes(taskId) ? b : { ...b, retain: [...b.retain, taskId] }), "keep-paused", taskId);
  }

  /**
   * A new priority defers the return of one interrupted task without moving its assignment: it stays paused (by this attendance) until the given time, when the return runs again. Bounded (14 days). Owner, host, service, or whoever may pause that task.
   */
  async deferReturn(by: Principal, command: NoActor & { occurrenceId: string; agent: string; taskId: string; minutes: number; reason: string }): Promise<{ until: string }> {
    onlyKnown(command, ["commandId", "occurrenceId", "agent", "taskId", "minutes", "reason"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const agent = typeof command.agent === "string" ? command.agent : invalid("agent", "is not an agent principal");
    const taskId = checkTaskId(command.taskId);
    const minutes = whole(command.minutes, "minutes", 1, ATTENDANCE_LIMITS.deferMax);
    const reason = plain(command.reason, "reason", ATTENDANCE_LIMITS.reason);
    const att = await this.#attendance(occurrenceId, agent);
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (att === undefined || task === undefined || !(staff(by) || this.#mayControlTask(by, taskId, task.projectId))) throw forbidden(by, "defer the return of that task");
    const item = att.body.interrupted.find((x) => x.taskId === taskId);
    if (item === undefined || item.outcome === "resumed" || item.outcome === "kept" || item.outcome === "ownership-changed") throw new DomainError("invalid_command", `${taskId} has no waiting return for that meeting`, { field: "taskId" });
    const until = new Date(ms(this.#runner.now()) + minutes * 60_000).toISOString();
    await this.#update(by, "defer", att.id, (b) => ({ ...b, plan: { superseded: b.plan?.superseded ?? [], decisions: b.plan?.decisions ?? [], defer: [...(b.plan?.defer ?? []).filter((d) => d.taskId !== taskId), { taskId, until, reason }] } }), "return-deferred", `${taskId} until ${until}`);
    return { until };
  }

  /**
   * Ends the meeting: the room closes (no one joins after this), whoever is present leaves, the occurrence is settled as held (M01), the decisions are applied to the return (agents whose tasks they supersede revalidate; a new priority defers a return; absent
   * affected agents get a durable notice) and every attendee is returned to work under the room's policy. Owner, host or service (M01's rule for marking a meeting held). Repeating it finishes whatever a crash left undone.
   */
  async endMeeting(by: Principal, command: NoActor & { occurrenceId: string; decisions?: readonly MeetingDecision[]; revalidateWithinMinutes?: number }): Promise<{
    left: readonly string[]; returned: readonly { who: string; outcomes: readonly { taskId: string; outcome: ReturnKind; detail?: string }[] }[]; notified: readonly string[]; unnotified: readonly string[]; revalidating: readonly string[];
  }> {
    onlyKnown(command, ["commandId", "occurrenceId", "decisions", "revalidateWithinMinutes"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    if (!staff(by)) throw forbidden(by, "end a meeting");
    const within = command.revalidateWithinMinutes === undefined ? ATTENDANCE_LIMITS.revalidateDefault : whole(command.revalidateWithinMinutes, "revalidateWithinMinutes", 1, ATTENDANCE_LIMITS.revalidateMax);
    const decisions = await this.#decisions(command.decisions ?? []);
    if ((await this.#roomFor(occurrenceId)) === undefined) throw forbidden(by, "end that meeting");
    const occ = (await this.#runner.get("meeting-occurrence", occurrenceId))?.body as unknown as OccurrenceBody | undefined;
    if (occ === undefined || (occ.state !== "planned" && occ.state !== "held")) throw new DomainError("invalid_command", `meeting ${occurrenceId} is ${occ?.state ?? "unknown"}`, { field: "occurrenceId" });
    return this.#end(by, occurrenceId, decisions, within, true);
  }

  /** The end of a room, by `endMeeting` (the meeting was held: `settle`) or by the sweep (the meeting lapsed: the occurrence is left to M01). Every step is idempotent. */
  async #end(by: Principal, occurrenceId: string, decisions: readonly MeetingDecision[], within: number, settle: boolean): Promise<{
    left: readonly string[]; returned: readonly { who: string; outcomes: readonly { taskId: string; outcome: ReturnKind; detail?: string }[] }[]; notified: readonly string[]; unnotified: readonly string[]; revalidating: readonly string[];
  }> {
    const room = (await this.#roomFor(occurrenceId))!;
    const occ = (await this.#runner.get("meeting-occurrence", occurrenceId))?.body as unknown as OccurrenceBody | undefined;
    // 1. Close the room first, so a join racing the end either lands before (and leaves below) or is refused.
    await this.#retrying(() => this.#runner.command("meeting.room.end", { commandId: scopedCommandId(by.id, `end:${occurrenceId}`), actor: by.id }, async () => ({
      payload: { occurrenceId },
      build: async () => {
        const cur = await this.#roomFor(occurrenceId);
        if (cur === undefined) throw new DomainError("not_found", `meeting ${occurrenceId} has no room`);
        const ref: AggregateRef = { kind: "meeting-room", id: cur.id };
        if (cur.body.state === "ended") return { ref, creates: false, changes: [{ type: "check", ref, expectedRevision: cur.revision }], detail: { occurrenceId, again: true } };
        // The room leaves the open list in the same commit.
        const open = await this.#runner.get("meeting-room-open", ROOMS);
        const ids = ((open?.body as unknown as PendingBody | undefined)?.ids ?? []).filter((x) => x !== occurrenceId);
        const listRef: AggregateRef = { kind: "meeting-room-open", id: ROOMS };
        const changes: Change[] = [{ type: "update", ref, expectedRevision: cur.revision, body: clean({ ...cur.body, state: "ended", endedAt: this.#runner.now(), endedBy: by.id }) }];
        if (open !== undefined) changes.push({ type: "update", ref: listRef, expectedRevision: open.revision, body: { ids } as unknown as JsonObject });
        return { ref, creates: false, changes, detail: { occurrenceId, settle } };
      },
    })));
    // 2. Everyone present leaves (their meeting tasks finish, bounded permissions end).
    const left: string[] = [];
    const everyone = [...room.body.roster, ...(room.body.ownerAttendance === undefined ? [] : [room.body.ownerAttendance])];
    for (const w of everyone) {
      const att = await this.#attendance(occurrenceId, w);
      if (att !== undefined && att.body.joinedAt !== undefined && att.body.leftAt === undefined) { await this.#leave(by, att.id, "left-at-end"); left.push(w); }
    }
    // 3. The occurrence is held (M01 defers the agenda items the meeting did not reach).
    if (settle && occ?.state === "planned") {
      try { await this.#meetings.settle(by, { commandId: `end-held:${occurrenceId}`, occurrenceId, outcome: "held" }); } catch (error) {
        // A concurrent end settled it first.
        if ((await this.#runner.get("meeting-occurrence", occurrenceId))?.body === undefined || ((await this.#runner.get("meeting-occurrence", occurrenceId))!.body as unknown as OccurrenceBody).state !== "held") throw error;
      }
    }
    // 4. Decisions: plans for the attendees and the revalidation requirement for everyone affected. Notices come last: a sink that fails must not keep anyone from returning to work.
    const dueAt = new Date(ms(this.#runner.now()) + within * 60_000).toISOString();
    const applied = await this.#applyDecisions(by, occurrenceId, room.body, decisions, dueAt);
    // 5. Return each attendee to work.
    const returned: { who: string; outcomes: { taskId: string; outcome: ReturnKind; detail?: string }[] }[] = [];
    for (const w of room.body.roster) {
      const att = await this.#attendance(occurrenceId, w);
      if (att === undefined) continue;
      returned.push({ who: w, outcomes: await this.#return(by, occurrenceId, w) });
    }
    // 6. Notices for the absent affected agents (recorded as unnotified, and retried by the sweep, when they cannot be sent).
    const sent = await this.#sendNotices(by, occurrenceId, room.body.projectId, applied.absent);
    return { left, returned, notified: sent.notified, unnotified: sent.unnotified, revalidating: applied.revalidating };
  }

  /**
   * Returns one attendee to work (also run for each attendee by `endMeeting`, and again for the waiting ones by `sweepReturns`). For each interrupted task: a pause this attendance made is resumed; one that predated the meeting, was requested during it
   * (`keepPaused`) or was replaced by another request is kept; an assignment that is no longer the agent's at the same generation is not returned to it (the attendance pause is lifted, nothing is moved); a task a decision supersedes waits for the
   * agent's acknowledgement; a deferred one waits for its time. Only the task-level pause this meeting made is ever lifted, so agent, team and installation pauses, suspensions and stops all stay. Needs `meeting.manage` (or the owner, host or service) and L01's authority to resume.
   */
  async returnToWork(by: Principal, command: NoActor & { occurrenceId: string; agent: string }): Promise<readonly { taskId: string; outcome: ReturnKind; detail?: string }[]> {
    onlyKnown(command, ["commandId", "occurrenceId", "agent"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const agent = typeof command.agent === "string" ? command.agent : invalid("agent", "is not an agent principal");
    agentIdOf(agent);
    const room = await this.#roomFor(occurrenceId);
    if (room === undefined || !this.#mayRun(by, room.body.projectId)) throw forbidden(by, "return that agent to work");
    const att = await this.#attendance(occurrenceId, agent);
    if (att === undefined) throw new DomainError("not_found", `${agent} is not in that meeting's room`);
    if (att.body.state === "present" && att.body.leftAt === undefined) throw new DomainError("invalid_command", `${agent} is still in the meeting; it returns to work when it leaves or the meeting ends`, { field: "agent" });
    return this.#return(by, occurrenceId, agent);
  }

  /** Sends one warning of the quick-answer period, once per attendance and phase; a failure is dropped (the warning is a courtesy, the controller enforces the limit itself). */
  async #warn(phase: "ahead" | "begins" | "ends", attId: string, agent: string, occurrenceId: string, taskId: string): Promise<void> {
    if (this.#window === undefined) return;
    try { await this.#window.notify({ key: `${attId}:${phase}`, phase, agent, occurrenceId, taskId }); } catch { /* best effort */ }
  }

  async #return(by: Principal, occurrenceId: string, agent: string): Promise<{ taskId: string; outcome: ReturnKind; detail?: string }[]> {
    const attId = attendanceIdOf(occurrenceId, agent);
    const agentId = agentIdOf(agent);
    const out: { taskId: string; outcome: ReturnKind; detail?: string }[] = [];
    const nowMs = ms(this.#runner.now());
    const att0 = await this.#runner.get("meeting-attendance", attId);
    const items = (att0?.body as unknown as AttendanceBody | undefined)?.interrupted ?? [];
    for (const item of items) {
      const fresh = (await this.#attendance(occurrenceId, agent))!;
      const it = fresh.body.interrupted.find((x) => x.taskId === item.taskId)!;
      if (it.outcome === "resumed" || it.outcome === "kept" || it.outcome === "ownership-changed") { out.push({ taskId: it.taskId, outcome: it.outcome, ...(it.outcomeDetail === undefined ? {} : { detail: it.outcomeDetail }) }); continue; }
      const scope: PauseScope = { kind: "task", id: it.taskId };
      const gate = (await this.#runner.get("pause-gate", PauseService.gateIdOf(scope)))?.body as unknown as PauseGateBody | undefined;
      const set = async (outcome: ReturnKind, detail: string | undefined, extra: Partial<InterruptedWork> = {}): Promise<void> => {
        if (outcome === "deferred" || outcome === "revalidating") {
          // A waiting return must be listed for the sweep to find it: refuse before writing the outcome when the list is full, so no attendance is left waiting and unlisted.
          const listed = ((await this.#runner.get("meeting-return-pending", PENDING))?.body as unknown as PendingBody | undefined)?.ids ?? [];
          if (!listed.includes(attId) && listed.length >= ATTENDANCE_LIMITS.pending) throw new DomainError("unavailable", `${ATTENDANCE_LIMITS.pending} returns are already waiting; settle some first`);
        }
        const nowIso = this.#runner.now();
        await this.#update(by, "return", attId, (b) => {
          const interrupted = b.interrupted.map((x) => (x.taskId === it.taskId ? clean({ ...x, outcome, outcomeAt: nowIso, ...(detail === undefined ? {} : { outcomeDetail: detail }), ...extra }) as unknown as InterruptedWork : x));
          const settled = interrupted.every((x) => x.outcome === "resumed" || x.outcome === "kept" || x.outcome === "ownership-changed");
          return { ...b, interrupted, returned: settled, ...this.#event(b, `return-${outcome}`, by.id, `${it.taskId}${detail === undefined ? "" : `: ${detail}`}`) };
        }, undefined, undefined, true);
        out.push({ taskId: it.taskId, outcome, ...(detail === undefined ? {} : { detail }) });
      };
      // Kept: not ours to lift.
      if (!it.pausedByUs) { await set("kept", "paused-before-meeting" satisfies KeptReason); continue; }
      if (fresh.body.retain.includes(it.taskId)) { await set("kept", "requested-during-meeting" satisfies KeptReason); continue; }
      if (gate === undefined || gate.intent !== "pause") { await set("kept", "already-resumed" satisfies KeptReason); continue; }
      if (gate.requestId !== it.pauseRequestId) { await set("kept", "pause-replaced" satisfies KeptReason); continue; }
      // Deferred by a new priority: the pause stays, the assignment is not moved, and the time to look again is recorded.
      const deferral = fresh.body.plan?.defer.find((d) => d.taskId === it.taskId);
      if (deferral !== undefined && ms(deferral.until) > nowMs) { await set("deferred", deferral.reason, { deferUntil: deferral.until }); continue; }
      // Ownership as at preparation: the same agent, the same generation.
      const asg = (await this.#runner.get("assignment", assignmentIdOf(it.taskId)))?.body as unknown as AssignmentBody | undefined;
      const same = asg !== undefined && asg.state === "assigned" && asg.owner?.kind === "agent" && asg.owner.id === agentId && asg.generation === it.generation;
      // A superseding decision: the agent revalidates before its pause is lifted.
      if (same && (fresh.body.plan?.superseded ?? []).includes(it.taskId) && (await this.#awaitsRevalidation(agent, occurrenceId))) { await set("revalidating", "a decision of the meeting supersedes this task's plan; the agent revalidates before it continues"); continue; }
      let stillPausedBy: PauseScope[] = [];
      try {
        const resumed = await this.#pauses.resume(by, { commandId: `attend-resume:${attId}:${it.taskId}`, scope, reason: `meeting ${occurrenceId} ended; the pause it made for attendance is lifted` });
        stillPausedBy = [...resumed.stillPausedBy];
      } catch (error) {
        // Another resume got there first (same effect), or the pause is not ours any more: look again.
        if (!(error instanceof DomainError) || error.code !== "invalid_command") throw error;
        const again = (await this.#runner.get("pause-gate", PauseService.gateIdOf(scope)))?.body as unknown as PauseGateBody | undefined;
        if (again !== undefined && again.intent === "pause") throw error;
        stillPausedBy = (await this.#gateScopes(it.taskId)).filter((s) => !sameScope(s, scope));
      }
      const availability = await this.#reach(agent);
      const note = availability === "suspended" || availability === "stopped" ? `the agent is ${availability} and stays ${availability}` : undefined;
      if (!same) await set("ownership-changed", "the assignment is no longer this agent's at the generation it had; the attendance pause is lifted and nothing was moved", { stillPausedBy });
      else await set("resumed", note, { stillPausedBy });
    }
    if (items.length === 0) await this.#update(by, "returned", attId, (b) => (b.returned ? b : { ...b, returned: true }), "returned");
    const was = att0?.body as unknown as AttendanceBody | undefined;
    if (was?.meetingTaskId !== undefined) await this.#warn("ends", attId, agent, occurrenceId, was.meetingTaskId);
    // Waiting returns are listed so the sweep finds them; settled ones leave the list.
    await this.#syncPending(by, attId);
    return out;
  }

  async #awaitsRevalidation(agent: string, occurrenceId: string): Promise<boolean> {
    const rec = (await this.#runner.get("meeting-revalidation", agent))?.body as unknown as RevalidationBody | undefined;
    return rec?.entries.some((e) => e.occurrenceIds.includes(occurrenceId)) ?? false;
  }

  /**
   * The lease on a room: a room whose meeting was never ended is ended once its meeting is over for good (settled some other way, cancelled or missed) or its end plus M01's grace has passed, so the pauses made for attendance cannot be held for ever. It is
   * ended as a lapsed meeting: everyone leaves, no decisions are applied, the occurrence is left to M01 (which marks a meeting nobody held `missed`), and each attendee is returned under the usual rules. Then the waiting returns are run again: deferred ones whose time
   * has come, and revalidating ones whose agent has acknowledged. Owner, host or service. Reads the open-room list (200 at most) and the pending list (200 at most); `remaining` is what still waits.
   */
  async sweepReturns(by: Principal): Promise<{ checked: number; remaining: number; endedRooms: readonly string[]; unnotified: number }> {
    if (!staff(by)) throw forbidden(by, "run the return sweep");
    const endedRooms: string[] = [];
    const nowMs = ms(this.#runner.now());
    for (const occurrenceId of (((await this.#runner.get("meeting-room-open", ROOMS))?.body as unknown as PendingBody | undefined)?.ids ?? [])) {
      const occ = (await this.#runner.get("meeting-occurrence", occurrenceId))?.body as unknown as OccurrenceBody | undefined;
      const lapsed = occ === undefined || occ.state !== "planned" || nowMs >= ms(occ.endsAt) + MEETING_LIMITS.graceMinutes * 60_000;
      if (!lapsed) continue;
      await this.#end(by, occurrenceId, [], ATTENDANCE_LIMITS.revalidateDefault, false);
      endedRooms.push(occurrenceId);
    }
    const pending = (await this.#runner.get("meeting-return-pending", PENDING))?.body as unknown as PendingBody | undefined;
    let checked = 0;
    for (const attId of pending?.ids ?? []) {
      const att = (await this.#runner.get("meeting-attendance", attId))?.body as unknown as AttendanceBody | undefined;
      if (att === undefined) continue;
      checked++;
      await this.#return(by, att.occurrenceId, att.who);
    }
    const after = (await this.#runner.get("meeting-return-pending", PENDING))?.body as unknown as PendingBody | undefined;
    return { checked, remaining: after?.ids.length ?? 0, endedRooms, unnotified: await this.#retryNotices(by) };
  }

  /** The attendances whose return is waiting (deferred, or revalidating). */
  async pendingReturns(by: Principal): Promise<readonly string[]> {
    if (!staff(by)) throw forbidden(by, "list pending returns");
    return ((await this.#runner.get("meeting-return-pending", PENDING))?.body as unknown as PendingBody | undefined)?.ids ?? [];
  }

  // ---- decisions, revalidation, notices ------------------------------------------------------------------------------------------------------

  async #decisions(value: readonly MeetingDecision[]): Promise<MeetingDecision[]> {
    if (!Array.isArray(value) || value.length > ATTENDANCE_LIMITS.decisions) invalid("decisions", `must be a list of at most ${ATTENDANCE_LIMITS.decisions} decisions`);
    const out: MeetingDecision[] = [];
    let total = 0;
    for (const [i, d] of value.entries()) {
      if (d === null || typeof d !== "object" || Array.isArray(d)) invalid(`decisions[${i}]`, "must be an object");
      onlyKnown(d, ["ref", "summary", "supersedes", "defers", "deferMinutes"]);
      const ref = plain(d.ref, `decisions[${i}].ref`, 200);
      const supersedes = d.supersedes === undefined ? undefined : this.#taskList(d.supersedes, `decisions[${i}].supersedes`, ATTENDANCE_LIMITS.decisionTasks);
      const defers = d.defers === undefined ? undefined : this.#taskList(d.defers, `decisions[${i}].defers`, ATTENDANCE_LIMITS.decisionTasks);
      if (defers !== undefined && defers.length > 0 && d.deferMinutes === undefined) invalid(`decisions[${i}].deferMinutes`, "a deferral needs a time limit");
      const deferMinutes = d.deferMinutes === undefined ? undefined : whole(d.deferMinutes, `decisions[${i}].deferMinutes`, 1, ATTENDANCE_LIMITS.deferMax);
      total += (supersedes?.length ?? 0) + (defers?.length ?? 0);
      for (const t of [...(supersedes ?? []), ...(defers ?? [])]) if ((await this.#runner.get("task", t)) === undefined) invalid(`decisions[${i}]`, `${t} is not a task`);
      out.push({ ref, ...(d.summary === undefined ? {} : { summary: plain(d.summary, `decisions[${i}].summary`, 300) }), ...(supersedes === undefined ? {} : { supersedes }), ...(defers === undefined ? {} : { defers }), ...(deferMinutes === undefined ? {} : { deferMinutes }) });
    }
    if (total > ATTENDANCE_LIMITS.affectedTasks) invalid("decisions", `name at most ${ATTENDANCE_LIMITS.affectedTasks} tasks in all`);
    return out;
  }

  /** Writes the return plan of each attendee, a revalidation entry for each affected agent (attendee or not), and sends the notice to the absent ones. Each step is idempotent. */
  async #applyDecisions(by: Principal, occurrenceId: string, room: RoomBody, decisions: readonly MeetingDecision[], dueAt: string): Promise<{ absent: { agent: string; taskIds: readonly string[]; decisions: readonly string[]; dueAt: string }[]; revalidating: string[] }> {
    const byAgent = new Map<string, { tasks: Set<string>; refs: Set<string> }>();
    const nowMs = ms(this.#runner.now());
    const deferByTask = new Map<string, { until: string; reason: string; ref: string }>();
    for (const d of decisions) {
      for (const t of d.supersedes ?? []) {
        const asg = (await this.#runner.get("assignment", assignmentIdOf(t)))?.body as unknown as AssignmentBody | undefined;
        if (asg === undefined || asg.state !== "assigned" || asg.owner?.kind !== "agent") continue;
        const key = `agent:${asg.owner.id}`;
        const e = byAgent.get(key) ?? { tasks: new Set<string>(), refs: new Set<string>() };
        e.tasks.add(t); e.refs.add(d.ref);
        byAgent.set(key, e);
      }
      for (const t of d.defers ?? []) deferByTask.set(t, { until: new Date(nowMs + (d.deferMinutes as number) * 60_000).toISOString(), reason: `a new priority (${d.ref}) defers the return`, ref: d.ref });
    }
    // Plans for attendees (tasks they were interrupted from).
    for (const w of room.roster) {
      const att = await this.#attendance(occurrenceId, w);
      if (att === undefined || att.body.interrupted.length === 0) continue;
      const mine = new Set(att.body.interrupted.map((x) => x.taskId));
      const superseded = [...(byAgent.get(w)?.tasks ?? [])].filter((t) => mine.has(t));
      const defer = [...deferByTask].filter(([t]) => mine.has(t)).map(([taskId, d]) => ({ taskId, until: d.until, reason: d.reason }));
      const refs = decisions.map((d) => d.ref);
      if (superseded.length === 0 && defer.length === 0) continue;
      // Merged into any plan already there: a deferral time set once never slides when the end is repeated, and a repeat changes nothing.
      await this.#update(by, "plan", att.id, (b) => {
        const p = b.plan ?? { superseded: [], defer: [], decisions: [] };
        const sup = [...new Set([...p.superseded, ...superseded])];
        const def = [...p.defer, ...defer.filter((d) => !p.defer.some((x) => x.taskId === d.taskId))];
        const dec = [...new Set([...p.decisions, ...refs])].slice(0, 25);
        return sup.length === p.superseded.length && def.length === p.defer.length && dec.length === p.decisions.length ? b : { ...b, plan: { superseded: sup, defer: def, decisions: dec } };
      }, "return-planned", refs.join(", "));
    }
    const absent: { agent: string; taskIds: readonly string[]; decisions: readonly string[]; dueAt: string }[] = [];
    const revalidating: string[] = [];
    for (const [agent, e] of byAgent) {
      const attended = (await this.#attendance(occurrenceId, agent))?.body.joinedAt !== undefined;
      const entry: RevalidationEntry = { occurrenceIds: [occurrenceId], projectId: room.projectId, taskIds: [...e.tasks].sort(), decisions: [...e.refs].sort(), createdAt: this.#runner.now(), dueAt, attended };
      await this.#addRevalidation(by, agent, entry);
      revalidating.push(agent);
      if (!attended) absent.push({ agent, taskIds: entry.taskIds, decisions: entry.decisions, dueAt });
    }
    return { absent, revalidating };
  }

  /** Sends the notices not yet sent. A failure, or no sink composed, leaves the agent in the unnotified list (the sweep retries) and in the result; it never stops anything else. */
  async #sendNotices(by: Principal, occurrenceId: string, projectId: string, absent: readonly { agent: string; taskIds: readonly string[]; decisions: readonly string[]; dueAt: string }[]): Promise<{ notified: string[]; unnotified: string[] }> {
    const notified: string[] = [];
    const unnotified: string[] = [];
    for (const n of absent) {
      const rec = (await this.#runner.get("meeting-revalidation", n.agent))?.body as unknown as RevalidationBody | undefined;
      const entry = rec?.entries.find((e) => e.occurrenceIds.includes(occurrenceId));
      if (entry?.notifiedAt !== undefined) { notified.push(n.agent); continue; }
      if (await this.#deliver(by, occurrenceId, projectId, n)) notified.push(n.agent);
      else { unnotified.push(n.agent); await this.#noticeListed(by, `${occurrenceId}|${n.agent}`, true); }
    }
    return { notified, unnotified };
  }

  async #deliver(by: Principal, occurrenceId: string, projectId: string, n: { agent: string; taskIds: readonly string[]; decisions: readonly string[]; dueAt: string }): Promise<boolean> {
    if (this.#notices === undefined) return false;
    try { await this.#notices.notify({ key: `${occurrenceId}:${n.agent}`, agent: n.agent, occurrenceId, projectId, decisions: n.decisions, taskIds: n.taskIds, dueAt: n.dueAt }); } catch { return false; }
    await this.#markNotified(by, n.agent, occurrenceId);
    await this.#noticeListed(by, `${occurrenceId}|${n.agent}`, false);
    return true;
  }

  /** The list of notices not yet sent (200 at most; beyond that the requirement itself, which shows `notifiedAt` absent, is the record). */
  async #noticeListed(by: Principal, key: string, add: boolean): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get("meeting-notice-pending", PENDING);
      const ids = (found?.body as unknown as PendingBody | undefined)?.ids ?? [];
      if (ids.includes(key) === add || (add && ids.length >= ATTENDANCE_LIMITS.pending)) return;
      const next = add ? [...ids, key] : ids.filter((x) => x !== key);
      const ref: AggregateRef = { kind: "meeting-notice-pending", id: PENDING };
      try {
        await this.#runner.command("meeting.notice.pending", { commandId: scopedCommandId(by.id, `notice-list:${key}:${found?.revision ?? 0}:${add ? "add" : "remove"}`), actor: by.id }, async () => ({
          payload: { key, add },
          build: async () => ({ ref, creates: found === undefined, changes: [found === undefined ? { type: "create", ref, body: { ids: next } as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: { ids: next } as unknown as JsonObject }], detail: { key, add } }),
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= ATTENDANCE_LIMITS.retries) throw error;
      }
    }
  }

  /** Retries the unsent notices; one whose requirement was acknowledged meanwhile, or already sent, is dropped from the list. Returns how many still wait. */
  async #retryNotices(by: Principal): Promise<number> {
    const ids = ((await this.#runner.get("meeting-notice-pending", PENDING))?.body as unknown as PendingBody | undefined)?.ids ?? [];
    let waiting = 0;
    for (const key of ids) {
      const [occurrenceId, agent] = key.split("|") as [string, string];
      const rec = (await this.#runner.get("meeting-revalidation", agent))?.body as unknown as RevalidationBody | undefined;
      const entry = rec?.entries.find((e) => e.occurrenceIds.includes(occurrenceId));
      if (entry === undefined || entry.notifiedAt !== undefined) { await this.#noticeListed(by, key, false); continue; }
      if (!(await this.#deliver(by, occurrenceId, entry.projectId, { agent, taskIds: entry.taskIds, decisions: entry.decisions, dueAt: entry.dueAt }))) waiting++;
    }
    return waiting;
  }

  async #addRevalidation(by: Principal, agent: string, entry: RevalidationEntry): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get("meeting-revalidation", agent);
      const body = found?.body as unknown as RevalidationBody | undefined;
      if (body?.entries.some((x) => x.occurrenceIds.includes(entry.occurrenceIds[0] as string))) return;
      const entries = [...(body?.entries ?? [])];
      if (entries.length >= ATTENDANCE_LIMITS.revalidationEntries) {
        // Full: fold into the newest entry (nothing is dropped; if it no longer fits, every task of the agent is held for revalidation).
        const last = entries.pop() as RevalidationEntry;
        const ids = [...last.occurrenceIds, ...entry.occurrenceIds];
        const tasks = [...new Set([...last.taskIds, ...entry.taskIds])];
        const overflow = ids.length > ATTENDANCE_LIMITS.revalidationOccurrences || tasks.length > ATTENDANCE_LIMITS.revalidationTasks;
        entries.push({
          ...last, occurrenceIds: ids.slice(-ATTENDANCE_LIMITS.revalidationOccurrences), taskIds: tasks.slice(0, ATTENDANCE_LIMITS.revalidationTasks), decisions: [...new Set([...last.decisions, ...entry.decisions])].slice(0, 25),
          dueAt: last.dueAt < entry.dueAt ? last.dueAt : entry.dueAt, attended: last.attended && entry.attended, ...(overflow || last.allTasks === true ? { allTasks: true } : {}),
        });
      } else entries.push(entry);
      const ref: AggregateRef = { kind: "meeting-revalidation", id: agent };
      try {
        await this.#runner.command("meeting.revalidation.add", { commandId: scopedCommandId(by.id, `reval:${entry.occurrenceIds[0]}:${agent}:${found?.revision ?? 0}`), actor: by.id }, async () => ({
          payload: { agent, occurrenceId: entry.occurrenceIds[0] as string },
          build: async () => ({ ref, creates: found === undefined, changes: [found === undefined ? { type: "create", ref, body: clean({ agent, entries }) } : { type: "update", ref, expectedRevision: found.revision, body: clean({ agent, entries }) }], detail: { agent, occurrenceId: entry.occurrenceIds[0] as string, tasks: entry.taskIds.length } }),
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= ATTENDANCE_LIMITS.retries) throw error;
      }
    }
  }

  async #markNotified(by: Principal, agent: string, occurrenceId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get("meeting-revalidation", agent);
      const body = found?.body as unknown as RevalidationBody | undefined;
      if (found === undefined || body === undefined) return;
      if (!body.entries.some((x) => x.occurrenceIds.includes(occurrenceId) && x.notifiedAt === undefined)) return;
      const nowIso = this.#runner.now();
      const entries = body.entries.map((x) => (x.occurrenceIds.includes(occurrenceId) && x.notifiedAt === undefined ? { ...x, notifiedAt: nowIso } : x));
      const ref: AggregateRef = { kind: "meeting-revalidation", id: agent };
      try {
        await this.#runner.command("meeting.revalidation.notified", { commandId: scopedCommandId(by.id, `reval-sent:${occurrenceId}:${agent}:${found.revision}`), actor: by.id }, async () => ({
          payload: { agent, occurrenceId },
          build: async () => ({ ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean({ ...body, entries }) }], detail: { agent, occurrenceId } }),
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= ATTENDANCE_LIMITS.retries) throw error;
      }
    }
  }

  /**
   * What a meeting's decisions require of this task's agent before it continues: the entries not yet acknowledged. A dispatcher asks before it starts the agent's next action (wiring is the composer's, like L01's guards). The owner, host or service,
   * the agent itself, or a holder of `assignment.read` on the task.
   */
  async revalidation(by: Principal, taskId: string): Promise<{ required: boolean; entries: readonly (RevalidationEntry & { overdue: boolean })[] } | undefined> {
    const id = checkTaskId(taskId);
    const task = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
    const asg = (await this.#runner.get("assignment", assignmentIdOf(id)))?.body as unknown as AssignmentBody | undefined;
    if (task === undefined) return undefined;
    const agent = asg?.state === "assigned" && asg.owner?.kind === "agent" ? `agent:${asg.owner.id}` : undefined;
    const may = staff(by) || (agent !== undefined && by.id === agent && inTaskScope(by, task.projectId)) || allows(by, "assignment.read", task.projectId, { resource: { kind: "task", id } });
    if (!may) return undefined;
    if (agent === undefined) return { required: false, entries: [] };
    const rec = (await this.#runner.get("meeting-revalidation", agent))?.body as unknown as RevalidationBody | undefined;
    const nowMs = ms(this.#runner.now());
    const entries = (rec?.entries ?? []).filter((e) => e.allTasks === true || e.taskIds.includes(id)).map((e) => ({ ...e, overdue: ms(e.dueAt) <= nowMs }));
    return { required: entries.length > 0, entries };
  }

  /**
   * The agent says it has revalidated its next actions against the meeting's decisions (continue, replanned, or stopping): the requirement for that meeting is cleared, and a return that was waiting for it can complete (`returnToWork`, or the next sweep).
   * Only the agent itself can acknowledge. `all` clears every requirement when entries were folded together.
   */
  async acknowledge(by: Principal, command: NoActor & { occurrenceId?: string; all?: boolean; outcome: "continue" | "replanned" | "stopping"; note?: string }): Promise<{ cleared: number }> {
    onlyKnown(command, ["commandId", "occurrenceId", "all", "outcome", "note"]);
    if (by.kind !== "agent" || !AGENT.test(by.id)) throw forbidden(by, "acknowledge a meeting's decisions");
    if (command.outcome !== "continue" && command.outcome !== "replanned" && command.outcome !== "stopping") invalid("outcome", "must be continue, replanned or stopping");
    if ((command.occurrenceId === undefined) === (command.all !== true)) invalid("occurrenceId", "name one meeting, or pass all");
    const occurrenceId = command.occurrenceId === undefined ? undefined : this.#occurrenceId(command.occurrenceId);
    const note = command.note === undefined ? undefined : plain(command.note, "note", ATTENDANCE_LIMITS.note);
    let cleared = 0;
    await this.#retrying(() => this.#runner.command("meeting.revalidation.ack", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ occurrenceId, all: command.all, outcome: command.outcome, note }),
      build: async () => {
        const found = await this.#runner.get("meeting-revalidation", by.id);
        const body = found?.body as unknown as RevalidationBody | undefined;
        if (found === undefined || body === undefined) { cleared = 0; throw new DomainError("not_found", "there is nothing to acknowledge"); }
        const entries = command.all === true ? [] : body.entries.map((e) => ({ ...e, occurrenceIds: e.occurrenceIds.filter((o) => o !== occurrenceId) })).filter((e) => e.occurrenceIds.length > 0);
        cleared = body.entries.length - entries.length;
        const ref: AggregateRef = { kind: "meeting-revalidation", id: by.id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean({ ...body, entries }) }], detail: { agent: by.id, ...(occurrenceId === undefined ? {} : { occurrenceId }), outcome: command.outcome, cleared } };
      },
    })));
    return { cleared };
  }

  // ---- the saved brief ----------------------------------------------------------------------------------------------------------------------------

  /** The agent saves its brief for a meeting it may not attend (README 572). Only the agent itself, only on its own attendance, and only until the meeting is over. */
  async saveBrief(by: Principal, command: NoActor & { occurrenceId: string; text: string }): Promise<void> {
    onlyKnown(command, ["commandId", "occurrenceId", "text"]);
    const occurrenceId = this.#occurrenceId(command.occurrenceId);
    const body = plain(command.text, "text", ATTENDANCE_LIMITS.brief);
    const room = await this.#roomFor(occurrenceId);
    const att = room === undefined ? undefined : await this.#attendance(occurrenceId, by.id);
    if (room === undefined || att === undefined || att.body.isOwner || !this.#isSelf(by, by.id, room.body.projectId)) throw forbidden(by, "save a brief for that meeting");
    if (room.body.state !== "open") throw new DomainError("invalid_command", `the room of meeting ${occurrenceId} has ended`, { field: "occurrenceId" });
    const nowIso = this.#runner.now();
    await this.#update(by, "brief", att.id, (b) => ({ ...b, brief: { text: body, savedAt: nowIso } }), "brief-saved");
  }

  /**
   * An agent's saved brief, for whoever may see the meeting. It is always marked as saved and never as live: `live` is false, it carries the time it was saved, and the notice says it is not a live answer from the agent, whether or not the agent is present.
   */
  async briefOf(viewer: Principal, occurrenceId: string, agent: string): Promise<{ live: false; savedAt: string; text: string; notice: string } | undefined> {
    const id = this.#occurrenceId(occurrenceId);
    if ((await this.#meetings.occurrence(viewer, id)) === undefined) return undefined;
    const att = await this.#attendance(id, agent);
    const brief = att?.body.brief;
    if (att === undefined || brief === undefined) return undefined;
    return { live: false, savedAt: brief.savedAt, text: brief.text, notice: `Saved brief of ${agent} from ${brief.savedAt}. It is not a live answer from the agent.` };
  }

  // ---- internals --------------------------------------------------------------------------------------------------------------------------------------------

  async #reach(who: string): Promise<Availability> {
    try { return await this.#availability(who); } catch { return "stopped"; }
  }

  /** Whether the participant can come now, as at this moment: used when preparing, joining and on refresh. The seat is M01's record of the owner's direct invitation (read again here unless given). */
  async #redecide(body: AttendanceBody, occurrenceId: string, seat?: ParticipantRecord): Promise<{ state: AttendanceState; reason?: string; bounded: boolean; covers?: PauseExemptionBody["covers"] }> {
    const given = seat ?? ((await this.#runner.get("meeting-occurrence", occurrenceId))?.body as unknown as OccurrenceBody | undefined)?.participants.find((p) => p.id === body.who);
    return this.#decide(body.who, given);
  }

  /** The interrupted tasks that have not reached a safe boundary, with what the executor reports for each. */
  async #waiting(body: AttendanceBody): Promise<{ taskId: string; observed: string; blocked: boolean }[]> {
    const out: { taskId: string; observed: string; blocked: boolean }[] = [];
    for (const item of body.interrupted) {
      const gate = (await this.#runner.get("pause-gate", PauseService.gateIdOf({ kind: "task", id: item.taskId })))?.body as unknown as PauseGateBody | undefined;
      if (gate === undefined || gate.intent !== "pause") { out.push({ taskId: item.taskId, observed: "not-paused", blocked: false }); continue; }
      const o = gate.observed;
      if (o?.state === "paused") continue;
      const blocked = o?.state === "recovery-required" || o?.state === "unreachable" || o?.boundary === "uncooperative";
      out.push({ taskId: item.taskId, observed: o?.state ?? "pausing", blocked });
    }
    return out;
  }

  #effective(body: AttendanceBody, waiting: readonly { taskId: string; observed: string; blocked: boolean }[]): { state: AttendanceState; reason?: string } {
    if (body.state === "present" || body.state === "unavailable") return { state: body.state, ...(body.reason === undefined ? {} : { reason: body.reason }) };
    if (body.reportedBlock !== undefined) return { state: "blocked", reason: `blocked by an operation it cannot safely interrupt: ${body.reportedBlock.reason}` };
    const hard = waiting.filter((w) => w.blocked);
    if (hard.length > 0) return { state: "blocked", reason: `blocked by an operation it cannot safely interrupt (${hard.map((h) => `${h.taskId} is ${h.observed}`).join(", ")})` };
    return { state: "preparing", ...(waiting.length > 0 ? { reason: `waiting for a safe boundary on ${waiting.map((w) => w.taskId).join(", ")}` } : {}) };
  }

  async #gateScopes(taskId: string): Promise<PauseScope[]> { return [...(await this.#pauses.guard(taskId)).blockedBy]; }

  #event(body: Pick<AttendanceBody, "events" | "eventCount">, kind: string, by: string, note?: string): { events: AttendanceEvent[]; eventCount: number } {
    const seq = body.eventCount + 1;
    return { events: [...body.events, { seq, kind, at: this.#runner.now(), by, ...(note === undefined ? {} : { note: note.slice(0, ATTENDANCE_LIMITS.note) }) }].slice(-ATTENDANCE_LIMITS.events), eventCount: seq };
  }

  async #roomFor(occurrenceId: string): Promise<{ id: string; revision: number; body: RoomBody } | undefined> {
    const found = await this.#runner.get("meeting-room", roomIdOf(occurrenceId));
    return found === undefined ? undefined : { id: found.id, revision: found.revision, body: found.body as unknown as RoomBody };
  }

  async #attendance(occurrenceId: string, who: string): Promise<{ id: string; revision: number; body: AttendanceBody } | undefined> {
    const found = await this.#runner.get("meeting-attendance", attendanceIdOf(occurrenceId, who));
    return found === undefined ? undefined : { id: found.id, revision: found.revision, body: found.body as unknown as AttendanceBody };
  }

  /** One revision-checked change of one attendance, with an event. `fn` returns the new body (the same object: nothing to change). Retried when it loses a race; repeats after a crash decide again from the stored state. */
  async #update(by: Principal, label: string, attId: string, fn: (b: AttendanceBody) => AttendanceBody, eventKind?: string, note?: string, quiet = false): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const att = await this.#runner.get("meeting-attendance", attId);
      const body = att?.body as unknown as AttendanceBody | undefined;
      if (att === undefined || body === undefined) throw new DomainError("not_found", "that attendance does not exist");
      const next = fn(body);
      if (next === body) return;
      const withEvent = eventKind === undefined || quiet ? next : { ...next, ...this.#event(next, eventKind, by.id, note) };
      try {
        await this.#runner.command(`meeting.attendance.${label}`, { commandId: scopedCommandId(by.id, `${label}:${attId}:${att.revision}`), actor: by.id }, async () => ({
          payload: { attendanceId: attId, revision: att.revision, label },
          build: async () => {
            const ref: AggregateRef = { kind: "meeting-attendance", id: attId };
            return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: att.revision, body: clean(withEvent) }], detail: { occurrenceId: body.occurrenceId, who: body.who, label } };
          },
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= ATTENDANCE_LIMITS.retries) throw error;
      }
    }
  }

  /** Keeps the pending-return list in step with an attendance: in it while a return waits (deferred or revalidating), out when settled. One revision-checked write of the list; 200 entries at most (a further deferral is refused, not dropped). */
  async #syncPending(by: Principal, attId: string): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const att = (await this.#runner.get("meeting-attendance", attId))?.body as unknown as AttendanceBody | undefined;
      const found = await this.#runner.get("meeting-return-pending", PENDING);
      const ids = (found?.body as unknown as PendingBody | undefined)?.ids ?? [];
      const waiting = att !== undefined && att.interrupted.some((x) => x.outcome === "deferred" || x.outcome === "revalidating");
      const has = ids.includes(attId);
      if (waiting === has) return;
      if (waiting && ids.length >= ATTENDANCE_LIMITS.pending) throw new DomainError("unavailable", `${ATTENDANCE_LIMITS.pending} returns are already waiting; settle some first`);
      const next = waiting ? [...ids, attId] : ids.filter((x) => x !== attId);
      const ref: AggregateRef = { kind: "meeting-return-pending", id: PENDING };
      try {
        await this.#runner.command("meeting.return.pending", { commandId: scopedCommandId(by.id, `pending:${attId}:${found?.revision ?? 0}:${waiting ? "add" : "remove"}`), actor: by.id }, async () => ({
          payload: { attendanceId: attId, waiting },
          build: async () => ({ ref, creates: found === undefined, changes: [found === undefined ? { type: "create", ref, body: { ids: next } as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: { ids: next } as unknown as JsonObject }], detail: { attendanceId: attId, waiting } }),
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= ATTENDANCE_LIMITS.retries) throw error;
      }
    }
  }

  #occurrenceId(value: unknown): string { return typeof value === "string" && OCCURRENCE_ID.test(value) ? value : invalid("occurrenceId", "is not a meeting ID"); }
  #mayRun(by: Principal, projectId: string): boolean { return staff(by) || (allows(by, "meeting.manage", projectId) && inTaskScope(by, projectId)); }
  #isSelf(by: Principal, agent: string, projectId: string): boolean { return by.kind === "agent" && by.id === agent && by.asOf !== undefined && inTaskScope(by, projectId); }
  #mayControlTask(by: Principal, taskId: string, projectId: string): boolean { return by.kind === "owner" || (inTaskScope(by, projectId) && allows(by, "assignment.manage", projectId, { resource: { kind: "task", id: taskId } })); }

  #requireAll(value: unknown): { timeoutMinutes: number } {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("requireAll", "must be an object with timeoutMinutes");
    onlyKnown(value, ["timeoutMinutes"]);
    return { timeoutMinutes: whole((value as { timeoutMinutes?: unknown }).timeoutMinutes, "requireAll.timeoutMinutes", 1, ATTENDANCE_LIMITS.timeoutMax) };
  }

  #taskList(value: unknown, field: string, max: number): string[] {
    if (!Array.isArray(value) || value.length > max) return invalid(field, `must be a list of at most ${max} task IDs`);
    return [...new Set(value.map((v) => checkTaskId(v)))];
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= ATTENDANCE_LIMITS.retries) throw error;
      }
    }
  }
}

export interface AttendanceDeps {
  readonly meetings: MeetingService;
  readonly pauses: PauseService;
  readonly projects: ProjectService;
  readonly assignments: AssignmentService;
  /** Resolves a named team to its agents for `callNow`. */
  readonly agents?: AgentService;
  /** Opens the meeting conversation of a room. */
  readonly histories?: HistoryService;
  /**
   * Charges the time an agent spent in a meeting (card R05d). Measurement basis: wall-clock milliseconds between joining and leaving, charged as compute to the agent's meeting task
   * (or, with none, to the shared-overhead rule "meeting"). Idempotent by `commandId`. A failure is reported, never allowed to keep an agent in the room.
   */
  readonly charge?: (usage: { commandId: string; projectId: string; agentId: string; computeMs: number; taskId?: string }) => Promise<void>;
  readonly onChargeError?: (error: unknown) => void;
  /**
   * The `meeting.leadMinutes` setting in minutes (card M01d): from this long before a meeting starts, the agents that will attend are kept free of new work (admission defers it, whatever its expected length, unless it is a safe
   * long-running operation). Work already running is not touched. Absent, failing or 0: only work that would still be running at the start is deferred, as before.
   */
  readonly leadMinutes?: () => Promise<number | undefined>;
}
