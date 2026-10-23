import { evidenceInText, evidenceStrong } from "../chat/interpreter.js";
import type { TurnBody } from "../chat/chat.js";
import type { DeskRecordBody } from "../context/desks.js";
import { mergeChanges } from "../domain/changes.js";
import type { EffectBody, EffectService } from "../domain/effects.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { EventService } from "../events/events.js";
import type { GenerationService } from "../generation/generation.js";
import { allows, inTaskScope } from "../security/access.js";
import { DISPATCHER_PRINCIPAL } from "../security/task-credentials.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import {
  DECISION_CATEGORIES, DECISION_ID, DECISION_LIMITS, GATE_KINDS, GATE_TOPIC, SESSION, STANCES, SUBJECT_KINDS, TOPIC,
  canReadDecision, decisionText, notADecisionIn, dependentsIdOf, followUpIdOf, linkIdOf, normalText, normalTopic, notADecision, propagationIdOf, relianceIdOf, topicIdOf,
  type ContextRecordBody, type OwnerDecisionBody, type DecisionCategory, type DecisionContext, type DecisionGuard, type DecisionOrigin, type DecisionSource, type DependentsBody, type DisputeBody, type FollowUpBody, type GateKind,
  type LinkBody, type PropagationBody, type PropagationReason, type PropagationStep, type QuestionBody, type RelianceBody, type Stance, type SubjectKind, type TopicBody, type TopicEntry,
} from "./records.js";

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const plain = (value: unknown, field: string, max: number, min = 1): string => {
  const out = text(value, field, { min, max, multiline: true });
  if (redactText(out) !== out) invalid(field, "looks like a credential or key; those are not recorded");
  return out;
};
const body = <T>(a: Aggregate | undefined): T | undefined => (a === undefined ? undefined : (a.body as unknown as T));
const json = (value: object): JsonObject => value as unknown as JsonObject;
const clean = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
const FOLLOW_UP_ID = /^dfu-[0-9a-f]{20}$/;
const DISPUTE_ID = /^dsp-[a-z2-7]{20}$/;
const QUESTION_ID = /^dqn-[a-z2-7]{20}$/;

export interface RecordDecision extends NoActor {
  readonly projectId: string;
  /** Absent: the whole project. */
  readonly taskId?: string;
  readonly category: DecisionCategory;
  readonly topic: string;
  /** The decided choice. */
  readonly statement: string;
  /** The owner's own words. Checked against the chat turn named in `source`. */
  readonly wording: string;
  /** For `category: "gate"` only. */
  readonly gate?: GateKind;
  readonly source: { readonly channel: "chat"; readonly turnId: string } | { readonly channel: "direct" };
  /** The version of this topic and scope the owner's session saw (0: nothing decided yet). A session that did not see the latest version cannot overwrite it: the conflict is surfaced instead. */
  readonly basedOn: number;
  /** A label for the owner's session or device. Shown, never trusted as an identity. */
  readonly session?: string;
  /** How the message was read. Anything but `decided` records nothing. */
  readonly stance?: Stance;
}

export type RecordResult =
  | { readonly recorded: true; readonly id: string; readonly version: number; readonly superseded: readonly string[]; readonly disputeId?: string; readonly propagation: "none" | "done" | "pending"; readonly replayed: boolean }
  | { readonly recorded: false; readonly reason: string; readonly decisionId?: string };

export interface PropagationResult { readonly done: boolean; readonly pendingTasks: readonly string[]; readonly failures: readonly { readonly taskId: string; readonly step: string; readonly code: string; readonly message: string }[] }

export type Authority =
  | { readonly status: "decided"; readonly decision: View<OwnerDecisionBody> }
  | { readonly status: "disputed"; readonly dispute: View<DisputeBody> }
  | { readonly status: "none" };

export interface DecisionDeps {
  /** Tells the agents whose work relied on a superseded decision (a `task:` stream event they read when they next wake, even after a pause or a restart). */
  readonly events?: EventService;
  /** Interrupts a running generation of an affected task (L05 `correct`). */
  readonly generation?: GenerationService;
  /** Reads the effect ledger, to record effects that already happened. */
  readonly effects?: EffectService;
}

/** The newest live entry that applies to a task (or to the project when none is named): a task-level decision made after the project-wide one overrides it for that task, and never the other way round. */
const newest = (live: readonly TopicEntry[], taskId: string | undefined): TopicEntry | undefined =>
  live.filter((e) => e.taskId === undefined || e.taskId === taskId).reduce<TopicEntry | undefined>((m, e) => (m === undefined || e.version > m.version ? e : m), undefined);

class NoChange extends Error { constructor(readonly decisionId: string) { super("no change"); } }
/** A question that does not need asking: the topic is decided, disputed, or already has an open question. */
class Settled extends Error { constructor(readonly questionId?: string) { super("settled"); } }

/**
 * Owner decision records and correction propagation (card C08).
 *
 * - **Owner words only.** Only the authenticated owner records a decision (an agent, a host, a service and a client cannot, whatever they hold). A decision keeps the owner's own wording, the reading of it, its
 *   scope (project or one task), a version, what it supersedes and where it came from (the chat turn it was said in, which the controller checks holds those words outside quoted text). Brainstorming, a hypothetical,
 *   quoted text, a question and an agent's paraphrase create nothing. These records are separate from the agents' desk records of kind `decision`, which are conclusions and never authoritative.
 * - **A correction is authoritative at once.** A later decision on a topic supersedes the earlier ones in its scope (a project-wide decision also the task-level ones on that topic; a task-level one only that task's) in
 *   the same commit; the old ones stay, marked non-authoritative. The owner's session must name the version it saw (`basedOn`): if the decision moved meanwhile and the words differ, nothing is overwritten; both
 *   are marked disputed, the work that relies on them is blocked, and only the owner's explicit choice (`resolveDispute`) settles it, never arrival order and never a vote.
 * - **Links.** Plans, task contracts, reviews, queued or finished actions and branches are linked to the decisions they rely on. Whether a task may take its next step is read from the decisions themselves at that
 *   moment (`guard`), so a correction blocks a busy, paused or suspended agent's next action the instant it commits, and still does after a restart. Revalidation links the work to the current decision; it can never link
 *   to a superseded one, so no agent agreement restores old guidance.
 * - **Propagation.** After the commit, a resumable pass marks the affected links superseded, records effects that already happened with an open corrective follow-up (never "undone"), interrupts a running generation
 *   (L05) and tells each affected task through an event it reads on waking. It is restart-safe (`resume`).
 * - **Gates.** A planning-only instruction or an implementation hold is a decision of category `gate`: it binds by itself, whether or not work was linked to it, until the owner decides otherwise.
 */
export class DecisionService implements DecisionGuard {
  readonly #runner: CommandRunner;
  readonly #deps: DecisionDeps;

  private constructor(runner: CommandRunner, deps: DecisionDeps) { this.#runner = runner; this.#deps = deps; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: DecisionDeps = {}, options: RunnerOptions = {}): DecisionService {
    return new DecisionService(new CommandRunner(storage, epoch, options), deps);
  }

  // ---- recording -------------------------------------------------------------------------------------------------------------

