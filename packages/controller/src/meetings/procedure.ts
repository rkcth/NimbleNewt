import type { Aggregate, ControllerStorage } from "../storage/types.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { inTaskScope } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import { redactText } from "../security/redact.js";
import type { NoActor, Principal } from "../security/principals.js";
import { clean, invalid, plain, whole } from "../standups/shared.js";
import type { MeetingRecordService } from "./record.js";
import { RECORD_LIMITS } from "./record.js";
import type { MotionBody, RecordBody, SourceCite } from "./record-types.js";
import { PROCEDURE_DEFAULTS, type ProcedureSettings } from "./procedure-settings.js";
import { looksLikeEcho, quotesBallot, roundSummary, seatOrder, type SeatTraits } from "./procedure-rules.js";
import { PROCEDURE_KIND, type FollowUp, type ObjectionAnswer, type ProcedureBody, type ProcedureStage } from "./procedure-types.js";
import type { BallotBody } from "./record-types.js";
import type { BallotValue } from "./votes.js";

export { PROCEDURE_KIND, noteOf, type ProcedureBody, type ProcedureStage, type ObjectionAnswer, type FollowUp } from "./procedure-types.js";
export { PROCEDURE_DEFAULTS, PROCEDURE_SETTINGS, PROCEDURE_SETTING_KEYS, type ProcedureSettings } from "./procedure-settings.js";
export { looksLikeEcho, quotesBallot, roundSummary, seatOrder, type SeatTraits } from "./procedure-rules.js";

/** One entry of the transcript as a member is given it: the whole meeting so far, never a ballot. */
export interface MeetingDelivered { readonly seq: number; readonly kind: string; readonly speaker: string; readonly text: string }
export interface MotionView { readonly id: string; readonly number: number; readonly version: number; readonly text: string }

/**
 * Every request names its meeting record (`recordId`) so the floor, which supplies the members, can find its own state for the meeting. A request carries only what the member may be given: the motion, the transcript (never a ballot),
 * the round summary for an objection check; never another voter's ballot and never who has voted.
 */
export interface CommentRequest { readonly agent: string; readonly recordId: string; readonly round: number; readonly rounds: number; /** 0 for the first pass; a fresh pass after a material amendment counts up. */ readonly fresh: number; readonly motion: MotionView; readonly transcript: readonly MeetingDelivered[]; /** From the second round on a member may check its own desk and bring what it finds. */ readonly deskCheck: boolean; /** The members still to be asked in this round, the asked one first (so a floor may ask the blind round in parallel). */ readonly seats: readonly string[] }
export interface ObjectionRequest { readonly agent: string; readonly recordId: string; readonly run: number; readonly fresh: number; readonly motion: MotionView; /** The summary of the comment rounds: all the member receives besides the motion. */ readonly summary: string; /** Whether a request for time to research is an answer this check offers (meeting.tabling). */ readonly tabling: boolean; /** The members still to be asked in this check, the asked one first. */ readonly seats: readonly string[] }
export interface BallotRequest { readonly agent: string; readonly recordId: string; readonly motion: MotionView; readonly transcript: readonly MeetingDelivered[] }
export interface RevisionRequest { readonly agent: string; readonly recordId: string; readonly motion: MotionView; readonly ballot: { readonly value: BallotValue; readonly reason: string }; readonly ownerMessage: MeetingDelivered; /** What was said since the member's ballot. */ readonly since: readonly MeetingDelivered[] }
export interface RulingRequest { readonly recordId: string; readonly motion: MotionView; readonly run: number; readonly canUphold: boolean; readonly canTable: boolean; readonly answers: readonly ObjectionAnswer[] }
/** The vote is tied; its counts stay unrevealed until it concludes (M02), so the chair is told only that it is tied. */
export interface CastingRequest { readonly recordId: string; readonly motion: MotionView; readonly castingDeadline?: string }
/** What the floor is asked before each step: whether it holds the motion back, or has work of its own to do first (the owner's questions, a chair question's answer). */
export interface GateRequest { readonly recordId: string; readonly motion: MotionView; readonly stage: ProcedureStage }
export type FloorGate = { readonly ran: string } | { readonly halt: "inquiry" | "time" | "spend"; readonly why: string } | undefined;
/** The work between two comment rounds (the chair's notes, questions, desk read and summary); one step each time it is asked, `done` when there is nothing more. A `summary` is what the objection check is given in place of the mechanical digest. */
export interface BetweenRequest { readonly recordId: string; readonly motion: MotionView; readonly round: number; readonly rounds: number; readonly fresh: number }
export interface BetweenResult { readonly done: boolean; readonly did?: string; readonly summary?: string }
/** A ballot or a revision the member answered while an inquiry then held the vote: the answer is set aside (its cost stays counted) and asked again when the vote resumes. */
export interface AsideRequest { readonly recordId: string; readonly motionId: string; readonly version: number; readonly kind: "ballot" | "revision"; readonly agent: string; /** For a revision turn: the owner message it answers. */ readonly ownerMessageSeq?: number }

/** Thrown by a floor when another driver is already asking the same member the same thing: the step waits, nothing is recorded. */
export class FloorBusy extends Error { constructor(message = "another driver is already asking") { super(message); this.name = "FloorBusy"; } }
/** Thrown by a floor when the member cannot answer now because it waits on a tool: the step waits and is tried again, nothing is recorded as no answer. */
export class FloorWaits extends Error { readonly what: string; constructor(what: string) { super(`waiting on ${what}`); this.name = "FloorWaits"; this.what = what; } }

/**
 * What the procedure asks the members. The procedure is the only service that runs a motion; the floor (card M05) supplies what is floor-specific behind this port: bounded model turns, the blind first round, the chair's notes, questions,
 * summary and desk read, the timeboxes and the owner's inquiry. A member that gives no answer (undefined, or the call fails) is recorded as no response and never blocks the meeting. `before`, `between` and `setAside` are the floor's
 * own hooks and are optional: scripted members (tests) need none of them.
 */
export interface MeetingFloor {
  comment(request: CommentRequest): Promise<{ text: string; stance?: string; sources?: readonly SourceCite[] } | undefined>;
  objection(request: ObjectionRequest): Promise<{ answer: "none" | "objection" | "research"; reason?: string } | undefined>;
  ballot(request: BallotRequest): Promise<{ value: BallotValue; reason: string; sources?: readonly SourceCite[] } | undefined>;
  revision(request: RevisionRequest): Promise<{ keep: true } | { value: BallotValue; reason: string } | undefined>;
  before?(request: GateRequest): Promise<FloorGate>;
  between?(request: BetweenRequest): Promise<BetweenResult>;
  setAside?(request: AsideRequest): Promise<void>;
}
/** The chair's own decisions when a model chair is wired; without it the controller waits for the chair's (or the owner's) command. */
export interface ChairFloor {
  rule(request: RulingRequest): Promise<RulingInput | undefined>;
  castingVote(request: CastingRequest): Promise<{ value: "yes" | "no"; reason: string } | undefined>;
}

export type RulingInput =
  | { readonly ruling: "proceed"; readonly text?: string }
  | { readonly ruling: "table"; readonly reason: string; readonly text?: string }
  | { readonly ruling: "uphold"; readonly addressed: "clarify" | "amend"; readonly text: string };

export interface ProcedureOptions extends RunnerOptions {
  /** The settings in force (the owner's, from the configuration); a failing read gives the defaults. */
  readonly settings?: () => Promise<Partial<ProcedureSettings>>;
  readonly floor?: MeetingFloor;
  readonly chair?: ChairFloor;
  /** An agent's own authenticated principal, for the acts that are its own (a ballot, a chair's ruling). The controller supplies it; without it nothing can be asked of members. */
  readonly actAs?: (agent: string) => Promise<Principal | undefined>;
  /** Model family and information of a member, for seating. Unknown members form one group. */
  readonly traits?: (agent: string) => SeatTraits | undefined;
  /** Creates an owned follow-up task for research a tabled motion needs. */
  readonly followUp?: (task: { readonly projectId: string; readonly agent: string; readonly title: string; readonly description: string; readonly commandId: string }) => Promise<{ taskId: string }>;
}

export const PROCEDURE_LIMITS = { retries: 8, steps: 400, followUps: 10, text: 600, pages: 12 } as const;

