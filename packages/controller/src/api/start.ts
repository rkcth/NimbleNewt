import { createHash } from "node:crypto";
import { assignedTaskIn, projectIds, type RouteProbes } from "../dispatch/loops.js";
import { createTargetVersions, type TargetVersionOptions } from "../dispatch/target-versions.js";
import { allows } from "../security/access.js";
import { WORKER_PROTOCOL } from "../remote/protocol.js";
import { PlacementSettingsService } from "../remote/placement-settings.js";
import { QuietHostSettingsService } from "../remote/quiet-host-settings.js";
import { ReconnectSettingsService } from "../remote/reconnect-settings.js";
import { InvitationInbox, MeetingWakeHost, MEETING_LIMITS, MEETING_SETTINGS, MeetingService, meetingWakeSink, safeLongRunningOf, SAFE_LONG_RUNNING_SETTING, checkMeetingWakeTimeout, type HostWakeRequest } from "../meetings/index.js";
import { DeletionLedger, LEDGER_FILE, QuotaMeter, RETENTION_DEFAULTS, ReserveFile, RetentionService, RetentionSettingsService, guardStorage, type RetentionValues } from "../retention/index.js";
import { JOURNAL_FILE, PENDING_FILE, keepDataLocks, type DataLockKeeper, type LockEnv } from "../backup/index.js";
import { BackupEncryption, BackupEncryptionSettingService, BackupKeyPinService, BackupProofReminder, BackupProofStore, BackupService, BackupSigningService, describeSetting, sealsBackups, type SigningSecretStore, MaintenanceBarrier, StagedRestore, applyPendingRestore, createBackup, readKeyringFile, type PendingRestore, type PiStateSource } from "../backup/index.js";
import { readFile, statfs } from "node:fs/promises";
import { activeProjectIds, defaultEventSources } from "./default-sources.js";
import { ImprovementService } from "../standups/improvements.js";
import { shareableCite } from "../meetings/shareable.js";
import { reassignWarningSink } from "../meetings/reassign-warning.js";
import { MeetingRecordService, budgetRaiseApplier, grantApplier, taskReassignApplier, taskUpdateApplier } from "../meetings/record.js";
import { EventService, EventSourceSettingsService, type EventSource } from "../events/index.js";
import { BudgetService, holderNotice, type NotifyAggregate } from "../budgets/index.js";
import { CriticalPathService } from "../critical/index.js";
import { NotificationService, UrgentWatch, workSource, type ChannelAdapter } from "../notifications/index.js";
import { EscalationLadderService, RecoveryLadderService, StallService, type RecoveryEffects, type StallOptions } from "../health/index.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { AssignmentService } from "../domain/assignments.js";
import { WaitService } from "../domain/waits.js";
import { DeskService, HistoryService, RetrievalService, WorkingNoteService, ContextRouteSettingsService, StartSizeService, ThinkingStore, ThinkingService, InspectionService } from "../context/index.js";
import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  UnsupportedEnvironmentError, checkEnvironment, checkFilesystems, checkPrerequisites, decideStartup, detectDistribution, detectEnvironment, hostLine, overrideRequested, overriddenCheck, prerequisiteProblems, realProbes, recordHost, recordOverride,
  type EnvironmentFacts, type FilesystemDetector, type FilesystemReport, type PrerequisiteNeed, type PrerequisiteReport, type Probes, type StartupCheck,
} from "../environment/index.js";
import { AgentService } from "../agents/index.js";
import { HarnessCatalog, type HarnessDeclaration } from "../harness/index.js";
import { Reconciler } from "../domain/reconcile.js";
import { InboxService } from "../domain/inbox.js";
import { WatchService } from "../events/handling.js";
import { EffectService } from "../domain/effects.js";
import { DecisionService } from "../decisions/index.js";
import { BlockerService } from "../domain/blockers.js";
import { ContractService, WaitGraphService } from "../planning/index.js";
import { HEARTBEAT_ENV, HeartbeatWriter, ReleaseActivationService, ReleaseService, notificationSink, type ActivationOptions } from "../release/index.js";
import { SwarmLimitsService, SwarmService } from "../swarm/index.js";
import { CoverageService, CoverageSettingsService, IncidentService, MaintenanceLeaseService, ProjectPlanService, ProjectResourceService, ResponsibilityChecks, ResponsibilityService } from "../projects/index.js";
import { InquiryService } from "../inquiries/index.js";
import { DISPATCHER_PRINCIPAL, GrantService, PrincipalService, TaskCredentialService, type Principal } from "../security/index.js";
import { SqliteStorage, probeSqliteLibrary } from "../storage/sqlite/index.js";
import { PostgresStorage, probePostgresLibrary } from "../storage/postgres/index.js";
import type { ControllerStorage } from "../storage/types.js";
import type { BeforeUpgrade } from "../storage/snapshot.js";
import { LocalHostSettingService, SetupProviderService, SetupReadinessService } from "../setup/index.js";
import { providerKind } from "../setup/providers.js";
import type { CatalogRevocationPort, ContinuationOps, WebAccessPort } from "./operations.js";
import { StateApi } from "./state-api.js";
import { ConfigurationService } from "../configuration/index.js";
import { ConversationService, type Availability } from "../conversations/index.js";
import { AgentMessageService } from "../messaging/index.js";
import { PolicyEditService } from "../chat/index.js";
import { WebChatDoor, type WebChatOptions } from "../web/index.js";

import { CatalogPolicyService, CatalogService } from "../catalog/index.js";
import { AdmissionService } from "../admission/index.js";
import { HostService } from "../hosts/index.js";
import { RunningCallStore, ToolExecutionService, type BoundGateway, type BridgeRequest, type BridgeResponse, type ToolExecutionDeps } from "../toolbridge/index.js";
import { CommandService, catalogSource } from "../commands/index.js";
import { BUILTIN_COMMANDS } from "./operations.js";

import { wideningDecision } from "./widening.js";
import { ApprovalLoadService, IntegrationPolicyService, PolicyService, ProfileSuggestionService, ProtectedBranchService, type ApprovalsFacade } from "../policy/index.js";
import { StatusService } from "../status/index.js";
import { ChatService, ChatSpendService, CoordinatorService, GuardedModelCall, agentLifecycle, chatRoutes, type ChatInterpreter, type CoordinatorModel, type ModelCall } from "../chat/index.js";
import { ContextBranchService } from "../branches/index.js";
import { createMeetingGate } from "../jobs/meeting-gate.js";
import { JobService, LocalJobRuns, decideAtStart, type JobLauncher, type LocalJobRunsDeps } from "../jobs/index.js";
import { McpService, callToolAsJob, type McpJobCall } from "../mcp/index.js";
import type { ResumePorts } from "../continuation/resume.js";
import { ContinuationService, ResumeCheckService, ResumeReviewer, ResumeSettingsService, ReviewNotRun, controllerResumePorts, type ResumeReviewModel, type ResumeReviewRoutes } from "../continuation/index.js";
import { DependencyService, checkoutDependencyObserver, locallyPlaced, resumeProbeEnabled } from "../dependencies/index.js";
import { ActivityService, ReplayLimitsService, ReplayService } from "../activity/index.js";
import { BoundedReviewerModel, RESUME_REVIEWER_ROUTE_SETTING, REVIEWER_ROUTE_SETTING, ReportInterrogator, WorkEndService, reviewerRoute, checkpointVerdict, dispatcherEndingPorts, stagedSubmit, type EndingAttempt, type Landed, type StagedWork } from "../work-end/index.js";
import { HandoffService, PauseService, StopService, agentsUnder, controllerHandoffSources, dispatchStopPorts, responsibilityHandover, describeReassigned, hostLocalWork, swarmDescendantsInfo, swarmDescendantsOf, type LocalWork } from "../lifecycle/index.js";
import { AcceptanceService, SubmissionService, attemptOfAssignments } from "../submissions/index.js";
import { ReviewService } from "../review/index.js";
import { CutoverService, DifficultyService, FallbackService, RoutingService, selectRoute } from "../routing/index.js";
import { LANDING_SETTING_KEYS, landingPolicyFrom } from "./landing-policy.js";
import { SecurityDetectors } from "../notifications/security-detect.js";
import { checkLocalWorkerLimits } from "./worker-limits.js";
import { AgreedLimitsSettingsService } from "./agreed-limits-settings.js";
import { WorkerLimitsSettingsService } from "./worker-limits-settings.js";
import { CapacityLimitsService } from "../admission/caps.js";
import { StreamSettingsService } from "../generation/index.js";
import { DispatchLimitsSettingsService } from "./dispatch-limits-settings.js";
import { MaintenanceService, EnvironmentChangeApplier, StorageJournal, type EnvironmentRuntime, type MaintenanceApplier } from "../maintenance/index.js";
import { EnvironmentService } from "../environments/index.js";
import { CleanupSettingsService, ScratchCleanupService, ownerNotices, supervisorNotice, scratchRecordId, type ScratchMode, type ScratchPorts } from "../work-end/index.js";
import { WorkspaceOpService, type WorkspacePort } from "../workspace-ops/index.js";
import { IntegratorLeaseOps, IntegratorLeaseService, describeLeases, integratorLeaseHandover } from "../landing/index.js";
import { ArtifactService, DeliverableService, FileBlobStore, TaskArtifactPublisher } from "../artifacts/index.js";
import { ServiceOperations, type ServiceTarget } from "../service-ops/index.js";
import { composeDispatch, type DispatchHandle, type DispatchStartOptions } from "./dispatch-compose.js";
import { canon } from "../backup/canon.js";
import { DatabaseTransferService, assertNotFenced, expectEpochOnFirstTake, type RestartEvent, acquireStateLock, guardStart, withStateLock, postgresFingerprint, recordFirstStart, sqliteFingerprint, postgresTargetDeps, transferTargetsFromConfig, type TransferPoint, type TransferReferences, type TransferSource, type TransferTarget } from "../transfer/index.js";
import { ConversationTransport, MCP_ENABLED_SETTING, type TransportOptions } from "../transport/index.js";
import { redactedSink, redactText } from "../security/redact.js";

export type StorageChoice =
  | { readonly kind: "sqlite"; readonly path: string }
  | { readonly kind: "postgres"; readonly url: string; readonly schema?: string; readonly maxConnections?: number; /** A stricter floor than the supported minimum (it can never be lower). Mostly for tests. */ readonly minimumServerVersionNum?: number };

export interface StartOptions {
  readonly storage: StorageChoice;
  /**
   * What the host can add to the checked resume (card L04c): `observe` (what a worker sees now for a task's recorded dependencies; without it every dependency that needs an observation reads unknown), `review` (an independent reviewer's verdict on each change;
   * without it every change is treated as relevant and the owner decides), and extra `missingContext` / `uncertainEffects` checks. Each must be repeatable.
   */
  readonly resume?: Partial<ResumePorts>;
  /**
   * The reviewer agent for a checked resume (card L04d): a model client and the routes it may use, tried in order. Without one the
   * controller treats every change as relevant, so every changed resume waits for the owner; with one, a change the reviewer judges
   * not to matter is committed without the owner. It is told the changes, the task's title and the next step its continuation
   * recorded, each quoted as data (`tellTask: false` leaves the last two out). An explicit `resume.review` wins over this.
   * The model is the host's raw client; the controller puts it behind its own routed client (card L04d, as for the chat, U03b): a credit or authentication failure blocks that provider's routes, a rate limit or an
   * outage cools the route down, and the tokens each call reports (`completeDetailed`) are counted against the daily cap on the controller's own model calls, at which no call is made and the check waits at the review.
   * `routes` absent: the routing table's eligible list for `role` (default `safety-supervisor`, which every routing table must give a fallback list), read again at every review.
   */
  readonly resumeReview?: { readonly model: ResumeReviewModel & Pick<ModelCall, "completeDetailed">; readonly routes?: ResumeReviewRoutes; readonly role?: string; readonly tellTask?: boolean };
  /**
   * The host's raw model client for the reviewer roles (card W10 wiring): the HTTP client over the owner's recorded provider addresses in the launcher. The controller bounds it (`BoundedReviewerModel`: redacted, cut, one reply
   * size), puts it behind its routed and metered client and uses it for the second agent that questions a done, on the route the owner set (`report.reviewerRoute`, a setting reachable in chat; unset: no report is questioned and each
   * done's report says so). Ignored when `reportInterrogation` is given (that explicit composition stays as it was).
   * The same bounded client is the resume reviewer (card L04d wiring) on its own owner setting (`resume.reviewerRoute`), unless `resumeReview` or `resume.review` is given: unset, unusable, at the daily cap or with a model
   * that gives no verdict, the resume check records the review as not run and every change waits for the owner (never a `review_failed` hold, never a pass).
   */
  readonly reviewerModel?: ResumeReviewModel & Pick<ModelCall, "completeDetailed">;
  /**
   * The second agent that questions an agent's done before it is recorded succeeded (card W10): a model client of its own, with no tools and no share in the agent's conversation, reached exactly as the resume reviewer is (card L04d):
   * the host's raw client behind the controller's routed client (`GuardedModelCall`: credit and authentication failures block the provider, a rate limit or an outage cools the route), its tokens counted against the daily cap on the
   * controller's own model calls (at the cap no call is made). `routes` absent: the routing table's eligible list for `role` (default `safety-supervisor`), read at every questioning. Absent: no done is questioned, and each done's
   * report records that no second agent questioned it (the done is taken on the controller's own checks, card W05).
   */
  readonly reportInterrogation?: { readonly model: ResumeReviewModel & Pick<ModelCall, "completeDetailed">; readonly routes?: ResumeReviewRoutes; readonly role?: string };
  /**
   * Whether a checked resume may look at the task's own checkout to see how its recorded files and directories are now (card L04d),
   * instead of leaving every one of them `unknown`. Default: yes. `false` turns the reading off, `{ maxEntries, maxBytes }` bounds it
   * tighter. A probe reads nothing outside the checkout the task's records name, and reports only what it really read. An explicit
   * `resume.observe` wins over this. With remote hosts (`dispatch.remote.hosts`) the default is off: the resumed attempt's host is
   * chosen after the check, and this machine's disk says nothing about another's. Given explicitly there, a task last placed on a
   * remote host (or never placed) is still not probed, so its files stay `unknown` unless the host's own `resume.observe` answers.
   */
  readonly resumeProbe?: boolean | { readonly maxEntries?: number; readonly maxBytes?: number; readonly maxTotalBytes?: number; readonly timeoutMs?: number };
  /**
   * Moving the controller database to another one from chat (card F04e). The databases a transfer may go to are named here by the host (a PostgreSQL address holds a password, so it is never typed in chat); with none given
   * the transfer commands answer "not configured". Needs a data directory (the transfer journal and the authority file live there). `inject` is a test hook.
   */
  readonly transfer?: { /** ONE fixed folder for the transfer journal and authority file, independent of every database path (mandatory when targets are given). */ readonly stateDirectory?: string; readonly targets: readonly TransferTarget[];
    /** Destinations as the configuration lists them, `{ name, kind: "sqlite", path }` or `{ name, kind: "postgres", url: { secret }, schema?, maxBytes? }` (card F04l): checked and built here, so a host passes the configuration's entries as they are. They are added to `targets`; a name or a place used twice is refused. */
    readonly targetEntries?: readonly unknown[];
    /** Turns a secret name into its value (the host's secret store). Needed for PostgreSQL entries: their address is only a reference in the configuration. The value is used to open, size and empty the destination and is hidden from every error, log and journal text. */
    readonly secrets?: (name: string) => Promise<string | undefined>;
    /** Checks outside the database, answered by the host (card F04l): `checkpoints` answers which recovery points' conversation checkpoints are MISSING from the agents' stores. The controller does not know the layout of Pi's stores, so it cannot check them itself. Each point's `checkpoint` is given as the JSON text the recovery-point record holds. */
    readonly references?: Pick<TransferReferences, "checkpoints">; readonly inject?: (point: TransferPoint) => void | Promise<void>; readonly onSwitched?: () => void;
    /**
     * The host's opt-in to restart the controller onto the new database by itself (card F04m): after a move (or a rollback) was answered, `run` is called once, `delayMs` later (default 1500), with what happened. The host stops this controller and starts it again
     * from its configuration, which points at the new database. Without it the controller waits for the host to be restarted. The owner can turn the automatic restart off in chat (`database.transfer.restart`).
     */
    readonly restart?: { readonly run: (event: RestartEvent) => void | Promise<void>; readonly delayMs?: number } };
  /** Where releases are staged and activated (card K02): off unless given. The release root holds `incoming`, `releases` and the activation pointer; the launcher reads the pointer. */
  readonly releases?: Omit<ActivationOptions, "runner">;
  /**
   * Liveness heartbeat (card K02): when this controller runs under the launcher, a timer writes a counter to a launcher-owned file so the launcher can tell a hung controller from a working one. Default: on when `env.NIMBLENEWT_HEARTBEAT_FILE`
   * (with `NIMBLENEWT_HEARTBEAT_TOKEN` and optionally `NIMBLENEWT_HEARTBEAT_INTERVAL_MS`) is set by the supervisor, off otherwise; `false` turns it off. An unsafe path or token only turns it off (told once).
   */
  readonly heartbeat?: false | { readonly file: string; readonly token: string; readonly intervalMs?: number };
  /** The command line and environment of the process: the operator's override is read from them (`--allow-unsupported-environment`, `NIMBLENEWT_ALLOW_UNSUPPORTED_ENVIRONMENT=1`). */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where start-up notices go. Default: standard error. */
  readonly print?: (line: string) => void;
  /** What the data directory lock asks the system (tests inject a clock, a heartbeat period, ...). */
  readonly dataLockEnv?: LockEnv;
  /** Names this controller in the epoch record. */
  readonly holder?: string;
  /** For tests: what the process is running on, instead of detecting it. */
  readonly facts?: EnvironmentFacts;
  /**
   * The data directory (card F04i). Default: the directory of the SQLite file; PostgreSQL has none unless this is given. Its file system must be on the supported list and not a network
   * file system, or the controller refuses to start (the F04h switch overrides it).
   */
  readonly dataDirectory?: string;
  /** The roots under which workspaces (checkouts) live; each one's file system must be on the supported list too. */
  readonly workspaceRoots?: readonly string[];
  /** The parts this controller runs on this machine besides the controller itself (card F04j): their tools are required at start. Default: the sandbox and the limits when a local worker host is built (`dispatch.local`), otherwise none; the sandbox and the limits are then checked by the launcher, which refuses to advertise capacity without them. */
  readonly features?: readonly ("sandbox" | "limits")[];
  /** For tests: how the file system under a path is found, instead of asking this machine. */
  readonly filesystem?: FilesystemDetector;
  /** For tests: what is present on this machine, instead of probing it. Ids not given are probed for real. */
  readonly probes?: Probes;
  /** For tests: the Linux distribution's description, instead of reading it. */
  readonly distribution?: string | null;
  /** For tests: called with errors that are not part of the API contract. */
  readonly onInternalError?: (error: unknown) => void;
  /** The harnesses this installation ships (card F08). None by default: an attempt that names a harness is then refused. The first release ships Pi only. */
  readonly harnesses?: readonly HarnessDeclaration[];
  /**
   * Opens the conversation listener (card U02b). Off unless given. Local only by default; a remote listener needs `allowRemote`, TLS and `publicHosts` (see `TransportOptions`).
   * The listener is closed with the controller.
   */
  readonly conversationTransport?: Omit<TransportOptions, "conversations" | "principals">;
  /**
   * Opens the web chat (card U07): the responsive browser page for the owner, over the owner chat (`chat` must be given). Off unless given. `host` and `network` are required and the address is never public
   * (see `checkBinding`); `assets` are the page files (`webChatAssets()` from `@nimblenewt/ui`). The listener is closed with the controller.
   */
  readonly webChat?: Omit<WebChatOptions, "backend">;
  /** What the lifecycle says about a principal (cards L01 and L02 supply it). Default: everyone is available. */
  readonly availability?: (principalId: string) => Promise<Availability>;
  /** How the host brings an agent its `availability` hook reports stopped or suspended up for one meeting (card M04f). Called only after the owner authorized that wake (`meeting.wake`), once per meeting and agent key, and must treat a repeated key as the same request. Absent: that authorization is refused. */
  readonly meetingWake?: { readonly recover: (request: HostWakeRequest) => Promise<void>; readonly timeoutMs?: number };
  /** Stall detection's thresholds, the margin and the speeds a route is read at before it has been measured (card V01b); the controller's own pause check is not replaceable. */
  /** `clock`: the time stall concerns, their climbs and their recovery steps (manual and automatic) are judged and recorded by; absent: the dispatcher's clock, else the system clock. */
  readonly stall?: Pick<StallOptions, "thresholds" | "declaredSpeed" | "defaultReadTokensPerSecond" | "readMarginPercent" | "escalateAfterMs" | "clock">;
  /**
   * Builds the attempt dispatcher and runs its loops (card H12c): the tick, the messages, attendance, stand-up, event and decision loops. Off unless given. The loops run only while this controller
   * holds the primary epoch; a newer controller instance stops them here. See `DispatchStartOptions`.
   */
  readonly dispatch?: DispatchStartOptions;
  /**
   * The controller's reading of each call's target version, so an exact-operation approval is bound to what the target was when it was reviewed (card A05b follow-up). On by default: a branch or ref head commit, a workspace
   * file's `sha256:` digest, a record's `rev:` revision (see `createTargetVersions`), nothing for any other kind. `false` leaves every call bound by name only; limits (file size cap, git and total time) can be set for a host.
   */
  readonly targetVersions?: false | TargetVersionOptions;
  /** Meeting records (card M03i): minutes after a meeting ends before the lease hands its outcomes back by itself (default 60; the owner can return them with a question before then). */
  readonly meetingRecords?: { readonly autoReturnMinutes?: number };
  /** Reviewed environment changes (card A09). The applier makes an approved change in the agent's environment; without one every approved change waits (pending) and the owner is not misled. */
  readonly maintenance?: { readonly applier?: MaintenanceApplier; /** The host side of the real environment applier (card A09): the disposable trial, the worker reload and the validation. With it, and without an `applier` of its own, approved package and extension requests are carried out by `EnvironmentChangeApplier`; without both, approved changes wait. */ readonly environmentRuntime?: EnvironmentRuntime; /** How long the suspension for an environment change may take (default one minute). */ readonly suspendMs?: number; /** The maintenance loop period in milliseconds (default 30000). */ readonly tickMs?: number; /** The claim heartbeat in milliseconds (default a third of the lease; 0 = off). */ readonly heartbeatMs?: number };
  /**
   * How the owner is reached outside the inbox (card U11b): the named channel adapters the notification service delivers through when the owner sets the channel to `external` (Urgent items, escalations and digests
   * all go through them), and a fixed clock for tests. With the dispatcher, each tick runs `notifications.runDue` (escalation of unattended Needs-you items, Notice expiry, digests, retries); without it nothing runs it.
   */
  readonly notifications?: { readonly channels?: Record<string, ChannelAdapter>; readonly clock?: () => string };
  /**
   * The protected tool bridge for catalogue tools (card T06, wired by T02b): the script runner and which hosts are this machine. Off unless given (and it needs `dispatch`). The service is built ONCE here, over the controller's one
   * catalogue, so a revocation reaches the calls it runs; `revocationPolicy` is the operator\'s own answer for a revocation that carried no owner choice: it beats the owner\'s setting, and `catalog.policy.get` says so (`source: operator`). `pauseTask` and `notice` replace the built-in pause and owner notice (tests).
   */
  readonly tools?: Pick<ToolExecutionDeps, "runner" | "isLocalHost" | "facts" | "revocationPolicy" | "pauseTask" | "notice" | "revocationWatchMs">;
  /**
   * Card T07b: long-running jobs agents start through the tool bridge. `launcher` starts a job's process in the sandbox (the worker package's `jobLauncher` over the A03 launcher); `limits` bound how many run at once, how much output
   * they write and how long a stop waits. Off unless given (and it needs `tools`): without it the bridge's job operations answer as unavailable. Whatever is given, every controller with a dispatcher decides the live jobs at start.
   */
  readonly jobs?: { readonly launcher: JobLauncher; readonly limits?: LocalJobRunsDeps["limits"] };
  /**
   * Where the artifact files are kept (card U05b). Given, the status answers check each delivered artifact against its files and say whether they match, are damaged, or were not checked; absent: they are shown as not checked and never as verified.
   * This controller only reads through it (it publishes nothing here), but opening creates the folder if it is missing, so a mistyped path shows every artifact as not matching until it is corrected. Not defaulted from the remote hosts' blob folder: name it explicitly.
   */
  readonly artifacts?: { readonly directory: string };
  /**
   * The services that operations (`service.operate`) reach (card P03). Absent: no operation can be done and no operational outcome can be recorded. Tests and the sandbox pass a `SimulatedServices`;
   * it reaches nothing outside the process.
   */
  readonly serviceTarget?: ServiceTarget;
  /**
   * The built-in backup (card K01): a folder the backups are written to, "back up now" for the owner and, with the dispatcher, a nightly run keeping 7 daily and 4 weekly copies. Off unless given.
   * The folder should be on another disk than the database for the backup to survive that disk.
   */
  /**
   * Health probes of failed-over routes (card R04c). Off unless given, and `enabled` starts false: the owner asked for no probes to reach their model servers until they say so, so nothing sends a request on its own. `run` sends one small request to a route.
   */
  /** External event sources polled by the dispatcher each tick (card H13d). By default the built-in one, which reports tasks seen done or cancelled in the last week (card H13e); pass an empty list for none. The sources reach out, so any others are only the ones the caller chooses. */
  readonly eventSources?: readonly EventSource[];
  /** What the runtime knows about an attempt's local processes and delegated child work, and what the stop cleanup cost it (card L02d). Absent: the stop inventory does not list them. */
  readonly localWork?: LocalWork;
  /**
   * Stages an attempt's work and reports it (card H12n): the commit its checkout is based on, the tree and patch id of what is staged and the files changed. Provided by the workspace host (not composed yet, H12k). Absent: `work.end { submit: true }` is refused as unavailable, as before.
   */
  readonly stage?: (attempt: EndingAttempt) => Promise<StagedWork>;
  /** What the task's checkout changed against its base and what the landing branch changed since (card H12n). Absent: the checkout is unknown, so a submit cannot be checked. */
  readonly landing?: (taskId: string) => Promise<Landed | undefined>;
  /**
   * The HOST PORT of the scratch cleanup (owner decision 2026-10-30): executes a cleanup order on the attempt's controller-created scratch workspace and reports what an agent installed or left running (never removed). Idempotent by `order.key`.
   * Absent (no host here can do it): scratch is kept. `cleanupDefault` is the start-up default of the owner's `cleanup` setting (`after-handoff` unless set).
   */
  readonly scratchHost?: { readonly remove: NonNullable<ScratchPorts["order"]> };
  readonly cleanupDefault?: ScratchMode;
  /** The installation's retention defaults (card K06): the profile the owner's chat settings override. Everything that deletes is off unless a default here turns it on; the owner changes any value by chatting. */
  readonly retention?: { readonly defaults?: Partial<RetentionValues>; /** The least time between two automatic runs when the owner turned `autoRun` on (default one hour). */ readonly autoEveryMs?: number };
  readonly routeProbes?: { readonly run: RouteProbes["run"]; readonly intervalMs?: number; readonly enabled?: boolean };
  readonly backup?: { readonly directory: string; readonly everyMs?: number; readonly retention?: { readonly daily: number; readonly weekly: number }; readonly version?: string; readonly now?: () => Date;
    /** Encrypted backups (card K01b). Off unless given. `keyringFile` is made on the host by `backup encryption-setup`; the passcode and recovery files are the out-of-band files the owner points the proof at (never the chat). If the keyring cannot be read the controller does not start: it never falls back to plain backups. */
    readonly encryption?: { readonly keyringFile: string; readonly passcodeFile?: string; readonly recoveryFile?: string };
    /** Signs every backup (card K01b3). Off unless given. `store` is the host's secret store (F09: `resolve` and `set`); the private key lives there under `secretName` (default `backup-signing-key`) and nowhere else. The public keys are recorded in the database as the owner's record of who signs. With it, backups are refused rather than written unsigned, and a restore through the controller requires a valid signature. */
    readonly signing?: { readonly store: SigningSecretStore; readonly secretName?: string };
    /** The agents' own conversation stores on this machine (card K01h): copied into every backup and put back by a restore. */
    readonly piState?: PiStateSource;
    /** Restoring from inside the running controller (card K01h; PostgreSQL card K01i, which needs `dataDirectory` for the marker, key and journal). `piFinal` says where a conversation store goes (default: `restored-pi-state/<id>` in the data directory); `onStaged` is told when a restore waits for the restart (the controller does not end its own process). */
    readonly restore?: { readonly piFinal?: (id: string) => string | undefined; readonly onStaged?: (pending: PendingRestore) => void;
      /** How this host restarts the controller once a restore is staged (card K01i): `automatic` closes this controller and starts it again (called `delayMs` after the restore is staged, so the owner's reply goes out first); `instruction` is what the owner must do here when it is not automatic. Absent: the owner is told to stop and start the controller the usual way. */
      readonly restart?: { readonly automatic?: () => void | Promise<void>; readonly instruction?: string; /** Default 1000 ms after the restore is staged. */ readonly delayMs?: number } } };
  /**
   * Owner chat (card U03): the interpreter that reads the owner's messages (a model behind the routed client in production; a scripted one in tests) and, optionally, the persistent coordinator's model and credential. Absent: no chat service is built.
   * The approval profile (A07), status explanations (U05) and conversational policy edits (U04) are composed in. The coordinator is controller-managed and nothing depends on it: when it is paused, stopped or its routes fail, the chat and the rest of the controller carry on.
   */
  readonly chat?: {
    readonly interpreter: ChatInterpreter;
    readonly coordinator?: { readonly model: CoordinatorModel; /** The coordinator agent's credential, held by the controller. */ readonly token: () => Promise<string | undefined>; /** Where its routes come from at each question (the routing table, via `chatRoutes`); absent: the routes stored with it. */ readonly routes?: () => Promise<readonly string[]> | readonly string[]; /** The routes for a hosted coordinator whose agent has a `defaultProfile` (card U03d); absent: the routing table's own for that profile (local, unpaid), via `chatRoutes`. */ readonly profileRoutes?: (profile: string) => Promise<readonly string[]> | readonly string[] };
  };
}

