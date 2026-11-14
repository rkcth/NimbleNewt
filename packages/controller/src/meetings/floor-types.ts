import type { SourceCite } from "./record-types.js";
import type { Prompt, TurnUsage } from "./floor-text.js";
import type { FloorSettings } from "./floor-settings.js";

/** What kind of turn a model is asked for. Every turn is its own tool-less call; the controller reads the reply and writes what it means into the meeting record. */
export type TurnKind =
  | "statement" | "blind-statement" | "direct-answer" | "direct-continue" | "chair-answer" | "reply" | "owner-answer" | "checkpoint-answer" | "revision" | "ballot" | "correction" | "objection"
  | "chair-notes" | "chair-questions" | "desk-offer" | "desk-excerpts" | "chair-summary" | "chair-reminders" | "chair-ruling" | "chair-match" | "casting";

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

export type UnitKind =
  | "round-blind" | "round-turn" | "direct-answer" | "direct-continue" | "chair-answer" | "reply" | "owner-ask" | "revision"
  | "chair-notes" | "chair-questions" | "desk-offer" | "desk-excerpts" | "correction" | "chair-summary" | "chair-reminders"
  | "objection" | "chair-ruling" | "chair-match" | "open-vote" | "ballot" | "close-vote" | "casting" | "wrap-up";

/** A step waiting its turn in front of the rest. Owner questions come first. */
export interface QueueItem {
  readonly id: string;
  readonly kind: "owner-ask" | "revision" | "chair-answer" | "reply" | "direct-answer" | "direct-continue" | "chair-notes";
  readonly agent: string;
  /** owner-ask: the owner's question entry; revision: the owner message revised for; direct-answer / continue: the asker. */
  readonly entryId?: string;
  readonly question?: string;
  readonly from?: string;
  readonly chairQuestionId?: string;
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

export type FloorPhase = "round" | "between" | "objection" | "ruling" | "match" | "vote" | "done";

export interface VoteState {
  readonly motionId: string;
  readonly version: number;
  readonly order: readonly string[];
  readonly opened: boolean;
  readonly cast: Readonly<Record<string, number>>;
  readonly noResponse: readonly string[];
  readonly revisions: Readonly<Record<string, number>>;
  /** The latest owner message entry the voters were asked to revise for, and who was owed a turn for it. */
  readonly trigger?: string;
  readonly closed?: boolean;
  readonly tie?: boolean;
  readonly decisionId?: string;
  readonly castingAsked?: boolean;
  /** `<owner message>:<voter>` pairs already offered a revision turn. */
  readonly offered?: readonly string[];
}

export interface InquiryState {
  readonly openedAt: string;
  readonly lastActivityAt: string;
  readonly questions: number;
  readonly voteHeld: boolean;
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

export interface FloorBody {
  readonly recordId: string;
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly state: "running" | "ended";
  readonly settings: FloorSettings;
  readonly phase: FloorPhase;
  readonly round: number;
  readonly fresh: boolean;
  readonly order: readonly string[];
  readonly spoken: readonly string[];
  readonly turn: number;
  readonly todo: readonly string[];
  readonly queue: readonly QueueItem[];
  readonly motionId?: string | undefined;
  readonly motionVersion?: number | undefined;
  readonly objection: { readonly attempt: number; readonly objectors: readonly { readonly agent: string; readonly reason: string; readonly research?: true }[]; readonly noResponse: readonly string[] };
  readonly vote?: VoteState | undefined;
  readonly inflight?: Inflight | undefined;
  readonly unitSeq: number;
  readonly clock: { readonly startedAt: string; readonly durationMs: number; readonly extraMs: number; readonly pausedMs: number; readonly pausedAt?: string | undefined };
  readonly spend: { readonly usd: number; readonly tokens: number; readonly calls: number; readonly hiddenTokens: number; readonly ownerUsd: number; readonly ownerTokens: number; readonly extraUsd: number; readonly extraTokens: number };
  readonly timebox?: { readonly reason: "time" | "spend"; readonly at: string } | undefined;
  readonly turns: readonly TurnLog[];
  readonly deliveries: number;
  readonly summaries: Readonly<Record<string, string>>;
  readonly stances: Readonly<Record<string, Readonly<Record<string, string>>>>;
  readonly amendments: readonly { readonly by: string; readonly text: string; readonly round: number; readonly entryId: string }[];
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
  readonly followUps: readonly { readonly key: string; readonly taskId: string; readonly title: string; readonly owner?: string }[];
  readonly notices: readonly Notice[];
  readonly priorities: readonly { readonly itemId: string; readonly urgency?: string; readonly at: string }[];
  readonly waitingTool?: { readonly tool: string; readonly agent: string; readonly since: string } | undefined;
  readonly echo?: boolean | undefined;
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
}

/** What `advance` did. */
export type AdvanceResult =
  | { readonly did: UnitKind; readonly agent?: string; readonly phase: FloorPhase; readonly waiting?: undefined }
  | { readonly waiting: "owner" | "tool" | "vote-time" | "busy" | "none" | "chair" | "meeting-ended"; readonly phase: FloorPhase; readonly detail?: string };

export type WaitingOn =
  | { readonly kind: "person"; readonly who: "owner"; readonly what: string; readonly since: string }
  | { readonly kind: "agent"; readonly who: string; readonly what: string; readonly since: string }
  | { readonly kind: "tool"; readonly who: string; readonly what: string; readonly since: string }
  | { readonly kind: "nothing"; readonly what: string };

export type { SourceCite };