const MOTION_ID = /^mmo-[a-z2-7]{20}$/;
const RECORD_ID = /^mrc-[a-z2-7]{20}$/;
const FINAL = new Set(["adopted", "rejected", "failed", "no-quorum", "tabled", "void"]);
const isService = (p: Principal): boolean => (p.kind === "owner" || p.kind === "host" || p.kind === "service") && p.taskScope === undefined;
const known = <T>(a: Aggregate | undefined): T | undefined => (a === undefined ? undefined : (a.body as unknown as T));
const forbidden = (by: Principal, what: string): DomainError => new DomainError("forbidden", `${by.id} may not ${what}`);
const json = (value: object): import("../storage/types.js").JsonObject => JSON.parse(JSON.stringify(value)) as import("../storage/types.js").JsonObject;
const cutText = (s: string, max: number): string => (s.length <= max ? s : `${s.slice(0, max - 3)}...`);
/** A member's short free text (an objection's reason, a stance) kept in the procedure's own record: cut to size with control characters folded to spaces; text that looks like a credential is not kept at all (undefined). */
const memberText = (value: unknown, max: number): string | undefined => {
  if (typeof value !== "string") return undefined;
  const folded = value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").trim();
  if (folded === "" || redactText(folded) !== folded) return undefined;
  const out = cutText(folded, max);
  return redactText(out) === out ? out : undefined;
};
const chairOf = (by: Principal, rec: RecordBody): boolean => by.kind === "agent" && by.asOf !== undefined && rec.chair !== undefined && by.id === rec.chair && inTaskScope(by, rec.projectId);

export type Waiting = { readonly on: "chair" | "owner" | "time" | "nobody" | "tool" | "busy"; readonly why: string };
export interface StepResult { readonly stage: ProcedureStage; readonly did: string; readonly waiting?: Waiting; readonly done: boolean }

/**
 * The meeting procedure (card M06): comment rounds, the objection check, tabling, the vote asked one member at a time and the revision turns, over the records of M02. It is a state machine kept in one record per motion and moved one
 * step at a time by `advance` (a member's turn, an answer, a ballot), so a restart resumes where it stopped.
 *
 * - **Rounds.** `rounds` comment rounds (default 2): each present member has the floor once per round in seat order, hears the whole transcript up to its turn (never a ballot: ballots are not in the transcript while a vote is open),
 *   an absent member is skipped and recorded, and a member who joins before being asked is heard first. From the second round a member may check its desk (the request says so).
 * - **Objection check.** Every present member answers none, objection (with a reason) or needs time to research (with what it would look into), receiving only the motion version and the round summary. A member that does not answer is
 *   recorded as no response and never blocks. Any objection or request for research holds the vote until the chair or the owner rules: proceed (the objections are recorded as dissent), table, or uphold (clarify or amend, and the check
 *   runs again, at most `objectionReruns` times).
 * - **Tabling.** The chair may table when members asked for time to research (the owner always may): no vote, the research becomes owned follow-up tasks, the motion returns on the next meeting's agenda with its reason and next step. The owner
 *   can overrule the tabling (the motion is moved again at its objection check, then voted) or ask for the vote anyway.
 * - **Voting.** Each ballot is asked of one member alone; the delivery holds no ballot. An owner message in the transcript reaches a member who has not voted with its ballot request, and every member who voted before it is offered one
 *   revision turn (at most `maxRevisions` a voter) before the vote closes. A tie goes to the chair's casting vote as M02 decided.
 * - **Amendment.** A material amendment after the comment rounds starts a fresh round, a fresh objection check and a fresh vote.
 */
export class MeetingProcedureService {
  readonly #runner: CommandRunner;
  readonly #records: MeetingRecordService;
  readonly #options: ProcedureOptions;
  /** Where the scheduled look (`driveAll`) goes on from: in memory only (a restart begins at the start, which is safe). */
  #driveAfter: string | undefined;

