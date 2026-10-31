import type { ResumeCheckService } from "../continuation/resume.js";
import { createHash } from "node:crypto";
import { framedMcp } from "../dispatch/tools.js";
import { ProjectResourceService } from "../projects/index.js";
import type { AttemptRelay, ModelRelay, RelayMonitor } from "../dispatch/relay.js";
import { AdmissionService } from "../admission/index.js";
import { BudgetService, ChargeRetryService, holderNotice } from "../budgets/index.js";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { RemoteWorkerHost, RemoteWorkerService, WorkerTransport, type RemoteDeps, type RemoteOptions, type RemoteWorkerHostOptions, type WorkerTransportOptions } from "../remote/index.js";
import { DecisionService, type DecisionDeps } from "../decisions/index.js";
import { ContextEnforcementService } from "../context/index.js";
import { CachePolicies, type AttemptCache, type CachePolicyDeps } from "../dispatch/cache.js";
import { MarkerService } from "../inference-cache/index.js";
import { checkLocalWorkerLimits, type LocalWorkerLimits } from "./worker-limits.js";
import type { WorkspaceOpService, WorkspacePort } from "../workspace-ops/index.js";
import { DispatchDriver, DispatcherService, QuiesceCoordinator, controllerGuards, type RuntimeGuards, type WorkOrder, activeAgents, attendanceLoops, budgetNoticeLoops, workspaceLoops, decisionLoops, meetingLoops, eventLoops, watchLoops, wakeLoops, attemptWaker, recordLoops, responsibilityLoops, probeLoops, sourceLoops, improvementOutcomeLoops, untoldImprovementLoops, type RouteProbes, recoveryLoops, reviewLoops, messageLoops, projectIds, standupLoops, type AttemptDispatcherOptions, type DispatcherLimitFigures, type DispatcherLoop, type RouteResolver, type TimerPort, type WorkerHost } from "../dispatch/index.js";
import type { CutoverService } from "../routing/cutover.js";
import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import type { StallEvent, StallService } from "../health/index.js";

