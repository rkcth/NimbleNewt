import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { Availability } from "../conversations/index.js";
import type { InquiryService } from "../inquiries/inquiries.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { SettingDefinition } from "../configuration/settings.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import { knownZone, dueSlots, isLocalDate, isLocalTime, nextSlot, wallClock, type Recurrence, type Slot, type SlotRule } from "./zones.js";

export type ScheduleState = "active" | "paused" | "ended";
export type OccurrenceKind = "scheduled" | "urgent";
/** `live`: the meeting can still be held. `catch-up`: its time had already passed when it was created (downtime, a late start), so it is a report for the period and not a meeting to call people into. */
export type OccurrenceMode = "live" | "catch-up";
/** `reported`: a catch-up, created already settled (nothing to hold; it is not waiting and takes no place in the open lists). `missed`: nobody held it and nobody cancelled it, and its time (plus the grace period) has gone. */
export type OccurrenceState = "planned" | "held" | "cancelled" | "missed" | "reported";
export type ParticipantStatus = "eligible" | "withheld-paused" | "withheld-unavailable" | "owner-invited";
export type AgendaState = "queued" | "scheduled" | "discussed" | "deferred" | "resolved";
export type AgendaUrgency = "normal" | "urgent";
/** What the topic asks for. An owner instruction or a decision delegated to the team carries authority, so only the owner can record one; a paraphrase by a supervisor is a discussion or a recommendation request. */
export type AgendaIntent = "discussion" | "recommendation" | "delegated-decision" | "owner-instruction";
/**
 * What kind of agenda point it is, for the order a meeting takes them in (card M03): conflicts first, then questions, then decisions, then other topics, then improvement proposals. Absent on older items: it is derived
 * (`categoryOf`). Only a manager or the owner may record a `conflict`; an agent that disagrees with another raises a question.
 */
export type AgendaCategory = "conflict" | "question" | "decision" | "topic" | "improvement";
export const AGENDA_CATEGORIES: readonly AgendaCategory[] = ["conflict", "question", "decision", "topic", "improvement"];
const CATEGORY_RANK: Readonly<Record<AgendaCategory, number>> = { conflict: 0, question: 1, decision: 2, topic: 3, improvement: 4 };

/** The category an item has: the stated one, or derived from what it asks (a decision for the team or an instruction is a decision; a question text makes a question; anything else a topic). */
export const categoryOf = (item: { readonly category?: AgendaCategory; readonly intent: AgendaIntent; readonly question?: string }): AgendaCategory =>
  item.category ?? (item.intent === "delegated-decision" || item.intent === "owner-instruction" ? "decision" : item.question !== undefined ? "question" : "topic");

/**
 * What each request type lets the team do with the topic (card M03). `executes` is true only where the owner gave a direction: a discussion or a recommendation request is never an instruction, so findings go back and nothing is done on its strength.
 * `votable` says whether the team may vote to overturn the substance: an explicit owner choice is a constraint on the discussion, not a proposition.
 */
export const authorityOf = (intent: AgendaIntent): { readonly executes: boolean; readonly votable: boolean; readonly words: string } => {
  switch (intent) {
    case "discussion": return { executes: false, votable: true, words: "discussion only: the team talks it over and reports back; nothing is done because of it" };
    case "recommendation": return { executes: false, votable: true, words: "a recommendation is asked for: the team advises and the owner decides; nothing is done because of it" };
    case "delegated-decision": return { executes: true, votable: true, words: "the owner left this decision to the team: it may be decided within the authority the team already has" };
    case "owner-instruction": return { executes: true, votable: false, words: "an explicit instruction from the owner: the team plans how to carry it out and does not vote on whether to" };
  }
};

export interface ScheduleBody {
  readonly projectId: string;
  readonly title: string;
  /** The fixed roster each new occurrence starts from (agent principals). Editing it changes later occurrences only. */
  readonly roster: readonly string[];
  readonly timeZone: string;
  /** The zone was taken from the owner's setting when the schedule was made (it is recorded, not followed: changing the setting later changes no schedule by itself). */
  readonly timeZoneFromOwnerSetting: boolean;
  readonly time: string;
  readonly recurrence: Recurrence;
  readonly startDate?: string;
  readonly endDate?: string;
  readonly durationMinutes: number;
  /** How long before the start the occurrence is created, so that agents can reach a safe boundary and prepare a brief. */
  readonly prepareMinutes: number;
  /** A planning figure for the meeting procedure (M05); nothing here enforces it. */
  readonly budgetTokens?: number;
  /** A stand-up's daily window (local wall-clock hours, in the schedule's zone): the time and the length of the meeting must lie inside it, on creation and on every later change (card M03). */
  readonly window?: { readonly from: string; readonly to: string };
  readonly state: ScheduleState;
  readonly createdBy: string;
  readonly createdAt: string;
  /** The start of the latest slot handled (created, or skipped in favour of a later one), or the creation/last change time before any: slots at or before it are never made again. */
  readonly cursor: string;
  /** The last change that moved when meetings happen (a time, zone, recurrence or date change, or a resume). Slots at or before it are not made; `tick` reports them as skipped. */
  readonly editedAt?: string;
  /** When the next occurrence is due to be created (absent: none is coming). */
  readonly nextPrepareAt?: string;
  readonly lastOccurrenceId?: string;
  readonly occurrences: number;
}

export interface ParticipantRecord {
  readonly id: string;
  readonly status: ParticipantStatus;
  /** What was observed when the status was decided. */
  readonly availability: Availability;
  /** Present once the invitation was handed to the invitation sink. */
  readonly invitedAt?: string;
  /** Only the owner's direct invitation sets this: a paused agent may attend this meeting only, its other work stays paused. */
  readonly invitedBy?: string;
  /** When the owner's direct invitation was made (each invitation sets it again): a pause placed after it is not covered by it. */
  readonly ownerInvitedAt?: string;
}

export interface OccurrenceBody {
  readonly scheduleId?: string;
  readonly projectId: string;
  readonly kind: OccurrenceKind;
  readonly title: string;
  readonly reason?: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly prepareFrom?: string;
  readonly timeZone: string;
  /** The local calendar date in `timeZone` that names the slot. */
  readonly localDate: string;
  readonly mode: OccurrenceMode;
  readonly state: OccurrenceState;
  readonly participants: readonly ParticipantRecord[];
  /** Agenda items attached at creation (they are `scheduled` for this occurrence). */
  readonly agenda: readonly string[];
  /** Open items that matched but did not fit in the agenda; they stay queued. */
  readonly agendaOverflow: number;
  /** Items that could not be put back on the open agenda when this meeting was settled (the list was full); they stay queued, marked `unlisted`. */
  readonly agendaUnlisted?: number;
  /** Items this meeting deferred whose outcome could not be queued to go back to their conversation (the queue of returns was full); their state still shows what happened. */
  readonly returnsUnlisted?: number;
  /** The report period a catch-up covers: from the previous handled slot to this one. */
  readonly coversFrom?: string;
  /** Earlier slots that were not made into occurrences because this later one replaced them (after downtime). */
  readonly skippedSlots: readonly string[];
  readonly skippedCount: number;
  /** The look-back limit was reached: more slots were skipped than counted. */
  readonly skippedTruncated: boolean;
  readonly budgetTokens?: number;
  readonly createdBy: string;
  readonly createdAt: string;
  readonly settledAt?: string;
  readonly settledBy?: string;
  readonly settleReason?: string;
}

