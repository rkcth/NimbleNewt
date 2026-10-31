import { DomainError, isDomainError } from "../domain/errors.js";
import { isStorageError } from "../storage/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import type { ProjectService } from "../domain/service.js";
import type { RetrievalService } from "../context/index.js";
import type { AgentService } from "../agents/index.js";
import type { WatchService } from "../events/handling.js";
import type { InquiryService } from "../inquiries/index.js";
import type { ContractService, WaitGraphService } from "../planning/index.js";
import type { ReleaseService } from "../release/index.js";
import type { SubmissionService } from "../submissions/index.js";
import type { SwarmService } from "../swarm/index.js";
import type { IncidentService, ProjectPlanService, ProjectResourceService, ResponsibilityChecks, ResponsibilityService } from "../projects/index.js";
import type { ContextBranchService } from "../branches/index.js";
import type { InvitationInbox, MeetingService } from "../meetings/index.js";
import type { AgentMessageService } from "../messaging/index.js";
import type { EventService } from "../events/index.js";
import type { BudgetService } from "../budgets/index.js";
import type { NotificationService } from "../notifications/index.js";
import type { DifficultyService } from "../routing/difficulty.js";
import type { CutoverService } from "../routing/cutover.js";
import type { FallbackService } from "../routing/fallback.js";
import type { WorkspaceOpService } from "../workspace-ops/index.js";
import type { StatusService } from "../status/index.js";
import type { DecisionService } from "../decisions/index.js";
import { SecureApi } from "../security/secured.js";
import type { GrantService } from "../security/grants.js";
import type { EscalationLadderService } from "../health/escalation-ladder.js";
import type { AgreedLimitsSettingsService } from "./agreed-limits-settings.js";
import type { WorkerLimitsSettingsService } from "./worker-limits-settings.js";
import type { SetupReadinessService } from "../setup/index.js";
import type { DispatchLimitsSettingsService } from "./dispatch-limits-settings.js";
import type { PlacementSettingsService } from "../remote/placement-settings.js";
import type { ProtectedBranchService } from "../policy/protected-branches.js";
import type { EventSourceSettingsService } from "../events/source-settings.js";
import type { PolicyService } from "../policy/policy.js";
import type { WorkingNoteService } from "../context/notes.js";
import type { WorkEndService } from "../work-end/index.js";
import type { PauseService } from "../lifecycle/pause.js";
import type { StopService } from "../lifecycle/stop.js";
import type { BackupService } from "../backup/index.js";
import type { ImprovementService } from "../standups/improvements.js";
import type { MeetingRecordService } from "../meetings/record.js";
import type { AttendanceService } from "../meetings/attendance.js";
import type { PolicyEditService } from "../chat/policy-edit.js";
import type { StandupService } from "../standups/standups.js";
import type { ActivityService } from "../activity/activity.js";
import type { DeliverableService } from "../artifacts/deliverables.js";
import type { ResumeCheckService } from "../continuation/resume.js";
import type { ResumeSettingsService } from "../continuation/resume-settings.js";
import type { HandoffService } from "../lifecycle/handoff.js";
import type { IntegrationPolicyService } from "../policy/integration-policy.js";

import type { CommandService } from "../commands/index.js";
import type { Principal, PrincipalService } from "../security/principals.js";
import type { TaskCredentialService } from "../security/task-credentials.js";
import type { JsonObject } from "../storage/types.js";
import { OPERATION_BY_NAME, type Args, type Context } from "./operations.js";

export const API_VERSION = 1;

/** A request: the version, the operation, a command ID for commands, and the operation's arguments. */
export interface ApiRequest {
  readonly v: number;
  readonly op: string;
  readonly commandId?: string;
  readonly args?: Record<string, unknown>;
}

export interface ApiError {
  readonly code: string;
  readonly message: string;
  readonly field?: string;
  /** For a refused write on an out-of-date revision: the revision to read again from. */
  readonly currentRevision?: number;
}

export type ApiResponse =
  | { readonly v: typeof API_VERSION; readonly op: string; readonly ok: true; readonly result: JsonObject; readonly accepted?: true; readonly completed?: boolean; readonly awaits?: string }
  | { readonly v: typeof API_VERSION; readonly op: string; readonly ok: false; readonly error: ApiError };

