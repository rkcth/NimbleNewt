import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { taskId as checkTaskIdValue, type TaskBody } from "../domain/model.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { ControllerStorage } from "../storage/types.js";
import type { ReadBlock, ThinkingCursor } from "../context/thinking.js";
import type { ActivityKind, ActivityService, ActivityStepBody, ExplanationBody, ManifestRef, StepOutcome } from "./activity.js";

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

export const REPLAY_LIMITS = { scan: 1000, page: 50, defaultPage: 20, search: 50, evidence: 5, retroPages: 5 } as const;
/** The words a view shows next to these, so no screen has to invent them. */
export const REPLAY_LABELS = {
  concurrent: "Steps on different branches happened side by side. Their numbers show the order they were recorded, not that one came before another.",
  thinking: "Model output. This is what the model produced while working; it is not an explanation of any decision, and it may be wrong or incomplete.",
  thinkingRemoved: "The model's thinking for this task was removed by retention. Nothing else about the record changes.",
  contemporaneous: "Written at the time by the one who chose.",
  retrospective: "Asked for afterwards and built only from the records; not what was in anyone's mind.",
  superseded: "Replaced by a later step; kept for the record and no longer authoritative.",
  notRecorded: "not recorded",
  unexplained: "The records do not show what led to this step.",
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
  | { readonly state: "stored"; readonly chars: number; readonly redactions: number; readonly sensitive: boolean; /** Present only when asked for and allowed. */ readonly text?: string; readonly readable?: boolean };
export interface ReplayStep {
  readonly seq: number; readonly at: string; readonly actor: string; readonly kind: ActivityKind; readonly summary: string;
  readonly lane: string;
  readonly outcome: ReplayOutcome;
  /** The context supplied at the step, as recorded then. */
  readonly versionsThen: { readonly state: "recorded"; readonly refs: readonly ManifestRef[]; readonly summaryId?: string } | { readonly state: "not-recorded"; readonly reason: string };
  readonly authority: "current" | "superseded";
  readonly supersedes?: number; readonly supersededBy?: readonly number[];
  readonly content: ReplayContent;
  readonly corrections: number;
  readonly previousInLane?: number; readonly nextInLane?: number;
  readonly links: readonly ReplayLink[];
}
export interface ReplayGap { readonly seq: number; readonly unavailable: string }
export type ReplayEntry = ReplayStep | ReplayGap;

export interface ReplaySummary {
  /** Steps counted (up to the scan limit). */
  readonly total: number; readonly scanLimited: boolean;
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
  /** Pass as `from` for the next window. */
  readonly next?: number;
  readonly note?: string;
}
export interface ReplayDetail {
  readonly step: ReplayStep;
  readonly explanations: { readonly contemporaneous: { readonly label: string; readonly items: readonly ExplanationBody[] }; readonly retrospective: { readonly label: string; readonly items: readonly ExplanationBody[] } };
  readonly thinking?: ReplayThinkingState;
}
export type ReplayThinkingState = { readonly state: "removed-by-retention"; readonly removedAt: string; readonly label: string } | { readonly state: "not-removed"; readonly note: string };

export interface ThinkingRemovalSource { /** When retention removed the task's stored thinking, if it did. */ removedAt(task: { readonly projectId: string; readonly taskId: string }): Promise<string | undefined> }
export interface ReplayDeps {
  /** The owner's explicit look at stored thinking (a recorded look); without it, thinking is not offered. */
  readonly thinking?: { read(by: Principal, command: { commandId: string; projectId: string; taskId: string; reason: string; after?: ThinkingCursor; limit?: number }): Promise<{ blocks?: ReadBlock[]; next?: ThinkingCursor; lookId: string; replayed: boolean }> };
  readonly thinkingRemoval?: ThinkingRemovalSource;
}
type Reads = Pick<ActivityService, "steps" | "payload" | "explanations" | "explanationsPage">;

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isGap = (e: unknown): e is { seq: number; unavailable: string } => typeof e === "object" && e !== null && "unavailable" in e;

interface Scanned { readonly steps: Map<number, ActivityStepBody & { corrections: number }>; readonly gaps: Map<number, string>; readonly last: number; readonly limited: boolean }

export class ReplayService {
  readonly #runner: CommandRunner;
  readonly #activity: Reads;
  readonly #deps: ReplayDeps;
  private constructor(runner: CommandRunner, activity: Reads, deps: ReplayDeps) { this.#runner = runner; this.#activity = activity; this.#deps = deps; }
  static withEpoch(storage: ControllerStorage, epoch: number, activity: Reads, deps: ReplayDeps = {}, options: RunnerOptions = {}): ReplayService { return new ReplayService(new CommandRunner(storage, epoch, options), activity, deps); }

  /** Opens a task's replay: a summary first, then a window of steps from `from` (default the start). Filters narrow the window, not the summary. Reads only. */
  async open(by: Principal, taskId: string, window: { from?: number; limit?: number; lane?: string; actor?: string; kind?: string; withContent?: boolean } = {}): Promise<ReplayView> {
    const tid = checkTaskIdValue(taskId);
    const limit = window.limit === undefined ? REPLAY_LIMITS.defaultPage : Number.isSafeInteger(window.limit) && window.limit >= 1 && window.limit <= REPLAY_LIMITS.page ? window.limit : invalid("limit", `must be 1 to ${REPLAY_LIMITS.page}`);
    const from = window.from === undefined ? 1 : Number.isSafeInteger(window.from) && window.from >= 1 ? window.from : invalid("from", "must be a step number, from 1");
    const task = await this.#task(tid);
    const scanned = await this.#scan(by, tid);
    const model = this.#model(scanned);
    const entries: ReplayEntry[] = [];
    let next: number | undefined;
    for (let seq = from; seq <= scanned.last; seq++) {
      const gap = scanned.gaps.get(seq);
      const step = scanned.steps.get(seq);
      const shown = gap !== undefined ? (window.lane === undefined && window.actor === undefined && window.kind === undefined ? { seq, unavailable: gap } : undefined) : step === undefined ? undefined : this.#view(step, model);
      if (shown === undefined) continue;
      if (!isGap(shown) && ((window.lane !== undefined && shown.lane !== window.lane) || (window.actor !== undefined && shown.actor !== window.actor) || (window.kind !== undefined && shown.kind !== window.kind))) continue;
      if (entries.length >= limit) { next = entries[entries.length - 1]!.seq; break; }
      entries.push(!isGap(shown) && window.withContent === true ? { ...shown, content: await this.#content(by, tid, shown.content, seq) } : shown);
    }
    const lanes = model.lanes;
    return {
      taskId: tid, projectId: task.projectId, summary: this.#summary(scanned, model), entries, ...(next === undefined ? {} : { next }),
      ...(lanes.size > 1 ? { note: REPLAY_LABELS.concurrent } : {}),
    };
  }

  /** One step in full: the step, its explanations (written at the time and asked for afterwards, apart), and the state of the model's thinking for the owner. */
  async step(by: Principal, taskId: string, seq: number, options: { withContent?: boolean } = {}): Promise<ReplayDetail> {
    const tid = checkTaskIdValue(taskId);
    if (!Number.isSafeInteger(seq) || seq < 1) invalid("seq", "must be a step number");
    const task = await this.#task(tid);
    const scanned = await this.#scan(by, tid);
    if (scanned.gaps.has(seq)) throw new DomainError("not_found", `step ${seq} is unavailable: ${scanned.gaps.get(seq)}`, { field: "seq" });
    const found = scanned.steps.get(seq);
    if (found === undefined) throw new DomainError("not_found", `no step ${seq} on that task`, { field: "seq" });
    const step = this.#view(found, this.#model(scanned));
    const contemporaneous = await this.#activity.explanations(by, tid, seq);
    const retrospective: ExplanationBody[] = [];
    for (let after = 0, pages = 0; pages < REPLAY_LIMITS.retroPages; pages++) {
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
    };
  }

  /** "What evidence and instruction led to this change?" answered with links: the context the step was given, the evidence written at the time, the nearest earlier instructions, messages and approvals on its lane, and what it replaces. */
  async led(by: Principal, taskId: string, seq: number): Promise<{ seq: number; links: readonly ReplayLink[]; grounded: boolean; note: string }> {
    const tid = checkTaskIdValue(taskId);
    const scanned = await this.#scan(by, tid);
    if (scanned.gaps.has(seq)) throw new DomainError("not_found", `step ${seq} is unavailable: ${scanned.gaps.get(seq)}`, { field: "seq" });
    const found = scanned.steps.get(seq);
    if (found === undefined) throw new DomainError("not_found", `no step ${seq} on that task`, { field: "seq" });
    const links: ReplayLink[] = [];
    if (!found.manifest.missing) for (const r of found.manifest.refs) links.push({ relation: "context", kind: r.kind, id: r.id, ...(r.version === undefined ? {} : { version: r.version }) });
    for (const e of await this.#activity.explanations(by, tid, seq)) for (const ev of e.evidence) links.push({ relation: "evidence", note: ev.statement, ...(ev.ref === undefined ? {} : { kind: ev.ref.kind, id: ev.ref.id, ...(ev.ref.version === undefined ? {} : { version: ev.ref.version }) }) });
    const lane = found.branch ?? "main";
    const leading: ActivityKind[] = ["instruction", "owner-message", "agent-message", "source-retrieved", "approval"];
    let taken = 0;
    for (let s = seq - 1; s >= 1 && taken < REPLAY_LIMITS.evidence; s--) {
      const earlier = scanned.steps.get(s);
      if (earlier === undefined || (earlier.branch ?? "main") !== lane || !leading.includes(earlier.kind)) continue;
      links.push({ relation: "earlier-step", seq: s, note: `${earlier.kind}: ${earlier.summary}` });
      taken++;
    }
    if (found.supersedes !== undefined) links.push({ relation: "supersedes", seq: found.supersedes });
    return { seq, links, grounded: links.length > 0, note: links.length > 0 ? "Links to what the records show the step was given; they are not a statement of why." : REPLAY_LABELS.unexplained };
  }

  /** Finds steps of a task whose summary contains the words (case ignored). Summaries were redacted when recorded; stored content is not searched. The same task checks apply. */
  async search(by: Principal, taskId: string, query: string, options: { limit?: number } = {}): Promise<{ matches: readonly ReplayStep[]; scanLimited: boolean }> {
    const tid = checkTaskIdValue(taskId);
    if (typeof query !== "string" || query.trim().length < 1 || query.length > 200) invalid("query", "must be 1 to 200 characters");
    const limit = options.limit === undefined ? 20 : Number.isSafeInteger(options.limit) && options.limit >= 1 && options.limit <= REPLAY_LIMITS.search ? options.limit : invalid("limit", `must be 1 to ${REPLAY_LIMITS.search}`);
    const scanned = await this.#scan(by, tid);
    const model = this.#model(scanned);
    const needle = query.trim().toLowerCase();
    const matches: ReplayStep[] = [];
    for (const [, s] of [...scanned.steps].sort((a, b) => a[0] - b[0])) {
      if (!s.summary.toLowerCase().includes(needle)) continue;
      matches.push(this.#view(s, model));
      if (matches.length >= limit) break;
    }
    return { matches, scanLimited: scanned.limited };
  }

  /** The whole replay as data to save: every step as in the view, gaps marked, explanations by kind. Stored content and the model's thinking are never in it. */
  async export(by: Principal, taskId: string): Promise<{ format: "nimblenewt-replay/1"; exportedAt: string; taskId: string; projectId: string; summary: ReplaySummary; entries: readonly ReplayEntry[]; explanations: { contemporaneous: readonly ExplanationBody[]; retrospective: readonly ExplanationBody[] }; content: "not included"; thinking: "not included" }> {
    const tid = checkTaskIdValue(taskId);
    const task = await this.#task(tid);
    const scanned = await this.#scan(by, tid);
    const model = this.#model(scanned);
    const entries: ReplayEntry[] = [];
    for (let seq = 1; seq <= scanned.last; seq++) {
      const gap = scanned.gaps.get(seq); const step = scanned.steps.get(seq);
      if (gap !== undefined) entries.push({ seq, unavailable: gap }); else if (step !== undefined) entries.push(this.#view(step, model));
    }
    const contemporaneous: ExplanationBody[] = []; const retrospective: ExplanationBody[] = [];
    for (let after = 0, pages = 0; pages < 20; pages++) {
      const got = await this.#activity.explanationsPage(by, tid, undefined, after, 100);
      for (const e of got.items) (e.mode === "retrospective" ? retrospective : contemporaneous).push(e);
      if (got.next === undefined) break;
      after = got.next;
    }
    return { format: "nimblenewt-replay/1", exportedAt: this.#runner.now(), taskId: tid, projectId: task.projectId, summary: this.#summary(scanned, model), entries, explanations: { contemporaneous, retrospective }, content: "not included", thinking: "not included" };
  }

  /**
   * The owner expands the model's thinking for a task: an explicit, recorded look (card C06b), collapsed by default in every view and shown labelled as model output. After retention removed it, the answer is
   * that it was removed and nothing else. Anyone but the owner is told there is none.
   */
  async thinking(by: Principal, command: { commandId: string; taskId: string; reason: string; after?: ThinkingCursor; limit?: number }): Promise<{ collapsed: true; label: string; state: "stored"; blocks: readonly ReadBlock[]; next?: ThinkingCursor; lookId: string } | { collapsed: true; state: "removed-by-retention"; removedAt: string; label: string }> {
    const taskId = checkTaskIdValue(command.taskId);
    if (by.kind !== "owner" || this.#deps.thinking === undefined) throw new DomainError("not_found", "no stored thinking for that task");
    const task = await this.#task(taskId);
    const removed = await this.#deps.thinkingRemoval?.removedAt({ projectId: task.projectId, taskId });
    if (removed !== undefined) return { collapsed: true, state: "removed-by-retention", removedAt: removed, label: REPLAY_LABELS.thinkingRemoved };
    const got = await this.#deps.thinking.read(by, { commandId: command.commandId, projectId: task.projectId, taskId, reason: command.reason, ...(command.after === undefined ? {} : { after: command.after }), ...(command.limit === undefined ? {} : { limit: command.limit }) });
    return { collapsed: true, label: REPLAY_LABELS.thinking, state: "stored", blocks: got.blocks ?? [], ...(got.next === undefined ? {} : { next: got.next }), lookId: got.lookId };
  }

  // ---- internals -----------------------------------------------------------------------------------------------------------

  async #task(taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", "no such task");
    return task;
  }

  async #scan(by: Principal, taskId: string): Promise<Scanned> {
    const steps = new Map<number, ActivityStepBody & { corrections: number }>(); const gaps = new Map<number, string>();
    let after = 0; let last = 0; let limited = false;
    for (;;) {
      const got = await this.#activity.steps(by, taskId, { after, limit: 100 });
      for (const s of got.steps) {
        last = s.seq;
        if (isGap(s)) gaps.set(s.seq, s.unavailable); else steps.set(s.seq, s as ActivityStepBody & { corrections: number });
      }
      if (got.next === undefined) break;
      if (last >= REPLAY_LIMITS.scan) { limited = true; break; }
      after = got.next;
    }
    return { steps, gaps, last, limited };
  }

  #model(scanned: Scanned): { lanes: Map<string, number[]>; supersededBy: Map<number, number[]> } {
    const lanes = new Map<string, number[]>(); const supersededBy = new Map<number, number[]>();
    for (const [seq, s] of [...scanned.steps].sort((a, b) => a[0] - b[0])) {
      const lane = s.branch ?? "main";
      lanes.set(lane, [...(lanes.get(lane) ?? []), seq]);
      if (s.supersedes !== undefined) supersededBy.set(s.supersedes, [...(supersededBy.get(s.supersedes) ?? []), seq]);
    }
    return { lanes, supersededBy };
  }

  #view(s: ActivityStepBody & { corrections: number }, model: { lanes: Map<string, number[]>; supersededBy: Map<number, number[]> }): ReplayStep {
    const lane = s.branch ?? "main";
    const inLane = model.lanes.get(lane) ?? [];
    const at = inLane.indexOf(s.seq);
    const by = model.supersededBy.get(s.seq);
    const links: ReplayLink[] = [];
    if (!s.manifest.missing) for (const r of s.manifest.refs) links.push({ relation: "context", kind: r.kind, id: r.id, ...(r.version === undefined ? {} : { version: r.version }) });
    if (s.supersedes !== undefined) links.push({ relation: "supersedes", seq: s.supersedes });
    for (const n of by ?? []) links.push({ relation: "superseded-by", seq: n });
    return {
      seq: s.seq, at: s.at, actor: s.actor, kind: s.kind, summary: s.summary, lane,
      outcome: s.outcome ?? "not-recorded",
      versionsThen: s.manifest.missing ? { state: "not-recorded", reason: s.manifest.reason } : { state: "recorded", refs: s.manifest.refs, ...(s.manifest.summaryId === undefined ? {} : { summaryId: s.manifest.summaryId }) },
      authority: by === undefined ? "current" : "superseded",
      ...(s.supersedes === undefined ? {} : { supersedes: s.supersedes }), ...(by === undefined ? {} : { supersededBy: by }),
      content: s.payload.state === "none" ? { state: "none" } : s.payload.state === "missing" ? { state: "missing", reason: s.payload.reason } : { state: "stored", chars: s.payload.chars, redactions: s.payload.redactions, sensitive: s.payload.sensitive },
      corrections: s.corrections,
      ...(at > 0 ? { previousInLane: inLane[at - 1]! } : {}), ...(at >= 0 && at < inLane.length - 1 ? { nextInLane: inLane[at + 1]! } : {}),
      links,
    };
  }

  #summary(scanned: Scanned, model: { lanes: Map<string, number[]>; supersededBy: Map<number, number[]> }): ReplaySummary {
    const byKind: Record<string, number> = {}; const byOutcome: Record<string, number> = {}; const agents = new Map<string, number>();
    let redactedSteps = 0; let stepsWithoutManifest = 0; let corrected = 0;
    for (const s of scanned.steps.values()) {
      byKind[s.kind] = (byKind[s.kind] ?? 0) + 1;
      byOutcome[s.outcome ?? "not-recorded"] = (byOutcome[s.outcome ?? "not-recorded"] ?? 0) + 1;
      agents.set(s.actor, (agents.get(s.actor) ?? 0) + 1);
      if (s.payload.state === "stored" && s.payload.redactions > 0) redactedSteps++;
      if (s.manifest.missing) stepsWithoutManifest++;
      if (s.corrections > 0) corrected++;
    }
    return {
      total: scanned.steps.size + scanned.gaps.size, scanLimited: scanned.limited, byKind, byOutcome,
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
      return got === undefined ? { ...content, readable: false } : { ...content, readable: true, text: redactText(got.text) };
    } catch (error) {
      if (error instanceof DomainError && (error.code === "not_found" || error.code === "forbidden")) return { ...content, readable: false };
      throw error;
    }
  }

  async #thinkingState(by: Principal, projectId: string, taskId: string): Promise<ReplayThinkingState | undefined> {
    if (by.kind !== "owner" || this.#deps.thinking === undefined) return undefined;
    const removed = await this.#deps.thinkingRemoval?.removedAt({ projectId, taskId });
    return removed === undefined ? { state: "not-removed", note: "The model's thinking, where the provider returned it, is collapsed; ask to expand it. It is model output, not an explanation." } : { state: "removed-by-retention", removedAt: removed, label: REPLAY_LABELS.thinkingRemoved };
  }
}
