import type { SecurityEvent } from "../notifications/urgent.js";
import type { ReportInterrogatorPort } from "../dispatch/report.js";
import type { PiStateSource } from "../backup/index.js";
import type { ResumeCheckService } from "../continuation/resume.js";
import type { ContinuationService } from "../continuation/continuation.js";
import { continuationRecorder } from "../continuation/host-capture.js";
import type { ReleaseService } from "../release/release.js";
import { createHash } from "node:crypto";
import { framedMcp } from "../dispatch/tools.js";
import { ProjectResourceService } from "../projects/index.js";
import type { AttemptRelay, ModelRelay, RelayMonitor } from "../dispatch/relay.js";
import { AdmissionService } from "../admission/index.js";
import { BudgetService, ChargeRetryService, holderNotice, type NotifyAggregate } from "../budgets/index.js";
import { ArtifactService, FileBlobStore } from "../artifacts/index.js";
import { QuietHostService, type QuietHostOptions, RemoteWorkerHost, RemoteWorkerService, WorkerTransport, type QuietHostSettingsService, type RemoteDeps, type RemoteOptions, type RemoteWorkerHostOptions, type WorkerTransportOptions } from "../remote/index.js";
import { DecisionService, compactionKeep, ownerRuleItems, startupItems, type DecisionDeps } from "../decisions/index.js";
import { ANCHOR_DEFAULT_CHARS, anchorBudget, findAnchors } from "../context/anchor.js";
import { RecallReader } from "../context/recall-source.js";
import { RecallService } from "../context/recall-service.js";
import { ContextEnforcementService, PROMPT_NOTE_RESERVE_CHARS, StartSizeService, ThinkingStore, type ReportedThinking, startSizeRecorder, type ContextRouteSettingsService, type HandoffFacts } from "../context/index.js";
import { CachePolicies, type AttemptCache, type CachePolicyDeps } from "../dispatch/cache.js";
import { CacheEndpoints, MarkerService } from "../inference-cache/index.js";
import type { LandingPolicyFigures } from "./landing-policy.js";
import { checkLocalWorkerLimits, type LocalWorkerLimits } from "./worker-limits.js";
import type { LaunchRecord } from "./worker-limits-settings.js";
import type { WorkspaceOpService, WorkspacePort } from "../workspace-ops/index.js";
import { DispatchDriver, DispatcherService, QuiesceCoordinator, checkpointStoredTokens, controllerGuards, estimatedFirstCall, usableWindow, type RuntimeGuards, type ToolGateway, type WorkOrder, activeAgents, attendanceLoops, wakeAttendLoops, budgetNoticeLoops, coverageLoops, type CoverageNoticeLike, workspaceLoops, decisionLoops, meetingLoops, eventLoops, watchLoops, wakeLoops, attemptWaker, recordLoops, responsibilityLoops, probeLoops, grantLapseLoops, sourceLoops, improvementOutcomeLoops, untoldImprovementLoops, type RouteProbes, recoveryLoops, reviewLoops, messageLoops, projectIds, standupLoops, type AttemptDispatcherOptions, type DispatcherLimitFigures, type DispatcherLoop, type DispatcherDeps, type RouteResolver, type TimerPort, type WorkerHost } from "../dispatch/index.js";
import type { EnvironmentService } from "../environments/index.js";
import type { CutoverService } from "../routing/cutover.js";
import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import type { StallService } from "../health/index.js";
import { relayMonitor } from "./relay-monitor.js";
import { providerKind } from "../setup/providers.js";

/** Who the local worker's security hook reports as (card U11d): a host principal with no grants of its own; it can only report. */
const LOCAL_HOST_REPORTER: Principal = { id: "host:local-worker", kind: "host", name: "local-worker", grants: [] };
import { EffectService } from "../domain/effects.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { WaitService } from "../domain/waits.js";
import { EventService, SourceService, noticeThroughNotifications, type EventSource } from "../events/index.js";
import { WatchService } from "../events/handling.js";
import { InboxService } from "../domain/inbox.js";
import { GenerationService, streamTapFor, type StreamSettingsService } from "../generation/index.js";
import type { HarnessCatalog } from "../harness/index.js";
import { HostService } from "../hosts/index.js";
import type { JsonObject } from "../storage/types.js";
import { NetworkGrantService, NetworkRelay, WebFetch, WEB_FETCH_TOOL, type NetworkOpener, type NetworkRelayOptions, type WebFetchOptions } from "../network/index.js";
import type { BuiltinTool } from "../toolbridge/index.js";
import { McpService, RemoteMcpClient, RemoteMcpConnector, type McpHttpOptions } from "../mcp/index.js";
import type { NameResolver } from "../dispatch/network.js";
import type { RetrievalService } from "../context/index.js";
import type { AgentService } from "../agents/index.js";
import type { HistoryService } from "../context/index.js";
import type { InquiryService } from "../inquiries/index.js";
import { PauseService } from "../lifecycle/index.js";
import type { HandoffService } from "../lifecycle/handoff.js";
import type { Availability } from "../conversations/index.js";
import { ActivityService } from "../activity/index.js";
import type { BackupService } from "../backup/index.js";
import type { MeetingRecordService } from "../meetings/record.js";
import type { CoverageService, IncidentService, ResponsibilityChecks } from "../projects/index.js";
import { AttendanceService, InvitationInbox, MeetingService, MeetingWakeHost, type WakeAttender, meetingNoticeSink, meetingWindowSink, withNudge, type InvitationSink, type WakeSink } from "../meetings/index.js";
import { AgentMessageService } from "../messaging/index.js";
import { NotificationService } from "../notifications/index.js";
import type { ContractService } from "../planning/index.js";
import { ApprovalLoadService, PolicyService, ProtectedBranchService } from "../policy/index.js";
import type { ReviewService } from "../review/index.js";
import { DifficultyService, type FallbackService, type RoutingService } from "../routing/index.js";
import { cutoverListener, routeCallsOf } from "./route-calls.js";
import { DISPATCHER_PRINCIPAL, type GrantService, type Principal, type PrincipalService, type TaskCredentialService } from "../security/index.js";
import { redactText } from "../security/redact.js";
import type { StopService } from "../lifecycle/stop.js";
import { ImprovementService, StandupService, agendaOutcomeSink, allocationFromValue, improvementOutcomeSink, needsOwnerFrom, noticesFrom, ownerQuestionSink, preparationNoticeSink } from "../standups/index.js";
import { chatTurnFollowUps } from "../chat/follow-ups.js";
import type { ControllerStorage } from "../storage/types.js";
import { personalNamespace } from "../catalog/index.js";
import type { BoundGateway, BridgeRequest, BridgeResponse, ToolExecutionService } from "../toolbridge/index.js";

/**
 * Finishing what a request already started (a suspension, a stop, a hand-off, a checked resume) after a restart is not a new decision: whoever was entitled to ask did, and the record says so. The dispatcher's service principal holds no
 * control grants of its own, so the sweeps run with its identity at the owner's level of control, in this process only (no API operation reaches it); the audit still names the dispatcher as the actor.
 */
const recovering = (by: Principal): Principal => ({ ...by, kind: "owner" });

/** What the operator gives the controller to run the dispatcher (card H12c). Absent from `StartOptions`: no dispatcher is built and no loop runs. */
/** The worker process's context limits for an order, in the shape of the channel's `ChannelContext` (the controller does not depend on the contracts package; the host's `context` option takes it structurally). */
export interface WorkerContextLimits { readonly toolOutputBytes?: number; readonly toolOutputLines?: number; readonly compaction?: { readonly timeoutMs?: number; readonly fallback?: "extractive"; /** The owner's decisions the process keeps through its own compactions (card C07q). */ readonly keep?: { readonly note: string; readonly lines: readonly string[] }; /** Card W12: the goal anchor the controller wrote for the attempt, which the process puts at the top of every summary that replaces its cut conversation (replacing the earlier one). */ readonly anchor?: { readonly text: string } } }

/** Remote workers (card H02): the artifact folder the controller owns, the listener workers connect to and the hosts the dispatcher may place attempts on. */
export interface RemoteStartOptions {
  /** The controller's own folder for artifacts and checkpoints. Workers never mount a database or this folder: they fetch through the transport. */
  readonly blobDirectory: string;
  /** Where the transport listens. Default: loopback on any free port. Exposure beyond loopback needs `allowRemote`, TLS and `publicHosts` (see `WorkerTransportOptions`). */
  readonly transport?: Omit<WorkerTransportOptions, "remote" | "principals">;
  readonly protocol?: RemoteOptions["protocol"];
  readonly fileBytes?: number;
  /** How long a move waits for the old host to settle and send a checkpoint (see `RemoteOptions.settleMs`). */
  readonly settleMs?: number;
  readonly relocationPolicy?: RemoteDeps["relocationPolicy"];
  /** Which hosts may hold local-only data, see the repository or be given the task credential (card H07). Default: local-only data is never placed on a remote host. */
  readonly placementPolicy?: RemoteDeps["placementPolicy"];
  /** Whether a reconnected worker may take its attempt up again by itself (card H09b). Default: the owner decides. */
  readonly reaccept?: RemoteDeps["reaccept"];
  /** How long an attempt that waits for the owner keeps its lease (card H09b); the controller supplies the owner's setting when absent. */
  readonly patienceMs?: RemoteDeps["patienceMs"];
  readonly confirmWindowMs?: RemoteDeps["confirmWindowMs"];
  /** How often a remote model call's output so far is reported to stall detection while it streams (see `RemoteDeps.monitorProgressMs`; default 15 s). */
  readonly monitorProgressMs?: number;
  /** The remote hosts attempts may be placed on, with what each attempt asks of them and what it needs. */
  readonly hosts: readonly ({ readonly hostId: string } & RemoteWorkerHostOptions)[];
}

