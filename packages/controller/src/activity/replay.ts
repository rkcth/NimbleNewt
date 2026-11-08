import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { taskId as checkTaskIdValue, type TaskBody } from "../domain/model.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ControllerStorage } from "../storage/types.js";
import type { ReadBlock, ThinkingCursor } from "../context/thinking.js";
import { ACTIVITY_KINDS, filterTime, type ActivityKind, type ActivityService, type ActivityStepBody, type ExplanationBody, type ManifestRef, type StepOutcome } from "./activity.js";
import { REPLAY_LIMIT_DEFAULTS, type EffectiveReplayLimits } from "./replay-limits.js";

/**
 * Read-only replay of a task's activity (card U09). Everything here reads the records the activity service keeps, through its own read operations, so the same checks apply as for reading the steps
 * directly (the task's history right, or working on it; sensitive content only with a history right; unavailable ranges stay marked). Nothing here can run a tool, send a message, submit a job or call a
 * model: the service holds no port that could (only the activity reads, the task record and, for the owner's explicit look at stored thinking, the thinking read), and opening or stepping writes nothing.
 * A rerun or a simulation is a different command in an isolated scope (card P07) and is not offered here.
 *
 * The view shows each step as it was recorded: the context versions supplied then (never the current records), where it stood (proposed, dispatched, confirmed, uncertain, or "not recorded"), its branch lane,
 * whether it was later superseded (non-authoritative from then on), how many corrections it has, and links to what it cites. Explanations written at the time and explanations asked for afterwards are kept in
 * separate lists with their own labels.
 */

/** Sizes of one answer (a request cannot ask for more). What bounds how much of a task one replay READS is a setting, `ReplayLimitsService` (off, or generous, by default). */
export const REPLAY_LIMITS = { page: 50, defaultPage: 20, search: 50, evidence: 5 } as const;
/** The words a view shows next to these, so no screen has to invent them. */
export const REPLAY_LABELS = {
  concurrent: "Steps on different branches happened side by side. Their numbers show the order they were recorded, not that one came before another.",
  thinking: "Model output. This is what the model produced while working; it is not an explanation of any decision, and it may be wrong or incomplete.",
  thinkingRemoved: "The model's thinking for this task was removed by retention. Nothing else about the record changes.",
  contemporaneous: "Written at the time by the one who chose.",
  retrospective: "Asked for afterwards and built only from the records; not what was in anyone's mind.",
  superseded: "Replaced by a later step; kept for the record and no longer authoritative.",
  supersederUnread: "Later steps of this task were not read (the range is given), so a step after this window may have replaced this one.",
  notRecorded: "not recorded",
  unexplained: "The records do not show what led to this step.",
  /** Outcome and branch are written by whoever recorded the step; only a controller service's are facts. */
  reported: "Reported by the one who recorded the step; the controller did not check it.",
  unverifiedLane: "unverified lane",
  thinkingUnavailable: "unavailable (not wired): this controller runs without the thinking store or the retention marker, so this says nothing about whether thinking exists.",
  windowed: "Only part of this task's record was read (the range is given); ask for another range to see the rest.",
} as const;

export type ReplayOutcome = StepOutcome | "not-recorded";
export interface ReplayLink {
  readonly relation: "context" | "evidence" | "earlier-step" | "supersedes" | "superseded-by";
  /** For a reference to a record kept elsewhere (a summary, an artifact version, a message, a diff, a comment, a tool call): its kind and ID, never resolved here. */
  readonly kind?: string; readonly id?: string; readonly version?: string;
  /** For a reference to another step of the same task. */
  readonly seq?: number;
  readonly note?: string;
}
export type ReplayContent =
  | { readonly state: "none" }
  | { readonly state: "missing"; readonly reason: string }
  | { readonly state: "stored"; readonly sensitive: boolean; /** Size and redaction count are shown only to a reader who may read the text itself. */ readonly chars?: number; readonly redactions?: number; /** Present only when asked for and allowed. */ readonly text?: string; readonly readable?: boolean };
