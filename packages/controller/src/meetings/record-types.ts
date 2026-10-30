import type { JsonObject } from "../storage/types.js";
import type { BallotValue, VoteOutcome, Tally, TieBreak } from "./votes.js";

/** What kind of entry the meeting record holds. Motions, amendments, votes are made only by their own commands (they carry structure); the others are appended with `append`. */
export type EntryKind = "statement" | "owner-message" | "motion" | "amendment" | "ruling" | "vote" | "correction" | "presence";
export const ENTRY_KINDS: readonly EntryKind[] = ["statement", "owner-message", "motion", "amendment", "ruling", "vote", "correction", "presence"];
/** Marks a statement for the summary: a key update, an unresolved question, an action, or a stand-up plan item. */
export type EntryTag = "update" | "question" | "action" | "plan";
export const ENTRY_TAGS: readonly EntryTag[] = ["update", "question", "action", "plan"];

/** A record a statement rests on. Private records (an agent's desk, scratch) cannot be shared with the meeting's readers: a conclusion that rests on one is published marked unverifiable. */
export interface SourceCite { readonly kind: string; readonly id: string; readonly revision?: number }

export interface MeetingEntryBody {
  readonly recordId: string;
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly seq: number;
  readonly kind: EntryKind;
  /** The authenticated principal that wrote the entry down. */
  readonly by: string;
  /** Who spoke: the same principal, or (when the controller wrote down a turn) the roster agent whose turn it was. */
  readonly speaker: string;
  readonly at: string;
  readonly text: string;
  readonly tag?: EntryTag;
  readonly assignee?: string;
  readonly taskId?: string;
  readonly motionId?: string;
  readonly motionVersion?: number;
  /** A correction points at the entry it corrects (the original is never changed). */
  readonly corrects?: string;
  /** A ruling by the owner that overrules an earlier ruling. */
  readonly overrules?: string;
  /** A statement that answers an earlier question entry. */
  readonly answers?: string;
  readonly sources?: readonly SourceCite[];
  /** Structured content of motion, amendment and vote entries (the ballot table, the changes proposed). */
  readonly data?: JsonObject;
}

export interface Tagged { readonly entryId: string; readonly seq: number; readonly tag: EntryTag; readonly speaker: string; readonly text: string; readonly assignee?: string; readonly taskId?: string; readonly sources?: readonly SourceCite[]; readonly answeredBy?: string; readonly correctedBy?: string }

export type RecordState = "open" | "ended" | "interrupted";

export interface RecordBody {
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly title: string;
  readonly state: RecordState;
  /** The agent chairing (it may or may not be on the roster). Absent: no chair, so a tie fails. */
  readonly chair?: string;
  readonly chairChanges: number;
  /** Fixed when the record was opened (the occurrence's roster). A later schedule edit, a new agent or a second session adds no voice. */
  readonly roster: readonly string[];
  /** Roster members who could not be asked when the occurrence was made (paused, suspended, stopped): absent, not abstaining. */
  readonly withheld: readonly string[];
  /** Roster members who took part (joined, spoke or voted). */
  readonly attended: readonly string[];
  readonly ownerPresent: boolean;
  readonly ownerJoins: number;
  readonly endsAt: string;
  readonly nextSeq: number;
  readonly tagged: readonly Tagged[];
  /** Entries that have been corrected: the target, the correction entries in order, and the text now in force (the original entry is never changed). */
  readonly corrections: readonly { readonly target: string; readonly entries: readonly string[]; readonly text: string }[];
  readonly motions: readonly string[];
  readonly openedAt: string;
  readonly openedBy: string;
  readonly endedAt?: string;
  readonly endedBy?: string;
  readonly endReason?: string;
}

export type MotionState = "proposed" | "voting" | "tie-pending" | "adopted" | "rejected" | "failed" | "no-quorum" | "tabled" | "void";
export const FINAL_MOTION_STATES: readonly MotionState[] = ["adopted", "rejected", "failed", "no-quorum", "tabled", "void"];

/** What a motion would change if adopted. The carrier is the roster agent whose authority the change relies on: it must hold the action at the moment the change is applied. */
export interface ProposedChange {
  readonly id: string;
  /** A kind the controller knows how to apply (a registered applier), for example `task.update`. */
  readonly kind: string;
  readonly agent: string;
  readonly target: { readonly kind: string; readonly id: string };
  /** The revision of the target the proposal was made against. If the target moved, the change is not applied. */
  readonly expectedRevision: number;
  readonly patch: JsonObject;
  readonly summary: string;
}