export interface DispatchStartOptions {
  /** Timing of the quiet-host pass (default: a host is quiet after 5 minutes; a gap between passes beyond 10 minutes is read as a clock jump or a stall). */
  readonly quietHosts?: Pick<QuietHostOptions, "quietAfterMs" | "maxGapMs">;
  /** Remote workers: a transport workers connect to, and hosts placed after the local ones. */
  readonly remote?: RemoteStartOptions;
  /** The worker hosts, local or remote, tried in order. None: attempts are admitted and checked but no worker starts (the loops still run). */
  readonly workers?: readonly WorkerHost[];
  /**
   * What the controller writes a hand-off from when an attempt ends without one — the durable facts of the task: the effect ledger, its artifacts, the checkpoint and the last known state (card C07p). Absent:
   * the dispatcher's own default (the task's title, how the attempt ended and whether it holds a checkpoint), which is all a controller with no ledger reader knows.
   */
  readonly handoffFacts?: (info: { taskId: string; attemptId: string; endedBecause: string }) => Promise<Omit<HandoffFacts, "endedBecause">>;
  /**
   * Whether every checkpoint a worker host hands the dispatcher (the end of a turn, a shutdown, a stop) is captured as the task's continuation (card L04d). Default on; `false` captures none, and a resume is then checked only
   * against what a host or the owner captured through `continuation.capture`. A capture is complete only when the host said its checkpoint reads back from its store.
   */
  readonly captureContinuations?: boolean;
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
    /** The model's context window for the order's route, in tokens. `undefined` means this host does not state one for the route: the routing table's `contextTokens` for it is used instead, and a route neither says is refused (card C07n). */
    readonly window: (order: WorkOrder) => number | undefined;
    /** The size of the conversation a checkpoint holds, in tokens. Absent: the controller's own reader of the worker package's checkpoint shape (`checkpointStoredTokens`) judges every stored conversation, so a resume is never left unchecked (card C07n). */
    readonly storedTokens?: (from: NonNullable<WorkOrder["resumeFrom"]>) => number | undefined;
    /** What one agent on this host may use (cpus, memoryMb, diskMb, processes), checked at start and handed to `build` as `limits` for the host's `workspace` to carry (`AttemptWorkspace.limits`). Absent: none applied. */
    readonly limits?: LocalWorkerLimits;
    readonly build: (services: { /** The route out of a task's sandbox (card H12i), present when `network` was given: spread `{ network: services.network }` into the host's options. */ readonly network?: { readonly forAttempt: (order: WorkOrder) => NetworkOpener | undefined }; readonly guards: RuntimeGuards; /** The worker-side security hook (card U11d): hand it to `LocalWorkspaces` as `security`. It reports to the owner's Urgent watch through the controller's security detectors (source `local-worker`, under the owner's `securityDetectors` switch), never throws and never waits. A security event is `{ kind, key, projectId }`; the key is the same for the same event and holds no secret. */ readonly reportSecurity: (event: { readonly kind: string; readonly key: string; readonly projectId?: string }) => void; /** The landing policy for a task, from the owner's settings (`workspace.landing.branch`, `.requirePermit`, `.protectedPaths`), read fresh at each call (card H12s). Pass it as the `landing` option of `LocalWorkspaces`. It throws when the settings cannot be read, which the host treats as no policy (the landing is refused). */ readonly landingPolicy: (call: { readonly taskId: string; readonly projectId: string }) => Promise<LandingPolicyFigures>; /** The limits for an agent launched now (start-up figures with the owner's setting over them), read fresh at each call; `undefined` when none apply. There is deliberately no static copy of the start-up figures here, so a host cannot read stale ones. It throws when the setting cannot be read, and the host must then refuse the launch (fail visibly), never run the agent unlimited. */ readonly currentLimits: () => Promise<LocalWorkerLimits | undefined>; /** Whether the owner allowed best effort: a launch whose limits this OS cannot enforce in full may go ahead (default: refused). Read at each launch; throws when unreadable, and the host must then refuse the launch. */ readonly bestEffortAllowed: () => Promise<boolean>; /** Keeps what a launch came to (limits asked for, how each was enforced, started or refused). Pass the host's `onLaunch` this; if it throws the host ends the process. */ readonly recordLaunch: (record: LaunchRecord) => Promise<void>; /** Keeps a compaction the attempt\'s own process made (card C07q): it takes its place in the task\'s compaction chain with how much was compacted and the summary\'s digest. Never throws. Spread into the host with `ownerPolicyOptions(services)`. */ readonly recordCompaction: (order: WorkOrder, note: { readonly messageCount: number; readonly summaryChars: number; readonly digest: string }) => Promise<void>; /** Keeps the model\'s thinking the attempt\'s process reported (card U09b): untrusted text that is cleaned, bounded and stored for the owner only, and only for the task\'s current attempt. Never throws. Spread into the host with `ownerPolicyOptions(services)`. */ readonly recordThinking: (order: WorkOrder, blocks: readonly ReportedThinking[]) => Promise<void>; /** The process's context limits for an order (card C07b): tool output cut to the window\'s share and the extractive compaction fallback, with the owner\'s decisions for the task that the process keeps through its compactions (card C07q); `undefined` when the route does not say its window. Never throws (decisions that cannot be read are left out and reported). The host\'s `context` option takes it. */ readonly context: (order: WorkOrder) => Promise<WorkerContextLimits | undefined>; /** Records the input size the provider reported for the attempt\'s first model call (the relay\'s `onFirstUsage`) against the call that was admitted. Never throws. */ readonly confirmFirstCall: (order: WorkOrder, usage: { readonly inputTokens: number; readonly requestChars: number }) => Promise<void>; /** The relay of one attempt (the same object for every call of the attempt, so that only its first call is measured), with the first-call count already going to `confirmFirstCall`. Use this instead of `relay.forAttempt`. */ readonly attemptRelay: (order: WorkOrder, relay: ModelRelay, options?: { readonly model?: string; readonly cache?: Parameters<ModelRelay["forAttempt"]>[1] }) => AttemptRelay; readonly cache?: { forOrder(order: WorkOrder): Promise<AttemptCache> }; /** Present when `dispatch.mcp` was given (card H12k): the only way the host reaches a remote MCP server, the same connector and client as the handle's `mcp`. */ readonly mcp?: { readonly connector: RemoteMcpConnector; readonly client: RemoteMcpClient }; /** The protected tool bridge (card T06b): answers one bridge request of an attempt's worker process with the controller's `ToolExecutionService`, bound to the attempt (`order.attemptId`) and its gateway (`call`). Pass it as the `bridge` option of `localWorkerParts`. Present when the controller was started with `tools`; absent, the host has no bridge to give its processes. */ readonly bridge?: (order: WorkOrder, call: ToolGateway["call"], token: string, request: { readonly op: string; readonly callId: string; readonly args?: { readonly [key: string]: unknown } }) => Promise<BridgeResponse>; /** The agent's own tool namespace as the worker process names it (card T06b): the catalogue's `personalNamespace` of the order's agent without its `a_` prefix. Pass it as the `namespaceId` option of `localWorkerParts`. */ readonly namespaceId: (order: WorkOrder) => string }) => WorkerHost | Promise<WorkerHost>;
    /** Run agents without the owner's limits, best-effort setting and launch record (the host built by `build` does not connect them). Absent: such a host is refused at start. */
    readonly acceptUnenforcedLimits?: boolean;
    /** Where this host keeps the agents' own conversation stores, and where each one goes back on a restore (card K01h). Given: backups include them and restores put them back, with no separate `backup.piState`. Absent (and no `backup.piState`): Pi state is not in backups, and the backup status says so. */
    readonly piState?: { readonly source: PiStateSource; readonly final?: (id: string) => string | undefined; /** Removes the stored model thinking from one conversation store folder (the Pi adapter's `removeStoredThinking`; card K06c). Given, the retention rule that removes stored thinking also cleans the stores this host keeps; absent, only the controller's copy is removed. */ readonly purge?: (dir: string) => Promise<{ readonly blocks: number }> };
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
  /**
   * Controlled network routes for tasks (card H12i). Given, the controller builds the network relay (the only way out of a task's sandbox besides the model relay) and the web tool, over the network grant service: `local.build` is handed
   * `network.forAttempt` (spread into the host's `network` option), and the handle carries the web tool as a built-in tool of the bridge. Nothing is reachable without a live grant (the default is none), and every connection is logged. `resolve` looks a name up
   * (once per connection; the connection goes to the checked address); `dial` and `tls` are for tests and private CAs; `secret` reads a secret by its name for a grant that states a credential header (the web tool only; the relay adds none).
   */
  readonly network?: {
    readonly resolve: NetworkRelayOptions["resolve"];
    readonly dial?: NetworkRelayOptions["dial"];
    readonly recheckMs?: number;
    readonly maxOpen?: number;
    readonly idleMs?: number;
    readonly connectTimeoutMs?: number;
    readonly maxLogged?: number;
    readonly tls?: WebFetchOptions["tls"];
    readonly secret?: WebFetchOptions["secret"];
    /** Told of a failure that is not a refusal (a connection record that could not be completed). */
    readonly onError?: (message: string) => void;
  };
  /** Remote MCP servers (cards T03, H12g): the name resolver the host uses. Given, the handle carries the MCP service and the connector that reaches an approved server only at a checked public address. */
  readonly mcp?: {
    readonly resolve: NameResolver;
    /** Refuses while the controller is paused or stopping (the lifecycle gate); default: never refuses. */
    readonly gate?: () => Promise<void>;
    /** The MCP transport's settings (card H12k): time and size bounds, a private CA, the server's credential header. The socket always goes to the checked address. */
    readonly transport?: McpHttpOptions;
  };
}

export interface DispatchHandle {
  readonly dispatcher: DispatcherService;
  /** The dispatcher's own service principal: the staff identity the lifecycle (Suspend, Stop) acts through (card L02). */
  readonly principal: Principal;
  readonly driver: DispatchDriver;
  /** The generation service (card L05): the tool bridge asks it whether a call belongs to a complete, current generation (card L05c). */
  readonly generation: GenerationService;
  /** Makes an agent's attempts quiet around an integration, landing, refresh, release or quarantine of its work (card H12d). */
  readonly quiesce: QuiesceCoordinator;
  /** Shuts down the local worker host the operator built, if it gave a way to. */
  readonly closeWorkers: () => Promise<void>;
  /** Card W13: the read-only memory tool the tool bridge answers `task.recall` with (the records of the attempt's own task; the owner's switch and call cap). */
  readonly recall: RecallService;
  /** The remote-worker service when `remote` was given: the owner's moves of attempts and stores, and the placement records (card H02c proves them through the composed controller). */
  readonly remote?: RemoteWorkerService;
  /** The owner's "move the work off this host" and the quiet-host pass, when remote hosts and `quietHosts` were given. */
  readonly quietHosts?: Pick<QuietHostService, "moveWork" | "episodes">;
  /** Where remote workers connect (present when `remote` was given). */
  readonly workerUrl?: string;
  /** The host an agent's live attempt runs on, if it has one (the review service judges a reviewer's host with it, card H05b). */
  readonly hostOfAgent: (agentId: string) => Promise<string | undefined>;
  /** One page of the rest of a tool result that was cut to the window (card C07d), for someone who may work on the task; otherwise it reads like a missing spill. */
  readonly readSpill: (by: Principal, spillId: string, index: number, size?: number) => Promise<{ text: string; next?: number } | undefined>;
  /** The full text of an item cut when a task moved to a smaller route (card C07f), for someone who may work on the task. */
  readonly readRouteArchive: (by: Principal, taskId: string, digest: string) => Promise<{ itemId: string; text: string; digest: string } | undefined>;
  /** The whole text of a note that was cut to fit, by the digest its marker names (card C07p), for someone who may work on the task. */
  readonly readNoteArchive: (by: Principal, taskId: string, digest: string) => Promise<{ taskId: string; attemptId?: string; what: string; digest: string; text: string } | undefined>;
  /** One hand-off note of a task, by the ID its next attempt's first call names (card C07m), for someone who may work on the task. */
  readonly readHandoffNote: (by: Principal, noteId: string) => Promise<{ id: string; taskId: string; attemptId: string; source: "attempt" | "controller"; endedBecause: string; text: string } | undefined>;
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
  /** What an attempt's freeze says and lifting it, for the workspace service's recovery (card H12l), telling a running agent something and stopping an attempt (card H12m). */
  readonly attemptControl: { live(taskId: string): Promise<string[]>; frozenReason(attemptId: string): Promise<string | undefined>; release(attemptId: string): Promise<void>; tell(attemptId: string, text: string): Promise<boolean>; stop(attemptId: string, reason: string): Promise<void> };
  /** The MCP service and the only way the host reaches a remote server (cards T03, H12g): the connector, and the client that speaks MCP over it to the checked address (card H12k); present when `mcp` was given. */
  readonly mcp?: { readonly service: McpService; readonly connector: RemoteMcpConnector; readonly client: RemoteMcpClient };
  /** The network relay and the web tool (card H12i), present when `network` and the grant service were given. The tool is a built-in of the bridge (`ToolExecutionDeps.builtins`). */
  readonly network?: { readonly relay: NetworkRelay; readonly webTool: BuiltinTool };
}