/** The characters per token the relay assumes when it sizes a prompt for stall detection: low on purpose, so the estimate errs on the large side (card V01b). */
const RELAY_CHARS_PER_TOKEN = 3;
import { EffectService } from "../domain/effects.js";
import type { RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { WaitService } from "../domain/waits.js";
import { EventService, SourceService, noticeThroughNotifications, type EventSource } from "../events/index.js";
import { WatchService } from "../events/handling.js";
import { InboxService } from "../domain/inbox.js";
import { GenerationService } from "../generation/index.js";
import type { HarnessCatalog } from "../harness/index.js";
import { HostService } from "../hosts/index.js";
import { McpService, RemoteMcpConnector } from "../mcp/index.js";
import type { NameResolver } from "../dispatch/network.js";
import type { RetrievalService } from "../context/index.js";
import type { AgentService } from "../agents/index.js";
import type { HistoryService } from "../context/index.js";
import type { InquiryService } from "../inquiries/index.js";
import { PauseService } from "../lifecycle/index.js";
import type { Availability } from "../conversations/index.js";
import { ActivityService } from "../activity/index.js";
import type { BackupService } from "../backup/index.js";
import type { MeetingRecordService } from "../meetings/record.js";
import type { IncidentService, ResponsibilityChecks } from "../projects/index.js";
import { AttendanceService, InvitationInbox, MeetingService, meetingNoticeSink, meetingWindowSink, withNudge, type InvitationSink, type WakeSink } from "../meetings/index.js";
import { AgentMessageService } from "../messaging/index.js";
import { NotificationService } from "../notifications/index.js";
import type { ContractService } from "../planning/index.js";
import { PolicyService, ProtectedBranchService } from "../policy/index.js";
import type { ReviewService } from "../review/index.js";
import { DifficultyService, type RoutingService } from "../routing/index.js";
import { DISPATCHER_PRINCIPAL, type GrantService, type Principal, type PrincipalService, type TaskCredentialService } from "../security/index.js";
import type { StopService } from "../lifecycle/stop.js";
import { ImprovementService, StandupService, agendaOutcomeSink, improvementOutcomeSink, needsOwnerFrom, noticesFrom } from "../standups/index.js";
import { chatTurnFollowUps } from "../chat/follow-ups.js";
import type { ControllerStorage } from "../storage/types.js";

/**
 * Finishing what a request already started (a suspension, a stop, a hand-off, a checked resume) after a restart is not a new decision: whoever was entitled to ask did, and the record says so. The dispatcher's service principal holds no
 * control grants of its own, so the sweeps run with its identity at the owner's level of control, in this process only (no API operation reaches it); the audit still names the dispatcher as the actor.
 */
const recovering = (by: Principal): Principal => ({ ...by, kind: "owner" });

/** What the operator gives the controller to run the dispatcher (card H12c). Absent from `StartOptions`: no dispatcher is built and no loop runs. */
/** The worker process's context limits for an order, in the shape of the channel's `ChannelContext` (the controller does not depend on the contracts package; the host's `context` option takes it structurally). */
export interface WorkerContextLimits { readonly toolOutputBytes?: number; readonly toolOutputLines?: number; readonly compaction?: { readonly timeoutMs?: number; readonly fallback?: "extractive" } }

/** Remote workers (card H02): the artifact folder the controller owns, the listener workers connect to and the hosts the dispatcher may place attempts on. */
export interface RemoteStartOptions {
  /** The controller's own folder for artifacts and checkpoints. Workers never mount a database or this folder: they fetch through the transport. */
  readonly blobDirectory: string;
  /** Where the transport listens. Default: loopback on any free port. Exposure beyond loopback needs `allowRemote`, TLS and `publicHosts` (see `WorkerTransportOptions`). */
  readonly transport?: Omit<WorkerTransportOptions, "remote" | "principals">;
  readonly protocol?: RemoteOptions["protocol"];
  readonly fileBytes?: number;
  readonly relocationPolicy?: RemoteDeps["relocationPolicy"];
  /** Which hosts may hold local-only data, see the repository or be given the task credential (card H07). Default: local-only data is never placed on a remote host. */
  readonly placementPolicy?: RemoteDeps["placementPolicy"];
  /** The remote hosts attempts may be placed on, with what each attempt asks of them and what it needs. */
  readonly hosts: readonly ({ readonly hostId: string } & RemoteWorkerHostOptions)[];
}

export interface DispatchStartOptions {
  /** Remote workers: a transport workers connect to, and hosts placed after the local ones. */
  readonly remote?: RemoteStartOptions;
  /** The worker hosts, local or remote, tried in order. None: attempts are admitted and checked but no worker starts (the loops still run). */
  readonly workers?: readonly WorkerHost[];
  /** How the route and harness of a task are chosen. Default: the owner's configured execution profiles and routing table (R03). */
  readonly route?: RouteResolver;
  /** Time between ticks. Default 5 seconds. */
  readonly intervalMs?: number;
  /** Production: a real timer. Tests give one that fires when told. */
  readonly timer?: TimerPort;
  /** The clock of the dispatcher, its services and the driver. Default: the real one. */
  readonly clock?: () => string;
  /** Leave the timer off (a test or a tool that calls `tick()` itself). Default: start ticking. */
  readonly manual?: boolean;
  /** Lease, attempt time, attempts allowed and so on. */
  readonly dispatcher?: AttemptDispatcherOptions;
  /**
   * The local worker host (card H12k). The controller binds its services to the worker's guards (context budget, pause observation, message boundaries: `controllerGuards`) and hands them to `build`, which makes the
   * `LocalWorker` over the operator's sandbox launcher, worker process and model relay; the result is added to `workers`. The worker package holds no controller service: only these functions.
   */
  readonly local?: {
    /** The model's context window for the order's route, in tokens; `undefined` when the route does not say. */
    readonly window: (order: WorkOrder) => number | undefined;
    readonly storedTokens?: (from: NonNullable<WorkOrder["resumeFrom"]>) => number | undefined;
    /** What one agent on this host may use (cpus, memoryMb, diskMb, processes), checked at start and handed to `build` as `limits` for the host's `workspace` to carry (`AttemptWorkspace.limits`). Absent: none applied. */
    readonly limits?: LocalWorkerLimits;
    readonly build: (services: { readonly guards: RuntimeGuards; /** The limits for an agent launched now (start-up figures with the owner's setting over them), read fresh at each call; `undefined` when none apply. There is deliberately no static copy of the start-up figures here, so a host cannot read stale ones. It throws when the setting cannot be read, and the host must then refuse the launch (fail visibly), never run the agent unlimited. */ readonly currentLimits: () => Promise<LocalWorkerLimits | undefined>; /** The process's context limits for an order (card C07b): tool output cut to the window\'s share and the extractive compaction fallback; `undefined` when the route does not say its window. The host\'s `context` option takes it. */ readonly context: (order: WorkOrder) => WorkerContextLimits | undefined; /** Records the input size the provider reported for the attempt\'s first model call (the relay\'s `onFirstUsage`) against the call that was admitted. Never throws. */ readonly confirmFirstCall: (order: WorkOrder, usage: { readonly inputTokens: number; readonly requestChars: number }) => Promise<void>; /** The relay of one attempt (the same object for every call of the attempt, so that only its first call is measured), with the first-call count already going to `confirmFirstCall`. Use this instead of `relay.forAttempt`. */ readonly attemptRelay: (order: WorkOrder, relay: ModelRelay, options?: { readonly model?: string; readonly cache?: Parameters<ModelRelay["forAttempt"]>[1] }) => AttemptRelay; readonly cache?: { forOrder(order: WorkOrder): Promise<AttemptCache> } }) => WorkerHost | Promise<WorkerHost>;
    /** Shuts down what `build` made (live workers, the sandbox launcher, the relay). Called when the controller closes and when a later step of the start fails. */
    readonly close?: () => Promise<void>;
  };
  /**
   * The model-call cache (card H12e): the owner's endpoint configuration by route and the installation secret the keys are derived under. Given, `local.build` receives `cache.forOrder(order)`, one `AttemptCache` per attempt
   * (the same object for every ask), whose policy goes to the relay (`relay.forAttempt(.., attempt.policy)`) and to the host's `cache` option together with `takeUsage`.
   */
  readonly cache?: Pick<CachePolicyDeps, "secret" | "endpoints" | "state" | "isolationRequired"> & {
    /** The pin marker the project holds for this attempt's route, if any (a pin is sent only while the marker is active). */
    readonly pinMarker?: (order: WorkOrder) => string | undefined;
  };
  /** Where the invitations of scheduled meetings go (card M01): the host delivers them to the agents it can reach. Absent: they go to the controller's own invitation inbox, which the agent reads through `meeting.invitations`. */
  readonly invitations?: InvitationSink;
  /**
   * A hint to an agent that a meeting it is invited to is coming (card M01d), sent once the invitation is in its inbox, and only for an agent with no attempt running: a busy agent is not interrupted and sees the invitation at its next
   * stopping point. Idempotent by `key` on the host's side (an invitation tried again calls it again, possibly while the first call is still running). Not waited for. A failure is reported, never allowed to lose the invitation. Absent: the inbox alone.
   */
  readonly nudge?: (nudge: { readonly key: string; readonly agent: string; readonly occurrenceId: string; readonly projectId: string; readonly startsAt: string; readonly urgent: boolean }) => Promise<void>;
  /** Remote MCP servers (cards T03, H12g): the name resolver the host uses. Given, the handle carries the MCP service and the connector that reaches an approved server only at a checked public address. */
  readonly mcp?: { readonly resolve: NameResolver; /** Refuses while the controller is paused or stopping (the lifecycle gate); default: never refuses. */ readonly gate?: () => Promise<void> };
}

export interface DispatchHandle {
  readonly dispatcher: DispatcherService;
  /** The dispatcher's own service principal: the staff identity the lifecycle (Suspend, Stop) acts through (card L02). */
  readonly principal: Principal;
  readonly driver: DispatchDriver;
  /** Makes an agent's attempts quiet around an integration, refresh, release or quarantine of its work (card H12d). */
  readonly quiesce: QuiesceCoordinator;
  /** Shuts down the local worker host the operator built, if it gave a way to. */
  readonly closeWorkers: () => Promise<void>;
  /** The remote-worker service when `remote` was given: the owner's moves of attempts and stores, and the placement records (card H02c proves them through the composed controller). */
  readonly remote?: RemoteWorkerService;
  /** Where remote workers connect (present when `remote` was given). */
  readonly workerUrl?: string;
  /** The host an agent's live attempt runs on, if it has one (the review service judges a reviewer's host with it, card H05b). */
  readonly hostOfAgent: (agentId: string) => Promise<string | undefined>;
  /** One page of the rest of a tool result that was cut to the window (card C07d), for someone who may work on the task; otherwise it reads like a missing spill. */
  readonly readSpill: (by: Principal, spillId: string, index: number, size?: number) => Promise<{ text: string; next?: number } | undefined>;
  /** Charges time that is not a model call (a review, a job) to a task, as the dispatcher does; the commandId makes a repeat count once (card R05f). */
  /** Charges that could not be booked and are waiting for a retry, or were given up on (owner or dispatcher). */
  /** The attendance service, composed with the meetings and the budget (card R05g proves a held meeting reaches budget.usage through it). */
  readonly attendance: AttendanceService;
  /** The stand-up service composed with the meetings (card M03b). */
  readonly standups: StandupService;
  /** The watches the dispatcher set up and dispatches each tick (card H13b). */
  readonly watches: WatchService;
  readonly unsettledCharges: (by: Principal) => ReturnType<ChargeRetryService["unsettled"]>;
  readonly chargeUse: (usage: { commandId: string; activity: "review" | "background-job"; taskId: string; agentId?: string; computeMs: number }) => Promise<void>;
  /** The host side of workspace operations for a task's checkout (card H12l): the host of its live attempt, else the only host that has one; `undefined` when none can be named. */
  readonly workspacePortOf: (taskId: string) => Promise<WorkspacePort | undefined>;
  /** What an attempt's freeze says and lifting it, for the workspace service's recovery (card H12l). */
  readonly attemptControl: { live(taskId: string): Promise<string[]>; frozenReason(attemptId: string): Promise<string | undefined>; release(attemptId: string): Promise<void> };
  /** The MCP service and the only way the host reaches a remote server (cards T03, H12g); present when `mcp` was given. */
  readonly mcp?: { readonly service: McpService; readonly connector: RemoteMcpConnector };
}

export interface ComposeInput {
  /** Whether an agent can be reached apart from its pause gates (the controller's `availability` option): `suspended` and `stopped` agents are withheld from meetings, the same as in the API's own instance. */
  readonly availability?: (principalId: string) => Promise<Availability>;
  /** Brings an agent the host reports stopped or suspended up for one meeting, after the owner authorized it (card M04f). Absent: the owner's authorization is refused ("no wake path"). */
  readonly meetingWake?: WakeSink;
  readonly storage: ControllerStorage; readonly epoch: number; readonly options: DispatchStartOptions;
  readonly principals: PrincipalService; readonly grants: GrantService; readonly taskCredentials: TaskCredentialService; readonly projects: ProjectService; readonly assignments: AssignmentService; readonly waits: WaitService;
  readonly contracts: ContractService; readonly catalog: HarnessCatalog; readonly routing: RoutingService; readonly inquiries: InquiryService; readonly agents: AgentService; readonly histories: HistoryService; readonly reviews: ReviewService;
  readonly retrieval: RetrievalService;
  /** The workspace operations service; the tick resolves the ones a stopped controller left unfinished (card H12l). */
  readonly workspaceOps?: Pick<WorkspaceOpService, "recover">;
  /** Suspensions and stops the controller was carrying out are carried on each tick, and at start-up by the first one (card L02b). */
  readonly stops?: Pick<StopService, "sweep">;
  /** Meeting records are swept for votes past their time and records nobody finished (card M02c). */
  readonly records?: Pick<MeetingRecordService, "sweep">;
  /** Responsibility checks are recorded when due and incidents past their escalation time are escalated (card P04). */
  readonly responsibilities?: { readonly checks: Pick<ResponsibilityChecks, "generate">; readonly incidents: Pick<IncidentService, "escalate" | "untold" | "markNotified">; readonly notify?: (escalated: { id: string; projectId: string; escalatedTo?: string; signature: string; responsibilityId: string; count: number }) => Promise<void> };
  /** The nightly backup is started by the tick when the newest one is older than a day (card K01). */
  readonly backups?: Pick<BackupService, "runScheduled">;
  /** External event sources polled each tick (card H13d). None are built in. */
  readonly eventSources?: readonly EventSource[];
  /** The limits for the next local agent: the start-up figures with the owner's setting over them (card H12k). Throws when unreadable. */
  readonly workerLimits?: () => Promise<LocalWorkerLimits | undefined>;
  /** The owner's dispatcher limits (attempt time, attempts), read on every claim and re-admission; absent: the start-up options. */
  readonly dispatchLimits?: () => Promise<DispatcherLimitFigures>;
  /** The configured `time.maxMinutes` of a task, for the claim; absent: not applied. */
  readonly taskMinutes?: (taskId: string) => Promise<number | undefined>;
  /** The sources the owner turned off, read at every tick (card H13f). */
  readonly eventSourcesOff?: () => Promise<ReadonlySet<string>>;
  /** Health probes of failed-over routes (card R04c): off unless given, and then only while `enabled()` says so. */
  readonly probes?: { readonly cutover: Pick<CutoverService, "downTargets" | "probe">; readonly probes: RouteProbes };
  /** The checked resume the dispatcher calls when an attempt brings earlier work back (card L04c). */
  readonly resumes?: Pick<ResumeCheckService, "start" | "commit" | "advance" | "retry" | "cancel" | "forTask" | "checkIdFor" | "retryable" | "exhausted" | "cancelledAsStale" | "get"> & Partial<Pick<ResumeCheckService, "hasContinuation">>;
  /** Unfinished hand-offs and checked resumes are carried on the same way (cards L03c, L04c). */
  readonly sweeps?: readonly { readonly name: string; readonly sweep: (by: Principal) => Promise<unknown> }[];
  /** The stall detection and the reconciler the controller built; the dispatcher's tick runs them (card L01b). */
  readonly recovery?: { readonly stall: Pick<StallService, "scan"> & Partial<Pick<StallService, "reportFromRelay" | "holdWithOwner">>; readonly reconciler: { runPass(): Promise<unknown> } };
  readonly onError?: (error: unknown) => void;
  /** The `meeting.leadMinutes` setting (card M01d), already defaulted by the caller: how long before a meeting its occurrence is made and its agents are invited and kept free. */
  readonly leadMinutes?: () => Promise<number | undefined>;
}

/**
 * Builds the dispatcher on the controller's epoch and every loop the services said "the controller's loop must call" (cards H12, H12c): messages (U12 `settleDue`, `release`), attendance (M04
 * `sweepReturns`), stand-ups (M03 `prepare`, `deliverOutcomes`), event subscriptions (H06b `expireIdle`) and decisions (C08 `resume`), and the driver that ticks them. The dispatcher acts as
 * `service:dispatcher`, provisioned here with a credential that lives only in this process. The services built here share the controller's epoch, so a controller that was deposed writes nothing.
 */
export async function composeDispatch(i: ComposeInput): Promise<DispatchHandle> {
  const { storage, epoch } = i;
  const ro: RunnerOptions = i.options.clock === undefined ? {} : { clock: i.options.clock };
  const notifications = NotificationService.withEpoch(storage, epoch, ro);
  // A routine credential rotation at start is not reported; a dispatcher the owner disabled is: the owner is told once per epoch, then the refusal goes on to the caller.
  const tell = (why: string): Promise<unknown> => notifications.emitFromController({ commandId: `dpa-off:${epoch}`, kind: "maintenance", level: "needs-you", ref: { kind: "principal", id: "dispatcher" }, detail: why });
  const issued = await i.principals.provisionService(DISPATCHER_PRINCIPAL.slice("service:".length)).catch(async (error: unknown) => {
    if (error instanceof DomainError && error.code === "forbidden") await tell("The dispatcher is switched off: its service principal is disabled, so no work is started. Enable service:dispatcher to turn it back on.").catch(() => undefined);
    throw error;
  });
  const principal = await i.principals.authenticate(issued.token);
  const admission = AdmissionService.withEpoch(storage, epoch, ro);
  const hosts = HostService.withEpoch(storage, epoch, i.assignments, ro);
  const effects = EffectService.withEpoch(storage, epoch, i.assignments, { ...ro, holder: "dispatcher" });
  const blockers = BlockerService.withEpoch(storage, epoch, ro);
  const policy = PolicyService.withEpoch(storage, epoch, i.grants, { ...ro, roles: (id) => i.agents.rolesOfPrincipal(id) });
  const branchSettings = ProtectedBranchService.withEpoch(storage, epoch, ro);
  const budgets = BudgetService.withEpoch(storage, epoch, ro);
  const pauses = PauseService.withEpoch(storage, epoch, { waits: i.waits }, { ...ro, ...(i.availability === undefined ? {} : { otherAvailability: i.availability }) });
  const events = EventService.withEpoch(storage, epoch, { ...ro, notify: noticeThroughNotifications(notifications) });
  // A subscription made before idle expiry existed is counted idle from now, not from the day it was made (card H06c).
  await events.stampIdle(principal).catch((error: unknown) => i.onError?.(error));
  // The generation service is built from the decisions, and the decisions interrupt a running generation: the dependency is filled in once both exist.
  const decisionDeps: { -readonly [K in keyof DecisionDeps]: DecisionDeps[K] } = { events, effects };
  const decisions = DecisionService.withEpoch(storage, epoch, decisionDeps, ro);
  const generation = GenerationService.withEpoch(storage, epoch, { assignments: i.assignments, effects, pauses, decisions }, ro);
  decisionDeps.generation = generation;
  const difficulty = DifficultyService.withEpoch(storage, epoch, i.routing, i.contracts, ro);
  const route: RouteResolver = i.options.route ?? (async ({ commandId, taskId }) => {
    const d = await difficulty.resolve(principal, { commandId, taskId, role: "worker", data: "local-only", paidAuthorized: false });
    return d.outcome === "chosen" ? { route: d.route!, ...(d.profile?.harness === undefined ? {} : { harness: d.profile.harness }), role: d.role, request: d.request, routing: d.routingRevision ?? 0, profiles: d.profilesRevision } : { none: true, reasons: d.reasons };
  });
  const live: { dispatcher?: DispatcherService } = {};
  const delivery = i.options.invitations ?? InvitationInbox.withEpoch(storage, epoch, ro);
  const nudge = i.options.nudge;
  // The invitation first; then, for an agent with no attempt running, a hint that a meeting is coming (card M01d). Until the dispatcher exists nobody can be told apart, so no hint goes out.
  const invitations: InvitationSink = nudge === undefined ? delivery : withNudge(delivery, nudge, async (agent) => {
    if (live.dispatcher === undefined) return true;
    // Busy is an attempt running now; one waiting for a place or parked on an approval is not working and is kept free like any idle agent.
    for (const id of await live.dispatcher.liveAttemptsOf(principal, { agentId: agent })) if ((await live.dispatcher.get(principal, id))?.state === "running") return true;
    return false;
  }, i.onError);
  // A charge the ledger could not take is kept and tried again by a loop (card R05g); one given up on is reported.
  const chargeRetry = ChargeRetryService.withEpoch(storage, epoch, { budgets }, { ...ro, onDropped: (e) => i.onError?.(new Error(`charge ${e.commandId} was given up on: ${e.reason}`)) });
  const meetings = MeetingService.withEpoch(storage, epoch, { inquiries: i.inquiries }, { ...ro, availability: pauses.availability, invitations, ...(i.leadMinutes === undefined ? {} : { leadMinutes: i.leadMinutes }) });
  const messages = AgentMessageService.withEpoch(storage, epoch, {
    ...ro, availability: pauses.availability, taskPaused: (t) => pauses.isPaused(t), guard: (t) => pauses.guard(t), waits: i.waits, assignments: i.assignments, meetings, inquiries: i.inquiries, notifications,
  });
  const attendance = AttendanceService.withEpoch(storage, epoch, { meetings, pauses, projects: i.projects, assignments: i.assignments, agents: i.agents, histories: i.histories,
    // The time an agent spends in a meeting is charged as compute: to its meeting task, or to the shared-overhead rule "meeting" (card R05d).
    charge: (u) => chargeRetry.submit(principal, { commandId: u.commandId, activity: "meeting", agentId: u.agentId, computeMs: u.computeMs, projectId: u.projectId, ...(u.taskId === undefined ? { sharedOverheadRule: "meeting" } : { taskId: u.taskId }) }).then(() => undefined),
    ...(i.onError === undefined ? {} : { onChargeError: i.onError }), ...(i.leadMinutes === undefined ? {} : { leadMinutes: i.leadMinutes }) }, { ...ro, availability: pauses.availability, notices: meetingNoticeSink(messages), window: meetingWindowSink(messages), ...(i.meetingWake === undefined ? {} : { wake: i.meetingWake }) });
  const watches = WatchService.withEpoch(storage, epoch, { events, inbox: InboxService.withEpoch(storage, epoch, i.assignments), assignments: i.assignments, projects: i.projects }, ro);
  const followUps = chatTurnFollowUps(storage, epoch, ro);
  const improvements = ImprovementService.withEpoch(storage, epoch, { meetings }, { ...ro, outcomes: improvementOutcomeSink(messages) });
  // The one owner-level read the stand-up preparation needs: the inbox, nothing else; the elevated principal does not leave this closure.
  const ownerInboxFor = needsOwnerFrom({ inbox: () => notifications.inbox(recovering(principal)) }, principal);
  const ownerNoticesFor = noticesFrom({ inbox: () => notifications.inbox(recovering(principal)) }, principal);
  const standups = StandupService.withEpoch(storage, epoch, { meetings, assignments: i.assignments }, { ...ro, availability: pauses.availability, onBriefed: (by, item, revision) => improvements.markTold(by, item, revision), waitingMessages: (by, agent) => messages.waitingAtStandup(by, agent), ownerItems: ownerInboxFor, ownerNotices: ownerNoticesFor, outcomes: agendaOutcomeSink({ followUp: (turnId, f) => followUps.add(turnId, f), inquiry: async (id) => { const q = (await storage.getAggregate({ kind: "inquiry", id }))?.body as unknown as { asker?: string; taskId?: string } | undefined; return q?.asker === undefined || q.taskId === undefined ? undefined : { asker: q.asker, taskId: q.taskId }; }, messages }) });
  const projects = (): Promise<string[]> => projectIds(i.projects);
  let stallNotices = 0;
  const loops: DispatcherLoop[] = [
    { name: "charge-retry", run: (by) => chargeRetry.sweep(by) },
    ...(i.stops === undefined ? [] : [{ name: "stops.sweep", run: async (by: Principal) => { await i.stops!.sweep(recovering(by)); } }]), ...(i.sweeps ?? []).map((s) => ({ name: s.name, run: async (by: Principal) => { await s.sweep(recovering(by)); } })), ...messageLoops(messages, () => activeAgents(storage)), ...(i.workspaceOps === undefined ? [] : workspaceLoops(i.workspaceOps)), ...budgetNoticeLoops(budgets, (n) => { const { purpose, text } = holderNotice(n); return messages.noticeFromController({ commandId: `bgt-hold-${n.requestId}`, taskId: n.parentTaskId ?? n.taskId, to: n.to, purpose, text, admit: "budget.manage" }); }), ...attendanceLoops(attendance), ...meetingLoops(meetings, projects), ...standupLoops(standups, meetings, projects), ...eventLoops(events), ...watchLoops(watches),
    // The event is already in the agent's inbox; waking it is making sure an attempt is there to read it: one running will at its next boundary, one waiting for a place will when it starts (card H13c).
    ...wakeLoops(watches, attemptWaker(() => live.dispatcher, principal)), ...(i.records === undefined ? [] : recordLoops(i.records, projects)), ...(i.responsibilities === undefined ? [] : responsibilityLoops(i.responsibilities.checks, i.responsibilities.incidents, projects, i.responsibilities.notify)), ...(i.eventSources === undefined ? [] : sourceLoops(SourceService.withEpoch(storage, epoch, events, ro), i.eventSources, i.eventSourcesOff, { tell: (n) => notifications.emitFromController({ commandId: n.id, kind: "maintenance", ref: { kind: "principal", id: "dispatcher" }, detail: n.text }), log: (m) => i.onError?.(new Error(m)) })), ...(i.probes === undefined ? [] : probeLoops(i.probes.cutover, i.probes.probes)), ...(i.backups === undefined ? [] : [{ name: "backups.nightly", run: async () => { void i.backups!.runScheduled().catch(() => undefined); /* started, not awaited: a long copy never holds up the other loops; a failure is kept in the backup status */ } }]), ...improvementOutcomeLoops(improvements, projects), ...untoldImprovementLoops(improvements, projects, (n) => notifications.emitFromController({ commandId: n.key, kind: "maintenance", level: "notice", ref: { kind: "improvement-item", id: n.itemId }, detail: n.text, projectId: n.projectId })), ...reviewLoops(i.reviews, projects), ...decisionLoops(decisions, projects),
    // A pause the owner gave a time to is lifted when the time comes, and only that scope (card L06b).
    { name: "lifecycle.resume-conditions", run: async (by) => { await pauses.liftDue(by); } },
    ...(i.recovery === undefined ? [] : recoveryLoops(i.recovery.stall, i.recovery.reconciler, () => notifications.emitFromController({ commandId: `stall-off:${epoch}:${++stallNotices}`, kind: "maintenance", level: "needs-you", ref: { kind: "principal", id: "dispatcher" }, detail: "Stall detection is not running: the dispatcher does not hold the recovery.stall-scan right. Grant it that right to turn stall detection on." }), () => i.principals.authenticate(issued.token), async (c) => {
      // Each climb of the supervisor ladder is told once (owner decision 2026-10-30, supervisor ladder): the id carries the concern, the level and the time it climbed, which are stored, so a retried notice is the same one. A supervisor is told by a notice on the task; the owner, at the top, by a needs-you item.
      const key = createHash("sha256").update(`${c.id}|${c.escalatedAt ?? ""}|${c.escalationLevel ?? 0}`).digest("hex").slice(0, 32);
      const detail = `A ${c.kind} concern on a task has waited too long for its supervisor to decide: ${c.detail}`.slice(0, 200);
      if (c.escalatedTo?.startsWith("agent:")) {
        try { await messages.noticeFromController({ commandId: `stall-esc-${key}`, taskId: c.taskId, to: c.escalatedTo, purpose: "A stuck agent's concern was passed up to you", text: `${detail} Concern ${c.id}, level ${c.escalationLevel ?? 1}. Look at it and confirm or dismiss it; if you do not decide in time it goes to your supervisor, and finally to the owner.` }); return; } catch (error) {
          // A supervisor who can no longer be told (it lost sight of the task since) must not hold the concern: the owner is told, and the reason is in the text.
          if (!(error instanceof DomainError && error.code === "forbidden")) throw error;
          // The concern is parked with the owner first, so it is not left with an agent who cannot see the task (and does not climb back down); a repeat of this notice is the same one.
          await i.recovery!.stall.holdWithOwner?.(await i.principals.authenticate(issued.token), c.id);
          await notifications.emitFromController({ commandId: `stall-esc-${key}`, kind: "maintenance", level: "needs-you", ref: { kind: "task", id: c.taskId }, projectId: c.projectId, detail: `${detail}`.slice(0, 120) + ` (${c.escalatedTo} could not be told)` });
          return;
        }
      }
      await notifications.emitFromController({ commandId: `stall-esc-${key}`, kind: "maintenance", level: "needs-you", ref: { kind: "task", id: c.taskId }, projectId: c.projectId, detail });
    })),
  ];
  // The local worker host gets its guards here, bound to the services built above (card H12k); the dispatcher then has it among its workers.
  const workers: WorkerHost[] = [...(i.options.workers ?? [])];
  // Context enforcement (card C07b): the worker host's first-call checks, and the dispatcher's overflow count and hand-off when an attempt ends.
  const context = ContextEnforcementService.withEpoch(storage, epoch, { blockers, retrieval: i.retrieval }, ro);
  if (i.options.local !== undefined) {
    const limits = checkLocalWorkerLimits(i.options.local.limits);
    const guards = controllerGuards({
      context, pause: pauses, messages, system: principal,
      agent: (order) => i.taskCredentials.authenticate(order.credential),
      assignee: (order) => i.taskCredentials.agentOf(principal, order.attemptId),
      window: i.options.local.window,
      ...(i.options.local.storedTokens === undefined ? {} : { storedTokens: i.options.local.storedTokens }),
    });
    let cache: { forOrder(order: WorkOrder): Promise<AttemptCache> } | undefined;
    if (i.options.cache !== undefined) {
      const o = i.options.cache;
      const policies = new CachePolicies({ ...o, principal, markers: MarkerService.withEpoch(storage, epoch, ro), ...(i.onError === undefined ? {} : { onError: i.onError }) });
      // One policy per attempt: its slot, its pin bookkeeping and its figures belong to the attempt, so the relay and the host must share it. An entry is kept until the attempt's own expiry (it cannot run past it) and dropped then, never earlier.
      const made = new Map<string, { readonly cache: Promise<AttemptCache>; readonly until: number }>();
      const now = i.options.clock === undefined ? Date.now : (): number => Date.parse(i.options.clock!());
      cache = {
        forOrder: (order) => {
          for (const [id, entry] of made) if (entry.until < now()) made.delete(id);
          let found = made.get(order.attemptId);
          if (found === undefined) {
            const pin = o.pinMarker?.(order);
            const cache = policies.forAttempt({ projectId: order.projectId, route: order.route }, pin === undefined ? {} : { pinMarker: pin });
            found = { cache, until: (order.expiresAt === undefined ? now() + 24 * 3_600_000 : Date.parse(order.expiresAt)) + 60_000 };
            made.set(order.attemptId, found);
            cache.catch(() => made.delete(order.attemptId));
          }
          return found.cache;
        },
      };
    }
    const windowOf = i.options.local.window;
    const contextFor = (order: WorkOrder): WorkerContextLimits | undefined => {
      const window = windowOf(order);
      if (window === undefined) return undefined;
      const budget = context.budget(window);
      return { toolOutputBytes: Math.min(Math.floor(budget.toolOutputChars), 10_000_000), compaction: { fallback: "extractive" } };
    };
    const confirmFirstCall = async (order: WorkOrder, usage: { readonly inputTokens: number; readonly requestChars: number }): Promise<void> => {
      try { await guards.context?.confirm?.(order, { reportedInputTokens: usage.inputTokens, promptChars: Math.max(1, usage.requestChars) }); } catch (error) { i.onError?.(error); }
    };
    // What the relay tells stall detection about every model call of an attempt (card V01b): reports are sent one after another so they arrive in order, and a failure of the report never reaches the call.
    const reporter = i.recovery?.stall.reportFromRelay?.bind(i.recovery.stall);
    const monitorOf = reporter === undefined ? undefined : (order: WorkOrder): RelayMonitor => {
      // Reports are sent one after another so they arrive in order; each call has its own request ID, and every report names the attempt, so a leftover process of an earlier attempt is fenced.
      let queue: Promise<unknown> = Promise.resolve(); let calls = 0; let seq = 0;
      // The share of the prompt the cache served on the attempt's latest finished call: the next call, which repeats most of that prompt, is expected to be served about as much (card V01c).
      let expectedShare: number | undefined;
      const send = (event: StallEvent): void => {
        const commandId = `relay:${order.attemptId}:${++seq}`;
        queue = queue.then(() => reporter({ commandId, taskId: order.taskId, generation: order.generation, attemptId: order.attemptId, event })).catch((error) => { if (!(error instanceof DomainError && (error.code === "fenced" || error.code === "not_found" || (error.code === "invalid_command" && /is not the open request/.test(error.message))))) i.onError?.(error); });
      };
      const tokensOf = (chars: number): number => Math.ceil(chars / RELAY_CHARS_PER_TOKEN);
      return {
        started: ({ requestChars }) => {
          const requestId = `${order.attemptId}:${++calls}`;
          send({ type: "request_started", requestId, promptTokens: tokensOf(requestChars), route: order.route, ...(expectedShare === undefined ? {} : { cachedShare: expectedShare }) });
          return {
            firstOutput: () => { send({ type: "first_output", requestId }); },
            // A rough count: the bytes of the stream over the same characters per token. The provider's own count arrives with the end of the call.
            progress: (bytes) => { send({ type: "output_progress", requestId, tokens: tokensOf(bytes) }); },
            finished: (call) => { if (call.ok && call.inputTokens !== undefined && call.inputTokens > 0 && call.cachedTokens !== undefined) expectedShare = Math.min(1, Math.max(0, call.cachedTokens / call.inputTokens)); send({ type: "request_finished", requestId, outcome: call.ok ? "ok" : "error", ...(call.inputTokens === undefined ? {} : { inputTokens: call.inputTokens }), ...(call.cachedTokens === undefined ? {} : { cachedTokens: call.cachedTokens }), ...(call.outputTokens === undefined ? {} : { outputTokens: call.outputTokens }) }); },
          };
        },
      };
    };
    // One relay per attempt, kept until the attempt\'s own expiry.
    const relays = new Map<string, { readonly relay: AttemptRelay; readonly until: number }>();
    const attemptRelay = (order: WorkOrder, relay: ModelRelay, options: { readonly model?: string; readonly cache?: Parameters<ModelRelay["forAttempt"]>[1] } = {}): AttemptRelay => {
      const clock = i.options.clock === undefined ? Date.now : (): number => Date.parse(i.options.clock!());
      for (const [id, entry] of relays) if (entry.until < clock()) relays.delete(id);
      let found = relays.get(order.attemptId);
      if (found === undefined) {
        found = { relay: relay.forAttempt({ route: order.route, ...(options.model === undefined ? {} : { model: options.model }), onFirstUsage: (usage) => { void confirmFirstCall(order, usage); }, ...(monitorOf === undefined ? {} : { monitor: monitorOf(order) }) }, options.cache), until: (Number.isFinite(Date.parse(order.expiresAt ?? "")) ? Date.parse(order.expiresAt!) : clock() + 24 * 60 * 60_000) + 60_000 };
        relays.set(order.attemptId, found);
      }
      return found.relay;
    };
    workers.push(await i.options.local.build({ guards, currentLimits: async () => i.workerLimits === undefined ? limits : i.workerLimits(), context: contextFor, confirmFirstCall, attemptRelay, ...(cache === undefined ? {} : { cache }) }));
  }
  // Whatever was built before a later step fails is closed again: the listener, and the local host built above (a host the controller was given the means to build owns real resources).
  let transport: WorkerTransport | undefined;
  try {
    // Remote workers: the dispatcher is built with a way to ask who owns an agent's native store, and the remote service is built on the dispatcher afterwards.
    let remote: RemoteWorkerService | undefined;
    let blobs: FileBlobStore | undefined;
    const holder: { dispatcher?: DispatcherService } = {};
    if (i.options.remote !== undefined) {
      blobs = await FileBlobStore.open({ directory: i.options.remote.blobDirectory });
      const artifacts = ArtifactService.withEpoch(storage, epoch, blobs, { ...ro, onPublished: async (e) => { await ActivityService.withEpoch(storage, epoch, ro).record(principal, { commandId: `artv:${e.artifactId}`, taskId: e.taskId, kind: "artifact-version", summary: `Recorded artifact ${e.name} (${e.files} file${e.files === 1 ? "" : "s"}).`, manifest: { refs: [{ kind: "artifact", id: e.artifactId }] } } as never); } });
      const d = (): DispatcherService => holder.dispatcher!;
      remote = RemoteWorkerService.withEpoch(storage, epoch, {
        principal, hosts, artifacts,
        dispatch: { gateway: (id) => d().gateway(id), get: (by, id) => d().get(by, id), relocate: (by, id, m) => d().relocate(by, id, m), quiesce: (by, id, r) => d().quiesce(by, id, r), release: (by, id) => d().release(by, id) },
        ...(i.options.remote.relocationPolicy === undefined ? {} : { relocationPolicy: i.options.remote.relocationPolicy }),
        ...(i.options.remote.placementPolicy === undefined ? {} : { placementPolicy: i.options.remote.placementPolicy }),
      }, { ...ro, ...(i.options.remote.protocol === undefined ? {} : { protocol: i.options.remote.protocol }), ...(i.options.remote.fileBytes === undefined ? {} : { fileBytes: i.options.remote.fileBytes }) });
      for (const h of i.options.remote.hosts) workers.push(new RemoteWorkerHost(h.hostId, remote, principal, h));
    }
    const dispatcher = DispatcherService.withEpoch(storage, epoch, {
      principal, assignments: i.assignments, projects: i.projects, credentials: i.taskCredentials, admission, hosts, workers,  contracts: i.contracts, harnesses: i.catalog, policy, protectedBranch: (projectId, branch) => branchSettings.isProtected(projectId, branch), effects, blockers, route,
      activity: async (step) => { await ActivityService.withEpoch(storage, epoch, ro).record(principal, { commandId: step.commandId, taskId: step.taskId, kind: step.kind, summary: step.summary, manifest: { refs: step.refs } } as never); }, routing: i.routing, pauses, decisions, ...(i.resumes === undefined ? {} : { resumes: i.resumes }), prerequisites: async (taskId: string) => { const deps = await i.contracts.prerequisitesOf(taskId); if (deps === undefined) throw new DomainError("unavailable", "the task's dependencies could not be read"); const open: string[] = []; const dead: string[] = []; for (const e of deps.dependsOn) { if (e.state === undefined) dead.push(`${e.taskId} (missing)`); else if (e.state === "cancelled") dead.push(`${e.taskId} (cancelled)`); else if (e.state !== "done") open.push(`${e.taskId} (${e.state})`); } return { open, dead }; }, checkouts: ProjectResourceService.withEpoch(storage, epoch, ro), generation, reviews: i.reviews, budgets, meetings: attendance, notifications, loops, context,
      ...(i.options.local === undefined ? {} : { toolWindow: (route: string) => { try { return i.options.local!.window({ route } as WorkOrder); } catch { return undefined; } } }),
      ...(remote === undefined ? {} : { storeOwner: (agentId: string, attemptId: string) => remote!.storeOwner(principal, agentId, attemptId) }),
    }, { ...ro, holder: "dispatcher", ...(i.onError === undefined ? {} : { onError: i.onError }), ...(i.options.dispatcher ?? {}), ...(i.dispatchLimits === undefined ? {} : { limits: i.dispatchLimits }), ...(i.taskMinutes === undefined ? {} : { configuredMinutes: i.taskMinutes }) });
    holder.dispatcher = dispatcher;
    live.dispatcher = dispatcher;
    if (remote !== undefined) {
      transport = await WorkerTransport.listen({ ...(i.options.remote?.transport ?? {}), remote, principals: i.principals });
    }
    const driver = new DispatchDriver({
      dispatcher, storage, epoch, record: { storage, options: ro },
      ...(i.options.intervalMs === undefined ? {} : { intervalMs: i.options.intervalMs }), ...(i.options.timer === undefined ? {} : { timer: i.options.timer }), ...(i.options.clock === undefined ? {} : { clock: i.options.clock }),
      ...(i.onError === undefined ? {} : { onError: i.onError }),
      enabled: async () => (await i.principals.get(DISPATCHER_PRINCIPAL))?.state === "active",
      onDisabled: async (why) => { await tell(why); },
    });
    const mcpService = i.options.mcp === undefined ? undefined : McpService.withEpoch(storage, epoch, { ...ro, ...(i.options.mcp?.gate === undefined ? {} : { gate: i.options.mcp.gate }) });
    // Started last, so a failure above leaves no driver ticking a dispatcher whose host is being closed.
    if (i.options.manual !== true) driver.start();
    return {
      dispatcher, driver, closeWorkers: async () => { remote?.close(); await transport?.close().catch(() => undefined); await i.options.local?.close?.(); },
      ...(transport === undefined ? {} : { workerUrl: transport.url }), ...(remote === undefined ? {} : { remote }),
      attemptControl: { live: (taskId) => dispatcher.liveAttemptsOf(principal, { taskId }), frozenReason: async (id) => (await dispatcher.get(principal, id))?.frozen?.reason, release: (id) => dispatcher.release(principal, id) },
      workspacePortOf: async (taskId) => {
        const capable = workers.filter((w) => w.workspace !== undefined);
        for (const attemptId of await dispatcher.liveAttemptsOf(principal, { taskId })) {
          const d = await dispatcher.get(principal, attemptId);
          const host = d?.state === "running" ? d.hostId : d?.pinnedHost;
          if (host !== undefined) return workers.find((w) => w.hostId === host)?.workspace;
        }
        // No live attempt names a host: the checkout is on the only host that can do this, if there is exactly one.
        return capable.length === 1 ? capable[0]!.workspace : undefined;
      },
      attendance, standups, watches,
      unsettledCharges: (by) => chargeRetry.unsettled(by),
      chargeUse: (u) => chargeRetry.submit(principal, { commandId: u.commandId, activity: u.activity, taskId: u.taskId, computeMs: u.computeMs, ...(u.agentId === undefined ? {} : { agentId: u.agentId }) }).then(() => undefined),
      // An outside server's text is framed as data on every page, with the injection check over the page itself (the visible head was checked when it was cut).
      readSpill: async (by, spillId, index, size) => {
        const found = await context.readSpill(by, spillId, index, size);
        if (found === undefined) return undefined;
        return { text: found.untrusted === true ? framedMcp(found.tool ?? "mcp", found.text, undefined, true) : found.text, ...(found.next === undefined ? {} : { next: found.next }) };
      },
      principal,
      hostOfAgent: async (agentId) => { for (const attemptId of await dispatcher.liveAttemptsOf(principal, { agentId })) { const d = await dispatcher.get(principal, attemptId); const host = d?.state === "running" ? d.hostId : d?.pinnedHost; if (host !== undefined) return host; } return undefined; }, quiesce: new QuiesceCoordinator({ dispatcher, blockers, principal }),
      ...(mcpService === undefined || i.options.mcp === undefined ? {} : { mcp: { service: mcpService, connector: new RemoteMcpConnector({ mcp: mcpService, resolve: i.options.mcp.resolve, principal }) } }),
    };
  } catch (error) {
    await transport?.close().catch(() => undefined);
    await i.options.local?.close?.().catch(() => undefined);
    throw error;
  }
}
