import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import type { BlockerBody } from "../domain/blockers.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, type TaskBody, type TaskState, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { WaitBody } from "../domain/waits.js";
import type { Availability } from "../conversations/index.js";
import type { InquiryBody } from "../inquiries/inquiries.js";
import type { ItemBody } from "../notifications/notifications.js";
import type { ArtifactBody } from "../artifacts/service.js";
import { categoryOf, authorityOf, type AgendaBody, type MeetingService, type OccurrenceBody, type ScheduleBody } from "../meetings/meetings.js";
import { isLocalTime } from "../meetings/zones.js";
import type { Recurrence } from "../meetings/zones.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { Aggregate, AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { outcomeText, type ImprovementBody } from "./improvements.js";
import { clean, cut, invalid, plain, whole, type Cite, type OutcomeSink } from "./shared.js";

// ---- records --------------------------------------------------------------------------------------------------------------------

/** What a stand-up schedule adds to a meeting schedule (kind `standup-config`, named by the schedule's ID). */
export interface StandupConfigBody {
  readonly scheduleId: string;
  readonly projectId: string;
  /** The hours of the local day in which the stand-up may be held (the schedule's zone): it starts at or after `windowFrom` and ends by `windowTo`. */
  readonly windowFrom: string;
  readonly windowTo: string;
  /** How far back a brief looks when there is no earlier meeting to count from (hours; about 24). */
  readonly coverageHours: number;
  readonly createdBy: string;
  readonly createdAt: string;
}

export interface BriefEntry {
  readonly text: string;
  readonly cites: readonly Cite[];
  /** Words only the owner, the controller and the agent itself may read (the text and recipient of a question the agent asked another); other readers get `text` and the citation. */
  readonly detail?: string;
}
export type BriefSection = "accomplishments" | "unfinished" | "blockers" | "advice" | "priorities";
export const BRIEF_SECTIONS: readonly BriefSection[] = ["accomplishments", "unfinished", "blockers", "advice", "priorities"];
/** What the agent itself added; it is its own words and is shown as such, never as a record. */
export interface AgentStatement { readonly section: "advice" | "priorities" | "note"; readonly text: string; readonly at: string }

/**
 * An agent's brief for one stand-up (kind `standup-brief`): accomplishments over the period, unfinished work, blockers, advice needed and next priorities, every entry with the records it rests on. It is made from records; the agent
 * is not asked and not woken for it, so a paused agent has one too. The agent's own additions are kept apart in `statements`.
 */
export interface BriefBody {
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly agent: string;
  readonly coversFrom: string;
  readonly coversTo: string;
  /** What the agent's availability was when the brief was assembled (observed, not changed). */
  readonly agentState: Availability;
  readonly accomplishments: readonly BriefEntry[];
  readonly unfinished: readonly BriefEntry[];
  readonly blockers: readonly BriefEntry[];
  readonly advice: readonly BriefEntry[];
  readonly priorities: readonly BriefEntry[];
  /** Entries beyond the section limit, by section: nothing is hidden silently. */
  readonly more: Readonly<Partial<Record<BriefSection, number>>>;
  readonly statements: readonly AgentStatement[];
  /** The scan for records stopped before the end: some entries may be missing. */
  readonly partial: boolean;
  readonly digest: string;
  readonly assembledAt: string;
}

export interface ReviewLine { readonly text: string; readonly cites: readonly Cite[] }
/** The short production / production-capacity balance review of the planning agenda. */
export interface PlanningReview {
  readonly projectId: string;
  readonly coversFrom: string;
  readonly at: string;
  readonly lines: readonly ReviewLine[];
  readonly figures: {
    readonly deliveredP: number; readonly pendingP: number; readonly deliveredPC: number; readonly activePC: number; readonly deferredPC: number;
    readonly improvementsOpen: number; readonly improvementsAdopted: number; readonly improvementsStopped: number; readonly improvementsDeferred: number;
    readonly pcShareByCount?: number; readonly floor?: number; readonly ceiling?: number; readonly target?: number;
  };
  readonly partial: boolean;
}

/** What the controller keeps of getting ready for one occurrence (kind `standup-prep`, named by the occurrence's ID). */
export interface PrepBody {
  readonly occurrenceId: string;
  readonly projectId: string;
  /** Agent -> when the notice was handed to the sink. */
  readonly notified: Readonly<Record<string, string>>;
  readonly withheld: readonly string[];
  readonly briefs: Readonly<Record<string, string>>;
  readonly review?: PlanningReview;
  /** What is waiting for the owner, as the digest part of the daily meeting (see `StandupOptions.ownerItems`); each line cites its record. */
  readonly needsOwner?: readonly ReviewLine[];
  readonly preparedAt: string;
}

export interface PrepNotice {
  /** Names this notice for ever: a sink that sees the key twice does it once. */
  readonly key: string;
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly agent: string;
  readonly startsAt: string;
  readonly coversFrom: string;
  /** Built by the controller from the typed record, never from model text. */
  readonly message: string;
}
/** Delivers the advance notice (a message to the agent, a note in its inbox). Called only for agents that may be reached; must be idempotent by `key`. It must not start, resume or wake anything. */
export interface PreparationSink { notify(notice: PrepNotice): Promise<void> }

export interface Allocation { readonly floor?: number; readonly target?: number; readonly ceiling?: number }

export interface StandupOptions extends RunnerOptions {
  /** Whether an agent may be reached (the pause service's `availability`). Required; failing closed: a missing or throwing hook withholds the notice. It is only asked, never acted on. */
  readonly availability: (principalId: string) => Promise<Availability>;
  readonly notices?: PreparationSink;
  readonly outcomes?: OutcomeSink;
  /** Told when a brief that carries a decision on an improvement proposal has been stored, so the proposal can be marked told (it was told in the brief, having no task to file a notice on). Best effort. */
  readonly onBriefed?: (by: Principal, itemId: string, revision: number) => Promise<unknown>;
  /** How many messages wait for an agent at the stand-up boundary (`AgentMessageService.waitingAtStandup`): the brief says so, and the agent reads them at the stand-up. Best effort: a failure leaves the line out. */
  readonly waitingMessages?: (by: Principal, agent: string) => Promise<number>;
  /** The configured P/PC allocation (floor, target, ceiling in percent), for the balance review (see `allocationFrom`). */
  readonly allocation?: () => Promise<Allocation | undefined>;
  /** Actual use on the allocation basis (worker-slot time) when something measures it; absent: the review says so and falls back to counting tasks. */
  readonly usage?: (projectId: string, since: string, until: string) => Promise<{ readonly pcShare: number; readonly basis: string } | undefined>;
  /** What needs the owner now (the digest, part of the daily meeting by the owner's decision of 2026-10-22), as lines with their records: see `needsOwnerFrom`. Absent or failing: the agenda says the list could not be read. */
  readonly ownerItems?: (projectId: string) => Promise<readonly ReviewLine[]>;
  /** When the next protected improvement window opens, if one is scheduled. */
  readonly improvementWindow?: (projectId: string) => Promise<string | undefined>;
  /** Records read per page, and pages per kind in one scan. A scan that is cut off says so (`partial`). */
  readonly scanPageSize?: number;
  readonly scanPages?: number;
}

