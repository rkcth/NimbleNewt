import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows, allowsExactly, inTaskScope } from "../security/access.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { Aggregate, ControllerStorage, JsonObject } from "../storage/types.js";
import type { DeskRecordBody } from "../context/desks.js";
import type { MeetingRecordService } from "./record.js";
import type { MeetingDeskReadService } from "./desk-reads.js";
import type { MeetingService } from "./meetings.js";
import type { MotionBody, RecordBody, SourceCite } from "./record-types.js";
import { PROCEDURE_KIND, type ProcedureBody } from "./procedure-types.js";
import { quotesBallot } from "./procedure-rules.js";
import type { BallotBody } from "./record-types.js";
import type { BallotValue } from "./votes.js";
import { FloorBusy, FloorWaits, type AsideRequest, type BallotRequest, type BetweenRequest, type BetweenResult, type CastingRequest, type ChairFloor, type CommentRequest, type FloorGate, type GateRequest, type MeetingDelivered, type MeetingFloor, type MeetingProcedureService, type ObjectionRequest, type RevisionRequest, type RulingInput, type RulingRequest, type StepResult } from "./procedure.js";
import { FLOOR_DEFAULTS, applyFloorChange, type FloorSettings } from "./floor-settings.js";
import {
  accountTurn, buildPrompt, chairQuestionRefusal, estimateTokens, parseJsonObject, parseObjection, parseStatement, parseVote, quoteOccurs, recordText, transcriptView, usesFacts, wrapCheckpointAnswer,
  type ShownEntry,
} from "./floor-text.js";
import {
  TurnWaitsOnTool,
  type AdvanceResult, type ChairQuestionRecord, type FloorBody, type FloorPhase, type Inflight, type InquiryState, type PortReply, type QueueItem, type StoredReply, type TurnKind, type TurnLog, type TurnRunner, type UnitKind, type WaitingOn,
} from "./floor-types.js";

export { TurnWaitsOnTool } from "./floor-types.js";
export type * from "./floor-types.js";

const KIND = "meeting-floor";
const RECORD_ID = /^mrc-[a-z2-7]{20}$/;
const AGENT = /^agent:[a-z0-9][a-z0-9-]{0,39}$/;
const DESK_ID = /^dsk-[a-z2-7]{20}$/;
const ENTRY_ID = /^mte-[a-z2-7]{20}-[0-9]{1,5}$/;
const ms = (iso: string): number => Date.parse(iso);
const json = (value: unknown): JsonObject => value as unknown as JsonObject;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const forbidden = (by: Principal, what: string): DomainError => new DomainError("forbidden", `${by.id} may not ${what}`);

/** What the floor keeps, at most: the record it belongs to is bounded the same way (every list is a window). */
export const FLOOR_LIMITS = { turns: 300, notices: 60, queue: 60, heldAnswers: 40, ownerAnswers: 60, chairQuestions: 30, investigations: 30, followUps: 60, stepsPerDrive: 400, unitRetries: 16, text: 3900, desk: 20, deskRead: 5, replies: 60, summaries: 80, tickUnits: 20 } as const;

/** What the facilitator needs from the rest of the controller. Nothing is reached by any other road. */
export interface FloorDeps {
  readonly records: Pick<MeetingRecordService, "record" | "discussion" | "append" | "move" | "amend" | "table" | "hold" | "resume" | "finish" | "motion" | "ballots">;
  /**
   * The meeting procedure (card M06), which is the only service that runs a motion (comment rounds, the objection check, rulings, tabling, ballots one at a time, revision turns, the casting vote). The floor starts it and steps it, and
   * is itself the procedure's `floor` and `chair` port (`asMembers`, `asChair`). A getter, because the procedure is built with the floor as its port. Absent: the floor only moves the motion and carries the owner's controls.
   */
  readonly procedure?: () => Pick<MeetingProcedureService, "begin" | "advance" | "expecting"> | undefined;
  readonly deskReads?: Pick<MeetingDeskReadService, "read">;
  readonly meetings?: Pick<MeetingService, "setAgendaState" | "agendaItem" | "correctAgendaItem">;
  /** The model side: one tool-less call per turn. */
  readonly runner: TurnRunner;
  /** A host or service principal that may read and run the meeting's record (the controller itself). */
  readonly service: Principal;
  /** The authenticated principal of a roster agent, for what only the agent itself may do (casting its own ballot, the chair's casting vote and desk reads). Absent: that agent cannot act. */
  readonly principalOf: (agent: string) => Promise<Principal | undefined>;
  /** The installation's defaults (`meeting.floor.*` settings); absent: the built-in ones. A failing read counts as absent. */
  readonly settings?: () => Promise<FloorSettings>;
  /** How an agent is described to its own model call (its role and habits). */
  readonly persona?: (agent: string) => Promise<string | undefined>;
  /** Notes from the member's own desk it may bring into a comment round or an answer. */
  readonly deskNotes?: (agent: string, recordId: string) => Promise<string | undefined>;
  /** Per-task and per-provider budgets: `ok: false` says what is reached. */
  readonly budget?: (agent: string, projectId: string) => Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }>;
  /** Makes an owned follow-up task. The command ID is stable, so a repeat makes no second task. */
  readonly followUps?: { create(input: { commandId: string; projectId: string; title: string; description: string; owner?: string }): Promise<{ id: string }> };
  /** A member's saved checkpoint, for a question put to one who is not in the room. */
  readonly checkpointOf?: (agent: string, recordId: string) => Promise<{ readonly savedAt: string; readonly text: string } | undefined>;
  /** The current revision of a record a statement cites, to tell whether the source has changed since. */
  readonly sourceRevision?: (cite: SourceCite) => Promise<number | undefined>;
  /** The owner is told (reminder of an idle inquiry, a budget that was reached, a timebox, a correction during an open vote). Failing it never stops the meeting. */
  readonly notifyOwner?: (notice: { recordId: string; projectId: string; kind: string; text: string; /** Makes the notice its own (a reminder repeated each idle period); without it the same words about the same meeting are one notice. */ key?: string }) => Promise<void>;
  /** The notices about an inquiry (opened, idle) are closed once the owner ends it, so none stays on the owner's list after the answer. Failing it never stops the meeting. */
  readonly settleOwner?: (notice: { recordId: string; projectId: string; kinds: readonly string[] }) => Promise<void>;
  /** Participants the owner did not address may go back to work during an inquiry, and are recalled when addressed (attendance's return rules). */
  readonly work?: { release(recordId: string, agents: readonly string[]): Promise<void>; recall(recordId: string, agent: string): Promise<void> };
  /** Timer for a turn that never answers; returns the way to cancel it. Default: the global timer. */
  readonly timer?: (ms: number, fire: () => void) => () => void;
}

