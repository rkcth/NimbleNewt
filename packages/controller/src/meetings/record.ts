import { canonicalJson } from "../storage/json.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { DecisionService, RecordDecision } from "../decisions/decisions.js";
import { normalTopic, TOPIC } from "../decisions/records.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { BudgetService } from "../budgets/budgets.js";
import type { GrantService } from "../security/grants.js";
import type { ProjectService } from "../domain/service.js";
import { allows, inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import { clean, invalid, optionalPlain, plain, whole } from "../standups/shared.js";
import { ATTENDANCE_LIMITS, type MeetingDecision } from "./attendance.js";
import { authorityOf, type AgendaBody, type MeetingService, type OccurrenceBody } from "./meetings.js";
import {
  ENTRY_TAGS, FINAL_MOTION_STATES,
  type BallotBody, type ChangeRecord, type DecisionRecordBody, type MeetingEntryBody, type EntryKind, type EntryTag, type MotionBody, type MotionState, type OpenIndexBody, type OwnerResponse,
  type PlanBody, type ProposedChange, type RecordBody, type SourceCite, type MeetingSummaryBody, type SummaryContent,
} from "./record-types.js";
import { buildSummary } from "./summary.js";
import { BALLOT_VALUES, castingOutcome, tallyOf, verdictOf, type BallotValue, type CountedBallot, type VoteOutcome, type Tally, type TieBreak } from "./votes.js";

export type * from "./record-types.js";

/** How a kind of change is carried out. The controller registers one per kind it is willing to let a meeting decide (for example `task.update`). */
export interface ChangeApplier {
  /** The access action the carrying agent must hold, at the moment the change is applied, for the change's target (an action of the A02 grants). */
  readonly action: string;
  /** The project the target belongs to; `undefined` when it does not exist. */
  project(target: { kind: string; id: string }): Promise<string | undefined>;
  /**
   * Set for a kind of change that widens what someone may do or spend (a grant, a budget): the approval policy's class for it. Such a kind is allowed in a motion (owner decision 2026-10-29, answer to question 3 of the M02d design set),
   * but the decision waits for the owner unless the policy lets that class through (`widening`); otherwise it is carried out only once the owner agrees.
   */
  readonly widens?: "access-change" | "spend";
  /** Carries the change out. `commandId` is stable per change, so a repeat after a crash does it once. A `stale_revision` refusal means the target moved and the change is not applied. */
  apply(change: { readonly commandId: string; readonly actor: string; readonly target: { kind: string; id: string }; readonly expectedRevision: number; readonly patch: JsonObject; /** Who allowed it: `owner:agreed` (the owner agreed to the decision) or `policy:<class>` (the approval policy let its class through). */ readonly agreedBy: string }): Promise<{ revision?: number }>;
}

/**
 * A budget raise for a task, decided in a meeting (card M02e). It widens spend, so it is carried out only with the owner's agreement or where the approval policy lets spend through (the profile, with a specific setting
 * overriding it); it adds exactly the amounts the decision named to the task it named, as the controller's own identity, recording who allowed it.
 */
export function budgetRaiseApplier(budgets: Pick<BudgetService, "raiseAgreed">, controller: Principal, projects: Pick<ProjectService, "getTask">): ChangeApplier {
  return {
    action: "budget.manage",
    widens: "spend",
    async project(target) { return target.kind === "task" ? (await projects.getTask(target.id))?.projectId : undefined; },
    async apply(change) {
      const patch = change.patch as { costMicros?: unknown; computeMs?: unknown };
      const known = Object.keys(patch).every((k) => k === "costMicros" || k === "computeMs");
      const number = (v: unknown): number | undefined => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined);
      const costMicros = number(patch.costMicros); const computeMs = number(patch.computeMs);
      if (!known || (patch.costMicros !== undefined && costMicros === undefined) || (patch.computeMs !== undefined && computeMs === undefined) || (costMicros === undefined && computeMs === undefined)) {
        throw new DomainError("invalid_command", "a budget raise names costMicros and/or computeMs as positive whole numbers and nothing else");
      }
      if (change.target.kind !== "task") throw new DomainError("invalid_command", "a budget raise targets a task");
      await budgets.raiseAgreed(controller, { commandId: change.commandId, taskId: change.target.id, ...(costMicros === undefined ? {} : { costMicros }), ...(computeMs === undefined ? {} : { computeMs }), decisionId: change.commandId, agreedBy: change.agreedBy });
      return {};
    },
  };
}

/** Task titles and descriptions, through the project service (which checks the expected revision itself). */
export function taskUpdateApplier(projects: ProjectService): ChangeApplier {
  return {
    action: "task.update",
    async project(target) { return target.kind === "task" ? (await projects.getTask(target.id))?.projectId : undefined; },
    async apply(change) {
      const patch = change.patch as { title?: unknown; description?: unknown };
      const done = await projects.updateTask({
        commandId: change.commandId, actor: change.actor, taskId: change.target.id, expectedRevision: change.expectedRevision,
        ...(typeof patch.title === "string" ? { title: patch.title } : {}), ...(typeof patch.description === "string" ? { description: patch.description } : {}),
      });
      return { revision: done.revision };
    },
  };
}

/**
 * A grant of rights decided in a meeting (card M02e). The target is the project the grant is for; the patch names the agent, the one action and when it ends. It widens rights, so it is carried out only with the
 * owner's agreement or where the owner set the access-change cell by hand (a specific setting overrides the profile; the engine otherwise keeps a change of rights a decision for the owner). The carrying agent must
 * hold `principal.manage`. The grant is direct, for this project only, and ends.
 */
export function grantApplier(grants: Pick<GrantService, "grantAgreed">, controller: Principal): ChangeApplier {
  return {
    action: "principal.manage",
    widens: "access-change",
    async project(target) { return target.kind === "project" ? target.id : undefined; },
    async apply(change) {
      const patch = change.patch as { grantee?: unknown; action?: unknown; expiresAt?: unknown; basis?: unknown };
      const bad = (why: string): never => { throw new DomainError("invalid_command", `a grant names ${why}`); };
      if (Object.keys(patch).some((k) => !["grantee", "action", "expiresAt", "basis"].includes(k))) bad("grantee, action, expiresAt and basis and nothing else");
      if (change.target.kind !== "project") bad("the project it is for as its target");
      if (typeof patch.grantee !== "string" || typeof patch.action !== "string" || typeof patch.expiresAt !== "string") bad("an agent, one action and an end time");
      await grants.grantAgreed(controller, { commandId: change.commandId, grantee: patch.grantee as string, action: patch.action as string, project: change.target.id, expiresAt: patch.expiresAt as string, basis: typeof patch.basis === "string" && patch.basis.length > 0 ? patch.basis : "agreed in a meeting", decisionId: change.commandId, agreedBy: change.agreedBy });
      return {};
    },
  };
}

export interface RecordOptions extends RunnerOptions {
  /** The agent's grants and restrictions as they are now (A02): production wiring is the principal service's lookup passed through `GrantService.effective`. Never taken from a caller. Missing or `undefined`: the agent holds nothing. */
  readonly authority?: (agentPrincipalId: string) => Promise<Principal | undefined>;
  /** What a meeting may decide, by kind of change. */
  readonly appliers?: Readonly<Record<string, ChangeApplier>>;
  /** Whether a cited record can be shared with the meeting's readers. Default: nothing can (so a conclusion that cites a record is published as unverifiable). Asking for a rationale never grants access to a source. */
  readonly shareable?: (cite: SourceCite) => Promise<boolean>;
  /** Writes a short narrative overview of a record that is already complete. If it throws, the summary is kept without it. */
  readonly narrate?: (input: { readonly summary: SummaryContent }) => Promise<string>;
  /**
   * Told of each change of a decision that was carried out or not carried out, once it has a final state (card C09f): the target, the outcome and the reason, for the task activity. Best effort and repeatable (the caller derives a stable
   * command ID from the decision and the change); a failure never changes the decision.
   */
  readonly onChange?: (event: { decisionId: string; index: number; projectId: string; target: { kind: string; id: string }; state: "applied" | "not-applied"; summary: string; reason?: string }) => Promise<void>;
  /** Whether the approval policy lets a class of widening change be carried out without asking the owner (spend follows the profile: strict asks, derived and autonomous let it through in development; rights are the owner's unless the owner set that cell by hand). Missing: always ask the owner. */
  readonly widening?: (cls: "access-change" | "spend", projectId: string) => Promise<"allow" | "ask">;
  /** Minutes a vote stays open (default 10), unless the vote names its own. */
  readonly voteMinutes?: number;
}

export const RECORD_LIMITS = {
  text: 4000, reason: 500, entries: 1000, systemEntries: 50, motions: 30, trail: 60, tagged: 100, corrections: 100, changes: 10, versions: 20, sources: 5, openRecords: 100, patchBytes: 4000,
  voteMinutes: 10, voteMinutesMax: 120, abandonMinutes: 120, page: 100, retries: 12, history: 10,
} as const;

const AGENT = /^agent:[a-z0-9][a-z0-9-]{0,39}$/;
const OCCURRENCE_ID = /^mto-[a-z2-7]{20}$/;
const RECORD_ID = /^mrc-[a-z2-7]{20}$/;
const MOTION_ID = /^mmo-[a-z2-7]{20}$/;
const DECISION_ID = /^mdn-[a-z2-7]{20}$/;
const ENTRY_ID = /^mte-[a-z2-7]{20}-[0-9]{1,5}$/;
const AGENDA_ID = /^mag-[a-z2-7]{20}$/;
const TASK_ID = /^task-[a-z2-7]{20}$/;
/** What a meeting may never decide, whatever is registered: permissions, budgets, configuration and the like. A motion widens nothing. */
const NEVER = /^(?:\*|principal\.|grant|restriction|budget\.|config\.|routing\.|review\.policy|catalog\.|environment\.|mcp\.|agent\.manage|recovery\.|resource\.scope|project\.participants|events\.)/;

const OPEN_KIND = "meeting-record-open";
const isService = (p: Principal): boolean => (p.kind === "owner" || p.kind === "host" || p.kind === "service") && p.taskScope === undefined;
const ms = (iso: string): number => Date.parse(iso);
const addMinutes = (iso: string, minutes: number): string => new Date(ms(iso) + minutes * 60_000).toISOString();
const entryIdOf = (recordId: string, seq: number): string => `mte-${recordId.slice(4)}-${seq}`;
const forbidden = (by: Principal, what: string): DomainError => new DomainError("forbidden", `${by.id} may not ${what}`);
const known = <T>(a: Aggregate | undefined): T | undefined => (a === undefined ? undefined : (a.body as unknown as T));
const json = (value: object): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const jsonClean = (value: object): JsonObject => clean(value as Record<string, unknown>);

interface Draft {
  readonly kind: EntryKind;
  readonly by: string;
  readonly speaker: string;
  readonly text: string;
  readonly tag?: EntryTag;
  readonly assignee?: string;
  readonly taskId?: string;
  readonly motionId?: string;
  readonly motionVersion?: number;
  readonly corrects?: string;
  readonly overrules?: string;
  readonly answers?: string;
  readonly sources?: readonly SourceCite[];
  readonly data?: JsonObject;
}

interface Loaded { readonly agg: Aggregate; readonly body: RecordBody }

/**
 * Votes, decisions and meeting summaries (card M02). It keeps the *record* of a meeting and the rules the record enforces; running the meeting (the floor, the rounds, the chair's questions) is the procedure cards' job (M05, M06), which
 * call these commands.
 *
 * - **A transcript of typed entries.** Statements, owner messages, motions, amendments, rulings, votes, corrections and presence, in order, appended one record at a time under a sequence number. Nothing is edited: a correction is a new
 *   entry linked to the one it corrects. The transcript is durable the moment an entry is acknowledged, whether or not the meeting is later interrupted or a summarizer fails.
 * - **Motions and ballots.** A motion has versions; a material amendment makes a new version and needs a fresh vote. Ballots (with a required reason, abstentions included) are bound to the version, individual, hidden until the vote
 *   concludes, and revealed together; the roster is fixed when the record opens, so duplicate sessions, new agents and late roster edits add no voice. Quorum is a majority of the roster; the owner is never needed for it; absence is never
 *   approval. A tie is broken by the chair without a double vote (`votes.ts`). A vote has a time limit and a lease: a stuck vote or an abandoned record is closed by `sweep`.
 * - **Decisions.** A concluded motion becomes a decision record with the tally, the table of reasons, the dissent and a link to the discussion. An adopted decision is *in scope* only when the agenda item allows the team to act, no owner
 *   decision stands on its topic, and the carrying agents hold the action now (A02); otherwise it stays a recommendation. It is applied change by change, each against the revision it was proposed on: a target that moved means "not applied".
 *   A decision never grants anything, so an old grant is not reopened, and a grant revoked since the meeting is not honoured.
 * - **Owner presence.** The owner's arrival and departure are entries; the arrival reports what has already been adopted and applied. With the owner present an adopted decision waits for the owner's response; its absence leaves an in-scope
 *   decision actionable. The owner may agree, decline, or make a separate alternative decision (C08's record), which needs no re-vote.
 * - **Summary.** Built from the records alone: attendance, key updates, decisions with reasons and a link to the discussion, dissent, unresolved questions, actions, and the plan; adopted is kept apart from applied. A conclusion that rests on a
 *   private record is marked unverifiable for readers who cannot be shown it.
 */
export class MeetingRecordService {
  readonly #runner: CommandRunner;
  readonly #deps: { meetings?: MeetingService; decisions?: DecisionService };
  readonly #options: RecordOptions;

  private constructor(runner: CommandRunner, deps: { meetings?: MeetingService; decisions?: DecisionService }, options: RecordOptions) { this.#runner = runner; this.#deps = deps; this.#options = options; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: { meetings?: MeetingService; decisions?: DecisionService } = {}, options: RecordOptions = {}): MeetingRecordService {
    return new MeetingRecordService(new CommandRunner(storage, epoch, options), deps, options);
  }

  // ---- opening and presence ----------------------------------------------------------------------------------------------------------------