export const STANDUP_LIMITS = { section: 25, statements: 10, statement: 500, coverageMax: 168, coverageDefault: 24, prepareDefault: 60, durationDefault: 30, retries: 8, page: 100, priorities: 5, agendaPage: 50, ownerLines: 25 } as const;
const BRIEF_ID = /^sbr-[a-z2-7]{20}$/;
const SCHEDULE_ID = /^msc-[a-z2-7]{20}$/;
const OCCURRENCE_ID = /^mto-[a-z2-7]{20}$/;
const isService = (p: Principal): boolean => (p.kind === "owner" || p.kind === "host" || p.kind === "service") && p.taskScope === undefined;
const minutesOf = (time: string): number => Number(time.slice(0, 2)) * 60 + Number(time.slice(3));
const STATE_WORDS: Readonly<Record<TaskState, string>> = { proposed: "proposed", ready: "ready to be worked on", in_progress: "in progress", blocked: "blocked", done: "done", cancelled: "cancelled" };

interface TaskFact { readonly id: string; readonly revision: number; readonly updatedAt: string; readonly body: TaskBody; readonly owner?: string; readonly priority: number; readonly workClass: "P" | "PC" }
interface Facts {
  readonly tasks: TaskFact[];
  readonly blockers: Aggregate[];
  readonly waits: Aggregate[];
  readonly inquiries: Aggregate[];
  readonly artifacts: Aggregate[];
  /** The project's improvement proposals (the briefs tell proposers of decisions they have not been told yet). */
  readonly improvements: Aggregate[];
  partial: boolean;
}

/**
 * Stand-up preparation (card M03), on top of the meeting scheduling and agendas of M01. It adds: the stand-up schedule configuration (time, zone, participant group, length, a daily window the time must lie in, how far back a brief looks); the
 * advance notice (agents are told to reach a safe boundary; the paused and the unavailable are not woken, their brief is made from the records anyway); durable briefs assembled from source-backed records, every entry with its citations;
 * the agenda for an occurrence in its order (conflicts, questions, decisions, then topics and improvement proposals) with each topic's authority; the P/PC balance review of the planning agenda; and the return of outcomes to the conversation a
 * topic came from. Running the meeting is M05 and M06.
 *
 * - **Nothing here wakes anyone.** The notice goes only to agents whose availability is `available` (checked again each time), the paused and the stopped are listed as withheld, and briefs read records. Assembling a brief asks nothing of the agent.
 * - **Records, not recollection.** Accomplishments, unfinished work, blockers and advice come from the task, assignment, blocker, wait, inquiry and artifact records, with links. What an agent adds is kept as its own words (`statements`).
 * - **Callers cannot act as others.** Preparation is for owner, host or service principals; an agent adds statements to its own brief only; no operation takes a principal or actor from the caller.
 */
export class StandupService {
  readonly #runner: CommandRunner;
  readonly #meetings: MeetingService;
  readonly #assignments: AssignmentService;
  readonly #options: StandupOptions;
  readonly #pageSize: number;
  readonly #pages: number;