export interface StateApiDeps {
  readonly principals: PrincipalService;
  readonly projects: ProjectService;
  readonly assignments: AssignmentService;
  readonly retrieval: RetrievalService;
  readonly inquiries: InquiryService;
  readonly agents: AgentService;
  readonly contracts: ContractService;
  readonly graph: WaitGraphService;
  /** When present, event handling attempts can be listed and inspected (card H13). */
  readonly watches?: WatchService;
  /** When present, project resources, plans and responsibilities can be used through the API (card P01). */
  readonly resources?: ProjectResourceService;
  readonly plans?: ProjectPlanService;
  readonly responsibilities?: ResponsibilityService;
  readonly responsibilityChecks?: Pick<ResponsibilityChecks, "pending">;
  readonly release?: Pick<ReleaseService, "submit" | "authorizeHost" | "issue" | "report" | "interrupt" | "gate" | "approve" | "attempts">;
  readonly swarm?: Pick<SwarmService, "spawn" | "cancel" | "children">;
  readonly incidents?: Pick<IncidentService, "report" | "resolve" | "list" | "observed">;
  /** Submissions by role (card Q01b). */
  readonly submissions?: Pick<SubmissionService, "record" | "get" | "list">;
  /** When present, agenda items can be captured, corrected and listed through the API (cards M01 and M03). */
  readonly meetings?: MeetingService;
  /** When present, integration, checkout refresh and quarantine of a task's work can be requested (cards H12l, H12d). */
  readonly workspaceOps?: Pick<WorkspaceOpService, "request" | "get">;
  /** When present, the status views (task, overview, noticeboard, changes, tools, delivered, failed events) can be asked through the API (card U05b). */
  readonly status?: Pick<StatusService, "ask" | "attention">;
  readonly invitations?: InvitationInbox;
  /** When present, context branches can be opened, switched, resumed and delegated through the API (card C05). */
  readonly branches?: ContextBranchService;
  /** When present, an agent can ask the owner a question and the owner can see and answer the questions (card U12). */
  readonly messages?: Pick<AgentMessageService, "send" | "readable" | "acknowledge" | "markHandled" | "get" | "inbox" | "setFocus" | "release" | "askOwner" | "ownerQuestions" | "answerOwner">;
  readonly ownerQuestions?: Pick<AgentMessageService, "askOwner" | "ownerQuestions" | "answerOwner">;
  /** When present, the owner can grant and revoke rights through the API (card U03e). */
  readonly grants?: Pick<GrantService, "grant" | "revoke" | "getGrant" | "list">;
  /** When present, the owner can say which hosts may hold local-only data through the API (card H07c). */
  readonly placement?: Pick<PlacementSettingsService, "get" | "set" | "change">;
  readonly workerLimits?: Pick<WorkerLimitsSettingsService, "get" | "set" | "change">;
  /** When present, the owner can read what is set up and what is missing before a first agent can work (card U14). */
  readonly setup?: Pick<SetupReadinessService, "check">;
  /** How long an undecided stall concern waits at each level of the supervisor ladder (owner decision 2026-10-30, supervisor ladder). */
  readonly escalationLadder?: Pick<EscalationLadderService, "get" | "set">;
  readonly agreedLimits?: Pick<AgreedLimitsSettingsService, "get" | "change">;
  readonly resumeSettings?: Pick<ResumeSettingsService, "get" | "set">;
  readonly dispatchLimits?: Pick<DispatchLimitsSettingsService, "get" | "change">;
  readonly branchSettings?: Pick<ProtectedBranchService, "get" | "set" | "change">;
  /** Which event sources are watched (card H13f). */
  readonly eventSourceSettings?: Pick<EventSourceSettingsService, "get" | "set" | "change">;
  /** Absent when the controller runs without the agent's ending (card H12n). */
  readonly workEnd?: Pick<WorkEndService, "request" | "get">;
  readonly notes?: Pick<WorkingNoteService, "write" | "revise" | "setVisibility" | "read" | "versions" | "list">;
  readonly integration?: Pick<IntegrationPolicyService, "get" | "set" | "getDefault" | "setDefault" | "ensure" | "precheck">;

