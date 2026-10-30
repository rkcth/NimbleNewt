import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, text, type TaskBody } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

/** What a step of a task's work can be (card C09). */
export const ACTIVITY_KINDS = [
  "owner-message", "agent-message", "instruction", "source-retrieved", "model-selected", "harness-selected", "tool-call", "approval", "artifact-version", "compression", "branch", "meeting-decision", "lifecycle", "ownership",
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface ManifestRef { readonly kind: string; readonly id: string; readonly version?: string }
/** The context actually supplied at a step: the references and versions, including which summary stood in for earlier history. `missing` says it was not recorded, so a reader never mistakes silence for "nothing". */
export type StepManifest = { readonly missing: false; readonly refs: readonly ManifestRef[]; readonly summaryId?: string } | { readonly missing: true; readonly reason: string };

export interface ActivityStepBody {
  readonly taskId: string;
  readonly projectId: string;
  readonly seq: number;
  readonly kind: ActivityKind;
  readonly summary: string;
  readonly actor: string;
  readonly at: string;
  readonly manifest: StepManifest;
  /** The sensitive part (tool inputs and results, message text) lives in its own record under access control; the step keeps only whether it is there. */
  readonly payload: { readonly state: "stored"; readonly id: string; readonly chars: number; readonly redactions: number; readonly sensitive: boolean } | { readonly state: "none" } | { readonly state: "missing"; readonly reason: string };
}
/** What a task has been explained and corrected by, so a reader goes straight to them instead of reading every explanation and correction in the installation (card C09i). */
interface IndexBody { readonly explanations: readonly string[]; /** Retrospective explanations (asked for by readers), kept apart and capped lower so they cannot fill the room the worker's own need. */ readonly later?: readonly string[]; readonly corrections: readonly { readonly seq: number; readonly id: string }[] }
interface HeadBody { readonly next: number; readonly projectId: string; /** When the latest step was recorded (absent on heads written before the timeline). */ readonly lastAt?: string; readonly unavailable: readonly { readonly from: number; readonly to: number; readonly reason: string; readonly by: string; readonly at: string }[] }
interface PayloadBody { readonly taskId: string; readonly projectId: string; readonly seq: number; readonly sensitive: boolean; readonly text: string; readonly redactions: number }
export interface ExplanationBody {
  readonly taskId: string; readonly projectId: string; readonly seq?: number;
  /** `contemporaneous`: written at the choice, by the one who chose. `retrospective`: asked for later and built only from records. */
  readonly mode: "contemporaneous" | "retrospective";
  readonly choice: string;
  readonly alternatives: readonly { readonly option: string; readonly whyNot: string }[];
  readonly evidence: readonly { readonly statement: string; readonly ref?: ManifestRef }[];
  readonly uncertainty: string;
  /** Retrospective only: false when the records could not explain the step, which the statement then says. */
  readonly grounded?: boolean;
  readonly by: string; readonly at: string;
}
export interface CorrectionBody { readonly taskId: string; readonly projectId: string; readonly seq: number; readonly note: string; readonly by: string; readonly at: string; readonly stepDigest: string }

export const ACTIVITY_LIMITS = { indexed: 2000, indexedLater: 200, summary: 300, summaryInput: 4000, payload: 8000, refs: 100, alternatives: 10, evidence: 10, statement: 500, page: 100, ranges: 200 } as const;
const KIND_OF = { step: "activity-step", head: "activity-head", payload: "activity-payload", explanation: "activity-explanation", correction: "activity-correction", index: "activity-index" } as const;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const REF = /^[a-z][a-z0-9-]{0,30}$/;
const clean = (body: object): JsonObject => JSON.parse(JSON.stringify(body)) as JsonObject;
const forbiddenWords = ["thinking", "reasoning", "chainOfThought", "thoughts", "scratchpad"];

/** A user-facing statement: text, with credentials removed. Provider thinking is not a statement and is refused by name wherever it could arrive. */
/** The first `max` characters, never leaving half of a surrogate pair at the end. */
export const clipText = (value: string, max: number): string => { const cut = value.slice(0, max); return value.length > max && /[\ud800-\udbff]$/.test(cut) ? cut.slice(0, -1) : cut; };
const TIMELINE_PER_TASK = 10;
const TIMELINE_TASKS = 25;
const TIMELINE_PAGES = 40;
const statement = (value: unknown, field: string, max: number = ACTIVITY_LIMITS.statement): string => redactText(text(value, field, { min: 1, max, multiline: true }));
const checkRef = (value: unknown, field: string): ManifestRef => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return invalid(field, "must be { kind, id, version? }");
  const o = value as Record<string, unknown>;
  onlyKnown(o, ["kind", "id", "version"]);
  const kind = typeof o["kind"] === "string" && REF.test(o["kind"]) ? o["kind"] : invalid(`${field}.kind`, "must be a plain lowercase name");
  const id = text(o["id"], `${field}.id`, { min: 1, max: 120 });
  return { kind, id, ...(o["version"] === undefined ? {} : { version: text(o["version"], `${field}.version`, { min: 1, max: 80 }) }) };
};
const refuseThinking = (c: object): void => { for (const w of forbiddenWords) if (w in c) throw new DomainError("invalid_command", `${w}: provider thinking and hidden reasoning are never recorded as an explanation; state the choice, alternatives, evidence and uncertainty`, { field: w }); };