export interface MotionBody {
  readonly recordId: string;
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly number: number;
  readonly proposer: string;
  readonly version: number;
  readonly text: string;
  readonly versions: readonly { readonly version: number; readonly text: string; readonly by: string; readonly at: string; readonly entryId: string }[];
  /** The entries about this motion, in order: the motion itself, amendments, rulings, the vote. */
  readonly trail: readonly { readonly entryId: string; readonly seq: number; readonly kind: EntryKind }[];
  /** The owner-decision topic the motion touches, if any: a recorded owner decision on it is not overridden. */
  readonly topic?: string;
  readonly agendaItemId?: string;
  readonly changes: readonly ProposedChange[];
  readonly sources?: readonly SourceCite[];
  readonly state: MotionState;
  readonly chairAtOpen?: string;
  readonly limitMinutes: number;
  readonly votingOpenedAt?: string;
  readonly closesAt?: string;
  readonly heldAt?: string;
  readonly castingDeadline?: string;
  readonly closedAt?: string;
  readonly decisionId?: string;
  readonly voidReason?: string;
  /** Why it ended without a decision (tabled, or void), and whether that was handed back to its agenda item. */
  readonly outcomeReturned?: boolean;
  /** How many ballots (and revisions) have been cast: every one moves the motion's revision, so closing and casting cannot miss each other. */
  readonly ballots?: number;
  readonly createdAt: string;
}

export interface BallotHistory { readonly version: number; readonly value: BallotValue; readonly reason: string; readonly at: string; readonly trigger: string }

export interface BallotBody {
  readonly motionId: string;
  readonly recordId: string;
  readonly projectId: string;
  readonly voter: string;
  /** The motion version the current ballot is bound to. A ballot for another version does not count. */
  readonly version: number;
  readonly value: BallotValue;
  readonly reason: string;
  readonly sources?: readonly SourceCite[];
  readonly at: string;
  /** Every ballot and revision, oldest first, with what triggered it. */
  readonly history: readonly BallotHistory[];
  /** The owner messages this voter has already revised for (at most one revision per message). */
  readonly revisedFor: readonly string[];
  /** The record's sequence counter when the ballot was cast: an owner message numbered after it is a reason to revise. */
  readonly castAtSeq?: number;
}

export type ChangeState = "adopted" | "applying" | "applied" | "not-applied";
export type NotAppliedCode = "recommendation" | "conflict" | "unauthorized" | "owner" | "gate" | "missing" | "failed";

export interface ChangeRecord extends ProposedChange {
  readonly state: ChangeState;
  readonly code?: NotAppliedCode;
  readonly reason?: string;
  readonly appliedRevision?: number;
  /** Who allowed the change, recorded when it enters `applying` so a replay uses the same basis. */
  readonly agreedBy?: string;
  /** The principal id the effect is carried out as, recorded when the change enters `applying`: the command digest includes the actor, so a replay by someone else (the service after the owner's agreement) must reuse it. */
  readonly actedAs?: string;
  readonly at?: string;
}

export type OwnerResponse = "not-asked" | "pending" | "agreed" | "declined" | "alternative";

export interface DecisionRecordBody {
  readonly motionId: string;
  readonly recordId: string;
  readonly occurrenceId: string;
  readonly projectId: string;
  readonly number: number;
  readonly version: number;
  readonly text: string;
  readonly outcome: VoteOutcome;
  readonly tally?: Tally;
  readonly tie?: TieBreak;
  /** Every voter's last ballot with its reason (the original ballots and revisions are in the ballot records). */
  readonly table: readonly { readonly voter: string; readonly value: BallotValue; readonly reason: string; readonly revisions: number; readonly sources?: readonly SourceCite[] }[];
  /** Those who voted against the outcome, and those who abstained. */
  readonly dissent: readonly { readonly voter: string; readonly value: BallotValue; readonly reason: string }[];
  readonly abstained: readonly string[];
  /** The discussion this decision came from: the sequence numbers to read in the full-discussion view, and the entries that bear on it. */
  readonly discussion: { readonly fromSeq: number; readonly toSeq: number; readonly entryIds: readonly string[] };
  /** `in-scope`: the team may carry it out within authority it already has. `recommendation`: it advises, and nothing is applied. */
  readonly scope: "in-scope" | "recommendation";
  readonly scopeReason?: string;
  readonly changes: readonly ChangeRecord[];
  readonly ownerResponse: OwnerResponse;
  readonly ownerDecisionId?: string;
  readonly ownerRespondedAt?: string;
  readonly agendaItemId?: string;
  readonly topic?: string;
  readonly sources?: readonly SourceCite[];
  readonly concludedAt: string;
}