  readonly pauses?: Pick<PauseService, "pause" | "resume" | "gate" | "setResumeCondition">;
  readonly modelBudget?: Pick<FallbackService, "setBudget" | "budget" | "spend">;
  readonly cutover?: Pick<CutoverService, "disable" | "drain" | "cutover" | "reenable" | "setFailbackPolicy" | "controls" | "report" | "topology" | "tick">;
  readonly handoffs?: Pick<HandoffService, "prepare" | "complete" | "takeover" | "choose" | "cancel" | "advance" | "get" | "forTask" | "sweep" | "screen">;
  readonly resumes?: Pick<ResumeCheckService, "start" | "commit" | "retry" | "cancel" | "advance" | "get" | "sweep">;
  readonly activity?: Pick<ActivityService, "record" | "explain" | "explainLater" | "correct" | "markUnavailable" | "steps" | "payload" | "explanations" | "explanationsPage" | "corrections" | "timeline">;
  readonly policyContext?: Pick<PolicyService, "contextFor">;
  readonly records?: Pick<MeetingRecordService, "open" | "setChair" | "join" | "leave" | "append" | "move" | "amend" | "table" | "openVote" | "castBallot" | "closeVote" | "castingVote" | "apply" | "ownerRespond" | "finish" | "summarize" | "returnOutcomes" | "sweep" | "record" | "recordFor" | "discussion" | "motion" | "ballots" | "decision" | "why" | "summary" | "latestPlan" | "decisionLog">;
  readonly attendance?: Pick<AttendanceService, "admission" | "openRoom" | "callNow" | "status" | "beginDiscussion" | "prepare" | "reportBlocked" | "join" | "joinAsOwner" | "authorizeWake" | "leave" | "keepPaused" | "deferReturn" | "endMeeting" | "returnToWork" | "acknowledge" | "revalidation" | "saveBrief" | "briefOf">;
  readonly standups?: Pick<StandupService, "configure" | "update" | "standup" | "prepare" | "prepared" | "brief" | "briefs" | "addStatement" | "agenda" | "deliverOutcomes">;
  readonly watchControl?: {
    create(owner: Principal, command: { commandId: string; stream: string; taskId: string; kinds?: readonly string[]; cooldownSeconds?: number; batch?: number }): Promise<{ id: string; replayed: boolean }>;
    cancel(owner: Principal, command: { commandId: string; watchId: string }): Promise<void>;
    list(owner: Principal): Promise<string[]>;
    describe(owner: Principal): Promise<{ id: string; stream: string; taskId: string; projectId: string }[]>;
  };
  readonly policyForward?: Pick<PolicyEditService, "forward">;
  readonly deliverables?: Pick<DeliverableService, "list" | "get">;
  readonly backups?: Pick<BackupService, "backUpNow" | "backUpFor" | "list" | "status">;
  readonly improvements?: Pick<ImprovementService, "propose" | "group" | "decide" | "bringToStandup" | "get" | "open">;
  readonly stops?: Pick<StopService, "request" | "force" | "choose" | "advance" | "get" | "sweep" | "readiness">;

  /** Typed commands (card T09b). Absent: `command.run` answers as unavailable. */
  readonly commands?: CommandService;

  /** When present, the rest of a tool result cut to the window can be read in pages through the API (card C07d). */
  readonly spill?: { readonly readSpill: (by: Principal, spillId: string, index: number, size?: number) => Promise<{ text: string; next?: number } | undefined> };
  /** When present, the owner can set the idle time of event subscriptions and cancel one through the API (card H06c). */
  readonly events?: Pick<EventService, "configureIdle" | "cancel">;
  /** When present, the owner can read and set notification settings through the API (card U11b). */
  readonly notifications?: Pick<NotificationService, "configure" | "settings">;
  /** When present, budgets can be read, asked for and decided through the API (card R05c). */
  readonly budgets?: Pick<BudgetService, "report" | "usage" | "request" | "pending" | "requestMore" | "decide" | "open" | "raise" | "close" | "aggregate" | "setAggregate">;
  /** When present, difficulty profiles, delegation and escalation can be used through the API (card R03). */
  readonly difficulty?: Pick<DifficultyService, "profiles" | "setProfiles" | "decisions" | "decision" | "delegate" | "reassignParent" | "delegation" | "setDifficulty" | "escalate" | "decide" | "escalations">;
  /** When present, owner decisions can be recorded, read and corrected through the API (card C08). */
  readonly decisions?: Pick<DecisionService, "record" | "resolveDispute" | "ask" | "dismissQuestion" | "link" | "revalidate" | "closeFollowUp" | "get" | "history" | "authoritative" | "context" | "reliance" | "propagation">;
  /** When present, a task credential (`tcr-…`) is accepted too and acts for its one task (card A10b). */
  readonly taskCredentials?: TaskCredentialService;
  /** Called with errors that are not part of the contract (so they are not shown to the client). */
  readonly onInternalError?: (error: unknown) => void;
}