  private constructor(runner: CommandRunner, records: MeetingRecordService, options: ProcedureOptions) { this.#runner = runner; this.#records = records; this.#options = options; }

  static withEpoch(storage: ControllerStorage, epoch: number, records: MeetingRecordService, options: ProcedureOptions = {}): MeetingProcedureService {
    return new MeetingProcedureService(new CommandRunner(storage, epoch, options), records, options);
  }

  // ---- beginning -----------------------------------------------------------------------------------------------------------------------

  /**
   * Starts the procedure for a proposed motion (the chair, the owner, a host or a service). The settings in force are kept; the present members are seated (m00 proposal 10: different model families next to each other where the roster
   * allows). `skipComments` begins at the objection check (a motion moved again after the owner overruled its tabling).
   */
  async begin(by: Principal, command: NoActor & { motionId: string; skipComments?: boolean }): Promise<{ id: string; replayed: boolean }> {
    onlyKnown(command, ["commandId", "motionId", "skipComments"]);
    const motionId = this.#motionId(command.motionId);
    const id = derivedId("mpr", motionId);
    const found = await this.#runner.get("meeting-motion", motionId);
    const motion = known<MotionBody>(found);
    if (motion === undefined) throw forbidden(by, "begin that procedure");
    const rec = known<RecordBody>(await this.#runner.get("meeting-record", motion.recordId));
    if (rec === undefined || !(isService(by) || chairOf(by, rec))) throw forbidden(by, "begin that procedure");
    const settings = await this.#settings();
    const present = rec.roster.filter((a) => !rec.withheld.includes(a));
    const seats = seatOrder(present, settings.seating, this.#options.traits);
    const result = await this.#runner.command("meeting.procedure.begin", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: clean({ motionId, skipComments: command.skipComments }),
      build: async () => {
        const again = await this.#runner.get("meeting-motion", motionId);
        const m = known<MotionBody>(again);
        if (m === undefined || again === undefined) throw forbidden(by, "begin that procedure");
        const again2 = known<RecordBody>(await this.#runner.get("meeting-record", m.recordId))!;
        if (m.state !== "proposed") throw new DomainError("invalid_command", `motion ${m.number} is ${m.state}; a procedure begins on a proposed motion`, { field: "motionId" });
        if ((await this.#runner.get(PROCEDURE_KIND, id)) !== undefined) throw new DomainError("invalid_command", `motion ${m.number} already has a procedure`, { field: "motionId" });
        const body: ProcedureBody = {
          recordId: m.recordId, projectId: m.projectId, motionId, settings, seats, stage: command.skipComments === true ? "check" : "comment", version: m.version, roundSince: again2.nextSeq, round: 1, rounds: command.skipComments === true ? 0 : settings.rounds,
          asked: [], spoken: [], skipped: [], stances: [], summaries: [], check: { run: 1, answers: [] }, dissent: [], rulings: [], followUps: [], fresh: 0, voteAsked: [], ballotSeq: [], noBallot: [], offers: [], offersCapped: [],
          openedBy: by.id, openedAt: this.#runner.now(),
        };
        const ref = { kind: PROCEDURE_KIND, id };
        return { ref, creates: true, changes: [{ type: "create", ref, body: json(body) }], detail: { projectId: m.projectId, motionId } };
      },
    }));
    return { id: result.id, replayed: result.replayed };
  }

  // ---- moving one step ---------------------------------------------------------------------------------------------------------------

  /**
   * Does the next step of a motion's procedure and says what it waits for (a person's ruling, the owner's inquiry, the vote's time, nobody: finished). Owner, host or service only: the controller drives, the members never do. Safe to
   * repeat after a crash (every record it writes has a stable command ID and each step is saved before the next).
   */
  async advance(by: Principal, command: { motionId: string }): Promise<StepResult> {
    onlyKnown(command, ["motionId"]);
    const motionId = this.#motionId(command.motionId);
    if (!isService(by)) throw forbidden(by, "move that procedure");
    const proc = await this.#load(motionId);
    const body = proc.body;
    const m = await this.#motion(motionId);
    if (FINAL.has(m.state) && body.stage !== "concluded" && body.stage !== "tabled" && body.stage !== "void") return this.#settled(proc, m);
    // A material amendment made on the record itself (the record's own amend, not this service's) gives a new version and puts an open vote back to proposed: the procedure starts its fresh pass here, as `amend` would have.
    if (!FINAL.has(m.state) && m.version !== body.version && (body.stage === "comment" || body.stage === "check" || body.stage === "ruling" || body.stage === "ready" || body.stage === "voting")) {
      await this.#save(proc, await this.#freshPass(body, m.version), "fresh pass after a material amendment on the record");
      return { stage: "comment", did: `motion ${m.number} was materially amended (version ${m.version}); a fresh round begins`, done: false };
    }
    // The floor's own work first (the owner's questions, a chair question's answer) and its holds (an owner inquiry, a used-up timebox): the procedure asks no member while the floor holds the meeting back.
    const gate = await this.#gate(proc, m);
    if (gate.step !== undefined) return gate.step;
    const halt = gate.halt;
    if (halt !== undefined && body.stage !== "voting") return { stage: body.stage, did: "the meeting is held", waiting: haltWaiting(halt), done: false };
    switch (body.stage) {
      case "comment": return this.#comment(by, proc, m);
      case "check": return this.#check(by, proc, m);
      case "ruling": return this.#ruling(by, proc, m);
      case "ready": return this.#ready(by, proc, m);
      case "voting": return this.#voting(by, proc, m, halt);
      default: return { stage: body.stage, did: "nothing to do", done: true };
    }
  }

  /** Asks the floor what it has to do before the next step; what it does not know (a failing floor) is no hold. */
  async #gate(proc: Aggregate, m: MotionBody): Promise<{ step?: StepResult; halt?: Extract<FloorGate, { halt: unknown }> }> {
    const floor = this.#options.floor;
    const body = this.#body(proc);
    if (floor?.before === undefined) return {};
    const got = await this.#port(body.stage, () => floor.before!({ recordId: body.recordId, motion: this.#view(m, motionIdOf(proc)), stage: body.stage }));
    if (!got.ok) return { step: got.step };
    const g = got.value;
    if (g === undefined) return {};
    if ("ran" in g) return { step: { stage: body.stage, did: g.ran, done: false } };
    return { halt: g };
  }

  /** Calls the floor: a floor that is busy or waits on a tool makes the step wait (nothing recorded); any other failure of a call is no answer. */
  async #port<T>(stage: ProcedureStage, call: () => Promise<T>): Promise<{ ok: true; value: T | undefined } | { ok: false; step: StepResult }> {
    try { return { ok: true, value: await call() }; } catch (error) {
      if (error instanceof FloorBusy) return { ok: false, step: { stage, did: "another driver is already asking", waiting: { on: "busy", why: "another driver is asking a member; try again" }, done: false } };
      if (error instanceof FloorWaits) return { ok: false, step: { stage, did: `waiting on ${error.what}`, waiting: { on: "tool", why: `a member waits on ${error.what}; the step is tried again` }, done: false } };
      return { ok: true, value: undefined };
    }
  }

  /** Moves the procedure until it waits for something or finishes (at most `steps` steps, so a stuck member can never loop it). */
  async run(by: Principal, command: { motionId: string; steps?: number }): Promise<StepResult & { steps: number }> {
    onlyKnown(command, ["motionId", "steps"]);
    const max = command.steps === undefined ? PROCEDURE_LIMITS.steps : whole(command.steps, "steps", 1, PROCEDURE_LIMITS.steps);
    let last: StepResult = { stage: "comment", did: "", done: false };
    for (let i = 1; i <= max; i++) {
      last = await this.advance(by, { motionId: command.motionId });
      if (last.done || last.waiting !== undefined) return { ...last, steps: i };
    }
    return { ...last, steps: max };
  }

  /**
   * The scheduled loop's turn (owner, host or service): moves every motion's procedure that is under way until it waits or finishes (at most `steps` steps each and `procedures` procedures a call), so a vote the owner asked for
   * does not need anyone to call `advance`. A procedure whose meeting `skip` names is left to its own driver. One failing procedure never stops the others.
   */
  async driveAll(by: Principal, command: { steps?: number; procedures?: number; skip?: (recordId: string) => Promise<boolean> } = {}): Promise<{ driven: number; steps: number; failed: number }> {
    if (!isService(by)) throw forbidden(by, "drive the meeting procedures");
    const each = command.steps === undefined ? 20 : whole(command.steps, "steps", 1, PROCEDURE_LIMITS.steps);
    const most = command.procedures === undefined ? 50 : whole(command.procedures, "procedures", 1, 500);
    let driven = 0, steps = 0, failed = 0;
    // The look goes on from where the last call stopped (wrapping round at the end), so every procedure is reached in turn however many finished ones are kept, and one call reads at most `pages` pages.
    let after: string | undefined = this.#driveAfter;
    outer: for (let page = 0; page < PROCEDURE_LIMITS.pages; page++) {
      const list = await this.#runner.list(PROCEDURE_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const a of list) {
        const b = a.body as unknown as ProcedureBody;
        if (b.stage === "concluded" || b.stage === "tabled" || b.stage === "void") { after = a.id; continue; }
        if (driven >= most) break outer;
        after = a.id;
        try {
          if (command.skip !== undefined && (await command.skip(b.recordId))) continue;
          const rec = known<RecordBody>(await this.#runner.get("meeting-record", b.recordId));
          if (rec === undefined || rec.state !== "open") continue;
          // Card P06: an archived project's meetings are held: no member is asked and nothing is spent until it is restored (read fresh each time, so another controller's archive counts at once).
          if (known<{ state?: string }>(await this.#runner.get("project", b.projectId))?.state === "archived") continue;
          const r = await this.run(by, { motionId: b.motionId, steps: each });
          driven += 1; steps += r.steps;
        } catch { failed += 1; }
      }
      // At the end the next call begins again from the start.
      if (list.length < 100) { after = undefined; break; }
    }
    this.#driveAfter = after;
    return { driven, steps, failed };
  }

  // ---- comment rounds -----------------------------------------------------------------------------------------------------------------

  async #comment(by: Principal, proc: Aggregate, m: MotionBody): Promise<StepResult> {
    const body = this.#body(proc);
    const rec = await this.#rec(body.recordId);
    const heard = new Set(body.asked);
    // A member who has joined the room since this round began and has not been asked yet is heard first (a member absent when the record opened cannot join: the roster is fixed, so M04's wake does not add a voice).
    const joinedNow = await this.#joinedSince(body.recordId, body.roundSince);
    const agent = body.seats.find((a) => joinedNow.includes(a) && !heard.has(a)) ?? body.seats.find((a) => !heard.has(a));
    if (agent === undefined) return this.#endRound(proc, m, rec);
    const floor = this.#options.floor;
    if (floor === undefined) return { stage: "comment", did: "no members are connected", waiting: { on: "nobody", why: "the floor is not wired: nothing can ask a member for a turn" }, done: false };
    const transcript = await this.#transcript(by, body.recordId);
    const got = await this.#port("comment", () => floor.comment({ agent, recordId: body.recordId, round: body.round, rounds: body.rounds, fresh: body.fresh, motion: this.#view(m, motionIdOf(proc)), transcript, deskCheck: body.round >= 2, seats: body.seats.filter((a) => !heard.has(a)) }));
    if (!got.ok) return got.step;
    const reply = got.value;
    let wrote: { seq: number } | undefined;
    if (reply !== undefined && typeof reply.text === "string" && reply.text.trim() !== "") {
      try {
        wrote = await this.#records.append(by, { commandId: `mpr:${proc.id}:c:${body.fresh}:${body.round}:${agent}`, recordId: body.recordId, kind: "statement", text: cutText(reply.text.trim(), RECORD_LIMITS.text), speaker: agent, ...(reply.sources === undefined ? {} : { sources: reply.sources }) });
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "invalid_command" && error.code !== "command_conflict")) throw error;
        if (error.code === "command_conflict") wrote = { seq: 0 };
      }
    }
    const next: ProcedureBody = {
      ...body, asked: [...body.asked, agent],
      ...(wrote === undefined ? { skipped: [...body.skipped, { stage: "comment" as const, round: body.round, agent, reason: "no answer" }] } : { spoken: [...body.spoken, { round: body.round, agent, seq: wrote.seq }] }),
      ...(wrote !== undefined && body.round === 1 && body.fresh === 0 && memberText(reply?.stance, 40) !== undefined ? { stances: [...body.stances, { round: 1, agent, stance: memberText(reply?.stance, 40)! }] } : {}),
    };
    await this.#save(proc, next, `comment ${agent}`);
    return { stage: "comment", did: wrote === undefined ? `${agent} gave no comment` : `${agent} spoke in round ${body.round}`, done: false };
  }