/**
 * Activity records and decision explanations (card C09). Every step of a task's work is appended, in order, with the exact context manifest it used (the references and versions supplied, and which summary), and
 * its sensitive content stored apart under access control with redactions counted and gaps marked. Material choices carry an explanation written at the time: choice, alternatives, key evidence and
 * uncertainty, as statements to a person and never as the model's thinking. An explanation asked for later is a separate, explicit operation, labelled retrospective, built only from what the records
 * hold, and says so when they cannot explain. History is never rewritten: a correction is appended with who and when; ranges that were archived, deleted or are otherwise gone stay in the list, marked unavailable.
 */
export class ActivityService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ActivityService { return new ActivityService(new CommandRunner(storage, epoch, options)); }

  /** Appends a step. The writer is the owner, a host or service, or an agent with `history.append` (or working the task). */
  async record(by: Principal, command: NoActor & { taskId: string; kind: ActivityKind; summary: string; manifest?: { refs: readonly unknown[]; summaryId?: string } | { missing: true; reason: string }; payload?: { text: string; sensitive?: boolean } | { missing: true; reason: string } }): Promise<{ id: string; seq: number; replayed: boolean }> {
    refuseThinking(command);
    onlyKnown(command, ["commandId", "taskId", "kind", "summary", "manifest", "payload"]);
    const taskId = checkTaskId(command.taskId);
    const task = await this.#task(taskId);
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "history.append", task.projectId) || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }))) throw new DomainError("forbidden", `${by.id} may not record activity for that task`);
    if (!ACTIVITY_KINDS.includes(command.kind)) invalid("kind", `must be one of ${ACTIVITY_KINDS.join(", ")}`);
    // The whole text is redacted first and only then cut to what is kept, so a secret that straddles the cut is never left half-hidden.
    const summary = clipText(statement(command.summary, "summary", ACTIVITY_LIMITS.summaryInput), ACTIVITY_LIMITS.summary);
    const manifest = this.#manifest(command.manifest);
    const cmd = scopedCommandId(by.id, command.commandId);
    const stepIdAt = (seq: number): string => derivedId("act", `${taskId}\0${seq}`);
    const payloadIdAt = (seq: number): string => derivedId("apl", `${taskId}\0${seq}`);
    let payload: ActivityStepBody["payload"] = { state: "none" };
    let payloadBody: PayloadBody | undefined;
    const given = command.payload;
    if (given !== undefined) {
      if ("missing" in given && given.missing === true) payload = { state: "missing", reason: statement(given.reason, "payload.reason", 200) };
      else {
        const p = given as { text: string; sensitive?: boolean };
        onlyKnown(p, ["text", "sensitive"]);
        const raw = text(p.text, "payload.text", { min: 1, max: ACTIVITY_LIMITS.payload, multiline: true });
        const cleaned = redactText(raw);
        const redactions = cleaned === raw ? 0 : Math.max(1, (cleaned.match(/\[redacted[^\]]*\]/gi) ?? []).length);
        const sensitive = p.sensitive !== false; // sensitive unless the writer says otherwise
        payload = { state: "stored", id: "", chars: cleaned.length, redactions, sensitive };
        payloadBody = { taskId, projectId: task.projectId, seq: 0, sensitive, text: cleaned, redactions };
      }
    }
    const headRef: AggregateRef = { kind: KIND_OF.head, id: taskId };
    const r = await this.#runner.command("activity.record", { commandId: cmd, actor: by.id }, async () => ({
      payload: { taskId, kind: command.kind, summary, manifest: manifest as unknown as JsonObject, payload: payload as unknown as JsonObject },
      build: async () => {
        const found = await this.#runner.get(headRef.kind, headRef.id);
        const head = found?.body as unknown as HeadBody | undefined;
        const seq = head?.next ?? 1;
        const ref: AggregateRef = { kind: KIND_OF.step, id: stepIdAt(seq) };
        const stored = payload.state === "stored" ? { ...payload, id: payloadIdAt(seq) } : payload;
        const body: ActivityStepBody = { taskId, projectId: task.projectId, seq, kind: command.kind, summary, actor: by.id, at: this.#runner.now(), manifest, payload: stored };
        const next: HeadBody = { next: seq + 1, projectId: task.projectId, lastAt: this.#runner.now(), unavailable: head?.unavailable ?? [] };
        const changes: { type: "create" | "update"; ref: AggregateRef; body: JsonObject; expectedRevision?: number }[] = [{ type: "create", ref, body: clean(body) }];
        if (payloadBody !== undefined) changes.push({ type: "create", ref: { kind: KIND_OF.payload, id: payloadIdAt(seq) }, body: clean({ ...payloadBody, seq }) });
        changes.push(head === undefined ? { type: "create", ref: headRef, body: clean(next) } : { type: "update", ref: headRef, expectedRevision: found!.revision, body: clean(next) });
        return { ref, creates: true, changes: changes as never, detail: { taskId, seq, kind: command.kind }, contention: async () => new DomainError("stale_revision", "another step was recorded at the same moment") };
      },
    }));
    const stored = (await this.#runner.get(KIND_OF.step, r.id))!.body as unknown as ActivityStepBody;
    return { id: r.id, seq: stored.seq, replayed: r.replayed };
  }

  /** A choice that mattered, explained as it was made. Alternatives, key evidence and uncertainty are required; there is no place for thinking. */
  async explain(by: Principal, command: NoActor & { taskId: string; seq?: number; choice: string; alternatives: readonly { option: string; whyNot: string }[]; evidence: readonly { statement: string; ref?: unknown }[]; uncertainty: string }): Promise<{ id: string; replayed: boolean }> {
    refuseThinking(command);
    onlyKnown(command, ["commandId", "taskId", "seq", "choice", "alternatives", "evidence", "uncertainty"]);
    const taskId = checkTaskId(command.taskId);
    const task = await this.#task(taskId);
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "history.append", task.projectId) || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: taskId } }))) throw new DomainError("forbidden", `${by.id} may not explain choices on that task`);
    if (command.seq !== undefined && (await this.#stepView(taskId, command.seq)).gone !== undefined) invalid("seq", "that step is unavailable");
    if (!Array.isArray(command.alternatives) || command.alternatives.length < 1 || command.alternatives.length > ACTIVITY_LIMITS.alternatives) invalid("alternatives", `give 1 to ${ACTIVITY_LIMITS.alternatives} alternatives that were considered`);
    if (!Array.isArray(command.evidence) || command.evidence.length < 1 || command.evidence.length > ACTIVITY_LIMITS.evidence) invalid("evidence", `give 1 to ${ACTIVITY_LIMITS.evidence} pieces of key evidence`);
    const body: ExplanationBody = {
      taskId, projectId: task.projectId, ...(command.seq === undefined ? {} : { seq: command.seq }), mode: "contemporaneous", choice: statement(command.choice, "choice"),
      alternatives: command.alternatives.map((a, i) => { onlyKnown(a, ["option", "whyNot"]); return { option: statement(a.option, `alternatives[${i}].option`, 200), whyNot: statement(a.whyNot, `alternatives[${i}].whyNot`) }; }),
      evidence: command.evidence.map((e, i) => { onlyKnown(e, ["statement", "ref"]); return { statement: statement(e.statement, `evidence[${i}].statement`), ...(e.ref === undefined ? {} : { ref: checkRef(e.ref, `evidence[${i}].ref`) }) }; }),
      uncertainty: statement(command.uncertainty, "uncertainty"), by: by.id, at: this.#runner.now(),
    };
    return this.#storeExplanation(by, command.commandId, body);
  }

  /**
   * A retrospective explanation of a step, asked for explicitly. It is built from the records only (the step, its manifest, any explanation written at the time) and labelled retrospective; when the records
   * hold no basis it says that they cannot explain instead of inventing a reason. Asking never changes the step.
   */
  async explainLater(by: Principal, command: NoActor & { taskId: string; seq: number }): Promise<{ id: string; replayed: boolean; explanation: ExplanationBody }> {
    onlyKnown(command, ["commandId", "taskId", "seq"]);
    const taskId = checkTaskId(command.taskId);
    const task = await this.#task(taskId);
    this.#mayRead(by, task.projectId, taskId);
    const { step, gone } = await this.#stepView(taskId, command.seq);
    const earlier = await this.#explanationsFor(taskId, command.seq);
    let body: ExplanationBody;
    if (gone !== undefined) body = this.#retro(taskId, task.projectId, command.seq, by, `The records for step ${command.seq} are unavailable (${gone}), so they cannot explain it.`, [], false);
    else if (earlier.length > 0) {
      const e = earlier[0]!;
      body = { ...this.#retro(taskId, task.projectId, command.seq, by, `At the time this was recorded: chose "${e.choice}".`, e.evidence, true), alternatives: e.alternatives, uncertainty: e.uncertainty };
    } else if (!step!.manifest.missing && step!.manifest.refs.length > 0) {
      body = this.#retro(taskId, task.projectId, command.seq, by, `Step ${command.seq} (${step!.kind}) by ${step!.actor}: "${step!.summary}". It was given ${step!.manifest.refs.length} context reference(s). The records do not say why it was chosen.`,
        step!.manifest.refs.slice(0, ACTIVITY_LIMITS.evidence).map((r) => ({ statement: `context supplied: ${r.kind} ${r.id}${r.version === undefined ? "" : ` @${r.version}`}`, ref: r })), true);
    } else body = this.#retro(taskId, task.projectId, command.seq, by, `The records cannot explain step ${command.seq} (${step!.kind}): no explanation was written and no context manifest was kept.`, [], false);
    const stored = await this.#storeExplanation(by, command.commandId, body);
    return { ...stored, explanation: body };
  }

  /** Appends a correction to a step. The step itself is never changed; the correction keeps who, when and a digest of the step as it was. */
  async correct(by: Principal, command: NoActor & { taskId: string; seq: number; note: string }): Promise<{ id: string; replayed: boolean }> {
    refuseThinking(command);
    onlyKnown(command, ["commandId", "taskId", "seq", "note"]);
    const taskId = checkTaskId(command.taskId);
    const task = await this.#task(taskId);
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "history.append", task.projectId))) throw new DomainError("forbidden", `${by.id} may not correct that task's activity`);
    if ((await this.#stepView(taskId, command.seq)).gone !== undefined) invalid("seq", "that step is unavailable");
    const step = await this.#step(taskId, command.seq);
    const note = statement(command.note, "note");
    const id = derivedId("acr", scopedCommandId(by.id, command.commandId));
    const ref: AggregateRef = { kind: KIND_OF.correction, id };
    const body: CorrectionBody = { taskId, projectId: task.projectId, seq: command.seq, note, by: by.id, at: this.#runner.now(), stepDigest: digest(step.body) };
    const r = await this.#runner.command("activity.correct", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, seq: command.seq, note },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, await this.#indexChange(taskId, (x) => ({ ...x, corrections: [...x.corrections, { seq: command.seq, id }] }), "corrections")] as never, detail: { taskId, seq: command.seq }, contention: async () => new DomainError("stale_revision", "another correction or explanation was recorded at the same moment") }),
    }));
    return { id: r.id, replayed: r.replayed };
  }

  /** Marks a range of steps as no longer available (archived, deleted, lost). The steps stay in the list as references and their content is withheld. */
  async markUnavailable(by: Principal, command: NoActor & { taskId: string; first: number; last: number; reason: string }): Promise<{ replayed: boolean }> {
    onlyKnown(command, ["commandId", "taskId", "first", "last", "reason"]);
    const taskId = checkTaskId(command.taskId);
    await this.#task(taskId);
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} may not mark activity unavailable`);
    if (!Number.isSafeInteger(command.first) || !Number.isSafeInteger(command.last) || command.first < 1 || command.last < command.first) invalid("first", "must be a range of step numbers, from 1");
    const reason = statement(command.reason, "reason", 200);
    const headRef: AggregateRef = { kind: KIND_OF.head, id: taskId };
    const r = await this.#runner.command("activity.unavailable", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { taskId, first: command.first, last: command.last, reason },
      build: async () => {
        const found = await this.#runner.get(headRef.kind, headRef.id);
        const head = found?.body as unknown as HeadBody | undefined;
        if (head === undefined || command.last >= head.next) throw new DomainError("invalid_command", "that range includes steps that were never recorded", { field: "last" });
        if (head.unavailable.length >= ACTIVITY_LIMITS.ranges) throw new DomainError("invalid_command", "too many unavailable ranges; merge them", { field: "first" });
        const next: HeadBody = { ...head, unavailable: [...head.unavailable, { from: command.first, to: command.last, reason, by: by.id, at: this.#runner.now() }] };
        return { ref: headRef, creates: false, changes: [{ type: "update", ref: headRef, expectedRevision: found!.revision, body: clean(next) }], detail: { taskId, first: command.first, last: command.last } };
      },
    }));
    return { replayed: r.replayed };
  }

  /** The steps of a task in order, from `after`. Steps in an unavailable range show only that they were there. */
  async steps(by: Principal, taskId: string, page: { after?: number; limit?: number; tail?: boolean } = {}): Promise<{ steps: (ActivityStepView)[]; next?: number }> {
    const tid = checkTaskId(taskId);
    const task = await this.#task(tid);
    this.#mayRead(by, task.projectId, tid);
    const head = (await this.#runner.get(KIND_OF.head, tid))?.body as unknown as HeadBody | undefined;
    if (head === undefined) return { steps: [] };
    const limit = Math.min(Math.max(1, page.limit ?? 50), ACTIVITY_LIMITS.page);
    // `tail`: the last steps (the ones before them are not read).
    const start = page.tail === true ? Math.max(1, head.next - limit) : Math.max(1, (page.after ?? 0) + 1);
    const out: ActivityStepView[] = [];
    let seq = start;
    for (; seq < head.next && out.length < limit; seq++) {
      const { step, gone } = await this.#stepView(tid, seq, head);
      if (gone !== undefined) { out.push({ seq, unavailable: gone }); continue; }
      out.push({ ...step!, corrections: (await this.#corrections(tid, seq)).length });
    }
    return { steps: out, ...(seq < head.next ? { next: seq - 1 } : {}) };
  }

  /**
   * A project's recent steps across its tasks, newest first (card U09): read only, nothing is recorded, run or sent. The project's 25 most recently active tasks each contribute their latest steps (at most 10), so this is a summary to start from, not the whole history;
   * `agent` keeps one actor's steps and `since` keeps those at or after a time. A step in an unavailable range is left out. The caller needs the project's history right (or to be the owner, a host or a service).
   */
  async timeline(by: Principal, projectIdValue: string, filter: { agent?: string; since?: string; limit?: number } = {}): Promise<{ steps: { taskId: string; seq: number; kind: ActivityKind; summary: string; actor: string; at: string }[]; /** Steps in the looked-at range whose records are gone (archived, deleted, ...), so the timeline shows a gap and not a quiet stretch. Left out when the list is filtered by agent (a gone step has no known actor). */ gaps: { taskId: string; seq: number; reason: string }[]; scanned: number; truncated: boolean }> {
    onlyKnown(filter, ["agent", "since", "limit"]);
    const projectId = checkProjectId(projectIdValue);
    // A host is not given every project's history in one call here (it may read a task it is working through `steps`).
    if (!(by.kind === "owner" || by.kind === "service" || allows(by, "history.read", projectId))) throw new DomainError("not_found", "no such project");
    const limit = Math.min(Math.max(1, filter.limit ?? 30), ACTIVITY_LIMITS.page);
    const agent = filter.agent === undefined ? undefined : text(filter.agent, "agent", { min: 1, max: 120 });
    const sinceMs = filter.since === undefined ? undefined : Date.parse(text(filter.since, "since", { min: 1, max: 40 }));
    if (sinceMs !== undefined && Number.isNaN(sinceMs)) invalid("since", "must be a time");
    const found: { taskId: string; seq: number; kind: ActivityKind; summary: string; actor: string; at: string }[] = [];
    const gaps: { taskId: string; seq: number; reason: string }[] = [];
    let truncated = false;
    // Task IDs say nothing about age, so every head is looked at (the head is in the listing already: no read per task) and only the project's most recently active tasks have their steps read.
    const heads: { id: string; head: HeadBody }[] = [];
    for (let after: string | undefined, pages = 0; ; pages++) {
      if (pages >= TIMELINE_PAGES) { truncated = true; break; }
      const chunk = await this.#runner.list(KIND_OF.head, { ...(after === undefined ? {} : { afterId: after }), limit: 500 });
      for (const rec of chunk) { after = rec.id; const head = rec.body as unknown as HeadBody; if (head.projectId === projectId) heads.push({ id: rec.id, head }); }
      if (chunk.length < 500) break;
    }
    const scanned = heads.length;
    // A head from before `lastAt` existed sorts last.
    heads.sort((a, b) => ((b.head.lastAt ?? "") < (a.head.lastAt ?? "") ? -1 : (b.head.lastAt ?? "") > (a.head.lastAt ?? "") ? 1 : a.id < b.id ? -1 : 1));
    if (heads.length > TIMELINE_TASKS) truncated = true;
    for (const { id, head } of heads.slice(0, TIMELINE_TASKS)) {
      if (sinceMs !== undefined && head.lastAt !== undefined && Date.parse(head.lastAt) < sinceMs) continue;
      for (let seq = Math.max(1, head.next - TIMELINE_PER_TASK); seq < head.next; seq++) {
        const { step, gone } = await this.#stepView(id, seq, head);
        if (step === undefined && gone !== undefined && agent === undefined) gaps.push({ taskId: id, seq, reason: gone });
        if (step === undefined || (agent !== undefined && step.actor !== agent) || (sinceMs !== undefined && Date.parse(step.at) < sinceMs)) continue;
        found.push({ taskId: id, seq, kind: step.kind, summary: step.summary, actor: step.actor, at: step.at });
      }
    }
    found.sort((a, b) => (a.at === b.at ? (a.taskId < b.taskId ? 1 : a.taskId > b.taskId ? -1 : b.seq - a.seq) : a.at < b.at ? 1 : -1));
    return { steps: found.slice(0, limit), gaps: gaps.slice(0, limit), scanned, truncated };
  }

  /** The stored content of a step. Sensitive content needs the owner or a history grant; ordinary content is also open to those working the task. */
  async payload(by: Principal, taskId: string, seq: number): Promise<{ text: string; redactions: number } | undefined> {
    const tid = checkTaskId(taskId);
    const task = await this.#task(tid);
    this.#mayRead(by, task.projectId, tid);
    const { step, gone } = await this.#stepView(tid, seq);
    if (gone !== undefined) throw new DomainError("not_found", `the content of step ${seq} is unavailable: ${gone}`);
    if (step!.payload.state !== "stored") return undefined;
    const p = (await this.#runner.get(KIND_OF.payload, step!.payload.id))?.body as unknown as PayloadBody | undefined;
    if (p === undefined) return undefined;
    const may = by.kind === "owner" || by.kind === "service" || allows(by, "history.read", task.projectId) || (!p.sensitive && (by.kind === "host" || allows(by, "attempt.work", task.projectId, { resource: { kind: "task", id: tid } })));
    if (!may) throw new DomainError("not_found", "no such content, or none you may read");
    return { text: p.text, redactions: p.redactions };
  }

  /** Explanations written for a task (optionally one step), oldest first. */
  async explanations(by: Principal, taskId: string, seq?: number): Promise<ExplanationBody[]> {
    const tid = checkTaskId(taskId);
    const task = await this.#task(tid);
    this.#mayRead(by, task.projectId, tid);
    if (seq === undefined) { const keep: ExplanationBody[] = []; for (const e of await this.#allExplanations(tid)) if (e.seq === undefined || (await this.#stepView(tid, e.seq)).gone === undefined) keep.push(e); return keep; }
    return (await this.#stepView(tid, seq)).gone !== undefined ? [] : this.#explanationsFor(tid, seq);
  }

  async corrections(by: Principal, taskId: string, seq: number): Promise<CorrectionBody[]> {
    const tid = checkTaskId(taskId);
    const task = await this.#task(tid);
    this.#mayRead(by, task.projectId, tid);
    return (await this.#stepView(tid, seq)).gone !== undefined ? [] : this.#corrections(tid, seq);
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  async #task(taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", "no such task");
    return task;
  }
  #mayRead(by: Principal, projectId: string, taskId: string): void {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "history.read", projectId) || allows(by, "attempt.work", projectId, { resource: { kind: "task", id: taskId } }))) throw new DomainError("not_found", "no such task");
  }
  async #step(taskId: string, seq: number) {
    if (!Number.isSafeInteger(seq) || seq < 1) invalid("seq", "must be a step number");
    const head = (await this.#runner.get(KIND_OF.head, taskId))?.body as unknown as HeadBody | undefined;
    if (head === undefined || seq >= head.next) throw new DomainError("not_found", `no step ${seq} on that task`, { field: "seq" });
    const found = await this.#runner.get(KIND_OF.step, derivedId("act", `${taskId}\0${seq}`));
    if (found === undefined) throw new DomainError("not_found", `no step ${seq} on that task`, { field: "seq" });
    return found;
  }
  async #stepView(taskId: string, seq: number, known?: HeadBody): Promise<{ step?: ActivityStepBody; gone?: string }> {
    const head = known ?? ((await this.#runner.get(KIND_OF.head, taskId))?.body as unknown as HeadBody | undefined);
    if (head === undefined || !Number.isSafeInteger(seq) || seq < 1 || seq >= head.next) throw new DomainError("not_found", `no step ${seq} on that task`, { field: "seq" });
    const range = head.unavailable.find((r) => seq >= r.from && seq <= r.to);
    if (range !== undefined) return { gone: range.reason };
    return { step: (await this.#step(taskId, seq)).body as unknown as ActivityStepBody };
  }

  #manifest(value: unknown): StepManifest {
    if (value === undefined) return { missing: true, reason: "no context manifest was recorded for this step" };
    const m = value as Record<string, unknown>;
    if (m === null || typeof m !== "object") return invalid("manifest", "must be { refs, summaryId? } or { missing: true, reason }");
    if (m["missing"] === true) { onlyKnown(m, ["missing", "reason"]); return { missing: true, reason: statement(m["reason"], "manifest.reason", 200) }; }
    onlyKnown(m, ["refs", "summaryId"]);
    if (!Array.isArray(m["refs"]) || m["refs"].length > ACTIVITY_LIMITS.refs) invalid("manifest.refs", `must list at most ${ACTIVITY_LIMITS.refs} references`);
    return { missing: false, refs: (m["refs"] as unknown[]).map((r, i) => checkRef(r, `manifest.refs[${i}]`)), ...(m["summaryId"] === undefined ? {} : { summaryId: text(m["summaryId"], "manifest.summaryId", { min: 1, max: 120 }) }) };
  }

  #retro(taskId: string, projectId: string, seq: number, by: Principal, choice: string, evidence: ExplanationBody["evidence"], grounded: boolean): ExplanationBody {
    return { taskId, projectId, seq, mode: "retrospective", choice: redactText(choice).slice(0, ACTIVITY_LIMITS.statement * 2), alternatives: [], evidence, uncertainty: grounded ? "This is read back from records; it is not what was in anyone's mind." : "Nothing in the records supports a reason.", grounded, by: by.id, at: this.#runner.now() };
  }

  async #storeExplanation(by: Principal, commandId: unknown, body: ExplanationBody): Promise<{ id: string; replayed: boolean }> {
    const id = derivedId("xpn", scopedCommandId(by.id, commandId));
    const ref: AggregateRef = { kind: KIND_OF.explanation, id };
    const r = await this.#runner.command("activity.explain", { commandId: scopedCommandId(by.id, commandId), actor: by.id }, async () => ({
      payload: { taskId: body.taskId, mode: body.mode, ...(body.seq === undefined ? {} : { seq: body.seq }), choice: body.choice },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: clean(body) }, await this.#indexChange(body.taskId, (x) => (body.mode === "retrospective" ? { ...x, later: [...(x.later ?? []), id] } : { ...x, explanations: [...x.explanations, id] }), body.mode === "retrospective" ? "later" : "explanations")] as never, detail: { taskId: body.taskId, mode: body.mode }, contention: async () => new DomainError("stale_revision", "another explanation or correction was recorded at the same moment") }),
    }));
    return { id: r.id, replayed: r.replayed };
  }

  /** The change that adds to a task's index (created with the first entry); refused past the limit so one task cannot grow it without bound. */
  async #indexChange(taskId: string, add: (x: IndexBody) => IndexBody, what: "explanations" | "later" | "corrections"): Promise<{ type: "create" | "update"; ref: AggregateRef; body: JsonObject; expectedRevision?: number }> {
    const ref: AggregateRef = { kind: KIND_OF.index, id: taskId };
    const found = await this.#runner.get(ref.kind, ref.id);
    const current = (found?.body as unknown as IndexBody | undefined) ?? { explanations: [], corrections: [] };
    const have = current[what]?.length ?? 0;
    const cap = what === "later" ? ACTIVITY_LIMITS.indexedLater : ACTIVITY_LIMITS.indexed;
    if (have >= cap) invalid(what, `this task already has ${cap} ${what === "later" ? "later explanations" : what}`);
    const next = clean(add(current));
    return found === undefined ? { type: "create", ref, body: next } : { type: "update", ref, expectedRevision: found.revision, body: next };
  }
  async #indexOf(taskId: string): Promise<IndexBody> { return ((await this.#runner.get(KIND_OF.index, taskId))?.body as unknown as IndexBody | undefined) ?? { explanations: [], corrections: [] }; }

  async #allExplanations(taskId: string): Promise<ExplanationBody[]> {
    const out: ExplanationBody[] = [];
    const index = await this.#indexOf(taskId);
    for (const id of [...index.explanations, ...(index.later ?? [])]) { const found = await this.#runner.get(KIND_OF.explanation, id); if (found !== undefined) out.push(found.body as unknown as ExplanationBody); }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }
  async #explanationsFor(taskId: string, seq: number): Promise<ExplanationBody[]> { return (await this.#allExplanations(taskId)).filter((e) => e.seq === seq && e.mode === "contemporaneous"); }
  async #corrections(taskId: string, seq: number): Promise<CorrectionBody[]> {
    const out: CorrectionBody[] = [];
    for (const c of (await this.#indexOf(taskId)).corrections) if (c.seq === seq) { const found = await this.#runner.get(KIND_OF.correction, c.id); if (found !== undefined) out.push(found.body as unknown as CorrectionBody); }
    return out.sort((a, b) => a.at.localeCompare(b.at));
  }
}

export type ActivityStepView = (ActivityStepBody & { readonly corrections: number }) | { readonly seq: number; readonly unavailable: string };
const digest = (body: unknown): string => {
  let h = 5381;
  const s = JSON.stringify(body);
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return `d${(h >>> 0).toString(16)}${s.length}`;
};