/**
 * The one door to the controller's state for chat, command-line and HTTP clients alike (card U01). A client presents a credential and a request; the API authenticates, builds the caller's
 * `SecureApi` (so every fact is scoped to what that principal may see, and every write is checked), and answers in one envelope. There is no other path to these operations, which is why a chat
 * client and an API client of the same principal see the same facts.
 *
 * - **Versioned.** `v` must be 1; anything else is refused naming the supported version.
 * - **Idempotent writes.** A command carries a `commandId`; sending it again returns the first result with `replayed: true`; reusing it for a different command is `command_conflict`.
 * - **Optimistic revisions.** A write names the revision it read; a stale one is `stale_revision` with `currentRevision`.
 * - **Accepted is not completed.** A successful command says `accepted: true` and `completed`. For a recorded change that is the whole effect, `completed` is true. For a command whose work
 *   is done by someone else (assigning a task) it is false and `awaits` says what to look at.
 * - **Pagination.** Lists take `limit` (at most 100) and `after`, and return `items` and, when more may follow, `next`.
 * - **Errors** have a code, a message and, where it helps, the field or current revision. Failures that are not part of the contract are reported as `unavailable` without detail.
 */
export class StateApi {
  readonly #deps: StateApiDeps;

  constructor(deps: StateApiDeps) {
    this.#deps = deps;
  }

