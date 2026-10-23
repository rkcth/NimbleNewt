import { createHash } from "node:crypto";
import { allows, inTaskScope } from "../security/access.js";
import type { Principal } from "../security/principals.js";
import type { StartupItem } from "../context/budget.js";
import type { View } from "../domain/model.js";
import type { Change } from "../storage/types.js";

/** What kind of owner statement a decision is. `gate` is a planning-only instruction or an implementation hold (or the owner opening the gate again). */
export const DECISION_CATEGORIES = ["decision", "goal", "permission", "gate"] as const;
export type DecisionCategory = (typeof DECISION_CATEGORIES)[number];
export const GATE_KINDS = ["planning-only", "implementation-hold", "open"] as const;
export type GateKind = (typeof GATE_KINDS)[number];
/** Gates are decisions about one fixed topic, so a later gate decision always supersedes the earlier one in its scope. */
export const GATE_TOPIC = "implementation-gate";
export const SUBJECT_KINDS = ["plan", "contract", "review", "action", "branch", "task"] as const;
export type SubjectKind = (typeof SUBJECT_KINDS)[number];
/** `stance` is how the interpreter read the owner's words. Only `decided` makes a decision; the rest are kept out by name so a caller cannot slip one in. */
export const STANCES = ["decided", "brainstorm", "hypothetical", "quoted", "paraphrase", "question"] as const;
export type Stance = (typeof STANCES)[number];

/** `active`: authoritative. `superseded`: replaced by a later owner decision, kept and visible, never authoritative again. `disputed`: two owner instructions conflict and the owner has not chosen. */
export type DecisionState = "active" | "superseded" | "disputed";

export interface DecisionSource {
  /** `chat`: the owner's own words in a chat turn (the controller checked the wording is in the turn, outside quoted text). `direct`: typed by the owner through the API. */
  readonly channel: "chat" | "direct";
  readonly turnId?: string;
  readonly messageId?: string;
}
/** Who said it, from authentication (never from the caller). `session` is a label the owner's client gives its session or device; it is shown, never trusted as an identity. */
export interface DecisionOrigin { readonly principalId: string; readonly credentialId?: string; readonly session?: string }

export interface OwnerDecisionBody {
  readonly projectId: string;
  /** Absent: the whole project. */
  readonly taskId?: string;
  readonly category: DecisionCategory;
  readonly topic: string;
  /** The decided choice, in the interpreter's words. The wording below is what the owner said and is what to go back to when the reading matters. */
  readonly statement: string;
  readonly wording: string;
  readonly gate?: GateKind;
  readonly source: DecisionSource;
  readonly origin: DecisionOrigin;
  /** Within the chain of decisions of one topic and scope: 1, 2, ... */
  readonly version: number;
  readonly state: DecisionState;
  /** The decisions this one replaced, when it was recorded. */
  readonly supersedes: readonly string[];
  readonly supersededBy?: string;
  readonly supersededAt?: string;
  readonly disputeId?: string;
  readonly recordedAt: string;
  /** The project's context record version this decision created. */
  readonly contextVersion: number;
}

export interface TopicEntry { readonly id: string; readonly taskId?: string; readonly version: number; readonly state: DecisionState }
export interface TopicBody {
  readonly projectId: string;
  readonly topic: string;
  /** Absent until the first decision: a question can be asked about a topic before anything is decided on it. */
  readonly category?: DecisionCategory;
  /** Every decision ever recorded on the topic, in order, including superseded ones. */
  readonly entries: readonly TopicEntry[];
  /** Open questions on the topic. */
  readonly questions: readonly { readonly id: string; readonly taskId?: string }[];
}

/** One record per project: the versioned context record. It lists the IDs; the decisions themselves are read from their own records, so this can never hold a stale copy of the owner's words. */
export interface ContextRecordBody {
  readonly projectId: string;
  /** Raised by every change to the set of authoritative decisions, disputes or open questions. */
  readonly version: number;
  readonly active: readonly string[];
  readonly disputes: readonly string[];
  readonly questions: readonly string[];
  /** Propagations not finished yet (a correction whose agents are not all told or revalidated): resumed after a restart. */
  readonly pending: readonly string[];
}

export interface DisputeBody {
  readonly projectId: string;
  readonly taskId?: string;
  readonly topic: string;
  readonly members: readonly string[];
  readonly state: "open" | "resolved";
  readonly openedAt: string;
  readonly chosen?: string;
  readonly resolvedBy?: string;
  readonly resolvedAt?: string;
}

export interface QuestionBody {
  readonly projectId: string;
  readonly taskId?: string;
  readonly topic: string;
  readonly question: string;
  readonly askedBy: string;
  readonly askedAt: string;
  readonly state: "open" | "answered" | "dismissed";
  readonly answeredBy?: string;
  readonly closedAt?: string;
}