export interface ComposeInput {
  /** Called once everything is built and nothing is running yet, right before the driver starts (card F04e notes the first-start counters here). */
  readonly beforeLoops?: () => Promise<void>;
  /** Told once per window when the owner's aggregate spending cap refuses a reservation or stops paid calls (the same function the API's own budget service uses). */
  readonly notifyAggregate?: NotifyAggregate;
  /** Whether an agent can be reached apart from its pause gates (the controller's `availability` option): `suspended` and `stopped` agents are withheld from meetings, the same as in the API's own instance. */
  readonly availability?: (principalId: string) => Promise<Availability>;
  /** Brings an agent the host reports stopped or suspended up for one meeting, after the owner authorized it (card M04f). Absent: the owner's authorization is refused ("no wake path"). */
  readonly meetingWake?: WakeSink;
  /** Card M04h: the controller's own wake host, when it is the one in use: its loop brings woken agents into their rooms through the attendance service, and the owner sees and stops its wakes through the same service. */
  readonly wakeHost?: MeetingWakeHost;
  /** Card M04h: what the composed meeting wake host says about an agent a pause holds (the same function the controller's own pause service uses); the dispatcher's pause service answers the attendance the same way. */
  readonly pausedAvailability?: (principalId: string, options?: { readonly meetingWake?: boolean }) => Promise<Availability | undefined>;
  /** Whether a task's work is a safe long-running operation during a meeting (card M04g, asked only for a running attempt). `options.dispatcher.safeLongRunning` replaces it. */
  readonly safeLongRunning?: (taskId: string, attemptId: string) => Promise<boolean>;
  /** Card W11: the jobs of a task an attempt that ends its turn can wait for (the job service's `waitable`). With it the attempt parks for them and their ends wake the task; whether the task is stopped is read from `stops`. */
  readonly jobWaits?: (taskId: string) => Promise<readonly string[]>;
  /** Card W10: the second agent that questions a done before it is recorded succeeded (the controller's routed, metered client). Absent: no done is questioned, and each report says so. */
  readonly interrogator?: ReportInterrogatorPort;
  /** Release-test jobs carried to the hosts the owner authorized (card X09b). */
  readonly release?: Pick<ReleaseService, "jobsFor" | "pickUp" | "reportFromHost" | "expire">;
  readonly storage: ControllerStorage; readonly epoch: number; readonly options: DispatchStartOptions;
  /**
   * The controller's tool execution service (card T06b), reached late: it is built over the dispatcher, after this function returns, so these are called only once it exists. `handle` answers the local host's bridge requests, `replaySafe`
   * is the dispatcher's answer to whether a catalogue call may be run again from the start after a restart (the approved manifest's `recovery`, never the worker's word).
   */
  readonly toolBridge?: { readonly handle: (token: string, gateway: BoundGateway, request: BridgeRequest) => Promise<BridgeResponse>; readonly replaySafe: ToolExecutionService["replaySafe"] };
  /** The network grant service (card H12i); with `options.network` the relay and the web tool are built over it. */ readonly networkGrants?: NetworkGrantService; readonly principals: PrincipalService; readonly grants: GrantService; readonly taskCredentials: TaskCredentialService; readonly projects: ProjectService; readonly assignments: AssignmentService; readonly waits: WaitService;
  readonly contracts: ContractService; readonly catalog: HarnessCatalog; readonly routing: RoutingService; readonly inquiries: InquiryService; readonly agents: AgentService; readonly histories: HistoryService; readonly reviews: ReviewService;
  readonly retrieval: RetrievalService;
  /** The workspace operations service; the tick resolves the ones a stopped controller left unfinished (card H12l). */
  readonly workspaceOps?: Pick<WorkspaceOpService, "recover" | "isBusy">;
  /**
   * Hands the workspace service the way to a task's host port (card H12m). The port is not on the handle this function returns: it can be reached only through the function given here, which the workspace service holds
   * (an operation is then recorded, run behind the quiesce and answered as a typed outcome). The host is the one that runs the task's live attempt (or the one it is pinned to); with no live attempt, the host of the task's
   * last placement; a live attempt that is waiting with no host pinned names none and nothing is guessed. Only a task never placed anywhere falls back to the one host that has a workspace port, if there is exactly one.
   */
  /** The controller's reading of a call's target version (card A05b follow-up, `createTargetVersions`); handed to the dispatcher as `targetVersion`. Absent: calls are bound by name only. */
  readonly targetVersion?: DispatcherDeps["targetVersion"];
  readonly bindWorkspacePort?: (portOf: (taskId: string) => Promise<WorkspacePort | undefined>) => void;
  /** Suspensions and stops the controller was carrying out are carried on each tick, and at start-up by the first one (card L02b). */
  readonly stops?: Pick<StopService, "sweep" | "holding">;
  /** Meeting records are swept for votes past their time and records nobody finished (card M02c). */
  readonly records?: Pick<MeetingRecordService, "sweep">;
  /** Responsibility checks are recorded when due and incidents past their escalation time are escalated (card P04). */
  readonly responsibilities?: { readonly checks: Pick<ResponsibilityChecks, "generate">; readonly incidents: Pick<IncidentService, "escalate" | "untold" | "markNotified">; readonly notify?: (escalated: { id: string; projectId: string; escalatedTo?: string; signature: string; responsibilityId: string; count: number }) => Promise<void>; readonly coverage?: { readonly service: Pick<CoverageService, "sweep" | "markTold">; readonly notify: (notice: CoverageNoticeLike) => Promise<void> } };
  /** Retention (card K06): once a tick the quota and reserve warnings, the reserve made again when room was made, and the runner when the owner turned it on. */
  readonly retention?: { readonly sweep: (by: Principal) => Promise<unknown>; readonly restoreReserve?: () => Promise<unknown> };
  /** The nightly backup is started by the tick when the newest one is older than a day (card K01). */
  readonly backups?: Pick<BackupService, "runScheduled">;
  /** External event sources polled each tick (card H13d). None are built in. A function is read at every tick (card H13f: the owner's defined sources count without a restart). */
  readonly eventSources?: readonly EventSource[] | (() => Promise<readonly EventSource[]>);
  /** The limits for the next local agent: the start-up figures with the owner's setting over them (card H12k). Throws when unreadable. */
  readonly workerLimits?: () => Promise<LocalWorkerLimits | undefined>;
  /** The landing policy of a task from the settings (card H12s), handed to the local host builder. */
  readonly landingPolicy?: (call: { readonly taskId: string; readonly projectId: string }) => Promise<LandingPolicyFigures>;
  /** The owner's best-effort switch and the place launches are recorded (card H12k). */
  readonly workerPolicy?: { readonly bestEffortAllowed: () => Promise<boolean>; readonly recordLaunch: (record: LaunchRecord) => Promise<void> };
  /** The agents' environments (card A08): each attempt pins its agent's active revision, and the revision's limits, cut by the installation's, are the limits of the launch (card A08d). */
  readonly environments?: Pick<EnvironmentService, "pin" | "resume">;
  /** The owner's dispatcher limits (attempt time, attempts), read on every claim and re-admission; absent: the start-up options. */
  readonly dispatchLimits?: () => Promise<DispatcherLimitFigures>;
  /** The configured `time.maxMinutes` of a task, for the claim; absent: not applied. */
  readonly taskMinutes?: (taskId: string) => Promise<number | undefined>;
  /** The sources the owner turned off, read at every tick (card H13f). */
  readonly eventSourcesOff?: () => Promise<ReadonlySet<string>>;
  /** Health probes of failed-over routes (card R04c): off unless given, and then only while `enabled()` says so. */
  readonly probes?: { readonly cutover: Pick<CutoverService, "downTargets" | "probe">; readonly probes: RouteProbes };
  /**
   * Provider drain and cutover (card R04c): the dispatcher's model calls go through `fallback` (with the default route resolver; an operator's own resolver keeps choosing routes by itself), a cutover cancels the running
   * generation and runtime of the attempts it cut, and every tick carries out what the controls leave due (an expired drain becomes a cutover; a cancellation a crash left is done again).
   */
  readonly routes?: { readonly cutover: CutoverService; readonly fallback: FallbackService };
  /** Where the checkpoints workers hand the dispatcher are captured as continuations (card L04d); absent: none are. */
  readonly continuations?: Pick<ContinuationService, "capture" | "latest">;
  /** The checked resume the dispatcher calls when an attempt brings earlier work back (card L04c). */
  readonly resumes?: Pick<ResumeCheckService, "start" | "commit" | "advance" | "retry" | "cancel" | "forTask" | "checkIdFor" | "retryable" | "exhausted" | "cancelledAsStale" | "get"> & Partial<Pick<ResumeCheckService, "hasContinuation">>;
  /**
   * The hand-offs the controller keeps (card C07m): a new attempt's first prompt names the hand-off its task came with, so its agent knows where the package is kept. Absent: the call says nothing about it.
   */
  readonly handoffs?: Pick<HandoffService, "latestForTask">;
  /** Told when the approval policy denies an agent's tool call, once the refusal is on record (card U11c). */
  /** Where the local worker's security hook and a remote host's own report go (`UrgentWatch.reportSecurityFrom`); with the principal that reports. Absent: such reports are dropped. */
  readonly securityReport?: (by: Principal, event: { readonly kind: string; readonly key: string; readonly projectId?: string }) => Promise<{ readonly itemId: string; readonly held: boolean }>;
  /** The controller's security detectors (card U11d); absent: detectors do nothing. */
  readonly detect?: (source: string, event: { readonly kind: SecurityEvent; readonly key: string; readonly projectId?: string; readonly subject?: string }) => void;
  readonly onDenied?: (denial: { readonly attemptId?: string; readonly callId?: string; readonly agentId: string; readonly projectId: string }) => Promise<unknown>;
  /** Unfinished hand-offs and checked resumes are carried on the same way (cards L03c, L04c). */
  readonly sweeps?: readonly { readonly name: string; readonly sweep: (by: Principal) => Promise<unknown>; /** Runs apart from the dispatcher's tick (it makes model calls): the tick waits for it only briefly (card L04d follow-up). */ readonly apart?: boolean }[];
  /** The stall detection and the reconciler the controller built; the dispatcher's tick runs them (card L01b). */
  /** The owner's switches for recording the model stream and holding back a late reply (card L05b); absent: both on. */
  readonly streamSettings?: Pick<StreamSettingsService, "effective">;
  /** The owner's settings for the route-change check (card C07f): whether it runs, and the floor counted for an unmeasured route. */
  readonly contextRouteSettings?: Pick<ContextRouteSettingsService, "effective">;
  readonly recovery?: { readonly stall: Pick<StallService, "scan"> & Partial<Pick<StallService, "reportFromRelay" | "holdWithOwner">>; readonly reconciler: { runPass(): Promise<unknown> } };
  /** The owner's quiet-host figures (grace hours, automatic moves): given, the dispatcher's tick warns the owner about a host that stopped reporting and re-places its work as the figures say (needs remote hosts). */
  readonly quietHosts?: { readonly settings: Pick<QuietHostSettingsService, "effective">; /** The pass's own timing (tests, operators): see `QuietHostOptions`. */ readonly options?: Pick<QuietHostOptions, "quietAfterMs" | "maxGapMs"> };
  readonly onError?: (error: unknown) => void;
  /** True while the maintenance barrier is up (card K01h): the driver skips its ticks. */
  readonly hold?: () => boolean;
  /** Whether a restore left an attempt's conversation store for a remote host and it waits for delivery (card K01i review): the host is not offered the attempt meanwhile. */
  readonly restoreWaits?: (hostId: string, attemptId: string) => Promise<boolean>;
  /** One installation-level setting, for the controller's own reading (`ConfigurationService.installationSettings`: each value with whether the owner set it): the stand-up's balance review reads the P/PC allocation (`workClass.pcFloor`, `pcTarget`, `pcCeiling`) through it (card M03g). Absent: the review says no allocation is set. */
  readonly installationSettings?: (keys: readonly string[]) => Promise<Readonly<Record<string, { value: unknown; set: boolean }>>>;
  /** The `meeting.leadMinutes` setting (card M01d), already defaulted by the caller: how long before a meeting its occurrence is made and its agents are invited and kept free. */
  readonly leadMinutes?: () => Promise<number | undefined>;
}

/**
 * Builds the dispatcher on the controller's epoch and every loop the services said "the controller's loop must call" (cards H12, H12c): messages (U12 `settleDue`, `release`), attendance (M04
 * `sweepReturns`), stand-ups (M03 `prepare`, `deliverOutcomes`), event subscriptions (H06b `expireIdle`) and decisions (C08 `resume`), and the driver that ticks them. The dispatcher acts as
 * `service:dispatcher`, provisioned here with a credential that lives only in this process. The services built here share the controller's epoch, so a controller that was deposed writes nothing.
 */
/**
 * What the controller's wake host may do for a woken agent (card M04h), all through services that make their own checks: the attendance service prepares it, joins it (the bounded meeting task and the permission that lets only that task past the stop)
 * and ends the wake; the assignment service admits one attempt on that task, the same admission the dispatcher uses to read again, which the dispatcher then claims through its ordinary checks (pause, meeting, route, budget, grant, host, lease).
 */