  /**
   * Opens the record of a live meeting that is still planned: owner, host, service, or `meeting.manage` in the project. The roster is the occurrence's (fixed from here on); those it could not reach are absent, not abstaining.
   * `chair` is an agent (on the roster or not); with none, a tie fails.
   */
  async open(by: Principal, command: NoActor & { occurrenceId: string; chair?: string }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "occurrenceId", "chair"]);
    const occurrenceId = typeof command.occurrenceId === "string" && OCCURRENCE_ID.test(command.occurrenceId) ? command.occurrenceId : invalid("occurrenceId", "is not a meeting ID");
    const chair = command.chair === undefined ? undefined : await this.#agent(command.chair, "chair");
    const id = derivedId("mrc", occurrenceId);
    const result = await this.#cmd("meeting.record.open", by, command.commandId, async () => ({
      payload: clean({ occurrenceId, chair }),
      build: async () => {
        const occ = known<OccurrenceBody>(await this.#runner.get("meeting-occurrence", occurrenceId));
        if (occ === undefined || !(isService(by) || allows(by, "meeting.manage", occ.projectId))) throw forbidden(by, "open that meeting's record");
        if (occ.mode !== "live" || occ.state !== "planned") throw new DomainError("invalid_command", `meeting ${occurrenceId} is ${occ.mode === "live" ? occ.state : "a catch-up report"}; there is nothing to hold`, { field: "occurrenceId" });
        if ((await this.#runner.get("meeting-record", id)) !== undefined) throw new DomainError("invalid_command", `meeting ${occurrenceId} already has a record`, { field: "occurrenceId" });
        const now = this.#runner.now();
        const index = await this.#runner.get(OPEN_KIND, occ.projectId);
        const ids = known<OpenIndexBody>(index)?.ids ?? [];
        if (ids.length >= RECORD_LIMITS.openRecords) throw new DomainError("unavailable", `${RECORD_LIMITS.openRecords} meeting records are already open in this project; finish some first`);
        const withheld = occ.participants.filter((p) => p.status !== "eligible" && p.status !== "owner-invited").map((p) => p.id);
        const body: RecordBody = {
          occurrenceId, projectId: occ.projectId, title: occ.title, state: "open", ...(chair === undefined ? {} : { chair }), chairChanges: 0, roster: occ.participants.map((p) => p.id), withheld, attended: [],
          ownerPresent: false, ownerJoins: 0, endsAt: occ.endsAt, nextSeq: 1, tagged: [], corrections: [], motions: [], openedAt: now, openedBy: by.id,
        };
        const ref: AggregateRef = { kind: "meeting-record", id };
        const indexBody: OpenIndexBody = { projectId: occ.projectId, ids: [...ids, id] };
        const indexChange: Change = index === undefined ? { type: "create", ref: { kind: OPEN_KIND, id: occ.projectId }, body: json(indexBody) } : { type: "update", ref: { kind: OPEN_KIND, id: occ.projectId }, expectedRevision: index.revision, body: json(indexBody) };
        return { ref, creates: true, changes: [{ type: "create", ref, body: json(body) }, indexChange], detail: { projectId: occ.projectId, occurrenceId } };
      },
    }));
    return { id: result.id, replayed: result.replayed };
  }

  /** Names or removes the chair (owner, host, service, or a manager). A vote opened under another chair can no longer take a casting vote: its tie fails. */
  async setChair(by: Principal, command: NoActor & { recordId: string; chair: string | null }): Promise<void> {
    onlyKnown(command, ["commandId", "recordId", "chair"]);
    const recordId = this.#recordId(command.recordId);
    const chair = command.chair === null ? null : await this.#agent(command.chair, "chair");
    await this.#cmd("meeting.record.chair", by, command.commandId, async () => ({
      payload: { recordId, chair },
      build: async () => {
        const head = await this.#open(recordId);
        if (!this.#controls(by, head.body)) throw forbidden(by, "change that meeting's chair");
        const { chair: _old, ...rest } = head.body;
        void _old;
        const next: RecordBody = { ...rest, ...(chair === null ? {} : { chair }), chairChanges: head.body.chairChanges + 1 };
        const done = this.#append(head, next, [{ kind: "presence", by: by.id, speaker: by.id, text: chair === null ? "The chair was removed." : `${chair} is now the chair.` }]);
        return { ref: done.ref, creates: false, changes: done.changes, detail: { projectId: head.body.projectId } };
      },
    }));
  }

  /** A roster member joins the meeting (it can be asked, and counts as present). Absent members (paused, suspended, stopped when the meeting was made) cannot join: that is the owner's wake decision, not this one. */
  async join(by: Principal, command: NoActor & { recordId: string }): Promise<void> { await this.#presence(by, command, "joined"); }
  async leave(by: Principal, command: NoActor & { recordId: string }): Promise<void> { await this.#presence(by, command, "left"); }

  async #presence(by: Principal, command: NoActor & { recordId: string }, what: "joined" | "left"): Promise<void> {
    onlyKnown(command, ["commandId", "recordId"]);
    const recordId = this.#recordId(command.recordId);
    await this.#cmd(`meeting.record.${what}`, by, command.commandId, async () => ({
      payload: { recordId },
      build: async () => {
        const head = await this.#open(recordId);
        if (!this.#member(by, head.body)) throw forbidden(by, "take part in that meeting");
        const attended = head.body.attended.includes(by.id) ? head.body.attended : [...head.body.attended, by.id];
        const done = this.#append(head, { ...head.body, attended }, [{ kind: "presence", by: by.id, speaker: by.id, text: `${by.id} ${what}.` }]);
        return { ref: done.ref, creates: false, changes: done.changes, detail: { projectId: head.body.projectId } };
      },
    }));
  }

  /**
   * The owner arrives (only the authenticated owner). Recorded as a durable entry that reports what has already happened: votes open, decisions adopted, and what was and was not applied, from the records. Arrival decides nothing.
   */
  async ownerJoin(by: Principal, command: NoActor & { recordId: string }): Promise<{ report: string }> {
    onlyKnown(command, ["commandId", "recordId"]);
    if (by.kind !== "owner") throw forbidden(by, "join as the owner");
    const recordId = this.#recordId(command.recordId);
    let report = "";
    await this.#cmd("meeting.record.owner-join", by, command.commandId, async () => ({
      payload: { recordId },
      build: async () => {
        const head = await this.#open(recordId);
        const lines = await this.#progress(head.body);
        report = lines;
        // A decision adopted while the owner was away but not yet carried out waits for the owner now that they are here.
        const holds: Change[] = [];
        for (const id of head.body.motions) {
          const m = known<MotionBody>(await this.#runner.get("meeting-motion", id));
          const agg = m?.decisionId === undefined ? undefined : await this.#runner.get("meeting-decision", m.decisionId);
          const d = known<DecisionRecordBody>(agg);
          if (agg === undefined || d === undefined || d.outcome !== "adopted" || d.scope !== "in-scope" || d.ownerResponse !== "not-asked") continue;
          if (d.changes.some((c) => c.state === "adopted") && !d.changes.some((c) => c.state === "applying")) holds.push({ type: "update", ref: { kind: "meeting-decision", id: agg.id }, expectedRevision: agg.revision, body: json({ ...d, ownerResponse: "pending" }) });
        }
        const done = this.#append(head, { ...head.body, ownerPresent: true, ownerJoins: head.body.ownerJoins + 1 }, [{ kind: "presence", by: by.id, speaker: by.id, text: `The owner joined. ${lines}`, data: { ownerJoined: true } }]);
        return { ref: done.ref, creates: false, changes: [...done.changes, ...holds], detail: { projectId: head.body.projectId } };
      },
    }));
    if (report === "") report = await this.#progressOf(recordId);
    return { report };
  }

  /** The owner leaves. Departure authorizes nothing: a decision that waits for the owner still waits. */
  async ownerLeave(by: Principal, command: NoActor & { recordId: string }): Promise<void> {
    onlyKnown(command, ["commandId", "recordId"]);
    if (by.kind !== "owner") throw forbidden(by, "leave as the owner");
    const recordId = this.#recordId(command.recordId);
    await this.#cmd("meeting.record.owner-leave", by, command.commandId, async () => ({
      payload: { recordId },
      build: async () => {
        const head = await this.#open(recordId);
        const done = this.#append(head, { ...head.body, ownerPresent: false }, [{ kind: "presence", by: by.id, speaker: by.id, text: "The owner left. Nothing is authorized by leaving; a decision waiting for the owner still waits." }]);
        return { ref: done.ref, creates: false, changes: done.changes, detail: { projectId: head.body.projectId } };
      },
    }));
  }

  // ---- entries ----------------------------------------------------------------------------------------------------------------------------

  /**
   * Appends a statement, an owner message, a ruling or a correction. Motions, amendments and votes have their own commands. An agent writes as itself; the controller (owner, host or service) may write down a roster agent's turn with
   * `speaker`, and the entry then shows both. Only the owner writes owner messages and overrules a ruling; only the chair rules. A correction is a new entry linked to the original, which is kept.
   */
  async append(by: Principal, command: NoActor & {
    recordId: string; kind: "statement" | "owner-message" | "ruling" | "correction"; text: string; speaker?: string; tag?: EntryTag; assignee?: string; taskId?: string; motionId?: string; corrects?: string; overrules?: string; answers?: string; sources?: readonly SourceCite[];
  }): Promise<{ id: string; seq: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "recordId", "kind", "text", "speaker", "tag", "assignee", "taskId", "motionId", "corrects", "overrules", "answers", "sources"]);
    const recordId = this.#recordId(command.recordId);
    if (!["statement", "owner-message", "ruling", "correction"].includes(command.kind as string)) invalid("kind", "must be statement, owner-message, ruling or correction (motions, amendments and votes have their own commands)");
    const text = plain(command.text, "text", RECORD_LIMITS.text);
    const tag = command.tag === undefined ? undefined : (ENTRY_TAGS as readonly string[]).includes(command.tag) ? command.tag : invalid("tag", `must be one of ${ENTRY_TAGS.join(", ")}`);
    if (tag !== undefined && command.kind !== "statement") invalid("tag", "only a statement is tagged");
    const assignee = command.assignee === undefined ? undefined : await this.#agent(command.assignee, "assignee");
    if (assignee !== undefined && tag !== "action" && tag !== "plan") invalid("assignee", "only an action or a plan item has an assignee");
    const taskId = command.taskId === undefined ? undefined : (typeof command.taskId === "string" && TASK_ID.test(command.taskId) ? command.taskId : invalid("taskId", "is not a task ID"));
    if (taskId !== undefined && tag !== "action" && tag !== "plan") invalid("taskId", "only an action or a plan item names a task");
    const motionId = command.motionId === undefined ? undefined : this.#motionId(command.motionId);
    if (motionId !== undefined && command.kind !== "ruling") invalid("motionId", "only a ruling is about a motion");
    const corrects = command.corrects === undefined ? undefined : this.#entryId(command.corrects, "corrects");
    if ((corrects !== undefined) !== (command.kind === "correction")) invalid("corrects", "a correction names the entry it corrects, and nothing else does");
    const overrules = command.overrules === undefined ? undefined : this.#entryId(command.overrules, "overrules");
    if (overrules !== undefined && command.kind !== "ruling") invalid("overrules", "only a ruling overrules");
    const answers = command.answers === undefined ? undefined : this.#entryId(command.answers, "answers");
    if (answers !== undefined && command.kind !== "statement") invalid("answers", "only a statement answers a question");
    const sources = this.#sources(command.sources);
    if (command.speaker !== undefined && (command.kind === "ruling" || command.kind === "owner-message")) invalid("speaker", "a ruling is the chair's own and an owner message the owner's own: nobody writes them down for another");
    const speakerAsked = command.speaker === undefined ? undefined : await this.#agent(command.speaker, "speaker");
    const result = await this.#cmd("meeting.record.append", by, command.commandId, async () => ({
      payload: clean({ recordId, kind: command.kind, text, speaker: speakerAsked, tag, assignee, taskId, motionId, corrects, overrules, answers, sources }),
      build: async () => {
        const head = await this.#open(recordId);
        const rec = head.body;
        if (speakerAsked !== undefined && !isService(by)) throw forbidden(by, "write down another agent's turn");
        const speaker = speakerAsked ?? by.id;
        const changes: Change[] = [];
        let next: RecordBody = rec;
        if (command.kind === "owner-message") {
          if (by.kind !== "owner" || speakerAsked !== undefined) throw forbidden(by, "write an owner message");
        } else if (command.kind === "ruling") {
          const chairIsAuthor = rec.chair !== undefined && by.id === rec.chair && speakerAsked === undefined;
          if (!(by.kind === "owner" || chairIsAuthor)) throw forbidden(by, "rule in that meeting");
          if (overrules !== undefined) {
            if (by.kind !== "owner") throw forbidden(by, "overrule a ruling");
            const earlier = await this.#entry(recordId, overrules);
            if (earlier === undefined || earlier.kind !== "ruling") invalid("overrules", "is not a ruling of this meeting");
          }
        } else if (command.kind === "statement") {
          if (speakerAsked === undefined ? !this.#speaks(by, rec) : !this.#speaksId(speakerAsked, rec)) throw forbidden(by, "speak in that meeting");
        }
        if (taskId !== undefined) {
          const task = known<TaskBody>(await this.#runner.get("task", taskId));
          if (task?.projectId !== rec.projectId) invalid("taskId", "is not a task of this meeting's project");
        }
        if (assignee !== undefined && !rec.roster.includes(assignee) && assignee !== rec.chair) invalid("assignee", "is not on this meeting's roster");
        let motion: Aggregate | undefined;
        if (motionId !== undefined) {
          motion = await this.#runner.get("meeting-motion", motionId);
          const m = known<MotionBody>(motion);
          if (motion === undefined || m === undefined || m.recordId !== recordId) invalid("motionId", "is not a motion of this meeting");
          if (m !== undefined && FINAL_MOTION_STATES.includes(m.state)) invalid("motionId", `motion ${m.number} is already ${m.state}`);
        }
        if (command.kind === "correction" && corrects !== undefined) {
          const target = await this.#entry(recordId, corrects);
          if (target === undefined || !["statement", "owner-message", "ruling"].includes(target.kind)) invalid("corrects", "is not an entry of this meeting that can be corrected");
          if (!(by.id === target?.speaker || by.kind === "owner" || (rec.chair !== undefined && by.id === rec.chair) || isService(by))) throw forbidden(by, "correct that entry");
          const prior = rec.corrections.find((c) => c.target === corrects);
          if (prior === undefined && rec.corrections.length >= RECORD_LIMITS.corrections) throw new DomainError("unavailable", `${RECORD_LIMITS.corrections} entries have already been corrected in this meeting`);
          const nextId = entryIdOf(recordId, rec.nextSeq);
          const corrections = prior === undefined ? [...rec.corrections, { target: corrects, entries: [nextId], text }] : rec.corrections.map((c) => (c.target === corrects ? { target: corrects, entries: [...c.entries, nextId], text } : c));
          next = { ...next, corrections, tagged: rec.tagged.map((t) => (t.entryId === corrects ? { ...t, text, correctedBy: nextId } : t)) };
        }
        if (answers !== undefined) {
          const q = rec.tagged.find((t) => t.entryId === answers);
          if (q === undefined || q.tag !== "question") invalid("answers", "is not a question of this meeting");
          next = { ...next, tagged: next.tagged.map((t) => (t.entryId === answers ? { ...t, answeredBy: entryIdOf(recordId, rec.nextSeq) } : t)) };
        }
        if (motion !== undefined && motionId !== undefined) {
          const m = known<MotionBody>(motion)!;
          if (m.trail.length >= RECORD_LIMITS.trail) throw new DomainError("unavailable", `motion ${m.number} already has ${RECORD_LIMITS.trail} entries`);
          changes.push({ type: "update", ref: { kind: "meeting-motion", id: motionId }, expectedRevision: motion.revision, body: json({ ...m, trail: [...m.trail, { entryId: entryIdOf(recordId, rec.nextSeq), seq: rec.nextSeq, kind: "ruling" }] }) });
        }
        const draft = { kind: command.kind, by: by.id, speaker, text, ...jsonDraft({ tag, assignee, taskId, motionId, corrects, overrules, answers }), ...(sources === undefined ? {} : { sources }) } as Draft;
        const done = this.#append(head, next, [draft]);
        // The entry is the command's subject, so a repeat answers with the entry it made.
        return { ref: { kind: "meeting-entry", id: entryIdOf(recordId, rec.nextSeq) }, creates: true, changes: [...done.changes, ...changes], detail: { projectId: rec.projectId, kind: command.kind, seq: rec.nextSeq } };
      },
    }));
    return { id: result.id, seq: Number(result.id.slice(result.id.lastIndexOf("-") + 1)), replayed: result.replayed };
  }

  // ---- motions ------------------------------------------------------------------------------------------------------------------------------

  /**
   * A roster member (or the chair) moves a motion. It may name the owner-decision topic it touches (a recorded owner decision on it is never overridden), the agenda item it answers (not an owner instruction, which is planned and not
   * voted on), and the changes it would make: only kinds the controller registered, never a permission, budget or configuration change, each against the revision of its target.
   */
  async move(by: Principal, command: NoActor & { recordId: string; text: string; topic?: string; agendaItemId?: string; changes?: readonly Omit<ProposedChange, "id">[]; sources?: readonly SourceCite[] }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "recordId", "text", "topic", "agendaItemId", "changes", "sources"]);
    const recordId = this.#recordId(command.recordId);
    const text = plain(command.text, "text", RECORD_LIMITS.text);
    const topic = command.topic === undefined ? undefined : (TOPIC.test(normalTopic(String(command.topic))) ? normalTopic(String(command.topic)) : invalid("topic", "must be 1 to 80 letters, digits, spaces and . _ / -"));
    const agendaItemId = command.agendaItemId === undefined ? undefined : (typeof command.agendaItemId === "string" && AGENDA_ID.test(command.agendaItemId) ? command.agendaItemId : invalid("agendaItemId", "is not an agenda item ID"));
    const sources = this.#sources(command.sources);
    const proposed = await this.#changes(command.changes);
    const id = derivedId("mmo", scopedCommandId(by.id, command.commandId));
    const result = await this.#cmd("meeting.motion.move", by, command.commandId, async () => ({
      payload: clean({ recordId, text, topic, agendaItemId, changes: proposed, sources }),
      build: async () => {
        const head = await this.#open(recordId);
        const rec = head.body;
        if (!this.#speaks(by, rec)) throw forbidden(by, "move a motion in that meeting");
        if (proposed.length > 0 && topic === undefined && agendaItemId === undefined) invalid("topic", "a motion that changes things names the owner-decision topic it touches, or the agenda item it answers, so that a recorded owner decision is never overridden unseen");
        if (rec.motions.length >= RECORD_LIMITS.motions) throw new DomainError("unavailable", `${RECORD_LIMITS.motions} motions have already been moved in this meeting`);
        for (const c of proposed) {
          if (!rec.roster.includes(c.agent)) invalid("changes", `${c.agent} is not on this meeting's roster`);
          const project = await this.#options.appliers?.[c.kind]?.project(c.target);
          if (project !== rec.projectId) invalid("changes", `the target ${c.target.kind} ${c.target.id} is not in this meeting's project`);
        }
        if (agendaItemId !== undefined) {
          const item = known<AgendaBody>(await this.#runner.get("agenda-item", agendaItemId));
          if (item === undefined || item.projectId !== rec.projectId || item.occurrenceId !== rec.occurrenceId || (item.state !== "scheduled" && item.state !== "discussed")) invalid("agendaItemId", "is not an item on this meeting's agenda");
          else if (!authorityOf(item.intent).votable) invalid("agendaItemId", "that topic is an explicit owner instruction: the team plans how to carry it out and does not vote on whether to");
        }
        const now = this.#runner.now();
        const motionRef: AggregateRef = { kind: "meeting-motion", id };
        const seq = rec.nextSeq;
        const entryId = entryIdOf(recordId, seq);
        const motion: MotionBody = {
          recordId, occurrenceId: rec.occurrenceId, projectId: rec.projectId, number: rec.motions.length + 1, proposer: by.id, version: 1, text, versions: [{ version: 1, text, by: by.id, at: now, entryId }],
          trail: [{ entryId, seq, kind: "motion" }], ...(topic === undefined ? {} : { topic }), ...(agendaItemId === undefined ? {} : { agendaItemId }), changes: proposed, ...(sources === undefined ? {} : { sources }),
          state: "proposed", limitMinutes: this.#options.voteMinutes ?? RECORD_LIMITS.voteMinutes, createdAt: now,
        };
        const attended = rec.attended.includes(by.id) || !rec.roster.includes(by.id) ? rec.attended : [...rec.attended, by.id];
        const done = this.#append(head, { ...rec, motions: [...rec.motions, id], attended }, [{
          kind: "motion", by: by.id, speaker: by.id, text: `Motion ${motion.number}: ${text}`, motionId: id, motionVersion: 1, ...(sources === undefined ? {} : { sources }),
          data: json({ number: motion.number, changes: proposed.map((c) => ({ id: c.id, kind: c.kind, summary: c.summary })), ...(topic === undefined ? {} : { topic }) }),
        }]);
        return { ref: motionRef, creates: true, changes: [{ type: "create", ref: motionRef, body: json(motion) }, ...done.changes], detail: { projectId: rec.projectId, recordId } };
      },
    }));
    return { id: result.id, replayed: result.replayed };
  }

  /**
   * The chair (or the owner, host, service) amends a motion. A *material* amendment makes a new version, sets the vote back to proposed (earlier ballots are bound to the old version and no longer count) and needs a fresh vote.
   * A non-material wording change is allowed only before voting opens.
   */
  async amend(by: Principal, command: NoActor & { motionId: string; expectedVersion: number; text: string; material: boolean; changes?: readonly Omit<ProposedChange, "id">[] }): Promise<{ version: number }> {
    onlyKnown(command, ["commandId", "motionId", "expectedVersion", "text", "material", "changes"]);
    const motionId = this.#motionId(command.motionId);
    const expectedVersion = whole(command.expectedVersion, "expectedVersion", 1, 1000);
    const text = plain(command.text, "text", RECORD_LIMITS.text);
    if (typeof command.material !== "boolean") invalid("material", "must say whether the amendment changes the substance");
    const replaced = command.changes === undefined ? undefined : await this.#changes(command.changes);
    if (replaced !== undefined && !command.material) invalid("changes", "a change to what the motion does is a material amendment");
    let version = 0;
    await this.#cmd("meeting.motion.amend", by, command.commandId, async () => ({
      payload: clean({ motionId, expectedVersion, text, material: command.material, changes: replaced }),
      build: async () => {
        const found = await this.#runner.get("meeting-motion", motionId);
        const motion = known<MotionBody>(found);
        if (found === undefined || motion === undefined) throw forbidden(by, "amend that motion");
        const head = await this.#open(motion.recordId);
        if (!this.#chairOrOwner(by, head.body)) throw forbidden(by, "amend that motion");
        if (motion.version !== expectedVersion) throw new DomainError("stale_revision", `motion ${motion.number} is at version ${motion.version}, not ${expectedVersion}`, { currentRevision: found.revision });
        if (motion.state !== "proposed" && motion.state !== "voting") throw new DomainError("invalid_command", `motion ${motion.number} is ${motion.state}; it cannot be amended`, { field: "motionId" });
        if (motion.state === "voting" && !command.material) invalid("material", "once voting has opened every amendment changes what is voted on and is material");
        if (motion.versions.length >= RECORD_LIMITS.versions) throw new DomainError("unavailable", `motion ${motion.number} has been amended ${RECORD_LIMITS.versions} times; table it and move a new one`);
        if (replaced !== undefined) for (const c of replaced) {
          if (!head.body.roster.includes(c.agent)) invalid("changes", `${c.agent} is not on this meeting's roster`);
          if ((await this.#options.appliers?.[c.kind]?.project(c.target)) !== head.body.projectId) invalid("changes", `the target ${c.target.kind} ${c.target.id} is not in this meeting's project`);
        }
        const nextVersion = command.material ? motion.version + 1 : motion.version;
        version = nextVersion;
        const seq = head.body.nextSeq;
        const entryId = entryIdOf(motion.recordId, seq);
        const now = this.#runner.now();
        const { closesAt: _c, heldAt: _h, votingOpenedAt: _v, chairAtOpen: _a, ...rest } = motion;
        void _c; void _h; void _v; void _a;
        const next: MotionBody = {
          ...rest, text, version: nextVersion, changes: replaced ?? motion.changes, state: "proposed",
          versions: command.material ? [...motion.versions, { version: nextVersion, text, by: by.id, at: now, entryId }] : motion.versions.map((v) => (v.version === motion.version ? { ...v, text } : v)),
          trail: [...motion.trail, { entryId, seq, kind: "amendment" }],
        };
        if (motion.trail.length >= RECORD_LIMITS.trail) throw new DomainError("unavailable", `motion ${motion.number} already has ${RECORD_LIMITS.trail} entries`);
        const done = this.#append(head, head.body, [{ kind: "amendment", by: by.id, speaker: by.id, text: `${command.material ? "Material amendment" : "Amendment"} to motion ${motion.number}${command.material ? ` (now version ${nextVersion}; a fresh vote is needed)` : ""}: ${text}`, motionId, motionVersion: nextVersion }]);
        return { ref: { kind: "meeting-motion", id: motionId }, creates: false, changes: [{ type: "update", ref: { kind: "meeting-motion", id: motionId }, expectedRevision: found.revision, body: json(next) }, ...done.changes], detail: { projectId: motion.projectId, material: command.material } };
      },
    }));
    return { version };
  }

  /** The chair ends discussion of a motion without a vote (for example to research it): tabled, with a reason. The owner, host or service can too. */
  async table(by: Principal, command: NoActor & { motionId: string; reason: string }): Promise<void> {
    onlyKnown(command, ["commandId", "motionId", "reason"]);
    const motionId = this.#motionId(command.motionId);
    const reason = plain(command.reason, "reason", RECORD_LIMITS.reason);
    await this.#cmd("meeting.motion.table", by, command.commandId, async () => ({
      payload: { motionId, reason },
      build: async () => {
        const found = await this.#runner.get("meeting-motion", motionId);
        const motion = known<MotionBody>(found);
        if (found === undefined || motion === undefined) throw forbidden(by, "table that motion");
        const head = await this.#open(motion.recordId);
        if (!this.#chairOrOwner(by, head.body)) throw forbidden(by, "table that motion");
        if (motion.state !== "proposed") throw new DomainError("invalid_command", `motion ${motion.number} is ${motion.state}; only a motion not yet put to a vote can be tabled`, { field: "motionId" });
        const seq = head.body.nextSeq;
        const done = this.#append(head, head.body, [{ kind: "ruling", by: by.id, speaker: by.id, text: `Motion ${motion.number} is tabled: ${reason}`, motionId, motionVersion: motion.version }]);
        const next: MotionBody = { ...motion, state: "tabled", closedAt: this.#runner.now(), voidReason: reason, trail: [...motion.trail, { entryId: entryIdOf(motion.recordId, seq), seq, kind: "ruling" }] };
        return { ref: { kind: "meeting-motion", id: motionId }, creates: false, changes: [{ type: "update", ref: { kind: "meeting-motion", id: motionId }, expectedRevision: found.revision, body: json(next) }, ...done.changes], detail: { projectId: motion.projectId } };
      },
    }));
  }

  // ---- voting --------------------------------------------------------------------------------------------------------------------------------

  /** Opens the vote on the current version (chair, owner, host or service). The quorum is fixed by the roster; if too few members can be asked for a binding vote the vote is deferred (refused here). */
  async openVote(by: Principal, command: NoActor & { motionId: string; expectedVersion: number; limitMinutes?: number }): Promise<{ closesAt: string }> {
    onlyKnown(command, ["commandId", "motionId", "expectedVersion", "limitMinutes"]);
    const motionId = this.#motionId(command.motionId);
    const expectedVersion = whole(command.expectedVersion, "expectedVersion", 1, 1000);
    const limit = command.limitMinutes === undefined ? undefined : whole(command.limitMinutes, "limitMinutes", 1, RECORD_LIMITS.voteMinutesMax);
    let closesAt = "";
    await this.#cmd("meeting.vote.open", by, command.commandId, async () => ({
      payload: clean({ motionId, expectedVersion, limitMinutes: limit }),
      build: async () => {
        const found = await this.#runner.get("meeting-motion", motionId);
        const motion = known<MotionBody>(found);
        if (found === undefined || motion === undefined) throw forbidden(by, "open that vote");
        const head = await this.#open(motion.recordId);
        if (!this.#chairOrOwner(by, head.body)) throw forbidden(by, "open that vote");
        if (motion.version !== expectedVersion) throw new DomainError("stale_revision", `motion ${motion.number} is at version ${motion.version}, not ${expectedVersion}`, { currentRevision: found.revision });
        if (motion.state !== "proposed") throw new DomainError("invalid_command", `motion ${motion.number} is ${motion.state}; a vote opens on a motion that is proposed`, { field: "motionId" });
        const tally = tallyOf(head.body.roster, head.body.withheld, []);
        if (tally.eligible < tally.quorum) throw new DomainError("invalid_command", `only ${tally.eligible} of ${tally.roster} members can be asked and ${tally.quorum} are needed, so a binding vote is deferred; reports and discussion go on`, { field: "motionId" });
        for (const o of head.body.motions) {
          if (o === motionId) continue;
          const other = known<MotionBody>(await this.#runner.get("meeting-motion", o));
          if (other?.state === "voting" || other?.state === "tie-pending") invalid("motionId", `motion ${other.number} is being voted on; one vote at a time`);
        }
        const now = this.#runner.now();
        const minutes = limit ?? motion.limitMinutes;
        closesAt = addMinutes(now, minutes);
        const seq = head.body.nextSeq;
        const done = this.#append(head, head.body, [{ kind: "vote", by: by.id, speaker: by.id, text: `Voting opened on motion ${motion.number} (version ${motion.version}). A majority of the roster (${tally.quorum} of ${tally.roster}) must cast ballots; closes at ${closesAt}.`, motionId, motionVersion: motion.version, data: { phase: "opened", closesAt } }]);
        const next: MotionBody = { ...motion, state: "voting", limitMinutes: minutes, votingOpenedAt: now, closesAt, ...(head.body.chair === undefined ? {} : { chairAtOpen: head.body.chair }), trail: [...motion.trail, { entryId: entryIdOf(motion.recordId, seq), seq, kind: "vote" }] };
        return { ref: { kind: "meeting-motion", id: motionId }, creates: false, changes: [{ type: "update", ref: { kind: "meeting-motion", id: motionId }, expectedRevision: found.revision, body: json(next) }, ...done.changes], detail: { projectId: motion.projectId } };
      },
    }));
    return { closesAt };
  }

  /** The owner starts an inquiry: the open vote is held (no ballot can be cast or revised) and its clock stops. Owner, host or service. */
  async hold(by: Principal, command: NoActor & { motionId: string }): Promise<void> { await this.#hold(by, command, true); }
  /** Ends the hold: the vote's remaining time resumes where it stopped. */
  async resume(by: Principal, command: NoActor & { motionId: string }): Promise<void> { await this.#hold(by, command, false); }

  async #hold(by: Principal, command: NoActor & { motionId: string }, holding: boolean): Promise<void> {
    onlyKnown(command, ["commandId", "motionId"]);
    const motionId = this.#motionId(command.motionId);
    await this.#cmd(holding ? "meeting.vote.hold" : "meeting.vote.resume", by, command.commandId, async () => ({
      payload: { motionId },
      build: async () => {
        const found = await this.#runner.get("meeting-motion", motionId);
        const motion = known<MotionBody>(found);
        if (found === undefined || motion === undefined) throw forbidden(by, "hold that vote");
        const head = await this.#open(motion.recordId);
        if (!isService(by)) throw forbidden(by, "hold that vote");
        if (motion.state !== "voting") throw new DomainError("invalid_command", `motion ${motion.number} is ${motion.state}; only an open vote is held`, { field: "motionId" });
        const now = this.#runner.now();
        let next: MotionBody;
        if (holding) {
          if (motion.heldAt !== undefined) throw new DomainError("invalid_command", `the vote on motion ${motion.number} is already held`, { field: "motionId" });
          next = { ...motion, heldAt: now };
        } else {
          if (motion.heldAt === undefined || motion.closesAt === undefined) throw new DomainError("invalid_command", `the vote on motion ${motion.number} is not held`, { field: "motionId" });
          const { heldAt: _h, ...rest } = motion;
          void _h;
          next = { ...rest, closesAt: new Date(ms(motion.closesAt) + Math.max(0, ms(now) - ms(motion.heldAt))).toISOString() };
        }
        const done = this.#append(head, head.body, [{ kind: "vote", by: by.id, speaker: by.id, text: holding ? `The vote on motion ${motion.number} is held: no ballot can be cast or revised until it resumes.` : `The vote on motion ${motion.number} resumes.`, motionId, motionVersion: motion.version, data: { phase: holding ? "held" : "resumed" } }]);
        return { ref: { kind: "meeting-motion", id: motionId }, creates: false, changes: [{ type: "update", ref: { kind: "meeting-motion", id: motionId }, expectedRevision: found.revision, body: json(next) }, ...done.changes], detail: { projectId: motion.projectId } };
      },
    }));
  }

  /**
   * A roster member casts its own ballot (never another's: the voter is the authenticated agent). A reason is required, abstentions too. One ballot per motion version; a voter may revise only because of an owner message that arrived
   * after its ballot, once per message (`ownerMessageEntryId`). Nobody else sees the ballot until the vote concludes, except the owner. Casting is refused when the vote is not open, is held, or its time has run out.
   */
  async castBallot(by: Principal, command: NoActor & { motionId: string; version: number; value: BallotValue; reason: string; sources?: readonly SourceCite[]; ownerMessageEntryId?: string }): Promise<{ revised: boolean }> {
    onlyKnown(command, ["commandId", "motionId", "version", "value", "reason", "sources", "ownerMessageEntryId"]);
    const motionId = this.#motionId(command.motionId);
    const version = whole(command.version, "version", 1, 1000);
    const value = (BALLOT_VALUES as readonly string[]).includes(command.value) ? command.value : invalid("value", "must be yes, no or abstain");
    const reason = plain(command.reason, "reason", RECORD_LIMITS.reason);
    const sources = this.#sources(command.sources);
    const trigger = command.ownerMessageEntryId === undefined ? undefined : this.#entryId(command.ownerMessageEntryId, "ownerMessageEntryId");
    let revised = false;
    await this.#cmd("meeting.vote.ballot", by, command.commandId, async () => ({
      payload: clean({ motionId, version, value, reason, sources, trigger }),
      build: async () => {
        const found = await this.#runner.get("meeting-motion", motionId);
        const motion = known<MotionBody>(found);
        const headAgg = motion === undefined ? undefined : await this.#runner.get("meeting-record", motion.recordId);
        const rec = known<RecordBody>(headAgg);
        // A member who may not vote and a vote that is not there get the same answer.
        if (found === undefined || motion === undefined || headAgg === undefined || rec === undefined || by.kind !== "agent" || by.asOf === undefined || !inTaskScope(by, rec.projectId) || !rec.roster.includes(by.id) || rec.withheld.includes(by.id)) throw forbidden(by, "vote on that motion");
        if (rec.state !== "open") throw new DomainError("invalid_command", `the meeting is ${rec.state}`, { field: "motionId" });
        if (motion.state !== "voting" || motion.closesAt === undefined) throw new DomainError("invalid_command", `motion ${motion.number} is not open for ballots (it is ${motion.state})`, { field: "motionId" });
        if (motion.heldAt !== undefined) throw new DomainError("invalid_command", `the vote on motion ${motion.number} is held for the owner's inquiry; no ballot can be cast or revised`, { field: "motionId" });
        const now = this.#runner.now();
        if (ms(now) >= ms(motion.closesAt)) throw new DomainError("invalid_command", `the time for voting on motion ${motion.number} is over`, { field: "motionId" });
        if (motion.version !== version) throw new DomainError("stale_revision", `motion ${motion.number} is at version ${motion.version}; a ballot is bound to one version`, { currentRevision: found.revision });
        const id = derivedId("mbl", `${motionId}:${by.id}`);
        const ref: AggregateRef = { kind: "meeting-ballot", id };
        const existing = await this.#runner.get("meeting-ballot", id);
        const prior = known<BallotBody>(existing);
        // Every ballot moves the motion's revision, so a vote closed (or amended, or held) at the same moment either sees this ballot or makes it retry: no acknowledged ballot is missing from a tally.
        const guard: Change = { type: "update", ref: { kind: "meeting-motion", id: motionId }, expectedRevision: found.revision, body: json({ ...motion, ballots: (motion.ballots ?? 0) + 1 }) };
        const at = now;
        if (prior === undefined || existing === undefined) {
          if (trigger !== undefined) invalid("ownerMessageEntryId", "there is no earlier ballot to revise");
          const body: BallotBody = { motionId, recordId: motion.recordId, projectId: rec.projectId, voter: by.id, version, value, reason, ...(sources === undefined ? {} : { sources }), at, history: [{ version, value, reason, at, trigger: "initial" }], revisedFor: [] };
          return { ref, creates: true, changes: [{ type: "create", ref, body: json({ ...body, castAtSeq: rec.nextSeq }) }, guard], detail: { projectId: rec.projectId, version } };
        }
        revised = prior.version === version;
        let revisedFor = prior.revisedFor;
        let why = "new-version";
        if (prior.version === version) {
          if (trigger === undefined) throw new DomainError("invalid_command", "you have already voted on this version; you may revise only after an owner message, naming it", { field: "ownerMessageEntryId" });
          const message = await this.#entry(motion.recordId, trigger);
          if (message === undefined || message.kind !== "owner-message") invalid("ownerMessageEntryId", "is not an owner message of this meeting");
          if (prior.revisedFor.includes(trigger)) throw new DomainError("invalid_command", "you have already revised for that owner message", { field: "ownerMessageEntryId" });
          if (message !== undefined && message.seq < (prior.castAtSeq ?? 0)) invalid("ownerMessageEntryId", "that owner message came before your ballot");
          if (prior.history.length >= RECORD_LIMITS.history) throw new DomainError("unavailable", `a ballot may be revised ${RECORD_LIMITS.history - 1} times at most`);
          revisedFor = [...prior.revisedFor, trigger];
          why = `owner-message:${trigger}`;
        } else if (trigger !== undefined) invalid("ownerMessageEntryId", "a ballot on a new version is not a revision");
        const body: BallotBody = { ...prior, version, value, reason, ...(sources === undefined ? {} : { sources }), at, revisedFor, history: [...prior.history.slice(-(RECORD_LIMITS.history - 1)), { version, value, reason, at, trigger: why }] };
        const { sources: _s, ...withoutSources } = body;
        void _s;
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: existing.revision, body: json({ ...(sources === undefined ? withoutSources : body), castAtSeq: rec.nextSeq }) }, guard], detail: { projectId: rec.projectId, version } };
      },
    }));
    return { revised };
  }

  /**
   * Closes a vote (chair, owner, host or service) once every member who could be asked has voted, or the time limit has passed. The tally and the table are revealed together, in a vote entry and a decision record. A tie that only
   * the chair can break stays open for the chair's casting vote, for the vote's time limit again.
   */
  async closeVote(by: Principal, command: NoActor & { motionId: string }): Promise<{ state: MotionState; decisionId?: string }> {
    onlyKnown(command, ["commandId", "motionId"]);
    const motionId = this.#motionId(command.motionId);
    return this.#close(by, command.commandId, motionId, undefined);
  }

  /** The chair's single casting vote on a tie (a chair who is not on the roster, abstained or cast nothing). Only the chair the vote opened under, only on a tie, once, and before the casting window runs out. */
  async castingVote(by: Principal, command: NoActor & { motionId: string; value: "yes" | "no"; reason: string }): Promise<{ state: MotionState; decisionId?: string }> {
    onlyKnown(command, ["commandId", "motionId", "value", "reason"]);
    const motionId = this.#motionId(command.motionId);
    if (command.value !== "yes" && command.value !== "no") invalid("value", "a casting vote is yes or no");
    const reason = plain(command.reason, "reason", RECORD_LIMITS.reason);
    return this.#close(by, command.commandId, motionId, { value: command.value, reason });
  }

  async #close(by: Principal, userCommandId: unknown, motionId: string, casting: { value: "yes" | "no"; reason: string } | undefined, fixedCommandId?: string): Promise<{ state: MotionState; decisionId?: string }> {
    let state: MotionState = "voting";
    let decisionId: string | undefined;
    const commandId = fixedCommandId ?? scopedCommandId(by.id, userCommandId);
    await this.#retrying(() => this.#runner.command(casting === undefined ? "meeting.vote.close" : "meeting.vote.casting", { commandId, actor: by.id }, async () => ({
      payload: { motionId, ...(casting === undefined ? {} : casting) },
      build: async () => {
        const found = await this.#runner.get("meeting-motion", motionId);
        const motion = known<MotionBody>(found);
        if (found === undefined || motion === undefined) throw forbidden(by, "close that vote");
        const head = await this.#open(motion.recordId);
        const rec = head.body;
        const now = this.#runner.now();
        const expired = (motion.closesAt !== undefined && motion.heldAt === undefined && ms(now) >= ms(motion.closesAt));
        const ballots = await this.#ballots(motionId, motion, rec);
        const tally = tallyOf(rec.roster, rec.withheld, ballots);
        const chairCanCast = rec.chair !== undefined && rec.chair === motion.chairAtOpen && !rec.withheld.includes(rec.chair);
        if (casting !== undefined) {
          if (motion.state !== "tie-pending" || motion.castingDeadline === undefined) throw new DomainError("invalid_command", `motion ${motion.number} is not waiting for a casting vote`, { field: "motionId" });
          if (rec.chair === undefined || by.id !== rec.chair || by.kind !== "agent" || !chairCanCast) throw forbidden(by, "cast the casting vote");
          if (ms(now) > ms(motion.castingDeadline)) throw new DomainError("invalid_command", `the time for the casting vote on motion ${motion.number} is over; the tie fails`, { field: "motionId" });
          const cast = castingOutcome(rec.chair, casting.value, casting.reason, tally);
          return this.#conclude(head, found, motion, ballots, tally, cast.outcome, cast.tie, by, (s, d) => { state = s; decisionId = d; });
        }
        if (!this.#chairOrOwner(by, rec)) throw forbidden(by, "close that vote");
        if (motion.state === "tie-pending") {
          if (motion.castingDeadline === undefined || ms(now) <= ms(motion.castingDeadline)) throw new DomainError("invalid_command", `motion ${motion.number} waits for the chair's casting vote until ${motion.castingDeadline ?? "its deadline"}`, { field: "motionId" });
          return this.#conclude(head, found, motion, ballots, tally, "failed", { how: "none", reason: `tied ${tally.yes}-${tally.no} and the chair gave no casting vote in time` }, by, (s, d) => { state = s; decisionId = d; });
        }
        if (motion.state !== "voting") throw new DomainError("invalid_command", `motion ${motion.number} is ${motion.state}; there is no open vote to close`, { field: "motionId" });
        if (motion.heldAt !== undefined) throw new DomainError("invalid_command", `the vote on motion ${motion.number} is held for the owner's inquiry`, { field: "motionId" });
        if (!expired && tally.silent.length > 0) throw new DomainError("invalid_command", `${tally.silent.length} member(s) have not voted and the time limit (${motion.closesAt ?? "-"}) has not passed`, { field: "motionId" });
        // Only the chair the vote opened under counts: a chair named or changed since gets neither its ballot nor a casting vote.
        const verdict = verdictOf(tally, ballots, rec.chair !== undefined && rec.chair === motion.chairAtOpen ? rec.chair : undefined, rec.roster, chairCanCast);
        if (verdict.state === "decided") return this.#conclude(head, found, motion, ballots, tally, verdict.outcome, verdict.tie, by, (s, d) => { state = s; decisionId = d; });
        // A tie only the chair can break: the vote stays unrevealed until the casting vote or its deadline.
        state = "tie-pending";
        const seq = rec.nextSeq;
        const deadline = addMinutes(now, motion.limitMinutes);
        const done = this.#append(head, rec, [{ kind: "vote", by: by.id, speaker: by.id, text: `The vote on motion ${motion.number} is tied. The chair may cast a single casting vote until ${deadline}; otherwise the tie fails. The ballots are revealed when the vote concludes.`, motionId, motionVersion: motion.version, data: { phase: "tie", castingDeadline: deadline } }]);
        const next: MotionBody = { ...motion, state: "tie-pending", castingDeadline: deadline, trail: [...motion.trail, { entryId: entryIdOf(motion.recordId, seq), seq, kind: "vote" }] };
        return { ref: { kind: "meeting-motion", id: motionId }, creates: false, changes: [{ type: "update", ref: { kind: "meeting-motion", id: motionId }, expectedRevision: found.revision, body: json(next) }, ...done.changes], detail: { projectId: motion.projectId, state: "tie-pending" } };
      },
    })));
    return { state, ...(decisionId === undefined ? {} : { decisionId }) };
  }

  /** Builds the change list that concludes a vote: the motion, its decision record, the vote entry that reveals the table, and the head. */
  async #conclude(head: Loaded, found: Aggregate, motion: MotionBody, ballots: readonly CountedBallot[], tally: Tally, outcome: VoteOutcome, tie: TieBreak | undefined, by: Principal, report: (state: MotionState, decisionId: string) => void) {
    const rec = head.body;
    const motionId = found.id;
    const now = this.#runner.now();
    const decisionId = derivedId("mdn", motionId);
    const table = rec.roster.flatMap((voter) => {
      const b = ballots.find((x) => x.voter === voter);
      return b === undefined ? [] : [{ voter, value: b.value, reason: b.reason, revisions: b.revisions }];
    });
    const sourcesOf = new Map<string, readonly SourceCite[]>();
    for (const t of table) {
      const rec2 = known<BallotBody>(await this.#runner.get("meeting-ballot", derivedId("mbl", `${motionId}:${t.voter}`)));
      if (rec2?.sources !== undefined) sourcesOf.set(t.voter, rec2.sources);
    }
    const rows = table.map((t) => ({ ...t, ...(sourcesOf.has(t.voter) ? { sources: sourcesOf.get(t.voter)! } : {}) }));
    const against = (v: BallotValue): boolean => (outcome === "adopted" ? v === "no" : outcome === "rejected" ? v === "yes" : false);
    const dissent = table.filter((t) => against(t.value)).map((t) => ({ voter: t.voter, value: t.value, reason: t.reason }));
    const abstained = table.filter((t) => t.value === "abstain").map((t) => t.voter);
    const scope = outcome === "adopted" ? await this.#scope(motion, rec) : { scope: "in-scope" as const };
    const adopted = outcome === "adopted";
    const changeRecords: ChangeRecord[] = !adopted ? [] : motion.changes.map((c) => (scope.scope === "recommendation" ? { ...c, state: "not-applied" as const, code: "recommendation" as const, reason: scope.reason ?? "advisory only", at: now } : { ...c, state: "adopted" as const }));
    // A change that widens rights or spend waits for the owner unless the approval policy lets its class through, whether or not the owner is in the room.
    let widensAsk = false;
    if (adopted && scope.scope === "in-scope") for (const c of changeRecords) { const cls = this.#options.appliers?.[c.kind]?.widens; if (cls !== undefined && (this.#options.widening === undefined || (await this.#options.widening(cls, motion.projectId).catch(() => "ask" as const)) !== "allow")) widensAsk = true; }
    const ownerResponse: OwnerResponse = adopted && scope.scope === "in-scope" && changeRecords.length > 0 && (rec.ownerPresent || widensAsk) ? "pending" : "not-asked";
    const voteSeq = rec.nextSeq;
    const voteEntry = entryIdOf(motion.recordId, voteSeq);
    const trail = [...motion.trail, { entryId: voteEntry, seq: voteSeq, kind: "vote" as const }];
    const decision: DecisionRecordBody = {
      motionId, recordId: motion.recordId, occurrenceId: motion.occurrenceId, projectId: motion.projectId, number: motion.number, version: motion.version, text: motion.text, outcome, tally, ...(tie === undefined ? {} : { tie }),
      table: rows, dissent, abstained, discussion: { fromSeq: trail[0]!.seq, toSeq: voteSeq, entryIds: trail.map((t) => t.entryId) },
      scope: scope.scope, ...(scope.reason === undefined ? {} : { scopeReason: scope.reason }), changes: changeRecords, ownerResponse,
      ...(motion.agendaItemId === undefined ? {} : { agendaItemId: motion.agendaItemId }), ...(motion.topic === undefined ? {} : { topic: motion.topic }), ...(motion.sources === undefined ? {} : { sources: motion.sources }), concludedAt: now,
    };
    const words = outcome === "adopted" ? "adopted" : outcome === "rejected" ? "rejected" : outcome === "no-quorum" ? "not decided: no quorum" : "failed";
    const text = `Motion ${motion.number} ${words}. Yes ${tally.yes}, no ${tally.no}, abstain ${tally.abstain}; ${tally.cast} of ${tally.roster} cast ballots (quorum ${tally.quorum}).${tie === undefined ? "" : ` ${tie.reason}.`}`;
    const done = this.#append(head, rec, [{ kind: "vote", by: by.id, speaker: by.id, text, motionId, motionVersion: motion.version, data: json({ phase: "closed", outcome, tally, table: rows.map((r) => ({ voter: r.voter, value: r.value, reason: r.reason })), ...(tie === undefined ? {} : { tie }) }) }]);
    const next: MotionBody = { ...motion, state: outcome, closedAt: now, decisionId, trail };
    const { castingDeadline: _c, ...closed } = next;
    void _c;
    report(outcome, decisionId);
    return {
      ref: { kind: "meeting-motion", id: motionId }, creates: false,
      changes: [{ type: "update", ref: { kind: "meeting-motion", id: motionId }, expectedRevision: found.revision, body: json(closed) } as Change, { type: "create", ref: { kind: "meeting-decision", id: decisionId }, body: json(decision) } as Change, ...done.changes],
      detail: { projectId: motion.projectId, outcome },
    };
  }

  /** Decides what an adopted motion is: a decision the team may carry out, or a recommendation. */
  async #scope(motion: MotionBody, rec: RecordBody): Promise<{ scope: "in-scope" | "recommendation"; reason?: string }> {
    if (motion.agendaItemId !== undefined) {
      const item = known<AgendaBody>(await this.#runner.get("agenda-item", motion.agendaItemId));
      if (item === undefined || !authorityOf(item.intent).executes) return { scope: "recommendation", reason: "the agenda topic asked for discussion or a recommendation; nothing is done because of it" };
    }
    // The topics an owner decision could stand on: the one the motion names and the agenda item's own topic, so a motion cannot dodge the check by leaving its topic out.
    const topics = new Set<string>();
    if (motion.topic !== undefined) topics.add(motion.topic);
    if (motion.agendaItemId !== undefined) {
      const item = known<AgendaBody>(await this.#runner.get("agenda-item", motion.agendaItemId));
      const t = item === undefined ? undefined : normalTopic(item.topic);
      if (t !== undefined && TOPIC.test(t)) topics.add(t);
    }
    for (const topic of topics) {
      const decisions = this.#deps.decisions;
      const owner = decisions === undefined ? undefined : await this.#ownerDecisionOn(rec.projectId, topic);
      if (decisions === undefined || owner !== "none") return { scope: "recommendation", reason: decisions === undefined ? `topic "${topic}" cannot be checked against the owner's decisions, so it stays a recommendation` : `the owner has ${owner === "decided" ? "decided" : "an unresolved conflict on"} "${topic}"; a vote does not override it` };
    }
    if (motion.changes.length > 0) {
      let any = false;
      for (const c of motion.changes) if ((await this.#mayCarry(c, rec.projectId)) === undefined) any = true;
      if (!any) return { scope: "recommendation", reason: "no carrying agent holds the authority these changes need, and a vote grants none" };
    }
    return { scope: "in-scope" };
  }

  async #ownerDecisionOn(projectId: string, topic: string): Promise<"none" | "decided" | "disputed"> {
    const decisions = this.#deps.decisions;
    if (decisions === undefined) return "decided";
    const ownerLike = { id: "owner:meeting-record", kind: "owner", name: "meeting-record", grants: [], asOf: this.#runner.now() } as Principal;
    const found = await decisions.authoritative(ownerLike, { projectId, topic });
    return found === undefined ? "decided" : found.status === "none" ? "none" : found.status;
  }

  /** `undefined` when the agent may carry the change out now; otherwise the reason it may not. */
  async #mayCarry(c: ProposedChange, projectId: string): Promise<string | undefined> {
    const applier = this.#options.appliers?.[c.kind];
    if (applier === undefined) return `no applier is registered for ${c.kind}`;
    if (applier.widens === undefined && NEVER.test(applier.action)) return `${applier.action} is never decided by a vote`;
    const who = await this.#options.authority?.(c.agent).catch(() => undefined);
    if (who === undefined) return `${c.agent} holds no authority that can be checked`;
    return allows(who, applier.action, projectId, { resource: c.target, now: this.#runner.now() }) ? undefined : `${c.agent} does not hold ${applier.action} on ${c.target.kind} ${c.target.id} now`;
  }

  // ---- applying -------------------------------------------------------------------------------------------------------------------------------

  /**
   * Carries out an adopted, in-scope decision (owner, host or service), change by change. Each change is checked just before it is applied: the owner's response (a decision waits for an owner who is present), an implementation hold on
   * the task, the carrying agent's authority *now* (a grant revoked since the meeting is not honoured, and nothing here reopens one), and the revision of the target (a target that moved is "not applied", with the reason). Progress
   * is saved around each change, and the change's command ID is stable, so a crash and a repeat apply it once.
   */
  async apply(by: Principal, command: { decisionId: string }): Promise<{ applied: number; notApplied: number; pending: number; waitingFor?: "owner" }> {
    onlyKnown(command, ["decisionId"]);
    if (!isService(by)) throw forbidden(by, "apply a meeting decision");
    const decisionId = this.#decisionId(command.decisionId);
    return this.#applyDecision(by, decisionId);
  }

  async #applyDecision(by: Principal, decisionId: string): Promise<{ applied: number; notApplied: number; pending: number; waitingFor?: "owner" }> {
    for (let index = 0; index < RECORD_LIMITS.changes; index++) {
      const found = await this.#runner.get("meeting-decision", decisionId);
      const d = known<DecisionRecordBody>(found);
      if (found === undefined || d === undefined) throw new DomainError("not_found", "that decision does not exist");
      const tally = (): { applied: number; notApplied: number; pending: number; waitingFor?: "owner" } => ({
        applied: d.changes.filter((c) => c.state === "applied").length, notApplied: d.changes.filter((c) => c.state === "not-applied").length, pending: d.changes.filter((c) => c.state === "adopted" || c.state === "applying").length,
        ...(d.ownerResponse === "pending" ? { waitingFor: "owner" as const } : {}),
      });
      if (d.outcome !== "adopted" || d.scope !== "in-scope" || d.ownerResponse === "pending") return tally();
      const change = d.changes.find((c) => c.state === "adopted" || c.state === "applying");
      if (change === undefined) { await this.#announceChanges(decisionId); return tally(); }
      // `agreement` is set for the save that starts a change: it holds only while the change is still adopted and the owner's response is still the one the agreement was worked out from.
      const save = async (next: ChangeRecord, agreement?: string): Promise<boolean> => {
        let lost = false;
        try { await this.#retrying(() => this.#runner.command("meeting.decision.change", { commandId: `${decisionId}:${change.id}:${next.state}`.slice(0, 120), actor: by.id }, async () => ({
          payload: { decisionId, changeId: change.id, to: next.state },
          build: async () => {
            const cur = await this.#runner.get("meeting-decision", decisionId);
            const body = known<DecisionRecordBody>(cur)!;
            const now = this.#runner.now();
            if (agreement !== undefined) {
              const here = body.changes.find((c) => c.id === change.id);
              if (here?.state !== "adopted" || body.ownerResponse !== d.ownerResponse) { lost = true; throw new DomainError("invalid_command", "the owner answered before this change started"); }
            }
            const changes = body.changes.map((c) => (c.id === change.id && (c.state === "adopted" || c.state === "applying") ? { ...next, at: now } : c));
            return { ref: { kind: "meeting-decision", id: decisionId }, creates: false, changes: [{ type: "update", ref: { kind: "meeting-decision", id: decisionId }, expectedRevision: cur!.revision, body: json({ ...body, changes }) }], detail: { projectId: body.projectId, change: change.id, to: next.state } };
          },
        }))); } catch (error) { if (lost) return false; throw error; }
        return true;
      };
      const refuse = async (code: ChangeRecord["code"], reason: string): Promise<void> => { await save({ ...change, state: "not-applied", ...(code === undefined ? {} : { code }), reason }); };
      if (change.state === "adopted") {
        const applier = this.#options.appliers?.[change.kind];
        if (applier === undefined) { await refuse("failed", `no applier is registered for ${change.kind}`); continue; }
        // The policy may have tightened since the vote: a widening change goes ahead without the owner's agreement only while the policy still lets its class through.
        if (applier.widens !== undefined && d.ownerResponse !== "agreed" && (this.#options.widening === undefined || (await this.#options.widening(applier.widens, d.projectId).catch(() => "ask" as const)) !== "allow")) { await refuse("unauthorized", `the approval policy asks the owner before ${applier.widens} changes are carried out, and the owner has not agreed`); continue; }
        if (change.target.kind === "task" && this.#deps.decisions !== undefined) {
          const blocked = (await this.#deps.decisions.guard(change.target.id, "start")).blockedBy;
          if (blocked.length > 0) { await refuse("gate", `an owner gate or a superseded decision blocks work on the task (${blocked.join(", ")})`); continue; }
        }
        const why = await this.#mayCarry(change, d.projectId);
        if (why !== undefined) { await refuse("unauthorized", why); continue; }
        const target = await this.#runner.get(change.target.kind, change.target.id);
        if (target === undefined) { await refuse("missing", `${change.target.kind} ${change.target.id} no longer exists`); continue; }
        if (target.revision !== change.expectedRevision) { await refuse("conflict", `${change.target.kind} ${change.target.id} is at revision ${target.revision}, not ${change.expectedRevision} as proposed`); continue; }
        // Who allowed it is fixed now and kept: a replay after a crash uses it (the grant basis is part of the command digest), and a later owner decline does not cancel a change already started.
        const agreedBy = d.ownerResponse === "agreed" ? "owner:agreed" : `policy:${applier.widens ?? "none"}`;
        // The owner may have declined since this was read: then the change is not started, and the decline's own record stands.
        if (!(await save({ ...change, state: "applying", agreedBy }, agreedBy))) continue;
      }
      const applier = this.#options.appliers?.[change.kind];
      if (applier === undefined) { await refuse("failed", `no applier is registered for ${change.kind}`); continue; }
      try {
        const done = await applier.apply({ commandId: `mtg:${decisionId}:${change.id}`, actor: by.id, target: change.target, expectedRevision: change.expectedRevision, patch: change.patch, agreedBy: change.agreedBy ?? (d.ownerResponse === "agreed" ? "owner:agreed" : `policy:${applier.widens ?? "none"}`) });
        await save({ ...change, state: "applied", ...(done.revision === undefined ? {} : { appliedRevision: done.revision }) });
      } catch (error) {
        if (error instanceof DomainError && error.code === "stale_revision") await refuse("conflict", `${change.target.kind} ${change.target.id} changed meanwhile: ${error.message}`);
        else if (error instanceof DomainError && ["invalid_command", "forbidden", "not_found", "invalid_transition"].includes(error.code)) await refuse("failed", error.message);
        else throw error;
      }
    }
    await this.#announceChanges(decisionId);
    return this.#applyDecisionTally(decisionId);
  }

  /** Tells the observer of every change that has reached a final state; each is told again on a repeat of the apply, which the observer's stable command IDs make harmless. */
  async #announceChanges(decisionId: string): Promise<void> {
    if (this.#options.onChange === undefined) return;
    const d = known<DecisionRecordBody>(await this.#runner.get("meeting-decision", decisionId));
    if (d === undefined) return;
    for (const [index, c] of d.changes.entries()) {
      if (c.state !== "applied" && c.state !== "not-applied") continue;
      try { await this.#options.onChange({ decisionId, index, projectId: d.projectId, target: { kind: c.target.kind, id: c.target.id }, state: c.state, summary: c.summary, ...(c.reason === undefined ? {} : { reason: c.reason }) }); } catch { /* an observer never changes the decision */ }
    }
  }

  async #applyDecisionTally(decisionId: string): Promise<{ applied: number; notApplied: number; pending: number }> {
    const d = known<DecisionRecordBody>(await this.#runner.get("meeting-decision", decisionId))!;
    return { applied: d.changes.filter((c) => c.state === "applied").length, notApplied: d.changes.filter((c) => c.state === "not-applied").length, pending: d.changes.filter((c) => c.state === "adopted" || c.state === "applying").length };
  }

  /**
   * The owner answers an adopted decision (only the authenticated owner). `agree` lets it be applied (and applies it). `decline` refuses the changes not yet applied: what was already applied stays reported as applied. `alternative`
   * records the owner's own wording as a separate owner decision (C08) and refuses the changes not yet applied; no re-vote is needed. The vote and the owner's decision stay separate records.
   */
  async ownerRespond(by: Principal, command: NoActor & { decisionId: string; response: "agree" | "decline" | "alternative"; alternative?: Omit<RecordDecision, "commandId"> & { commandId: string } }): Promise<{ ownerDecisionId?: string; applied?: number }> {
    onlyKnown(command, ["commandId", "decisionId", "response", "alternative"]);
    if (by.kind !== "owner") throw forbidden(by, "answer for the owner");
    const decisionId = this.#decisionId(command.decisionId);
    if (!["agree", "decline", "alternative"].includes(command.response as string)) invalid("response", "must be agree, decline or alternative");
    if ((command.response === "alternative") !== (command.alternative !== undefined)) invalid("alternative", "is needed for an alternative, and only for one");
    let ownerDecisionId: string | undefined;
    if (command.alternative !== undefined) {
      if (this.#deps.decisions === undefined) throw new DomainError("unavailable", "owner decisions are not available here");
      const found = known<DecisionRecordBody>(await this.#runner.get("meeting-decision", decisionId));
      if (found === undefined) throw new DomainError("not_found", "that decision does not exist");
      if (command.alternative.projectId !== found.projectId) invalid("alternative", "must be in the meeting's project");
      if (found.outcome !== "adopted" || found.scope !== "in-scope" || (found.ownerResponse !== "pending" && found.ownerResponse !== "not-asked")) throw new DomainError("invalid_command", "that decision does not wait for the owner", { field: "decisionId" });
      const recorded = await this.#deps.decisions.record(by, command.alternative);
      if (!recorded.recorded) invalid("alternative", recorded.reason);
      else ownerDecisionId = recorded.id;
    }
    await this.#cmd("meeting.decision.owner", by, command.commandId, async () => ({
      payload: clean({ decisionId, response: command.response, ownerDecisionId }),
      build: async () => {
        const found = await this.#runner.get("meeting-decision", decisionId);
        const d = known<DecisionRecordBody>(found);
        if (found === undefined || d === undefined) throw new DomainError("not_found", "that decision does not exist");
        if (d.outcome !== "adopted" || d.scope !== "in-scope") throw new DomainError("invalid_command", "only an adopted decision the team may carry out waits for the owner", { field: "decisionId" });
        if (d.ownerResponse !== "pending" && d.ownerResponse !== "not-asked") throw new DomainError("invalid_command", `the owner already answered (${d.ownerResponse})`, { field: "decisionId" });
        const now = this.#runner.now();
        const response: OwnerResponse = command.response === "agree" ? "agreed" : command.response === "decline" ? "declined" : "alternative";
        const reason = command.response === "decline" ? "the owner declined it" : `the owner chose an alternative (${ownerDecisionId ?? ""})`;
        const changes = command.response === "agree" ? d.changes : d.changes.map((c) => (c.state === "adopted" ? { ...c, state: "not-applied" as const, code: "owner" as const, reason, at: now } : c));
        const next: DecisionRecordBody = { ...d, changes, ownerResponse: response, ownerRespondedAt: now, ...(ownerDecisionId === undefined ? {} : { ownerDecisionId }) };
        return { ref: { kind: "meeting-decision", id: decisionId }, creates: false, changes: [{ type: "update", ref: { kind: "meeting-decision", id: decisionId }, expectedRevision: found.revision, body: json(next) }], detail: { projectId: d.projectId, response } };
      },
    }));
    if (command.response === "agree") return { applied: (await this.#applyDecision(by, decisionId)).applied };
    return { ...(ownerDecisionId === undefined ? {} : { ownerDecisionId }) };
  }

  // ---- ending ----------------------------------------------------------------------------------------------------------------------------------

  /**
   * Ends the record (owner, host or service): `ended` normally, `interrupted` when the meeting was cut short. Motions that were not concluded are void ("not concluded"), an open vote included. The transcript stays complete and readable;
   * the summary is built from it by `summarize`, which this does not depend on. It does not settle the M01 occurrence: the procedure calls `MeetingService.settle` as well.
   */
  async finish(by: Principal, command: NoActor & { recordId: string; interrupted?: boolean; reason?: string }): Promise<{ voided: string[] }> {
    onlyKnown(command, ["commandId", "recordId", "interrupted", "reason"]);
    const recordId = this.#recordId(command.recordId);
    const reason = optionalPlain(command.reason, "reason", RECORD_LIMITS.reason);
    return this.#finish(by, recordId, command.interrupted === true, reason, scopedCommandId(by.id, command.commandId));
  }

  async #finish(by: Principal, recordId: string, interrupted: boolean, reason: string | undefined, commandId: string): Promise<{ voided: string[] }> {
    let voided: string[] = [];
    await this.#retrying(() => this.#runner.command("meeting.record.finish", { commandId, actor: by.id }, async () => ({
      payload: clean({ recordId, interrupted, reason }),
      build: async () => {
        const head = await this.#open(recordId);
        if (!isService(by)) throw forbidden(by, "end that meeting");
        const rec = head.body;
        const now = this.#runner.now();
        const changes: Change[] = [];
        voided = [];
        let entries = 0;
        for (const id of rec.motions) {
          const found = await this.#runner.get("meeting-motion", id);
          const m = known<MotionBody>(found);
          if (found === undefined || m === undefined || FINAL_MOTION_STATES.includes(m.state)) continue;
          const why = m.state === "voting" || m.state === "tie-pending" ? "the meeting ended during an open vote; the vote is void and not concluded" : "the meeting ended before it was put to a vote";
          voided.push(id);
          entries++;
          changes.push({ type: "update", ref: { kind: "meeting-motion", id }, expectedRevision: found.revision, body: json({ ...m, state: "void", closedAt: now, voidReason: why }) });
        }
        const text = `The meeting ${interrupted ? "was interrupted" : "ended"}${reason === undefined ? "" : `: ${reason}`}.${voided.length === 0 ? "" : ` ${voided.length} motion(s) were not concluded.`}`;
        const next: RecordBody = { ...rec, state: interrupted ? "interrupted" : "ended", endedAt: now, endedBy: by.id, ...(reason === undefined ? {} : { endReason: reason }), ownerPresent: false };
        const done = this.#append(head, next, [{ kind: "presence", by: by.id, speaker: by.id, text, data: { ended: true, interrupted } }], true);
        const index = await this.#runner.get(OPEN_KIND, rec.projectId);
        const ids = known<OpenIndexBody>(index)?.ids ?? [];
        if (index !== undefined) changes.push({ type: "update", ref: { kind: OPEN_KIND, id: rec.projectId }, expectedRevision: index.revision, body: json({ projectId: rec.projectId, ids: ids.filter((x) => x !== recordId) }) });
        void entries;
        return { ref: done.ref, creates: false, changes: [...done.changes, ...changes], detail: { projectId: rec.projectId, interrupted } };
      },
    })));
    return { voided };
  }

  /**
   * The lease: closes votes whose time is up (`tied` lists those that came to a tie and now wait for the chair's casting vote), fails ties whose casting window is over, and ends records nobody finished (two hours past the meeting's end), so nothing stays open for ever. Owner, host or service. Each step has a
   * command ID derived from the record, so repeating the sweep, or running it on several processes, does each step once.
   */
  async sweep(by: Principal, command: { projectId: string }): Promise<{ closed: string[]; tied: string[]; failedTies: string[]; interrupted: string[] }> {
    onlyKnown(command, ["projectId"]);
    if (!isService(by)) throw forbidden(by, "sweep meeting records");
    const projectId = typeof command.projectId === "string" ? command.projectId : invalid("projectId", "is not a project ID");
    const closed: string[] = [];
    const tied: string[] = [];
    const failedTies: string[] = [];
    const interrupted: string[] = [];
    const ids = known<OpenIndexBody>(await this.#runner.get(OPEN_KIND, projectId))?.ids ?? [];
    for (const recordId of ids) {
      const rec = known<RecordBody>(await this.#runner.get("meeting-record", recordId));
      if (rec === undefined || rec.state !== "open") continue;
      const now = this.#runner.now();
      for (const motionId of rec.motions) {
        const found = await this.#runner.get("meeting-motion", motionId);
        const m = known<MotionBody>(found);
        if (found === undefined || m === undefined) continue;
        const key = `sweep:${motionId}:${m.state}:${found.revision}`;
        if (m.state === "voting" && m.heldAt === undefined && m.closesAt !== undefined && ms(now) >= ms(m.closesAt)) {
          const r = await this.#close(by, undefined, motionId, undefined, scopedCommandId(by.id, key));
          (r.state === "tie-pending" ? tied : closed).push(motionId);
        } else if (m.state === "tie-pending" && m.castingDeadline !== undefined && ms(now) > ms(m.castingDeadline)) {
          await this.#close(by, undefined, motionId, undefined, scopedCommandId(by.id, key));
          failedTies.push(motionId);
        }
      }
      if (ms(this.#runner.now()) > ms(rec.endsAt) + RECORD_LIMITS.abandonMinutes * 60_000) {
        await this.#finish(by, recordId, true, "nobody finished this meeting record; it was closed by the lease", scopedCommandId(by.id, `sweep:${recordId}:finish`));
        interrupted.push(recordId);
      }
    }
    return { closed, tied, failedTies, interrupted };
  }

  // ---- summary ---------------------------------------------------------------------------------------------------------------------------------

  /**
   * Writes (or refreshes) the stored summary snapshot and the project's latest stand-up plan (owner, host or service). The summary is built from the records alone; the optional narrative overview comes from the configured summarizer,
   * and if that throws the snapshot is still written, marked `overviewFailed`. Safe to call again after more has happened (a decision applied, the owner's answer).
   */
  async summarize(by: Principal, command: NoActor & { recordId: string }): Promise<{ builds: number; overviewFailed?: string }> {
    onlyKnown(command, ["commandId", "recordId"]);
    const recordId = this.#recordId(command.recordId);
    if (!isService(by)) throw forbidden(by, "summarize a meeting");
    let out: { builds: number; overviewFailed?: string } = { builds: 0 };
    await this.#cmd("meeting.summary.write", by, command.commandId, async () => ({
      payload: { recordId },
      build: async () => {
        const rec = known<RecordBody>(await this.#runner.get("meeting-record", recordId));
        if (rec === undefined) throw new DomainError("not_found", "that meeting record does not exist");
        const content = await this.#summaryOf(recordId, rec);
        let overview: string | undefined;
        let overviewFailed: string | undefined;
        if (this.#options.narrate !== undefined) {
          try {
            const raw = await this.#options.narrate({ summary: content });
            const cleaned = typeof raw === "string" ? raw.trim() : "";
            if (cleaned === "" || redactText(cleaned) !== cleaned || [...cleaned].length > RECORD_LIMITS.text) overviewFailed = "the summarizer returned nothing usable";
            else overview = cleaned;
          } catch (error) { overviewFailed = redactText(`the summarizer failed: ${error instanceof Error ? error.message : String(error)}`).slice(0, 300); }
        }
        const id = derivedId("msu", recordId);
        const prior = await this.#runner.get("meeting-summary", id);
        const builds = (known<MeetingSummaryBody>(prior)?.builds ?? 0) + 1;
        const now = this.#runner.now();
        const body: MeetingSummaryBody = { occurrenceId: rec.occurrenceId, recordId, projectId: rec.projectId, builds, builtAt: now, content, ...(overview === undefined ? {} : { overview }), ...(overviewFailed === undefined ? {} : { overviewFailed }) };
        out = { builds, ...(overviewFailed === undefined ? {} : { overviewFailed }) };
        const ref: AggregateRef = { kind: "meeting-summary", id };
        const changes: Change[] = [prior === undefined ? { type: "create", ref, body: json(body) } : { type: "update", ref, expectedRevision: prior.revision, body: json(body) }];
        const plan = await this.#runner.get("meeting-plan", rec.projectId);
        const latest = known<PlanBody>(plan);
        if (content.plan.length > 0 && (latest === undefined || latest.recordId === recordId || ms(latest.at) <= ms(rec.openedAt))) {
          const pb: PlanBody = { projectId: rec.projectId, occurrenceId: rec.occurrenceId, recordId, at: rec.openedAt, items: content.plan };
          changes.push(plan === undefined ? { type: "create", ref: { kind: "meeting-plan", id: rec.projectId }, body: json(pb) } : { type: "update", ref: { kind: "meeting-plan", id: rec.projectId }, expectedRevision: plan.revision, body: json(pb) });
        }
        return { ref, creates: prior === undefined, changes, detail: { projectId: rec.projectId, builds } };
      },
    }));
    // A repeat of a command that already applied is answered with the snapshot as it stands.
    if (out.builds === 0) out = { builds: known<MeetingSummaryBody>(await this.#runner.get("meeting-summary", derivedId("msu", recordId)))?.builds ?? 0 };
    return out;
  }

  /** Hands each concluded motion's outcome back to the agenda item it answered (and so to the conversation that item came from), through M03's path. The caller is the owner or a manager (M01's rule for changing an item). Safe to repeat. */
  async returnOutcomes(by: Principal, command: { recordId: string }): Promise<{ returned: string[]; pending: string[] }> {
    onlyKnown(command, ["recordId"]);
    const recordId = this.#recordId(command.recordId);
    const meetings = this.#deps.meetings;
    if (meetings === undefined) throw new DomainError("unavailable", "the meeting service is not available here");
    const rec = known<RecordBody>(await this.#runner.get("meeting-record", recordId));
    if (rec === undefined || !(isService(by) || allows(by, "meeting.manage", rec.projectId))) throw forbidden(by, "return that meeting's outcomes");
    const returned: string[] = [];
    const pending: string[] = [];
    for (const motionId of rec.motions) {
      const found = await this.#runner.get("meeting-motion", motionId);
      const m = known<MotionBody>(found);
      if (found === undefined || m === undefined || m.agendaItemId === undefined || m.outcomeReturned === true || !FINAL_MOTION_STATES.includes(m.state)) continue;
      const item = await this.#runner.get("agenda-item", m.agendaItemId);
      const ib = known<AgendaBody>(item);
      if (item === undefined || ib === undefined) continue;
      const d = m.decisionId === undefined ? undefined : known<DecisionRecordBody>(await this.#runner.get("meeting-decision", m.decisionId));
      const decided = m.state === "adopted" || m.state === "rejected";
      const note = d === undefined ? `Motion ${m.number}: ${m.state}. ${m.voidReason ?? "Nothing was decided."}` : `Motion ${m.number} was ${d.outcome} (yes ${d.tally?.yes ?? 0}, no ${d.tally?.no ?? 0}). ${d.scope === "recommendation" && d.outcome === "adopted" ? "It is a recommendation: nothing was done because of it." : ""}`.trim();
      try {
        if (ib.state === "scheduled" || ib.state === "discussed" || ib.state === "deferred") {
          await meetings.setAgendaState(by, decided
            ? { commandId: `ret-${motionId}`, itemId: m.agendaItemId, expectedRevision: item.revision, to: "resolved", outcomeRef: m.decisionId ?? motionId, outcomeNote: note.slice(0, 1000) }
            : { commandId: `ret-${motionId}`, itemId: m.agendaItemId, expectedRevision: item.revision, to: "deferred", reason: (m.voidReason ?? `the motion ended ${m.state}`).slice(0, 500), nextStep: "it is on the next meeting's agenda", ...{} });
        }
        await this.#retrying(() => this.#runner.command("meeting.motion.returned", { commandId: `mtg-returned:${motionId}`, actor: by.id }, async () => ({
          payload: { motionId },
          build: async () => {
            const cur = await this.#runner.get("meeting-motion", motionId);
            return { ref: { kind: "meeting-motion", id: motionId }, creates: false, changes: [{ type: "update", ref: { kind: "meeting-motion", id: motionId }, expectedRevision: cur!.revision, body: json({ ...known<MotionBody>(cur)!, outcomeReturned: true }) }], detail: { projectId: m.projectId } };
          },
        })));
        returned.push(motionId);
      } catch (error) {
        if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "unavailable")) pending.push(motionId);
        else throw error;
      }
    }
    return { returned, pending };
  }

  /**
   * The decisions of a meeting in the form M04's `endMeeting` takes (owner, host or service): each adopted decision the team may carry out that changes tasks names those tasks, so their agents revalidate their next actions
   * before continuing (an attendee's own paused task stays paused until it acknowledges; an absent agent is sent a notice). Changes that were refused are left out. `more` counts decisions beyond what `endMeeting` accepts.
   */
  async attendanceDecisions(by: Principal, command: { recordId: string }): Promise<{ decisions: MeetingDecision[]; more: number }> {
    onlyKnown(command, ["recordId"]);
    const recordId = this.#recordId(command.recordId);
    if (!isService(by)) throw forbidden(by, "list a meeting's decisions for attendance");
    const rec = known<RecordBody>(await this.#runner.get("meeting-record", recordId));
    if (rec === undefined) throw new DomainError("not_found", "that meeting record does not exist");
    const out: MeetingDecision[] = [];
    let more = 0;
    for (const id of rec.motions) {
      const m = known<MotionBody>(await this.#runner.get("meeting-motion", id));
      const d = m?.decisionId === undefined ? undefined : known<DecisionRecordBody>(await this.#runner.get("meeting-decision", m.decisionId));
      if (m?.decisionId === undefined || d === undefined || d.outcome !== "adopted" || d.scope !== "in-scope") continue;
      const tasks = [...new Set(d.changes.filter((c) => c.target.kind === "task" && c.state !== "not-applied").map((c) => c.target.id))].slice(0, ATTENDANCE_LIMITS.decisionTasks);
      if (tasks.length === 0) continue;
      if (out.length >= ATTENDANCE_LIMITS.decisions) { more++; continue; }
      out.push({ ref: m.decisionId, summary: redactText(d.text).slice(0, 300), supersedes: tasks });
    }
    return { decisions: out, more };
  }

  // ---- reads ------------------------------------------------------------------------------------------------------------------------------------

  /** The meeting record, for the owner, a manager or reader of the project's meetings, or a roster member or the chair. Anyone else gets `undefined`, as for a record that does not exist. */
  async record(viewer: Principal, recordId: string): Promise<View<RecordBody> | undefined> {
    const raw = await this.#readable(viewer, recordId);
    return raw === undefined ? undefined : this.#strip(viewer, raw);
  }

  /** The record as stored, if the viewer may read it (the citations are still on it: only the code in here sees it this way). */
  async #readable(viewer: Principal, recordId: string): Promise<View<RecordBody> | undefined> {
    const found = typeof recordId === "string" && RECORD_ID.test(recordId) ? await this.#runner.get("meeting-record", recordId) : undefined;
    const body = known<RecordBody>(found);
    return found === undefined || body === undefined || !this.#canRead(viewer, body) ? undefined : view<RecordBody>(found);
  }

  /** The record of one occurrence. */
  async recordFor(viewer: Principal, occurrenceId: string): Promise<View<RecordBody> | undefined> {
    return typeof occurrenceId === "string" && OCCURRENCE_ID.test(occurrenceId) ? this.record(viewer, derivedId("mrc", occurrenceId)) : undefined;
  }

  /**
   * The full discussion, in order and paged: every entry with the corrections made to it linked (`correctedBy`, and `currentText`, the text now in force beside the original). Entries that rest on a record the reader cannot be shown
   * come back with `verifiable: false` and no citation. A ballot is not here while a vote is open: it is revealed with the vote entry when the vote concludes.
   */
  async discussion(viewer: Principal, recordId: string, page: { fromSeq?: number; toSeq?: number; limit?: number } = {}): Promise<{ entries: DiscussionEntry[]; next?: number } | undefined> {
    onlyKnown(page, ["fromSeq", "toSeq", "limit"]);
    const head = await this.#readable(viewer, recordId);
    if (head === undefined) return undefined;
    const from = page.fromSeq === undefined ? 1 : whole(page.fromSeq, "fromSeq", 1, 100_000);
    const to = page.toSeq === undefined ? head.nextSeq - 1 : whole(page.toSeq, "toSeq", 1, 100_000);
    const limit = page.limit === undefined ? 50 : whole(page.limit, "limit", 1, RECORD_LIMITS.page);
    const entries: DiscussionEntry[] = [];
    let seq = from;
    for (; seq <= Math.min(to, head.nextSeq - 1) && entries.length < limit; seq++) {
      const found = await this.#runner.get("meeting-entry", entryIdOf(recordId, seq));
      const body = known<MeetingEntryBody>(found);
      if (found === undefined || body === undefined) continue;
      const corrected = head.corrections.find((c) => c.target === found.id);
      const shown = await this.#showSources(viewer, body.sources);
      entries.push({ id: found.id, ...body, sources: shown.cites, verifiable: shown.verifiable, ...(corrected === undefined ? {} : { correctedBy: corrected.entries, currentText: corrected.text }) });
    }
    return { entries, ...(seq <= Math.min(to, head.nextSeq - 1) ? { next: seq } : {}) };
  }

  async motion(viewer: Principal, motionId: string): Promise<View<MotionBody> | undefined> {
    const found = typeof motionId === "string" && MOTION_ID.test(motionId) ? await this.#runner.get("meeting-motion", motionId) : undefined;
    const body = known<MotionBody>(found);
    if (found === undefined || body === undefined || (await this.#readable(viewer, body.recordId)) === undefined) return undefined;
    return this.#strip(viewer, view<MotionBody>(found));
  }

  /**
   * The ballots of a motion. While the vote is open only the owner sees them all (and a voter its own); everyone else is told only whether they are hidden. After it concludes every reader of the meeting sees every ballot with its
   * history (the original ballots and revisions, each with what triggered it).
   */
  async ballots(viewer: Principal, motionId: string): Promise<{ hidden: true; cast?: number } | { hidden: false; ballots: View<BallotBody>[] } | undefined> {
    const motion = await this.motion(viewer, motionId);
    if (motion === undefined) return undefined;
    const head = known<RecordBody>(await this.#runner.get("meeting-record", motion.recordId))!;
    const rows: View<BallotBody>[] = [];
    for (const voter of head.roster) {
      const b = await this.#runner.get("meeting-ballot", derivedId("mbl", `${motionId}:${voter}`));
      if (b !== undefined) rows.push(await this.#strip(viewer, view<BallotBody>(b)));
    }
    // Individual ballots are shown only once a tally was concluded; until then (or when the vote was voided or the motion tabled) a voter sees only its own, the owner included.
    if (motion.decisionId !== undefined) return { hidden: false, ballots: rows };
    const own = rows.filter((r) => r.voter === viewer.id);
    return own.length > 0 ? { hidden: false, ballots: own } : { hidden: true };
  }

  async decision(viewer: Principal, decisionId: string): Promise<View<DecisionRecordBody> | undefined> {
    const found = typeof decisionId === "string" && DECISION_ID.test(decisionId) ? await this.#runner.get("meeting-decision", decisionId) : undefined;
    const body = known<DecisionRecordBody>(found);
    if (found === undefined || body === undefined || (await this.#readable(viewer, body.recordId)) === undefined) return undefined;
    return this.#strip(viewer, view<DecisionRecordBody>(found));
  }

  /**
   * Why a decision was taken, from the record: who moved it, how it was amended and ruled on, what each member voted and why, how the tie (if any) was broken, why it is a decision or only a recommendation, what the owner said, and
   * what happened to each change. Every line points at its entry. Asking grants nothing: a line that rests on a record the reader cannot see says so and shows no citation.
   */
  async why(viewer: Principal, decisionId: string): Promise<{ decision: View<DecisionRecordBody>; lines: { text: string; entryId?: string; seq?: number; verifiable: boolean }[] } | undefined> {
    const d = await this.decision(viewer, decisionId);
    if (d === undefined) return undefined;
    const motion = known<MotionBody>(await this.#runner.get("meeting-motion", d.motionId))!;
    const lines: { text: string; entryId?: string; seq?: number; verifiable: boolean }[] = [];
    for (const t of motion.trail) {
      const e = known<MeetingEntryBody>(await this.#runner.get("meeting-entry", t.entryId));
      if (e === undefined) continue;
      const shown = await this.#showSources(viewer, e.sources);
      lines.push({ text: `${e.kind} by ${e.speaker}: ${e.text}`, entryId: t.entryId, seq: t.seq, verifiable: shown.verifiable });
    }
    const raw = known<DecisionRecordBody>(await this.#runner.get("meeting-decision", decisionId))!;
    for (const r of raw.table) {
      const shown = await this.#showSources(viewer, r.sources);
      lines.push({ text: `${r.voter} voted ${r.value}${r.revisions > 1 ? ` (revised ${r.revisions - 1} time(s))` : ""}: ${r.reason}`, verifiable: shown.verifiable });
    }
    if (d.tally !== undefined) lines.push({ text: `Result: ${d.outcome}. Yes ${d.tally.yes}, no ${d.tally.no}, abstain ${d.tally.abstain}; ${d.tally.cast} of ${d.tally.roster} cast ballots, quorum ${d.tally.quorum}.`, verifiable: true });
    if (d.tie !== undefined) lines.push({ text: `Tie: ${d.tie.reason}`, verifiable: true });
    if (d.outcome === "adopted") lines.push({ text: d.scope === "in-scope" ? "The team may carry this out within authority it already holds." : `It is a recommendation: ${d.scopeReason ?? "advisory only"}.`, verifiable: true });
    if (d.ownerResponse !== "not-asked") lines.push({ text: `The owner: ${d.ownerResponse}${d.ownerDecisionId === undefined ? "" : ` (owner decision ${d.ownerDecisionId})`}.`, verifiable: true });
    for (const c of d.changes) lines.push({ text: `Change ${c.id} (${c.summary}): ${c.state}${c.reason === undefined ? "" : `, ${c.reason}`}.`, verifiable: true });
    return { decision: d, lines };
  }

  /**
   * The meeting summary as it stands now, built from the records (so it always matches what was applied), with the stored snapshot's overview if there is one. Conclusions that rest on a private record are marked unverifiable; the owner
   * additionally sees which records.
   */
  async summary(viewer: Principal, recordId: string): Promise<{ content: SummaryContent; overview?: string; overviewFailed?: string; snapshot?: { builds: number; builtAt: string; current: boolean }; privateSources?: { ref: string; cites: readonly SourceCite[] }[] } | undefined> {
    const head = await this.#readable(viewer, recordId);
    if (head === undefined) return undefined;
    const content = await this.#summaryOf(recordId, head);
    const stored = known<MeetingSummaryBody>(await this.#runner.get("meeting-summary", derivedId("msu", recordId)));
    const privateSources = viewer.kind === "owner" ? await this.#privateSources(head, recordId) : undefined;
    return {
      content, ...(stored?.overview === undefined ? {} : { overview: stored.overview }), ...(stored?.overviewFailed === undefined ? {} : { overviewFailed: stored.overviewFailed }),
      ...(stored === undefined ? {} : { snapshot: { builds: stored.builds, builtAt: stored.builtAt, current: canonicalJson(stored.content as unknown as JsonObject) === canonicalJson(JSON.parse(JSON.stringify(content)) as JsonObject) } }),
      ...(privateSources === undefined || privateSources.length === 0 ? {} : { privateSources }),
    };
  }

  /** The latest stand-up plan of a project, as the last meeting that had one left it. Needs `meeting.read`. */
  async latestPlan(viewer: Principal, projectId: string): Promise<View<PlanBody> | undefined> {
    const found = typeof projectId === "string" ? await this.#runner.get("meeting-plan", projectId) : undefined;
    const body = known<PlanBody>(found);
    return found === undefined || body === undefined || !(viewer.kind === "owner" || (inTaskScope(viewer, body.projectId) && (allows(viewer, "meeting.read", body.projectId) || allows(viewer, "meeting.manage", body.projectId)))) ? undefined : view<PlanBody>(found);
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------------------------------

  async #cmd(type: string, by: Principal, userCommandId: unknown, prepare: Parameters<CommandRunner["command"]>[2]): Promise<Awaited<ReturnType<CommandRunner["command"]>>> {
    const commandId = scopedCommandId(by.id, userCommandId);
    return this.#retrying(() => this.#runner.command(type, { commandId, actor: by.id }, prepare));
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= RECORD_LIMITS.retries) throw error;
      }
    }
  }

  async #agent(value: unknown, field: string): Promise<string> {
    const id = typeof value === "string" && AGENT.test(value) ? value : invalid(field, "must be an agent principal");
    const found = known<{ kind?: string; state?: string }>(await this.#runner.get("principal", id));
    if (found?.kind !== "agent" || found.state !== "active") invalid(field, `${id} is not an active agent`);
    return id;
  }

  #recordId(value: unknown): string { return typeof value === "string" && RECORD_ID.test(value) ? value : invalid("recordId", "is not a meeting record ID"); }
  #motionId(value: unknown): string { return typeof value === "string" && MOTION_ID.test(value) ? value : invalid("motionId", "is not a motion ID"); }
  #decisionId(value: unknown): string { return typeof value === "string" && DECISION_ID.test(value) ? value : invalid("decisionId", "is not a decision ID"); }
  #entryId(value: unknown, field: string): string { return typeof value === "string" && ENTRY_ID.test(value) ? value : invalid(field, "is not a meeting entry ID"); }

  #sources(value: unknown): SourceCite[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value) || value.length > RECORD_LIMITS.sources) return invalid("sources", `must be a list of at most ${RECORD_LIMITS.sources} records`);
    return value.map((raw: unknown) => {
      const s = raw as { kind?: unknown; id?: unknown; revision?: unknown };
      if (raw === null || typeof raw !== "object" || typeof s.kind !== "string" || !/^[a-z][a-z-]{0,39}$/.test(s.kind) || typeof s.id !== "string" || s.id.length < 1 || s.id.length > 200 || !/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(s.id)) return invalid("sources", "each source is {kind, id}");
      return { kind: s.kind, id: s.id, ...(typeof s.revision === "number" && Number.isSafeInteger(s.revision) && s.revision >= 1 ? { revision: s.revision } : {}) };
    });
  }

  async #changes(value: unknown): Promise<ProposedChange[]> {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > RECORD_LIMITS.changes) return invalid("changes", `must be a list of at most ${RECORD_LIMITS.changes} changes`);
    const out: ProposedChange[] = [];
    for (const [i, raw] of value.entries()) {
      const c = raw as Record<string, unknown>;
      if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return invalid("changes", "each change is an object");
      onlyKnown(c, ["kind", "agent", "target", "expectedRevision", "patch", "summary"]);
      const kind = typeof c["kind"] === "string" ? c["kind"] : invalid("changes", "a change has a kind");
      const applier = this.#options.appliers?.[kind];
      if (applier === undefined) invalid("changes", `${kind} is not a kind of change a meeting may decide`);
      else if (applier.widens === undefined && NEVER.test(applier.action)) invalid("changes", `${applier.action} is never decided by a vote: a motion widens no permission, budget or configuration`);
      const agent = await this.#agent(c["agent"], "changes.agent");
      const target = c["target"] as { kind?: unknown; id?: unknown } | undefined;
      if (target === undefined || target === null || typeof target.kind !== "string" || typeof target.id !== "string" || !/^[a-z][a-z-]{0,39}$/.test(target.kind) || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(target.id)) invalid("changes", "a change names its target as {kind, id}");
      const expectedRevision = checkRevision(c["expectedRevision"]);
      const patch = c["patch"];
      if (patch === null || typeof patch !== "object" || Array.isArray(patch) || JSON.stringify(patch).length > RECORD_LIMITS.patchBytes) invalid("changes", `a change's patch is an object of at most ${RECORD_LIMITS.patchBytes} characters`);
      if (redactText(JSON.stringify(patch)) !== JSON.stringify(patch)) invalid("changes", "a patch looks like it holds a credential or key");
      out.push({ id: `c${i + 1}`, kind, agent, target: { kind: (target as { kind: string }).kind, id: (target as { id: string }).id }, expectedRevision, patch: patch as JsonObject, summary: plain(c["summary"], "changes.summary", 300) });
    }
    return out;
  }

  async #open(recordId: string): Promise<Loaded> {
    const agg = await this.#runner.get("meeting-record", recordId);
    const body = known<RecordBody>(agg);
    if (agg === undefined || body === undefined) throw forbidden({ id: "caller" } as Principal, "use that meeting record");
    if (body.state !== "open") throw new DomainError("invalid_command", `the meeting is ${body.state}`, { field: "recordId" });
    return { agg, body };
  }

  async #entry(recordId: string, entryId: string): Promise<MeetingEntryBody | undefined> {
    const e = known<MeetingEntryBody>(await this.#runner.get("meeting-entry", entryId));
    return e !== undefined && e.recordId === recordId ? e : undefined;
  }

  /** Appends entries to a record: the new head body gets the next sequence numbers and the tagged items; returns the changes (the entries, then the head update). A meeting that is ending may exceed the entry limit by a little. */
  #append(head: Loaded, next: RecordBody, drafts: readonly Draft[], ending = false): { ref: AggregateRef; changes: Change[] } {
    let body = next;
    const changes: Change[] = [];
    const now = this.#runner.now();
    for (const d of drafts) {
      const seq = body.nextSeq;
      const system = d.kind === "presence" || d.kind === "vote";
      if (seq > RECORD_LIMITS.entries + (system || ending ? RECORD_LIMITS.systemEntries : 0)) throw new DomainError("unavailable", `this meeting already has ${RECORD_LIMITS.entries} entries`);
      const entry: MeetingEntryBody = { recordId: head.agg.id, occurrenceId: body.occurrenceId, projectId: body.projectId, seq, at: now, ...d, ...(d.sources === undefined ? {} : { sources: d.sources }) };
      const id = entryIdOf(head.agg.id, seq);
      changes.push({ type: "create", ref: { kind: "meeting-entry", id }, body: jsonClean(entry) });
      let tagged = body.tagged;
      if (d.tag !== undefined) {
        if (tagged.length >= RECORD_LIMITS.tagged) throw new DomainError("unavailable", `${RECORD_LIMITS.tagged} updates, questions, actions and plan items are already recorded in this meeting`);
        tagged = [...tagged, { entryId: id, seq, tag: d.tag, speaker: d.speaker, text: d.text.slice(0, 600), ...(d.assignee === undefined ? {} : { assignee: d.assignee }), ...(d.taskId === undefined ? {} : { taskId: d.taskId }), ...(d.sources === undefined ? {} : { sources: d.sources }) }];
      }
      const attended = d.kind === "statement" && body.roster.includes(d.speaker) && !body.attended.includes(d.speaker) ? [...body.attended, d.speaker] : body.attended;
      body = { ...body, nextSeq: seq + 1, tagged, attended };
    }
    changes.push({ type: "update", ref: { kind: "meeting-record", id: head.agg.id }, expectedRevision: head.agg.revision, body: json(body) });
    return { ref: { kind: "meeting-record", id: head.agg.id }, changes };
  }

  async #ballots(motionId: string, motion: MotionBody, rec: RecordBody): Promise<CountedBallot[]> {
    const out: CountedBallot[] = [];
    for (const voter of rec.roster) {
      if (rec.withheld.includes(voter)) continue;
      const b = known<BallotBody>(await this.#runner.get("meeting-ballot", derivedId("mbl", `${motionId}:${voter}`)));
      if (b !== undefined && b.version === motion.version) out.push({ voter, value: b.value, reason: b.reason, revisions: b.history.filter((h) => h.version === motion.version).length });
    }
    return out;
  }

  #member(by: Principal, rec: RecordBody): boolean {
    return by.kind === "agent" && by.asOf !== undefined && inTaskScope(by, rec.projectId) && rec.roster.includes(by.id) && !rec.withheld.includes(by.id);
  }

  /** Whether the principal may speak in the meeting as itself: a roster member who can be asked, or the chair. */
  #speaks(by: Principal, rec: RecordBody): boolean {
    return this.#member(by, rec) || (by.kind === "agent" && by.asOf !== undefined && rec.chair !== undefined && by.id === rec.chair && inTaskScope(by, rec.projectId));
  }

  #speaksId(id: string, rec: RecordBody): boolean { return (rec.roster.includes(id) && !rec.withheld.includes(id)) || id === rec.chair; }

  #chairOrOwner(by: Principal, rec: RecordBody): boolean {
    return isService(by) || (by.kind === "agent" && by.asOf !== undefined && rec.chair !== undefined && by.id === rec.chair && inTaskScope(by, rec.projectId));
  }

  #controls(by: Principal, rec: RecordBody): boolean { return isService(by) || (by.taskScope === undefined && allows(by, "meeting.manage", rec.projectId)); }

  #canRead(viewer: Principal, rec: RecordBody): boolean {
    if (viewer.kind === "owner") return true;
    if (!inTaskScope(viewer, rec.projectId)) return false;
    if (allows(viewer, "meeting.read", rec.projectId) || allows(viewer, "meeting.manage", rec.projectId)) return true;
    return viewer.kind === "agent" && viewer.asOf !== undefined && (rec.roster.includes(viewer.id) || viewer.id === rec.chair);
  }

  async #shared(cite: SourceCite): Promise<boolean> {
    try { return this.#options.shareable === undefined ? false : await this.#options.shareable(cite); } catch { return false; }
  }

  /** What a reader is shown of a list of citations: the owner sees them all; others see those that can be shared, and `verifiable` is false when any cannot. */
  async #showSources(viewer: Principal, cites: readonly SourceCite[] | undefined): Promise<{ cites?: readonly SourceCite[]; verifiable: boolean }> {
    if (cites === undefined || cites.length === 0) return { verifiable: true };
    if (viewer.kind === "owner") return { cites, verifiable: true };
    const shown: SourceCite[] = [];
    for (const c of cites) if (await this.#shared(c)) shown.push(c);
    return { ...(shown.length === 0 ? {} : { cites: shown }), verifiable: shown.length === cites.length };
  }

  /**
   * Removes from a record the citations the reader cannot be shown (every `sources` list, at any depth), marking the object they were on `unverifiable`. The owner sees everything. Asking for a record never reveals its sources.
   */
  async #strip<T>(viewer: Principal, value: T): Promise<T> {
    if (viewer.kind === "owner") return value;
    const walk = async (node: unknown): Promise<unknown> => {
      if (Array.isArray(node)) return Promise.all(node.map(walk));
      if (node === null || typeof node !== "object") return node;
      const out: Record<string, unknown> = {};
      let removed = false;
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (k === "sources" && Array.isArray(v)) {
          const kept: unknown[] = [];
          for (const c of v as SourceCite[]) if (await this.#shared(c)) kept.push(c); else removed = true;
          if (kept.length > 0) out[k] = kept;
        } else out[k] = await walk(v);
      }
      if (removed) out["unverifiable"] = true;
      return out;
    };
    return (await walk(value)) as T;
  }

  async #summaryOf(recordId: string, rec: RecordBody): Promise<SummaryContent> {
    const occ = known<OccurrenceBody>(await this.#runner.get("meeting-occurrence", rec.occurrenceId));
    const motions: View<MotionBody>[] = [];
    const decisions: View<DecisionRecordBody>[] = [];
    const cites = new Map<string, boolean>();
    const check = async (list: readonly SourceCite[] | undefined): Promise<void> => { for (const c of list ?? []) { const k = `${c.kind}\0${c.id}`; if (!cites.has(k)) cites.set(k, await this.#shared(c)); } };
    for (const id of rec.motions) {
      const m = await this.#runner.get("meeting-motion", id);
      if (m === undefined) continue;
      motions.push(view<MotionBody>(m));
      const did = known<MotionBody>(m)!.decisionId;
      const d = did === undefined ? undefined : await this.#runner.get("meeting-decision", did);
      if (d !== undefined) { decisions.push(view<DecisionRecordBody>(d)); const db = known<DecisionRecordBody>(d)!; await check(db.sources); for (const t of db.table) await check(t.sources); }
    }
    for (const t of rec.tagged) await check(t.sources);
    const ballotVoters = new Set<string>();
    for (const m of motions) if (m.decisionId !== undefined) for (const v of rec.roster) if ((await this.#runner.get("meeting-ballot", derivedId("mbl", `${m.id}:${v}`))) !== undefined) ballotVoters.add(v);
    const merged: RecordBody = { ...rec, attended: [...new Set([...rec.attended, ...ballotVoters])] };
    return buildSummary({ recordId, record: merged, participants: occ?.participants ?? [], motions, decisions, shared: (c) => cites.get(`${c.kind}\0${c.id}`) === true });
  }

  async #privateSources(rec: RecordBody, recordId: string): Promise<{ ref: string; cites: readonly SourceCite[] }[]> {
    void recordId;
    const out: { ref: string; cites: readonly SourceCite[] }[] = [];
    for (const t of rec.tagged) if (t.sources !== undefined) out.push({ ref: t.entryId, cites: t.sources });
    for (const id of rec.motions) {
      const m = known<MotionBody>(await this.#runner.get("meeting-motion", id));
      if (m?.sources !== undefined) out.push({ ref: id, cites: m.sources });
      const d = m?.decisionId === undefined ? undefined : known<DecisionRecordBody>(await this.#runner.get("meeting-decision", m.decisionId));
      for (const t of d?.table ?? []) if (t.sources !== undefined) out.push({ ref: `${m!.decisionId}:${t.voter}`, cites: t.sources });
    }
    return out;
  }

  /** What has happened so far, in plain lines from the records: for the owner who arrives mid-meeting. */
  async #progress(rec: RecordBody): Promise<string> {
    const lines: string[] = [];
    let adopted = 0, applied = 0, waiting = 0, notApplied = 0, rejected = 0, open = 0;
    for (const id of rec.motions) {
      const m = known<MotionBody>(await this.#runner.get("meeting-motion", id));
      if (m === undefined) continue;
      if (m.state === "proposed" || m.state === "voting" || m.state === "tie-pending") open++;
      const d = m.decisionId === undefined ? undefined : known<DecisionRecordBody>(await this.#runner.get("meeting-decision", m.decisionId));
      if (d === undefined) continue;
      if (d.outcome === "rejected" || d.outcome === "failed" || d.outcome === "no-quorum") rejected++;
      if (d.outcome !== "adopted") continue;
      adopted++;
      for (const c of d.changes) { if (c.state === "applied") applied++; else if (c.state === "not-applied") notApplied++; else waiting++; }
    }
    lines.push(`${adopted} decision(s) adopted so far; ${applied} change(s) applied, ${notApplied} not applied, ${waiting} not yet applied; ${rejected} motion(s) did not pass; ${open} motion(s) still open.`);
    return lines.join(" ");
  }

  async #progressOf(recordId: string): Promise<string> {
    const rec = known<RecordBody>(await this.#runner.get("meeting-record", recordId));
    return rec === undefined ? "" : this.#progress(rec);
  }
}

export interface DiscussionEntry extends Omit<MeetingEntryBody, "sources"> {
  readonly sources?: readonly SourceCite[] | undefined;
  readonly id: string;
  readonly verifiable: boolean;
  readonly correctedBy?: readonly string[];
  /** The text now in force when the entry has been corrected; `text` is always the original. */
  readonly currentText?: string;
}

const jsonDraft = (v: Record<string, string | undefined>): Record<string, string> => Object.fromEntries(Object.entries(v).filter(([, x]) => x !== undefined)) as Record<string, string>;