export interface LinkBody {
  readonly id: string;
  readonly subject: { readonly kind: SubjectKind; readonly id: string };
  readonly decisionId: string;
  /** The version of the decision the subject was made against. */
  readonly version: number;
  readonly topic: string;
  readonly state: "current" | "superseded";
  readonly supersededBy?: string;
  readonly markedAt?: string;
  readonly linkedBy: string;
  readonly linkedAt: string;
}
export interface RelianceBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly links: readonly LinkBody[];
  readonly revalidations: number;
  readonly lastRevalidation?: { readonly by: string; readonly at: string; readonly note: string; readonly links: readonly string[] };
  readonly followUps: readonly string[];
}
export interface DependentsBody { readonly decisionId: string; readonly taskIds: readonly string[] }

export interface FollowUpBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly effectId: string;
  readonly decisionId: string;
  readonly supersededBy?: string;
  /** What the effect ledger said when the decision was superseded. */
  readonly effectStatus: "confirmed" | "uncertain" | "in-flight";
  /** Always false: a correction changes the owner's decision; it does not undo what already happened outside. */
  readonly undone: false;
  readonly state: "open" | "addressed" | "accepted";
  readonly note: string;
  readonly createdAt: string;
  readonly closedBy?: string;
  readonly closedAt?: string;
  readonly closeNote?: string;
  readonly correctiveEffectId?: string;
}

export type PropagationReason = "superseded" | "disputed" | "resolved";
export interface PropagationStep { readonly links?: true; readonly generation?: true; readonly notified?: number; readonly skipped?: string }
export interface PropagationBody {
  readonly projectId: string;
  readonly reason: PropagationReason;
  /** The decisions whose dependents must be told. */
  readonly decisionIds: readonly string[];
  /** The decision that now governs (the one that superseded, or the one chosen). */
  readonly newId?: string;
  readonly state: "pending" | "done";
  readonly steps: Readonly<Record<string, PropagationStep>>;
  readonly createdAt: string;
  readonly doneAt?: string;
}

export const DECISION_LIMITS = {
  topic: 80, statement: 1000, wording: 2000, session: 60, question: 1000, note: 500, reason: 500,
  active: 200, entriesPerTopic: 400, supersedePerRecord: 50, linksPerTask: 50, tasksPerDecision: 200, openQuestions: 50, questionsPerTopic: 10, disputeMembers: 5, followUpsPerTask: 500, pending: 20, page: 100,
} as const;

export const DECISION_ID = /^dec-[a-z2-7]{20}$/;
export const TOPIC = /^[a-z0-9][a-z0-9 ._/-]{0,79}$/;
export const SESSION = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,59}$/;

