import type { SourceCite } from "./record-types.js";
import type { Prompt, TurnUsage } from "./floor-text.js";
import type { FloorSettings } from "./floor-settings.js";

/** What kind of turn a model is asked for. Every turn is its own tool-less call; the controller reads the reply and writes what it means into the meeting record. */
export type TurnKind =
  | "statement" | "blind-statement" | "direct-answer" | "direct-continue" | "chair-answer" | "reply" | "owner-answer" | "checkpoint-answer" | "revision" | "ballot" | "correction" | "objection"
  | "chair-notes" | "chair-questions" | "desk-offer" | "desk-excerpts" | "chair-summary" | "chair-reminders" | "chair-ruling" | "casting";

/** One model call, as the facilitator asks for it. The runner may not use tools, and must stop at `signal`. */
export interface TurnRequest {
  readonly kind: TurnKind;
  /** The member (or the chair) whose turn it is. Nothing is asked of a member who does not hold the floor. */
  readonly agent: string;
  readonly recordId: string;
  readonly prompt: Prompt;
  readonly maxVisibleTokens: number;
  readonly maxHiddenTokens: number;
  readonly signal: AbortSignal;
  readonly round?: number;
}

export interface TurnReply {
  readonly text: string;
  readonly usage?: TurnUsage;
  /** What the call cost in dollars, when the route knows it. */
  readonly costUsd?: number;
}

/** The model side of a meeting (a worker's bridge in production; a scripted fake in tests). It is asked for one turn at a time and never holds a tool. */
export interface TurnRunner { turn(request: TurnRequest): Promise<TurnReply> }

/** A turn that cannot finish because the agent is waiting on a tool: the meeting shows that it waits on a tool, and the unit is tried again at the next advance. */
export class TurnWaitsOnTool extends Error {
  readonly tool: string;
  constructor(tool: string) { super(`waiting on ${tool}`); this.name = "TurnWaitsOnTool"; this.tool = tool; }
}

/**
 * The units of work the floor runs itself: the owner's questions, answers to the members' and the chair's questions, the chair's work between rounds, the correction of a member whose desk was read, and the timebox's wrap-up. Rounds,
 * the objection check, rulings, ballots, revision turns and the casting vote are the meeting procedure's (card M06); the floor only supplies the model turns for them.
 */
export type UnitKind =
  | "direct-answer" | "direct-continue" | "direct-skip" | "chair-answer" | "reply" | "owner-ask"
  | "chair-notes" | "chair-questions" | "desk-offer" | "desk-excerpts" | "correction" | "chair-summary" | "chair-reminders" | "wrap-up";

/** A step waiting its turn in front of the rest. Owner questions come first. */
export interface QueueItem {
  readonly id: string;
  readonly kind: "owner-ask" | "chair-answer" | "reply" | "direct-answer" | "direct-continue" | "direct-skip" | "chair-notes";
  readonly agent: string;
  /** owner-ask: the owner's question entry; revision: the owner message revised for; direct-answer / continue: the asker. */
  readonly entryId?: string;
  readonly question?: string;
  readonly from?: string;
  readonly chairQuestionId?: string;
  /** direct-skip: the target of the skipped question. */
  readonly target?: string;
  /** The owner's question went to an agent that is not in the room: answered from its checkpoint. */
  readonly checkpoint?: true;
  readonly asOfSeq?: number;
}

export interface ChairQuestionRecord {
  readonly id: string;
  readonly to: string;
  readonly topic: string;
  readonly experienceSought: string;
  readonly askedBy: "chair" | string;
  readonly why: string;
  readonly round: number;
  readonly state: "asked" | "answered" | "skipped" | "withdrawn";
  readonly entryId?: string;
  readonly answerEntryId?: string;
  readonly challenge?: { readonly by: string; readonly reason: string; readonly ruling?: "upheld" | "dismissed"; readonly ruledBy?: string };
}

export interface DeskOffer { readonly id: string; readonly owner: string; readonly title: string; readonly visibility: "shared" | "private" }