export function wakeAttender(attendance: AttendanceService, assignments: Pick<AssignmentService, "getAssignment" | "admitAttempt">, harnessOf: (taskId: string) => Promise<string | undefined>, dispatcher: () => Pick<DispatcherService, "stop" | "liveAttemptsOf"> | undefined): WakeAttender {
  return {
    prepare: (by, command) => attendance.prepare(by, command),
    join: (by, command) => attendance.join(by, command),
    endWake: (by, occurrenceId, agent) => attendance.endWake(by, occurrenceId, agent),
    seat: (by, occurrenceId, agent) => attendance.seatOf(by, occurrenceId, agent),
    endAttempt: async (by, taskId, reason) => {
      // The task is done by now (the agent left), so the live attempts are asked of the dispatcher, not read off the assignment.
      const d = dispatcher();
      if (d === undefined) return;
      for (const attemptId of await d.liveAttemptsOf(by, { taskId })) {
        try { await d.stop(by, attemptId, { reason }); } catch (error) {
          // An attempt that already ended is what was wanted.
          if (!(error instanceof DomainError) || error.code !== "not_found") throw error;
        }
      }
    },
    admit: async (by, request) => {
      const agentId = /^agent:(agt-[a-z2-7]{20})$/.exec(request.agent)?.[1];
      for (let tries = 0; tries < 3; tries++) {
        const a = await assignments.getAssignment(request.taskId);
        if (agentId === undefined || a === undefined || a.state !== "assigned" || a.owner?.kind !== "agent" || a.owner.id !== agentId) throw new DomainError("unavailable", "the meeting task is not assigned to that agent");
        if (a.activeAttemptId !== undefined) return;
        // The harness is the one the owner's routing names for the task, as the dispatcher will find again at the claim; none named leaves the attempt gate to say so.
        const harness = await harnessOf(request.taskId);
        try {
          await assignments.admitAttempt({ commandId: request.commandId, actor: by.id, taskId: request.taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agentId }, ...(harness === undefined ? {} : { harness }) });
          return;
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== "stale_revision") throw error;
        }
      }
      throw new DomainError("unavailable", "the meeting task's assignment kept changing");
    },
  };
}

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
  // Who receives a child task's report (the owner of the task that spawned it), for the owner's optional fan-in cap (card H10b). A task that was not spawned reports to no one.
  const links = new CommandRunner(storage, epoch, ro);
  const reportsToOf = async (taskId: string): Promise<string | undefined> => {
    const link = (await links.get("swarm-link", taskId))?.body as unknown as { parentTaskId?: string } | undefined;
    if (link?.parentTaskId === undefined) return undefined;
    const parent = await i.assignments.getAssignment(link.parentTaskId);
    return parent?.state === "assigned" ? parent.owner?.id : undefined;
  };
  const hosts = HostService.withEpoch(storage, epoch, i.assignments, ro);
  const effects = EffectService.withEpoch(storage, epoch, i.assignments, { ...ro, holder: "dispatcher" });
  const blockers = BlockerService.withEpoch(storage, epoch, ro);
  const policy = PolicyService.withEpoch(storage, epoch, i.grants, { ...ro, roles: (id) => i.agents.rolesOfPrincipal(id) });
  const branchSettings = ProtectedBranchService.withEpoch(storage, epoch, ro);
  const budgets = BudgetService.withEpoch(storage, epoch, { ...ro, ...(i.notifyAggregate === undefined ? {} : { notifyAggregate: i.notifyAggregate }) });
  const pauses = PauseService.withEpoch(storage, epoch, { waits: i.waits }, { ...ro, ...(i.availability === undefined ? {} : { otherAvailability: i.availability }), ...(i.pausedAvailability === undefined ? {} : { pausedAvailability: i.pausedAvailability }) });
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
    // The other routes the configuration allows, in order, so the owner's routing controls can send new work past a closed one (card R04c).
    const alternatives = d.candidates.filter((c) => c.eligible && c.route !== d.route).map((c) => c.route);
    return d.outcome === "chosen" ? { route: d.route!, ...(d.profile?.harness === undefined ? {} : { harness: d.profile.harness }), role: d.role, request: d.request, routing: d.routingRevision ?? 0, profiles: d.profilesRevision, ...(alternatives.length === 0 ? {} : { alternatives }) } : { none: true, reasons: d.reasons };
  });
  // The model calls of attempts through the fallback service (card R04c), with the default resolver only (see `routes`).
  const modelCalls = i.routes === undefined || i.options.route !== undefined ? undefined : routeCallsOf(i.routes.fallback, i.routes.cutover, principal);
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
    ...(i.onError === undefined ? {} : { onChargeError: i.onError }), ...(i.leadMinutes === undefined ? {} : { leadMinutes: i.leadMinutes }) }, { ...ro, availability: pauses.availability, notices: meetingNoticeSink(messages), window: meetingWindowSink(messages), carriesOn: async (taskId) => (await live.dispatcher?.carriesOnTask(principal, taskId)) === true, ...(i.meetingWake === undefined ? {} : { wake: i.meetingWake }), ...(i.wakeHost === undefined ? {} : { wakeControl: i.wakeHost }) });
  const watches = WatchService.withEpoch(storage, epoch, { events, inbox: InboxService.withEpoch(storage, epoch, i.assignments), assignments: i.assignments, projects: i.projects }, ro);
  const followUps = chatTurnFollowUps(storage, epoch, ro);
  const improvements = ImprovementService.withEpoch(storage, epoch, { meetings }, { ...ro, outcomes: improvementOutcomeSink(messages) });
  // The one owner-level read the stand-up preparation needs: the inbox, nothing else; the elevated principal does not leave this closure.
  const ownerInboxFor = needsOwnerFrom({ inbox: () => notifications.inbox(recovering(principal)) }, principal);
  const ownerNoticesFor = noticesFrom({ inbox: () => notifications.inbox(recovering(principal)) }, principal);
  const standups = StandupService.withEpoch(storage, epoch, { meetings, assignments: i.assignments }, { ...ro, availability: pauses.availability, notices: preparationNoticeSink(messages), onBriefed: (by, item, revision) => improvements.markTold(by, item, revision), waitingMessages: (by, agent) => messages.waitingAtStandup(by, agent), ownerItems: ownerInboxFor, ownerNotices: ownerNoticesFor, ...(i.installationSettings === undefined ? {} : { allocation: allocationFromValue(i.installationSettings) }), ownerQuestions: ownerQuestionSink({ notify: (n) => notifications.emitFromController({ commandId: n.commandId, kind: "maintenance", level: "needs-you", ref: { kind: "owner-question", id: n.questionId }, projectId: n.projectId, detail: n.detail }), followUp: (turnId, f) => followUps.add(turnId, f) }), onOwnerAnswered: (q) => notifications.settleFromController({ commandId: `oqn-done:${q.questionId}`, kind: "maintenance", ref: { kind: "owner-question", id: q.questionId }, projectId: q.projectId }), outcomes: agendaOutcomeSink({ followUp: (turnId, f) => followUps.add(turnId, f), inquiry: async (id) => { const q = (await storage.getAggregate({ kind: "inquiry", id }))?.body as unknown as { asker?: string; taskId?: string } | undefined; return q?.asker === undefined || q.taskId === undefined ? undefined : { asker: q.asker, taskId: q.taskId }; }, messages }) });
  const projects = (): Promise<string[]> => projectIds(i.projects);
  let stallNotices = 0;
  const quiet: { service?: QuietHostService } = {};
  const loops: DispatcherLoop[] = [
    { name: "hosts.quiet", run: async (by) => { await quiet.service?.sweep(by); } },
    { name: "charge-retry", run: (by) => chargeRetry.sweep(by) },
    ...(i.release === undefined ? [] : [{ name: "release.expire", run: async () => { await i.release!.expire(); } }]),
    ...(i.stops === undefined ? [] : [{ name: "stops.sweep", run: async (by: Principal) => { await i.stops!.sweep(recovering(by)); } }]), ...(i.sweeps ?? []).map((s) => ({ name: s.name, ...(s.apart === true ? { apart: true as const } : {}), run: async (by: Principal) => { await s.sweep(recovering(by)); } })), ...messageLoops(messages, () => activeAgents(storage)), ...(i.workspaceOps === undefined ? [] : workspaceLoops(i.workspaceOps)), ...budgetNoticeLoops(budgets, (n) => { const { purpose, text } = holderNotice(n); return messages.noticeFromController({ commandId: `bgt-hold-${n.requestId}`, taskId: n.parentTaskId ?? n.taskId, to: n.to, purpose, text, admit: "budget.manage" }); }), ...attendanceLoops(attendance), ...(i.wakeHost === undefined ? [] : wakeAttendLoops(i.wakeHost, wakeAttender(attendance, i.assignments, async (taskId) => { const c = await route({ commandId: `mwl-route:${taskId}`, taskId }); return "none" in c ? undefined : c.harness; }, () => live.dispatcher))), ...meetingLoops(meetings, projects), ...standupLoops(standups, meetings, projects), ...eventLoops(events), ...watchLoops(watches),
    // The event is already in the agent's inbox; waking it is making sure an attempt is there to read it: one running will at its next boundary, one waiting for a place will when it starts (card H13c).
    ...wakeLoops(watches, attemptWaker(() => live.dispatcher, principal)), ...(i.records === undefined ? [] : recordLoops({ sweep: (by, command) => i.records!.sweep(recovering(by), command) }, projects)), ...(i.responsibilities === undefined ? [] : [...responsibilityLoops(i.responsibilities.checks, i.responsibilities.incidents, projects, i.responsibilities.notify), ...(i.responsibilities.coverage === undefined ? [] : coverageLoops(i.responsibilities.coverage.service, i.responsibilities.coverage.notify))]), ...(i.eventSources === undefined ? [] : sourceLoops(SourceService.withEpoch(storage, epoch, events, ro), i.eventSources, i.eventSourcesOff, { tell: (n) => notifications.emitFromController({ commandId: n.id, kind: "maintenance", ref: { kind: "principal", id: "dispatcher" }, detail: n.text }), log: (m) => i.onError?.(new Error(m)) })), ...(i.probes === undefined ? [] : probeLoops(i.probes.cutover, i.probes.probes)), ...(i.routes === undefined ? [] : [{ name: "routes.tick", run: async (by: Principal) => { await i.routes!.cutover.tick(by); } }]), ...(i.retention === undefined ? [] : [{ name: "retention.sweep", run: async (by: Principal) => { await i.retention!.restoreReserve?.(); await i.retention!.sweep(by); } }]), ...(i.backups === undefined ? [] : [{ name: "backups.nightly", run: async () => { void i.backups!.runScheduled().catch(() => undefined); /* started, not awaited: a long copy never holds up the other loops; a failure is kept in the backup status */ } }]), ...improvementOutcomeLoops(improvements, projects), ...untoldImprovementLoops(improvements, projects, (n) => notifications.emitFromController({ commandId: n.key, kind: "maintenance", level: "notice", ref: { kind: "improvement-item", id: n.itemId }, detail: n.text, projectId: n.projectId })), ...reviewLoops(i.reviews, projects), ...decisionLoops(decisions, projects),
    // A pause the owner gave a time to is lifted when the time comes, and only that scope (card L06b).
    { name: "lifecycle.resume-conditions", run: async (by) => { await pauses.liftDue(by); } },
    // A standing grant that lapsed from non-use is told to the owner once, in plain words (card A07h).
    ...grantLapseLoops(i.grants, (n) => notifications.emitFromController({ commandId: n.key, kind: "maintenance", level: "notice", label: "A standing grant lapsed from non-use", ref: { kind: "grant-record", id: n.grantId }, detail: n.text, ...(n.projectId === undefined ? {} : { projectId: n.projectId }) })),
    ...(i.recovery === undefined ? [] : recoveryLoops(i.recovery.stall, i.recovery.reconciler, () => notifications.emitFromController({ commandId: `stall-off:${epoch}:${++stallNotices}`, kind: "maintenance", level: "needs-you", ref: { kind: "principal", id: "dispatcher" }, detail: "Stall detection is not running: the dispatcher does not hold the recovery.stall-scan right. Grant it that right to turn stall detection on." }), () => i.principals.authenticate(issued.token), async (c) => {
      // Each climb of the supervisor ladder is told once (owner decision 2026-10-30, supervisor ladder): the id carries the concern, the level and the time it climbed, which are stored, so a retried notice is the same one. A supervisor is told by a notice on the task; the owner, at the top, by a needs-you item.
      const key = createHash("sha256").update(`${c.id}|${c.escalatedAt ?? ""}|${c.escalationLevel ?? 0}`).digest("hex").slice(0, 32);
      // A concern a recovery step handed to the owner says so (and whether the controller's automatic steps did it), not that it waited too long for a supervisor (card V02c).
      const last = c.escalatedTo === "owner" ? c.recoverySteps?.at(-1) : undefined;
      const handed = last !== undefined && last.action === "hand-to-owner" && last.skipped !== true && last.at === c.escalatedAt ? last : undefined;
      const detail = (handed === undefined
        ? `A ${c.kind} concern on a task has waited too long for its supervisor to decide: ${c.detail}`
        : handed.auto === true ? `A ${c.kind} concern on a task was handed to you by the automatic recovery steps (${handed.by} did not answer in time): ${c.detail}` : `A ${c.kind} concern on a task was handed to you by ${handed.by}: ${c.detail}`).slice(0, 200);
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
  // The notification sweep may wait on a slow outside channel (bounded by its own time budget), so it runs after every other loop of the tick and cannot delay them (card U11b review).
  const lastLoop = loops.findIndex((l) => l.name === "notifications.run");
  if (lastLoop >= 0) loops.push(...loops.splice(lastLoop, 1));
  // The local worker host gets its guards here, bound to the services built above (card H12k); the dispatcher then has it among its workers.
  const workers: WorkerHost[] = [...(i.options.workers ?? [])];
  const holder: { dispatcher?: DispatcherService } = {};
  // An attempt with no time limit has no expiry to keep its per-attempt entries until: they are kept while the dispatcher still has the attempt unfinished, and dropped once it has ended (checked at most every ten minutes).
  const unlimited = (): { readonly forget: (map: Map<string, unknown>, now: number) => void } => {
    let checked = 0;
    return {
      forget: (map, now) => {
        if (now - checked < 600_000) return;
        checked = now;
        for (const [id, entry] of map) {
          if ((entry as { until: number }).until !== Infinity) continue;
          void holder.dispatcher?.get(principal, id).then((d) => { if (d === undefined || d.state === "finished") map.delete(id); }, () => undefined);
        }
      },
    };
  };
  // Context enforcement (card C07b): the worker host's first-call checks, and the dispatcher's overflow count and hand-off when an attempt ends.
  const context = ContextEnforcementService.withEpoch(storage, epoch, { blockers, retrieval: i.retrieval }, { ...ro, ...(i.contextRouteSettings === undefined ? {} : { routeSettings: i.contextRouteSettings }), ...(i.onError === undefined ? {} : { onError: i.onError }) });
  /**
   * Card C07n: the context window a route carries in the owner's routing table (its `contextTokens`). Asked when the host's own figure does not know the route, so a route missing from the host's map is still
   * checked against what the owner configured for it. A route neither says is refused by the guards (never admitted unchecked) with a blocker naming it.
   */
  const tableWindow = async (route: string): Promise<number | undefined> => {
    try { return usableWindow((await i.routing.get())?.routes[route]?.contextTokens); } catch (error) { i.onError?.(error); return undefined; }
  };
  /**
   * The window of an order's route: the local host's own figure when it is one, else the routing table's (card C07n). `undefined` when neither says. The same rule as the guards' `windowOf` (C07n second review): a host
   * figure that is no window (0, negative, fractional, NaN) asks the routing table, so the route-move rebuild and the first-call admission never judge one attempt against two different windows.
   */
  const windowOfRoute = async (order: WorkOrder): Promise<number | undefined> => {
    let own: number | undefined;
    try { own = usableWindow(i.options.local?.window(order)); } catch { own = undefined; }
    return own ?? await tableWindow(order.route);
  };
  /**
   * A task's context built again for the route an attempt moves to (cards C07f, C07g): the owner's decision record as startup items, cut to the route's window and measured fixed part. `undefined` when there is nothing to build
   * for (the owner turned the check off, or the route says no window); otherwise the context service's answer, with the view the first prompt carries.
   */
  const moveContext = async (c: { readonly taskId: string; readonly projectId: string; readonly attemptId: string; readonly route: string; readonly harness?: string }, promptChars: number): Promise<Awaited<ReturnType<ContextEnforcementService["routeMoved"]>> | undefined> => {
    // The owner can turn the check off (chat-settable; on by default): the attempt then starts as it did before.
    if (i.contextRouteSettings !== undefined && !(await i.contextRouteSettings.effective()).check) return undefined;
    // The window of the new route (the local host's, else the routing table's, card C07n); a route that says none has nothing to rebuild for (its first call is refused as unchecked).
    const window = await windowOfRoute({ route: c.route } as WorkOrder);
    if (window === undefined) return undefined;
    // Read as the controller: the dispatcher's own principal holds no project grants, and through `context` it would read nothing (the C07f hook was built on an empty record until card C07g).
    const record = await decisions.controllerContext({ projectId: c.projectId, taskId: c.taskId });
    const moved = await context.routeMoved(principal, { taskId: c.taskId, attemptId: c.attemptId, route: c.route, ...(c.harness === undefined ? {} : { harness: c.harness }), window, items: record === undefined ? [] : startupItems(record), promptChars });
    // A route nobody has measured is not refused on a guess: the owner is told (a notice, once per attempt and route), and the first call on it is checked with its real size.
    const unmeasuredId = createHash("sha256").update(`${c.attemptId}\0${c.route}`).digest("hex").slice(0, 24);
    if (moved.rebuilt && moved.warning !== undefined) await notifications.emitFromController({ commandId: `ctx-unmeasured:${unmeasuredId}`, kind: "maintenance", level: "notice", ref: { kind: "route-move", id: unmeasuredId }, detail: `Route ${c.route.slice(0, 80)} has not been measured yet: the move was built on an assumed prompt size, and its first call will be checked with its real size.`.slice(0, 200), projectId: c.projectId }).catch((error: unknown) => i.onError?.(error));
    return moved;
  };
  /**
   * Card C07i: the starting-size watch, given every first call the guards judge on the local host and on each remote host. An alert it opens reaches the owner once (the notification's command ID is the alert's; one whose telling failed is told at the task's next first call), and the task's
   * status shows it while it is open. A rising run is a Notice (nothing waits on the owner yet); a call past the owner's share of its limit is Needs you, since the next growth is refused. A failure is reported, never raised.
   */
  const startSizes = StartSizeService.withEpoch(storage, epoch, ro);
  const recordStartSize = startSizeRecorder(startSizes, principal, notifications, i.onError);
  const startSize = (worker: "local" | "remote") => ({ worker, record: recordStartSize });
  const remedies = "choose a route with a larger window, reduce the task contract, supersede decisions or reassign the task";
  // Remote MCP servers (cards T03, H12g, H12k): built before the local host so the host is given the same connector and client the handle carries.
  const mcpParts = (() => {
    const o = i.options.mcp;
    if (o === undefined) return undefined;
    const service = McpService.withEpoch(storage, epoch, { ...ro, ...(o.gate === undefined ? {} : { gate: o.gate }) });
    const connector = new RemoteMcpConnector({ mcp: service, resolve: o.resolve, principal });
    return { service, connector, client: new RemoteMcpClient(connector, o.transport ?? {}) };
  })();
  // The network relay and the web tool (card H12i): built before the local host so the host is given the relay bound to each attempt.
  const networkParts = (() => {
    const o = i.options.network;
    if (o === undefined || i.networkGrants === undefined) return undefined;
    const grants = i.networkGrants;
    const relay = new NetworkRelay({ grants, resolve: o.resolve, ...(o.dial === undefined ? {} : { dial: o.dial }), ...(o.recheckMs === undefined ? {} : { recheckMs: o.recheckMs }), ...(o.maxOpen === undefined ? {} : { maxOpen: o.maxOpen }), ...(o.idleMs === undefined ? {} : { idleMs: o.idleMs }), ...(o.connectTimeoutMs === undefined ? {} : { connectTimeoutMs: o.connectTimeoutMs }), ...(o.maxLogged === undefined ? {} : { maxLogged: o.maxLogged }), ...(o.onError === undefined ? {} : { onError: o.onError }) });
    const web = new WebFetch({ grants, resolve: o.resolve, ...(o.dial === undefined ? {} : { dial: o.dial }), ...(o.tls === undefined ? {} : { tls: o.tls }), ...(o.secret === undefined ? {} : { secret: o.secret }), ...(o.maxLogged === undefined ? {} : { maxLogged: o.maxLogged }) });
    const webTool: BuiltinTool = {
      name: WEB_FETCH_TOOL.name, version: WEB_FETCH_TOOL.version, purpose: WEB_FETCH_TOOL.purpose, input: WEB_FETCH_TOOL.input, output: WEB_FETCH_TOOL.output,
      run: async (call, input, signal) => ({ ...(await web.run({ taskId: call.taskId, projectId: call.projectId, attemptId: call.attemptId }, input, signal)) } as unknown as JsonObject),
    };
    return { relay, webTool };
  })();
  // What the relay tells stall detection about every model call of an attempt (card V01b): reports are sent one after another so they arrive in order, and a failure of the report never reaches the call.
  const reporter = i.recovery?.stall.reportFromRelay?.bind(i.recovery.stall);
  const monitorOf = reporter === undefined ? undefined : (order: WorkOrder & { readonly hostId?: string }): RelayMonitor => relayMonitor(order, reporter, (error) => i.onError?.(error));
  // The store that keeps the thinking of the task's current attempt, for a local host's process (card U09b) and a remote host's (card U09c): one store, one set of bounds and cleaning.
  const thinkingStore = ThinkingStore.withEpoch(storage, epoch, ro);
  // The host's launch report goes to the owner's launch record (with what the dispatcher gave the launch and whose each figure was, card A08d) and onto the attempt's own record. The attempt's note is best effort: a note that
  // cannot be written never undoes a launch the host has made.
  const recordLaunch = async (record: LaunchRecord): Promise<void> => {
    let given: Awaited<ReturnType<DispatcherService["launchLimitsOf"]>>;
    try { given = await holder.dispatcher?.launchLimitsOf(record.attemptId); } catch (error) { i.onError?.(error); }
    await i.workerPolicy?.recordLaunch(given === undefined ? record : { ...record, environment: { ...(given.environmentRevision === undefined ? {} : { revision: given.environmentRevision }), sources: given.sources, ...(given.capped === undefined ? {} : { capped: given.capped }) } });
    try { await holder.dispatcher?.noteLaunch({ attemptId: record.attemptId, outcome: record.outcome, requested: record.requested, bestEffort: record.bestEffort, enforcement: record.enforcement, ...(record.reason === undefined ? {} : { reason: record.reason }) }); } catch (error) { i.onError?.(error); }
  };
  if (i.options.local !== undefined) {
    const limits = checkLocalWorkerLimits(i.options.local.limits);
    const guards = controllerGuards({
      context, pause: pauses, messages, system: principal,
      agent: (order) => i.taskCredentials.authenticate(order.credential),
      assignee: (order) => i.taskCredentials.agentOf(principal, order.attemptId),
      window: i.options.local.window,
      // Card C07n: a route the host's figure does not know is checked against the routing table's `contextTokens` for it; a route neither says is refused with a blocker, never admitted unchecked.
      // A routing table that cannot be read is not a route without a window (C07n review): the error reaches the guards, so the call is refused as unchecked without a blocker telling the owner to set a figure
      // that is already set, and a stored conversation starts fresh.
      routeWindow: async (order) => (await i.routing.get())?.routes[order.route]?.contextTokens,
      // And a stored conversation is judged whatever the embedder passed: a checkpoint of the worker package's shape says its size, and one that says nothing is not resumed.
      storedTokens: i.options.local.storedTokens ?? checkpointStoredTokens,
      startSize: startSize("local"),
      // Card C07g: the worker's process is up and says what it sends besides the prompt; the route is measured with that, and the view built again on the measured figure before the first call.
      rebuildView: async (order, fixed, launch, promptChars) => {
        await context.measureRoute(principal, { taskId: order.taskId, attemptId: order.attemptId, launch, route: order.route, ...(order.harness === undefined ? {} : { harness: order.harness }), systemPromptChars: fixed.systemPromptChars, toolSchemaChars: fixed.toolSchemaChars });
        // The rest of the prompt is known exactly now.
        const moved = await moveContext(order, promptChars);
        if (moved === undefined) return undefined;
        return moved.rebuilt ? { text: moved.view } : { refused: `${moved.reason ?? "the context does not fit the route"} (${remedies})` };
      },
    });
    let cache: { forOrder(order: WorkOrder): Promise<AttemptCache> } | undefined;
    if (i.options.cache !== undefined) {
      const o = i.options.cache;
      // The adapter's endpoint state is the controller's own (card H12e): when the operator gives none, one is kept for the controller's life, so a slotted server is never put in the no-reuse mode merely because it was not passed.
      const policies = new CachePolicies({ ...o, state: o.state ?? new CacheEndpoints(), principal, markers: MarkerService.withEpoch(storage, epoch, ro), ...(i.onError === undefined ? {} : { onError: i.onError }) });
      // One policy per attempt: its slot, its pin bookkeeping and its figures belong to the attempt, so the relay and the host must share it. An entry is kept until the attempt's own expiry (it cannot run past it) and dropped then, never earlier.
      const made = new Map<string, { readonly cache: Promise<AttemptCache>; readonly until: number }>();
      const forgetEnded = unlimited();
      const now = i.options.clock === undefined ? Date.now : (): number => Date.parse(i.options.clock!());
      cache = {
        forOrder: (order) => {
          for (const [id, entry] of made) if (entry.until < now()) made.delete(id);
          forgetEnded.forget(made, now());
          let found = made.get(order.attemptId);
          if (found === undefined) {
            const pin = o.pinMarker?.(order);
            const cache = policies.forAttempt({ projectId: order.projectId, route: order.route }, pin === undefined ? {} : { pinMarker: pin });
            found = { cache, until: order.expiresAt === undefined ? Infinity : Date.parse(order.expiresAt) + 60_000 };
            made.set(order.attemptId, found);
            cache.catch(() => made.delete(order.attemptId));
          }
          return found.cache;
        },
      };
    }
    const windowOf = i.options.local.window;
    const contextFor = async (order: WorkOrder): Promise<WorkerContextLimits | undefined> => {
      const window = windowOf(order);
      if (window === undefined) return undefined;
      const budget = context.budget(window);
      // The process compacts its conversation itself (card C07q): it is given the owner's decisions for the task, read as the controller (as the route view reads them), to keep through every compaction.
      let keep: ReturnType<typeof compactionKeep>;
      try { const record = await decisions.controllerContext({ projectId: order.projectId, taskId: order.taskId }); keep = record === undefined ? undefined : compactionKeep(record); } catch (error) { i.onError?.(error); keep = undefined; }
      // Card W12: the anchor at the top of the order's content that the order's contract names by digest (the task's own text may hold a block of its own; it is not the controller's and is never taken).
      const named = order.contract?.anchorDigest;
      const anchor = named === undefined ? undefined : findAnchors(order.content).find((a) => a.digest === named);
      return { toolOutputBytes: Math.min(Math.floor(budget.toolOutputChars), 10_000_000), compaction: { fallback: "extractive", ...(keep === undefined ? {} : { keep }), ...(anchor === undefined ? {} : { anchor: { text: anchor.text } }) } };
    };
    // The task's own process compacted its conversation (card C07q): the compaction takes its place in the task's chain, so the lineage a continuation capture lists is the real one. A failure is reported and changes nothing for the attempt.
    const recordCompaction = async (order: WorkOrder, note: { readonly messageCount: number; readonly summaryChars: number; readonly digest: string }): Promise<void> => {
      try {
        // Only the task's current attempt adds to its chain: a process whose attempt was superseded, released or ended (its lease lost, the task reassigned) may still be running for a moment, and its compaction is not the task's (C07q review).
        const [assignment, attempt] = await Promise.all([i.assignments.getAssignment(order.taskId), i.assignments.getAttempt(order.attemptId)]);
        if (assignment === undefined || attempt === undefined || assignment.state !== "assigned" || assignment.activeAttemptId !== order.attemptId || assignment.generation !== order.generation || attempt.state !== "active") return;
        await context.recordProcessCompaction(principal, { taskId: order.taskId, attemptId: order.attemptId, key: `pc-${createHash("sha256").update(`${order.attemptId}\0${note.digest}`).digest("hex").slice(0, 40)}`, ...note }); } catch (error) { i.onError?.(error); }
    };
    // The thinking the task's own process reported (card U09b): kept for the owner (bounded, cleaned, redacted, switchable), only for the task's current attempt, and only up to the process's own message bounds. A failure is reported and changes nothing for the attempt.
    const recordThinking = async (order: WorkOrder, blocks: readonly ReportedThinking[]): Promise<void> => {
      try {
        const [assignment, attempt] = await Promise.all([i.assignments.getAssignment(order.taskId), i.assignments.getAttempt(order.attemptId)]);
        if (assignment === undefined || attempt === undefined || assignment.state !== "assigned" || assignment.activeAttemptId !== order.attemptId || assignment.generation !== order.generation || attempt.state !== "active") return;
        await thinkingStore.record(principal, { projectId: order.projectId, taskId: order.taskId, agent: order.agentId.startsWith("agent:") ? order.agentId : `agent:${order.agentId}`, attemptId: order.attemptId, blocks });
      } catch (error) { i.onError?.(error); }
    };
    const confirmFirstCall = async (order: WorkOrder, usage: { readonly inputTokens: number; readonly requestChars: number }): Promise<void> => {
      try { await guards.context?.confirm?.(order, { reportedInputTokens: usage.inputTokens, promptChars: Math.max(1, usage.requestChars) }); } catch (error) { i.onError?.(error); }
    };
    // One relay per attempt, kept until the attempt\'s own expiry.
    const relays = new Map<string, { readonly relay: AttemptRelay; readonly until: number }>();
    const relayEnded = unlimited();
    // A paid route is stopped, before the call is sent, once the owner's aggregate spending cap is reached; a local or free route is never asked.
    const paidCallGate = async (order: WorkOrder): Promise<string | undefined> => {
      // A run whose model call a cutover took back sends nothing more, even before its worker has been stopped (card R04c).
      if (modelCalls !== undefined && live.dispatcher !== undefined) {
        const mc = (await live.dispatcher.get(principal, order.attemptId))?.modelCall;
        if (mc !== undefined && !(await modelCalls.current(mc))) return `the route ${mc.route} of this attempt was cut over or closed; the call is not sent`;
      }
      const table = (await i.routing.get()) as unknown as { providers?: Record<string, { paid?: boolean }> } | undefined;
      const provider = order.route.slice(0, Math.max(0, order.route.indexOf("/")));
      if (table?.providers?.[provider]?.paid !== true) return undefined;
      return budgets.capReached(principal, { taskId: order.taskId, agentId: order.agentId });
    };
    const attemptRelay = (order: WorkOrder, relay: ModelRelay, options: { readonly model?: string; readonly cache?: Parameters<ModelRelay["forAttempt"]>[1] } = {}): AttemptRelay => {
      const clock = i.options.clock === undefined ? Date.now : (): number => Date.parse(i.options.clock!());
      for (const [id, entry] of relays) if (entry.until < clock()) relays.delete(id);
      relayEnded.forget(relays, clock());
      let found = relays.get(order.attemptId);
      if (found === undefined) {
        // The route's length and reasoning budget (card W07), read from the routing table at every call; what could not be sent is a step of the task's activity, once per attempt and reason.
        const told = new Set<string>();
        const onBudget = (applied: { readonly notSent: readonly string[] }): void => {
          const key = applied.notSent.join("\n");
          if (applied.notSent.length === 0 || told.has(key)) return;
          told.add(key);
          const summary = `Route ${order.route}: ${applied.notSent.join("; ")}.`.slice(0, 3900);
          void ActivityService.withEpoch(storage, epoch, ro).record(principal, { commandId: `rbudget:${order.attemptId}:${createHash("sha256").update(key).digest("hex").slice(0, 24)}`, taskId: order.taskId, kind: "model-selected", summary, manifest: { refs: [{ kind: "task", id: order.taskId }] } } as never).catch((error: unknown) => i.onError?.(error));
        };
        // The route's provider record was changed while the attempt ran (card G09): its next call goes to the new address with the new record's key, and that is a step of the task's activity, once per change, never silent.
        const onEndpointChanged = (change: { readonly from: string; readonly to: string }): void => {
          const summary = redactText(`Route ${order.route}: its provider's address was changed while attempt ${order.attemptId} ran; its model calls go to ${change.to} from now on (before: ${change.from}), with the key the changed record names.`).slice(0, 3900);
          void ActivityService.withEpoch(storage, epoch, ro).record(principal, { commandId: `rmoved:${order.attemptId}:${createHash("sha256").update(`${change.from}>${change.to}`).digest("hex").slice(0, 24)}`, taskId: order.taskId, kind: "model-selected", summary, manifest: { refs: [{ kind: "task", id: order.taskId }] } } as never).catch((error: unknown) => i.onError?.(error));
        };
        // The endpoint's kind: the operator's cache endpoint configuration first, else the kind the owner recorded on the route's provider (guided setup, read at each call so a change applies from the next call).
        const configured = i.options.cache?.endpoints[order.route]?.config.kind;
        const kind = configured !== undefined ? configured : (): Promise<string | undefined> => providerKind(storage, order.route);
        found = { relay: relay.forAttempt({ route: order.route, ...(options.model === undefined ? {} : { model: options.model }), budget: async () => { const routes = (await i.routing.get())?.routes; const e = routes !== undefined && Object.hasOwn(routes, order.route) ? routes[order.route]! : undefined; return e === undefined ? undefined : { ...(e.maxTokens === undefined ? {} : { maxTokens: e.maxTokens }), ...(e.reasoningTokens === undefined ? {} : { reasoningTokens: e.reasoningTokens }) }; }, kind, onBudget, onEndpointChanged, onFirstUsage: (usage) => { void confirmFirstCall(order, usage); }, gate: () => paidCallGate(order), ...(monitorOf === undefined ? {} : { monitor: monitorOf(order) }), stream: streamTapFor({ generation, principal, ...(i.streamSettings === undefined ? {} : { settings: () => i.streamSettings!.effective() }), onError: (error) => i.onError?.(error) }, { attemptId: order.attemptId, taskId: order.taskId, generation: order.generation }) }, options.cache), until: Number.isFinite(Date.parse(order.expiresAt ?? "")) ? Date.parse(order.expiresAt!) + 60_000 : Infinity };
        relays.set(order.attemptId, found);
      }
      return found.relay;
    };
    const toolBridge = i.toolBridge;
    // The worker process's bridge requests go to the controller's own tool execution service, bound to the attempt that made them (the process holds only its task credential).
    const bridge = toolBridge === undefined ? undefined : (order: WorkOrder, call: ToolGateway["call"], token: string, request: { readonly op: string; readonly callId: string; readonly args?: { readonly [key: string]: unknown } }): Promise<BridgeResponse> => toolBridge.handle(token, { attemptId: order.attemptId, call }, request as BridgeRequest);
    const reportLocal = (event: { readonly kind: string; readonly key: string; readonly projectId?: string }): void => {
      // A malformed project ID is dropped, not the event. Never throws, never waits. With the controller's detectors present the sign goes through them (source `local-worker`), so the owner's
      // `securityDetectors` switch, the in-memory dedupe and the queue bounds apply to the local worker's hook too; without them it is reported as the local worker itself.
      try {
        const projectId = event !== null && typeof event === "object" && typeof event.projectId === "string" && /^proj-[a-z2-7]{20}$/.test(event.projectId) ? event.projectId : undefined;
        if (i.detect !== undefined) { i.detect("local-worker", { kind: event.kind as SecurityEvent, key: event.key, ...(projectId === undefined ? {} : { projectId }) }); return; }
        void Promise.resolve(i.securityReport?.(LOCAL_HOST_REPORTER, { kind: event.kind, key: event.key, ...(projectId === undefined ? {} : { projectId }) })).catch((error: unknown) => i.onError?.(error));
      } catch (error) { try { i.onError?.(error); } catch { /* ignored */ } }
    };
    const built = await i.options.local.build({ ...(networkParts === undefined ? {} : { network: { forAttempt: (order: WorkOrder) => networkParts.relay.forAttempt({ taskId: order.taskId, projectId: order.projectId, attemptId: order.attemptId }) } }), guards, reportSecurity: reportLocal, landingPolicy: async (call) => i.landingPolicy === undefined ? {} : i.landingPolicy(call), currentLimits: async () => i.workerLimits === undefined ? limits : i.workerLimits(), bestEffortAllowed: async () => i.workerPolicy === undefined ? false : i.workerPolicy.bestEffortAllowed(), recordLaunch: async (record) => { await recordLaunch(record); }, recordCompaction, recordThinking, context: contextFor, confirmFirstCall, attemptRelay, ...(cache === undefined ? {} : { cache }), ...(mcpParts === undefined ? {} : { mcp: { connector: mcpParts.connector, client: mcpParts.client } }), ...(bridge === undefined ? {} : { bridge }), namespaceId: (order) => personalNamespace(order.agentId).slice(2) });
    // The controller hands the host builder the owner's limits, best-effort setting and launch record. A host that does not say it connected them would run every agent unlimited whatever the owner set, so it is refused here, at start,
    // unless the operator states that it applies no owner limits (`acceptUnenforcedLimits`).
    if (built.ownerPolicy !== true && i.options.local.acceptUnenforcedLimits !== true) {
      try { await i.options.local.close?.(); } catch { /* the refusal below is the failure */ }
      throw new Error("dispatch.local.build returned a host that does not apply the owner's limits, best-effort setting or launch record: spread ownerPolicyOptions(services) from @nimblenewt/worker into localWorkerParts (and pass its ownerPolicy to the LocalWorker), or set dispatch.local.acceptUnenforcedLimits to run agents without them");
    }
    workers.push(built);
  }
  // Whatever was built before a later step fails is closed again: the listener, and the local host built above (a host the controller was given the means to build owns real resources).
  let transport: WorkerTransport | undefined;
  try {
    // Remote workers: the dispatcher is built with a way to ask who owns an agent's native store, and the remote service is built on the dispatcher afterwards.
    let remote: RemoteWorkerService | undefined;
    let blobs: FileBlobStore | undefined;
    if (i.options.remote !== undefined) {
      blobs = await FileBlobStore.open({ directory: i.options.remote.blobDirectory });
      const artifacts = ArtifactService.withEpoch(storage, epoch, blobs, { ...ro, onPublished: async (e) => { await ActivityService.withEpoch(storage, epoch, ro).record(principal, { commandId: `artv:${e.artifactId}`, taskId: e.taskId, kind: "artifact-version", summary: `Recorded artifact ${e.name} (${e.files} file${e.files === 1 ? "" : "s"}).`, manifest: { refs: [{ kind: "artifact", id: e.artifactId }] } } as never); } });
      const d = (): DispatcherService => holder.dispatcher!;
      remote = RemoteWorkerService.withEpoch(storage, epoch, {
        principal, hosts, artifacts, onError: (error) => i.onError?.(error),
        ...(i.securityReport === undefined ? {} : { reportSecurity: i.securityReport }),
        ...(i.detect === undefined ? {} : { detect: i.detect }),
        // What stall detection is told about a remote worker's model calls (card L05d): the controller does not carry them, so the stream messages are the report. The placement kept the order's route and the host (card L05e), so a remote call adds its reading of the route's speed on that host.
        ...(monitorOf === undefined ? {} : { monitor: (a: { attemptId: string; taskId: string; generation: number; route?: string; hostId: string }) => monitorOf({ ...a, route: a.route ?? "" } as unknown as WorkOrder) }),
        ...(i.toolBridge === undefined ? {} : { toolBridge: i.toolBridge }),
        // The thinking a remote host's process reported (card U09c): kept by the same store as a local process's, and only while the attempt is still the task's current one at the placement's generation (anything else is dropped, `stale`). The text is never logged or put in an error.
        thinking: async (a, blocks) => {
          try {
            const [assignment, attempt] = await Promise.all([i.assignments.getAssignment(a.taskId), i.assignments.getAttempt(a.attemptId)]);
            if (assignment === undefined || attempt === undefined || assignment.state !== "assigned" || assignment.activeAttemptId !== a.attemptId || assignment.generation !== a.generation || attempt.state !== "active") return { kept: 0, reason: "stale" };
            const r = await thinkingStore.record(principal, { projectId: a.projectId, taskId: a.taskId, agent: a.agentId.startsWith("agent:") ? a.agentId : `agent:${a.agentId}`, attemptId: a.attemptId, blocks });
            return { kept: r.kept, ...(r.reason === undefined ? {} : { reason: r.reason }) };
          } catch (error) { i.onError?.(error); return { kept: 0, reason: "unavailable" }; }
        },
        ...(i.options.remote.monitorProgressMs === undefined ? {} : { monitorProgressMs: i.options.remote.monitorProgressMs }),
        streams: (a) => streamTapFor({ generation, principal, ...(i.streamSettings === undefined ? {} : { settings: () => i.streamSettings!.effective() }), onError: (error) => i.onError?.(error) }, a),
        dispatch: { gateway: (id) => d().gateway(id), get: (by, id) => d().get(by, id), relocate: (by, id, m) => d().relocate(by, id, m), quiesce: (by, id, r, o) => d().quiesce(by, id, r, o), release: (by, id) => d().release(by, id), liveAttempts: (by) => d().liveAttempts(by) },
        ...(i.options.dispatcher?.bridges === undefined ? {} : { bridges: i.options.dispatcher.bridges }),
        ...(i.workerPolicy === undefined ? {} : { recordLaunch: async (r: Parameters<NonNullable<RemoteDeps["recordLaunch"]>>[0]) => { await recordLaunch(r as never); } }),
        ...(i.options.remote.relocationPolicy === undefined ? {} : { relocationPolicy: i.options.remote.relocationPolicy }),
        ...(i.options.remote.placementPolicy === undefined ? {} : { placementPolicy: i.options.remote.placementPolicy }),
        ...(i.restoreWaits === undefined ? {} : { restoreWaits: i.restoreWaits }),
        ...(i.options.remote.reaccept === undefined ? {} : { reaccept: i.options.remote.reaccept }),
        ...(i.options.remote.patienceMs === undefined ? {} : { patienceMs: i.options.remote.patienceMs }),
        ...(i.options.remote.confirmWindowMs === undefined ? {} : { confirmWindowMs: i.options.remote.confirmWindowMs }),
        // A reconnected worker that waits for the owner is a Needs-you notice (the notice kind is "maintenance"; the owner may change its level like any kind's).
        notify: async (n) => { await notifications.emitFromController({ commandId: n.commandId, kind: "maintenance", level: "needs-you", ref: { kind: "reconnect", id: n.attemptId }, detail: n.detail }); },
      }, { ...ro, ...(i.options.remote.protocol === undefined ? {} : { protocol: i.options.remote.protocol }), ...(i.options.remote.fileBytes === undefined ? {} : { fileBytes: i.options.remote.fileBytes }), ...(i.options.remote.settleMs === undefined ? {} : { settleMs: i.options.remote.settleMs }) });
      // Card H07b: the platform index is filled from the hosts on record, so a restarted controller does not wait for each host to connect before it can choose among them. A failure is reported and the index fills as hosts connect.
      try { await remote.rebuildIndex(principal); } catch (error) { i.onError?.(error); }
      // The owner's limits and best-effort setting reach a remote worker in the dispatch contract, read afresh at every start (card H12a).
      const ownerPolicy = { limits: async () => (i.workerLimits === undefined ? checkLocalWorkerLimits(i.options.local?.limits) : i.workerLimits()), bestEffort: async () => (i.workerPolicy === undefined ? false : i.workerPolicy.bestEffortAllowed()) };
      for (const h of i.options.remote.hosts) {
        // Card C07o: a remote host's first call and stored conversation are judged by the controller before the order is offered, with the local worker's guards (C07b, C07n): the host's stated window first, the routing
        // table's `contextTokens` second, and a route neither states refused with a blocker. A table that cannot be read refuses the call as unchecked (the error reaches the guards, as for the local host).
        const hostWindow = (order: WorkOrder): number | undefined => { try { return h.window?.(order); } catch { return undefined; } };
        const routeWindow = async (order: WorkOrder): Promise<number | undefined> => (await i.routing.get())?.routes[order.route]?.contextTokens;
        const guards = controllerGuards({
          context, pause: pauses, messages, system: principal,
          agent: (order) => i.taskCredentials.authenticate(order.credential),
          assignee: (order) => i.taskCredentials.agentOf(principal, order.attemptId),
          window: hostWindow, routeWindow, storedTokens: checkpointStoredTokens,
          // No remote operation reports the provider's input count, so no admitted round is kept waiting for one.
          confirms: false,
          startSize: startSize("remote"),
        }).context!;
        // The first call as the controller can know it before the host's process is up, measured against the same window the guards judge it by.
        const firstCall = estimatedFirstCall(context, async (order) => usableWindow(hostWindow(order)) ?? usableWindow(await routeWindow(order)));
        workers.push(new RemoteWorkerHost(h.hostId, remote, principal, { ...h, ownerPolicy, landingPolicy: async (call) => (i.landingPolicy === undefined ? {} : i.landingPolicy(call)), context: { guards, firstCall }, onGuardError: h.onGuardError ?? ((_attemptId, _what, error) => i.onError?.(error)) }));
      }
      if (i.quietHosts !== undefined) {
        const r = remote;
        quiet.service = QuietHostService.withEpoch(storage, epoch, {
          principal, settings: i.quietHosts.settings, hosts, remote: r, liveAttempts: () => d().liveAttempts(principal), attemptState: async (id) => (await d().get(principal, id))?.state,
          // The notice is the owner's, once per episode: the command ID is stable, and the reference is the host's name (a record code, never free text).
          notify: async (n) => { await notifications.emitFromController({ commandId: n.commandId, kind: "maintenance", level: "needs-you", ref: { kind: "host-record", id: n.hostId.slice("host:".length) }, detail: n.detail }); },
        }, { ...ro, ...i.quietHosts.options });
      }
    }
    // Every checkpoint a worker host hands the dispatcher becomes the task's continuation (card L04d), captured as the dispatcher: the lineage from the task's compactions (C07q), the budget from accounting, and the
    // previous continuation's identity, artifacts and decisions carried on. Complete only when the host said the checkpoint reads back from its store.
    const continuations = i.continuations;
    const capture = continuations === undefined || i.options.captureContinuations === false ? undefined : continuationRecorder({
      continuations, principal,
      sources: {
        compaction: async (taskId) => await context.latestCompaction(principal, taskId),
        budget: async (taskId) => { const r = await budgets.accounting(principal, taskId); return r === undefined ? undefined : { spent: r.spent.costMicros, remaining: r.available.costMicros, unit: `${r.currency} micros` }; },
        previous: async (taskId) => await continuations.latest(principal, taskId),
      },
      ...(i.onError === undefined ? {} : { onError: i.onError }),
    });
    const dispatcher = DispatcherService.withEpoch(storage, epoch, {
      ...(i.targetVersion === undefined ? {} : { targetVersion: i.targetVersion }), ...(i.toolBridge === undefined ? {} : { replaySafe: i.toolBridge.replaySafe }), ...(i.environments === undefined ? {} : { environments: i.environments }), launchDefaults: async () => (i.workerLimits === undefined ? checkLocalWorkerLimits(i.options.local?.limits) : i.workerLimits()), principal, assignments: i.assignments, projects: i.projects, credentials: i.taskCredentials, admission, reportsTo: reportsToOf, hosts, workers, ...(i.workspaceOps === undefined ? {} : { workspaceBusy: (taskId: string) => i.workspaceOps!.isBusy(taskId) }), contracts: i.contracts, harnesses: i.catalog, policy, decided: (decision, actionId) => ApprovalLoadService.withEpoch(storage, epoch, i.grants, ro).recordDecision(decision, { actionId }), protectedBranch: (projectId, branch) => branchSettings.isProtected(projectId, branch), ...(i.onDenied === undefined ? {} : { denied: i.onDenied }), effects, blockers, route, ...(modelCalls === undefined ? {} : { modelCalls }),
      activity: async (step) => { await ActivityService.withEpoch(storage, epoch, ro).record(principal, { commandId: step.commandId, taskId: step.taskId, kind: step.kind, summary: step.summary, manifest: { refs: step.refs } } as never); }, routing: i.routing, pauses,
      ...(i.interrogator === undefined ? {} : { interrogator: i.interrogator }),
      ...(i.jobWaits === undefined ? {} : { jobWakes: { waitable: i.jobWaits, ...(i.stops === undefined ? {} : { stopped: async (taskId: string) => { const held = await i.stops!.holding(taskId, undefined, { wider: true }); return held !== undefined && held.mode !== "suspend"; } }) } }), ...(i.stops === undefined ? {} : { heldBy: async (taskId: string) => { const ancestor = await stoppedAncestor(storage, i.stops!, taskId); return ancestor === undefined ? undefined : `its parent task ${ancestor.taskId} is ${ancestor.mode === "suspend" ? "suspended" : "stopped"} (stop ${ancestor.intentId}); its swarm children are not started while that holds`; } }), decisions, ...(i.resumes === undefined ? {} : { resumes: i.resumes }), ...(i.handoffs === undefined ? {} : { handedIn: (taskId: string) => i.handoffs!.latestForTask(taskId) }), prerequisites: async (taskId: string) => { const deps = await i.contracts.prerequisitesOf(taskId); if (deps === undefined) throw new DomainError("unavailable", "the task's dependencies could not be read"); const open: string[] = []; const dead: string[] = []; for (const e of deps.dependsOn) { if (e.state === undefined) dead.push(`${e.taskId} (missing)`); else if (e.state === "cancelled") dead.push(`${e.taskId} (cancelled)`); else if (e.state !== "done") open.push(`${e.taskId} (${e.state})`); } return { open, dead }; }, checkouts: ProjectResourceService.withEpoch(storage, epoch, ro), generation, reviews: i.reviews, budgets, meetings: attendance, notifications, loops, context,
      // Card W12: the goal anchor of an attempt about to start: on unless the owner turned it off, at most the owner's characters and the route's share of its window, and only where the route states a window.
      anchor: {
        plan: async (c) => {
          const settings = i.contextRouteSettings === undefined ? undefined : await i.contextRouteSettings.effective();
          if (settings?.anchor === false) return undefined;
          const window = await windowOfRoute({ route: c.route } as WorkOrder);
          if (window === undefined) return { leftOut: "no-window" as const };
          const maxChars = anchorBudget(window, settings?.anchorChars ?? ANCHOR_DEFAULT_CHARS);
          return maxChars === undefined ? { leftOut: "no-room" as const } : { maxChars, ...(settings?.recall === false ? {} : { recall: true }) };
        },
        rules: async (c) => {
          const record = await decisions.controllerContext({ projectId: c.projectId, taskId: c.taskId });
          if (record === undefined) return undefined;
          const items = ownerRuleItems(record);
          return items.length === 0 ? undefined : { version: record.version, total: items.length, items: items.slice(0, 12).map((x) => ({ id: x.id, text: x.text })) };
        },
      },
      routeChange: async (c) => {
        // The task's own text is in the prompt beside the view; `PROMPT_NOTE_RESERVE_CHARS` keeps room for the notes not measured here (the project's rules, a resume note), and the paragraph of what the task
        // was handed with (card C07m) is counted as it is on top of that — taking the larger of the two instead would let a long hand-off paragraph eat the room the rules were promised (C07m review).
        const moved = await moveContext(c, c.taskChars + PROMPT_NOTE_RESERVE_CHARS + (c.noteChars ?? 0));
        if (moved === undefined) return { ok: true };
        // The view (card C07g) goes in the first prompt of the attempt on the new route: its kept pieces and the references of what was cut.
        return moved.rebuilt ? { ok: true, view: { text: moved.view, measured: moved.measured } } : { ok: false, reason: `${moved.reason ?? "the context does not fit the new route"} (moved from ${c.previousRoute} to ${c.route}; ${remedies})` };
      },
      routeKept: async (k) => { await context.routeKept(principal, { taskId: k.taskId, route: k.route }); },
      ...(i.options.local === undefined ? {} : { toolWindow: (route: string) => { try { return i.options.local!.window({ route } as WorkOrder); } catch { return undefined; } } }),
      ...(remote === undefined ? {} : { storeOwner: (agentId: string, attemptId: string) => remote!.storeOwner(principal, agentId, attemptId) }),
      ...(i.options.handoffFacts === undefined ? {} : { handoffFacts: i.options.handoffFacts }),
      ...(capture === undefined ? {} : { checkpoints: capture }),
    }, { ...ro, holder: "dispatcher", ...(i.onError === undefined ? {} : { onError: i.onError }), ...(i.options.dispatcher ?? {}), ...((i.options.dispatcher?.safeLongRunning ?? i.safeLongRunning) === undefined ? {} : { safeLongRunning: (i.options.dispatcher?.safeLongRunning ?? i.safeLongRunning)! }), ...(i.dispatchLimits === undefined ? {} : { limits: i.dispatchLimits }), ...(i.taskMinutes === undefined ? {} : { configuredMinutes: i.taskMinutes }) });
    holder.dispatcher = dispatcher;
    // Card W13: `task.recall` reads the attempt's own task through the dispatcher's records and the context service's hand-off notes and cut notes, as the controller.
    const recallReader = new RecallReader({
      attemptsOf: (taskId) => dispatcher.attemptIdsOf(taskId), attempt: (attemptId) => dispatcher.attemptBody(attemptId), anchorFacts: (attemptId) => dispatcher.recallAnchorFacts(attemptId),
      handoff: (by, noteId) => context.readHandoff(by, noteId), archive: (by, taskId, digest) => context.noteArchive(by, { taskId, digest }),
    });
    const recall = new RecallService({ read: (attemptId, by) => recallReader.read(attemptId, by), settings: async () => (i.contextRouteSettings === undefined ? {} : await i.contextRouteSettings.effective()) });
    live.dispatcher = dispatcher;
    // A cutover cancels the running generation and runtime of the attempts it cut (card R04c).
    i.routes?.cutover.bind(i.routes.fallback, cutoverListener({ dispatcher: () => live.dispatcher, generation, principal, elevated: recovering(principal) }));
    i.bindWorkspacePort?.(async (taskId) => {
      const portOf = (hostId: string): WorkspacePort | undefined => workers.find((w) => w.hostId === hostId)?.workspace;
      const attempts = await dispatcher.liveAttemptsOf(principal, { taskId });
      if (attempts.length > 0) {
        for (const attemptId of attempts) {
          const d = await dispatcher.get(principal, attemptId);
          const host = d?.state === "running" ? d.hostId : d?.pinnedHost;
          if (host !== undefined) return portOf(host);
        }
        // A live attempt that waits with no host pinned: its checkout is not known to be anywhere, and another host is not tried.
        return undefined;
      }
      const placed = await dispatcher.placedHostOf(principal, taskId);
      if (placed !== undefined) return portOf(placed);
      const capable = workers.filter((w) => w.workspace !== undefined);
      return capable.length === 1 ? capable[0]!.workspace : undefined;
    });
    if (remote !== undefined) {
      transport = await WorkerTransport.listen({ ...(i.options.remote?.transport ?? {}), remote, principals: i.principals, ...(i.release === undefined ? {} : { release: i.release }) });
    }
    const driver = new DispatchDriver({
      dispatcher, storage, epoch, record: { storage, options: ro },
      ...(i.options.intervalMs === undefined ? {} : { intervalMs: i.options.intervalMs }), ...(i.options.timer === undefined ? {} : { timer: i.options.timer }), ...(i.options.clock === undefined ? {} : { clock: i.options.clock }),
      ...(i.onError === undefined ? {} : { onError: i.onError }),
      enabled: async () => (await i.principals.get(DISPATCHER_PRINCIPAL))?.state === "active",
      ...(i.hold === undefined ? {} : { hold: i.hold }),
      onDisabled: async (why) => { await tell(why); },
    });
    // Started last, so a failure above leaves no driver ticking a dispatcher whose host is being closed.
    await i.beforeLoops?.();
    if (i.options.manual !== true) driver.start();
    return {
      dispatcher, driver, generation, recall, closeWorkers: async () => { networkParts?.relay.close(); remote?.close(); await transport?.close().catch(() => undefined); await i.options.local?.close?.(); },
      ...(transport === undefined ? {} : { workerUrl: transport.url }), ...(remote === undefined ? {} : { remote }), ...(quiet.service === undefined ? {} : { quietHosts: quiet.service }),
      attemptControl: { live: (taskId) => dispatcher.liveAttemptsOf(principal, { taskId }), frozenReason: async (id) => (await dispatcher.get(principal, id))?.frozen?.reason, release: (id) => dispatcher.release(principal, id), tell: (id, text) => dispatcher.tell(principal, id, text), stop: (id, reason) => dispatcher.stop(principal, id, { reason }) },
      attendance, standups, watches,
      unsettledCharges: (by) => chargeRetry.unsettled(by),
      chargeUse: (u) => chargeRetry.submit(principal, { commandId: u.commandId, activity: u.activity, taskId: u.taskId, computeMs: u.computeMs, ...(u.agentId === undefined ? {} : { agentId: u.agentId }) }).then(() => undefined),
      // An outside server's text is framed as data on every page, with the injection check over the page itself (the visible head was checked when it was cut).
      readSpill: async (by, spillId, index, size) => {
        const found = await context.readSpill(by, spillId, index, size);
        if (found === undefined) return undefined;
        return { text: found.untrusted === true ? framedMcp(found.tool ?? "mcp", found.text, undefined, true) : found.text, ...(found.next === undefined ? {} : { next: found.next }) };
      },
      readRouteArchive: (by, taskId, digest) => context.routeArchive(by, { taskId, digest }),
      readNoteArchive: (by, taskId, digest) => context.noteArchive(by, { taskId, digest }),
      readHandoffNote: (by, noteId) => context.readHandoff(by, noteId),
      principal,
      hostOfAgent: async (agentId) => { for (const attemptId of await dispatcher.liveAttemptsOf(principal, { agentId })) { const d = await dispatcher.get(principal, attemptId); const host = d?.state === "running" ? d.hostId : d?.pinnedHost; if (host !== undefined) return host; } return undefined; }, quiesce: new QuiesceCoordinator({ dispatcher, blockers, principal }),
      ...(mcpParts === undefined ? {} : { mcp: mcpParts }),
      ...(networkParts === undefined ? {} : { network: networkParts }),
    };
  } catch (error) {
    await transport?.close().catch(() => undefined);
    await i.options.local?.close?.().catch(() => undefined);
    throw error;
  }
}

/** The nearest swarm ancestor of a task that has a Stop or Suspend in force, its own or one of a scope above it (cards L02d, L02e), or undefined. Bounded: 50 levels, so a cycle in the links ends. */
async function stoppedAncestor(storage: ControllerStorage, stops: Pick<StopService, "holding">, taskId: string): Promise<{ taskId: string; intentId: string; mode: string } | undefined> {
  const seen = new Set<string>([taskId]);
  let at = taskId;
  for (let hops = 0; hops < 50; hops++) {
    const parent = ((await storage.getAggregate({ kind: "swarm-link", id: at }))?.body as unknown as { parentTaskId?: string } | undefined)?.parentTaskId;
    if (typeof parent !== "string" || seen.has(parent)) return undefined;
    seen.add(parent);
    // A Stop of the parent's agent, a team above it or the installation ends the children's work too (card L02e), so it holds them as well.
    const held = await stops.holding(parent, taskId, { wider: true });
    if (held !== undefined) return { taskId: parent, ...held };
    at = parent;
  }
  return undefined;
}