  async handle(token: unknown, raw: unknown): Promise<ApiResponse> {
    const op = typeof raw === "object" && raw !== null && typeof (raw as { op?: unknown }).op === "string" ? (raw as { op: string }).op.slice(0, 60) : "";
    try {
      const principal = this.#deps.taskCredentials !== undefined && typeof token === "string" && token.startsWith("tcr-") ? await this.#deps.taskCredentials.authenticate(token) : await this.#deps.principals.authenticate(token);
      return await this.#perform(principal, raw, op);
    } catch (error) {
      return { v: API_VERSION, op, ok: false, error: this.#error(error) };
    }
  }

  /** The same request as an already authenticated principal (card T09b: a typed command runs the operation as the one who typed it). Never throws; an error is the answer. */
  async handleAs(principal: Principal, raw: unknown): Promise<ApiResponse> {
    const op = typeof raw === "object" && raw !== null && typeof (raw as { op?: unknown }).op === "string" ? (raw as { op: string }).op.slice(0, 60) : "";
    try { return await this.#perform(principal, raw, op); } catch (error) { return { v: API_VERSION, op, ok: false, error: this.#error(error) }; }
  }

  async #perform(principal: Principal, raw: unknown, _op: string): Promise<ApiResponse> {
    {
      const request = this.#parse(raw);
      const operation = OPERATION_BY_NAME.get(request.op);
      if (operation === undefined) throw new DomainError("invalid_command", `op: ${request.op.slice(0, 60)} is not an operation of API version ${API_VERSION}`, { field: "op" });
      if (operation.kind === "query" && request.commandId !== undefined) throw new DomainError("invalid_command", "commandId: a query takes none", { field: "commandId" });
      const args: Args = request.args ?? {};
      if ("commandId" in args || "actor" in args) throw new DomainError("invalid_command", "args: commandId goes beside the arguments, and the caller is the authenticated principal", { field: "args" });
      const context: Context = {
        principal, secure: new SecureApi(principal, { projects: this.#deps.projects, assignments: this.#deps.assignments }),
        retrieval: this.#deps.retrieval, inquiries: this.#deps.inquiries, agents: this.#deps.agents, contracts: this.#deps.contracts, graph: this.#deps.graph, projects: this.#deps.projects, assignments: this.#deps.assignments,
        ...(this.#deps.watches === undefined ? {} : { watches: this.#deps.watches }),
        ...(this.#deps.resources === undefined ? {} : { resources: this.#deps.resources }),
        ...(this.#deps.plans === undefined ? {} : { plans: this.#deps.plans }),
        ...(this.#deps.responsibilities === undefined ? {} : { responsibilities: this.#deps.responsibilities }),
        ...(this.#deps.responsibilityChecks === undefined ? {} : { responsibilityChecks: this.#deps.responsibilityChecks }),
        ...(this.#deps.incidents === undefined ? {} : { incidents: this.#deps.incidents }),
        ...(this.#deps.submissions === undefined ? {} : { submissions: this.#deps.submissions }),
        ...(this.#deps.release === undefined ? {} : { release: this.#deps.release }),
        ...(this.#deps.swarm === undefined ? {} : { swarm: this.#deps.swarm }),
        ...(this.#deps.meetings === undefined ? {} : { meetings: this.#deps.meetings }),
        ...(this.#deps.workspaceOps === undefined ? {} : { workspaceOps: this.#deps.workspaceOps }),
        ...(this.#deps.status === undefined ? {} : { status: this.#deps.status }),
        ...(this.#deps.invitations === undefined ? {} : { invitations: this.#deps.invitations }),
        ...(this.#deps.branches === undefined ? {} : { branches: this.#deps.branches }),
        ...(this.#deps.ownerQuestions === undefined ? {} : { ownerQuestions: this.#deps.ownerQuestions }),
        ...(this.#deps.messages === undefined ? {} : { messages: this.#deps.messages }),
        ...(this.#deps.decisions === undefined ? {} : { decisions: this.#deps.decisions }),
        ...(this.#deps.grants === undefined ? {} : { grants: this.#deps.grants }),
        ...(this.#deps.placement === undefined ? {} : { placement: this.#deps.placement }),
        ...(this.#deps.agreedLimits === undefined ? {} : { agreedLimits: this.#deps.agreedLimits }),
        ...(this.#deps.resumeSettings === undefined ? {} : { resumeSettings: this.#deps.resumeSettings }),
        ...(this.#deps.workerLimits === undefined ? {} : { workerLimits: this.#deps.workerLimits }),
        ...(this.#deps.setup === undefined ? {} : { setup: this.#deps.setup }),
        ...(this.#deps.escalationLadder === undefined ? {} : { escalationLadder: this.#deps.escalationLadder }),
        ...(this.#deps.dispatchLimits === undefined ? {} : { dispatchLimits: this.#deps.dispatchLimits }),
        ...(this.#deps.branchSettings === undefined ? {} : { branchSettings: this.#deps.branchSettings }),
        ...(this.#deps.eventSourceSettings === undefined ? {} : { eventSourceSettings: this.#deps.eventSourceSettings }),
        ...(this.#deps.integration === undefined ? {} : { integration: this.#deps.integration }),
        ...(this.#deps.notes === undefined ? {} : { notes: this.#deps.notes }),
        ...(this.#deps.workEnd === undefined ? {} : { workEnd: this.#deps.workEnd }),
        ...(this.#deps.stops === undefined ? {} : { stops: this.#deps.stops }),
        ...(this.#deps.policyForward === undefined ? {} : { policyForward: this.#deps.policyForward }),
        ...(this.#deps.backups === undefined ? {} : { backups: this.#deps.backups }),
        ...(this.#deps.improvements === undefined ? {} : { improvements: this.#deps.improvements }),
        ...(this.#deps.watchControl === undefined ? {} : { watchControl: this.#deps.watchControl }),
        ...(this.#deps.standups === undefined ? {} : { standups: this.#deps.standups }),
        ...(this.#deps.attendance === undefined ? {} : { attendance: this.#deps.attendance }),
        ...(this.#deps.records === undefined ? {} : { records: this.#deps.records }),
        ...(this.#deps.policyContext === undefined ? {} : { policyContext: this.#deps.policyContext }),
        ...(this.#deps.deliverables === undefined ? {} : { deliverables: this.#deps.deliverables }),
        ...(this.#deps.activity === undefined ? {} : { activity: this.#deps.activity }),
        ...(this.#deps.resumes === undefined ? {} : { resumes: this.#deps.resumes }),
        ...(this.#deps.handoffs === undefined ? {} : { handoffs: this.#deps.handoffs }),
        ...(this.#deps.cutover === undefined ? {} : { cutover: this.#deps.cutover }),
        ...(this.#deps.modelBudget === undefined ? {} : { modelBudget: this.#deps.modelBudget }),
        ...(this.#deps.pauses === undefined ? {} : { pauses: this.#deps.pauses }),

        ...(this.#deps.spill === undefined ? {} : { spill: this.#deps.spill }),
        ...(this.#deps.events === undefined ? {} : { events: this.#deps.events }),
        ...(this.#deps.notifications === undefined ? {} : { notifications: this.#deps.notifications }),
        ...(this.#deps.budgets === undefined ? {} : { budgets: this.#deps.budgets }),
        ...(this.#deps.difficulty === undefined ? {} : { difficulty: this.#deps.difficulty }),
        ...(this.#deps.commands === undefined ? {} : { commands: this.#deps.commands }),
        invoke: async (invokedOp, invokedArgs, invokedId) => {
          const answered = await this.handleAs(principal, { v: API_VERSION, op: invokedOp, ...(invokedId === undefined || OPERATION_BY_NAME.get(invokedOp)?.kind === "query" ? {} : { commandId: invokedId }), args: invokedArgs });
          return answered.ok ? { ok: true as const, result: answered.result } : { ok: false as const, code: answered.error.code, message: answered.error.message };
        },
      };
      const result = await operation.run(context, args, request.commandId);
      if (operation.kind === "query") return { v: API_VERSION, op: request.op, ok: true, result };
      const deferred = operation.completion?.kind === "deferred";
      return { v: API_VERSION, op: request.op, ok: true, result, accepted: true, completed: !deferred, ...(operation.completion?.kind === "deferred" ? { awaits: operation.completion.awaits } : {}) };
    }
  }

  #parse(raw: unknown): ApiRequest & { op: string } {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new DomainError("invalid_command", "request: must be an object with v, op and args", { field: "request" });
    const r = raw as Record<string, unknown>;
    for (const key of Object.keys(r)) if (!["v", "op", "commandId", "args"].includes(key)) throw new DomainError("invalid_command", `request.${key}: is not a field of a request`, { field: `request.${key}` });
    if (r["v"] !== API_VERSION) throw new DomainError("invalid_command", `v: this server speaks API version ${API_VERSION} only`, { field: "v" });
    if (typeof r["op"] !== "string") throw new DomainError("invalid_command", "op: is required and must be text", { field: "op" });
    if (r["commandId"] !== undefined && typeof r["commandId"] !== "string") throw new DomainError("invalid_command", "commandId: must be text", { field: "commandId" });
    if (r["args"] !== undefined && (r["args"] === null || typeof r["args"] !== "object" || Array.isArray(r["args"]))) throw new DomainError("invalid_command", "args: must be an object", { field: "args" });
    return r as unknown as ApiRequest & { op: string };
  }

  #error(error: unknown): ApiError {
    if (isDomainError(error)) {
      const e = error as DomainError & { field?: string; currentRevision?: number };
      return { code: e.code, message: e.message, ...(e.field === undefined ? {} : { field: e.field }), ...(e.currentRevision === undefined ? {} : { currentRevision: e.currentRevision }) };
    }
    // Input the storage layer rejected as malformed (for example arguments nested too deeply) is the client's mistake, not a server fault.
    if (isStorageError(error, "invalid_input")) return { code: "invalid_command", message: error.message, ...(error.path === undefined ? {} : { field: error.path }) };
    this.#deps.onInternalError?.(error);
    return { code: "unavailable", message: "the request could not be completed" };
  }
}
