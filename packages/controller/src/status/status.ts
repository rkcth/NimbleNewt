import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from "node:crypto";
import type { AssignmentService } from "../domain/assignments.js";
import type { ActivityBody, AssignmentBody, AttemptBody, GenerationBody } from "../domain/assignment-model.js";
import { defaultBasis, type BlockerBasis, type BlockerBody, type BlockerService, type BlockerType } from "../domain/blockers.js";
import { versionIdOf } from "../catalog/catalog.js";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { taskEventId } from "../domain/events.js";
import { TASK_STATES, onlyKnown, projectId as checkProjectId, taskId as checkTaskId, type TaskBody, type TaskState, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { WaitBody, WaitService } from "../domain/waits.js";
import type { HandlingBody, WatchService } from "../events/handling.js";
import type { WebBrowser, WebSettings } from "../web/index.js";
import { DEFAULT_THRESHOLDS, type EvidenceBody } from "../health/assess.js";
import type { ConcernBody, StallService } from "../health/stall.js";
import { DEFAULT_HOST_STALE_AFTER_MS, hostFreshness, type Freshness } from "../hosts/hosts.js";
import { quotedLine } from "../decisions/records.js";
import type { TaskHandoffBody } from "../lifecycle/handoff.js";
import { safeSlice } from "../lifecycle/handoff-cut.js";
import type { PauseService, PauseStatus } from "../lifecycle/pause.js";
import type { StopService } from "../lifecycle/stop.js";
import type { CallBody } from "../mcp/mcp.js";
import type { CutoverService } from "../routing/cutover.js";
import { startSizeAlertText, type StartSizeService } from "../context/start-size.js";
import type { JobService } from "../jobs/jobs.js";
import { DISPATCH_KIND, STOPPED_EARLY_KIND, TASK_ATTEMPTS_KIND, WORK_REPORT_KIND, type DispatchBody, type WorkReportTaskBody } from "../dispatch/model.js";
import { ATTEMPT_ENDINGS_LIMITS, ENDING_BLOCKER_WORDS, attemptEndingLines, type EndingBlocker } from "../dispatch/endings.js";
import { reportLines } from "../dispatch/report.js";
import type { ContractBody, ContractService, DependencyBody, Difficulty } from "../planning/contracts.js";
import type { HoldsUp } from "../critical/critical-path.js";
import { canRead as deskCanRead, type DeskRecordBody } from "../context/desks.js";
import { ACTIVITY_KINDS, type ActivityService, type ExplanationBody } from "../activity/activity.js";
import { REPLAY_LABELS, type ReplayService, type ReplayStep } from "../activity/replay.js";
import type { ArtifactBody } from "../artifacts/service.js";
import { allows, inTaskScope } from "../security/access.js";
import type { Principal, PrincipalBody } from "../security/principals.js";
import type { ApprovalsFacade } from "../policy/facade.js";
import type { ActivationStatus, Gate, GateCell, AttemptBody as ReleaseAttemptBody, CandidateRow, ReleaseService } from "../release/index.js";
import type { Aggregate, ControllerStorage } from "../storage/types.js";
import { CAP_NAMES, LIMIT_BOUNDS, type Limits } from "../admission/policy.js";
import type { CapacityLimitsService } from "../admission/caps.js";
import type { AdmissionService } from "../admission/service.js";
import type { EnvironmentService } from "../environments/index.js";
import type { MaintenanceService } from "../maintenance/index.js";
import { SWARM_LIMIT_BOUNDS, type SwarmLimitsService } from "../swarm/limits.js";
import {
  BASIS_WORDS, EXECUTION_STATES, executionOf, isOwnerOf, plainDuration, quoted, routeFor, shown, whoText,
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

export type AttentionKind = "paused_assignee" | "unreachable_worker" | "uncertain_tool_result";
export const ATTENTION_KINDS: readonly AttentionKind[] = ["paused_assignee", "unreachable_worker", "uncertain_tool_result"];
export interface AttentionItem {
  readonly kind: AttentionKind;
  readonly taskId: string;
  readonly projectId: string;
  readonly title: string;
  readonly taskState: TaskState;
  /** The task's owner of record (paused_assignee, unreachable_worker) or the caller of the tool (uncertain_tool_result). */
  readonly agentId?: string;
  /** When it started or was last seen: the pause time (the task's last change when the gate has none), the last sign of work, or the call time. */
  readonly at?: string;
  readonly summary: string;
  /** paused_assignee: the gates; unreachable_worker: the host and why; uncertain_tool_result: the call. */
  readonly detail: Readonly<Record<string, unknown>>;
  readonly cite: Cite;
}
export interface Attention {
  readonly observedAt: string;
  readonly items: readonly AttentionItem[];
  readonly next?: string;
  /** The search stopped before the end (its budget ran out): some items may be missing; ask again from `next`. */
  readonly scanLimited?: true;
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

/**
 * The kinds of status question the owner can ask, with the keys each takes and what it answers, in the owner's terms. The chat tells its model this list so that any free-form question can be turned into the right request (card M03h);
 * `ask` still checks every key, and a test confirms that every kind listed here is one `ask` knows. `taskTitle` stands for a task named by its words: the chat looks the task up before the request reaches this service.
 */
export const STATUS_KINDS: Readonly<Record<string, { readonly keys: readonly string[]; readonly about: string }>> = {
  task: { keys: ["taskId|taskTitle"], about: "how one task is going and what blocks it" },
  overview: { keys: ["projectId", "agentId", "state", "execution", "limit"], about: "the tasks of a project or of one agent, by state" },
  changes: { keys: ["projectId", "since", "limit"], about: "what changed in a project since a time" },
  tools: { keys: ["projectId", "taskId|taskTitle", "since", "limit"], about: "which tools were used" },
  delivered: { keys: ["projectId", "taskId|taskTitle", "since"], about: "what was delivered" },
  noticeboard: { keys: ["projectId"], about: "the project's noticeboard" },
  failed_events: { keys: ["projectId", "taskId|taskTitle", "limit"], about: "events whose handling failed" },
  failed_event: { keys: ["handlingId"], about: "one failed event in detail" },
  timeline: { keys: ["projectId", "agent", "since", "limit"], about: "a project's timeline, or one agent's (since: a time with its zone such as 2026-11-01T08:00:00Z, or a date meaning midnight UTC)" },
  shutdown: { keys: [], about: "whether the system is shutting down and what remains" },
  database_transfer: { keys: [], about: "which database the controller runs on, the databases it can be moved to, the last move and whether the host restarts the controller onto a new database by itself" },
  stop_cleanup: { keys: ["taskId|taskTitle", "scopeKind", "scopeId|scopeName"], about: "what the latest Suspend or Stop of a task, agent, team or the installation spent on cleanup and what was charged to the budgets (name the task by its title; for an agent or a team give scopeKind agent or team with the name as the owner said it in scopeName, or its ID in scopeId; for the whole installation scopeKind installation is enough; a stop is not read for a project); a scope with no request of its own is answered from the wider scope whose stop reaches it (its agent, a team above it, a parent task of its swarm or the installation), and the answer names that scope" },
  handoff: { keys: ["taskId|taskTitle"], about: "the hand-off of a task to another agent" },
  work_report: { keys: ["taskId|taskTitle"], about: "the report an agent gave when it ended its work on a task, done or not (what it did, found, left and could not do), its running notes, the questions a second agent put to it about a done and its answers, whether the report was found supported, was not supported or was not questioned (and why), and the task's earlier attempts' reports in short" },
  attempt_endings: { keys: ["taskId|taskTitle"], about: "how each attempt of a task ended or stands, newest first (card W08): who worked it on which route, when it started and ended, why its last turn stopped in plain words (cut off at the reply limit, ended with prose and no work.end, announced a step but made no call, no visible text, normal, or unknown), the nudges it got to go on, how far its plan got (steps checked of how many), its stops before the work was done, whether the checks of its done passed, whether a second agent questioned its report, its waits for jobs, and the blocker it left with what that blocker says, answering questions such as why did the last attempt stop or how far did it get" },
  start_size: { keys: ["taskId|taskTitle"], about: "a task's starting sizes across its hand-offs (card C07i): how large each attempt's first call was, against its route's startup limit (unknown when the route's window is), the alerts open on it with the trend and the largest contributors, where the originals are kept, and the watch's thresholds (the owner changes them with the context.start-size.change command)" },
  handoff_archive: { keys: ["taskId|taskTitle", "section", "archiveId", "from"], about: "the whole text of a hand-off package section that was cut to fit, as the source gave it (credentials removed): name the task (its latest hand-off, going on or finished) and the section (brief, completedWork, drafts, ...), or the archive ID a cut marker names; from is the line to read on from, as the previous answer says" },
  meetings: { keys: ["projectId", "limit"], about: "planned meetings and stand-ups of a project" },
  decision_log: { keys: ["projectId", "changeKind", "outcome", "limit"], about: "what meeting decisions changed and what became of them" },
  agenda: { keys: ["projectId", "limit"], about: "topics waiting for the next stand-up" },
  standups: { keys: ["projectId", "limit"], about: "a project's stand-ups themselves: each one's title, whether it is active, paused or ended, how often and at what time it is held, how long, who is on its roster, its next meeting and how its last one ended (planned meetings are the meetings kind, topics waiting are the agenda kind, what a stand-up prepared is the standup_briefs kind)" },
  explanations: { keys: ["taskId|taskTitle", "seq", "limit"], about: "why a task's steps were taken" },
  replay: { keys: ["taskId|taskTitle", "seq", "from", "limit", "lane", "agent", "stepKind", "since", "until"], about: "a replay of a task's recorded run, read only: a summary (lines of work and agents to follow) and a window of steps, narrowed to one line (lane), one agent, one kind of step (stepKind) or a time span (since, until: times with their zone such as 2026-11-01T08:00:00Z, or dates meaning midnight UTC; both ends included); with seq, one step in full with what led to it" },
  thinking: { keys: ["taskId|taskTitle", "after", "limit"], about: "owner only: what the model was thinking while it worked on a task (its progress notes), collected from the worker, kept for a limited time and shown as the model\'s own untrusted words, never as a reason or an instruction; each look is recorded; after is the block number to continue from, as the previous answer says" },
  activity: { keys: ["taskId|taskTitle", "latest", "after", "limit"], about: "the steps of a task's activity record" },
  revocations: { keys: ["name", "limit"], about: "the tool versions from the catalogue that the owner revoked: which tool and version, why, by whom and when (name is a tool's canonical name, anything else is refused)" },
  retention_hold: { keys: ["recordKind", "id", "name", "version"], about: "whether a record (recordKind and id) or a tool version (recordKind catalog-version with the tool's canonical name and its version) is kept from deletion, and why (owner only)" },
  retention: { keys: [], about: "owner only: the retention state in one answer: the values in force and which you set, the data disk's free room against the reserve for shutdown and recovery records, the per-project and per-agent storage quotas with use and the scopes near them, the backups and the latest one, and the latest deletions and retention runs (counts and record IDs only). Use it for how much room is left, which quotas are near their limit, which backups are kept and what retention deleted lately" },
  model_routes: { keys: ["level", "name"], about: "the model routing controls in force (which model, endpoint, account, provider or local service is disabled, draining or cut over, why and since when), how failed routes come back and which are down, and each route's reply limit and reasoning cap; with a level and a name, whether that one is out of service, how many requests still run on it and whether it is safe to stop (owner only)" },
  environment: { keys: ["agent|agentName"], about: "what one agent's environment is now (which revision is active, the shared base, the agent's own packages with exact versions, its skills and limits) and whether a newer staged revision waits, with why each recent revision was made, including a change that was rolled back (owner only)" },
  maintenance: { keys: ["maintenanceId", "agent|agentName", "status", "limit"], about: "the agents' requests to change their environment (a package, an extension, a mount, a site, a skill draft, a protected change): what each asked for, who decided, whether it is waiting, being applied, applied, rolled back, failed or revoked, and why a change waits (owner only)" },
  jobs: { keys: ["limit"], about: "the long-running jobs that have not ended (tools agents started, remote jobs, MCP operations): each one's state, task, kind and since when, which are outcome-unknown and wait for you to reconcile them, and which a stop could not end; and the jobs that ended most recently, how each ended and whether its task was woken for it (owner only)" },
  web_access: { keys: [], about: "the web chat in the owner's phone browser (owner only): the address it listens on and the network it may be reached from, whether a TLS proxy is trusted for client addresses, and which browsers are signed in (a short name such as Safari on iPhone, when it signed in and was last used); the owner signs one or all of them out in chat" },
  event_sources: { keys: [], about: "which event sources are watched (timers, files and folders, git repositories, service health, model availability, task completion): each one, whether it is on, and what the ones you defined watch (owner only)" },
  release: { keys: ["candidateId", "limit"], about: "release testing (owner only): per platform the gate result (pass, flaky pass, fail, interrupted, timed out, running or not run), each attempt with its state, host and time, whether the candidate is approved, and what is staged and current; with candidateId for one candidate, without it for the newest few (limit 1 to 10, default 5)" },
  capacity: { keys: [], about: "the capacity settings in force, in three groups: the optional caps (attempts running at once per project, per agent, and the children reporting to one supervising agent, all off unless you turned one on), the host and global quotas (productive attempts in total and on one host, the places kept for inquiries and reviews, the queue, each host's declared CPUs and memory, what runs and waits now) and the limits on spawning child tasks (depth, live children, children in all): each figure, whether you set it or it is the default, and which are off (owner only)" },
  approval_load: { keys: ["days"], about: "the approval load (owner only): how many decisions you made per day, how long asks waited, how many actions ran by a rule, a standing grant, an agent review or you, every ask still waiting with its age, the standing-rule proposals waiting for your answer (what each would have covered) and whether you are due to be asked about the derived profile; days is the window, 1 to 90, default 7" },
  catalog_policy: { keys: [], about: "what happens to tool calls that are running when the owner revokes their tool version and names no choice: the one in force, where it comes from and the owner's own setting" },
  agents: { keys: ["state", "limit"], about: "the agents (active unless state says retired) with their roles and team, and the coordinator marked with its lifecycle state (running, paused, stopping, suspended, stopped or unknown) and the pause that holds it; also whether the coordinator is an agent at all. An agent's name is its own words, shown quoted" },
  standup_questions: { keys: ["projectId"], about: "what the stand-ups asked the owner: the questions still waiting for an answer (the topic and the words asked) and the latest answers the owner gave; the owner answers one in chat in their own words" },
  standup_briefs: { keys: ["occurrenceId|meetingTopic", "agent|agentName"], about: "the briefs prepared for a stand-up, or one agent's: what it did, what is unfinished, what blocks it, advice it needs, its priorities and the notes added to it" },
  reconnect: { keys: ["limit"], about: "remote workers that reconnected and wait for the owner's decision on their attempts (attempt, placement, host, the session that asked and since when: what reconnect.reaccept needs), and whether reconnected workers take their attempts up again by themselves (owner only)" },
  needs_you: { keys: ["limit"], about: "everything waiting for the owner, ranked: what holds up the critical path the owner marked first, then what holds up the most tasks, then the oldest" },
  critical_path: { keys: [], about: "what the owner marked as the critical path (tasks, goals and projects), whether each is still open, and which decisions waiting for the owner hold it up (owner only; the owner marks and unmarks by chat)" },
  setup: { keys: [], about: "the first-run setup walk-through (owner only): what is set up, what is still missing in the order a person sets it up (approval profile, first project and its repository, where it is hosted and its CI, model providers, the host, notifications, the first agent and its rights, the first task, budgets), and for the next open step the question to put to the owner in plain words, the recommended answer and what declining means. Use it when the owner asks how to get started, what is left to set up, or says to continue the setup" },
  owner_questions: { keys: ["limit"], about: "questions agents have put to the owner" },
};

/**
 * One stand-up as the `standups` answer tells it (card M03h): the schedule as it stands, plus the meeting coming up next and the last one held. The stand-up service keeps these records; this is only the view of them (the same shape as
 * its own `StandupSummary`, declared here so the status service does not depend on that package).
 */
export interface StandupSummaryView {
  readonly scheduleId: string; readonly revision: number; readonly title: string; readonly state: string;
  readonly time: string; readonly timeZone: string; readonly recurrence: string;
  readonly window?: { readonly from: string; readonly to: string };
  readonly durationMinutes: number; readonly roster: readonly string[]; readonly occurrences: number; readonly endsOn?: string;
  readonly nextAt?: string; readonly nextOccurrenceId?: string; readonly nextRevision?: number;
  readonly lastAt?: string; readonly lastState?: string; readonly lastOccurrenceId?: string; readonly lastRevision?: number;
}

/** The parts of a stand-up brief the status answer reads (a brief is a record kept by the stand-up service; this is only the view of it). */
export interface OwnerQuestionView { readonly id: string; readonly revision: number; readonly topic: string; readonly question: string; readonly askedAt: string; readonly answer?: string; readonly answeredAt?: string }
/** One agent as the `agents` answer reads it (card U03c): the parts of the agent record it shows. */
export interface AgentRowView { readonly id: string; readonly revision: number; readonly friendlyName: string; readonly roles: readonly string[]; readonly teamId?: string; readonly state: string }
/** The coordinator as the `agents` answer reads it (card U03c): the owner's view of `CoordinatorService.get`. */
export interface CoordinatorRowView {
  readonly id: string; readonly revision: number; readonly principalId: string; readonly state: string;
  readonly hosted?: { readonly agentId: string };
  readonly lifecycle?: { readonly heldBy: readonly { readonly scope: { readonly kind: string; readonly id: string }; readonly observed?: string; readonly reason?: string; readonly by?: string }[] };
}
export interface StandupBriefView {
  readonly id: string; readonly revision: number; readonly occurrenceId: string; readonly agent: string;
  readonly accomplishments: readonly { readonly text: string; readonly cites: readonly Cite[] }[];
  readonly unfinished: readonly { readonly text: string; readonly cites: readonly Cite[] }[];
  readonly blockers: readonly { readonly text: string; readonly cites: readonly Cite[] }[];
  readonly advice: readonly { readonly text: string; readonly cites: readonly Cite[] }[];
  readonly priorities: readonly { readonly text: string; readonly cites: readonly Cite[] }[];
  readonly statements: readonly { readonly section: string; readonly text: string; readonly by?: "owner" }[];
  readonly partial: boolean;
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
  | { readonly kind: "setup" }
  | { readonly kind: "needs_you"; readonly limit?: number }
  | { readonly kind: "critical_path" }
  | { readonly kind: "handoff"; readonly taskId: string }
  | { readonly kind: "start_size"; readonly taskId: string }
  | { readonly kind: "work_report"; readonly taskId: string }
  | { readonly kind: "attempt_endings"; readonly taskId: string }
  | { readonly kind: "handoff_archive"; readonly taskId?: string; readonly archiveId?: string; readonly section?: string; readonly from?: number }
  | { readonly kind: "shutdown" }
  | { readonly kind: "database_transfer" }
  | { readonly kind: "stop_cleanup"; readonly taskId?: string; readonly scope?: { readonly kind: string; readonly id: string }; /** The same scope as flat fields, the form a chat request can take (a request there has no nesting). */ readonly scopeKind?: string; readonly scopeId?: string }
  | { readonly kind: "timeline"; readonly projectId: string; readonly agent?: string; readonly since?: string; readonly limit?: number }
  | { readonly kind: "meetings"; readonly projectId: string; readonly limit?: number }
  | { readonly kind: "agenda"; readonly projectId: string; readonly limit?: number }
  | { readonly kind: "decision_log"; readonly projectId?: string; readonly changeKind?: string; readonly outcome?: string; readonly after?: string; readonly limit?: number }
  | { readonly kind: "explanations"; readonly taskId: string; readonly seq?: number; readonly limit?: number }
  | { readonly kind: "replay"; readonly taskId: string; readonly seq?: number; readonly from?: number; readonly limit?: number; readonly lane?: string; readonly agent?: string; readonly stepKind?: string; readonly since?: string; readonly until?: string }
  | { readonly kind: "thinking"; readonly taskId: string; readonly after?: number; readonly limit?: number }
  | { readonly kind: "revocations"; readonly name?: string; readonly limit?: number }
  | { readonly kind: "approval_load"; readonly days?: number }
  | { readonly kind: "catalog_policy" }
  | { readonly kind: "retention_hold"; readonly recordKind: string; readonly id?: string; readonly name?: string; readonly version?: string }
  | { readonly kind: "retention" }
  | { readonly kind: "event_sources" }
  | { readonly kind: "web_access" }
  | { readonly kind: "capacity" }
  | { readonly kind: "environment"; readonly agent: string }
  | { readonly kind: "maintenance"; readonly maintenanceId?: string; readonly agent?: string; readonly status?: string; readonly limit?: number }
  | { readonly kind: "release"; readonly candidateId?: string; readonly limit?: number }
  | { readonly kind: "jobs"; readonly limit?: number }
  | { readonly kind: "model_routes"; readonly level?: string; readonly name?: string }
  | { readonly kind: "standups"; readonly projectId: string; readonly limit?: number }
  | { readonly kind: "standup_questions"; readonly projectId: string }
  | { readonly kind: "agents"; readonly state?: string; readonly limit?: number }
  | { readonly kind: "standup_briefs"; readonly occurrenceId: string; readonly agent?: string }
  | { readonly kind: "reconnect"; readonly limit?: number }
  | { readonly kind: "activity"; readonly taskId: string; readonly latest?: boolean; readonly after?: number; readonly limit?: number };

/** `rank` is the kind of item in the fixed order used to break a tie: approvals, questions, meeting decisions, held resumes, blockers. */
interface NeedItem { text: string; cites: Cite[]; taskId?: string; since: string; id: string; rank: number }

// ---- retention status lines (card K06d) ---------------------------------------------------------------------------------------

const RETENTION_SHOWN = { quotaScopes: 10, deletions: 5, runs: 5 } as const;

const obj = (v: unknown): Record<string, unknown> | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
const count = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : undefined);
const bytesWord = (n: number): string => (n < 1024 ? `${n} bytes` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KiB` : n < 1024 ** 3 ? `${(n / 1024 ** 2).toFixed(1)} MiB` : `${(n / 1024 ** 3).toFixed(2)} GiB`);
/** The same reference the quota notice uses for an agent, so a quota line and its notice cite one record. */
const quotaRef = (scope: string, id: string): Cite => (scope === "project" ? cite("project", id) : cite("quota", `a-${createHash("sha256").update(id).digest("hex").slice(0, 20)}`));

/**
 * The owner's lines from the retention status (the same answer as `retention.status`, read only): the disk against the reserve, each quota class with its use and the scopes near it, the backups and the last one,
 * the last deletions and runs by record ID with counts only (never the text a record held or the reason typed for a deletion). Everything read from storage is quoted through `shown`, and the lists are bounded.
 */
function retentionStatusLines(st: Readonly<Record<string, unknown>>, settings: Cite): Line[] {
  const lines: Line[] = [];
  const disk = obj(st["disk"]);
  if (disk !== undefined) {
    const free = count(disk["freeBytes"]); const total = count(disk["totalBytes"]); const reserve = obj(disk["reserve"]);
    lines.push(line(free === undefined || total === undefined || total === 0 ? "The data disk's free room is not known here." : `The data disk has ${bytesWord(free)} free of ${bytesWord(total)} (${Math.floor((free * 100) / total)}% free).`, settings));
    if (reserve !== undefined) {
      const wanted = count(reserve["wantedBytes"]) ?? 0;
      lines.push(line(wanted === 0 ? "No room is set aside for shutdown and recovery records (reserveBytes is 0)." : reserve["inUse"] === true ? `The ${bytesWord(wanted)} reserve for shutdown and recovery records is in use: only those records are written until room is made.` : reserve["short"] === true ? `The disk has too little room to set the ${bytesWord(wanted)} reserve aside.` : `${bytesWord(wanted)} is set aside as the reserve for shutdown and recovery records${free === undefined ? "" : free >= wanted ? `; the free room is above it` : `; the free room is below it`}.`, settings));
    }
  }
  const limits = obj(st["quotaLimits"]); const usage = obj(st["quotaUsage"]);
  const pq = limits === undefined ? undefined : count(limits["projectBytes"]); const aq = limits === undefined ? undefined : count(limits["agentBytes"]);
  if (limits !== undefined && pq === undefined && aq === undefined) lines.push(line("No storage quota is set for projects or agents.", settings));
  for (const [scope, label] of [["project", "Project"], ["agent", "Agent"]] as const) {
    const u = obj(usage?.[scope]); if (u === undefined) continue;
    const quota = count(u["quota"]); const scopes = count(u["scopes"]); const totalBytes = count(u["totalBytes"]);
    if (quota === undefined || scopes === undefined || totalBytes === undefined) continue;
    const top = Array.isArray(u["top"]) ? (u["top"] as unknown[]).map(obj).filter((t): t is Record<string, unknown> => t !== undefined && typeof t["id"] === "string" && count(t["used"]) !== undefined).slice(0, 3) : [];
    lines.push(line(`${label} quota: ${bytesWord(quota)} each (warning at ${count(limits?.["warnPercent"]) ?? "?"}%); ${scopes} ${scope}${scopes === 1 ? " holds" : "s hold"} ${bytesWord(totalBytes)} in all${top.length === 0 ? "" : `; the most: ${top.map((t) => `${shown(String(t["id"]), 60)} ${bytesWord(count(t["used"])!)}`).join(", ")}`}${st["quotaUsagePartial"] === true ? " (counting was cut short, so these figures are low)" : ""}.`, settings, ...top.map((t) => quotaRef(scope, String(t["id"])))));
  }
  const near = Array.isArray(st["quotas"]) ? (st["quotas"] as unknown[]).map(obj).filter((q): q is Record<string, unknown> => q !== undefined && typeof q["id"] === "string" && (q["scope"] === "project" || q["scope"] === "agent")) : [];
  for (const q of near.slice(0, RETENTION_SHOWN.quotaScopes)) {
    const used = count(q["used"]); const quota = count(q["quota"]); const percent = count(q["percent"]);
    if (used === undefined || quota === undefined || percent === undefined) continue;
    lines.push(line(`${q["scope"] === "project" ? "Project" : "Agent"} ${shown(String(q["id"]), 80)} is at ${percent}% of its storage quota (${bytesWord(used)} of ${bytesWord(quota)})${q["level"] === "full" ? "; new records from it are refused until you raise the quota or delete something" : ""}.`, quotaRef(String(q["scope"]), String(q["id"])), settings));
  }
  if (near.length > RETENTION_SHOWN.quotaScopes) lines.push(line(`${near.length - RETENTION_SHOWN.quotaScopes} more scope(s) are near their quota and not listed.`, settings));
  const backups = obj(st["backups"]);
  if (backups !== undefined) {
    if (backups["configured"] !== true) lines.push(line("No backups are set up on this installation.", settings));
    else {
      const n = count(backups["count"]) ?? 0; const bad = count(backups["untrusted"]) ?? 0; const counts = obj(backups["counts"]); const latest = obj(backups["latest"]);
      lines.push(line(`${n} backup${n === 1 ? " is" : "s are"} kept${bad > 0 ? ` (${bad} cannot be trusted)` : ""}; the rules keep ${count(counts?.["daily"]) ?? "?"} daily and ${count(counts?.["weekly"]) ?? "?"} weekly.`, settings));
      if (latest !== undefined && typeof latest["name"] === "string" && typeof latest["at"] === "string") lines.push(line(`The latest backup is ${shown(latest["name"], 80)}, made ${shown(latest["at"], 40)}${latest["trusted"] === true ? "" : " (it cannot be trusted)"}.`, cite("backup", latest["name"])));
      else if (n === 0) lines.push(line("No backup has been made yet.", settings));
    }
  }
  const deletions = Array.isArray(st["deletions"]) ? (st["deletions"] as unknown[]).map(obj).filter((d): d is Record<string, unknown> => d !== undefined && typeof d["id"] === "string") : [];
  if (deletions.length === 0) lines.push(line("No record has been deleted by request yet.", settings));
  for (const d of deletions.slice(0, RETENTION_SHOWN.deletions)) {
    const derived = obj(d["derived"]); let derivedCount = 0;
    if (derived !== undefined) for (const k of ["copies", "summaries", "compactions", "archives", "others"]) if (Array.isArray(derived[k])) derivedCount += derived[k].length;
    lines.push(line(`Deletion ${shown(String(d["id"]), 60)} of record ${shown(typeof d["recordId"] === "string" ? d["recordId"] : "?", 60)}: ${shown(typeof d["status"] === "string" ? d["status"] : "?", 20)}, ${shown(typeof d["at"] === "string" ? d["at"] : "?", 40)}, ${derivedCount} derived item(s) with it.`, cite("retention-deletion", String(d["id"]))));
  }
  if (deletions.length > RETENTION_SHOWN.deletions) lines.push(line(`${deletions.length - RETENTION_SHOWN.deletions} older deletion(s) are not listed.`, settings));
  const runs = Array.isArray(st["runs"]) ? (st["runs"] as unknown[]).map(obj).filter((r): r is Record<string, unknown> => r !== undefined && typeof r["id"] === "string") : [];
  if (runs.length === 0) lines.push(line("Retention has not run yet.", settings));
  for (const r of runs.slice(0, RETENTION_SHOWN.runs)) lines.push(line(`Retention run ${shown(String(r["id"]), 60)} (${r["auto"] === true ? "automatic" : "by you"}), ${shown(typeof r["at"] === "string" ? r["at"] : "?", 40)}: ${count(r["removed"]) ?? 0} record(s) removed, ${count(r["backupsDeleted"]) ?? 0} backup(s) deleted, ${count(r["incidentsArchived"]) ?? 0} incident(s) archived, ${count(r["incidentsPurged"]) ?? 0} archived incident(s) removed.`, cite("retention-run", String(r["id"]))));
  return lines;
}

// ---- service -------------------------------------------------------------------------------------------------------------------

export interface StatusDeps {
  /** What retention holds back and why, and its values (card T02c). Absent: the views are not offered. */
  readonly retention?: {
    check(by: Principal, ref: { kind: string; id: string }): Promise<{ readonly retained: boolean; readonly reasons: readonly string[] }>;
    settings(by: Principal): Promise<{ readonly revision: number; readonly settings: Readonly<Record<string, unknown>>; readonly effective: Readonly<Record<string, unknown>> }>;
    /** The same answer as `retention.status` (card K06d): the disk and the reserve, quotas and their use, backups, the last deletions and runs. Absent: the view tells the values only. */
    status?(by: Principal): Promise<Readonly<Record<string, unknown>>>;
  };
  /** The standing answer for calls running when a version is revoked (card T02c). Absent: the view is not offered. */
  readonly catalogPolicy?: { get(by: Principal): Promise<{ readonly revision: number; readonly runningCalls: string | null; readonly damaged: boolean; readonly default: string; readonly effective: string; readonly source: string }> };
  /** The owner's routing controls, the failback policy, route health and the drain report (card R04c). Absent: the view is not offered. */
  readonly routes?: Pick<CutoverService, "controls" | "report" | "healthStates"> & {
    /** Each configured route's length and reasoning budget (card W07), from the routing table. Absent: the view says nothing about budgets. */
    readonly budgets?: () => Promise<readonly { readonly route: string; readonly maxTokens?: number; readonly reasoningTokens?: number; /** The endpoint kind the controller's own configuration names for the route (it names the request fields); absent when the controller has none. */ readonly kind?: string }[]>;
  };
  /** The web chat listener's settings and signed-in browsers (card U07b). Absent, or no listener running: the view is not offered. */
  readonly webAccess?: () => { settings(): WebSettings; browsers(ownerId: string): readonly WebBrowser[] } | undefined;
  /** The live jobs (card T07b). Absent: the view is not offered. */
  /** The agents' environments and their change requests (cards A08, A09). Absent: the views are not offered. */
  readonly environments?: Pick<EnvironmentService, "get">;
  readonly maintenance?: Pick<MaintenanceService, "list" | "get">;
  readonly jobs?: Pick<JobService, "live"> & Partial<Pick<JobService, "recentlyEnded">>;
  /** Past revocations of catalogue tool versions (card T02c). Absent: the view is not offered. */
  readonly revocations?: { list(by: Principal, query: { name?: string; limit?: number }): Promise<{ readonly items: readonly { name: string; version: string; reason: string; revokedBy: string; at: string }[]; readonly total: number; readonly partial?: boolean }> };
  readonly assignments: AssignmentService;
  readonly waits: WaitService;
  readonly blockers: BlockerService;
  readonly contracts: ContractService;
  /** Suspected and confirmed stall concerns (card V01). Absent: none are shown. */
  readonly stall?: Pick<StallService, "list">;
  /** Pause gates (card L01). Absent: no gate is shown and none is assumed. */
  readonly pauses?: Pick<PauseService, "status" | "isPaused">;
  /** The setup readiness view (card U14). Absent: the `setup` view is not offered. */
  readonly setup?: { check(by: Principal): Promise<{ readonly ready: boolean; readonly next?: string; readonly items: readonly { readonly id: string; readonly label: string; readonly state: string; readonly required: boolean; readonly detail: string; readonly guide: { readonly question: string; readonly recommended: string; readonly ifDeclined: string } }[] }> };
  /** Which event sources are watched (card H13f). Absent: the view is not offered. */
  readonly eventSources?: { get(by: Principal): Promise<{ readonly revision: number; readonly sources: readonly { readonly id: string; readonly type: string; readonly enabled: boolean; readonly critical: boolean; readonly defined: boolean; readonly watches?: string }[] }> };
  /**
   * The owner's capacity settings (cards H10, H10b): the optional caps, the host and global quotas and the limits on spawning child tasks. Absent: the view is not offered.
   * A group whose service is not here is one line and the other groups are still shown, so the whole view does not disappear with one service.
   */
  readonly capacity?: {
    readonly limits?: Pick<CapacityLimitsService, "get">;
    readonly quotas?: Pick<AdmissionService, "quotas">;
    readonly swarm?: Pick<SwarmLimitsService, "get">;
  };
  /**
   * Release testing (card X09b part 2): the same reads the API's `release.gate`, `release.attempts` and `release.status` make, and the candidate list for the owner's `release` status view.
   * `gateAndAttempts` gives a candidate's gate and attempts from one read and is used when it is there (`gate` and `attempts` are the fallback for a service that has no such read);
   * `status` is the staging and activation state; absent: the view says staging is not set up here. Absent altogether: the view is not offered.
   */
  readonly release?: Pick<ReleaseService, "gate" | "attempts" | "candidates"> & { gateAndAttempts?(by: Principal, candidateId: string): Promise<{ gate: Gate; attempts: readonly (ReleaseAttemptBody & { id: string })[] }>, status?(by: Principal): Promise<ActivationStatus> };
  /** The approval load, the standing-rule proposals and the profile suggestion (cards A07b, A07c; U08). Absent: the view is not offered. */
  readonly approvals?: ApprovalsFacade;
  /** Whether reconnected remote workers take their attempts up again by themselves, and the attempts that wait for the owner's decision (card H09b). Absent: the view is not offered. */
  readonly reconnect?: {
    get(by: Principal): Promise<{ readonly revision: number; readonly reaccept: string | null; readonly profile: string; readonly effective: string; readonly patienceHours: number | "off"; readonly patienceChosen: boolean }>;
    pending(by: Principal, page: { limit?: number }): Promise<{ readonly items: readonly { readonly attemptId: string; readonly placement: number; readonly hostId: string; readonly sessionId: string; readonly at: string }[]; readonly next?: string }>;
  };
  /** The failed event queue (card H13). Absent: the queue cannot be listed. */
  readonly watch?: Pick<WatchService, "failures" | "inspect">;
  /** The hand-off going on for a task (card L03f). Absent: the view is not offered. */
  /** Whether the installation could be stopped now (card L06). Absent: the view is not offered. */
  /** Where the controller database lives and what a move did (card F04m). Owner only. Absent: the view is not offered. */
  readonly databaseTransfer?: { status(): Promise<{ readonly source: { readonly name: string; readonly kind: string }; readonly targets: readonly { readonly name: string; readonly kind: string }[]; readonly journal?: { readonly id: string; readonly phase: string; readonly to: { readonly name: string }; readonly note?: string; readonly failure?: { readonly reason: string; readonly destinationClean: boolean }; readonly restart?: { readonly state: string; readonly reason?: string } } }>; settings(): Promise<{ readonly enabled: boolean; readonly restart: boolean; readonly restartOffered: boolean }> };
  readonly shutdown?: { readiness(by: Principal): Promise<{ readonly ready: boolean; readonly paused: boolean; readonly unsettled: readonly { readonly kind: string; readonly ref: string; readonly state: string }[]; readonly tracked?: readonly { readonly kind: string; readonly ref: string; readonly state: string }[]; readonly truncated: boolean }> };
  /** What the latest suspension or stop of a scope spent on cleanup (card L02d). Absent: the view is not offered. */
  readonly stops?: Pick<StopService, "cleanupSpend">;
  readonly handoffs?: { forTask(by: Principal, taskId: string): Promise<View<TaskHandoffBody> | undefined>; /** The owner's marks for the task's hand-offs (card C07j), shown beside a hand-off going on. */ marks?(by: Principal, query: { taskId: string }): Promise<{ readonly marks: readonly string[] }>;
    /** The cuts of a task's latest hand-off the caller may read, and the archived originals (card C07j review, round 4): the `handoff_archive` view. Absent: that view is not offered. */
    cutsForTask?(by: Principal, taskId: string): Promise<{ readonly handoffId: string; readonly phase: string; readonly cuts: readonly { readonly section: string; readonly archiveId: string; readonly left: number; readonly total: number }[] } | undefined>;
    archive?(by: Principal, query: { archiveId: string; part?: number }): Promise<{ readonly handoffId: string; readonly taskId: string; readonly section: string; readonly chars: number; readonly parts: number; readonly text: string; readonly truncated?: boolean } | undefined> };
  /** Each attempt's starting size across a task's hand-offs and the alerts open on it (card C07i): the `start_size` view and the warning in the task's status. Absent: neither is shown. */
  readonly startSizes?: Pick<StartSizeService, "read" | "openAlerts">;
  /** The planned meetings of a project (card M04f). Absent: the view is not offered. */
  readonly meetings?: { planned(viewer: Principal, projectId: string, page?: { limit?: number }): Promise<{ items: readonly { id: string; revision: number; title: string; kind: string; startsAt: string; endsAt: string; mode: string; state: string; participants: readonly { id: string; status?: string; availability?: string }[] }[]; next?: string } | undefined> };
  /** The project's stand-ups by their latest occurrence (card M03h), shown in the meetings answer, and the stand-ups themselves (card M03h): the `standups` view. Absent: they are not listed. */
  readonly standups?: {
    recent(viewer: Principal, projectId: string, page?: { limit?: number }): Promise<{ items: readonly { occurrenceId: string; revision: number; title: string; startsAt: string; state: string }[]; more?: boolean } | undefined>;
    briefs?(viewer: Principal, occurrenceId: string): Promise<readonly StandupBriefView[]>;
    ownerQuestions?(viewer: Principal, projectId: string): Promise<{ open: readonly OwnerQuestionView[]; answered: readonly OwnerQuestionView[] }>;
    overview?(viewer: Principal, projectId: string, page?: { limit?: number; includeEnded?: boolean }): Promise<{ items: readonly StandupSummaryView[]; more?: boolean; ended?: number } | undefined>;
  };
  /**
   * The agents and the coordinator (card U03c): the `agents` view. `list` is the agent service's own list, so the right to read agents is the one `agent.list` needs; `coordinator` is the owner's read of the coordinator,
   * asked only for the owner (never for a task credential), as `agent.list` marks it. Absent: the view is not offered.
   */
  readonly agents?: {
    list(viewer: Principal, query: { state?: "active" | "retired"; limit?: number }): Promise<{ items: readonly AgentRowView[]; next?: string }>;
    coordinator?(owner: Principal): Promise<CoordinatorRowView | undefined>;
  };
  /** Adopted meeting decisions that wait for the owner (card M02g). Owner only. Absent: they are not listed in the needs-you list. */
  readonly meetingDecisions?: (viewer: Principal, limit: number) => Promise<{ items: readonly { id: string; revision: number; projectId: string; since: string; left: number; applied: number; text?: string; topic?: string }[]; truncated: boolean }>;
  /** Resume checks held for the owner because changes were judged to matter to the task (card L04c). Owner only. Absent: they are not listed in the needs-you list. */
  /** The critical path the owner marked (card U11d, "U11f"): ranks the Needs-you view and is shown by the `critical_path` request. Absent: nothing is marked. */
  readonly critical?: { readonly holdsUp: () => Promise<HoldsUp | undefined>; readonly list: (by: Principal) => Promise<{ readonly revision: number; readonly marks: readonly { readonly kind: string; readonly id: string; readonly markedAt: string }[] }> };
  readonly heldResumes?: (viewer: Principal, limit: number) => Promise<{ items: readonly { checkId: string; taskId: string; title: string; since: string; changes: readonly { kind: string; key: string; status: string }[] }[]; truncated: boolean }>;
  /** The log of what happened to each change a meeting decided (card M02g). Owner only: for anyone else the view reads as missing. Absent: the view is not offered. */
  readonly decisionLog?: (viewer: Principal, query: { kind?: string; outcome?: string; projectId?: string; after?: string; limit?: number }) => Promise<{ entries: readonly { id: string; revision: number; decisionId: string; projectId: string; kind: string; targetKind: string; outcome: string; code?: string; decidedBy: string; agreedBy?: string; widens?: string; setting?: string; changedAt: string }[]; next?: string; scanLimited?: true }>;
  /** The open agenda of a project (card M03f). Absent: the view is not offered. */
  readonly agenda?: { openAgenda(viewer: Principal, projectId: string, page?: { limit?: number }): Promise<{ items: readonly { id: string; revision: number; topic: string; question?: string; requestedOutcome?: string; urgency: string; intent: string; state: string; requestedBy: string; timeboxMinutes?: number }[]; next?: string } | undefined> };
  /** The steps of a task's activity record (card C09h). Absent: the view is not offered. */
  readonly activity?: Pick<ActivityService, "steps" | "explanations"> & Partial<Pick<ActivityService, "timeline">>;
  /** Step-through replay of a task's activity (card U09). Read only. Absent: the view is not offered. */
  readonly replay?: Pick<ReplayService, "open" | "step" | "led"> & Partial<Pick<ReplayService, "thinking">>;
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
/** How many references or links one replay chat line names before it counts the rest (card U09): a step may cite up to 100, which would make one line many kilobytes once quoted. */
const REPLAY_LINE_ITEMS = 12;
/** How many names of one stand-up's roster the stand-ups answer lists before counting the rest (card M03h): a roster may hold 50 principals. */
const STANDUP_ROSTER_LISTED = 10;
/** The ID of the one coordinator record (`COORDINATOR_ID` in chat/coordinator.ts), cited when there is none or it cannot be read. */
const COORDINATOR_RECORD = "coordinator:main";
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const HANDLING_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/;
const TASK_ID_IN_TEXT = /task-[a-z2-7]{20}/g;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const cite = (kind: string, id: string, revision?: number): Cite => ({ kind, id, ...(revision === undefined ? {} : { revision }) });
const line = (text: string, ...cites: Cite[]): Line => ({ text, cites });
const FRESH_WORDS: Readonly<Record<Freshness, string>> = { fresh: "recent", stale: "old", unknown: "not heard from lately" };
/** How many declared hosts the capacity view lists before it counts the rest (the owner's own `capacity.quotas.change` refuses a record holding more than 200). */
const CAPACITY_HOSTS = 10;
// ASSUMPTION: this answer needs no line-count cut, so it has none. Its shape bounds it - one line per group, one damaged line per group, three caps, four quotas, three spawn limits, at most
// CAPACITY_HOSTS host lines and one line counting the rest - which is 25 lines at the widest. The chat cuts any status answer to CHAT_LIMITS.statusLines (30) and counts what it left out anyway, so the
// `lines.length > CAPACITY_LINES` branch that used to sit at the end of `capacityLines` could neither be reached by any service nor exercised by a test; it is removed as dead code, and the test "a record
// with more declared hosts than the view lists ..." keeps the bound honest: it fills a record with more hosts than the owner's own command would track and fails if the answer ever outgrows thirty lines.
/** What each capacity figure lets the controller do, in the owner's words (cards H10, H10b). A name the code does not know is shown by its own name. */
const CAPACITY_WORDS: Readonly<Record<string, string>> = {
  perProject: "productive attempts running at once for one project", perAgent: "productive attempts running at once for one agent", fanIn: "running child attempts that report to one supervising agent",
  productive: "productive attempts running at once, in total", perHost: "productive attempts running at once on one host", control: "places only inquiries and reviews may use", queue: "requests that may wait",
  depth: "levels of child tasks below a task that was not spawned", liveChildren: "children of one parent that are not finished at once", totalChildren: "children of one parent in all (the fan-in)",
};
const capacityWord = (name: string): string => (Object.hasOwn(CAPACITY_WORDS, name) ? CAPACITY_WORDS[name] : undefined) ?? name;
/**
 * What a damaged record of each kind does to the controller, in the owner's words - said per group because each one gates something different, and borrowing one group's words for another would be a guess:
 * `AdmissionService.request` reads the caps record before it admits anything, so a damaged caps record refuses every new request (inquiries and reviews included) while what already runs keeps running and is
 * still released; the quotas live in the admission record itself, the record admission works from; and `SwarmService` takes its limits from `SwarmLimitsService.effective()`, which throws on a damaged record,
 * so a damaged swarm record spawns nothing at all.
 */
const CAPS_DAMAGED = "the caps record you stored is damaged - nothing new is admitted, not an inquiry, not a review, not productive work - until it is repaired with capacity.limits.change; what is already running is not stopped";
const SWARM_DAMAGED = "the stored swarm limits are damaged - no child task can be spawned until they are repaired with swarm.limits.change";
/** A stored figure the controller can work from: a number that is neither missing, nor NaN, nor an infinity. */
const isFigure = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
/**
 * Whether one stored quota figure is what `capacity.quotas.change` could have stored: a whole number inside the bound the admission service enforces (`LIMIT_BOUNDS`, the table `checkLimits` reads).
 * `quotas()` hands the record over unchecked, so a `productive` of `-1` or `1.5` reaches the view as it is, prints as the owner's own figure, and leaves admission admitting nothing. A name the table
 * does not hold is not a quota at all and is checked as a figure only - `checkLimits` itself cannot be called here, because it wants all seven figures and the quotas carry four of them.
 */
const quotaFigure = (name: string, v: unknown): boolean => {
  const bound = Object.hasOwn(LIMIT_BOUNDS, name) ? LIMIT_BOUNDS[name as keyof Limits] : undefined;
  return bound !== undefined && typeof v === "number" && Number.isSafeInteger(v) && v >= bound[0] && v <= bound[1];
};
/** What a stored quota figure has to be, in the owner's words - the same words `capacity.quotas.change` refuses a bad figure with (`must be a whole number from 1 to 64`). */
const quotaBoundWords = (name: string): string => {
  const bound = Object.hasOwn(LIMIT_BOUNDS, name) ? LIMIT_BOUNDS[name as keyof Limits] : undefined;
  return bound === undefined ? "a figure the controller can work from" : `a whole number from ${bound[0]} to ${bound[1]}`;
};
/**
 * How many productive attempts a quotas record says run on one host. `running.perHost` is a plain object, so a lookup that goes through the prototype answers with `Object.prototype`'s own members for a
 * host declared as `constructor` or `toString` - a function printed as the running count. A name the record does not carry simply runs nothing.
 */
const runningOn = (perHost: Readonly<Record<string, number>>, id: string): number => (Object.hasOwn(perHost, id) ? perHost[id]! : 0);
/** A stored record read as a field map; undefined for anything that is not one (missing, null, an array, text, a number). */
const asRecord = (v: unknown): Record<string, unknown> | undefined => (v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined);
/**
 * Why the host and global quotas cannot be shown, in one clause; undefined when every figure in them reads. `AdmissionService.quotas()` hands back what the admission record holds without checking it, so a
 * record no command could store reaches the view as it is: a figure that is missing or is not a number, a quota outside the bound the owner's own command enforces, hosts that is not a record of declared
 * CPUs and memory. Admission works from that same record, and a bound it cannot read is simply not applied (a record whose `queue` was missing let a queue of any length build up instead of refusing, and a
 * `productive` of nought starts no work at all), so the group is refused in one line rather than shown wrongly.
 */
function quotaProblem(q: { readonly limits: unknown; readonly defaults: unknown; readonly hosts: unknown; readonly running: unknown; readonly waiting: unknown }): string | undefined {
  const limits = asRecord(q.limits);
  if (limits === undefined || Object.keys(limits).length === 0) return "the limits are not a record of figures";
  const bad = Object.keys(limits).filter((n) => !isFigure(limits[n]));
  if (bad.length > 0) return `${bad.join(", ")} ${bad.length === 1 ? "is" : "are"} not a figure the controller can work from`;
  // A figure may read as a number and still be one no command could store (`productive: -1`, `queue: 0`, `perHost: 1.5`): admission works from it, so the group cannot be shown as the owner's own setting.
  const out = Object.keys(limits).filter((n) => !quotaFigure(n, limits[n]));
  if (out.length > 0) return `${out.slice(0, 3).map((n) => `${n} is not ${quotaBoundWords(n)}`).join(", ")}${out.length > 3 ? ` (and ${out.length - 3} more)` : ""}`;
  if (asRecord(q.defaults) === undefined) return "the defaults are not a record of figures";
  const hosts = asRecord(q.hosts);
  if (hosts === undefined) return "the declared hosts are not a record of CPUs and memory";
  const badHosts = Object.keys(hosts).filter((id) => { const h = asRecord(hosts[id]); return h === undefined || !isFigure(h["cpus"]) || !isFigure(h["memoryMb"]); });
  if (badHosts.length > 0) return `${badHosts.slice(0, 3).map((id) => quoted(id, 60)).join(", ")} ${badHosts.length === 1 ? "does" : "do"} not declare CPUs and memory as figures${badHosts.length > 3 ? ` (and ${badHosts.length - 3} more)` : ""}`;
  const running = asRecord(q.running);
  if (running === undefined || !isFigure(running["productive"]) || !isFigure(running["control"]) || asRecord(running["perHost"]) === undefined) return "the counts of what runs now are not figures";
  const perHost = asRecord(running["perHost"])!;
  const badCounts = Object.keys(perHost).filter((id) => !isFigure(perHost[id]));
  if (badCounts.length > 0) return `${badCounts.slice(0, 3).map((id) => quoted(id, 60)).join(", ")} ${badCounts.length === 1 ? "does not count what runs on it as a figure" : "do not count what runs on them as figures"}${badCounts.length > 3 ? ` (and ${badCounts.length - 3} more)` : ""}`;
  if (!isFigure(q.waiting)) return "the count of what waits now is not a figure";
  return undefined;
}
/**
 * Why the host and global quotas are not shown, in one line: the group is refused whole, because a figure that is not in force would be worse to read than nothing. It does not tell the owner to run
 * `capacity.quotas.change`, because that command merges `set` into the stored limits and checks the whole record (`checkLimits`), including `depth`, `children` and `patience`, which no quota command can
 * set: a record whose limits do not hold all seven figures is refused whatever is set (probed, and asserted in `chat/capacity.test.ts`: `limits.depth: must be a whole number from 0 to 8` for a record
 * with no limits even when all four quotas are set), while a record whose limits are whole but that lacks `queue` is mended by the very same command. Some shapes it cannot reach at all, so the line
 * names the need for repair rather than promising the command.
 */
const quotasDamaged = (what: string): string => `the stored admission record is damaged (${what}): nothing in this group is shown, and what admission admits from it is not what these figures would allow (it needs repair; capacity.quotas.change cannot mend every damaged shape)`;
/** Why one group of the capacity view cannot be shown, in one clause; anything but a damaged, refused or missing record is a real failure and is thrown. `damaged` is what that group's record being unreadable does, because the groups gate different things. */
function capacityProblem(error: unknown, damaged: string): string {
  if (!(error instanceof DomainError)) throw error;
  if (error.code === "integrity") return damaged;
  if (error.code === "forbidden" || error.code === "unavailable") return "it cannot be read here";
  throw error;
}
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
  /** Seals scan-position cursors so that a cursor left by a scan that ran out of budget reveals nothing about tasks the caller may not read (the position can be on any task the scan merely walked past). */
  readonly #cursorKey = randomBytes(32);

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

  #seal(plain: string): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.#cursorKey, iv);
    const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    return `~${Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url")}`;
  }

  /** The position inside a sealed cursor; a cursor that is not sealed is returned as it is, and one that fails to open is refused. */
  #unseal(field: string, cursor: string): string {
    if (!cursor.startsWith("~")) return cursor;
    try {
      const raw = Buffer.from(cursor.slice(1), "base64url");
      if (raw.length < 29) throw new Error("short");
      const decipher = createDecipheriv("aes-256-gcm", this.#cursorKey, raw.subarray(0, 12));
      decipher.setAuthTag(raw.subarray(12, 28));
      return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    } catch { return invalid(field, "is not a cursor from an earlier page"); }
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
      case "database_transfer": { onlyKnown(request, ["kind"]); return this.databaseTransferLines(by); }
      case "stop_cleanup": { onlyKnown(request, ["kind", "taskId", "scope", "scopeKind", "scopeId"]); return this.stopCleanupLines(by, request); }
      case "handoff": { onlyKnown(request, ["kind", "taskId"]); return this.handoffLines(by, request.taskId); }
      case "start_size": { onlyKnown(request, ["kind", "taskId"]); return this.startSizeLines(by, request.taskId); }
      case "work_report": { onlyKnown(request, ["kind", "taskId"]); return this.workReportLines(by, request.taskId); }
      case "attempt_endings": { onlyKnown(request, ["kind", "taskId"]); return this.attemptEndingLines(by, request.taskId); }
      case "handoff_archive": { onlyKnown(request, ["kind", "taskId", "archiveId", "section", "from"]); return this.handoffArchiveLines(by, request); }
      case "meetings": { onlyKnown(request, ["kind", "projectId", "limit"]); return this.meetingLines(by, request); }
      case "decision_log": { onlyKnown(request, ["kind", "projectId", "changeKind", "outcome", "after", "limit"]); return this.decisionLogLines(by, request); }
      case "agenda": { onlyKnown(request, ["kind", "projectId", "limit"]); return this.agendaLines(by, request); }
      case "explanations": { onlyKnown(request, ["kind", "taskId", "seq", "limit"]); return this.explanationLines(by, request); }
      case "replay": { onlyKnown(request, ["kind", "taskId", "seq", "from", "limit", "lane", "agent", "stepKind", "since", "until"]); return this.replayLines(by, request); }
      case "thinking": { onlyKnown(request, ["kind", "taskId", "after", "limit"]); return this.thinkingLines(by, request); }
      case "activity": { onlyKnown(request, ["kind", "taskId", "latest", "after", "limit"]); return this.activityLines(by, request); }
      case "standups": { onlyKnown(request, ["kind", "projectId", "limit"]); return this.standupLines(by, request); }
      case "standup_questions": { onlyKnown(request, ["kind", "projectId"]); return this.standupQuestionLines(by, request); }
      case "agents": { onlyKnown(request, ["kind", "state", "limit"]); return this.agentLines(by, request); }
      case "standup_briefs": { onlyKnown(request, ["kind", "occurrenceId", "agent"]); return this.standupBriefLines(by, request); }
      case "approval_load": { onlyKnown(request, ["kind", "days"]); return this.approvalLoadLines(by, request.days); }
      case "catalog_policy": { onlyKnown(request, ["kind"]); return this.catalogPolicyLines(by); }
      case "retention_hold": { onlyKnown(request, ["kind", "recordKind", "id", "name", "version"]); return this.retentionHoldLines(by, request); }
      case "retention": { onlyKnown(request, ["kind"]); return this.retentionLines(by); }
      case "web_access": { onlyKnown(request, ["kind"]); return this.webAccessLines(by); }
      case "event_sources": { onlyKnown(request, ["kind"]); return this.eventSourceLines(by); }
      case "capacity": { onlyKnown(request, ["kind"]); return this.capacityLines(by); }
      case "release": { onlyKnown(request, ["kind", "candidateId", "limit"]); return this.releaseLines(by, request); }
      case "environment": { onlyKnown(request, ["kind", "agent"]); return this.environmentLines(by, request.agent); }
      case "maintenance": { onlyKnown(request, ["kind", "maintenanceId", "agent", "status", "limit"]); return this.maintenanceLines(by, request); }
      case "jobs": { onlyKnown(request, ["kind", "limit"]); return this.jobLines(by, request.limit); }
      case "model_routes": { onlyKnown(request, ["kind", "level", "name"]); return this.modelRouteLines(by, request); }
      case "reconnect": { onlyKnown(request, ["kind", "limit"]); return this.reconnectLines(by, request); }
      case "revocations": { onlyKnown(request, ["kind", "name", "limit"]); return this.revocationLines(by, request); }
      case "needs_you": { onlyKnown(request, ["kind", "limit"]); return this.needsYou(by, request.limit); }
      case "critical_path": { onlyKnown(request, ["kind"]); return this.criticalPathLines(by); }
      case "setup": { onlyKnown(request, ["kind"]); return this.setupLines(by); }
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
      ? line(`Step ${s.seq} is no longer available: ${quoted(s.unavailable)}.`, cite("task", taskId))
      : line(`Step ${s.seq}, ${s.at}, ${shown(s.actor)}: ${s.kind} - ${quoted(s.summary)}${s.corrections > 0 ? ` (corrected ${s.corrections} time${s.corrections === 1 ? "" : "s"})` : ""}`, cite("task", taskId))));
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
    const lines: Line[] = got.steps.map((s) => line(`${s.at}, ${shown(s.actor)}: ${s.kind} - ${quoted(s.summary)}`, cite("task", s.taskId)));
    for (const g of got.gaps ?? []) lines.push(line(`Step ${g.seq} of a task is no longer available: ${quoted(g.reason)}.`, cite("task", g.taskId)));
    if (lines.length === 0) lines.push(line("No steps match.", cite("project", request.projectId)));
    else if (got.truncated) lines.push(line("The project has more tasks than were looked at; this is a part of its recent activity (usually the most recently active tasks).", cite("project", request.projectId)));
    return { observedAt: this.#runner.now(), lines };
  }

  /** Whether one record or tool version is kept from deletion, and why: one line per reason, each citing what is kept. Owner only. */
  async retentionHoldLines(by: Principal, query: { recordKind: string; id?: string; name?: string; version?: string }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.retention === undefined || by.kind !== "owner") return undefined;
    if (typeof query.recordKind !== "string" || query.recordKind === "") invalid("recordKind", "needs the kind of record, or catalog-version for a tool version");
    // A tool version is named by its tool and version (nobody is shown the version record's ID); every other record by its ID.
    const byName = query.recordKind === "catalog-version" && query.id === undefined;
    if (byName && (typeof query.name !== "string" || query.name === "" || typeof query.version !== "string" || query.version === "")) invalid("name", "a tool version needs the tool's name and its version");
    if (!byName && (typeof query.id !== "string" || query.id === "")) invalid("id", "needs the record's id");
    const id = byName ? versionIdOf(query.name!, query.version!) : query.id!;
    let found;
    try { found = await this.#deps.retention.check(by, { kind: query.recordKind, id }); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "unavailable")) return undefined;
      throw error;
    }
    const c = cite(query.recordKind.slice(0, 80), id.slice(0, 200));
    const what = byName ? `${shown(query.name!, 80)} ${shown(query.version!, 20)}` : `${shown(query.recordKind, 80)} ${shown(id, 200)}`;
    return { observedAt: this.#runner.now(), lines: found.retained ? [line(`${what} is kept from deletion for ${found.reasons.length} reason(s):`, c), ...found.reasons.slice(0, 20).map((why) => line(shown(why, 300), c)), ...(found.reasons.length > 20 ? [line(`${found.reasons.length - 20} more reason(s) are not shown.`, c)] : [])] : [line(`${what} is not held by anything retention knows of; a rule may remove it when its time comes.`, c)] };
  }

  /**
   * The owner's routing controls (card R04c): each disabled, draining or cut-over target with why and since when, the failback policy, and the targets that are down. With `level` and `name`, the three facts about taking that
   * target out of service, kept apart: routing applied, requests still running on it, safe to stop. Owner only.
   */
  async modelRouteLines(by: Principal, query: { level?: string; name?: string }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const routes = this.#deps.routes;
    if (routes === undefined || by.kind !== "owner") return undefined;
    if ((query.level === undefined) !== (query.name === undefined)) invalid(query.level === undefined ? "level" : "name", "give both a level and a name, or neither");
    const c = cite("route-controls", "controls");
    const controls = await routes.controls();
    const lines: Line[] = [];
    if (query.level !== undefined) {
      const r = await routes.report(by, { level: query.level as Parameters<CutoverService["report"]>[1]["level"], name: query.name! });
      const target = `${shown(r.level, 10)} ${shown(r.name, 64)}`;
      lines.push(line(`${target}: routing ${r.routingApplied ? `applied (${r.mode === "drain" ? "draining" : r.mode === "cutover" ? "cut over" : "disabled"})` : "not applied: new work can still reach it"}.`, c));
      lines.push(line(`${r.inFlightRemaining} request(s) still running on it${r.cancelPending ? "; cancellations of the cutover are still being carried out" : ""}${r.drainUntil === undefined ? "" : r.drainDeadlinePassed ? "; the drain deadline has passed" : `; the drain ends at ${shown(r.drainUntil, 30)}`}.`, c));
      lines.push(line(r.safeToStop ? `It is safe to stop${r.stopDiscardsCache ? " (stopping a local service loses its in-memory cache)" : ""}.` : "It is not safe to stop yet.", c));
      if (r.possibleCharges > 0) lines.push(line(`${r.possibleCharges} abandoned attempt(s) on a paid provider may still have been charged.`, c));
      return { observedAt: this.#runner.now(), lines };
    }
    lines.push(controls.entries.length === 0 ? line("No routing controls are in force: every configured route may take new work.", c) : line(`${controls.entries.length} routing control(s) in force:`, c));
    for (const e of controls.entries.slice(0, 50)) lines.push(line(`${shown(e.level, 10)} ${shown(e.name, 64)} is ${e.mode === "drain" ? `draining until ${shown(e.drainUntil ?? "", 30)}` : e.mode === "cutover" ? "cut over" : "disabled"} since ${shown(e.at, 30)}: ${shown(e.reason, 200)}.`, c));
    const f = controls.failback;
    lines.push(line(f.mode === "manual" ? "A target that failed comes back only when you restore it." : `A target that failed comes back by itself after ${f.minProbes} good probe(s) over at least ${f.stableSeconds} s, unless it failed again within ${f.holdDownSeconds} s of its last restore.`, c));
    const health = await routes.healthStates();
    const down = health.items.filter((h) => h.state === "down");
    for (const h of down.slice(0, 20)) lines.push(line(`${shown(h.scope, 10)} ${shown(h.name, 64)} is down since ${shown(h.since, 30)} (${shown(h.lastClass, 20)})${h.needsOwner ? "; it needs you to restore it" : ""}.`, h.scope === "model" ? c : cite("route-health", `${h.scope}-${h.name}`)));
    if (down.length > 20 || health.truncated) lines.push(line("More targets are down than are shown.", c));
    if (routes.budgets !== undefined) {
      // How long a route's replies may be and how much of them may go on reasoning (card W07); a route with neither is left to the agent's runtime.
      const budgets = await routes.budgets();
      const set = budgets.filter((b) => b.maxTokens !== undefined || b.reasoningTokens !== undefined);
      const b = cite("routing-table", "routing");
      if (budgets.length > 0) lines.push(line(set.length === 0 ? "No route has a reply limit or a reasoning cap: each model call asks for what the agent's runtime decides." : `${set.length} route(s) have a reply limit or a reasoning cap (a reply cut off at its limit is continued with a nudge to stop deliberating and act):`, b));
      for (const r of set.slice(0, 50)) lines.push(line(`${shown(r.route, 200)}: ${r.maxTokens === undefined ? "no reply limit" : `replies at most ${r.maxTokens} tokens`}, ${r.reasoningTokens === undefined ? "no reasoning cap" : `reasoning at most ${r.reasoningTokens} tokens`}${r.kind === undefined ? " (no endpoint kind is configured for this route, neither by the controller nor on its provider (tell the chat what kind of server the provider is): on an OpenAI-style endpoint the figures are sent only if the host names the kind; when they are not sent, the task's activity says so)" : ` (endpoint kind ${shown(r.kind, 40)})`}.`, b));
      if (set.length > 50) lines.push(line(`${set.length - 50} more route(s) with a budget are not shown.`, b));
    }
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * The jobs that have not ended (card T07b), oldest first: state, label (quoted), task, kind and since when; outcome-unknown ones say they wait for a reconciliation (`job.reconcile`), a stop that was not obeyed and the orphans a
   * stop could not end are named. The output of a job is never shown here (it is the program's text; `job.get` reads it). Owner only.
   */
  /** The first-run walk-through (card U14): the readiness view in the order a person sets things up, with the plain question for the next open step. Reads records only; no secret is read. */
  async setupLines(by: Principal): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.setup === undefined || by.kind !== "owner") return undefined;
    const r = await this.#deps.setup.check(by);
    const c = cite("setup", "readiness");
    const mark = (state: string): string => (state === "done" ? "done" : state === "default" ? "default (nothing chosen, works as it is)" : state === "optional" ? "optional, not yet" : "OPEN");
    const open = r.items.find((i) => i.state === "missing" || (i.state === "optional" && i.id === "task"));
    const lines: Line[] = [
      line(r.ready ? "Everything a first agent needs is set up." : `Not ready for a first agent yet: the first required step still open is ${shown(r.items.find((i) => i.id === r.next)?.label ?? "", 80)}.`, c),
      ...r.items.map((i) => line(`${shown(i.label, 80)}: ${mark(i.state)}${i.required ? " (needed)" : ""}. ${shown(i.detail, 240)}`, c)),
    ];
    if (open !== undefined) lines.push(line(`Next to ask: ${shown(open.guide.question, 700)} Recommended: ${shown(open.guide.recommended, 200)} If you decline: ${shown(open.guide.ifDeclined, 250)} Ask the owner this one question; apply nothing until they answer, and every answer can be changed later by chat.`, c));
    return { observedAt: this.#runner.now(), lines };
  }

  async jobLines(by: Principal, limit = 20): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.jobs === undefined || by.kind !== "owner") return undefined;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) invalid("limit", "must be a whole number from 1 to 100");
    const got = await this.#deps.jobs.live(by, { limit });
    const ended = await this.#endedLines(by, Math.min(limit, 10));
    if (got.jobs.length === 0) return { observedAt: this.#runner.now(), lines: [line("No job is running or waiting: every job has ended or is a tracked exception.", cite("jobs", "live")), ...ended] };
    const unknown = got.jobs.filter((j) => j.state === "outcome_unknown").length;
    return { observedAt: this.#runner.now(), lines: [
      line(`${got.jobs.length}${got.next === undefined ? "" : " or more"} job(s) have not ended${unknown === 0 ? "" : `; ${unknown} of them are outcome-unknown and wait for you to reconcile them (job.reconcile, with the evidence)`}:`, cite("jobs", "live")),
      ...got.jobs.map((j) => line(`${j.id} ${JSON.stringify(shown(j.label, 80))} (${j.kind}) of task ${j.taskId}: ${j.state.replaceAll("_", " ")} since ${shown(j.history.at(-1)?.at ?? j.admittedAt, 30)}${j.state === "outcome_unknown" && j.unknown !== undefined ? ` (${shown(j.unknown.reason, 160)})` : ""}${j.cancel?.uncooperative === true ? "; the stop was not obeyed, Force Stop is offered" : ""}${j.orphans.length > 0 ? `; the stop could not end ${j.orphans.length} process(es): ${j.orphans.slice(0, 3).map((o) => shown(o, 60)).join(", ")}` : ""}.`, cite("job", j.id), cite("task", j.taskId))),
      ...(got.next === undefined ? [] : [line("More jobs have not ended than are shown (ask with a larger limit).", cite("jobs", "live"))]),
      ...ended,
    ] };
  }

  /** Card W11: the jobs that ended most recently, newest first: how each ended, whether its task was woken for it (or why not, or what it waits for) and whether you were told. The output is not shown (`job.get` reads it). */
  async #endedLines(by: Principal, limit: number): Promise<Line[]> {
    const recent = await this.#deps.jobs?.recentlyEnded?.(by, limit).catch(() => undefined);
    if (recent === undefined || recent.length === 0) return [];
    const woke = (w: (typeof recent)[number]["wake"]): string => w.status === "woken" ? `its task was woken for it${w.woke === undefined ? "" : ` (attempt ${w.woke})`}`
      : w.status === "joined" ? `the task's next run was told of it${w.woke === undefined ? "" : ` (attempt ${w.woke})`}`
      : w.status === "skipped" ? `its task was not woken: ${shown(w.reason ?? "no reason recorded", 200)}`
      : "its task's wake is still to come (paused, busy, or its wake-ups for the hour used up)";
    return [
      line(`${recent.length} job(s) ended most recently:`, cite("jobs", "ended")),
      ...recent.map(({ job, wake }) => line(`${job.id} ${JSON.stringify(shown(job.label, 80))} (${job.kind}) of task ${job.taskId}: ${wake.state.replaceAll("_", " ")} at ${shown(wake.at, 30)}${job.exit?.reason === undefined ? "" : ` (${shown(job.exit.reason, 120)})`}; ${woke(wake)}${wake.notice === undefined ? "" : wake.notice.sent ? "; you were told" : `; you were not told (${shown(wake.notice.why ?? "", 120)})`}.`, cite("job", job.id), cite("task", job.taskId))),
    ];
  }

  /** The web chat's settings and the browsers signed in to it (card U07b). Owner only; nothing secret exists to show (no cookie, credential or pairing code is ever held in a readable form). */
  webAccessLines(by: Principal): { readonly observedAt: string; readonly lines: readonly Line[] } | undefined {
    const w = by.kind === "owner" ? this.#deps.webAccess?.() : undefined;
    if (w === undefined) return undefined;
    const c = cite("web-chat", "listener");
    const st = w.settings();
    const browsers = w.browsers(by.id);
    const proxy = st.trustedProxy.enabled ? `trusted proxy: ${st.trustedProxy.addresses.map((a) => shown(a, 45)).join(", ")} (client address from ${shown(st.trustedProxy.header, 20)})` : "no trusted proxy (every client is the connection's own address)";
    return { observedAt: this.#runner.now(), lines: [
      line(`The web chat listens on ${shown(st.host, 45)}:${st.port}, reachable from ${st.network === "loopback" ? "this machine only" : "your private network"}; ${st.tls ? "with its own TLS" : st.behindTlsProxy ? "behind a TLS proxy" : "plain HTTP"}; ${proxy}.`, c),
      line(`Sign-in limits: ${st.limits.failedLoginsPerAddressPerMinute} failures a minute per client address and ${st.limits.failedLoginsGlobalPerMinute} in all; a session ends after ${Math.round(st.session.idleMs / 3600_000)} h idle or ${Math.round(st.session.maxMs / 86_400_000)} days.`, c),
      ...(browsers.length === 0 ? [line("No browser is signed in.", c)] : [line(`${browsers.length} browser(s) signed in:`, c), ...browsers.slice(0, 20).map((b) => line(`${shown(b.label, 60)}: signed in ${b.createdAt}, last used ${b.lastSeen}`, c))]),
    ] };
  }

  /** Which event sources are watched (card H13f): each source the controller has, its kind, whether it is on, and for one the owner defined what it watches. Owner only. */
  async eventSourceLines(by: Principal): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.eventSources === undefined || by.kind !== "owner") return undefined;
    let got;
    try { got = await this.#deps.eventSources.get(by); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "unavailable")) return undefined;
      throw error;
    }
    const c = cite("event-source-settings", "main", got.revision === 0 ? undefined : got.revision);
    if (got.sources.length === 0) return { observedAt: this.#runner.now(), lines: [line("No event sources are configured; nothing outside is watched.", c)] };
    const shownSources = got.sources.slice(0, 50);
    return { observedAt: this.#runner.now(), lines: [
      line(`${got.sources.length} event source(s); ${got.sources.filter((s) => s.enabled).length} watched:`, c),
      ...shownSources.map((s) => line(`${shown(s.id, 64)} (${shown(s.type, 30)}${s.defined ? ", defined by you" : ", built in or from the host"}${s.critical ? ", cannot be turned off" : ""}): ${s.enabled ? "on" : "off"}${s.watches === undefined ? "" : `; ${shown(s.watches, 250)}`}.`, c)),
      ...(got.sources.length > shownSources.length ? [line(`${got.sources.length - shownSources.length} more are not shown.`, c)] : []),
    ] };
  }

  /** One agent's environment, for the owner: the active revision, a newer one that waits, and why each was made (card A09: what an approved change did, what a rolled-back one left). */
  async environmentLines(by: Principal, agent: unknown): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (by.kind !== "owner" || this.#deps.environments === undefined) return undefined;
    if (typeof agent !== "string" || !/^agent:[A-Za-z0-9][A-Za-z0-9-]{0,63}$/.test(agent)) return invalid("agent", "must be an agent, such as agent:agt-...");
    const env = await this.#deps.environments.get(by, agent);
    const c = cite("environment", agent);
    if (env === undefined) return { observedAt: this.#runner.now(), lines: [line(`${agent} has no environment yet.`, c)] };
    const lines: Line[] = [];
    const a = env.active;
    if (a === undefined) lines.push(line(`${agent} has ${env.latest} environment revision${env.latest === 1 ? "" : "s"} and none is active.`, c));
    else {
      const packages = a.manifest.packages.map((p) => `${p.name} ${p.version}`).join(", ") || "none";
      lines.push(line(`${agent}'s environment is at revision ${a.revision} of ${env.latest} (${a.digest.slice(0, 19)}...), made by ${a.createdBy} at ${a.createdAt}.`, cite("environment-revision", `${agent}|${a.revision}`)));
      lines.push(line(`Base ${a.manifest.base.name} ${a.manifest.base.version}; own packages: ${packages}; ${a.manifest.skills.length} skill${a.manifest.skills.length === 1 ? "" : "s"}; limits ${a.manifest.limits.cpus} cpus, ${a.manifest.limits.memoryMb} MB memory, ${a.manifest.limits.diskMb} MB disk, ${a.manifest.limits.processes} processes${a.manifest.limits.wallTimeMs === undefined ? ", no time limit of its own (the installation's applies)" : `, ${a.manifest.limits.wallTimeMs} ms for one launch`}; each launch uses these cut down by the limits you set for all agents, never more.`, c));
      lines.push(line(`Why revision ${a.revision} exists: ${a.reason}${a.rollbackOf === undefined ? "" : ` (it restores revision ${a.rollbackOf})`}.`, cite("environment-revision", `${agent}|${a.revision}`)));
    }
    if (env.latest > (a?.revision ?? 0)) {
      const waiting = (await this.#deps.environments.get(by, agent, env.latest))?.revision;
      if (waiting !== undefined) lines.push(line(`Revision ${waiting.revision} is staged and not active: ${waiting.reason}. It is activated only when the change that made it passes its trial and validation.`, cite("environment-revision", `${agent}|${waiting.revision}`)));
    }
    return { observedAt: this.#runner.now(), lines };
  }

  /** The agents' environment change requests, newest page first as the service lists them: what was asked, the state, and why one waits. Owner only. */
  async maintenanceLines(by: Principal, q: { maintenanceId?: string; agent?: string; status?: string; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const svc = this.#deps.maintenance;
    if (by.kind !== "owner" || svc === undefined) return undefined;
    const items = q.maintenanceId !== undefined ? [await svc.get(by, q.maintenanceId)] : (await svc.list(by, { ...(q.status === undefined ? {} : { status: q.status }), ...(q.agent === undefined ? {} : { agentId: q.agent }), limit: q.limit ?? 20 })).items;
    if (items.length === 0) return { observedAt: this.#runner.now(), lines: [line("No environment change requests match.", cite("maintenance", "all"))] };
    const lines = items.map((m) => {
      const spec = (m["spec"] ?? {}) as Record<string, unknown>;
      const what = typeof spec["name"] === "string" ? `${String(m["kind"])} ${spec["name"]}${typeof spec["version"] === "string" ? ` ${spec["version"]}` : ""}` : String(spec["site"] ?? spec["mountPath"] ?? spec["setting"] ?? m["kind"]);
      const failure = m["failure"] as { reason?: string } | undefined;
      const effect = m["effect"] as { environmentRevision?: number } | undefined;
      const tail = m["status"] === "failed" && failure?.reason !== undefined ? ` - ${failure.reason}` : m["pendingReason"] !== undefined ? ` - waiting: ${String(m["pendingReason"])}` : m["status"] === "applied" && effect?.environmentRevision !== undefined ? ` - now revision ${effect.environmentRevision}` : "";
      return line(`${String(m["id"])}: ${String(m["agentId"])} asked for ${what}; ${String(m["status"])}${tail}`.slice(0, 400), cite("maintenance", String(m["id"]), typeof m["revision"] === "number" ? m["revision"] : undefined));
    });
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * The capacity settings the owner can change in chat, read back from the same services the state API reads (cards H10, H10b): the optional caps, the host and global quotas and the limits on spawning
   * child tasks. Every figure says whether it is the owner's own or the default, an off one says what that means, and a damaged record says what it stops - admission for the caps and the quotas, spawning
   * for the swarm limits - because that is what the services reading them really do. A group whose service is not here, whose record cannot be read or whose stored figures are not figures is one line and
   * the rest of the answer stands: nothing the records hold throws out of this view, and only a failure of the read itself is passed on. Owner only.
   */
  async capacityLines(by: Principal): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const settings = this.#deps.capacity;
    if (settings === undefined || by.kind !== "owner") return undefined;
    const lines: Line[] = [];
    // ---- the optional caps: off (nothing capped) unless the owner turned one on.
    const capsAbsent = cite("capacity-limits-settings", "main");
    if (settings.limits === undefined) lines.push(line("Capacity caps: this controller does not offer them.", capsAbsent));
    else {
      let caps: Awaited<ReturnType<NonNullable<typeof settings.limits>["get"]>> | undefined;
      try { caps = await settings.limits.get(by); } catch (error) { lines.push(line(`Capacity caps: ${capacityProblem(error, CAPS_DAMAGED)}.`, capsAbsent)); }
      if (caps !== undefined) {
        const c = cite("capacity-limits-settings", "main", caps.revision === 0 ? undefined : caps.revision);
        lines.push(line(`Capacity caps (your setting is at revision ${caps.revision}); all are off unless you turned one on:`, c));
        for (const name of CAP_NAMES) {
          const e = caps.limits[name];
          const words = e === undefined ? "off, nothing is capped (the default)"
            : e.enabled === true ? `${e.value} at once (you set it)`
              : `off, nothing is capped (you set it)${e.value === undefined ? "" : `, the kept figure ${e.value} turns it back on`}`;
          lines.push(line(`${name} (${capacityWord(name)}): ${words}`, c));
        }
      }
    }
    // ---- the host and global quotas: figures the owner set over the installation's defaults, and what holds them now.
    const quotaAbsent = cite("admission-state", "admission");
    if (settings.quotas === undefined) lines.push(line("Host and global quotas: this controller does not offer them.", quotaAbsent));
    else {
      let q: Awaited<ReturnType<NonNullable<typeof settings.quotas>["quotas"]>> | undefined;
      // A record the service itself cannot read (its list of what runs is not a list) fails as a plain TypeError, not a `DomainError`; like every other damage here it costs this group one line, never the whole answer.
      try { q = await settings.quotas.quotas(by); } catch (error) { lines.push(line(`Host and global quotas: ${error instanceof DomainError ? capacityProblem(error, quotasDamaged("it cannot be read at all")) : quotasDamaged("it cannot be read as figures")}.`, quotaAbsent)); }
      const problem = q === undefined ? undefined : quotaProblem(q);
      if (q !== undefined && problem !== undefined) lines.push(line(`Host and global quotas: ${quotasDamaged(problem)}.`, quotaAbsent));
      if (q !== undefined && problem === undefined) {
        const c = cite("admission-state", "admission", q.revision === 0 ? undefined : q.revision);
        const live: Readonly<Record<string, string>> = { productive: `; ${q.running.productive} running now`, perHost: "", control: `; ${q.running.control} of them in use now`, queue: `; ${q.waiting} waiting now` };
        // The number is the revision of the whole admission record - the same record admission writes for every request and release - so it is named as that rather than as the version of the setting.
        lines.push(line(`Host and global quotas (the admission record is at revision ${q.revision}, which every request and release also raises); the ones marked "you set it" are yours, the others are the installation's defaults:`, c));
        for (const name of Object.keys(q.limits)) {
          const value = (q.limits as Record<string, number>)[name]!;
          // Every lookup by a name read out of a record is an own-property one: a quota or host named `constructor` must not be compared with, or described by, what `Object.prototype` holds.
          const same = Object.hasOwn(q.defaults, name) && (q.defaults as Record<string, number>)[name] === value;
          lines.push(line(`${name} (${capacityWord(name)}): ${value}${same ? " (the default)" : " (you set it)"}${Object.hasOwn(live, name) ? live[name]! : ""}`, c));
        }
        const hosts = Object.entries(q.hosts).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
        if (hosts.length === 0) lines.push(line("No host has declared CPUs or memory, so work that needs a host is refused until you declare them (capacity.quotas.change).", c));
        for (const [id, cap] of hosts.slice(0, CAPACITY_HOSTS)) lines.push(line(`Host ${quoted(id, 80)}: ${cap.cpus} CPU(s), ${cap.memoryMb} MB declared (you declared it); ${runningOn(q.running.perHost, id)} productive attempt(s) running on it.`, c));
        if (hosts.length > CAPACITY_HOSTS) lines.push(line(`${hosts.length - CAPACITY_HOSTS} more host(s) are declared than are shown.`, c));
      }
    }
    // ---- the owner's limits on spawning child tasks.
    const swarmAbsent = cite("swarm-limits-settings", "main");
    if (settings.swarm === undefined) lines.push(line("Limits on spawning child tasks: this controller does not offer them.", swarmAbsent));
    else {
      let s: Awaited<ReturnType<NonNullable<typeof settings.swarm>["get"]>> | undefined;
      try { s = await settings.swarm.get(by); } catch (error) { lines.push(line(`Limits on spawning child tasks: ${capacityProblem(error, SWARM_DAMAGED)}.`, swarmAbsent)); }
      if (s !== undefined) {
        const c = cite("swarm-limits-settings", "main", s.revision === 0 ? undefined : s.revision);
        lines.push(line(`Limits on spawning child tasks (your setting is at revision ${s.revision}):`, c));
        const damaged = s.damaged.map((n) => String(n));
        // `SwarmService` takes its limits from `SwarmLimitsService.effective()`, which throws on a damaged record: while one name is unreadable no child task is made at all, so the group says that first.
        if (damaged.length > 0) lines.push(line(`The stored swarm limits are damaged at ${damaged.map((n) => shown(n, 30)).join(", ")}: no child task can be spawned until ${damaged.length === 1 ? "it is" : "they are"} repaired (swarm.limits.change).`, c));
        for (const name of Object.keys(SWARM_LIMIT_BOUNDS) as (keyof typeof SWARM_LIMIT_BOUNDS)[]) {
          const e = s.limits[name];
          const isDamaged = damaged.includes(name);
          // A name whose stored figure cannot be read is called damaged; a sound one says whether it is the owner's or the default, and that it is not in force while another name is damaged.
          const words = isDamaged ? "damaged: the figure stored cannot be read"
            : e === null ? "off, no total (you set it)"
              : e === undefined ? `${s.defaults[name]} (the default)`
                : `${e} (you set it)`;
          // A nought in either of the first two is the owner turning spawning off, which the figure alone does not say.
          const none = !isDamaged && (e === undefined ? s.defaults[name] : e) === 0
            ? name === "depth" ? ": no child task may be spawned at all" : ": no new child task may be spawned now" : "";
          lines.push(line(`${name} (${capacityWord(name)}): ${words}${none}${!isDamaged && damaged.length > 0 ? " - not in force while the record is damaged" : ""}`, c));
        }
      }
    }
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * The owner's release view (card X09b part 2): one candidate, or the newest `limit` of them, each with the gate per platform (pass, flaky pass, fail, interrupted, timed out, running or not run)
   * and its attempts with state, host and time (newest first, because what is open or just ended is what the owner is asking about), and what is staged and current when this controller stages
   * releases. Every text a host or a candidate carries (a result summary, a host name, a platform name) is quoted on one line, never followed. Owner only: to anyone else this reads exactly like a view
   * that does not exist. The answer stays inside 30 lines and the candidates stop being read once that is used up: the gate summary of everything shown, the staging line and (when anything was cut)
   * the line saying how many lines are not shown and how to get the rest are always inside them.
   */
  async releaseLines(by: Principal, request: { candidateId?: string; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const release = this.#deps.release;
    if (release === undefined || by.kind !== "owner") return undefined;
    if (request.candidateId !== undefined && (typeof request.candidateId !== "string" || request.candidateId.trim() === "" || request.candidateId.length > 120)) invalid("candidateId", "needs the candidate's ID (the rcn- ID release.submit returned)");
    const limit = request.limit ?? 5;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10) invalid("limit", "must be a whole number from 1 to 10");
    const platform = (cell: GateCell["cell"]): string => quoted(`${cell.os} ${cell.arch}${cell.osVersion === undefined ? "" : ` ${cell.osVersion}`}`, 60);
    const gateWords = (cell: GateCell): string => {
      const state = cell.state === "passed" ? cell.flaky ? `flaky pass (passed only after ${cell.earlierFailures.length} earlier failure${cell.earlierFailures.length === 1 ? "" : "s"})` : "pass" : cell.state === "failed" ? "fail" : cell.state === "missing" ? "not run" : cell.state === "timed_out" ? "timed out" : cell.state === "running" ? "running" : cell.state;
      return `${state} (${cell.attempts} attempt${cell.attempts === 1 ? "" : "s"})`;
    };
    const attemptWords = (a: ReleaseAttemptBody & { id: string }): string => `${a.state === "issued" ? "issued, still open" : a.state === "timed_out" ? "timed out" : a.state} on ${platform(a.cell)}, host ${quoted(a.hostId, 80)}, started ${shown(a.issuedAt, 30)}${a.endedAt === undefined ? "" : `, ended ${shown(a.endedAt, 30)}`}${a.result === undefined ? "" : `, the host said ${quoted(a.result.summary, 160)}`}${a.reason === undefined ? "" : `; reason: ${quoted(a.reason, 160)}`}`;
    const body: Line[] = [];
    let candidates: readonly CandidateRow[];
    let moreCandidates = false;
    let scanLimited = false;
    if (request.candidateId !== undefined) candidates = [{ candidateId: request.candidateId, submittedAt: "", submittedBy: "" }];
    else {
      let got;
      try { got = await release.candidates(by, { limit }); }
      catch (error) {
        if (error instanceof DomainError && (error.code === "forbidden" || error.code === "unavailable")) return undefined;
        throw error;
      }
      candidates = got.candidates;
      moreCandidates = got.more;
      scanLimited = got.scanLimited;
      if (candidates.length === 0) body.push(line("No release candidate has been submitted yet: release.submit is the start.", cite("release-candidates", "list")));
    }
    // What the owner always gets besides the candidates: the staging line and, when anything is cut, the line saying so (and the line saying candidates are left out). Reading stops once the rest is used up.
    const max = 30;
    const budget = max - 2 - (moreCandidates ? 1 : 0);
    let lineDropped = 0;
    let candidatesSkipped = 0;
    for (const candidate of candidates) {
      // The budget is gone: the rest of the candidates are not read at all (so a wide list costs one page of reads, not a hundred).
      if (body.length >= budget) { candidatesSkipped++; continue; }
      const c = cite("release-candidate", candidate.candidateId);
      // One read where the service can give the gate and the attempts together; otherwise the two reads, as before.
      let gate: Gate;
      let attempts: (ReleaseAttemptBody & { id: string })[];
      try {
        if (release.gateAndAttempts !== undefined) {
          const both = await release.gateAndAttempts(by, candidate.candidateId);
          gate = both.gate;
          attempts = [...both.attempts];
        } else {
          gate = await release.gate(by, candidate.candidateId);
          attempts = await release.attempts(by, candidate.candidateId);
        }
      }
      catch (error) {
        if (error instanceof DomainError && error.code === "forbidden") return undefined;
        if (error instanceof DomainError && error.code === "not_found") {
          // A named candidate that is missing or unreadable reads like a missing subject; a listed one (it moved in the moment of the read) is simply skipped.
          if (request.candidateId !== undefined) return undefined;
          continue;
        }
        throw error;
      }
      const block: Line[] = [line(`Candidate ${shown(candidate.candidateId, 120)}: ${gate.approved ? "approved" : "not approved"}; ${gate.ready ? "every platform passed" : "not ready yet"}${gate.needsAcknowledgement ? "; a platform passed only after earlier failures (flaky: an approval shows these failures and accepting it means accepting them)" : ""}.`, c)];
      for (const cell of gate.cells) block.push(line(`  ${platform(cell.cell)}: ${gateWords(cell)}`, c));
      // Newest first: what is running now, or the attempt that just ended, is what the owner is asking about.
      for (const a of [...attempts].reverse()) block.push(line(`  attempt ${shown(a.id, 80)}: ${attemptWords(a)}`, c, cite("release-attempt", a.id)));
      for (const l of block) { if (body.length < budget) body.push(l); else lineDropped++; }
    }
    const lines: Line[] = [...body];
    if (moreCandidates) lines.push(line(scanLimited ? "More candidates were submitted than are listed, and the list had to stop at its read bound, so some older ones were never read: name one (kind release with its candidateId) to read it directly." : "More candidates were submitted than are listed (the newest are first); ask again naming one (kind release with its candidateId) or with a larger limit (1 to 10).", cite("release-candidates", "list")));
    const staging = cite("release-activation", "main");
    if (release.status === undefined) lines.push(line("Staging: not set up on this controller; nothing is staged or activated to show.", staging));
    else {
      try {
        const st = await release.status(by);
        lines.push(line(`Staging: ${st.current === undefined ? "nothing has been activated yet" : `the current release is ${quoted(st.current.id, 80)} since ${shown(st.current.at, 30)}`}${st.previous === undefined ? "" : `; going back would return to ${quoted(st.previous.id, 80)}`}; ${st.staged.length} staged release${st.staged.length === 1 ? "" : "s"}; activation ${st.settings.requireApproval ? "needs the candidate approved (release.approve)" : "does not need an approval right now"}${st.diverged ? `; WARNING: the launcher's pointer says ${quoted(st.pointer ?? "nothing", 80)}, not the release the record calls current` : ""}.`, staging));
      } catch (error) {
        if (!(error instanceof DomainError) || (error.code !== "forbidden" && error.code !== "unavailable")) throw error;
        lines.push(line("Staging: not set up on this controller; nothing is staged or activated to show.", staging));
      }
    }
    // The cut is said last, and says what the owner can actually do: someone who named a candidate is not told to name one.
    const dropped = lineDropped + candidatesSkipped;
    if (dropped > 0) {
      const rest = request.candidateId === undefined
        ? "ask again naming one candidate (kind release with its candidateId), or read release.attempts for one candidate's attempts (the newest are shown first)"
        : "read release.attempts for every attempt of this candidate (the newest are shown here first)";
      lines.push(line(`${dropped}${candidatesSkipped === 0 ? "" : " or more"} more line(s) are not shown: ${rest}.`, cite(request.candidateId === undefined ? "release-candidates" : "release-candidate", request.candidateId ?? "list")));
    }
    return { observedAt: this.#runner.now(), lines };
  }

  /** The retention values in force and which of them the owner set. Owner only. */
  async retentionLines(by: Principal): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.retention === undefined || by.kind !== "owner") return undefined;
    let got;
    try { got = await this.#deps.retention.settings(by); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || (error.code === "unavailable" && error.field !== "settings"))) return undefined;
      // A damaged stored setting (and only that: any other storage trouble is not a reason to re-set values) is told, with the way out, rather than reading like a view that is not there.
      if (error instanceof DomainError && error.code === "unavailable") return { observedAt: this.#runner.now(), lines: [line("The stored retention setting is damaged; set it again (retention.settings.set).", cite("retention-settings", "main"))] };
      throw error;
    }
    const c = cite("retention-settings", "main", got.revision === 0 ? undefined : got.revision);
    const word = (v: unknown): string => (v === null ? "none (off or unlimited)" : String(v));
    const lines: Line[] = [
      line(`Retention values in force (settings revision ${got.revision}); the ones marked "set" are yours, the others are the installation's:`, c),
      ...Object.keys(got.effective).sort().map((k) => line(`${shown(k, 60)}: ${shown(word(got.effective[k]), 60)}${Object.prototype.hasOwnProperty.call(got.settings, k) ? " (set)" : ""}`, c)),
    ];
    if (this.#deps.retention.status !== undefined) {
      let st: Readonly<Record<string, unknown>> | undefined;
      try { st = await this.#deps.retention.status(by); } catch (error) {
        if (error instanceof DomainError && error.code === "forbidden") return undefined;
        lines.push(line("The disk, quota, backup and deletion figures could not be read just now; the values above are from your settings.", c));
      }
      if (st !== undefined) lines.push(...retentionStatusLines(st, c));
    }
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * Reconnected remote workers (card H09b): whether they take their attempts up again by themselves (and where that comes from), and the attempts that wait for the owner's decision, oldest attempt ID first, with what
   * `reconnect.reaccept` needs. Owner only. Remote workers that are not running here read as nothing waiting, said so.
   */
  async reconnectLines(by: Principal, request: { limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.reconnect === undefined || by.kind !== "owner") return undefined;
    const limit = request.limit === undefined ? 20 : Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 50 ? request.limit : invalid("limit", "must be 1 to 50");
    let s;
    try { s = await this.#deps.reconnect.get(by); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "unavailable")) return undefined;
      throw error;
    }
    const c = cite("reconnect-settings", "main", s.revision === 0 ? undefined : s.revision);
    const lines: Line[] = [
      line(`A worker that reconnects ${s.effective === "auto" ? "takes its attempt up again by itself" : "takes its attempt up again only when you approve it"} (${shown(s.effective, 10)}), from ${s.reaccept === null ? `the approval profile (${shown(s.profile, 20)})` : "your setting"}. An attempt waiting for you ${s.patienceHours === "off" ? "keeps no extra lease" : `keeps its lease for ${s.patienceHours} hour(s)`}${s.patienceChosen ? " (your choice)" : " (the default)"}.`, c),
    ];
    let pending;
    try { pending = await this.#deps.reconnect.pending(by, { limit }); } catch (error) {
      if (error instanceof DomainError && error.code === "unavailable") return { observedAt: this.#runner.now(), lines: [...lines, line("Remote workers are not running here, so no attempt waits for your decision.", c)] };
      if (error instanceof DomainError && error.code === "forbidden") return undefined;
      throw error;
    }
    if (pending.items.length === 0) lines.push(line("No reconnected worker waits for your decision.", c));
    for (const p of pending.items) {
      lines.push(line(`Attempt ${shown(p.attemptId, 40)} (placement ${p.placement}) on ${shown(p.hostId, 80)} waits for your decision since ${shown(p.at, 40)}; the worker's session is ${shown(p.sessionId, 40)}. Approve it or stop it (reconnect.reaccept).`, cite("attempt", p.attemptId)));
    }
    if (pending.next !== undefined) lines.push(line("More attempts wait than are shown.", c));
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * The approval load for the owner (card U08): decisions per day, the average wait, how many actions ran by rule, grant, agent review or the owner, every ask still waiting with its age (the oldest first, at most 10 shown),
   * the standing-rule proposals waiting for an answer with what each would have covered, and whether the profile question is due. Owner only. The pieces that are not running here are left out, said so.
   */
  async approvalLoadLines(by: Principal, days?: number): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.approvals === undefined || by.kind !== "owner") return undefined;
    const window = days === undefined ? 7 : Number.isSafeInteger(days) && days >= 1 && days <= 90 ? days : invalid("days", "must be a whole number from 1 to 90");
    const a = this.#deps.approvals;
    const f = await a.load.load(by, window);
    const c = cite("approval-load", "main");
    const minutes = (m: number): string => (m < 90 ? `${m} minute${m === 1 ? "" : "s"}` : m < 2880 ? `${Math.round(m / 60)} hours` : `${Math.round(m / 1440)} days`);
    const lines: Line[] = [
      line(`In the last ${f.days} day${f.days === 1 ? "" : "s"} you decided ${f.ownerDecisions} ask${f.ownerDecisions === 1 ? "" : "s"}${f.averageOwnerWaitMinutes === null ? "" : `, each after waiting ${minutes(f.averageOwnerWaitMinutes)} on average`}; agents decided ${f.agentDecisions}.`, c),
      line(Object.values(f.decidedBy).every((x) => x === 0) ? "No policy decision is recorded in this window, so there is no split between rule, standing grant, agent review and you." : `Of the actions the policy decided, ${f.decidedBy.rule} ran by a rule, ${f.decidedBy.grant} by a standing grant, ${f.decidedBy.agentReview} went to an agent review, ${f.decidedBy.owner} to you and ${f.decidedBy.denied} were denied.`, c),
      line(`Your decisions per day: ${f.perDay.map((d) => `${shown(d.day, 10)} ${d.ownerDecisions}`).join(", ")}.`, c),
    ];
    const waiting = f.pending.length;
    if (waiting === 0) lines.push(line("No ask is waiting.", c));
    else {
      lines.push(line(`${waiting} ask${waiting === 1 ? " is" : "s are"} waiting (longest first${waiting > 10 ? ", 10 shown" : ""}):`, c));
      for (const p of f.pending.slice(0, 10)) lines.push(line(`${shown(p.tool, 80)} for ${shown(p.requester, 80)} in project ${shown(p.projectId, 60)}, waiting on ${p.waitingOn === "owner" ? "you" : "an agent review"} for ${minutes(p.waitingMinutes)}.`, cite("review", p.reviewId)));
    }
    const allOpen = await a.load.proposals(by, "open");
    const open = allOpen.slice(-10);
    if (open.length === 0) lines.push(line("No standing-rule proposal waits for your answer.", c));
    else if (allOpen.length > open.length) lines.push(line(`${allOpen.length} standing-rule proposals wait for your answer (${open.length} shown).`, c));
    for (const p of open) {
      const b = p;
      lines.push(line(`Proposal ${shown(p.id, 40)} (revision ${p.revision}): you approved ${shown(b.cls, 40)} for ${shown(b.requester, 80)} in project ${shown(b.projectId, 60)} (${shown(b.environment, 20)}) ${b.count} times, and could instead let it stand as an approval grant for ${b.defaultLength?.days ?? b.suggestion.days} days${b.defaultLength === undefined ? "" : ` (${shown(b.defaultLength.why, 200)})`}. Accepting, or switching to the derived profile instead, or dismissing it, is your choice; nothing is applied until you answer.`, cite("standing-proposal", p.id, p.revision)));
    }
    const s = await a.suggestion.check(by);
    const sc = cite("profile-suggestion", "installation", s.revision === 0 ? undefined : s.revision);
    if (s.due) lines.push(line(`You are due to be asked about the derived profile (${s.kind === "trial-ended" ? "your trial of it has ended" : `you have approved ${s.approvalsSince} asks since the last answer`}): ${s.answers?.map((x) => shown(x, 20)).join(", ")} (the first is the default).${s.preview === undefined || s.preview.notes.length === 0 ? "" : ` Switching would change this: ${s.preview.notes.slice(0, 5).map((n) => shown(n, 300)).join("; ")}.`}`, sc));
    else lines.push(line("The derived-profile question is not due.", sc));
    return { observedAt: this.#runner.now(), lines };
  }

  /** What happens to running calls when a version is revoked and the revoke names no choice: the policy in force, where it comes from, and the owner's own setting. Owner only. */
  async catalogPolicyLines(by: Principal): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.catalogPolicy === undefined || by.kind !== "owner") return undefined;
    let p;
    try { p = await this.#deps.catalogPolicy.get(by); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "unavailable")) return undefined;
      throw error;
    }
    const where = p.source === "operator" ? "the operator's startup option, which beats your setting"
      : p.source === "setting" ? "your setting"
      : p.source === "damaged" ? "a safe fallback, because the stored setting is damaged"
      : "the default";
    const mine = p.damaged ? "Your stored setting cannot be read." : p.runningCalls === null ? "You have set none." : `Your setting is ${shown(p.runningCalls, 20)}${p.source === "operator" ? " (it does not apply while the startup option stands)" : ""}.`;
    const c = cite("catalog-policy", "main", p.revision === 0 ? undefined : p.revision);
    return { observedAt: this.#runner.now(), lines: [
      line(`When a tool version is revoked and no choice is named, running calls ${p.effective === "finish" ? "are let finish" : p.effective === "cancel" ? "are cancelled" : "are cancelled and their tasks paused"} (${shown(p.effective, 20)}), from ${where}.`, c),
      line(`${mine} The default is ${shown(p.default, 20)}.`, c),
      ...(p.damaged ? [line(p.source === "damaged" ? "The stored setting is damaged and reads as cancel until you set it again." : "The stored setting is damaged; it does not apply while the operator's startup option stands, and reads as cancel if that is removed before you set it again.", c)] : []),
    ] };
  }

  /** The tool versions the owner withdrew, newest first: which, why, by whom, when. Owner only; nothing of the tool itself. */
  async revocationLines(by: Principal, query: { name?: string; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.revocations === undefined || by.kind !== "owner") return undefined;
    const limit = query.limit === undefined ? 20 : Number.isSafeInteger(query.limit) && query.limit >= 1 && query.limit <= 50 ? query.limit : invalid("limit", "must be 1 to 50");
    let found;
    try { found = await this.#deps.revocations.list(by, { ...(query.name === undefined ? {} : { name: query.name }), limit }); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "unavailable")) return undefined;
      throw error;
    }
    const at = this.#runner.now();
    if (found.total === 0 && found.partial !== true) return { observedAt: at, lines: [line(query.name === undefined ? "No tool version has been revoked." : `No version of ${shown(query.name, 80)} has been revoked.`, cite("installation", "installation"))] };
    const lines: Line[] = found.items.map((r) => line(`${shown(r.name, 80)} ${shown(r.version, 20)} was revoked at ${shown(r.at, 40)} by ${shown(r.revokedBy, 80)}: ${shown(r.reason, 200)}.`, cite("catalog-revocation", derivedId("cav", `${r.name}|${r.version}`))));
    if (found.total > found.items.length) lines.push(line(`${found.total - found.items.length} more revocation(s) are not shown.`, cite("installation", "installation")));
    if (found.partial === true) lines.push(line("The catalogue is larger than was looked through; there may be more revocations than this list shows.", cite("installation", "installation")));
    return { observedAt: at, lines };
  }

  async databaseTransferLines(by: Principal): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.databaseTransfer === undefined || by.kind !== "owner") return undefined;
    const at = this.#runner.now();
    const st = await this.#deps.databaseTransfer.status(), se = await this.#deps.databaseTransfer.settings();
    const here = cite("installation", "installation");
    const lines: Line[] = [line(`The controller database is ${shown(st.source.name)} (${shown(st.source.kind)}). It can be moved to: ${st.targets.length === 0 ? "nowhere (no destination is configured)" : st.targets.map((t) => `${shown(t.name)} (${shown(t.kind)})`).join(", ")}.`, here)];
    lines.push(line(se.enabled ? "Moving the database is allowed." : "Moving the database is switched off.", here));
    lines.push(line(!se.restartOffered ? "The host restarts the controller itself after a move only if it was set up to; it was not, so the restart is yours." : se.restart ? "After a move the host restarts the controller onto the new database by itself." : "After a move the controller waits for you to restart it (the automatic restart is off).", here));
    const j = st.journal;
    if (j !== undefined) {
      lines.push(line(`The last move (${shown(j.id)}) to ${shown(j.to.name)}: ${shown(j.phase)}${j.note === undefined ? "" : `, ${shown(j.note)}`}.`, here));
      if (j.failure !== undefined) lines.push(line(`It failed: ${shown(j.failure.reason)}. ${j.failure.destinationClean ? "The destination is clean." : "A partial copy may be left at the destination; ask to remove it."}`, here));
      if (j.restart !== undefined) lines.push(line(j.restart.state === "failed" ? `The host could not restart the controller (${shown(j.restart.reason ?? "no reason given")}); restart it yourself.` : "The host was asked to restart the controller onto the database it moved to.", here));
    }
    return { observedAt: at, lines };
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

  /** What a Suspend or Stop has spent on cleanup, as charged to the budgets (card L02d). A task (`taskId`) or a scope (`scope: { kind, id }`, or flat as `scopeKind` and `scopeId`, the form chat uses) is named; a scope with no request of its own is answered from the nearest wider scope whose request reaches it (its agent, a team above that, a parent task of its swarm or the installation), and the lines say whose request it is; a scope with no request at all gets one line saying so; one the asker may not control reads as nothing. */
  async stopCleanupLines(by: Principal, asked: { readonly taskId?: string; readonly scope?: { readonly kind: string; readonly id: string }; readonly scopeKind?: string; readonly scopeId?: string }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.stops === undefined) return undefined;
    // The scope comes nested (`scope`) or flat (`scopeKind` and `scopeId`, the form chat uses); not both, and a flat one needs both parts.
    if ((asked.scopeKind === undefined) !== (asked.scopeId === undefined) || (asked.scope !== undefined && asked.scopeKind !== undefined)) return invalid("scope", "give scope, or scopeKind with scopeId");
    const request = { ...(asked.taskId === undefined ? {} : { taskId: asked.taskId }), ...(asked.scope !== undefined ? { scope: asked.scope } : asked.scopeKind !== undefined ? { scope: { kind: asked.scopeKind, id: asked.scopeId! } } : {}) };
    if ((request.taskId === undefined) === (request.scope === undefined)) return invalid("taskId", "name either a task or a scope");
    let scope: { kind: "task" | "agent" | "team" | "installation"; id: string };
    if (request.taskId !== undefined) scope = { kind: "task", id: checkTaskId(request.taskId) };
    else {
      const sc = request.scope as { kind?: unknown; id?: unknown };
      if (typeof sc !== "object" || sc === null || (sc.kind !== "task" && sc.kind !== "agent" && sc.kind !== "team" && sc.kind !== "installation") || typeof sc.id !== "string" || sc.id.length === 0 || sc.id.length > 200) return invalid("scope", "must be { kind: task, agent, team or installation, id }");
      scope = { kind: sc.kind, id: sc.id };
    }
    let r;
    try { r = await this.#deps.stops.cleanupSpend(by, scope); } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return undefined;
      throw error;
    }
    const at = this.#runner.now();
    const where = cite(scope.kind, scope.id);
    if (r === undefined) {
      // Only what is true for the kind: a task can be stopped through its agent, a team above that agent, a parent task of its swarm or the installation; an agent through its team, a team above that or the installation; a team through a team above it or the installation; the installation through nothing.
      const wider = scope.kind === "task" ? " (its agent, a team above that agent, a parent task in its swarm, or the whole installation)" : scope.kind === "agent" ? " (its team, a team above that, or the whole installation)" : scope.kind === "team" ? " (a team above it or the whole installation)" : undefined;
      return { observedAt: at, lines: [line(wider === undefined ? "No Suspend or Stop of the installation was requested." : `No Suspend or Stop was requested for ${scope.kind} ${shown(scope.id, 80)} itself, nor through a wider scope${wider}.`, where)] };
    }
    const money = (micros: number): string => (micros / 1_000_000).toFixed(6).replace(/0+$/, "").replace(/\.$/, ".0");
    const used = `${money(r.spent)} (budget currency)${r.spendBudget === undefined ? ", with no limit set" : `, against a limit of ${money(r.spendBudget)}`}`;
    // The cost of ending the work is billed once the ending has run, and only a Stop (a force stop says it in its own sentence) has one to come. A Stop that never reached the ending (restart from an earlier boundary, a resume) says nothing about it.
    const live = r.phase === "preparing" || r.phase === "blocked" || r.phase === "prepared" || r.phase === "terminating";
    // The ending has run when it was recorded as run, or the request is done as a stop (older records carry no flag; a stop is only done after its ending).
    const ranEnding = r.endingRan || (r.phase === "done" && r.mode !== "suspend");
    const onTop = r.mode !== "stop" ? "" : ranEnding ? "; the cost of ending the work is charged on top" : live ? "; the cost of ending the work, when it runs, is charged on top" : "";
    const forceTail = ranEnding ? "what ending the work cost is charged to the attempts below" : live ? "what ending the work costs, when it runs, is charged to the attempts below" : "no ending of the work is recorded";
    const reuseTail = r.mode !== "stop" ? "" : ranEnding ? "; the cost of ending the work is in them too" : live ? "; the cost of ending the work, when it runs, is added to them" : "";
    // The request the answer comes from may be one made for a scope above the one asked about, whose stop reaches it (card L02e): the figures are that scope's.
    const through = r.through;
    const askedName = `${scope.kind} ${shown(scope.id, 80)}`;
    const name = through === undefined ? askedName : through.kind === "installation" ? "the whole installation" : `${through.kind} ${shown(through.id, 80)}`;
    let head: string;
    if (r.mode === "force-stop") {
      head = r.reusedCheckpoint ? `The force stop of ${name} is ${r.phase}. Its preparation was the checkpoint of an earlier Suspend (that cost is in the attempt totals below); ${forceTail}.`
        : !r.forcedAfterPreparation ? `The force stop of ${name} is ${r.phase}. A Force Stop has no preparation; ${forceTail}.`
          : `The force stop of ${name} is ${r.phase}. Its last cleanup budget window before the Force Stop (a wait on a blocked preparation starts it again) used ${used}; ${forceTail}.`;
    } else if (r.reusedCheckpoint) head = `The ${r.mode} of ${name} is ${r.phase}. This Stop reused the checkpoint of the earlier Suspend; that preparation's cost is in the attempt totals below${reuseTail}.`;
    else head = `The ${r.mode} of ${name} is ${r.phase}. Its cleanup budget window (a wait on a blocked preparation starts it again) has used ${used}${onTop}.`;
    const lines: Line[] = [];
    if (through !== undefined) lines.push(line(`Nothing was asked for ${askedName} itself: this is the ${r.mode} of ${name}${r.requestedAt === undefined ? "" : `, asked ${shown(r.requestedAt, 60)}`}, which reaches it. Every figure is that scope's, not ${askedName} alone.`, cite("stop", r.intentId), where, cite(through.kind, through.id)));
    lines.push(line(head, cite("stop", r.intentId), where));
    // The window above starts again after each wait on a blocked preparation: when earlier windows counted something, the request's whole figure is told too (card L02e).
    if (typeof r.cumulativeSpent === "number" && r.cumulativeSpent > r.spent) lines.push(line(`Over all its cleanup budget windows (earlier ones counted ${money(r.cumulativeSpent - r.spent)}) this request has counted ${money(r.cumulativeSpent)} (budget currency) in total.`, cite("stop", r.intentId), where));
    for (const a of r.attempts.slice(0, 20)) lines.push(line(`Attempt ${shown(a.attemptId, 80)}: ${money(a.costMicros)} and ${a.computeMs} ms of compute charged to its task's budget in all (every stop of it counted once)${a.pending ? "; a further charge is still being made" : ""}.`, cite("stop", r.intentId)));
    if (r.attempts.length > 20) lines.push(line(`${r.attempts.length - 20} more attempt(s) are not listed.`, cite("stop", r.intentId)));
    if (r.attempts.length === 0) lines.push(line("No attempt with a charged cleanup cost is recorded on this request.", cite("stop", r.intentId)));
    if (r.unpaid) lines.push(line(r.markOnly ? "A charge failed when the request ended; this request has nothing left to charge, and the next sweep checks it again and clears this."
      : r.markKept ? "A charge failed when the request ended. This request was recorded by an older version, which did not note where that charge went, so no sweep will clear this; compare the attempt totals above with the task's budget spending to see whether it was charged."
        : r.scanCut ? "A charge failed when the request ended. More charges are open than this view reads, so whether this request still has some of its own to make is not known."
          : "Some of the cleanup spend is not charged yet; it is retried until it is.", cite("stop", r.intentId)));
    else if (r.scanCut) lines.push(line("More charges are open than this view reads, so a charge this request is still making on an attempt not listed above may not be shown.", cite("stop", r.intentId)));
    return { observedAt: at, lines };
  }

  /**
   * A task's starting sizes across its hand-offs (card C07i), from the watch's own record: the newest points, what older ones were rolled up into, the alerts open with where the originals are kept, and the thresholds in force.
   * A route whose window is not known has no share: it is said to be unknown, never shown as zero.
   */
  async startSizeLines(by: Principal, taskIdValue: string): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.startSizes === undefined) return undefined;
    const taskId = checkTaskId(taskIdValue);
    const r = await this.#deps.startSizes.read(by, { taskId });
    if (r === undefined) return undefined;
    const c = cite("ctx-start-size", derivedId("css", taskId), r.revision);
    const lines: Line[] = [];
    const s = r.settings;
    const thresholds = `The watch alerts once when the starting size rises over ${s.risingHandoffs} hand-offs in a row (each at least ${s.minRisePercent} percent larger) and warns once at ${s.warnPercent} percent of the route's startup limit; it never cuts or compacts anything.`;
    if (r.points.length === 0) return { observedAt: this.#runner.now(), lines: [line(`No first call of this task has been recorded yet. ${thresholds}`, cite("task", taskId))] };
    const first = r.rolled?.fromHandoff ?? r.points[0]!.handoff;
    lines.push(line(`${r.attempts} attempt${r.attempts === 1 ? "" : "s"} recorded, hand-offs ${first} to ${r.points[r.points.length - 1]!.handoff}.${r.rolled === undefined ? "" : ` The ${r.rolled.count} oldest (hand-offs ${r.rolled.fromHandoff} to ${r.rolled.toHandoff}) are rolled up: smallest ${r.rolled.minTokens}, largest ${r.rolled.maxTokens}, mean ${Math.round(r.rolled.sumTokens / r.rolled.count)} tokens.`}`, c, cite("task", taskId)));
    for (const p of r.points.slice(-10)) {
      const limit = p.limitTokens === undefined ? "its route's window is not known, so its share of a limit is unknown" : `${p.share} percent of the route's startup limit of ${p.limitTokens} tokens`;
      lines.push(line(`Hand-off ${p.handoff} (attempt ${shown(p.attemptId, 40)}, ${p.worker} worker, route ${shown(p.route, 80)}): ${p.tokens} tokens, ${limit}${p.admitted ? "" : "; the call was refused"}.`, c));
    }
    const how = (ref: string): string => (ref.startsWith("hnd-") ? `${ref} (handoff.get)` : ref.startsWith("hof-") ? `${ref} (context.handoff.read)` : ref.startsWith("sha256:") ? `${ref.slice(0, 19)}... (context.note-archive.read)` : ref);
    for (const a of [r.alerts.trend, r.alerts.share]) {
      if (a === undefined || a.state !== "open") continue;
      lines.push(line(`Alert open since ${a.openedAt}: ${startSizeAlertText(a)}. The originals are kept whole: ${[...a.refs.map(how), "cut hand-off sections in the handoff_archive status of the task"].join("; ")}.`, cite("ctx-start-size", a.id), cite("task", taskId)));
    }
    lines.push(line(thresholds, c));
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * The work report of a task (card W10): the latest attempt that wrote notes or a report, in full (its report, its running notes, the second agent's questions and the agent's answers, and how the questioning went, or that it
   * did not run and why), then the earlier attempts in one line each. Everything the agent or the second agent wrote is quoted once. Who may read it: whoever may see who works on the task (the owner, holders of `assignment.read` or
   * `assignment.manage`, the assigned agent).
   */
  async workReportLines(by: Principal, taskIdValue: string): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const taskId = checkTaskId(taskIdValue);
    const task = await this.#runner.get("task", taskId);
    if (task === undefined) return undefined;
    const body = task.body as unknown as TaskBody;
    if (!this.#mayReadTask(by, body.projectId, taskId) || !this.#mayReadAssignment(by, body.projectId, taskId, await this.#deps.assignments.getAssignment(taskId))) return undefined;
    const at = this.#runner.now();
    const pointer = (await this.#runner.get(WORK_REPORT_KIND, taskId))?.body as unknown as WorkReportTaskBody | undefined;
    const ids = [...(pointer?.attempts ?? [])].reverse();
    if (ids.length === 0) return { observedAt: at, lines: [line(`No attempt of ${shown(body.title)} has written running notes or ended with a report yet.`, cite("task", taskId))] };
    const lines: Line[] = [];
    for (const [i, attemptId] of ids.entries()) {
      const found = await this.#runner.get(DISPATCH_KIND, derivedId("dpa", attemptId));
      if (found === undefined) continue;
      const d = found.body as unknown as DispatchBody;
      const c = cite("dispatch", attemptId, found.revision);
      if (i === 0) { for (const text of reportLines(d)) lines.push(line(text, c, cite("task", taskId))); continue; }
      const r = d.report;
      lines.push(line(`Earlier: attempt ${shown(attemptId, 60)} ${r === undefined ? `left ${d.notes?.length ?? 0} note(s) and no report` : `ended ${shown(r.result, 20)} at ${r.at}${r.result === "done" && d.outcome !== undefined && d.outcome.status !== "succeeded" ? ` (the attempt itself finished ${d.outcome.status})` : ""} with a report (${r.questioning === "not-asked" ? "not questioned" : r.questioning === "not-run" ? "no second agent questioned it" : `questioned: ${r.questioning}`}): ${quoted(r.text, 200)}`}.`, c));
    }
    return { observedAt: at, lines };
  }

  /**
   * How each attempt of a task ended (card W08), newest first, at most `ATTEMPT_ENDINGS_LIMITS.attempts`: two lines each from its dispatch record (see `attemptEndingLines`), then the blockers of cards W03, W05 and W10 open on the task,
   * each with its summary (the controller's text, which quotes the agent's last words once). The attempts are found through the task's attempt record (written with each claim) and, for attempts claimed before it existed, the
   * W10 report record and the W03 count. Who may read it: as for the work report, whoever may see who works on the task. The report's text itself is in the `work_report` view, not repeated here.
   */
  async attemptEndingLines(by: Principal, taskIdValue: string): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const taskId = checkTaskId(taskIdValue);
    const task = await this.#runner.get("task", taskId);
    if (task === undefined) return undefined;
    const body = task.body as unknown as TaskBody;
    if (!this.#mayReadTask(by, body.projectId, taskId) || !this.#mayReadAssignment(by, body.projectId, taskId, await this.#deps.assignments.getAssignment(taskId))) return undefined;
    const at = this.#runner.now();
    const listed = async (kind: string): Promise<readonly string[]> => { const a = ((await this.#runner.get(kind, taskId))?.body as unknown as { attempts?: unknown } | undefined)?.attempts; return Array.isArray(a) ? a.filter((x): x is string => typeof x === "string").slice(-50) : []; };
    // In claim order: the task's attempt record (written with each claim) last, the attempts only the older records name before it (they were claimed before that record existed). Sorted by claim time after, ties kept in this order.
    const claimed = await listed(TASK_ATTEMPTS_KIND);
    const ids = new Set<string>();
    for (const id of [...await listed(STOPPED_EARLY_KIND), ...await listed(WORK_REPORT_KIND)]) if (!claimed.includes(id)) ids.add(id);
    for (const id of claimed) ids.add(id);
    const found: { d: DispatchBody; revision: number }[] = [];
    for (const id of ids) {
      const got = await this.#runner.get(DISPATCH_KIND, derivedId("dpa", id));
      const d = got?.body as unknown as DispatchBody | undefined;
      if (got !== undefined && d !== undefined && d.taskId === taskId) found.push({ d, revision: got.revision });
    }
    found.sort((a, b) => (a.d.claimedAt < b.d.claimedAt ? -1 : a.d.claimedAt > b.d.claimedAt ? 1 : 0));
    const lines: Line[] = [];
    if (found.length === 0) return { observedAt: at, lines: [line(`No attempt of ${shown(body.title)} is on record yet.`, cite("task", taskId))] };
    const shownCount = Math.min(found.length, ATTEMPT_ENDINGS_LIMITS.attempts);
    lines.push(line(`${found.length} attempt(s) of ${shown(body.title)} on record${found.length > shownCount ? `; the newest ${shownCount} are shown` : ""}, newest first.`, cite("task", taskId)));
    for (let i = found.length - 1; i >= found.length - shownCount; i--) {
      const { d, revision } = found[i]!;
      const c = cite("dispatch", d.attemptId, revision);
      for (const text of attemptEndingLines(d, i + 1)) lines.push(line(text, c, cite("task", taskId)));
    }
    // The blockers these endings leave, open on the task now, with what each says (the agent's words in it are quoted once by whoever opened it).
    const viewerIsOwner = by.kind === "owner";
    for (const type of Object.keys(ENDING_BLOCKER_WORDS) as EndingBlocker[]) {
      const b = await this.#deps.blockers.openFor(type, { kind: "task", id: taskId }).catch(() => undefined);
      if (b === undefined) continue;
      // The summary is bounded where it is written (1,000 characters); it is shown whole, as one line, so the agent's last words in it are not cut off.
      lines.push(line(`Open blocker ${type} since ${b.openedAt}: ${shown(b.summary, 1000)} The way out: ${routeFor(b.type, b.basis ?? defaultBasis(b.type), b.resolver, viewerIsOwner)}.`, cite("blocker", b.id, b.revision), cite("task", taskId)));
    }
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
    // The owner's marks matter before a hand-off starts (they apply to the next package), so they are shown with or without one (card C07j review).
    const marks = await this.#deps.handoffs.marks?.(by, { taskId }).catch(() => undefined);
    const marksLine = marks !== undefined && marks.marks.length > 0 ? [line(`When a section is cut, entries holding one of the owner's marks are kept first: ${marks.marks.map((m) => quotedLine(shown(m, 200))).join(", ")}.`, cite("task", taskId))] : [];
    if (h === undefined) return { observedAt: this.#runner.now(), lines: [line("No hand-off is going on for this task.", cite("task", taskId)), ...marksLine] };
    const lines: Line[] = [line(`Hand-off from ${shown(h.from.id)} to ${shown(h.to.id)}, ${h.mode}: ${h.phase}. Asked by ${shown(h.requestedBy)} at ${h.requestedAt}: ${quoted(h.reason)}`, cite("handoff", h.id, h.revision), cite("task", taskId))];
    if (h.returnAt !== undefined) lines.push(line(`It is temporary: the task goes back to ${shown(h.from.id)} at ${h.returnAt}, if whoever asked still holds the right to control it then.`, cite("handoff", h.id)));
    if (h.package !== undefined) lines.push(line(h.package.ready ? "The package is complete." : `The package is missing: ${h.package.missing.map((x) => shown(x)).join(", ")}.`, cite("handoff", h.id)));
    // Card C07j: a section cut to fit (or, card C07k, the completed work summarised past a fixed number of entries) says so here too, with where its whole text is kept.
    for (const cut of h.package?.cuts ?? []) lines.push(line(`The ${shown(cut.section, 40)} section was cut to fit or summarised: ${cut.left} of ${cut.total} entries left out or shortened (the owner's marked ones and the newest are kept). ${cut.archiveTruncated === true ? "The first 1,000,000 characters of it are" : "Its whole text is"} kept in archive ${shown(cut.archiveId, 40)} (ask for the handoff_archive status of the section, or the state API query handoff.archive.read).`, cite("handoff", h.id)));
    lines.push(...marksLine);
    if (h.acceptedGaps !== undefined) lines.push(line(`It was handed over with gaps accepted: ${h.acceptedGaps.missing.map((x) => shown(x)).join(", ")}.`, cite("handoff", h.id)));
    if (h.blocked !== undefined) lines.push(line(`It is held up: ${shown(h.blocked.reason)} You can choose: ${h.blocked.choices.join(", ")}.`, cite("handoff", h.id)));
    if (h.failure !== undefined) lines.push(line(`It failed: ${shown(h.failure)}`, cite("handoff", h.id)));
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * The whole of a hand-off section that was cut to fit (card C07j review, round 4), so nothing a cut left out is beyond the owner's reach by chat: by the archive ID a marker names, or by the task (its latest
   * hand-off, going on or finished) and the section. Each entry is shown as the source gave it (credentials were removed before it was kept), numbered from 1; an entry too long for one line goes on over the next
   * lines. One answer holds what a chat answer shows; its last line says the line to read on `from`. What the caller may not read reads as missing.
   */
  async handoffArchiveLines(by: Principal, request: { taskId?: string; archiveId?: string; section?: string; from?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const h = this.#deps.handoffs;
    if (h?.archive === undefined || h.cutsForTask === undefined) return invalid("kind", "hand-off archives are not offered here");
    const from = request.from === undefined ? 1 : Number.isSafeInteger(request.from) && request.from >= 1 ? request.from : invalid("from", "must be a line number from 1");
    if (request.section !== undefined && typeof request.section !== "string") return invalid("section", "must be text");
    let archiveId = request.archiveId;
    if (archiveId === undefined) {
      if (request.taskId === undefined) return invalid("taskId", "name the task, or the archive ID a cut marker names");
      const taskId = checkTaskId(request.taskId);
      const found = await h.cutsForTask(by, taskId);
      if (found === undefined) return undefined;
      const wanted = request.section?.trim().toLowerCase();
      const cuts = wanted === undefined ? found.cuts : found.cuts.filter((c) => c.section.toLowerCase() === wanted);
      if (cuts.length !== 1) {
        const head = found.cuts.length === 0 ? `Nothing was cut from the latest hand-off of this task (${found.phase}) that you may read: its package sections are whole.`
          : wanted === undefined ? `${found.cuts.length} sections of the latest hand-off of this task (${found.phase}) were cut to fit; say which to read.`
          : `The ${shown(request.section, 40)} section of the latest hand-off of this task (${found.phase}) was not cut, or is not yours to read; these were cut:`;
        return { observedAt: this.#runner.now(), lines: [line(head, cite("handoff", found.handoffId), cite("task", taskId)), ...found.cuts.map((c) => line(`The ${shown(c.section, 40)} section: ${c.left} of ${c.total} entries left out or shortened; whole in archive ${shown(c.archiveId, 40)}.`, cite("handoff", found.handoffId)))] };
      }
      archiveId = cuts[0]!.archiveId;
    }
    if (typeof archiveId !== "string") return invalid("archiveId", "must be text");
    // The archive is read whole (at most 1,000,000 characters, in parts) and shown entry by entry, each over as many lines as it needs, so `from` names a line of this view.
    const first = await h.archive(by, { archiveId });
    if (first === undefined) return undefined;
    let text = first.text;
    for (let part = 1; part < first.parts; part++) { const next = await h.archive(by, { archiveId, part }); if (next === undefined) return undefined; text += next.text; }
    const WIDTH = 380;
    const rows: string[] = [];
    text.split("\n").forEach((raw, n) => {
      // Control characters and the characters some readers break a line at are written as escapes, so each line of the answer is one line wherever it is shown.
      const entry = raw.replace(/[\p{Cc}\u2028\u2029]/gu, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
      let at = 0;
      do { const piece = safeSlice(entry.slice(at, at + WIDTH + 1), WIDTH); rows.push(at === 0 ? `${n + 1}: ${piece}` : `${n + 1} (continued): ${piece}`); at += Math.max(piece.length, 1); } while (at < entry.length);
    });
    if (from > rows.length) return invalid("from", `this section is ${rows.length} lines long`);
    const cites = [cite("handoff", first.handoffId), cite("task", first.taskId)];
    // A heading line and a closing line around the rows, within the 30 lines a chat answer shows.
    const shownRows = rows.slice(from - 1, from - 1 + 28);
    const to = from - 1 + shownRows.length;
    return { observedAt: this.#runner.now(), lines: [
      line(`The ${shown(first.section, 40)} section of hand-off ${shown(first.handoffId, 40)} as the source gave it (credentials removed): ${text.split("\n").length} entries, ${first.chars} characters${first.truncated === true ? ` (only its first ${text.length} characters were kept)` : ""}.`, ...cites),
      ...shownRows.map((r) => line(r, ...cites)),
      line(to >= rows.length ? `Lines ${from} to ${to} of ${rows.length}: that is the end.` : `Lines ${from} to ${to} of ${rows.length}; ask again with from ${to + 1} to read on.`, ...cites),
    ] };
  }

  /** The meetings planned in a project, soonest first: the title, the kind, when, how it is held and who is on the roster with how each is placed (present, unavailable, paused...), then the project's stand-ups by their latest occurrence — when each ran or is planned and its state — most recent first (card M03h). Nothing for a project the caller may not read. */
  /**
   * The briefs prepared for one stand-up, or one agent's, in plain lines (card M03h): what the agent did, what is unfinished, what blocks it, the advice it needs, its priorities, and the notes added to it, each marked as the agent's or the owner's.
   * What the reader may not see reads as missing. Entries come from the records the brief was made from and cite them; the statements are words, not records.
   */
  async standupQuestionLines(by: Principal, request: { projectId: string }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.standups?.ownerQuestions === undefined) return undefined;
    const projectId = checkProjectId(request.projectId);
    if (by.kind === "owner" && (await this.#runner.get("project", projectId)) === undefined) return undefined;
    // A caller who may not read the project's meetings reads this as missing, as the other views do (not as a refusal).
    const source = this.#deps.standups.ownerQuestions;
    let read: Awaited<ReturnType<typeof source>>;
    try { read = await this.#deps.standups.ownerQuestions(by, projectId); } catch (error) { if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return undefined; throw error; }
    const { open, answered } = read;
    // Only the owner is the one being waited on; another reader (a manager, a host) sees whose answer it is.
    const mine = by.kind === "owner";
    const lines: Line[] = [];
    for (const q of open) lines.push(line(`${mine ? "Waiting for your answer" : "Waiting for the owner's answer"}, from the stand-up topic ${quoted(q.topic)}: ${quoted(q.question)} (asked ${q.askedAt}).`, cite("owner-question", q.id, q.revision), cite("project", projectId)));
    for (const q of answered) lines.push(line(`Answered, about ${quoted(q.topic)}: ${quoted(q.question)} ${mine ? "Your answer" : "The owner's answer"}: ${quoted(q.answer ?? "")} (${q.answeredAt ?? "no time recorded"}).`, cite("owner-question", q.id, q.revision), cite("project", projectId)));
    if (lines.length === 0) lines.push(line("No stand-up has asked the owner anything in this project.", cite("project", projectId)));
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * The agents in plain lines with the coordinator marked and its lifecycle state (card U03c), for the owner who asks in chat. Read only, from the agent and coordinator records; each line cites its records.
   * The rules are `agent.list`'s: whoever may not read agents reads this as missing, and only the owner (not a task credential) is told which agent is the coordinator. An agent's name, roles and team are
   * words someone else wrote, so they are shown quoted and clipped, and so is a pause's reason; the figures and states are the controller's. At most 50 agents are listed (default 20), and a longer list says so.
   */
  async agentLines(by: Principal, request: { state?: string; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const source = this.#deps.agents;
    if (source === undefined) return undefined;
    if (request.state !== undefined && request.state !== "active" && request.state !== "retired") invalid("state", "must be active or retired");
    const state: "active" | "retired" = request.state === "retired" ? "retired" : "active";
    const limit = request.limit === undefined ? 20 : Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 50 ? request.limit : invalid("limit", "must be 1 to 50");
    let listed: Awaited<ReturnType<typeof source.list>>;
    // One more than the page is asked for, so a list of exactly `limit` agents is not said to have more (the agent list gives `next` whenever a page is full).
    try { listed = await source.list(by, { state, limit: limit + 1 }); } catch (error) { if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return undefined; throw error; }
    const more = listed.items.length > limit || listed.next !== undefined;
    listed = { items: listed.items.slice(0, limit), ...(more ? { next: listed.next ?? listed.items[limit]!.id } : {}) };
    // Only the owner who is not a task credential is told which agent is the coordinator; a coordinator that cannot be read marks nothing (the list still works).
    const mayMark = by.kind === "owner" && by.taskScope === undefined && source.coordinator !== undefined;
    let coordinator: CoordinatorRowView | undefined;
    let coordinatorKnown = false;
    if (mayMark) { try { coordinator = await source.coordinator!(by); coordinatorKnown = true; } catch { coordinator = undefined; } }
    const hostedId = coordinator?.hosted?.agentId;
    const coordinatorWords = (c: CoordinatorRowView): string => {
      const held = (c.lifecycle?.heldBy ?? []).slice(0, 3).map((h) => `${shown(h.scope.kind, 20)} ${shown(h.scope.id, 60)}${h.observed === undefined ? "" : `, reported ${shown(h.observed, 20)}`}${h.reason === undefined ? "" : `, reason ${quoted(h.reason, 120)}`}${h.by === undefined ? "" : `, by ${shown(h.by, 60)}`}`);
      const more = (c.lifecycle?.heldBy.length ?? 0) - held.length;
      return `${shown(c.state, 20)}${held.length === 0 ? "" : `, held by the pause on ${held.join("; ")}${more > 0 ? ` and ${more} more` : ""}`}`;
    };
    const lines: Line[] = [line(`${listed.items.length}${listed.next === undefined ? "" : " or more"} ${state} agent${listed.items.length === 1 && listed.next === undefined ? "" : "s"}${listed.next === undefined ? "" : ` (the first ${listed.items.length}; ask with a larger limit for more)`}.`, cite("agents", state))];
    const seen = new Set<string>();
    for (const a of listed.items) {
      seen.add(a.id);
      const mark = a.id === hostedId && coordinator !== undefined;
      const roles = a.roles.slice(0, 5).map((r) => shown(r, 40));
      lines.push(line(`${quoted(a.friendlyName, 80)} (${shown(a.id, 60)}): ${shown(a.state, 20)}${roles.length === 0 ? "" : `, roles ${roles.join(", ")}${a.roles.length > roles.length ? ` and ${a.roles.length - roles.length} more` : ""}`}${a.teamId === undefined ? "" : `, team ${shown(a.teamId, 60)}`}${mark ? `. This agent is the coordinator: ${coordinatorWords(coordinator!)}` : ""}.`, cite("agent", a.id, a.revision), ...(mark ? [cite("coordinator", coordinator!.id, coordinator!.revision)] : [])));
    }
    if (coordinator !== undefined) {
      if (hostedId === undefined) lines.push(line(`The coordinator is not an agent: it runs under ${shown(coordinator.principalId, 80)} and is ${coordinatorWords(coordinator)}.`, cite("coordinator", coordinator.id, coordinator.revision)));
      else if (!seen.has(hostedId)) lines.push(line(`The coordinator is the agent ${shown(hostedId, 60)}, which is not in this list: ${coordinatorWords(coordinator)}.`, cite("coordinator", coordinator.id, coordinator.revision), cite("agent", hostedId)));
    } else if (coordinatorKnown) lines.push(line("No coordinator is set up.", cite("coordinator", COORDINATOR_RECORD)));
    // A coordinator that could not be read is said to be so: the owner who asks whether it runs is not left to read silence as "none".
    else if (mayMark) lines.push(line("Which agent is the coordinator could not be read just now; ask again shortly.", cite("coordinator", COORDINATOR_RECORD)));
    return { observedAt: this.#runner.now(), lines };
  }

  async standupBriefLines(by: Principal, request: { occurrenceId: string; agent?: string }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const briefs = this.#deps.standups?.briefs;
    if (briefs === undefined) return undefined;
    if (typeof request.occurrenceId !== "string" || request.occurrenceId === "") invalid("occurrenceId", "must be a stand-up occurrence ID");
    if (request.agent !== undefined && (typeof request.agent !== "string" || request.agent === "")) invalid("agent", "must be an agent ID");
    const all = (await this.#deps.standups!.briefs!(by, request.occurrenceId)).filter((b) => request.agent === undefined || b.agent === request.agent);
    const lines: Line[] = [];
    const sections: readonly [string, "accomplishments" | "unfinished" | "blockers" | "advice" | "priorities"][] = [["Done", "accomplishments"], ["Unfinished", "unfinished"], ["Blocked", "blockers"], ["Advice needed", "advice"], ["Priorities", "priorities"]];
    for (const b of all) {
      const who = shown(b.agent);
      lines.push(line(`${who}'s brief: ${sections.map(([label, key]) => `${b[key].length} ${label.toLowerCase()}`).join(", ")}${b.partial ? ". Some records could not be read, so it may be incomplete" : ""}.`, cite("standup-brief", b.id, b.revision)));
      for (const [label, key] of sections) for (const e of b[key].slice(0, 5)) lines.push(line(`${who} - ${label}: ${quoted(e.text)}`, ...e.cites));
      for (const st of b.statements) lines.push(line(`${st.by === "owner" ? "A note from the owner" : `${who}'s own words`} (${st.section}): ${quoted(st.text)}`, cite("standup-brief", b.id, b.revision)));
    }
    if (all.length === 0) lines.push(line("No brief has been prepared for that stand-up yet, or none is yours to read.", cite("meeting", request.occurrenceId)));
    return { observedAt: this.#runner.now(), lines };
  }

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
    if (this.#deps.standups !== undefined) {
      const recent = await this.#deps.standups.recent(by, projectId, { limit });
      if (recent !== undefined) {
        for (const s of recent.items) lines.push(line(`${shown(s.title)}: stand-up, ${s.startsAt}, ${s.state}.`, cite("meeting", s.occurrenceId, s.revision), cite("project", projectId)));
        if (recent.more === true) lines.push(line("There are more stand-ups than shown.", cite("project", projectId)));
      }
    }
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * A project's stand-ups themselves (card M03h), two lines each. The first is the schedule: its title (quoted, because one set up by an agent is that agent's wording), whether it is active, paused or ended, how often and at what time it is
   * held, how long it lasts, the hours of the day it must lie within and who is on its roster. The second is its meetings: the one coming up next, the last one held and how many it has made. Ended stand-ups are left out but counted, so the
   * answer says when it did. Nothing for a project the caller may not read, and nothing when the stand-up service is not running.
   */
  async standupLines(by: Principal, request: { projectId: string; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const source = this.#deps.standups;
    if (source?.overview === undefined) return undefined;
    const projectId = checkProjectId(request.projectId);
    const limit = request.limit === undefined ? 10 : Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 25 ? request.limit : invalid("limit", "must be 1 to 25");
    if (by.kind === "owner" && (await this.#runner.get("project", projectId)) === undefined) return undefined;
    const page = await source.overview(by, projectId, { limit });
    if (page === undefined) return undefined;
    const ended = page.ended === undefined ? 0 : page.ended;
    const lines: Line[] = [];
    for (const s of page.items) {
      const cites = [cite("meeting-schedule", s.scheduleId, s.revision), cite("project", projectId)];
      const listed = s.roster.slice(0, STANDUP_ROSTER_LISTED).map((a) => shown(a));
      const roster = s.roster.length === 0
        ? "Nothing is on its roster."
        : `On the roster: ${listed.join(", ")}${s.roster.length > listed.length ? `, and ${s.roster.length - listed.length} more` : ""}.`;
      lines.push(line(`${quoted(s.title)}: ${s.state}, ${s.recurrence} at ${s.time} ${shown(s.timeZone)}, ${s.durationMinutes} minutes${s.window === undefined ? "" : `, held between ${s.window.from} and ${s.window.to}`}. ${roster}`, ...cites));
      const occ: Cite[] = [];
      if (s.nextOccurrenceId !== undefined) occ.push(cite("meeting", s.nextOccurrenceId, s.nextRevision));
      if (s.lastOccurrenceId !== undefined) occ.push(cite("meeting", s.lastOccurrenceId, s.lastRevision));
      const ahead = s.nextAt === undefined ? "nothing is planned for it ahead" : `next one ${s.nextAt}`;
      const behind = s.lastAt === undefined ? "it has not met yet" : `its last meeting was ${s.lastAt}${s.lastState === undefined ? "" : `, ${s.lastState}`}`;
      lines.push(line(`${ahead}; ${behind}; ${s.occurrences} meeting${s.occurrences === 1 ? "" : "s"} of it so far${s.endsOn === undefined ? "" : `, and no more after ${s.endsOn}`}.`, ...occ, ...cites));
    }
    if (lines.length === 0) {
      lines.push(line(ended === 0 ? "No stand-up is set up in this project." : `This project has no stand-up running; ${ended} ended ${ended === 1 ? "one is" : "ones are"} not shown.`, cite("project", projectId)));
      return { observedAt: this.#runner.now(), lines };
    }
    if (page.more === true) lines.push(line("There are more stand-ups than shown.", cite("project", projectId)));
    if (ended > 0) lines.push(line(`${ended} ended stand-up${ended === 1 ? "" : "s"} of this project ${ended === 1 ? "is" : "are"} left out.`, cite("project", projectId)));
    return { observedAt: this.#runner.now(), lines };
  }

  /** What happened to the changes meetings decided, as plain lines (card M02g): the owner's reading of the decision log. The log is stored in ID order (not time order), so a reading is one page of `limit` stored entries (the log reader scans at most 2000 to fill it), shown newest first within the page, and `after` continues with the next page; a later page can hold newer entries than an earlier one. Anyone but the owner gets nothing. */
  async decisionLogLines(by: Principal, request: { projectId?: string; changeKind?: string; outcome?: string; after?: string; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (this.#deps.decisionLog === undefined) return undefined;
    if (by.kind !== "owner" || by.taskScope !== undefined) return undefined;
    const limit = request.limit === undefined ? 10 : Number.isSafeInteger(request.limit) && request.limit >= 1 && request.limit <= 50 ? request.limit : invalid("limit", "must be 1 to 50");
    const projectId = request.projectId === undefined ? undefined : checkProjectId(request.projectId);
    if (request.changeKind !== undefined && (typeof request.changeKind !== "string" || request.changeKind.length === 0 || request.changeKind.length > 80)) invalid("changeKind", "must be a kind of change, such as budget.raise");
    const page = await this.#deps.decisionLog(by, { limit, ...(projectId === undefined ? {} : { projectId }), ...(request.changeKind === undefined ? {} : { kind: request.changeKind }), ...(request.outcome === undefined ? {} : { outcome: request.outcome }), ...(request.after === undefined ? {} : { after: request.after }) });
    const newestFirst = [...page.entries].sort((a, b) => (a.changedAt < b.changedAt ? 1 : a.changedAt > b.changedAt ? -1 : a.id < b.id ? -1 : 1));
    const lines: Line[] = newestFirst.slice(0, limit).map((e) => {
      const b = e;
      const who = b.decidedBy === "owner" ? "you allowed it" : b.decidedBy === "policy" ? `the approval policy let it through${b.setting === undefined ? "" : ` (${b.widens ?? "widening"}: ${b.setting})`}` : b.decidedBy === "vote" ? "the team's vote alone" : b.decidedBy === "steward" ? "the steward agent decided" : "nobody started it";
      return line(`${b.changedAt}: ${shown(b.kind)} on a ${shown(b.targetKind)}: ${b.outcome}${b.code === undefined ? "" : ` (${shown(b.code)})`}; ${who}.`, cite("meeting-decision-log", b.id, b.revision), cite("meeting-decision", b.decisionId), cite("project", b.projectId));
    });
    const more = page.next !== undefined || page.scanLimited === true;
    if (lines.length === 0) lines.push(line(more ? `Nothing matched in the part of the log searched so far; ask again with after "${page.next ?? ""}" to search further.` : "No meeting decision matches."));
    else if (more) lines.push(line(`The log has more entries; go on with after "${page.next ?? ""}". The log is read in its stored order (by entry ID, which is not time order); each page is shown newest first.`));
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
      `${n + 1}. ${quoted(i.topic)} (${i.urgency}, ${i.intent}, ${i.state}) asked by ${shown(i.requestedBy)}${i.question === undefined ? "" : `: ${quoted(i.question)}`}${i.requestedOutcome === undefined ? "" : ` Outcome asked for: ${quoted(i.requestedOutcome)}.`}${i.timeboxMinutes === undefined ? "" : ` Timebox ${i.timeboxMinutes} minutes.`}`,
      cite("agenda", i.id, i.revision), cite("project", projectId)));
    if (lines.length === 0) lines.push(line("Nothing is waiting on the agenda of this project.", cite("project", projectId)));
    else if (open.next !== undefined) lines.push(line("There are more topics than shown.", cite("project", projectId)));
    return { observedAt: this.#runner.now(), lines };
  }

  /**
   * What the model was thinking while it worked on a task (card U09b), for the owner only. It is the explicit expansion of the replay's collapsed thinking, so it is a recorded look with a reason (the same step as `activity.replay.thinking`),
   * shown as the model's own words: untrusted, quoted, labelled, never a reason for any decision and never an instruction. Anyone but the owner gets no answer.
   */
  async thinkingLines(by: Principal, request: { taskId: string; after?: number; limit?: number }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const read = this.#deps.replay?.thinking;
    if (read === undefined || by.kind !== "owner") return undefined;
    const taskId = checkTaskId(request.taskId);
    const task = cite("task", taskId);
    if (request.after !== undefined && (!Number.isSafeInteger(request.after) || request.after < 0)) invalid("after", "must be a block number from the previous answer");
    try {
      const got = await this.#deps.replay!.thinking!(by, { commandId: `chat-thinking-${randomUUID()}`, taskId, reason: "the owner asked to see it in the chat", ...(request.after === undefined ? {} : { after: { entryId: request.after, block: 0 } }), limit: Math.min(request.limit ?? 5, 20) });
      if (got.state !== "stored") return { observedAt: this.#runner.now(), lines: [line(got.label, task)] };
      const lines: Line[] = [line(got.blocks.length === 0 ? "No thinking is kept for this task past that point." : `${REPLAY_LABELS.thinking} ${got.blocks.length} block${got.blocks.length === 1 ? "" : "s"} follow, each quoted.`, task)];
      for (const b of got.blocks) lines.push(line(`Block ${b.entryId} (${shown(b.model)}): ${b.opaque ? "the provider kept this block private" : quoted(b.text, 700)}${b.redacted ? " [something that looked like a credential was hidden]" : ""}`, task));
      if (got.next !== undefined) lines.push(line(`More follows; continue after block ${got.next.entryId}.`, task));
      return { observedAt: this.#runner.now(), lines };
    } catch (error) {
      if (error instanceof DomainError && error.code === "not_found") return { observedAt: this.#runner.now(), lines: [line("No thinking is kept for this task: it has not run, the owner's collection switch was off while it ran, the model returned none, or retention removed it.", task)] };
      if (error instanceof DomainError && error.code === "forbidden") return { observedAt: this.#runner.now(), lines: [line(`Refused: ${quoted(error.message, 200)}`, task)] };
      throw error;
    }
  }

  /**
   * Replay of a task's activity in plain lines (card U09): without `seq` a summary and a window of steps; with `seq` that step in full with what led to it. Read only: nothing is run, sent, submitted or asked of a model.
   * Where a step stood, the branch it is on, whether a later step replaced it, redactions and gaps are said in words; an agent's words are shown as such.
   */
  async replayLines(by: Principal, request: { taskId: string; seq?: number; from?: number; limit?: number; lane?: string; agent?: string; stepKind?: string; since?: string; until?: string }): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    const replay = this.#deps.replay;
    if (replay === undefined) return undefined;
    const taskId = checkTaskId(request.taskId);
    const task = cite("task", taskId);
    // Whatever someone recorded (a summary, a reason, a reference) is quoted; only the controller's own words and checked values (numbers, kinds, line names, principal IDs) are not.
    const describe = (s: ReplayStep): string => [
      `Step ${s.seq}, ${s.at}, ${shown(s.actor)}: ${s.kind} - ${quoted(s.summary)}`,
      `(${s.outcome === "not-recorded" ? REPLAY_LABELS.notRecorded : `${s.outcome}${s.outcomeNote === undefined ? "" : `, ${s.outcomeNote}`}`}${s.lane === "main" ? "" : `, branch ${shown(s.lane)}${s.laneNote === undefined ? "" : ` (${s.laneNote})`}`}${s.authority === "superseded" ? `, replaced by step ${(s.supersededBy ?? []).join(", ")}: ${REPLAY_LABELS.superseded}` : ""}${s.content.state === "stored" && (s.content.redactions ?? 0) > 0 ? `, ${s.content.redactions} redaction${s.content.redactions === 1 ? "" : "s"}` : ""}${s.content.state === "missing" ? `, content missing: ${quoted(s.content.reason)}` : ""}${s.corrections > 0 ? `, ${s.corrections} correction${s.corrections === 1 ? "" : "s"}` : ""})`,
    ].join(" ");
    const ref = (kind: string | undefined, id: string | undefined, version: string | undefined): string => `${shown(kind ?? "")} ${quoted(id ?? "", 120)}${version === undefined ? "" : ` @${quoted(version, 80)}`}`;
    // A step may cite up to 100 references and many pieces of evidence: one chat line names the first ones and counts the rest (activity.replay.step and .led give them all).
    const listed = (items: readonly string[], sep: string, max = REPLAY_LINE_ITEMS): string => `${items.slice(0, max).join(sep)}${items.length > max ? `${sep}and ${items.length - max} more` : ""}`;
    const counted = (items: readonly { name: string; steps: number }[], max = 10): string => `${items.slice(0, max).map((x) => `${x.name} (${x.steps})`).join(", ")}${items.length > max ? ` and ${items.length - max} more` : ""}`;
    try {
      if (request.seq !== undefined) {
        const d = await replay.step(by, taskId, request.seq);
        const led = await replay.led(by, taskId, request.seq);
        const lines: Line[] = [line(describe(d.step), task)];
        lines.push(line(d.step.versionsThen.state === "recorded" ? `Context then: ${d.step.versionsThen.refs.length === 0 ? "none listed" : listed(d.step.versionsThen.refs.map((r) => ref(r.kind, r.id, r.version)), ", ")}${d.step.versionsThen.summaryId === undefined ? "" : `; summary ${quoted(d.step.versionsThen.summaryId, 120)} stood in for earlier history`}.` : `Context then: not recorded (${quoted(d.step.versionsThen.reason)}).`, task));
        for (const e of d.explanations.contemporaneous.items) lines.push(line(`${REPLAY_LABELS.contemporaneous} ${shown(e.by)} chose ${quoted(e.choice)}. Uncertain: ${quoted(e.uncertainty)}`, task));
        for (const e of d.explanations.retrospective.items) lines.push(line(`${REPLAY_LABELS.retrospective} ${quoted(e.choice, 400)}`, task));
        lines.push(line(led.grounded ? `Led to this step (links, not reasons): ${listed(led.links.map((l) => (l.seq !== undefined ? `step ${l.seq} (${l.relation})` : l.kind !== undefined ? `${ref(l.kind, l.id, l.version)} (${l.relation})` : `${l.relation}: ${quoted(l.note ?? "")}`)), "; ")}.` : led.note, task));
        if (d.thinking !== undefined) lines.push(line(d.thinking.state === "removed-by-retention" || d.thinking.state === "unavailable" ? d.thinking.label : "The model's thinking is kept collapsed; ask to expand it. It is model output, not an explanation.", task));
        return { observedAt: this.#runner.now(), lines };
      }
      // The chat names the kind of step `stepKind`; a refusal names it so too.
      if (request.stepKind !== undefined && !(ACTIVITY_KINDS as readonly unknown[]).includes(request.stepKind)) invalid("stepKind", `must be one of ${ACTIVITY_KINDS.join(", ")}`);
      const v = await replay.open(by, taskId, {
        ...(request.from === undefined ? {} : { from: request.from }), limit: request.limit ?? 10, ...(request.lane === undefined ? {} : { lane: request.lane }), ...(request.agent === undefined ? {} : { actor: request.agent }),
        ...(request.stepKind === undefined ? {} : { kind: request.stepKind }), ...(request.since === undefined ? {} : { since: request.since }), ...(request.until === undefined ? {} : { until: request.until }),
      });
      const sm = v.summary;
      const lines: Line[] = [line(`${sm.total} step${sm.total === 1 ? "" : "s"}${sm.scanLimited ? ` (steps ${sm.range.first} to ${sm.range.last} of ${sm.range.of}; the record is longer)` : ""}; ${sm.lanes.length} line${sm.lanes.length === 1 ? "" : "s"} of work; ${sm.unavailable.length} unavailable; ${sm.superseded} replaced; ${sm.stepsWithoutManifest} without a recorded context.`, task)];
      // Lines of work and agents to follow: each can be asked for on its own (lane, agent).
      if (sm.lanes.length > 0) lines.push(line(`Lines of work: ${counted(sm.lanes.map((l) => ({ name: shown(l.lane), steps: l.steps })))}. Agents: ${counted(sm.agents.map((a) => ({ name: shown(a.actor), steps: a.steps })))}.`, task));
      for (const e of v.entries) lines.push("unavailable" in e ? line(`Step ${e.seq} is no longer available: ${quoted(e.unavailable)}.`, task) : line(describe(e), task));
      if (v.entries.length === 0 && sm.total > 0) lines.push(line("No step in this window matches.", task));
      if (v.note !== undefined) lines.push(line(v.note, task));
      if (v.next !== undefined) lines.push(line(`More steps follow; continue from step ${v.next}.`, task));
      return { observedAt: this.#runner.now(), lines };
    } catch (error) {
      if (error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found")) return undefined;
      throw error;
    }
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
      lines.push(line(`${how} by ${shown(e.by)} ${where}, ${e.at}: chose ${quoted(e.choice)}.`, cite("task", taskId)));
      for (const a of e.alternatives) lines.push(line(`Not ${quoted(a.option)}: ${quoted(a.whyNot)}`, cite("task", taskId)));
      for (const ev of e.evidence) lines.push(line(`Evidence: ${quoted(ev.statement)}`, cite("task", taskId)));
      if (e.uncertainty !== "") lines.push(line(`Uncertain: ${quoted(e.uncertainty)}`, cite("task", taskId)));
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
      `${shown(q.asker)} asks about ${quoted(q.task.title)} (${shown(q.task.projectName)}), since ${q.askedAt}: ${quoted(q.question)}${q.wait === undefined ? "" : ` Your answer ends the wait: ${quoted(q.wait.summary)}.${q.wait.deadline === undefined ? "" : ` It is due ${q.wait.deadline}.`}`}`,
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
        all.push({ text: `${shown(q.asker)} asks about ${quoted(q.task.title)}: ${quoted(q.question)} (answer the question)`, cites: [cite("inquiry", q.inquiryId, q.revision), cite("task", q.task.id)], taskId: q.task.id, since: q.askedAt, id: q.inquiryId, rank: 1 });
      }
    }
    if (this.#deps.reviews !== undefined) {
      // Ask for one beyond the room, to tell exactly 50 apart from more than 50.
      const pending = await this.#deps.reviews.ownerPending(by, 51);
      if (pending.length > 50) truncated.push("approvals");
      for (const r of pending.slice(0, 50)) {
        all.push({ text: `An approval of ${quoted(r.name)} is waiting for you (allow or deny it)`, cites: [cite("review", r.id), cite("task", r.taskId)], taskId: r.taskId, since: r.requestedAt, id: r.id, rank: 0 });
      }
    }
    if (this.#deps.meetingDecisions !== undefined) {
      const waiting = await this.#deps.meetingDecisions(by, 51);
      if (waiting.truncated || waiting.items.length > 50) truncated.push("meeting decisions");
      for (const m of waiting.items.slice(0, 50)) {
        all.push({ text: `A meeting decision waits for you${m.text === undefined ? "" : `: ${quoted(m.text, 160)}`}${m.topic === undefined ? "" : ` (topic ${quoted(m.topic)})`}: ${m.left} change${m.left === 1 ? "" : "s"} left to carry out${m.applied > 0 ? ` (${m.applied} already done)` : ""} (agree, decline or choose another)`, cites: [cite("meeting-decision", m.id, m.revision), cite("project", m.projectId)], since: m.since, id: m.id, rank: 2 });
      }
    }
    if (this.#deps.heldResumes !== undefined) {
      const held = await this.#deps.heldResumes(by, 51);
      if (held.truncated || held.items.length > 50) truncated.push("held resumes");
      for (const h of held.items.slice(0, 50)) {
        const names = h.changes.slice(0, 3).map((c) => `${c.kind} ${shown(c.key)} (${c.status})`).join(", ");
        all.push({ text: `${quoted(h.title, 60)} is held before it resumes: ${h.changes.length} change${h.changes.length === 1 ? "" : "s"} since it stopped ${h.changes.length === 1 ? "was" : "were"} judged to matter to it: ${names}${h.changes.length > 3 ? ` and ${h.changes.length - 3} more` : ""} (approve the resume to let it go on, or decline it, which releases the task)`, cites: [cite("resume-check", h.checkId), cite("task", h.taskId)], taskId: h.taskId, since: h.since, id: h.checkId, rank: 3 });
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
        all.push({ text: `${quoted(b.summary)} (${b.type}; resolve it or give what is missing)`, cites: [cite("blocker", b.id), ...(onTask ? [cite("task", b.subject.id)] : [])], ...(onTask ? { taskId: b.subject.id } : {}), since: b.openedAt, id: b.id, rank: 4 });
      }
      if (page.next === undefined) break;
      after = page.next;
    }
    const items: NeedItem[] = [];
    for (const i of all) if (i.taskId === undefined || (await taskOf(i.taskId))?.open !== false) items.push(i);
    if (blockersCut) truncated.push("blockers");
    return { items, taskOf, truncated };
  }

  /**
   * What the owner marked as the critical path (card U11d, "U11f"), owner only: each mark (a task, a goal or a project, by ID, with its title as the record shows it, quoted as data) and whether it is still open, then
   * the decisions waiting for the owner that hold it up, the first 10 in the order of the Needs-you view. A mark on something that no longer exists is shown as such. Marks are read as the owner wrote them: the list holds
   * nothing an agent supplied except the titles, which are quoted and never decide anything.
   */
  async criticalPathLines(by: Principal): Promise<{ readonly observedAt: string; readonly lines: readonly Line[] } | undefined> {
    if (by.kind !== "owner") return undefined;
    const lines: Line[] = [];
    if (this.#deps.critical === undefined) return { observedAt: this.#runner.now(), lines: [line("No critical path is kept in this installation.")] };
    const { marks } = await this.#deps.critical.list(by);
    if (marks.length === 0) return { observedAt: this.#runner.now(), lines: [line("Nothing is marked as the critical path. Say which task, goal or project is critical and it is marked.")] };
    for (const m of marks.slice(0, 50)) {
      const rec = (await this.#runner.get(m.kind === "project" ? "project" : "task", m.id))?.body as unknown as { title?: string; name?: string; state?: string } | undefined;
      const what = m.kind === "project" ? "project" : m.kind === "goal" ? "goal" : "task";
      const words = rec === undefined ? "no longer exists" : m.kind === "project" ? (rec.state === "archived" ? "archived" : "open") : rec.state === "done" || rec.state === "cancelled" ? `finished (${rec.state})` : `open (${rec.state ?? "unknown"})`;
      const name = rec === undefined ? "" : ` ${quoted(m.kind === "project" ? rec.name ?? "" : rec.title ?? "", 80)}`;
      lines.push(line(`The ${what}${name} is on the critical path you marked, since ${m.markedAt}; it is ${words}.`, cite(m.kind === "project" ? "project" : "task", m.id)));
    }
    if (marks.length > 50) lines.push(line(`${marks.length - 50} more marks are not shown.`));
    const { items, truncated } = await this.#needItems(by);
    let holds: HoldsUp | undefined;
    try { holds = await this.#deps.critical.holdsUp(); } catch { holds = undefined; }
    const held: NeedItem[] = [];
    if (holds !== undefined) for (const i of items) if (i.taskId !== undefined && (await holds(i.taskId))) held.push(i);
    held.sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : 0) || a.rank - b.rank || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (held.length === 0) lines.push(line("Nothing that waits for you holds the critical path up."));
    for (const i of held.slice(0, 10)) lines.push(line(`Holds up the critical path: ${i.text}; since ${i.since}.`, ...i.cites));
    if (held.length > 10) lines.push(line(`${held.length - 10} more hold it up; the needs_you request lists them all in order.`));
    if (truncated.length > 0) lines.push(line(`This list may be incomplete: there are more ${truncated.join(", ")} than could be looked at.`));
    return { observedAt: this.#runner.now(), lines };
  }

  /** How many things wait for the owner (for the count in a reply); no ranking is done. Owner only (anyone else: 0). */
  async needsYouCount(by: Principal): Promise<number> {
    return by.kind !== "owner" ? 0 : (await this.#needItems(by)).items.length;
  }

  /**
   * One list of what waits for the owner's decision: agent questions, reviews only the owner can decide, adopted meeting decisions waiting for the owner's answer, resume checks held for the owner (L04c), and open blockers whose resolver is the owner. What holds up the critical path the owner marked comes first, then what other open tasks wait for (how many), then oldest first, then the kind (approvals, questions, meeting decisions, held resumes, blockers).
   * `count` is the number found (each source up to 50); `truncated` names the sources (`questions`, `approvals`, `meeting decisions`, `held resumes`, `blockers`) that had more than was read, so the list may be missing items; the lines are cut at `limit`. Owner only (anyone else: undefined).
   */
  async needsYou(by: Principal, limit?: number): Promise<{ readonly observedAt: string; readonly lines: readonly Line[]; readonly count: number; readonly truncated: readonly string[]; /** How many of them hold up the critical path the owner marked (present when anything is marked). */ readonly critical?: number } | undefined> {
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
    // What holds up the critical path the owner marked comes first (card U11d, "U11f"). Only the owner's marks and the dependency records decide it; nothing an agent wrote (a title, a summary) is read for it.
    let holds: HoldsUp | undefined;
    if (this.#deps.critical !== undefined) { try { holds = await this.#deps.critical.holdsUp(); } catch { holds = undefined; } }
    const ranked: { i: NeedItem; blocked: number; critical: boolean }[] = [];
    for (const i of items) ranked.push({ i, blocked: await blockedBy(i), critical: holds !== undefined && i.taskId !== undefined && (await holds(i.taskId)) });
    ranked.sort((a, b) => Number(b.critical) - Number(a.critical) || b.blocked - a.blocked || (a.i.since < b.i.since ? -1 : a.i.since > b.i.since ? 1 : 0) || a.i.rank - b.i.rank || (a.i.id < b.i.id ? -1 : a.i.id > b.i.id ? 1 : 0));
    const lines: Line[] = ranked.slice(0, cap).map(({ i, blocked, critical }) => line(`${critical ? "On the critical path you marked: " : ""}${i.text}${blocked > 0 ? `; ${blocked} other open task${blocked === 1 ? " waits" : "s wait"} for it` : ""}; since ${i.since}.`, ...i.cites));
    if (lines.length === 0) lines.push(line("Nothing is waiting for you."));
    else if (ranked.length > cap) lines.push(line(`${ranked.length - cap} more are waiting; deal with these first and ask again.`));
    if (truncated.length > 0) lines.push(line(`This list may be incomplete: there are more ${truncated.join(", ")} than could be looked at.`));
    return { observedAt: this.#runner.now(), lines, count: ranked.length, truncated, ...(holds === undefined ? {} : { critical: ranked.filter((r) => r.critical).length }) };
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
    // Card C07i: a starting size that keeps rising, or is close to its limit, is a visible warning on the task while it lasts (the watch cut nothing for it).
    if (this.#deps.startSizes !== undefined && (viewerIsOwner || allows(by, "attempt.work", body.projectId, { resource: { kind: "task", id } }))) {
      const open = await this.#deps.startSizes.openAlerts(id).catch(() => []);
      for (const a of open) lines.push(line(`Warning: ${startSizeAlertText(a)}. Ask for the start_size status of the task for the figures and where the originals are kept.`, cite("ctx-start-size", a.id), cite("task", id)));
    }

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
    let after = query.afterId === undefined ? undefined : this.#unseal("afterId", query.afterId);
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
      next = after === undefined ? undefined : this.#seal(after);
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

  // ---- what needs attention (card U13) ---------------------------------------------------------------------------------------

  /**
   * The things in the overview that need a person's eye, as a paged list: assignees whose work is paused, workers (hosts) that reported the work and can no longer be relied on, and tool calls whose result is not known.
   * Read only, and what the caller may not read reads as missing: each kind rests on the same right as its neighbour (pauses and workers on the right to read the task's assignment, tool calls on the tool-history right),
   * so an item the caller could not see in `task`, `overview` or `tools` is never listed here and never matched by a filter. Only the owner may leave the project and task out.
   *
   * Paging walks the tasks in ID order and each task's items in a fixed order (paused, unreachable, then calls in ID order). The cursor names the last item handed out, so it stays valid when other items appear or disappear
   * between pages and nothing is skipped or repeated. The scan is bounded: when its budget runs out before the page is full, `scanLimited` is set and `next` continues from the last task that was fully read.
   * Not included (their data has no service yet): stale artifacts.
   */
  async attention(by: Principal, query: { projectId?: string; taskId?: string; agentId?: string; state?: string; kind?: string; since?: string; until?: string; afterId?: string; limit?: number } = {}): Promise<Attention> {
    onlyKnown(query, ["projectId", "taskId", "agentId", "state", "kind", "since", "until", "afterId", "limit"]);
    const project = query.projectId === undefined ? undefined : checkProjectId(query.projectId);
    const taskFilter = query.taskId === undefined ? undefined : checkTaskId(query.taskId);
    if (project === undefined && taskFilter === undefined && by.kind !== "owner") throw new DomainError("forbidden", `${by.id} must name a project or a task`);
    const agent = query.agentId === undefined ? undefined : this.#agentFilter(query.agentId);
    const state = query.state === undefined ? undefined : (TASK_STATES as readonly string[]).includes(query.state) ? query.state as TaskState : invalid("state", `must be one of ${TASK_STATES.join(", ")}`);
    const kind = query.kind === undefined ? undefined : (ATTENTION_KINDS as readonly string[]).includes(query.kind) ? query.kind as AttentionKind : invalid("kind", `must be one of ${ATTENTION_KINDS.join(", ")}`);
    const stamp = (name: string, v: string | undefined): string | undefined => v === undefined ? undefined : typeof v === "string" && v.length <= STATUS_LIMITS.since && TIMESTAMP.test(v) ? v : invalid(name, "must be a UTC timestamp such as 2026-10-20T12:00:00.000Z");
    const since = stamp("since", query.since);
    const until = stamp("until", query.until);
    if (since !== undefined && until !== undefined && since > until) invalid("since", "must not be after until");
    const limit = query.limit === undefined ? 50 : typeof query.limit === "number" && Number.isSafeInteger(query.limit) && query.limit >= 1 && query.limit <= 100 ? query.limit : invalid("limit", "must be a whole number from 1 to 100");
    let cursor: { taskId: string; rank: number; id: string } | undefined;
    if (query.afterId !== undefined) {
      const plain = typeof query.afterId === "string" && query.afterId.length <= 400 ? this.#unseal("afterId", query.afterId) : undefined;
      const m = plain === undefined ? null : /^(task-[a-z2-7]{20})\|([0-9])\|(.*)$/s.exec(plain);
      if (m === null) return invalid("afterId", "is not a cursor from an earlier page");
      cursor = { taskId: checkTaskId(m[1]!), rank: Number(m[2]), id: m[3]! };
      if (taskFilter !== undefined && cursor.taskId !== taskFilter) invalid("afterId", "is not a cursor for this task");
    }
    const want = (k: AttentionKind): boolean => kind === undefined || kind === k;
    const inRange = (at: string | undefined): boolean => (since === undefined && until === undefined) || (at !== undefined && (since === undefined || at > since) && (until === undefined || at <= until));
    const now = this.#runner.now();
    const nowMs = Date.parse(now);
    const budget = this.#pages * this.#pageSize;
    let examined = 0;
    let scanLimited = false;
    let resume: string | undefined;
    const found: { item: AttentionItem; key: string }[] = [];

    const visit = async (taskId: string, revision: number, updatedAt: string, body: TaskBody, floor: { rank: number; id: string } | undefined): Promise<void> => {
      examined++;
      if ((project !== undefined && body.projectId !== project) || (state !== undefined && body.state !== state) || !this.#mayReadTask(by, body.projectId, taskId)) return;
      if (floor !== undefined && floor.rank >= 9) return;
      const base = { taskId, projectId: body.projectId, title: shown(body.title), taskState: body.state } as const;
      const push = (rank: number, id: string, item: AttentionItem): void => { found.push({ item, key: `${taskId}|${rank}|${id}` }); };
      const after = (rank: number): boolean => floor === undefined || rank > floor.rank;
      let assignment: AssignmentBody | undefined;
      let owner: { kind: string; id: string } | undefined;
      let paused = false;
      if (want("paused_assignee") || want("unreachable_worker")) {
        assignment = await this.#deps.assignments.getAssignment(taskId);
        if (this.#mayReadAssignment(by, body.projectId, taskId, assignment) && assignment?.state === "assigned" && assignment.owner !== undefined) owner = { kind: assignment.owner.kind, id: assignment.owner.id };
        paused = owner !== undefined && this.#deps.pauses !== undefined && (await this.#deps.pauses.isPaused(taskId));
      }
      const ownerMatches = owner !== undefined && (agent === undefined || (owner.kind === "agent" && owner.id.replace(/^agent:/, "") === agent));
      const agentId = owner === undefined ? undefined : owner.id.replace(/^agent:/, "");
      if (want("paused_assignee") && ownerMatches && paused && after(0)) {
        const gates = (this.#deps.pauses === undefined ? undefined : await this.#deps.pauses.status(by, taskId))?.gates ?? [];
        const sinces = gates.flatMap((g) => g.gate.pausedAt === undefined ? [] : [g.gate.pausedAt]).sort();
        const at = sinces[0] ?? updatedAt;
        if (inRange(at)) push(0, "", { kind: "paused_assignee", ...base, agentId: agentId!, at, summary: `${base.title} is paused; its owner ${agentId} is not working on it meanwhile.`, detail: { gates: gates.map((g) => ({ scope: `${g.scope.kind} ${g.scope.id}`, ...(g.gate.pausedAt === undefined ? {} : { since: g.gate.pausedAt }), ...(g.gate.owner === undefined ? {} : { by: g.gate.owner }), ...(g.gate.observed === undefined ? {} : { observed: g.gate.observed.state }) })) }, cite: cite("task", taskId, revision) });
      }
      if (want("unreachable_worker") && ownerMatches && !paused && assignment?.activeAttemptId !== undefined && after(1)) {
        const attempt = await this.#deps.assignments.getAttempt(assignment.activeAttemptId);
        const facts = await this.#execution(body, taskId, assignment, attempt, nowMs, false);
        const host = facts.observation?.by;
        const problem = host !== undefined && host.startsWith("host:") ? await this.#hostProblem(host, nowMs) : undefined;
        if (problem !== undefined && inRange(facts.observation!.at)) push(1, "", { kind: "unreachable_worker", ...base, agentId: agentId!, at: facts.observation!.at, summary: `${base.title}: the host ${shown(host!, 80)} that reported the work ${problem === "revoked" ? "has been revoked" : "has not been heard from lately"}, so it is not known whether the work goes on.`, detail: { hostId: shown(host!, 80), reason: problem }, cite: cite("task", taskId, revision) });
      }
      if (want("uncertain_tool_result") && this.#mayReadTools(by, body.projectId, taskId) && (floor === undefined || floor.rank <= 2)) {
        let from = floor !== undefined && floor.rank === 2 ? floor.id : undefined;
        for (let reads = 0; ; reads++) {
          // The budget is checked before every read, not only between tasks; the first read of a visit always goes ahead, so each call moves the cursor on.
          if (reads >= this.#pages || (reads > 0 && examined >= budget)) { scanLimited = true; resume = `${taskId}|2|${from ?? ""}`; break; }
          const take = Math.max(1, Math.min(this.#pageSize, budget - examined));
          const page = await this.#runner.list(`mcp-call-${taskId}`, { ...(from === undefined ? {} : { afterId: from }), limit: take });
          for (const a of page) {
            from = a.id;
            examined++;
            const c = a.body as unknown as CallBody;
            if (!(c.uncertain === true || c.state === "started") || !inRange(c.at)) continue;
            if (agent !== undefined && c.by.replace(/^agent:/, "") !== agent) continue;
            const cap = `${c.capability.kind}:${shown(c.capability.name, 120)}`;
            push(2, a.id, { kind: "uncertain_tool_result", ...base, agentId: shown(c.by.replace(/^agent:/, ""), 80), at: c.at, summary: `${shown(c.serverName, 80)} ${cap} was called on ${base.title}; ${c.state === "started" && c.outcome === undefined ? "it has not reported an outcome" : "it is not known whether it took effect"}.`, detail: { callId: a.id, server: shown(c.serverName, 80), capability: cap, outcome: c.outcome ?? "not finished", protocolRevision: c.protocolRevision, catalogRevision: c.catalogRevision }, cite: cite(`mcp-call-${taskId}`, a.id) });
            if (found.length > limit) return;
          }
          if (page.length < take) break;
        }
      }
    };

    let lastDone: string | undefined;
    let ended = false;
    const first = taskFilter ?? cursor?.taskId;
    if (first !== undefined) {
      const t = await this.#runner.get("task", first);
      if (t !== undefined) await visit(first, t.revision, t.updatedAt, t.body as unknown as TaskBody, cursor !== undefined && cursor.taskId === first ? cursor : undefined);
      lastDone = first;
      if (resume !== undefined) ended = true;
      if (taskFilter !== undefined) ended = true;
    }
    let listAfter = taskFilter === undefined ? cursor?.taskId : undefined;
    scan: while (!ended && found.length <= limit) {
      const page = await this.#runner.list("task", { ...(listAfter === undefined ? {} : { afterId: listAfter }), limit: this.#pageSize });
      for (const aggregate of page) {
        if (found.length > limit) break scan;
        if (examined >= budget) { scanLimited = true; break scan; }
        listAfter = aggregate.id;
        await visit(aggregate.id, aggregate.revision, aggregate.updatedAt, aggregate.body as unknown as TaskBody, undefined);
        if (found.length <= limit) lastDone = aggregate.id;
        if (resume !== undefined) break scan;
      }
      if (page.length < this.#pageSize) ended = true;
    }
    let next: string | undefined;
    if (found.length > limit) next = found[limit - 1]!.key;
    else if (resume !== undefined) next = resume;
    else if (scanLimited && lastDone !== undefined) next = this.#seal(`${lastDone}|9|`);
    return { observedAt: now, items: found.slice(0, limit).map((f) => f.item), ...(next === undefined ? {} : { next }), ...(scanLimited ? { scanLimited: true as const } : {}) };
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
      const problem = await this.#hostProblem(by, nowMs);
      if (problem === "revoked") return { state: "unknown", ...(facts.observation === undefined ? {} : { observation: facts.observation }), uncertainty: [...facts.uncertainty, `the host ${by} that reported the work has been revoked`] };
      if (problem === "quiet") return { state: "unknown", ...(facts.observation === undefined ? {} : { observation: facts.observation }), uncertainty: [...facts.uncertainty, `the host ${by} that reported the work has not been heard from lately`] };
    }
    return facts;
  }

  /** Whether a host that reported work can still be relied on: its identity revoked, or not heard from within the freshness window. */
  async #hostProblem(hostId: string, nowMs: number): Promise<"revoked" | "quiet" | undefined> {
    const principal = (await this.#runner.get("principal", hostId))?.body as unknown as PrincipalBody | undefined;
    const record = (await this.#runner.get("host-record", hostId))?.body as unknown as { lastSeenAt?: string } | undefined;
    const fresh = hostFreshness(record?.lastSeenAt, new Date(nowMs).toISOString(), this.#options.hostStaleAfterMs ?? DEFAULT_HOST_STALE_AFTER_MS);
    return principal?.state === "disabled" ? "revoked" : fresh !== "fresh" ? "quiet" : undefined;
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