export interface Controller {
  readonly api: StateApi;
  readonly storage: ControllerStorage;
  readonly epoch: number;
  readonly check: StartupCheck;
  /** What was found under the data directory and the workspace roots (supported or not, and whether names fold). */
  readonly filesystems: readonly FilesystemReport[];
  /** What each prerequisite probe found. */
  readonly prerequisites: readonly PrerequisiteReport[];
  readonly services: {
    /** The integrator lease of each landing branch (card L03j, the first part of P10): for the code that composes the landing; a hand-off releases or (owner's choice) moves the sender's. */
    readonly integratorLeases: IntegratorLeaseService;
    /** Retention, quotas, archive, export and deletion, and their settings (card K06). */
    readonly retention: RetentionService; readonly retentionSettings: RetentionSettingsService;
    readonly backups?: BackupService;
    /** Reviewed environment changes (card A09). */
    readonly maintenance: MaintenanceService;
    readonly environments: EnvironmentService;
    readonly workEnd: WorkEndService; readonly scratchCleanup: ScratchCleanupService; readonly acceptance: AcceptanceService;
    /** The one catalogue (revoke path and tool bridge share it). */
    readonly catalog: CatalogService;
    readonly principals: PrincipalService; readonly taskCredentials: TaskCredentialService; readonly grants: GrantService; readonly projects: ProjectService; readonly assignments: AssignmentService;
    readonly waits: WaitService; readonly stall: StallService; readonly desks: DeskService; readonly histories: HistoryService; readonly retrieval: RetrievalService; readonly inquiries: InquiryService; readonly agents: AgentService; readonly harnesses: HarnessCatalog; readonly contracts: ContractService; readonly graph: WaitGraphService; readonly resources: ProjectResourceService; readonly plans: ProjectPlanService; readonly responsibilities: ResponsibilityService; readonly reviews: ReviewService; readonly conversations: ConversationService; readonly configuration: ConfigurationService; readonly routing: RoutingService; readonly records: MeetingRecordService; readonly activity: ActivityService; readonly continuations: ContinuationService; readonly resumes: ResumeCheckService; readonly handoffs: HandoffService; readonly cutover: CutoverService; readonly fallback: FallbackService; readonly pauses: PauseService; readonly branches: ContextBranchService;
    readonly jobs: JobService;
    /** Guided editing of the model providers, and the address and credential name of each one's model server (card U14). */
    readonly setupProviders: SetupProviderService;
    readonly localHost: LocalHostSettingService;
  };
  /** The dispatcher and the driver of its loops, when `dispatch` was given and the dispatcher could be provisioned. */
  readonly dispatch?: DispatchHandle;
  /** The tool bridge's execution service, when `tools` was given and the dispatcher was built. It is the only one: it subscribes to revocations of `services.catalog`. */
  readonly tools?: ToolExecutionService;
  /** The jobs this machine runs for agents (card T07b), when `jobs` and `tools` were given and the dispatcher was built. */
  readonly jobRuns?: LocalJobRuns;
  /** A long-running MCP operation as a job (card T07b): admitted as `by` on an approved server, called over the dispatcher's MCP client, ended with its answer or recorded outcome-unknown. Present when `dispatch.mcp` was given and the dispatcher was built. */
  readonly mcpJobs?: { call(by: Principal, call: McpJobCall): ReturnType<typeof callToolAsJob> };
  /** What the start-up rule decided for the jobs that were live when this controller started (card T07b), when the dispatcher was built. */
  readonly jobsAtStart?: { readonly decided: number; readonly failed: number };
  /** The web chat listener, when `webChat` was given. */
  readonly webChat?: WebChatDoor;
  /** The owner chat and the coordinator, when `chat` was given. */
  readonly chat?: ChatService;
  readonly coordinator?: CoordinatorService;
  /** Why the dispatcher was not built although it was asked for (for example the owner disabled `service:dispatcher`). */
  readonly dispatchProblem?: string;
  /** The conversation listener's address, when it was asked for. */
  readonly conversationUrl?: string;
  close(): Promise<void>;
}

/** The directories the registered projects keep their checkouts in, each once, as absolute paths, apart from the roots already checked. A location that is not a local path is not a workspace. */
async function checkoutRoots(storage: ControllerStorage, already: ReadonlySet<string>): Promise<string[]> {
  const seen = new Set<string>(already);
  const found: string[] = [];
  for (let afterId: string | undefined; ;) {
    const page = await storage.listAggregates("project", { ...(afterId === undefined ? {} : { afterId }), limit: 200 });
    for (const a of page) {
      // A retired project's checkouts are no longer worked in: a mount that has gone away must not keep the controller from starting.
      if ((a.body as unknown as { state?: string }).state === "archived") continue;
      for (const repository of (a.body as unknown as { repositories?: readonly { location?: unknown }[] }).repositories ?? []) {
        if (typeof repository.location !== "string" || !isAbsolute(repository.location)) continue;
        const path = resolve(repository.location);
        if (!seen.has(path)) { seen.add(path); found.push(path); }
      }
    }
    if (page.length < 200) return found;
    afterId = page[page.length - 1]!.id;
  }
}

/**
 * The controller's start-up path (first built with card U01). In order:
 * 1. Detect the environment (operating system, Node.js), the file systems under the data directory and workspaces (F04i) and the prerequisites (git, the database library, the sandbox tools
 *    where asked; F04j), and decide once with `decideStartup`: a supported one passes silently, an unsupported one **refuses to start** with what was found, what is supported, how to test or
 *    install it and the exact override, unless the operator gave the override; then it prints the notice and goes on. A missing hard prerequisite is refused whatever the switch says.
 * 2. Open the storage. For PostgreSQL the server's version is checked too: an unsupported server is refused unless the override was given (the adapter is told so), and then it is added to the notice.
 * 3. Take the primary epoch and write the audit record of an override (once per epoch). Nothing is written for a supported environment as an override (`environment.override`); the host record (`environment.host`) is written on every start.
 * 4. Build the services and the state API on that epoch.
 * Nothing else about behaviour changes under the override.
 */

/** The locks section of a hand-off when every kind of hold was read and none is held (card L03j). */
export const LOCKS_NONE = "none: the sender holds no integrator lease for this task, no workspace operation or freeze is on its checkout, and the sender's responsibilities hold no resource claims";

export async function startController(options: StartOptions): Promise<Controller> {
  const dir = options.dataDirectory ?? (options.storage.kind === "sqlite" ? dirname(resolve(options.storage.path)) : undefined);
  // One controller owns a data directory at a time (card K01h): a second start, or a restore swap under a running one, is refused with the holder named. The lock is taken once the environment checks have passed (a refused start creates nothing).
  const box: { lock?: DataLockKeeper } = {};
  const say = options.print ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const take = options.storage.kind !== "sqlite" || dir === undefined ? undefined : async (): Promise<DataLockKeeper | undefined> => {
    // A second controller on the same store takes the epoch and the first stops (card F04i), so a start that finds a LIVE holder goes on without the lock (told once; the keeper takes it when the holder lets go), unless it is about to swap a restore in under that holder.
    // Any other reason the lock cannot be taken (a torn lock file, a takeover in progress, ...) refuses the start.
    box.lock = await keepDataLocks([dir, dirname(resolve((options.storage as { path: string }).path))], { warn: say, ...(options.dataLockEnv ?? {}) }, { tolerateBusy: () => !existsSync(join(dir, PENDING_FILE)) && !existsSync(join(dir, JOURNAL_FILE)) });
    return box.lock;
  };
  try {
    // Whatever an internal fault says reaches the embedder's sink with credential shapes already redacted (an error can quote a command line, a header or a provider's reply).
    const sink = options.onInternalError;
    const safe: StartOptions = sink === undefined ? options : { ...options, onInternalError: redactedSink(sink) };
    const controller = await startControllerWith(safe, take);
    const close = controller.close;
    return { ...controller, close: async () => { try { await close(); } finally { await box.lock?.release(); } } };
  } catch (error) { await box.lock?.release(); throw error; }
}

