/**
 * The counting rules of a meeting vote (card M02), as pure functions so they can be tested without any storage.
 *
 * - The roster is fixed when the record is opened. Quorum is a majority of that whole roster (`floor(n / 2) + 1`), counted in ballots cast, abstentions included: an abstaining member is present, an absent one is not
 *   a yes, a no or an abstention. The owner is not on the roster and is never needed for quorum.
 * - A simple majority of the yes and no ballots decides. Abstentions are neither.
 * - A tie is broken by the chair without a double vote (owner decision 2026-10-22). A chair on the roster who cast a yes or a no already has that one ballot, and a tie goes to its side. A chair who is not on the roster, or who
 *   abstained, or who cast nothing, may cast a single casting vote and only on a tie (recorded as such). When no chair can cast it, the tie fails.
 */
export type BallotValue = "yes" | "no" | "abstain";
export const BALLOT_VALUES: readonly BallotValue[] = ["yes", "no", "abstain"];

export type VoteOutcome = "adopted" | "rejected" | "failed" | "no-quorum";

export interface CountedBallot { readonly voter: string; readonly value: BallotValue; readonly reason: string; readonly revisions: number }

export interface Tally {
  /** Members on the fixed roster. */
  readonly roster: number;
  /** Members who could be asked (the roster less those who were absent when the record was opened). */
  readonly eligible: number;
  /** Ballots needed for the vote to bind. */
  readonly quorum: number;
  /** Ballots cast, abstentions included (the casting vote is not one of them). */
  readonly cast: number;
  readonly yes: number;
  readonly no: number;
  readonly abstain: number;
  /** Roster members who could not be asked (absent). */
  readonly absent: readonly string[];
  /** Eligible members who cast no ballot. */
  readonly silent: readonly string[];
}

export interface TieBreak {
  /** `chair-ballot`: the chair's own ballot decided. `casting-vote`: a single casting vote, cast only because of the tie. `none`: nobody could cast it and the tie failed. */
  readonly how: "chair-ballot" | "casting-vote" | "none";
  readonly chair?: string;
  readonly value?: "yes" | "no";
  readonly reason: string;
}

export const quorumOf = (roster: number): number => Math.floor(roster / 2) + 1;

export function tallyOf(roster: readonly string[], withheld: readonly string[], ballots: readonly CountedBallot[]): Tally {
  const eligible = roster.filter((r) => !withheld.includes(r));
  const counted = ballots.filter((b) => eligible.includes(b.voter));
  const count = (v: BallotValue): number => counted.filter((b) => b.value === v).length;
  return {
    roster: roster.length, eligible: eligible.length, quorum: quorumOf(roster.length), cast: counted.length, yes: count("yes"), no: count("no"), abstain: count("abstain"),
    absent: roster.filter((r) => withheld.includes(r)), silent: eligible.filter((r) => !counted.some((b) => b.voter === r)),
  };
}

export type VoteVerdict =
  | { readonly state: "decided"; readonly outcome: VoteOutcome; readonly tie?: TieBreak }
  /** A tie that only the chair can break: waiting for a casting vote. */
  | { readonly state: "tie"; readonly chairBallot?: undefined };

/**
 * What a closed vote came to. `chair` is the meeting's chair (undefined: none). The caller says whether the chair may still cast a casting vote (`chairCanCast`: it is the chair the vote opened under, and is not absent).
 */
export function verdictOf(tally: Tally, ballots: readonly CountedBallot[], chair: string | undefined, roster: readonly string[], chairCanCast: boolean): VoteVerdict {
  if (tally.cast < tally.quorum) return { state: "decided", outcome: "no-quorum" };
  if (tally.yes > tally.no) return { state: "decided", outcome: "adopted" };
  if (tally.no > tally.yes) return { state: "decided", outcome: "rejected" };
  if (tally.yes === 0) return { state: "decided", outcome: "failed", tie: { how: "none", reason: "nobody voted yes or no" } };
  const own = chair !== undefined && roster.includes(chair) ? ballots.find((b) => b.voter === chair && b.value !== "abstain") : undefined;
  if (own !== undefined && chair !== undefined) {
    const value = own.value as "yes" | "no";
    return { state: "decided", outcome: value === "yes" ? "adopted" : "rejected", tie: { how: "chair-ballot", chair, value, reason: `tied ${tally.yes}-${tally.no}; the chair's own ballot decides, counted once` } };
  }
  return chairCanCast ? { state: "tie" } : { state: "decided", outcome: "failed", tie: { how: "none", reason: `tied ${tally.yes}-${tally.no} and no chair could cast a casting vote` } };
}

/** The outcome of a tie after the chair's casting vote. */
export function castingOutcome(chair: string, value: "yes" | "no", reason: string, tally: Tally): { outcome: VoteOutcome; tie: TieBreak } {
  return { outcome: value === "yes" ? "adopted" : "rejected", tie: { how: "casting-vote", chair, value, reason: `tied ${tally.yes}-${tally.no}; the chair cast a single casting vote: ${reason}` } };
}