export const sha = (value: string): string => createHash("sha256").update(value).digest("hex");
/** The topic as it is compared: lower case, spaces folded. */
export const normalTopic = (value: string): string => value.toLowerCase().replace(/\s+/g, " ").trim();
/** Statements as they are compared when deciding whether an owner said the same thing again. */
export const normalText = (value: string): string => value.toLowerCase().replace(/[\s"'`.,;:!]+/g, " ").trim();
export const topicIdOf = (projectId: string, topic: string): string => `dtp-${sha(`${projectId}\0${topic}`).slice(0, 32)}`;
export const relianceIdOf = (taskId: string): string => `drl-${taskId.slice(5)}`;
export const dependentsIdOf = (decisionId: string): string => `ddp-${decisionId.slice(4)}`;
export const propagationIdOf = (key: string): string => `dpr-${sha(key).slice(0, 32)}`;
export const followUpIdOf = (effectId: string, decisionId: string): string => `dfu-${sha(`${effectId}\0${decisionId}`).slice(0, 20)}`;
export const linkIdOf = (subject: { kind: string; id: string }, decisionId: string): string => sha(`${subject.kind}\0${subject.id}\0${decisionId}`).slice(0, 24);

/**
 * Words that mark a message as thinking aloud rather than deciding. This is a backstop behind the interpreter's own reading of the message, not a replacement: a message that matches is never recorded
 * as a decision, whatever the caller says it was. It errs towards not recording; the owner can say it plainly.
 */
const NOT_A_DECISION = /\b(what if|suppose|supposing|hypothetical(?:ly)?|for example|for instance|e\.g\.|brainstorm\w*|thinking out loud|just an idea|maybe we (?:could|should)|we could perhaps|might we|would it be|how about|not decided|haven'?t decided|undecided|not sure yet|let'?s discuss|should we|could we|can we|shall we|do we|i wonder|wonder if|maybe|perhaps|what about|if we)\b/i;
export function notADecision(wording: string): string | undefined {
  if (NOT_A_DECISION.test(wording)) return "the words are brainstorming or a hypothetical, not a choice";
  if (wording.trim().endsWith("?")) return "a question is not a decision";
  return undefined;
}

/** Words before the owner's phrase that turn it around ("do not use X" is not a decision to use X). */
const NEGATION = /\b(don'?t|do not|doesn'?t|does not|never|not|no longer|won'?t|will not|shouldn'?t|should not|cannot|can'?t|stop|avoid|without|instead of|rather than)\b/i;

/**
 * Whether the owner's phrase is a decision when read in the sentence(s) of the owner's message that hold it, not alone: a quotation of half a sentence ("what if we use X" -> "we use X") or of the
 * part after a negation, or of a question, is not what the owner decided. The markers and the trailing question mark are looked for in the whole sentence, and a negation anywhere before the phrase counts.
 */
export function notADecisionIn(turnText: string, wording: string): string | undefined {
  const norm = (v: string): string => v.toLowerCase().replace(/\s+/g, " ").trim();
  const phrase = norm(wording);
  const sentences = turnText.split(/(?<=[.!?])\s+|\n+/).map((x) => x.trim()).filter((x) => x.length > 0);
  const holding = sentences.filter((x) => norm(x).includes(phrase));
  // A phrase that spans sentences is judged with the whole message.
  for (const sentence of holding.length > 0 ? holding : [turnText]) {
    const why = notADecision(sentence);
    if (why !== undefined) return `${why} (in "${sentence.slice(0, 80)}")`;
    const at = norm(sentence).indexOf(phrase);
    if (at > 0 && NEGATION.test(norm(sentence).slice(0, at))) return `the words follow a negation in "${sentence.slice(0, 80)}", so they are not what the owner decided`;
  }
  return undefined;
}

/** Whether a principal may read a decision (an unreadable one reads like a missing one). The owner; those who read the project's histories; agents working on the task a decision is about. */
export function canReadDecision(by: Principal, d: Pick<OwnerDecisionBody, "projectId" | "taskId">): boolean {
  if (by.kind === "owner") return true;
  if (!inTaskScope(by, d.projectId)) return false;
  if (allows(by, "history.read", d.projectId)) return true;
  return d.taskId !== undefined && allows(by, "attempt.work", d.projectId, { resource: { kind: "task", id: d.taskId } });
}

/** The text a link to a decision resolves to. A superseded or disputed decision is shown, marked as not authoritative, so nobody mistakes the old wording for the current one. */
export function decisionText(d: OwnerDecisionBody, id: string): string {
  const mark = d.state === "active" ? "AUTHORITATIVE" : d.state === "superseded" ? `NOT AUTHORITATIVE, superseded${d.supersededBy === undefined ? "" : ` by ${d.supersededBy}`}` : "NOT AUTHORITATIVE, disputed";
  const disputed = d.state === "disputed" ? " (the owner's instructions conflict and the owner has not chosen)" : "";
  return `[${mark}] ${d.wording}\nOwner ${d.category} ${id} on "${d.topic}", version ${d.version}${d.gate === undefined ? "" : `, gate ${d.gate}`}${disputed}. Understood as: ${d.statement}`;
}

export interface DecisionContext {
  readonly projectId: string;
  readonly taskId?: string;
  /** The context record's version: it changes when any authoritative decision, dispute or open question does. */
  readonly version: number;
  readonly decisions: readonly View<OwnerDecisionBody>[];
  readonly goals: readonly View<OwnerDecisionBody>[];
  readonly permissions: readonly View<OwnerDecisionBody>[];
  readonly gates: readonly View<OwnerDecisionBody>[];
  readonly disputes: readonly View<DisputeBody>[];
  readonly questions: readonly View<QuestionBody>[];
}

/**
 * The context record as the C07 startup builder takes it. The owner's own words are `human` (always kept whole), permissions and goals keep their own kinds, a dispute is `human` too (an agent must
 * never start without knowing that the owner's instructions conflict), and open questions are ordinary (cuttable) items. Superseded decisions are not here: they are not authoritative.
 */
export function startupItems(context: DecisionContext): StartupItem[] {
  const out: StartupItem[] = [];
  for (const v of context.decisions) out.push({ id: v.id, kind: "human", text: decisionText(v, v.id), at: v.recordedAt });
  for (const v of context.gates) out.push({ id: v.id, kind: "human", text: decisionText(v, v.id), at: v.recordedAt });
  for (const v of context.goals) out.push({ id: v.id, kind: "goal", text: decisionText(v, v.id), at: v.recordedAt });
  for (const v of context.permissions) out.push({ id: v.id, kind: "permission", text: decisionText(v, v.id), at: v.recordedAt });
  for (const d of context.disputes) out.push({ id: d.id, kind: "human", text: `UNRESOLVED CONFLICT on "${d.topic}": the owner gave conflicting instructions (${d.members.join(", ")}). Do not act on this topic until the owner chooses.`, at: d.openedAt });
  for (const q of context.questions) out.push({ id: q.id, kind: "decision", text: `Open question to the owner on "${q.topic}": ${q.question}`, at: q.askedAt });
  return out;
}

/** What a gate or an obsolete reliance says about starting work. Same shape as the pause guard: the reasons, and the revision checks to commit with the caller's change. */
export interface DecisionGuard {
  /** `start`: a generation begins or a task's work resumes. `effect`: an external effect is admitted, started, or approved. */
  guard(taskId: string, purpose: "start" | "effect"): Promise<{ readonly blockedBy: readonly string[]; readonly changes: readonly Change[] }>;
}