async function startControllerWith(options: StartOptions, takeLock: (() => Promise<DataLockKeeper | undefined>) | undefined): Promise<Controller> {
  if (options.meetingWake !== undefined) checkMeetingWakeTimeout(options.meetingWake.timeoutMs);
  if (options.tools !== undefined && options.dispatch === undefined) throw new Error("options.tools needs options.dispatch: the tool bridge runs over the dispatcher, so without it the tools would be ignored");
  if (options.jobs !== undefined && options.tools === undefined) throw new Error("options.jobs needs options.tools: agents start jobs through the tool bridge, so without it the launcher would never be used");
  const print = options.print ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const override = overrideRequested(options.argv, options.env);
  const facts = options.facts ?? detectEnvironment();
  const dataDirectory = options.dataDirectory ?? (options.storage.kind === "sqlite" ? dirname(resolve(options.storage.path)) : undefined);
  const filesystems: FilesystemReport[] = await checkFilesystems([...(dataDirectory === undefined ? [] : [{ role: "data directory" as const, path: dataDirectory }]), ...(options.workspaceRoots ?? []).map((path) => ({ role: "workspace" as const, path }))], { platform: facts.platform, ...(options.filesystem === undefined ? {} : { detect: options.filesystem }) });
  // A controller that builds a local worker host runs agents in the sandbox on this machine, so the sandbox tools and the limits mechanism are required at start with the same found / required / install / switch message as every other prerequisite (card F04j). `features` says so explicitly (a test, or a controller whose workers are all remote).
  // Card H12k: a bad limit for local agents refuses the start, not the first attempt.
  checkLocalWorkerLimits(options.dispatch?.local?.limits);
  const features = options.features ?? (options.dispatch?.local === undefined ? [] : ["sandbox", "limits"] as const);
  const needs: PrerequisiteNeed[] = ["start", options.storage.kind, ...features];
  const prerequisites = await checkPrerequisites({ platform: facts.platform, needs, probes: { ...realProbes({ sqlite: probeSqliteLibrary, postgres: probePostgresLibrary }), ...(options.probes ?? {}) } });
  const distribution = options.distribution === undefined ? detectDistribution() : options.distribution ?? undefined;
  const host = hostLine(distribution, facts.platform, facts.arch);
  let check: StartupCheck;
  try { check = decideStartup([...checkEnvironment(facts), ...filesystems.flatMap((f) => (f.problem === undefined ? [] : [f.problem])), ...prerequisiteProblems(prerequisites)], { allowUnsupported: override, host }); } catch (error) {
    // A refusal is always shown to the operator, whoever called this.
    if (error instanceof UnsupportedEnvironmentError) print(error.message);
    throw error;
  }
  for (const line of check.output) print(line);

  let backupEncryption: BackupEncryption | undefined;
  if (options.backup?.encryption !== undefined) {
    const e = options.backup.encryption;
    try { backupEncryption = new BackupEncryption({ keyring: await readKeyringFile(e.keyringFile), keyringFile: e.keyringFile, ...(e.passcodeFile === undefined ? {} : { passcodeFile: e.passcodeFile }), ...(e.recoveryFile === undefined ? {} : { recoveryFile: e.recoveryFile }), ...(options.backup.now === undefined ? {} : { now: options.backup.now }) }); } catch { throw new Error("backups are set to be encrypted but the keyring file cannot be read or is not valid; no backup is made without it"); }
  }
  let storage: ControllerStorage;
  // A restore the owner prepared from inside the previous run is swapped in now, before the database is opened (card K01h).
  const dataLock = takeLock === undefined ? undefined : await takeLock();
  // A database transfer (card F04e) decides which database is the authoritative one: an interrupted transfer is settled and a start on any other database is refused, before anything is opened.
  const sourcePlace: TransferSource = options.storage.kind === "sqlite" ? { kind: "sqlite", fingerprint: await sqliteFingerprint(options.storage.path), name: "the SQLite database" } : { kind: "postgres", fingerprint: postgresFingerprint(options.storage.url, options.storage.schema), name: "the PostgreSQL database" };
  const stateInput = options.transfer?.stateDirectory;
  if (stateInput !== undefined && !isAbsolute(stateInput)) throw new Error("transfer.stateDirectory must be an absolute path (it is the one fixed place of the transfer journal and authority file)");
  const stateDirectory = stateInput === undefined ? undefined : await canon(stateInput);
  // Destinations from the configuration are built now (a bad entry stops the start with its index and problem), and joined to the ones the host gave.
  const configuredTargets = options.transfer?.targetEntries === undefined ? [] : await transferTargetsFromConfig(options.transfer.targetEntries, { openStorage: (path) => SqliteStorage.open({ path }), statfs: (path) => statfs(path),
    ...(options.transfer.secrets === undefined ? {} : { postgres: postgresTargetDeps(options.transfer.secrets) }) });
  const transferTargets: readonly TransferTarget[] = [...(options.transfer?.targets ?? []), ...configuredTargets];
  for (const [i, t] of transferTargets.entries()) {
    const twin = transferTargets.findIndex((o, j) => j < i && (o.name === t.name || o.fingerprint === t.fingerprint));
    if (twin >= 0) throw new Error(`database transfer targets: ${t.name} is the same name or the same place as ${transferTargets[twin]!.name}`);
  }
  if (transferTargets.length > 0 && stateDirectory === undefined) throw new Error("database transfer targets are configured without a transfer state directory (transfer.stateDirectory): the journal and the authority file need one fixed place that does not depend on a database path");
  const piState = options.backup?.piState ?? options.dispatch?.local?.piState?.source;
  const piFinal = options.backup?.restore?.piFinal ?? options.dispatch?.local?.piState?.final;
  // An existing database that is about to be upgraded to a newer schema is copied first, when backups are configured (card K01): if the copy cannot be made, the upgrade does not happen.
  const beforeUpgrade: BeforeUpgrade | undefined = options.backup === undefined ? undefined : async (notice) => {
    // Signed with the key in the secret store (card K01b3), so a restore of it on a signing installation is not refused as unsigned; the database, and so the signing record, is not open yet.
    const signing = options.backup!.signing;
    const signer = signing === undefined ? undefined : await BackupSigningService.storeSigner(signing.store, signing.secretName);
    await createBackup({ snapshot: notice.snapshot }, { root: options.backup!.directory, kind: "pre-upgrade", version: options.backup!.version ?? "0.0.0", ...(options.backup!.now === undefined ? {} : { now: options.backup!.now }), ...(backupEncryption === undefined ? {} : { encryption: backupEncryption.keyring }), ...(piState === undefined ? {} : { piState }), ...(signer === undefined ? {} : { signer }) });
    print(`The database is being upgraded from schema ${notice.from} to ${notice.to}; a backup of it as it was is in ${options.backup!.directory}.`);
  };
  // Settling the journal is a short step under the state folder's lock, so two starts (or a start and a transfer) cannot each see the files before the other changed them. The lock is NOT held across the slow work that follows (a staged
  // restore's swap, the migrations of the database); the holder check is made under it again, and the epoch is taken with the epoch that check read (card F04m), so nothing slips in between.
  if (stateDirectory !== undefined) await withStateLock(stateDirectory, async () => { const settled = await guardStart(stateDirectory, sourcePlace, undefined, "later"); if (settled.note !== undefined) print(settled.note); }, { wait: true });
  let seenEpoch: number | undefined;
  {
    if (options.storage.kind === "sqlite" && dataDirectory !== undefined) await applyPendingRestore(dataDirectory, resolve(options.storage.path), print, { ...(piFinal === undefined ? {} : { piFinal }), ...(dataLock === undefined || !(await dataLock.isHeld()) ? {} : { lock: dataLock }) });
    // PostgreSQL (card K01i): a restore staged in a new schema is swapped in before the schema is opened; the marker, key and journal are in the data directory the host gave.
    if (options.storage.kind === "postgres" && dataDirectory !== undefined) await applyPendingRestore(dataDirectory, { postgres: { url: options.storage.url, schema: options.storage.schema ?? "nimblenewt" } }, print, { ...(piFinal === undefined ? {} : { piFinal }) });
    if (options.storage.kind === "postgres") {
      const pg = await PostgresStorage.open({ connectionString: options.storage.url, allowUnsupportedServer: override, ...(beforeUpgrade === undefined ? {} : { beforeUpgrade }), ...(options.storage.schema === undefined ? {} : { schema: options.storage.schema }), ...(options.storage.maxConnections === undefined ? {} : { maxConnections: options.storage.maxConnections }), ...(options.storage.minimumServerVersionNum === undefined ? {} : { minimumServerVersionNum: options.storage.minimumServerVersionNum }) }).catch((error: unknown) => { if (error instanceof Error && error.message.startsWith("NimbleNewt will not start")) print(error.message); throw error; });
      storage = pg;
      const server = pg.unsupportedServer;
      if (server !== undefined) {
        // Only reachable with the override: the adapter refused otherwise. Fold the server into the one decision, so it is printed and audited with the rest (the notice is printed once, covering everything).
        const full = overriddenCheck([...check.problems, server], check.host ?? host);
        // When an operating-system or Node.js problem already printed the notice, only the server's own line is new.
        for (const line of check.output.length === 0 ? full.output : full.output.filter((l) => l.includes(`${server.item}: found ${server.found}`))) print(line);
        check = full;
      }
    } else {
      storage = await SqliteStorage.open({ path: options.storage.path, allowNetworkFilesystem: override, ...(beforeUpgrade === undefined ? {} : { beforeUpgrade }) });
    }
    // A database a transfer left stays fenced inside the database itself: it starts only if the authority file names it for that transfer (checked before the epoch is taken, under the state lock, and again guarded by the transfer files).
    try {
      if (stateDirectory === undefined) seenEpoch = await assertNotFenced(stateDirectory, sourcePlace, storage);
      else {
        await withStateLock(stateDirectory, async () => { const settled = await guardStart(stateDirectory, sourcePlace, undefined, storage); if (settled.note !== undefined) print(settled.note); seenEpoch = await assertNotFenced(stateDirectory, sourcePlace, storage); }, { wait: true });
      }
    } catch (error) { await storage.close().catch(() => undefined); throw error; }
  }
  if (seenEpoch !== undefined) storage = expectEpochOnFirstTake(storage, seenEpoch);
  // Retention in front of writes (card K06): the disk-full reserve and the optional quotas. The meter reads the unwrapped storage; the settings the guard consults are wired below once the epoch is known.
  const reserve = dataDirectory === undefined ? undefined : new ReserveFile(join(dataDirectory, ".nn-reserve"));
  const quotaMeter = new QuotaMeter(storage);
  let currentRetention: () => Promise<RetentionValues> = async () => ({ ...RETENTION_DEFAULTS, ...(options.retention?.defaults ?? {}) });
  storage = guardStorage(storage, { ...(reserve === undefined ? {} : { reserve }), meter: quotaMeter, values: () => currentRetention() });

  let dispatch: DispatchHandle | undefined;
  let transferLive: DatabaseTransferService | undefined;
  let toolsLive: ToolExecutionService | undefined;
  let jobRuns: LocalJobRuns | undefined;
  try {
    const projects = await ProjectService.open(storage, { holder: options.holder ?? "controller" });
    const epoch = projects.epoch;
    // Jobs admitted before this moment were live under an earlier controller: the start-up rule decides them (card T07b).
    const startedAt = new Date().toISOString();
    // The retention policy (card K06): the owner's chat settings over the installation defaults. Cached for a few seconds for the write guard; a change refreshes it and sets the reserve again.
    let retentionCache: { at: number; values: RetentionValues } | undefined;
    const retentionSettings: RetentionSettingsService = RetentionSettingsService.withEpoch(storage, epoch, {
      ...(options.retention?.defaults === undefined ? {} : { defaults: options.retention.defaults }),
      onChange: async (values) => { retentionCache = { at: Date.now(), values }; quotaMeter.invalidate(); await dataLock?.setStaleMinutes(values.dataLockStaleMinutes).catch(() => undefined); await reserve?.apply(values.reserveBytes).catch((error: unknown) => print(`The retention reserve could not be set: ${error instanceof Error ? error.message : String(error)}`)); },
    });
    currentRetention = async () => { if (retentionCache !== undefined && Date.now() - retentionCache.at < 5_000) return retentionCache.values; const values = await retentionSettings.effective(); retentionCache = { at: Date.now(), values }; return values; };
    await currentRetention().then((v) => dataLock?.setStaleMinutes(v.dataLockStaleMinutes)).catch(() => undefined);
    try { await reserve?.apply((await currentRetention()).reserveBytes); } catch (error) { print(`The retention reserve could not be set: ${error instanceof Error ? error.message : String(error)}`); }
    // The backup public key is pinned the first time it is loaded; a different one is refused until the owner approved its fingerprint (card K01b).
    const backupKeyPin = backupEncryption === undefined ? undefined : BackupKeyPinService.withEpoch(storage, epoch);
    const backupClock = options.backup?.now === undefined ? {} : { clock: () => options.backup!.now!().toISOString() };
    const backupEncryptionSetting = options.backup === undefined ? undefined : BackupEncryptionSettingService.withEpoch(storage, epoch, { ...backupClock, keyringConfigured: backupEncryption !== undefined });
    // An installation that has made encrypted backups does not quietly go plain because the configuration lost its keyring: that needs the owner's recorded switch-off (card K01b3).
    if (backupEncryption === undefined && backupEncryptionSetting !== undefined && await BackupKeyPinService.withEpoch(storage, epoch).hasPin() && (await backupEncryptionSetting.effective()).enabled) {
      throw new Error("this installation has made encrypted backups, but the configuration no longer names a keyring file; no plain backup is made. Restore the keyring option, or have the owner switch backup encryption off (backup.encryption.set) first.");
    }
    // An installation that has signed backups does not quietly go unsigned (and its restores unchecked) because the configuration lost the signing option (card K01b3).
    if (options.backup !== undefined && options.backup.signing === undefined && await BackupSigningService.hasRecord(storage)) {
      throw new Error("this installation signs its backups, but the configuration no longer gives the signing key's secret store; no unsigned backup is made and no restore goes unchecked. Restore the signing option.");
    }
    const backupSigning = options.backup?.signing === undefined ? undefined : BackupSigningService.withEpoch(storage, epoch, options.backup.signing.store, { ...backupClock, ...(options.backup.signing.secretName === undefined ? {} : { secretName: options.backup.signing.secretName }) });
    if (backupSigning !== undefined) {
      const signing = await backupSigning.ensure();
      print(signing.first ? `Backups are signed; the signing key (${signing.keyId.slice(0, 16)}) is made and its public half recorded. Save the public key off this machine (backup.signing.status).` : signing.changed ? `Warning: the signing key in the secret store is not the one last recorded; it is now recorded as a new generation (${signing.keyId.slice(0, 16)}). If you did not change it, check the secret store.` : `Backups are signed (key ${signing.keyId.slice(0, 16)}).`);
    }
    if (backupEncryption !== undefined) {
      await backupEncryption.attachProofStore(BackupProofStore.withEpoch(storage, epoch));
      const pinned = await backupKeyPin!.check(backupEncryption.keyring);
      print(pinned.first ? `Backups are encrypted; the backup key (fingerprint ${pinned.fingerprint}) is now pinned to this installation.` : pinned.approved ? `The backup key was replaced with the one the owner approved (fingerprint ${pinned.fingerprint}).` : `Backups are encrypted (fingerprint ${pinned.fingerprint}).`);
      for (const warning of backupEncryption.warnings()) print(`Warning: ${warning}.`);
    }
    // Card F04k: the workspaces are the checkouts of the registered projects, so their file systems are checked at every start, not only for roots the caller listed. Registered checkouts exist only once the
    // storage is open, so the decision is made again with these problems added: refused unless the F04h override was given, and then audited with the rest.
    const roots = await checkoutRoots(storage, new Set((options.workspaceRoots ?? []).map((r) => resolve(r))));
    if (roots.length > 0) {
      const reports = await checkFilesystems(roots.map((path) => ({ role: "workspace" as const, path })), { platform: facts.platform, ...(options.filesystem === undefined ? {} : { detect: options.filesystem }) });
      filesystems.push(...reports);
      const extra = reports.flatMap((f) => (f.problem === undefined ? [] : [f.problem]));
      if (extra.length > 0) {
        try {
          const decided = decideStartup([...check.problems, ...extra], { allowUnsupported: override, host: check.host ?? host });
          for (const line of check.output.length === 0 ? decided.output : decided.output.filter((l) => extra.some((p) => l.includes(`${p.item}: found ${p.found}`)))) print(line);
          check = decided;
        } catch (error) {
          if (error instanceof UnsupportedEnvironmentError) print(error.message);
          throw error;
        }
      }
    }
    await recordHost(storage, epoch, check.host ?? host);
    await recordOverride(storage, epoch, check);
    const principals = PrincipalService.withEpoch(storage, epoch);
    const taskCredentials = TaskCredentialService.withEpoch(storage, epoch);
    const agreedLimits = AgreedLimitsSettingsService.withEpoch(storage, epoch);
    const grants = GrantService.withEpoch(storage, epoch, { agreedLimits: () => agreedLimits.effective() });
    const catalog = HarnessCatalog.of(options.harnesses ?? []);
    const contracts = ContractService.withEpoch(storage, epoch);
    const assignments = AssignmentService.withEpoch(storage, epoch, projects, { attemptGate: async (taskId, harness) => catalog.checkAttempt(await contracts.recoveryOf(taskId), harness) });
    const waits = WaitService.withEpoch(storage, epoch, assignments);
    const desks = DeskService.withEpoch(storage, epoch);
    const histories = HistoryService.withEpoch(storage, epoch);
    const retrieval = RetrievalService.withEpoch(storage, epoch, desks, histories);
    const inquiries = InquiryService.withEpoch(storage, epoch, { histories, retrieval, waits, assignments });
    const agents = AgentService.withEpoch(storage, epoch);
    await agents.seedStandardRoles(); // the standard role templates exist on a new installation (card H11b)
    // Card L01: the pause gates supply the availability the conversations and the reviews consult, so a paused agent's messages are queued and a paused reviewer is skipped; whatever else the lifecycle reports (suspended, stopped) comes through `options.availability`.
    // Card M04h: unless the embedding application supplies its own wake path, the controller is the host for the owner's meeting wake: an agent a finished stop holds reports stopped (not paused) and available for the one open meeting it was woken for.
    let wakeHost: MeetingWakeHost | undefined;
    const pauses = PauseService.withEpoch(storage, epoch, { waits }, { ...(options.availability === undefined ? {} : { otherAvailability: options.availability }), ...(options.meetingWake !== undefined ? {} : { pausedAvailability: (p: string, o?: { readonly meetingWake?: boolean }) => wakeHost?.availability(p, o) ?? Promise.resolve(undefined) }) });
    // Suspected stalls: a task under a pause is assessed as paused, never as stalled (card L01).
    // The routing table is refused unless the coordinator, the safety supervisor and every other role in it have a valid fallback list (card R04).
    const routing = RoutingService.withEpoch(storage, epoch, {}, {});
    const setupReadiness = SetupReadinessService.withEpoch(storage, epoch);
    const setupProviders = SetupProviderService.withEpoch(storage, epoch, {}, {});
    const localHost = LocalHostSettingService.withEpoch(storage, epoch);
    // A speed given in the start options wins; otherwise the reading speed a route declares in the routing table is used until the route has been measured (card V01c).
    const declaredSpeed: NonNullable<StartOptions["stall"]>["declaredSpeed"] = async (route, hostId) => {
      const given = options.stall?.declaredSpeed === undefined ? undefined : await options.stall.declaredSpeed(route, hostId);
      if (given?.readTokensPerSecond !== undefined) return given;
      const entry = (await routing.get())?.routes[route];
      return entry?.readTokensPerSecond === undefined ? undefined : { readTokensPerSecond: entry.readTokensPerSecond };
    };
    // How long an undecided concern waits at each level of the supervisor ladder: the owner's setting, else the installation's `stall.escalateAfterMs`, else 24 hours (owner decision 2026-10-30, supervisor ladder).
    const escalationLadder = EscalationLadderService.withEpoch(storage, epoch);
    // The recovery action ladder (card V02c): its effects are bound below, once the services they use are built.
    const recoveryLadder = RecoveryLadderService.withEpoch(storage, epoch);
    let recoveryRun: RecoveryEffects | undefined;
    // The automatic recovery steps (card V02c) run in the dispatcher's tick (loop `recovery.auto-step`) and judge "no answer in time" by the stall service's clock, which is the dispatcher's unless one is given for stall detection.
    const stallClock = options.stall?.clock ?? options.dispatch?.clock;
    const stall = StallService.withEpoch(storage, epoch, assignments, waits, { ...(options.stall ?? {}), ...(stallClock === undefined ? {} : { clock: stallClock }), recoveryPolicy: () => recoveryLadder.policy(), recoveryEffects: { run: (action, ctx) => (recoveryRun ?? (() => { throw new DomainError("unavailable", "recovery steps are not available yet"); })()).run(action, ctx), unavailable: (action, ctx) => (recoveryRun?.unavailable?.(action, ctx) ?? Promise.resolve(undefined)) }, ladderHours: () => escalationLadder.hours(), ladderDamaged: async (n) => { await notifications.emitFromController({ commandId: n.id, kind: "maintenance", level: "needs-you", ref: { kind: "principal", id: "dispatcher" }, detail: n.detail }); }, declaredSpeed, isPaused: (taskId) => pauses.isPaused(taskId) });
    // Durable job records (card T07): a permitted background job's result goes to the pause service; no MCP connection check is bound until an MCP client exists, so no MCP operation is admitted.
    // The time a job or a review took is charged to its task by the dispatcher's budget service once that is built; a charge that fails is reported, and the job or review stands (card R05f).
    const charged = async (usage: { commandId: string; activity: "review" | "background-job"; taskId: string; agentId?: string; computeMs: number }): Promise<void> => { try { await dispatch?.chargeUse(usage); } catch (error) { options.onInternalError?.(error); } };
    // Card T07b: the dispatcher's principal is the job host (it runs agents' jobs here and decides the live ones at start); a stop asked for any job reaches the process that runs it here; an MCP operation is admitted only on an approved server.
    const mcpForJobs = McpService.withEpoch(storage, epoch);
    const jobs = JobService.withEpoch(storage, epoch, { pauses }, { host: DISPATCHER_PRINCIPAL, connections: { usable: (serverId) => mcpForJobs.usable(serverId) }, onCancel: (jobId, force) => { void jobRuns?.stop(jobId, force).catch((error: unknown) => options.onInternalError?.(error)); }, background: (principal, request) => pauses.recordFinishedJob(principal, request), longRunningGate: createMeetingGate({ attendance: () => (dispatch === undefined ? undefined : { service: dispatch.attendance, by: dispatch.principal }), ownerOf: async (taskId) => { const owner = (await assignments.getAssignment(taskId))?.owner; return owner?.kind === "agent" ? `agent:${owner.id}` : undefined; } }), longRunningLocks: async () => (dispatch === undefined ? [] : dispatch.attendance.meetingLocks()), onUsage: (u) => charged({ commandId: u.commandId, activity: "background-job", taskId: u.taskId, computeMs: u.computeMs }), wakes: true });
    // The reviewer's host is the one its running attempt is on, or the host a moved attempt is pinned to (known once the dispatcher is built); without one, or when the lookup fails, the host is not judged.
    const reviews = ReviewService.withEpoch(storage, epoch, {
      onDecided: async (e) => { await activity.record({ id: "service:reviews", kind: "service", name: "reviews", grants: [] } as Principal, { commandId: `rev-act:${e.requestId}:${e.verdict}`, taskId: e.taskId, kind: "approval", summary: `${e.decidedBy} ${e.verdict === "allow" ? "approved" : "denied"} ${e.tool}: ${e.reason}`, manifest: { refs: [{ kind: "review", id: e.requestId }] } } as never); },
      onUsage: (u) => charged({ commandId: u.commandId, activity: "review", taskId: u.taskId, agentId: u.agentId, computeMs: u.computeMs }), availability: pauses.workAvailability /* a meeting wake does not make a stopped agent a reviewer (card M04h) */, reviewerHost: async (principalId) => { try { return await dispatch?.hostOfAgent(principalId); } catch { return undefined; } } });
    const graph = WaitGraphService.withEpoch(storage, epoch, contracts, BlockerService.withEpoch(storage, epoch), { extraEdges: (projectId, tasks) => reviews.waitEdges(projectId, tasks) });

    // Where local-only data may go: the owner's setting over the approval profile's default, consulted at every placement on a remote host unless the operator gave a placement policy of their own (card H07c).
    const placement = PlacementSettingsService.withEpoch(storage, epoch);
    // A move of an attempt (the owner's, or the quiet-host pass's) judges the data location by the same setting when the controller supplies the placement policy and the operator gave no relocation policy: a host the owner lets hold local-only data at a placement may hold it after a move.
    const reconnectSettings = ReconnectSettingsService.withEpoch(storage, epoch);
    const reconnect = { get: (by: Principal) => reconnectSettings.get(by), set: (owner: Principal, command: Parameters<typeof reconnectSettings.set>[1]) => reconnectSettings.set(owner, command), decideReaccept: (owner: Principal, command: never) => { if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not decide on taking an attempt up again`); if (dispatch?.remote === undefined) throw new DomainError("unavailable", "remote workers are not running"); return dispatch.remote.decideReaccept(owner, command); }, pending: (owner: Principal, page: { after?: string; limit?: number }) => { if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not list the attempts waiting for a decision`); if (dispatch?.remote === undefined) throw new DomainError("unavailable", "remote workers are not running"); return dispatch.remote.pending(owner, page); } };
    const withPlacement = <T extends NonNullable<StartOptions["dispatch"]>>(dispatch: T): T => (dispatch?.remote === undefined || (dispatch.remote.placementPolicy !== undefined && dispatch.remote.reaccept !== undefined && dispatch.remote.patienceMs !== undefined && dispatch.remote.confirmWindowMs !== undefined) ? dispatch : Object.create(dispatch, { remote: { value: { ...dispatch.remote, ...(dispatch.remote.placementPolicy === undefined ? { placementPolicy: placement.policy(), ...(dispatch.remote.relocationPolicy === undefined ? { relocationPolicy: async () => ({ dataHosts: [...((await placement.policy()()).dataHosts ?? [])] }) } : {}) } : {}), ...(dispatch.remote.reaccept === undefined ? { reaccept: () => reconnectSettings.effective() } : {}), ...(dispatch.remote.patienceMs === undefined ? { patienceMs: () => reconnectSettings.patienceMs() } : {}), ...(dispatch.remote.confirmWindowMs === undefined ? { confirmWindowMs: () => reconnectSettings.confirmWindowMs() } : {}) }, enumerable: true } }) as T); // not a spread: the options are read when the dispatcher is built, not here
    const configuration = ConfigurationService.withEpoch(storage, epoch, { routing, settings: MEETING_SETTINGS });
    const conversations = ConversationService.withEpoch(storage, epoch, { availability: pauses.availability });
    const resources = ProjectResourceService.withEpoch(storage, epoch);
    const plans = ProjectPlanService.withEpoch(storage, epoch);
    const responsibilities = ResponsibilityService.withEpoch(storage, epoch);
    const responsibilityChecks = ResponsibilityChecks.withEpoch(storage, epoch, responsibilities);
    const incidents = IncidentService.withEpoch(storage, epoch, responsibilities);
    const leases = MaintenanceLeaseService.withEpoch(storage, epoch, responsibilities, incidents);
    const coverageSettings = CoverageSettingsService.withEpoch(storage, epoch);
    const coverage = CoverageService.withEpoch(storage, epoch, coverageSettings);
    // Questions to the owner (card U12): agents ask through the API, the owner sees and answers them; the owner is told through the notifications.
    // The plain 09:00 digest gives way to scheduled stand-ups (card U11d) when they carry every decision it would tell: the active stand-ups of live projects. The stand-up service starts with the dispatcher; until then, or when it fails, none is known and the owner is told.
    const standupProjects = async (): Promise<ReadonlySet<string>> => {
      const live = dispatch?.standups as unknown as { activeProjects?: () => Promise<ReadonlySet<string>> } | undefined;
      if (live?.activeProjects === undefined) return new Set();
      return live.activeProjects();
    };
    // The critical path the owner marked (card U11d, "U11f"): ranks the Needs-you view and the digest and is watched for the Urgent trigger.
    const critical = CriticalPathService.withEpoch(storage, epoch, { edges: (projectId) => contracts.activeEdges(projectId), ...(options.notifications?.clock === undefined ? {} : { clock: options.notifications.clock }) });
    const notifications = NotificationService.withEpoch(storage, epoch, { standupProjects, holdsUp: () => critical.holdsUp(), timeZone: async () => { const v = await configuration.installationValue("meeting.timeZone"); return typeof v === "string" ? v : undefined; }, ...(options.notifications?.channels === undefined ? {} : { channels: options.notifications.channels }), ...(options.notifications?.clock === undefined ? {} : { clock: options.notifications.clock }) });
    const messages = AgentMessageService.withEpoch(storage, epoch, {
      onSent: async (e) => { await activity.record({ id: "service:messages", kind: "service", name: "messages", grants: [] } as Principal, { commandId: `msg-act:${e.messageId}`, taskId: e.taskId, kind: e.ownerSent ? "owner-message" : "agent-message", summary: `${e.sender} sent ${e.to} a ${e.class} message: ${e.purpose}`, manifest: { refs: [{ kind: "agent-message", id: e.messageId }] } } as never); },
      availability: pauses.availability, taskPaused: (t) => pauses.isPaused(t), guard: (t) => pauses.guard(t), waits, assignments, inquiries, notifications });
    const branches = ContextBranchService.withEpoch(storage, epoch, { histories, retrieval });
    // Decisions recorded here block the next action of affected tasks through the stored guard; interrupting a generation already running is the dispatcher's own instance of the service (card C08b).
    const decisions = DecisionService.withEpoch(storage, epoch, { events: EventService.withEpoch(storage, epoch), effects: EffectService.withEpoch(storage, epoch, assignments) });
    // A new request for more budget tells the owner when it is addressed to them (card R05c). Only the controller's own facts go in the notice, never the requester's words.
    const notifyAggregate: NotifyAggregate = async (n) => { await notifications.emitFromController({ commandId: `bgt-agg-${n.noticeId}`, kind: "maintenance", level: "needs-you", ref: { kind: "budget-aggregate", id: n.noticeId }, detail: `${n.text.slice(0, 400)} Change it with budget.aggregate.set.` }); };
    const budgets = BudgetService.withEpoch(storage, epoch, { agreedLimits: () => agreedLimits.effective(), notifyAggregate, notify: async (n) => { if (n.to === "owner") await notifications.emitFromController({ commandId: `bgt-req-${n.requestId}`, kind: "maintenance", level: "needs-you", ref: { kind: "budget-request", id: n.requestId }, detail: `${n.requestedBy} asked for more budget for task ${n.taskId} (${n.costMicros} millionths, ${n.computeMs} ms of compute). Decide it with budget.decide.` }); else if (n.to.startsWith("agent:")) { const { purpose, text } = holderNotice(n); await messages.noticeFromController({ commandId: `bgt-hold-${n.requestId}`, taskId: n.parentTaskId ?? n.taskId, to: n.to, purpose, text, admit: "budget.manage" }); } } });
    // Event watches (card H13): an agent's watch on a stream, its handling attempts and the failed queue, which the status answers and the state API read.
    const watchService = WatchService.withEpoch(storage, epoch, { events: EventService.withEpoch(storage, epoch), inbox: InboxService.withEpoch(storage, epoch, assignments), assignments, projects });
    // A schedule that names no zone uses the owner's `meeting.timeZone` setting (card M01c).
    const invitationInbox = InvitationInbox.withEpoch(storage, epoch);
    const meetingLead = async (): Promise<number> => { const v = await configuration.installationValue("meeting.leadMinutes"); return typeof v === "number" ? v : MEETING_LIMITS.leadDefault; };
    const meetings = MeetingService.withEpoch(storage, epoch, { inquiries }, { ...(options.dispatch?.clock === undefined ? {} : { clock: options.dispatch.clock }) /* the meeting service creates the occurrences the dispatcher's attendance looks for, so both read one clock */, availability: pauses.availability, leadMinutes: meetingLead, ownerTimeZone: async () => { const v = await configuration.installationValue("meeting.timeZone"); return typeof v === "string" ? v : undefined; } });
    // The host's workspace port is reached only through this closure, which the dispatch composer fills in (card H12m): there is no other way to it from outside the workspace service.
    let workspacePort: ((taskId: string) => Promise<WorkspacePort | undefined>) | undefined;
    // The integrator leases of landing (card P10), on the controller's own clock (the one the meetings and the dispatcher read). A landing is made only under the project's lease on the landing branch the owner's policy names.
    const integratorLeases = IntegratorLeaseService.withEpoch(storage, epoch, { ...(options.dispatch?.clock === undefined ? {} : { clock: options.dispatch.clock }) });
    const integratorLeaseOps = new IntegratorLeaseOps(integratorLeases, { activeAgent: async (agentId) => { const p = await principals.get(`agent:${agentId}`); return p !== undefined && p.kind === "agent" && p.state === "active"; } });
    const landingBranchOf = landingPolicyFrom(configuration, (projectId) => branchSettings.landingOf(projectId));
    const workspaceOps = WorkspaceOpService.withEpoch(storage, epoch, {
      landingLease: async (by, call) => {
        let branch: string | undefined;
        try { branch = (await landingBranchOf(call)).branch; } catch { throw new DomainError("unavailable", "the landing settings could not be read, so no lease can be matched to the landing branch; nothing was landed"); }
        return integratorLeaseOps.checkLanding(by, { ...call, branch });
      },
      notify: async (n) => { await notifications.emitFromController({ commandId: n.commandId, kind: "maintenance", level: "needs-you", ref: { kind: "task", id: n.taskId }, detail: n.text }); },
      quiesce: { around: (scope, operation, run, after, tag, status) => dispatch === undefined ? run({ attempts: [] }) : dispatch.quiesce.around(scope, operation, run, after, tag, status) },
      portOf: async (taskId) => workspacePort?.(taskId),
      assignee: async (taskId) => { const a = await assignments.getAssignment(taskId); return a?.state === "assigned" ? a.owner?.id : undefined; },
      attempts: { live: async (taskId) => (await dispatch?.attemptControl.live(taskId)) ?? [], frozenReason: async (id) => dispatch?.attemptControl.frozenReason(id), release: async (id) => { await dispatch?.attemptControl.release(id); }, tell: async (id, text) => (await dispatch?.attemptControl.tell(id, text)) ?? false, stop: async (id, reason) => { await dispatch?.attemptControl.stop(id, reason); } },
    });
    const blobStore = options.artifacts === undefined ? undefined : await FileBlobStore.open({ directory: options.artifacts.directory });
    // Card C09h: an artifact published for a task through the API (by the owner, or by an agent, including a local worker through its tool bridge) is an `artifact-version` step of the task's activity.
    // The step is keyed by the artifact, so a repeated publish shows once; the name is the publisher's words and is quoted as such. Remote workers' artifacts are recorded by the dispatch composer's own service.
    const checked = blobStore === undefined ? undefined : ArtifactService.withEpoch(storage, epoch, blobStore, {
      onPublished: async (e) => { await activity.record({ id: "service:artifacts", kind: "service", name: "artifacts", grants: [] } as Principal, { commandId: `artv:${e.artifactId}`, taskId: e.taskId, kind: "artifact-version", summary: `${e.actor} published artifact ${JSON.stringify(e.name)} (${e.files} file${e.files === 1 ? "" : "s"}).`, manifest: { refs: [{ kind: "artifact", id: e.artifactId }] } } as never); },
    });
    // Replay reads: a reviewer reads only a task it was asked to review and sensitive content needs `history.sensitive.read` (card U09). The review-assignment source is the one the submissions use (Q01c): until it is composed (as it is not for submissions) no reviewer reads a task's activity.
    // A host reads the activity of a task only while it holds a live attempt of it (the attempts come from the dispatcher when it is composed; without one no host reads any task's steps).
    const activity = ActivityService.withEpoch(storage, epoch, {
      roles: (_id, scope, by) => agents.rolesOfPrincipalIn(by, scope.projectId, new Date().toISOString()),
      hostOwnsAttempt: async (hostId, taskId) => {
        for (const attemptId of (await dispatch?.attemptControl.live(taskId)) ?? []) {
          const found = await storage.getAggregate({ kind: "dispatch", id: attemptId });
          if ((found?.body as { hostId?: unknown } | undefined)?.hostId === hostId) return true;
        }
        return false;
      },
    });
    // Replay reads the activity records (card U09) and, for the owner's explicit look, the kept thinking (card U09b); the context-branch registry is not composed yet, so no side line is verified.
    const replayLimits = ReplayLimitsService.withEpoch(storage, epoch);
    // Card U09b: the thinking the workers report is kept by the store (bounded, redacted, owner switch, removed by the retention rule thinkingDays); the owner's reads go through ThinkingService (inspection policy, redaction, a recorded look).
    const thinkingStore = ThinkingStore.withEpoch(storage, epoch);
    const thinkingService = ThinkingService.withEpoch(storage, epoch, thinkingStore.source(), InspectionService.withEpoch(storage, epoch));
    const replay = ReplayService.withEpoch(storage, epoch, activity, { limits: replayLimits, thinking: thinkingService, thinkingRemoval: thinkingStore });
    // The stop service is built after the status service (it uses the pause service), so the readiness view reaches it through this.
    let maintenanceLive: MaintenanceService | undefined;
    const unavailableMaintenance = (): never => { throw new DomainError("unavailable", "environment change requests are not ready yet"); };
    const environments = EnvironmentService.withEpoch(storage, epoch, { reservedDigest: (name) => catalogService.systemDigest(name), skillUsable: (by, versionId) => catalogService.usableVersion(by, versionId) });
    let stopsLive: StopService | undefined;
    // Built further down; the routing status view (card R04c) reads it through these.
    let cutoverLive: CutoverService | undefined;
    const cutoverNow = (): CutoverService => { if (cutoverLive === undefined) throw new DomainError("unavailable", "routing controls are not ready"); return cutoverLive; };
    // The meeting record service is built after the status service (it needs the grants and budgets); the chat reading of the decision log reaches it when it is there (card M02g).
    let recordsLive: MeetingRecordService | undefined;
    let resumesLive: ResumeCheckService | undefined;
    // Built further down too; the owner's release status view (card X09b part 2) reads the tests and the staging through these.
    let releaseLive: ReleaseService | undefined;
    const releaseNow = (): ReleaseService => { if (releaseLive === undefined) throw new DomainError("unavailable", "release testing is not ready"); return releaseLive; };
    let activationLive: ReleaseActivationService | undefined;
    // Card C07i: the starting-size watch's records, read by the task status, the start_size view and the state API (the dispatcher's guards write them).
    const startSizes = StartSizeService.withEpoch(storage, epoch);
    // The approval views (cards A07b, A07c; U08): the load figures, the standing-rule proposals and the profile suggestion. A proposal is accepted against the owner's grants.maxDays setting, read for the accepting owner.
    const approvalPolicy = PolicyService.withEpoch(storage, epoch, grants, { roles: (id) => agents.rolesOfPrincipal(id) });
    const profileSuggestion = ProfileSuggestionService.withEpoch(storage, epoch, approvalPolicy);
    const approvalLoad = ApprovalLoadService.withEpoch(storage, epoch, grants, { profile: profileSuggestion });
    const approvals: ApprovalsFacade = {
      load: {
        load: (by, days) => approvalLoad.load(by, days), proposals: (by, state) => approvalLoad.proposals(by, state), propose: (by, c) => approvalLoad.propose(by, c),
        accept: async (by, c) => ApprovalLoadService.withEpoch(storage, epoch, grants, { profile: profileSuggestion, maxDays: async () => { const v = (await configuration.effective(by))?.values["grants.maxDays"]?.value; return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 ? v : undefined; } }).accept(by, c),
        acceptBySwitching: (by, c) => approvalLoad.acceptBySwitching(by, c), dismiss: (by, c) => approvalLoad.dismiss(by, c),
      },
      suggestion: { check: (by) => profileSuggestion.check(by), answer: (by, c) => profileSuggestion.answer(by, c) },
    };
    const status = StatusService.withEpoch(storage, epoch, { wakes: async () => (wakeHost === undefined || options.meetingWake !== undefined ? undefined : wakeHost.list()), approvals, agents: { list: (by, q) => agents.list(by, q), coordinator: async (owner) => coordinator?.get(owner) }, critical: { holdsUp: () => critical.holdsUp(), list: (by) => critical.list(by) }, webAccess: () => webAccessPort, setup: setupReadiness, landing: () => configuration.installationSettings(Object.values(LANDING_SETTING_KEYS)), landingProjects: async () => { const lands = await branchSettings.landings(); const found = await configuration.projectSettings(Object.values(LANDING_SETTING_KEYS), lands.map((l) => l.projectId)); return { projects: found.projects.map((p) => { const branch = lands.find((l) => l.projectId === p.projectId)?.branch; return { ...p, ...(branch === undefined ? {} : { branch }) }; }), truncated: found.truncated }; }, environments, maintenance: { list: (by, q) => (maintenanceLive ?? unavailableMaintenance()).list(by, q), get: (by, id) => (maintenanceLive ?? unavailableMaintenance()).get(by, id) }, ...(options.transfer === undefined || transferTargets.length === 0 || stateDirectory === undefined ? {} : { databaseTransfer: { status: async () => (transferLive ?? ((): never => { throw new DomainError("unavailable", "the database transfer is not running"); })()).status(), settings: async () => (transferLive ?? ((): never => { throw new DomainError("unavailable", "the database transfer is not running"); })()).settings() } }), startSizes, jobs, assignments, waits, blockers: BlockerService.withEpoch(storage, epoch), contracts, pauses, revocations: { list: (by, query) => catalogService.revocations(by, query) }, reconnect: { get: (by) => reconnect.get(by), pending: (by, page) => reconnect.pending(by, page) }, catalogPolicy: { get: (by) => catalogPolicy.get(by) }, routes: { controls: () => cutoverNow().controls(), report: (by, q) => cutoverNow().report(by, q), healthStates: (limit) => cutoverNow().healthStates(limit), budgets: async () => Promise.all(Object.entries((await routing.get())?.routes ?? {}).map(async ([route, e]) => { const kind = options.dispatch?.cache?.endpoints[route]?.config.kind ?? await providerKind(storage, route).catch(() => undefined); return { route, ...(e.maxTokens === undefined ? {} : { maxTokens: e.maxTokens }), ...(e.reasoningTokens === undefined ? {} : { reasoningTokens: e.reasoningTokens }), ...(typeof kind === "string" ? { kind } : {}) }; })).then((all) => all.sort((x, y) => (x.route < y.route ? -1 : x.route > y.route ? 1 : 0))) }, retention: { status: (by) => retention.status(by), check: (by, ref) => retention.check(by, ref), settings: async (by) => { const g = await retentionSettings.get(by); return { revision: g.revision, settings: { ...g.settings }, effective: { ...g.effective } }; } }, stall, watch: watchService, eventSources: { get: (by) => eventSourceSettings.get(by) }, release: { gate: (by, candidateId) => releaseNow().gate(by, candidateId), attempts: (by, candidateId) => releaseNow().attempts(by, candidateId), gateAndAttempts: (by, candidateId) => releaseNow().gateAndAttempts(by, candidateId), candidates: (by, page) => releaseNow().candidates(by, page), status: async (by) => { if (activationLive === undefined) throw new DomainError("unavailable", "release staging is not set up on this controller"); return activationLive.status(by); } }, capacity: { limits: { get: (by) => capacityLimits.get(by) }, quotas: { quotas: (by) => capacityAdmission.quotas(by) }, swarm: { get: (by) => swarmLimits.get(by) } }, reviews, ownerQuestions: messages, agenda: meetings, meetings, standups: { recent: async (by, projectId, page) => (dispatch?.standups === undefined ? undefined : dispatch.standups.recent(by, projectId, page)), overview: async (by, projectId, page) => (dispatch?.standups === undefined ? undefined : dispatch.standups.overview(by, projectId, page)), briefs: async (by, occurrenceId) => (dispatch?.standups === undefined ? [] : dispatch.standups.briefs(by, occurrenceId)), ownerQuestions: async (by, projectId) => { if (dispatch?.standups === undefined) throw new DomainError("unavailable", "stand-ups are not running"); return dispatch.standups.ownerQuestions(by, projectId); } }, meetingDecisions: async (by, limit) => (recordsLive === undefined ? { items: [], truncated: false } : recordsLive.ownerPending(by, limit)), heldResumes: async (by, limit) => (resumesLive === undefined ? { items: [], truncated: false } : resumesLive.held(by, limit)), decisionLog: async (by, query) => { if (recordsLive === undefined) throw new DomainError("unavailable", "meeting records are not running"); return recordsLive.decisionLog(by, query); }, shutdown: { readiness: async (by) => { if (stopsLive === undefined) throw new DomainError("unavailable", "stop is not ready"); return stopsLive.readiness(by, { kind: "installation", id: "installation" }); } }, handoffs: { forTask: (by, taskId) => handoffs.forTask(by, taskId), marks: (by, q) => handoffs.marks(by, q), cutsForTask: (by, taskId) => handoffs.cutsForTask(by, taskId), archive: (by, q) => handoffs.archive(by, q) }, stops: { cleanupSpend: async (by, scope) => { if (stopsLive === undefined) throw new DomainError("unavailable", "stop is not ready"); return stopsLive.cleanupSpend(by, scope); } }, activity, replay, ...(checked === undefined ? {} : { verifyArtifact: async (id: string) => ({ ok: (await checked.verify(id)).ok }) }) });
    const branchSettings = ProtectedBranchService.withEpoch(storage, epoch);
    // Typed commands (card T09b): the `nimblenewt.` names are the state-API operations, `toolbox.` and `a_<id>.` names come from the catalog.
    // ONE catalogue for the whole controller: its revocation listeners live on the instance, so the revoke path and the tool bridge must share it.
    const catalogService = CatalogService.withEpoch(storage, epoch, desks);
    // The standing answer for running calls when a revoke names none (card T02c); an operator-given `tools.revocationPolicy` wins over it.
    const operatorPolicy = options.tools?.revocationPolicy;
    const catalogPolicy = CatalogPolicyService.withEpoch(storage, epoch, "finish", {}, operatorPolicy);
    const catalogRevocation: CatalogRevocationPort = { revoke: (owner, command) => catalogService.revoke(owner, command), revocations: (owner, query) => catalogService.revocations(owner, query), running: async (_owner, name, version) => (toolsLive === undefined ? { calls: [], total: 0 } : toolsLive.runningEverywhere(name, version)) };
    const commands = CommandService.withEpoch(storage, epoch, BUILTIN_COMMANDS.source(catalogSource(catalogService)));
    const integration = IntegrationPolicyService.withEpoch(storage, epoch);
    const notes = WorkingNoteService.withEpoch(storage, epoch);
    // The agent's ending (card H12n). The submission is bound to the submission service through the optional `stage` (and the landing check to `landing`) of the start options: without them a submit is refused as unavailable and nothing is submitted.
    const submissions = SubmissionService.withEpoch(storage, epoch, (_id, scope, by) => agents.rolesOfPrincipalIn(by, scope.projectId, new Date().toISOString()), { reviewersAvailableIn: (projectId, workerId) => agents.reviewersAvailableIn(projectId, workerId, new Date().toISOString()), attemptOf: (() => { const of = attemptOfAssignments(assignments); /* the dispatcher names an attempt's owner by its bare agent id, the principals by `agent:<id>`: the same identity either way */ return async (taskId: string) => { const a = await of(taskId); return a === undefined ? undefined : { ...a, ownerId: a.ownerId.startsWith("agent:") ? a.ownerId : `agent:${a.ownerId}` }; }; })() });
    // Operations on services (card P03): the effect ledger, the fence of the agent's current attempt, and the target. An operational outcome is accepted only if the ledger confirms and verified it.
    const serviceOps = ServiceOperations.withEpoch(storage, epoch, {
      effects: EffectService.withEpoch(storage, epoch, assignments, { holder: "service-ops" }),
      ...(options.serviceTarget === undefined ? {} : { target: options.serviceTarget }),
      fenceOf: async (taskId, agentId) => {
        const asg = await assignments.getAssignment(taskId);
        if (asg === undefined || asg.activeAttemptId === undefined) return undefined;
        const attempt = await assignments.getAttempt(asg.activeAttemptId);
        if (attempt === undefined || (attempt.owner.id !== agentId && `agent:${attempt.owner.id}` !== agentId)) return undefined;
        return { generation: attempt.generation, attemptId: attempt.id };
      },
    });
    // Versioned deliverables and their acceptance (card Q01): roles as for submissions, the task contract version from the contract record, artifacts verified against their bytes (absent without an artifact directory: a deliverable that names artifacts is then refused, not trusted).
    const acceptance = AcceptanceService.withEpoch(storage, epoch, {
      rolesOf: (_id, scope, by) => agents.rolesOfPrincipalIn(by, scope.projectId, new Date().toISOString()),
      contractVersion: async (taskId) => ((await contracts.runner.get("task-contract", taskId))?.body as unknown as { version?: number } | undefined)?.version ?? 0,
      reviewersAvailableIn: (projectId, workerId) => agents.decidersAvailableIn(projectId, workerId, new Date().toISOString()),
      verifyOutcome: (taskId, outcome) => serviceOps.checkOutcome(taskId, outcome),
      notify: async (n) => { await notifications.emitFromController({ commandId: n.commandId, kind: "maintenance", level: "notice", ref: { kind: "deliverable", id: n.deliverableId }, detail: n.text }); },
      ...(checked === undefined ? {} : { verifyArtifact: async (artifactId: string) => { const r = await checked.verify(artifactId); return { ok: r.ok, problems: r.problems.length }; } }),
    });
    const cleanupSettings = CleanupSettingsService.withEpoch(storage, epoch, options.cleanupDefault, { warn: async (d) => { await notifications.emitFromController({ commandId: `cleanup-settings-damaged:${d.revision}`, kind: "maintenance", level: "needs-you", ref: { kind: "cleanup-settings", id: "main" }, detail: d.detail }); } });
    // The leftovers of a finished attempt (installed or still running, never removed by the controller) go to the agent's boss as a needs-you message; with no boss, or one who cannot be told about the task, to the owner.
    let workEndLate: WorkEndService | undefined;
    const scratchCleanup = ScratchCleanupService.withEpoch(storage, epoch, {
      mode: async () => (await cleanupSettings.effective()).scratch,
      patienceHours: async () => (await cleanupSettings.effective()).awaitStopHours,
      before: async (a) => workEndLate?.droppedReason(a.attemptId),
      decide: async (attemptId) => workEndLate?.scratchDecision(attemptId),
      workerStopped: async (a, signal) => (dispatch === undefined ? false : dispatch.dispatcher.confirmStopped(dispatch.principal, a.attemptId, signal)),
      unresolved: async (a, reason, key) => { await notifications.emitFromController({ commandId: key, kind: "maintenance", level: "needs-you", ref: { kind: "scratch-cleanup", id: `${scratchRecordId(a.attemptId)}-unresolved` }, ...(a.projectId === "" ? {} : { projectId: a.projectId }), detail: `Scratch of attempt ${a.attemptId} is kept and its cleanup was closed without a decision: ${reason}. Nothing was removed; check it by hand.`.slice(0, 200) }); },
      stuck: async (a, hours, key) => { await notifications.emitFromController({ commandId: key, kind: "maintenance", level: "needs-you", ref: { kind: "scratch-cleanup", id: `${scratchRecordId(a.attemptId)}-stuck` }, projectId: a.projectId, detail: `Scratch of attempt ${a.attemptId} is kept: its worker never confirmed it stopped within ${hours} hour(s), so nothing was removed. Check the host; the cleanup goes on by itself once the stop is confirmed.`.slice(0, 200) }); },
      ...(options.scratchHost === undefined ? {} : { order: options.scratchHost.remove }),
      report: async (a, leftovers, _key) => {
        // To the supervisor AGENT: the host's words framed as quoted untrusted data (see `supervisorNotice`). With no boss, or one who cannot be told about the task, to the owner in notices that fit the notification's detail limit.
        const own = a.agentId.startsWith("agent:") ? a.agentId.slice("agent:".length) : a.agentId;
        const boss = ((await storage.getAggregate({ kind: "agent", id: own }))?.body as unknown as { supervisorId?: string } | undefined)?.supervisorId;
        if (boss !== undefined) {
          const note = supervisorNotice(a, leftovers);
          try { await messages.noticeFromController({ commandId: `scl-left:${a.attemptId}`, taskId: a.taskId, to: `agent:${boss}`, purpose: note.purpose, text: note.text }); return; } catch (error) {
            if (!(error instanceof DomainError && (error.code === "forbidden" || error.code === "not_found"))) throw error;
          }
        }
        for (const [i, detail] of ownerNotices(a, leftovers).entries()) await notifications.emitFromController({ commandId: `scl-left:${a.attemptId}:${i + 1}`, kind: "maintenance", level: "needs-you", ref: { kind: "scratch-cleanup", id: `${scratchRecordId(a.attemptId)}-${i + 1}` }, projectId: a.projectId, detail });
      },
    });
    const workEnd = WorkEndService.withEpoch(storage, epoch, { attempts: dispatcherEndingPorts(() => (dispatch === undefined ? undefined : { dispatcher: dispatch.dispatcher, principal: dispatch.principal })), landing: options.landing === undefined ? async () => undefined : (taskId) => options.landing!(taskId), ...(options.stage === undefined ? {} : { submit: stagedSubmit({ stage: options.stage, submissions, principalOf: async (agentId) => { const p = await principals.get(agentId.startsWith("agent:") ? agentId : `agent:${agentId}`); return p === undefined || p.state !== "active" ? undefined : ((await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString())) as Principal); } }) }), blockers: BlockerService.withEpoch(storage, epoch), paused: (taskId) => pauses.isPaused(taskId), scratch: { cleanup: scratchCleanup, checkpointRecorded: async (a) => {
      if (dispatch === undefined) return false;
      const attempt = await dispatch.dispatcher.get(dispatch.principal, a.attemptId).catch(() => undefined);
      return attempt === undefined ? false : checkpointVerdict(await continuations.latest(dispatch.principal, a.taskId).catch(() => undefined), attempt);
    } } });
    workEndLate = workEnd;
    const stopMayControl = async (by: Principal, taskId: string): Promise<boolean> => {
      if (by.kind === "owner") return true;
      const parent = ((await storage.getAggregate({ kind: "swarm-link", id: taskId }))?.body as unknown as { parentTaskId?: string } | undefined)?.parentTaskId;
      if (parent !== undefined && await budgets.canManage(by, parent).catch(() => false)) return true;
      return pauses.authorizeControl(by, { kind: "task", id: taskId }).then(() => true, () => false);
    };
    const stops = stopsLive = StopService.withEpoch(storage, epoch, pauses, dispatchStopPorts(() => (dispatch === undefined ? undefined : { dispatcher: dispatch.dispatcher, principal: dispatch.principal }), () => (options.dispatch === undefined ? "none" : "pending"), (scope) => agentsUnder(storage, scope), (_by, taskId) => jobs.unfinishedOf(taskId), options.localWork ?? hostLocalWork(() => (dispatch === undefined ? undefined : { dispatcher: dispatch.dispatcher, principal: dispatch.principal })), { dropEnding: (id, why, reason) => workEnd.drop(id, why, reason) }, {
      descendants: (taskId) => swarmDescendantsInfo(storage, taskId),
      // A Stop of an agent, a team or the installation walks the children of every task it covers, the links read once for the lot (card L02e).
      descendantsOf: (taskIds) => swarmDescendantsOf(storage, taskIds),
      // Like `swarm.cancel`: the owner, or whoever holds the budget of the child's parent; or whoever may control the child's own scope.
      mayControl: stopMayControl,
      agentJobs: async (_by) => {
        // Paged to the end (up to 50 pages of 1,000), so a large installation does not make every agent Stop recovery-required; only a really huge list is reported as cut.
        const all: Awaited<ReturnType<typeof jobs.unfinishedAll>>["jobs"][number][] = [];
        let after: string | undefined;
        for (let page = 0; page < 50; page++) {
          const got = await jobs.unfinishedAll(1000, after);
          all.push(...got.jobs);
          if (!got.truncated || got.next === undefined) return { jobs: all, truncated: false };
          after = got.next;
        }
        return { jobs: all, truncated: true };
      },
      cancelJob: (by, jobId, o) => jobs.requestCancel(by, { commandId: `stopjob-${jobId}-${o.force ? "force" : "ask"}`, jobId, reason: o.reason, ...(o.force ? { force: true } : {}) }),
      charge: (by, c) => budgets.charge(by, { commandId: c.commandId, activity: "stop-cleanup", taskId: c.taskId, ...(c.agentId === undefined ? {} : { agentId: c.agentId }), ...(c.costMicros > 0 ? { costMicros: c.costMicros } : {}), ...(c.computeMs > 0 ? { computeMs: c.computeMs } : {}) }),
    }), { mayHold: async (requestedBy, taskId) => { const p = await principals.get(requestedBy); return p !== undefined && p.state === "active" && stopMayControl((await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString())) as Principal, taskId); }, onSettled: async (by, e) => { if (e.scope.kind !== "task") return; await activity.record(by, { commandId: `${e.intentId}-act`, taskId: e.scope.id, kind: "lifecycle", summary: `${e.mode === "suspend" ? "Suspension" : "Stop"} ${e.outcome.state}${e.outcome.graceful ? "" : " (not graceful)"}${e.outcome.unresolved.length > 0 ? `; unresolved: ${e.outcome.unresolved.slice(0, 5).join(", ")}` : ""}.`, manifest: { refs: [{ kind: "stop-intent", id: e.intentId }] } } as never); } });

    // Provider drain and cutover (card R04b): the owner's controls gate every route choice made through the fallback service, which the cutover cancels running calls on.
    // The same list rules as the routing table's (card R04c): a topology that would leave a model-using role without a valid fallback list is refused too, so neither change can break the lists.
    const cutover = cutoverLive = CutoverService.withEpoch(storage, epoch, routing, {}, {});
    const fallback = FallbackService.withEpoch(storage, epoch, routing, {}, cutover.gate());
    cutover.bind(fallback);
    wakeHost = MeetingWakeHost.withEpoch(storage, epoch, { rest: (agentId) => stops.agentRest(agentId), holds: (agentId) => pauses.agentHolds(agentId) });
    const handoffs = HandoffService.withEpoch(storage, epoch, { leases: integratorLeaseHandover(integratorLeases), asker: async (principalId) => { const p = await principals.get(principalId); return p === undefined || p.state !== "active" ? undefined : grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); }, onReturnGivenUp: async (by, e) => { await activity.record(by, { commandId: `${e.handoffId}-ret-${createHash("sha256").update(e.reason).digest("hex").slice(0, 12)}`, taskId: e.taskId, kind: "ownership", summary: `The temporary reassignment was not returned: ${e.reason}.`, manifest: { refs: [{ kind: "handoff", id: e.handoffId }] } } as never); }, onTransferred: async (by, e) => { await activity.record(by, { commandId: `${e.handoffId}-act`, taskId: e.taskId, kind: "ownership", summary: `Handed over from ${e.from.kind} ${e.from.id} to ${e.to.kind} ${e.to.id}.${describeReassigned(e.reassigned)}${describeLeases(e.leases)}`, manifest: { refs: [{ kind: "handoff", id: e.handoffId }] } } as never); }, pauses, stops, assignments, responsibilities: responsibilityHandover({
        responsibilities, projectOf: async (taskId) => (await projects.getTask(taskId))?.projectId,
        activeAgent: async (to) => { const p = await principals.get(`agent:${to.id}`); return p !== undefined && p.kind === "agent" && p.state === "active"; },
        // A duty moved at once; a new holder without the rights for it is reported to the owner, naming what is missing (owner decision 2026-10-30). Provisional set: read and write the duty, and work in the project.
        missingRights: async (agentPrincipalId, projectId) => { const p = await principals.get(agentPrincipalId); if (p === undefined) return ["responsibility.read", "responsibility.write", "attempt.work"]; const eff = await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); return ["responsibility.read", "responsibility.write", "attempt.work"].filter((a) => !allows(eff as never, a, projectId)); },
        warn: async (w) => { await notifications.emitFromController({ commandId: `hnd-rwarn-${createHash("sha256").update(`${w.handoffId}\0${w.responsibilityId}`).digest("hex").slice(0, 24)}`, kind: "maintenance", level: "needs-you", ref: { kind: "responsibility", id: w.responsibilityId }, projectId: w.projectId, detail: `${w.agent} now answers for responsibility ${w.responsibilityId} after a hand-off but lacks ${w.missing.join(", ")}. Grant the right or reassign it.`.slice(0, 200) }); },
      }), sources: controllerHandoffSources({ getTask: (id) => projects.getTask(id), contracts,
      // The sender's own shared drafts and the responsibilities it answers for travel with the task (card L03g), read as the sender.
      drafts: async ({ taskId, projectId, from }) => { const p = await principals.get(`agent:${from.id}`); if (p === undefined) return []; const eff = await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); const all: Awaited<ReturnType<typeof desks.list>>["items"] = []; for (let after: string | undefined, i = 0; i < 20; i++) { const page = await desks.list(eff as never, { ownerId: p.id, projectId, limit: 200, ...(after === undefined ? {} : { afterId: after }) }); all.push(...page.items); after = page.next; if (after === undefined) break; } return all.filter((r) => r.taskId === taskId && r.status === "draft" && r.visibility === "shared").map((r) => ({ id: r.id, title: r.title, body: r.body, updatedAt: r.updatedAt })); },
      responsibilities: async ({ projectId, from }) => { const p = await principals.get(`agent:${from.id}`); if (p === undefined) return []; const eff = await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); return ((await responsibilities.list(eff as never, projectId, { state: "active" })) ?? []).filter((r) => r.ownerId === p.id).map((r) => ({ id: r.id, title: r.title, desiredCondition: r.desiredCondition, state: r.state, updatedAt: r.updatedAt })); },
      // Every kind of hold the controller keeps (card L03j): the checkout's workspace operation and any freeze it could not lift, the sender's integrator leases for the task, and the claims of the sender's responsibilities.
      locks: async ({ taskId, projectId, from, to }) => {
        const p = await principals.get(`agent:${from.id}`); if (p === undefined) return [];
        const out: string[] = [];
        // The sender's integrator leases for this task: released when the task moves, unless the owner moves them with the hand-off. A failing read is a gap, said so.
        try {
          for (const l of (await integratorLeases.forTask(taskId)).filter((x) => x.holder === from.id)) out.push(`integrator lease on branch ${l.branch}: held by ${from.id} (the sender, fence ${l.fence}, until ${l.expiresAt}); released when the task moves, unless the owner moves it to the recipient on completing the hand-off (moveIntegratorLease)`);
        } catch { out.push("integrator leases: could not be read just now, so any the sender holds are missing from this section, not absent"); }
        // A workspace operation that ended but could not lift its freeze: only it (through the recovery loop) lifts those attempts, never the hand-off.
        try {
          const kept = await workspaceOps.heldFor(taskId);
          if (kept !== undefined) out.push(`checkout of ${taskId}: ${kept.operation} request ${kept.requestId} ended but still holds ${kept.held.length} attempt(s) frozen; the recovery loop lifts them, the hand-off does not`);
        } catch { out.push("workspace holds: could not be read just now, so any on the checkout are missing from this section, not absent"); }
        const rightsOf = async (x: { id: string; kind: never; name: string; grants: never }) => grants.effective(x as never, new Date().toISOString());
        // A workspace operation open on the task's checkout, whoever started it (the owner or the dispatcher as well as the sender): the checkout is frozen for the recipient too until it ends, so it is named with who started it.
        const op = await workspaceOps.openFor(taskId);
        if (op !== undefined) out.push(`checkout of ${taskId}: ${op.operation} in progress, started by ${op.requestedBy === p.id ? `${from.id} (the sender)` : op.requestedBy} (request ${op.requestId}, since ${op.at}); the checkout stays frozen for whoever holds the task until it ends or is settled by recovery`);
        // Resource claims held by the responsibilities the sender answers for: the claim belongs to the responsibility, so it stays with the sender until that is reassigned.
        const eff = await rightsOf(p as never);
        const mine = await responsibilities.list(eff as never, projectId, { state: "active" });
        // The sender being unable to read responsibilities is a gap in what is known, not the absence of claims: say so rather than show only the checkout line as if complete.
        if (mine === undefined) { out.push("resource claims: not known; the sender may not read the project's responsibilities, so claims it holds are missing from this section, not absent"); return out; }
        const claims: { resourceId: string; responsibilityId: string }[] = [];
        let unchecked = 0;
        for (const r of mine) {
          if (r.ownerId !== p.id) continue;
          for (const resourceId of r.managed) { try { const c = await resources.heldClaim(resourceId); if (c !== undefined && c.responsibilityId === r.id) claims.push({ resourceId, responsibilityId: r.id }); } catch { unchecked++; } }
        }
        if (unchecked > 0) out.push(`resource claims: ${unchecked} managed ${unchecked === 1 ? "entry" : "entries"} of the sender's responsibilities could not be checked and ${unchecked === 1 ? "is" : "are"} missing from this section`);
        // Only what the recipient may see by name: it needs resource.read and to be able to read the responsibility; the rest is given as a count and kinds.
        const tp = await principals.get(`agent:${to.id}`);
        const teff = tp === undefined ? undefined : await rightsOf(tp as never);
        const seeResources = teff !== undefined && allows(teff as never, "resource.read", projectId);
        const theirs = teff === undefined ? undefined : await responsibilities.list(teff as never, projectId, { state: "active" });
        const seeable = new Set((theirs ?? []).map((r) => r.id));
        const kinds = new Map<string, number>(); let hidden = 0;
        for (const c of claims) {
          if (seeResources && seeable.has(c.responsibilityId)) { out.push(`resource ${c.resourceId}: claimed by responsibility ${c.responsibilityId}; the claim stays with ${c.responsibilityId} until it is reassigned`); continue; }
          hidden++;
          const kind = (await resources.kindOf(c.resourceId).catch(() => undefined)) ?? "unknown";
          kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
        }
        if (hidden > 0) out.push(`resource claims: ${hidden} held by the sender's responsibilities (${[...kinds].map(([k, n]) => `${k} x${n}`).join(", ")}); details withheld, the recipient may not read them`);
        // Every kind of hold was read: none is a known answer, not a gap.
        return out.length === 0 ? [LOCKS_NONE] : out;
      },
      agentState: async (id) => ((await storage.getAggregate({ kind: "agent", id }))?.body as unknown as { state?: "active" | "retired" } | undefined)?.state, canWork: async (agentId, projectId) => { const p = await principals.get(`agent:${agentId}`); if (p === undefined || p.state !== "active") return false; const eff = await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); return allows(eff as never, "attempt.work", projectId); } }) });
    const continuations = ContinuationService.withEpoch(storage, epoch);
    const resumeSettings = ResumeSettingsService.withEpoch(storage, epoch, undefined, { warn: async (d) => { await notifications.emitFromController({ commandId: `resume-settings-damaged:${d.revision}`, kind: "maintenance", level: "needs-you", ref: { kind: "resume-settings", id: "main" }, detail: d.detail }); } });
    // What happens when a host stops reporting while it holds work: warn, then (unless the owner turned it off) re-place after the grace period. The owner's setting over the start-up defaults (12 hours, on).
    const quietHostSettings = QuietHostSettingsService.withEpoch(storage, epoch, undefined, { warn: async (d) => { await notifications.emitFromController({ commandId: `quiet-host-settings-damaged:${d.revision}`, kind: "maintenance", level: "needs-you", ref: { kind: "quiet-host-settings", id: "main" }, detail: d.detail }); } });
    const contextDependencies = DependencyService.withEpoch(storage, epoch);
    // Hosts capture continuations and the agent records what its work relied on through the state API (card L04c). A host captures only for a live attempt it runs or is pinned to; with no dispatcher, none.
    const continuationOps: ContinuationOps = {
      capture: (by, command) => continuations.capture(by, command), latest: (by, taskId) => continuations.latest(by, taskId),
      record: (by, command) => contextDependencies.record(by, command), manifest: (by, taskId) => contextDependencies.get(by, taskId),
      hostHolds: async (hostId, taskId) => {
        if (dispatch === undefined) return false;
        for (const id of await dispatch.dispatcher.liveAttemptsOf(dispatch.principal, { taskId })) {
          const d = await dispatch.dispatcher.get(dispatch.principal, id);
          if (d !== undefined && d.taskId === taskId && (d.hostId === hostId || d.pinnedHost === hostId)) return true;
        }
        return false;
      },
    };
    // The two ports of a checked resume that were only stand-ins (card L04d): what the recorded files and directories look like here
    // now, read from the checkout the task's repository is bound at before the attempt it checks starts, and a reviewer agent's reasoned verdict on each
    // change. Whatever the host supplies outright for either port is used instead of these.
    const RESUME_READER: Principal = { id: "service:resume-check", kind: "service", name: "resume-check", grants: [] };
    const remoteHostIds: ReadonlySet<string> = new Set((options.dispatch?.remote?.hosts ?? []).map((h) => h.hostId));
    const resumeProbe = !resumeProbeEnabled(options.resumeProbe, remoteHostIds.size) || options.resume?.observe !== undefined ? undefined : checkoutDependencyObserver({
      manifest: async (taskId) => await contextDependencies.get(RESUME_READER, taskId),
      // A task placed on a remote host works on that host's disk, not this one: nothing here is evidence about it (and a task never
      // placed, in an installation with remote hosts, may be about to go to one). Left unobserved, so the owner decides.
      locate: locallyPlaced(remoteHostIds, async (taskId) => {
        const placed = (await storage.getAggregate({ kind: "task-placement", id: taskId }))?.body as { hostId?: unknown } | undefined;
        return typeof placed?.hostId === "string" ? placed.hostId : undefined;
      }, async (taskId) => await resources.checkoutLocation(taskId)),
      ...(typeof options.resumeProbe === "object" ? options.resumeProbe : {}),
      onFault: (detail) => { options.onInternalError?.(new Error(`the resume dependency probe: ${detail}`)); },
    });
    // One bounded client over the host's raw reviewer client (card W10 wiring), shared by the resume reviewer and the second agent of a done, so the two share its slots.
    const boundedReviewer = options.reviewerModel === undefined ? undefined : new BoundedReviewerModel(options.reviewerModel);
    const resumeTask = async (taskId: string): Promise<{ title?: string; nextStep?: string } | undefined> => {
      const task = await projects.getTask(taskId);
      const latest = await continuations.latest(RESUME_READER, taskId).catch(() => undefined);
      return task === undefined && latest === undefined ? undefined : { ...(task === undefined ? {} : { title: task.title }), ...(latest === undefined ? {} : { nextStep: latest.continuation.nextStep }) };
    };
    // The reviewer's calls go through the controller's routed client (failures classified, blocked routes skipped) and are counted against the daily cap on the controller's own model calls (card L04d).
    const reviewModel = options.resumeReview === undefined ? undefined : new GuardedModelCall(options.resumeReview.model, { spend: ChatSpendService.withEpoch(storage, epoch), onSpendFailure: (error) => options.onInternalError?.(error) });
    const reviewer = options.resumeReview === undefined || reviewModel === undefined || options.resume?.review !== undefined ? undefined : new ResumeReviewer(reviewModel, {
      routes: options.resumeReview.routes ?? chatRoutes(routing, { role: options.resumeReview.role ?? "safety-supervisor" }),
      ...(options.resumeReview.tellTask === false ? {} : { task: resumeTask }),
      onFailure: (route, detail) => { options.onInternalError?.(new Error(`the resume reviewer on ${route}: ${detail}`)); },
    });
    // The shipped resume reviewer (card L04d wiring): with no explicit `resumeReview` or `resume.review`, the host's raw client (`reviewerModel`, what the launcher passes) is bounded, put behind the same routed,
    // metered client and asked only on the route the owner set (`resume.reviewerRoute`, read at every review). It fails closed: when it cannot run (no route, an unusable route, the cap, a model that does not
    // answer on any route) the check records the review as NOT RUN with why and every change waits for the owner, as with no reviewer at all; it never blocks a resume the old rule would let the owner decide.
    const shippedResumeRoutes = reviewerRoute({ setting: () => configuration.installationValue(RESUME_REVIEWER_ROUTE_SETTING), routing, purpose: "resume" });
    const shippedReviewer = reviewer !== undefined || options.resumeReview !== undefined || options.resume?.review !== undefined || boundedReviewer === undefined ? undefined
      : new ResumeReviewer(new GuardedModelCall(boundedReviewer, { spend: ChatSpendService.withEpoch(storage, epoch), onSpendFailure: (error) => options.onInternalError?.(error) }), {
        routes: shippedResumeRoutes, task: resumeTask,
        onFailure: (route, detail) => { options.onInternalError?.(new Error(`the resume reviewer on ${route}: ${detail}`)); },
      });
    const shippedReview = shippedReviewer === undefined ? undefined : async (request: Parameters<ResumePorts["review"]>[0]): Promise<Awaited<ReturnType<ResumePorts["review"]>>> => {
      // The route is read first so an unset or unusable one is said as such, before anything is put together for a model.
      try { await shippedResumeRoutes(); } catch (error) { throw new ReviewNotRun(error instanceof Error ? error.message : String(error)); }
      try { return await shippedReviewer.review(request); } catch (error) { throw new ReviewNotRun(`the resume reviewer gave no verdict: ${error instanceof Error ? error.message : String(error)}`); }
    };
    // Card W10: the second agent's calls go through the same routed, metered client as the reviewer's, under the same daily cap.
    // The shipped composition (card W10 wiring): the host's raw client (`reviewerModel`) is bounded, put behind the same routed, metered client, and asked only on the route the owner set (`report.reviewerRoute`, read at every questioning).
    // With no route set the questioning is recorded as not run, never as passed. An explicit `reportInterrogation` of the host is used as it is, as before.
    const reviewerClient = options.reportInterrogation !== undefined ? undefined : boundedReviewer;
    const interrogator = options.reportInterrogation === undefined && reviewerClient === undefined ? undefined : new ReportInterrogator(new GuardedModelCall(options.reportInterrogation?.model ?? reviewerClient!, { spend: ChatSpendService.withEpoch(storage, epoch), onSpendFailure: (error) => options.onInternalError?.(error) }), {
      routes: options.reportInterrogation !== undefined ? (options.reportInterrogation.routes ?? chatRoutes(routing, { role: options.reportInterrogation.role ?? "safety-supervisor" })) : reviewerRoute({ setting: () => configuration.installationValue(REVIEWER_ROUTE_SETTING), routing }),
      onFailure: (route, detail) => { options.onInternalError?.(new Error(`the report interrogator on ${route}: ${detail}`)); },
    });
    const resumePorts: Partial<ResumePorts> = {
      ...(resumeProbe === undefined ? {} : { observe: resumeProbe }),
      ...(reviewer === undefined ? {} : { review: (request) => reviewer.review(request) }),
      ...(shippedReview === undefined ? {} : { review: shippedReview }),
      ...options.resume,
    };
    const resumes = ResumeCheckService.withEpoch(storage, epoch, { continuations, dependencies: contextDependencies, blockers: BlockerService.withEpoch(storage, epoch), ports: controllerResumePorts(storage, resumePorts),
      // The owner's decline releases the task while the held attempt is still its active one, and closes the dispatcher's notice that it is held (card L04c).
      release: async (by, taskId, attemptId) => {
        const a = await assignments.getAssignment(taskId);
        if (a === undefined || a.state !== "assigned" || a.activeAttemptId !== attemptId) return;
        await assignments.releaseTask({ commandId: `rck-decline-release:${attemptId}`, actor: by.id, taskId, expectedRevision: a.revision, reason: "the owner declined to resume it on inputs that changed" });
      },
      settle: async (checkId, projectId) => { await notifications.settleFromController({ commandId: `dpa-ntf-done:resume-review:${checkId}`, kind: "maintenance", ref: { kind: "resume-check", id: checkId }, projectId }); },
    }, { rounds: () => resumeSettings.effective() });
    resumesLive = resumes;
    // The identity that carries out what a meeting decided and was allowed: a service with no grants of its own (the carrying agent's rights are checked separately).
    const meetingController = { id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as Principal;
    const reassignApplier = taskReassignApplier(assignments, projects, principals,
        // The rights the work needs, checked the way the services check them (the agent's own effective grants): the ones it lacks.
        async (agentId, projectId, taskId) => { const p = await principals.get(agentId); if (p === undefined || p.state !== "active") return ["task.read", "attempt.work"]; const eff = await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); return ["attempt.work", "task.read"].filter((a) => !allows(eff as never, a, projectId, { resource: { kind: "task", id: taskId } })); },
        // Owner decision 2026-10-30: a reassignment is made at once; a new holder without the rights is reported to the owner (and the chair), once per change (the notification's command ID comes from the change's).
        reassignWarningSink({ notifications, storage, messages }));
    const records = MeetingRecordService.withEpoch(storage, epoch, { meetings, decisions }, {
      // A cited record may be shown to a meeting's readers only when it is a project-visible kind and exists; desks, scratch and unknown kinds stay private (card M02e).
      shareable: shareableCite(storage),
      // A meeting may retitle or reword a task; the change is made by the project service as the agent that holds the right, and only once (card M02c).
      appliers: { "task.update": taskUpdateApplier(projects), "task.reassign": reassignApplier, "budget.raise": budgetRaiseApplier(budgets, meetingController, projects), "grant.add": grantApplier(grants, meetingController, projects) },
      // Changes that widen rights or spend (a budget raise and a grant are both registered) are carried out without the owner only when the approval policy lets their class through: the profile, with a specific setting overriding it (owner decision 2026-10-29).
      widening: async (cls, projectId) => {
        const cell = await PolicyService.withEpoch(storage, epoch, grants, { roles: (id) => agents.rolesOfPrincipal(id) }).classMode(projectId, cls);
        // The engine keeps a change of rights a decision for the owner whatever the profile says, so a vote widens rights without the owner only where the owner set that cell by hand (a specific setting overrides the profile).
        return wideningDecision(cell, cls);
      },
      // At most this many widening changes per decision on the policy's leave alone (card M02g); the owner turns the limit off with meeting.decision.limitPolicyWidening.
      policyWideningLimit: async () => { const v = await configuration.installationValues(["meeting.decision.limitPolicyWidening", "meeting.decision.maxPolicyWidening"]); return v["meeting.decision.limitPolicyWidening"] === false ? undefined : typeof v["meeting.decision.maxPolicyWidening"] === "number" ? v["meeting.decision.maxPolicyWidening"] : 3; },
      // A change that was carried out, or refused, is a step in the task it names (card C09f); the step is written by the controller itself (a service identity with no grants, which the activity service accepts as a service).
      onChange: async (e) => {
        if (e.target.kind !== "task") return;
        // Only a task of the decision's own project: the target and the words are an agent's, and this identity may write to any task.
        if ((await projects.getTask(e.target.id))?.projectId !== e.projectId) return;
        await activity.record({ id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as Principal, { commandId: `mdn-act:${e.decisionId}:${e.index}:${e.state}`, taskId: e.target.id, kind: "meeting-decision", summary: `A meeting decision ${e.state === "applied" ? "changed" : "could not change"} this task: ${e.summary}${e.reason === undefined ? "" : ` (${e.reason})`}.`, manifest: { refs: [{ kind: "meeting-decision", id: e.decisionId }] } } as never);
      },
      authority: async (principalId) => { const p = await principals.get(principalId); return p === undefined || p.state !== "active" ? undefined : grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); },
      ...(options.meetingRecords?.autoReturnMinutes === undefined ? {} : { autoReturnMinutes: options.meetingRecords.autoReturnMinutes }),
    });
    recordsLive = records;
    // The attendance service lives with the dispatcher (it needs the budget and the pause service it was composed with), which starts after the API: calls reach it when it is there.
    const attendance = new Proxy({}, { get: (_t, method: string) => (...args: unknown[]) => { const live = dispatch?.attendance as unknown as Record<string, (...x: unknown[]) => unknown> | undefined; if (live === undefined) throw new DomainError("unavailable", "meeting attendance is not running: the dispatcher is not"); return live[method]!(...args); } }) as NonNullable<ConstructorParameters<typeof StateApi>[0]["attendance"]>;
    const standups = new Proxy({}, { get: (_t, method: string) => (...args: unknown[]) => { const live = dispatch?.standups as unknown as Record<string, (...x: unknown[]) => unknown> | undefined; if (live === undefined) throw new DomainError("unavailable", "stand-ups are not running: the dispatcher is not"); return live[method]!(...args); } }) as NonNullable<ConstructorParameters<typeof StateApi>[0]["standups"]>;
    // A watch is dispatched only by the principal that set it up, so the owner's request is carried out as the dispatcher, which runs the dispatching (card H13b).
    const asDispatcher = (owner: Principal): { watches: NonNullable<typeof dispatch>["watches"]; by: Principal } => {
      if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not set up watches`);
      if (dispatch === undefined) throw new DomainError("unavailable", "event watching is not running: the dispatcher is not");
      return { watches: dispatch.watches, by: dispatch.principal };
    };
    const watchControl = {
      create: async (owner: Principal, command: { commandId: string; stream: string; taskId: string; kinds?: readonly string[]; cooldownSeconds?: number; batch?: number }) => { const w = asDispatcher(owner); return w.watches.watch(w.by, command); },
      cancel: async (owner: Principal, command: { commandId: string; watchId: string }) => { const w = asDispatcher(owner); await w.watches.cancelWatch(w.by, command); },
      list: async (owner: Principal) => { const w = asDispatcher(owner); return w.watches.activeOf(w.by); },
      describe: async (owner: Principal) => { const w = asDispatcher(owner); return w.watches.describeActive(w.by); },
    };
    // Forwarding goes through the policy-edit service, which exists only when chat is configured and after the API (it uses the API).
    let policyEditsLive: PolicyEditService | undefined;
    const policyForward = { forward: async (by: Principal, request: { commandId: string; threadId: string; seq: number }) => { if (policyEditsLive === undefined) throw new DomainError("unavailable", "forwarding owner messages needs chat to be configured"); return policyEditsLive.forward(by, request); } };
    const backups = options.backup === undefined ? undefined : new BackupService(storage, { root: options.backup.directory, version: options.backup.version ?? "0.0.0", ...(options.backup.everyMs === undefined ? {} : { everyMs: options.backup.everyMs }), ...(options.backup.retention === undefined ? {} : { retention: options.backup.retention }), retentionSource: async () => { const v = await retentionSettings.effective(); return { daily: v.backupDaily, weekly: v.backupWeekly, preRestoreKept: v.preRestoreKept, preRestoreMaxAgeDays: v.preRestoreMaxAgeDays }; }, ...(options.backup.now === undefined ? {} : { now: options.backup.now }), ...(blobStore === undefined ? {} : { blobs: blobStore }), ...(backupEncryption === undefined ? {} : { encryptionSource: async () => (sealsBackups(await backupEncryptionSetting!.effective()) ? backupEncryption.keyring : undefined) }), ...(piState === undefined ? {} : { piState }), ...(backupSigning === undefined ? {} : { signer: backupSigning }) });
    // The maintenance barrier (card K01h): while a restore is prepared, the stores below stop writing. Added in the order they are held.
    const barrier = new MaintenanceBarrier();
    if (backups !== undefined) barrier.add({ name: "backups", hold: async () => backups.hold() });
    barrier.add({ name: "dispatcher", hold: async () => { await dispatch?.driver.settle(); const live = dispatch === undefined ? [] : await dispatch.dispatcher.liveAttempts(dispatch.principal); if (live.length > 0) throw new Error(`${live.length} agent attempt(s) are still running: stop or pause the work first`); return () => undefined; } });
    const databaseTransfer = options.transfer === undefined || transferTargets.length === 0 || stateDirectory === undefined ? undefined : new DatabaseTransferService({
      storage, source: sourcePlace, targets: () => transferTargets, stateDirectory, barrier, enabled: async () => (await configuration.installationValue("database.transfer.enabled")) !== false,
      references: { ...(options.transfer.references?.checkpoints === undefined ? {} : { checkpoints: options.transfer.references.checkpoints }), ...(blobStore === undefined ? {} : { artifacts: async (digests: readonly string[]) => { const missing: string[] = []; for (const d of digests) if (!(await blobStore.has(d))) missing.push(d); return missing; } }) },
      ...(options.transfer.inject === undefined ? {} : { inject: options.transfer.inject }), ...(options.transfer.onSwitched === undefined ? {} : { onSwitched: () => options.transfer!.onSwitched!() }),
      ...(options.transfer.restart === undefined ? {} : { restart: options.transfer.restart, restartEnabled: async () => (await configuration.installationValue("database.transfer.restart")) !== false }),
      settings: {
        // The two switches live in the installation settings layer, so its revision is the one a change quotes (card F04m, third slice): a chat proposal pins the revision it was planned at and is
        // refused when anything changed the layer since, rather than applied over a change the owner did not see.
        get: async (by) => {
          const values = { enabled: (await configuration.installationValue("database.transfer.enabled")) !== false, restart: (await configuration.installationValue("database.transfer.restart")) !== false };
          if (by === undefined) return values;
          return { ...values, revision: (await configuration.layer(by as Parameters<typeof configuration.layer>[0], "installation", undefined))?.revision ?? 0 };
        },
        set: async (by, patch) => {
          const who = by as Parameters<typeof configuration.layer>[0];
          const set: Record<string, boolean> = { ...(patch.enabled === undefined ? {} : { "database.transfer.enabled": patch.enabled }), ...(patch.restart === undefined ? {} : { "database.transfer.restart": patch.restart }) };
          // One write that sets the switches and puts them into force together (review of card F04m, third slice): a stop cannot leave a switch staged, and nothing staged in the installation layer
          // (by anyone) goes into force with it, so a draft neither blocks the switches nor rides along. The caller's revision (0: nothing set yet) when given, else the layer as it is when written.
          try {
            return await configuration.change(who, { commandId: `${patch.commandId}-ch`, layer: "installation", ...(patch.expectedRevision === undefined ? {} : { expectedRevision: patch.expectedRevision }), set } as never);
          } catch (error) {
            if (error instanceof DomainError && error.code === "invalid_command" && error.message.startsWith("the configuration check refused it: ")) throw new DomainError("invalid_command", `the installation settings refused the change: ${error.message.slice("the configuration check refused it: ".length) || "no reason given"}`);
            throw error;
          }
        },
      },
    });
    transferLive = databaseTransfer;
    const pgStorage = options.storage.kind === "postgres" ? options.storage : undefined;
    // On PostgreSQL the restore is staged in a new schema of the same database, opened with the same server options as the live one (card K01i).
    const restoreDatabase = options.storage.kind === "sqlite" ? { sqlitePath: resolve(options.storage.path) } : { postgres: { url: pgStorage!.url, schema: pgStorage!.schema ?? "nimblenewt", openStaged: (schema: string) => PostgresStorage.open({ connectionString: pgStorage!.url, schema, allowUnsupportedServer: override, ...(pgStorage!.minimumServerVersionNum === undefined ? {} : { minimumServerVersionNum: pgStorage!.minimumServerVersionNum }) }) } };
    const stagedRestore = backups === undefined || dataDirectory === undefined ? undefined : new StagedRestore({ backups, root: options.backup!.directory, barrier, ...restoreDatabase, dataDirectory, storage, ...(blobStore === undefined ? {} : { blobs: blobStore }), ...(piFinal === undefined ? {} : { piFinal }), piStateConfigured: piState !== undefined, ...(dataLock === undefined ? {} : { lock: dataLock }), confirmMinutes: async () => (await retentionSettings.effective()).restoreConfirmMinutes, changeMargin: async () => (await retentionSettings.effective()).restoreChangeMargin, ...(backupEncryption === undefined ? {} : { unlock: (m) => backupEncryption!.unlock(m) }), deletions: () => new DeletionLedger(join(options.backup!.directory, LEDGER_FILE)).read(), ...(backupSigning === undefined ? {} : { signatureTrust: () => backupSigning.trust() }), ...(options.backup!.restore?.onStaged === undefined ? {} : { onStaged: options.backup!.restore.onStaged }), ...(options.backup!.restore?.restart === undefined ? {} : { restart: options.backup!.restore.restart }), ...(options.backup!.now === undefined ? {} : { now: options.backup!.now }) });
    // The controller's own Urgent triggers (card U11c): no good backup in time, a silent host, repeated policy denials; swept by the dispatcher and told through the notification service.
    const urgentClock = options.notifications?.clock;
    const urgentWatch = new UrgentWatch({ notifications, critical: { holdsUp: () => critical.holdsUp() }, work: workSource({ tasks: projects, blockers: BlockerService.withEpoch(storage, epoch) }), ...(backups === undefined ? {} : { backups }), hosts: HostService.withEpoch(storage, epoch, assignments, urgentClock === undefined ? {} : { clock: urgentClock }), ...(urgentClock === undefined ? {} : { clock: urgentClock }) });
    // The controller's security detectors (card U11d): a sign seen in the controller or reported by a worker's hook is told to the Urgent watch in the background, bounded and deduped.
    const securityDetectors = new SecurityDetectors({ report: (by, e) => urgentWatch.reportSecurityFrom(by, e), enabled: async () => (await notifications.controllerSettings()).securityDetectors !== false, onError: (error) => options.onInternalError?.(error) });
    // The quarterly proof of a backup unlock method is a notification with an escalation (card K01b3), and a change to backup encryption or the signing key is announced to the owner's inbox.
    const proofReminder = new BackupProofReminder({ notifications, source: { due: () => backupEncryption?.proofDue() ?? false, since: () => backupEncryption?.proofSince(), everyDays: backupEncryption?.proofEveryDays ?? 92 }, ...(options.backup?.now === undefined ? {} : { now: options.backup.now }) });
    backupEncryptionSetting?.onChanged(async (change, by) => { await notifications.emitFromController({ commandId: `bes:${change.after.enabled}:${change.after.scope}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`, kind: "maintenance", ref: { kind: "backup-encryption", id: "setting" }, ...(change.weaker ? {} : { level: "notice" as const }), label: change.weaker ? "Backup encryption was made weaker" : "Backup encryption was strengthened", detail: `${describeSetting(change.after)} (set by ${by})`.slice(0, 190) }); });
    backupSigning?.onRotated(async (entry, by) => { await notifications.emitFromController({ commandId: `bsr:${entry.keyId.slice(0, 16)}`, kind: "maintenance", ref: { kind: "backup-signing", id: entry.keyId.slice(0, 16) }, level: "notice", label: "A new backup signing key was made", detail: `Generation ${entry.generation} (key ${entry.keyId.slice(0, 16)}) set by ${by}. Save its public key off this machine (backup.signing.status).`.slice(0, 190) }); });
    const improvements = ImprovementService.withEpoch(storage, epoch, { meetings });
    // Which of the event sources the owner has turned off (card H13f); the list is the host's, or the built-in one.
    // The built-in ones are task completion and (card H13f) model availability from the router's health record, told to every active project.
    const eventSourceList = options.eventSources ?? defaultEventSources(projects, Date.now, { health: () => cutover.healthStates(), projects: () => activeProjectIds(projects) });
    // The sources the owner defines in settings (card H13f: timers, files and folders, git repositories, service health) are added to the host's list at every tick, so they need no restart.
    const eventSourceSettings = EventSourceSettingsService.withEpoch(storage, epoch, () => eventSourceList, { ...(options.dispatch?.clock === undefined ? {} : { clock: options.dispatch.clock }), streams: async (projectId, taskId) => {
      const project = await projects.getProject(projectId);
      if (project === undefined) throw new DomainError("not_found", `projectId: no project ${projectId}`);
      if (taskId !== undefined && (await projects.getTask(taskId))?.projectId !== projectId) throw new DomainError("not_found", `taskId: no task ${taskId} in that project`);
    } });
    // What one local agent may use: the owner's setting over the start-up figures (card H12k).
    const workerLimits = WorkerLimitsSettingsService.withEpoch(storage, epoch, checkLocalWorkerLimits(options.dispatch?.local?.limits));
    // How long an attempt may run and how many attempts are admitted: off unless the owner (or a start-up option) turns them on.
    const dispatchLimits = DispatchLimitsSettingsService.withEpoch(storage, epoch, { ...(options.dispatch?.dispatcher?.attemptMs === undefined ? {} : { attemptMs: options.dispatch.dispatcher.attemptMs }), ...(options.dispatch?.dispatcher?.maxAttempts === undefined ? {} : { maxAttempts: options.dispatch.dispatcher.maxAttempts }) });
    // Optional caps on attempts per project, per agent and on fan-in: off unless the owner turns them on (card H10b). A change lets waiting work in at once through an admission sweep.
    const capacityAdmission = AdmissionService.withEpoch(storage, epoch);
    const capacityLimits = CapacityLimitsService.withEpoch(storage, epoch, { onChanged: async (revision) => { await capacityAdmission.sweep({ commandId: `cap-sweep:${revision}`, actor: "dispatcher" }); } });
    // The host and global quotas go through the same admission record (card H10); the owner's limits on spawning child tasks are read at every spawn.
    const swarmLimits = SwarmLimitsService.withEpoch(storage, epoch);
    const streamSettings = StreamSettingsService.withEpoch(storage, epoch);
    const contextRouteSettings = ContextRouteSettingsService.withEpoch(storage, epoch);
    recoveryRun = {
      // The existing services do the work as the caller, so their own rights checks apply; each is keyed by the step (`ctx.key`, made from concern, rung and episode), so a repeat of the step does it once.
      // The agent is the one the concern is about (pinned when it was opened). Pause and stop act on the concern's TASK, not on the agent's other work; the services have no scope of one agent's work on one task, so every agent working on that task is paused or stopped
      // (nudge, rebrief and pause come before reassign on the ladder, so they meet the stalled agent, not the new holder).
      run: async (action, ctx) => {
        const asg = await assignments.getAssignment(ctx.taskId);
        const holder = asg?.state === "assigned" && asg.owner?.kind === "agent" ? asg.owner.id : undefined;
        const agent = ctx.agent ?? holder;
        const scope = { kind: "task" as const, id: ctx.taskId };
        if (action === "nudge" || action === "rebrief") {
          if (agent === undefined) throw new DomainError("invalid_transition", "the task has no agent working on it");
          await messages.noticeFromController({ commandId: ctx.key, taskId: ctx.taskId, to: `agent:${agent}`, purpose: action === "nudge" ? "A nudge from your supervisor" : "A new brief from your supervisor", text: ctx.text });
          return {};
        }
        if (action === "pause") { await pauses.pause(ctx.by, { commandId: ctx.key, scope, reason: ctx.text }); return {}; }
        if (action === "stop") { await stops.request(ctx.by, { commandId: ctx.key, scope, mode: "stop", reason: ctx.text }); return {}; }
        // Reassign: the caller was found fit to decide the concern and the ladder allows the rung, so no further right is asked of them. A task with a running attempt moves by a prepared hand-off (the attempt is suspended first and the package collected),
        // which finishes when the hand-off is completed; otherwise the meeting path's rules apply (moved at once; rights the new holder lacks are warned about).
        const to = ctx.to!;
        if (asg !== undefined && asg.activeAttemptId !== undefined) {
          await handoffs.prepare(ctx.by, { commandId: ctx.key, taskId: ctx.taskId, to: { kind: "agent", id: to.slice("agent:".length) }, reason: ctx.text });
          return { warnings: [`${to} takes the task by a hand-off: the running attempt is being suspended and the task moves when the hand-off is completed`] };
        }
        await reassignApplier.apply({ commandId: ctx.key, actor: ctx.by.id, target: { kind: "task", id: ctx.taskId }, expectedRevision: 0, patch: { toAgent: to, from: holder === undefined ? null : `agent:${holder}`, via: "recovery", ...(asg === undefined ? {} : { generation: asg.generation, revision: asg.revision }) } as never, agreedBy: ctx.by.id } as never);
        const target = await principals.get(to);
        const eff = target === undefined || target.state !== "active" ? undefined : await grants.effective({ id: target.id, kind: target.kind, name: target.name, grants: target.grants }, new Date().toISOString());
        const missing = eff === undefined ? ["task.read", "attempt.work"] : ["attempt.work", "task.read"].filter((x) => !allows(eff as never, x, ctx.projectId, { resource: { kind: "task", id: ctx.taskId } }));
        return missing.length === 0 ? {} : { warnings: [`${to} lacks ${missing.join(" and ")} for this task; the work waits until the owner grants it`] };
      },
      // Whether the actor can take the rung at all; a rung they cannot take is passed on the ladder, with the reason.
      unavailable: async (action, ctx) => {
        if (action === "nudge" || action === "rebrief") return ctx.agent === undefined && (await assignments.getAssignment(ctx.taskId))?.owner?.kind !== "agent" ? "the task has no agent working on it" : undefined;
        if (action === "reassign") {
          // The target must be an active agent; a task with a running attempt moves by a prepared hand-off, which needs the right to control the task.
          if (ctx.to !== undefined) { const t = await principals.get(ctx.to); if (t === undefined || t.state !== "active" || t.kind !== "agent") return `${ctx.to} is not an active agent`; }
          if ((await assignments.getAssignment(ctx.taskId))?.activeAttemptId === undefined) return undefined;
          try { await pauses.authorizeControl(ctx.by, { kind: "task", id: ctx.taskId }); return undefined; } catch (error) { return error instanceof DomainError ? `${ctx.by.id} may not hand the running task over: ${error.message}`.slice(0, 200) : undefined; }
        }
        try { await pauses.authorizeControl(ctx.by, { kind: "task", id: ctx.taskId }); return undefined; } catch (error) { return error instanceof DomainError ? `${ctx.by.id} may not ${action} the task: ${error.message}`.slice(0, 200) : undefined; }
      },
    };
    const releaseService = ReleaseService.withEpoch(storage, epoch);
    releaseLive = releaseService;
    const retention = RetentionService.withEpoch(storage, epoch, {
      settings: retentionSettings, catalog: catalogService, ...(backups === undefined ? {} : { backups }), incidents, projects: () => projectIds(projects),
      notify: async (n) => { await notifications.emitFromController({ commandId: n.commandId, kind: "maintenance", level: "needs-you", ref: n.ref, detail: n.text }); },
      meter: quotaMeter, ...(options.backup === undefined ? {} : { ledger: new DeletionLedger(join(options.backup.directory, LEDGER_FILE)) }), ...(reserve === undefined ? {} : { reserve }), ...(dataDirectory === undefined ? {} : { dataDirectory }), ...(options.retention?.autoEveryMs === undefined ? {} : { autoEveryMs: options.retention.autoEveryMs }),
    });
    // Reviewed environment changes (card A09): a request is recorded at once, decided per the installation profile, applied through the applier port and logged. A new request that a person must decide files one notice for the owner.
    const environmentApplier = options.maintenance?.applier === undefined && options.maintenance?.environmentRuntime !== undefined
      ? new EnvironmentChangeApplier({ environments, pauses, stops, runtime: options.maintenance.environmentRuntime, journal: new StorageJournal(storage, epoch, {}), ...(options.maintenance.suspendMs === undefined ? {} : { suspendMs: options.maintenance.suspendMs }) }) : undefined;
    const maintenance = MaintenanceService.withEpoch(storage, epoch, { ...(options.maintenance?.applier === undefined ? (environmentApplier === undefined ? {} : { applier: environmentApplier }) : { applier: options.maintenance.applier }), ...(options.maintenance?.heartbeatMs === undefined ? {} : { heartbeatMs: options.maintenance.heartbeatMs }), held: async (agentId) => (await pauses.agentHolds(agentId)).length > 0, notify: async (n) => { if (n.to === "owner") await notifications.emitFromController({ commandId: `mnt-req-${n.maintenanceId}`, kind: "maintenance", level: "needs-you", ref: { kind: "maintenance", id: n.maintenanceId }, detail: `${n.agentId} asked for an environment change (${n.kind}) that you decide. Read it with maintenance.get and decide with maintenance.decide.`.slice(0, 400) });
      // The supervisor who may decide it is named to the owner at the lower level (an agent has no inbox outside a task; it reads its reports' requests with maintenance.list), so the owner knows who was asked.
      else await notifications.emitFromController({ commandId: `mnt-req-${n.maintenanceId}`, kind: "maintenance", level: "notice", ref: { kind: "maintenance", id: n.maintenanceId }, detail: `${n.agentId} asked for an environment change (${n.kind}); its supervisor ${n.supervisorId ?? ""} may decide it (maintenance.list shows it to them). You can decide it too.`.slice(0, 400) }); } });
    const activation = options.releases === undefined ? undefined : ReleaseActivationService.withEpoch(storage, epoch, { ...options.releases, notices: options.releases.notices ?? notificationSink(notifications), compat: options.releases.compat ?? { workers: WORKER_PROTOCOL, required: true } });
    activationLive = activation;
    // An interrupted switch is resolved before anything is served: to the old release or the new, from what the launcher's pointer says.
    if (activation !== undefined) { try { const r = await activation.recover(); if (r.resolved === "unresolved") (options.print ?? ((l: string) => process.stderr.write(`${l}\n`)))("release activation: an interrupted switch could not be resolved (the pointer names neither release); see release.status"); } catch (error) { (options.print ?? ((l: string) => process.stderr.write(`${l}\n`)))(`release activation: recovery failed: ${redactText(String((error as Error)?.message ?? error)).slice(0, 160)}`); } }
    maintenanceLive = maintenance;
    const api = new StateApi({ approvals, critical, coordinator: () => coordinator, webAccess: () => webAccessPort, environments, jobs, ...(stagedRestore === undefined ? {} : { backupRestore: stagedRestore }), ...(databaseTransfer === undefined ? {} : { databaseTransfer }), maintenanceHeld: () => (barrier.held ? (barrier.state().reason ?? "starting") : undefined), streamSettings, contextRouteSettings, startSizes, ...(activation === undefined ? {} : { activation }), maintenance, serviceOps, ...(checked === undefined ? {} : { taskArtifacts: TaskArtifactPublisher.withEpoch(storage, epoch, checked) }), retention, retentionSettings, acceptance, reconnect, coverage, coverageSettings, leases, quietHostSettings, catalogPolicy, quietHosts: { moveWork: async (owner, command) => { const hosts = dispatch?.quietHosts; if (hosts === undefined) throw new DomainError("unavailable", "this controller runs without remote hosts"); return hosts.moveWork(owner, command); } }, catalogRevocation, setup: setupReadiness, setupProviders, credentialAdmin: principals, localHost, security: { report: (by, e) => urgentWatch.reportSecurityFrom(by, e) }, detect: (source, e) => securityDetectors.signal(source, e), eventSourceSettings, resumeSettings, workerLimits, capacityLimits, agreedLimits, escalationLadder, recoveryLadder, recoveryStep: stall, dispatchLimits, cleanupSettings, workEnd, submissions, deliverables: DeliverableService.withEpoch(storage, epoch), release: releaseService, responsibilityChecks, incidents, swarm: SwarmService.withEpoch(storage, epoch, { projects, contracts, budgets, stops, settings: swarmLimits }), swarmLimits, capacityQuotas: capacityAdmission, status, branchSettings, improvements, ...(backups === undefined ? {} : { backups }), ...(backupEncryption === undefined ? {} : { backupEncryption }), ...(backupKeyPin === undefined ? {} : { backupKeyPin }), ...(backupEncryptionSetting === undefined ? {} : { backupEncryptionSetting }), ...(backupSigning === undefined ? {} : { backupSigning }), policyForward, watchControl, standups, attendance, records, policyContext: PolicyService.withEpoch(storage, epoch, grants, { roles: (id) => agents.rolesOfPrincipal(id) }), activity, replay, replayLimits, thinkingStore, resumes, continuations: continuationOps, handoffs, cutover, routeBudgets: routing, modelBudget: fallback, commands, integration, notes, stops, pauses, workspaceOps, integratorLeases: integratorLeaseOps, branches, meetings, invitations: invitationInbox, grants, placement, spill: { readSpill: async (by, id, index, size) => dispatch?.readSpill(by, id, index, size), readRouteArchive: async (by, taskId, digest) => dispatch?.readRouteArchive(by, taskId, digest), readNoteArchive: async (by, taskId, digest) => dispatch?.readNoteArchive(by, taskId, digest) }, handoffNotes: { read: async (by, noteId) => dispatch?.readHandoffNote(by, noteId) }, watches: watchService, events: EventService.withEpoch(storage, epoch), notifications, budgets, difficulty: DifficultyService.withEpoch(storage, epoch, routing, contracts), decisions, ownerQuestions: messages, messages, principals, taskCredentials, projects, assignments, retrieval, inquiries, agents, contracts, graph, resources, plans, responsibilities, ...(options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError }) });
    let chat: ChatService | undefined;
    let coordinator: CoordinatorService | undefined;
    // The web chat listener opens after the API; the owner's sign-out and settings reads reach it through this (card U07b).
    let webAccessPort: WebAccessPort | undefined;
    if (options.chat !== undefined) {
      const o = options.chat;
      // The approval profile (A07), status explanations (U05) and conversational policy edits (U04) are composed from the services built above.
      const policy = PolicyService.withEpoch(storage, epoch, grants, { roles: (id) => agents.rolesOfPrincipal(id) });
      const policyEdits = PolicyEditService.withEpoch(storage, epoch, { policy, reviews, grants, configuration, conversations, interpreter: o.interpreter });
      policyEditsLive = policyEdits;
      chat = ChatService.withEpoch(storage, epoch, { principals, api, interpreter: o.interpreter, policy, status, policyEdits, coordinator: () => coordinator, waiting: async (owner) => (await messages.ownerQuestions(owner, { limit: 50 })).items.length, needing: (owner) => status.needsYouCount(owner), ...(o.coordinator === undefined ? {} : { coordinatorToken: o.coordinator.token }) });
      if (o.coordinator !== undefined) {
        const c = o.coordinator;
        coordinator = CoordinatorService.withEpoch(storage, epoch, {
          chat, retrieval, inquiries, projects, assignments, api, token: c.token, model: c.model, ...(c.routes === undefined ? {} : { routes: c.routes }),
          agents: async () => { const who = await principals.authenticate((await c.token())!); return (await agents.list(who, { state: "active", limit: 100 })).items.map((a) => ({ id: a.id, name: a.friendlyName, roles: a.roles })); },
          // Authentication already returns the principal with its grant records and restrictions as of now, so a revoked right stops counting at the coordinator's next use, as for any agent.
          principal: async () => { const t = await c.token(); if (t === undefined) throw new DomainError("unavailable", "the coordinator has no credential"); return principals.authenticate(t); },
          // A coordinator that is an agent record is paused, stopped and started through the same pause gates and Stop as any agent (card U03c).
          lifecycle: agentLifecycle({ agents, pauses, stops }),
          // A hosted coordinator's routes follow its agent's profile unless the owner stated routes, and its model calls are usage of that agent (card U03d): recorded, never refused.
          profileRoutes: c.profileRoutes ?? ((profile) => chatRoutes(routing, { role: "coordinator", profile })()),
          // Routes the owner states are judged against the routing table like the role's own (local data, no paid route, not disabled or excluded, a configured route), each alone, as dispatch judges a route; no table: none.
          eligibleRoutes: async (stated) => {
            const table = await routing.get();
            if (table === undefined) return [];
            const picked = selectRoute({ ...table, profiles: { ...table.profiles, "coordinator-stated": [...stated] } }, { role: "coordinator", profile: "coordinator-stated", contextTokens: 8000, needs: [], data: "local-only", paidAuthorized: false });
            return picked.candidates.filter((x) => x.eligible).map((x) => x.route);
          },
          attribute: async (by, agentPrincipal, use) => { await budgets.charge(by, { commandId: `coord-use-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`.slice(0, 120), activity: "model-call", sharedOverheadRule: "the coordinator's own model calls (hosted agent)", agentId: agentPrincipal, computeMs: use.computeMs, ...(use.projectId === undefined ? {} : { projectId: use.projectId }) }); },
          ...(options.onInternalError === undefined ? {} : { onAttributionFailure: options.onInternalError }),
        });
      }
    }
    // The first start on a database a transfer moved to notes its counters now: the epoch is taken and the start-up records are written, and no loop has run yet (card F04e).
    // An unrecorded first start only disables a rollback; it must never keep the controller from starting.
    const noteFirstStart = async (): Promise<void> => { if (stateDirectory !== undefined) { try { await withStateLock(stateDirectory, () => recordFirstStart(stateDirectory, sourcePlace, storage), { wait: true }); } catch (error) { print(`database transfer: the first start on this database could not be recorded (${error instanceof Error ? error.message.slice(0, 160) : "failed"}); a rollback of the transfer is not available`); } } };
    // The reconciler (card L01b) holds an inbox message for a paused task. No delivery destination or effect bridge is built yet, so it repairs, admits, recovers and settles waits only.
    const reconciler = new Reconciler(storage, epoch, { projects, inbox: InboxService.withEpoch(storage, epoch, assignments), effects: EffectService.withEpoch(storage, epoch, assignments), blockers: BlockerService.withEpoch(storage, epoch), waits, pauses, destinations: [], bridges: {} }, { claimant: "controller" });
    let dispatchProblem: string | undefined;
    if (options.dispatch !== undefined) {
      // The tool execution service is built over the dispatcher (below), so the dispatcher and the local host reach it late (card T06b): the local worker processes' bridge requests are answered by it, and the dispatcher asks it whether a
      // catalogue call may be run again after a restart. A request that arrives before it exists (the driver may tick in between) is refused as unavailable, and no call is taken as replay-safe then.
      const toolBridge = {
        handle: async (token: string, gateway: BoundGateway, request: BridgeRequest): Promise<BridgeResponse> => toolsLive === undefined ? { ok: false, code: "unavailable", message: "the tool bridge is not running" } : toolsLive.handle(token, gateway, request),
        replaySafe: async (...a: Parameters<ToolExecutionService["replaySafe"]>): Promise<boolean> => toolsLive === undefined ? false : toolsLive.replaySafe(...a),
      };
      try {
        dispatch = await composeDispatch({ continuations, ...(options.targetVersions === false ? {} : { targetVersion: createTargetVersions({ storage, location: (taskId) => resources.checkoutLocation(taskId), ...(options.targetVersions === undefined ? {} : { options: options.targetVersions }) }) }), ...(options.tools === undefined ? {} : { toolBridge }), beforeLoops: noteFirstStart, hold: () => barrier.held, installationSettings: (keys) => configuration.installationSettings(keys), streamSettings, contextRouteSettings, retention: { sweep: (by) => retention.sweep(by), restoreReserve: async () => { await reserve?.restore(); } }, release: releaseService, quietHosts: { settings: quietHostSettings, ...(options.dispatch?.quietHosts === undefined ? {} : { options: options.dispatch.quietHosts }) }, notifyAggregate, storage, epoch, workspaceOps, bindWorkspacePort: (f) => { workspacePort = f; }, stops, records, responsibilities: { checks: responsibilityChecks, incidents, coverage: { service: coverage, notify: async (g) => { const more = (n: number): string => `; and ${n} more`; let list = ""; let shown = 0; for (const x of g.items) { const next = `${list}${shown === 0 ? "" : "; "}${x.title.slice(0, 30)}`; if (next.length > 110) break; list = next; shown++; } await notifications.emitFromController({ commandId: g.alertId, kind: "maintenance", level: "needs-you", ref: { kind: "responsibility", id: g.items[0]!.responsibilityId }, projectId: g.projectId, detail: `${g.count} responsibilit${g.count === 1 ? "y is" : "ies are"} without coverage: ${list}${g.count > shown ? more(g.count - shown) : ""}. See responsibility.coverage.`.slice(0, 200) }); } }, notify: async (e) => {
          // The text must not change between ticks (no alert count): the command ids are fixed, so a retry after a failed markNotified must carry the same payload.
          const detail = `An incident on a responsibility (${e.signature}) is still open past its escalation time.`;
          if (e.escalatedTo === "owner") await notifications.emitFromController({ commandId: `inc-esc-${e.id}`, kind: "maintenance", level: "needs-you", ref: { kind: "responsibility-incident", id: e.id }, projectId: e.projectId, detail });
          // An agent is told through its inbox, as a budget holder is: the notice is filed about a task the agent holds in the project (an incident has none), and with none it is retried each tick.
          else if (e.escalatedTo?.startsWith("agent:")) {
            const taskId = await assignedTaskIn(storage, e.projectId, e.escalatedTo);
            if (taskId === undefined) throw new DomainError("unavailable", `${e.escalatedTo} holds no task in the project to file the escalation notice against`);
            await messages.noticeFromController({ commandId: `inc-esc-${e.id}`, taskId, to: e.escalatedTo, purpose: "An incident was escalated to you", text: `${detail} Responsibility ${e.responsibilityId}; incident ${e.id}.` });
          }
        } }, onDenied: (d) => urgentWatch.reportDenial(d.agentId, d.projectId), securityReport: (by, e) => urgentWatch.reportSecurityFrom(by, e), detect: (source, e) => securityDetectors.signal(source, e), eventSources: async () => [...eventSourceList, ...(await eventSourceSettings.definedSources())], eventSourcesOff: () => eventSourceSettings.disabled(), workerLimits: () => workerLimits.effective(), environments, landingPolicy: landingPolicyFrom(configuration, (projectId) => branchSettings.landingOf(projectId)), workerPolicy: { bestEffortAllowed: () => workerLimits.bestEffortAllowed(), recordLaunch: (r) => workerLimits.recordLaunch(r) }, dispatchLimits: () => dispatchLimits.effective(), taskMinutes: async (taskId) => { const v = await configuration.taskValue("time.maxMinutes", taskId); return typeof v === "number" ? v : undefined; }, routes: { cutover, fallback }, ...(options.routeProbes === undefined ? {} : { probes: { cutover, probes: { enabled: () => options.routeProbes?.enabled === true, run: options.routeProbes.run, intervalMs: options.routeProbes.intervalMs ?? 60_000 } } }), ...(backups === undefined ? {} : { backups }), resumes, handoffs, sweeps: [{ name: "handoffs.sweep", sweep: (by) => handoffs.sweep(by) }, { name: "resumes.sweep", sweep: (by) => resumes.sweep(by) }, { name: "workend.complete", sweep: () => workEnd.recover() }, { name: "scratch.recover", sweep: async () => { await scratchCleanup.recover(); } }, { name: "urgent.watch", sweep: (by) => urgentWatch.sweep(by, { throttled: true }) }, ...(activation === undefined ? [] : [{ name: "release.start-notices", sweep: async () => { await activation.deliverStartNotices(); } }]), ...(backupEncryption === undefined ? [] : [{ name: "backup.proof-reminder", sweep: () => proofReminder.sweep({ throttled: true }) }]), { name: "notifications.run", sweep: () => notifications.runDue({ throttled: true }) }], leadMinutes: meetingLead, options: withPlacement(options.dispatch), safeLongRunning: safeLongRunningOf(jobs, { enabled: async () => (await configuration.installationValue(SAFE_LONG_RUNNING_SETTING)) !== false }), jobWaits: (taskId) => jobs.waitable(taskId), ...(interrogator === undefined ? {} : { interrogator }), ...(options.availability === undefined ? {} : { availability: options.availability }), ...(options.meetingWake === undefined ? { wakeHost: wakeHost! } : {}), meetingWake: options.meetingWake === undefined ? meetingWakeSink(wakeHost!) : meetingWakeSink(options.meetingWake, options.meetingWake.timeoutMs === undefined ? {} : { timeoutMs: options.meetingWake.timeoutMs }), ...(options.meetingWake !== undefined ? {} : { pausedAvailability: (p: string, o?: { readonly meetingWake?: boolean }) => wakeHost!.availability(p, o) }), recovery: { stall, reconciler }, principals, grants, taskCredentials, projects, assignments, waits, contracts, catalog, routing, inquiries, agents, histories, reviews, retrieval, ...(options.onInternalError === undefined ? {} : { onError: options.onInternalError }) });
      } catch (error) {
        // A dispatcher the owner disabled, or a store that failed here, must not keep the rest of the controller from starting; the operator is told, and the reason stays on the controller.
        dispatchProblem = error instanceof Error ? error.message.slice(0, 300) : "the dispatcher could not be built";
        print(`The dispatcher is not running: ${dispatchProblem}`);
      }
    }
    // Endings still open when the controller went down are completed once, from their first undone step (the tick's sweep does the same for what is left).
    // The dispatcher asks the ending before it ends an attempt for any reason: a stop drops it with its true reason, the turn completing after work.end completes it with the agent's result.
    dispatch?.dispatcher.onEnd((attemptId, how) => workEnd.resolveOnEnd(attemptId, how));
    dispatch?.dispatcher.onEnded((attemptId, how) => workEnd.cleanupAfterEnd(attemptId, how.signal));
    if (dispatch !== undefined) await workEnd.recover().catch((error: unknown) => { options.onInternalError?.(error); });
    // Card T07b: every job that was live when this controller started gets a decision by the rule for its class (decideAtStart), so none is left without one.
    let jobsAtStart: { decided: number; failed: number } | undefined;
    if (dispatch !== undefined) {
      const local = options.tools?.isLocalHost ?? ((): boolean => options.dispatch?.local !== undefined);
      try {
        const report = await decideAtStart(jobs, dispatch.principal, { epoch, before: startedAt, isLocal: local });
        jobsAtStart = { decided: report.decided.length, failed: report.failed.length };
        if (report.failed.length > 0) print(`${report.failed.length} job(s) live at the last shutdown could not be decided at start: ${report.failed.slice(0, 3).map((f) => `${f.jobId} (${f.error})`).join("; ")}`);
      } catch (error) { options.onInternalError?.(error); jobsAtStart = { decided: 0, failed: 1 }; }
      if (options.jobs !== undefined && options.tools !== undefined) {
        const host = dispatch.principal;
        // A job does not run on after its task: the runs stop the jobs whose task is done or cancelled (both final), or gone.
        const taskEnded = async (taskId: string): Promise<boolean> => { const t = await projects.getTask(taskId); return t === undefined || t.state === "done" || t.state === "cancelled"; };
        jobRuns = new LocalJobRuns({ jobs, principal: () => host, launcher: options.jobs.launcher, taskEnded, ...(options.onInternalError === undefined ? {} : { onError: options.onInternalError }), ...(options.jobs.limits === undefined ? {} : { limits: options.jobs.limits }) });
      }
    }
    const mcpParts = dispatch?.mcp;
    const mcpHost = dispatch?.principal;
    const mcpJobs = mcpParts === undefined || mcpHost === undefined ? undefined : { call: (by: Principal, call: McpJobCall) => callToolAsJob({ jobs, client: mcpParts.client, host: mcpHost }, by, call) };
    let tools: ToolExecutionService | undefined;
    if (options.tools !== undefined && dispatch !== undefined) {
      const ro = {};
      tools = toolsLive = new ToolExecutionService({
        principal: dispatch.principal, credentials: taskCredentials, dispatch: { get: (...a) => dispatch!.dispatcher.get(...a), toolOperation: (...a) => dispatch!.dispatcher.toolOperation(...a) }, assignments, catalog: catalogService,
        hosts: HostService.withEpoch(storage, epoch, assignments, ro), admission: AdmissionService.withEpoch(storage, epoch, ro), pauses, desks,
        // The task, artifact and message requests of the bridge go through the API and the message service every client uses (card C09h: without them a worker's output and messages never reached the task or its activity).
        state: api, recall: dispatch.recall, messages, activity: (step) => activity.record(dispatch!.principal, { commandId: step.commandId, taskId: step.taskId, kind: step.kind, summary: step.summary, manifest: { refs: step.refs } } as never), pauseTask: (owner, taskId, reason, commandId) => pauses.pause(owner, { commandId, scope: { kind: "task", id: taskId }, reason }), notice: async (n) => { await notifications.emitFromController({ commandId: n.commandId, kind: "maintenance", level: "needs-you", ref: { kind: "task", id: n.taskId }, detail: n.text }); }, ...options.tools, generations: dispatch.generation, ...(jobRuns === undefined ? {} : { jobs, jobRuns }), ...(streamSettings === undefined ? {} : { callCheck: async () => { const v = await streamSettings.effective(); return { check: v.checkBridge, require: v.requireRecorded, bind: v.bindCall, admit: v.admitCall, requireStream: v.requireStream, record: v.record }; } }), revocationPolicy: () => catalogPolicy.effective(),
        // Card T02d: a revocation taken by another process pauses as the owner who revoked (read from the store, active principals only).
        // Card T02d close-out: each running call is also on the durable record, so another controller process on this store lists it and the owner's revoke question and choice reach it.
        runRecords: RunningCallStore.withEpoch(storage, epoch),
        revocationOwner: async (id) => { const p = await principals.get(id); return p === undefined || p.kind !== "owner" || p.state !== "active" ? undefined : { id: p.id, kind: p.kind, name: p.name, grants: p.grants }; },
      });
    }
    // Records of runs a stopped (or fenced) controller could not remove are cleared once they can no longer be running. Best effort (never throws; one bounded look), waited for so it never races the close.
    if (tools !== undefined) await tools.sweepRunRecords().catch(() => 0);
    await noteFirstStart(); // without a dispatcher: still before the maintenance loop and the transport
    const transport = options.conversationTransport === undefined ? undefined : await ConversationTransport.listen({ mcpEnabled: async () => (await configuration.installationValue(MCP_ENABLED_SETTING)) !== false, ...options.conversationTransport, conversations, principals });
    let webChat: WebChatDoor | undefined;
    // A web chat that cannot open (no owner chat, a refused binding, a port in use) must not leave the conversation transport listening behind a failed start.
    if (options.webChat !== undefined) try {
      const owned = chat;
      if (owned === undefined) throw new DomainError("invalid_command", "the web chat needs the owner chat (the chat option)", { field: "webChat" });
      webChat = await WebChatDoor.listen({ ...options.webChat, backend: {
        authenticate: (token) => principals.authenticate(token),
        // The web page keeps what it receives in the browser (its outbox), so it is never given a credential shown once: those operations are refused here and done in the terminal chat.
        // Whatever the web listener passes (its `stillAllowed` check), the secrets flag is set here and cannot be overridden by it.
        submit: (token, message, options) => owned.submit(token, message, { ...options, secrets: false }),
        decide: (token, message, options) => owned.submit(token, { messageId: message.messageId, text: message.text }, { ...options, secrets: false, fixedIntents: message.intents }),
        applyProposal: (token, request, options) => owned.applyProposal(token, request, { ...options, secrets: false }),
        discardProposal: (token, request, options) => owned.discardProposal(token, request, options),
        query: async (token, op, args) => {
          const r = await api.handle(token, { v: 1, op, args });
          return r.ok ? { ok: true, result: r.result } : { ok: false, error: { code: r.error.code, message: r.error.message } };
        },
      } });
      const door = webChat;
      webAccessPort = { settings: () => door.settings(), browsers: (ownerId) => door.browsers(ownerId), revoke: (ownerId, want, commandId) => door.revokeBrowsers(ownerId, want, undefined, commandId) };
    } catch (error) { await transport?.close().catch(() => undefined); throw error; }
    // A change that was approved but not finished when the last controller ended is picked up again (bounded; the applier is idempotent by request ID).
    maintenance.background(maintenance.ensureSettings().then(() => maintenance.resume()));
    // The maintenance loop: settings changes and lease expiries are looked at here, a bounded number per round, never inside the settings write.
    // The loop period is the owner's setting (maintenance.settings.set tickSeconds), read before each round; a start option overrides it for tests.
    let heartbeat: HeartbeatWriter | undefined;
    let maintenanceStopped = false;
    let maintenanceTimer: ReturnType<typeof setTimeout> | undefined;
    const maintenanceRound = (): void => {
      if (maintenanceStopped) return;
      maintenance.background(maintenance.tick());
      void (options.maintenance?.tickMs !== undefined ? Promise.resolve(options.maintenance.tickMs) : maintenance.tickMs()).catch(() => 30_000).then((ms) => { if (!maintenanceStopped) { maintenanceTimer = setTimeout(maintenanceRound, ms); maintenanceTimer.unref(); } });
    };
    void maintenance.tickMs().catch(() => 30_000).then((first) => { if (!maintenanceStopped) { maintenanceTimer = setTimeout(maintenanceRound, options.maintenance?.tickMs ?? first); maintenanceTimer.unref(); } });
    // Liveness heartbeat (card K02): under the launcher, a timer beats into the file the launcher named, so it can tell a hung controller from a working one. Before the confirmation below, so the first beat precedes it. Never stops the start.
    const heartbeatFile = options.heartbeat === false ? undefined : options.heartbeat?.file ?? options.env[HEARTBEAT_ENV.file];
    if (heartbeatFile !== undefined && heartbeatFile !== "") {
      const hbSay = options.print ?? ((l: string) => process.stderr.write(`${l}\n`));
      const token = options.heartbeat === false ? undefined : options.heartbeat?.token ?? options.env[HEARTBEAT_ENV.token];
      const requested = options.heartbeat === false ? undefined : options.heartbeat?.intervalMs ?? Number(options.env[HEARTBEAT_ENV.intervalMs] ?? "");
      try { heartbeat = await HeartbeatWriter.start({ file: heartbeatFile, token: token ?? "", ...(requested === undefined || !Number.isFinite(requested) ? {} : { intervalMs: requested }), onProblem: hbSay }); } catch (error) { hbSay(`liveness heartbeat is off: ${(error as Error).message.slice(0, 160)}`); }
    }
    // Everything is up: a controller started by the launcher from the release the record names as current says so, and that release becomes the last known good (card K02). A failure here never stops the controller.
    if (activation !== undefined) {
      const say = options.print ?? ((l: string) => process.stderr.write(`${l}\n`));
      // The owner's startup window goes into the launcher's own file (it cannot read the database); then the start is confirmed; then the owner is told what the launcher wrote while no controller could (a fall-back, a failed start).
      try { await activation.syncLauncherWindow(); } catch (error) { say(`release activation: copying the startup window to the launcher failed: ${(error as Error).message.slice(0, 160)}`); }
      try { await activation.confirmStartup(); } catch (error) { say(`release activation: confirming the start failed: ${(error as Error).message.slice(0, 160)}`); }
      try { await activation.deliverStartNotices(); } catch (error) { say(`release activation: telling the owner about the launcher's notices failed (they stay pending): ${(error as Error).message.slice(0, 160)}`); }
    }
    return {
      api, storage, epoch, check, filesystems, prerequisites, services: { integratorLeases, maintenance, setupProviders, localHost, environments, retention, retentionSettings, ...(backups === undefined ? {} : { backups }), acceptance, catalog: catalogService, workEnd, scratchCleanup, records, activity, continuations, resumes, handoffs, cutover, fallback, principals, taskCredentials, grants, projects, assignments, waits, stall, desks, histories, retrieval, inquiries, agents, harnesses: catalog, contracts, graph, resources, plans, responsibilities, reviews, conversations, configuration, routing, pauses, branches, jobs },
      ...(chat === undefined ? {} : { chat }), ...(coordinator === undefined ? {} : { coordinator }),
      ...(dispatch === undefined ? {} : { dispatch }), ...(tools === undefined ? {} : { tools }), ...(jobRuns === undefined ? {} : { jobRuns }), ...(jobsAtStart === undefined ? {} : { jobsAtStart }), ...(mcpJobs === undefined ? {} : { mcpJobs }), ...(dispatchProblem === undefined ? {} : { dispatchProblem }),
      ...(transport === undefined ? {} : { conversationUrl: transport.url }), ...(webChat === undefined ? {} : { webChat }),
      // The heartbeat stops last: a clean stop that takes a while (a backup finishing, workers closing, the database shutting down) keeps beating, so the launcher never takes it for a hang and kills it.
      close: async () => { try { maintenanceStopped = true; transferLive?.dispose(); if (maintenanceTimer !== undefined) clearTimeout(maintenanceTimer); await maintenance.close().catch(() => undefined); tools?.dispose(); await jobRuns?.close().catch(() => undefined); await dispatch?.driver.stop(); await scratchCleanup.close().catch(() => undefined); await dispatch?.closeWorkers().catch(() => undefined); await transport?.close(); await webChat?.close(); await backups?.finish(); await storage.close(); } finally { await heartbeat?.stop().catch(() => undefined); } },
    };
  } catch (error) {
    toolsLive?.dispose();
    await jobRuns?.close().catch(() => undefined);
    await dispatch?.driver.stop().catch(() => undefined);
    await dispatch?.closeWorkers().catch(() => undefined);
    await storage.close().catch(() => undefined);
    throw error;
  }
}