export interface DeskState {
  readonly offered: readonly DeskOffer[];
  /** The file IDs the chair asked to read and the controller read (one inspection record each). */
  readonly filesRead: readonly string[];
  /** The files an excerpt was quoted from, verified verbatim. */
  readonly filesQuoted: readonly string[];
  readonly refused: readonly { readonly id: string; readonly why: string }[];
  readonly rejectedExcerpts: number;
  readonly corrections: readonly { readonly member: string; readonly entryId: string }[];
  /** The members whose desks were read; each is asked for a correction once it is in the room. */
  readonly readOwners: readonly string[];
  /** The text of the files just read (redacted), kept only between the read and the chair's choice of excerpts. */
  readonly pending: readonly { readonly id: string; readonly owner: string; readonly title: string; readonly text: string }[];
}

export interface TurnLog {
  readonly unit: string;
  readonly kind: TurnKind;
  readonly agent: string;
  readonly at: string;
  readonly visibleTokens: number;
  readonly hiddenTokens: number;
  readonly truncated?: true;
  readonly hiddenOver?: true;
  readonly noResponse?: string;
  /** The transcript the member was given: entries up to this sequence number (0: none, a blind round). */
  readonly deliveredUpTo: number;
  readonly entryId?: string;
}

export interface Notice { readonly at: string; readonly kind: string; readonly text: string }

/** Where the meeting procedure has a motion (card M06), as the floor shows it; `none` when no motion is on the floor. */
export type FloorPhase = "none" | "comment" | "check" | "ruling" | "ready" | "voting" | "concluded" | "tabled" | "void";

export interface InquiryState {
  readonly openedAt: string;
  readonly lastActivityAt: string;
  readonly questions: number;
  readonly voteHeld: boolean;
  /** The motion whose vote the inquiry held (the floor's own, or one the meeting procedure or the record runs). */
  readonly heldMotionId?: string;
  readonly addressed: readonly string[];
  readonly remindedAt?: string | undefined;
  /** The owner message entries entered during the inquiry. */
  readonly messages: readonly string[];
}

export interface HeldAnswer { readonly agent: string; readonly text: string; readonly at: string; readonly question: string }

export interface OwnerAnswerRecord {
  /** The owner's question entry. */
  readonly entryId: string;
  /** The answer's own entry, absent while the answer is held until the vote closes. */
  readonly answerEntryId?: string | undefined;
  readonly agent: string;
  readonly question: string;
  readonly completed: readonly string[];
  readonly proposed: readonly string[];
  readonly stale: readonly string[];
  /** Sources the answer cited with a revision that could not be checked (a private kind, another project's record, a record that does not exist, a failed read): never marked current. Absent on older entries. */
  readonly unchecked?: readonly string[];
  readonly checkpoint?: string;
  readonly held?: true;
}

export interface Inflight {
  readonly id: string;
  readonly kind: UnitKind;
  readonly agent?: string;
  readonly agents?: readonly string[];
  readonly since: string;
  readonly queueId?: string;
  /** The model's reply, stored before anything is written to the meeting record, so a repeat after a crash writes the same words and spends nothing more. */
  readonly reply?: StoredReply;
  readonly owner?: true;
}

export interface StoredReply {
  /** One entry per member asked (a batch), or one for a single turn. */
  readonly items: readonly { readonly agent: string; readonly text: string; readonly noResponse?: string; readonly usage: { readonly visible: number; readonly hidden: number; readonly input: number; readonly cached: number }; readonly truncated?: true; readonly hiddenOver?: true; readonly deliveredUpTo: number; readonly waitsOnTool?: string; readonly costUsd?: number }[];
  readonly costUsd: number;
}