export interface SummaryDecision {
  readonly id: string;
  readonly number: number;
  readonly text: string;
  readonly outcome: DecisionRecordBody["outcome"];
  /** adopted: voted for and not yet applied; applied / part-applied / not-applied; waiting-for-owner; recommendation: adopted but advisory; and the unadopted outcomes. */
  readonly status: "applied" | "part-applied" | "adopted" | "not-applied" | "waiting-for-owner" | "recommendation" | "rejected" | "failed" | "no-quorum" | "tabled" | "void";
  readonly verifiable: boolean;
  readonly reasons: readonly { readonly voter: string; readonly value: BallotValue; readonly reason: string; readonly verifiable: boolean }[];
  readonly dissent: readonly { readonly voter: string; readonly value: BallotValue; readonly reason: string }[];
  readonly abstained: readonly string[];
  readonly tally?: Tally;
  readonly tie?: TieBreak;
  readonly discussion: { readonly recordId: string; readonly fromSeq: number; readonly toSeq: number };
  readonly changes: readonly { readonly id: string; readonly summary: string; readonly state: ChangeState; readonly reason?: string }[];
  readonly ownerResponse: OwnerResponse;
  readonly ownerDecisionId?: string;
}

export interface SummaryItem { readonly entryId: string; readonly seq: number; readonly speaker: string; readonly text: string; readonly verifiable: boolean; readonly assignee?: string; readonly taskId?: string }

/** The meeting summary, built from the records alone. */
export interface SummaryContent {
  readonly occurrenceId: string;
  readonly recordId: string;
  readonly title: string;
  readonly meetingState: RecordState;
  /** The meeting was interrupted: this is what the records held when it stopped. */
  readonly partial: boolean;
  readonly attendance: {
    readonly present: readonly string[];
    readonly absent: readonly { readonly id: string; readonly why: string }[];
    readonly didNotTakePart: readonly string[];
    readonly chair?: string;
    readonly owner: { readonly present: boolean; readonly joins: number };
  };
  readonly keyUpdates: readonly SummaryItem[];
  readonly decisions: readonly SummaryDecision[];
  /** Adopted is not applied: what the meeting voted for, and separately what was carried out. */
  readonly adopted: readonly string[];
  readonly applied: readonly { readonly decisionId: string; readonly changeId: string; readonly summary: string }[];
  readonly notApplied: readonly { readonly decisionId: string; readonly changeId: string; readonly summary: string; readonly reason: string }[];
  readonly dissent: readonly { readonly decisionId: string; readonly voter: string; readonly value: BallotValue; readonly reason: string }[];
  readonly unresolved: readonly { readonly kind: "question" | "motion" | "owner"; readonly text: string; readonly ref: string }[];
  readonly actions: readonly SummaryItem[];
  readonly plan: readonly SummaryItem[];
  /** The summary agrees with the decision records it was built from (every counted change is in exactly one list). */
  readonly consistent: boolean;
  /** Some conclusions rest on private records the readers cannot see: they are shown as claims, marked unverifiable. */
  readonly unverifiableCount: number;
}

export interface MeetingSummaryBody {
  readonly occurrenceId: string;
  readonly recordId: string;
  readonly projectId: string;
  /** How many times the snapshot was written. */
  readonly builds: number;
  readonly builtAt: string;
  readonly content: SummaryContent;
  /** A narrative overview written by the summarizer, when one was configured and succeeded. */
  readonly overview?: string;
  /** The summarizer failed: the summary above is still complete (it never depends on it). */
  readonly overviewFailed?: string;
}

export interface PlanBody { readonly projectId: string; readonly occurrenceId: string; readonly recordId: string; readonly at: string; readonly items: readonly SummaryItem[] }

export interface OpenIndexBody { readonly projectId: string; readonly ids: readonly string[] }