const defaultTimer = (delay: number, fire: () => void): (() => void) => { const t = setTimeout(fire, delay); t.unref?.(); return () => clearTimeout(t); };
const isService = (p: Principal): boolean => (p.kind === "owner" || p.kind === "host" || p.kind === "service") && p.taskScope === undefined;
const hash = (...parts: readonly string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
const base = (recordId: string): string => recordId.slice(4);
/** The key a statement's TLDR is kept under: the procedure writes the statement, so its entry is found again by who said it and what. */
const summaryKey = (speaker: string, text: string): string => hash(speaker, text.trim());

const PRIORITY: Readonly<Record<QueueItem["kind"], number>> = { "owner-ask": 0, "chair-answer": 2, reply: 2, "chair-notes": 3, "direct-answer": 4, "direct-continue": 4, "direct-skip": 4 };
const sortQueue = (q: readonly QueueItem[]): QueueItem[] => q.map((x, i) => ({ x, i })).sort((a, b) => PRIORITY[a.x.kind] - PRIORITY[b.x.kind] || a.i - b.i).map((r) => r.x);

/**
 * The facilitator of a meeting (card M05): who has the floor, in what order, for how long and at what cost; the owner's commands; the chair's questions, notes and desk reads; the inquiry period; the timeboxes. It writes
 * every turn into the meeting record through `MeetingRecordService` (the records, votes and rules of M06) and keeps its own state, one record per meeting (`meeting-floor`), which survives a restart.
 *
 * The floor is a baton: a member is asked for something only when it holds the floor, receives the whole transcript up to that moment (never a ballot while a vote is open; ballots are not part of the transcript) and nothing otherwise.
 * One unit of work (one turn, or one batch for a blind round or an objection check) is claimed, answered, written and committed at a time, so the owner's question is taken at the next boundary without undoing anything that was written.
 * Every default is the proposal of the M00 record, kept configurable (`floor-settings.ts`).
 */
export class MeetingFloorService {
  readonly #runner: CommandRunner;
  readonly #deps: FloorDeps;
  private constructor(runner: CommandRunner, deps: FloorDeps) { this.#runner = runner; this.#deps = deps; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: FloorDeps, options: RunnerOptions = {}): MeetingFloorService {
    return new MeetingFloorService(new CommandRunner(storage, epoch, options), deps);
  }

  // ---- storage ---------------------------------------------------------------------------------------------------------------------------

  #floorId(recordId: string): string { return derivedId("mfl", recordId); }

  async #load(recordId: string): Promise<{ agg: Aggregate; body: FloorBody } | undefined> {
    const agg = await this.#runner.get(KIND, this.#floorId(recordId));
    return agg === undefined ? undefined : { agg, body: agg.body as unknown as FloorBody };
  }

  async #need(recordId: string): Promise<{ agg: Aggregate; body: FloorBody }> {
    const f = await this.#load(recordId);
    if (f === undefined) throw new DomainError("not_found", "this meeting has not been started on the floor");
    return f;
  }

  /** Changes the floor with `mutate` against the newest state, again from the top when someone else changed it first (a few tries). `mutate` returns undefined to change nothing. */
  async #update(recordId: string, by: Principal, tag: string, mutate: (b: FloorBody) => FloorBody | undefined): Promise<FloorBody> {
    for (let tries = 0; ; tries += 1) {
      const f = await this.#need(recordId);
      const next = mutate(f.body);
      if (next === undefined) return f.body;
      const body = capped(next);
      const commandId = `flr-${hash(recordId, String(f.agg.revision), tag, JSON.stringify(body))}`;
      try {
        await this.#runner.command("meeting.floor.update", { commandId, actor: by.id }, async () => ({
          payload: { recordId, tag, revision: f.agg.revision },
          build: async () => ({ ref: { kind: KIND, id: f.agg.id }, creates: false, changes: [{ type: "update" as const, ref: { kind: KIND, id: f.agg.id }, expectedRevision: f.agg.revision, body: json(body) }], detail: { projectId: body.projectId, tag } }),
        }));
        return body;
      } catch (error) {
        if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict") && tries < FLOOR_LIMITS.unitRetries) continue;
        throw error;
      }
    }
  }

  async #meeting(recordId: string): Promise<View<RecordBody>> {
    const rec = await this.#deps.records.record(this.#deps.service, recordId);
    if (rec === undefined) throw new DomainError("not_found", "no such meeting record, or none you may read");
    return rec;
  }

  #present(rec: RecordBody): string[] { return rec.roster.filter((a) => rec.attended.includes(a) && !rec.withheld.includes(a)); }
  #absent(rec: RecordBody): string[] { return rec.roster.filter((a) => !rec.attended.includes(a) || rec.withheld.includes(a)); }

  /**
   * The meeting's motion whose vote is open (voting, or tied and waiting for the casting vote), whoever runs it: the floor's own vote, the meeting procedure's (card M06) or one opened on the record. One vote at a time, so the newest
   * such motion is the one. Answers to the owner are held from the voters while it is there, and an inquiry holds it.
   */
  async #votingMotion(rec: RecordBody): Promise<(MotionBody & { id: string }) | undefined> {
    for (const id of [...rec.motions].reverse()) {
      const m = (await this.#deps.records.motion(this.#deps.service, id)) as unknown as MotionBody | undefined;
      if (m !== undefined && (m.state === "voting" || m.state === "tie-pending")) return { ...m, id };
    }
    return undefined;
  }

  /** Answers to the owner held while a vote was open go into the transcript once no vote is open, each once (stable command IDs), and leave the floor's list. */
  async #releaseHeld(by: Principal, recordId: string, rec: RecordBody): Promise<FloorBody> {
    const f = await this.#need(recordId);
    const keyOf = (h: FloorBody["held"][number]): string => hash(h.agent, h.at, h.question, h.text);
    for (const h of f.body.held) {
      await this.#deps.records.append(this.#deps.service, { commandId: `fl-${base(recordId)}-hr-${keyOf(h)}`, recordId, kind: "statement", speaker: h.agent, text: `(answer to the owner, released now that the vote has closed) ${recordText(h.text, FLOOR_LIMITS.text - 80)}` });
    }
    const done = new Set(f.body.held.map(keyOf));
    return this.#update(recordId, by, `release-held-${hash(...done)}`, (b) => (b.held.some((h) => done.has(keyOf(h))) ? { ...b, held: b.held.filter((h) => !done.has(keyOf(h))) } : undefined));
  }

  // ---- authorization ---------------------------------------------------------------------------------------------------------------------

  #controls(by: Principal, projectId: string): boolean { return isService(by) || (by.taskScope === undefined && allows(by, "meeting.manage", projectId)); }
  #ownerOnly(by: Principal, what: string): void { if (by.kind !== "owner" || by.taskScope !== undefined) throw forbidden(by, what); }
  #member(by: Principal, rec: RecordBody): boolean { return by.kind === "agent" && by.asOf !== undefined && inTaskScope(by, rec.projectId) && rec.roster.includes(by.id) && !rec.withheld.includes(by.id); }

  async #settings(): Promise<FloorSettings> {
    try { const s = await this.#deps.settings?.(); if (s !== undefined) return { ...FLOOR_DEFAULTS, ...s }; } catch { /* an unreadable setting is the default */ }
    return FLOOR_DEFAULTS;
  }

  // ---- starting --------------------------------------------------------------------------------------------------------------------------

  /**
   * The newest motion of the meeting that is still under way (proposed, being voted or tied). With `withProcedure` only one the meeting procedure runs: that is the motion `advance` moves.
   */
  async #activeMotion(rec: RecordBody, withProcedure: boolean): Promise<(MotionBody & { id: string }) | undefined> {
    for (const id of [...rec.motions].reverse()) {
      const m = (await this.#deps.records.motion(this.#deps.service, id)) as unknown as MotionBody | undefined;
      if (m === undefined || !(m.state === "proposed" || m.state === "voting" || m.state === "tie-pending")) continue;
      if (withProcedure && (await this.#runner.get(PROCEDURE_KIND, derivedId("mpr", id))) === undefined) continue;
      return { ...m, id };
    }
    return undefined;
  }

  /**
   * Puts a meeting's record on the floor and, when a motion is given, moves it and has the meeting procedure begin it: from here the procedure runs the rounds, the objection check and the vote one step at a time and the floor supplies
   * the members' turns (`advance` or `drive` do the next step). The owner, a host or service, or `meeting.manage` in the project. Called again once the motion has concluded, with another motion, it starts the next one (the clock, spend and inquiry
   * settings carry on).
   */
  async start(by: Principal, command: NoActor & { recordId: string; motion?: { text: string; topic?: string; agendaItemId?: string }; settings?: Readonly<Record<string, unknown>> }): Promise<{ motionId?: string; present: readonly string[]; absent: readonly string[]; replayed: boolean }> {
    onlyKnown(command, ["commandId", "recordId", "motion", "settings"]);
    const recordId = RECORD_ID.test(command.recordId) ? command.recordId : invalid("recordId", "is not a meeting record ID");
    const rec = await this.#meeting(recordId);
    if (!this.#controls(by, rec.projectId)) throw forbidden(by, "start that meeting on the floor");
    if (rec.state !== "open") throw new DomainError("invalid_command", `the meeting is ${rec.state}`, { field: "recordId" });
    const existing = await this.#load(recordId);
    let settings = await this.#settings();
    if (command.settings !== undefined) try { settings = applyFloorChange(settings, command.settings); } catch (e) { invalid("settings", (e as Error).message); }
    const present = this.#present(rec);
    const absent = this.#absent(rec);
    const now = this.#runner.now();
    if (existing !== undefined && command.motion !== undefined) {
      // The floor is on one motion at a time: the next is moved once the earlier one is over.
      const running = await this.#activeMotion(rec, true);
      if (running !== undefined && existing.body.motionId !== undefined && running.id !== existing.body.motionId) throw new DomainError("invalid_command", "the floor is still on an earlier motion", { field: "motion" });
      if (running !== undefined && running.id === existing.body.motionId) return { motionId: running.id, present, absent, replayed: true };
    }
    const motionId = command.motion === undefined ? undefined : await this.#moveAndBegin(rec, recordId, command, present);
    if (existing !== undefined) {
      if (motionId !== undefined) await this.#update(recordId, by, `next-motion-${motionId}`, (b) => (b.motionId === motionId ? undefined : { ...b, motionId, between: undefined, lastBetween: undefined, queue: b.queue.filter((q) => q.kind === "owner-ask"), chairQuestions: [], chairQuestionsAsked: 0, asks: {}, timebox: undefined }));
      return { ...(motionId === undefined ? (existing.body.motionId === undefined ? {} : { motionId: existing.body.motionId }) : { motionId }), present, absent, replayed: motionId === undefined };
    }
    const durationMs = Math.max(60_000, ms(rec.endsAt) - ms(now));
    const body: FloorBody = {
      recordId, occurrenceId: rec.occurrenceId, projectId: rec.projectId, state: "running", settings, queue: [], ...(motionId === undefined ? {} : { motionId }), unitSeq: 0, replies: {}, claims: {},
      clock: { startedAt: now, durationMs, extraMs: 0, pausedMs: 0 },
      spend: { usd: 0, tokens: 0, calls: 0, hiddenTokens: 0, ownerUsd: 0, ownerTokens: 0, extraUsd: 0, extraTokens: 0 }, turns: [], deliveries: 0, summaries: {}, chairNotesCount: 0,
      chairQuestions: [], chairQuestionsAsked: 0, asks: {}, desk: { offered: [], filesRead: [], filesQuoted: [], refused: [], rejectedExcerpts: 0, corrections: [], readOwners: [], pending: [] }, skipped: [], held: [], ownerAnswers: [], investigations: [], followUps: [], notices: [], priorities: [], startedAt: now,
    };
    try {
      await this.#runner.command("meeting.floor.start", { commandId: `flr-start-${base(recordId)}`, actor: by.id }, async () => ({
        payload: { recordId },
        build: async () => ({ ref: { kind: KIND, id: this.#floorId(recordId) }, creates: true, changes: [{ type: "create" as const, ref: { kind: KIND, id: this.#floorId(recordId) }, body: json(body) }], detail: { projectId: rec.projectId } }),
      }));
    } catch (error) {
      if (error instanceof DomainError && error.code === "command_conflict") return { ...(motionId === undefined ? {} : { motionId }), present, absent, replayed: true };
      throw error;
    }
    await this.#noteAbsent(recordId, rec, absent);
    return { ...(motionId === undefined ? {} : { motionId }), present, absent, replayed: false };
  }

  /** Moves the motion (the chair moves it, else the first present member) and has the procedure begin it, once: a repeat of the same start makes nothing twice. */
  async #moveAndBegin(rec: RecordBody, recordId: string, command: { commandId: string; motion?: { text: string; topic?: string; agendaItemId?: string } }, present: readonly string[]): Promise<string> {
    const motion = command.motion!;
    const proposer = rec.chair ?? present[0];
    if (proposer === undefined) throw new DomainError("invalid_command", "nobody is present to move the motion", { field: "motion" });
    const mover = await this.#deps.principalOf(proposer);
    if (mover === undefined) throw new DomainError("invalid_command", `${proposer} has no credential to move the motion`, { field: "motion" });
    const m = await this.#deps.records.move(mover, { commandId: `fl-mv-${hash(recordId, command.commandId, motion.text)}`, recordId, text: recordText(motion.text), ...(motion.topic === undefined ? {} : { topic: motion.topic }), ...(motion.agendaItemId === undefined ? {} : { agendaItemId: motion.agendaItemId }) } as never);
    const procedure = this.#deps.procedure?.();
    if (procedure !== undefined && (await this.#runner.get(PROCEDURE_KIND, derivedId("mpr", m.id))) === undefined) await procedure.begin(this.#deps.service, { commandId: `fl-pb-${hash(recordId, m.id)}`, motionId: m.id });
    return m.id;
  }

  /** A skipped member is recorded in the transcript (by the chair, when there is one) and on the floor. */
  async #noteAbsent(recordId: string, rec: RecordBody, absent: readonly string[]): Promise<void> {
    if (absent.length === 0) return;
    const now = this.#runner.now();
    await this.#update(recordId, this.#deps.service, `absent-${hash(...absent)}`, (b) => ({ ...b, skipped: [...b.skipped, ...absent.filter((a) => !b.skipped.some((s) => s.agent === a)).map((agent) => ({ agent, why: "absent (decided by the controller from the roster and attendance)", at: now }))] }));
    if (rec.chair !== undefined) {
      for (const a of absent) {
        await this.#deps.records.append(this.#deps.service, { commandId: `fl-abs-${hash(recordId, a)}`, recordId, kind: "statement", speaker: rec.chair, text: `${a} is absent and is skipped in the comment rounds and the vote (recorded).` });
      }
    }
  }

  // ---- reading the transcript ------------------------------------------------------------------------------------------------------------

  /** The transcript up to the newest entry, as it is shown to a member: the whole text, or facts-style summaries (the full text stays in the record). */
  async #transcript(recordId: string, b: FloorBody, rec: RecordBody, full: boolean, from = 1): Promise<{ text: string; upTo: number; entries: ShownEntry[] }> {
    const out: ShownEntry[] = [];
    let seq = from;
    let upTo = 0;
    for (;;) {
      const page = await this.#deps.records.discussion(this.#deps.service, recordId, { fromSeq: seq, limit: 100 });
      if (page === undefined) break;
      for (const e of page.entries) {
        upTo = Math.max(upTo, e.seq);
        if (e.kind === "presence") continue;
        const text = e.currentText ?? e.text;
        const label = e.kind === "owner-message" ? "owner" : e.kind === "motion" || e.kind === "amendment" || e.kind === "ruling" || e.kind === "vote" || e.kind === "correction" ? e.kind : undefined;
        const summary = e.kind === "statement" ? b.summaries[summaryKey(e.speaker, text)] : undefined;
        out.push({ seq: e.seq, who: e.kind === "owner-message" ? "Owner" : e.speaker, ...(label === undefined ? {} : { label }), text, ...(summary === undefined ? {} : { summary }) });
      }
      if (page.next === undefined) break;
      seq = page.next;
    }
    const facts = !full && usesFacts(b.settings.transcriptMode, this.#present(rec).length, b.settings.factsAboveMembers);
    return { text: transcriptView(out, facts ? "facts" : "full"), upTo, entries: out };
  }

  async #persona(agent: string): Promise<string> { return (await this.#deps.persona?.(agent).catch(() => undefined)) ?? `You are ${agent}.`; }

  // ---- the model call --------------------------------------------------------------------------------------------------------------------

  #hangMs(b: FloorBody): number { return b.settings.hangTimeoutSeconds * 1000; }

  async #ask(b: FloorBody, input: { kind: import("./floor-types.js").TurnKind; agent: string; prompt: import("./floor-text.js").Prompt; visible: number; round?: number; deliveredUpTo: number; owner?: boolean }): Promise<StoredReply["items"][number]> {
    const zero = { visible: 0, hidden: 0, input: 0, cached: 0 };
    const budget = await this.#deps.budget?.(input.agent, b.projectId).catch(() => ({ ok: false as const, reason: "the budget could not be read" }));
    if (budget !== undefined && !budget.ok) await this.#deps.notifyOwner?.({ recordId: b.recordId, projectId: b.projectId, kind: "budget", text: `${input.agent} could not take its turn in a meeting: the budget is reached (${budget.reason}).` }).catch(() => undefined);
    if (budget !== undefined && !budget.ok) return { agent: input.agent, text: "", noResponse: `budget reached: ${budget.reason}`, usage: zero, deliveredUpTo: input.deliveredUpTo };
    const ac = new AbortController();
    const cancel = (this.#deps.timer ?? defaultTimer)(this.#hangMs(b), () => ac.abort());
    const hung = new Promise<never>((_, reject) => ac.signal.addEventListener("abort", () => reject(new Error(`no answer within ${b.settings.hangTimeoutSeconds} seconds`)), { once: true }));
    try {
      const reply = await Promise.race([this.#deps.runner.turn({ kind: input.kind, agent: input.agent, recordId: b.recordId, prompt: input.prompt, maxVisibleTokens: input.visible, maxHiddenTokens: b.settings.hiddenReasoningTokens, signal: ac.signal, ...(input.round === undefined ? {} : { round: input.round }) }), hung]);
      const acct = accountTurn(recordText(reply.text, FLOOR_LIMITS.text * 2), reply.usage, { visible: input.visible, hidden: b.settings.hiddenReasoningTokens });
      return {
        agent: input.agent, text: acct.text, deliveredUpTo: input.deliveredUpTo,
        usage: { visible: acct.visibleTokens, hidden: acct.hiddenTokens, input: reply.usage?.inputTokens ?? estimateTokens(input.prompt.text), cached: reply.usage?.cachedTokens ?? 0 },
        ...(acct.truncated ? { truncated: true as const } : {}), ...(acct.hiddenOver ? { hiddenOver: true as const } : {}),
        // the cost rides on the first item of a reply
        ...(reply.costUsd === undefined ? {} : { costUsd: reply.costUsd }),
      } as StoredReply["items"][number];
    } catch (error) {
      if (error instanceof TurnWaitsOnTool) return { agent: input.agent, text: "", noResponse: `waiting on ${error.tool}`, waitsOnTool: error.tool, usage: zero, deliveredUpTo: input.deliveredUpTo };
      // The route's own error text can carry a host path, an address or a key: it is not kept. The hang timeout and a refusal the controller itself raised say what happened in their own words.
      const said = ac.signal.aborted ? `no answer within ${b.settings.hangTimeoutSeconds} seconds` : error instanceof DomainError ? `the call was refused (${error.code})` : "the model call failed";
      return { agent: input.agent, text: "", noResponse: said, usage: zero, deliveredUpTo: input.deliveredUpTo };
    } finally { cancel(); }
  }

  // ---- advancing -------------------------------------------------------------------------------------------------------------------------

  #allowedMs(b: FloorBody): number { return b.clock.durationMs + b.clock.extraMs; }
  #elapsedMs(b: FloorBody, now: string): number { return Math.max(0, ms(now) - ms(b.clock.startedAt) - b.clock.pausedMs - (b.clock.pausedAt === undefined ? 0 : ms(now) - ms(b.clock.pausedAt))); }

  /** Why the meeting's own timebox is used up, if it is (time without the inquiry's pauses; spend without the owner's own questions). */
  #timeboxed(b: FloorBody, now: string): "time" | "spend" | undefined {
    if (this.#elapsedMs(b, now) >= this.#allowedMs(b)) return "time";
    if (b.spend.usd >= b.settings.spendCapUsd + b.spend.extraUsd || b.spend.tokens >= b.settings.tokenCap + b.spend.extraTokens) return "spend";
    return undefined;
  }

  /**
   * The next unit of the floor's own work, or why there is none. Pure: it reads the floor and the meeting only. The rounds, the objection check, rulings and the vote are not here: they are the meeting procedure's (card M06), which asks
   * the floor for the members' turns and asks it first (`before`) whether it holds the meeting back.
   */
  #plan(b: FloorBody, rec: RecordBody, now: string, active?: { state: string }): { unit: Inflight } | { wait: Extract<AdvanceResult, { waiting: string }>["waiting"]; detail?: string } {
    const id = (kind: UnitKind): string => `u${b.unitSeq + 1}-${kind}`;
    const mk = (kind: UnitKind, extra: Partial<Inflight> = {}): { unit: Inflight } => ({ unit: { id: id(kind), kind, since: now, ...extra } });
    if (b.state === "ended" || rec.state !== "open") return { wait: "meeting-ended" };
    if (b.inquiry !== undefined) {
      const ask = sortQueue(b.queue).find((q) => q.kind === "owner-ask");
      return ask === undefined ? { wait: "owner", detail: "the owner's inquiry is open" } : mk("owner-ask", { agent: ask.agent, queueId: ask.id, owner: true });
    }
    const front = sortQueue(b.queue)[0];
    if (front?.kind === "owner-ask") return mk("owner-ask", { agent: front.agent, queueId: front.id, owner: true });
    if (b.timebox !== undefined) return { wait: "none", detail: `the meeting's ${b.timebox.reason} timebox is used up` };
    const boxed = this.#timeboxed(b, now);
    // The timebox ends the meeting's own work: a motion not yet put to a vote is tabled; one being voted on is counted without more ballots.
    if (boxed !== undefined && active !== undefined) return mk("wrap-up");
    if (front !== undefined) return mk(front.kind as UnitKind, { agent: front.agent, queueId: front.id });
    return { wait: "none", detail: "the floor has no work of its own; the procedure runs the motion" };
  }

  /**
   * Does the next step: first the floor's own work (the owner's questions come first, then the answers owed to members' and the chair's questions, the timebox's wrap-up), then the next step of the motion's procedure, which asks the floor
   * for the members' turns. Returns what it did, or why nothing can be done now. Safe to call from several places at once: a unit is claimed first, and a claim that is still fresh makes the other caller `busy`; a claim whose caller died is
   * taken over (its stored reply is written, nothing is asked twice).
   */
  async advance(by: Principal, command: { recordId: string }): Promise<AdvanceResult> {
    const recordId = RECORD_ID.test(command.recordId) ? command.recordId : invalid("recordId", "is not a meeting record ID");
    const rec = await this.#meeting(recordId);
    if (!this.#controls(by, rec.projectId)) throw forbidden(by, "run that meeting");
    const own = await this.#advance(by, recordId, rec, false);
    if ("did" in own || own.waiting !== "none") return own;
    const procedure = this.#deps.procedure?.();
    const motion = procedure === undefined ? undefined : await this.#activeMotion(rec, true);
    if (procedure === undefined || motion === undefined) return own;
    const out = this.#fromStep(await procedure.advance(this.#deps.service, { motionId: motion.id }));
    // The step may have closed the vote: answers held from the voters are released at once, not at the next call.
    const after = await this.#need(recordId);
    if (after.body.held.length > 0) {
      const fresh = await this.#meeting(recordId);
      if (fresh.state === "open" && (await this.#votingMotion(fresh)) === undefined) await this.#releaseHeld(by, recordId, fresh);
    }
    return out;
  }

  #fromStep(step: StepResult): AdvanceResult {
    const phase = step.stage as FloorPhase;
    if (step.done) return { waiting: "none", phase, detail: step.did };
    if (step.waiting === undefined) return { did: "procedure", phase, detail: step.did };
    const on = step.waiting.on === "owner" ? "owner" : step.waiting.on === "chair" ? "chair" : step.waiting.on === "time" ? "vote-time" : step.waiting.on === "tool" ? "tool" : step.waiting.on === "busy" ? "busy" : "none";
    return { waiting: on, phase, detail: step.waiting.why };
  }

  async #advance(by: Principal, recordId: string, rec0: View<RecordBody>, onlyOwner: boolean): Promise<AdvanceResult> {
    let rec = rec0;
    let f = await this.#need(recordId);
    const phaseNow = (): FloorPhase => "none";
    const now = this.#runner.now();
    // A claim that is still fresh belongs to another caller; one that outlived the hang timeout is taken over.
    if (f.body.inflight !== undefined) {
      const age = ms(now) - ms(f.body.inflight.since);
      if (age < (f.body.settings.hangTimeoutSeconds + 30) * 1000 && !(f.body.inflight.reply !== undefined)) return { waiting: "busy", phase: phaseNow() };
      if (f.body.inflight.reply === undefined && age >= (f.body.settings.hangTimeoutSeconds + 30) * 1000) { /* take it over */ }
    }
    let unit = f.body.inflight;
    if (unit === undefined) {
      rec = await this.#meeting(recordId);
      if (f.body.held.length > 0 && rec.state === "open" && (await this.#votingMotion(rec)) === undefined) f = { agg: f.agg, body: await this.#releaseHeld(by, recordId, rec) };
      const plan = this.#plan(f.body, rec, now, await this.#activeMotion(rec, false));
      if ("wait" in plan) return { waiting: plan.wait, phase: phaseNow(), ...(plan.detail === undefined ? {} : { detail: plan.detail }) };
      if (onlyOwner && !plan.unit.owner) return { waiting: "owner", phase: phaseNow(), detail: "only the owner's questions run now" };
      const claimed = plan.unit;
      try {
        await this.#update(recordId, by, `claim-${claimed.id}`, (b) => (b.inflight !== undefined || b.unitSeq + 1 !== Number(claimed.id.slice(1, claimed.id.indexOf("-"))) ? (() => { throw new DomainError("stale_revision", "another caller claimed the next unit"); })() : { ...b, unitSeq: b.unitSeq + 1, inflight: claimed }));
      } catch (error) {
        if (error instanceof DomainError && error.code === "stale_revision") return { waiting: "busy", phase: phaseNow() };
        throw error;
      }
      f = await this.#need(recordId);
      unit = f.body.inflight!;
    }
    return this.#run(by, recordId, unit);
  }

  /** Runs (or finishes) a claimed unit: ask the model(s), store the reply, write the record, commit the floor. */
  async #run(by: Principal, recordId: string, unit: Inflight): Promise<AdvanceResult> {
    let f = await this.#need(recordId);
    const rec = await this.#meeting(recordId);
    let reply = unit.reply;
    if (reply === undefined) {
      reply = await this.#askUnit(f.body, rec, unit);
      const stored = reply;
      f = { agg: f.agg, body: await this.#update(recordId, by, `reply-${unit.id}`, (b) => (b.inflight?.id === unit.id ? { ...b, inflight: { ...b.inflight, reply: stored } } : undefined)) as unknown as FloorBody } as never;
    }
    const tool = reply.items.find((i) => i.waitsOnTool !== undefined);
    if (tool !== undefined) {
      // The agent waits on a tool: the unit is dropped (no spend counted twice) and tried again at the next advance.
      const now = this.#runner.now();
      const body = await this.#update(recordId, by, `tool-${unit.id}`, (b) => (b.inflight?.id === unit.id ? { ...b, inflight: undefined, waitingTool: { tool: tool.waitsOnTool!, agent: tool.agent, since: b.waitingTool?.since ?? now } } : undefined));
      return { waiting: "tool", phase: "none", detail: tool.waitsOnTool! };
    }
    const fresh = (await this.#need(recordId)).body;
    const recNow = await this.#meeting(recordId);
    if (recNow.state !== "open") {
      // the meeting ended (the owner's end command takes effect at this boundary): the unit is dropped, nothing completed is undone
      await this.#update(recordId, by, `ended-${unit.id}`, (b) => ({ ...b, inflight: undefined, state: "ended", endedAt: this.#runner.now() }));
      return { waiting: "meeting-ended", phase: "none" };
    }
    let fx: Record<string, unknown>;
    try { fx = await this.#apply(by, recordId, fresh, recNow, unit, reply); } catch (error) {
      // The step cannot be taken now: the unit is dropped (asked again later) and what the call cost is still counted.
      if (error instanceof Wait) { await this.#update(recordId, by, `wait-${unit.id}`, (b) => (b.inflight?.id === unit.id ? { ...this.#account(b, unit, reply!), inflight: undefined } : undefined)); return { waiting: error.reason, phase: "none", detail: error.message }; }
      throw error;
    }
    const done = await this.#update(recordId, by, `commit-${unit.id}`, (b) => (b.inflight?.id === unit.id ? this.#reduce(b, recNow, unit, reply!, fx) : undefined));
    void done;
    return { did: unit.kind, ...(unit.agent === undefined ? {} : { agent: unit.agent }), phase: "none" };
  }

  /** Runs units until nothing can be done now, the meeting is over, or `maxUnits` units ran. */
  async drive(by: Principal, command: { recordId: string; maxUnits?: number }): Promise<{ did: number; last: AdvanceResult }> {
    onlyKnown(command, ["recordId", "maxUnits"]);
    const max = command.maxUnits === undefined ? FLOOR_LIMITS.stepsPerDrive : Number.isInteger(command.maxUnits) && command.maxUnits >= 1 && command.maxUnits <= 2000 ? command.maxUnits : invalid("maxUnits", "must be 1 to 2000");
    let did = 0;
    let last: AdvanceResult = { waiting: "none", phase: "none" };
    while (did < max) {
      last = await this.advance(by, { recordId: command.recordId });
      if ("waiting" in last && last.waiting !== undefined) break;
      did += 1;
    }
    return { did, last };
  }

  // ---- asking the model for a unit -------------------------------------------------------------------------------------------------------

  async #motionText(b: FloorBody): Promise<{ version: number; text: string } | undefined> {
    if (b.motionId === undefined) return undefined;
    const m = (await this.#deps.records.motion(this.#deps.service, b.motionId)) as unknown as MotionBody | undefined;
    return m === undefined ? undefined : { version: m.version, text: m.text };
  }

  /** What the member itself exchanged with the owner while a vote was held: its own words are its own, so it keeps them though other voters do not get them. */
  #ownExchange(b: FloorBody, agent: string): string {
    const mine = b.held.filter((h) => h.agent === agent);
    return mine.length === 0 ? "" : `Your own earlier exchange with the owner:\n${mine.map((h) => `Owner: ${h.question}\nYou: ${h.text}`).join("\n")}`;
  }

  /** The files of absent members the chair may be offered: committed shared records, and private ones only for a chair that holds the exact scratch grant (the read itself checks again). */
  async #offers(b: FloorBody, rec: RecordBody): Promise<{ id: string; owner: string; title: string; visibility: "shared" | "private" }[]> {
    const absent = this.#absent(rec);
    if (absent.length === 0 || rec.chair === undefined) return [];
    const chair = await this.#deps.principalOf(rec.chair);
    const scratch = chair !== undefined && allowsExactly(chair, "desk.scratch.read", rec.projectId);
    const out: { id: string; owner: string; title: string; visibility: "shared" | "private" }[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list("desk-record", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const d = a.body as unknown as DeskRecordBody;
        if (d.projectId !== rec.projectId || !absent.includes(d.owner) || d.status === "draft" || d.deleted !== undefined || d.archived !== undefined) continue;
        if (d.visibility === "private" && !scratch) continue;
        if (out.length < FLOOR_LIMITS.desk) out.push({ id: a.id, owner: d.owner, title: recordText(d.title, 120), visibility: d.visibility });
      }
      if (page.length < 200 || out.length >= FLOOR_LIMITS.desk) break;
    }
    void b;
    return out;
  }

  /** The motion the floor's own work is about: the meeting's newest motion under way, else the one the floor was started with. */
  async #motionNow(b: FloorBody, rec: RecordBody): Promise<{ version: number; text: string } | undefined> {
    const active = await this.#activeMotion(rec, false);
    if (active !== undefined) return { version: active.version, text: active.text };
    return this.#motionText(b);
  }

  /** One model call with the prompt every kind of turn shares: the persona, the motion, the transcript as the member may see it (never a ballot), its own exchange with the owner and its own desk notes. The reply is not stored or accounted here. */
  async #prompted(b: FloorBody, rec: RecordBody, motion: { version: number; text: string } | undefined, kind: TurnKind, agent: string, instruction: string, o: { visible?: number; blind?: boolean; full?: boolean; extra?: string; transcript?: string; upTo?: number; desk?: boolean; owner?: boolean; round?: number } = {}): Promise<PortReply> {
    let t: { text: string; upTo: number };
    if (o.blind === true) t = { text: "(This is the independent first round: you have not heard anyone else.)", upTo: 0 };
    else if (o.transcript !== undefined) t = { text: o.transcript, upTo: o.upTo ?? 0 };
    else { const x = await this.#transcript(b.recordId, b, rec, o.full === true || agent === rec.chair); t = { text: x.text, upTo: x.upTo }; }
    const notes = o.desk === true ? await this.#deps.deskNotes?.(agent, b.recordId).catch(() => undefined) : undefined;
    const extra = [o.extra, this.#ownExchange(b, agent), notes === undefined ? "" : `Notes you looked up on your own desk:\n${notes}`].filter((x): x is string => x !== undefined && x !== "").join("\n\n");
    const prompt = buildPrompt({ order: b.settings.promptOrder, motion, transcript: t.text, persona: await this.#persona(agent), extra, instruction });
    return this.#ask(b, { kind, agent, prompt, visible: o.visible ?? b.settings.turnTokens, deliveredUpTo: t.upTo, ...(o.round === undefined ? {} : { round: o.round }), ...(o.owner === true ? { owner: true } : {}) });
  }

  async #askUnit(b: FloorBody, rec: RecordBody, unit: Inflight): Promise<StoredReply> {
    const items: StoredReply["items"][number][] = [];
    let cost = 0;
    const take = (i: StoredReply["items"][number]): void => { cost += i.costUsd ?? 0; items.push(i); };
    const order = b.settings.promptOrder;
    const motion = await this.#motionNow(b, rec);
    const words = (tokens: number): number => Math.max(20, Math.round(tokens * 0.7));
    const limit = b.settings.turnTokens;
    const chair = rec.chair;
    const round = b.between?.round;
    const ask = (kind: TurnKind, agent: string, instruction: string, o: { visible?: number; full?: boolean; transcript?: string; upTo?: number; desk?: boolean; owner?: boolean } = {}): Promise<PortReply> => this.#prompted(b, rec, motion, kind, agent, instruction, { ...o, ...(round === undefined ? {} : { round }) });
    const SHORT = "Use exactly this format:\nSTANCE: for|against|undecided\nSTATEMENT: <your statement>\nTLDR: none";
    const q = b.queue.find((x) => x.id === unit.queueId);
    const half = Math.ceil(limit / 2) + 20;
    switch (unit.kind) {
      case "owner-ask": {
        if (q?.checkpoint === true) {
          const cp = await this.#deps.checkpointOf?.(unit.agent!, b.recordId).catch(() => undefined);
          const prompt = buildPrompt({ order, motion: undefined, transcript: `SAVED CHECKPOINT of ${unit.agent!} (saved ${cp?.savedAt ?? "at an unknown time"}):\n${cp?.text ?? "(none)"}`, persona: `You are answering for ${unit.agent!}, who is not in the meeting, only from the saved checkpoint above.`, instruction: `Answer the owner's question in at most ${words(b.settings.ownerAnswerTokens)} words, only from the checkpoint; say what is unconfirmed or may be out of date; do not take or promise any action. Question: ${q.question ?? ""}` });
          take(await this.#ask(b, { kind: "checkpoint-answer", agent: unit.agent!, prompt, visible: b.settings.ownerAnswerTokens, deliveredUpTo: 0, owner: true }));
        } else take(await ask("owner-answer", unit.agent!, `The owner asks you directly: "${q?.question ?? ""}". Answer the owner in at most ${words(b.settings.ownerAnswerTokens)} words, from your own background and notes only. Reply exactly:\nANSWER: <text>\nSOURCES: none | <kind:id@revision>, ...\nCOMPLETED: none | <what you have actually done>\nPROPOSED: none | <what you only propose, not yet done>\nINVESTIGATE: none | <a question that needs deeper work than this meeting>`, { visible: b.settings.ownerAnswerTokens, desk: true, owner: true }));
        break;
      }
      case "direct-answer": take(await ask("direct-answer", unit.agent!, `${q?.from ?? "A member"} asked you directly: "${q?.question ?? ""}". Answer in at most ${words(limit / 2)} words, from your own background and notes. Do not ask anything back. ${SHORT}`, { visible: half, desk: true })); break;
      case "direct-continue": take(await ask("direct-continue", unit.agent!, `You asked a question and the answer is above. If it changes anything for you, say so in at most ${words(limit / 2)} words; otherwise say briefly that it does not. ${SHORT}`, { visible: half })); break;
      case "chair-answer": { const cq = b.chairQuestions.find((x) => x.id === q?.chairQuestionId); take(await ask("chair-answer", unit.agent!, `The chair asked you: "${cq?.topic ?? ""}" — ${cq?.experienceSought ?? ""}. Answer in at most ${words(limit / 2)} words, from your own experience and your notes only. ${SHORT}`, { visible: half, desk: true })); break; }
      case "reply": take(await ask("reply", unit.agent!, `The chair's questions have been answered above. In at most ${words(limit / 2)} words, say whether the answers change your view before the vote. ${SHORT}`, { visible: half, desk: true })); break;
      case "chair-notes": take(await ask("chair-notes", chair!, b.settings.chairNotes === "rolling" && b.chairNotes !== undefined ? `YOUR PRIVATE NOTES SO FAR:\n${b.chairNotes}\n\nUpdate your notes with the newest statement: one short entry per speaker: key claims and evidence, what they could not answer, and follow-up factual questions you may want to ask (never how anyone will vote).` : "Read the full statements above. Keep private notes for yourself, briefly: for each speaker, their key claims and evidence, anything they could not answer or left unclear, and the follow-up factual questions you may want to ask (facts and experience only, never how anyone will vote).", { visible: 450, full: true })); break;
      case "chair-questions": {
        const left = Math.max(0, b.settings.chairQuestionCap - b.chairQuestionsAsked);
        take(await ask("chair-questions", chair!, `${b.chairNotes === undefined ? "" : `Your private notes:\n${b.chairNotes}\n\n`}Ask up to ${left} factual questions of named members to inform the group, for example asking those who have used a tool what they found. Each question needs: "to" (one of: ${rec.roster.join(", ")}), "topic" (a factual topic) and "experience_sought". Never ask how anyone will vote or whether they are for or against. Reply with JSON only: {"questions":[{"to":"...","topic":"...","experience_sought":"..."}]} (an empty list if none).`, { visible: 300, full: true }));
        break;
      }
      case "desk-offer": {
        const offered = await this.#offers(b, rec);
        take({ agent: chair!, text: JSON.stringify(offered), usage: { visible: 0, hidden: 0, input: 0, cached: 0 }, deliveredUpTo: 0 });
        if (offered.length > 0) take(await ask("desk-offer", chair!, `Some members are absent. Under the meeting rules you may read an absent member's desk, read-only, to inform the group. These files are offered:\n${offered.map((o) => `- ${o.id} (${o.visibility}; desk of ${o.owner}, absent): ${o.title}`).join("\n")}\n\nChoose at most ${FLOOR_LIMITS.deskRead} files to read, by their IDs, only those that bear on the motion. Reply with JSON only: {"read":["<file id>"]}`, { visible: 150, full: true }));
        break;
      }
      case "desk-excerpts": take(await ask("desk-excerpts", chair!, `The files you read are below. Choose at most 3 short excerpts that bear on the motion. Each needs the file ID, a verbatim quote copied exactly from the file and what it bears on. Facts and evidence only; never anything about how to vote.\n\n${b.desk.pending.map((f) => `FILE ${f.id} (${f.title}; desk of ${f.owner}, absent):\n${f.text}`).join("\n\n")}\n\nReply with JSON only: {"excerpts":[{"file":"<file id>","quote":"...","bears_on":"..."}]}`, { visible: 450, full: true })); break;
      case "correction": take(await ask("correction", unit.agent!, `While you were away the chair read your desk, read-only. Files read: ${b.desk.filesRead.join(", ") || "none"}. Files quoted to the meeting: ${b.desk.filesQuoted.join(", ") || "none"} (see the transcript, marked unverified). If the meeting was given a wrong or misleading picture of your view, add a short correction. Reply exactly:\nCORRECTION: none | <at most 40 words>\nCONTRADICTS: yes|no`, { visible: 120 })); break;
      case "chair-summary": take(await ask("chair-summary", chair!, `You have read the full statements. Give the group a neutral summary of the most important points before the next round: at most ${b.settings.chairSummaryPoints} points, covering points several speakers made, points a speaker made that the summaries left out and points the speakers dispute, each attributed and balanced, with no recommendation. A point left out of a summary must carry a verbatim quote from the speaker's full statement. Reply with JSON only: {"points":[{"kind":"shared|omitted|disputed","speakers":["<member id>"],"point":"...","quote":"<only for omitted>"}]}`, { visible: 700, full: true })); break;
      case "chair-reminders": take(await ask("chair-reminders", chair!, `Above are the statements as the other members saw them (summaries where long). You have read the full text. Find up to ${b.settings.chairReminders} important points a member's summary left out that the others should know before the vote. Each needs the speaker's member id and a verbatim quote from their full statement. Reply with JSON only: {"reminders":[{"from":"<member id>","quote":"..."}]}`, { visible: 450, full: true })); break;
      default: break;
    }
    return { items, costUsd: cost };
  }

  // ---- writing a unit's result into the record -------------------------------------------------------------------------------------------

  async #say(recordId: string, unit: Inflight, key: string, agent: string, text: string): Promise<string> {
    const clean = recordText(text, FLOOR_LIMITS.text);
    const r = await this.#deps.records.append(this.#deps.service, { commandId: `fl-${base(recordId)}-${unit.id}-${key}`.slice(0, 120), recordId, kind: "statement", speaker: agent, text: clean === "" ? "(no words)" : clean });
    return r.id;
  }

  /** An inquiry opened while a ballot was being asked holds the vote: the answer is not cast now, and the voter is asked again once the vote resumes (with what was said meanwhile). */
  async #notHeld(motionId: string): Promise<void> {
    const m = (await this.#deps.records.motion(this.#deps.service, motionId)) as unknown as MotionBody | undefined;
    if (m?.heldAt !== undefined) throw new Wait("owner", "the vote is held for the owner's inquiry; the ballot is asked again when it resumes");
  }

  async #voterPrincipal(agent: string): Promise<Principal | undefined> { return this.#deps.principalOf(agent).catch(() => undefined); }

  /** Writes what the reply means into the meeting record (every write has an ID derived from the unit, so a repeat after a crash writes nothing twice) and returns what the reduction needs. */
  async #apply(by: Principal, recordId: string, b: FloorBody, rec: RecordBody, unit: Inflight, reply: StoredReply): Promise<Record<string, unknown>> {
    const fx: Record<string, unknown> = {};
    const item = reply.items[0];
    const chair = rec.chair;
    const notice = async (kind: string, text: string): Promise<void> => { await this.#deps.notifyOwner?.({ recordId, projectId: b.projectId, kind, text }).catch(() => undefined); };
    const statementOf = async (key: string, it: StoredReply["items"][number], label?: string): Promise<{ entryId: string; parsed: ReturnType<typeof parseStatement> } | undefined> => {
      if (it.noResponse !== undefined || it.text.trim() === "") return undefined;
      const parsed = parseStatement(it.text);
      const entryId = await this.#say(recordId, unit, key, it.agent, label === undefined ? parsed.text : `${label}${parsed.text}`);
      return { entryId, parsed };
    };
    try {
      switch (unit.kind) {
        case "direct-skip": {
          const q = b.queue.find((x) => x.id === unit.queueId);
          if (q?.target === undefined) break;
          fx["entryId"] = await this.#say(recordId, unit, "skip", chair ?? q.from ?? q.target, `${q.from ?? "A member"}'s question to ${q.target} is skipped: absent (recorded).`);
          break;
        }
        case "direct-answer": case "direct-continue": case "chair-answer": case "reply": {
          const q = b.queue.find((x) => x.id === unit.queueId);
          // A member's question to another is written now, just before the answer (the member's own statement was written by the procedure when it spoke).
          if (unit.kind === "direct-answer" && q?.from !== undefined && q.question !== undefined) await this.#say(recordId, unit, "q", q.from, `To ${item!.agent}: ${recordText(q.question, 500)}`);
          const s = await statementOf("s", item!);
          if (s !== undefined) fx["statements"] = { [item!.agent]: s };
          break;
        }
        case "owner-ask": {
          const q = b.queue.find((x) => x.id === unit.queueId);
          if (q === undefined) break;
          if (item!.noResponse !== undefined) { await notice("owner-answer-blocked", `${item!.agent} could not answer the owner's question: ${item!.noResponse}`); break; }
          let text: string;
          const completed: string[] = []; const proposed: string[] = []; const stale: string[] = []; const invest: string[] = [];
          if (q.checkpoint === true) {
            const cp = await this.#deps.checkpointOf?.(item!.agent, recordId).catch(() => undefined);
            text = wrapCheckpointAnswer(item!.agent, cp?.savedAt ?? "an unknown time", item!.text);
            fx["checkpoint"] = cp?.savedAt ?? "unknown";
          } else {
            const pick = (re: RegExp): string | undefined => { const m = re.exec(item!.text)?.[1]?.trim(); return m === undefined || /^none\.?$/i.test(m) ? undefined : m; };
            const answer = pick(/ANSWER:\s*([\s\S]*?)(?:\n\s*(?:SOURCES|COMPLETED|PROPOSED|INVESTIGATE):|$)/i) ?? item!.text;
            for (const s of (pick(/SOURCES:\s*(.*)$/im) ?? "").split(",").map((x) => x.trim()).filter((x) => x !== "")) {
              const m = /^([a-z-]+):([\w-]+)(?:@(\d+))?$/.exec(s);
              if (m === null || m[3] === undefined) continue;
              const now = await this.#deps.sourceRevision?.({ kind: m[1]!, id: m[2]! }).catch(() => undefined);
              if (now !== undefined && now !== Number(m[3])) stale.push(`${s} (now at revision ${now})`);
            }
            const lines = (text: string | undefined): string[] => (text === undefined ? [] : text.split(/;|\n/).map((x) => x.trim()).filter((x) => x !== ""));
            completed.push(...lines(pick(/COMPLETED:\s*([\s\S]*?)(?:\n\s*(?:SOURCES|PROPOSED|INVESTIGATE):|$)/i)));
            proposed.push(...lines(pick(/PROPOSED:\s*([\s\S]*?)(?:\n\s*(?:SOURCES|COMPLETED|INVESTIGATE):|$)/i)));
            const inv = pick(/INVESTIGATE:\s*([\s\S]*?)$/i);
            if (inv !== undefined) invest.push(inv);
            text = [answer, completed.length === 0 ? "" : `Done: ${completed.join("; ")}`, proposed.length === 0 ? "" : `Proposed, not done: ${proposed.join("; ")}`, stale.length === 0 ? "" : `Stale sources (changed since the agent looked): ${stale.join("; ")}`, invest.length === 0 ? "" : `Needs deeper work than this meeting (follow-up): ${invest.join("; ")}`].filter((x) => x !== "").join("\n");
          }
          // held while any vote of the meeting is open, the floor's own or one the meeting procedure (card M06) or the record runs
          const holding = (await this.#votingMotion(rec)) !== undefined;
          fx["held"] = holding;
          fx["text"] = recordText(text, FLOOR_LIMITS.text);
          fx["completed"] = completed; fx["proposed"] = proposed; fx["stale"] = stale; fx["invest"] = invest;
          // During an open vote the answer goes to the owner at once (the floor view) and into the transcript only when the vote closes.
          fx["entryId"] = holding ? undefined : await this.#say(recordId, unit, "a", item!.agent, `(to the owner) ${recordText(text, FLOOR_LIMITS.text - 20)}`);
          if (holding) await notice("held-answer", `${item!.agent}'s answer to your question is kept out of the other voters' view until the vote closes.`);
          break;
        }
        case "chair-notes": break;
        case "chair-questions": {
          const parsed = parseJsonObject(item!.text);
          const qs = Array.isArray(parsed?.["questions"]) ? (parsed!["questions"] as unknown[]) : [];
          const left = Math.max(0, b.settings.chairQuestionCap - b.chairQuestionsAsked);
          const made: ChairQuestionRecord[] = [];
          const refused: string[] = [];
          for (const raw of qs.slice(0, left)) {
            const why = chairQuestionRefusal(raw);
            const o = raw as Record<string, string>;
            if (why !== undefined || !rec.roster.includes(o["to"]!)) { refused.push(why ?? `${o["to"]} is not on the roster`); continue; }
            const id = `cq${b.chairQuestions.length + made.length + 1}`;
            const present = this.#present(rec).includes(o["to"]!);
            const entryId = chair === undefined ? undefined : await this.#say(recordId, unit, id, chair, present ? `Question to ${o["to"]}: ${recordText(o["topic"]!, 300)} (${recordText(o["experience_sought"]!, 300)})` : `Question to ${o["to"]} skipped: absent (recorded).`);
            made.push({ id, to: o["to"]!, topic: recordText(o["topic"]!, 300), experienceSought: recordText(o["experience_sought"]!, 300), askedBy: "chair", why: `fact-finding question after comment round ${b.between?.round ?? 1}`, round: b.between?.round ?? 1, state: present ? "asked" : "skipped", ...(entryId === undefined ? {} : { entryId }) });
          }
          fx["questions"] = made; fx["refused"] = refused;
          break;
        }
        case "desk-offer": {
          const offered = JSON.parse(reply.items[0]!.text) as { id: string; owner: string; title: string; visibility: "shared" | "private" }[];
          fx["offered"] = offered;
          const picks = reply.items[1] === undefined ? undefined : parseJsonObject(reply.items[1].text);
          const want = Array.isArray(picks?.["read"]) ? (picks!["read"] as unknown[]).filter((x): x is string => typeof x === "string").slice(0, FLOOR_LIMITS.deskRead) : [];
          const chairP = chair === undefined ? undefined : await this.#voterPrincipal(chair);
          const read: string[] = []; const refused: { id: string; why: string }[] = []; const pending: { id: string; owner: string; title: string; text: string }[] = [];
          for (const id of [...new Set(want)]) {
            const o = offered.find((x) => x.id === id);
            if (o === undefined || !DESK_ID.test(id)) { refused.push({ id: String(id).slice(0, 40), why: "not a file the controller offered" }); continue; }
            if (chairP === undefined || this.#deps.deskReads === undefined) { refused.push({ id, why: "the chair cannot read" }); continue; }
            try {
              const r = await this.#deps.deskReads.read(chairP, { commandId: `fl-${base(recordId)}-${unit.id}-r-${id.slice(4, 14)}`, meetingRecordId: recordId, deskRecordId: id });
              if (r.record === undefined) { refused.push({ id, why: "already read in an earlier attempt; the text is not returned twice" }); continue; }
              read.push(id);
              pending.push({ id, owner: o.owner, title: o.title, text: recordText(r.record.body, 3000) });
            } catch (error) { refused.push({ id, why: error instanceof DomainError ? error.code : "failed" }); }
          }
          fx["read"] = read; fx["refused"] = refused; fx["pending"] = pending;
          break;
        }
        case "desk-excerpts": {
          const parsed = parseJsonObject(item!.text);
          const ex = Array.isArray(parsed?.["excerpts"]) ? (parsed!["excerpts"] as Record<string, unknown>[]).slice(0, 3) : [];
          const quoted: string[] = []; let rejected = 0;
          let n = 0;
          for (const e of ex) {
            const f = b.desk.pending.find((x) => x.id === e["file"]);
            if (f === undefined || !quoteOccurs(e["quote"], f.text)) { rejected += 1; continue; }
            if (chair !== undefined) await this.#say(recordId, unit, `x${n}`, chair, `[From ${f.owner}'s desk, read by the chair read-only, file ${f.title} (${f.id}), UNVERIFIED by ${f.owner}] "${recordText(String(e["quote"]), 400)}"${typeof e["bears_on"] === "string" ? ` (${recordText(e["bears_on"], 200)})` : ""}`);
            n += 1;
            if (!quoted.includes(f.id)) quoted.push(f.id);
          }
          if (chair !== undefined) await this.#say(recordId, unit, "list", chair, `Desk read: files read ${b.desk.filesRead.join(", ") || "none"}; files quoted ${quoted.join(", ") || "none"}.`);
          fx["quoted"] = quoted; fx["rejected"] = rejected;
          break;
        }
        case "correction": {
          const m = /CORRECTION:\s*([\s\S]*?)(?:\n\s*CONTRADICTS:|$)/i.exec(item!.text)?.[1]?.trim();
          if (item!.noResponse !== undefined || m === undefined || /^none\.?$/i.test(m)) break;
          fx["entryId"] = await this.#say(recordId, unit, "c", item!.agent, `(correction by the returning member) ${m}`);
          if (/CONTRADICTS:\s*yes/i.test(item!.text) && (await this.#votingMotion(rec)) !== undefined) await notice("correction-during-vote", `${item!.agent}'s correction contradicts what the chair relayed from its desk while the vote is open.`);
          break;
        }
        case "chair-summary": case "chair-reminders": {
          const parsed = parseJsonObject(item!.text);
          const key = unit.kind === "chair-summary" ? "points" : "reminders";
          const list = Array.isArray(parsed?.[key]) ? (parsed![key] as Record<string, unknown>[]).slice(0, unit.kind === "chair-summary" ? b.settings.chairSummaryPoints : b.settings.chairReminders) : [];
          const full = (await this.#transcript(recordId, b, rec, true)).entries;
          const lines: string[] = [];
          for (const p of list) {
            if (unit.kind === "chair-summary") {
              const who = (Array.isArray(p["speakers"]) ? p["speakers"] as unknown[] : []).filter((x): x is string => typeof x === "string" && rec.roster.includes(x));
              let ok = typeof p["point"] === "string" && p["point"] !== "" && who.length > 0;
              if (ok && p["kind"] === "omitted") ok = who.some((w) => full.some((e) => e.who === w && quoteOccurs(p["quote"], e.text)));
              if (ok) lines.push(`- (${String(p["kind"] ?? "point")}; ${who.join(", ")}) ${recordText(String(p["point"]), 400)}${p["kind"] === "omitted" ? ` — from the full statement: "${recordText(String(p["quote"]), 300)}"` : ""}`);
            } else if (typeof p["from"] === "string" && full.some((e) => e.who === p["from"] && quoteOccurs(p["quote"], e.text))) lines.push(`Reminder from ${p["from"]}'s full statement: "${recordText(String(p["quote"]), 300)}"`);
          }
          if (lines.length > 0 && chair !== undefined) await this.#say(recordId, unit, "l", chair, unit.kind === "chair-summary" ? `Chair's summary of round ${b.between?.round ?? 1}:\n${lines.join("\n")}` : lines.join("\n"));
          fx["lines"] = lines.length;
          fx["summary"] = unit.kind === "chair-summary" && lines.length > 0 ? lines.join("\n") : undefined;
          break;
        }
        case "wrap-up": {
          const reason = this.#timeboxed(b, this.#runner.now()) ?? "time";
          const m = await this.#activeMotion(rec, false);
          if (m?.state === "proposed") { await this.#deps.records.table(this.#deps.service, { commandId: `fl-${base(recordId)}-${unit.id}-tb`, motionId: m.id, reason: `the meeting's ${reason === "time" ? "time" : "model-spend"} timebox ended before the vote; the rest is follow-up work` }); fx["tabled"] = true; }
          fx["reason"] = reason;
          await notice("timebox", `The meeting's ${reason === "time" ? "time" : "model-spend"} timebox is used up.`);
          break;
        }
        default: break;
      }
    } catch (error) {
      if (error instanceof Wait) throw error;
      throw error;
    }
    void by;
    return fx;
  }

  // ---- the floor after a unit ------------------------------------------------------------------------------------------------------------

  /** The steps between rounds, in the order the experiments found useful: the chair's notes once, its questions, the desk read (absent members only) and its summary; reminders once summaries are used. */
  #betweenSteps(b: FloorBody, rec: RecordBody, round: number, fresh: number): string[] {
    if (rec.chair === undefined) return [];
    const first = round === 1 && fresh === 0;
    const steps: string[] = [];
    if (first && b.settings.chairNotes === "once") steps.push("chair-notes");
    if (b.settings.chairQuestionCap - b.chairQuestionsAsked > 0) steps.push("chair-questions");
    if (first && this.#absent(rec).length > 0 && this.#deps.deskReads !== undefined) steps.push("desk-offer");
    if (first) steps.push("chair-summary");
    else if (usesFacts(b.settings.transcriptMode, this.#present(rec).length, b.settings.factsAboveMembers) && b.settings.chairReminders > 0) steps.push("chair-reminders");
    return steps;
  }

  /** What every unit leaves on the floor, whatever it did: its spend, its turn log, its no-response notices; the claim cleared. */
  #account(b: FloorBody, unit: Inflight, reply: StoredReply): FloorBody {
    const kindOf: Record<UnitKind, TurnLog["kind"]> = {
      "direct-answer": "direct-answer", "direct-continue": "direct-continue", "direct-skip": "direct-answer", "chair-answer": "chair-answer", reply: "reply", "owner-ask": "owner-answer",
      "chair-notes": "chair-notes", "chair-questions": "chair-questions", "desk-offer": "desk-offer", "desk-excerpts": "desk-excerpts", correction: "correction", "chair-summary": "chair-summary", "chair-reminders": "chair-reminders", "wrap-up": "chair-ruling",
    };
    return { ...this.#spent(b, unit.id, kindOf[unit.kind], reply.items, reply.costUsd, unit.owner === true, unit.kind), inflight: undefined, waitingTool: undefined };
  }

  /** The spend and the turn log of answered calls: the owner's own questions are recorded apart so they never count against the meeting's timebox. */
  #spent(b: FloorBody, unitId: string, kind: TurnLog["kind"], items: readonly PortReply[], costUsd: number, owner: boolean, label: string): FloorBody {
    const now = this.#runner.now();
    let usd = b.spend.usd, tokens = b.spend.tokens, hidden = b.spend.hiddenTokens, ownerUsd = b.spend.ownerUsd, ownerTokens = b.spend.ownerTokens, calls = b.spend.calls;
    const logs: TurnLog[] = [];
    let deliveries = b.deliveries;
    const share = items.length === 0 ? 0 : costUsd / items.length;
    for (const it of items) {
      if (it.usage.visible === 0 && it.usage.hidden === 0 && it.usage.input === 0 && it.noResponse === undefined) continue;
      const t = it.usage.input + it.usage.visible + it.usage.hidden;
      if (owner) { ownerUsd += share; ownerTokens += t; } else { usd += share; tokens += t; }
      hidden += it.usage.hidden; calls += 1;
      if (it.deliveredUpTo >= 0) deliveries += 1;
      logs.push({ unit: unitId, kind, agent: it.agent, at: now, visibleTokens: it.usage.visible, hiddenTokens: it.usage.hidden, deliveredUpTo: it.deliveredUpTo, ...(it.truncated === true ? { truncated: true as const } : {}), ...(it.hiddenOver === true ? { hiddenOver: true as const } : {}), ...(it.noResponse === undefined ? {} : { noResponse: it.noResponse }) });
    }
    const notices: { at: string; kind: string; text: string }[] = [];
    for (const it of items) if (it.noResponse !== undefined) notices.push({ at: now, kind: "no-response", text: `${it.agent} gave no answer (${it.noResponse}) in ${label}` });
    return { ...b, spend: { ...b.spend, usd, tokens, hiddenTokens: hidden, ownerUsd, ownerTokens, calls }, turns: [...b.turns, ...logs], deliveries, notices: [...b.notices, ...notices] };
  }

  /** The between-rounds list after the step `kind` ran: its entry is taken off, and the chair's summary is kept for the objection check. */
  #popBetween(n: FloorBody, kind: string, summary?: string): FloorBody {
    const t = n.between;
    if (t === undefined || t.todo[0] !== kind) return n;
    return { ...n, between: { ...t, todo: t.todo.slice(1), ...(summary === undefined ? {} : { summary }) } };
  }

  #reduce(b: FloorBody, rec: RecordBody, unit: Inflight, reply: StoredReply, fx: Record<string, unknown>): FloorBody {
    const now = this.#runner.now();
    let n: FloorBody = this.#account(b, unit, reply);
    const dropQueue = (): FloorBody => ({ ...n, queue: n.queue.filter((q) => q.id !== unit.queueId) });
    const statements = (fx["statements"] ?? {}) as Record<string, { entryId: string; parsed: ReturnType<typeof parseStatement> }>;
    const withStatement = (base0: FloorBody): FloorBody => {
      let r = base0;
      for (const [agent, s] of Object.entries(statements)) if (s.parsed.summary !== undefined) r = { ...r, summaries: { ...r.summaries, [summaryKey(agent, recordText(s.parsed.text, FLOOR_LIMITS.text))]: s.parsed.summary } };
      return r;
    };
    switch (unit.kind) {
      case "direct-answer": case "direct-continue": case "chair-answer": case "reply": {
        n = withStatement(dropQueue());
        if (unit.kind === "chair-answer") n = { ...n, chairQuestions: n.chairQuestions.map((c) => (c.id === b.queue.find((x) => x.id === unit.queueId)?.chairQuestionId ? { ...c, state: "answered" as const, ...(statements[unit.agent!] === undefined ? {} : { answerEntryId: statements[unit.agent!]!.entryId }) } : c)) };
        return n;
      }
      case "direct-skip": {
        const q = b.queue.find((x) => x.id === unit.queueId);
        n = dropQueue();
        return q?.target === undefined ? n : { ...n, skipped: [...n.skipped, { agent: q.target, why: `a direct question from ${q.from ?? "a member"} was skipped: absent`, at: now }] };
      }
      case "owner-ask": {
        const q = b.queue.find((x) => x.id === unit.queueId);
        n = dropQueue();
        if (q === undefined || reply.items[0]?.noResponse !== undefined) return n;
        const rec0 = { entryId: q.entryId ?? "held", answerEntryId: fx["entryId"] as string | undefined, agent: q.agent, question: recordText(q.question ?? "", 500), completed: (fx["completed"] as string[] | undefined) ?? [], proposed: (fx["proposed"] as string[] | undefined) ?? [], stale: (fx["stale"] as string[] | undefined) ?? [], ...(typeof fx["checkpoint"] === "string" ? { checkpoint: fx["checkpoint"] } : {}), ...(fx["held"] === true ? { held: true as const } : {}) };
        n = { ...n, ownerAnswers: [...n.ownerAnswers, rec0] };
        if (fx["held"] === true) n = { ...n, held: [...n.held, { agent: q.agent, text: (fx["text"] as string) ?? "", at: now, question: recordText(q.question ?? "", 500) }] };
        const inv = (fx["invest"] as string[] | undefined) ?? [];
        if (inv.length > 0) n = { ...n, investigations: [...n.investigations, ...inv.map((text) => ({ text: recordText(text, 300), by: q.agent, ...(typeof fx["entryId"] === "string" ? { entryId: fx["entryId"] as string } : {}) }))] };
        if (n.inquiry !== undefined) n = { ...n, inquiry: { ...n.inquiry, lastActivityAt: now, questions: n.inquiry.questions + 1, addressed: [...new Set([...n.inquiry.addressed, q.agent])], remindedAt: undefined } };
        return n;
      }
      case "chair-notes": {
        n = unit.queueId === undefined ? n : dropQueue();
        const text = reply.items[0]?.noResponse === undefined ? recordText(reply.items[0]!.text, 3000) : undefined;
        n = this.#popBetween(n, "chair-notes");
        return { ...n, ...(text === undefined ? {} : { chairNotes: text, chairNotesAt: now, chairNotesCount: n.chairNotesCount + 1 }) };
      }
      case "chair-questions": {
        const made = (fx["questions"] as ChairQuestionRecord[] | undefined) ?? [];
        const queue = [...n.queue];
        for (const c of made) if (c.state === "asked") queue.push({ id: `cqa-${c.id}`, kind: "chair-answer", agent: c.to, chairQuestionId: c.id });
        const t = n.between;
        if (made.length > 0 && t !== undefined && t.round >= t.rounds && t.fresh === 0) for (const a of this.#present(rec)) queue.push({ id: `rp-${n.unitSeq}-${a.slice(-8)}`, kind: "reply", agent: a });
        n = this.#popBetween(n, "chair-questions");
        return { ...n, notices: [...n.notices, ...((fx["refused"] as string[] | undefined) ?? []).map((text) => ({ at: now, kind: "chair-question-refused", text: recordText(text, 200) }))], chairQuestions: [...n.chairQuestions, ...made], chairQuestionsAsked: n.chairQuestionsAsked + made.length, queue, skipped: [...n.skipped, ...made.filter((c) => c.state === "skipped").map((c) => ({ agent: c.to, why: "a chair question was skipped: absent", at: now }))] };
      }
      case "desk-offer": {
        const read = (fx["read"] as string[] | undefined) ?? [];
        const pending = (fx["pending"] as FloorBody["desk"]["pending"] | undefined) ?? [];
        n = this.#popBetween(n, "desk-offer");
        n = { ...n, desk: { ...n.desk, offered: (fx["offered"] as FloorBody["desk"]["offered"] | undefined) ?? [], filesRead: [...n.desk.filesRead, ...read], refused: [...n.desk.refused, ...((fx["refused"] as { id: string; why: string }[] | undefined) ?? [])], pending, readOwners: [...new Set([...n.desk.readOwners, ...pending.map((p) => p.owner)])] } };
        if (pending.length > 0 && n.between !== undefined) n = { ...n, between: { ...n.between, todo: ["desk-excerpts", ...n.between.todo] } };
        return n;
      }
      case "desk-excerpts": {
        n = this.#popBetween(n, "desk-excerpts");
        return { ...n, desk: { ...n.desk, filesQuoted: [...new Set([...n.desk.filesQuoted, ...((fx["quoted"] as string[] | undefined) ?? [])])], rejectedExcerpts: n.desk.rejectedExcerpts + ((fx["rejected"] as number | undefined) ?? 0), pending: [] } };
      }
      case "correction": return { ...n, desk: { ...n.desk, corrections: [...n.desk.corrections, { member: unit.agent!, entryId: (fx["entryId"] as string | undefined) ?? "none" }] } };
      case "chair-summary": return this.#popBetween(n, "chair-summary", typeof fx["summary"] === "string" ? (fx["summary"] as string) : undefined);
      case "chair-reminders": return this.#popBetween(n, "chair-reminders");
      case "wrap-up": {
        const reason = ((fx["reason"] as string | undefined) ?? "time") as "time" | "spend";
        return { ...n, timebox: { reason, at: now }, queue: n.queue.filter((q) => q.kind === "owner-ask") };
      }
      default: return n;
    }
  }

  // ---- the owner's controls (owner only: the chair, a member or a manager cannot use them, and nothing the chair does can stop them) -----

  async #open(recordId: unknown): Promise<{ recordId: string; rec: View<RecordBody> }> {
    const id = typeof recordId === "string" && RECORD_ID.test(recordId) ? recordId : invalid("recordId", "is not a meeting record ID");
    const rec = await this.#meeting(id);
    if (rec.state !== "open") throw new DomainError("invalid_command", `the meeting is ${rec.state}`, { field: "recordId" });
    return { recordId: id, rec };
  }

  async #ownerMessage(owner: Principal, recordId: string, commandId: string, text: string): Promise<{ id: string; seq: number }> {
    const r = await this.#deps.records.append(owner, { commandId, recordId, kind: "owner-message", text: recordText(text, FLOOR_LIMITS.text) });
    return { id: r.id, seq: r.seq };
  }

  /** A note of the owner's control (an inquiry opened or ended, priorities changed): written as the owner's ruling, not an owner message, so it is not a reason to offer any voter a revision turn. */
  async #ownerNote(owner: Principal, recordId: string, commandId: string, text: string): Promise<{ id: string; seq: number }> {
    const r = await this.#deps.records.append(owner, { commandId, recordId, kind: "ruling", text: recordText(text, FLOOR_LIMITS.text) });
    return { id: r.id, seq: r.seq };
  }

  /**
   * The owner's words go to everyone who has the floor after them. While a vote is open, words that repeat a cast ballot's reason would hand that ballot to the other voters, so they are refused with a warning until sent again with
   * `acknowledged` true: the same check as the meeting procedure's owner message (card M06), on whichever vote of the meeting is open.
   */
  async #ballotEcho(rec: RecordBody, text: string, acknowledged: unknown): Promise<void> {
    if (acknowledged !== undefined && typeof acknowledged !== "boolean") invalid("acknowledged", "is true or false");
    const voting = await this.#votingMotion(rec);
    if (voting === undefined || acknowledged === true) return;
    for (const voter of rec.roster) {
      const ballot = (await this.#runner.get("meeting-ballot", derivedId("mbl", `${voting.id}:${voter}`)))?.body as unknown as BallotBody | undefined;
      if (ballot !== undefined && quotesBallot(text, ballot.reason)) {
        throw new DomainError("invalid_command", `These words repeat the reason of ${voter}'s ballot while the vote on motion ${voting.number} is open. Everyone who speaks after them will see those words, so ballots stop being private. Send them again with acknowledged true if that is what you want.`, { field: "acknowledged" });
      }
    }
  }

  /**
   * The owner asks one agent a question. It goes into the transcript as the owner's message; the agent is given the floor at the next safe boundary (after the turn being answered, which is not undone) and answers; the answer is in the
   * transcript at once, or - while a vote is open - held and shown to the owner only until the vote closes. A voter who cast before the question is offered one short revision turn. A member who is not in the room is answered from its
   * saved checkpoint, stamped as not live; nobody outside the roster is ever brought in. The meeting's turn limit and timebox do not apply; the spend is recorded, and a budget that is reached is reported to the owner.
   */
  async ask(by: Principal, command: NoActor & { recordId: string; agent: string; question: string; acknowledged?: boolean }): Promise<{ entryId: string; answered: boolean; queued: boolean; checkpoint?: true; blocked?: string }> {
    onlyKnown(command, ["commandId", "recordId", "agent", "question", "acknowledged"]);
    this.#ownerOnly(by, "ask a meeting member a question");
    const { recordId, rec } = await this.#open(command.recordId);
    const agent = typeof command.agent === "string" && AGENT.test(command.agent) ? command.agent : invalid("agent", "is not an agent");
    const question = typeof command.question === "string" && command.question.trim() !== "" ? recordText(command.question, 1500) : invalid("question", "must say what to ask");
    const f = await this.#need(recordId);
    const present = this.#present(rec).includes(agent) || agent === rec.chair;
    if (!rec.roster.includes(agent) && agent !== rec.chair) invalid("agent", "is not in this meeting's roster; nobody outside the roster is brought in");
    const checkpoint = !present;
    if (checkpoint && (!f.body.settings.checkpointAnswers || this.#deps.checkpointOf === undefined)) throw new DomainError("invalid_command", `${agent} is not in the room, and answers from checkpoints are off`, { field: "agent" });
    await this.#ballotEcho(rec, question, command.acknowledged);
    const msg = await this.#ownerMessage(by, recordId, `fl-ask-${base(recordId)}-${hash(by.id, command.commandId)}`, `Question to ${agent}: ${question}`);
    if (f.body.ownerAnswers.some((a) => a.entryId === msg.id)) return { entryId: msg.id, answered: true, queued: false, ...(checkpoint ? { checkpoint: true as const } : {}) };
    const now = this.#runner.now();
    const item: QueueItem = { id: `oa-${hash(by.id, command.commandId)}`, kind: "owner-ask", agent, entryId: msg.id, question, ...(checkpoint ? { checkpoint: true as const } : {}) };
    await this.#update(recordId, by, `ask-${item.id}`, (b) => (b.queue.some((q) => q.id === item.id) ? undefined : { ...b, queue: [...b.queue, item], ...(b.inquiry === undefined ? {} : { inquiry: { ...b.inquiry, lastActivityAt: now, messages: [...b.inquiry.messages, msg.id].slice(-50), addressed: [...new Set([...b.inquiry.addressed, agent])], remindedAt: undefined } }) }));
    if (f.body.inquiry !== undefined && !checkpoint) await this.#deps.work?.recall(recordId, agent).catch(() => undefined);
    // at a safe boundary: now, when no turn is being answered; otherwise the next advance takes it first
    // A unit that was claimed before the question is finished (or set aside, when an inquiry now holds the vote) first; then the question runs.
    for (let i = 0; i < 3; i += 1) {
      const r = await this.#advance(by, recordId, rec, true).catch(() => undefined);
      if (r === undefined || ("did" in r && r.did === "owner-ask") || (r.waiting !== undefined && r.waiting !== "owner" && r.waiting !== "vote-time")) break;
      if ((await this.#need(recordId)).body.ownerAnswers.some((a) => a.entryId === msg.id)) break;
    }
    const after = await this.#need(recordId);
    const answered = after.body.ownerAnswers.some((a) => a.entryId === msg.id);
    const queued = after.body.queue.some((q) => q.id === item.id);
    const blocked = !answered && !queued ? after.body.notices.at(-1)?.text : undefined;
    return { entryId: msg.id, answered, queued, ...(checkpoint ? { checkpoint: true as const } : {}), ...(blocked === undefined ? {} : { blocked }) };
  }

  /**
   * The owner speaks to the whole meeting. The words go into the transcript; nobody is given the floor by it (the baton rule): each member receives them with the floor it is next given, a voter who has not yet cast with its
   * ballot request, and a voter who cast before is offered one revision turn. With `agent` that agent is given the floor to answer (as `ask`). With `amend` the owner's words materially amend the motion: a fresh round and a fresh vote follow
   * and no revision is offered (an owner alternative to the decision itself is a separate record, not a ballot).
   */
  async address(by: Principal, command: NoActor & { recordId: string; text: string; agent?: string; amend?: { text: string }; acknowledged?: boolean }): Promise<{ entryId: string; restarted?: true; revisionsOffered: number }> {
    onlyKnown(command, ["commandId", "recordId", "text", "agent", "amend", "acknowledged"]);
    this.#ownerOnly(by, "address the meeting");
    const { recordId, rec } = await this.#open(command.recordId);
    const text = typeof command.text === "string" && command.text.trim() !== "" ? recordText(command.text, 3000) : invalid("text", "must say something");
    if (command.agent !== undefined) {
      const r = await this.ask(by, { commandId: command.commandId, recordId, agent: command.agent, question: text, ...(command.acknowledged === undefined ? {} : { acknowledged: command.acknowledged }) });
      return { entryId: r.entryId, revisionsOffered: 0 };
    }
    const f = await this.#need(recordId);
    await this.#ballotEcho(rec, text, command.acknowledged);
    const msg = await this.#ownerMessage(by, recordId, `fl-adr-${base(recordId)}-${hash(by.id, command.commandId)}`, text);
    if (command.amend !== undefined) {
      const amendText = typeof command.amend.text === "string" && command.amend.text.trim() !== "" ? recordText(command.amend.text, 3000) : invalid("amend", "needs the new wording");
      const m = await this.#activeMotion(rec, false);
      if (m === undefined) invalid("amend", "there is no motion under way");
      // The record's own amendment: the procedure sees the new version at its next step and begins a fresh pass (one comment round, a fresh objection check and a fresh vote); a held vote is back to proposed.
      await this.#deps.records.amend(this.#deps.service, { commandId: `fl-am-${base(recordId)}-${hash(by.id, command.commandId)}`, motionId: m!.id, expectedVersion: m!.version, text: amendText, material: true });
      // The procedure notices the new version at its next step and begins the fresh pass; one step now, so the owner's call shows it (no member is asked).
      await this.#deps.procedure?.()?.advance(this.#deps.service, { motionId: m!.id });
      return { entryId: msg.id, restarted: true, revisionsOffered: 0 };
    }
    // Each voter who cast before these words is offered a revision turn by the procedure (one per owner message, up to the owner's maximum), once the vote is not held.
    if (f.body.inquiry !== undefined) await this.#update(recordId, by, `inq-msg-${msg.id}`, (b) => (b.inquiry === undefined ? undefined : { ...b, inquiry: { ...b.inquiry, lastActivityAt: this.#runner.now(), messages: [...b.inquiry.messages, msg.id].slice(-50), remindedAt: undefined } }));
    return { entryId: msg.id, revisionsOffered: 0 };
  }

  /**
   * The owner opens an inquiry period: the meeting's clock and turn limits stop, nothing but the owner's own questions advances (no comment round, no objection check, no vote opens), an open vote is held (its roster, quorum and
   * recorded ballots stay, and none can be cast or revised) with its own time limit paused, and participants the owner has not addressed may go back to work. Heartbeats and attempt timeouts of the attending agents keep running; only
   * the meeting's own clock stops. The period survives a restart. After the owner's idle time a reminder is sent and the open inquiry shows as a Needs-you item (`ownerPending`).
   */
  async openInquiry(by: Principal, command: NoActor & { recordId: string }): Promise<{ voteHeld: boolean; replayed: boolean }> {
    onlyKnown(command, ["commandId", "recordId"]);
    this.#ownerOnly(by, "open an inquiry");
    const { recordId, rec } = await this.#open(command.recordId);
    const f = await this.#need(recordId);
    if (f.body.inquiry !== undefined) return { voteHeld: f.body.inquiry.voteHeld, replayed: true };
    // The vote open on the record is held, whoever runs it (the floor, the meeting procedure of card M06, or the record itself); one a crash already held is not held twice.
    const voting = await this.#votingMotion(rec);
    const open = voting !== undefined && voting.state === "voting";
    if (open && voting.heldAt === undefined) await this.#deps.records.hold(this.#deps.service, { commandId: `fl-hold-${base(recordId)}-${hash(by.id, command.commandId)}`, motionId: voting.id });
    const msg = await this.#ownerNote(by, recordId, `fl-inq-${base(recordId)}-${hash(by.id, command.commandId)}`, `The owner opens an inquiry: the meeting clock and turn limits stop${open ? " and the vote is held" : ""} until the owner ends it.`);
    const now = this.#runner.now();
    await this.#update(recordId, by, `inq-open-${msg.id}`, (b) => (b.inquiry !== undefined ? undefined : { ...b, clock: { ...b.clock, pausedAt: now }, inquiry: { openedAt: now, lastActivityAt: now, questions: 0, voteHeld: open, ...(open ? { heldMotionId: voting.id } : {}), addressed: [], messages: [msg.id] } }));
    await this.#deps.work?.release(recordId, this.#present(rec)).catch(() => undefined);
    await this.#deps.notifyOwner?.({ recordId, projectId: rec.projectId, kind: "inquiry-open", text: "An owner inquiry is open on a meeting; it waits for you to say you are done with questions." }).catch(() => undefined);
    return { voteHeld: open, replayed: false };
  }

  /** "Done with questions": the clock runs again, a held vote resumes where it stopped, each voter who cast before is offered one revision turn, and the meeting goes on where it left off. */
  async endInquiry(by: Principal, command: NoActor & { recordId: string }): Promise<{ revisionsOffered: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "recordId"]);
    this.#ownerOnly(by, "end an inquiry");
    const { recordId } = await this.#open(command.recordId);
    const f = await this.#need(recordId);
    const inq = f.body.inquiry;
    if (inq === undefined) return { revisionsOffered: 0, replayed: true };
    // answers still queued are answered first: the owner asked them
    for (let i = 0; i < 20; i += 1) { const r = await this.#advance(by, recordId, await this.#meeting(recordId), true).catch(() => undefined); if (r === undefined || "waiting" in r) break; }
    const heldId = inq.heldMotionId;
    const held = inq.voteHeld && heldId !== undefined ? ((await this.#deps.records.motion(this.#deps.service, heldId)) as unknown as MotionBody | undefined) : undefined;
    if (held !== undefined && held.state === "voting" && held.heldAt !== undefined) await this.#deps.records.resume(this.#deps.service, { commandId: `fl-resume-${base(recordId)}-${hash(by.id, command.commandId)}`, motionId: heldId! });
    const msg = await this.#ownerNote(by, recordId, `fl-end-${base(recordId)}-${hash(by.id, command.commandId)}`, "That is all my questions; carry on.");
    const now = this.#runner.now();
    await this.#update(recordId, by, `inq-end-${msg.id}`, (b) => (b.inquiry === undefined ? undefined : { ...b, inquiry: undefined, clock: { ...b.clock, pausedMs: b.clock.pausedMs + (b.clock.pausedAt === undefined ? 0 : Math.max(0, ms(now) - ms(b.clock.pausedAt))), pausedAt: undefined } }));
    void msg;
    await this.#deps.settleOwner?.({ recordId, projectId: f.body.projectId, kinds: ["inquiry-open", "inquiry-idle"] }).catch(() => undefined);
    return { revisionsOffered: 0, replayed: false };
  }

  /** The owner's priorities for the meeting: the agenda items it names are made urgent or normal (nonurgent ones that cannot be reached are batched to the next meeting by the timebox). Recorded as the owner's message. */
  async setPriorities(by: Principal, command: NoActor & { recordId: string; items: readonly { itemId: string; urgency: "urgent" | "normal" }[] }): Promise<{ changed: number }> {
    onlyKnown(command, ["commandId", "recordId", "items"]);
    this.#ownerOnly(by, "change the meeting's priorities");
    const { recordId } = await this.#open(command.recordId);
    if (!Array.isArray(command.items) || command.items.length === 0 || command.items.length > 20) invalid("items", "must list 1 to 20 agenda items");
    const items = command.items.map((i) => ({ itemId: typeof i?.itemId === "string" ? i.itemId : invalid("itemId", "is not an agenda item"), urgency: i.urgency === "urgent" || i.urgency === "normal" ? i.urgency : invalid("urgency", "must be urgent or normal") }));
    let changed = 0;
    for (const i of items) {
      const item = await this.#deps.meetings?.agendaItem(by, i.itemId);
      if (item === undefined) throw new DomainError("not_found", `no such agenda item ${i.itemId}`);
      if (item.urgency !== i.urgency) { await this.#deps.meetings!.correctAgendaItem(by, { commandId: `fl-pri-${base(recordId)}-${hash(command.commandId, i.itemId)}`, itemId: i.itemId, expectedRevision: item.revision, urgency: i.urgency }); changed += 1; }
    }
    await this.#ownerNote(by, recordId, `fl-pri-${base(recordId)}-${hash(by.id, command.commandId)}`, `The owner changes the priorities: ${items.map((i) => `${i.itemId} is ${i.urgency}`).join("; ")}.`);
    const now = this.#runner.now();
    await this.#update(recordId, by, `pri-${hash(command.commandId)}`, (b) => ({ ...b, priorities: [...b.priorities, ...items.map((i) => ({ itemId: i.itemId, urgency: i.urgency, at: now }))].slice(-40) }));
    return { changed };
  }

  /** More time or model spend for this meeting (the owner's decision; the inquiry never needs it). A wrap-up already done is not undone. */
  async extend(by: Principal, command: NoActor & { recordId: string; minutes?: number; usd?: number; tokens?: number }): Promise<void> {
    onlyKnown(command, ["commandId", "recordId", "minutes", "usd", "tokens"]);
    this.#ownerOnly(by, "extend the meeting's limits");
    const { recordId } = await this.#open(command.recordId);
    const minutes = command.minutes === undefined ? 0 : Number.isFinite(command.minutes) && command.minutes >= 0 && command.minutes <= 1440 ? command.minutes : invalid("minutes", "must be 0 to 1440");
    const usd = command.usd === undefined ? 0 : Number.isFinite(command.usd) && command.usd >= 0 && command.usd <= 1000 ? command.usd : invalid("usd", "must be 0 to 1000");
    const tokens = command.tokens === undefined ? 0 : Number.isSafeInteger(command.tokens) && command.tokens >= 0 && command.tokens <= 50_000_000 ? command.tokens : invalid("tokens", "must be 0 to 50000000");
    await this.#update(recordId, by, `extend-${hash(command.commandId)}`, (b) => {
      const n: FloorBody = { ...b, clock: { ...b.clock, extraMs: b.clock.extraMs + minutes * 60_000 }, spend: { ...b.spend, extraUsd: b.spend.extraUsd + usd, extraTokens: b.spend.extraTokens + tokens } };
      return b.timebox !== undefined && this.#timeboxed(n, this.#runner.now()) === undefined ? { ...n, timebox: undefined } : n;
    });
  }

  /** Changes this meeting's settings (the owner; the installation's defaults are the `meeting.floor.*` settings). Takes effect from the next unit. */
  async configure(by: Principal, command: NoActor & { recordId: string; set: Readonly<Record<string, unknown>> }): Promise<{ settings: FloorSettings }> {
    onlyKnown(command, ["commandId", "recordId", "set"]);
    this.#ownerOnly(by, "change the meeting's settings");
    const { recordId } = await this.#open(command.recordId);
    if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set) || Object.keys(command.set).length === 0) invalid("set", "must name the settings to change");
    const f = await this.#need(recordId);
    let next: FloorSettings;
    try { next = applyFloorChange(f.body.settings, command.set); } catch (e) { invalid("set", (e as Error).message); }
    const body = await this.#update(recordId, by, `cfg-${hash(command.commandId)}`, (b) => ({ ...b, settings: next! }));
    return { settings: body.settings };
  }

  /** The owner ends the meeting. A turn being answered finishes its own writes (nothing completed is undone) and nothing further is asked. The chair cannot stop this or any other owner command. */
  async end(by: Principal, command: NoActor & { recordId: string; reason?: string }): Promise<{ voided: string[] }> {
    onlyKnown(command, ["commandId", "recordId", "reason"]);
    this.#ownerOnly(by, "end the meeting");
    const { recordId } = await this.#open(command.recordId);
    const out = await this.#deps.records.finish(this.#deps.service, { commandId: `fl-end-${base(recordId)}-${hash(by.id, command.commandId)}`, recordId, ...(command.reason === undefined ? {} : { reason: recordText(command.reason, 400) }) });
    const now = this.#runner.now();
    await this.#update(recordId, by, "ended", (b) => (b.state === "ended" ? undefined : { ...b, state: "ended", endedAt: now, inquiry: undefined, inflight: undefined, clock: { ...b.clock, pausedAt: undefined } }));
    return out;
  }

  // ---- members and the chair -------------------------------------------------------------------------------------------------------------

  /**
   * A member asks the chair to put a fact-finding question to someone else (within the cap, and never while a vote is open). The same structural check applies: only a topic and the experience sought, and nothing about how anyone will vote.
   */
  async requestChairQuestion(by: Principal, command: NoActor & { recordId: string; to: string; topic: string; experienceSought: string }): Promise<{ questionId: string }> {
    onlyKnown(command, ["commandId", "recordId", "to", "topic", "experienceSought"]);
    const { recordId, rec } = await this.#open(command.recordId);
    if (!this.#member(by, rec)) throw forbidden(by, "ask the chair for a question");
    const f = await this.#need(recordId);
    if (rec.chair === undefined) throw new DomainError("invalid_command", "the meeting has no chair to put the question");
    if ((await this.#votingMotion(rec)) !== undefined) throw new DomainError("invalid_command", "chair questions are not put once the vote has opened", { field: "recordId" });
    if (f.body.chairQuestionsAsked >= f.body.settings.chairQuestionCap) throw new DomainError("invalid_command", `the cap of ${f.body.settings.chairQuestionCap} chair questions for this motion is used`, { field: "recordId" });
    const why = chairQuestionRefusal({ to: command.to, topic: command.topic, experience_sought: command.experienceSought });
    if (why !== undefined) invalid("topic", why);
    if (!rec.roster.includes(command.to)) invalid("to", "is not on this meeting's roster");
    const id = `cq${f.body.chairQuestions.length + 1}-${hash(by.id, command.commandId).slice(0, 6)}`;
    const present = this.#present(rec).includes(command.to);
    const entryId = await this.#deps.records.append(this.#deps.service, { commandId: `fl-rq-${base(recordId)}-${hash(by.id, command.commandId)}`, recordId, kind: "statement", speaker: rec.chair, text: present ? `Question to ${command.to}, at ${by.id}'s request: ${recordText(command.topic, 300)} (${recordText(command.experienceSought, 300)})` : `Question to ${command.to}, at ${by.id}'s request, skipped: absent (recorded).` });
    await this.#update(recordId, by, `rq-${id}`, (b) => {
      if (b.chairQuestions.some((c) => c.id === id) || b.chairQuestionsAsked >= b.settings.chairQuestionCap) return undefined;
      const q: ChairQuestionRecord = { id, to: command.to, topic: recordText(command.topic, 300), experienceSought: recordText(command.experienceSought, 300), askedBy: by.id, why: `asked of the chair by ${by.id}`, round: b.between?.round ?? 1, state: present ? "asked" : "skipped", entryId: entryId.id };
      return { ...b, chairQuestions: [...b.chairQuestions, q], chairQuestionsAsked: b.chairQuestionsAsked + 1, queue: present ? [...b.queue, { id: `cqa-${id}`, kind: "chair-answer", agent: command.to, chairQuestionId: id }] : b.queue };
    });
    return { questionId: id };
  }

  /** A member challenges a chair question as one that seeks a position (a procedural concern). The chair, or the owner, rules (`ruleOnChallenge`); until then the question stands. */
  async challengeQuestion(by: Principal, command: NoActor & { recordId: string; questionId: string; reason: string }): Promise<void> {
    onlyKnown(command, ["commandId", "recordId", "questionId", "reason"]);
    const { recordId, rec } = await this.#open(command.recordId);
    if (!this.#member(by, rec)) throw forbidden(by, "challenge a chair question");
    const reason = typeof command.reason === "string" && command.reason.trim() !== "" ? recordText(command.reason, 400) : invalid("reason", "must say why");
    const f = await this.#need(recordId);
    const q = f.body.chairQuestions.find((c) => c.id === command.questionId);
    if (q === undefined) throw new DomainError("not_found", "no such chair question");
    if (q.challenge !== undefined) throw new DomainError("invalid_command", "that question was already challenged", { field: "questionId" });
    await this.#deps.records.append(this.#deps.service, { commandId: `fl-ch-${base(recordId)}-${hash(by.id, command.commandId)}`, recordId, kind: "statement", speaker: by.id, text: `Procedural concern: the chair's question ${q.id} to ${q.to} seeks a position. ${reason}` });
    await this.#update(recordId, by, `challenge-${q.id}`, (b) => ({ ...b, chairQuestions: b.chairQuestions.map((c) => (c.id === q.id && c.challenge === undefined ? { ...c, challenge: { by: by.id, reason } } : c)) }));
  }

  /** The chair (or the owner, who can overrule it) rules on a challenge. An upheld challenge withdraws the question: it is not answered, and the answer already given stays in the record. */
  async ruleOnChallenge(by: Principal, command: NoActor & { recordId: string; questionId: string; ruling: "upheld" | "dismissed" }): Promise<void> {
    onlyKnown(command, ["commandId", "recordId", "questionId", "ruling"]);
    const { recordId, rec } = await this.#open(command.recordId);
    const isChair = by.kind === "agent" && by.asOf !== undefined && rec.chair === by.id && inTaskScope(by, rec.projectId);
    if (!(isChair || (by.kind === "owner" && by.taskScope === undefined))) throw forbidden(by, "rule on a challenge");
    if (command.ruling !== "upheld" && command.ruling !== "dismissed") invalid("ruling", "must be upheld or dismissed");
    const f = await this.#need(recordId);
    const q = f.body.chairQuestions.find((c) => c.id === command.questionId);
    if (q === undefined || q.challenge === undefined) throw new DomainError("not_found", "no such challenged chair question");
    await this.#deps.records.append(this.#deps.service, { commandId: `fl-rl-${base(recordId)}-${hash(by.id, command.commandId)}`, recordId, kind: "statement", speaker: rec.chair ?? by.id, text: `Ruling on the challenge to chair question ${q.id}: ${command.ruling}${by.kind === "owner" ? " (by the owner)" : ""}.` }).catch(async () => this.#ownerNote(by, recordId, `fl-rl-${base(recordId)}-${hash(by.id, command.commandId)}`, `Ruling on the challenge to chair question ${q.id}: ${command.ruling}.`));
    await this.#update(recordId, by, `rule-${q.id}-${command.ruling}`, (b) => ({
      ...b,
      chairQuestions: b.chairQuestions.map((c) => (c.id === q.id ? { ...c, challenge: { ...c.challenge!, ruling: command.ruling, ruledBy: by.id }, ...(command.ruling === "upheld" && c.state === "asked" ? { state: "withdrawn" as const } : {}) } : c)),
      queue: command.ruling === "upheld" ? b.queue.filter((x) => x.chairQuestionId !== q.id) : b.queue,
    }));
  }

  // ---- follow-up work, the Needs-you item and the lease --------------------------------------------------------------------------------

  /**
   * Turns what the meeting left open into owned follow-up tasks, once each: an unresolved question (a tagged question nobody answered, owned by whoever raised it), a chair question nobody answered, research asked for before
   * a tabling, and a question an agent said needs deeper work than the meeting (deep investigations become follow-up work, never meeting time). Nonurgent agenda items that were not reached are batched to the next meeting.
   */
  async followUps(by: Principal, command: { recordId: string }): Promise<{ created: { key: string; taskId: string; title: string; owner?: string }[]; deferred: string[] }> {
    const recordId = RECORD_ID.test(command.recordId) ? command.recordId : invalid("recordId", "is not a meeting record ID");
    const rec = await this.#meeting(recordId);
    if (!this.#controls(by, rec.projectId)) throw forbidden(by, "make follow-ups for that meeting");
    const f = await this.#need(recordId);
    if (this.#deps.followUps === undefined) throw new DomainError("unavailable", "follow-up tasks are not wired");
    const wanted: { key: string; title: string; why: string; owner?: string }[] = [];
    for (const t of rec.tagged) if (t.tag === "question" && t.answeredBy === undefined) wanted.push({ key: `q:${t.entryId}`, title: `Answer: ${recordText(t.text, 150)}`, why: `Raised in meeting ${rec.title} (entry ${t.entryId}) and left unresolved.`, owner: t.speaker });
    for (const c of f.body.chairQuestions) if (c.state === "asked") wanted.push({ key: `c:${c.id}`, title: `Find out: ${recordText(c.topic, 150)}`, why: `A chair question to ${c.to} was never answered (${c.experienceSought}).`, owner: c.to });
    // keyed by what the investigation is, not by its place in the list: the list is a window, and a place that shifts must not make a second task
    f.body.investigations.forEach((i) => wanted.push({ key: `i:${hash(i.by, i.text).slice(0, 16)}`, title: `Investigate: ${recordText(i.text, 150)}`, why: `Deeper work than the meeting could do (${i.by}).`, ...(AGENT.test(i.by) ? { owner: i.by } : {}) }));
    const made: { key: string; taskId: string; title: string; owner?: string }[] = [];
    for (const w of wanted) {
      if (f.body.followUps.some((x) => x.key === w.key)) continue;
      const t = await this.#deps.followUps.create({ commandId: `fl-fu-${hash(recordId, w.key)}`, projectId: rec.projectId, title: w.title, description: w.why, ...(w.owner === undefined ? {} : { owner: w.owner }) });
      made.push({ key: w.key, taskId: t.id, title: w.title, ...(w.owner === undefined ? {} : { owner: w.owner }) });
    }
    if (made.length > 0) await this.#update(recordId, by, `fu-${hash(JSON.stringify(made))}`, (b) => ({ ...b, followUps: [...b.followUps, ...made.filter((m) => !b.followUps.some((x) => x.key === m.key))] }));
    const deferred = await this.#batchNonUrgent(by, rec);
    return { created: made, deferred };
  }

  /** Nonurgent agenda items of this meeting that were never discussed go to the next meeting (deferred, with the reason). Needs the agenda service; best effort per item. */
  async #batchNonUrgent(by: Principal, rec: RecordBody): Promise<string[]> {
    const out: string[] = [];
    if (this.#deps.meetings === undefined) return out;
    const items = (await (this.#deps.meetings as unknown as { occurrence?: (v: Principal, id: string) => Promise<{ agenda: View<{ urgency: string; state: string }>[] } | undefined> }).occurrence?.(this.#deps.service, rec.occurrenceId)) ?? undefined;
    for (const a of items?.agenda ?? []) {
      if (a.urgency === "urgent" || a.state !== "queued" && a.state !== "scheduled") continue;
      try { await this.#deps.meetings.setAgendaState(by, { commandId: `fl-df-${hash(rec.occurrenceId, a.id)}`, itemId: a.id, expectedRevision: a.revision, to: "deferred", reason: "the meeting ran out of time or spend before this nonurgent item", nextStep: "batched to the next meeting" }); out.push(a.id); } catch { /* left as it is */ }
    }
    return out;
  }

  /** Reminds the owner of inquiries that sat idle past the owner-set time (once per idle period). Run from the controller's loop with the other meeting sweeps. */
  async sweep(by: Principal, command: { projectId?: string } = {}): Promise<{ reminded: string[] }> {
    if (!isService(by)) throw forbidden(by, "sweep meetings");
    const now = this.#runner.now();
    const reminded: string[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as FloorBody;
        if (b.inquiry === undefined || (command.projectId !== undefined && b.projectId !== command.projectId)) continue;
        const idleFrom = b.inquiry.remindedAt ?? b.inquiry.lastActivityAt;
        if (ms(now) - ms(idleFrom) < b.settings.inquiryIdleMinutes * 60_000) continue;
        await this.#deps.notifyOwner?.({ recordId: b.recordId, projectId: b.projectId, kind: "inquiry-idle", key: `remind-${now}`, text: `Your inquiry on a meeting has been idle for ${b.settings.inquiryIdleMinutes} minutes; say when you are done with questions.` }).catch(() => undefined);
        await this.#update(b.recordId, by, `remind-${now}`, (x) => (x.inquiry === undefined ? undefined : { ...x, inquiry: { ...x.inquiry, remindedAt: now } }));
        reminded.push(b.recordId);
      }
      if (page.length < 200) break;
    }
    return { reminded };
  }

  /** The open owner inquiries, for the Needs-you list: the owner is the one it waits for. */
  async ownerPending(by: Principal, limit = 50): Promise<{ items: { recordId: string; projectId: string; since: string; lastActivityAt: string; questions: number; voteHeld: boolean }[] }> {
    this.#ownerOnly(by, "list open inquiries");
    const items: { recordId: string; projectId: string; since: string; lastActivityAt: string; questions: number; voteHeld: boolean }[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as FloorBody;
        if (b.inquiry !== undefined && items.length < limit) items.push({ recordId: b.recordId, projectId: b.projectId, since: b.inquiry.openedAt, lastActivityAt: b.inquiry.lastActivityAt, questions: b.inquiry.questions, voteHeld: b.inquiry.voteHeld });
      }
      if (page.length < 200) break;
    }
    return { items };
  }

  // ---- views -----------------------------------------------------------------------------------------------------------------------------

  /**
   * The floor as the viewer may see it. The owner sees everything: the chair's private notes, answers held from the other voters, ballots by the record's own rules, spend. The chair sees its own notes. A manager sees the state without the
   * notes and held answers. A roster member sees where the meeting is and what it waits on, never notes or held answers. Anyone else sees nothing.
   */
  async state(viewer: Principal, recordId: string): Promise<Record<string, unknown> | undefined> {
    const rec = await this.#deps.records.record(viewer, recordId).catch(() => undefined);
    const f = rec === undefined ? undefined : await this.#load(recordId);
    if (rec === undefined || f === undefined) return undefined;
    const b = f.body;
    const owner = viewer.kind === "owner" && viewer.taskScope === undefined;
    const full = owner || isService(viewer);
    const chair = viewer.kind === "agent" && viewer.asOf !== undefined && rec.chair === viewer.id && inTaskScope(viewer, rec.projectId);
    const active = await this.#activeMotion(rec, true);
    const procedure = this.#deps.procedure?.();
    const shownMotion = active?.id ?? b.motionId;
    const expecting = procedure === undefined || shownMotion === undefined ? undefined : await procedure.expecting(shownMotion);
    // Everyone but the owner, a host and a service (the chair and a manager agent included) sees only what a member sees: no ballot turn, no count of who has voted or is owed a revision, no held answer and nothing drawn from one.
    const common = { phase: (expecting?.stage ?? "none") as FloorPhase, state: b.state, motionId: active?.id ?? b.motionId, waiting: await this.#waitingFor(viewer, b, rec, expecting), timebox: b.timebox, inquiryOpen: b.inquiry !== undefined, queued: b.queue.length };
    if (!full) return json({ ...common, ...(chair && b.chairNotes !== undefined ? { chairNotes: b.chairNotes } : {}) }) as unknown as Record<string, unknown>;
    const { inflight, replies, claims, ...rest } = b;
    void inflight; void replies; void claims;
    return { ...rest, ...common, spend: this.#spendView(b), elapsedMinutes: Math.round(this.#elapsedMs(b, this.#runner.now()) / 60_000), allowedMinutes: Math.round(this.#allowedMs(b) / 60_000) };
  }

  /** The waiting-on view as `viewer` may see it: while a vote is open, everyone but the owner, a host and a service is told only that the meeting waits on the voters, never which voter (that would tell who has voted). */
  async #waitingFor(viewer: Principal, b: FloorBody, rec: RecordBody, expecting?: { stage: string; what: string; agent?: string }): Promise<WaitingOn> {
    const w = await this.#waiting(b, rec, this.#runner.now(), expecting);
    if ((viewer.kind === "owner" && viewer.taskScope === undefined) || isService(viewer)) return w;
    return w.kind === "agent" && (w.what === "ballot" || w.what === "revision" || w.what === "close-vote") ? { kind: "agent", who: "the voters", what: "the vote", since: w.since } : w;
  }

  #spendView(b: FloorBody): { usd: number; tokens: number; ownerUsd: number; ownerTokens: number; capUsd: number; capTokens: number } {
    return { usd: b.spend.usd, tokens: b.spend.tokens, ownerUsd: b.spend.ownerUsd, ownerTokens: b.spend.ownerTokens, capUsd: b.settings.spendCapUsd + b.spend.extraUsd, capTokens: b.settings.tokenCap + b.spend.extraTokens };
  }

  async #waiting(b: FloorBody, rec: RecordBody, now: string, expecting?: { stage: string; what: string; agent?: string }): Promise<WaitingOn> {
    if (b.state === "ended" || rec.state !== "open") return { kind: "nothing", what: "the meeting has ended" };
    if (b.inquiry !== undefined) return { kind: "person", who: "owner", what: "the owner's questions (inquiry open)", since: b.inquiry.openedAt };
    if (b.waitingTool !== undefined) return { kind: "tool", who: b.waitingTool.agent, what: b.waitingTool.tool, since: b.waitingTool.since };
    if (b.inflight !== undefined) return { kind: "agent", who: b.inflight.agent ?? b.inflight.agents?.[0] ?? "the members", what: b.inflight.kind, since: b.inflight.since };
    const plan = this.#plan(b, rec, now);
    if ("unit" in plan) return { kind: "agent", who: plan.unit.agent ?? plan.unit.agents?.[0] ?? "the members", what: plan.unit.kind, since: now };
    if (expecting !== undefined && expecting.what !== "nothing") {
      if (expecting.what === "inquiry") return { kind: "person", who: "owner", what: "the owner's questions (inquiry open)", since: now };
      if (expecting.agent !== undefined) return { kind: "agent", who: expecting.agent, what: expecting.what, since: now };
      if (expecting.what === "close-vote") return { kind: "agent", who: "the voters", what: "the vote's time limit", since: now };
      return { kind: "agent", who: rec.chair ?? "the members", what: expecting.what, since: now };
    }
    return { kind: "nothing", what: plan.wait === "none" ? (plan.detail ?? "nothing is waiting") : "nothing is waiting" };
  }

  /** What the meeting waits on right now: a person (the owner), an agent (who holds the floor or must answer) or a tool; or nothing. Seen by whoever may read the meeting. */
  async waiting(viewer: Principal, recordId: string): Promise<WaitingOn | undefined> {
    const rec = await this.#deps.records.record(viewer, recordId).catch(() => undefined);
    const f = rec === undefined ? undefined : await this.#load(recordId);
    if (rec === undefined || f === undefined) return undefined;
    const active = await this.#activeMotion(rec, true);
    const procedure = this.#deps.procedure?.();
    const shownMotion = active?.id ?? f.body.motionId;
    const expecting = procedure === undefined || shownMotion === undefined ? undefined : await procedure.expecting(shownMotion);
    return this.#waitingFor(viewer, f.body, rec, expecting);
  }

  /** The chair's private notes, kept in the meeting's records: for the owner and the chair only. */
  async chairNotes(viewer: Principal, recordId: string): Promise<{ notes?: string; at?: string; count: number } | undefined> {
    const rec = await this.#deps.records.record(viewer, recordId).catch(() => undefined);
    const f = rec === undefined ? undefined : await this.#load(recordId);
    if (rec === undefined || f === undefined) return undefined;
    const ok = (viewer.kind === "owner" && viewer.taskScope === undefined) || (viewer.kind === "agent" && rec.chair === viewer.id && viewer.asOf !== undefined && inTaskScope(viewer, rec.projectId));
    if (!ok) return undefined;
    return { ...(f.body.chairNotes === undefined ? {} : { notes: f.body.chairNotes }), ...(f.body.chairNotesAt === undefined ? {} : { at: f.body.chairNotesAt }), count: f.body.chairNotesCount };
  }

  // ---- the procedure's members and chair -------------------------------------------------------------------------------------------------

  /**
   * Asks one thing of one member for the procedure, once. The answer is stored on the floor before the procedure writes anything, so a repeat after a restart returns the same words and spends nothing more; another driver asking the same
   * thing meanwhile gets `FloorBusy` (a claim whose asker died is taken over); an agent that waits on a tool gets `FloorWaits`. `afterStore` also changes the floor in the same step as the stored answer.
   */
  async #cached(recordId: string, key: string, produce: (b: FloorBody, rec: RecordBody) => Promise<PortReply>, afterStore?: (b: FloorBody, item: PortReply) => FloorBody): Promise<PortReply> {
    const have = (await this.#need(recordId)).body.replies[key];
    if (have !== undefined) return have;
    const claimedAt = this.#runner.now();
    let settings: FloorSettings | undefined;
    await this.#update(recordId, this.#deps.service, `claim-${hash(key)}`, (b) => {
      if (b.replies[key] !== undefined) return undefined;
      const since = b.claims[key];
      if (since !== undefined && ms(claimedAt) - ms(since) < (b.settings.hangTimeoutSeconds + 30) * 1000) throw new FloorBusy();
      settings = b.settings;
      return { ...b, claims: { ...b.claims, [key]: claimedAt } };
    });
    const again = (await this.#need(recordId)).body;
    if (again.replies[key] !== undefined) return again.replies[key]!;
    void settings;
    let item: PortReply;
    try {
      item = await produce(again, await this.#meeting(recordId));
    } catch (error) {
      await this.#update(recordId, this.#deps.service, `unclaim-${hash(key)}`, (b) => { const { [key]: _c, ...rest } = b.claims; void _c; return { ...b, claims: rest }; }).catch(() => undefined);
      throw error;
    }
    if (item.waitsOnTool !== undefined) {
      const tool = item.waitsOnTool;
      await this.#update(recordId, this.#deps.service, `tool-${hash(key)}`, (b) => { const { [key]: _c, ...rest } = b.claims; void _c; return { ...b, claims: rest, waitingTool: { tool, agent: item.agent, since: b.waitingTool?.since ?? this.#runner.now() } }; });
      throw new FloorWaits(tool);
    }
    const kind = (item as PortReply & { turnKind?: TurnKind }).turnKind;
    await this.#update(recordId, this.#deps.service, `store-${hash(key)}`, (b) => {
      if (b.replies[key] !== undefined) return undefined;
      const { [key]: _c, ...claims } = b.claims; void _c;
      const stored: PortReply = { ...item };
      delete (stored as { turnKind?: TurnKind }).turnKind;
      let n: FloorBody = this.#spent({ ...b, claims, waitingTool: undefined }, `p-${hash(key)}`, kind ?? "statement", [item], item.costUsd ?? 0, false, key.split(":")[0]!);
      n = { ...n, replies: Object.fromEntries(Object.entries({ ...n.replies, [key]: stored }).slice(-FLOOR_LIMITS.replies)) };
      return afterStore === undefined ? n : afterStore(n, item);
    });
    return (await this.#need(recordId)).body.replies[key]!;
  }

  /** Forgets a stored answer (a ballot set aside because an inquiry held the vote): its spend stays counted, the member is asked again. */
  async #forget(recordId: string, key: string): Promise<void> {
    await this.#update(recordId, this.#deps.service, `forget-${hash(key)}`, (b) => { if (b.replies[key] === undefined) return undefined; const { [key]: _r, ...rest } = b.replies; void _r; return { ...b, replies: rest }; });
  }

  /** What the meeting's own checks say about asking now, for answers that start a model call for the procedure: the budget is checked by the call itself. */
  #tag(kind: TurnKind, item: PortReply): PortReply { return Object.assign({}, item, { turnKind: kind }); }

  /** The members, as the procedure's port (card M06). Every call is one tool-less model turn within the turn limits; what a member is given is the motion and the transcript as it may see it, never a ballot. */
  asMembers(): MeetingFloor {
    const view = (recordId: string): Promise<{ b: FloorBody; rec: RecordBody }> => Promise.all([this.#need(recordId), this.#meeting(recordId)]).then(([f, rec]) => ({ b: f.body, rec }));
    const shown = (entries: readonly MeetingDelivered[]): ShownEntry[] => entries.map((e) => ({ seq: e.seq, who: e.kind === "owner-message" ? "Owner" : e.speaker, ...(e.kind === "owner-message" ? { label: "owner" } : e.kind === "motion" || e.kind === "amendment" || e.kind === "ruling" || e.kind === "vote" || e.kind === "correction" ? { label: e.kind } : {}), text: e.text }));
    const words = (tokens: number): number => Math.max(20, Math.round(tokens * 0.7));
    // A member who has not come into the room is skipped (nothing is asked of it), and that is written in the transcript once; the procedure counts the missing answer as no response.
    const away = async (recordId: string, agent: string): Promise<boolean> => {
      const rec = await this.#meeting(recordId);
      if (rec.attended.includes(agent) && !rec.withheld.includes(agent)) return false;
      await this.#noteAbsent(recordId, rec, [agent]);
      return true;
    };
    return {
      comment: async (r: CommentRequest) => {
        if (await away(r.recordId, r.agent)) return undefined;
        const { b, rec: rec0 } = await view(r.recordId);
        const blind = r.round === 1 && r.fresh === 0 && b.settings.firstRound === "blind";
        const key = (agent: string): string => `statement:${r.motion.id}:v${r.motion.version}:p${r.fresh}:r${r.round}:${agent}`;
        const ask = (agent: string): Promise<PortReply> => this.#cached(r.recordId, key(agent), async (bb, rec) => {
          const limit = bb.settings.turnTokens;
          const FORMAT = `Use exactly this format:\nSTANCE: for|against|undecided\nSTATEMENT: <your statement>\nTLDR: <if your statement is brief, write none; otherwise one brief paragraph of the important points and details you want the group to know>${bb.settings.directQuestions > 0 && r.round >= 2 ? "\nASK: none | <member id>: <one short factual question to one present member, only if you really need an answer from them>" : ""}\nAMEND: none | <a wording of the motion you think the group could accept, only if you would propose one>`;
          const text = r.round === 1 && r.fresh === 0 ? `Give your position on the motion in at most ${words(limit)} words.` : "You have now heard the others. Respond to what was said; you may confirm, correct or reverse your earlier view, and you may cite your notes if you have any.";
          return this.#tag(blind ? "blind-statement" : "statement", await this.#prompted(bb, rec, { version: r.motion.version, text: r.motion.text }, blind ? "blind-statement" : "statement", agent, `${text} At most ${words(limit)} words. ${FORMAT}`, { desk: r.deskCheck, round: r.round, ...(blind ? { blind: true } : {}) }));
        }, (n, item) => this.#afterStatement(n, item, r, rec0));
        // The blind first round is asked of several members at once (up to `parallel`): the answers are kept and used one by one in seat order.
        if (blind) {
          const others = r.seats.filter((a) => a !== r.agent).slice(0, Math.max(0, b.settings.parallel - 1));
          const settled = await Promise.allSettled([ask(r.agent), ...others.map((a) => ask(a))]);
          const mine = settled[0]!;
          if (mine.status === "rejected") throw mine.reason;
          return this.#statementOf(mine.value);
        }
        return this.#statementOf(await ask(r.agent));
      },
      objection: async (r: ObjectionRequest) => {
        if (await away(r.recordId, r.agent)) return undefined;
        const { b } = await view(r.recordId);
        const key = (agent: string): string => `objection:${r.motion.id}:v${r.motion.version}:p${r.fresh}:u${r.run}:${agent}`;
        const ask = (agent: string): Promise<PortReply> => this.#cached(r.recordId, key(agent), async (bb, rec) => this.#tag("objection", await this.#prompted(bb, rec, { version: r.motion.version, text: r.motion.text }, "objection", agent, `Do you object to opening the vote now (for example the motion is unclear or something essential is missing)? Reply exactly:\nOBJECT: yes|no${r.tabling ? "|research" : ""}\nREASON: <one sentence, only if yes${r.tabling ? "; if research, say what you would look into and why it matters before voting" : ""}>`, { transcript: `Summary of the discussion:\n${r.summary}`, upTo: 0, visible: 80 })));
        const others = r.seats.filter((a) => a !== r.agent).slice(0, Math.max(0, b.settings.parallel - 1));
        const settled = await Promise.allSettled([ask(r.agent), ...others.map((a) => ask(a))]);
        const mine = settled[0]!;
        if (mine.status === "rejected") throw mine.reason;
        const item = mine.value;
        if (item.noResponse !== undefined) return undefined;
        const parsed = parseObjection(item.text, r.tabling);
        if (parsed.answer === "yes") return { answer: "objection" as const, reason: parsed.reason };
        if (parsed.answer === "research") return { answer: "research" as const, reason: parsed.reason };
        return { answer: "none" as const };
      },
      ballot: async (r: BallotRequest) => {
        if (await away(r.recordId, r.agent)) return undefined;
        const item = await this.#cached(r.recordId, `ballot:${r.motion.id}:v${r.motion.version}:${r.agent}`, async (bb, rec) => this.#tag("ballot", await this.#prompted(bb, rec, { version: r.motion.version, text: r.motion.text }, "ballot", r.agent, "Cast your ballot on the motion as it now stands. Reply exactly:\nVOTE: yes|no|abstain\nREASON: <one sentence>", { visible: 120 })));
        if (item.noResponse !== undefined) return undefined;
        const parsed = parseVote(item.text);
        return parsed.value === undefined ? undefined : { value: parsed.value as BallotValue, reason: recordText(parsed.reason === "" ? `${parsed.value} (no reason given)` : parsed.reason, 480) };
      },
      revision: async (r: RevisionRequest) => {
        if (await away(r.recordId, r.agent)) return undefined;
        const item = await this.#cached(r.recordId, `revision:${r.motion.id}:v${r.motion.version}:${r.agent}:m${r.ownerMessage.seq}`, async (bb, rec) => {
          const t = transcriptView(shown(r.since), "full");
          // a short prompt (proposed change 9): the motion, the voter's own ballot and what came after it, not the whole transcript
          return this.#tag("revision", await this.#prompted(bb, rec, { version: r.motion.version, text: r.motion.text }, "revision", r.agent, `You have the floor for one revision turn because of the owner's message and questions above. Your recorded ballot is ${r.ballot.value}: ${r.ballot.reason}. Keep it or revise it. Reply exactly:\nVOTE: yes|no|abstain\nREASON: <one sentence>`, { visible: 120, transcript: t, upTo: r.since.at(-1)?.seq ?? 0 }));
        });
        if (item.noResponse !== undefined) return undefined;
        const parsed = parseVote(item.text);
        if (parsed.value === undefined) return { keep: true as const };
        return { value: parsed.value as BallotValue, reason: recordText(parsed.reason === "" ? `${parsed.value === r.ballot.value ? "keeping" : "revising"} my ballot after the owner's questions` : parsed.reason, 480) };
      },
      before: (r: GateRequest) => this.#before(r),
      between: (r: BetweenRequest) => this.#between(r),
      setAside: async (r: AsideRequest) => { await this.#forget(r.recordId, r.kind === "ballot" ? `ballot:${r.motionId}:v${r.version}:${r.agent}` : `revision:${r.motionId}:v${r.version}:${r.agent}:m`); },
    };
  }

  #statementOf(item: PortReply): { text: string; stance?: string } | undefined {
    if (item.noResponse !== undefined || item.text.trim() === "") return undefined;
    const parsed = parseStatement(item.text);
    const text = recordText(parsed.text, FLOOR_LIMITS.text);
    return { text: text === "" ? "(no words)" : text, stance: parsed.stance };
  }

  /** A member's statement is kept with its TLDR, and what it asks (a direct question to another member, a rolling chair note) is queued with it, in the same step. */
  #afterStatement(n0: FloorBody, item: PortReply, r: CommentRequest, rec: RecordBody): FloorBody {
    if (item.noResponse !== undefined || item.text.trim() === "") return n0;
    const parsed = parseStatement(item.text);
    let n = n0;
    const text = recordText(parsed.text, FLOOR_LIMITS.text);
    if (parsed.summary !== undefined) n = { ...n, summaries: Object.fromEntries(Object.entries({ ...n.summaries, [summaryKey(item.agent, text === "" ? "(no words)" : text)]: parsed.summary }).slice(-FLOOR_LIMITS.summaries)) };
    const queue = [...n.queue];
    const ask = parsed.ask;
    const id = `dq-${hash(r.motion.id, String(r.motion.version), String(r.fresh), String(r.round), item.agent)}`;
    if (ask !== undefined && n.settings.directQuestions > 0 && r.round >= 2 && !queue.some((q) => q.id.startsWith(id))) {
      const key = `${r.round}:${item.agent}`;
      const used = n.asks[key] ?? 0;
      // a question to nobody on the roster, to oneself or past the member's limit is refused (nothing is asked or written); one to an absent member is recorded as skipped
      const target = rec.roster.find((a) => a === ask.to);
      if (target !== undefined && target !== item.agent && used < n.settings.directQuestions) {
        if (this.#present(rec).includes(target)) {
          n = { ...n, asks: { ...n.asks, [key]: used + 1 } };
          queue.push({ id: `${id}a`, kind: "direct-answer", agent: target, from: item.agent, question: ask.text }, { id: `${id}c`, kind: "direct-continue", agent: item.agent, from: target });
        } else queue.push({ id: `${id}s`, kind: "direct-skip", agent: item.agent, from: item.agent, target });
      }
    }
    if (n.settings.chairNotes === "rolling" && rec.chair !== undefined) queue.push({ id: `cn-${id}`, kind: "chair-notes", agent: rec.chair });
    return { ...n, queue };
  }

  /** The chair, as the procedure's port: a ruling on the objections, and a casting vote. */
  asChair(): ChairFloor {
    return {
      rule: async (r: RulingRequest): Promise<RulingInput | undefined> => {
        const { rec } = await Promise.all([this.#need(r.recordId), this.#meeting(r.recordId)]).then(([f, rr]) => ({ b: f.body, rec: rr }));
        const chair = rec.chair;
        if (chair === undefined) return undefined;
        const research = r.answers.some((a) => a.answer === "research");
        const item = await this.#cached(r.recordId, `ruling:${r.motion.id}:v${r.motion.version}:u${r.run}`, async (bb, rr) => this.#tag("chair-ruling", await this.#prompted(bb, rr, { version: r.motion.version, text: r.motion.text }, "chair-ruling", chair, research && r.canTable
          ? "Members asked for time to research before voting (see the transcript). Reply \"RULING: table\" to postpone the decision to the next meeting, listing \"RESEARCH: <member>: <what they will look into>\" per line, or \"RULING: proceed\" to vote now. Table only if the research could change the outcome."
          : !r.canUphold ? "Members objected to opening the vote and no more amendments are allowed. Reply \"RULING: proceed\" (the remaining objections are recorded as dissent) with \"REASON: <one sentence>\"."
            : "Members objected to opening the vote (see the transcript). Rule: reply \"RULING: proceed\" or \"RULING: amend\" followed by \"AMENDED_MOTION: <the clarified motion text>\" and \"REASON: <one sentence>\".", { visible: 250, full: true })));
        if (item.noResponse !== undefined) return undefined;
        const text = item.text;
        const reason = /REASON:\s*([^\n]+)/i.exec(text)?.[1]?.trim();
        if (/RULING:\s*table/i.test(text) && r.canTable && research) {
          const lines = [...text.matchAll(/RESEARCH:\s*([^\n]+)/gi)].map((m) => recordText(m[1]!, 300));
          return { ruling: "table", reason: `members asked for time to research: ${lines.join(" | ") || "unspecified"}` };
        }
        if (/RULING:\s*amend/i.test(text) && r.canUphold) {
          const to = /AMENDED_MOTION:\s*([\s\S]*?)(?:\n\s*REASON:|$)/i.exec(text)?.[1]?.trim();
          if (to !== undefined && to !== "" && to !== r.motion.text) return { ruling: "uphold", addressed: "amend", text: recordText(to, 600) };
        }
        return { ruling: "proceed", ...(reason === undefined ? {} : { text: recordText(`Chair's ruling: proceed to the vote — ${reason}`, 580) }) };
      },
      castingVote: async (r: CastingRequest) => {
        const rec = await this.#meeting(r.recordId);
        if (rec.chair === undefined) return undefined;
        const chair = rec.chair;
        const item = await this.#cached(r.recordId, `casting:${r.motion.id}:v${r.motion.version}`, async (bb, rr) => this.#tag("casting", await this.#prompted(bb, rr, { version: r.motion.version, text: r.motion.text }, "casting", chair, "The ballots are tied. Under the rules the chair casts a single casting vote on a tie, with no double vote. Reply exactly:\nCASTING: yes|no\nREASON: <one sentence>", { visible: 100, full: true })));
        if (item.noResponse !== undefined) return undefined;
        const parsed = parseVote(item.text);
        if (parsed.value !== "yes" && parsed.value !== "no") return undefined;
        return { value: parsed.value, reason: recordText(parsed.reason === "" ? `${parsed.value} (casting vote)` : parsed.reason, 480) };
      },
    };
  }

  // ---- what the floor does for the procedure between its steps ----------------------------------------------------------------------------

  /**
   * Asked before every step of the procedure: the owner's inquiry and a used-up timebox hold the meeting (nothing is asked of a member), and the floor's own work comes first (the owner's questions, a chair question's answer, the wrap-up of
   * a timebox, the correction of a member whose desk was read, before the vote opens).
   */
  async #before(r: GateRequest): Promise<FloorGate> {
    const f = await this.#load(r.recordId);
    if (f === undefined || f.body.state === "ended") return undefined;
    const rec = await this.#meeting(r.recordId);
    const own = await this.#advance(this.#deps.service, r.recordId, rec, false);
    if ("did" in own) return { ran: `the floor did ${own.did}${own.agent === undefined ? "" : ` for ${own.agent}`}` };
    if (own.waiting === "busy") throw new FloorBusy();
    if (own.waiting === "tool") throw new FloorWaits(own.detail ?? "a tool");
    const b = (await this.#need(r.recordId)).body;
    if (b.inquiry !== undefined) return { halt: "inquiry", why: "the owner's inquiry holds the meeting; only the owner's questions run" };
    if (b.timebox !== undefined) return { halt: b.timebox.reason, why: `the meeting's ${b.timebox.reason} timebox is used up` };
    // A member whose desk the chair read, now in the room, is asked for a correction before the vote opens.
    if (r.stage === "ready") {
      const owed = b.desk.readOwners.find((a) => this.#present(rec).includes(a) && !b.desk.corrections.some((c) => c.member === a));
      if (owed !== undefined) {
        const ran = await this.#runOwnUnit(r.recordId, rec, "correction", owed);
        if (ran) return { ran: `the floor asked ${owed} for a correction` };
      }
    }
    return undefined;
  }

  /** Runs one floor unit of a kind now (claimed, answered, written, committed like any other unit). */
  async #runOwnUnit(recordId: string, rec: RecordBody, kind: UnitKind, agent?: string): Promise<boolean> {
    const f = await this.#need(recordId);
    if (f.body.inflight !== undefined) return false;
    const unit: Inflight = { id: `u${f.body.unitSeq + 1}-${kind}`, kind, since: this.#runner.now(), ...(agent === undefined ? {} : { agent }) };
    try {
      await this.#update(recordId, this.#deps.service, `claim-${unit.id}`, (b) => (b.inflight !== undefined || b.unitSeq + 1 !== f.body.unitSeq + 1 ? (() => { throw new DomainError("stale_revision", "another caller claimed the next unit"); })() : { ...b, unitSeq: b.unitSeq + 1, inflight: unit }));
    } catch (error) {
      if (error instanceof DomainError && error.code === "stale_revision") return false;
      throw error;
    }
    await this.#run(this.#deps.service, recordId, (await this.#need(recordId)).body.inflight!);
    return true;
  }

  /**
   * The chair's work between two comment rounds, one step each time the procedure asks: the notes once, its questions, the desk read and its summary (the first round only), the reminders where facts-style summaries are used. When none is
   * left, `done` with the chair's summary (a verified one: a point left out of a statement carries a verbatim quote from it), which the objection check is given in place of the mechanical digest.
   */
  async #between(r: BetweenRequest): Promise<BetweenResult> {
    const key = `${r.motion.id}:${r.motion.version}:${r.fresh}:${r.round}`;
    const f = await this.#load(r.recordId);
    if (f === undefined) return { done: true };
    if (f.body.lastBetween?.key === key) return { done: true, ...(f.body.lastBetween.summary === undefined ? {} : { summary: f.body.lastBetween.summary }) };
    const rec = await this.#meeting(r.recordId);
    if (f.body.between?.key !== key) {
      const todo = this.#betweenSteps(f.body, rec, r.round, r.fresh);
      await this.#update(r.recordId, this.#deps.service, `between-${hash(key)}`, (b) => (b.between?.key === key ? undefined : { ...b, between: { key, motionId: r.motion.id, version: r.motion.version, round: r.round, rounds: r.rounds, fresh: r.fresh, todo } }));
    }
    const cur = (await this.#need(r.recordId)).body.between;
    if (cur === undefined || cur.key !== key || cur.todo.length === 0) {
      const summary = cur?.key === key ? cur.summary : undefined;
      await this.#update(r.recordId, this.#deps.service, `between-done-${hash(key)}`, (b) => (b.lastBetween?.key === key ? undefined : { ...b, between: undefined, lastBetween: { key, ...(summary === undefined ? {} : { summary }) } }));
      return { done: true, ...(summary === undefined ? {} : { summary }) };
    }
    const kind = cur.todo[0] as UnitKind;
    const ran = await this.#runOwnUnit(r.recordId, rec, kind, kind === "correction" ? undefined : rec.chair);
    if (!ran) throw new FloorBusy();
    return { done: false, did: `the chair's ${kind.replace("chair-", "")} after round ${r.round}` };
  }

  // ---- the scheduled turn ----------------------------------------------------------------------------------------------------------------

  /**
   * The scheduled loop's turn (host or service): reminds the owner of an idle inquiry, and gives each running meeting a few steps (its own work and its motion's procedure), so a meeting goes on with nobody calling `advance`. A meeting that
   * fails does not stop the others.
   */
  async tick(by: Principal, command: { units?: number } = {}): Promise<{ reminded: readonly string[]; driven: number; failed: number }> {
    if (!isService(by)) throw forbidden(by, "run the meetings' turn");
    const units = command.units === undefined ? FLOOR_LIMITS.tickUnits : command.units;
    const { reminded } = await this.sweep(by);
    let driven = 0, failed = 0;
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as FloorBody;
        if (b.state !== "running") continue;
        try { await this.drive(by, { recordId: b.recordId, maxUnits: units }); driven += 1; } catch { failed += 1; }
      }
      if (page.length < 200) break;
    }
    return { reminded, driven, failed };
  }

  /** The meetings whose owner inquiry is open, oldest first (the Needs-you list shows each until the owner says they are done). Owner only. */
  async openInquiries(viewer: Principal, limit: number): Promise<{ items: readonly { recordId: string; projectId: string; since: string; idleMinutes: number; questions: number }[]; truncated: boolean }> {
    if (!(viewer.kind === "owner" && viewer.taskScope === undefined)) return { items: [], truncated: false };
    const items: { recordId: string; projectId: string; since: string; idleMinutes: number; questions: number }[] = [];
    const now = ms(this.#runner.now());
    let after: string | undefined;
    for (;;) {
      const page = await this.#runner.list(KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const b = a.body as unknown as FloorBody;
        if (b.state !== "running" || b.inquiry === undefined) continue;
        items.push({ recordId: b.recordId, projectId: b.projectId, since: b.inquiry.openedAt, idleMinutes: Math.max(0, Math.floor((now - ms(b.inquiry.lastActivityAt)) / 60_000)), questions: b.inquiry.questions });
      }
      if (page.length < 200) break;
    }
    items.sort((x, y) => (x.since < y.since ? -1 : x.since > y.since ? 1 : 0));
    return { items: items.slice(0, limit), truncated: items.length > limit };
  }

  /** Whether a meeting is on the floor and running: the scheduled procedure loop leaves such a meeting to the floor's own turn. */
  async runs(recordId: string): Promise<boolean> { return (await this.#load(recordId))?.body.state === "running"; }
}

/** A step that cannot be taken yet (a vote that cannot close before its time): not a failure. */
class Wait extends Error {
  readonly reason: "vote-time" | "owner";
  constructor(reason: "vote-time" | "owner", message: string) { super(message); this.reason = reason; }
}

/** Keeps every list on the floor inside its window (oldest dropped). */
function capped(b: FloorBody): FloorBody {
  const w = {
    ...b, turns: b.turns.slice(-FLOOR_LIMITS.turns), notices: b.notices.slice(-FLOOR_LIMITS.notices), held: b.held.slice(-FLOOR_LIMITS.heldAnswers), ownerAnswers: b.ownerAnswers.slice(-FLOOR_LIMITS.ownerAnswers),
    chairQuestions: b.chairQuestions.slice(-FLOOR_LIMITS.chairQuestions), investigations: b.investigations.slice(-FLOOR_LIMITS.investigations), followUps: b.followUps.slice(-FLOOR_LIMITS.followUps),
    queue: b.queue.slice(-FLOOR_LIMITS.queue),
  };
  // storage keeps JSON: a field that is undefined is simply absent
  return JSON.parse(JSON.stringify(w)) as FloorBody;
}