export interface ReplayStep {
  readonly seq: number; readonly at: string; readonly actor: string; readonly kind: ActivityKind; readonly summary: string;
  readonly lane: string;
  /** `main`: the main line. `controller`: set by a controller service. `verified`: a context branch of this task by that name exists. `unverified`: named by whoever recorded the step; nothing shows the line exists. */
  readonly laneStatus: "main" | "controller" | "verified" | "unverified";
  /** Shown beside a line that is not verified: "unverified lane". */
  readonly laneNote?: string;
  readonly outcome: ReplayOutcome;
  /** For an outcome that someone reported (not a controller service): "reported by agent", so a view never shows a claim as a fact. */
  readonly outcomeNote?: string;
  /** The context supplied at the step, as recorded then. */
  readonly versionsThen: { readonly state: "recorded"; readonly refs: readonly ManifestRef[]; readonly summaryId?: string } | { readonly state: "not-recorded"; readonly reason: string };
  readonly authority: "current" | "superseded";
  /** Set on a step shown as current when later steps were not read, so a superseder may lie outside the window. */
  readonly authorityNote?: string;
  readonly supersedes?: number; readonly supersededBy?: readonly number[];
  readonly content: ReplayContent;
  readonly corrections: number;
  readonly previousInLane?: number; readonly nextInLane?: number;
  readonly links: readonly ReplayLink[];
}
export interface ReplayGap { readonly seq: number; readonly unavailable: string }
export type ReplayEntry = ReplayStep | ReplayGap;

export interface ReplaySummary {
  /** Steps counted in the range that was read. */
  readonly total: number; readonly scanLimited: boolean;
  /** The step numbers that were read, out of how many the task has. */
  readonly range: { readonly first: number; readonly last: number; readonly of: number };
  readonly byKind: Readonly<Record<string, number>>;
  readonly byOutcome: Readonly<Record<string, number>>;
  readonly lanes: readonly { readonly lane: string; readonly steps: number }[];
  readonly agents: readonly { readonly actor: string; readonly steps: number }[];
  readonly unavailable: readonly { readonly seq: number; readonly reason: string }[];
  readonly redactedSteps: number; readonly stepsWithoutManifest: number; readonly superseded: number; readonly corrected: number;
}
export interface ReplayView {
  readonly taskId: string; readonly projectId: string;
  readonly summary: ReplaySummary;
  readonly entries: readonly ReplayEntry[];
  /** The NEXT step to show: pass it as `from` for the next window (no step is repeated or skipped). Absent: nothing follows. */
  readonly next?: number;
  readonly note?: string;
}
export interface ReplayDetail {
  readonly step: ReplayStep;
  readonly explanations: { readonly contemporaneous: { readonly label: string; readonly items: readonly ExplanationBody[] }; readonly retrospective: { readonly label: string; readonly items: readonly ExplanationBody[] } };
  readonly thinking?: ReplayThinkingState;
  /** The range of steps read to place this step (lines, replacements). Absent when the whole record was read. */
  readonly window?: { readonly first: number; readonly last: number; readonly of: number; readonly note: string };
  /** True when the retrospective explanations were read only up to the limit (`ReplayLimitsService`). */
  readonly retrospectiveTruncated?: boolean;
}
export type ReplayThinkingState = { readonly state: "removed-by-retention"; readonly removedAt: string; readonly label: string } | { readonly state: "not-removed"; readonly note: string } | { readonly state: "unavailable"; readonly label: string };

export interface ThinkingRemovalSource { /** When retention removed the task's stored thinking, if it did. */ removedAt(task: { readonly projectId: string; readonly taskId: string }): Promise<string | undefined> }
export interface ReplayDeps {
  /** The owner's explicit look at stored thinking (a recorded look); without it, thinking is not offered. */
  readonly thinking?: { read(by: Principal, command: { commandId: string; projectId: string; taskId: string; reason: string; after?: ThinkingCursor; limit?: number }): Promise<{ blocks?: ReadBlock[]; next?: ThinkingCursor; lookId: string; replayed: boolean }> };
  readonly thinkingRemoval?: ThinkingRemovalSource;
  /** The bounds on how much of a task one replay reads (a setting; off, or generous, by default). Absent: the generous defaults. */
  readonly limits?: { effective(): Promise<EffectiveReplayLimits> };
  /** Whether a context branch of the task by that name exists. Absent: no registry is known, and every line but `main` reads "unverified lane". */
  readonly branchKnown?: (taskId: string, lane: string) => Promise<boolean>;
}
type Reads = Pick<ActivityService, "steps" | "payload" | "explanations" | "explanationsPage" | "contentReadable">;

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isGap = (e: unknown): e is { seq: number; unavailable: string } => typeof e === "object" && e !== null && "unavailable" in e;

