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
import { FLOOR_DEFAULTS, applyFloorChange, type FloorSettings } from "./floor-settings.js";
import {
  accountTurn, buildPrompt, chairQuestionRefusal, estimateTokens, parseJsonObject, parseObjection, parseStatement, parseVote, quoteOccurs, recordText, transcriptView, usesFacts, wrapCheckpointAnswer,
  type ShownEntry,
} from "./floor-text.js";
import {
  TurnWaitsOnTool,
  type AdvanceResult, type ChairQuestionRecord, type FloorBody, type FloorPhase, type Inflight, type InquiryState, type QueueItem, type StoredReply, type TurnLog, type TurnRunner, type UnitKind, type VoteState, type WaitingOn,
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
export const FLOOR_LIMITS = { turns: 300, notices: 60, queue: 60, heldAnswers: 40, ownerAnswers: 60, amendments: 20, chairQuestions: 30, investigations: 30, followUps: 60, stepsPerDrive: 400, unitRetries: 8, text: 3900, desk: 20, deskRead: 5 } as const;

/** What the facilitator needs from the rest of the controller. Nothing is reached by any other road. */
export interface FloorDeps {
  readonly records: Pick<MeetingRecordService, "record" | "discussion" | "append" | "move" | "amend" | "table" | "openVote" | "hold" | "resume" | "castBallot" | "closeVote" | "castingVote" | "finish" | "motion" | "ballots">;
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
  readonly notifyOwner?: (notice: { recordId: string; kind: string; text: string }) => Promise<void>;
  /** Participants the owner did not address may go back to work during an inquiry, and are recalled when addressed (attendance's return rules). */
  readonly work?: { release(recordId: string, agents: readonly string[]): Promise<void>; recall(recordId: string, agent: string): Promise<void> };
  /** Timer for a turn that never answers; returns the way to cancel it. Default: the global timer. */
  readonly timer?: (ms: number, fire: () => void) => () => void;
}

const defaultTimer = (delay: number, fire: () => void): (() => void) => { const t = setTimeout(fire, delay); t.unref?.(); return () => clearTimeout(t); };
const isService = (p: Principal): boolean => (p.kind === "owner" || p.kind === "host" || p.kind === "service") && p.taskScope === undefined;
const hash = (...parts: readonly string[]): string => createHash("sha256").update(parts.join("\u0000")).digest("hex").slice(0, 40);
const base = (recordId: string): string => recordId.slice(4);

const PRIORITY: Readonly<Record<QueueItem["kind"], number>> = { "owner-ask": 0, revision: 1, "chair-answer": 2, reply: 2, "chair-notes": 3, "direct-answer": 4, "direct-continue": 4 };
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
   * Puts a meeting's record on the floor and moves the motion (when one is given): from here the facilitator runs the rounds, the chair's work, the objection check and the vote one unit at a time with `advance` (or `drive`).
   * The owner, a host or service, or `meeting.manage` in the project. Called again once the motion has concluded, with another motion, it starts the next one (the clock, spend and inquiry settings carry on).
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
    let motionId: string | undefined;
    if (command.motion !== undefined) {
      const proposer = rec.chair ?? present[0];
      if (proposer === undefined) throw new DomainError("invalid_command", "nobody is present to move the motion", { field: "motion" });
      const mover = await this.#deps.principalOf(proposer);
      if (mover === undefined) throw new DomainError("invalid_command", `${proposer} has no credential to move the motion`, { field: "motion" });
      const m = await this.#deps.records.move(mover, { commandId: `fl-mv-${hash(recordId, command.commandId, command.motion.text)}`, recordId, text: recordText(command.motion.text), ...(command.motion.topic === undefined ? {} : { topic: command.motion.topic }), ...(command.motion.agendaItemId === undefined ? {} : { agendaItemId: command.motion.agendaItemId }) } as never);
      motionId = m.id;
    }
    if (existing !== undefined) {
      if (existing.body.phase !== "done" || motionId === undefined) {
        if (motionId === undefined || existing.body.motionId === motionId) return { ...(existing.body.motionId === undefined ? {} : { motionId: existing.body.motionId }), present, absent, replayed: true };
        throw new DomainError("invalid_command", "the floor is still on an earlier motion", { field: "motion" });
      }
      const mid = motionId;
      await this.#update(recordId, by, `next-motion-${mid}`, (b) => (b.motionId === mid ? undefined : this.#fresh(b, rec, mid, now)));
      return { motionId: mid, present, absent, replayed: false };
    }
    const durationMs = Math.max(60_000, ms(rec.endsAt) - ms(now));
    const body: FloorBody = {
      recordId, occurrenceId: rec.occurrenceId, projectId: rec.projectId, state: "running", settings, phase: "round", round: 1, fresh: false, order: [], spoken: [], turn: 0, todo: [], queue: [],
      ...(motionId === undefined ? {} : { motionId }), objection: { attempt: 0, objectors: [], noResponse: [] }, unitSeq: 0, clock: { startedAt: now, durationMs, extraMs: 0, pausedMs: 0 },
      spend: { usd: 0, tokens: 0, calls: 0, hiddenTokens: 0, ownerUsd: 0, ownerTokens: 0, extraUsd: 0, extraTokens: 0 }, turns: [], deliveries: 0, summaries: {}, stances: {}, amendments: [], chairNotesCount: 0,
      chairQuestions: [], chairQuestionsAsked: 0, asks: {}, desk: { offered: [], filesRead: [], filesQuoted: [], refused: [], rejectedExcerpts: 0, corrections: [], readOwners: [], pending: [] }, skipped: [], held: [], ownerAnswers: [], investigations: [], followUps: [], notices: [], priorities: [], startedAt: now,
    };
    const started = this.#beginRound(body, rec, 1, false);
    try {
      await this.#runner.command("meeting.floor.start", { commandId: `flr-start-${base(recordId)}`, actor: by.id }, async () => ({
        payload: { recordId },
        build: async () => ({ ref: { kind: KIND, id: this.#floorId(recordId) }, creates: true, changes: [{ type: "create" as const, ref: { kind: KIND, id: this.#floorId(recordId) }, body: json(started) }], detail: { projectId: rec.projectId } }),
      }));
    } catch (error) {
      if (error instanceof DomainError && error.code === "command_conflict") return { ...(motionId === undefined ? {} : { motionId }), present, absent, replayed: true };
      throw error;
    }
    await this.#noteAbsent(recordId, rec, absent);
    return { ...(motionId === undefined ? {} : { motionId }), present, absent, replayed: false };
  }

  /** A skipped member is recorded in the transcript (by the chair, when there is one) and on the floor. */
  async #noteAbsent(recordId: string, rec: RecordBody, absent: readonly string[]): Promise<void> {
    if (absent.length === 0) return;
    const now = this.#runner.now();
    await this.#update(recordId, this.#deps.service, "absent", (b) => ({ ...b, skipped: [...b.skipped, ...absent.filter((a) => !b.skipped.some((s) => s.agent === a)).map((agent) => ({ agent, why: "absent (decided by the controller from the roster and attendance)", at: now }))] }));
    if (rec.chair !== undefined) {
      for (const a of absent) {
        await this.#deps.records.append(this.#deps.service, { commandId: `fl-abs-${hash(recordId, a)}`, recordId, kind: "statement", speaker: rec.chair, text: `${a} is absent and is skipped in the comment rounds and the vote (recorded).` });
      }
    }
  }

  #fresh(b: FloorBody, rec: RecordBody, motionId: string, now: string): FloorBody {
    void now;
    return this.#beginRound({ ...b, motionId, motionVersion: undefined, phase: "round", round: 1, fresh: false, todo: [], queue: b.queue.filter((q) => q.kind === "owner-ask"), objection: { attempt: 0, objectors: [], noResponse: [] }, chairQuestions: [], chairQuestionsAsked: 0, asks: {}, amendments: [], summaries: {}, stances: {}, echo: undefined, timebox: undefined, vote: undefined } as unknown as FloorBody, rec, 1, false);
  }

  /** Starts comment round `n`: everyone present now, in roster order. */
  #beginRound(b: FloorBody, rec: RecordBody, n: number, fresh: boolean): FloorBody {
    return { ...b, phase: "round", round: n, fresh, order: this.#present(rec), spoken: [], turn: 0, todo: [] };
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
        const summary = b.summaries[e.id];
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
      return { agent: input.agent, text: "", noResponse: recordText(error instanceof Error ? error.message : String(error), 200) || "no answer", usage: zero, deliveredUpTo: input.deliveredUpTo };
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

  /** The next unit of work, or why there is none. Pure: it reads the floor and the meeting only. */
  #plan(b: FloorBody, rec: RecordBody, now: string): { unit: Inflight } | { wait: Extract<AdvanceResult, { waiting: string }>["waiting"]; detail?: string } {
    const id = (kind: UnitKind): string => `u${b.unitSeq + 1}-${kind}`;
    const mk = (kind: UnitKind, extra: Partial<Inflight> = {}): { unit: Inflight } => ({ unit: { id: id(kind), kind, since: now, ...extra } });
    if (b.state === "ended" || rec.state !== "open") return { wait: "meeting-ended" };
    if (b.inquiry !== undefined) {
      const ask = sortQueue(b.queue).find((q) => q.kind === "owner-ask");
      return ask === undefined ? { wait: "owner", detail: "the owner's inquiry is open" } : mk("owner-ask", { agent: ask.agent, queueId: ask.id, owner: true });
    }
    const front = sortQueue(b.queue)[0];
    if (front?.kind === "owner-ask") return mk("owner-ask", { agent: front.agent, queueId: front.id, owner: true });
    if (b.timebox !== undefined && b.phase !== "vote") return { wait: "none", detail: `the meeting's ${b.timebox.reason} timebox is used up` };
    const boxed = this.#timeboxed(b, now);
    if (boxed !== undefined && b.timebox === undefined && b.phase !== "done") return mk("wrap-up");
    if (b.timebox !== undefined && b.vote !== undefined && !b.vote.closed) return this.#planVote(b, rec, mk);
    if (front !== undefined) return mk(front.kind as UnitKind, { agent: front.agent, queueId: front.id });
    switch (b.phase) {
      case "round": {
        const joiner = this.#present(rec).find((a) => !b.order.includes(a));
        if (b.round === 1 && b.settings.firstRound === "blind" && !b.fresh && b.turn === 0 && b.spoken.length === 0) return mk("round-blind", { agents: b.order.filter((a) => this.#present(rec).includes(a)) });
        if (joiner !== undefined) return mk("round-turn", { agent: joiner });
        const agent = b.order[b.turn];
        return agent === undefined ? { wait: "none", detail: "the round is complete" } : mk("round-turn", { agent });
      }
      case "between": {
        const step = b.todo[0];
        return step === undefined ? { wait: "none", detail: "nothing is left between the rounds" } : mk(step as UnitKind);
      }
      case "objection": return mk("objection", { agents: this.#present(rec) });
      case "ruling": return rec.chair === undefined ? { wait: "chair", detail: "a ruling is needed and there is no chair" } : mk("chair-ruling", { agent: rec.chair });
      case "match": return rec.chair === undefined ? { wait: "none" } : mk("chair-match", { agent: rec.chair });
      case "vote": return this.#planVote(b, rec, mk);
      default: return { wait: "none", detail: "the motion is concluded" };
    }
  }

  #planVote(b: FloorBody, rec: RecordBody, mk: (kind: UnitKind, extra?: Partial<Inflight>) => { unit: Inflight }): { unit: Inflight } | { wait: Extract<AdvanceResult, { waiting: string }>["waiting"]; detail?: string } {
    const v = b.vote;
    if (v === undefined || !v.opened) {
      // a member whose desk was read, now in the room, is asked for a correction before the ballots open
      const owed = b.desk.readOwners.find((a) => this.#present(rec).includes(a) && !b.desk.corrections.some((c) => c.member === a));
      return owed === undefined ? mk("open-vote") : mk("correction", { agent: owed });
    }
    if (v.closed) {
      if (v.tie === true && v.decisionId === undefined) {
        if (rec.chair === undefined || v.castingAsked === true) return { wait: "chair", detail: "the tie waits for the chair's casting vote or its time limit" };
        return mk("casting", { agent: rec.chair });
      }
      return { wait: "none", detail: "the vote is concluded" };
    }
    const can = this.#present(rec).filter((a) => v.order.includes(a));
    if (b.timebox === undefined) {
      const next = can.find((a) => v.cast[a] === undefined && !v.noResponse.includes(a));
      if (next !== undefined) return mk("ballot", { agent: next });
    }
    return mk("close-vote");
  }

  /**
   * Does one unit of work: the next turn, batch or step, in the order the rules give (the owner's questions first). Returns what it did, or why nothing can be done now. Safe to call from several places at once: a unit is claimed
   * first, and a claim that is still fresh makes the other caller `busy`; a claim whose caller died is taken over (its stored reply is written, nothing is asked twice).
   */
  async advance(by: Principal, command: { recordId: string }): Promise<AdvanceResult> {
    const recordId = RECORD_ID.test(command.recordId) ? command.recordId : invalid("recordId", "is not a meeting record ID");
    const rec = await this.#meeting(recordId);
    if (!this.#controls(by, rec.projectId)) throw forbidden(by, "run that meeting");
    return this.#advance(by, recordId, rec, false);
  }

  async #advance(by: Principal, recordId: string, rec0: View<RecordBody>, onlyOwner: boolean): Promise<AdvanceResult> {
    let rec = rec0;
    let f = await this.#need(recordId);
    const now = this.#runner.now();
    // A claim that is still fresh belongs to another caller; one that outlived the hang timeout is taken over.
    if (f.body.inflight !== undefined) {
      const age = ms(now) - ms(f.body.inflight.since);
      if (age < (f.body.settings.hangTimeoutSeconds + 30) * 1000 && !(f.body.inflight.reply !== undefined)) return { waiting: "busy", phase: f.body.phase };
      if (f.body.inflight.reply === undefined && age >= (f.body.settings.hangTimeoutSeconds + 30) * 1000) { /* take it over */ }
    }
    let unit = f.body.inflight;
    if (unit === undefined) {
      rec = await this.#meeting(recordId);
      const plan = this.#plan(f.body, rec, now);
      if ("wait" in plan) return { waiting: plan.wait, phase: f.body.phase, ...(plan.detail === undefined ? {} : { detail: plan.detail }) };
      if (onlyOwner && !plan.unit.owner) return { waiting: "owner", phase: f.body.phase, detail: "only the owner's questions run now" };
      const claimed = plan.unit;
      try {
        await this.#update(recordId, by, `claim-${claimed.id}`, (b) => (b.inflight !== undefined || b.unitSeq + 1 !== Number(claimed.id.slice(1, claimed.id.indexOf("-"))) ? (() => { throw new DomainError("stale_revision", "another caller claimed the next unit"); })() : { ...b, unitSeq: b.unitSeq + 1, inflight: claimed }));
      } catch (error) {
        if (error instanceof DomainError && error.code === "stale_revision") return { waiting: "busy", phase: f.body.phase };
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
    if (tool !== undefined && unit.kind !== "round-blind") {
      // The agent waits on a tool: the unit is dropped (no spend counted twice) and tried again at the next advance.
      const now = this.#runner.now();
      const body = await this.#update(recordId, by, `tool-${unit.id}`, (b) => (b.inflight?.id === unit.id ? { ...b, inflight: undefined, waitingTool: { tool: tool.waitsOnTool!, agent: tool.agent, since: b.waitingTool?.since ?? now } } : undefined));
      return { waiting: "tool", phase: body.phase, detail: tool.waitsOnTool! };
    }
    const fresh = (await this.#need(recordId)).body;
    const recNow = await this.#meeting(recordId);
    if (recNow.state !== "open") {
      // the meeting ended (the owner's end command takes effect at this boundary): the unit is dropped, nothing completed is undone
      await this.#update(recordId, by, `ended-${unit.id}`, (b) => ({ ...b, inflight: undefined, state: "ended", endedAt: this.#runner.now() }));
      return { waiting: "meeting-ended", phase: fresh.phase };
    }
    let fx: Record<string, unknown>;
    try { fx = await this.#apply(by, recordId, fresh, recNow, unit, reply); } catch (error) {
      if (error instanceof Wait) { await this.#update(recordId, by, `wait-${unit.id}`, (b) => (b.inflight?.id === unit.id ? { ...b, inflight: undefined } : undefined)); return { waiting: error.reason, phase: fresh.phase, detail: error.message }; }
      throw error;
    }
    const done = await this.#update(recordId, by, `commit-${unit.id}`, (b) => (b.inflight?.id === unit.id ? this.#reduce(b, recNow, unit, reply!, fx) : undefined));
    return { did: unit.kind, ...(unit.agent === undefined ? {} : { agent: unit.agent }), phase: done.phase };
  }

  /** Runs units until nothing can be done now, the meeting is over, or `maxUnits` units ran. */
  async drive(by: Principal, command: { recordId: string; maxUnits?: number }): Promise<{ did: number; last: AdvanceResult }> {
    onlyKnown(command, ["recordId", "maxUnits"]);
    const max = command.maxUnits === undefined ? FLOOR_LIMITS.stepsPerDrive : Number.isInteger(command.maxUnits) && command.maxUnits >= 1 && command.maxUnits <= 2000 ? command.maxUnits : invalid("maxUnits", "must be 1 to 2000");
    let did = 0;
    let last: AdvanceResult = { waiting: "none", phase: "round" };
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

  async #ownBallot(b: FloorBody, agent: string): Promise<{ value: string; reason: string } | undefined> {
    if (b.motionId === undefined) return undefined;
    const p = await this.#deps.principalOf(agent);
    void p;
    const all = await this.#deps.records.ballots(this.#deps.service, b.motionId);
    if (all === undefined || all.hidden) return undefined;
    const mine = all.ballots.find((x) => x.voter === agent);
    return mine === undefined ? undefined : { value: mine.value, reason: mine.reason };
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

  async #askUnit(b: FloorBody, rec: RecordBody, unit: Inflight): Promise<StoredReply> {
    const items: StoredReply["items"][number][] = [];
    let cost = 0;
    const take = (i: StoredReply["items"][number]): void => { cost += i.costUsd ?? 0; items.push(i); };
    const order = b.settings.promptOrder;
    const motion = await this.#motionText(b);
    const words = (tokens: number): number => Math.max(20, Math.round(tokens * 0.7));
    const limit = b.settings.turnTokens;
    const chair = rec.chair;
    const ask = async (kind: import("./floor-types.js").TurnKind, agent: string, instruction: string, o: { visible?: number; blind?: boolean; full?: boolean; extra?: string; transcript?: string; upTo?: number; desk?: boolean; owner?: boolean } = {}): Promise<StoredReply["items"][number]> => {
      let t: { text: string; upTo: number };
      if (o.blind === true) t = { text: "(This is the independent first round: you have not heard anyone else.)", upTo: 0 };
      else if (o.transcript !== undefined) t = { text: o.transcript, upTo: o.upTo ?? 0 };
      else { const x = await this.#transcript(b.recordId, b, rec, o.full === true || agent === chair); t = { text: x.text, upTo: x.upTo }; }
      const notes = o.desk === true ? await this.#deps.deskNotes?.(agent, b.recordId).catch(() => undefined) : undefined;
      const extra = [o.extra, this.#ownExchange(b, agent), notes === undefined ? "" : `Notes you looked up on your own desk:\n${notes}`].filter((x): x is string => x !== undefined && x !== "").join("\n\n");
      const prompt = buildPrompt({ order, motion, transcript: t.text, persona: await this.#persona(agent), extra, instruction });
      return this.#ask(b, { kind, agent, prompt, visible: o.visible ?? limit, deliveredUpTo: t.upTo, round: b.round });
    };
    const batch = async (agents: readonly string[], one: (a: string) => Promise<StoredReply["items"][number]>): Promise<void> => {
      const out = new Array<StoredReply["items"][number]>(agents.length);
      let next = 0;
      await Promise.all(Array.from({ length: Math.min(b.settings.parallel, agents.length) }, async () => { while (next < agents.length) { const i = next; next += 1; out[i] = await one(agents[i]!); } }));
      out.forEach(take);
    };
    const FORMAT = `Use exactly this format:\nSTANCE: for|against|undecided\nSTATEMENT: <your statement>\nTLDR: <if your statement is brief, write none; otherwise one brief paragraph of the important points and details you want the group to know>${b.settings.directQuestions > 0 && b.round >= 2 ? "\nASK: none | <member id>: <one short factual question to one present member, only if you really need an answer from them>" : ""}\nAMEND: none | <a wording of the motion you think the group could accept, only if you would propose one>`;
    const SHORT = "Use exactly this format:\nSTANCE: for|against|undecided\nSTATEMENT: <your statement>\nTLDR: none";
    const q = b.queue.find((x) => x.id === unit.queueId);
    const half = Math.ceil(limit / 2) + 20;
    switch (unit.kind) {
      case "round-blind": await batch(unit.agents ?? [], (a) => ask("blind-statement", a, `Give your position on the motion in at most ${words(limit)} words. ${FORMAT}`, { blind: true })); break;
      case "round-turn": take(await ask("statement", unit.agent!, `${b.round === 1 && !b.fresh ? `Give your position on the motion in at most ${words(limit)} words.` : "You have now heard the others. Respond to what was said; you may confirm, correct or reverse your earlier view, and you may cite your notes if you have any."} At most ${words(limit)} words. ${FORMAT}`, { desk: b.round >= 2 })); break;
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
      case "revision": {
        const own = await this.#ownBallot(b, unit.agent!);
        // a short prompt (proposed change 9): the motion, the voter's own ballot and what came after it, not the whole transcript
        const t = await this.#transcript(b.recordId, b, rec, false, Math.max(1, b.vote?.cast[unit.agent!] ?? 1));
        take(await ask("revision", unit.agent!, `You have the floor for one revision turn because of the owner's message and questions above. Your recorded ballot is ${own?.value ?? "none"}: ${own?.reason ?? ""}. Keep it or revise it. Reply exactly:\nVOTE: yes|no|abstain\nREASON: <one sentence>`, { visible: 120, transcript: t.text, upTo: t.upTo }));
        break;
      }
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
      case "objection": {
        const t = await this.#transcript(b.recordId, b, rec, false);
        const summary = t.entries.slice(-60).map((e) => `- ${e.who}: ${e.summary ?? e.text.slice(0, 280)}`).join("\n");
        // the member receives only the motion version and the round summary, and may answer only yes or no with a reason
        await batch(unit.agents ?? [], (a) => ask("objection", a, `Do you object to opening the vote now (for example the motion is unclear or something essential is missing)? Reply exactly:\nOBJECT: yes|no${b.settings.tabling ? "|research" : ""}\nREASON: <one sentence, only if yes${b.settings.tabling ? "; if research, say what you would look into and why it matters before voting" : ""}>`, { transcript: `Summary of the discussion:\n${summary}`, upTo: t.upTo, visible: 80 }));
        break;
      }
      case "chair-ruling": {
        const research = b.objection.objectors.some((o) => o.research === true);
        const last = b.objection.attempt >= b.settings.objectionReruns;
        take(await ask("chair-ruling", chair!, research
          ? "Members asked for time to research before voting (see the transcript). Reply \"RULING: table\" to postpone the decision to the next meeting, listing \"RESEARCH: <member>: <what they will look into>\" per line, or \"RULING: proceed\" to vote now. Table only if the research could change the outcome."
          : last ? "Members objected to opening the vote and no more amendments are allowed. Reply \"RULING: proceed\" (the remaining objections are recorded as dissent) with \"REASON: <one sentence>\"."
            : "Members objected to opening the vote (see the transcript). Rule: reply \"RULING: proceed\" or \"RULING: amend\" followed by \"AMENDED_MOTION: <the clarified motion text>\" and \"REASON: <one sentence>\".", { visible: 250, full: true }));
        break;
      }
      case "chair-match": take(await ask("chair-match", chair!, `Before the ballots open: does the motion as worded match where the discussion landed${b.amendments.length === 0 ? "" : ` (members proposed these wordings: ${b.amendments.map((a) => `${a.by}: ${a.text}`).join(" | ")})`}? Reply exactly:\nMATCHES: yes|no\nAMENDED_MOTION: none | <the motion reworded to match the discussion>\nREASON: <one sentence>`, { visible: 250, full: true })); break;
      case "ballot": take(await ask("ballot", unit.agent!, "Cast your ballot on the motion as it now stands. Reply exactly:\nVOTE: yes|no|abstain\nREASON: <one sentence>", { visible: 120 })); break;
      case "casting": take(await ask("casting", chair!, "The ballots are tied. Under the rules the chair casts a single casting vote on a tie, with no double vote. Reply exactly:\nCASTING: yes|no\nREASON: <one sentence>", { visible: 100, full: true })); break;
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

  async #voterPrincipal(agent: string): Promise<Principal | undefined> { return this.#deps.principalOf(agent).catch(() => undefined); }

  /** Writes what the reply means into the meeting record (every write has an ID derived from the unit, so a repeat after a crash writes nothing twice) and returns what the reduction needs. */
  async #apply(by: Principal, recordId: string, b: FloorBody, rec: RecordBody, unit: Inflight, reply: StoredReply): Promise<Record<string, unknown>> {
    const fx: Record<string, unknown> = {};
    const item = reply.items[0];
    const chair = rec.chair;
    const notice = async (kind: string, text: string): Promise<void> => { await this.#deps.notifyOwner?.({ recordId, kind, text }).catch(() => undefined); };
    const statementOf = async (key: string, it: StoredReply["items"][number], label?: string): Promise<{ entryId: string; parsed: ReturnType<typeof parseStatement> } | undefined> => {
      if (it.noResponse !== undefined || it.text.trim() === "") return undefined;
      const parsed = parseStatement(it.text);
      const entryId = await this.#say(recordId, unit, key, it.agent, label === undefined ? parsed.text : `${label}${parsed.text}`);
      return { entryId, parsed };
    };
    try {
      switch (unit.kind) {
        case "round-blind": {
          const done: Record<string, { entryId: string; parsed: ReturnType<typeof parseStatement> }> = {};
          for (const it of reply.items) { const s = await statementOf(`s-${it.agent}`, it); if (s !== undefined) done[it.agent] = s; }
          fx["statements"] = done;
          break;
        }
        case "round-turn": case "direct-answer": case "direct-continue": case "chair-answer": case "reply": {
          const s = await statementOf("s", item!);
          if (s !== undefined) {
            fx["statements"] = { [item!.agent]: s };
            const ask = s.parsed.ask;
            if (unit.kind === "round-turn" && ask !== undefined && b.settings.directQuestions > 0 && b.round >= 2) {
              const used = b.asks[`${b.round}:${item!.agent}`] ?? 0;
              const target = rec.roster.find((a) => a === ask.to);
              if (target === undefined || target === item!.agent || used >= b.settings.directQuestions) fx["askRefused"] = `${ask.to}`;
              else if (!this.#present(rec).includes(target)) { fx["askSkipped"] = target; fx["askEntry"] = await this.#say(recordId, unit, "skip", chair ?? item!.agent, `${item!.agent}'s question to ${target} is skipped: absent (recorded).`); }
              else { fx["askTo"] = target; fx["askQuestion"] = ask.text; fx["askEntry"] = await this.#say(recordId, unit, "q", item!.agent, `To ${target}: ${recordText(ask.text, 500)}`); }
            }
          }
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
          const vote = b.vote;
          const holding = vote !== undefined && vote.opened && vote.closed !== true;
          fx["held"] = holding;
          fx["text"] = recordText(text, FLOOR_LIMITS.text);
          fx["completed"] = completed; fx["proposed"] = proposed; fx["stale"] = stale; fx["invest"] = invest;
          // During an open vote the answer goes to the owner at once (the floor view) and into the transcript only when the vote closes.
          fx["entryId"] = holding ? undefined : await this.#say(recordId, unit, "a", item!.agent, `(to the owner) ${recordText(text, FLOOR_LIMITS.text - 20)}`);
          if (holding) await notice("held-answer", `${item!.agent}'s answer to your question is kept out of the other voters' view until the vote closes.`);
          break;
        }
        case "revision": {
          const q = b.queue.find((x) => x.id === unit.queueId);
          const v = b.vote;
          const voter = await this.#voterPrincipal(item!.agent);
          if (q === undefined || v === undefined || item!.noResponse !== undefined || voter === undefined) break;
          const parsed = parseVote(item!.text);
          const old = await this.#ownBallot(b, item!.agent);
          const value = parsed.value ?? (old?.value as "yes" | "no" | "abstain" | undefined);
          if (value === undefined) break;
          await this.#deps.records.castBallot(voter, { commandId: `fl-${base(recordId)}-${unit.id}-rev`, motionId: v.motionId, version: v.version, value, reason: recordText(parsed.reason === "" ? `${value === old?.value ? "keeping" : "revising"} my ballot after the owner's questions` : parsed.reason, 480), ownerMessageEntryId: q.entryId! } as never);
          fx["revised"] = true;
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
            made.push({ id, to: o["to"]!, topic: recordText(o["topic"]!, 300), experienceSought: recordText(o["experience_sought"]!, 300), askedBy: "chair", why: `fact-finding question after comment round ${b.round}`, round: b.round, state: present ? "asked" : "skipped", ...(entryId === undefined ? {} : { entryId }) });
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
          if (/CONTRADICTS:\s*yes/i.test(item!.text) && b.vote?.opened === true && b.vote.closed !== true) await notice("correction-during-vote", `${item!.agent}'s correction contradicts what the chair relayed from its desk while the vote is open.`);
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
          if (lines.length > 0 && chair !== undefined) await this.#say(recordId, unit, "l", chair, unit.kind === "chair-summary" ? `Chair's summary of round ${b.round}:\n${lines.join("\n")}` : lines.join("\n"));
          fx["lines"] = lines.length;
          break;
        }
        case "objection": {
          const results = reply.items.map((it) => ({ agent: it.agent, noResponse: it.noResponse, ...parseObjection(it.text, b.settings.tabling) }));
          for (const r of results) if (r.noResponse === undefined && (r.answer === "yes" || r.answer === "research")) await this.#say(recordId, unit, `o-${r.agent}`, r.agent, `${r.answer === "research" ? "Needs time to research" : "Objection"}: ${r.reason === "" ? "(no reason given)" : r.reason}`);
          fx["results"] = results;
          break;
        }
        case "chair-ruling": {
          const text = item?.text ?? "";
          const motion = await this.#motionText(b);
          const table = /RULING:\s*table/i.test(text) && b.objection.objectors.some((o) => o.research === true);
          const amend = /RULING:\s*amend/i.test(text) && b.objection.attempt < b.settings.objectionReruns;
          const reason = /REASON:\s*([^\n]+)/i.exec(text)?.[1]?.trim();
          if (table) {
            const research = [...text.matchAll(/RESEARCH:\s*([^\n]+)/gi)].map((m) => recordText(m[1]!, 300));
            await this.#deps.records.table(this.#deps.service, { commandId: `fl-${base(recordId)}-${unit.id}-tb`, motionId: b.motionId!, reason: `members asked for time to research: ${research.join(" | ") || "unspecified"}` });
            fx["table"] = research;
          } else if (amend) {
            const to = /AMENDED_MOTION:\s*([\s\S]*?)(?:\n\s*REASON:|$)/i.exec(text)?.[1]?.trim();
            if (to !== undefined && to !== "" && motion !== undefined && to !== motion.text) {
              await this.#deps.records.amend(this.#deps.service, { commandId: `fl-${base(recordId)}-${unit.id}-am`, motionId: b.motionId!, expectedVersion: motion.version, text: recordText(to, 3000), material: true });
              fx["amended"] = true;
            }
          } else if (b.objection.objectors.length > 0 && b.objection.attempt >= b.settings.objectionReruns) {
            await this.#say(recordId, unit, "dissent", chair ?? item!.agent, `Rerun limit reached; proceeding to the vote. Remaining objections are recorded as dissent: ${b.objection.objectors.map((o) => `${o.agent} (${o.reason || "no reason given"})`).join("; ")}.`);
          }
          if (chair !== undefined) await this.#say(recordId, unit, "ruling", chair, `Chair's ruling: ${table ? "motion tabled" : fx["amended"] === true ? "motion amended" : "proceed to the vote"}${reason === undefined ? "" : ` — ${reason}`}`);
          break;
        }
        case "chair-match": {
          const text = item?.text ?? "";
          const motion = await this.#motionText(b);
          const to = /AMENDED_MOTION:\s*([\s\S]*?)(?:\n\s*REASON:|$)/i.exec(text)?.[1]?.trim();
          if (/MATCHES:\s*no/i.test(text) && to !== undefined && !/^none\.?$/i.test(to) && motion !== undefined && to !== motion.text && b.objection.attempt < b.settings.objectionReruns) {
            await this.#deps.records.amend(this.#deps.service, { commandId: `fl-${base(recordId)}-${unit.id}-am`, motionId: b.motionId!, expectedVersion: motion.version, text: recordText(to, 3000), material: true });
            fx["amended"] = true;
            if (chair !== undefined) await this.#say(recordId, unit, "ruling", chair, "Chair's check before the ballots: the motion did not match where the discussion landed and was amended; a fresh round and vote follow.");
          } else if (chair !== undefined) await this.#say(recordId, unit, "ruling", chair, "Chair's check before the ballots: the motion matches where the discussion landed.");
          break;
        }
        case "open-vote": {
          const motion = await this.#motionText(b);
          if (motion === undefined) throw new DomainError("invalid_command", "there is no motion to vote on");
          await this.#deps.records.openVote(this.#deps.service, { commandId: `fl-${base(recordId)}-${unit.id}-ov`, motionId: b.motionId!, expectedVersion: motion.version });
          fx["version"] = motion.version;
          break;
        }
        case "ballot": {
          const v = b.vote!;
          const voter = await this.#voterPrincipal(item!.agent);
          const parsed = parseVote(item!.text);
          if (item!.noResponse !== undefined || voter === undefined || parsed.value === undefined) { fx["noResponse"] = item!.noResponse ?? (voter === undefined ? "the agent has no credential" : "no valid ballot in the answer"); break; }
          fx["seq"] = rec.nextSeq;
          await this.#deps.records.castBallot(voter, { commandId: `fl-${base(recordId)}-${unit.id}-b`, motionId: v.motionId, version: v.version, value: parsed.value, reason: recordText(parsed.reason === "" ? `${parsed.value} (no reason given)` : parsed.reason, 480) } as never);
          fx["cast"] = parsed.value;
          break;
        }
        case "close-vote": {
          const v = b.vote!;
          let closed: { state: string; decisionId?: string };
          try { closed = await this.#deps.records.closeVote(this.#deps.service, { commandId: `fl-${base(recordId)}-${unit.id}-cl`, motionId: v.motionId }); }
          catch (error) { if (error instanceof DomainError && error.code === "invalid_command") throw new Wait("vote-time", error.message); throw error; }
          fx["state"] = closed.state; fx["decisionId"] = closed.decisionId;
          if (closed.state !== "tie-pending") { let n = 0; for (const h of b.held) { await this.#say(recordId, unit, `h${n}`, h.agent, `(answer to the owner, released now that the vote has closed) ${h.text}`); n += 1; } }
          break;
        }
        case "casting": {
          const v = b.vote!;
          const chairP = chair === undefined ? undefined : await this.#voterPrincipal(chair);
          const parsed = parseVote(item!.text);
          if (chairP === undefined || item!.noResponse !== undefined || (parsed.value !== "yes" && parsed.value !== "no")) { fx["noAnswer"] = true; break; }
          const closed = await this.#deps.records.castingVote(chairP, { commandId: `fl-${base(recordId)}-${unit.id}-cv`, motionId: v.motionId, value: parsed.value, reason: recordText(parsed.reason === "" ? `${parsed.value} (casting vote)` : parsed.reason, 480) });
          fx["state"] = closed.state; fx["decisionId"] = closed.decisionId;
          let n = 0; for (const h of b.held) { await this.#say(recordId, unit, `h${n}`, h.agent, `(answer to the owner, released now that the vote has closed) ${h.text}`); n += 1; }
          break;
        }
        case "wrap-up": {
          const reason = this.#timeboxed(b, this.#runner.now()) ?? "time";
          const m = b.motionId === undefined ? undefined : ((await this.#deps.records.motion(this.#deps.service, b.motionId)) as unknown as MotionBody | undefined);
          if (m?.state === "proposed") { await this.#deps.records.table(this.#deps.service, { commandId: `fl-${base(recordId)}-${unit.id}-tb`, motionId: b.motionId!, reason: `the meeting's ${reason === "time" ? "time" : "model-spend"} timebox ended before the vote; the rest is follow-up work` }); fx["tabled"] = true; }
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
  #betweenSteps(b: FloorBody, rec: RecordBody, n: number): string[] {
    if (rec.chair === undefined) return [];
    const steps: string[] = [];
    if (n === 1 && b.settings.chairNotes === "once") steps.push("chair-notes");
    if (b.settings.chairQuestionCap - b.chairQuestionsAsked > 0) steps.push("chair-questions");
    if (n === 1 && this.#absent(rec).length > 0 && this.#deps.deskReads !== undefined) steps.push("desk-offer");
    if (n === 1) steps.push("chair-summary");
    else if (usesFacts(b.settings.transcriptMode, this.#present(rec).length, b.settings.factsAboveMembers) && b.settings.chairReminders > 0) steps.push("chair-reminders");
    return steps;
  }

  /** The round is over: between-round steps, or on to the objection check after the last round. */
  #roundOver(b: FloorBody, rec: RecordBody): FloorBody {
    const todo = this.#betweenSteps(b, rec, b.round);
    return todo.length > 0 ? { ...b, phase: "between", todo } : this.#afterBetween(b, rec);
  }

  #afterBetween(b: FloorBody, rec: RecordBody): FloorBody {
    const last = b.fresh ? b.round : b.settings.commentRounds;
    if (!b.fresh && b.round < b.settings.commentRounds) return this.#beginRound({ ...b, todo: [] }, rec, b.round + 1, false);
    void last;
    return { ...b, phase: "objection", todo: [], objection: { attempt: b.objection.attempt, objectors: [], noResponse: [] } };
  }

  /** After a material amendment a fresh round (and then a fresh objection check and vote) follows, or the objection check runs again at once. */
  #restart(b: FloorBody, rec: RecordBody, version: number): FloorBody {
    const attempt = b.objection.attempt + 1;
    const next: FloorBody = { ...b, motionVersion: version, vote: undefined, amendments: [], objection: { attempt, objectors: [], noResponse: [] } };
    return b.settings.freshRoundAfterAmendment ? this.#beginRound({ ...next, round: b.round }, rec, b.round + 1, true) : { ...next, phase: "objection", todo: [] };
  }

  #reduce(b: FloorBody, rec: RecordBody, unit: Inflight, reply: StoredReply, fx: Record<string, unknown>): FloorBody {
    const now = this.#runner.now();
    const owner = unit.owner === true;
    // every unit: spend, turn log, claim cleared
    let usd = b.spend.usd, tokens = b.spend.tokens, hidden = b.spend.hiddenTokens, ownerUsd = b.spend.ownerUsd, ownerTokens = b.spend.ownerTokens, calls = b.spend.calls;
    const logs: TurnLog[] = [];
    let deliveries = b.deliveries;
    const kindOf: Record<UnitKind, TurnLog["kind"]> = {
      "round-blind": "blind-statement", "round-turn": "statement", "direct-answer": "direct-answer", "direct-continue": "direct-continue", "chair-answer": "chair-answer", reply: "reply", "owner-ask": "owner-answer", revision: "revision",
      "chair-notes": "chair-notes", "chair-questions": "chair-questions", "desk-offer": "desk-offer", "desk-excerpts": "desk-excerpts", correction: "correction", "chair-summary": "chair-summary", "chair-reminders": "chair-reminders",
      objection: "objection", "chair-ruling": "chair-ruling", "chair-match": "chair-match", "open-vote": "ballot", ballot: "ballot", "close-vote": "ballot", casting: "casting", "wrap-up": "chair-ruling",
    };
    const share = reply.items.length === 0 ? 0 : reply.costUsd / reply.items.length;
    for (const it of reply.items) {
      if (it.usage.visible === 0 && it.usage.hidden === 0 && it.usage.input === 0 && it.noResponse === undefined) continue;
      const t = it.usage.input + it.usage.visible + it.usage.hidden;
      if (owner) { ownerUsd += share; ownerTokens += t; } else { usd += share; tokens += t; }
      hidden += it.usage.hidden; calls += 1;
      if (it.deliveredUpTo >= 0) deliveries += 1;
      logs.push({ unit: unit.id, kind: owner && unit.kind === "owner-ask" ? "owner-answer" : kindOf[unit.kind], agent: it.agent, at: now, visibleTokens: it.usage.visible, hiddenTokens: it.usage.hidden, deliveredUpTo: it.deliveredUpTo, ...(it.truncated === true ? { truncated: true as const } : {}), ...(it.hiddenOver === true ? { hiddenOver: true as const } : {}), ...(it.noResponse === undefined ? {} : { noResponse: it.noResponse }) });
    }
    const notices: { at: string; kind: string; text: string }[] = [];
    for (const it of reply.items) if (it.noResponse !== undefined) notices.push({ at: now, kind: "no-response", text: `${it.agent} gave no answer (${it.noResponse}) in ${unit.kind}` });
    let n: FloorBody = {
      ...b, inflight: undefined, waitingTool: undefined, spend: { ...b.spend, usd, tokens, hiddenTokens: hidden, ownerUsd, ownerTokens, calls }, turns: [...b.turns, ...logs], deliveries, notices: [...b.notices, ...notices],
    };
    const dropQueue = (): FloorBody => ({ ...n, queue: n.queue.filter((q) => q.id !== unit.queueId) });
    const statements = (fx["statements"] ?? {}) as Record<string, { entryId: string; parsed: ReturnType<typeof parseStatement> }>;
    const note = (round: number, agent: string, stance: string, base0: FloorBody): FloorBody => ({ ...base0, stances: { ...base0.stances, [String(round)]: { ...(base0.stances[String(round)] ?? {}), [agent]: stance } } });
    const withStatement = (base0: FloorBody): FloorBody => {
      let r = base0;
      for (const [agent, s] of Object.entries(statements)) {
        if (s.parsed.summary !== undefined) r = { ...r, summaries: { ...r.summaries, [s.entryId]: s.parsed.summary } };
        if (s.parsed.amend !== undefined && r.amendments.length < FLOOR_LIMITS.amendments) r = { ...r, amendments: [...r.amendments, { by: agent, text: recordText(s.parsed.amend, 500), round: r.round, entryId: s.entryId }] };
        r = note(r.round, agent, s.parsed.stance, r);
      }
      return r;
    };
    switch (unit.kind) {
      case "round-blind": {
        n = withStatement(n);
        n = { ...n, spoken: n.order, turn: n.order.length };
        return this.#roundOver(n, rec);
      }
      case "round-turn": {
        n = withStatement(n);
        const agent = unit.agent!;
        let order = [...n.order]; let turn = n.turn;
        if (!order.includes(agent)) { order = [...order.slice(0, turn), agent, ...order.slice(turn)]; turn += 1; } else turn += 1;
        n = { ...n, order, turn, spoken: [...n.spoken, agent] };
        const queue = [...n.queue];
        if (typeof fx["askTo"] === "string") {
          const key = `${n.round}:${agent}`;
          n = { ...n, asks: { ...n.asks, [key]: (n.asks[key] ?? 0) + 1 } };
          const id = `dq${n.unitSeq}`;
          queue.push({ id: `${id}a`, kind: "direct-answer", agent: fx["askTo"] as string, from: agent, question: fx["askQuestion"] as string, entryId: fx["askEntry"] as string }, { id: `${id}c`, kind: "direct-continue", agent, from: fx["askTo"] as string });
        } else if (typeof fx["askSkipped"] === "string") n = { ...n, skipped: [...n.skipped, { agent: fx["askSkipped"] as string, why: `a direct question from ${agent} was skipped: absent`, at: now }] };
        if (n.settings.chairNotes === "rolling" && rec.chair !== undefined && statements[agent] !== undefined) queue.push({ id: `cn${n.unitSeq}`, kind: "chair-notes", agent: rec.chair });
        n = { ...n, queue };
        const joiner = this.#present(rec).find((a) => !n.order.includes(a));
        return n.turn >= n.order.length && joiner === undefined ? this.#roundOver(n, rec) : n;
      }
      case "direct-answer": case "direct-continue": case "chair-answer": case "reply": {
        n = withStatement(dropQueue());
        if (unit.kind === "chair-answer") n = { ...n, chairQuestions: n.chairQuestions.map((c) => (c.id === b.queue.find((x) => x.id === unit.queueId)?.chairQuestionId ? { ...c, state: "answered" as const, ...(statements[unit.agent!] === undefined ? {} : { answerEntryId: statements[unit.agent!]!.entryId }) } : c)) };
        return n;
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
      case "revision": {
        n = dropQueue();
        if (n.vote !== undefined && fx["revised"] === true) n = { ...n, vote: { ...n.vote, revisions: { ...n.vote.revisions, [unit.agent!]: (n.vote.revisions[unit.agent!] ?? 0) + 1 } } };
        return n;
      }
      case "chair-notes": {
        n = unit.queueId === undefined ? n : dropQueue();
        const text = reply.items[0]?.noResponse === undefined ? recordText(reply.items[0]!.text, 3000) : undefined;
        n = { ...n, todo: n.phase === "between" && n.todo[0] === "chair-notes" ? n.todo.slice(1) : n.todo, ...(text === undefined ? {} : { chairNotes: text, chairNotesAt: now, chairNotesCount: n.chairNotesCount + 1 }) };
        return n.phase === "between" && n.todo.length === 0 ? this.#afterBetween(n, rec) : n;
      }
      case "chair-questions": {
        const made = (fx["questions"] as ChairQuestionRecord[] | undefined) ?? [];
        const queue = [...n.queue];
        for (const c of made) if (c.state === "asked") queue.push({ id: `cqa-${c.id}`, kind: "chair-answer", agent: c.to, chairQuestionId: c.id });
        if (made.length > 0 && n.round >= n.settings.commentRounds && !n.fresh) for (const a of this.#present(rec)) queue.push({ id: `rp-${n.unitSeq}-${a.slice(-8)}`, kind: "reply", agent: a });
        n = { ...n, notices: [...n.notices, ...((fx["refused"] as string[] | undefined) ?? []).map((text) => ({ at: now, kind: "chair-question-refused", text: recordText(text, 200) }))], chairQuestions: [...n.chairQuestions, ...made], chairQuestionsAsked: n.chairQuestionsAsked + made.length, queue, todo: n.todo.slice(1), skipped: [...n.skipped, ...made.filter((c) => c.state === "skipped").map((c) => ({ agent: c.to, why: "a chair question was skipped: absent", at: now }))] };
        return n.todo.length === 0 ? this.#afterBetween(n, rec) : n;
      }
      case "desk-offer": {
        const read = (fx["read"] as string[] | undefined) ?? [];
        const pending = (fx["pending"] as FloorBody["desk"]["pending"] | undefined) ?? [];
        n = { ...n, todo: n.todo.slice(1), desk: { ...n.desk, offered: (fx["offered"] as FloorBody["desk"]["offered"] | undefined) ?? [], filesRead: [...n.desk.filesRead, ...read], refused: [...n.desk.refused, ...((fx["refused"] as { id: string; why: string }[] | undefined) ?? [])], pending, readOwners: [...new Set([...n.desk.readOwners, ...pending.map((p) => p.owner)])] } };
        if (pending.length > 0) n = { ...n, todo: ["desk-excerpts", ...n.todo] };
        return n.todo.length === 0 ? this.#afterBetween(n, rec) : n;
      }
      case "desk-excerpts": {
        n = { ...n, todo: n.todo.slice(1), desk: { ...n.desk, filesQuoted: [...new Set([...n.desk.filesQuoted, ...((fx["quoted"] as string[] | undefined) ?? [])])], rejectedExcerpts: n.desk.rejectedExcerpts + ((fx["rejected"] as number | undefined) ?? 0), pending: [] } };
        return n.todo.length === 0 ? this.#afterBetween(n, rec) : n;
      }
      case "correction": {
        n = { ...n, desk: { ...n.desk, corrections: [...n.desk.corrections, { member: unit.agent!, entryId: (fx["entryId"] as string | undefined) ?? "none" }] } };
        return n;
      }
      case "chair-summary": case "chair-reminders": {
        n = { ...n, todo: n.todo.slice(1) };
        return n.todo.length === 0 ? this.#afterBetween(n, rec) : n;
      }
      case "objection": {
        const results = (fx["results"] as { agent: string; noResponse?: string; answer?: string; reason: string }[] | undefined) ?? [];
        const objectors = results.filter((r) => r.noResponse === undefined && (r.answer === "yes" || r.answer === "research")).map((r) => ({ agent: r.agent, reason: recordText(r.reason, 300), ...(r.answer === "research" ? { research: true as const } : {}) }));
        n = { ...n, objection: { attempt: n.objection.attempt, objectors, noResponse: results.filter((r) => r.noResponse !== undefined).map((r) => r.agent) } };
        if (objectors.length === 0) return rec.chair === undefined ? { ...n, phase: "vote" } : { ...n, phase: "match" };
        return rec.chair === undefined ? { ...n, phase: "vote" } : { ...n, phase: "ruling" };
      }
      case "chair-ruling": {
        if (Array.isArray(fx["table"])) {
          const research = fx["table"] as string[];
          const items = research.length === 0 ? [{ text: "research asked for before voting (tabled)", by: "chair" }] : research.map((line) => { const m = /^(agent:[a-z0-9][a-z0-9-]{0,39})\s*:\s*([\s\S]+)$/.exec(line); return m === null ? { text: line, by: "chair" } : { text: m[2]!, by: m[1]! }; });
          return { ...n, phase: "done", investigations: [...n.investigations, ...items].slice(-FLOOR_LIMITS.investigations) };
        }
        if (fx["amended"] === true) return this.#restart(n, rec, (n.motionVersion ?? 1) + 1);
        return { ...n, phase: "match" };
      }
      case "chair-match": return fx["amended"] === true ? this.#restart(n, rec, (n.motionVersion ?? 1) + 1) : { ...n, phase: "vote" };
      case "open-vote": return { ...n, phase: "vote", motionVersion: (fx["version"] as number | undefined) ?? n.motionVersion, vote: { motionId: n.motionId!, version: (fx["version"] as number) ?? 1, order: this.#present(rec), opened: true, cast: {}, noResponse: [], revisions: {} } };
      case "ballot": {
        const v = n.vote!;
        const agent = unit.agent!;
        return { ...n, vote: typeof fx["cast"] === "string" ? { ...v, cast: { ...v.cast, [agent]: (fx["seq"] as number | undefined) ?? 0 } } : { ...v, noResponse: [...v.noResponse, agent] } };
      }
      case "close-vote": {
        const v = n.vote!;
        const state = fx["state"] as string;
        const echo = this.#echo(n);
        if (state === "tie-pending") return { ...n, vote: { ...v, closed: true, tie: true }, held: n.held };
        return { ...n, phase: "done", held: [], vote: { ...v, closed: true, ...(typeof fx["decisionId"] === "string" ? { decisionId: fx["decisionId"] } : {}) }, ...(echo === undefined ? {} : { echo }) };
      }
      case "casting": {
        const v = n.vote!;
        if (fx["noAnswer"] === true) return { ...n, vote: { ...v, castingAsked: true } };
        return { ...n, phase: "done", held: [], vote: { ...v, tie: true, ...(typeof fx["decisionId"] === "string" ? { decisionId: fx["decisionId"] } : {}), castingAsked: true } };
      }
      case "wrap-up": {
        const reason = ((fx["reason"] as string | undefined) ?? "time") as "time" | "spend";
        const hasVote = n.vote !== undefined && n.vote.opened && n.vote.closed !== true;
        return { ...n, timebox: { reason, at: now }, phase: hasVote ? n.phase : "done", queue: n.queue.filter((q) => q.kind === "owner-ask" || q.kind === "revision" && false) };
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

  /** Queues a revision turn (keep or revise, with a reason) for every voter who cast before the owner message `trigger`, within the voter's maximum; at most one per voter per message. */
  async #offerRevisions(by: Principal, recordId: string, trigger: string, seq: number): Promise<number> {
    let queued = 0;
    await this.#update(recordId, by, `rev-${trigger}`, (b) => {
      const v = b.vote;
      if (v === undefined || !v.opened || v.closed === true || b.timebox !== undefined) return undefined;
      const queue = [...b.queue]; const offered = [...(v.offered ?? [])];
      queued = 0;
      for (const [agent, castSeq] of Object.entries(v.cast)) {
        const key = `${trigger}:${agent}`;
        if (seq < castSeq || offered.includes(key) || (v.revisions[agent] ?? 0) + queue.filter((q) => q.kind === "revision" && q.agent === agent).length >= b.settings.maxRevisionsPerVoter) continue;
        offered.push(key);
        queue.push({ id: `rv-${hash(trigger)}-${agent.slice(-8)}`, kind: "revision", agent, entryId: trigger });
        queued += 1;
      }
      return queued === 0 ? undefined : { ...b, queue, vote: { ...v, offered, trigger } };
    });
    return queued;
  }

  /**
   * The owner asks one agent a question. It goes into the transcript as the owner's message; the agent is given the floor at the next safe boundary (after the turn being answered, which is not undone) and answers; the answer is in the
   * transcript at once, or - while a vote is open - held and shown to the owner only until the vote closes. A voter who cast before the question is offered one short revision turn. A member who is not in the room is answered from its
   * saved checkpoint, stamped as not live; nobody outside the roster is ever brought in. The meeting's turn limit and timebox do not apply; the spend is recorded, and a budget that is reached is reported to the owner.
   */
  async ask(by: Principal, command: NoActor & { recordId: string; agent: string; question: string }): Promise<{ entryId: string; answered: boolean; queued: boolean; checkpoint?: true; blocked?: string }> {
    onlyKnown(command, ["commandId", "recordId", "agent", "question"]);
    this.#ownerOnly(by, "ask a meeting member a question");
    const { recordId, rec } = await this.#open(command.recordId);
    const agent = typeof command.agent === "string" && AGENT.test(command.agent) ? command.agent : invalid("agent", "is not an agent");
    const question = typeof command.question === "string" && command.question.trim() !== "" ? recordText(command.question, 1500) : invalid("question", "must say what to ask");
    const f = await this.#need(recordId);
    const present = this.#present(rec).includes(agent) || agent === rec.chair;
    if (!rec.roster.includes(agent) && agent !== rec.chair) invalid("agent", "is not in this meeting's roster; nobody outside the roster is brought in");
    const checkpoint = !present;
    if (checkpoint && (!f.body.settings.checkpointAnswers || this.#deps.checkpointOf === undefined)) throw new DomainError("invalid_command", `${agent} is not in the room, and answers from checkpoints are off`, { field: "agent" });
    const msg = await this.#ownerMessage(by, recordId, `fl-ask-${base(recordId)}-${hash(by.id, command.commandId)}`, `Question to ${agent}: ${question}`);
    if (f.body.ownerAnswers.some((a) => a.entryId === msg.id)) return { entryId: msg.id, answered: true, queued: false, ...(checkpoint ? { checkpoint: true as const } : {}) };
    const now = this.#runner.now();
    const item: QueueItem = { id: `oa-${hash(by.id, command.commandId)}`, kind: "owner-ask", agent, entryId: msg.id, question, ...(checkpoint ? { checkpoint: true as const } : {}) };
    await this.#update(recordId, by, `ask-${item.id}`, (b) => (b.queue.some((q) => q.id === item.id) ? undefined : { ...b, queue: [...b.queue, item], ...(b.inquiry === undefined ? {} : { inquiry: { ...b.inquiry, lastActivityAt: now, messages: [...b.inquiry.messages, msg.id].slice(-50), addressed: [...new Set([...b.inquiry.addressed, agent])], remindedAt: undefined } }) }));
    if (f.body.inquiry !== undefined && !checkpoint) await this.#deps.work?.recall(recordId, agent).catch(() => undefined);
    if (f.body.inquiry === undefined) await this.#offerRevisions(by, recordId, msg.id, msg.seq);
    // at a safe boundary: now, when no turn is being answered; otherwise the next advance takes it first
    const r = await this.#advance(by, recordId, rec, true).catch(() => undefined);
    const after = await this.#need(recordId);
    const answered = after.body.ownerAnswers.some((a) => a.entryId === msg.id);
    const queued = after.body.queue.some((q) => q.id === item.id);
    const blocked = !answered && !queued ? after.body.notices.at(-1)?.text : undefined;
    void r;
    return { entryId: msg.id, answered, queued, ...(checkpoint ? { checkpoint: true as const } : {}), ...(blocked === undefined ? {} : { blocked }) };
  }

  /**
   * The owner speaks to the whole meeting. The words go into the transcript; nobody is given the floor by it (the baton rule): each member receives them with the floor it is next given, a voter who has not yet cast with its
   * ballot request, and a voter who cast before is offered one revision turn. With `agent` that agent is given the floor to answer (as `ask`). With `amend` the owner's words materially amend the motion: a fresh round and a fresh vote follow
   * and no revision is offered (an owner alternative to the decision itself is a separate record, not a ballot).
   */
  async address(by: Principal, command: NoActor & { recordId: string; text: string; agent?: string; amend?: { text: string } }): Promise<{ entryId: string; restarted?: true; revisionsOffered: number }> {
    onlyKnown(command, ["commandId", "recordId", "text", "agent", "amend"]);
    this.#ownerOnly(by, "address the meeting");
    const { recordId, rec } = await this.#open(command.recordId);
    const text = typeof command.text === "string" && command.text.trim() !== "" ? recordText(command.text, 3000) : invalid("text", "must say something");
    if (command.agent !== undefined) {
      const r = await this.ask(by, { commandId: command.commandId, recordId, agent: command.agent, question: text });
      return { entryId: r.entryId, revisionsOffered: 0 };
    }
    const f = await this.#need(recordId);
    const msg = await this.#ownerMessage(by, recordId, `fl-adr-${base(recordId)}-${hash(by.id, command.commandId)}`, text);
    if (command.amend !== undefined) {
      const amendText = typeof command.amend.text === "string" && command.amend.text.trim() !== "" ? recordText(command.amend.text, 3000) : invalid("amend", "needs the new wording");
      if (f.body.motionId === undefined) invalid("amend", "there is no motion on the floor");
      const m = await this.#motionText(f.body);
      if (m === undefined) invalid("amend", "there is no motion on the floor");
      const held = f.body.vote?.opened === true && f.body.vote.closed !== true && f.body.inquiry?.voteHeld === true;
      void held;
      await this.#deps.records.amend(this.#deps.service, { commandId: `fl-am-${base(recordId)}-${hash(by.id, command.commandId)}`, motionId: f.body.motionId!, expectedVersion: m!.version, text: amendText, material: true });
      const rec2 = await this.#meeting(recordId);
      await this.#update(recordId, by, `owner-amend-${msg.id}`, (b) => (b.motionVersion === m!.version + 1 ? undefined : { ...this.#restart({ ...b, queue: b.queue.filter((q) => q.kind !== "revision") }, rec2, m!.version + 1), ...(b.inquiry === undefined ? {} : {}) }));
      // a held vote is no longer there to hold: the motion is back to proposed
      return { entryId: msg.id, restarted: true, revisionsOffered: 0 };
    }
    let offered = 0;
    if (f.body.inquiry === undefined) offered = await this.#offerRevisions(by, recordId, msg.id, msg.seq);
    else await this.#update(recordId, by, `inq-msg-${msg.id}`, (b) => (b.inquiry === undefined ? undefined : { ...b, inquiry: { ...b.inquiry, lastActivityAt: this.#runner.now(), messages: [...b.inquiry.messages, msg.id].slice(-50), remindedAt: undefined } }));
    void rec;
    return { entryId: msg.id, revisionsOffered: offered };
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
    const v = f.body.vote;
    const open = v !== undefined && v.opened && v.closed !== true;
    if (open) await this.#deps.records.hold(this.#deps.service, { commandId: `fl-hold-${base(recordId)}-${hash(by.id, command.commandId)}`, motionId: v.motionId });
    const msg = await this.#ownerMessage(by, recordId, `fl-inq-${base(recordId)}-${hash(by.id, command.commandId)}`, `The owner opens an inquiry: the meeting clock and turn limits stop${open ? " and the vote is held" : ""} until the owner ends it.`);
    const now = this.#runner.now();
    await this.#update(recordId, by, `inq-open-${msg.id}`, (b) => (b.inquiry !== undefined ? undefined : { ...b, clock: { ...b.clock, pausedAt: now }, inquiry: { openedAt: now, lastActivityAt: now, questions: 0, voteHeld: open, addressed: [], messages: [msg.id] } }));
    await this.#deps.work?.release(recordId, this.#present(rec)).catch(() => undefined);
    await this.#deps.notifyOwner?.({ recordId, kind: "inquiry-open", text: "An owner inquiry is open on a meeting; it waits for you to say you are done with questions." }).catch(() => undefined);
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
    const v = f.body.vote;
    if (inq.voteHeld && v !== undefined) await this.#deps.records.resume(this.#deps.service, { commandId: `fl-resume-${base(recordId)}-${hash(by.id, command.commandId)}`, motionId: v.motionId });
    const msg = await this.#ownerMessage(by, recordId, `fl-end-${base(recordId)}-${hash(by.id, command.commandId)}`, "That is all my questions; carry on.");
    const now = this.#runner.now();
    await this.#update(recordId, by, `inq-end-${msg.id}`, (b) => (b.inquiry === undefined ? undefined : { ...b, inquiry: undefined, clock: { ...b.clock, pausedMs: b.clock.pausedMs + (b.clock.pausedAt === undefined ? 0 : Math.max(0, ms(now) - ms(b.clock.pausedAt))), pausedAt: undefined } }));
    const offered = inq.voteHeld ? await this.#offerRevisions(by, recordId, msg.id, msg.seq) : 0;
    return { revisionsOffered: offered, replayed: false };
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
    await this.#ownerMessage(by, recordId, `fl-pri-${base(recordId)}-${hash(by.id, command.commandId)}`, `The owner changes the priorities: ${items.map((i) => `${i.itemId} is ${i.urgency}`).join("; ")}.`);
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
    if (f.body.vote?.opened === true || f.body.phase === "vote" || f.body.phase === "done") throw new DomainError("invalid_command", "chair questions are not put once the vote has opened", { field: "recordId" });
    if (f.body.chairQuestionsAsked >= f.body.settings.chairQuestionCap) throw new DomainError("invalid_command", `the cap of ${f.body.settings.chairQuestionCap} chair questions for this motion is used`, { field: "recordId" });
    const why = chairQuestionRefusal({ to: command.to, topic: command.topic, experience_sought: command.experienceSought });
    if (why !== undefined) invalid("topic", why);
    if (!rec.roster.includes(command.to)) invalid("to", "is not on this meeting's roster");
    const id = `cq${f.body.chairQuestions.length + 1}-${hash(by.id, command.commandId).slice(0, 6)}`;
    const present = this.#present(rec).includes(command.to);
    const entryId = await this.#deps.records.append(this.#deps.service, { commandId: `fl-rq-${base(recordId)}-${hash(by.id, command.commandId)}`, recordId, kind: "statement", speaker: rec.chair, text: present ? `Question to ${command.to}, at ${by.id}'s request: ${recordText(command.topic, 300)} (${recordText(command.experienceSought, 300)})` : `Question to ${command.to}, at ${by.id}'s request, skipped: absent (recorded).` });
    await this.#update(recordId, by, `rq-${id}`, (b) => {
      if (b.chairQuestions.some((c) => c.id === id) || b.chairQuestionsAsked >= b.settings.chairQuestionCap) return undefined;
      const q: ChairQuestionRecord = { id, to: command.to, topic: recordText(command.topic, 300), experienceSought: recordText(command.experienceSought, 300), askedBy: by.id, why: `asked of the chair by ${by.id}`, round: b.round, state: present ? "asked" : "skipped", entryId: entryId.id };
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
    await this.#deps.records.append(this.#deps.service, { commandId: `fl-rl-${base(recordId)}-${hash(by.id, command.commandId)}`, recordId, kind: "statement", speaker: rec.chair ?? by.id, text: `Ruling on the challenge to chair question ${q.id}: ${command.ruling}${by.kind === "owner" ? " (by the owner)" : ""}.` }).catch(async () => this.#ownerMessage(by, recordId, `fl-rl-${base(recordId)}-${hash(by.id, command.commandId)}`, `Ruling on the challenge to chair question ${q.id}: ${command.ruling}.`));
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
    f.body.investigations.forEach((i, n) => wanted.push({ key: `i:${n}:${hash(i.text).slice(0, 8)}`, title: `Investigate: ${recordText(i.text, 150)}`, why: `Deeper work than the meeting could do (${i.by}).`, ...(AGENT.test(i.by) ? { owner: i.by } : {}) }));
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
        await this.#deps.notifyOwner?.({ recordId: b.recordId, kind: "inquiry-idle", text: `Your inquiry on a meeting has been idle for ${b.settings.inquiryIdleMinutes} minutes; say when you are done with questions.` }).catch(() => undefined);
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
    const chair = viewer.kind === "agent" && rec.chair === viewer.id;
    const manager = this.#controls(viewer, rec.projectId);
    const common = { phase: b.phase, round: b.round, state: b.state, motionId: b.motionId, waiting: this.#waiting(b, rec, this.#runner.now()), timebox: b.timebox, inquiryOpen: b.inquiry !== undefined, queued: b.queue.length };
    if (!owner && !manager && !chair) return json(common) as unknown as Record<string, unknown>;
    const { inflight, chairNotes, held, ...rest } = b;
    void inflight;
    return {
      ...rest, ...common, spend: this.#spendView(b), elapsedMinutes: Math.round(this.#elapsedMs(b, this.#runner.now()) / 60_000), allowedMinutes: Math.round(this.#allowedMs(b) / 60_000),
      ...(owner || chair ? { chairNotes } : {}), ...(owner ? { held } : { heldCount: held.length }),
    };
  }

  #spendView(b: FloorBody): { usd: number; tokens: number; ownerUsd: number; ownerTokens: number; capUsd: number; capTokens: number } {
    return { usd: b.spend.usd, tokens: b.spend.tokens, ownerUsd: b.spend.ownerUsd, ownerTokens: b.spend.ownerTokens, capUsd: b.settings.spendCapUsd + b.spend.extraUsd, capTokens: b.settings.tokenCap + b.spend.extraTokens };
  }

  #waiting(b: FloorBody, rec: RecordBody, now: string): WaitingOn {
    if (b.state === "ended" || rec.state !== "open") return { kind: "nothing", what: "the meeting has ended" };
    if (b.inquiry !== undefined) return { kind: "person", who: "owner", what: "the owner's questions (inquiry open)", since: b.inquiry.openedAt };
    if (b.waitingTool !== undefined) return { kind: "tool", who: b.waitingTool.agent, what: b.waitingTool.tool, since: b.waitingTool.since };
    if (b.inflight !== undefined) return { kind: "agent", who: b.inflight.agent ?? b.inflight.agents?.[0] ?? "the members", what: b.inflight.kind, since: b.inflight.since };
    const plan = this.#plan(b, rec, now);
    if ("unit" in plan) return { kind: "agent", who: plan.unit.agent ?? plan.unit.agents?.[0] ?? "the members", what: plan.unit.kind, since: now };
    if (plan.wait === "vote-time") return { kind: "agent", who: "the voters", what: "the vote's time limit", since: now };
    if (plan.wait === "chair") return { kind: "agent", who: rec.chair ?? "the chair", what: plan.detail ?? "the chair", since: now };
    return { kind: "nothing", what: plan.detail ?? "nothing is waiting" };
  }

  /** What the meeting waits on right now: a person (the owner), an agent (who holds the floor or must answer) or a tool; or nothing. Seen by whoever may read the meeting. */
  async waiting(viewer: Principal, recordId: string): Promise<WaitingOn | undefined> {
    const rec = await this.#deps.records.record(viewer, recordId).catch(() => undefined);
    const f = rec === undefined ? undefined : await this.#load(recordId);
    return rec === undefined || f === undefined ? undefined : this.#waiting(f.body, rec, this.#runner.now());
  }

  /** The chair's private notes, kept in the meeting's records: for the owner and the chair only. */
  async chairNotes(viewer: Principal, recordId: string): Promise<{ notes?: string; at?: string; count: number } | undefined> {
    const rec = await this.#deps.records.record(viewer, recordId).catch(() => undefined);
    const f = rec === undefined ? undefined : await this.#load(recordId);
    if (rec === undefined || f === undefined) return undefined;
    const ok = (viewer.kind === "owner" && viewer.taskScope === undefined) || (viewer.kind === "agent" && rec.chair === viewer.id && viewer.asOf !== undefined);
    if (!ok) return undefined;
    return { ...(f.body.chairNotes === undefined ? {} : { notes: f.body.chairNotes }), ...(f.body.chairNotesAt === undefined ? {} : { at: f.body.chairNotesAt }), count: f.body.chairNotesCount };
  }

  /** The meeting looked like an echo: every first-round stance and every ballot was the same (the summary flags it; the experiments saw 45 of 46 votes unanimous). */
  #echo(b: FloorBody): boolean | undefined {
    const first = Object.values(b.stances["1"] ?? {});
    return first.length > 1 && first.every((s) => s === first[0]) && b.vote !== undefined && Object.keys(b.vote.cast).length > 1 ? true : undefined;
  }
}

/** A step that cannot be taken yet (a vote that cannot close before its time): not a failure. */
class Wait extends Error {
  readonly reason: "vote-time";
  constructor(reason: "vote-time", message: string) { super(message); this.reason = reason; }
}

/** Keeps every list on the floor inside its window (oldest dropped). */
function capped(b: FloorBody): FloorBody {
  const w = {
    ...b, turns: b.turns.slice(-FLOOR_LIMITS.turns), notices: b.notices.slice(-FLOOR_LIMITS.notices), held: b.held.slice(-FLOOR_LIMITS.heldAnswers), ownerAnswers: b.ownerAnswers.slice(-FLOOR_LIMITS.ownerAnswers),
    amendments: b.amendments.slice(-FLOOR_LIMITS.amendments), chairQuestions: b.chairQuestions.slice(-FLOOR_LIMITS.chairQuestions), investigations: b.investigations.slice(-FLOOR_LIMITS.investigations), followUps: b.followUps.slice(-FLOOR_LIMITS.followUps),
    queue: b.queue.slice(-FLOOR_LIMITS.queue),
  };
  // storage keeps JSON: a field that is undefined is simply absent
  return JSON.parse(JSON.stringify(w)) as FloorBody;
}
