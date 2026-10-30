import { createHash } from "node:crypto";
import type { AssignmentService } from "../domain/assignments.js";
import type { ActivityBody, AssignmentBody, AttemptBody, GenerationBody } from "../domain/assignment-model.js";
import { defaultBasis, type BlockerBasis, type BlockerBody, type BlockerService, type BlockerType } from "../domain/blockers.js";
import { DomainError } from "../domain/errors.js";
import { taskEventId } from "../domain/events.js";
import { TASK_STATES, onlyKnown, projectId as checkProjectId, taskId as checkTaskId, type TaskBody, type TaskState, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { WaitBody, WaitService } from "../domain/waits.js";
import type { HandlingBody, WatchService } from "../events/handling.js";
import { DEFAULT_THRESHOLDS, type EvidenceBody } from "../health/assess.js";
import type { ConcernBody, StallService } from "../health/stall.js";
import { DEFAULT_HOST_STALE_AFTER_MS, hostFreshness, type Freshness } from "../hosts/hosts.js";
import type { TaskHandoffBody } from "../lifecycle/handoff.js";
import type { PauseService, PauseStatus } from "../lifecycle/pause.js";
import type { CallBody } from "../mcp/mcp.js";
import type { ContractBody, ContractService, DependencyBody, Difficulty } from "../planning/contracts.js";
import { canRead as deskCanRead, type DeskRecordBody } from "../context/desks.js";
import type { ActivityService, ExplanationBody } from "../activity/activity.js";
import type { ArtifactBody } from "../artifacts/service.js";
import { allows, inTaskScope } from "../security/access.js";
import type { Principal, PrincipalBody } from "../security/principals.js";
import type { Aggregate, ControllerStorage } from "../storage/types.js";
import {
  BASIS_WORDS, EXECUTION_STATES, executionOf, isOwnerOf, plainDuration, routeFor, shown, whoText,
  type Cite, type ExecutionFacts, type ExecutionState, type Line, type WorkObservation,
} from "./explain.js";

// ---- views ---------------------------------------------------------------------------------------------------------------------

export interface BlockerView {
  readonly id: string;
  /** The kind of obstacle in words; a hold opened by an agent is worded as that agent's hold, not as a person's. */
  readonly words: string;
  /** The details were left out because the reader may not see outside actions. */
  readonly masked: boolean;
  readonly revision: number;
  readonly type: BlockerType;
  /** What kind of obstacle it is: technical, an enforced permission, a policy conflict, a person's hold, or a preference. */
  readonly basis: BlockerBasis;
  readonly summary: string;
  readonly resolver: string;
  /** What has to happen and who can do it. */
  readonly route: string;
  readonly openedAt: string;
  readonly nextReviewAt?: string;
}

export type Pending =
  | { readonly kind: "dependency"; readonly prerequisiteId: string; readonly title: string; readonly state: TaskState; readonly willNotFinish: boolean; readonly responsible?: string }
  | { readonly kind: "hidden_dependency" }
  | { readonly kind: "dependency_check_incomplete" }
  | { readonly kind: "wait"; readonly waitId: string; readonly reason: string; readonly resolver: string; readonly summary: string; readonly nextAction: string; readonly deadline?: string; readonly onDeadline?: string; readonly indefiniteOwner?: string }
  | { readonly kind: "retry"; readonly what: "task_event_delivery" | "event_handling"; readonly id: string; readonly attempts: number; readonly nextAttemptAt?: string; readonly lastError?: string };

export interface TaskStatus {
  /** When this was read, by the controller's clock. Everything below is as of this moment. */
  readonly observedAt: string;
  readonly task: { readonly id: string; readonly projectId: string; readonly title: string; readonly state: TaskState; readonly revision: number; readonly updatedAt: string };
  /** `done` only when the task record says so; `done_with_open_doubts` when something that may not have finished is still open. Doing work, finishing an attempt or publishing a file never makes a task done. */
  readonly completion: "done" | "done_with_open_doubts" | "not_done" | "cancelled";
  /** The owner of record. Absent when the caller may not see assignments. */
  readonly owner?: { readonly kind: string; readonly id: string; readonly name?: string; readonly generation: number; readonly activeAttemptId?: string };
  readonly execution?: { readonly state: ExecutionState; readonly observation?: WorkObservation; readonly uncertainty: readonly string[] };
  readonly pending: readonly Pending[];
  readonly blockers: readonly BlockerView[];
  /** Preferences of a supervisor or team on an outcome the owner decided: shown, but never as a blocker. */
  readonly advice: readonly BlockerView[];
  readonly concerns: { readonly suspected: readonly { id: string; kind: string; detail: string }[]; readonly confirmed: readonly { id: string; kind: string; detail: string }[] };
  readonly pause?: { readonly paused: boolean; readonly gates: readonly { readonly scope: string; readonly since?: string; readonly by?: string; readonly observed?: string }[] };
  /** Parts of the answer the caller's permissions do not cover. */
  readonly withheld: readonly string[];
  /** The scan for open blockers did not finish: some blockers may be missing. */
  readonly partial: boolean;
  readonly lines: readonly Line[];
}

export interface OverviewRow {
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly state: TaskState;
  readonly owner?: { readonly kind: string; readonly id: string };
  readonly execution?: ExecutionState;
  /** When anything was last seen of the work, and how old that is. */
  readonly observation?: { readonly at: string; readonly ageMs: number; readonly freshness: Freshness };
  /** The sign of work is old, or an attempt is recorded as running with no sign at all. */
  readonly stale: boolean;
  readonly uncertain: readonly string[];
  readonly blockers: number;
  readonly advice: number;
  readonly waiting?: { readonly reason: string; readonly resolver: string; readonly deadline?: string };
  readonly paused: boolean;
  readonly cite: Cite;
}

export interface Overview {
  readonly observedAt: string;
  readonly items: readonly OverviewRow[];
  /** Parts of the answer the caller's permissions do not cover. */
  readonly withheld: readonly string[];
  readonly counts: { readonly byState: Readonly<Record<string, number>>; readonly stale: number; readonly uncertain: number; readonly blocked: number };
  /** Where to continue. Present whenever the scan stopped before the end of the tasks (the page was full, or the scan budget ran out). */
  readonly next?: string;
  /** The scan budget ran out before the page was full: `next` continues. */
  readonly partial: boolean;
  readonly lines: readonly Line[];
}

export interface StatusChange { readonly at: string; readonly what: string; readonly summary: string; readonly cite: Cite }
export interface Changes {
  readonly observedAt: string;
  readonly since: string;
  readonly items: readonly StatusChange[];
  /** How many changes matched; `items` holds the newest `limit` of them. */
  readonly total: number;
  readonly partial: boolean;
  readonly lines: readonly Line[];
}

export interface ToolUse { readonly id: string; readonly taskId: string; readonly server: string; readonly capability: string; readonly outcome: string; readonly uncertain: boolean; readonly at: string; readonly protocolRevision: string; readonly catalogRevision: number }
export interface EffectUse { readonly id: string; readonly taskId: string; readonly kind: string; readonly target: string; readonly status: string; readonly at: string }
export interface ToolsUsed {
  readonly observedAt: string;
  readonly summary: readonly { readonly server: string; readonly capability: string; readonly calls: number; readonly ok: number; readonly errors: number; readonly uncertain: number }[];
  readonly calls: readonly ToolUse[];
  readonly effects: readonly EffectUse[];
  readonly total: number;
  readonly partial: boolean;
  readonly lines: readonly Line[];
}

export interface DeliveredArtifact { readonly id: string; readonly name: string; readonly taskId?: string; readonly files: number; readonly bytes: number; readonly manifestDigest: string; readonly recordedAt: string; readonly verification: "verified" | "damaged" | "not_checked" }
export interface Delivered {
  readonly observedAt: string;
  readonly artifacts: readonly DeliveredArtifact[];
  /** Tasks the records mark done that have no artifact: finished, but nothing is recorded as delivered. */
  readonly doneWithoutArtifact: readonly { readonly taskId: string; readonly title: string }[];
  readonly partial: boolean;
  readonly lines: readonly Line[];
}

export interface Noticeboard {
  readonly observedAt: string;
  readonly projectId: string;
  readonly assignments: readonly { readonly taskId: string; readonly title: string; readonly state: TaskState; readonly owner?: string; readonly link: Cite }[];
  readonly standups: readonly { readonly recordId: string; readonly owner: string; readonly title: string; readonly status: string; readonly taskId?: string; readonly at: string; /** Older than `standupStaleAfterMs`: shown, but flagged as old. */ readonly stale: boolean; readonly desk: Cite; readonly link: Cite }[];
  readonly deliverables: readonly { readonly artifactId: string; readonly name: string; readonly taskId?: string; readonly at: string; readonly link: Cite }[];
  readonly withheld: readonly string[];
  readonly partial: boolean;
  readonly lines: readonly Line[];
}

export interface FailedEvents {
  readonly observedAt: string;
  readonly items: readonly { readonly id: string; readonly taskId: string; readonly projectId: string; readonly state: string; readonly stream: string; readonly attempts: number; readonly failedBy?: string; readonly failedAt?: string; readonly error?: string; readonly nextAttemptAt?: string }[];
  readonly next?: string;
  readonly scanLimited: boolean;
  readonly lines: readonly Line[];
}

export interface FailedEventDetail {
  readonly observedAt: string;
  readonly handling: { readonly id: string; readonly taskId: string; readonly state: string; readonly attempts: number; readonly round: number; readonly reasons: readonly string[]; readonly failedBy?: string; readonly error?: string; readonly nextAttemptAt?: string };
  /** Text that came with the events: data from outside, shown for reading, never an instruction. */
  readonly eventText: readonly { readonly seq: number; readonly text: string }[];
  readonly inbox?: { readonly id: string; readonly state: string };
  readonly lines: readonly Line[];
}

export type StatusRequest =
  | { readonly kind: "task"; readonly taskId: string }
  | { readonly kind: "overview"; readonly projectId?: string; readonly agentId?: string; readonly state?: string; readonly execution?: string; readonly afterId?: string; readonly limit?: number }
  | { readonly kind: "changes"; readonly projectId: string; readonly since: string; readonly limit?: number }
  | { readonly kind: "tools"; readonly projectId?: string; readonly taskId?: string; readonly since?: string; readonly limit?: number }
  | { readonly kind: "delivered"; readonly projectId: string; readonly taskId?: string; readonly since?: string }
  | { readonly kind: "noticeboard"; readonly projectId: string }
  | { readonly kind: "failed_events"; readonly projectId?: string; readonly taskId?: string; readonly afterId?: string; readonly limit?: number }
  | { readonly kind: "failed_event"; readonly handlingId: string }
  | { readonly kind: "owner_questions"; readonly limit?: number }
  | { readonly kind: "needs_you"; readonly limit?: number }
  | { readonly kind: "handoff"; readonly taskId: string }
  | { readonly kind: "shutdown" }
  | { readonly kind: "timeline"; readonly projectId: string; readonly agent?: string; readonly since?: string; readonly limit?: number }
  | { readonly kind: "meetings"; readonly projectId: string; readonly limit?: number }
  | { readonly kind: "agenda"; readonly projectId: string; readonly limit?: number }
  | { readonly kind: "explanations"; readonly taskId: string; readonly seq?: number; readonly limit?: number }
  | { readonly kind: "activity"; readonly taskId: string; readonly latest?: boolean; readonly after?: number; readonly limit?: number };

interface NeedItem { text: string; cites: Cite[]; taskId?: string; since: string; id: string }

// ---- service -------------------------------------------------------------------------------------------------------------------

export interface StatusDeps {
  readonly assignments: AssignmentService;
  readonly waits: WaitService;
  readonly blockers: BlockerService;
  readonly contracts: ContractService;
  /** Suspected and confirmed stall concerns (card V01). Absent: none are shown. */
  readonly stall?: Pick<StallService, "list">;
  /** Pause gates (card L01). Absent: no gate is shown and none is assumed. */
  readonly pauses?: Pick<PauseService, "status" | "isPaused">;
  /** The failed event queue (card H13). Absent: the queue cannot be listed. */
  readonly watch?: Pick<WatchService, "failures" | "inspect">;
  /** The hand-off going on for a task (card L03f). Absent: the view is not offered. */
  /** Whether the installation could be stopped now (card L06). Absent: the view is not offered. */
  readonly shutdown?: { readiness(by: Principal): Promise<{ readonly ready: boolean; readonly paused: boolean; readonly unsettled: readonly { readonly kind: string; readonly ref: string; readonly state: string }[]; readonly tracked?: readonly { readonly kind: string; readonly ref: string; readonly state: string }[]; readonly truncated: boolean }> };
  readonly handoffs?: { forTask(by: Principal, taskId: string): Promise<View<TaskHandoffBody> | undefined> };
  /** The planned meetings of a project (card M04f). Absent: the view is not offered. */
  readonly meetings?: { planned(viewer: Principal, projectId: string, page?: { limit?: number }): Promise<{ items: readonly { id: string; revision: number; title: string; kind: string; startsAt: string; endsAt: string; mode: string; state: string; participants: readonly { id: string; status?: string; availability?: string }[] }[]; next?: string } | undefined> };
  /** The open agenda of a project (card M03f). Absent: the view is not offered. */
  readonly agenda?: { openAgenda(viewer: Principal, projectId: string, page?: { limit?: number }): Promise<{ items: readonly { id: string; revision: number; topic: string; question?: string; requestedOutcome?: string; urgency: string; intent: string; state: string; requestedBy: string; timeboxMinutes?: number }[]; next?: string } | undefined> };
  /** The steps of a task's activity record (card C09h). Absent: the view is not offered. */
  readonly activity?: Pick<ActivityService, "steps" | "explanations"> & Partial<Pick<ActivityService, "timeline">>;
  /** The reviews only the owner can decide (card U11b). Absent: they are not listed. */
  readonly reviews?: { ownerPending(owner: Principal, limit?: number): Promise<readonly { id: string; taskId: string; projectId: string; name: string; requestedAt: string }[]> };
  /** Questions agents have put to the owner (card U12e). Absent: none are listed. */
  readonly ownerQuestions?: { ownerQuestions(owner: Principal, page?: { afterId?: string; limit?: number }): Promise<{ items: readonly { inquiryId: string; asker: string; question: string; askedAt: string; revision: number; task: { id: string; title: string; projectName: string }; wait?: { summary: string; nextAction: string; deadline?: string } }[]; next?: string }> };
  /** Checks an artifact against its files (card S06). Absent: artifacts are listed as `not_checked`, never as verified. */
  readonly verifyArtifact?: (artifactId: string) => Promise<{ readonly ok: boolean }>;
}

export interface StatusOptions extends RunnerOptions {
  /** How old the last sign of work may be before it is `stale`. Default: the silence threshold of the task's difficulty, the one stall detection uses. */
  readonly staleAfterMs?: number;
  /** How long a host counts as fresh. Default: the one constant `HostService` uses. */
  readonly hostStaleAfterMs?: number;
  /** Records read per page, and pages per kind in one scan. A scan that is cut off says so (`partial`). */
  readonly scanPageSize?: number;
  readonly scanPages?: number;
  /** Artifacts verified in one answer (verification reads every file). Default 20. */
  readonly verifyLimit?: number;
  /** How old a stand-up report may be before it is flagged as old. Provisional default 36 hours. */
  readonly standupStaleAfterMs?: number;
}

export const STATUS_LIMITS = { page: 100, defaultPage: 20, id: 120, board: 10, since: 40 } as const;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HANDLING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TASK_ID_IN_TEXT = /task-[a-z2-7]{20}/g;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const cite = (kind: string, id: string, revision?: number): Cite => ({ kind, id, ...(revision === undefined ? {} : { revision }) });
const line = (text: string, ...cites: Cite[]): Line => ({ text, cites });
const FRESH_WORDS: Readonly<Record<Freshness, string>> = { fresh: "recent", stale: "old", unknown: "not heard from lately" };
const STATE_WORDS: Readonly<Record<TaskState, string>> = { proposed: "proposed and not yet ready", ready: "ready to be worked on", in_progress: "marked in progress", blocked: "blocked", done: "marked done", cancelled: "cancelled" };

interface BlockerIndex { readonly byTask: Map<string, View<BlockerBody>[]>; readonly unmapped: View<BlockerBody>[]; readonly partial: boolean }
interface Ctx {
  readonly principalKinds: Map<string, string | undefined>;
  index?: Promise<BlockerIndex>;
}

/**
 * Chat status and blocker explanations (card U05). Everything here is a read: nothing is written, no worker is woken, no model is asked, and every statement comes with the records it rests on (`Cite`).
 * What a caller sees is what its grants allow, section by section: a task it cannot read reads like a missing one, and a part it may not see (who owns the task, the pause gates, the tools used) is
 * left out and named in `withheld`, never filled in.
 *
 * - **Owner and activity are two facts.** The owner of record comes from the assignment; "working" comes only from a recent sign of work by that owner under the current generation (host activity, card H01,
 *   or stall evidence, card V01). Time never promotes anything: an old sign is `stale` and the state is `unknown`, and a worker that lost its generation is reported as such, not as the owner working.
 * - **No fabricated completion.** A task is done only when its record says so, and then with any open doubt (an effect that may not have happened, a tool call whose outcome is unknown, a failed event) beside it.
 * - **A blocker says what kind of obstacle it is and the way out.** Technical, enforced permission, policy conflict, a person's hold, or a preference (`BlockerBasis`). A preference of a supervisor or team is not a
 *   boundary: on an outcome the owner decided it is listed as advice, never as a blocker.
 * - **Nothing is cut silently.** Scans are bounded; when the budget runs out the answer says `partial` and gives a cursor.
 */
export class StatusService {
  readonly #runner: CommandRunner;
  readonly #storage: ControllerStorage;
  readonly #deps: StatusDeps;
  readonly #options: StatusOptions;
  readonly #pageSize: number;
  readonly #pages: number;

  private constructor(runner: CommandRunner, deps: StatusDeps, options: StatusOptions) {
    this.#runner = runner;
    this.#storage = runner.storage;
    this.#deps = deps;
    this.#options = options;
    this.#pageSize = options.scanPageSize ?? 200;
    this.#pages = options.scanPages ?? 25;
    if (!Number.isSafeInteger(this.#pageSize) || this.#pageSize < 1 || !Number.isSafeInteger(this.#pages) || this.#pages < 1) invalid("scanPages", "must be whole numbers of at least 1");
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: StatusDeps, options: StatusOptions = {}): StatusService {
    return new StatusService(new CommandRunner(storage, epoch, options), deps, options);
  }

  /** One question in one object, for the coordinator and the chat. Returns the plain lines (each with its records) of whichever view the request names, or undefined when the subject is missing or unreadable. */
  async ask(by: Principal, request: StatusRequest): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (request === null || typeof request !== "object") return invalid("request", "must be an object");
    switch (request.kind) {
      case "task": { onlyKnown(request, ["kind", "taskId"]); return this.task(by, request.taskId); }
      case "overview": { const { kind: _k, ...rest } = request; return this.overview(by, rest); }
      case "changes": { const { kind: _k, ...rest } = request; return this.changes(by, rest); }
      case "tools": { const { kind: _k, ...rest } = request; return this.tools(by, rest); }
      case "delivered": { const { kind: _k, ...rest } = request; return this.delivered(by, rest); }
      case "noticeboard": { onlyKnown(request, ["kind", "projectId"]); return this.noticeboard(by, request.projectId); }
      case "failed_events": { const { kind: _k, ...rest } = request; return this.failedEvents(by, rest); }
      case "failed_event": { onlyKnown(request, ["kind", "handlingId"]); return this.inspectFailedEvent(by, request.handlingId); }
      case "timeline": { onlyKnown(request, ["kind", "projectId", "agent", "since", "limit"]); return this.timelineLines(by, request); }
      case "shutdown": { onlyKnown(request, ["kind"]); return this.shutdownLines(by); }
      case "handoff": { onlyKnown(request, ["kind", "taskId"]); return this.handoffLines(by, request.taskId); }
      case "meetings": { onlyKnown(request, ["kind", "projectId", "limit"]); return this.meetingLines(by, request); }
      case "agenda": { onlyKnown(request, ["kind", "projectId", "limit"]); return this.agendaLines(by, request); }
      case "explanations": { onlyKnown(request, ["kind", "taskId", "seq", "limit"]); return this.explanationLines(by, request); }
      case "activity": { onlyKnown(request, ["kind", "taskId", "latest", "after", "limit"]); return this.activityLines(by, request); }
      case "needs_you": { onlyKnown(request, ["kind", "limit"]); return this.needsYou(by, request.limit); }
      case "owner_questions": { onlyKnown(request, ["kind", "limit"]); return this.ownerQuestionLines(by, request.limit); }
      default: return invalid("kind", "is not a kind of status request");
    }
  }

  // ---- what happened on a task (card C09h) ------------------------------------------------------------------------------------

  /**
   * The steps of a task's activity record in plain lines, in order: from `after`, or, with `latest`, the last few. What the caller may not read reads as missing. Only the summary of a step is shown (an agent's words, as its words); the stored content of a step is never
   * quoted here, because it is the part that needs a history right.
   */
  async activityLines(by: Principal, request: { taskId: string; latest?: boolean; after?: number; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const activity = this.#deps.activity;
    if (activity === undefined) return undefined;
    const taskId = checkTaskId(request.taskId);
    const limit = request.limit === undefined ? 20 : Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 50 ? request.limit : invalid("limit", "must be 1 to 50");
    if (request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < 0)) invalid("after", "must be a whole number from 0");
    if (request.latest === true && request.after !== undefined) invalid("latest", "cannot be combined with after");
    let steps: Awaited<ReturnType<ActivityService["steps"]>>["steps"] = [];
    let next: number | undefined;
    try {
      if (request.latest === true) {
        steps = (await activity.steps(by, taskId, { tail: true, limit })).steps;
      } else {
        const got = await activity.steps(by, taskId, { ...(request.after === undefined ? {} : { after: request.after }), limit });
        steps = got.steps;
        next = got.next;
      }
    } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return undefined;
      throw error;
    }
    const lines: Line[] = steps.map((s) => ("unavailable" in s
      ? line(`Step ${s.seq} is no longer available: ${shown(s.unavailable)}.`, cite("task", taskId))
      : line(`Step ${s.seq}, ${s.at}, ${shown(s.actor)}: ${s.kind} - ${shown(s.summary)}${s.corrections > 0 ? ` (corrected ${s.corrections} time${s.corrections === 1 ? "" : "s"})` : ""}`, cite("task", taskId))));
    if (lines.length === 0) lines.push(line("No steps are recorded for this task yet.", cite("task", taskId)));
    else if (next !== undefined) lines.push(line(`There are more steps; ask again after step ${next}.`, cite("task", taskId)));
    return { observedAt: this.#runner.now(), lines };
  }

  /** The hand-off going on for a task: from whom to whom, why and who asked, how far it is, whether the package is complete (and what is missing), what blocks it and how, when it will be returned if it is temporary. Nothing when the task cannot be read; a plain line when no hand-off is going. */
  /** A project's recent steps across its tasks, newest first, one line each (card U09). Read only. What the caller may not read reads as missing. */
  async timelineLines(by: Principal, request: { projectId: string; agent?: string; since?: string; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.activity?.timeline === undefined) return undefined;
    const limit = request.limit === undefined ? 20 : Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 50 ? request.limit : invalid("limit", "must be 1 to 50");
    let got;
    try { got = await this.#deps.activity.timeline(by, request.projectId, { limit, ...(request.agent === undefined ? {} : { agent: request.agent }), ...(request.since === undefined ? {} : { since: request.since }) }); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return undefined;
      throw error;
    }
    const lines: Line[] = got.steps.map((s) => line(`${s.at}, ${shown(s.actor)}: ${s.kind} - ${shown(s.summary)}`, cite("task", s.taskId)));
    for (const g of got.gaps ?? []) lines.push(line(`Step ${g.seq} of a task is no longer available: ${shown(g.reason)}.`, cite("task", g.taskId)));
    if (lines.length === 0) lines.push(line("No steps match.", cite("project", request.projectId)));
    else if (got.truncated) lines.push(line("The project has more tasks than were looked at; this is a part of its recent activity (usually the most recently active tasks).", cite("project", request.projectId)));
    return { observedAt: this.#runner.now(), lines };
  }

  async shutdownLines(by: Principal): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.shutdown === undefined || by.kind !== "owner") return undefined;
    let r;
    try { r = await this.#deps.shutdown.readiness(by); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "unavailable")) return undefined;
      throw error;
    }
    const at = this.#runner.now();
    const exceptions = (r.tracked ?? []).slice(0, 20).map((i) => line(`${shown(i.kind)} ${shown(i.ref)} is a permitted remote job; it keeps running through a stop and is tracked.`, cite("installation", "installation")));
    if (r.ready) return { observedAt: at, lines: [line(r.paused ? "Nothing is running or unknown; the installation could be stopped now, and it is paused." : "Nothing is running or unknown; the installation could be stopped now.", cite("installation", "installation")), ...exceptions] };
    const lines: Line[] = [line(`The installation could not be stopped cleanly yet: ${r.unsettled.length}${r.truncated ? " or more" : ""} thing(s) are still running or not known.`, cite("installation", "installation"))];
    for (const i of r.unsettled.slice(0, 20)) lines.push(line(`${shown(i.kind)} ${shown(i.ref)}: ${shown(i.state)}.`, cite("installation", "installation")));
    lines.push(...exceptions);
    return { observedAt: at, lines };
  }

  async handoffLines(by: Principal, taskIdValue: string): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.handoffs === undefined) return undefined;
    const taskId = checkTaskId(taskIdValue);
    let h: View<TaskHandoffBody> | undefined;
    try { h = await this.#deps.handoffs.forTask(by, taskId); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return undefined;
      throw error;
    }
    if (h === undefined) return { observedAt: this.#runner.now(), lines: [line("No hand-off is going on for this task.", cite("task", taskId))] };
    const lines: Line[] = [line(`Hand-off from ${shown(h.from.id)} to ${shown(h.to.id)}, ${h.mode}: ${h.phase}. Asked by ${shown(h.requestedBy)} at ${h.requestedAt}: ${shown(h.reason)}`, cite("handoff", h.id, h.revision), cite("task", taskId))];
    if (h.returnAt !== undefined) lines.push(line(`It is temporary: the task goes back to ${shown(h.from.id)} at ${h.returnAt}, if whoever asked still holds the right to control it then.`, cite("handoff", h.id)));
    if (h.package !== undefined) lines.push(line(h.package.ready ? "The package is complete." : `The package is missing: ${h.package.missing.map((x) => shown(x)).join(", ")}.`, cite("handoff", h.id)));
    if (h.acceptedGaps !== undefined) lines.push(line(`It was handed over with gaps accepted: ${h.acceptedGaps.missing.map((x) => shown(x)).join(", ")}.`, cite("handoff", h.id)));
    if (h.blocked !== undefined) lines.push(line(`It is held up: ${shown(h.blocked.reason)} You can choose: ${h.blocked.choices.join(", ")}.`, cite("handoff", h.id)));
    if (h.failure !== undefined) lines.push(line(`It failed: ${shown(h.failure)}`, cite("handoff", h.id)));
    return { observedAt: this.#runner.now(), lines };
  }

  /** The meetings planned in a project, soonest first: the title, the kind, when, how it is held and who is on the roster with how each is placed (present, unavailable, paused...). Nothing for a project the caller may not read. */
  async meetingLines(by: Principal, request: { projectId: string; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.meetings === undefined) return undefined;
    const projectId = checkProjectId(request.projectId);
    const limit = request.limit === undefined ? 10 : Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 50 ? request.limit : invalid("limit", "must be 1 to 50");
    if (by.kind === "owner" && (await this.#runner.get("project", projectId)) === undefined) return undefined;
    const planned = await this.#deps.meetings.planned(by, projectId, { limit });
    if (planned === undefined) return undefined;
    const lines: Line[] = planned.items.map((m) => {
      const roster = m.participants.map((p) => `${shown(p.id)}${[p.status, p.availability].filter((x) => x !== undefined && x !== "").length === 0 ? "" : ` (${[p.status, p.availability].filter((x) => x !== undefined && x !== "").join(", ")})`}`);
      return line(`${shown(m.title)}: ${m.kind}, ${m.startsAt} to ${m.endsAt}, ${m.mode}, ${m.state}. ${roster.length === 0 ? "No roster." : `On the roster: ${roster.join(", ")}.`}`, cite("meeting", m.id, m.revision), cite("project", projectId));
    });
    if (lines.length === 0) lines.push(line("No meeting is planned in this project.", cite("project", projectId)));
    else if (planned.next !== undefined) lines.push(line("There are more meetings than shown.", cite("project", projectId)));
    return { observedAt: this.#runner.now(), lines };
  }

  /** What waits for the next stand-up in a project, in the order the meeting will take it: the topic, how urgent, what kind of request, who asked, the question and the outcome asked for. Words that came from someone else are shown as theirs. Anyone who may not read the project gets nothing. */
  async agendaLines(by: Principal, request: { projectId: string; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.agenda === undefined) return undefined;
    const projectId = checkProjectId(request.projectId);
    const limit = request.limit === undefined ? 10 : Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 50 ? request.limit : invalid("limit", "must be 1 to 50");
    if (by.kind === "owner" && (await this.#runner.get("project", projectId)) === undefined) return undefined;
    const open = await this.#deps.agenda.openAgenda(by, projectId, { limit });
    if (open === undefined) return undefined;
    const lines: Line[] = open.items.map((i, n) => line(
      `${n + 1}. ${shown(i.topic)} (${i.urgency}, ${i.intent}, ${i.state}) asked by ${shown(i.requestedBy)}${i.question === undefined ? "" : `: "${shown(i.question)}"`}${i.requestedOutcome === undefined ? "" : ` Outcome asked for: ${shown(i.requestedOutcome)}.`}${i.timeboxMinutes === undefined ? "" : ` Timebox ${i.timeboxMinutes} minutes.`}`,
      cite("agenda", i.id, i.revision), cite("project", projectId)));
    if (lines.length === 0) lines.push(line("Nothing is waiting on the agenda of this project.", cite("project", projectId)));
    else if (open.next !== undefined) lines.push(line("There are more topics than shown.", cite("project", projectId)));
    return { observedAt: this.#runner.now(), lines };
  }

  /** The explanations agents wrote for their choices on a task (or one step), the latest first: what was chosen, what else was considered and why not, the evidence and what is uncertain; a retrospective one says so and says when the records could not explain the step. */
  async explanationLines(by: Principal, request: { taskId: string; seq?: number; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const activity = this.#deps.activity;
    if (activity === undefined) return undefined;
    const taskId = checkTaskId(request.taskId);
    const limit = request.limit === undefined ? 5 : Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 20 ? request.limit : invalid("limit", "must be 1 to 20");
    if (request.seq !== undefined && (!Number.isSafeInteger(request.seq) || request.seq < 1)) invalid("seq", "must be a whole number from 1");
    let all: readonly ExplanationBody[];
    try { all = await activity.explanations(by, taskId, request.seq); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return undefined;
      throw error;
    }
    const latest = [...all].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0)).slice(0, limit);
    const lines: Line[] = [];
    for (const e of latest) {
      const where = e.seq === undefined ? "on the task" : `at step ${e.seq}`;
      const how = e.mode === "retrospective" ? (e.grounded === false ? "Written afterwards, and the records could not explain it" : "Written afterwards, from the records") : "Written at the time";
      lines.push(line(`${how} by ${shown(e.by)} ${where}, ${e.at}: chose ${shown(e.choice)}.`, cite("task", taskId)));
      for (const a of e.alternatives) lines.push(line(`Not ${shown(a.option)}: ${shown(a.whyNot)}`, cite("task", taskId)));
      for (const ev of e.evidence) lines.push(line(`Evidence: ${shown(ev.statement)}`, cite("task", taskId)));
      if (e.uncertainty !== "") lines.push(line(`Uncertain: ${shown(e.uncertainty)}`, cite("task", taskId)));
    }
    if (lines.length === 0) lines.push(line("No explanations are written for this task yet.", cite("task", taskId)));
    else if (all.length > latest.length) lines.push(line(`${all.length - latest.length} older explanation${all.length - latest.length === 1 ? " is" : "s are"} not shown.`, cite("task", taskId)));
    return { observedAt: this.#runner.now(), lines };
  }

  // ---- questions to the owner (card U12e) ------------------------------------------------------------------------------------

  /** The questions waiting for the owner's answer, oldest first, for the owner only (anyone else: undefined, as for a record they cannot read). An agent's words are shown as its words, never as the owner's or the system's. */
  async ownerQuestionLines(by: Principal, limit?: number): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (by.kind !== "owner" || this.#deps.ownerQuestions === undefined) return undefined;
    const cap = limit === undefined ? 10 : Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 ? limit : invalid("limit", "must be 1 to 50");
    const { items, next } = await this.#deps.ownerQuestions.ownerQuestions(by, { limit: cap });
    const lines: Line[] = items.map((q) => line(
      `${shown(q.asker)} asks about "${shown(q.task.title)}" (${shown(q.task.projectName)}), since ${q.askedAt}: "${shown(q.question)}"${q.wait === undefined ? "" : ` Your answer ends the wait: ${shown(q.wait.summary)}.${q.wait.deadline === undefined ? "" : ` It is due ${q.wait.deadline}.`}`}`,
      cite("inquiry", q.inquiryId, q.revision), cite("task", q.task.id)));
    if (lines.length === 0) lines.push(line("No agent is waiting for your answer."));
    else if (next !== undefined) lines.push(line("There are more questions than shown; answer these first and ask again."));
    return { observedAt: this.#runner.now(), lines };
  }

  // ---- everything waiting for the owner (card U11b) -------------------------------------------------------------------------

  /** What waits for the owner, unranked: agent questions, approvals only the owner can decide and blockers the owner resolves; what is about a finished or cancelled task is left out. */
  async #needItems(by: Principal): Promise<{ items: NeedItem[]; taskOf: (id: string) => Promise<{ projectId: string; open: boolean } | undefined>; truncated: string[] }> {
    const truncated: string[] = [];
    const memo = new Map<string, { projectId: string; open: boolean } | undefined>();
    const taskOf = async (id: string): Promise<{ projectId: string; open: boolean } | undefined> => {
      if (!memo.has(id)) {
        const t = (await this.#runner.get("task", id))?.body as unknown as { projectId: string; state: TaskState } | undefined;
        memo.set(id, t === undefined ? undefined : { projectId: t.projectId, open: t.state !== "done" && t.state !== "cancelled" });
      }
      return memo.get(id);
    };
    const all: NeedItem[] = [];
    if (this.#deps.ownerQuestions !== undefined) {
      // Ask for one beyond the room: the service reports `next` once it has `limit` items even when nothing follows, so exactly 50 must not look like more.
      const asked = await this.#deps.ownerQuestions.ownerQuestions(by, { limit: 51 });
      if (asked.items.length > 50) truncated.push("questions");
      for (const q of asked.items.slice(0, 50)) {
        all.push({ text: `${shown(q.asker)} asks about "${shown(q.task.title)}": "${shown(q.question)}" (answer the question)`, cites: [cite("inquiry", q.inquiryId, q.revision), cite("task", q.task.id)], taskId: q.task.id, since: q.askedAt, id: q.inquiryId });
      }
    }
    if (this.#deps.reviews !== undefined) {
      // Ask for one beyond the room, to tell exactly 50 apart from more than 50.
      const pending = await this.#deps.reviews.ownerPending(by, 51);
      if (pending.length > 50) truncated.push("approvals");
      for (const r of pending.slice(0, 50)) {
        all.push({ text: `An approval of "${shown(r.name)}" is waiting for you (allow or deny it)`, cites: [cite("review", r.id), cite("task", r.taskId)], taskId: r.taskId, since: r.requestedAt, id: r.id });
      }
    }
    // The owner's blockers are looked for through all the open ones (the others are the agents' to resolve), up to 50 found.
    let owned = 0;
    let blockersCut = false;
    for (let after: string | undefined, pages = 0; !blockersCut; pages++) {
      if (pages >= 20) { blockersCut = true; break; }
      const page = await this.#deps.blockers.list({ ...(after === undefined ? {} : { afterId: after }), limit: 200, openOnly: true });
      for (const b of page.items) {
        if (b.resolver !== "owner") continue;
        const onTask = b.subject.kind === "task";
        // A blocker on a finished or cancelled task does not wait for anything and does not use up the room.
        if (onTask && (await taskOf(b.subject.id))?.open === false) continue;
        if (owned >= 50) { blockersCut = true; break; }
        owned++;
        all.push({ text: `${shown(b.summary)} (${b.type}; resolve it or give what is missing)`, cites: [cite("blocker", b.id), ...(onTask ? [cite("task", b.subject.id)] : [])], ...(onTask ? { taskId: b.subject.id } : {}), since: b.openedAt, id: b.id });
      }
      if (page.next === undefined) break;
      after = page.next;
    }
    const items: NeedItem[] = [];
    for (const i of all) if (i.taskId === undefined || (await taskOf(i.taskId))?.open !== false) items.push(i);
    if (blockersCut) truncated.push("blockers");
    return { items, taskOf, truncated };
  }

  /** How many things wait for the owner (for the count in a reply); no ranking is done. Owner only (anyone else: 0). */
  async needsYouCount(by: Principal): Promise<number> {
    return by.kind !== "owner" ? 0 : (await this.#needItems(by)).items.length;
  }

  /**
   * One list of what waits for the owner's decision: agent questions, reviews only the owner can decide, and open blockers whose resolver is the owner. What other open tasks wait for comes first, then how many they are, then oldest first.
   * `count` is the number found (each source up to 50); `truncated` names the sources (`questions`, `approvals`, `blockers`) that had more than was read, so the list may be missing items; the lines are cut at `limit`. Owner only (anyone else: undefined).
   */
  async needsYou(by: Principal, limit?: number): Promise<{ readonly observedAt: string; readonly lines: readonly Line[]; readonly count: number; readonly truncated: readonly string[] } | undefined> {
    if (by.kind !== "owner") return undefined;
    const cap = limit === undefined ? 20 : Number.isSafeInteger(limit) && limit >= 1 && limit <= 50 ? limit : invalid("limit", "must be 1 to 50");
    const { items, taskOf, truncated } = await this.#needItems(by);
    // How many other open tasks wait, directly or through others, for the task an item is about (the edges of a project are read once).
    const reverse = new Map<string, Promise<Map<string, string[]>>>();
    const reverseOf = (projectId: string): Promise<Map<string, string[]>> => {
      let r = reverse.get(projectId);
      if (r === undefined) {
        r = this.#deps.contracts.activeEdges(projectId).then((edges) => { const m = new Map<string, string[]>(); for (const e of edges) m.set(e.prerequisiteId, [...(m.get(e.prerequisiteId) ?? []), e.taskId]); return m; });
        reverse.set(projectId, r);
      }
      return r;
    };
    const blockedBy = async (item: NeedItem): Promise<number> => {
      if (item.taskId === undefined) return 0;
      const t = await taskOf(item.taskId);
      if (t === undefined) return 0;
      const rev = await reverseOf(t.projectId);
      const seen = new Set<string>([item.taskId]);
      const queue = [item.taskId];
      let n = 0;
      while (queue.length > 0 && seen.size < 2000) {
        for (const next of rev.get(queue.shift()!) ?? []) {
          if (seen.has(next)) continue;
          seen.add(next);
          if ((await taskOf(next))?.open === true) { n++; queue.push(next); }
        }
      }
      return n;
    };
    const ranked: { i: NeedItem; blocked: number }[] = [];
    for (const i of items) ranked.push({ i, blocked: await blockedBy(i) });
    ranked.sort((a, b) => b.blocked - a.blocked || (a.i.since < b.i.since ? -1 : a.i.since > b.i.since ? 1 : a.i.id < b.i.id ? -1 : 1));
    const lines: Line[] = ranked.slice(0, cap).map(({ i, blocked }) => line(`${i.text}${blocked > 0 ? `; ${blocked} other open task${blocked === 1 ? " waits" : "s wait"} for it` : ""}; since ${i.since}.`, ...i.cites));
    if (lines.length === 0) lines.push(line("Nothing is waiting for you."));
    else if (ranked.length > cap) lines.push(line(`${ranked.length - cap} more are waiting; deal with these first and ask again.`));
    if (truncated.length > 0) lines.push(line(`This list may be incomplete: there are more ${truncated.join(", ")} than could be looked at.`));
    return { observedAt: this.#runner.now(), lines, count: ranked.length, truncated };
  }

  // ---- one task ------------------------------------------------------------------------------------------------------------

  /** Everything the records say about one task, for a caller who may read it; undefined otherwise (as for a task that does not exist). */
  async task(by: Principal, taskId: string): Promise<TaskStatus | undefined> {
    const id = checkTaskId(taskId);
    const found = await this.#runner.get("task", id);
    if (found === undefined) return undefined;
    const body = found.body as unknown as TaskBody;
    if (!this.#mayReadTask(by, body.projectId, id)) return undefined;
    const ctx = this.#ctx();
    const now = this.#runner.now();
    const nowMs = Date.parse(now);
    const withheld: string[] = [];
    const viewerIsOwner = by.kind === "owner";
    const task = view<TaskBody>(found);
    const toolsOk = this.#mayReadTools(by, body.projectId, id);
    const assignment = await this.#deps.assignments.getAssignment(id);
    const mayAssign = this.#mayReadAssignment(by, body.projectId, id, assignment);
    if (!mayAssign) withheld.push("who owns the task, who is working on it, and whether it is paused");
    const lines: Line[] = [line(`${shown(body.title)} is ${STATE_WORDS[body.state]}.`, cite("task", id, found.revision))];
    const pending: Pending[] = [];

    // Owner of record and what has been seen of the work.
    let owner: TaskStatus["owner"];
    let execution: ExecutionFacts | undefined;
    let pauseView: TaskStatus["pause"];
    const concerns: { suspected: { id: string; kind: string; detail: string }[]; confirmed: { id: string; kind: string; detail: string }[] } = { suspected: [], confirmed: [] };
    if (mayAssign) {
      const name = assignment?.owner?.kind === "agent" ? ((await this.#runner.get("agent", assignment.owner.id.replace(/^agent:/, "")))?.body as unknown as { friendlyName?: string } | undefined)?.friendlyName : undefined;
      owner = assignment?.state === "assigned" && assignment.owner !== undefined
        ? { kind: assignment.owner.kind, id: assignment.owner.id, ...(name === undefined ? {} : { name: shown(name, 80) }), generation: assignment.generation, ...(assignment.activeAttemptId === undefined ? {} : { activeAttemptId: assignment.activeAttemptId }) }
        : undefined;
      const attempt = assignment?.activeAttemptId === undefined ? undefined : await this.#deps.assignments.getAttempt(assignment.activeAttemptId);
      const pauseStatus = this.#deps.pauses === undefined ? undefined : await this.#deps.pauses.status(by, id);
      const paused = this.#deps.pauses !== undefined && (await this.#deps.pauses.isPaused(id));
      execution = await this.#execution(body, id, assignment, attempt, nowMs, paused);
      if (pauseStatus !== undefined) {
        pauseView = { paused: pauseStatus.paused, gates: pauseStatus.gates.map((g) => ({ scope: `${g.scope.kind} ${g.scope.id}`, ...(g.gate.pausedAt === undefined ? {} : { since: g.gate.pausedAt }), ...(g.gate.owner === undefined ? {} : { by: g.gate.owner }), ...(g.gate.observed === undefined ? {} : { observed: g.gate.observed.state }) })) };
      }
      if (this.#deps.stall !== undefined) {
        for (const state of ["suspected", "confirmed"] as const) {
          const page = await this.#deps.stall.list(by, { taskId: id, state, limit: 20 });
          for (const c of page.items) concerns[state].push({ id: c.id, kind: c.kind, detail: shown(c.detail) });
        }
      }
      lines.push(...this.#ownerLines(id, assignment, owner, execution, attempt, pauseStatus));
    }

    // What is pending, exactly.
    await this.#pendingOf(by, id, task, pending, toolsOk);
    for (const p of pending) lines.push(this.#pendingLine(p, id, viewerIsOwner));

    if (!toolsOk) withheld.push("the tools used and the details of outside actions");
    // Blockers and advice.
    const index = await this.#index(ctx);
    const blockers: BlockerView[] = [];
    const advice: BlockerView[] = [];
    const decided = await this.#ownerDecided(ctx, body, id);
    const all = index.byTask.get(id) ?? [];
    for (const b of all) {
      const bv = this.#blockerView(b, viewerIsOwner, toolsOk);
      (bv.basis === "preference" && decided ? advice : blockers).push(bv);
    }
    for (const b of blockers) lines.push(line(`It is held up by ${b.words}: ${b.summary} The way out: ${b.route}.`, cite("blocker", b.id, b.revision), cite("task", id)));
    for (const b of advice) lines.push(line(`Advice, not a blocker: ${b.summary} This outcome was decided by the owner, so a preference does not stop it.`, cite("blocker", b.id, b.revision), cite("task", id)));
    if (body.state === "blocked" && pending.every((p) => p.kind !== "wait") && blockers.length === 0 && advice.length === 0)
      lines.push(line("It is blocked, but no record says why. That is itself a problem to look at.", cite("task", id, found.revision)));
    for (const c of concerns.suspected) lines.push(line(`Suspected, not confirmed: ${c.detail}`, cite("stall-concern", c.id), cite("task", id)));
    for (const c of concerns.confirmed) lines.push(line(`Confirmed problem: ${c.detail}`, cite("stall-concern", c.id), cite("task", id)));

    // Completion, from the task record alone, with the doubts that are still open.
    const doubts = await this.#doubts(id, all, toolsOk);
    const completion: TaskStatus["completion"] = body.state === "cancelled" ? "cancelled" : body.state === "done" ? (doubts.length > 0 ? "done_with_open_doubts" : "done") : "not_done";
    if (body.state === "done") for (const d of doubts) lines.push(line(`It is marked done, but ${d.text}`, ...d.cites));
    if (body.state !== "done" && body.state !== "cancelled" && assignment !== undefined && mayAssign) {
      const last = await this.#latestAttempt(id, assignment);
      if (last !== undefined && last.state === "succeeded") lines.push(line("The latest attempt ended as succeeded, but the task is not marked done, so it is not counted as finished.", cite("attempt", last.id), cite("task", id)));
    }
    if (withheld.length > 0) lines.push(line(`Not shown to you: ${withheld.join("; ")}.`, cite("task", id)));
    if (index.partial) lines.push(line("The search for blockers did not finish, so some may be missing from this answer.", cite("task", id)));
    return {
      observedAt: now,
      task: { id, projectId: body.projectId, title: shown(body.title), state: body.state, revision: found.revision, updatedAt: task.updatedAt },
      completion, ...(owner === undefined ? {} : { owner }),
      ...(execution === undefined ? {} : { execution: { state: execution.state, ...(execution.observation === undefined ? {} : { observation: execution.observation }), uncertainty: execution.uncertainty } }),
      pending, blockers, advice, concerns, ...(pauseView === undefined ? {} : { pause: pauseView }), withheld, partial: index.partial, lines,
    };
  }

  // ---- the overview --------------------------------------------------------------------------------------------------------

  /**
   * Tasks the caller may read, filtered by project, agent (the owner of record) and state, one page at a time. Each row says when the work was last seen and whether that is fresh, stale or unknown, and
   * what is uncertain. Only the installation owner may leave the project out. A row whose owner the caller may not see is never matched by an agent filter.
   */
  async overview(by: Principal, query: { projectId?: string; agentId?: string; state?: string; execution?: string; afterId?: string; limit?: number } = {}): Promise<Overview> {
    onlyKnown(query, ["projectId", "agentId", "state", "execution", "afterId", "limit"]);
    const project = query.projectId === undefined ? undefined : checkProjectId(query.projectId);
    if (project === undefined && by.kind !== "owner") throw new DomainError("forbidden", `${by.id} must name a project`);
    const agent = query.agentId === undefined ? undefined : this.#agentFilter(query.agentId);
    const state = query.state === undefined ? undefined : (TASK_STATES as readonly string[]).includes(query.state) ? query.state as TaskState : invalid("state", `must be one of ${TASK_STATES.join(", ")}`);
    const execution = query.execution === undefined ? undefined : (EXECUTION_STATES as readonly string[]).includes(query.execution) ? query.execution as ExecutionState : invalid("execution", `must be one of ${EXECUTION_STATES.join(", ")}`);
    const limit = this.#limit(query.limit);
    if (query.afterId !== undefined && (typeof query.afterId !== "string" || query.afterId.length > STATUS_LIMITS.id)) invalid("afterId", "is not a cursor from an earlier page");
    const ctx = this.#ctx();
    const index = await this.#index(ctx);
    const now = this.#runner.now();
    const nowMs = Date.parse(now);
    const items: OverviewRow[] = [];
    let after = query.afterId;
    let next: string | undefined;
    let partial = false;
    scan: {
      for (let reads = 0; reads < this.#pages; reads++) {
        const page = await this.#runner.list("task", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
        for (const aggregate of page) {
          after = aggregate.id;
          const body = aggregate.body as unknown as TaskBody;
          if ((project !== undefined && body.projectId !== project) || (state !== undefined && body.state !== state)) continue;
          if (!this.#mayReadTask(by, body.projectId, aggregate.id)) continue;
          const row = await this.#row(by, ctx, index, aggregate.id, aggregate.revision, body, nowMs);
          if (agent !== undefined && (row.owner === undefined || row.owner.kind !== "agent" || row.owner.id.replace(/^agent:/, "") !== agent)) continue;
          if (execution !== undefined && row.execution !== execution) continue;
          items.push(row);
          if (items.length >= limit) { next = aggregate.id; break scan; }
        }
        if (page.length < this.#pageSize) { after = undefined; break scan; }
      }
      partial = true;
      next = after;
    }
    const counts = { byState: {} as Record<string, number>, stale: 0, uncertain: 0, blocked: 0 };
    for (const r of items) { counts.byState[r.state] = (counts.byState[r.state] ?? 0) + 1; if (r.stale) counts.stale++; if (r.uncertain.length > 0) counts.uncertain++; if (r.blockers > 0 || r.state === "blocked") counts.blocked++; }
    const withheld: string[] = [];
    if (items.some((r) => r.execution === undefined)) withheld.push("who owns the tasks, whether work is happening, and pauses");
    const lines: Line[] = [];
    for (const r of items) lines.push(this.#rowLine(r));
    if (withheld.length > 0) lines.push(line(`Not shown to you: ${withheld.join("; ")}.`, cite("task-list", project ?? "all")));
    if (items.length === 0) lines.push(line("No task matches, among those you may read.", cite("task-list", project ?? "all")));
    if (partial) lines.push(line("The search stopped before the end of the tasks; ask again from the cursor to carry on.", cite("task-list", project ?? "all")));
    if (index.partial) lines.push(line("The search for blockers did not finish, so some blockers may be missing.", cite("task-list", project ?? "all")));
    return { observedAt: now, items, withheld, counts, ...(next === undefined ? {} : { next }), partial, lines };
  }

  async #row(by: Principal, ctx: Ctx, index: BlockerIndex, id: string, revision: number, body: TaskBody, nowMs: number): Promise<OverviewRow> {
    const assignment = await this.#deps.assignments.getAssignment(id);
    const mayAssign = this.#mayReadAssignment(by, body.projectId, id, assignment);
    const wait = await this.#deps.waits.openFor(id);
    const decided = (index.byTask.get(id) ?? []).some((b) => b.basis === "preference") ? await this.#ownerDecided(ctx, body, id) : false;
    let blockers = 0, advice = 0;
    for (const b of index.byTask.get(id) ?? []) { if ((b.basis ?? defaultBasis(b.type)) === "preference" && decided) advice++; else blockers++; }
    let facts: ExecutionFacts | undefined;
    let paused = false;
    if (mayAssign) {
      const attempt = assignment?.activeAttemptId === undefined ? undefined : await this.#deps.assignments.getAttempt(assignment.activeAttemptId);
      paused = this.#deps.pauses !== undefined && (await this.#deps.pauses.isPaused(id));
      facts = await this.#execution(body, id, assignment, attempt, nowMs, paused);
    }
    const uncertain = [...(facts?.uncertainty ?? [])];
    if ((index.byTask.get(id) ?? []).some((b) => b.type === "effect_uncertain")) uncertain.push("an action may or may not have happened");
    const obs = facts?.observation;
    return {
      taskId: id, projectId: body.projectId, title: shown(body.title), state: body.state,
      ...(mayAssign && assignment?.state === "assigned" && assignment.owner !== undefined ? { owner: { kind: assignment.owner.kind, id: assignment.owner.id } } : {}),
      ...(facts === undefined ? {} : { execution: facts.state }),
      ...(obs === undefined ? {} : { observation: { at: obs.at, ageMs: obs.ageMs, freshness: obs.freshness } }),
      stale: facts !== undefined && (facts.state === "unknown" || obs?.freshness === "stale") && facts.state !== "closed",
      uncertain, blockers, advice,
      ...(wait === undefined ? {} : { waiting: { reason: wait.reason, resolver: wait.resolver, ...(wait.deadline === undefined ? {} : { deadline: wait.deadline }) } }),
      paused, cite: cite("task", id, revision),
    };
  }

  #rowLine(r: OverviewRow): Line {
    const parts: string[] = [`${r.title} is ${STATE_WORDS[r.state]}`];
    if (r.owner !== undefined) parts.push(`owned by ${r.owner.id}`);
    if (r.execution === "working" && r.observation !== undefined) parts.push(`work was seen ${plainDuration(r.observation.ageMs)} ago`);
    else if (r.execution === "unknown") parts.push(r.observation === undefined ? "recorded as running, but no sign of work has been seen" : `recorded as running, but the last sign of work is ${plainDuration(r.observation.ageMs)} old (${FRESH_WORDS[r.observation.freshness]})`);
    else if (r.execution === "paused") parts.push("paused");
    else if (r.execution === "assigned_not_started") parts.push("not started yet");
    if (r.waiting !== undefined) parts.push(`waiting for ${r.waiting.resolver} (${r.waiting.reason})`);
    if (r.blockers > 0) parts.push(`${r.blockers} blocker${r.blockers === 1 ? "" : "s"}`);
    if (r.uncertain.length > 0) parts.push(`uncertain: ${r.uncertain.join("; ")}`);
    return line(`${parts.join(", ")}.`, r.cite);
  }

  // ---- what changed ------------------------------------------------------------------------------------------------------------

  /**
   * What changed in a project since a time, from the records the caller may read: tasks, ownership, waits, blockers, stall concerns and artifacts. The newest `limit` are listed, `total` says how many matched.
   * A project the caller cannot read answers like an empty one.
   */
  async changes(by: Principal, query: { projectId: string; since: string; limit?: number }): Promise<Changes | undefined> {
    onlyKnown(query, ["projectId", "since", "limit"]);
    const project = checkProjectId(query.projectId);
    const since = typeof query.since === "string" && query.since.length <= STATUS_LIMITS.since && TIMESTAMP.test(query.since) ? query.since : invalid("since", "must be a UTC timestamp such as 2026-10-20T12:00:00.000Z");
    const limit = this.#limit(query.limit);
    const now = this.#runner.now();
    if (by.kind === "owner" && (await this.#runner.get("project", project)) === undefined) return undefined;
    const found: StatusChange[] = [];
    let partial = false;
    const readable = new Map<string, boolean>();
    const taskReadable = async (taskId: string): Promise<boolean> => {
      if (!readable.has(taskId)) { const t = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined; readable.set(taskId, t !== undefined && t.projectId === project && this.#mayReadTask(by, project, taskId)); }
      return readable.get(taskId)!;
    };
    const sweep = async (kind: string, visit: (a: Aggregate) => Promise<void>): Promise<void> => {
      let after: string | undefined;
      for (let reads = 0; ; reads++) {
        if (reads >= this.#pages) { partial = true; return; }
        const page = await this.#runner.list(kind, { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
        for (const a of page) { after = a.id; await visit(a); }
        if (page.length < this.#pageSize) return;
      }
    };
    await sweep("task", async (a) => {
      const t = a.body as unknown as TaskBody;
      if (t.projectId !== project || a.updatedAt <= since || !this.#mayReadTask(by, project, a.id)) return;
      found.push({ at: a.updatedAt, what: a.createdAt > since ? "task created" : "task changed", summary: `${shown(t.title)} is now ${STATE_WORDS[t.state]}.`, cite: cite("task", a.id, a.revision) });
    });
    await sweep("assignment", async (a) => {
      const s = a.body as unknown as AssignmentBody;
      if (a.updatedAt <= since || !(await taskReadable(s.taskId))) return;
      const t = (await this.#runner.get("task", s.taskId))?.body as unknown as TaskBody;
      if (!this.#mayReadAssignment(by, project, s.taskId, view<AssignmentBody>(a))) return;
      found.push({ at: a.updatedAt, what: "ownership", summary: s.state === "assigned" && s.owner !== undefined ? `${shown(t.title)} is owned by ${s.owner.id} (${s.attempts} attempt${s.attempts === 1 ? "" : "s"} so far).` : `${shown(t.title)} has no owner now.`, cite: cite("assignment", a.id, a.revision) });
    });
    await sweep("wait", async (a) => {
      const w = a.body as unknown as WaitBody;
      if (a.updatedAt <= since || !(await taskReadable(w.taskId))) return;
      found.push({ at: a.updatedAt, what: w.state === "open" ? "wait opened" : "wait closed", summary: w.state === "open" ? `Waiting for ${w.resolver} (${w.reason}): ${shown(w.summary)}` : `A wait for ${w.resolver} ended as ${w.outcome ?? w.state}.`, cite: cite("wait", a.id, a.revision) });
    });
    await sweep("blocker", async (a) => {
      const b = a.body as unknown as BlockerBody;
      if (a.updatedAt <= since) return;
      const tasks = await this.#tasksOfBlocker(view<BlockerBody>(a));
      let ok = false;
      for (const t of tasks) if (await taskReadable(t)) ok = true;
      if (!ok) return;
      let toolsOk = false;
      for (const t of tasks) if (await taskReadable(t) && this.#mayReadTools(by, project, t)) toolsOk = true;
      const bv = this.#blockerView(view<BlockerBody>(a), by.kind === "owner", toolsOk);
      found.push({ at: a.updatedAt, what: b.state === "open" ? "blocker opened" : "blocker resolved", summary: b.state === "open" ? `${bv.words}: ${bv.summary}` : bv.masked || (b.subject.kind === "wait-ring" && by.kind !== "owner") ? "A blocker about an outside action was resolved." : `A blocker was resolved: ${shown(b.resolution)}`, cite: cite("blocker", bv.id, a.revision) });
    });
    if (this.#deps.stall !== undefined) await sweep("stall-concern", async (a) => {
      const c = a.body as unknown as ConcernBody;
      if (c.projectId !== project || c.lastChangedAt <= since || !(await taskReadable(c.taskId)) || !this.#mayReadAssignment(by, project, c.taskId, undefined, true)) return;
      found.push({ at: c.lastChangedAt, what: `concern ${c.state}`, summary: `${c.state === "suspected" ? "Suspected" : c.state === "confirmed" ? "Confirmed" : c.state === "dismissed" ? "Dismissed" : "Cleared"}: ${shown(c.detail)}`, cite: cite("stall-concern", a.id, a.revision) });
    });
    if (this.#mayReadArtifacts(by, project)) await sweep("artifact", async (a) => {
      const art = a.body as unknown as ArtifactBody;
      if (art.projectId !== project || a.createdAt <= since) return;
      found.push({ at: a.createdAt, what: "artifact", summary: `Artifact ${shown(art.name)} was recorded (${art.entries.length} file${art.entries.length === 1 ? "" : "s"}).`, cite: cite("artifact", a.id, a.revision) });
    });
    found.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.cite.id < y.cite.id ? -1 : 1));
    const items = found.slice(0, limit);
    const lines: Line[] = items.map((c) => line(`${c.at}: ${c.summary}`, c.cite));
    if (found.length === 0) lines.push(line(`Nothing you may read has changed since ${since}.`, cite("project", project)));
    if (found.length > items.length) lines.push(line(`${found.length - items.length} older change${found.length - items.length === 1 ? "" : "s"} since ${since} are not listed.`, cite("project", project)));
    if (partial) lines.push(line("The search stopped before every record was read, so some changes may be missing.", cite("project", project)));
    return { observedAt: now, since, items, total: found.length, partial, lines };
  }

  // ---- tools used ------------------------------------------------------------------------------------------------------------

  /**
   * Which tools were used on a task or in a project: each MCP call with its server and capability, the outcome (unknown outcomes are said to be unknown), and the outside actions the effect ledger holds. Needs
   * the history or work rights the MCP activity list needs. A call is activity, not progress: no line says a call delivered anything.
   */
  async tools(by: Principal, query: { projectId?: string; taskId?: string; since?: string; limit?: number }): Promise<ToolsUsed | undefined> {
    onlyKnown(query, ["projectId", "taskId", "since", "limit"]);
    if ((query.projectId === undefined) === (query.taskId === undefined)) return invalid("projectId", "give exactly one of projectId and taskId");
    const since = query.since === undefined ? undefined : TIMESTAMP.test(query.since) && query.since.length <= STATUS_LIMITS.since ? query.since : invalid("since", "must be a UTC timestamp such as 2026-10-20T12:00:00.000Z");
    const limit = this.#limit(query.limit);
    const now = this.#runner.now();
    let taskIds: string[];
    let projectId: string;
    let partial = false;
    if (query.taskId !== undefined) {
      const id = checkTaskId(query.taskId);
      const t = (await this.#runner.get("task", id))?.body as unknown as TaskBody | undefined;
      if (t === undefined || !this.#mayReadTools(by, t.projectId, id)) return undefined;
      taskIds = [id]; projectId = t.projectId;
    } else {
      projectId = checkProjectId(query.projectId);
      if (by.kind === "owner" && (await this.#runner.get("project", projectId)) === undefined) return undefined;
      taskIds = [];
      let after: string | undefined;
      for (let reads = 0; ; reads++) {
        if (reads >= this.#pages) { partial = true; break; }
        const page = await this.#runner.list("task", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
        for (const a of page) { after = a.id; if ((a.body as unknown as TaskBody).projectId === projectId && this.#mayReadTools(by, projectId, a.id)) taskIds.push(a.id); }
        if (page.length < this.#pageSize) break;
      }
    }
    const wanted = new Set(taskIds);
    const calls: ToolUse[] = [];
    for (const taskId of taskIds) {
      let after: string | undefined;
      for (let reads = 0; ; reads++) {
        if (reads >= this.#pages) { partial = true; break; }
        const page = await this.#runner.list(`mcp-call-${taskId}`, { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
        for (const a of page) {
          after = a.id;
          const c = a.body as unknown as CallBody;
          if (since !== undefined && c.at <= since) continue;
          calls.push({ id: a.id, taskId, server: shown(c.serverName, 80), capability: `${c.capability.kind}:${shown(c.capability.name, 120)}`, outcome: c.outcome ?? "not finished", uncertain: c.uncertain === true || c.state === "started", at: c.at, protocolRevision: c.protocolRevision, catalogRevision: c.catalogRevision });
        }
        if (page.length < this.#pageSize) break;
      }
    }
    const effects: EffectUse[] = [];
    if (wanted.size > 0) {
      let after: string | undefined;
      for (let reads = 0; ; reads++) {
        if (reads >= this.#pages) { partial = true; break; }
        const page = await this.#runner.list("effect", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
        for (const a of page) {
          after = a.id;
          const e = a.body as unknown as { taskId?: string; kind: string; target: string };
          if (e.taskId === undefined || !wanted.has(e.taskId) || (since !== undefined && a.createdAt <= since)) continue;
          const ledger = await this.#storage.getEffect(a.id);
          effects.push({ id: a.id, taskId: e.taskId, kind: shown(e.kind, 60), target: shown(e.target, 120), status: ledger?.status ?? "unknown", at: a.createdAt });
        }
        if (page.length < this.#pageSize) break;
      }
    }
    calls.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.id < y.id ? -1 : 1));
    effects.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.id < y.id ? -1 : 1));
    const groups = new Map<string, { server: string; capability: string; calls: number; ok: number; errors: number; uncertain: number }>();
    for (const c of calls) {
      const key = `${c.server}\0${c.capability}`;
      const g = groups.get(key) ?? { server: c.server, capability: c.capability, calls: 0, ok: 0, errors: 0, uncertain: 0 };
      g.calls++; if (c.outcome === "ok") g.ok++; else if (c.outcome === "error") g.errors++; if (c.uncertain) g.uncertain++;
      groups.set(key, g);
    }
    const summary = [...groups.values()].sort((x, y) => y.calls - x.calls || (x.server + x.capability < y.server + y.capability ? -1 : 1));
    const lines: Line[] = [];
    for (const g of summary) lines.push(line(`${g.server}, ${g.capability}: ${g.calls} call${g.calls === 1 ? "" : "s"} (${g.ok} ok, ${g.errors} failed${g.uncertain > 0 ? `, ${g.uncertain} with an unknown outcome` : ""}).`, ...calls.filter((c) => c.server === g.server && c.capability === g.capability).slice(0, 5).map((c) => cite(`mcp-call-${c.taskId}`, c.id))));
    for (const e of effects.slice(0, limit)) lines.push(line(`Outside action ${e.kind} on ${e.target}: ${e.status}.`, cite("effect", e.id), cite("task", e.taskId)));
    if (calls.length === 0 && effects.length === 0) lines.push(line("No tool use is recorded for this scope, among what you may read.", cite(query.taskId === undefined ? "project" : "task", query.taskId ?? projectId)));
    else lines.push(line("A tool call is activity, not progress; what was delivered is a separate question.", cite(query.taskId === undefined ? "project" : "task", query.taskId ?? projectId)));
    if (partial) lines.push(line("The search stopped before every record was read, so some tool use may be missing.", cite("project", projectId)));
    return { observedAt: now, summary, calls: calls.slice(0, limit), effects: effects.slice(0, limit), total: calls.length + effects.length, partial, lines };
  }

  // ---- what was delivered -------------------------------------------------------------------------------------------------------

  /**
   * What the records say was delivered in a project: the artifacts published for it, each verified against its files when a verifier is wired (a missing or damaged artifact is reported, not counted), and the tasks
   * marked done that have no artifact. Needs `artifact.read`. Done and delivered are different things, and neither is inferred from the other.
   */
  async delivered(by: Principal, query: { projectId: string; taskId?: string; since?: string }): Promise<Delivered | undefined> {
    onlyKnown(query, ["projectId", "taskId", "since"]);
    const project = checkProjectId(query.projectId);
    const taskFilter = query.taskId === undefined ? undefined : checkTaskId(query.taskId);
    const since = query.since === undefined ? undefined : TIMESTAMP.test(query.since) && query.since.length <= STATUS_LIMITS.since ? query.since : invalid("since", "must be a UTC timestamp such as 2026-10-20T12:00:00.000Z");
    const now = this.#runner.now();
    if (by.kind === "owner" && (await this.#runner.get("project", project)) === undefined) return undefined;
    let partial = false;
    const artifacts: DeliveredArtifact[] = [];
    const lines: Line[] = [];
    const hasArtifacts = new Set<string>();
    const mayArtifacts = this.#mayReadArtifacts(by, project);
    let verified = 0;
    if (mayArtifacts) {
      let after: string | undefined;
      for (let reads = 0; ; reads++) {
        if (reads >= this.#pages) { partial = true; break; }
        const page = await this.#runner.list("artifact", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
        for (const a of page) {
          after = a.id;
          const art = a.body as unknown as ArtifactBody;
          if (art.projectId !== project) continue;
          if (art.taskId !== undefined) hasArtifacts.add(art.taskId);
          if ((taskFilter !== undefined && art.taskId !== taskFilter) || (since !== undefined && a.createdAt <= since)) continue;
          let verification: DeliveredArtifact["verification"] = "not_checked";
          if (this.#deps.verifyArtifact !== undefined && verified < (this.#options.verifyLimit ?? 20)) {
            verified++;
            try { verification = (await this.#deps.verifyArtifact(a.id)).ok ? "verified" : "damaged"; } catch { verification = "damaged"; }
          }
          artifacts.push({ id: a.id, name: shown(art.name, 120), ...(art.taskId === undefined ? {} : { taskId: art.taskId }), files: art.entries.length, bytes: art.totalBytes, manifestDigest: art.manifestDigest, recordedAt: a.createdAt, verification });
        }
        if (page.length < this.#pageSize) break;
      }
    }
    artifacts.sort((x, y) => (x.recordedAt < y.recordedAt ? 1 : x.recordedAt > y.recordedAt ? -1 : x.id < y.id ? -1 : 1));
    for (const a of artifacts) {
      const how = a.verification === "verified" ? "its files were checked and match" : a.verification === "damaged" ? "its files are missing or do not match, so it is NOT counted as delivered" : "its files have not been checked";
      lines.push(line(`Artifact ${a.name} (${a.files} file${a.files === 1 ? "" : "s"}) was recorded ${a.recordedAt}; ${how}.`, cite("artifact", a.id), ...(a.taskId === undefined ? [] : [cite("task", a.taskId)])));
    }
    const doneWithout: { taskId: string; title: string }[] = [];
    if (mayArtifacts || by.kind === "owner") {
      let after: string | undefined;
      for (let reads = 0; ; reads++) {
        if (reads >= this.#pages) { partial = true; break; }
        const page = await this.#runner.list("task", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
        for (const a of page) {
          after = a.id;
          const t = a.body as unknown as TaskBody;
          if (t.projectId !== project || t.state !== "done" || hasArtifacts.has(a.id) || (taskFilter !== undefined && a.id !== taskFilter) || (since !== undefined && a.updatedAt <= since) || !this.#mayReadTask(by, project, a.id)) continue;
          doneWithout.push({ taskId: a.id, title: shown(t.title) });
          lines.push(line(`${shown(t.title)} is marked done, but no artifact is recorded for it, so nothing is recorded as delivered.`, cite("task", a.id, a.revision)));
        }
        if (page.length < this.#pageSize) break;
      }
    }
    if (!mayArtifacts) lines.push(line("Artifacts are not shown to you.", cite("project", project)));
    if (lines.length === 0) lines.push(line("Nothing is recorded as delivered for this scope.", cite("project", project)));
    if (partial) lines.push(line("The search stopped before every record was read, so some items may be missing.", cite("project", project)));
    return { observedAt: now, artifacts, doneWithoutArtifact: doneWithout, partial, lines };
  }

  // ---- the noticeboard ---------------------------------------------------------------------------------------------------------

  /**
   * A permission-filtered summary of a project for anyone who works in it: current assignments, the latest stand-up report of each agent (its newest shared progress note) and the latest deliverables, each with a link to
   * the record (the detail stays on its owner's desk). A part the caller may not read is left out and named in `withheld`.
   */
  async noticeboard(by: Principal, projectId: string): Promise<Noticeboard | undefined> {
    const project = checkProjectId(projectId);
    const now = this.#runner.now();
    const nowMs = Date.parse(now);
    if (by.kind === "owner" && (await this.#runner.get("project", project)) === undefined) return undefined;
    const withheld: string[] = [];
    let partial = false;
    const assignments: Noticeboard["assignments"][number][] = [];
    let after: string | undefined;
    tasks: for (let reads = 0; ; reads++) {
      if (reads >= this.#pages) { partial = true; break; }
      const page = await this.#runner.list("task", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
      for (const a of page) {
        after = a.id;
        const t = a.body as unknown as TaskBody;
        if (t.projectId !== project || (t.state !== "ready" && t.state !== "in_progress" && t.state !== "blocked") || !this.#mayReadTask(by, project, a.id)) continue;
        const asg = await this.#deps.assignments.getAssignment(a.id);
        const sees = this.#mayReadAssignment(by, project, a.id, asg);
        if (!sees && !withheld.includes("who owns the tasks")) withheld.push("who owns the tasks");
        assignments.push({ taskId: a.id, title: shown(t.title), state: t.state, ...(sees && asg?.state === "assigned" && asg.owner !== undefined ? { owner: `${asg.owner.kind}:${asg.owner.id}` } : {}), link: cite("task", a.id, a.revision) });
        if (assignments.length >= STATUS_LIMITS.page) { partial = true; break tasks; }
      }
      if (page.length < this.#pageSize) break;
    }
    // Stand-up reports: the newest shared, accepted progress note of each agent, found from the desks. The reader's own right to read each record decides what appears.
    const latest = new Map<string, { id: string; revision: number; body: DeskRecordBody; at: string }>();
    after = undefined;
    for (let reads = 0; ; reads++) {
      if (reads >= this.#pages) { partial = true; break; }
      const page = await this.#runner.list("desk-record", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
      for (const a of page) {
        after = a.id;
        const d = a.body as unknown as DeskRecordBody;
        if (d.projectId !== project || d.kind !== "progress" || d.visibility !== "shared" || d.status !== "accepted" || !deskCanRead(by, d)) continue;
        const prev = latest.get(d.owner);
        if (prev === undefined || prev.at < a.updatedAt || (prev.at === a.updatedAt && prev.id < a.id)) latest.set(d.owner, { id: a.id, revision: a.revision, body: d, at: a.updatedAt });
      }
      if (page.length < this.#pageSize) break;
    }
    const standups = [...latest.values()].sort((x, y) => (x.at < y.at ? 1 : -1)).slice(0, STATUS_LIMITS.page).map((r) => ({ recordId: r.id, owner: r.body.owner, title: shown(r.body.title, 120), status: r.body.status, ...(r.body.taskId === undefined ? {} : { taskId: r.body.taskId }), at: r.at, stale: nowMs - Date.parse(r.at) > (this.#options.standupStaleAfterMs ?? 36 * 3_600_000), desk: cite("desk", r.body.owner), link: cite("desk-record", r.id, r.revision) }));
    if (by.kind !== "owner" && !allows(by, "desk.read", project)) withheld.push("stand-up reports");
    const deliverables: Noticeboard["deliverables"][number][] = [];
    if (this.#mayReadArtifacts(by, project)) {
      const found: { id: string; revision: number; art: ArtifactBody; at: string }[] = [];
      after = undefined;
      for (let reads = 0; ; reads++) {
        if (reads >= this.#pages) { partial = true; break; }
        const page = await this.#runner.list("artifact", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
        for (const a of page) { after = a.id; const art = a.body as unknown as ArtifactBody; if (art.projectId === project) found.push({ id: a.id, revision: a.revision, art, at: a.createdAt }); }
        if (page.length < this.#pageSize) break;
      }
      found.sort((x, y) => (x.at < y.at ? 1 : x.at > y.at ? -1 : x.id < y.id ? -1 : 1));
      for (const f of found.slice(0, STATUS_LIMITS.board)) deliverables.push({ artifactId: f.id, name: shown(f.art.name, 120), ...(f.art.taskId === undefined ? {} : { taskId: f.art.taskId }), at: f.at, link: cite("artifact", f.id, f.revision) });
    } else withheld.push("deliverables");
    const lines: Line[] = [];
    for (const a of assignments) lines.push(line(`${a.title} is ${STATE_WORDS[a.state]}${a.owner === undefined ? "" : `, owned by ${a.owner}`}.`, a.link));
    for (const s of standups) lines.push(line(`Latest report from ${s.owner}: ${s.title} (${s.at})${s.stale ? ", which is old" : ""}. Details are on their desk.`, s.link, s.desk));
    for (const d of deliverables) lines.push(line(`Deliverable: ${d.name}, recorded ${d.at}.`, d.link));
    if (lines.length === 0) lines.push(line("Nothing you may read is on the noticeboard for this project yet.", cite("project", project)));
    if (withheld.length > 0) lines.push(line(`Not shown to you: ${withheld.join("; ")}.`, cite("project", project)));
    if (partial) lines.push(line("The search stopped before every record was read, so the board may be incomplete.", cite("project", project)));
    return { observedAt: now, projectId: project, assignments, standups, deliverables, withheld, partial, lines };
  }

  // ---- the failed event queue --------------------------------------------------------------------------------------------------

  /** The event handlings that failed or died, as the event service lists them for this caller (the owner sees all; others the projects whose histories they may read). */
  async failedEvents(by: Principal, query: { projectId?: string; taskId?: string; afterId?: string; limit?: number } = {}): Promise<FailedEvents | undefined> {
    onlyKnown(query, ["projectId", "taskId", "afterId", "limit"]);
    if (this.#deps.watch === undefined) return undefined;
    const limit = this.#limit(query.limit);
    const now = this.#runner.now();
    const page = await this.#deps.watch.failures(by, {
      limit,
      ...(query.projectId === undefined ? {} : { projectId: checkProjectId(query.projectId) }), ...(query.taskId === undefined ? {} : { taskId: checkTaskId(query.taskId) }),
      ...(query.afterId === undefined ? {} : { afterId: query.afterId }),
    });
    const items = page.items.map((h) => ({ id: h.id, taskId: h.taskId, projectId: h.projectId, state: h.state, stream: shown(h.stream, 80), attempts: h.attempts, ...(h.failure === undefined ? {} : { failedBy: h.failure.by, failedAt: h.failure.at, error: shown(h.failure.error, 200), ...(h.failure.nextAttemptAt === undefined ? {} : { nextAttemptAt: h.failure.nextAttemptAt }) }) }));
    const lines: Line[] = items.map((i) => line(`${i.state === "dead" ? "Gave up on" : "Failed to hand over"} events for task ${i.taskId} after ${i.attempts} attempt${i.attempts === 1 ? "" : "s"}${i.failedBy === undefined ? "" : ` (${i.failedBy === "delivery" ? "could not be delivered" : i.failedBy === "agent" ? "the agent reported failure" : "the agent did not report in time"}: ${i.error})`}${i.nextAttemptAt === undefined ? "" : `; next retry ${i.nextAttemptAt}`}.`, cite("event-handling", i.id), cite("task", i.taskId)));
    if (items.length === 0) lines.push(line("The failed event queue is empty, among what you may read.", cite("event-handling", "queue")));
    if (page.scanLimited === true) lines.push(line("The search stopped before the end of the queue; ask again from the cursor to carry on.", cite("event-handling", "queue")));
    return { observedAt: now, items, ...(page.next === undefined ? {} : { next: page.next }), scanLimited: page.scanLimited === true, lines };
  }

  /** One failed handling in full, with the text that came with its events shown as untrusted data. Unreadable reads like missing. */
  async inspectFailedEvent(by: Principal, handlingId: string): Promise<FailedEventDetail | undefined> {
    if (typeof handlingId !== "string" || !HANDLING_ID.test(handlingId)) return invalid("handlingId", "is not an event handling ID");
    if (this.#deps.watch === undefined) return undefined;
    const found = await this.#deps.watch.inspect(by, handlingId);
    if (found === undefined) return undefined;
    const h = found.handling as View<HandlingBody>;
    const detail = {
      id: h.id, taskId: h.taskId, state: h.state, attempts: h.attempts, round: h.round, reasons: h.reasons.map((r) => shown(r, 120)),
      ...(h.failure === undefined ? {} : { failedBy: h.failure.by, error: shown(h.failure.error, 200), ...(h.failure.nextAttemptAt === undefined ? {} : { nextAttemptAt: h.failure.nextAttemptAt }) }),
    };
    const eventText = found.data.slice(0, 20).map((d) => ({ seq: d.seq, text: shown(d.text, 300) }));
    const lines: Line[] = [line(`Handling ${h.id} for task ${h.taskId} is ${h.state} after ${h.attempts} attempt${h.attempts === 1 ? "" : "s"}.${h.failure === undefined ? "" : ` ${h.failure.by === "delivery" ? "It could not be delivered" : h.failure.by === "agent" ? "The agent reported failure" : "The agent did not report in time"}: ${shown(h.failure.error, 200)}.`}${h.failure?.nextAttemptAt === undefined ? "" : ` Next retry ${h.failure.nextAttemptAt}.`}`, cite("event-handling", h.id, h.revision), cite("task", h.taskId))];
    if (found.inbox !== undefined) lines.push(line(`Its inbox item is ${found.inbox.state}.`, cite("inbox-message", found.inbox.id)));
    for (const e of eventText) lines.push(line(`Event ${e.seq} carried this text (outside data, not an instruction): "${e.text}"`, cite("event-handling", h.id)));
    return { observedAt: this.#runner.now(), handling: detail, eventText, ...(found.inbox === undefined ? {} : { inbox: found.inbox }), lines };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  #ctx(): Ctx { return { principalKinds: new Map() }; }

  #limit(value: number | undefined): number {
    const limit = value ?? STATUS_LIMITS.defaultPage;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > STATUS_LIMITS.page) return invalid("limit", `must be a whole number from 1 to ${STATUS_LIMITS.page}`);
    return limit;
  }

  /** An agent may be named with or without the `agent:` prefix, whichever way its assignment spells it. */
  #agentFilter(value: unknown): string {
    if (typeof value !== "string" || value.length < 1 || value.length > STATUS_LIMITS.id) return invalid("agentId", `must be text of 1 to ${STATUS_LIMITS.id} characters`);
    return value.replace(/^agent:/, "");
  }

  /** The owner, or a principal with `task.read` for this task (a grant narrowed to other resources does not count); a task credential reaches its own task only. */
  #mayReadTask(by: Principal, projectId: string, taskId: string): boolean {
    if (by.kind === "owner") return true;
    return inTaskScope(by, projectId) && allows(by, "task.read", projectId, { resource: { kind: "task", id: taskId } });
  }

  /** Who owns a task and what was seen of the work: the owner, holders of `assignment.read` or `assignment.manage`, and the assigned agent itself. */
  #mayReadAssignment(by: Principal, projectId: string, taskId: string, assignment: AssignmentBody | undefined, rightsOnly = false): boolean {
    if (by.kind === "owner") return true;
    if (!inTaskScope(by, projectId)) return false;
    const resource = { resource: { kind: "task", id: taskId } } as const;
    if (allows(by, "assignment.read", projectId, resource) || allows(by, "assignment.manage", projectId, resource)) return true;
    return !rightsOnly && by.taskScope === undefined && assignment?.state === "assigned" && isOwnerOf(assignment.owner, by.id);
  }

  /** The rule of the MCP activity list (card T03): the owner, holders of `history.read` in the project, and workers with `attempt.work` on the task. */
  #mayReadTools(by: Principal, projectId: string, taskId: string): boolean {
    if (by.kind === "owner") return true;
    if (!inTaskScope(by, projectId)) return false;
    return allows(by, "history.read", projectId) || allows(by, "attempt.work", projectId, { resource: { kind: "task", id: taskId } });
  }

  #mayReadArtifacts(by: Principal, projectId: string): boolean {
    return by.kind === "owner" || (inTaskScope(by, projectId) && allows(by, "artifact.read", projectId));
  }

  async #execution(body: TaskBody, taskId: string, assignment: AssignmentBody | undefined, attempt: AttemptBody | undefined, nowMs: number, paused: boolean): Promise<ExecutionFacts> {
    const contract = (await this.#runner.get("task-contract", taskId))?.body as unknown as ContractBody | undefined;
    const difficulty: Difficulty = contract?.difficulty ?? "medium";
    const activity = (await this.#deps.assignments.getActivity(taskId)) as ActivityBody | undefined;
    const stored = (await this.#runner.get("stall-evidence", taskId))?.body as unknown as EvidenceBody | undefined;
    const facts = executionOf({
      taskState: body.state, assignment, attempt, activity,
      evidence: stored === undefined ? undefined : { lastProgressAt: stored.lastProgressAt, reportedBy: stored.reportedBy, generation: stored.generation },
      paused, now: nowMs, staleAfterMs: this.#options.staleAfterMs ?? DEFAULT_THRESHOLDS[difficulty].silenceMs,
    });
    // A host that reported for the owner and has gone quiet, or whose identity was revoked, makes a fresh-looking sign less certain.
    const by = facts.observation?.by;
    if (by !== undefined && by.startsWith("host:") && facts.state === "working") {
      const principal = (await this.#runner.get("principal", by))?.body as unknown as PrincipalBody | undefined;
      const record = (await this.#runner.get("host-record", by))?.body as unknown as { lastSeenAt?: string } | undefined;
      const hostFresh = hostFreshness(record?.lastSeenAt, new Date(nowMs).toISOString(), this.#options.hostStaleAfterMs ?? DEFAULT_HOST_STALE_AFTER_MS);
      if (principal?.state === "disabled") return { state: "unknown", ...(facts.observation === undefined ? {} : { observation: facts.observation }), uncertainty: [...facts.uncertainty, `the host ${by} that reported the work has been revoked`] };
      if (hostFresh !== "fresh") return { state: "unknown", ...(facts.observation === undefined ? {} : { observation: facts.observation }), uncertainty: [...facts.uncertainty, `the host ${by} that reported the work has not been heard from lately`] };
    }
    return facts;
  }

  #ownerLines(taskId: string, assignment: View<AssignmentBody> | undefined, owner: TaskStatus["owner"], execution: ExecutionFacts, attempt: View<AttemptBody> | undefined, pause: PauseStatus | undefined): Line[] {
    const out: Line[] = [];
    const asg = assignment === undefined ? cite("task", taskId) : cite("assignment", assignment.id, assignment.revision);
    if (owner === undefined) { out.push(line(assignment?.state === "released" ? "Nobody owns it now; it was released." : "Nobody owns it.", asg)); return out; }
    out.push(line(`Owner of record: ${owner.name === undefined ? owner.id : `${owner.name} (${owner.id})`}, since it was last reassigned. That says who is responsible, not that work is happening.`, asg));
    const o = execution.observation;
    switch (execution.state) {
      case "working": out.push(line(`Work was last seen ${plainDuration(o!.ageMs)} ago${o!.kind === "" ? "" : ` (${shown(o!.kind, 60)}${o!.detail === "" ? "" : `: ${shown(o!.detail, 120)}`})`}, by the owner, since it was last reassigned.`, asg)); break;
      case "unknown": out.push(line(`It is recorded as running, but that is not confirmed: ${execution.uncertainty.length === 0 ? "nothing recent says so" : execution.uncertainty.join("; ")}.`, asg, ...(attempt === undefined ? [] : [cite("attempt", attempt.id)]))); break;
      case "paused": out.push(line(`It is paused (${pause?.gates.map((g) => `${g.scope.kind} ${g.scope.id}${g.gate.observed === undefined ? "" : `, observed ${g.gate.observed.state}`}`).join("; ") ?? "by a gate"}). Intent and what the worker has reached are separate facts.`, asg)); break;
      case "assigned_not_started": out.push(line("It is owned, but no attempt has started.", asg)); break;
      default: break;
    }
    if (execution.state === "working" && o !== undefined && o.freshness !== "fresh") out.push(line(`That sign of work is ${FRESH_WORDS[o.freshness]}.`, asg));
    if (execution.state !== "working" && execution.state !== "unknown" && execution.uncertainty.length > 0) out.push(line(`Uncertain: ${execution.uncertainty.join("; ")}.`, asg));
    return out;
  }

  async #latestAttempt(taskId: string, assignment: View<AssignmentBody>): Promise<View<AttemptBody> | undefined> {
    // Attempts are numbered per task over all generations; the newest is the one whose number equals the count.
    if (assignment.attempts === 0) return undefined;
    if (assignment.activeAttemptId !== undefined) return this.#deps.assignments.getAttempt(assignment.activeAttemptId);
    let after: string | undefined;
    let newest: View<AttemptBody> | undefined;
    for (let reads = 0; reads < this.#pages; reads++) {
      const page = await this.#runner.list("attempt", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
      for (const a of page) { after = a.id; const b = a.body as unknown as AttemptBody; if (b.taskId === taskId && (newest === undefined || b.number > newest.number)) newest = view<AttemptBody>(a); }
      if (page.length < this.#pageSize) break;
    }
    return newest;
  }

  async #pendingOf(by: Principal, taskId: string, task: View<TaskBody>, pending: Pending[], toolsOk: boolean): Promise<void> {
    // Edges are read here, not through the contract service, so that an unfinished prerequisite the reader may not read still shows as "something you cannot see".
    let after: string | undefined;
    for (let reads = 0; ; reads++) {
      if (reads >= this.#pages) { pending.push({ kind: "dependency_check_incomplete" }); break; }
      const page = await this.#runner.list("task-dep", { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
      for (const a of page) {
        after = a.id;
        const e = a.body as unknown as DependencyBody;
        if (e.taskId !== taskId || e.state !== "active") continue;
        const pre = (await this.#runner.get("task", e.prerequisiteId))?.body as unknown as TaskBody | undefined;
        if (pre === undefined || pre.state === "done") continue;
        if (!this.#mayReadTask(by, pre.projectId, e.prerequisiteId)) { pending.push({ kind: "hidden_dependency" }); continue; }
        pending.push({ kind: "dependency", prerequisiteId: e.prerequisiteId, title: shown(pre.title), state: pre.state, willNotFinish: pre.state === "cancelled", ...(e.responsible === undefined ? {} : { responsible: shown(e.responsible, 80) }) });
      }
      if (page.length < this.#pageSize) break;
    }
    const wait = await this.#deps.waits.openFor(taskId);
    if (wait !== undefined) pending.push({ kind: "wait", waitId: wait.id, reason: wait.reason, resolver: shown(wait.resolver, 80), summary: shown(wait.summary, 300), nextAction: shown(wait.nextAction, 200), ...(wait.deadline === undefined ? {} : { deadline: wait.deadline }), ...(wait.onDeadline === undefined ? {} : { onDeadline: wait.onDeadline }), ...(wait.indefinite === undefined ? {} : { indefiniteOwner: shown(wait.indefinite.owner, 80) }) });
    // The announcement of the task's latest change, if it has not gone out yet: the retry that is pending.
    const delivery = await this.#storage.getDelivery(taskEventId(taskId, task.revision));
    if (delivery !== undefined && delivery.state !== "delivered" && delivery.attempts > 0) pending.push({ kind: "retry", what: "task_event_delivery", id: delivery.deliveryId, attempts: delivery.attempts, nextAttemptAt: delivery.nextAttemptAt, ...(delivery.lastError === undefined || !toolsOk ? {} : { lastError: shown(delivery.lastError, 200) }) });
    if (this.#deps.watch !== undefined) {
      const failed = await this.#deps.watch.failures(by, { taskId, limit: 5 });
      for (const h of failed.items) if (h.state === "failed") pending.push({ kind: "retry", what: "event_handling", id: h.id, attempts: h.attempts, ...(h.failure?.nextAttemptAt === undefined ? {} : { nextAttemptAt: h.failure.nextAttemptAt }), ...(h.failure === undefined || !toolsOk ? {} : { lastError: shown(h.failure.error, 200) }) });
    }
  }

  #pendingLine(p: Pending, taskId: string, viewerIsOwner: boolean): Line {
    switch (p.kind) {
      case "dependency_check_incomplete": return line("The dependency check did not finish, so some dependencies may be missing from this answer.", cite("task", taskId));
      case "hidden_dependency": return line("It is waiting on something you cannot see.", cite("task", taskId));
      case "dependency": return line(p.willNotFinish ? `It depends on ${p.title}, which was cancelled and will never finish; the dependency has to change.` : `It is waiting for ${p.title} (${p.prerequisiteId}), which is ${STATE_WORDS[p.state]}${p.responsible === undefined ? "" : `; ${p.responsible} is answerable for it`}.`, cite("task", p.prerequisiteId), cite("task", taskId));
      case "wait": return line(`Waiting for ${whoText(p.resolver, viewerIsOwner)} (${p.reason}): ${p.summary} When answered: ${p.nextAction}. ${p.deadline !== undefined ? `Deadline ${p.deadline}; then it will ${p.onDeadline === "resume" ? "resume" : p.onDeadline === "cancel" ? "be cancelled" : "stay blocked and be flagged"}.` : `No deadline; ${p.indefiniteOwner ?? "its owner"} holds it.`}`, cite("wait", p.waitId), cite("task", taskId));
      default: return line(p.what === "task_event_delivery" ? `The announcement of its latest change has not gone out yet: ${p.attempts} attempt${p.attempts === 1 ? "" : "s"} so far${p.nextAttemptAt === undefined ? "" : `, next try ${p.nextAttemptAt}`}${p.lastError === undefined ? "" : `, last error: ${p.lastError}`}.` : `Events for it could not be handed over (${p.attempts} attempt${p.attempts === 1 ? "" : "s"})${p.nextAttemptAt === undefined ? "" : `; next retry ${p.nextAttemptAt}`}${p.lastError === undefined ? "" : `: ${p.lastError}`}.`, cite(p.what === "task_event_delivery" ? "delivery" : "event-handling", p.id), cite("task", taskId));
    }
  }

  #blockerView(b: View<BlockerBody>, viewerIsOwner: boolean, toolsOk: boolean): BlockerView {
    const basis = b.basis ?? defaultBasis(b.type);
    // A ring's summary lists every task in it; a reader who is not the owner may not be allowed to see them all. The summary of an effect, attempt, delivery or message blocker names the action, destination
    // or error: a reader who may not see tools and outside actions gets a generic sentence.
    const masked = !toolsOk && ["effect", "attempt", "delivery", "inbox-message"].includes(b.subject.kind);
    const summary = b.subject.kind === "wait-ring" && !viewerIsOwner ? "Tasks are waiting for each other in a ring that includes this one." : masked ? "An outside action or message for this task has a problem; the details are not shown to you." : shown(b.summary, 400);
    const words = basis === "owner_hold" && /^(agent|host|service):/.test(b.openedBy) ? `a hold placed by ${shown(b.openedBy, 60)}` : BASIS_WORDS[basis];
    // A masked view carries an opaque ID, so the effect, attempt or delivery it is about cannot be worked out from it.
    const id = masked ? `blk-${createHash("sha256").update(`status-mask\0${b.id}`).digest("hex").slice(0, 20)}` : b.id;
    return { id, words, masked, revision: b.revision, type: b.type, basis, summary, resolver: shown(b.resolver, 80), route: routeFor(b.type, basis, b.resolver, viewerIsOwner), openedAt: b.openedAt, ...(b.nextReviewAt === undefined ? {} : { nextReviewAt: b.nextReviewAt }) };
  }

  /** Open blockers grouped by the task they hold up. Read once per question; a blocker whose task cannot be found is kept apart, and a scan that ends early says so. */
  #index(ctx: Ctx): Promise<BlockerIndex> {
    ctx.index ??= (async () => {
      const byTask = new Map<string, View<BlockerBody>[]>();
      const unmapped: View<BlockerBody>[] = [];
      let after: string | undefined;
      for (let reads = 0; reads < this.#pages; reads++) {
        const page = await this.#deps.blockers.list({ ...(after === undefined ? {} : { afterId: after }), limit: Math.min(100, this.#pageSize), openOnly: true });
        for (const b of page.items) {
          const tasks = await this.#tasksOfBlocker(b);
          if (tasks.length === 0) unmapped.push(b);
          for (const t of tasks) byTask.set(t, [...(byTask.get(t) ?? []), b]);
        }
        if (page.next === undefined) return { byTask, unmapped, partial: false };
        after = page.next;
      }
      return { byTask, unmapped, partial: true };
    })();
    return ctx.index;
  }

  /** The tasks a blocker holds up, from its subject: a task, an effect or attempt (their task), a task event delivery, an inbox message (its payload), or a ring (the tasks named in it). */
  async #tasksOfBlocker(b: View<BlockerBody>): Promise<string[]> {
    const { kind, id } = b.subject;
    const valid = (v: unknown): v is string => typeof v === "string" && /^task-[a-z2-7]{20}$/.test(v);
    if (kind === "task") return valid(id) ? [id] : [];
    if (kind === "effect") { const t = ((await this.#runner.get("effect", id))?.body as unknown as { taskId?: string } | undefined)?.taskId; return valid(t) ? [t] : []; }
    if (kind === "attempt") { const t = ((await this.#runner.get("attempt", id))?.body as unknown as { taskId?: string } | undefined)?.taskId; return valid(t) ? [t] : []; }
    if (kind === "delivery") { const m = /^tev:(task-[a-z2-7]{20}):\d+$/.exec(id); return m?.[1] === undefined ? [] : [m[1]]; }
    if (kind === "inbox-message") { const t = ((await this.#runner.get("inbox-message", id))?.body as unknown as { payload?: { taskId?: unknown } } | undefined)?.payload?.taskId; return valid(t) ? [t] : []; }
    if (kind === "wait-ring") return [...new Set(b.summary.match(TASK_ID_IN_TEXT) ?? [])];
    return [];
  }

  /** The owner decided the outcome when the task was created by the owner or its latest assignment was made by the owner. */
  async #ownerDecided(ctx: Ctx, body: TaskBody, taskId: string): Promise<boolean> {
    const isOwnerPrincipal = async (id: string): Promise<boolean> => {
      if (!ctx.principalKinds.has(id)) ctx.principalKinds.set(id, ((await this.#runner.get("principal", id))?.body as unknown as PrincipalBody | undefined)?.kind);
      return ctx.principalKinds.get(id) === "owner";
    };
    // The latest assignment decides: one made by the owner is the owner's outcome, and a later reassignment by someone else is not. With no assignment, the task's creator decides.
    const history = (await this.#deps.assignments.history(taskId)) as View<GenerationBody>[];
    const last = history.at(-1);
    return last !== undefined ? isOwnerPrincipal(last.assignedBy) : isOwnerPrincipal(body.createdBy);
  }

  /** Open doubts about a task's actions: an effect that may not have happened, a tool call with an unknown outcome, a failed event handling. */
  async #doubts(taskId: string, blockers: readonly View<BlockerBody>[], toolsOk: boolean): Promise<{ text: string; cites: Cite[] }[]> {
    const out: { text: string; cites: Cite[] }[] = [];
    for (const b of blockers) if (b.type === "effect_uncertain") out.push({ text: "an action it took may or may not have happened, and nobody has settled that yet.", cites: [cite("blocker", b.id, b.revision), cite("task", taskId)] });
    {
      let after: string | undefined;
      for (let reads = 0; ; reads++) {
        // A check that could not finish is itself a doubt: "done" is not claimed cleanly over records that were not all read.
        if (reads >= this.#pages) { out.push({ text: "the check for tool calls with an unknown outcome did not finish.", cites: [cite("task", taskId)] }); break; }
        const page = await this.#runner.list(`mcp-call-${taskId}`, { ...(after === undefined ? {} : { afterId: after }), limit: this.#pageSize });
        for (const a of page) { after = a.id; const c = a.body as unknown as CallBody; if ((c.uncertain === true || c.state === "started") && !toolsOk) { if (!out.some((d) => d.cites.length === 1 && d.cites[0]!.kind === "task")) out.push({ text: "an action's outcome is not known.", cites: [cite("task", taskId)] }); } else if (c.uncertain === true || c.state === "started") out.push({ text: `a tool call to ${shown(c.serverName, 60)} (${c.capability.kind}:${shown(c.capability.name, 80)}) has no known outcome.`, cites: [cite(`mcp-call-${taskId}`, a.id), cite("task", taskId)] }); }
        if (page.length < this.#pageSize) break;
      }
    }
    return out;
  }
}