export interface AgendaBody {
  readonly projectId: string;
  readonly topic: string;
  /** The requester's actual question, in their words. */
  readonly question?: string;
  readonly context?: string;
  readonly requestedOutcome?: string;
  readonly urgency: AgendaUrgency;
  readonly intent: AgendaIntent;
  /** Where it goes in the order of a meeting; absent: derived (`categoryOf`). */
  readonly category?: AgendaCategory;
  /** How long the meeting should spend on it (improvement proposals are timeboxed, README 531). The meeting procedure enforces it (M05); here it is recorded and shown. */
  readonly timeboxMinutes?: number;
  /** What the topic is about, when that is a record other than a conversation (an improvement backlog item, card M03). */
  readonly link?: { readonly kind: "improvement"; readonly id: string };
  /** Corrections made after it was captured (the requester or a manager fixing what the supervisor wrote), newest last, at most ten kept. */
  readonly corrections?: readonly { readonly at: string; readonly by: string; readonly fields: readonly string[] }[];
  readonly correctionCount?: number;
  /** Empty: whoever is on the roster. */
  readonly participants: readonly string[];
  readonly owner: string;
  readonly requestedBy: string;
  /** The conversation the topic came from: an inquiry (H04) or an owner chat turn (U03). */
  readonly source?: { readonly kind: "inquiry" | "chat-turn"; readonly id: string };
  readonly state: AgendaState;
  /** Queued or deferred but not on the open list because it was full; `setAgendaState` to `queued` lists it again when there is room. */
  readonly unlisted?: boolean;
  readonly occurrenceId?: string;
  readonly deferral?: { readonly reason: string; readonly nextStep: string };
  /** A link to what the meeting made of it (a decision record), set by whoever resolves it. */
  readonly outcomeRef?: string;
  /** What the meeting made of it, in words, for the conversation the topic came from (set with the state change; handed back by `outcomesToReturn`). */
  readonly outcomeNote?: string;
  /** The outcome could not go on the list of outcomes waiting to be returned (it was full): it waits on the overflow list or, past that, nowhere; `requeueReturns` lists it when there is room. */
  readonly returnUnlisted?: true;
  /** Present once the outcome was handed back to the conversation the item came from. */
  readonly returnedAt?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

interface IndexBody { readonly ids: readonly string[] }
interface OpenState { readonly projectId: string; readonly ids: readonly string[]; readonly pRevision: number; readonly count: number; readonly projects: readonly string[]; readonly gRevision: number }

export interface Invitation {
  /** Names this invitation for ever: a sink that sees the key twice does it once. */
  readonly key: string;
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly agent: string;
  readonly startsAt: string;
  readonly urgent: boolean;
  /** The agent is paused and the owner invited it by hand: it attends this meeting only. */
  readonly bounded: boolean;
}
/** Hands an invitation to whatever delivers it (a conversation message, a bounded meeting task). Called only for agents that may be invited; must be idempotent by `key`. */
export interface TickSkip { readonly scheduleId: string; readonly localDate: string; readonly reason: string }
export interface InvitationSink { invite(invitation: Invitation): Promise<void> }

export interface MeetingOptions extends RunnerOptions {
  /** Whether an agent may be reached (the pause service's `availability`). Required. It fails closed: if it is missing or throws, the participant is treated as unavailable and withheld. */
  readonly availability: (principalId: string) => Promise<Availability>;
  /** The owner's time zone setting (the `meeting.timeZone` setting, see `ownerTimeZoneFrom`); used when a schedule names no zone. */
  readonly ownerTimeZone?: () => Promise<string | undefined>;
  readonly invitations?: InvitationSink;
  /** How many outcomes may wait on the list to be returned to their conversations, and how many more on the overflow list behind it (defaults 200 and 1000; mostly for tests). Beyond both the state change is still recorded, the outcome is marked unlisted and counted. */
  readonly returnsListed?: number;
  readonly returnsMore?: number;
}

export const MEETING_LIMITS = {
  title: 200, reason: 1000, topic: 200, question: 2000, context: 4000, outcome: 1000, deferral: 500, ref: 200, roster: 50, participants: 50, durationMax: 480, prepareMax: 720,
  openAgendaPerProject: 200, returnsPending: 200, returnsMore: 1000, timeboxMax: 120, corrections: 10, agendaPerMeeting: 25, openOccurrencesPerProject: 200, openOccurrences: 1000, scheduleScanDays: 400, retries: 8, page: 100, skippedListed: 10, graceMinutes: 60, tickSchedules: 50, tickMax: 200, budgetTokens: 1_000_000_000,
} as const;

/** The setting that holds the owner's time zone for meetings. Pass these as `settings` to the configuration service. */
export const MEETING_SETTINGS: readonly SettingDefinition[] = [
  { key: "meeting.timeZone", kind: "default", check: (v) => knownZone(v) ?? (() => { throw "must be an IANA time zone name such as Europe/Berlin"; })(), effect: "next-request", description: "The time zone meeting schedules use when they name none." },
];

const SCHEDULE_ID = /^msc-[a-z2-7]{20}$/;
const OCCURRENCE_ID = /^mto-[a-z2-7]{20}$/;
const AGENDA_ID = /^mag-[a-z2-7]{20}$/;
const IMPROVEMENT_ID = /^imp-[a-z2-7]{20}$/;
const AGENT = /^agent:[a-z0-9][a-z0-9-]{0,39}$/;
const GLOBAL_OPEN = "all";
const agendaIndexId = (projectId: string): string => projectId;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string, max: number): string => {
  const out = text(value, field, { min: 1, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const optionalPlain = (value: unknown, field: string, max: number): string | undefined => (value === undefined ? undefined : plain(value, field, max));
const whole = (value: unknown, field: string, min: number, max: number): number => (typeof value === "number" && Number.isSafeInteger(value) && value >= min && value <= max ? value : invalid(field, `must be a whole number from ${min} to ${max}`));
const clean = <T extends object>(body: T): JsonObject => Object.fromEntries(Object.entries(body).filter(([, v]) => v !== undefined)) as unknown as JsonObject;
const isService = (p: Principal): boolean => p.kind === "owner" || p.kind === "host" || p.kind === "service";
const ms = (iso: string): number => Date.parse(iso);

/**
 * Durable meeting scheduling and agendas (card M01). It decides *when* a meeting exists, *who may be asked to it* and *what is on its agenda*; running the meeting (the chair, motions, votes, the record) is the procedure cards' job.
 *
 * - **Schedules** are a wall-clock time in a named IANA zone (the owner's setting unless the schedule names one) with a recurrence (once, daily, weekly on chosen days). The clock is the injected one. Daylight-saving changes move the
 *   instant and never the wall-clock time; a skipped local time happens just after the gap, a repeated one at its first pass, and a local date has at most one slot (see `zones.ts`).
 * - **Occurrences are idempotent.** An occurrence is named by its schedule and local date, and is created in the same commit that moves the schedule's cursor past it, so `tick` can be called by any number of processes, repeatedly and after
 *   a restart, and each slot yields one occurrence. After downtime, all the slots that passed are replaced by one occurrence for the latest (the others are listed as skipped; it says what period it covers). One whose time has already
 *   gone is a `catch-up` report, never a meeting to call people into.
 * - **Urgent meetings** are made at once by someone with `meeting.manage`, with an explicit roster. Their invitations are first-class: the same participants rules apply.
 * - **Absent or paused participants** are decided when the occurrence is made and again when invitations go out: an agent that is paused (its own gate, its team's or the installation's) or suspended or stopped is *withheld*, not woken; it stays on the
 *   roster as absent. Only the owner can invite a paused agent by hand (bounded attendance, other work stays paused); nothing here wakes a suspended or stopped agent.
 * - **Agenda items** are durable records ("topics raised with a supervisor"): the requester's question, context, requested outcome, urgency, intended participants, an owner, and a link to the conversation they came from. They are queued
 *   until a meeting takes them, and come back to the queue if the meeting is cancelled or missed; items a held meeting did not reach become `deferred` with a reason and next step. Nothing is dropped.
 */
export class MeetingService {
  readonly #runner: CommandRunner;
  readonly #inquiries: InquiryService | undefined;
  readonly #availability: ((principalId: string) => Promise<Availability>) | undefined;
  readonly #ownerZone: (() => Promise<string | undefined>) | undefined;
  readonly #sink: InvitationSink | undefined;
  readonly #capListed: number;
  readonly #capMore: number;

  private constructor(runner: CommandRunner, deps: { inquiries?: InquiryService }, options: MeetingOptions) {
    this.#runner = runner;
    this.#inquiries = deps.inquiries;
    this.#availability = options.availability;
    this.#ownerZone = options.ownerTimeZone;
    this.#sink = options.invitations;
    this.#capListed = options.returnsListed ?? MEETING_LIMITS.returnsPending;
    this.#capMore = options.returnsMore ?? MEETING_LIMITS.returnsMore;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { inquiries?: InquiryService } = {}, options: MeetingOptions): MeetingService {
    return new MeetingService(new CommandRunner(storage, epoch, options), deps, options);
  }

  // ---- schedules ------------------------------------------------------------------------------------------------------------

  /** Creates a schedule. Needs `meeting.manage` in the project. Slots before the creation time are never made (a schedule made at 10:00 for 09:00 daily starts tomorrow). */
  async createSchedule(by: Principal, command: NoActor & {
    projectId: string; title: string; roster: readonly string[]; time: string; recurrence?: Recurrence; timeZone?: string; startDate?: string; endDate?: string;
    durationMinutes?: number; prepareMinutes?: number; budgetTokens?: number; window?: { from: string; to: string };
  }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "title", "roster", "time", "recurrence", "timeZone", "startDate", "endDate", "durationMinutes", "prepareMinutes", "budgetTokens", "window"]);
    const projectId = checkProjectId(command.projectId);
    await this.#requireManage(by, projectId);
    const title = plain(command.title, "title", MEETING_LIMITS.title);
    const roster = await this.#roster(command.roster, projectId);
    const time = isLocalTime(command.time) ? command.time : invalid("time", "must be a wall-clock time such as 09:30");
    const recurrence = checkRecurrence(command.recurrence ?? { kind: "daily" });
    const fromOwner = command.timeZone === undefined;
    const given = fromOwner ? await this.#ownerZone?.() : command.timeZone;
    const timeZone = knownZone(given) ?? invalid("timeZone", fromOwner ? "the owner has no meeting.timeZone setting and the schedule names no zone" : "is not an IANA time zone name the system knows");
    const startDate = command.startDate === undefined ? undefined : (isLocalDate(command.startDate) ? command.startDate : invalid("startDate", "must be a date such as 2026-11-02"));
    const endDate = command.endDate === undefined ? undefined : (isLocalDate(command.endDate) ? command.endDate : invalid("endDate", "must be a date such as 2026-11-02"));
    if (startDate !== undefined && endDate !== undefined && endDate < startDate) invalid("endDate", "is before startDate");
    const durationMinutes = command.durationMinutes === undefined ? 30 : whole(command.durationMinutes, "durationMinutes", 1, MEETING_LIMITS.durationMax);
    const prepareMinutes = command.prepareMinutes === undefined ? 0 : whole(command.prepareMinutes, "prepareMinutes", 0, MEETING_LIMITS.prepareMax);
    const budgetTokens = command.budgetTokens === undefined ? undefined : whole(command.budgetTokens, "budgetTokens", 1, MEETING_LIMITS.budgetTokens);
    const window = command.window === undefined ? undefined : checkWindow(command.window, time, durationMinutes);
    const id = derivedId("msc", scopedCommandId(by.id, command.commandId));
    const result = await this.#runner.command("meeting.schedule.create", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ projectId, title, roster, time, recurrence, timeZone, fromOwner, startDate, endDate, durationMinutes, prepareMinutes, budgetTokens, window }),
      build: async () => {
        const now = this.#runner.now();
        const base = { projectId, title, roster, timeZone, timeZoneFromOwnerSetting: fromOwner, time, recurrence, ...(startDate === undefined ? {} : { startDate }), ...(endDate === undefined ? {} : { endDate }), durationMinutes, prepareMinutes, ...(budgetTokens === undefined ? {} : { budgetTokens }), ...(window === undefined ? {} : { window }) };
        const next = nextPrepare({ ...base, cursor: now });
        const body: ScheduleBody = { ...base, state: next === undefined ? "ended" : "active", createdBy: by.id, createdAt: now, cursor: now, ...(next === undefined ? {} : { nextPrepareAt: next }), occurrences: 0 };
        const ref: AggregateRef = { kind: "meeting-schedule", id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }], detail: { projectId, timeZone } };
      },
    }));
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * Changes a schedule: pause, resume or end it, or change its title, roster, time, recurrence, zone, length or lead time. A change of when it happens (or a resume) moves the cursor to now, so it never makes occurrences for
   * times that already passed; an occurrence that already exists is not touched.
   */
  async updateSchedule(by: Principal, command: NoActor & {
    scheduleId: string; expectedRevision: number; state?: ScheduleState; title?: string; roster?: readonly string[]; time?: string; recurrence?: Recurrence; timeZone?: string; startDate?: string | null; endDate?: string | null;
    durationMinutes?: number; prepareMinutes?: number; window?: { from: string; to: string };
  }): Promise<void> {
    onlyKnown(command, ["commandId", "scheduleId", "expectedRevision", "state", "title", "roster", "time", "recurrence", "timeZone", "startDate", "endDate", "durationMinutes", "prepareMinutes", "window"]);
    const id = typeof command.scheduleId === "string" && SCHEDULE_ID.test(command.scheduleId) ? command.scheduleId : invalid("scheduleId", "is not a schedule ID");
    const expected = checkRevision(command.expectedRevision);
    if (command.state !== undefined && command.state !== "active" && command.state !== "paused" && command.state !== "ended") invalid("state", "must be active, paused or ended");
    const found = await this.#runner.get("meeting-schedule", id);
    const current = found?.body as unknown as ScheduleBody | undefined;
    if (found === undefined || current === undefined || !allows(by, "meeting.manage", current.projectId)) throw new DomainError("forbidden", `${by.id} may not change that schedule`);
    const title = command.title === undefined ? undefined : plain(command.title, "title", MEETING_LIMITS.title);
    const roster = command.roster === undefined ? undefined : await this.#roster(command.roster, current.projectId);
    const time = command.time === undefined ? undefined : (isLocalTime(command.time) ? command.time : invalid("time", "must be a wall-clock time such as 09:30"));
    const recurrence = command.recurrence === undefined ? undefined : checkRecurrence(command.recurrence);
    const timeZone = command.timeZone === undefined ? undefined : (knownZone(command.timeZone) ?? invalid("timeZone", "is not an IANA time zone name the system knows"));
    const startDate = command.startDate === undefined || command.startDate === null ? command.startDate : (isLocalDate(command.startDate) ? command.startDate : invalid("startDate", "must be a date such as 2026-11-02"));
    const endDate = command.endDate === undefined || command.endDate === null ? command.endDate : (isLocalDate(command.endDate) ? command.endDate : invalid("endDate", "must be a date such as 2026-11-02"));
    const durationMinutes = command.durationMinutes === undefined ? undefined : whole(command.durationMinutes, "durationMinutes", 1, MEETING_LIMITS.durationMax);
    const prepareMinutes = command.prepareMinutes === undefined ? undefined : whole(command.prepareMinutes, "prepareMinutes", 0, MEETING_LIMITS.prepareMax);
    await this.#runner.command("meeting.schedule.update", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ scheduleId: id, expectedRevision: expected, state: command.state, title, roster, time, recurrence, timeZone, startDate, endDate, durationMinutes, prepareMinutes, window: command.window }),
      build: async () => {
        const now = this.#runner.now();
        const cur = await this.#runner.get("meeting-schedule", id);
        const body = cur?.body as unknown as ScheduleBody | undefined;
        if (cur === undefined || body === undefined || !allows(by, "meeting.manage", body.projectId)) throw new DomainError("forbidden", `${by.id} may not change that schedule`);
        if (cur.revision !== expected) throw new DomainError("stale_revision", `schedule ${id} is at revision ${cur.revision}, not ${expected}`, { currentRevision: cur.revision });
        if (body.state === "ended") throw new DomainError("invalid_command", `schedule ${id} has ended; make a new one`, { field: "scheduleId" });
        const state = command.state ?? body.state;
        const moved = time !== undefined || recurrence !== undefined || timeZone !== undefined || startDate !== undefined || endDate !== undefined || (state === "active" && body.state === "paused");
        const { startDate: oldStart, endDate: oldEnd, nextPrepareAt: _n, ...rest } = body;
        void _n;
        const newStart = startDate === undefined ? oldStart : (startDate === null ? undefined : startDate);
        const newEnd = endDate === undefined ? oldEnd : (endDate === null ? undefined : endDate);
        const merged = {
          ...rest, title: title ?? body.title, roster: roster ?? body.roster, time: time ?? body.time, recurrence: recurrence ?? body.recurrence, timeZone: timeZone ?? body.timeZone,
          timeZoneFromOwnerSetting: timeZone === undefined ? body.timeZoneFromOwnerSetting : false, durationMinutes: durationMinutes ?? body.durationMinutes, prepareMinutes: prepareMinutes ?? body.prepareMinutes,
          ...(newStart === undefined ? {} : { startDate: newStart }), ...(newEnd === undefined ? {} : { endDate: newEnd }),
        };
        // A change of when meetings happen (or a resume) marks the moment: slots at or before it are not made, and the next tick says so.
        // A stand-up schedule keeps its daily window: whatever the change, the time and length that result must lie inside the window that results.
        const newWindow = command.window === undefined ? body.window : checkWindow(command.window, merged.time, merged.durationMinutes);
        if (command.window === undefined && newWindow !== undefined) checkWindow(newWindow, merged.time, merged.durationMinutes);
        const editedAt = moved ? now : body.editedAt;
        const next = state === "active" ? nextPrepare({ ...merged, ...(editedAt === undefined ? {} : { editedAt }) }) : undefined;
        const nextState: ScheduleState = state === "active" && next === undefined ? "ended" : state;
        const out: ScheduleBody = { ...merged, ...(newWindow === undefined ? {} : { window: newWindow }), state: nextState, ...(editedAt === undefined ? {} : { editedAt }), ...(next === undefined ? {} : { nextPrepareAt: next }) };
        const ref: AggregateRef = { kind: "meeting-schedule", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: cur.revision, body: clean(out) }], detail: { projectId: body.projectId } };
      },
    }));
  }

  async schedule(viewer: Principal, scheduleId: string): Promise<View<ScheduleBody> | undefined> {
    const found = typeof scheduleId === "string" && SCHEDULE_ID.test(scheduleId) ? await this.#runner.get("meeting-schedule", scheduleId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as ScheduleBody;
    return this.#mayRead(viewer, body.projectId) ? view<ScheduleBody>(found) : undefined;
  }

  // ---- ticking: occurrences ---------------------------------------------------------------------------------------------------

  /**
   * Makes the occurrences that are due now and settles the ones nobody held. Called by the controller's own loop (owner, host or service); safe to call from several places at once, repeatedly, and after a restart.
   * Slots that were not made because an edit or resume overtook them, or because the date already had its meeting, come back in `skipped` with the reason (also in the audit detail): none is dropped silently.
   * Per call at most `limit` schedules are looked at; `next` is the point to continue from when there are more (nothing is silently left out). `nextDueAt` is the earliest time anything else will be due.
   */
  async tick(by: Principal, page: { afterId?: string; limit?: number } = {}): Promise<{ created: { scheduleId: string; occurrenceId: string; skipped: number; mode: OccurrenceMode }[]; missed: string[]; blocked: string[]; skipped: TickSkip[]; next?: string; nextDueAt?: string }> {
    onlyKnown(page, ["afterId", "limit"]);
    if (!isService(by) || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not run the meeting clock`);
    const limit = page.limit === undefined ? MEETING_LIMITS.tickSchedules : whole(page.limit, "limit", 1, MEETING_LIMITS.tickMax);
    if (page.afterId !== undefined && (typeof page.afterId !== "string" || !SCHEDULE_ID.test(page.afterId))) invalid("afterId", "is not a schedule ID");
    const missed = page.afterId === undefined ? await this.#sweep(by) : [];
    const created: { scheduleId: string; occurrenceId: string; skipped: number; mode: OccurrenceMode }[] = [];
    let seen = 0;
    let after = page.afterId;
    let nextDue: number | undefined;
    const soonest = (iso: string | undefined): void => { if (iso !== undefined && (nextDue === undefined || ms(iso) < nextDue)) nextDue = ms(iso); };
    let more = false;
    const blocked: string[] = [];
    const skippedSlots: TickSkip[] = [];
    for (;;) {
      const ask = Math.min(200, limit - seen + 1);
      const chunk = await this.#runner.list("meeting-schedule", { ...(after === undefined ? {} : { afterId: after }), limit: ask });
      for (const schedule of chunk) {
        if (seen >= limit) { more = true; break; }
        seen++;
        after = schedule.id;
        const result = await this.#advance(by, schedule.id);
        if (result.created !== undefined) created.push(result.created);
        if (result.blocked === true) blocked.push(schedule.id);
        skippedSlots.push(...result.skippedSlots);
        soonest(result.nextPrepareAt);
      }
      if (more || chunk.length < ask) break;
    }
    return { created, missed, blocked, skipped: skippedSlots, ...(more && after !== undefined ? { next: after } : {}), ...(nextDue === undefined || more ? {} : { nextDueAt: new Date(nextDue).toISOString() }) };
  }

  /** The due slots of a schedule now, split into the ones an edit or resume has overtaken (`stale`: not made, reported) and the ones that stand (`live`). */
  #plan(schedule: ScheduleBody, nowMs: number): { stale: Slot[]; live: Slot[]; truncated: boolean } {
    const due = dueSlots(ruleOf(schedule), ms(schedule.cursor), nowMs, schedule.prepareMinutes * 60_000, MEETING_LIMITS.scheduleScanDays);
    const edited = schedule.editedAt === undefined ? -Infinity : ms(schedule.editedAt);
    return { stale: due.slots.filter((s) => s.at <= edited), live: due.slots.filter((s) => s.at > edited), truncated: due.truncated };
  }

  /** One schedule: makes the occurrence for the latest due slot, if any. Re-reads and decides again when it loses a race (another process ticking, an edit). */
  async #advance(by: Principal, scheduleId: string): Promise<{ created?: { scheduleId: string; occurrenceId: string; skipped: number; mode: OccurrenceMode }; skippedSlots: TickSkip[]; blocked?: true; nextPrepareAt?: string }> {
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get("meeting-schedule", scheduleId);
      if (found === undefined) return { skippedSlots: [] };
      const schedule = found.body as unknown as ScheduleBody;
      if (schedule.state !== "active") return { skippedSlots: [] };
      const plan = this.#plan(schedule, ms(this.#runner.now()));
      const slot = plan.live[plan.live.length - 1] ?? plan.stale[plan.stale.length - 1];
      if (slot === undefined) return { skippedSlots: [], ...(schedule.nextPrepareAt === undefined ? {} : { nextPrepareAt: schedule.nextPrepareAt }) };
      const occurrenceId = derivedId("mto", `${scheduleId}\0${slot.key}`);
      const notes: TickSkip[] = [];
      try {
        const result = await this.#runner.command("meeting.occurrence.create", { commandId: `mtg:${scheduleId}:${slot.key}:${found.revision}`, actor: by.id }, async () => ({
          payload: { scheduleId, slot: slot.key },
          build: async () => { notes.length = 0; return this.#buildOccurrence(by, scheduleId, slot.key, notes); },
        }));
        const after = await this.#runner.get("meeting-schedule", scheduleId);
        const next = (after?.body as unknown as ScheduleBody | undefined)?.nextPrepareAt;
        const occurrence = await this.#runner.get("meeting-occurrence", occurrenceId);
        const body = occurrence?.body as unknown as OccurrenceBody | undefined;
        // Made by this call (not found existing, not a replay): the schedule's count went up.
        const made = (after?.body as unknown as ScheduleBody | undefined)?.occurrences !== schedule.occurrences;
        return { skippedSlots: result.replayed ? [] : [...notes], ...(body === undefined || result.replayed || !made ? {} : { created: { scheduleId, occurrenceId, skipped: body.skippedCount, mode: body.mode } }), ...(next === undefined ? {} : { nextPrepareAt: next }) };
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict" && error.code !== "unavailable") || attempt >= MEETING_LIMITS.retries) throw error;
        if (error.code === "unavailable") return { skippedSlots: [], blocked: true };
      }
    }
  }

  async #buildOccurrence(by: Principal, scheduleId: string, slotKey: string, notes: TickSkip[]) {
    const found = await this.#runner.get("meeting-schedule", scheduleId);
    const schedule = found?.body as unknown as ScheduleBody | undefined;
    if (found === undefined || schedule === undefined || schedule.state !== "active") throw new DomainError("stale_revision", `schedule ${scheduleId} changed`);
    const nowIso = this.#runner.now();
    const nowMs = ms(nowIso);
    const plan = this.#plan(schedule, nowMs);
    const slot = plan.live[plan.live.length - 1] ?? plan.stale[plan.stale.length - 1];
    // The slot the caller meant is not the latest due one any more (another process made it, the schedule was edited): decide again.
    if (slot === undefined || slot.key !== slotKey) throw new DomainError("stale_revision", `schedule ${scheduleId} has moved on`);
    for (const s of plan.stale) notes.push({ scheduleId, localDate: s.key, reason: "the schedule was changed or resumed after this time, so no meeting is made for it" });
    const changes: Change[] = [];
    const cursor = new Date(slot.at).toISOString();
    let created = false;
    let occurrenceId = derivedId("mto", `${scheduleId}\0${slot.key}`);
    let ref: AggregateRef = { kind: "meeting-occurrence", id: occurrenceId };
    let mode: OccurrenceMode = "live";
    let skippedCount = 0;
    if (plan.live.length === 0) {
      ref = { kind: "meeting-schedule", id: scheduleId };
    } else {
      const startsMs = slot.at;
      const endsMs = startsMs + schedule.durationMinutes * 60_000;
      mode = nowMs >= endsMs ? "catch-up" : "live";
      const skipped = plan.live.slice(0, -1);
      skippedCount = skipped.length;
      const existing = await this.#runner.get("meeting-occurrence", occurrenceId);
      if (existing !== undefined) {
        notes.push({ scheduleId, localDate: slot.key, reason: "that date already had its meeting, so there is no second one" });
      } else {
        created = true;
        let agenda: { ids: string[]; changes: Change[]; overflow: number } = { ids: [], changes: [], overflow: 0 };
        const open = await this.#open(schedule.projectId);
        // A catch-up is a report: it is created already settled, waits for nothing and takes no place in the open lists. A live one waits to be held.
        if (mode === "live") {
          this.#checkOpenRoom(open);
          agenda = await this.#takeAgenda(schedule.projectId, schedule.roster, occurrenceId);
        }
        const participants = await this.#participants(schedule.roster);
        const body: OccurrenceBody = {
          scheduleId, projectId: schedule.projectId, kind: "scheduled", title: schedule.title, startsAt: cursor, endsAt: new Date(endsMs).toISOString(),
          ...(schedule.prepareMinutes > 0 ? { prepareFrom: new Date(startsMs - schedule.prepareMinutes * 60_000).toISOString() } : {}),
          timeZone: schedule.timeZone, localDate: slot.key, mode, state: mode === "live" ? "planned" : "reported", participants, agenda: agenda.ids, agendaOverflow: agenda.overflow,
          coversFrom: schedule.cursor, skippedSlots: skipped.slice(-MEETING_LIMITS.skippedListed).map((x) => x.key), skippedCount: skipped.length, skippedTruncated: plan.truncated,
          ...(schedule.budgetTokens === undefined ? {} : { budgetTokens: schedule.budgetTokens }), createdBy: by.id, createdAt: nowIso,
          ...(mode === "live" ? {} : { settledAt: nowIso, settledBy: by.id, settleReason: "catch-up report for the period; no meeting to hold" }),
        };
        changes.push({ type: "create", ref, body: clean(body) });
        if (mode === "live") changes.push(...this.#openChanges(open, [...open.ids, occurrenceId]));
        changes.push(...agenda.changes);
      }
    }
    const next = nextPrepare({ ...schedule, cursor });
    const updated: ScheduleBody = {
      ...schedule, cursor, ...(plan.live.length === 0 ? {} : { lastOccurrenceId: occurrenceId }), occurrences: schedule.occurrences + (created ? 1 : 0),
      ...(next === undefined ? {} : { nextPrepareAt: next }), state: next === undefined ? "ended" : "active",
    };
    if (next === undefined) delete (updated as { nextPrepareAt?: string }).nextPrepareAt;
    changes.unshift({ type: "update", ref: { kind: "meeting-schedule", id: scheduleId }, expectedRevision: found.revision, body: clean(updated) });
    // The record the command targets: the new occurrence, or (nothing new was made) the schedule it advanced.
    return { ref: created ? ref : { kind: "meeting-schedule", id: scheduleId }, creates: created, changes, detail: { scheduleId, localDate: slot.key, mode, skipped: skippedCount, stale: plan.stale.length, projectId: schedule.projectId } };
  }

  /** Occurrences still planned long after they ended become `missed`, and their agenda items go back to the queue. */
  async #sweep(by: Principal): Promise<string[]> {
    const missed: string[] = [];
    const nowMs = ms(this.#runner.now());
    const global = await this.#globalOpen();
    for (const projectId of global.projects) {
      const open = await this.#open(projectId);
      for (const id of open.ids) {
        const found = await this.#runner.get("meeting-occurrence", id);
        const body = found?.body as unknown as OccurrenceBody | undefined;
        if (found === undefined || body === undefined) continue;
        if (body.state === "planned" && nowMs >= ms(body.endsAt) + MEETING_LIMITS.graceMinutes * 60_000) {
          try { await this.#settle(by, id, "missed", `not held by ${MEETING_LIMITS.graceMinutes} minutes after its end`, undefined, `mtg-missed:${id}`); missed.push(id); } catch (error) {
            if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict")) throw error;
          }
        }
      }
    }
    return missed;
  }

  // ---- urgent meetings ----------------------------------------------------------------------------------------------------------

  /**
   * Calls a meeting now ("bring everyone into a meeting now"). The roster is explicit (resolving "the team" is the caller's job); the topic becomes an urgent agenda item, and so do the queued urgent items for these
   * participants. Absent or paused participants are listed as such and not woken. Needs `meeting.manage`.
   */
  async callUrgent(by: Principal, command: NoActor & { projectId: string; title: string; reason: string; roster: readonly string[]; durationMinutes?: number }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "title", "reason", "roster", "durationMinutes"]);
    const projectId = checkProjectId(command.projectId);
    await this.#requireManage(by, projectId);
    const title = plain(command.title, "title", MEETING_LIMITS.title);
    const reason = plain(command.reason, "reason", MEETING_LIMITS.reason);
    const roster = await this.#roster(command.roster, projectId);
    const durationMinutes = command.durationMinutes === undefined ? 30 : whole(command.durationMinutes, "durationMinutes", 1, MEETING_LIMITS.durationMax);
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("mto", `urgent\0${scoped}`);
    const topicId = derivedId("mag", `urgent\0${scoped}`);
    const result = await this.#retrying(() => this.#runner.command("meeting.urgent", { commandId: scoped, actor: by.id }, async () => ({
      payload: { projectId, title, reason, roster, durationMinutes },
      build: async () => {
        const nowIso = this.#runner.now();
        const open = await this.#open(projectId);
        this.#checkOpenRoom(open);
        const index = await this.#agendaIndex(projectId);
        // The topic is an item created already scheduled for this meeting; the other urgent items waiting for these people come with it.
        const others = await this.#takeAgenda(projectId, roster, id, { urgentOnly: true, room: MEETING_LIMITS.agendaPerMeeting - 1, indexIds: index.ids, indexRevision: index.revision });
        const topic: AgendaBody = {
          projectId, topic: title, question: reason, urgency: "urgent", intent: "discussion", participants: [], owner: by.id, requestedBy: by.id, state: "scheduled", occurrenceId: id, createdAt: nowIso, updatedAt: nowIso,
        };
        const startsAt = nowIso;
        const body: OccurrenceBody = {
          projectId, kind: "urgent", title, reason, startsAt, endsAt: new Date(ms(nowIso) + durationMinutes * 60_000).toISOString(), timeZone: "UTC", localDate: wallClock(ms(nowIso), "UTC").date, mode: "live", state: "planned",
          participants: await this.#participants(roster), agenda: [topicId, ...others.ids], agendaOverflow: others.overflow, skippedSlots: [], skippedCount: 0, skippedTruncated: false, createdBy: by.id, createdAt: nowIso,
        };
        const ref: AggregateRef = { kind: "meeting-occurrence", id };
        return {
          ref, creates: true,
          changes: [{ type: "create", ref, body: clean(body) }, { type: "create", ref: { kind: "agenda-item", id: topicId }, body: clean(topic) }, ...this.#openChanges(open, [...open.ids, id]), ...others.changes],
          detail: { projectId, kind: "urgent", participants: roster.length },
        };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  // ---- invitations ----------------------------------------------------------------------------------------------------------------

  /**
   * The owner invites one paused agent to one meeting by hand: it may attend this meeting only and its other work stays paused. A suspended or stopped agent is not woken by an invitation (that is the owner's
   * wake or recovery decision, made elsewhere), and an agent that is not on the roster cannot be added to a fixed roster.
   */
  async inviteDirect(by: Principal, command: NoActor & { occurrenceId: string; agent: string }): Promise<void> {
    onlyKnown(command, ["commandId", "occurrenceId", "agent"]);
    if (by.kind !== "owner" || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not invite a paused agent`);
    const id = this.#occurrenceId(command.occurrenceId);
    const agent = typeof command.agent === "string" && AGENT.test(command.agent) ? command.agent : invalid("agent", "is not an agent principal");
    await this.#retrying(() => this.#runner.command("meeting.invite.direct", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { occurrenceId: id, agent },
      build: async () => {
        const found = await this.#runner.get("meeting-occurrence", id);
        const body = found?.body as unknown as OccurrenceBody | undefined;
        if (found === undefined || body === undefined) throw new DomainError("not_found", `meeting ${id} does not exist`);
        if (body.state !== "planned" || body.mode !== "live") throw new DomainError("invalid_command", `meeting ${id} is not waiting to be held`, { field: "occurrenceId" });
        const seat = body.participants.find((p) => p.id === agent);
        if (seat === undefined) throw new DomainError("invalid_command", `${agent} is not on the roster of that meeting`, { field: "agent" });
        const availability = await this.#reach(agent);
        if (availability === "suspended" || availability === "stopped") throw new DomainError("invalid_command", `${agent} is ${availability}; an invitation does not wake it`, { field: "agent" });
        const status: ParticipantStatus = availability === "paused" ? "owner-invited" : "eligible";
        const participants = body.participants.map((p) => (p.id === agent ? { ...p, status, availability, ...(availability === "paused" ? { invitedBy: by.id, ownerInvitedAt: this.#runner.now() } : {}) } : p));
        const ref: AggregateRef = { kind: "meeting-occurrence", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean({ ...body, participants }) }], detail: { agent, projectId: body.projectId } };
      },
    })));
  }

  /**
   * Hands the invitations that may go out to the invitation sink, once each. Availability is looked at again first: an agent paused since the occurrence was made is withheld, one resumed since is now eligible, and
   * neither is woken by this. A catch-up report, a settled meeting or one past its end sends nothing. Delivery is at least once (the sink de-duplicates by `Invitation.key`); the record shows who was invited.
   */
  async dispatchInvitations(by: Principal, occurrenceId: string): Promise<{ invited: string[]; withheld: string[] }> {
    if (!isService(by) || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not send meeting invitations`);
    const id = this.#occurrenceId(occurrenceId);
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get("meeting-occurrence", id);
      const body = found?.body as unknown as OccurrenceBody | undefined;
      if (found === undefined || body === undefined) throw new DomainError("not_found", `meeting ${id} does not exist`);
      if (body.state !== "planned" || body.mode !== "live" || ms(this.#runner.now()) >= ms(body.endsAt)) return { invited: [], withheld: body.participants.filter((p) => p.status !== "eligible" && p.status !== "owner-invited").map((p) => p.id) };
      const decided: ParticipantRecord[] = [];
      const todo: ParticipantRecord[] = [];
      for (const p of body.participants) {
        const availability = await this.#reach(p.id);
        let status = p.status;
        if (p.status === "owner-invited") status = availability === "suspended" || availability === "stopped" ? "withheld-unavailable" : "owner-invited";
        else status = availability === "available" ? "eligible" : availability === "paused" ? "withheld-paused" : "withheld-unavailable";
        const next: ParticipantRecord = { ...p, status, availability };
        decided.push(next);
        if ((status === "eligible" || status === "owner-invited") && p.invitedAt === undefined) todo.push(next);
      }
      const sink = this.#sink;
      const at = this.#runner.now();
      const sent: string[] = [];
      if (sink !== undefined) for (const p of todo) {
        await sink.invite({ key: `${id}:${p.id}`, occurrenceId: id, projectId: body.projectId, agent: p.id, startsAt: body.startsAt, urgent: body.kind === "urgent", bounded: p.status === "owner-invited" });
        sent.push(p.id);
      }
      const participants = decided.map((p) => (sent.includes(p.id) ? { ...p, invitedAt: at } : p));
      try {
        await this.#runner.command("meeting.invite.dispatch", { commandId: `mti:${id}:${attempt}:${found.revision}`, actor: by.id }, async () => ({
          payload: { occurrenceId: id, revision: found.revision },
          build: async () => {
            const ref: AggregateRef = { kind: "meeting-occurrence", id };
            return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean({ ...body, participants }) }], detail: { projectId: body.projectId, invited: sent.length } };
          },
        }));
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= MEETING_LIMITS.retries) throw error;
        continue;
      }
      return { invited: sent, withheld: participants.filter((p) => p.status === "withheld-paused" || p.status === "withheld-unavailable").map((p) => p.id) };
    }
  }

  // ---- settling ----------------------------------------------------------------------------------------------------------------------

  /** Records that the meeting was held (owner, host or service only) or cancelled (also `meeting.manage`). Agenda items go back to the queue when it is cancelled; those a held meeting did not reach are deferred. */
  async settle(by: Principal, command: NoActor & { occurrenceId: string; outcome: "held" | "cancelled"; reason?: string }): Promise<void> {
    onlyKnown(command, ["commandId", "occurrenceId", "outcome", "reason"]);
    const id = this.#occurrenceId(command.occurrenceId);
    if (command.outcome !== "held" && command.outcome !== "cancelled") invalid("outcome", "must be held or cancelled");
    const reason = command.outcome === "cancelled" ? plain(command.reason, "reason", MEETING_LIMITS.reason) : optionalPlain(command.reason, "reason", MEETING_LIMITS.reason);
    await this.#settle(by, id, command.outcome, reason, command.commandId);
  }

  async #settle(by: Principal, id: string, outcome: "held" | "cancelled" | "missed", reason: string | undefined, userCommandId: unknown, fixedCommandId?: string): Promise<void> {
    const commandId = fixedCommandId ?? scopedCommandId(by.id, userCommandId);
    await this.#retrying(() => this.#runner.command("meeting.settle", { commandId, actor: by.id }, async () => ({
      payload: { occurrenceId: id, outcome, ...(reason === undefined ? {} : { reason }) },
      build: async () => {
        const found = await this.#runner.get("meeting-occurrence", id);
        const body = found?.body as unknown as OccurrenceBody | undefined;
        const allowed = body !== undefined && (outcome === "cancelled" ? allows(by, "meeting.manage", body.projectId) || isService(by) : isService(by));
        // Whoever may not settle it, and a meeting that is not there, get the same answer.
        if (found === undefined || body === undefined || !allowed || (by.taskScope !== undefined && !inTaskScope(by, body.projectId))) throw new DomainError("forbidden", `${by.id} may not settle that meeting`);
        if (body.state !== "planned") throw new DomainError("invalid_command", `meeting ${id} is already ${body.state}`, { field: "occurrenceId" });
        const nowIso = this.#runner.now();
        const open = await this.#open(body.projectId);
        const index = await this.#agendaIndex(body.projectId);
        const ids = [...index.ids];
        const changes: Change[] = [];
        let unlisted = 0;
        const returns = await this.#returnsIndex(body.projectId);
        const returnIds = [...returns.ids];
        const returnMore = [...returns.more];
        let returnsUnlisted = 0;
        for (const itemId of body.agenda) {
          const item = await this.#runner.get("agenda-item", itemId);
          const ib = item?.body as unknown as AgendaBody | undefined;
          if (item === undefined || ib === undefined || ib.state !== "scheduled" || ib.occurrenceId !== id) continue;
          const { occurrenceId: _o, deferral: _d, outcomeNote: _n, returnedAt: _r, returnUnlisted: _ru, ...rest } = ib;
          void _o; void _d; void _n; void _r; void _ru;
          // A topic from a conversation that the meeting did not reach is told so there, with its reason and next step.
          const placed = outcome === "held" && ib.source !== undefined ? this.#place(returnIds, returnMore, itemId) : undefined;
          if (placed !== undefined && placed !== "listed") returnsUnlisted++;
          // The open list holds 200 at most: an item that does not fit stays queued (or deferred) but marked unlisted, and the meeting counts them.
          const fits = ids.includes(itemId) || ids.length < MEETING_LIMITS.openAgendaPerProject;
          if (!fits) unlisted++;
          const next: AgendaBody = outcome === "held"
            ? { ...rest, state: "deferred", deferral: { reason: "the meeting did not reach it", nextStep: "it is on the next meeting's agenda" }, updatedAt: nowIso, ...(fits ? {} : { unlisted: true }), ...(placed === undefined || placed === "listed" ? {} : { returnUnlisted: true as const }) }
            : { ...rest, state: "queued", updatedAt: nowIso, ...(ib.deferral === undefined ? {} : { deferral: ib.deferral }), ...(fits ? {} : { unlisted: true }) };
          changes.push({ type: "update", ref: { kind: "agenda-item", id: itemId }, expectedRevision: item.revision, body: clean(next) });
          if (fits && !ids.includes(itemId)) ids.push(itemId);
        }
        const ref: AggregateRef = { kind: "meeting-occurrence", id };
        const settled: OccurrenceBody = { ...body, state: outcome, settledAt: nowIso, settledBy: by.id, ...(reason === undefined ? {} : { settleReason: reason }), ...(unlisted === 0 ? {} : { agendaUnlisted: unlisted }), ...(returnsUnlisted === 0 ? {} : { returnsUnlisted }) };
        const all: Change[] = [{ type: "update", ref, expectedRevision: found.revision, body: clean(settled) }, ...this.#openChanges(open, open.ids.filter((x) => x !== id)), ...changes];
        if (ids.length !== index.ids.length) all.push(this.#agendaChange(body.projectId, index, ids));
        if (returnIds.length !== returns.ids.length || returnMore.length !== returns.more.length) all.push(this.#returnsChange(body.projectId, returns, returnIds, returnMore));
        return { ref, creates: false, changes: all, detail: { outcome, projectId: body.projectId } };
      },
    })));
  }

  // ---- agenda --------------------------------------------------------------------------------------------------------------------------

  /**
   * Saves a topic for a later meeting. The requester needs `meeting.agenda` (or `meeting.manage`) in the project, or is the owner. A topic that asks for an owner instruction or a decision delegated to the team is recorded only
   * by the owner: a supervisor's paraphrase cannot turn a tentative idea into an instruction. The source link, if given, must be a conversation the requester can see (an inquiry) or an owner chat turn.
   */
  async addAgendaItem(by: Principal, command: NoActor & {
    projectId: string; topic: string; question?: string; context?: string; requestedOutcome?: string; urgency?: AgendaUrgency; intent?: AgendaIntent; participants?: readonly string[];
    source?: { kind: "inquiry" | "chat-turn"; id: string }; category?: AgendaCategory; timeboxMinutes?: number; link?: { kind: "improvement"; id: string };
  }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "topic", "question", "context", "requestedOutcome", "urgency", "intent", "participants", "source", "category", "timeboxMinutes", "link"]);
    const projectId = checkProjectId(command.projectId);
    if (!(allows(by, "meeting.agenda", projectId) || allows(by, "meeting.manage", projectId)) || !(await this.#projectExists(projectId))) throw new DomainError("forbidden", `${by.id} may not add agenda items in that project`);
    const topic = plain(command.topic, "topic", MEETING_LIMITS.topic);
    const question = optionalPlain(command.question, "question", MEETING_LIMITS.question);
    const context = optionalPlain(command.context, "context", MEETING_LIMITS.context);
    const requestedOutcome = optionalPlain(command.requestedOutcome, "requestedOutcome", MEETING_LIMITS.outcome);
    const urgency: AgendaUrgency = command.urgency === undefined ? "normal" : (command.urgency === "normal" || command.urgency === "urgent" ? command.urgency : invalid("urgency", "must be normal or urgent"));
    const intent: AgendaIntent = command.intent === undefined ? "discussion" : (["discussion", "recommendation", "delegated-decision", "owner-instruction"].includes(command.intent as string) ? command.intent : invalid("intent", "must be discussion, recommendation, delegated-decision or owner-instruction")) as AgendaIntent;
    if ((intent === "owner-instruction" || intent === "delegated-decision") && by.kind !== "owner") throw new DomainError("forbidden", `only the owner can record a topic as ${intent.replace("-", " ")}`);
    const participants = command.participants === undefined ? [] : this.#names(command.participants, "participants");
    const source = await this.#source(by, projectId, command.source);
    const category = this.#category(by, projectId, command.category);
    const timeboxMinutes = command.timeboxMinutes === undefined ? undefined : whole(command.timeboxMinutes, "timeboxMinutes", 1, MEETING_LIMITS.timeboxMax);
    const link = await this.#link(by, projectId, command.link);
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("mag", scoped);
    const result = await this.#retrying(() => this.#runner.command("meeting.agenda.add", { commandId: scoped, actor: by.id }, async () => ({
      payload: clean({ projectId, topic, question, context, requestedOutcome, urgency, intent, participants, source, category, timeboxMinutes, link }),
      build: async () => {
        const index = await this.#agendaIndex(projectId);
        if (index.ids.length >= MEETING_LIMITS.openAgendaPerProject) throw new DomainError("unavailable", `${MEETING_LIMITS.openAgendaPerProject} agenda items are already open in this project; settle some first`);
        const nowIso = this.#runner.now();
        const body: AgendaBody = { projectId, topic, ...(question === undefined ? {} : { question }), ...(context === undefined ? {} : { context }), ...(requestedOutcome === undefined ? {} : { requestedOutcome }), urgency, intent, ...(category === undefined ? {} : { category }), ...(timeboxMinutes === undefined ? {} : { timeboxMinutes }), ...(link === undefined ? {} : { link }), participants, owner: by.id, requestedBy: by.id, ...(source === undefined ? {} : { source }), state: "queued", createdAt: nowIso, updatedAt: nowIso };
        const ref: AggregateRef = { kind: "agenda-item", id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, this.#agendaChange(projectId, index, [...index.ids, id])], detail: { projectId, urgency, intent } };
      },
    })));
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * Moves an item along: `discussed`, `resolved` (with an optional link to the outcome), `deferred` (with a reason and a next step; it stays open and comes back on the next agenda) or `queued` again. The item's owner or
   * someone with `meeting.manage` does it. A resolved item is final.
   */
  async setAgendaState(by: Principal, command: NoActor & { itemId: string; expectedRevision: number; to: "discussed" | "resolved" | "deferred" | "queued"; reason?: string; nextStep?: string; outcomeRef?: string; outcomeNote?: string }): Promise<void> {
    onlyKnown(command, ["commandId", "itemId", "expectedRevision", "to", "reason", "nextStep", "outcomeRef", "outcomeNote"]);
    const id = typeof command.itemId === "string" && AGENDA_ID.test(command.itemId) ? command.itemId : invalid("itemId", "is not an agenda item ID");
    const expected = checkRevision(command.expectedRevision);
    if (!["discussed", "resolved", "deferred", "queued"].includes(command.to as string)) invalid("to", "must be discussed, resolved, deferred or queued");
    const to = command.to;
    const reason = to === "deferred" ? plain(command.reason, "reason", MEETING_LIMITS.deferral) : undefined;
    const nextStep = to === "deferred" ? plain(command.nextStep, "nextStep", MEETING_LIMITS.deferral) : undefined;
    if (to !== "deferred" && (command.reason !== undefined || command.nextStep !== undefined)) invalid("reason", "only a deferral carries a reason and a next step");
    const outcomeRef = command.outcomeRef === undefined ? undefined : (to === "resolved" || to === "discussed" ? plain(command.outcomeRef, "outcomeRef", MEETING_LIMITS.ref) : invalid("outcomeRef", "only a discussed or resolved item links an outcome"));
    const outcomeNote = command.outcomeNote === undefined ? undefined : (to === "queued" ? invalid("outcomeNote", "a queued item has no outcome yet") : plain(command.outcomeNote, "outcomeNote", MEETING_LIMITS.outcome));
    await this.#retrying(() => this.#runner.command("meeting.agenda.state", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ itemId: id, expectedRevision: expected, to, reason, nextStep, outcomeRef, outcomeNote }),
      build: async () => {
        const found = await this.#runner.get("agenda-item", id);
        const body = found?.body as unknown as AgendaBody | undefined;
        const allowed = body !== undefined && (allows(by, "meeting.manage", body.projectId) || (by.id === body.owner && allows(by, "meeting.agenda", body.projectId)));
        if (found === undefined || body === undefined || !allowed) throw new DomainError("forbidden", `${by.id} may not change that agenda item`);
        if (found.revision !== expected) throw new DomainError("stale_revision", `agenda item ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
        const legal: Readonly<Record<AgendaState, readonly AgendaState[]>> = {
          queued: ["deferred", "resolved"], scheduled: ["discussed", "deferred", "resolved", "queued"], discussed: ["resolved", "deferred"], deferred: ["queued", "resolved"], resolved: [],
        };
        // An item that did not fit on the full open list can be listed again (queued to queued) once there is room.
        const relist = body.state === "queued" && to === "queued" && body.unlisted === true;
        if (!relist && !legal[body.state].includes(to)) throw new DomainError("invalid_command", `agenda item ${id} is ${body.state}; it cannot become ${to}`, { field: "to" });
        const { occurrenceId: keepOccurrence, deferral: _d, outcomeRef: _o, unlisted: _u, outcomeNote: _n, returnedAt: _r, returnUnlisted: _ru, ...rest } = body;
        void _d; void _o; void _u; void _n; void _r; void _ru;
        // An outcome of a topic that came from a conversation is queued to go back to it, in the same commit as the state change. A full list never blocks the change: the outcome goes on the overflow list (or is counted).
        const returns = await this.#returnsIndex(body.projectId);
        const returnIds = [...returns.ids];
        const returnMore = [...returns.more];
        const returning = body.source !== undefined && (to === "discussed" || to === "resolved" || to === "deferred");
        const placed = returning ? this.#place(returnIds, returnMore, id) : undefined;
        if (!returning) { const a = returnIds.indexOf(id); if (a >= 0) returnIds.splice(a, 1); const b = returnMore.indexOf(id); if (b >= 0) returnMore.splice(b, 1); }
        const nowIso = this.#runner.now();
        const stays = to === "discussed" ? keepOccurrence : undefined;
        const next: AgendaBody = {
          ...rest, state: to, updatedAt: nowIso, ...(stays === undefined ? {} : { occurrenceId: stays }),
          ...(to === "deferred" ? { deferral: { reason: reason as string, nextStep: nextStep as string } } : {}),
          ...(outcomeRef === undefined ? (body.outcomeRef === undefined || to === "queued" ? {} : { outcomeRef: body.outcomeRef }) : { outcomeRef }),
          ...(outcomeNote === undefined ? {} : { outcomeNote }),
          ...(placed === undefined || placed === "listed" ? {} : { returnUnlisted: true as const }),
        };
        // Open means queued or deferred: those are in the project's index; the rest are not.
        const index = await this.#agendaIndex(body.projectId);
        const openNow = (s: AgendaState): boolean => s === "queued" || s === "deferred";
        if (openNow(to) && !index.ids.includes(id) && index.ids.length >= MEETING_LIMITS.openAgendaPerProject) throw new DomainError("unavailable", `${MEETING_LIMITS.openAgendaPerProject} agenda items are already open in this project; settle some first`);
        const ids = openNow(to) ? (index.ids.includes(id) ? index.ids : [...index.ids, id]) : index.ids.filter((x) => x !== id);
        const ref: AggregateRef = { kind: "agenda-item", id };
        const changes: Change[] = [{ type: "update", ref, expectedRevision: found.revision, body: clean(next) }];
        if (ids.length !== index.ids.length) changes.push(this.#agendaChange(body.projectId, index, ids));
        if (returnIds.length !== returns.ids.length || returnMore.length !== returns.more.length) changes.push(this.#returnsChange(body.projectId, returns, returnIds, returnMore));
        return { ref, creates: false, changes, detail: { projectId: body.projectId, to } };
      },
    })));
  }

  /**
   * Corrects a captured item (card M03): the owner sees what the supervisor wrote in chat and fixes it. The item's own requester (with `meeting.agenda`), a manager or the owner may do it while the item is still open
   * (queued, scheduled or deferred); a discussed or resolved item is history. A field given as `null` is cleared. The request type is authority: only the owner may set an instruction or a decision delegated to the team, or
   * change an item that already is one, so a correction by someone else can neither promote a tentative idea nor rewrite what the owner decided. The revision read must still be current; each correction is counted and its fields kept (ten at most).
   */
  async correctAgendaItem(by: Principal, command: NoActor & {
    itemId: string; expectedRevision: number; topic?: string; question?: string | null; context?: string | null; requestedOutcome?: string | null; urgency?: AgendaUrgency; intent?: AgendaIntent;
    participants?: readonly string[]; category?: AgendaCategory | null; timeboxMinutes?: number | null;
  }): Promise<{ revision: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "itemId", "expectedRevision", "topic", "question", "context", "requestedOutcome", "urgency", "intent", "participants", "category", "timeboxMinutes"]);
    const id = typeof command.itemId === "string" && AGENDA_ID.test(command.itemId) ? command.itemId : invalid("itemId", "is not an agenda item ID");
    const expected = checkRevision(command.expectedRevision);
    const patch: Record<string, unknown> = {};
    if (command.topic !== undefined) patch["topic"] = plain(command.topic, "topic", MEETING_LIMITS.topic);
    if (command.question !== undefined) patch["question"] = command.question === null ? null : plain(command.question, "question", MEETING_LIMITS.question);
    if (command.context !== undefined) patch["context"] = command.context === null ? null : plain(command.context, "context", MEETING_LIMITS.context);
    if (command.requestedOutcome !== undefined) patch["requestedOutcome"] = command.requestedOutcome === null ? null : plain(command.requestedOutcome, "requestedOutcome", MEETING_LIMITS.outcome);
    if (command.urgency !== undefined) patch["urgency"] = command.urgency === "normal" || command.urgency === "urgent" ? command.urgency : invalid("urgency", "must be normal or urgent");
    if (command.intent !== undefined) patch["intent"] = (["discussion", "recommendation", "delegated-decision", "owner-instruction"].includes(command.intent as string) ? command.intent : invalid("intent", "must be discussion, recommendation, delegated-decision or owner-instruction"));
    if (command.participants !== undefined) patch["participants"] = this.#names(command.participants, "participants");
    if (command.category !== undefined) patch["category"] = command.category === null ? null : (AGENDA_CATEGORIES.includes(command.category) ? command.category : invalid("category", `must be one of ${AGENDA_CATEGORIES.join(", ")}`));
    if (command.timeboxMinutes !== undefined) patch["timeboxMinutes"] = command.timeboxMinutes === null ? null : whole(command.timeboxMinutes, "timeboxMinutes", 1, MEETING_LIMITS.timeboxMax);
    if (Object.keys(patch).length === 0) invalid("topic", "nothing to correct: give at least one field");
    const result = await this.#retrying(() => this.#runner.command("meeting.agenda.correct", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ itemId: id, expectedRevision: expected, ...patch }),
      build: async () => {
        const found = await this.#runner.get("agenda-item", id);
        const body = found?.body as unknown as AgendaBody | undefined;
        const allowed = body !== undefined && inTaskScope(by, body.projectId) && (by.kind === "owner" || allows(by, "meeting.manage", body.projectId) || (by.id === body.requestedBy && allows(by, "meeting.agenda", body.projectId)));
        if (found === undefined || body === undefined || !allowed) throw new DomainError("forbidden", `${by.id} may not change that agenda item`);
        if (found.revision !== expected) throw new DomainError("stale_revision", `agenda item ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
        if (body.state === "discussed" || body.state === "resolved") throw new DomainError("invalid_command", `agenda item ${id} is ${body.state}; it can no longer be corrected`, { field: "itemId" });
        const authority = (i: AgendaIntent): boolean => i === "owner-instruction" || i === "delegated-decision";
        if (by.kind !== "owner" && (authority(body.intent) || (patch["intent"] !== undefined && authority(patch["intent"] as AgendaIntent)))) throw new DomainError("forbidden", "only the owner can set or change an instruction or a decision delegated to the team");
        if (patch["category"] === "conflict" && !(by.kind === "owner" || allows(by, "meeting.manage", body.projectId))) throw new DomainError("forbidden", `${by.id} may not record a conflict; raise it as a question`);
        const next: Record<string, unknown> = { ...body };
        const fields: string[] = [];
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete next[key]; else next[key] = value;
          fields.push(key);
        }
        const nowIso = this.#runner.now();
        const log = [...(body.corrections ?? []), { at: nowIso, by: by.id, fields }].slice(-MEETING_LIMITS.corrections);
        const out = { ...next, updatedAt: nowIso, corrections: log, correctionCount: (body.correctionCount ?? 0) + 1 };
        const ref: AggregateRef = { kind: "agenda-item", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean(out as object) }], detail: { projectId: body.projectId, fields } };
      },
    })));
    return { revision: result.revision, replayed: result.replayed };
  }

  /**
   * Outcomes waiting to go back to the conversation their topic came from (a chat turn or an inquiry): items that were discussed, resolved or deferred (also by a meeting that did not reach them) and not yet handed back, oldest first, paged.
   * Owner, host or service only; the delivery itself is the caller's (`markOutcomeReturned` records it, once the conversation has the text).
   */
  async outcomesToReturn(by: Principal, projectId: string, page: { afterId?: string; limit?: number } = {}): Promise<{ items: View<AgendaBody>[]; next?: string }> {
    if (!isService(by) || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not collect agenda outcomes`);
    const project = checkProjectId(projectId);
    const limit = page.limit === undefined ? 20 : whole(page.limit, "limit", 1, MEETING_LIMITS.page);
    const index = await this.#returnsIndex(project);
    const start = page.afterId === undefined ? 0 : index.ids.indexOf(page.afterId) + 1;
    if (page.afterId !== undefined && start === 0) invalid("afterId", "is not in the list");
    const items: View<AgendaBody>[] = [];
    let pos = start;
    for (; pos < index.ids.length && items.length < limit; pos++) {
      const found = await this.#runner.get("agenda-item", index.ids[pos]!);
      if (found !== undefined) items.push(view<AgendaBody>(found));
    }
    return { items, ...(pos < index.ids.length ? { next: index.ids[pos - 1]! } : {}) };
  }

  /**
   * Records that an item's outcome reached its conversation and takes it off the waiting list. Owner, host or service only. `revision` is the revision of the item that was delivered: if the item has moved on since (a newer outcome), it stays
   * waiting and false is returned, so the newer outcome is still sent. Repeating it changes nothing.
   */
  async markOutcomeReturned(by: Principal, itemId: string, revision: number): Promise<boolean> {
    if (!isService(by) || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not record a returned outcome`);
    const id = typeof itemId === "string" && AGENDA_ID.test(itemId) ? itemId : invalid("itemId", "is not an agenda item ID");
    const delivered = checkRevision(revision);
    return this.#retrying(async () => {
      const found = await this.#runner.get("agenda-item", id);
      const body = found?.body as unknown as AgendaBody | undefined;
      if (found === undefined || body === undefined) throw new DomainError("not_found", `agenda item ${id} does not exist`);
      if (found.revision !== delivered) return false;
      if (!(await this.#returnsIndex(body.projectId)).ids.includes(id)) return true;
      await this.#runner.command("meeting.agenda.returned", { commandId: `mar:${id}:${found.revision}`, actor: by.id }, async () => ({
        payload: { itemId: id, revision: found.revision },
        build: async () => {
          const ref: AggregateRef = { kind: "agenda-item", id };
          const returns = await this.#returnsIndex(body.projectId);
          if (!returns.ids.includes(id)) throw new DomainError("stale_revision", `agenda item ${id} changed`, { currentRevision: found.revision });
          const nowIso = this.#runner.now();
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean({ ...body, returnedAt: nowIso }) }, this.#returnsChange(body.projectId, returns, returns.ids.filter((x) => x !== id), returns.more)], detail: { projectId: body.projectId } };
        },
      }));
      return true;
    });
  }

  /**
   * Lists the outcomes that did not fit on the waiting list, now that there is room (oldest first). Owner, host or service only; `deliverOutcomes` calls it first. Returns how many were listed and how many still wait on the overflow list.
   * Outcomes that fitted on neither list are not found again (they are marked `returnUnlisted` on their items and counted by the settling meeting).
   */
  async requeueReturns(by: Principal, projectId: string): Promise<{ listed: number; stillWaiting: number }> {
    if (!isService(by) || by.taskScope !== undefined) throw new DomainError("forbidden", `${by.id} may not requeue agenda outcomes`);
    const project = checkProjectId(projectId);
    return this.#retrying(async () => {
      const returns = await this.#returnsIndex(project);
      const room = this.#capListed - returns.ids.length;
      const take = returns.more.slice(0, Math.max(0, room));
      if (take.length === 0) return { listed: 0, stillWaiting: returns.more.length };
      const moves: { id: string; revision: number; body: AgendaBody }[] = [];
      for (const id of take) { const f = await this.#runner.get("agenda-item", id); if (f !== undefined) moves.push({ id, revision: f.revision, body: f.body as unknown as AgendaBody }); }
      await this.#runner.command("meeting.agenda.requeue", { commandId: `mrq:${project}:${returns.revision}`, actor: by.id }, async () => ({
        payload: { projectId: project, revision: returns.revision },
        build: async () => {
          const ref: AggregateRef = { kind: "agenda-returns", id: project };
          const changes: Change[] = [this.#returnsChange(project, returns, [...returns.ids, ...moves.map((m) => m.id)], returns.more.filter((x) => !take.includes(x)))];
          for (const m of moves) { const { returnUnlisted: _u, ...rest } = m.body; void _u; changes.push({ type: "update", ref: { kind: "agenda-item", id: m.id }, expectedRevision: m.revision, body: clean(rest) }); }
          return { ref, creates: false, changes, detail: { projectId: project, listed: moves.length } };
        },
      }));
      return { listed: moves.length, stillWaiting: returns.more.length - take.length };
    });
  }

  /** How many outcomes wait to be returned to their conversations (listed and on the overflow list), for the agenda. Needs `meeting.read` (or the owner); otherwise undefined. */
  async returnsWaiting(viewer: Principal, projectId: string): Promise<number | undefined> {
    const project = checkProjectId(projectId);
    if (!this.#mayRead(viewer, project)) return undefined;
    const r = await this.#returnsIndex(project);
    return r.ids.length + r.more.length;
  }

  /** Open agenda items (queued or deferred) of a project, in the order a meeting takes them. Needs `meeting.read` (or the owner). Paged: `next` is where to continue. */
  async openAgenda(viewer: Principal, projectId: string, page: { afterId?: string; limit?: number } = {}): Promise<{ items: View<AgendaBody>[]; next?: string } | undefined> {
    const project = checkProjectId(projectId);
    if (!this.#mayRead(viewer, project)) return undefined;
    const limit = page.limit === undefined ? 20 : whole(page.limit, "limit", 1, MEETING_LIMITS.page);
    const index = await this.#agendaIndex(project);
    // The whole open list (200 at most) is ordered first, then paged, so the order is the same on every page.
    const all: View<AgendaBody>[] = [];
    for (const id of index.ids) { const found = await this.#runner.get("agenda-item", id); if (found !== undefined) all.push(view<AgendaBody>(found)); }
    const sorted = sortItems(all);
    const start = page.afterId === undefined ? 0 : sorted.findIndex((i) => i.id === page.afterId) + 1;
    if (page.afterId !== undefined && start === 0) invalid("afterId", "is not in the agenda");
    const items = sorted.slice(start, start + limit);
    return { items, ...(start + limit < sorted.length ? { next: items[items.length - 1]!.id } : {}) };
  }

  /** The item as this viewer may see it: `meeting.read` in its project, the owner, or its requester. Anyone else gets `undefined`, as for an item that does not exist. */
  async agendaItem(viewer: Principal, itemId: string): Promise<View<AgendaBody> | undefined> {
    const found = typeof itemId === "string" && AGENDA_ID.test(itemId) ? await this.#runner.get("agenda-item", itemId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as AgendaBody;
    return this.#mayRead(viewer, body.projectId) || (viewer.id === body.requestedBy && inTaskScope(viewer, body.projectId)) ? view<AgendaBody>(found) : undefined;
  }

  /** The occurrence with its agenda, for someone who may read the project's meetings or who is on its roster. Anyone else gets `undefined`. */
  async occurrence(viewer: Principal, occurrenceId: string): Promise<{ occurrence: View<OccurrenceBody>; agenda: View<AgendaBody>[] } | undefined> {
    const found = typeof occurrenceId === "string" && OCCURRENCE_ID.test(occurrenceId) ? await this.#runner.get("meeting-occurrence", occurrenceId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as OccurrenceBody;
    const onRoster = body.participants.some((p) => p.id === viewer.id) && inTaskScope(viewer, body.projectId) && viewer.asOf !== undefined;
    if (!this.#mayRead(viewer, body.projectId) && !onRoster) return undefined;
    const agenda: View<AgendaBody>[] = [];
    for (const id of body.agenda) { const item = await this.#runner.get("agenda-item", id); if (item !== undefined) agenda.push(view<AgendaBody>(item)); }
    return { occurrence: view<OccurrenceBody>(found), agenda };
  }

  /** The occurrences of one project's meetings that are still waiting (planned), oldest first, paged; `next` is where to continue. Needs `meeting.read`. */
  async planned(viewer: Principal, projectId: string, page: { afterId?: string; limit?: number } = {}): Promise<{ items: View<OccurrenceBody>[]; next?: string } | undefined> {
    const project = checkProjectId(projectId);
    if (!this.#mayRead(viewer, project)) return undefined;
    const limit = page.limit === undefined ? 20 : whole(page.limit, "limit", 1, MEETING_LIMITS.page);
    const open = await this.#open(project);
    const start = page.afterId === undefined ? 0 : open.ids.indexOf(page.afterId) + 1;
    if (page.afterId !== undefined && start === 0) invalid("afterId", "is not in the list");
    const items: View<OccurrenceBody>[] = [];
    let pos = start;
    for (; pos < open.ids.length && items.length < limit; pos++) {
      const found = await this.#runner.get("meeting-occurrence", open.ids[pos]!);
      const body = found?.body as unknown as OccurrenceBody | undefined;
      if (found !== undefined && body !== undefined && body.projectId === project && body.state === "planned") items.push(view<OccurrenceBody>(found));
    }
    return { items, ...(pos < open.ids.length ? { next: open.ids[pos - 1]! } : {}) };
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------------------------

  /** Whether the agent can be reached. Fails closed: a missing or failing hook means "stopped", so the agent is withheld, never invited on a guess. */
  async #reach(id: string): Promise<Availability> {
    try { return this.#availability === undefined ? "stopped" : await this.#availability(id); } catch { return "stopped"; }
  }

  #mayRead(viewer: Principal, projectId: string): boolean { return allows(viewer, "meeting.read", projectId) || allows(viewer, "meeting.manage", projectId); }

  async #projectExists(projectId: string): Promise<boolean> { return (await this.#runner.get("project", projectId)) !== undefined; }

  async #requireManage(by: Principal, projectId: string): Promise<void> {
    if (!allows(by, "meeting.manage", projectId) || !(await this.#projectExists(projectId))) throw new DomainError("forbidden", `${by.id} may not manage meetings in that project`);
  }

  #occurrenceId(value: unknown): string { return typeof value === "string" && OCCURRENCE_ID.test(value) ? value : invalid("occurrenceId", "is not a meeting ID"); }

  #names(value: unknown, field: string): string[] {
    if (!Array.isArray(value) || value.length > MEETING_LIMITS.participants) return invalid(field, `must be a list of at most ${MEETING_LIMITS.participants} agent principals`);
    const out = value.map((v) => (typeof v === "string" && AGENT.test(v) ? v : invalid(field, `${JSON.stringify(v)} is not an agent principal`)));
    return [...new Set(out)].sort();
  }

  /** A fixed roster: known, active agents, each once. Nothing else can be on it, so no meeting can be given extra voices. */
  async #roster(value: unknown, projectId: string): Promise<string[]> {
    if (!Array.isArray(value) || value.length < 1 || value.length > MEETING_LIMITS.roster) invalid("roster", `must list 1 to ${MEETING_LIMITS.roster} agent principals`);
    const roster = this.#names(value, "roster");
    for (const id of roster) {
      const found = await this.#runner.get("principal", id);
      const body = found?.body as unknown as { kind?: string; state?: string } | undefined;
      if (found === undefined || body?.kind !== "agent" || body.state !== "active") invalid("roster", `${id} is not an active agent`);
    }
    void projectId;
    return roster;
  }

  async #participants(roster: readonly string[]): Promise<ParticipantRecord[]> {
    const out: ParticipantRecord[] = [];
    for (const id of roster) {
      const availability = await this.#reach(id);
      out.push({ id, availability, status: availability === "available" ? "eligible" : availability === "paused" ? "withheld-paused" : "withheld-unavailable" });
    }
    return out;
  }

  /** A stated category; a conflict is recorded by the owner or a manager only. */
  #category(by: Principal, projectId: string, value: unknown): AgendaCategory | undefined {
    if (value === undefined) return undefined;
    if (typeof value !== "string" || !AGENDA_CATEGORIES.includes(value as AgendaCategory)) return invalid("category", `must be one of ${AGENDA_CATEGORIES.join(", ")}`);
    if (value === "conflict" && !(by.kind === "owner" || allows(by, "meeting.manage", projectId))) throw new DomainError("forbidden", `${by.id} may not record a conflict; raise it as a question`);
    return value as AgendaCategory;
  }

  /** A link to an improvement backlog item of this project; managers and the owner only (the item is what the topic is about, and the link shows nothing of it). */
  async #link(by: Principal, projectId: string, value: unknown): Promise<{ kind: "improvement"; id: string } | undefined> {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("link", "must be an object with kind and id");
    onlyKnown(value, ["kind", "id"]);
    const l = value as { kind?: unknown; id?: unknown };
    if (l.kind !== "improvement" || typeof l.id !== "string" || !IMPROVEMENT_ID.test(l.id)) return invalid("link", "must name an improvement backlog item");
    const found = await this.#runner.get("improvement-item", l.id);
    if (found === undefined || (found.body as unknown as { projectId?: string }).projectId !== projectId || !(by.kind === "owner" || allows(by, "meeting.manage", projectId))) invalid("link", "must be an improvement item of this project that the requester may link");
    return { kind: "improvement", id: l.id };
  }

  async #source(by: Principal, projectId: string, value: unknown): Promise<{ kind: "inquiry" | "chat-turn"; id: string } | undefined> {
    if (value === undefined) return undefined;
    if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("source", "must be an object with kind and id");
    onlyKnown(value, ["kind", "id"]);
    const s = value as { kind?: unknown; id?: unknown };
    if (typeof s.id !== "string" || s.id.length > MEETING_LIMITS.ref) invalid("source.id", "is not a record ID");
    if (s.kind === "inquiry") {
      const seen = this.#inquiries === undefined ? undefined : await this.#inquiries.view(by, s.id as string);
      if (seen === undefined || seen.inquiry.projectId !== projectId) invalid("source", "must be an inquiry in this project that the requester can see");
      return { kind: "inquiry", id: s.id as string };
    }
    if (s.kind === "chat-turn") {
      // The owner's chat is the owner's: only the owner, or a manager of this project's meetings acting for a topic raised there, may point to one. The link shows nothing of its content.
      // Missing, in another project, or not linkable by this requester: one answer.
      const found = await this.#runner.get("chat-turn", s.id as string);
      const turnProject = (found?.body as unknown as { projectId?: string } | undefined)?.projectId;
      if (found === undefined || turnProject !== projectId || !(by.kind === "owner" || allows(by, "meeting.manage", projectId))) invalid("source", "must be a conversation turn the requester may link");
      return { kind: "chat-turn", id: s.id as string };
    }
    return invalid("source.kind", "must be inquiry or chat-turn");
  }

  /**
   * The waiting (planned, live) meetings of one project, and the global count and list of projects that have any. The project list is capped at 200 and the global count at 1000, so one busy project cannot block another
   * until the whole installation is full. Every creation and settlement writes both records under revision checks: concurrent creations in *any* project contend on the global record and the loser retries (a known cost of the global cap).
   */
  async #open(projectId: string): Promise<OpenState> {
    const p = await this.#runner.get("meeting-open", projectId);
    const g = await this.#runner.get("meeting-open", GLOBAL_OPEN);
    const gb = g?.body as unknown as { count: number; projects: string[] } | undefined;
    return { projectId, ids: p === undefined ? [] : (p.body as unknown as IndexBody).ids, pRevision: p?.revision ?? 0, count: gb?.count ?? 0, projects: gb?.projects ?? [], gRevision: g?.revision ?? 0 };
  }

  async #globalOpen(): Promise<{ projects: readonly string[] }> {
    const g = await this.#runner.get("meeting-open", GLOBAL_OPEN);
    return { projects: (g?.body as unknown as { projects: string[] } | undefined)?.projects ?? [] };
  }

  #checkOpenRoom(open: OpenState): void {
    if (open.ids.length >= MEETING_LIMITS.openOccurrencesPerProject) throw new DomainError("unavailable", `${MEETING_LIMITS.openOccurrencesPerProject} meetings of this project are already waiting to be held or settled`);
    if (open.count >= MEETING_LIMITS.openOccurrences) throw new DomainError("unavailable", `${MEETING_LIMITS.openOccurrences} meetings are already waiting to be held or settled`);
  }

  #openChanges(open: OpenState, ids: readonly string[]): Change[] {
    const pRef: AggregateRef = { kind: "meeting-open", id: open.projectId };
    const gRef: AggregateRef = { kind: "meeting-open", id: GLOBAL_OPEN };
    const pBody = { ids: [...ids] } as unknown as JsonObject;
    const projects = ids.length > 0 ? [...new Set([...open.projects, open.projectId])].sort() : open.projects.filter((x) => x !== open.projectId);
    const gBody = { count: Math.max(0, open.count - open.ids.length + ids.length), projects } as unknown as JsonObject;
    return [
      open.pRevision === 0 ? { type: "create", ref: pRef, body: pBody } : { type: "update", ref: pRef, expectedRevision: open.pRevision, body: pBody },
      open.gRevision === 0 ? { type: "create", ref: gRef, body: gBody } : { type: "update", ref: gRef, expectedRevision: open.gRevision, body: gBody },
    ];
  }

  async #agendaIndex(projectId: string): Promise<{ ids: readonly string[]; revision: number }> {
    const found = await this.#runner.get("agenda-index", agendaIndexId(projectId));
    return found === undefined ? { ids: [], revision: 0 } : { ids: (found.body as unknown as IndexBody).ids, revision: found.revision };
  }

  async #returnsIndex(projectId: string): Promise<{ ids: readonly string[]; more: readonly string[]; revision: number }> {
    const found = await this.#runner.get("agenda-returns", projectId);
    const body = found?.body as unknown as { ids?: string[]; more?: string[] } | undefined;
    return found === undefined ? { ids: [], more: [], revision: 0 } : { ids: body?.ids ?? [], more: body?.more ?? [], revision: found.revision };
  }

  #returnsChange(projectId: string, index: { revision: number }, ids: readonly string[], more: readonly string[]): Change {
    const ref: AggregateRef = { kind: "agenda-returns", id: projectId };
    const body = { ids: [...ids], more: [...more] } as unknown as JsonObject;
    return index.revision === 0 ? { type: "create", ref, body } : { type: "update", ref, expectedRevision: index.revision, body };
  }

  /** Puts an outcome on the list of those waiting to be returned, or on the overflow list behind it, or (both full) nowhere; says which. Never refuses: a state change must not wait for a delivery loop. */
  #place(ids: string[], more: string[], id: string): "listed" | "more" | "beyond" {
    if (ids.includes(id)) return "listed";
    if (more.includes(id)) return "more";
    if (ids.length < this.#capListed) { ids.push(id); return "listed"; }
    if (more.length < this.#capMore) { more.push(id); return "more"; }
    return "beyond";
  }

  #agendaChange(projectId: string, index: { revision: number }, ids: readonly string[]): Change {
    const ref: AggregateRef = { kind: "agenda-index", id: agendaIndexId(projectId) };
    return index.revision === 0 ? { type: "create", ref, body: { ids: [...ids] } as unknown as JsonObject } : { type: "update", ref, expectedRevision: index.revision, body: { ids: [...ids] } as unknown as JsonObject };
  }

  /**
   * The open items a meeting with this roster takes: urgent first, then conflicts, questions, decisions, other topics and improvement proposals (`agendaOrder`), then oldest (ties keep the order they were queued in), those that name no participants or name one on the roster, at most `agendaPerMeeting`. Returns the changes that attach them
   * (state scheduled, the occurrence) and take them out of the open list; what does not fit stays open and is counted.
   */
  async #takeAgenda(projectId: string, roster: readonly string[], occurrenceId: string, options: { urgentOnly?: boolean; room?: number; indexIds?: readonly string[]; indexRevision?: number } = {}): Promise<{ ids: string[]; changes: Change[]; overflow: number }> {
    const index = options.indexIds === undefined ? await this.#agendaIndex(projectId) : { ids: options.indexIds, revision: options.indexRevision as number };
    const candidates: { id: string; revision: number; body: AgendaBody }[] = [];
    for (const id of index.ids) {
      const found = await this.#runner.get("agenda-item", id);
      const body = found?.body as unknown as AgendaBody | undefined;
      if (found === undefined || body === undefined || (body.state !== "queued" && body.state !== "deferred")) continue;
      if (options.urgentOnly === true && body.urgency !== "urgent") continue;
      if (body.participants.length > 0 && !body.participants.some((p) => roster.includes(p))) continue;
      candidates.push({ id, revision: found.revision, body });
    }
    candidates.sort((a, b) => agendaOrder(a.body, b.body));
    const room = options.room ?? MEETING_LIMITS.agendaPerMeeting;
    const taken = candidates.slice(0, room);
    if (taken.length === 0) return { ids: [], changes: [], overflow: candidates.length };
    const nowIso = this.#runner.now();
    const changes: Change[] = taken.map((c) => {
      const { deferral, ...rest } = c.body;
      const next: AgendaBody = { ...rest, state: "scheduled", occurrenceId, updatedAt: nowIso, ...(deferral === undefined ? {} : { deferral }) };
      return { type: "update", ref: { kind: "agenda-item", id: c.id }, expectedRevision: c.revision, body: clean(next) } as Change;
    });
    changes.push(this.#agendaChange(projectId, index, index.ids.filter((id) => !taken.some((t) => t.id === id))));
    return { ids: taken.map((t) => t.id), changes, overflow: candidates.length - taken.length };
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= MEETING_LIMITS.retries) throw error;
      }
    }
  }
}

/** The order of an agenda: urgent first, then conflicts, questions, decisions, other topics and improvement proposals, and within each the oldest first. */
const agendaOrder = (a: { urgency: AgendaUrgency; createdAt: string } & Pick<AgendaBody, "category" | "intent" | "question">, b: { urgency: AgendaUrgency; createdAt: string } & Pick<AgendaBody, "category" | "intent" | "question">): number =>
  (a.urgency === b.urgency ? 0 : a.urgency === "urgent" ? -1 : 1) || CATEGORY_RANK[categoryOf(a)] - CATEGORY_RANK[categoryOf(b)] || (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0);

function sortItems(items: View<AgendaBody>[]): View<AgendaBody>[] {
  return [...items].sort(agendaOrder);
}

/** A stand-up window: two wall-clock times, the first before the second; the meeting (start and start plus length) must lie inside it. */
function checkWindow(value: unknown, time: string, duration: number): { from: string; to: string } {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("window", "must be an object with from and to");
  onlyKnown(value, Object.keys({ from: 0, to: 0 }));
  const w = value as { from?: unknown; to?: unknown };
  if (!isLocalTime(w.from) || !isLocalTime(w.to)) return invalid("window", "from and to must be wall-clock times such as 08:00");
  const minutes = (t: string): number => Number(t.slice(0, 2)) * 60 + Number(t.slice(3));
  if (minutes(w.from) >= minutes(w.to)) return invalid("window", "to must be after from (a window does not cross midnight)");
  if (minutes(time) < minutes(w.from) || minutes(time) + duration > minutes(w.to)) return invalid("time", `the stand-up (${time} for ${duration} minutes) must lie inside the daily window ${w.from} to ${w.to}`);
  return { from: w.from, to: w.to };
}

function checkRecurrence(value: unknown): Recurrence {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid("recurrence", "must be an object with a kind");
  const r = value as { kind?: unknown; date?: unknown; days?: unknown };
  if (r.kind === "daily") { onlyKnown(r, ["kind"]); return { kind: "daily" }; }
  if (r.kind === "once") { onlyKnown(r, ["kind", "date"]); return isLocalDate(r.date) ? { kind: "once", date: r.date } : invalid("recurrence.date", "must be a date such as 2026-11-02"); }
  if (r.kind === "weekly") {
    onlyKnown(r, ["kind", "days"]);
    if (!Array.isArray(r.days) || r.days.length < 1 || r.days.length > 7 || !r.days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)) return invalid("recurrence.days", "must list 1 to 7 weekdays, 0 (Sunday) to 6 (Saturday)");
    return { kind: "weekly", days: [...new Set(r.days as number[])].sort((a, b) => a - b) };
  }
  return invalid("recurrence.kind", "must be once, daily or weekly");
}

const ruleOf = (s: Pick<ScheduleBody, "recurrence" | "time" | "timeZone" | "startDate" | "endDate">): SlotRule => ({
  recurrence: s.recurrence, time: s.time, zone: s.timeZone, ...(s.startDate === undefined ? {} : { startDate: s.startDate }), ...(s.endDate === undefined ? {} : { endDate: s.endDate }),
});

/** When the occurrence after the cursor is due to be made (its start minus the lead), or undefined when there is none. */
function nextPrepare(s: Pick<ScheduleBody, "recurrence" | "time" | "timeZone" | "startDate" | "endDate" | "prepareMinutes" | "cursor" | "editedAt">): string | undefined {
  const after = Math.max(ms(s.cursor), s.editedAt === undefined ? -Infinity : ms(s.editedAt));
  const next = nextSlot(ruleOf(s), after, MEETING_LIMITS.scheduleScanDays);
  return next === undefined ? undefined : new Date(next.at - s.prepareMinutes * 60_000).toISOString();
}

/** The owner's meeting time zone from the configuration service, for `MeetingOptions.ownerTimeZone`. Absent or unreadable: undefined (the schedule must then name a zone). */
export function ownerTimeZoneFrom(configuration: { effective(by: Principal): Promise<{ readonly values: Readonly<Record<string, { readonly value: unknown }>> } | undefined> }, owner: Principal): () => Promise<string | undefined> {
  return async () => {
    const value = (await configuration.effective(owner))?.values["meeting.timeZone"]?.value;
    return typeof value === "string" ? value : undefined;
  };
}