interface Scanned { readonly steps: Map<number, ActivityStepBody & { corrections: number }>; readonly gaps: Map<number, string>; readonly first: number; readonly last: number; readonly lastSeq: number; readonly limited: boolean; readonly canText: { readonly sensitive: boolean; readonly ordinary: boolean } }
interface Model { readonly lanes: Map<string, number[]>; readonly supersededBy: Map<number, number[]>; readonly verified: ReadonlyMap<string, boolean> }
/** "agent" for `agent:coder`, "service" for `service:reviews`, "owner" for the owner. */
const actorKind = (actor: string): string => actor.split(":")[0] ?? actor;
/** Whether `by` may replace `target`: the one who wrote it, the owner or a service; on the same line. A target outside the window is taken as replaceable by an authorised writer only. */
const replaceable = (target: { actor: string; branch?: string } | undefined, by: { actor: string; branch?: string }): boolean =>
  target !== undefined && (actorKind(by.actor) === "owner" || actorKind(by.actor) === "service" || target.actor === by.actor) && (target.branch ?? "main") === (by.branch ?? "main");

export class ReplayService {
  readonly #runner: CommandRunner;
  readonly #activity: Reads;
  readonly #deps: ReplayDeps;
  private constructor(runner: CommandRunner, activity: Reads, deps: ReplayDeps) { this.#runner = runner; this.#activity = activity; this.#deps = deps; }
  static withEpoch(storage: ControllerStorage, epoch: number, activity: Reads, deps: ReplayDeps = {}, options: RunnerOptions = {}): ReplayService { return new ReplayService(new CommandRunner(storage, epoch, options), activity, deps); }

  /**
   * Opens a task's replay: a summary first, then a window of steps from `from` (default: the newest steps the read bound allows). Filters (one line, one actor, one kind of step, a time span from `since` to `until`,
   * both included) narrow the window, not the summary; a gap has no known line, actor or time, so it is listed only in an unfiltered window. Reads only.
   */
  async open(by: Principal, taskId: string, window: { from?: number; limit?: number; lane?: string; actor?: string; kind?: string; since?: string; until?: string; withContent?: boolean } = {}): Promise<ReplayView> {
    const tid = checkTaskIdValue(taskId);
    const limit = window.limit === undefined ? REPLAY_LIMITS.defaultPage : Number.isSafeInteger(window.limit) && window.limit >= 1 && window.limit <= REPLAY_LIMITS.page ? window.limit : invalid("limit", `must be 1 to ${REPLAY_LIMITS.page}`);
    const from = window.from === undefined ? undefined : Number.isSafeInteger(window.from) && window.from >= 1 ? window.from : invalid("from", "must be a step number, from 1");
    const sinceMs = filterTime(window.since, "since"); const untilMs = filterTime(window.until, "until");
    if (sinceMs !== undefined && untilMs !== undefined && sinceMs > untilMs) invalid("since", "must not be after until");
    // A kind that no step can have is a mistake to say, not an empty window to show.
    if (window.kind !== undefined && !(ACTIVITY_KINDS as readonly unknown[]).includes(window.kind)) invalid("kind", `must be one of ${ACTIVITY_KINDS.join(", ")}`);
    const filtered = window.lane !== undefined || window.actor !== undefined || window.kind !== undefined || sinceMs !== undefined || untilMs !== undefined;
    const task = await this.#task(tid);
    const scanned = await this.#scan(by, tid, from === undefined ? {} : { from });
    const model = await this.#model(tid, scanned);
    const entries: ReplayEntry[] = [];
    let next: number | undefined;
    for (let seq = Math.max(from ?? scanned.first, scanned.first); seq <= scanned.last; seq++) {
      const gap = scanned.gaps.get(seq);
      const step = scanned.steps.get(seq);
      const shown = gap !== undefined ? (filtered ? undefined : { seq, unavailable: gap }) : step === undefined ? undefined : this.#view(step, model, scanned);
      if (shown === undefined) continue;
      if (!isGap(shown) && ((window.lane !== undefined && shown.lane !== window.lane) || (window.actor !== undefined && shown.actor !== window.actor) || (window.kind !== undefined && shown.kind !== window.kind)
        || (sinceMs !== undefined && Date.parse(shown.at) < sinceMs) || (untilMs !== undefined && Date.parse(shown.at) > untilMs))) continue;
      if (entries.length >= limit) { next = seq; break; }
      entries.push(!isGap(shown) && window.withContent === true ? { ...shown, content: await this.#content(by, tid, shown.content, seq) } : shown);
    }
    // The window ended before the record did: the next step to show is the one after it.
    if (next === undefined && scanned.last < scanned.lastSeq) next = scanned.last + 1;
    return {
      taskId: tid, projectId: task.projectId, summary: this.#summary(scanned, model), entries, ...(next === undefined ? {} : { next }),
      ...(model.lanes.size > 1 ? { note: REPLAY_LABELS.concurrent } : {}),
    };
  }

  /** One step in full: the step, its explanations (written at the time and asked for afterwards, apart), and the state of the model's thinking for the owner. */
  async step(by: Principal, taskId: string, seq: number, options: { withContent?: boolean } = {}): Promise<ReplayDetail> {
    const tid = checkTaskIdValue(taskId);
    if (!Number.isSafeInteger(seq) || seq < 1) invalid("seq", "must be a step number");
    const task = await this.#task(tid);
    const limits = await this.#limits();
    // The step is placed from a window around it, so a step anywhere in a long record is found.
    const scanned = await this.#scan(by, tid, { around: seq });
    if (scanned.gaps.has(seq)) throw new DomainError("not_found", `step ${seq} is unavailable: ${scanned.gaps.get(seq)}`, { field: "seq" });
    const found = scanned.steps.get(seq);
    if (found === undefined) throw new DomainError("not_found", `no step ${seq} on that task`, { field: "seq" });
    const step = this.#view(found, await this.#model(tid, scanned), scanned);
    const contemporaneous = await this.#activity.explanations(by, tid, seq);
    const retrospective: ExplanationBody[] = [];
    let truncated = false;
    for (let after = 0, pages = 0; ; pages++) {
      if (limits.stepPages !== null && pages >= limits.stepPages) { truncated = true; break; }
      const got = await this.#activity.explanationsPage(by, tid, undefined, after, 100);
      for (const e of got.items) if (e.mode === "retrospective" && e.seq === seq) retrospective.push(e);
      if (got.next === undefined) break;
      after = got.next;
    }
    const thinking = await this.#thinkingState(by, task.projectId, tid);
    return {
      step: options.withContent === true ? { ...step, content: await this.#content(by, tid, step.content, seq) } : step,
      explanations: { contemporaneous: { label: REPLAY_LABELS.contemporaneous, items: contemporaneous }, retrospective: { label: REPLAY_LABELS.retrospective, items: retrospective } },
      ...(thinking === undefined ? {} : { thinking }),
      ...(scanned.limited ? { window: { first: scanned.first, last: scanned.last, of: scanned.lastSeq, note: REPLAY_LABELS.windowed } } : {}),
      ...(truncated ? { retrospectiveTruncated: true } : {}),
    };
  }

  /**
   * "What evidence and instruction led to this change?" answered with links: the context the step was given, the evidence written at the time, the nearest earlier instructions, messages and approvals on its lane, what it replaces, and,
   * for a step on a side line, the owner's instructions on the main line (a side line named by whoever recorded the step is not a reason to lose them).
   */
  async led(by: Principal, taskId: string, seq: number): Promise<{ seq: number; links: readonly ReplayLink[]; grounded: boolean; note: string; scanLimited?: boolean }> {
    const tid = checkTaskIdValue(taskId);
    if (!Number.isSafeInteger(seq) || seq < 1) invalid("seq", "must be a step number");
    const scanned = await this.#scan(by, tid, { around: seq });
    if (scanned.gaps.has(seq)) throw new DomainError("not_found", `step ${seq} is unavailable: ${scanned.gaps.get(seq)}`, { field: "seq" });
    const found = scanned.steps.get(seq);
    if (found === undefined) throw new DomainError("not_found", `no step ${seq} on that task`, { field: "seq" });
    const links: ReplayLink[] = [];
    if (!found.manifest.missing) for (const r of found.manifest.refs) links.push({ relation: "context", kind: r.kind, id: r.id, ...(r.version === undefined ? {} : { version: r.version }) });
    for (const e of await this.#activity.explanations(by, tid, seq)) for (const ev of e.evidence) links.push({ relation: "evidence", note: ev.statement, ...(ev.ref === undefined ? {} : { kind: ev.ref.kind, id: ev.ref.id, ...(ev.ref.version === undefined ? {} : { version: ev.ref.version }) }) });
    const lane = found.branch ?? "main";
    const leading: ActivityKind[] = ["instruction", "owner-message", "agent-message", "source-retrieved", "approval"];
    let taken = 0;
    for (let s = seq - 1; s >= scanned.first && taken < REPLAY_LIMITS.evidence; s--) {
      const earlier = scanned.steps.get(s);
      if (earlier === undefined || (earlier.branch ?? "main") !== lane || !leading.includes(earlier.kind)) continue;
      links.push({ relation: "earlier-step", seq: s, note: `${earlier.kind}: ${earlier.summary}` });
      taken++;
    }
    if (lane !== "main") {
      let owned = 0;
      for (let s = seq - 1; s >= scanned.first && owned < REPLAY_LIMITS.evidence; s--) {
        const earlier = scanned.steps.get(s);
        if (earlier === undefined || (earlier.branch ?? "main") !== "main" || actorKind(earlier.actor) !== "owner" || (earlier.kind !== "instruction" && earlier.kind !== "owner-message")) continue;
        links.push({ relation: "earlier-step", seq: s, note: `main line, ${earlier.kind} by the owner: ${earlier.summary}` });
        owned++;
      }
    }
    if (found.supersedes !== undefined) links.push({ relation: "supersedes", seq: found.supersedes });
    return { seq, links, grounded: links.length > 0, note: links.length > 0 ? "Links to what the records show the step was given; they are not a statement of why." : REPLAY_LABELS.unexplained, ...(scanned.first > 1 ? { scanLimited: true } : {}) };
  }

  /** Finds steps of a task whose summary contains the words (case ignored). Summaries were redacted when recorded; stored content is not searched. The same task checks apply. */
  async search(by: Principal, taskId: string, query: string, options: { limit?: number } = {}): Promise<{ matches: readonly ReplayStep[]; scanLimited: boolean; range: { first: number; last: number; of: number } }> {
    const tid = checkTaskIdValue(taskId);
    if (typeof query !== "string" || query.trim().length < 1 || query.length > 200) invalid("query", "must be 1 to 200 characters");
    const limit = options.limit === undefined ? 20 : Number.isSafeInteger(options.limit) && options.limit >= 1 && options.limit <= REPLAY_LIMITS.search ? options.limit : invalid("limit", `must be 1 to ${REPLAY_LIMITS.search}`);
    const scanned = await this.#scan(by, tid);
    const model = await this.#model(tid, scanned);
    const needle = query.trim().toLowerCase();
    const matches: ReplayStep[] = [];
    for (const [, s] of [...scanned.steps].sort((a, b) => a[0] - b[0])) {
      if (!s.summary.toLowerCase().includes(needle)) continue;
      matches.push(this.#view(s, model, scanned));
      if (matches.length >= limit) break;
    }
    return { matches, scanLimited: scanned.limited, range: { first: scanned.first, last: scanned.last, of: scanned.lastSeq } };
  }

  /** The whole replay as data to save: every step as in the view, gaps marked, explanations by kind with their labels. Stored content and the model's thinking are never in it. A bound that cut it short is flagged. */
  async export(by: Principal, taskId: string): Promise<{ format: "nimblenewt-replay/1"; exportedAt: string; taskId: string; projectId: string; summary: ReplaySummary; entries: readonly ReplayEntry[]; truncated: { entries: boolean; explanations: boolean }; explanations: { contemporaneous: { label: string; items: readonly ExplanationBody[] }; retrospective: { label: string; items: readonly ExplanationBody[] } }; content: "not included"; thinking: "not included" }> {
    const tid = checkTaskIdValue(taskId);
    const task = await this.#task(tid);
    const limits = await this.#limits();
    const scanned = await this.#scan(by, tid, { from: 1 });
    const model = await this.#model(tid, scanned);
    const entries: ReplayEntry[] = [];
    for (let seq = scanned.first; seq <= scanned.last; seq++) {
      const gap = scanned.gaps.get(seq); const step = scanned.steps.get(seq);
      if (gap !== undefined) entries.push({ seq, unavailable: gap }); else if (step !== undefined) entries.push(this.#view(step, model, scanned));
    }
    const contemporaneous: ExplanationBody[] = []; const retrospective: ExplanationBody[] = [];
    let cut = false;
    for (let after = 0, pages = 0; ; pages++) {
      if (limits.exportPages !== null && pages >= limits.exportPages) { cut = true; break; }
      const got = await this.#activity.explanationsPage(by, tid, undefined, after, 100);
      for (const e of got.items) (e.mode === "retrospective" ? retrospective : contemporaneous).push(e);
      if (got.next === undefined) break;
      after = got.next;
    }
    return {
      format: "nimblenewt-replay/1", exportedAt: this.#runner.now(), taskId: tid, projectId: task.projectId, summary: this.#summary(scanned, model), entries, truncated: { entries: scanned.limited, explanations: cut },
      explanations: { contemporaneous: { label: REPLAY_LABELS.contemporaneous, items: contemporaneous }, retrospective: { label: REPLAY_LABELS.retrospective, items: retrospective } }, content: "not included", thinking: "not included",
    };
  }

  /**
   * The owner expands the model's thinking for a task: an explicit, recorded look (card C06b), collapsed by default in every view and shown labelled as model output. After retention removed it, the answer is
   * that it was removed and nothing else. Anyone but the owner is told there is none. Where the thinking store or the retention marker is not part of this controller, the owner is told it is unavailable (not wired),
   * which is not the same as there being none.
   */
  async thinking(by: Principal, command: { commandId: string; taskId: string; reason: string; after?: ThinkingCursor; limit?: number }): Promise<{ collapsed: true; label: string; state: "stored"; blocks: readonly ReadBlock[]; next?: ThinkingCursor; lookId: string } | { collapsed: true; state: "removed-by-retention"; removedAt: string; label: string } | { collapsed: true; state: "unavailable"; label: string }> {
    const taskId = checkTaskIdValue(command.taskId);
    if (by.kind !== "owner") throw new DomainError("not_found", "no stored thinking for that task");
    const task = await this.#task(taskId);
    const thinking = this.#deps.thinking;
    if (thinking === undefined || this.#deps.thinkingRemoval === undefined) return { collapsed: true, state: "unavailable", label: REPLAY_LABELS.thinkingUnavailable };
    const removed = await this.#deps.thinkingRemoval.removedAt({ projectId: task.projectId, taskId });
    if (removed !== undefined) return { collapsed: true, state: "removed-by-retention", removedAt: removed, label: REPLAY_LABELS.thinkingRemoved };
    const got = await thinking.read(by, { commandId: command.commandId, projectId: task.projectId, taskId, reason: command.reason, ...(command.after === undefined ? {} : { after: command.after }), ...(command.limit === undefined ? {} : { limit: command.limit }) });
    return { collapsed: true, label: REPLAY_LABELS.thinking, state: "stored", blocks: got.blocks ?? [], ...(got.next === undefined ? {} : { next: got.next }), lookId: got.lookId };
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  async #task(taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", "no such task");
    return task;
  }

  async #limits(): Promise<EffectiveReplayLimits> { return this.#deps.limits === undefined ? REPLAY_LIMIT_DEFAULTS : this.#deps.limits.effective(); }

  /**
   * Reads a window of the task's steps by step number (never a page count). By default the window is the newest steps the read bound allows (all of them when the bound is off or not reached); `from` starts it at that step;
   * `around` makes it include that step with room before it. A step is therefore found wherever it is in a long record, and a window that is not the whole record says so (`limited`).
   */
  async #scan(by: Principal, taskId: string, anchor: { from?: number; around?: number } = {}): Promise<Scanned> {
    const steps = new Map<number, ActivityStepBody & { corrections: number }>(); const gaps = new Map<number, string>();
    const canText = { sensitive: await this.#activity.contentReadable(by, taskId, true), ordinary: await this.#activity.contentReadable(by, taskId, false) };
    const cap = (await this.#limits()).scan;
    const tail = await this.#activity.steps(by, taskId, { tail: true, limit: 1 });
    const lastSeq = tail.steps.length === 0 ? 0 : tail.steps[tail.steps.length - 1]!.seq;
    if (lastSeq === 0) return { steps, gaps, first: 1, last: 0, lastSeq: 0, limited: false, canText };
    const span = cap ?? lastSeq;
    let first = Math.max(1, lastSeq - span + 1);
    if (anchor.from !== undefined) first = anchor.from;
    else if (anchor.around !== undefined && anchor.around < first) first = Math.max(1, anchor.around - Math.floor(span / 2));
    const last = Math.min(lastSeq, first + span - 1);
    for (let after = first - 1; after < last;) {
      const got = await this.#activity.steps(by, taskId, { after, limit: Math.min(100, last - after) });
      if (got.steps.length === 0) break;
      for (const s of got.steps) { if (s.seq > last) continue; if (isGap(s)) gaps.set(s.seq, s.unavailable); else steps.set(s.seq, s as ActivityStepBody & { corrections: number }); }
      after = got.steps[got.steps.length - 1]!.seq;
    }
    return { steps, gaps, first, last, lastSeq, limited: first > 1 || last < lastSeq, canText };
  }

  async #model(taskId: string, scanned: Scanned): Promise<Model> {
    const lanes = new Map<string, number[]>(); const supersededBy = new Map<number, number[]>();
    for (const [seq, s] of [...scanned.steps].sort((a, b) => a[0] - b[0])) {
      const lane = s.branch ?? "main";
      lanes.set(lane, [...(lanes.get(lane) ?? []), seq]);
      // The same authority as when a step is recorded (only its writer, the owner or a service may replace a step, and only on its own line): an older record, or one written some other way, that claims otherwise does not retire the step.
      if (s.supersedes !== undefined && replaceable(scanned.steps.get(s.supersedes), s)) supersededBy.set(s.supersedes, [...(supersededBy.get(s.supersedes) ?? []), seq]);
    }
    // A line is "verified" only when a registry of the task's context branches knows it; without one, no line is.
    const verified = new Map<string, boolean>();
    for (const lane of lanes.keys()) if (lane !== "main") verified.set(lane, this.#deps.branchKnown === undefined ? false : await this.#deps.branchKnown(taskId, lane));
    return { lanes, supersededBy, verified };
  }

  #view(s: ActivityStepBody & { corrections: number }, model: Model, scanned: Scanned): ReplayStep {
    const lane = s.branch ?? "main";
    const inLane = model.lanes.get(lane) ?? [];
    const at = inLane.indexOf(s.seq);
    const by = model.supersededBy.get(s.seq);
    const kind = actorKind(s.actor);
    const links: ReplayLink[] = [];
    if (!s.manifest.missing) for (const r of s.manifest.refs) links.push({ relation: "context", kind: r.kind, id: r.id, ...(r.version === undefined ? {} : { version: r.version }) });
    if (s.supersedes !== undefined) links.push({ relation: "supersedes", seq: s.supersedes });
    for (const n of by ?? []) links.push({ relation: "superseded-by", seq: n });
    const laneStatus = lane === "main" ? "main" : kind === "service" ? "controller" : model.verified.get(lane) === true ? "verified" : "unverified";
    const readable = s.payload.state === "stored" && (s.payload.sensitive ? scanned.canText.sensitive : scanned.canText.ordinary);
    return {
      seq: s.seq, at: s.at, actor: s.actor, kind: s.kind, summary: s.summary, lane, laneStatus, ...(laneStatus === "unverified" ? { laneNote: REPLAY_LABELS.unverifiedLane } : {}),
      outcome: s.outcome ?? "not-recorded", ...(s.outcome !== undefined && kind !== "service" ? { outcomeNote: `reported by ${kind}` } : {}),
      versionsThen: s.manifest.missing ? { state: "not-recorded", reason: s.manifest.reason } : { state: "recorded", refs: s.manifest.refs, ...(s.manifest.summaryId === undefined ? {} : { summaryId: s.manifest.summaryId }) },
      authority: by === undefined ? "current" : "superseded",
      ...(by === undefined && scanned.last < scanned.lastSeq ? { authorityNote: REPLAY_LABELS.supersederUnread } : {}),
      ...(s.supersedes === undefined ? {} : { supersedes: s.supersedes }), ...(by === undefined ? {} : { supersededBy: by }),
      content: s.payload.state === "none" ? { state: "none" } : s.payload.state === "missing" ? { state: "missing", reason: s.payload.reason } : { state: "stored", sensitive: s.payload.sensitive, ...(readable ? { chars: s.payload.chars, redactions: s.payload.redactions } : {}) },
      corrections: s.corrections,
      ...(at > 0 ? { previousInLane: inLane[at - 1]! } : {}), ...(at >= 0 && at < inLane.length - 1 ? { nextInLane: inLane[at + 1]! } : {}),
      links,
    };
  }

  #summary(scanned: Scanned, model: Model): ReplaySummary {
    const byKind: Record<string, number> = {}; const byOutcome: Record<string, number> = {}; const agents = new Map<string, number>();
    let redactedSteps = 0; let stepsWithoutManifest = 0; let corrected = 0;
    for (const s of scanned.steps.values()) {
      byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
      byOutcome[s.outcome ?? "not-recorded"] = (byOutcome[s.outcome ?? "not-recorded"] ?? 0) + 1;
      agents.set(s.actor, (agents.get(s.actor) ?? 0) + 1);
      if (s.payload.state === "stored" && s.payload.redactions > 0 && (s.payload.sensitive ? scanned.canText.sensitive : scanned.canText.ordinary)) redactedSteps++;
      if (s.manifest.missing) stepsWithoutManifest++;
      if (s.corrections > 0) corrected++;
    }
    return {
      total: scanned.steps.size + scanned.gaps.size, scanLimited: scanned.limited, range: { first: scanned.first, last: scanned.last, of: scanned.lastSeq }, byKind, byOutcome,
      lanes: [...model.lanes].map(([lane, seqs]) => ({ lane, steps: seqs.length })),
      agents: [...agents].map(([actor, steps]) => ({ actor, steps })).sort((a, b) => b.steps - a.steps || (a.actor < b.actor ? -1 : 1)),
      unavailable: [...scanned.gaps].map(([seq, reason]) => ({ seq, reason })).sort((a, b) => a.seq - b.seq),
      redactedSteps, stepsWithoutManifest, superseded: model.supersededBy.size, corrected,
    };
  }

  /** Content is read only when asked for, through the activity read that checks the history right; refused content is reported as not readable, never as empty. Text is redacted again on its way out. */
  async #content(by: Principal, taskId: string, content: ReplayContent, seq: number): Promise<ReplayContent> {
    if (content.state !== "stored") return content;
    try {
      const got = await this.#activity.payload(by, taskId, seq);
      return got === undefined ? { ...content, readable: false } : { ...content, readable: true, chars: got.text.length, redactions: got.redactions, text: redactText(got.text) };
    } catch (error) {
      if (error instanceof DomainError && (error.code === "not_found" || error.code === "forbidden")) return { ...content, readable: false };
      throw error;
    }
  }

  async #thinkingState(by: Principal, projectId: string, taskId: string): Promise<ReplayThinkingState | undefined> {
    if (by.kind !== "owner") return undefined;
    if (this.#deps.thinking === undefined || this.#deps.thinkingRemoval === undefined) return { state: "unavailable", label: REPLAY_LABELS.thinkingUnavailable };
    const removed = await this.#deps.thinkingRemoval.removedAt({ projectId, taskId });
    return removed === undefined ? { state: "not-removed", note: "The model's thinking, where the provider returned it, is collapsed; ask to expand it. It is model output, not an explanation." } : { state: "removed-by-retention", removedAt: removed, label: REPLAY_LABELS.thinkingRemoved };
  }
}