/** The floor's own state for one meeting: its queue, clock and spend, the chair's notes and desk reads, the owner's inquiry and what the members and the chair said to the owner. Never a motion's rounds, ballots or rulings: those are the procedure's. */
export interface FloorBody {
  readonly recordId: string;
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly state: "running" | "ended";
  readonly settings: FloorSettings;
  readonly queue: readonly QueueItem[];
  /** The motion the floor was started with (informational; the procedure runs it). */
  readonly motionId?: string | undefined;
  readonly inflight?: Inflight | undefined;
  readonly unitSeq: number;
  /** The chair's work between two comment rounds, one step at a time (the procedure asks for it at the end of each round). */
  readonly between?: BetweenState | undefined;
  readonly lastBetween?: { readonly key: string; readonly summary?: string | undefined } | undefined;
  /** What the members and the chair were asked for the procedure, answered and not yet used up: a repeat after a restart writes the same words and spends nothing more. Newest last, a window. */
  readonly replies: Readonly<Record<string, PortReply>>;
  /** Asks in flight (key to the time they began): another driver asking the same thing waits, a claim whose asker died is taken over. */
  readonly claims: Readonly<Record<string, string>>;
  readonly clock: { readonly startedAt: string; readonly durationMs: number; readonly extraMs: number; readonly pausedMs: number; readonly pausedAt?: string | undefined };
  readonly spend: { readonly usd: number; readonly tokens: number; readonly calls: number; readonly hiddenTokens: number; readonly ownerUsd: number; readonly ownerTokens: number; readonly extraUsd: number; readonly extraTokens: number };
  readonly timebox?: { readonly reason: "time" | "spend"; readonly at: string } | undefined;
  readonly turns: readonly TurnLog[];
  readonly deliveries: number;
  /** TLDR summaries of long statements, by the speaker and the words (the statement is written by the procedure, so its entry is looked up by what it says). */
  readonly summaries: Readonly<Record<string, string>>;
  readonly chairNotes?: string | undefined;
  readonly chairNotesAt?: string | undefined;
  readonly chairNotesCount: number;
  readonly chairQuestions: readonly ChairQuestionRecord[];
  readonly chairQuestionsAsked: number;
  readonly asks: Readonly<Record<string, number>>;
  readonly desk: DeskState;
  readonly skipped: readonly { readonly agent: string; readonly why: string; readonly at: string }[];
  readonly inquiry?: InquiryState | undefined;
  readonly held: readonly HeldAnswer[];
  readonly ownerAnswers: readonly OwnerAnswerRecord[];
  readonly investigations: readonly { readonly text: string; readonly by: string; readonly entryId?: string; readonly taskId?: string }[];
  /** `assigned`: the task was given to its owner (absent on entries made before that was kept, false when the assignment could not be made: the task stays open and names its owner). */
  readonly followUps: readonly { readonly key: string; readonly taskId: string; readonly title: string; readonly owner?: string; readonly assigned?: boolean }[];
  /** When the floor itself turned what the ended meeting left open into follow-up tasks (once, after the meeting ended); `followUpTries` counts the scheduled turn's attempts until then, at most `FLOOR_LIMITS.followUpTries`. */
  readonly followUpsAt?: string | undefined;
  readonly followUpTries?: number | undefined;
  readonly notices: readonly Notice[];
  readonly priorities: readonly { readonly itemId: string; readonly urgency?: string; readonly at: string }[];
  readonly waitingTool?: { readonly tool: string; readonly agent: string; readonly since: string } | undefined;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
}

export interface BetweenState {
  readonly key: string;
  readonly motionId: string;
  readonly version: number;
  readonly round: number;
  readonly rounds: number;
  readonly fresh: number;
  readonly todo: readonly string[];
  readonly summary?: string | undefined;
}

/** One model answer kept for the procedure (the same shape as a unit's stored item, without the cost bookkeeping). */
export type PortReply = StoredReply["items"][number];

/** What `advance` did. */
export type AdvanceResult =
  | { readonly did: UnitKind | "procedure"; readonly agent?: string; readonly phase: FloorPhase; readonly detail?: string; readonly waiting?: undefined }
  | { readonly waiting: "owner" | "tool" | "vote-time" | "busy" | "none" | "chair" | "meeting-ended"; readonly phase: FloorPhase; readonly detail?: string };

export type WaitingOn =
  | { readonly kind: "person"; readonly who: "owner"; readonly what: string; readonly since: string }
  | { readonly kind: "agent"; readonly who: string; readonly what: string; readonly since: string }
  | { readonly kind: "tool"; readonly who: string; readonly what: string; readonly since: string }
  | { readonly kind: "nothing"; readonly what: string };

export type { SourceCite };
