import type { ProcedureSettings } from "./procedure-settings.js";
import type { BallotValue } from "./votes.js";
import type { ProcedureNote } from "./record-types.js";

/** The aggregate kind of one motion's procedure (card M06). Private: it is never a shareable citation (the default for a kind nobody classified). */
export const PROCEDURE_KIND = "meeting-procedure";

export type ProcedureStage = "comment" | "check" | "ruling" | "ready" | "voting" | "concluded" | "tabled" | "void";
export type ObjectionKind = "none" | "objection" | "research" | "no-response";

export interface ObjectionAnswer {
  readonly agent: string;
  readonly answer: ObjectionKind;
  /** The reason for an objection, or what the member would look into when it needs time to research. */
  readonly reason?: string;
}

export interface FollowUp { readonly agent: string; readonly text: string; readonly taskId?: string }

/** The state of one motion's procedure: persisted after every step, so a restart resumes where it stopped and nothing is asked twice that was already answered. */
export interface ProcedureBody {
  readonly recordId: string;
  readonly projectId: string;
  readonly motionId: string;
  /** The settings in force when the procedure began: a later change does not alter a procedure under way. */
  readonly settings: ProcedureSettings;
  /** The present members in seat order (roster less those who could not be asked when the record opened). */
  readonly seats: readonly string[];
  readonly stage: ProcedureStage;
  /** The motion version the procedure is working on. */
  readonly version: number;
  /** Comment rounds: the current one and how many this pass has (a fresh pass after a material amendment has one). */
  readonly round: number;
  readonly rounds: number;
  /** The record's sequence counter when the round began: a member who joined the room after it and has not been asked is heard first. */
  readonly roundSince: number;
  /** Members who have had the floor in the current round. */
  readonly asked: readonly string[];
  readonly spoken: readonly { readonly round: number; readonly agent: string; readonly seq: number }[];
  readonly skipped: readonly { readonly stage: "comment" | "check"; readonly round: number; readonly agent: string; readonly reason: string }[];
  readonly stances: readonly { readonly round: number; readonly agent: string; readonly stance: string }[];
  readonly summaries: readonly { readonly round: number; readonly text: string }[];
  /** The objection check: which run it is on, who has answered, and the answers. */
  readonly check: { readonly run: number; readonly answers: readonly ObjectionAnswer[] };
  readonly dissent: readonly { readonly agent: string; readonly reason: string; readonly run: number }[];
  /** The rulings made at this stage, newest last (the entries are in the transcript). */
  readonly rulings: readonly { readonly by: string; readonly ruling: string; readonly at: string; readonly entryId?: string }[];
  readonly followUps: readonly FollowUp[];
  readonly tabled?: { readonly reason: string; readonly by: string; readonly at: string };
  /** A motion moved again after the owner overruled a tabling: the tabled motion it came from; and the other way round. */
  readonly resumedFrom?: string;
  readonly overruledBy?: string;
  readonly fresh: number;
  /** Voting: members asked for a ballot, the record's sequence counter after each ballot (an owner message after it is a reason to offer a revision), and the revision turns offered. */
  readonly voteAsked: readonly string[];
  readonly ballotSeq: readonly { readonly agent: string; readonly seq: number }[];
  readonly noBallot: readonly string[];
  readonly offers: readonly { readonly agent: string; readonly messageEntryId: string; readonly outcome: "kept" | "revised" | "no-answer" }[];
  readonly offersCapped: readonly { readonly agent: string; readonly messageEntryId: string }[];
  readonly castingAsked?: boolean;
  readonly echo?: boolean;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly note?: string;
}

/** What the summary says about one motion's procedure. */
export function noteOf(number: number, motionId: string, p: ProcedureBody): ProcedureNote {
  return {
    motionId, number, rounds: p.rounds, fresh: p.fresh, objectionRuns: p.check.run,
    skipped: [...new Set(p.skipped.map((s) => s.agent))],
    noResponse: [...new Set([...p.check.answers.filter((a) => a.answer === "no-response").map((a) => a.agent), ...p.noBallot])],
    dissent: p.dissent.map((d) => ({ agent: d.agent, reason: d.reason })),
    ...(p.tabled === undefined ? {} : { tabled: { reason: p.tabled.reason, followUps: p.followUps.map((f) => ({ agent: f.agent, text: f.text, ...(f.taskId === undefined ? {} : { taskId: f.taskId }) })) } }),
    echo: p.echo === true,
  };
}

export type { BallotValue };
