import assert from "node:assert/strict";
import { test } from "node:test";
import { isConsistent } from "./summary.js";
import { castingOutcome, quorumOf, tallyOf, verdictOf, type BallotValue, type CountedBallot } from "./votes.js";

const roster = ["agent:a", "agent:b", "agent:c", "agent:d"];
const ballots = (...pairs: [string, BallotValue][]): CountedBallot[] => pairs.map(([voter, value]) => ({ voter, value, reason: "because", revisions: 1 }));

test("quorum is a majority of the whole roster", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 8].map(quorumOf), [1, 2, 2, 3, 3, 5]);
});

test("the tally counts abstentions toward quorum, leaves absent members out and never turns silence into a vote", () => {
  const b = ballots(["agent:a", "yes"], ["agent:b", "abstain"], ["agent:d", "no"]);
  const t = tallyOf(roster, ["agent:d"], b);
  assert.deepEqual([t.roster, t.eligible, t.quorum, t.cast, t.yes, t.no, t.abstain], [4, 3, 3, 2, 1, 0, 1], "a ballot from an absent member does not count");
  assert.deepEqual(t.absent, ["agent:d"]);
  assert.deepEqual(t.silent, ["agent:c"]);
});

test("a simple majority of yes and no decides; fewer ballots than the quorum decide nothing", () => {
  const yes = ballots(["agent:a", "yes"], ["agent:b", "yes"], ["agent:c", "no"]);
  assert.deepEqual(verdictOf(tallyOf(roster, [], yes), yes, undefined, roster, false), { state: "decided", outcome: "adopted" });
  const no = ballots(["agent:a", "no"], ["agent:b", "no"], ["agent:c", "yes"]);
  assert.deepEqual(verdictOf(tallyOf(roster, [], no), no, undefined, roster, false), { state: "decided", outcome: "rejected" });
  const few = ballots(["agent:a", "yes"], ["agent:b", "yes"]);
  assert.deepEqual(verdictOf(tallyOf(roster, [], few), few, undefined, roster, false), { state: "decided", outcome: "no-quorum" });
  const abstain = ballots(["agent:a", "yes"], ["agent:b", "abstain"], ["agent:c", "abstain"]);
  assert.equal(verdictOf(tallyOf(roster, [], abstain), abstain, undefined, roster, false).state, "decided");
});

test("a tie: a chair on the roster who voted yes or no decides it with that one ballot", () => {
  const b = ballots(["agent:a", "yes"], ["agent:b", "no"], ["agent:c", "abstain"]);
  const t = tallyOf(roster, [], b);
  const v = verdictOf(t, b, "agent:a", roster, true);
  assert.equal(v.state, "decided");
  assert.ok(v.state === "decided" && v.outcome === "adopted" && v.tie?.how === "chair-ballot" && v.tie.value === "yes");
  const other = verdictOf(t, b, "agent:b", roster, true);
  assert.ok(other.state === "decided" && other.outcome === "rejected", "the chair's own side");
});

test("a tie: a chair who is off the roster or abstained is asked for a single casting vote; with no chair able to cast it the tie fails", () => {
  const b = ballots(["agent:a", "yes"], ["agent:b", "no"], ["agent:c", "abstain"]);
  const t = tallyOf(roster, [], b);
  assert.equal(verdictOf(t, b, "agent:z", roster, true).state, "tie", "a chair outside the roster casts only because of the tie");
  assert.equal(verdictOf(t, b, "agent:c", roster, true).state, "tie", "an abstaining chair casts the casting vote");
  const none = verdictOf(t, b, undefined, roster, false);
  assert.ok(none.state === "decided" && none.outcome === "failed" && none.tie?.how === "none");
  const gone = verdictOf(t, b, "agent:z", roster, false);
  assert.ok(gone.state === "decided" && gone.outcome === "failed", "a chair who changed or is absent cannot cast it");
  const empty = ballots(["agent:a", "abstain"], ["agent:b", "abstain"], ["agent:c", "abstain"]);
  const e = verdictOf(tallyOf(roster, [], empty), empty, "agent:z", roster, true);
  assert.ok(e.state === "decided" && e.outcome === "failed", "nobody voted yes or no: no casting vote is asked for");
  const noTie = ballots(["agent:a", "yes"], ["agent:b", "yes"], ["agent:c", "no"]);
  assert.equal(verdictOf(tallyOf(roster, [], noTie), noTie, "agent:z", roster, true).state, "decided", "no casting vote when there is no tie");
});

test("the casting vote is one vote, recorded as such, and decides to its side", () => {
  const t = tallyOf(roster, [], ballots(["agent:a", "yes"], ["agent:b", "no"], ["agent:c", "abstain"]));
  const yes = castingOutcome("agent:z", "yes", "it is cheaper", t);
  assert.equal(yes.outcome, "adopted");
  assert.deepEqual([yes.tie.how, yes.tie.value, yes.tie.chair], ["casting-vote", "yes", "agent:z"]);
  assert.equal(castingOutcome("agent:z", "no", "too risky", t).outcome, "rejected");
});

test("the summary's consistency check fails when a change is listed twice, is missing, or the adopted list is wrong", () => {
  const row = (id: string, states: string[]) => ({ id, outcome: "adopted", changes: states.map((s, i) => ({ id: `c${i + 1}`, summary: "x", state: s })) }) as never;
  const rows = [row("d1", ["applied", "not-applied", "adopted"])];
  const applied = [{ decisionId: "d1", changeId: "c1" }];
  const notApplied = [{ decisionId: "d1", changeId: "c2" }];
  assert.equal(isConsistent(rows, ["d1"], applied, notApplied, ["d1/c3"]), true);
  assert.equal(isConsistent(rows, ["d1"], applied, notApplied, []), false, "a change in no list");
  assert.equal(isConsistent(rows, ["d1"], [...applied, ...notApplied], notApplied, ["d1/c3"]), false, "a change in two lists");
  assert.equal(isConsistent(rows, [], applied, notApplied, ["d1/c3"]), false, "adopted does not match");
  assert.equal(isConsistent([row("d1", ["bogus"])], ["d1"], [], [], []), false, "an unknown state is in no list");
});
