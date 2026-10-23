import type { View } from "../domain/model.js";
import type { ParticipantRecord } from "./meetings.js";
import type { DecisionRecordBody, MotionBody, RecordBody, SourceCite, SummaryContent, SummaryDecision, SummaryItem } from "./record-types.js";

/** Whether a citation can be shared with the meeting's readers. Private records (an agent's desk, scratch) cannot: a conclusion that rests on one is published as an unverifiable claim. */
export type Shared = (cite: SourceCite) => boolean;

export interface SummaryInput {
  readonly recordId: string;
  readonly record: RecordBody;
  readonly participants: readonly ParticipantRecord[];
  readonly motions: readonly View<MotionBody>[];
  readonly decisions: readonly View<DecisionRecordBody>[];
  readonly shared: Shared;
}

const restsOnPrivate = (sources: readonly SourceCite[] | undefined, shared: Shared): boolean => (sources ?? []).some((s) => !shared(s));

/** The statuses that mean a change is carried out, refused, or still waiting. */
function statusOf(d: DecisionRecordBody): SummaryDecision["status"] {
  if (d.outcome !== "adopted") return d.outcome;
  if (d.scope === "recommendation") return "recommendation";
  if (d.ownerResponse === "pending") return "waiting-for-owner";
  if (d.changes.length === 0) return "adopted";
  const applied = d.changes.filter((c) => c.state === "applied").length;
  const refused = d.changes.filter((c) => c.state === "not-applied").length;
  if (applied === d.changes.length) return "applied";
  if (applied > 0) return "part-applied";
  return refused === d.changes.length ? "not-applied" : "adopted";
}

/**
 * Builds the meeting summary from the records alone (card M02): attendance, key updates, decisions with their reasons and a link to the discussion, dissent, unresolved questions, actions and the plan, with what was
 * adopted kept apart from what was applied. It reads nothing but the meeting's own records, so a summarizer that fails costs the overview and nothing else.
 */