  /** Records an owner decision, correction or gate. Returns `recorded: false` (and writes nothing) for words that are not a decision, or the same decision said again. */
  async record(by: Principal, command: RecordDecision): Promise<RecordResult> {
    onlyKnown(command, ["commandId", "projectId", "taskId", "category", "topic", "statement", "wording", "gate", "source", "basedOn", "session", "stance"]);
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the owner; only the owner's own words make a decision`);
    const projectId = checkProjectId(command.projectId);
    const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
    const category = (DECISION_CATEGORIES as readonly string[]).includes(command.category) ? command.category : invalid("category", `must be one of ${DECISION_CATEGORIES.join(", ")}`);
    const gate = command.gate === undefined ? undefined : (GATE_KINDS as readonly string[]).includes(command.gate) ? command.gate : invalid("gate", `must be one of ${GATE_KINDS.join(", ")}`);
    if ((category === "gate") !== (gate !== undefined)) invalid("gate", "is needed for a gate decision, and only for one");
    const topic = category === "gate" ? GATE_TOPIC : normalTopic(typeof command.topic === "string" ? command.topic : "");
    if (!TOPIC.test(topic)) invalid("topic", "must be 1 to 80 letters, digits, spaces and . _ / -");
    if (category === "gate" && command.topic !== undefined && normalTopic(command.topic) !== GATE_TOPIC) invalid("topic", `a gate is always about ${GATE_TOPIC}`);
    const statement = plain(command.statement, "statement", DECISION_LIMITS.statement);
    const wording = plain(command.wording, "wording", DECISION_LIMITS.wording);
    if (!Number.isSafeInteger(command.basedOn) || command.basedOn < 0) invalid("basedOn", "must be the version this session saw (0 if nothing was decided yet)");
    const session = command.session === undefined ? undefined : typeof command.session === "string" && SESSION.test(command.session) ? command.session : invalid("session", "must be a short label");
    const stance = command.stance === undefined ? "decided" : (STANCES as readonly string[]).includes(command.stance) ? command.stance : invalid("stance", `must be one of ${STANCES.join(", ")}`);
    if (stance !== "decided") return { recorded: false, reason: `a ${stance} is not a decision; nothing was recorded` };
    const words = notADecision(wording);
    if (words !== undefined) return { recorded: false, reason: `${words}; nothing was recorded` };
    const sourced = await this.#source(by, command.source, wording);
    if ("refusal" in sourced) return { recorded: false, reason: `${sourced.refusal}; nothing was recorded` };
    const source = sourced;
    if ((await this.#runner.get("project", projectId)) === undefined) throw new DomainError("not_found", `project ${projectId} does not exist`);
    if (taskId !== undefined && body<TaskBody>(await this.#runner.get("task", taskId))?.projectId !== projectId) invalid("taskId", "is not a task of that project");
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("dec", scoped);
    const origin: DecisionOrigin = { principalId: by.id, ...(by.credentialId === undefined ? {} : { credentialId: by.credentialId }), ...(session === undefined ? {} : { session }) };
    let outcome: { version: number; superseded: string[]; disputeId?: string; propId?: string } = { version: 0, superseded: [] };
    try {
      const result = await this.#retrying(() => this.#runner.command("decision.record", { commandId: scoped, actor: by.id }, async () => ({
        payload: json({ projectId, ...(taskId === undefined ? {} : { taskId }), category, topic, statement, wording, ...(gate === undefined ? {} : { gate }), source: source as unknown as JsonObject, basedOn: command.basedOn, ...(session === undefined ? {} : { session }) }),
        build: async () => this.#buildRecord({ id, by, projectId, taskId, category, topic, statement, wording, gate, source, basedOn: command.basedOn, origin }, (o) => { outcome = o; }),
      })));
      if (result.replayed) {
        const d = body<OwnerDecisionBody>(await this.#runner.get("decision", id))!;
        // A repeat after a crash that came between the commit and the passing on finishes the passing on.
        const propId = propagationIdOf(id);
        const prop = await this.#runner.get("decision-propagation", propId);
        const propagation = prop === undefined ? "none" : body<PropagationBody>(prop)!.state === "done" ? "done" : await this.#propagateSafely(by, propId);
        return { recorded: true, id, version: d.version, superseded: [...d.supersedes], ...(d.disputeId === undefined ? {} : { disputeId: d.disputeId }), propagation, replayed: true };
      }
    } catch (error) {
      if (error instanceof NoChange) return { recorded: false, reason: "the owner already decided exactly this; it stands, and nothing needs to be asked again", decisionId: error.decisionId };
      throw error;
    }
    let propagation: "none" | "done" | "pending" = "none";
    if (outcome.propId !== undefined) propagation = await this.#propagateSafely(by, outcome.propId);
    return { recorded: true, id, version: outcome.version, superseded: outcome.superseded, ...(outcome.disputeId === undefined ? {} : { disputeId: outcome.disputeId }), propagation, replayed: false };
  }

  async #buildRecord(a: { id: string; by: Principal; projectId: string; taskId: string | undefined; category: DecisionCategory; topic: string; statement: string; wording: string; gate: GateKind | undefined; source: DecisionSource; basedOn: number; origin: DecisionOrigin }, done: (o: { version: number; superseded: string[]; disputeId?: string; propId?: string }) => void) {
    const topicRef: AggregateRef = { kind: "decision-topic", id: topicIdOf(a.projectId, a.topic) };
    const topicFound = await this.#runner.get(topicRef.kind, topicRef.id);
    const topic: TopicBody = body<TopicBody>(topicFound) ?? { projectId: a.projectId, topic: a.topic, entries: [], questions: [] };
    if (topic.category !== undefined && topic.category !== a.category) invalid("category", `the topic "${a.topic}" holds ${topic.category} decisions`);
    const ctx = await this.#context(a.projectId);
    const now = this.#runner.now();
    const live = topic.entries.filter((e) => e.state !== "superseded");
    const exact = live.find((e) => e.taskId === a.taskId);
    const inScope = a.taskId === undefined ? live : live.filter((e) => e.taskId === a.taskId);
    // What the session had to have seen: the newest decision that applies to this scope, task-level ones included for a project-wide correction.
    const relevant = a.taskId === undefined ? live : live.filter((e) => e.taskId === undefined || e.taskId === a.taskId);
    const top = relevant.reduce<TopicEntry | undefined>((m, e) => (m === undefined || e.version > m.version ? e : m), undefined);
    if (relevant.some((e) => e.state === "disputed")) invalid("topic", `"${a.topic}" has an unresolved conflict between the owner's instructions; the owner chooses first (resolveDispute)`);
    const sameScope = exact === undefined ? undefined : body<OwnerDecisionBody>(await this.#runner.get("decision", exact.id));
    if (sameScope !== undefined && normalText(sameScope.statement) === normalText(a.statement) && sameScope.gate === a.gate) throw new NoChange(exact!.id);
    if (topic.entries.length >= DECISION_LIMITS.entriesPerTopic) throw new DomainError("unavailable", `the topic "${a.topic}" already has ${DECISION_LIMITS.entriesPerTopic} recorded versions`);
    const version = topic.entries.length + 1;
    const decisionRef: AggregateRef = { kind: "decision", id: a.id };
    const ctxRef: AggregateRef = { kind: "decision-context", id: a.projectId };
    const common = { projectId: a.projectId, ...(a.taskId === undefined ? {} : { taskId: a.taskId }), category: a.category, topic: a.topic, statement: a.statement, wording: a.wording, ...(a.gate === undefined ? {} : { gate: a.gate }), source: a.source, origin: a.origin, version, recordedAt: now, contextVersion: ctx.body.version + 1 };
    const changes: Change[] = [];
    const upsert = (ref: AggregateRef, revision: number, next: object): Change => this.#upsert(ref, revision, next);

    // Two sessions at once: the owner's session names the version it saw. A different version with different words is a conflict between the owner's own instructions, and no order settles it.
    if (top !== undefined && a.basedOn !== top.version) {
      // Every live decision in the new one's scope (and the newest that applies to it) is in the conflict: none of them can stay authoritative while the owner's instructions contradict each other.
      const memberEntries = [...new Map([...inScope, top].map((e) => [e.id, e])).values()];
      if (memberEntries.length + 1 > DECISION_LIMITS.supersedePerRecord) throw new DomainError("unavailable", `this conflict would involve ${memberEntries.length + 1} decisions; at most ${DECISION_LIMITS.supersedePerRecord}`);
      const disputeId = derivedId("dsp", a.id);
      const members = [...memberEntries.map((e) => e.id), a.id];
      const dispute: DisputeBody = { projectId: a.projectId, ...(a.taskId === undefined ? {} : { taskId: a.taskId }), topic: a.topic, members, state: "open", openedAt: now };
      const propId = propagationIdOf(a.id);
      const prop: PropagationBody = { projectId: a.projectId, reason: "disputed", decisionIds: members, state: "pending", steps: {}, createdAt: now };
      changes.push({ type: "create", ref: decisionRef, body: json({ ...common, state: "disputed", supersedes: [], disputeId } satisfies OwnerDecisionBody) });
      for (const e of memberEntries) {
        const old = await this.#runner.get("decision", e.id);
        changes.push({ type: "update", ref: { kind: "decision", id: e.id }, expectedRevision: old!.revision, body: json({ ...body<OwnerDecisionBody>(old)!, state: "disputed", disputeId }) });
      }
      changes.push(
        { type: "create", ref: { kind: "decision-dispute", id: disputeId }, body: json(dispute) },
        upsert(topicRef, topicFound?.revision ?? 0, { ...topic, category: a.category, entries: [...topic.entries.map((e) => (memberEntries.some((m) => m.id === e.id) ? { ...e, state: "disputed" as const } : e)), { id: a.id, ...(a.taskId === undefined ? {} : { taskId: a.taskId }), version, state: "disputed" as const }] }),
        upsert(ctxRef, ctx.revision, { ...ctx.body, version: ctx.body.version + 1, active: ctx.body.active.filter((x) => !memberEntries.some((m) => m.id === x)), disputes: [...ctx.body.disputes, disputeId], pending: [...ctx.body.pending, propId] }),
        { type: "create", ref: { kind: "decision-propagation", id: propId }, body: json(prop) },
      );
      done({ version, superseded: [], disputeId, propId });
      return { ref: decisionRef, creates: true, changes: mergeChanges(changes), detail: { decisionId: a.id, topic: a.topic, version, disputeId, members } };
    }

    // An ordinary decision or correction: it supersedes the active decisions of its scope.
    const replaced = inScope.filter((e) => e.state === "active");
    if (replaced.length > DECISION_LIMITS.supersedePerRecord) throw new DomainError("unavailable", `this would supersede ${replaced.length} decisions at once; at most ${DECISION_LIMITS.supersedePerRecord}`);
    const active = [...ctx.body.active.filter((x) => !replaced.some((r) => r.id === x)), a.id];
    if (active.length > DECISION_LIMITS.active) throw new DomainError("unavailable", `a project holds at most ${DECISION_LIMITS.active} authoritative decisions; supersede some`);
    for (const r of replaced) {
      const old = await this.#runner.get("decision", r.id);
      const ob = body<OwnerDecisionBody>(old)!;
      changes.push({ type: "update", ref: { kind: "decision", id: r.id }, expectedRevision: old!.revision, body: json({ ...ob, state: "superseded", supersededBy: a.id, supersededAt: now }) });
    }
    // The questions this answers are closed with it, and are not asked again.
    const answered = topic.questions.filter((q) => a.taskId === undefined || q.taskId === a.taskId);
    for (const q of answered) {
      const qa = await this.#runner.get("decision-question", q.id);
      if (qa !== undefined) changes.push({ type: "update", ref: { kind: "decision-question", id: q.id }, expectedRevision: qa.revision, body: json({ ...body<QuestionBody>(qa)!, state: "answered", answeredBy: a.id, closedAt: now }) });
    }
    const propId = replaced.length > 0 ? propagationIdOf(a.id) : undefined;
    changes.unshift({ type: "create", ref: decisionRef, body: json({ ...common, state: "active", supersedes: replaced.map((r) => r.id) } satisfies OwnerDecisionBody) });
    changes.push(
      upsert(topicRef, topicFound?.revision ?? 0, { ...topic, category: a.category, entries: [...topic.entries.map((e) => (replaced.some((r) => r.id === e.id) ? { ...e, state: "superseded" as const } : e)), { id: a.id, ...(a.taskId === undefined ? {} : { taskId: a.taskId }), version, state: "active" as const }], questions: topic.questions.filter((q) => !answered.includes(q)) }),
      upsert(ctxRef, ctx.revision, { ...ctx.body, version: ctx.body.version + 1, active, questions: ctx.body.questions.filter((q) => !answered.some((x) => x.id === q)), pending: propId === undefined ? ctx.body.pending : [...ctx.body.pending, propId] }),
    );
    if (propId !== undefined) changes.push({ type: "create", ref: { kind: "decision-propagation", id: propId }, body: json({ projectId: a.projectId, reason: "superseded", decisionIds: replaced.map((r) => r.id), newId: a.id, state: "pending", steps: {}, createdAt: now } satisfies PropagationBody) });
    changes.push(...(await this.#firstGate(a.projectId, ctx.revision, topicRef.id)));
    done({ version, superseded: replaced.map((r) => r.id), ...(propId === undefined ? {} : { propId }) });
    return { ref: decisionRef, creates: true, changes: mergeChanges(changes), detail: { decisionId: a.id, topic: a.topic, version, superseded: replaced.map((r) => r.id) } };
  }

  /** Where the words came from. For a chat turn: the owner's own turn, and the wording is in the owner's own text, which never includes quoted material. */
  async #source(by: Principal, value: unknown, wording: string): Promise<DecisionSource | { refusal: string }> {
    if (value === null || typeof value !== "object") return invalid("source", "must say the source of the words");
    const s = value as Record<string, unknown>;
    if (s["channel"] === "direct") { onlyKnown(s, ["channel"]); return { channel: "direct" }; }
    if (s["channel"] !== "chat") return invalid("source.channel", "must be chat or direct");
    onlyKnown(s, ["channel", "turnId"]);
    const turnId = typeof s["turnId"] === "string" && /^turn-[A-Za-z0-9]{1,100}$/.test(s["turnId"]) ? s["turnId"] : invalid("source.turnId", "is not a chat turn ID");
    const turn = body<TurnBody>(await this.#runner.get("chat-turn", turnId));
    // A turn that is not there, not the owner's own, or that does not contain these words in the owner's own text (quoted text is never part of it) cannot be the source.
    if (turn === undefined || turn.ownerId !== by.id) return invalid("source.turnId", "is not a chat turn of yours");
    if (!evidenceStrong(wording) || !evidenceInText(wording, turn.text)) return invalid("wording", "is not in the owner's own words of that chat turn (quoted material and other people's words do not count)");
    const sentence = notADecisionIn(turn.text, wording);
    if (sentence !== undefined) return { refusal: sentence };
    return { channel: "chat", turnId, messageId: turn.messageId };
  }

  /** The owner settles a conflict between two of the owner's own instructions by choosing one. */
  async resolveDispute(by: Principal, command: NoActor & { disputeId: string; chosen: string }): Promise<{ replayed: boolean; propagation: "none" | "done" | "pending" }> {
    onlyKnown(command, ["commandId", "disputeId", "chosen"]);
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the owner; only the owner chooses between conflicting instructions`);
    const disputeId = typeof command.disputeId === "string" && DISPUTE_ID.test(command.disputeId) ? command.disputeId : invalid("disputeId", "is not a dispute ID");
    const chosen = typeof command.chosen === "string" && DECISION_ID.test(command.chosen) ? command.chosen : invalid("chosen", "is not a decision ID");
    const propId = propagationIdOf(`resolve:${disputeId}`);
    const result = await this.#retrying(() => this.#runner.command("decision.resolve", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { disputeId, chosen },
      build: async () => {
        const found = await this.#runner.get("decision-dispute", disputeId);
        const dispute = body<DisputeBody>(found);
        if (found === undefined || dispute === undefined) throw new DomainError("not_found", `dispute ${disputeId} does not exist`);
        if (dispute.state !== "open") invalid("disputeId", "is already resolved");
        if (!dispute.members.includes(chosen)) invalid("chosen", "is not one of the conflicting decisions");
        const now = this.#runner.now();
        const topicFound = await this.#runner.get("decision-topic", topicIdOf(dispute.projectId, dispute.topic));
        const topic = body<TopicBody>(topicFound)!;
        const ctx = await this.#context(dispute.projectId);
        const losers = dispute.members.filter((m) => m !== chosen);
        const changes: Change[] = [];
        for (const m of dispute.members) {
          const a = await this.#runner.get("decision", m);
          const d = body<OwnerDecisionBody>(a)!;
          const next: OwnerDecisionBody = m === chosen
            ? clean({ ...d, state: "active" as const, supersedes: [...new Set([...d.supersedes, ...losers])], disputeId: undefined }) as unknown as OwnerDecisionBody
            : clean({ ...d, state: "superseded" as const, supersededBy: chosen, supersededAt: now, disputeId: undefined }) as unknown as OwnerDecisionBody;
          changes.push({ type: "update", ref: { kind: "decision", id: m }, expectedRevision: a!.revision, body: json(next) });
        }
        changes.push({ type: "update", ref: { kind: "decision-dispute", id: disputeId }, expectedRevision: found.revision, body: json({ ...dispute, state: "resolved", chosen, resolvedBy: by.id, resolvedAt: now } satisfies DisputeBody) });
        changes.push({ type: "update", ref: { kind: "decision-topic", id: topicIdOf(dispute.projectId, dispute.topic) }, expectedRevision: topicFound!.revision, body: json({ ...topic, entries: topic.entries.map((e) => (e.id === chosen ? { ...e, state: "active" as const } : losers.includes(e.id) ? { ...e, state: "superseded" as const } : e)) }) });
        const active = [...ctx.body.active.filter((x) => !dispute.members.includes(x)), chosen];
        if (active.length > DECISION_LIMITS.active) throw new DomainError("unavailable", `a project holds at most ${DECISION_LIMITS.active} authoritative decisions; supersede some`);
        changes.push(this.#upsert({ kind: "decision-context", id: dispute.projectId }, ctx.revision, { ...ctx.body, version: ctx.body.version + 1, active, disputes: ctx.body.disputes.filter((x) => x !== disputeId), pending: [...ctx.body.pending, propId] }));
        changes.push({ type: "create", ref: { kind: "decision-propagation", id: propId }, body: json({ projectId: dispute.projectId, reason: "resolved", decisionIds: dispute.members, newId: chosen, state: "pending", steps: {}, createdAt: now } satisfies PropagationBody) });
        return { ref: { kind: "decision-dispute", id: disputeId }, creates: false, changes: mergeChanges(changes), detail: { disputeId, chosen, losers } };
      },
    })));
    if (result.replayed) return { replayed: true, propagation: body<PropagationBody>(await this.#runner.get("decision-propagation", propId))?.state === "done" ? "done" : await this.#propagateSafely(by, propId) };
    return { replayed: false, propagation: await this.#propagateSafely(by, propId) };
  }

  // ---- questions ---------------------------------------------------------------------------------------------------------------

  /**
   * An agent working on a task asks the owner to decide something. A topic the owner already decided is not asked again (the answer is returned), a disputed one is not asked (the owner's conflict stands),
   * and a question already open on the topic is not asked a second time.
   */
  async ask(by: Principal, command: NoActor & { taskId: string; topic: string; question: string }): Promise<{ asked: boolean; questionId?: string; decided?: View<OwnerDecisionBody>; disputed?: string; replayed?: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "topic", "question"]);
    const taskId = checkTaskId(command.taskId);
    const task = body<TaskBody>(await this.#runner.get("task", taskId));
    if (task === undefined || !inTaskScope(by, task.projectId) || !allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } })) throw new DomainError("forbidden", `${by.id} may not ask about that task`);
    const topic = normalTopic(typeof command.topic === "string" ? command.topic : "");
    if (!TOPIC.test(topic) || topic === GATE_TOPIC) invalid("topic", "must be 1 to 80 letters, digits, spaces and . _ / -");
    const question = plain(command.question, "question", DECISION_LIMITS.question);
    const known = await this.#authority(task.projectId, taskId, topic);
    if (known.status === "decided") return { asked: false, decided: known.decision };
    if (known.status === "disputed") return { asked: false, disputed: known.dispute.id };
    const scoped = scopedCommandId(by.id, command.commandId);
    const id = derivedId("dqn", scoped);
    try {
      const result = await this.#retrying(() => this.#runner.command("decision.ask", { commandId: scoped, actor: by.id }, async () => ({
        payload: { taskId, topic, question },
        build: async () => {
          const topicRef: AggregateRef = { kind: "decision-topic", id: topicIdOf(task.projectId, topic) };
          const topicFound = await this.#runner.get(topicRef.kind, topicRef.id);
          const t: TopicBody = body<TopicBody>(topicFound) ?? { projectId: task.projectId, topic, entries: [], questions: [] };
          // A decision recorded since the check above settles it; a question already open is not asked a second time.
          if (t.entries.some((e) => e.state !== "superseded" && (e.taskId === undefined || e.taskId === taskId))) throw new Settled();
          const open = t.questions[0];
          if (open !== undefined) throw new Settled(open.id);
          if (t.questions.length >= DECISION_LIMITS.questionsPerTopic) throw new DomainError("unavailable", `"${topic}" already has ${DECISION_LIMITS.questionsPerTopic} open questions`);
          const ctx = await this.#context(task.projectId);
          if (ctx.body.questions.length >= DECISION_LIMITS.openQuestions) throw new DomainError("unavailable", `the project already has ${DECISION_LIMITS.openQuestions} open questions for the owner`);
          const q: QuestionBody = { projectId: task.projectId, taskId, topic, question, askedBy: by.id, askedAt: this.#runner.now(), state: "open" };
          const ref: AggregateRef = { kind: "decision-question", id };
          return {
            ref, creates: true, detail: { questionId: id, topic, taskId },
            changes: [
              { type: "create", ref, body: json(q) },
              this.#upsert({ kind: "decision-topic", id: topicRef.id }, topicFound?.revision ?? 0, { ...t, questions: [...t.questions, { id, taskId }] }),
              this.#upsert({ kind: "decision-context", id: task.projectId }, ctx.revision, { ...ctx.body, version: ctx.body.version + 1, questions: [...ctx.body.questions, id] }),
              ...(await this.#firstGate(task.projectId, ctx.revision, topicRef.id)),
            ],
          };
        },
      })));
      return { asked: !result.replayed, questionId: result.id, replayed: result.replayed };
    } catch (error) {
      if (!(error instanceof Settled)) throw error;
      if (error.questionId !== undefined) return { asked: false, questionId: error.questionId };
      const k = await this.#authority(task.projectId, taskId, topic);
      return k.status === "decided" ? { asked: false, decided: k.decision } : k.status === "disputed" ? { asked: false, disputed: k.dispute.id } : { asked: false };
    }
  }

  /** The owner withdraws an open question without answering it. */
  async dismissQuestion(by: Principal, command: NoActor & { questionId: string; reason: string }): Promise<void> {
    onlyKnown(command, ["commandId", "questionId", "reason"]);
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} is not the owner`);
    const id = typeof command.questionId === "string" && QUESTION_ID.test(command.questionId) ? command.questionId : invalid("questionId", "is not a question ID");
    plain(command.reason, "reason", DECISION_LIMITS.reason);
    await this.#retrying(() => this.#runner.command("decision.dismiss", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { questionId: id, reason: command.reason },
      build: async () => {
        const found = await this.#runner.get("decision-question", id);
        const q = body<QuestionBody>(found);
        if (found === undefined || q === undefined) throw new DomainError("not_found", `question ${id} does not exist`);
        if (q.state !== "open") invalid("questionId", `is ${q.state}`);
        const topicFound = await this.#runner.get("decision-topic", topicIdOf(q.projectId, q.topic));
        const t = body<TopicBody>(topicFound)!;
        const ctx = await this.#context(q.projectId);
        const ctxRef: AggregateRef = { kind: "decision-context", id: q.projectId };
        return {
          ref: { kind: "decision-question", id }, creates: false, detail: { questionId: id },
          changes: [
            { type: "update", ref: { kind: "decision-question", id }, expectedRevision: found.revision, body: json({ ...q, state: "dismissed", closedAt: this.#runner.now() }) },
            { type: "update", ref: { kind: "decision-topic", id: topicIdOf(q.projectId, q.topic) }, expectedRevision: topicFound!.revision, body: json({ ...t, questions: t.questions.filter((x) => x.id !== id) }) },
            { type: "update", ref: ctxRef, expectedRevision: ctx.revision, body: json({ ...ctx.body, version: ctx.body.version + 1, questions: ctx.body.questions.filter((x) => x !== id) }) },
          ],
        };
      },
    })));
  }

  // ---- links and revalidation --------------------------------------------------------------------------------------------------

  /** Links a plan, task contract, review, action or branch of a task to the decisions it relies on. Only authoritative decisions can be linked. */
  async link(by: Principal, command: NoActor & { taskId: string; subject: { kind: SubjectKind; id: string }; decisions: readonly string[] }): Promise<{ links: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "subject", "decisions"]);
    const taskId = checkTaskId(command.taskId);
    const task = await this.#workTask(by, taskId);
    const subject = this.#subject(command.subject);
    const ids = this.#decisionIds(command.decisions);
    const result = await this.#retrying(() => this.#runner.command("decision.link", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, subject: json(subject), decisions: ids },
      build: async () => {
        await this.#checkSubject(by, task, taskId, subject);
        const now = this.#runner.now();
        const relRef: AggregateRef = { kind: "decision-reliance", id: relianceIdOf(taskId) };
        const relFound = await this.#runner.get(relRef.kind, relRef.id);
        const rel: RelianceBody = body<RelianceBody>(relFound) ?? { taskId, projectId: task.projectId, links: [], revalidations: 0, followUps: [] };
        const byId = new Map(rel.links.map((l) => [l.id, l]));
        const changes: Change[] = [];
        for (const id of ids) {
          const found = await this.#runner.get("decision", id);
          const d = body<OwnerDecisionBody>(found);
          if (found === undefined || d === undefined || d.projectId !== task.projectId || (d.taskId !== undefined && d.taskId !== taskId)) invalid("decisions", `${id} is not a decision this task can rely on`);
          if (d!.category === "gate") invalid("decisions", `${id} is a gate; a gate binds by itself and is not linked`);
          if (d!.state !== "active") invalid("decisions", `${id} is ${d!.state === "superseded" ? `superseded${d!.supersededBy === undefined ? "" : ` (the current one is ${d!.supersededBy})`}` : "disputed"} and is not authoritative; link the current decision`);
          // Only the decision that governs this task on the topic: a project-wide decision that a task-level one overrides is not what this task relies on.
          const governing = await this.#authority(task.projectId, taskId, d!.topic);
          if (governing.status !== "decided" || governing.decision.id !== id) invalid("decisions", `${id} does not govern this task on "${d!.topic}"${governing.status === "decided" ? `; ${governing.decision.id} does` : ""}`);
          const link: LinkBody = { id: linkIdOf(subject, id), subject, decisionId: id, version: d!.version, topic: d!.topic, state: "current", linkedBy: by.id, linkedAt: now };
          byId.set(link.id, link);
          changes.push({ type: "check", ref: { kind: "decision", id }, expectedRevision: found!.revision }, ...(await this.#addDependent(id, taskId)));
        }
        if (byId.size > DECISION_LIMITS.linksPerTask) throw new DomainError("unavailable", `a task relies on at most ${DECISION_LIMITS.linksPerTask} decision links`);
        const next: RelianceBody = { ...rel, links: [...byId.values()].sort((a, b) => (a.id < b.id ? -1 : 1)) };
        changes.push(relFound === undefined ? { type: "create", ref: relRef, body: json(next) } : { type: "update", ref: relRef, expectedRevision: relFound.revision, body: json(next) });
        return { ref: relRef, creates: relFound === undefined, changes: mergeChanges(changes), detail: { taskId, subject: json(subject), decisions: ids } };
      },
    })));
    return { links: ids.length, replayed: result.replayed };
  }

  /**
   * Work that relied on superseded or disputed decisions is revalidated by linking it to the current ones. Every stale link needs the decision that governs the task on its topic (the one `authoritative`
   * returns) among `decisions`; a superseded decision can never be named. Who may clear a link depends on what it is: the agent working the task (or the owner) clears the links of its plans, contract, actions
   * and branches; a review's link is cleared only by a reviewer who did not ask for it (or the owner). A reviewer who does not work on the task clears nothing else. `subjects` names the links to clear;
   * without it, every stale link the caller may clear is cleared and the others are reported in `remaining`.
   */
  async revalidate(by: Principal, command: NoActor & { taskId: string; decisions: readonly string[]; note: string; subjects?: readonly { kind: SubjectKind; id: string }[] }): Promise<{ revalidated: number; remaining: number; replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "decisions", "note", "subjects"]);
    const taskId = checkTaskId(command.taskId);
    const task = await this.#workTask(by, taskId, true);
    const ids = this.#decisionIds(command.decisions);
    const note = plain(command.note, "note", DECISION_LIMITS.note);
    if (command.subjects !== undefined && (!Array.isArray(command.subjects) || command.subjects.length < 1 || command.subjects.length > DECISION_LIMITS.linksPerTask)) invalid("subjects", `must list 1 to ${DECISION_LIMITS.linksPerTask} subjects`);
    const wanted = command.subjects?.map((x) => this.#subject(x));
    const result: { revalidated: number; remaining: number } = { revalidated: 0, remaining: 0 };
    const run = await this.#retrying(() => this.#runner.command("decision.revalidate", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, decisions: ids, note, ...(wanted === undefined ? {} : { subjects: wanted as unknown as JsonObject[] }) },
      build: async () => {
        const relRef: AggregateRef = { kind: "decision-reliance", id: relianceIdOf(taskId) };
        const relFound = await this.#runner.get(relRef.kind, relRef.id);
        const rel = body<RelianceBody>(relFound);
        if (relFound === undefined || rel === undefined) invalid("taskId", "relies on no decisions");
        const given = new Map<string, { revision: number; body: OwnerDecisionBody }>();
        for (const id of ids) {
          const found = await this.#runner.get("decision", id);
          const d = body<OwnerDecisionBody>(found);
          if (found === undefined || d === undefined || d.projectId !== task.projectId || (d.taskId !== undefined && d.taskId !== taskId)) invalid("decisions", `${id} is not a decision this task can rely on`);
          if (d!.state !== "active" || d!.category === "gate") invalid("decisions", `${id} is not an authoritative decision; superseded guidance cannot be restored by naming it`);
          given.set(id, { revision: found!.revision, body: d! });
        }
        const stale: LinkBody[] = [];
        for (const l of rel!.links) if (body<OwnerDecisionBody>(await this.#runner.get("decision", l.decisionId))?.state !== "active") stale.push(l);
        if (stale.length === 0) invalid("taskId", "has nothing to revalidate");
        const covered = (l: LinkBody): boolean => wanted === undefined || wanted.some((w) => w.kind === l.subject.kind && w.id === l.subject.id);
        for (const w of wanted ?? []) if (!stale.some((l) => l.subject.kind === w.kind && l.subject.id === w.id)) invalid("subjects", `${w.kind} ${w.id} has no stale link`);
        const chosen: LinkBody[] = [];
        let refusal: string | undefined;
        for (const l of stale.filter(covered)) {
          const why = await this.#cannotClear(by, taskId, task.projectId, l);
          if (why === undefined) chosen.push(l); else if (wanted !== undefined) throw new DomainError("forbidden", why); else refusal ??= why;
        }
        if (chosen.length === 0) throw new DomainError("forbidden", refusal ?? `${by.id} may not revalidate anything on that task`);
        const next = new Map(rel!.links.filter((l) => !chosen.includes(l)).map((l) => [l.id, l]));
        const now = this.#runner.now();
        const used = new Set<string>();
        const missing: string[] = [];
        for (const l of chosen) {
          const governing = await this.#authority(task.projectId, taskId, l.topic);
          const replacement = governing.status === "decided" && given.has(governing.decision.id) ? governing.decision.id : undefined;
          if (replacement === undefined) { missing.push(l.topic); continue; }
          const fresh: LinkBody = { id: linkIdOf(l.subject, replacement), subject: l.subject, decisionId: replacement, version: given.get(replacement)!.body.version, topic: l.topic, state: "current", linkedBy: by.id, linkedAt: now };
          next.set(fresh.id, fresh);
          used.add(replacement);
        }
        if (missing.length > 0) invalid("decisions", `the decision that governs this task on ${[...new Set(missing)].map((t) => `"${t}"`).join(", ")} is needed (a disputed topic stays blocked until the owner chooses)`);
        result.revalidated = chosen.length;
        result.remaining = stale.length - chosen.length;
        const changes: Change[] = [];
        for (const id of used) changes.push({ type: "check", ref: { kind: "decision", id }, expectedRevision: given.get(id)!.revision }, ...(await this.#addDependent(id, taskId)));
        const nextRel: RelianceBody = { ...rel!, links: [...next.values()].sort((a, b) => (a.id < b.id ? -1 : 1)), revalidations: rel!.revalidations + 1, lastRevalidation: { by: by.id, at: now, note, links: chosen.map((l) => l.id) } };
        changes.push({ type: "update", ref: relRef, expectedRevision: relFound!.revision, body: json(nextRel) });
        return { ref: relRef, creates: false, changes: mergeChanges(changes), detail: { taskId, revalidated: chosen.length, remaining: result.remaining, decisions: [...used] } };
      },
    })));
    return { ...result, replayed: run.replayed };
  }

  /** Why this caller may not clear this link, or `undefined` when it may. */
  async #cannotClear(by: Principal, taskId: string, projectId: string, l: LinkBody): Promise<string | undefined> {
    if (by.kind === "owner") return undefined;
    if (l.subject.kind === "review") {
      const review = body<{ binding: { requester: string; projectId: string }; state: string; decidedBy?: string }>(await this.#runner.get("review", l.subject.id));
      const route = body<{ mandatoryHuman: boolean; state: string }>(await this.#runner.get("review-route", l.subject.id));
      // A review in owner mode (or one the owner decided) is only ever decided again by the owner (card H12h).
      if (review === undefined || route === undefined || review.state === "owner-decision" || route.mandatoryHuman || route.state === "escalated" || (review.decidedBy ?? "").startsWith("owner:")) return `${by.id} may not revalidate that review: it is the owner's to decide again`;
      return review === undefined || review.binding.requester === by.id || !allows(by, "review.decide", review.binding.projectId) || !inTaskScope(by, projectId)
        ? `${by.id} may not revalidate that review: the agent whose work was reviewed cannot re-approve it; a reviewer (or the owner) decides again` : undefined;
    }
    return inTaskScope(by, projectId) && allows(by, "attempt.work", projectId, { resource: { kind: "task", id: taskId } }) ? undefined : `${by.id} does not work on that task, so it may not revalidate its ${l.subject.kind}`;
  }

  async #addDependent(decisionId: string, taskId: string): Promise<Change[]> {
    const ref: AggregateRef = { kind: "decision-dependents", id: dependentsIdOf(decisionId) };
    const found = await this.#runner.get(ref.kind, ref.id);
    const cur = body<DependentsBody>(found) ?? { decisionId, taskIds: [] };
    if (cur.taskIds.includes(taskId)) return found === undefined ? [] : [{ type: "check", ref, expectedRevision: found.revision }];
    if (cur.taskIds.length >= DECISION_LIMITS.tasksPerDecision) throw new DomainError("unavailable", `at most ${DECISION_LIMITS.tasksPerDecision} tasks can rely on one decision`);
    const next: DependentsBody = { decisionId, taskIds: [...cur.taskIds, taskId].sort() };
    return [found === undefined ? { type: "create", ref, body: json(next) } : { type: "update", ref, expectedRevision: found.revision, body: json(next) }];
  }

  // ---- follow-up of completed effects --------------------------------------------------------------------------------------------

  /**
   * Closes a corrective follow-up. `addressed`: corrective work was done (optionally naming the corrective effect). `accepted`: the owner accepts the effect as it stands. Neither says the original effect
   * was undone, and nothing here can.
   */
  async closeFollowUp(by: Principal, command: NoActor & { followUpId: string; state: "addressed" | "accepted"; note: string; correctiveEffectId?: string }): Promise<void> {
    onlyKnown(command, ["commandId", "followUpId", "state", "note", "correctiveEffectId"]);
    const id = typeof command.followUpId === "string" && FOLLOW_UP_ID.test(command.followUpId) ? command.followUpId : invalid("followUpId", "is not a follow-up ID");
    if (command.state !== "addressed" && command.state !== "accepted") invalid("state", "must be addressed or accepted");
    const note = plain(command.note, "note", DECISION_LIMITS.note);
    const corrective = command.correctiveEffectId === undefined ? undefined : typeof command.correctiveEffectId === "string" && /^eff-[a-z2-7]{20}$/.test(command.correctiveEffectId) ? command.correctiveEffectId : invalid("correctiveEffectId", "is not an effect ID");
    await this.#runner.command("decision.followup", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { followUpId: id, state: command.state, note, ...(corrective === undefined ? {} : { correctiveEffectId: corrective }) },
      build: async () => {
        const found = await this.#runner.get("decision-followup", id);
        const f = body<FollowUpBody>(found);
        const allowed = f !== undefined && (by.kind === "owner" || (command.state === "addressed" && inTaskScope(by, f.projectId) && allows(by, "attempt.work", f.projectId, { resource: { kind: "task", id: f.taskId } })));
        if (found === undefined || f === undefined || !allowed) throw new DomainError("forbidden", `${by.id} may not close that follow-up`);
        if (f.state !== "open") invalid("followUpId", `is already ${f.state}`);
        if (corrective !== undefined) {
          const eff = body<EffectBody>(await this.#runner.get("effect", corrective));
          if (eff === undefined || eff.taskId !== f.taskId || corrective === f.effectId) invalid("correctiveEffectId", "is not another effect of this task");
        }
        const next: FollowUpBody = { ...f, state: command.state, closedBy: by.id, closedAt: this.#runner.now(), closeNote: note, ...(corrective === undefined ? {} : { correctiveEffectId: corrective }) };
        return { ref: { kind: "decision-followup", id }, creates: false, changes: [{ type: "update", ref: { kind: "decision-followup", id }, expectedRevision: found.revision, body: json(next) }], detail: { followUpId: id, state: command.state } };
      },
    }));
  }

  // ---- propagation -------------------------------------------------------------------------------------------------------------

  /** Passes a correction on (marks links, records finished effects, interrupts a running generation, tells each task) until all is done; what could not be done stays pending. Owner, host or service. */
  async propagate(by: Principal, command: { propagationId: string }): Promise<PropagationResult> {
    onlyKnown(command, ["propagationId"]);
    if (typeof command.propagationId !== "string" || !/^dpr-[0-9a-f]{32}$/.test(command.propagationId)) invalid("propagationId", "is not a propagation ID");
    const rec = body<PropagationBody>(await this.#runner.get("decision-propagation", command.propagationId));
    if (rec === undefined || !this.#mayPass(by, rec.projectId, "assignment.manage")) throw new DomainError("forbidden", `${by.id} may not pass corrections on`);
    return this.#propagate(by, command.propagationId);
  }

  /** Finishes the unfinished propagations of a project, at most 20 a call (`more` says to call again): after a restart, or when a task could not be told. The owner, or a host or service with `assignment.manage` in the project. */
  async resume(by: Principal, command: { projectId: string }): Promise<{ done: number; pending: number; more: boolean; failures: readonly PropagationResult["failures"][number][] }> {
    onlyKnown(command, ["projectId"]);
    const projectId = checkProjectId(command.projectId);
    if (!this.#mayPass(by, projectId, "assignment.manage")) throw new DomainError("forbidden", `${by.id} may not pass corrections on in that project`);
    const ctx = await this.#context(projectId);
    let done = 0, pending = 0;
    const failures: PropagationResult["failures"][number][] = [];
    // A pass looks at a bounded number; `more` says to call again. The owner's own corrections are never refused for a backlog.
    for (const id of ctx.body.pending.slice(0, DECISION_LIMITS.pending)) {
      const r = await this.#propagate(by, id);
      if (r.done) done++; else pending++;
      failures.push(...r.failures);
    }
    return { done, pending, more: ctx.body.pending.length > DECISION_LIMITS.pending, failures };
  }

  async #propagateSafely(by: Principal, propId: string): Promise<"done" | "pending"> {
    try { return (await this.#propagate(by, propId)).done ? "done" : "pending"; } catch (error) {
      if (error instanceof DomainError && error.code === "stale_epoch") throw error;
      return "pending";
    }
  }

  async #propagate(by: Principal, propId: string): Promise<PropagationResult> {
    const first = await this.#runner.get("decision-propagation", propId);
    const rec = body<PropagationBody>(first);
    if (first === undefined || rec === undefined) throw new DomainError("not_found", `propagation ${propId} does not exist`);
    if (rec.state === "done") return { done: true, pendingTasks: [], failures: [] };
    const tasks = new Set<string>();
    for (const id of rec.decisionIds) for (const t of body<DependentsBody>(await this.#runner.get("decision-dependents", dependentsIdOf(id)))?.taskIds ?? []) tasks.add(t);
    const steps: Record<string, PropagationStep> = { ...rec.steps };
    const failures: PropagationResult["failures"][number][] = [];
    const pendingTasks: string[] = [];
    const noticeKind = rec.reason === "superseded" ? "decision-superseded" : rec.reason === "disputed" ? "decision-disputed" : "decision-resolved";
    const subject = rec.newId ?? rec.decisionIds[0]!;
    for (const taskId of [...tasks].sort()) {
      let step: PropagationStep = steps[taskId] ?? {};
      let step_ = "links";
      try {
        if (rec.reason !== "disputed" && step.links === undefined) { await this.#markLinks(by, propId, taskId, rec); step = { ...step, links: true }; }
        step_ = "generation";
        if (rec.reason !== "resolved" && step.generation === undefined) { await this.#interrupt(by, propId, taskId, rec); step = { ...step, generation: true }; }
        step_ = "notice";
        if (step.notified === undefined && this.#deps.events !== undefined) {
          const published = await this.#deps.events.publish(by, { commandId: `${propId}-e-${taskId}`, stream: `task:${taskId}`, kind: noticeKind, ref: { kind: "owner-decision", id: subject }, key: `decision:${propId.slice(4, 20)}` });
          if (!published.accepted) { failures.push({ taskId, step: step_, code: "backpressure", message: published.reason }); pendingTasks.push(taskId); steps[taskId] = step; continue; }
          step = { ...step, notified: published.seq };
        }
      } catch (error) {
        if (error instanceof DomainError && error.code === "stale_epoch") throw error;
        failures.push({ taskId, step: step_, code: error instanceof DomainError ? error.code : "error", message: error instanceof Error ? error.message : String(error) });
        pendingTasks.push(taskId);
      }
      steps[taskId] = step;
    }
    await this.#saveProgress(by, propId, steps, pendingTasks.length === 0);
    return { done: pendingTasks.length === 0, pendingTasks, failures };
  }

  async #saveProgress(by: Principal, propId: string, steps: Record<string, PropagationStep>, finished: boolean): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      try {
        const found = await this.#runner.get("decision-propagation", propId);
        const rec = body<PropagationBody>(found)!;
        const merged: Record<string, PropagationStep> = { ...rec.steps };
        for (const [t, s] of Object.entries(steps)) merged[t] = { ...(merged[t] ?? {}), ...s };
        const now = this.#runner.now();
        const changes: Change[] = [{ type: "update", ref: { kind: "decision-propagation", id: propId }, expectedRevision: found!.revision, body: json({ ...rec, steps: merged, ...(finished ? { state: "done", doneAt: now } : {}) }) }];
        if (finished) {
          const ctx = await this.#context(rec.projectId);
          if (ctx.revision > 0) changes.push({ type: "update", ref: { kind: "decision-context", id: rec.projectId }, expectedRevision: ctx.revision, body: json({ ...ctx.body, pending: ctx.body.pending.filter((p) => p !== propId) }) });
        }
        await this.#runner.command("decision.propagated", { commandId: `${propId}-p-${found!.revision}`, actor: by.id }, async () => ({
          payload: { propagationId: propId, finished },
          build: async () => ({ ref: { kind: "decision-propagation", id: propId }, creates: false, changes, detail: { propagationId: propId, finished } }),
        }));
        return;
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 8) throw error;
      }
    }
  }

  /** Marks a task's links to the replaced decisions superseded, and records each already-started or finished action that relied on one. */
  async #markLinks(by: Principal, propId: string, taskId: string, rec: PropagationBody): Promise<void> {
    const losing = new Set(rec.decisionIds.filter((d) => d !== rec.newId));
    await this.#retrying(() => this.#runner.command("decision.mark", { commandId: `${propId}-m-${taskId}`, actor: by.id }, async () => ({
      payload: { propagationId: propId, taskId },
      build: async () => {
        const relRef: AggregateRef = { kind: "decision-reliance", id: relianceIdOf(taskId) };
        const found = await this.#runner.get(relRef.kind, relRef.id);
        const rel = body<RelianceBody>(found);
        if (found === undefined || rel === undefined) throw new DomainError("not_found", `task ${taskId} has no recorded reliance`);
        const now = this.#runner.now();
        const changes: Change[] = [];
        const followUps = [...rel.followUps];
        const links: LinkBody[] = [];
        for (const l of rel.links) {
          if (!losing.has(l.decisionId) || l.state === "superseded") { links.push(l); continue; }
          links.push({ ...l, state: "superseded", ...(rec.newId === undefined ? {} : { supersededBy: rec.newId }), markedAt: now });
          if (l.subject.kind === "action" && this.#deps.effects !== undefined) {
            const effect = await this.#deps.effects.get(l.subject.id);
            const status = effect === undefined ? undefined : effect.status === "confirmed" ? "confirmed" : effect.status === "uncertain" ? "uncertain" : effect.status === "intended" && effect.started ? "in-flight" : undefined;
            if (status !== undefined) {
              const fid = followUpIdOf(l.subject.id, l.decisionId);
              if (!followUps.includes(fid) && (await this.#runner.get("decision-followup", fid)) === undefined) {
                if (followUps.length >= DECISION_LIMITS.followUpsPerTask) throw new DomainError("unavailable", `task ${taskId} already has ${DECISION_LIMITS.followUpsPerTask} follow-ups`);
                const f: FollowUpBody = {
                  taskId, projectId: rel.projectId, effectId: l.subject.id, decisionId: l.decisionId, ...(rec.newId === undefined ? {} : { supersededBy: rec.newId }), effectStatus: status, undone: false, state: "open", createdAt: now,
                  note: `The owner's decision this action relied on was superseded after the action ${status === "confirmed" ? "was completed" : status === "uncertain" ? "may or may not have happened" : "had started"}. It has not been undone; decide and record any corrective work.`,
                };
                changes.push({ type: "create", ref: { kind: "decision-followup", id: fid }, body: json(f) });
                followUps.push(fid);
              }
            }
          }
        }
        changes.push({ type: "update", ref: relRef, expectedRevision: found.revision, body: json({ ...rel, links, followUps }) });
        return { ref: relRef, creates: false, changes: mergeChanges(changes), detail: { propagationId: propId, taskId, marked: links.filter((l) => l.state === "superseded").length } };
      },
    })));
  }

  /** A running generation of the task is interrupted (L05 `correct`), so what it was producing cannot be applied. A task that never generated, or is finished, needs nothing. */
  async #interrupt(by: Principal, propId: string, taskId: string, rec: PropagationBody): Promise<void> {
    const generation = this.#deps.generation;
    if (generation === undefined) return;
    const gate = await generation.gate(by, taskId);
    if (gate === undefined) return;
    try {
      await generation.correct(by, { commandId: `${propId}-g-${taskId}`, taskId, expectedContextRevision: gate.gate.contextRevision, reason: `owner decision ${rec.reason}: ${(rec.newId ?? rec.decisionIds[0]!)}` });
    } catch (error) {
      // Finished tasks need no interruption; a revision that moved or a repeat with another revision means a correction already landed.
      if (error instanceof DomainError && (error.code === "invalid_command" || error.code === "command_conflict" || error.code === "stale_revision")) return;
      throw error;
    }
  }

  // ---- the guard ----------------------------------------------------------------------------------------------------------------

  /**
   * Why a task may not take its next step now, read from the decisions as they are at this moment: an implementation hold (nothing starts), a planning-only instruction (no effect starts), a disputed gate, or
   * work that relies on a decision that is no longer authoritative. The revision checks (the gate topic record and each decision the task is linked to) go into the same commit as the caller's change, so a gate or a correction racing an admission lands strictly before or after it.
   * The project's first record of any kind creates the gate topic, so only that very first record racing an admission is not ordered (there is nothing yet to check).
   */
  async guard(taskId: string, purpose: "start" | "effect"): Promise<{ readonly blockedBy: readonly string[]; readonly changes: readonly Change[] }> {
    const id = checkTaskId(taskId);
    const task = body<TaskBody>(await this.#runner.get("task", id));
    if (task === undefined) return { blockedBy: [], changes: [] };
    const blockedBy: string[] = [];
    const changes: Change[] = [];
    // Only what this decision reads is guarded: the gate topic and each decision the task's work is linked to, so unrelated decisions never make an admission retry.
    const topicFound = await this.#runner.get("decision-topic", topicIdOf(task.projectId, GATE_TOPIC));
    if (topicFound !== undefined) changes.push({ type: "check", ref: { kind: "decision-topic", id: topicFound.id }, expectedRevision: topicFound.revision });
    const topic = body<TopicBody>(topicFound);
    const live = (topic?.entries ?? []).filter((e) => e.state !== "superseded");
    const entry = newest(live, id);
    if (entry !== undefined) {
      const d = body<OwnerDecisionBody>(await this.#runner.get("decision", entry.id))!;
      if (d.state === "disputed") blockedBy.push(`the owner's instructions about the implementation gate conflict (${entry.id}); nothing starts until the owner chooses`);
      else if (d.gate === "implementation-hold" || (d.gate === "planning-only" && purpose === "effect")) blockedBy.push(`the owner's ${d.gate} instruction (${entry.id}) is in force: ${d.statement}`);
    }
    // Work that relied on a decision that is no longer authoritative may still be thought about (the agent has to read the new decision and revalidate), but no effect starts from it.
    const relFound = purpose === "effect" ? await this.#runner.get("decision-reliance", relianceIdOf(id)) : undefined;
    if (relFound !== undefined) {
      changes.push({ type: "check", ref: { kind: "decision-reliance", id: relianceIdOf(id) }, expectedRevision: relFound.revision });
      const seen = new Set<string>();
      for (const l of body<RelianceBody>(relFound)!.links) {
        const found = await this.#runner.get("decision", l.decisionId);
        const d = body<OwnerDecisionBody>(found);
        if (found !== undefined && !seen.has(found.id)) { seen.add(found.id); changes.push({ type: "check", ref: { kind: "decision", id: found.id }, expectedRevision: found.revision }); }
        if (d !== undefined && d.state !== "active") blockedBy.push(`${l.subject.kind} ${l.subject.id} relies on ${l.topic ? `"${l.topic}" ` : ""}decision ${l.decisionId}, which is ${d.state === "superseded" ? `superseded${d.supersededBy === undefined ? "" : ` by ${d.supersededBy}`}` : "disputed"}; revalidate it first`);
      }
    }
    return { blockedBy, changes };
  }

  /** Throws unless the task may take a step now (for callers that only need the answer). */
  async assertCurrent(taskId: string, purpose: "start" | "effect"): Promise<void> {
    const g = await this.guard(taskId, purpose);
    if (g.blockedBy.length > 0) throw new DomainError("invalid_command", `task ${taskId} may not continue: ${g.blockedBy.join("; ")}`, { field: "decisions" });
  }

  // ---- reads --------------------------------------------------------------------------------------------------------------------

  /** One decision, with its state. Superseded decisions are returned too, marked by their state. Unreadable reads like missing. */
  async get(by: Principal, id: string): Promise<View<OwnerDecisionBody> | undefined> {
    if (typeof id !== "string" || !DECISION_ID.test(id)) return undefined;
    const found = await this.#runner.get("decision", id);
    const d = body<OwnerDecisionBody>(found);
    return found === undefined || d === undefined || !canReadDecision(by, d) ? undefined : view<OwnerDecisionBody>(found);
  }

  /** Every version recorded on a topic, oldest first, the superseded ones included and marked. Needs the owner or history.read in the project. */
  async history(by: Principal, command: { projectId: string; topic: string; taskId?: string }): Promise<View<OwnerDecisionBody>[]> {
    const projectId = checkProjectId(command.projectId);
    const topic = body<TopicBody>(await this.#runner.get("decision-topic", topicIdOf(projectId, normalTopic(String(command.topic)))));
    const out: View<OwnerDecisionBody>[] = [];
    for (const e of topic?.entries ?? []) {
      if (command.taskId !== undefined && e.taskId !== undefined && e.taskId !== command.taskId) continue;
      const found = await this.#runner.get("decision", e.id);
      if (found !== undefined && canReadDecision(by, body<OwnerDecisionBody>(found)!)) out.push(view<OwnerDecisionBody>(found));
    }
    return out;
  }

  /** What governs a topic for a task (or the project): the owner's decision, an unresolved conflict, or nothing decided. */
  async authoritative(by: Principal, command: { projectId: string; taskId?: string; topic: string }): Promise<Authority | undefined> {
    const projectId = checkProjectId(command.projectId);
    const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
    if (!(await this.#mayContext(by, projectId, taskId))) return undefined;
    return this.#authority(projectId, taskId, normalTopic(String(command.topic)));
  }

  /**
   * The versioned context record of a project (and a task): current decisions, goals, permissions the owner stated, gates, unresolved conflicts and open questions. Built from the records, never from a summary, so
   * it is the same after any number of compactions. Unreadable reads like missing.
   */
  async context(by: Principal, command: { projectId: string; taskId?: string }): Promise<DecisionContext | undefined> {
    const projectId = checkProjectId(command.projectId);
    const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
    if (!(await this.#mayContext(by, projectId, taskId))) return undefined;
    const ctx = await this.#context(projectId);
    const relevant = (t: string | undefined): boolean => taskId === undefined || t === undefined || t === taskId;
    const decisions: View<OwnerDecisionBody>[] = [], goals: View<OwnerDecisionBody>[] = [], permissions: View<OwnerDecisionBody>[] = [], gates: View<OwnerDecisionBody>[] = [];
    for (const id of ctx.body.active) {
      const found = await this.#runner.get("decision", id);
      const d = body<OwnerDecisionBody>(found);
      if (found === undefined || d === undefined || d.state !== "active" || !relevant(d.taskId)) continue;
      (d.category === "goal" ? goals : d.category === "permission" ? permissions : d.category === "gate" ? gates : decisions).push(view<OwnerDecisionBody>(found));
    }
    const disputes: View<DisputeBody>[] = [];
    for (const id of ctx.body.disputes) { const f = await this.#runner.get("decision-dispute", id); const d = body<DisputeBody>(f); if (f !== undefined && d !== undefined && relevant(d.taskId)) disputes.push(view<DisputeBody>(f)); }
    const questions: View<QuestionBody>[] = [];
    for (const id of ctx.body.questions) { const f = await this.#runner.get("decision-question", id); const q = body<QuestionBody>(f); if (f !== undefined && q !== undefined && relevant(q.taskId)) questions.push(view<QuestionBody>(f)); }
    return { projectId, ...(taskId === undefined ? {} : { taskId }), version: ctx.body.version, decisions, goals, permissions, gates, disputes, questions };
  }

  /** What a task relies on, link by link, with the current state of each decision. */
  async reliance(by: Principal, taskId: string): Promise<{ links: (LinkBody & { decisionState: string; stale: boolean })[]; followUps: View<FollowUpBody>[]; revalidations: number } | undefined> {
    const id = checkTaskId(taskId);
    const task = body<TaskBody>(await this.#runner.get("task", id));
    if (task === undefined || !(by.kind === "owner" || (inTaskScope(by, task.projectId) && (allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id } }) || allows(by, "history.read", task.projectId))))) return undefined;
    const rel = body<RelianceBody>(await this.#runner.get("decision-reliance", relianceIdOf(id)));
    if (rel === undefined) return { links: [], followUps: [], revalidations: 0 };
    const links: (LinkBody & { decisionState: string; stale: boolean })[] = [];
    for (const l of rel.links) { const s = body<OwnerDecisionBody>(await this.#runner.get("decision", l.decisionId))?.state ?? "missing"; links.push({ ...l, decisionState: s, stale: s !== "active" }); }
    const followUps: View<FollowUpBody>[] = [];
    for (const f of rel.followUps) { const a = await this.#runner.get("decision-followup", f); if (a !== undefined) followUps.push(view<FollowUpBody>(a)); }
    return { links, followUps, revalidations: rel.revalidations };
  }

  /** The propagation record of a correction, for the owner, a host or a service. */
  async propagation(by: Principal, propagationId: string): Promise<View<PropagationBody> | undefined> {
    const found = typeof propagationId === "string" ? await this.#runner.get("decision-propagation", propagationId) : undefined;
    return found === undefined || !this.#mayPass(by, body<PropagationBody>(found)!.projectId, "assignment.read") ? undefined : view<PropagationBody>(found);
  }

  /** The text a link to a decision resolves to, for a reader who may read it (used by the retrieval layer's `owner-decision` links). */
  async text(by: Principal, id: string): Promise<{ text: string; projectId: string; state: string } | undefined> {
    const d = await this.get(by, id);
    return d === undefined ? undefined : { text: decisionText(d, id), projectId: d.projectId, state: d.state };
  }

  // ---- internals ----------------------------------------------------------------------------------------------------------------

  /** The owner, or a host or service principal holding the action in this project (a host is scoped to the work it was given, not to every project). */
  #mayPass(by: Principal, projectId: string, action: "assignment.manage" | "assignment.read"): boolean {
    // The dispatcher's service principal finishes pending corrections in every project from its loop (card H12c); a service may hold no `assignment.manage` grant, so it is named here, as in the host record's reads.
    if (by.kind === "service" && by.id === DISPATCHER_PRINCIPAL && by.taskScope === undefined && action === "assignment.manage") return true;
    return by.kind === "owner" || ((by.kind === "host" || by.kind === "service") && inTaskScope(by, projectId) && allows(by, action, projectId));
  }

  /** The project's first record of any kind also creates the (empty) gate topic, so the guard always has a record to check for a later gate decision. */
  async #firstGate(projectId: string, contextRevision: number, writingTopicId: string): Promise<Change[]> {
    const id = topicIdOf(projectId, GATE_TOPIC);
    if (contextRevision !== 0 || writingTopicId === id || (await this.#runner.get("decision-topic", id)) !== undefined) return [];
    const empty: TopicBody = { projectId, topic: GATE_TOPIC, category: "gate", entries: [], questions: [] };
    return [{ type: "create", ref: { kind: "decision-topic", id }, body: json(empty) }];
  }

  #upsert(ref: AggregateRef, revision: number, next: object): Change {
    return revision === 0 ? { type: "create", ref, body: json(next) } : { type: "update", ref, expectedRevision: revision, body: json(next) };
  }

  async #context(projectId: string): Promise<{ revision: number; body: ContextRecordBody }> {
    const found = await this.#runner.get("decision-context", projectId);
    return found === undefined ? { revision: 0, body: { projectId, version: 0, active: [], disputes: [], questions: [], pending: [] } } : { revision: found.revision, body: body<ContextRecordBody>(found)! };
  }

  async #mayContext(by: Principal, projectId: string, taskId: string | undefined): Promise<boolean> {
    if (by.kind === "owner") return (await this.#runner.get("project", projectId)) !== undefined;
    if (!inTaskScope(by, projectId)) return false;
    if (taskId !== undefined) {
      const task = body<TaskBody>(await this.#runner.get("task", taskId));
      return task?.projectId === projectId && (allows(by, "attempt.work", projectId, { resource: { kind: "task", id: taskId } }) || allows(by, "history.read", projectId));
    }
    return allows(by, "history.read", projectId);
  }

  async #authority(projectId: string, taskId: string | undefined, topic: string): Promise<Authority> {
    const t = body<TopicBody>(await this.#runner.get("decision-topic", topicIdOf(projectId, topic)));
    const live = (t?.entries ?? []).filter((e) => e.state !== "superseded");
    const entry = newest(live, taskId);
    if (entry === undefined) return { status: "none" };
    const found = await this.#runner.get("decision", entry.id);
    const d = body<OwnerDecisionBody>(found)!;
    if (d.state === "active") return { status: "decided", decision: view<OwnerDecisionBody>(found!) };
    const dispute = d.disputeId === undefined ? undefined : await this.#runner.get("decision-dispute", d.disputeId);
    return dispute === undefined ? { status: "none" } : { status: "disputed", dispute: view<DisputeBody>(dispute) };
  }

  async #workTask(by: Principal, taskId: string, reviewer = false): Promise<TaskBody> {
    const task = body<TaskBody>(await this.#runner.get("task", taskId));
    const may = task !== undefined && (by.kind === "owner" || (inTaskScope(by, task.projectId) && (allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }) || (reviewer && allows(by, "review.decide", task.projectId)))));
    if (task === undefined || !may) throw new DomainError("forbidden", `${by.id} may not do that on that task`);
    return task;
  }

  #subject(value: unknown): { kind: SubjectKind; id: string } {
    if (value === null || typeof value !== "object") return invalid("subject", "must name what relies on the decision: { kind, id }");
    const s = value as Record<string, unknown>;
    onlyKnown(s, ["kind", "id"]);
    const kind = (SUBJECT_KINDS as readonly string[]).includes(s["kind"] as string) ? s["kind"] as SubjectKind : invalid("subject.kind", `must be one of ${SUBJECT_KINDS.join(", ")}`);
    const id = typeof s["id"] === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(s["id"]) ? s["id"] : invalid("subject.id", "is not an ID");
    return { kind, id };
  }

  #decisionIds(value: unknown): string[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > 10) return invalid("decisions", "must list 1 to 10 decisions");
    const ids = value.map((v, i) => (typeof v === "string" && DECISION_ID.test(v) ? v : invalid(`decisions[${i}]`, "is not a decision ID")));
    if (new Set(ids).size !== ids.length) invalid("decisions", "names a decision twice");
    return ids;
  }

  /** The thing that relies on the decisions must exist and belong to the task. */
  async #checkSubject(by: Principal, task: TaskBody, taskId: string, subject: { kind: SubjectKind; id: string }): Promise<void> {
    const fail = (): never => invalid("subject", `${subject.kind} ${subject.id} is not something of this task`);
    switch (subject.kind) {
      case "task": case "contract": if (subject.id !== taskId) fail(); break;
      case "plan": {
        const d = body<DeskRecordBody>(await this.#runner.get("desk-record", subject.id));
        if (d === undefined || d.kind !== "plan" || d.projectId !== task.projectId || (d.taskId !== undefined && d.taskId !== taskId) || (d.visibility === "private" && d.owner !== by.id && by.kind !== "owner")) fail();
        break;
      }
      case "review": if (body<{ binding: { taskId: string } }>(await this.#runner.get("review", subject.id))?.binding.taskId !== taskId) fail(); break;
      case "action": if (body<EffectBody>(await this.#runner.get("effect", subject.id))?.taskId !== taskId) fail(); break;
      case "branch": if (body<{ taskId: string }>(await this.#runner.get("context-branch", subject.id))?.taskId !== taskId) fail(); break;
    }
  }

  async #retrying<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      try { return await run(); } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "stale_revision" && error.code !== "command_conflict") || attempt >= 8) throw error;
      }
    }
  }
}