  private constructor(runner: CommandRunner, deps: { meetings: MeetingService; assignments: AssignmentService }, options: StandupOptions) {
    this.#runner = runner;
    this.#meetings = deps.meetings;
    this.#assignments = deps.assignments;
    this.#options = options;
    this.#pageSize = options.scanPageSize ?? 200;
    this.#pages = options.scanPages ?? 25;
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || !Number.isSafeInteger(this.#pages) || this.#pages < 1) invalid("scanPages", "must be whole numbers of at least 1");
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { meetings: MeetingService; assignments: AssignmentService }, options: StandupOptions): StandupService {
    return new StandupService(new CommandRunner(storage, epoch, options), deps, options);
  }

  // ---- configuration -----------------------------------------------------------------------------------------------------------

  /**
   * Sets up a stand-up: a meeting schedule (daily unless a recurrence is given) for a participant group (the roster), plus the daily window its time must lie in and how far back briefs look. The start and the end (start plus length) must
   * fall inside the window; the schedule's zone is a real IANA zone, so the same wall-clock time holds across daylight-saving changes (M01). Needs `meeting.manage` in the project. A repeat with the same command ID returns the same stand-up.
   */
  async configure(by: Principal, command: NoActor & {
    projectId: string; title: string; roster: readonly string[]; time: string; windowFrom: string; windowTo: string; timeZone?: string; recurrence?: Recurrence; startDate?: string; endDate?: string;
    durationMinutes?: number; prepareMinutes?: number; coverageHours?: number; budgetTokens?: number;
  }): Promise<{ scheduleId: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "projectId", "title", "roster", "time", "windowFrom", "windowTo", "timeZone", "recurrence", "startDate", "endDate", "durationMinutes", "prepareMinutes", "coverageHours", "budgetTokens"]);
    const projectId = checkProjectId(command.projectId);
    const duration = command.durationMinutes === undefined ? STANDUP_LIMITS.durationDefault : whole(command.durationMinutes, "durationMinutes", 1, 480);
    const window = this.#window(command.windowFrom, command.windowTo, command.time, duration);
    const coverageHours = command.coverageHours === undefined ? STANDUP_LIMITS.coverageDefault : whole(command.coverageHours, "coverageHours", 1, STANDUP_LIMITS.coverageMax);
    // The meeting service checks authority, roster, zone and dates; it is called first so a caller without rights learns nothing about the window rules.
    const made = await this.#meetings.createSchedule(by, {
      commandId: command.commandId, projectId, title: command.title, roster: command.roster, time: command.time, ...(command.recurrence === undefined ? {} : { recurrence: command.recurrence }), ...(command.timeZone === undefined ? {} : { timeZone: command.timeZone }),
      ...(command.startDate === undefined ? {} : { startDate: command.startDate }), ...(command.endDate === undefined ? {} : { endDate: command.endDate }), durationMinutes: duration, window: { from: window.windowFrom, to: window.windowTo },
      prepareMinutes: command.prepareMinutes === undefined ? STANDUP_LIMITS.prepareDefault : command.prepareMinutes, ...(command.budgetTokens === undefined ? {} : { budgetTokens: command.budgetTokens }),
    } as never);
    await this.#retrying(async () => {
      const existing = await this.#runner.get("standup-config", made.id);
      if (existing !== undefined) return;
      await this.#runner.command("standup.config.create", { commandId: `scf:${made.id}`, actor: by.id }, async () => ({
        payload: { scheduleId: made.id, projectId, ...window, coverageHours },
        build: async () => {
          const ref: AggregateRef = { kind: "standup-config", id: made.id };
          const body: StandupConfigBody = { scheduleId: made.id, projectId, windowFrom: window.windowFrom, windowTo: window.windowTo, coverageHours, createdBy: by.id, createdAt: this.#runner.now() };
          return { ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }], detail: { projectId } };
        },
      }));
    });
    return { scheduleId: made.id, replayed: made.replayed };
  }

  /**
   * Changes a stand-up: its time, length, zone, group, lead time or state go to the schedule (M01 rules: the cursor moves, the past is not replayed), its window and coverage to the stand-up record. The window rule is checked on the values
   * the stand-up will have. Needs `meeting.manage`. The schedule revision read must still be current.
   */
  async update(by: Principal, command: NoActor & {
    scheduleId: string; expectedRevision: number; state?: "active" | "paused" | "ended"; title?: string; roster?: readonly string[]; time?: string; timeZone?: string; recurrence?: Recurrence;
    durationMinutes?: number; prepareMinutes?: number; windowFrom?: string; windowTo?: string; coverageHours?: number;
  }): Promise<void> {
    onlyKnown(command, ["commandId", "scheduleId", "expectedRevision", "state", "title", "roster", "time", "timeZone", "recurrence", "durationMinutes", "prepareMinutes", "windowFrom", "windowTo", "coverageHours"]);
    const id = typeof command.scheduleId === "string" && SCHEDULE_ID.test(command.scheduleId) ? command.scheduleId : invalid("scheduleId", "is not a schedule ID");
    checkRevision(command.expectedRevision);
    const schedule = await this.#meetings.schedule(by, id);
    const found = await this.#runner.get("standup-config", id);
    if (schedule === undefined || found === undefined || !allows(by, "meeting.manage", schedule.projectId)) throw new DomainError("forbidden", `${by.id} may not change that stand-up`);
    const config = found.body as unknown as StandupConfigBody;
    const duration = command.durationMinutes === undefined ? schedule.durationMinutes : whole(command.durationMinutes, "durationMinutes", 1, 480);
    const window = this.#window(command.windowFrom ?? config.windowFrom, command.windowTo ?? config.windowTo, command.time ?? schedule.time, duration);
    const coverageHours = command.coverageHours === undefined ? config.coverageHours : whole(command.coverageHours, "coverageHours", 1, STANDUP_LIMITS.coverageMax);
    const { windowFrom: _f, windowTo: _t, coverageHours: _c, ...forSchedule } = command;
    void _f; void _t; void _c;
    await this.#meetings.updateSchedule(by, { ...forSchedule, window: { from: window.windowFrom, to: window.windowTo } } as never);
    if (window.windowFrom !== config.windowFrom || window.windowTo !== config.windowTo || coverageHours !== config.coverageHours) {
      await this.#retrying(async () => {
        const cur = await this.#runner.get("standup-config", id);
        if (cur === undefined) return;
        const body = cur.body as unknown as StandupConfigBody;
        await this.#runner.command("standup.config.update", { commandId: `scu:${scopedCommandId(by.id, command.commandId)}`, actor: by.id }, async () => ({
          payload: { scheduleId: id, ...window, coverageHours },
          build: async () => {
            const ref: AggregateRef = { kind: "standup-config", id };
            return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: cur.revision, body: clean({ ...body, ...window, coverageHours }) }], detail: { projectId: body.projectId } };
          },
        }));
      });
    }
  }

  /** The schedule with its stand-up settings, for someone who may read the project's meetings. Anyone else gets `undefined`, as for one that does not exist. */
  async standup(viewer: Principal, scheduleId: string): Promise<{ schedule: View<ScheduleBody>; config: View<StandupConfigBody> } | undefined> {
    const schedule = await this.#meetings.schedule(viewer, scheduleId);
    const found = schedule === undefined ? undefined : await this.#runner.get("standup-config", scheduleId);
    return schedule === undefined || found === undefined ? undefined : { schedule, config: view<StandupConfigBody>(found) };
  }

  // ---- preparation ---------------------------------------------------------------------------------------------------------------

  /**
   * Gets one occurrence ready: tells the agents that may be reached to come to a safe boundary and (for a live meeting that has not started) hands each notice to the sink once; makes or refreshes every participant's brief from the records,
   * the paused and unavailable included; and stores the P/PC balance review for the planning agenda. Owner, host or service only. Repeating it changes nothing that has not changed in the records; a catch-up report gets briefs and no notices.
   */
  async prepare(by: Principal, occurrenceId: string): Promise<{ notified: string[]; withheld: string[]; briefs: { agent: string; briefId: string; change: "created" | "updated" | "unchanged" }[]; review: PlanningReview }> {
    if (!isService(by)) throw new DomainError("forbidden", `${by.id} may not prepare stand-ups`);
    const id = typeof occurrenceId === "string" && OCCURRENCE_ID.test(occurrenceId) ? occurrenceId : invalid("occurrenceId", "is not a meeting ID");
    for (let attempt = 1; ; attempt++) {
      const found = await this.#runner.get("meeting-occurrence", id);
      const occurrence = found?.body as unknown as OccurrenceBody | undefined;
      if (found === undefined || occurrence === undefined) throw new DomainError("not_found", `meeting ${id} does not exist`);
      if (occurrence.state !== "planned" && occurrence.state !== "reported") throw new DomainError("invalid_command", `meeting ${id} is ${occurrence.state}; there is nothing to prepare`, { field: "occurrenceId" });
      const config = occurrence.scheduleId === undefined ? undefined : ((await this.#runner.get("standup-config", occurrence.scheduleId))?.body as unknown as StandupConfigBody | undefined);
      const nowIso = this.#runner.now();
      const coversFrom = occurrence.coversFrom ?? new Date(Date.parse(occurrence.startsAt) - (config?.coverageHours ?? STANDUP_LIMITS.coverageDefault) * 3_600_000).toISOString();
      const prepFound = await this.#runner.get("standup-prep", id);
      const prep = prepFound?.body as unknown as PrepBody | undefined;

      // The advance notice: only to agents that can be reached now; a live meeting that has not ended; once each.
      const notified: Record<string, string> = { ...(prep?.notified ?? {}) };
      const withheld: string[] = [];
      const sent: string[] = [];
      const live = occurrence.mode === "live" && occurrence.state === "planned" && Date.parse(nowIso) < Date.parse(occurrence.endsAt);
      for (const p of occurrence.participants) {
        const availability = await this.#reach(p.id);
        const reachable = availability === "available" || (p.status === "owner-invited" && availability === "paused");
        if (!reachable) { withheld.push(p.id); continue; }
        if (!live || notified[p.id] !== undefined || this.#options.notices === undefined) continue;
        await this.#options.notices.notify({
          key: `${id}:${p.id}:prepare`, occurrenceId: id, projectId: occurrence.projectId, agent: p.id, startsAt: occurrence.startsAt, coversFrom,
          message: `Stand-up at ${occurrence.startsAt}. Reach a safe boundary and save your position before then. Your brief is put together from the records of your work; you do not need to write it, and your assignment stays as it is.`,
        });
        notified[p.id] = nowIso;
        sent.push(p.id);
      }

      // The briefs, from records.
      const facts = await this.#facts(occurrence.projectId, coversFrom, nowIso);
      const briefs: { agent: string; briefId: string; change: "created" | "updated" | "unchanged" }[] = [];
      const briefed = new Map<string, { revision: number; agents: Set<string> }>();
      for (const p of occurrence.participants) { const made = await this.#brief(by, id, occurrence, p.id, coversFrom, nowIso, facts); briefs.push({ agent: made.agent, briefId: made.briefId, change: made.change }); for (const [item, revision] of made.briefed) { const e = briefed.get(item) ?? { revision, agents: new Set<string>() }; e.agents.add(p.id); briefed.set(item, e); } }
      // A decision counts as told once every proposer it concerns has it in a stored brief; one that could not be written (the meeting has started) is told next time.
      if (this.#options.onBriefed !== undefined) for (const [item, e] of briefed) {
        const body = facts.improvements.find((x) => x.id === item)?.body as unknown as ImprovementBody | undefined;
        const proposers = body === undefined ? [] : [body.proposedBy, ...(body.duplicates ?? []).map((d) => (facts.improvements.find((x) => x.id === d)?.body as unknown as ImprovementBody | undefined)?.proposedBy)];
        // A cut-off scan or a duplicate whose record was not read could hide a proposer, so nothing is marked on it.
        if (facts.partial || proposers.length === 0 || !proposers.every((a) => a !== undefined && e.agents.has(a))) continue;
        try { await this.#options.onBriefed(by, item, e.revision); } catch { /* told again next time */ }
      }

      const review = await this.#review(occurrence.projectId, coversFrom, nowIso, facts);
      const needsOwner = this.#options.ownerItems === undefined ? undefined : await this.#options.ownerItems(occurrence.projectId).then((lines) => lines.slice(0, STANDUP_LIMITS.ownerLines).map((l) => ({ text: cut(l.text, 300), cites: l.cites.slice(0, 5) })), (): ReviewLine[] => [{ text: "The list of what needs you could not be read just now; it is in your inbox.", cites: [{ kind: "project", id: occurrence.projectId }] }]);
      const body: PrepBody = { occurrenceId: id, projectId: occurrence.projectId, notified, withheld, briefs: Object.fromEntries(briefs.map((b) => [b.agent, b.briefId])), review, ...(needsOwner === undefined ? {} : { needsOwner }), preparedAt: nowIso };
      // Nothing new since the last preparation (the same people told, withheld and briefed, the same review): nothing is written.
      const stable = (b: PrepBody): string => canonicalJson({ ...b, preparedAt: "", ...(b.review === undefined ? {} : { review: { ...b.review, at: "" } }) } as unknown as JsonObject);
      if (prep !== undefined && stable(prep) === stable(body)) return { notified: sent, withheld, briefs, review: prep.review ?? review };
      try {
        await this.#runner.command("standup.prepare", { commandId: `spp:${id}:${prepFound?.revision ?? 0}:${sha256(canonicalJson(body as unknown as JsonObject)).slice(0, 16)}`, actor: by.id }, async () => ({
          payload: { occurrenceId: id, revision: prepFound?.revision ?? 0 },
          build: async () => {
            const ref: AggregateRef = { kind: "standup-prep", id };
            return { ref, creates: prepFound === undefined, changes: [prepFound === undefined ? { type: "create", ref, body: clean(body) } : { type: "update", ref, expectedRevision: prepFound.revision, body: clean(body) }], detail: { projectId: occurrence.projectId, notified: sent.length } };
          },
        }));
      } catch (error) {
        if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict") && attempt < STANDUP_LIMITS.retries) continue;
        throw error;
      }
      return { notified: sent, withheld, briefs, review };
    }
  }

  /** What was prepared for an occurrence (who was told, who was withheld, the review). Needs `meeting.read` (or the owner); anyone else gets `undefined`. */
  async prepared(viewer: Principal, occurrenceId: string): Promise<View<PrepBody> | undefined> {
    const found = typeof occurrenceId === "string" && OCCURRENCE_ID.test(occurrenceId) ? await this.#runner.get("standup-prep", occurrenceId) : undefined;
    if (found === undefined) return undefined;
    const body = found.body as unknown as PrepBody;
    if (!isService(viewer) && (!inTaskScope(viewer, body.projectId) || !(allows(viewer, "meeting.read", body.projectId) || allows(viewer, "meeting.manage", body.projectId)))) return undefined;
    // The review names tasks (as briefs do) and the owner's to-do list is the owner's: each goes only to who may read it.
    const { review, needsOwner, ...rest } = view<PrepBody>(found);
    return { ...rest, ...(review !== undefined && this.#mayReadRecords(viewer, body.projectId) ? { review } : {}), ...(needsOwner !== undefined && isService(viewer) ? { needsOwner } : {}) } as View<PrepBody>;
  }

  // ---- briefs ----------------------------------------------------------------------------------------------------------------------

  /** A brief, for the owner, a service, the agent it is about, a manager of the project's meetings, or a reader of both its meetings and its histories (the last two see the record-backed sections only, never the words of questions asked of others). Anyone else gets `undefined`, as for one that does not exist. */
  async brief(viewer: Principal, briefId: string): Promise<View<BriefBody> | undefined> {
    const found = typeof briefId === "string" && BRIEF_ID.test(briefId) ? await this.#runner.get("standup-brief", briefId) : undefined;
    if (found === undefined) return undefined;
    const brief = found.body as unknown as BriefBody;
    if (!this.#mayReadBrief(viewer, brief)) return undefined;
    const v = view<BriefBody>(found);
    // The words of a question asked of another agent are in the inquiry's own record, which only its parties and the owner may read.
    return this.#mayReadQuestions(viewer, brief) ? v : { ...v, advice: v.advice.map(({ detail: _d, ...e }) => { void _d; return e; }) };
  }

  /** The briefs of an occurrence, in roster order, as far as this viewer may read them. */
  async briefs(viewer: Principal, occurrenceId: string): Promise<View<BriefBody>[]> {
    const prep = typeof occurrenceId === "string" && OCCURRENCE_ID.test(occurrenceId) ? await this.#runner.get("standup-prep", occurrenceId) : undefined;
    if (prep === undefined) return [];
    const out: View<BriefBody>[] = [];
    for (const briefId of Object.values((prep.body as unknown as PrepBody).briefs)) { const b = await this.brief(viewer, briefId); if (b !== undefined) out.push(b); }
    return out;
  }

  /**
   * An agent adds its own words to its own brief: advice it needs, priorities it proposes, or a note. They are kept as statements of the agent (not records) and shown so. Only the agent the brief is about, only while the meeting
   * is still ahead, ten at most. The revision read must still be current.
   */
  async addStatement(by: Principal, command: NoActor & { briefId: string; expectedRevision: number; section: "advice" | "priorities" | "note"; text: string }): Promise<void> {
    onlyKnown(command, ["commandId", "briefId", "expectedRevision", "section", "text"]);
    const id = typeof command.briefId === "string" && BRIEF_ID.test(command.briefId) ? command.briefId : invalid("briefId", "is not a brief ID");
    const expected = checkRevision(command.expectedRevision);
    if (command.section !== "advice" && command.section !== "priorities" && command.section !== "note") invalid("section", "must be advice, priorities or note");
    const text = plain(command.text, "text", STANDUP_LIMITS.statement);
    await this.#retrying(() => this.#runner.command("standup.brief.statement", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { briefId: id, expectedRevision: expected, section: command.section, text },
      build: async () => {
        const found = await this.#runner.get("standup-brief", id);
        const body = found?.body as unknown as BriefBody | undefined;
        // Someone else's brief reads like a missing one.
        if (found === undefined || body === undefined || body.agent !== by.id || by.asOf === undefined || !inTaskScope(by, body.projectId)) throw new DomainError("forbidden", `${by.id} may not add to that brief`);
        if (found.revision !== expected) throw new DomainError("stale_revision", `brief ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
        const occ = (await this.#runner.get("meeting-occurrence", body.occurrenceId))?.body as unknown as OccurrenceBody | undefined;
        if (occ === undefined || occ.state !== "planned" || Date.parse(this.#runner.now()) >= Date.parse(occ.startsAt)) throw new DomainError("invalid_command", "the stand-up has started or is over; the brief is closed", { field: "briefId" });
        if (body.statements.length >= STANDUP_LIMITS.statements) throw new DomainError("invalid_command", `a brief holds at most ${STANDUP_LIMITS.statements} statements`, { field: "text" });
        const ref: AggregateRef = { kind: "standup-brief", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: clean({ ...body, statements: [...body.statements, { section: command.section, text, at: this.#runner.now() }] }) }], detail: { projectId: body.projectId } };
      },
    })));
  }

  // ---- the agenda ------------------------------------------------------------------------------------------------------------------

  /**
   * The agenda of an occurrence as the meeting will take it: urgent points first, then conflicts, questions and decisions, then other topics and improvement proposals, each with its request type's authority in words (a discussion or a
   * recommendation request never executes anything; an instruction is not put to a vote) and its timebox; then the planning section (the P/PC balance review) and which briefs exist. Routine progress stays in the briefs. What the viewer
   * may not read is named in `withheld`. Anyone who may not see the occurrence gets `undefined`.
   */
  async agenda(viewer: Principal, occurrenceId: string): Promise<{
    occurrenceId: string; startsAt: string; items: AgendaLine[]; sections: Readonly<Record<"conflicts" | "questions" | "decisions" | "topics" | "improvements", readonly AgendaLine[]>>;
    needsOwner?: readonly ReviewLine[]; planning?: PlanningReview; briefs?: { agent: string; briefId: string; agentState: Availability; blockers: number; advice: number }[]; withheld: string[]; notes?: string[]; routine: string;
  } | undefined> {
    const shown = await this.#meetings.occurrence(viewer, occurrenceId);
    if (shown === undefined) return undefined;
    const occ = shown.occurrence;
    const items: AgendaLine[] = shown.agenda.map((i) => lineOf(i));
    const rank = { conflict: 0, question: 1, decision: 2, topic: 3, improvement: 4 } as const;
    // The occurrence stores the order it was taken in; a meeting called later may add items, so the order is made again from the same rule.
    items.sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === "urgent" ? -1 : 1) || rank[a.category] - rank[b.category]);
    const sections = {
      conflicts: items.filter((i) => i.category === "conflict"), questions: items.filter((i) => i.category === "question"), decisions: items.filter((i) => i.category === "decision"),
      topics: items.filter((i) => i.category === "topic"), improvements: items.filter((i) => i.category === "improvement"),
    };
    const withheld: string[] = [];
    const prep = await this.prepared(viewer, occurrenceId);
    const briefs = await this.briefs(viewer, occurrenceId);
    if (prep === undefined || prep.review === undefined) withheld.push("the planning review");
    if (briefs.length === 0 && prep !== undefined) withheld.push("briefs");
    const waiting = await this.#meetings.returnsWaiting(viewer, occ.projectId);
    const notes = waiting === undefined || waiting === 0 ? [] : [`${waiting} outcome${waiting === 1 ? "" : "s"} of earlier topics ${waiting === 1 ? "has" : "have"} not yet been told to the conversation${waiting === 1 ? "" : "s"} they came from.`];
    return {
      occurrenceId, startsAt: occ.startsAt, items, sections, ...(prep?.needsOwner === undefined ? {} : { needsOwner: prep.needsOwner }), ...(prep?.review === undefined ? {} : { planning: prep.review }),
      ...(briefs.length === 0 ? {} : { briefs: briefs.map((b) => ({ agent: b.agent, briefId: b.id, agentState: b.agentState, blockers: b.blockers.length, advice: b.advice.length })) }), withheld, ...(notes.length === 0 ? {} : { notes }),
      routine: "Routine progress is in the written briefs; the agenda holds what needs the meeting.",
    };
  }

  // ---- outcomes back to the conversation ---------------------------------------------------------------------------------------------

  /**
   * Hands outcomes of agenda topics to the conversation they came from (the owner's chat turn, or the inquiry), once each: resolved, discussed or deferred, with the meeting's words, the deferral's reason and next step, and what the topic's
   * authority was ("a discussion: nothing was done because of it"). The notice has a stable key; the item is marked returned only after the sink returned. Without a sink, outcomes stay waiting (listed in `waiting`). Owner, host or service only.
   */
  async deliverOutcomes(by: Principal, projectId: string): Promise<{ delivered: string[]; waiting: string[] }> {
    if (!isService(by)) throw new DomainError("forbidden", `${by.id} may not deliver agenda outcomes`);
    const project = checkProjectId(projectId);
    const delivered: string[] = [];
    const waiting: string[] = [];
    // Outcomes that did not fit on the waiting list are listed first, now that there may be room.
    await this.#meetings.requeueReturns(by, project);
    // A snapshot of the waiting list is taken before anything is delivered (delivering changes the list the pages are cut from).
    const snapshot: View<AgendaBody>[] = [];
    for (let restart = 0; ; restart++) {
      snapshot.length = 0;
      try {
        let after: string | undefined;
        for (;;) {
          const page = await this.#meetings.outcomesToReturn(by, project, { limit: STANDUP_LIMITS.agendaPage, ...(after === undefined ? {} : { afterId: after }) });
          snapshot.push(...page.items);
          if (page.next === undefined) break;
          after = page.next;
        }
        break;
      } catch (error) {
        // Someone else delivered while the pages were read, so the place to continue from is gone: read again from the start.
        if (!(error instanceof DomainError) || error.code !== "invalid_command" || restart >= STANDUP_LIMITS.retries) throw error;
      }
    }
    for (const item of snapshot) {
      const sink = this.#options.outcomes;
      if (sink === undefined || item.source === undefined) { waiting.push(item.id); continue; }
      const sent = await sink.deliver({ key: `${item.id}:${item.revision}`, kind: "agenda-outcome", projectId: project, to: { kind: item.source.kind, id: item.source.id }, text: outcomeLine(item), refs: [{ kind: "agenda-item", id: item.id, revision: item.revision }] });
      if (sent === false) { waiting.push(item.id); continue; }
      // Marked only if the item is still the one that was sent; a newer outcome stays waiting and goes next time.
      if (await this.#meetings.markOutcomeReturned(by, item.id, item.revision)) delivered.push(item.id); else waiting.push(item.id);
    }
    return { delivered, waiting };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------------

  async #reach(id: string): Promise<Availability> {
    try { return await this.#options.availability(id); } catch { return "stopped"; }
  }

  #window(from: unknown, to: unknown, time: unknown, duration: number): { windowFrom: string; windowTo: string } {
    if (!isLocalTime(from)) return invalid("windowFrom", "must be a wall-clock time such as 08:00");
    if (!isLocalTime(to)) return invalid("windowTo", "must be a wall-clock time such as 18:00");
    if (minutesOf(from) >= minutesOf(to)) invalid("windowTo", "must be after windowFrom (a window does not cross midnight)");
    if (!isLocalTime(time)) return invalid("time", "must be a wall-clock time such as 09:30");
    if (minutesOf(time) < minutesOf(from) || minutesOf(time) + duration > minutesOf(to)) invalid("time", `the stand-up (${time} for ${duration} minutes) must lie inside the daily window ${from} to ${to}`);
    return { windowFrom: from, windowTo: to };
  }

  /** The record-backed parts (task titles, blockers, the review): the owner and the controller, managers of the project's meetings, and those who read both its meetings and its histories. */
  #mayReadRecords(viewer: Principal, projectId: string): boolean {
    if (isService(viewer)) return true;
    if (!inTaskScope(viewer, projectId)) return false;
    return allows(viewer, "meeting.manage", projectId) || (allows(viewer, "meeting.read", projectId) && allows(viewer, "history.read", projectId));
  }

  #mayReadBrief(viewer: Principal, brief: BriefBody): boolean {
    return (viewer.id === brief.agent && viewer.asOf !== undefined && inTaskScope(viewer, brief.projectId)) || this.#mayReadRecords(viewer, brief.projectId);
  }

  /** The words of a question the agent asked another: the owner, the controller and the agent itself (the inquiry's own rule lets only its parties and the owner read it). */
  #mayReadQuestions(viewer: Principal, brief: BriefBody): boolean {
    return isService(viewer) || (viewer.id === brief.agent && viewer.asOf !== undefined && inTaskScope(viewer, brief.projectId));
  }

  async #scan(kind: string, facts: { partial: boolean }, visit: (a: Aggregate) => Promise<void> | void): Promise<void> {
    let after: string | undefined;
    for (let reads = 0; ; reads++) {
      if (reads >= this.#pages) { facts.partial = true; return; }
      const page = await this.#runner.list(kind, { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
      for (const a of page) { after = a.id; await visit(a); }
      if (page.length < this.#pageSize) return;
    }
  }

  /** The records a brief and the review rest on, read once for the whole occurrence. Each scan is bounded; a cut scan marks everything built from it `partial`. */
  async #facts(projectId: string, since: string, until: string): Promise<Facts> {
    const facts: Facts = { tasks: [], blockers: [], waits: [], inquiries: [], artifacts: [], improvements: [], partial: false };
    await this.#scan("task", facts, async (a) => {
      const body = a.body as unknown as TaskBody;
      if (body.projectId !== projectId || body.state === "cancelled" || body.state === "proposed") return;
      if (body.state === "done" && a.updatedAt <= since) { facts.tasks.push({ id: a.id, revision: a.revision, updatedAt: a.updatedAt, body, priority: 5, workClass: await this.#classOf(a.id) }); return; }
      const asg = await this.#assignments.getAssignment(a.id);
      let owner = asg?.state === "assigned" && asg.owner !== undefined ? asg.owner : undefined;
      if (owner === undefined && body.state === "done") { const gens = await this.#assignments.history(a.id); owner = gens[gens.length - 1]?.owner; }
      const contract = (await this.#runner.get("task-contract", a.id))?.body as unknown as { priority?: number; workClass?: "P" | "PC" } | undefined;
      facts.tasks.push({ id: a.id, revision: a.revision, updatedAt: a.updatedAt, body, ...(owner === undefined ? {} : { owner: owner.kind === "agent" ? (owner.id.startsWith("agent:") ? owner.id : `agent:${owner.id}`) : `${owner.kind}:${owner.id}` }), priority: contract?.priority ?? 5, workClass: contract?.workClass ?? "P" });
    });
    const inProject = new Set(facts.tasks.map((t) => t.id));
    await this.#scan("blocker", facts, (a) => { const b = a.body as unknown as BlockerBody; if (b.state === "open" && b.subject.kind === "task" && inProject.has(b.subject.id)) facts.blockers.push(a); });
    await this.#scan("wait", facts, (a) => { const w = a.body as unknown as WaitBody; if (w.state === "open" && inProject.has(w.taskId)) facts.waits.push(a); });
    await this.#scan("inquiry", facts, (a) => { const q = a.body as unknown as InquiryBody; if (q.projectId === projectId && q.state === "open") facts.inquiries.push(a); });
    await this.#scan("artifact", facts, (a) => { const art = a.body as unknown as ArtifactBody; if (art.projectId === projectId && art.taskId !== undefined && inProject.has(art.taskId) && a.createdAt > since && a.createdAt <= until) facts.artifacts.push(a); });
    await this.#scan("improvement-item", facts, (a) => { const b = a.body as unknown as ImprovementBody; if (b.projectId === projectId) facts.improvements.push(a); });
    return facts;
  }

  async #classOf(taskId: string): Promise<"P" | "PC"> {
    return ((await this.#runner.get("task-contract", taskId))?.body as unknown as { workClass?: "P" | "PC" } | undefined)?.workClass ?? "P";
  }

  /** Makes, refreshes or leaves a participant's brief. The agent is only looked at (its availability is recorded), never asked or started. */
  async #brief(by: Principal, occurrenceId: string, occurrence: OccurrenceBody, agent: string, since: string, until: string, facts: Facts): Promise<{ agent: string; briefId: string; change: "created" | "updated" | "unchanged"; briefed: [string, number][] }> {
    const briefId = derivedId("sbr", `standup-brief:${occurrenceId}:${agent}`);
    const mine = facts.tasks.filter((t) => t.owner === agent);
    const sections: Record<BriefSection, BriefEntry[]> = { accomplishments: [], unfinished: [], blockers: [], advice: [], priorities: [] };
    const tcite = (t: TaskFact): Cite => ({ kind: "task", id: t.id, revision: t.revision });
    for (const t of mine) if (t.body.state === "done") sections.accomplishments.push({ text: `${cut(t.body.title, 120)} was marked done (${t.updatedAt}).`, cites: [tcite(t)] });
    for (const a of facts.artifacts) {
      const art = a.body as unknown as ArtifactBody;
      const t = mine.find((x) => x.id === art.taskId);
      if (t !== undefined) sections.accomplishments.push({ text: `Artifact ${cut(art.name, 100)} was recorded for ${cut(t.body.title, 100)} (${a.createdAt}).`, cites: [{ kind: "artifact", id: a.id, revision: a.revision }, tcite(t)] });
    }
    const open = mine.filter((t) => t.body.state === "ready" || t.body.state === "in_progress" || t.body.state === "blocked");
    for (const t of open) sections.unfinished.push({ text: `${cut(t.body.title, 120)} is ${STATE_WORDS[t.body.state]}.`, cites: [tcite(t)] });
    for (const t of open) {
      const mineBlockers = facts.blockers.filter((b) => (b.body as unknown as BlockerBody).subject.id === t.id);
      for (const b of mineBlockers) {
        const body = b.body as unknown as BlockerBody;
        sections.blockers.push({ text: `${cut(t.body.title, 100)} is held: ${cut(body.summary, 200)} (waiting for ${cut(body.resolver, 60)}).`, cites: [{ kind: "blocker", id: b.id, revision: b.revision }, tcite(t)] });
      }
      for (const w of facts.waits.filter((x) => (x.body as unknown as WaitBody).taskId === t.id)) {
        const body = w.body as unknown as WaitBody;
        sections.blockers.push({ text: `${cut(t.body.title, 100)} is waiting for ${cut(body.resolver, 60)} (${body.reason}): ${cut(body.summary, 200)}`, cites: [{ kind: "wait", id: w.id, revision: w.revision }, tcite(t)] });
      }
      if (t.body.state === "blocked" && mineBlockers.length === 0 && !facts.waits.some((x) => (x.body as unknown as WaitBody).taskId === t.id)) sections.blockers.push({ text: `${cut(t.body.title, 120)} is blocked and no blocker or wait is recorded for it.`, cites: [tcite(t)] });
    }
    for (const q of facts.inquiries) {
      const body = q.body as unknown as InquiryBody;
      if (body.asker === agent) sections.advice.push({ text: `Asked another agent a question (${body.askedAt}).`, detail: `Asked ${cut(body.to, 60)}: ${cut(body.question, 200)}`, cites: [{ kind: "inquiry", id: q.id, revision: q.revision }] });
    }
    const briefedItems: [string, number][] = [];
    // A decision on the agent's improvement proposal that it has not been told yet (the notice could not be filed on a task of its own): told here, in the brief it reads.
    for (const u of facts.improvements) {
      const body = u.body as unknown as ImprovementBody;
      if (!body.returnPending) continue;
      const proposers = [body.proposedBy, ...(body.duplicates ?? []).map((d) => (facts.improvements.find((x) => x.id === d)?.body as unknown as ImprovementBody | undefined)?.proposedBy)];
      if (proposers.includes(agent)) briefedItems.push([u.id, u.revision]);
      if (proposers.includes(agent)) sections.advice.push({ text: cut(outcomeText(body), 400), cites: [{ kind: "improvement-item", id: u.id, revision: u.revision }] });
    }
    // Messages are delivered at the boundary by the agent itself (it reads and confirms them); the brief only tells it they are there.
    if (this.#options.waitingMessages !== undefined) {
      const waiting = await this.#options.waitingMessages(by, agent).catch(() => 0);
      if (waiting > 0) sections.advice.push({ text: `${waiting} message${waiting === 1 ? " is" : "s are"} waiting for you. Read ${waiting === 1 ? "it" : "them"} at this stand-up (boundary stand-up, this meeting).`, cites: [] });
    }
    const next = open.filter((t) => t.body.state !== "blocked").sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : 1)).slice(0, STANDUP_LIMITS.priorities);
    for (const t of next) sections.priorities.push({ text: `${cut(t.body.title, 120)} (priority ${t.priority}, ${STATE_WORDS[t.body.state]}).`, cites: [tcite(t)] });
    const more: Partial<Record<BriefSection, number>> = {};
    for (const s of BRIEF_SECTIONS) if (sections[s].length > STANDUP_LIMITS.section) { more[s] = sections[s].length - STANDUP_LIMITS.section; sections[s] = sections[s].slice(0, STANDUP_LIMITS.section); }
    const agentState = await this.#reach(agent);
    const content = { accomplishments: sections.accomplishments, unfinished: sections.unfinished, blockers: sections.blockers, advice: sections.advice, priorities: sections.priorities, more, partial: facts.partial, agentState, coversFrom: since };
    const digest = sha256(canonicalJson(content as unknown as JsonObject));
    const existing = await this.#runner.get("standup-brief", briefId);
    const old = existing?.body as unknown as BriefBody | undefined;
    if (old !== undefined && old.digest === digest) return { agent, briefId, change: "unchanged", briefed: briefedItems };
    // A brief is not rewritten once the meeting has started: it stays what the meeting saw.
    if (old !== undefined && occurrence.mode === "live" && Date.parse(until) >= Date.parse(occurrence.startsAt)) return { agent, briefId, change: "unchanged", briefed: [] };
    const body: BriefBody = { occurrenceId, projectId: occurrence.projectId, agent, coversFrom: since, coversTo: until, agentState, ...sections, more, statements: old?.statements ?? [], partial: facts.partial, digest, assembledAt: until };
    await this.#runner.command("standup.brief.assemble", { commandId: `sba:${briefId}:${existing?.revision ?? 0}:${digest.slice(0, 16)}`, actor: by.id }, async () => ({
      payload: { briefId, revision: existing?.revision ?? 0, digest },
      build: async () => {
        const ref: AggregateRef = { kind: "standup-brief", id: briefId };
        return { ref, creates: existing === undefined, changes: [existing === undefined ? { type: "create", ref, body: clean(body) } : { type: "update", ref, expectedRevision: existing.revision, body: clean(body) }], detail: { projectId: occurrence.projectId, occurrenceId } };
      },
    }));
    return { agent, briefId, change: existing === undefined ? "created" : "updated", briefed: briefedItems };
  }

  /** The short P/PC balance review: delivered and pending production, capacity work attempted and evaluated, the allocation against actual use, deferred PC work and the next protected improvement window. */
  async #review(projectId: string, since: string, until: string, facts: Facts): Promise<PlanningReview> {
    const lines: ReviewLine[] = [];
    const project: Cite = { kind: "project", id: projectId };
    const live = facts.tasks.filter((t) => t.body.state !== "done" || (t.updatedAt > since && t.updatedAt <= until));
    const doneP = live.filter((t) => t.workClass === "P" && t.body.state === "done");
    const pendingP = live.filter((t) => t.workClass === "P" && t.body.state !== "done");
    const donePC = live.filter((t) => t.workClass === "PC" && t.body.state === "done");
    const activePC = live.filter((t) => t.workClass === "PC" && (t.body.state === "in_progress" || t.body.state === "ready"));
    const blockedPC = live.filter((t) => t.workClass === "PC" && t.body.state === "blocked");
    const titles = (ts: TaskFact[]): string => (ts.length === 0 ? "" : `: ${ts.slice(0, 3).map((t) => cut(t.body.title, 60)).join("; ")}${ts.length > 3 ? `; and ${ts.length - 3} more` : ""}`);
    lines.push({ text: `Production (P): ${doneP.length} delivered since ${since}${titles(doneP)}; ${pendingP.length} pending.`, cites: [project, ...doneP.slice(0, 3).map((t) => ({ kind: "task", id: t.id, revision: t.revision }))] });
    // Improvement proposals of the project.
    const items: View<ImprovementBody>[] = [];
    const index = await this.#runner.get("improvement-index", projectId);
    for (const id of (index?.body as unknown as { ids?: string[] } | undefined)?.ids ?? []) { const f = await this.#runner.get("improvement-item", id); if (f !== undefined) items.push(view<ImprovementBody>(f)); }
    const by = (d: string): View<ImprovementBody>[] => items.filter((i) => i.disposition === d && i.groupedUnder === undefined);
    const adopted = items.filter((i) => i.disposition === "adopted" && i.updatedAt > since);
    const stopped = items.filter((i) => i.disposition === "stopped" && i.updatedAt > since);
    const deferred = by("deferred");
    const openItems = items.filter((i) => i.groupedUnder === undefined && !["adopted", "rejected", "stopped"].includes(i.disposition));
    lines.push({
      text: `Capacity (PC): ${donePC.length} PC task${donePC.length === 1 ? "" : "s"} finished and ${activePC.length} under way${titles(donePC)}; improvement proposals: ${openItems.length} open, ${adopted.length} adopted and ${stopped.length} stopped since ${since}${adopted.length === 0 ? "" : ` (adopted: ${adopted.slice(0, 3).map((i) => cut(i.title, 60)).join("; ")})`}.`,
      cites: [project, ...donePC.slice(0, 3).map((t) => ({ kind: "task", id: t.id, revision: t.revision })), ...adopted.slice(0, 3).map((i) => ({ kind: "improvement-item", id: i.id, revision: i.revision }))],
    });
    const allocation = this.#options.allocation === undefined ? undefined : await this.#options.allocation().catch(() => undefined);
    const classed = live.filter((t) => t.body.state === "in_progress" || t.body.state === "done");
    const byCount = classed.length === 0 ? undefined : Math.round((classed.filter((t) => t.workClass === "PC").length / classed.length) * 100);
    const measured = this.#options.usage === undefined ? undefined : await this.#options.usage(projectId, since, until).catch(() => undefined);
    const planned = allocation === undefined || (allocation.floor === undefined && allocation.target === undefined && allocation.ceiling === undefined) ? "no P/PC allocation is set" : `planned PC share: floor ${allocation.floor ?? "-"}%, target ${allocation.target ?? "-"}%, ceiling ${allocation.ceiling ?? "-"}%`;
    const actual = measured !== undefined ? `actual PC share ${measured.pcShare}% (${cut(measured.basis, 100)})` : byCount !== undefined ? `actual PC share ${byCount}% by count of tasks worked on or finished (worker-slot time is not measured here, so this is only a rough guide)` : "nothing was worked on or finished in the period";
    lines.push({ text: `Allocation against use: ${planned}; ${actual}.`, cites: [project] });
    const pcDeferred = blockedPC.length + deferred.length;
    lines.push({
      text: `Deferred PC work: ${pcDeferred === 0 ? "none" : `${blockedPC.length} PC task${blockedPC.length === 1 ? "" : "s"} blocked and ${deferred.length} proposal${deferred.length === 1 ? "" : "s"} deferred${deferred.length === 0 ? "" : ` (${deferred.slice(0, 3).map((i) => `${cut(i.title, 50)}: next step ${cut(i.nextStep ?? "", 80)}`).join("; ")})`}`}.`,
      cites: [project, ...blockedPC.slice(0, 3).map((t) => ({ kind: "task", id: t.id, revision: t.revision })), ...deferred.slice(0, 3).map((i) => ({ kind: "improvement-item", id: i.id, revision: i.revision }))],
    });
    const window = this.#options.improvementWindow === undefined ? undefined : await this.#options.improvementWindow(projectId).catch(() => undefined);
    lines.push({ text: `Next protected improvement window: ${window ?? "none is scheduled"}.`, cites: [project] });
    if (facts.partial) lines.push({ text: "The search stopped before every record was read, so these figures may be low.", cites: [project] });
    return {
      projectId, coversFrom: since, at: until, lines, partial: facts.partial,
      figures: {
        deliveredP: doneP.length, pendingP: pendingP.length, deliveredPC: donePC.length, activePC: activePC.length, deferredPC: pcDeferred, improvementsOpen: openItems.length, improvementsAdopted: adopted.length, improvementsStopped: stopped.length, improvementsDeferred: deferred.length,
        ...(measured !== undefined ? { pcShareByCount: measured.pcShare } : byCount !== undefined ? { pcShareByCount: byCount } : {}),
        ...(allocation?.floor === undefined ? {} : { floor: allocation.floor }), ...(allocation?.ceiling === undefined ? {} : { ceiling: allocation.ceiling }), ...(allocation?.target === undefined ? {} : { target: allocation.target }),
      },
    };
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= STANDUP_LIMITS.retries) throw error;
      }
    }
  }
}

// ---- pure helpers -----------------------------------------------------------------------------------------------------------------

export interface AgendaLine {
  readonly id: string;
  readonly topic: string;
  readonly category: "conflict" | "question" | "decision" | "topic" | "improvement";
  readonly urgency: string;
  readonly intent: string;
  /** What the request type lets the team do with it, in words. */
  readonly authority: string;
  readonly executes: boolean;
  readonly votable: boolean;
  readonly state: string;
  readonly owner: string;
  readonly question?: string;
  readonly requestedOutcome?: string;
  readonly timeboxMinutes?: number;
  readonly deferral?: { readonly reason: string; readonly nextStep: string };
  readonly source?: { readonly kind: string; readonly id: string };
  readonly cite: Cite;
}

export function lineOf(item: View<AgendaBody>): AgendaLine {
  const authority = authorityOf(item.intent);
  return {
    id: item.id, topic: item.topic, category: categoryOf(item), urgency: item.urgency, intent: item.intent, authority: authority.words, executes: authority.executes, votable: authority.votable, state: item.state, owner: item.owner,
    ...(item.question === undefined ? {} : { question: item.question }), ...(item.requestedOutcome === undefined ? {} : { requestedOutcome: item.requestedOutcome }), ...(item.timeboxMinutes === undefined ? {} : { timeboxMinutes: item.timeboxMinutes }),
    ...(item.deferral === undefined ? {} : { deferral: item.deferral }), ...(item.source === undefined ? {} : { source: item.source }), cite: { kind: "agenda-item", id: item.id, revision: item.revision },
  };
}

/**
 * The captured item as the owner is shown it in chat, so it can be checked and corrected: the topic, their own question, the context and constraints, the outcome asked for, the urgency, who it is for, the request type and what that lets the team do,
 * and the revision and ID a correction names. Built from the typed record only.
 */
export function shownLines(item: View<AgendaBody>): string[] {
  const authority = authorityOf(item.intent);
  const lines = [
    `Agenda item ${item.id} (revision ${item.revision}), ${item.state === "queued" ? "saved for the next stand-up" : item.state}: "${cut(item.topic, 160)}".`,
    ...(item.question === undefined ? [] : [`Your question, as recorded: ${cut(item.question, 300)}`]),
    ...(item.context === undefined ? [] : [`Context and constraints: ${cut(item.context, 300)}`]),
    ...(item.requestedOutcome === undefined ? [] : [`Outcome asked for: ${cut(item.requestedOutcome, 200)}`]),
    `Urgency: ${item.urgency}. For: ${item.participants.length === 0 ? "whoever is at the meeting" : item.participants.join(", ")}. Kind of point: ${categoryOf(item)}.`,
    `Request type: ${item.intent.replace("-", " ")} - ${authority.words}.`,
    "Nothing has been done on it. To change what was recorded, say what to correct.",
  ];
  return lines;
}

/** What the originating conversation is told about a topic, from the typed record. A discussion or recommendation request says plainly that nothing was done because of it. */
export function outcomeLine(item: Pick<AgendaBody, "topic" | "state" | "intent" | "deferral" | "outcomeNote" | "outcomeRef">): string {
  const head = `Your topic "${cut(item.topic, 120)}"`;
  const authority = authorityOf(item.intent);
  const tail = authority.executes ? "" : " This was raised for discussion or advice: no work was started because of it.";
  const ref = item.outcomeRef === undefined ? "" : ` Record: ${cut(item.outcomeRef, 120)}.`;
  switch (item.state) {
    case "resolved": return `${head} was settled at the stand-up${item.outcomeNote === undefined ? "." : `: ${cut(item.outcomeNote, 600)}`}${ref}${tail}`;
    case "discussed": return `${head} was discussed at the stand-up${item.outcomeNote === undefined ? "." : `: ${cut(item.outcomeNote, 600)}`}${ref}${tail}`;
    case "deferred": return `${head} was not settled and stays on the list. Reason: ${cut(item.deferral?.reason ?? "", 300)} Next step: ${cut(item.deferral?.nextStep ?? "", 300)}${item.outcomeNote === undefined ? "" : ` ${cut(item.outcomeNote, 400)}`}${tail}`;
    default: return `${head} is ${item.state}.`;
  }
}

/**
 * What needs the owner, from the notification inbox (card U11): the unanswered items of the project (items that name no project are not shown on any project's agenda), urgent first, then oldest, for `StandupOptions.ownerItems`. The daily meeting opens with them, so the owner answers in
 * one place; each line cites its inbox item. The owner's own principal reads the inbox.
 */
export function needsOwnerFrom(notifications: { inbox(owner: Principal): Promise<{ readonly items: readonly View<ItemBody>[] }> }, owner: Principal): (projectId: string) => Promise<ReviewLine[]> {
  return async (projectId) => {
    const open = (await notifications.inbox(owner)).items.filter((i) => i.state !== "answered" && i.state !== "settled" && i.projectId === projectId);
    open.sort((a, b) => Number(b.urgent) - Number(a.urgent) || (a.firstAt < b.firstAt ? -1 : a.firstAt > b.firstAt ? 1 : a.id < b.id ? -1 : 1));
    return open.map((i) => ({ text: `${i.urgent ? "Urgent: " : ""}${cut(i.label, 200)}${i.count > 1 ? ` (reported ${i.count} times)` : ""}, waiting since ${i.firstAt}.`, cites: [{ kind: "notification-item", id: i.id, revision: i.revision }] }));
  };
}

/** The P/PC allocation from the configuration service (`workClass.pcFloor`, `pcTarget`, `pcCeiling`), for `StandupOptions.allocation`. Unreadable: undefined. */
export function allocationFrom(configuration: { effective(by: Principal): Promise<{ readonly values: Readonly<Record<string, { readonly value: unknown }>> } | undefined> }, owner: Principal): () => Promise<Allocation | undefined> {
  return async () => {
    const values = (await configuration.effective(owner))?.values;
    if (values === undefined) return undefined;
    const num = (key: string): number | undefined => { const v = values[key]?.value; return typeof v === "number" ? v : undefined; };
    const floor = num("workClass.pcFloor"); const target = num("workClass.pcTarget"); const ceiling = num("workClass.pcCeiling");
    return { ...(floor === undefined ? {} : { floor }), ...(target === undefined ? {} : { target }), ...(ceiling === undefined ? {} : { ceiling }) };
  };
}