export function buildSummary(input: SummaryInput): SummaryContent {
  const { record, shared } = input;
  const decisions = [...input.decisions].sort((a, b) => a.number - b.number);
  const spoke = new Set<string>(record.attended);
  for (const t of record.tagged) spoke.add(t.speaker);
  for (const d of decisions) for (const t of d.table) spoke.add(t.voter);
  const roster = record.roster;
  const present = roster.filter((r) => spoke.has(r));
  const absent = record.withheld.map((id) => ({ id, why: input.participants.find((p) => p.id === id)?.status ?? "withheld" }));
  const didNotTakePart = roster.filter((r) => !spoke.has(r) && !record.withheld.includes(r));
  const itemOf = (t: RecordBody["tagged"][number]): SummaryItem => ({
    entryId: t.entryId, seq: t.seq, speaker: t.speaker, text: t.text, verifiable: !restsOnPrivate(t.sources, shared),
    ...(t.assignee === undefined ? {} : { assignee: t.assignee }), ...(t.taskId === undefined ? {} : { taskId: t.taskId }),
  });
  const decisionRows: SummaryDecision[] = decisions.map((d) => ({
    id: d.id, number: d.number, text: d.text, outcome: d.outcome, status: statusOf(d),
    verifiable: !restsOnPrivate(d.sources, shared) && !d.table.some((t) => restsOnPrivate(t.sources, shared)),
    reasons: d.table.map((t) => ({ voter: t.voter, value: t.value, reason: t.reason, verifiable: !restsOnPrivate(t.sources, shared) })),
    dissent: d.dissent, abstained: d.abstained,
    ...(d.tally === undefined ? {} : { tally: d.tally }), ...(d.tie === undefined ? {} : { tie: d.tie }),
    discussion: { recordId: input.recordId, fromSeq: d.discussion.fromSeq, toSeq: d.discussion.toSeq },
    changes: d.changes.map((c) => ({ id: c.id, summary: c.summary, state: c.state, ...(c.reason === undefined ? {} : { reason: c.reason }) })),
    ownerResponse: d.ownerResponse, ...(d.ownerDecisionId === undefined ? {} : { ownerDecisionId: d.ownerDecisionId }),
  }));
  const adopted = decisions.filter((d) => d.outcome === "adopted").map((d) => d.id);
  const applied: SummaryContent["applied"][number][] = [];
  const notApplied: SummaryContent["notApplied"][number][] = [];
  const waiting: string[] = [];
  for (const d of decisions) {
    if (d.outcome !== "adopted") continue;
    for (const c of d.changes) {
      if (c.state === "applied") applied.push({ decisionId: d.id, changeId: c.id, summary: c.summary });
      else if (c.state === "not-applied") notApplied.push({ decisionId: d.id, changeId: c.id, summary: c.summary, reason: c.reason ?? "not applied" });
      else if (c.state === "adopted" || c.state === "applying") waiting.push(`${d.id}/${c.id}`);
    }
  }
  const dissent = decisions.flatMap((d) => d.dissent.map((x) => ({ decisionId: d.id, voter: x.voter, value: x.value, reason: x.reason })));
  const unresolved: SummaryContent["unresolved"][number][] = [];
  for (const t of record.tagged) if (t.tag === "question" && t.answeredBy === undefined) unresolved.push({ kind: "question", text: t.text, ref: t.entryId });
  for (const m of input.motions) {
    if (m.state === "adopted" || m.state === "rejected") continue;
    const why = m.state === "void" ? `ended without a decision${m.voidReason === undefined ? "" : ` (${m.voidReason})`}` : m.state === "tabled" ? "tabled" : m.state === "failed" ? "the vote failed on a tie" : m.state === "no-quorum" ? "no quorum" : m.state === "proposed" ? "not put to a vote" : "vote not concluded";
    unresolved.push({ kind: "motion", text: `Motion ${m.number}: ${m.text} (${why})`, ref: m.id });
  }
  for (const d of decisions) if (d.ownerResponse === "pending") unresolved.push({ kind: "owner", text: `Motion ${d.number} is adopted and waits for the owner's agreement`, ref: d.id });
  const tagged = (tag: string): SummaryItem[] => record.tagged.filter((t) => t.tag === tag).map(itemOf);
  const all = [...record.tagged.map((t) => !restsOnPrivate(t.sources, shared)), ...decisionRows.map((d) => d.verifiable)];
  return {
    occurrenceId: record.occurrenceId, recordId: input.recordId, title: record.title, meetingState: record.state, partial: record.state === "interrupted",
    attendance: { present, absent, didNotTakePart, ...(record.chair === undefined ? {} : { chair: record.chair }), owner: { present: record.ownerPresent, joins: record.ownerJoins } },
    keyUpdates: tagged("update"), decisions: decisionRows, adopted, applied, notApplied, dissent, unresolved, actions: tagged("action"), plan: tagged("plan"),
    consistent: isConsistent(decisionRows, adopted, applied, notApplied, waiting),
    unverifiableCount: all.filter((v) => !v).length,
  };
}

/** Every change of every adopted decision is in exactly one of applied, not applied or waiting, nothing else is listed, and `adopted` is exactly the adopted decisions. */
export function isConsistent(rows: readonly SummaryDecision[], adopted: readonly string[], applied: readonly { decisionId: string; changeId: string }[], notApplied: readonly { decisionId: string; changeId: string }[], waiting: readonly string[]): boolean {
  const listed = [...applied, ...notApplied].map((x) => `${x.decisionId}/${x.changeId}`).concat(waiting);
  if (new Set(listed).size !== listed.length) return false;
  const expected = rows.filter((r) => r.outcome === "adopted").flatMap((r) => r.changes.map((c) => `${r.id}/${c.id}`));
  return expected.length === listed.length && expected.every((e) => listed.includes(e)) && adopted.length === rows.filter((r) => r.outcome === "adopted").length && rows.filter((r) => r.outcome === "adopted").every((r) => adopted.includes(r.id));
}