  async #endRound(proc: Aggregate, m: MotionBody, rec: RecordBody): Promise<StepResult> {
    const body = this.#body(proc);
    // The floor's work between two rounds (the chair's notes, questions, desk read and summary), one step at a time; its summary, when it has one, is what the objection check is given.
    let chairSummary: string | undefined;
    const floor = this.#options.floor;
    if (floor?.between !== undefined) {
      const got = await this.#port("comment", () => floor.between!({ recordId: body.recordId, motion: this.#view(m, motionIdOf(proc)), round: body.round, rounds: body.rounds, fresh: body.fresh }));
      if (!got.ok) return got.step;
      if (got.value !== undefined && !got.value.done) return { stage: "comment", did: got.value.did ?? `the chair's work after round ${body.round}`, done: false };
      chairSummary = got.value?.summary;
    }
    // Members still absent when the round ends are recorded as skipped for it.
    const gone = rec.withheld.filter((a) => !rec.attended.includes(a) && !body.skipped.some((s) => s.stage === "comment" && s.round === body.round && s.agent === a));
    const silent = body.skipped.filter((s) => s.stage === "comment" && s.round === body.round).map((s) => s.agent);
    const spokeNow = body.spoken.filter((s) => s.round === body.round);
    const statements = await this.#statements(spokeNow.map((s) => s.seq), body.recordId);
    const summary = chairSummary !== undefined && chairSummary.trim() !== "" ? cutText(chairSummary, 3000) : roundSummary(body.round, statements, [...gone, ...silent]);
    const skipped = [...body.skipped, ...gone.map((agent) => ({ stage: "comment" as const, round: body.round, agent, reason: "absent from the meeting" }))];
    const more = body.round < body.rounds;
    const next: ProcedureBody = more
      ? { ...body, skipped, summaries: [...body.summaries, { round: body.round, text: summary }], round: body.round + 1, asked: [], roundSince: rec.nextSeq }
      : { ...body, skipped, summaries: [...body.summaries, { round: body.round, text: summary }], stage: "check", asked: [], check: { run: 1, answers: [] } };
    await this.#save(proc, next, `end of round ${body.round}`);
    void m;
    return { stage: next.stage, did: `round ${body.round} ended`, done: false };
  }

  // ---- objection check -----------------------------------------------------------------------------------------------------------------

  async #check(by: Principal, proc: Aggregate, m: MotionBody): Promise<StepResult> {
    const body = this.#body(proc);
    const answered = new Set(body.check.answers.map((a) => a.agent));
    const agent = body.seats.find((a) => !answered.has(a));
    if (agent === undefined) return this.#checked(proc, m);
    const floor = this.#options.floor;
    if (floor === undefined) return { stage: "check", did: "no members are connected", waiting: { on: "nobody", why: "the floor is not wired: nothing can ask a member for an answer" }, done: false };
    const summary = [...body.summaries].reverse().map((s) => s.text)[0] ?? "";
    const got = await this.#port("check", () => floor.objection({ agent, recordId: body.recordId, run: body.check.run, fresh: body.fresh, motion: this.#view(m, motionIdOf(proc)), summary: body.summaries.length === 0 ? summary : body.summaries.map((s) => s.text).join("\n"), tabling: body.settings.tabling, seats: body.seats.filter((a) => !answered.has(a)) }));
    if (!got.ok) return got.step;
    const reply = got.value;
    const kind = reply?.answer === "none" || reply?.answer === "objection" || reply?.answer === "research" ? reply.answer : "no-response";
    // An objection needs its reason and a request for research what it would look into; without it the answer is not usable and counts as no response.
    const reason = memberText(reply?.reason, PROCEDURE_LIMITS.text) ?? "";
    const usable = kind === "none" || kind === "no-response" ? kind : reason === "" ? "no-response" : kind;
    const answer: ObjectionAnswer = { agent, answer: usable, ...(usable === "objection" || usable === "research" ? { reason } : {}) };
    // An objection and a request for research enter the transcript, for the chair's ruling and for those who speak later.
    if (usable === "objection" || usable === "research") {
      try {
        await this.#records.append(by, { commandId: `mpr:${proc.id}:o:${body.fresh}:${body.check.run}:${agent}`, recordId: body.recordId, kind: "statement", text: usable === "objection" ? `Objection check (run ${body.check.run}), objection from ${agent}: ${reason}` : `Objection check (run ${body.check.run}), ${agent} needs time to research: ${reason}`, speaker: agent });
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "invalid_command" && error.code !== "command_conflict")) throw error;
      }
    }
    await this.#save(proc, { ...body, check: { ...body.check, answers: [...body.check.answers, answer] } }, `check ${agent}`);
    return { stage: "check", did: `${agent} answered the objection check: ${usable}`, done: false };
  }

  async #checked(proc: Aggregate, m: MotionBody): Promise<StepResult> {
    const body = this.#body(proc);
    const rec = await this.#rec(body.recordId);
    const gone = rec.withheld.filter((a) => !body.skipped.some((s) => s.stage === "check" && s.agent === a && s.round === body.check.run));
    const skipped = [...body.skipped, ...gone.map((agent) => ({ stage: "check" as const, round: body.check.run, agent, reason: "absent from the meeting" }))];
    const hold = body.check.answers.some((a) => a.answer === "objection" || a.answer === "research");
    const next: ProcedureBody = { ...body, skipped, stage: hold ? "ruling" : "ready" };
    await this.#save(proc, next, hold ? "check holds the vote" : "check clear");
    void m;
    // With a chair that can rule, the next step is its ruling: nothing waits yet (a driver goes on at once); without one the vote waits for the owner.
    const chairRules = this.#options.chair !== undefined && rec.chair !== undefined && this.#options.actAs !== undefined;
    return hold
      ? { stage: "ruling", did: "the objection check holds the vote", ...(chairRules ? {} : { waiting: this.#waitingRuling(next) }), done: false }
      : { stage: "ready", did: "the objection check is clear", done: false };
  }

  #waitingRuling(body: ProcedureBody): Waiting {
    const research = body.check.answers.filter((a) => a.answer === "research").length;
    const objections = body.check.answers.filter((a) => a.answer === "objection").length;
    return { on: "chair", why: `${objections} objection${objections === 1 ? "" : "s"} and ${research} request${research === 1 ? "" : "s"} for research hold the vote until the chair or the owner rules` };
  }

  // ---- ruling ---------------------------------------------------------------------------------------------------------------------------

  async #ruling(by: Principal, proc: Aggregate, m: MotionBody): Promise<StepResult> {
    const body = this.#body(proc);
    const rec = await this.#rec(body.recordId);
    const chair = this.#options.chair;
    const asChair = rec.chair === undefined || this.#options.actAs === undefined ? undefined : await this.#options.actAs(rec.chair);
    if (chair !== undefined && asChair !== undefined) {
      const got = await this.#port("ruling", () => chair.rule({ recordId: body.recordId, motion: this.#view(m, motionIdOf(proc)), run: body.check.run, canUphold: body.check.run <= body.settings.objectionReruns, canTable: this.#canTable(body, false), answers: body.check.answers }));
      if (!got.ok) return got.step;
      const ruling: RulingInput | undefined = got.value;
      if (ruling !== undefined) {
        try {
          await this.rule(asChair, { commandId: `mpr:${proc.id}:rule:${body.fresh}:${body.check.run}`, motionId: motionIdOf(proc), ...pickRuling(ruling) } as never);
          return { stage: (await this.#load(motionIdOf(proc))).body.stage, did: "the chair ruled", done: false };
        } catch (error) {
          // A ruling the rules do not allow (table with no request for research, uphold past the limit, unusable text) is not taken: the vote stays held for a proper ruling by the chair or the owner.
          if (!(error instanceof DomainError) || !["invalid_command", "forbidden", "command_conflict"].includes(error.code)) throw error;
          return { stage: "ruling", did: "the chair's ruling was not allowed", waiting: this.#waitingRuling(body), done: false };
        }
      }
    }
    return { stage: "ruling", did: "waiting for a ruling", waiting: this.#waitingRuling(body), done: false };
  }

  #canTable(body: ProcedureBody, owner: boolean): boolean {
    return owner || (body.settings.tabling && body.check.answers.some((a) => a.answer === "research"));
  }

  /**
   * The chair's (or the owner's) ruling on the objections and requests for research that hold the vote. `proceed`: go to the vote, every remaining objection recorded as dissent. `table`: no vote; the research becomes owned
   * follow-up tasks (the chair may table only when a member asked for time to research and tabling is on; the owner always may). `uphold`: the objection is addressed by a clarification or an amendment and the check runs again, at most
   * `objectionReruns` times; after that only proceed and table remain.
   */
  async rule(by: Principal, command: NoActor & { motionId: string } & RulingInput): Promise<{ stage: ProcedureStage }> {
    onlyKnown(command, ["commandId", "motionId", "ruling", "text", "reason", "addressed"]);
    const motionId = this.#motionId(command.motionId);
    const proc = await this.#load(motionId);
    const body = proc.body;
    const rec = await this.#rec(body.recordId);
    const owner = by.kind === "owner" && by.taskScope === undefined;
    const chair = chairOf(by, rec);
    if (!owner && !chair) throw forbidden(by, "rule on the objections of that motion");
    if (body.stage !== "ruling") throw new DomainError("invalid_command", `motion ${motionIdOf(proc)} is at the ${body.stage} stage; there is nothing to rule on`, { field: "motionId" });
    const m = await this.#motion(motionId);
    const objections = body.check.answers.filter((a) => a.answer === "objection");
    const text = command.text === undefined ? undefined : plain(command.text, "text", PROCEDURE_LIMITS.text);
    const id = (what: string): string => `mpr:${proc.id}:${what}:${body.fresh}:${body.check.run}`;
    const ruled = async (summary: string): Promise<string | undefined> => {
      try { return (await this.#records.append(by, { commandId: `${command.commandId}`, recordId: body.recordId, kind: "ruling", text: summary, motionId })).id; } catch (error) {
        if (error instanceof DomainError && error.code === "command_conflict") return undefined;
        throw error;
      }
    };
    void id;
    if (command.ruling === "proceed") {
      const entryId = await ruled(`Ruling on the objection check of motion ${m.number}: go to the vote${objections.length === 0 ? "" : `; ${objections.length} remaining objection${objections.length === 1 ? " is" : "s are"} recorded as dissent`}.${text === undefined ? "" : ` ${text}`}`);
      const dissent = [...body.dissent, ...objections.map((a) => ({ agent: a.agent, reason: a.reason ?? "", run: body.check.run }))];
      await this.#save(proc, { ...body, stage: "ready", dissent, rulings: [...body.rulings, { by: by.id, ruling: "proceed", at: this.#runner.now(), ...(entryId === undefined ? {} : { entryId }) }] }, "ruling: proceed");
      return { stage: "ready" };
    }
    if (command.ruling === "table") {
      const reason = plain(command.reason, "reason", PROCEDURE_LIMITS.text);
      if (!this.#canTable(body, owner)) throw new DomainError("invalid_command", body.settings.tabling ? "no member asked for time to research, so the chair may not table the motion (the owner may)" : "tabling is switched off (meeting.tabling); only the owner may table", { field: "ruling" });
      const research = body.check.answers.filter((a) => a.answer === "research");
      const followUps = await this.#followUps(by, proc, m, research);
      const nextStep = followUps.length === 0 ? "" : ` Next step: ${followUps.map((f) => `${f.agent} ${f.text}${f.taskId === undefined ? "" : ` (task ${f.taskId})`}`).join("; ")}.`;
      await this.#records.table(by, { commandId: `mpr:${proc.id}:table`, motionId, reason: `${reason}${nextStep}`.slice(0, RECORD_LIMITS.text) });
      await this.#save(proc, { ...body, stage: "tabled", followUps, tabled: { reason, by: by.id, at: this.#runner.now() }, rulings: [...body.rulings, { by: by.id, ruling: "table", at: this.#runner.now() }] }, "ruling: table");
      return { stage: "tabled" };
    }
    if (command.ruling === "uphold") {
      if (body.check.run > body.settings.objectionReruns) throw new DomainError("invalid_command", `the check has already run ${body.check.run} times (${body.settings.objectionReruns} reruns are allowed); the chair or the owner rules whether to proceed, and the remaining objections are recorded as dissent`, { field: "ruling" });
      if (command.addressed !== "clarify" && command.addressed !== "amend") invalid("addressed", "an upheld objection is addressed by a clarification or an amendment");
      if (text === undefined) invalid("text", "says what is clarified or the amended wording");
      let version = m.version;
      let entryId: string | undefined;
      if (command.addressed === "amend") {
        try {
          version = (await this.#records.amend(by, { commandId: `${command.commandId}:amend`, motionId, expectedVersion: m.version, text: text!, material: true })).version;
        } catch (error) {
          // The same ruling repeated after a restart: its amendment is already on record (the motion is at the version it made).
          if (!(error instanceof DomainError) || error.code !== "command_conflict" || m.version <= body.version) throw error;
        }
      } else {
        entryId = await ruled(`Objection upheld on motion ${m.number}; clarified: ${text}`);
      }
      if (command.addressed === "amend") entryId = await ruled(`Objection upheld on motion ${m.number}; the motion is amended (version ${version}).`);
      await this.#save(proc, { ...body, version, stage: "check", asked: [], check: { run: body.check.run + 1, answers: [] }, rulings: [...body.rulings, { by: by.id, ruling: `uphold-${command.addressed}`, at: this.#runner.now(), ...(entryId === undefined ? {} : { entryId }) }] }, "ruling: uphold");
      return { stage: "check" };
    }
    return invalid("ruling", "must be proceed, table or uphold");
  }

  async #followUps(by: Principal, proc: Aggregate, m: MotionBody, research: readonly ObjectionAnswer[]): Promise<FollowUp[]> {
    const out: FollowUp[] = [];
    for (const r of research.slice(0, PROCEDURE_LIMITS.followUps)) {
      const text = cutText(r.reason ?? "research the question", 200);
      const make = this.#options.followUp;
      let taskId: string | undefined;
      if (make !== undefined) {
        taskId = (await make({ projectId: m.projectId, agent: r.agent, title: cutText(`Research for motion ${m.number}: ${text}`, 120), description: `The meeting tabled motion ${m.number} (${cutText(m.text, 200)}) because ${r.agent} needed time to research: ${text}`, commandId: `mpr:${proc.id}:fu:${r.agent}` })).taskId;
      }
      out.push({ agent: r.agent, text, ...(taskId === undefined ? {} : { taskId }) });
    }
    void by;
    return out;
  }

  /**
   * The owner overrules a tabling and has the motion put to a vote anyway: the tabled motion stays tabled (and is not lost); the same wording and changes are moved again as a new motion (by the chair, or else the member who moved
   * the first) and its procedure begins at the objection check, since the discussion has been held. Owner only.
   */
  async overruleTabling(by: Principal, command: NoActor & { motionId: string }): Promise<{ motionId: string; procedureId: string }> {
    onlyKnown(command, ["commandId", "motionId"]);
    if (by.kind !== "owner" || by.taskScope !== undefined) throw forbidden(by, "overrule a tabling");
    const motionId = this.#motionId(command.motionId);
    const proc = await this.#load(motionId);
    const old = await this.#motion(motionId);
    if (old.state !== "tabled" || proc.body.stage !== "tabled") throw new DomainError("invalid_command", `motion ${old.number} is not tabled`, { field: "motionId" });
    if (proc.body.overruledBy !== undefined) return { motionId: proc.body.overruledBy, procedureId: derivedId("mpr", proc.body.overruledBy) };
    const rec = await this.#rec(old.recordId);
    if (rec.state !== "open") throw new DomainError("invalid_command", "the meeting has ended", { field: "motionId" });
    const mover = [rec.chair, old.proposer].find((a) => a !== undefined && (a === rec.chair || (rec.roster.includes(a) && !rec.withheld.includes(a))));
    const asMover = mover === undefined || this.#options.actAs === undefined ? undefined : await this.#options.actAs(mover);
    if (asMover === undefined) throw new DomainError("unavailable", "the chair and the member who moved the motion cannot be reached to move it again");
    const created = await this.#records.move(asMover, { commandId: `mpr:${proc.id}:resume`, recordId: old.recordId, text: old.text, ...(old.topic === undefined ? {} : { topic: old.topic }), ...(old.agendaItemId === undefined ? {} : { agendaItemId: old.agendaItemId }), changes: old.changes.map((c) => { const { id: _id, ...rest } = c; void _id; return rest; }) });
    const fresh = await this.begin(by, { commandId: `mpr:${proc.id}:resume-begin`, motionId: created.id, skipComments: true });
    const next: ProcedureBody = { ...proc.body, overruledBy: created.id, note: "the owner overruled the tabling and had the motion voted on" };
    await this.#save(proc, next, "overrule tabling");
    const procedure = await this.#runner.get(PROCEDURE_KIND, fresh.id);
    if (procedure !== undefined) await this.#save(procedure, { ...(procedure.body as unknown as ProcedureBody), resumedFrom: motionId }, "resumed after tabling");
    return { motionId: created.id, procedureId: fresh.id };
  }

  // ---- opening the vote and voting ------------------------------------------------------------------------------------------------------

  async #ready(by: Principal, proc: Aggregate, m: MotionBody): Promise<StepResult> {
    const body = this.#body(proc);
    if (m.state === "proposed") {
      try {
        await this.#records.openVote(by, { commandId: `mpr:${proc.id}:open:${body.fresh}:${body.check.run}`, motionId: motionIdOf(proc), expectedVersion: m.version });
      } catch (error) {
        // Too few members can be asked for a binding vote: discussion and reports go on, the vote is deferred (M02).
        if (error instanceof DomainError && error.code === "invalid_command" && /deferred/.test(error.message)) return { stage: "ready", did: "the vote is deferred", waiting: { on: "nobody", why: error.message }, done: false };
        throw error;
      }
    }
    await this.#save(proc, { ...body, stage: "voting", version: m.version, voteAsked: [], ballotSeq: [], noBallot: [], offers: [], offersCapped: [] }, "vote opened");
    return { stage: "voting", did: "the vote is open", done: false };
  }

  async #voting(by: Principal, proc: Aggregate, m: MotionBody, halt?: Extract<FloorGate, { halt: unknown }>): Promise<StepResult> {
    const body = this.#body(proc);
    const motionId = motionIdOf(proc);
    // An owner inquiry holds everything; a used-up timebox lets the vote be counted but asks no one more.
    if (halt?.halt === "inquiry") return { stage: "voting", did: "the meeting is held for the owner's inquiry", waiting: haltWaiting(halt), done: false };
    if (m.state === "tie-pending") return this.#tie(by, proc, m);
    if (m.state !== "voting") return this.#settled(proc, m);
    if (m.heldAt !== undefined) return { stage: "voting", did: "the vote is held for the owner's inquiry", waiting: { on: "owner", why: "the owner's inquiry holds the vote; no ballot can be cast or revised until it ends" }, done: false };
    const floor = this.#options.floor;
    const view = this.#view(m, motionId);
    const next = halt !== undefined ? undefined : body.seats.find((a) => !body.voteAsked.includes(a));
    if (next !== undefined) {
      if (floor === undefined || this.#options.actAs === undefined) return { stage: "voting", did: "no members are connected", waiting: { on: "nobody", why: "the floor is not wired: nothing can ask a member for a ballot" }, done: false };
      const who = await this.#options.actAs(next);
      // Each ballot is asked of one member alone; what it is given is the transcript, which holds no ballot.
      const got = who === undefined ? { ok: true as const, value: undefined } : await this.#port("voting", async () => floor.ballot({ agent: next, recordId: body.recordId, motion: view, transcript: await this.#transcript(by, body.recordId) }));
      if (!got.ok) return got.step;
      const reply = got.value;
      // An inquiry opened while the member was answering holds the vote: the answer is set aside (its cost stays counted) and the member is asked again when the vote resumes.
      if (reply !== undefined && (await this.#motion(motionId)).heldAt !== undefined) {
        await floor.setAside?.({ recordId: body.recordId, motionId, version: m.version, kind: "ballot", agent: next }).catch(() => undefined);
        return { stage: "voting", did: `${next}'s ballot was set aside: the owner's inquiry holds the vote`, waiting: { on: "owner", why: "the owner's inquiry holds the vote; the ballot is asked again when it resumes" }, done: false };
      }
      let cast = false;
      if (who !== undefined && reply !== undefined) {
        try {
          await this.#records.castBallot(who, { commandId: `mpr:${proc.id}:b:${body.version}:${next}`, motionId, version: m.version, value: reply.value, reason: reply.reason, ...(reply.sources === undefined ? {} : { sources: reply.sources }) });
          cast = true;
        } catch (error) {
          if (!(error instanceof DomainError) || !["invalid_command", "command_conflict", "forbidden"].includes(error.code)) throw error;
          // An inquiry that held the vote between the check above and the cast: the ballot is set aside and asked again when the vote resumes, never counted as no ballot.
          if (error.code === "invalid_command" && (await this.#motion(motionId)).heldAt !== undefined) {
            await floor.setAside?.({ recordId: body.recordId, motionId, version: m.version, kind: "ballot", agent: next }).catch(() => undefined);
            return { stage: "voting", did: `${next}'s ballot was set aside: the owner's inquiry holds the vote`, waiting: { on: "owner", why: "the owner's inquiry holds the vote; the ballot is asked again when it resumes" }, done: false };
          }
          cast = error.code === "command_conflict";
        }
      }
      const seq = cast ? (await this.#rec(body.recordId)).nextSeq : 0;
      await this.#save(proc, { ...body, voteAsked: [...body.voteAsked, next], ...(cast ? { ballotSeq: [...body.ballotSeq, { agent: next, seq }] } : { noBallot: [...body.noBallot, next] }) }, `ballot ${next}`);
      return { stage: "voting", did: cast ? `${next} cast its ballot` : `${next} gave no ballot`, done: false };
    }
    // Everyone asked has answered: an owner message after a ballot is a reason to offer that voter one revision turn.
    const found = halt !== undefined ? { capped: [] as { agent: string; messageEntryId: string }[] } : await this.#nextOffer(by, proc);
    if (found.offer === undefined && found.capped.length > 0) {
      await this.#save(proc, { ...body, offersCapped: [...body.offersCapped, ...found.capped] }, "revision turns capped");
      return { stage: "voting", did: "revision turns beyond the owner's limit were not offered", done: false };
    }
    const offer = found.offer;
    if (offer !== undefined) {
      const { agent, message, since, ballot } = offer;
      let outcome: "kept" | "revised" | "no-answer" = "no-answer";
      const who = this.#options.actAs === undefined ? undefined : await this.#options.actAs(agent);
      const got = floor === undefined || who === undefined ? { ok: true as const, value: undefined } : await this.#port("voting", () => floor.revision({ agent, recordId: body.recordId, motion: view, ballot, ownerMessage: message, since }));
      if (!got.ok) return got.step;
      const reply = got.value;
      if (reply !== undefined && (await this.#motion(motionId)).heldAt !== undefined) {
        await floor?.setAside?.({ recordId: body.recordId, motionId, version: m.version, kind: "revision", agent, ownerMessageSeq: message.seq }).catch(() => undefined);
        return { stage: "voting", did: `${agent}'s revision was set aside: the owner's inquiry holds the vote`, waiting: { on: "owner", why: "the owner's inquiry holds the vote; the revision turn is offered again when it resumes" }, done: false };
      }
      if (reply !== undefined && who !== undefined) {
        if ("keep" in reply) outcome = "kept";
        else {
          try {
            await this.#records.castBallot(who, { commandId: `mpr:${proc.id}:r:${agent}:${message.seq}`, motionId, version: m.version, value: reply.value, reason: reply.reason, ownerMessageEntryId: entryIdOf(body.recordId, message.seq) });
            outcome = "revised";
          } catch (error) {
            if (!(error instanceof DomainError) || !["invalid_command", "command_conflict"].includes(error.code)) throw error;
            if (error.code === "invalid_command" && (await this.#motion(motionId)).heldAt !== undefined) {
              await floor?.setAside?.({ recordId: body.recordId, motionId, version: m.version, kind: "revision", agent, ownerMessageSeq: message.seq }).catch(() => undefined);
              return { stage: "voting", did: `${agent}'s revision was set aside: the owner's inquiry holds the vote`, waiting: { on: "owner", why: "the owner's inquiry holds the vote; the revision turn is offered again when it resumes" }, done: false };
            }
            // The same revision turn was answered before a restart: the revision is already on record.
            if (error.code === "command_conflict") outcome = "revised";
          }
        }
      }
      const seqAfter = outcome === "revised" ? (await this.#rec(body.recordId)).nextSeq : undefined;
      await this.#save(proc, {
        ...body, offersCapped: [...body.offersCapped, ...found.capped], offers: [...body.offers, { agent, messageEntryId: entryIdOf(body.recordId, message.seq), outcome }],
        ...(seqAfter === undefined ? {} : { ballotSeq: body.ballotSeq.map((b) => (b.agent === agent ? { agent, seq: seqAfter } : b)) }),
      }, `revision turn ${agent}`);
      return { stage: "voting", did: `${agent} was offered a revision turn: ${outcome}`, done: false };
    }
    // All asked, all revision turns finished: the vote closes when every present member has cast, or when its time is up.
    const missing = body.seats.filter((a) => !body.ballotSeq.some((b) => b.agent === a));
    const now = this.#runner.now();
    if (missing.length > 0 && m.closesAt !== undefined && Date.parse(now) < Date.parse(m.closesAt)) {
      return { stage: "voting", did: "waiting for the remaining ballots", waiting: { on: "time", why: `${missing.join(", ")} did not answer; the vote closes at ${m.closesAt}` }, done: false };
    }
    const closed = await this.#records.closeVote(by, { commandId: `mpr:${proc.id}:close:${body.version}`, motionId });
    if (closed.state === "tie-pending") return this.#tie(by, proc, { ...m, state: "tie-pending" });
    const settled = await this.#motion(motionId);
    return this.#settled(proc, settled);
  }

  /** The next revision turn to offer (no state is changed here), and the offers the owner's cap leaves out. */
  async #nextOffer(by: Principal, proc: Aggregate): Promise<{ offer?: { agent: string; message: MeetingDelivered; since: MeetingDelivered[]; ballot: { value: BallotValue; reason: string } }; capped: { agent: string; messageEntryId: string }[] }> {
    const body = this.#body(proc);
    const all = await this.#transcript(by, body.recordId);
    const capped: { agent: string; messageEntryId: string }[] = [];
    for (const message of all.filter((e) => e.kind === "owner-message")) {
      const key = entryIdOf(body.recordId, message.seq);
      for (const b of body.ballotSeq) {
        if (b.seq > message.seq) continue;
        if (body.offers.some((o) => o.agent === b.agent && o.messageEntryId === key) || body.offersCapped.some((o) => o.agent === b.agent && o.messageEntryId === key) || capped.some((o) => o.agent === b.agent && o.messageEntryId === key)) continue;
        if (body.offers.filter((o) => o.agent === b.agent).length >= body.settings.maxRevisions) { capped.push({ agent: b.agent, messageEntryId: key }); continue; }
        const ballot = known<BallotBody>(await this.#runner.get("meeting-ballot", derivedId("mbl", `${motionIdOf(proc)}:${b.agent}`)));
        if (ballot === undefined) continue;
        return { offer: { agent: b.agent, message, since: all.filter((e) => e.seq >= b.seq), ballot: { value: ballot.value, reason: ballot.reason } }, capped };
      }
    }
    return { capped };
  }

  async #tie(by: Principal, proc: Aggregate, m: MotionBody): Promise<StepResult> {
    const body = this.#body(proc);
    const chair = this.#options.chair;
    const rec = await this.#rec(body.recordId);
    // The time for the casting vote is over: the tie fails (M02), and the procedure says so instead of waiting for a sweep.
    if (m.castingDeadline !== undefined && Date.parse(this.#runner.now()) > Date.parse(m.castingDeadline)) {
      await this.#records.closeVote(by, { commandId: `mpr:${proc.id}:tie-over:${body.version}`, motionId: motionIdOf(proc) });
      return this.#settled(proc, await this.#motion(motionIdOf(proc)));
    }
    const who = rec.chair === undefined || this.#options.actAs === undefined ? undefined : await this.#options.actAs(rec.chair);
    if (chair === undefined || who === undefined) return { stage: "voting", did: "the vote is tied", waiting: { on: "chair", why: "the vote is tied and waits for the chair's casting vote; with no chair able to cast it the tie fails when its time is up" }, done: false };
    const got = await this.#port("voting", () => chair.castingVote({ recordId: body.recordId, motion: this.#view(m, motionIdOf(proc)), ...(m.castingDeadline === undefined ? {} : { castingDeadline: m.castingDeadline }) }));
    if (!got.ok) return got.step;
    const reply = got.value;
    if (reply === undefined) return { stage: "voting", did: "the chair gave no casting vote", waiting: { on: "chair", why: "the chair has not cast its casting vote; the tie fails when the time is up" }, done: false };
    try {
      await this.#records.castingVote(who, { commandId: `mpr:${proc.id}:cast:${body.version}`, motionId: motionIdOf(proc), value: reply.value, reason: reply.reason });
    } catch (error) {
      // A casting vote the record refuses (an unusable reason, the time just ran out) is not one: the tie waits, then fails when its time is up.
      if (!(error instanceof DomainError) || !["invalid_command", "forbidden"].includes(error.code)) throw error;
      return { stage: "voting", did: "the chair's casting vote was not accepted", waiting: { on: "chair", why: "the chair's casting vote was refused; the tie fails when its time is up" }, done: false };
    }
    return this.#settled(proc, await this.#motion(motionIdOf(proc)));
  }

  async #settled(proc: Aggregate, m: MotionBody): Promise<StepResult> {
    const body = proc.body as unknown as ProcedureBody;
    const stage: ProcedureStage = m.state === "tabled" ? "tabled" : m.state === "void" ? "void" : "concluded";
    let echo = body.echo;
    if (stage === "concluded" && body.settings.echoFlag && m.decisionId !== undefined) {
      const rec = await this.#rec(body.recordId);
      const ballots: string[] = [];
      for (const v of rec.roster) { const b = known<BallotBody>(await this.#runner.get("meeting-ballot", derivedId("mbl", `${motionIdOf(proc)}:${v}`))); if (b !== undefined && b.version === m.version) ballots.push(b.value); }
      echo = looksLikeEcho(body.stances.map((s) => s.stance), ballots, body.seats.length);
    }
    if (body.stage !== stage || body.echo !== echo) await this.#save(proc, { ...body, stage, ...(echo === undefined ? {} : { echo }) }, `settled: ${m.state}`);
    return { stage, did: `motion ${m.number} is ${m.state}`, done: true };
  }

  // ---- amendment and the owner's message ---------------------------------------------------------------------------------------------

  /**
   * Amends a motion under way (chair, owner, host or service). A non-material wording change goes through as the record allows (before voting opens). A material amendment, or a procedural concern that changes the motion, after the
   * comment rounds starts a fresh round, a fresh objection check and a fresh vote: ballots already cast on the old version are not counted (M02).
   */
  async amend(by: Principal, command: NoActor & { motionId: string; text: string; material: boolean; changes?: Parameters<MeetingRecordService["amend"]>[1]["changes"] }): Promise<{ version: number; fresh: boolean }> {
    onlyKnown(command, ["commandId", "motionId", "text", "material", "changes"]);
    const motionId = this.#motionId(command.motionId);
    const m = await this.#motion(motionId);
    const out = await this.#records.amend(by, { commandId: command.commandId, motionId, expectedVersion: m.version, text: command.text, material: command.material, ...(command.changes === undefined ? {} : { changes: command.changes }) });
    const proc = await this.#runner.get(PROCEDURE_KIND, derivedId("mpr", motionId));
    if (proc === undefined || !command.material) return { version: out.version, fresh: false };
    const body = proc.body as unknown as ProcedureBody;
    if (body.stage === "concluded" || body.stage === "tabled" || body.stage === "void") return { version: out.version, fresh: false };
    if (body.version === out.version) return { version: out.version, fresh: false };
    await this.#save(proc, await this.#freshPass(body, out.version), "fresh pass after a material amendment");
    return { version: out.version, fresh: true };
  }

  /**
   * The owner writes to the meeting. While a vote is open a message that repeats a cast ballot's words would hand it to everyone who has the floor after it, so the owner is warned first: the message is refused until it is sent
   * again with `acknowledged` true. A message goes into the transcript only; nobody gets the floor by it (M05's baton), and every voter who cast before it is offered a revision turn by the procedure.
   */
  async ownerMessage(by: Principal, command: NoActor & { recordId: string; text: string; acknowledged?: boolean }): Promise<{ id: string; seq: number; warning?: string }> {
    onlyKnown(command, ["commandId", "recordId", "text", "acknowledged"]);
    if (by.kind !== "owner" || by.taskScope !== undefined) throw forbidden(by, "write an owner message");
    const recordId = typeof command.recordId === "string" && RECORD_ID.test(command.recordId) ? command.recordId : invalid("recordId", "is not a meeting record ID");
    const text = plain(command.text, "text", RECORD_LIMITS.text);
    if (command.acknowledged !== undefined && typeof command.acknowledged !== "boolean") invalid("acknowledged", "is true or false");
    const rec = await this.#rec(recordId);
    let warning: string | undefined;
    for (const motionId of rec.motions) {
      const m = known<MotionBody>(await this.#runner.get("meeting-motion", motionId));
      if (m === undefined || (m.state !== "voting" && m.state !== "tie-pending")) continue;
      for (const voter of rec.roster) {
        const b = known<BallotBody>(await this.#runner.get("meeting-ballot", derivedId("mbl", `${motionId}:${voter}`)));
        if (b !== undefined && quotesBallot(text, b.reason)) { warning = `This message repeats the reason of ${voter}'s ballot while the vote on motion ${m.number} is open. Everyone who speaks after it will see those words, so ballots stop being private. Send it again with acknowledged true if that is what you want.`; break; }
      }
      if (warning !== undefined) break;
    }
    if (warning !== undefined && command.acknowledged !== true) throw new DomainError("invalid_command", warning, { field: "acknowledged" });
    const wrote = await this.#records.append(by, { commandId: command.commandId, recordId, kind: "owner-message", text });
    return { id: wrote.id, seq: wrote.seq, ...(warning === undefined ? {} : { warning }) };
  }

  async #freshPass(body: ProcedureBody, version: number): Promise<ProcedureBody> {
    return { ...body, version, stage: "comment", round: 1, rounds: 1, roundSince: (await this.#rec(body.recordId)).nextSeq, asked: [], check: { run: 1, answers: [] }, dissent: [], fresh: body.fresh + 1, voteAsked: [], ballotSeq: [], noBallot: [], offers: [], offersCapped: [] };
  }

  // ---- reading ------------------------------------------------------------------------------------------------------------------------------

  /**
   * Where a motion's procedure stands. The owner, a host, a service and the chair see all of it. A member sees its own state and the stage, the settings and the rulings, but never who has voted or how (the order of ballots would
   * tell). A reader of the meeting's record sees the same as a member. Nobody else sees it.
   */
  async status(viewer: Principal, motionId: string): Promise<Record<string, unknown> | undefined> {
    const id = this.#motionId(motionId);
    const proc = await this.#runner.get(PROCEDURE_KIND, derivedId("mpr", id));
    const body = known<ProcedureBody>(proc);
    if (proc === undefined || body === undefined) return undefined;
    if ((await this.#records.record(viewer, body.recordId)) === undefined) return undefined;
    const rec = await this.#rec(body.recordId);
    // The chair is usually a voter too, so it sees what a member sees: never who has voted, revised or stayed silent while a vote is open.
    const full = isService(viewer);
    void rec;
    const { voteAsked: _a, ballotSeq: _b, noBallot: _n, offers: _o, offersCapped: _c, stances: _s, echo: _e, ...open } = body;
    void _a; void _b; void _n; void _o; void _c; void _s; void _e;
    const waiting = body.stage === "ruling" ? this.#waitingRuling(body) : undefined;
    return { id: proc.id, revision: proc.revision, ...(full ? body : open), ...(waiting === undefined ? {} : { waiting }) };
  }

  /**
   * What a motion's procedure is waiting for next, for the controller's own views (the floor's waiting-on): the stage, what is expected (a statement, an objection answer, a ruling, a ballot, a revision turn, the count) and from whom. A read
   * of the records only; the caller decides who may see it (who has voted must not reach a member).
   */
  async expecting(motionId: string): Promise<{ stage: ProcedureStage; what: string; agent?: string } | undefined> {
    const id = this.#motionId(motionId);
    const proc = await this.#runner.get(PROCEDURE_KIND, derivedId("mpr", id));
    const body = known<ProcedureBody>(proc);
    if (proc === undefined || body === undefined) return undefined;
    const m = await this.#motion(id);
    const rec = await this.#rec(body.recordId);
    const done = (what: string, agent?: string): { stage: ProcedureStage; what: string; agent?: string } => ({ stage: body.stage, what, ...(agent === undefined ? {} : { agent }) });
    if (FINAL.has(m.state) || body.stage === "concluded" || body.stage === "tabled" || body.stage === "void") return done("nothing");
    switch (body.stage) {
      case "comment": {
        const heard = new Set(body.asked);
        const joined = await this.#joinedSince(body.recordId, body.roundSince);
        const agent = body.seats.find((a) => joined.includes(a) && !heard.has(a)) ?? body.seats.find((a) => !heard.has(a));
        return agent === undefined ? done("round-end") : done("statement", agent);
      }
      case "check": { const answered = new Set(body.check.answers.map((a) => a.agent)); const agent = body.seats.find((a) => !answered.has(a)); return agent === undefined ? done("check-end") : done("objection", agent); }
      case "ruling": return done("ruling", rec.chair);
      case "ready": return done("open-vote");
      case "voting": {
        if (m.state === "tie-pending") return done("casting-vote", rec.chair);
        if (m.heldAt !== undefined) return done("inquiry");
        const next = body.seats.find((a) => !body.voteAsked.includes(a));
        if (next !== undefined) return done("ballot", next);
        const found = await this.#nextOffer({ id: "service:meeting-procedure", kind: "service", name: "meeting-procedure", asOf: this.#runner.now(), grants: [] } as unknown as Principal, proc);
        return found.offer === undefined ? done("close-vote") : done("revision", found.offer.agent);
      }
      default: return done("nothing");
    }
  }

  /** What the owner can rule on: procedures waiting for a ruling and tabled motions the owner can overrule. Owner only. */
  async ownerControls(by: Principal): Promise<{ rulings: { motionId: string; recordId: string; projectId: string; number: number; text: string; why: string }[]; tabled: { motionId: string; recordId: string; projectId: string; number: number; text: string; reason: string }[] }> {
    const none = { rulings: [], tabled: [] };
    if (by.kind !== "owner" || by.taskScope !== undefined) return none;
    const rulings: { motionId: string; recordId: string; projectId: string; number: number; text: string; why: string }[] = [];
    const tabled: { motionId: string; recordId: string; projectId: string; number: number; text: string; reason: string }[] = [];
    let after: string | undefined;
    for (let page = 0; page < PROCEDURE_LIMITS.pages; page++) {
      const list = await this.#runner.list(PROCEDURE_KIND, { ...(after === undefined ? {} : { afterId: after }), limit: 100 });
      for (const a of list) {
        const b = a.body as unknown as ProcedureBody;
        if (b.stage !== "ruling" && !(b.stage === "tabled" && b.overruledBy === undefined)) continue;
        const rec = known<RecordBody>(await this.#runner.get("meeting-record", b.recordId));
        if (rec === undefined || rec.state !== "open") continue;
        const m = known<MotionBody>(await this.#runner.get("meeting-motion", b.motionId));
        if (m === undefined) continue;
        if (b.stage === "ruling") rulings.push({ motionId: b.motionId, recordId: b.recordId, projectId: b.projectId, number: m.number, text: m.text.slice(0, 300), why: this.#waitingRuling(b).why });
        else tabled.push({ motionId: b.motionId, recordId: b.recordId, projectId: b.projectId, number: m.number, text: m.text.slice(0, 300), reason: b.tabled?.reason ?? "" });
      }
      if (list.length < 100) break;
      after = list[list.length - 1]!.id;
    }
    return { rulings, tabled };
  }

  // ---- helpers -----------------------------------------------------------------------------------------------------------------------------

  async #settings(): Promise<ProcedureSettings> {
    let given: Partial<ProcedureSettings> = {};
    try { given = (await this.#options.settings?.()) ?? {}; } catch { given = {}; }
    const pick = <K extends keyof ProcedureSettings>(k: K): ProcedureSettings[K] => (given[k] === undefined ? PROCEDURE_DEFAULTS[k] : (given[k] as ProcedureSettings[K]));
    return { rounds: pick("rounds"), objectionReruns: pick("objectionReruns"), maxRevisions: pick("maxRevisions"), tabling: pick("tabling"), echoFlag: pick("echoFlag"), seating: pick("seating") };
  }

  async #load(motionId: string): Promise<Aggregate & { body: ProcedureBody }> {
    const found = await this.#runner.get(PROCEDURE_KIND, derivedId("mpr", motionId));
    if (found === undefined) throw new DomainError("not_found", `motion ${motionId} has no procedure`);
    return found as Aggregate & { body: ProcedureBody };
  }

  #body(proc: Aggregate): ProcedureBody { return proc.body as unknown as ProcedureBody; }

  async #motion(motionId: string): Promise<MotionBody> {
    const m = known<MotionBody>(await this.#runner.get("meeting-motion", motionId));
    if (m === undefined) throw new DomainError("not_found", `no motion ${motionId}`);
    return m;
  }

  async #rec(recordId: string): Promise<RecordBody> {
    const r = known<RecordBody>(await this.#runner.get("meeting-record", recordId));
    if (r === undefined) throw new DomainError("not_found", `no meeting record ${recordId}`);
    return r;
  }

  #view(m: MotionBody, id: string): MotionView { return { id, number: m.number, version: m.version, text: m.text }; }

  /**
   * The transcript as a member is given it: every statement, ruling and message so far, in order, with corrections in force, and never a ballot (ballots are not entries). Read from the records by the service itself, so the controller's
   * own principal needs no right to read meetings.
   */
  async #transcript(_by: Principal, recordId: string): Promise<MeetingDelivered[]> {
    const rec = await this.#rec(recordId);
    const out: MeetingDelivered[] = [];
    for (let seq = 1; seq < rec.nextSeq; seq++) {
      const found = await this.#runner.get("meeting-entry", entryIdOf(recordId, seq));
      const e = known<{ kind: string; speaker: string; text: string }>(found);
      if (found === undefined || e === undefined || e.kind === "presence") continue;
      const corrected = rec.corrections.find((c) => c.target === found.id);
      out.push({ seq, kind: e.kind, speaker: e.speaker, text: corrected?.text ?? e.text });
    }
    return out;
  }

  /** The members who joined the room since sequence number `since`. */
  async #joinedSince(recordId: string, since: number): Promise<string[]> {
    const rec = await this.#rec(recordId);
    const out: string[] = [];
    for (let seq = Math.max(1, since); seq < rec.nextSeq; seq++) {
      const e = known<{ kind: string; speaker: string; text: string }>(await this.#runner.get("meeting-entry", entryIdOf(recordId, seq)));
      if (e !== undefined && e.kind === "presence" && e.text.endsWith(" joined.") && !out.includes(e.speaker)) out.push(e.speaker);
    }
    return out;
  }

  async #statements(seqs: readonly number[], recordId: string): Promise<{ speaker: string; text: string }[]> {
    const out: { speaker: string; text: string }[] = [];
    for (const seq of seqs) {
      if (seq <= 0) continue;
      const e = known<{ speaker: string; text: string }>(await this.#runner.get("meeting-entry", entryIdOf(recordId, seq)));
      if (e !== undefined) out.push({ speaker: e.speaker, text: e.text });
    }
    return out;
  }

  /** Saves the procedure's next state under the revision just read: a competing step makes this one retry from what it finds, never overwrite. */
  async #save(proc: Aggregate, next: ProcedureBody, what: string): Promise<void> {
    await this.#runner.command("meeting.procedure.step", { commandId: `mpr-step-${proc.id}-${proc.revision}`, actor: "service:meeting-procedure" }, async () => ({
      payload: { what },
      build: async () => {
        const ref = { kind: PROCEDURE_KIND, id: proc.id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: proc.revision, body: json(next) }], detail: { projectId: next.projectId, what } };
      },
    }));
  }

  #motionId(value: unknown): string { return typeof value === "string" && MOTION_ID.test(value) ? value : invalid("motionId", "is not a motion ID"); }
}

/** Only the fields of a ruling, whatever else a model chair's answer carries. */
const pickRuling = (r: RulingInput): Record<string, unknown> => {
  const out: Record<string, unknown> = { ruling: r.ruling };
  if ("text" in r && r.text !== undefined) out["text"] = r.text;
  if ("reason" in r && r.reason !== undefined) out["reason"] = r.reason;
  if ("addressed" in r && r.addressed !== undefined) out["addressed"] = r.addressed;
  return out;
};
const haltWaiting = (halt: Extract<FloorGate, { halt: unknown }>): Waiting => (halt.halt === "inquiry" ? { on: "owner", why: halt.why } : { on: "time", why: halt.why });
const entryIdOf = (recordId: string, seq: number): string => `mte-${recordId.slice(4)}-${seq}`;
const motionIdOf = (proc: Aggregate): string => (proc.body as unknown as ProcedureBody).motionId;
