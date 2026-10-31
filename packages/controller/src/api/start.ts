import { createHash } from "node:crypto";
import { assignedTaskIn, type RouteProbes } from "../dispatch/loops.js";
import { allows } from "../security/access.js";
import { PlacementSettingsService } from "../remote/placement-settings.js";
import { QuietHostSettingsService } from "../remote/quiet-host-settings.js";
import { ReconnectSettingsService } from "../remote/reconnect-settings.js";
import { InvitationInbox, MEETING_LIMITS, MEETING_SETTINGS, MeetingService, meetingWakeSink, checkMeetingWakeTimeout, type HostWakeRequest } from "../meetings/index.js";
import { BackupEncryption, BackupKeyPinService, BackupService, createBackup, readKeyringFile } from "../backup/index.js";
import { readFile } from "node:fs/promises";
import { defaultEventSources } from "./default-sources.js";
import { ImprovementService } from "../standups/improvements.js";
import { shareableCite } from "../meetings/shareable.js";
import { reassignWarningSink } from "../meetings/reassign-warning.js";
import { MeetingRecordService, budgetRaiseApplier, grantApplier, taskReassignApplier, taskUpdateApplier } from "../meetings/record.js";
import { EventService, EventSourceSettingsService, type EventSource } from "../events/index.js";
import { BudgetService, holderNotice, type NotifyAggregate } from "../budgets/index.js";
import { NotificationService } from "../notifications/index.js";
import { EscalationLadderService, RecoveryLadderService, StallService, type RecoveryEffects, type StallOptions } from "../health/index.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { AssignmentService } from "../domain/assignments.js";
import { WaitService } from "../domain/waits.js";
import { DeskService, HistoryService, RetrievalService, WorkingNoteService } from "../context/index.js";
import { dirname, isAbsolute, resolve } from "node:path";
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
import { ReleaseService } from "../release/index.js";
import { SwarmService } from "../swarm/index.js";
import { CoverageService, CoverageSettingsService, IncidentService, ProjectPlanService, ProjectResourceService, ResponsibilityChecks, ResponsibilityService } from "../projects/index.js";
import { InquiryService } from "../inquiries/index.js";
import { GrantService, PrincipalService, TaskCredentialService, type Principal } from "../security/index.js";
import { SqliteStorage, probeSqliteLibrary } from "../storage/sqlite/index.js";
import { PostgresStorage, probePostgresLibrary } from "../storage/postgres/index.js";
import type { ControllerStorage } from "../storage/types.js";
import type { BeforeUpgrade } from "../storage/snapshot.js";
import { SetupReadinessService } from "../setup/index.js";
import type { CatalogRevocationPort } from "./operations.js";
import { StateApi } from "./state-api.js";
import { ConfigurationService } from "../configuration/index.js";
import { ConversationService, type Availability } from "../conversations/index.js";
import { AgentMessageService } from "../messaging/index.js";
import { PolicyEditService } from "../chat/index.js";

import { CatalogService } from "../catalog/index.js";
import { AdmissionService } from "../admission/index.js";
import { HostService } from "../hosts/index.js";
import { ToolExecutionService, type ToolExecutionDeps } from "../toolbridge/index.js";
import { CommandService, catalogSource } from "../commands/index.js";
import { BUILTIN_COMMANDS } from "./operations.js";

import { wideningDecision } from "./widening.js";
import { IntegrationPolicyService, PolicyService, ProtectedBranchService } from "../policy/index.js";
import { StatusService } from "../status/index.js";
import { ChatService, CoordinatorService, type ChatInterpreter, type CoordinatorModel } from "../chat/index.js";
import { ContextBranchService } from "../branches/index.js";
import { JobService } from "../jobs/index.js";
import { ContinuationService, ResumeCheckService, ResumeSettingsService, controllerResumePorts } from "../continuation/index.js";
import { DependencyService } from "../dependencies/index.js";
import { ActivityService } from "../activity/index.js";
import { WorkEndService, checkpointVerdict, dispatcherEndingPorts, stagedSubmit, type EndingAttempt, type Landed, type StagedWork } from "../work-end/index.js";
import { HandoffService, PauseService, StopService, agentsUnder, controllerHandoffSources, dispatchStopPorts, type LocalWork } from "../lifecycle/index.js";
import { SubmissionService, attemptOfAssignments } from "../submissions/index.js";
import { ReviewService } from "../review/index.js";
import { CutoverService, DifficultyService, FallbackService, RoutingService } from "../routing/index.js";
import { checkLocalWorkerLimits } from "./worker-limits.js";
import { AgreedLimitsSettingsService } from "./agreed-limits-settings.js";
import { WorkerLimitsSettingsService } from "./worker-limits-settings.js";
import { CapacityLimitsService } from "../admission/caps.js";
import { DispatchLimitsSettingsService } from "./dispatch-limits-settings.js";
import { CleanupSettingsService, ScratchCleanupService, ownerNotices, supervisorNotice, scratchRecordId, type ScratchMode, type ScratchPorts } from "../work-end/index.js";
import { WorkspaceOpService } from "../workspace-ops/index.js";
import { ArtifactService, DeliverableService, FileBlobStore } from "../artifacts/index.js";
import { composeDispatch, type DispatchHandle, type DispatchStartOptions } from "./dispatch-compose.js";
import { ConversationTransport, type TransportOptions } from "../transport/index.js";

export type StorageChoice =
  | { readonly kind: "sqlite"; readonly path: string }
  | { readonly kind: "postgres"; readonly url: string; readonly schema?: string; readonly maxConnections?: number; /** A stricter floor than the supported minimum (it can never be lower). Mostly for tests. */ readonly minimumServerVersionNum?: number };

export interface StartOptions {
  readonly storage: StorageChoice;
  /** The command line and environment of the process: the operator's override is read from them (`--allow-unsupported-environment`, `NIMBLENEWT_ALLOW_UNSUPPORTED_ENVIRONMENT=1`). */
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Where start-up notices go. Default: standard error. */
  readonly print?: (line: string) => void;
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
  /** What the lifecycle says about a principal (cards L01 and L02 supply it). Default: everyone is available. */
  readonly availability?: (principalId: string) => Promise<Availability>;
  /** How the host brings an agent its `availability` hook reports stopped or suspended up for one meeting (card M04f). Called only after the owner authorized that wake (`meeting.wake`), once per meeting and agent key, and must treat a repeated key as the same request. Absent: that authorization is refused. */
  readonly meetingWake?: { readonly recover: (request: HostWakeRequest) => Promise<void>; readonly timeoutMs?: number };
  /** Stall detection's thresholds, the margin and the speeds a route is read at before it has been measured (card V01b); the controller's own pause check is not replaceable. */
  readonly stall?: Pick<StallOptions, "thresholds" | "declaredSpeed" | "defaultReadTokensPerSecond" | "readMarginPercent" | "escalateAfterMs">;
  /**
   * Builds the attempt dispatcher and runs its loops (card H12c): the tick, the messages, attendance, stand-up, event and decision loops. Off unless given. The loops run only while this controller
   * holds the primary epoch; a newer controller instance stops them here. See `DispatchStartOptions`.
   */
  readonly dispatch?: DispatchStartOptions;
  /**
   * The protected tool bridge for catalogue tools (card T06, wired by T02b): the script runner and which hosts are this machine. Off unless given (and it needs `dispatch`). The service is built ONCE here, over the controller's one
   * catalogue, so a revocation reaches the calls it runs; `revocationPolicy` is only the fallback for a revocation that carried no owner choice.
   */
  readonly tools?: Pick<ToolExecutionDeps, "runner" | "isLocalHost" | "facts" | "revocationPolicy">;
  /**
   * Where the artifact files are kept (card U05b). Given, the status answers check each delivered artifact against its files and say whether they match, are damaged, or were not checked; absent: they are shown as not checked and never as verified.
   * This controller only reads through it (it publishes nothing here), but opening creates the folder if it is missing, so a mistyped path shows every artifact as not matching until it is corrected. Not defaulted from the remote hosts' blob folder: name it explicitly.
   */
  readonly artifacts?: { readonly directory: string };
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
  readonly routeProbes?: { readonly run: RouteProbes["run"]; readonly intervalMs?: number; readonly enabled?: boolean };
  readonly backup?: { readonly directory: string; readonly everyMs?: number; readonly retention?: { readonly daily: number; readonly weekly: number }; readonly version?: string; readonly now?: () => Date;
    /** Encrypted backups (card K01b). Off unless given. `keyringFile` is made on the host by `backup encryption-setup`; the passcode and recovery files are the out-of-band files the owner points the proof at (never the chat). If the keyring cannot be read the controller does not start: it never falls back to plain backups. */
    readonly encryption?: { readonly keyringFile: string; readonly passcodeFile?: string; readonly recoveryFile?: string } };
  /**
   * Owner chat (card U03): the interpreter that reads the owner's messages (a model behind the routed client in production; a scripted one in tests) and, optionally, the persistent coordinator's model and credential. Absent: no chat service is built.
   * The approval profile (A07), status explanations (U05) and conversational policy edits (U04) are composed in. The coordinator is controller-managed and nothing depends on it: when it is paused, stopped or its routes fail, the chat and the rest of the controller carry on.
   */
  readonly chat?: {
    readonly interpreter: ChatInterpreter;
    readonly coordinator?: { readonly model: CoordinatorModel; /** The coordinator agent's credential, held by the controller. */ readonly token: () => Promise<string | undefined>; /** Where its routes come from at each question (the routing table, via `chatRoutes`); absent: the routes stored with it. */ readonly routes?: () => Promise<readonly string[]> | readonly string[] };
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
    readonly backups?: BackupService;
    readonly workEnd: WorkEndService; readonly scratchCleanup: ScratchCleanupService;
    /** The one catalogue (revoke path and tool bridge share it). */
    readonly catalog: CatalogService;
    readonly principals: PrincipalService; readonly taskCredentials: TaskCredentialService; readonly grants: GrantService; readonly projects: ProjectService; readonly assignments: AssignmentService;
    readonly waits: WaitService; readonly stall: StallService; readonly desks: DeskService; readonly histories: HistoryService; readonly retrieval: RetrievalService; readonly inquiries: InquiryService; readonly agents: AgentService; readonly harnesses: HarnessCatalog; readonly contracts: ContractService; readonly graph: WaitGraphService; readonly resources: ProjectResourceService; readonly plans: ProjectPlanService; readonly responsibilities: ResponsibilityService; readonly reviews: ReviewService; readonly conversations: ConversationService; readonly configuration: ConfigurationService; readonly routing: RoutingService; readonly records: MeetingRecordService; readonly activity: ActivityService; readonly continuations: ContinuationService; readonly resumes: ResumeCheckService; readonly handoffs: HandoffService; readonly cutover: CutoverService; readonly fallback: FallbackService; readonly pauses: PauseService; readonly branches: ContextBranchService;
    readonly jobs: JobService;
  };
  /** The dispatcher and the driver of its loops, when `dispatch` was given and the dispatcher could be provisioned. */
  readonly dispatch?: DispatchHandle;
  /** The tool bridge's execution service, when `tools` was given and the dispatcher was built. It is the only one: it subscribes to revocations of `services.catalog`. */
  readonly tools?: ToolExecutionService;
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
export async function startController(options: StartOptions): Promise<Controller> {
  if (options.meetingWake !== undefined) checkMeetingWakeTimeout(options.meetingWake.timeoutMs);
  if (options.tools !== undefined && options.dispatch === undefined) throw new Error("options.tools needs options.dispatch: the tool bridge runs over the dispatcher, so without it the tools would be ignored");
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
  // An existing database that is about to be upgraded to a newer schema is copied first, when backups are configured (card K01): if the copy cannot be made, the upgrade does not happen.
  const beforeUpgrade: BeforeUpgrade | undefined = options.backup === undefined ? undefined : async (notice) => {
    await createBackup({ snapshot: notice.snapshot }, { root: options.backup!.directory, kind: "pre-upgrade", version: options.backup!.version ?? "0.0.0", ...(options.backup!.now === undefined ? {} : { now: options.backup!.now }), ...(backupEncryption === undefined ? {} : { encryption: backupEncryption.keyring }) });
    print(`The database is being upgraded from schema ${notice.from} to ${notice.to}; a backup of it as it was is in ${options.backup!.directory}.`);
  };
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

  let dispatch: DispatchHandle | undefined;
  let toolsLive: ToolExecutionService | undefined;
  try {
    const projects = await ProjectService.open(storage, { holder: options.holder ?? "controller" });
    const epoch = projects.epoch;
    // The backup public key is pinned the first time it is loaded; a different one is refused until the owner approved its fingerprint (card K01b).
    const backupKeyPin = backupEncryption === undefined ? undefined : BackupKeyPinService.withEpoch(storage, epoch);
    if (backupEncryption !== undefined) {
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
    const pauses = PauseService.withEpoch(storage, epoch, { waits }, options.availability === undefined ? {} : { otherAvailability: options.availability });
    // Suspected stalls: a task under a pause is assessed as paused, never as stalled (card L01).
    // The routing table is refused unless the coordinator, the safety supervisor and every other role in it have a valid fallback list (card R04).
    const routing = RoutingService.withEpoch(storage, epoch, {}, {});
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
    const stall = StallService.withEpoch(storage, epoch, assignments, waits, { ...(options.stall ?? {}), recoveryPolicy: () => recoveryLadder.policy(), recoveryEffects: { run: (action, ctx) => (recoveryRun ?? (() => { throw new DomainError("unavailable", "recovery steps are not available yet"); })()).run(action, ctx), unavailable: (action, ctx) => (recoveryRun?.unavailable?.(action, ctx) ?? Promise.resolve(undefined)) }, ladderHours: () => escalationLadder.hours(), ladderDamaged: async (n) => { await notifications.emitFromController({ commandId: n.id, kind: "maintenance", level: "needs-you", ref: { kind: "principal", id: "dispatcher" }, detail: n.detail }); }, declaredSpeed, isPaused: (taskId) => pauses.isPaused(taskId) });
    // Durable job records (card T07): a permitted background job's result goes to the pause service; no MCP connection check is bound until an MCP client exists, so no MCP operation is admitted.
    // The time a job or a review took is charged to its task by the dispatcher's budget service once that is built; a charge that fails is reported, and the job or review stands (card R05f).
    const charged = async (usage: { commandId: string; activity: "review" | "background-job"; taskId: string; agentId?: string; computeMs: number }): Promise<void> => { try { await dispatch?.chargeUse(usage); } catch (error) { options.onInternalError?.(error); } };
    const jobs = JobService.withEpoch(storage, epoch, { pauses }, { background: (principal, request) => pauses.recordFinishedJob(principal, request), longRunningGate: async (principal, taskId) => { const meeting = principal.kind === "agent" ? await dispatch?.attendance.meetingOfTask(taskId, principal.id) : undefined; return meeting === undefined ? undefined : `${principal.id} is in meeting ${meeting.occurrenceId} (until ${meeting.endsAt}); long-running work is not started during a meeting`; }, onUsage: (u) => charged({ commandId: u.commandId, activity: "background-job", taskId: u.taskId, computeMs: u.computeMs }) });
    // The reviewer's host is the one its running attempt is on, or the host a moved attempt is pinned to (known once the dispatcher is built); without one, or when the lookup fails, the host is not judged.
    const reviews = ReviewService.withEpoch(storage, epoch, {
      onDecided: async (e) => { await activity.record({ id: "service:reviews", kind: "service", name: "reviews", grants: [] } as Principal, { commandId: `rev-act:${e.requestId}:${e.verdict}`, taskId: e.taskId, kind: "approval", summary: `${e.decidedBy} ${e.verdict === "allow" ? "approved" : "denied"} ${e.tool}: ${e.reason}`, manifest: { refs: [{ kind: "review", id: e.requestId }] } } as never); },
      onUsage: (u) => charged({ commandId: u.commandId, activity: "review", taskId: u.taskId, agentId: u.agentId, computeMs: u.computeMs }), availability: pauses.availability, reviewerHost: async (principalId) => { try { return await dispatch?.hostOfAgent(principalId); } catch { return undefined; } } });
    const graph = WaitGraphService.withEpoch(storage, epoch, contracts, BlockerService.withEpoch(storage, epoch), { extraEdges: (projectId, tasks) => reviews.waitEdges(projectId, tasks) });

    // Where local-only data may go: the owner's setting over the approval profile's default, consulted at every placement on a remote host unless the operator gave a placement policy of their own (card H07c).
    const placement = PlacementSettingsService.withEpoch(storage, epoch);
    // A move of an attempt (the owner's, or the quiet-host pass's) judges the data location by the same setting when the controller supplies the placement policy and the operator gave no relocation policy: a host the owner lets hold local-only data at a placement may hold it after a move.
    const reconnectSettings = ReconnectSettingsService.withEpoch(storage, epoch);
    const reconnect = { get: (by: Principal) => reconnectSettings.get(by), set: (owner: Principal, command: Parameters<typeof reconnectSettings.set>[1]) => reconnectSettings.set(owner, command), decideReaccept: (owner: Principal, command: never) => { if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not decide on taking an attempt up again`); if (dispatch?.remote === undefined) throw new DomainError("unavailable", "remote workers are not running"); return dispatch.remote.decideReaccept(owner, command); }, pending: (owner: Principal, page: { after?: string; limit?: number }) => { if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not list the attempts waiting for a decision`); if (dispatch?.remote === undefined) throw new DomainError("unavailable", "remote workers are not running"); return dispatch.remote.pending(owner, page); } };
    const withPlacement = <T extends NonNullable<StartOptions["dispatch"]>>(dispatch: T): T => (dispatch?.remote === undefined || (dispatch.remote.placementPolicy !== undefined && dispatch.remote.reaccept !== undefined && dispatch.remote.patienceMs !== undefined) ? dispatch : Object.create(dispatch, { remote: { value: { ...dispatch.remote, ...(dispatch.remote.placementPolicy === undefined ? { placementPolicy: placement.policy(), ...(dispatch.remote.relocationPolicy === undefined ? { relocationPolicy: async () => ({ dataHosts: [...((await placement.policy()()).dataHosts ?? [])] }) } : {}) } : {}), ...(dispatch.remote.reaccept === undefined ? { reaccept: () => reconnectSettings.effective() } : {}), ...(dispatch.remote.patienceMs === undefined ? { patienceMs: () => reconnectSettings.patienceMs() } : {}) }, enumerable: true } }) as T); // not a spread: the options are read when the dispatcher is built, not here
    const configuration = ConfigurationService.withEpoch(storage, epoch, { routing, settings: MEETING_SETTINGS });
    const conversations = ConversationService.withEpoch(storage, epoch, { availability: pauses.availability });
    const resources = ProjectResourceService.withEpoch(storage, epoch);
    const plans = ProjectPlanService.withEpoch(storage, epoch);
    const responsibilities = ResponsibilityService.withEpoch(storage, epoch);
    const responsibilityChecks = ResponsibilityChecks.withEpoch(storage, epoch, responsibilities);
    const incidents = IncidentService.withEpoch(storage, epoch, responsibilities);
    const coverageSettings = CoverageSettingsService.withEpoch(storage, epoch);
    const coverage = CoverageService.withEpoch(storage, epoch, coverageSettings);
    // Questions to the owner (card U12): agents ask through the API, the owner sees and answers them; the owner is told through the notifications.
    const notifications = NotificationService.withEpoch(storage, epoch);
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
    const meetings = MeetingService.withEpoch(storage, epoch, { inquiries }, { availability: pauses.availability, leadMinutes: meetingLead, ownerTimeZone: async () => { const v = await configuration.installationValue("meeting.timeZone"); return typeof v === "string" ? v : undefined; } });
    const workspaceOps = WorkspaceOpService.withEpoch(storage, epoch, { quiesce: { around: (scope, operation, run, after) => dispatch === undefined ? run({ attempts: [] }) : dispatch.quiesce.around(scope, operation, run, after) }, portOf: async (taskId) => dispatch?.workspacePortOf(taskId), attempts: { live: async (taskId) => (await dispatch?.attemptControl.live(taskId)) ?? [], frozenReason: async (id) => dispatch?.attemptControl.frozenReason(id), release: async (id) => { await dispatch?.attemptControl.release(id); } } });
    const blobStore = options.artifacts === undefined ? undefined : await FileBlobStore.open({ directory: options.artifacts.directory });
    const checked = blobStore === undefined ? undefined : ArtifactService.withEpoch(storage, epoch, blobStore);
    const activity = ActivityService.withEpoch(storage, epoch);
    // The stop service is built after the status service (it uses the pause service), so the readiness view reaches it through this.
    let stopsLive: StopService | undefined;
    const status = StatusService.withEpoch(storage, epoch, { assignments, waits, blockers: BlockerService.withEpoch(storage, epoch), contracts, pauses, stall, watch: watchService, reviews, ownerQuestions: messages, agenda: meetings, meetings, shutdown: { readiness: async (by) => { if (stopsLive === undefined) throw new DomainError("unavailable", "stop is not ready"); return stopsLive.readiness(by, { kind: "installation", id: "installation" }); } }, handoffs: { forTask: (by, taskId) => handoffs.forTask(by, taskId) }, activity, ...(checked === undefined ? {} : { verifyArtifact: async (id: string) => ({ ok: (await checked.verify(id)).ok }) }) });
    const branchSettings = ProtectedBranchService.withEpoch(storage, epoch);
    // Typed commands (card T09b): the `nimblenewt.` names are the state-API operations, `toolbox.` and `a_<id>.` names come from the catalog.
    // ONE catalogue for the whole controller: its revocation listeners live on the instance, so the revoke path and the tool bridge must share it.
    const catalogService = CatalogService.withEpoch(storage, epoch, desks);
    const catalogRevocation: CatalogRevocationPort = { revoke: (owner, command) => catalogService.revoke(owner, command), running: async (_owner, name, version) => ({ calls: toolsLive?.runningCalls(name, version) ?? [], total: toolsLive?.runningTotal(name, version) ?? 0 }) };
    const commands = CommandService.withEpoch(storage, epoch, BUILTIN_COMMANDS.source(catalogSource(catalogService)));
    const integration = IntegrationPolicyService.withEpoch(storage, epoch);
    const notes = WorkingNoteService.withEpoch(storage, epoch);
    // The agent's ending (card H12n). The submission is bound to the submission service through the optional `stage` (and the landing check to `landing`) of the start options: without them a submit is refused as unavailable and nothing is submitted.
    const submissions = SubmissionService.withEpoch(storage, epoch, (_id, scope, by) => agents.rolesOfPrincipalIn(by, scope.projectId, new Date().toISOString()), { reviewersAvailableIn: (projectId, workerId) => agents.reviewersAvailableIn(projectId, workerId, new Date().toISOString()), attemptOf: (() => { const of = attemptOfAssignments(assignments); /* the dispatcher names an attempt's owner by its bare agent id, the principals by `agent:<id>`: the same identity either way */ return async (taskId: string) => { const a = await of(taskId); return a === undefined ? undefined : { ...a, ownerId: a.ownerId.startsWith("agent:") ? a.ownerId : `agent:${a.ownerId}` }; }; })() });
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
    const stops = stopsLive = StopService.withEpoch(storage, epoch, pauses, dispatchStopPorts(() => (dispatch === undefined ? undefined : { dispatcher: dispatch.dispatcher, principal: dispatch.principal }), () => (options.dispatch === undefined ? "none" : "pending"), (scope) => agentsUnder(storage, scope), (_by, taskId) => jobs.unfinishedOf(taskId), options.localWork, { dropEnding: (id, why, reason) => workEnd.drop(id, why, reason) }), { onSettled: async (by, e) => { if (e.scope.kind !== "task") return; await activity.record(by, { commandId: `${e.intentId}-act`, taskId: e.scope.id, kind: "lifecycle", summary: `${e.mode === "suspend" ? "Suspension" : "Stop"} ${e.outcome.state}${e.outcome.graceful ? "" : " (not graceful)"}${e.outcome.unresolved.length > 0 ? `; unresolved: ${e.outcome.unresolved.slice(0, 5).join(", ")}` : ""}.`, manifest: { refs: [{ kind: "stop-intent", id: e.intentId }] } } as never); } });

    // Provider drain and cutover (card R04b): the owner's controls gate every route choice made through the fallback service, which the cutover cancels running calls on.
    const cutover = CutoverService.withEpoch(storage, epoch, routing, {});
    const fallback = FallbackService.withEpoch(storage, epoch, routing, {}, cutover.gate());
    cutover.bind(fallback);
    const handoffs = HandoffService.withEpoch(storage, epoch, { asker: async (principalId) => { const p = await principals.get(principalId); return p === undefined || p.state !== "active" ? undefined : grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); }, onReturnGivenUp: async (by, e) => { await activity.record(by, { commandId: `${e.handoffId}-ret-${createHash("sha256").update(e.reason).digest("hex").slice(0, 12)}`, taskId: e.taskId, kind: "ownership", summary: `The temporary reassignment was not returned: ${e.reason}.`, manifest: { refs: [{ kind: "handoff", id: e.handoffId }] } } as never); }, onTransferred: async (by, e) => { await activity.record(by, { commandId: `${e.handoffId}-act`, taskId: e.taskId, kind: "ownership", summary: `Handed over from ${e.from.kind} ${e.from.id} to ${e.to.kind} ${e.to.id}.`, manifest: { refs: [{ kind: "handoff", id: e.handoffId }] } } as never); }, pauses, stops, assignments, sources: controllerHandoffSources({ getTask: (id) => projects.getTask(id), contracts,
      // The sender's own shared drafts and the responsibilities it answers for travel with the task (card L03g), read as the sender.
      drafts: async ({ taskId, projectId, from }) => { const p = await principals.get(`agent:${from.id}`); if (p === undefined) return []; const eff = await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); const all: Awaited<ReturnType<typeof desks.list>>["items"] = []; for (let after: string | undefined, i = 0; i < 20; i++) { const page = await desks.list(eff as never, { ownerId: p.id, projectId, limit: 200, ...(after === undefined ? {} : { afterId: after }) }); all.push(...page.items); after = page.next; if (after === undefined) break; } return all.filter((r) => r.taskId === taskId && r.status === "draft" && r.visibility === "shared").map((r) => ({ id: r.id, title: r.title, body: r.body })); },
      responsibilities: async ({ projectId, from }) => { const p = await principals.get(`agent:${from.id}`); if (p === undefined) return []; const eff = await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); return ((await responsibilities.list(eff as never, projectId, { state: "active" })) ?? []).filter((r) => r.ownerId === p.id).map((r) => ({ id: r.id, title: r.title, desiredCondition: r.desiredCondition, state: r.state })); },
      locks: async ({ taskId, projectId, from, to }) => {
        const p = await principals.get(`agent:${from.id}`); if (p === undefined) return [];
        const out: string[] = [];
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
        return out;
      },
      agentState: async (id) => ((await storage.getAggregate({ kind: "agent", id }))?.body as unknown as { state?: "active" | "retired" } | undefined)?.state, canWork: async (agentId, projectId) => { const p = await principals.get(`agent:${agentId}`); if (p === undefined || p.state !== "active") return false; const eff = await grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); return allows(eff as never, "attempt.work", projectId); } }) });
    const continuations = ContinuationService.withEpoch(storage, epoch);
    const resumeSettings = ResumeSettingsService.withEpoch(storage, epoch, undefined, { warn: async (d) => { await notifications.emitFromController({ commandId: `resume-settings-damaged:${d.revision}`, kind: "maintenance", level: "needs-you", ref: { kind: "resume-settings", id: "main" }, detail: d.detail }); } });
    // What happens when a host stops reporting while it holds work: warn, then (unless the owner turned it off) re-place after the grace period. The owner's setting over the start-up defaults (12 hours, on).
    const quietHostSettings = QuietHostSettingsService.withEpoch(storage, epoch, undefined, { warn: async (d) => { await notifications.emitFromController({ commandId: `quiet-host-settings-damaged:${d.revision}`, kind: "maintenance", level: "needs-you", ref: { kind: "quiet-host-settings", id: "main" }, detail: d.detail }); } });
    const resumes = ResumeCheckService.withEpoch(storage, epoch, { continuations, dependencies: DependencyService.withEpoch(storage, epoch), blockers: BlockerService.withEpoch(storage, epoch), ports: controllerResumePorts(storage) }, { rounds: () => resumeSettings.effective() });
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
      // A change that was carried out, or refused, is a step in the task it names (card C09f); the step is written by the controller itself (a service identity with no grants, which the activity service accepts as a service).
      onChange: async (e) => {
        if (e.target.kind !== "task") return;
        // Only a task of the decision's own project: the target and the words are an agent's, and this identity may write to any task.
        if ((await projects.getTask(e.target.id))?.projectId !== e.projectId) return;
        await activity.record({ id: "service:meeting-records", kind: "service", name: "meeting-records", grants: [] } as Principal, { commandId: `mdn-act:${e.decisionId}:${e.index}:${e.state}`, taskId: e.target.id, kind: "meeting-decision", summary: `A meeting decision ${e.state === "applied" ? "changed" : "could not change"} this task: ${e.summary}${e.reason === undefined ? "" : ` (${e.reason})`}.`, manifest: { refs: [{ kind: "meeting-decision", id: e.decisionId }] } } as never);
      },
      authority: async (principalId) => { const p = await principals.get(principalId); return p === undefined || p.state !== "active" ? undefined : grants.effective({ id: p.id, kind: p.kind, name: p.name, grants: p.grants }, new Date().toISOString()); },
    });
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
    const backups = options.backup === undefined ? undefined : new BackupService(storage, { root: options.backup.directory, version: options.backup.version ?? "0.0.0", ...(options.backup.everyMs === undefined ? {} : { everyMs: options.backup.everyMs }), ...(options.backup.retention === undefined ? {} : { retention: options.backup.retention }), ...(options.backup.now === undefined ? {} : { now: options.backup.now }), ...(blobStore === undefined ? {} : { blobs: blobStore }), ...(backupEncryption === undefined ? {} : { encryption: backupEncryption.keyring }) });
    const improvements = ImprovementService.withEpoch(storage, epoch, { meetings });
    // Which of the event sources the owner has turned off (card H13f); the list is the host's, or the built-in one.
    const eventSourceList = options.eventSources ?? defaultEventSources(projects);
    const eventSourceSettings = EventSourceSettingsService.withEpoch(storage, epoch, () => eventSourceList);
    // What one local agent may use: the owner's setting over the start-up figures (card H12k).
    const workerLimits = WorkerLimitsSettingsService.withEpoch(storage, epoch, checkLocalWorkerLimits(options.dispatch?.local?.limits));
    // How long an attempt may run and how many attempts are admitted: off unless the owner (or a start-up option) turns them on.
    const dispatchLimits = DispatchLimitsSettingsService.withEpoch(storage, epoch, { ...(options.dispatch?.dispatcher?.attemptMs === undefined ? {} : { attemptMs: options.dispatch.dispatcher.attemptMs }), ...(options.dispatch?.dispatcher?.maxAttempts === undefined ? {} : { maxAttempts: options.dispatch.dispatcher.maxAttempts }) });
    // Optional caps on attempts per project, per agent and on fan-in: off unless the owner turns them on (card H10b). A change lets waiting work in at once through an admission sweep.
    const capacityAdmission = AdmissionService.withEpoch(storage, epoch);
    const capacityLimits = CapacityLimitsService.withEpoch(storage, epoch, { onChanged: async (revision) => { await capacityAdmission.sweep({ commandId: `cap-sweep:${revision}`, actor: "dispatcher" }); } });
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
    const api = new StateApi({ reconnect, coverage, coverageSettings, quietHostSettings, quietHosts: { moveWork: async (owner, command) => { const hosts = dispatch?.quietHosts; if (hosts === undefined) throw new DomainError("unavailable", "this controller runs without remote hosts"); return hosts.moveWork(owner, command); } }, catalogRevocation, setup: SetupReadinessService.withEpoch(storage, epoch), eventSourceSettings, resumeSettings, workerLimits, capacityLimits, agreedLimits, escalationLadder, recoveryLadder, recoveryStep: stall, dispatchLimits, cleanupSettings, workEnd, submissions, deliverables: DeliverableService.withEpoch(storage, epoch), release: releaseService, responsibilityChecks, incidents, swarm: SwarmService.withEpoch(storage, epoch, { projects, contracts, budgets, stops }), status, branchSettings, improvements, ...(backups === undefined ? {} : { backups }), ...(backupEncryption === undefined ? {} : { backupEncryption }), ...(backupKeyPin === undefined ? {} : { backupKeyPin }), policyForward, watchControl, standups, attendance, records, policyContext: PolicyService.withEpoch(storage, epoch, grants, { roles: (id) => agents.rolesOfPrincipal(id) }), activity, resumes, handoffs, cutover, modelBudget: fallback, commands, integration, notes, stops, pauses, workspaceOps, branches, meetings, invitations: invitationInbox, grants, placement, spill: { readSpill: async (by, id, index, size) => dispatch?.readSpill(by, id, index, size) }, watches: watchService, events: EventService.withEpoch(storage, epoch), notifications, budgets, difficulty: DifficultyService.withEpoch(storage, epoch, routing, contracts), decisions, ownerQuestions: messages, messages, principals, taskCredentials, projects, assignments, retrieval, inquiries, agents, contracts, graph, resources, plans, responsibilities, ...(options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError }) });
    let chat: ChatService | undefined;
    let coordinator: CoordinatorService | undefined;
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
          principal: async () => { const t = await c.token(); if (t === undefined) throw new DomainError("unavailable", "the coordinator has no credential"); return principals.authenticate(t); },
        });
      }
    }
    // The reconciler (card L01b) holds an inbox message for a paused task. No delivery destination or effect bridge is built yet, so it repairs, admits, recovers and settles waits only.
    const reconciler = new Reconciler(storage, epoch, { projects, inbox: InboxService.withEpoch(storage, epoch, assignments), effects: EffectService.withEpoch(storage, epoch, assignments), blockers: BlockerService.withEpoch(storage, epoch), waits, pauses, destinations: [], bridges: {} }, { claimant: "controller" });
    let dispatchProblem: string | undefined;
    if (options.dispatch !== undefined) {
      try {
        dispatch = await composeDispatch({ release: releaseService, quietHosts: { settings: quietHostSettings, ...(options.dispatch?.quietHosts === undefined ? {} : { options: options.dispatch.quietHosts }) }, notifyAggregate, storage, epoch, workspaceOps, stops, records, responsibilities: { checks: responsibilityChecks, incidents, coverage: { service: coverage, notify: async (g) => { const more = (n: number): string => `; and ${n} more`; let list = ""; let shown = 0; for (const x of g.items) { const next = `${list}${shown === 0 ? "" : "; "}${x.title.slice(0, 30)}`; if (next.length > 110) break; list = next; shown++; } await notifications.emitFromController({ commandId: g.alertId, kind: "maintenance", level: "needs-you", ref: { kind: "responsibility", id: g.items[0]!.responsibilityId }, projectId: g.projectId, detail: `${g.count} responsibilit${g.count === 1 ? "y is" : "ies are"} without coverage: ${list}${g.count > shown ? more(g.count - shown) : ""}. See responsibility.coverage.`.slice(0, 200) }); } }, notify: async (e) => {
          // The text must not change between ticks (no alert count): the command ids are fixed, so a retry after a failed markNotified must carry the same payload.
          const detail = `An incident on a responsibility (${e.signature}) is still open past its escalation time.`;
          if (e.escalatedTo === "owner") await notifications.emitFromController({ commandId: `inc-esc-${e.id}`, kind: "maintenance", level: "needs-you", ref: { kind: "responsibility-incident", id: e.id }, projectId: e.projectId, detail });
          // An agent is told through its inbox, as a budget holder is: the notice is filed about a task the agent holds in the project (an incident has none), and with none it is retried each tick.
          else if (e.escalatedTo?.startsWith("agent:")) {
            const taskId = await assignedTaskIn(storage, e.projectId, e.escalatedTo);
            if (taskId === undefined) throw new DomainError("unavailable", `${e.escalatedTo} holds no task in the project to file the escalation notice against`);
            await messages.noticeFromController({ commandId: `inc-esc-${e.id}`, taskId, to: e.escalatedTo, purpose: "An incident was escalated to you", text: `${detail} Responsibility ${e.responsibilityId}; incident ${e.id}.` });
          }
        } }, eventSources: eventSourceList, eventSourcesOff: () => eventSourceSettings.disabled(), workerLimits: () => workerLimits.effective(), workerPolicy: { bestEffortAllowed: () => workerLimits.bestEffortAllowed(), recordLaunch: (r) => workerLimits.recordLaunch(r) }, dispatchLimits: () => dispatchLimits.effective(), taskMinutes: async (taskId) => { const v = await configuration.taskValue("time.maxMinutes", taskId); return typeof v === "number" ? v : undefined; }, ...(options.routeProbes === undefined ? {} : { probes: { cutover, probes: { enabled: () => options.routeProbes?.enabled === true, run: options.routeProbes.run, intervalMs: options.routeProbes.intervalMs ?? 60_000 } } }), ...(backups === undefined ? {} : { backups }), resumes, sweeps: [{ name: "handoffs.sweep", sweep: (by) => handoffs.sweep(by) }, { name: "resumes.sweep", sweep: (by) => resumes.sweep(by) }, { name: "workend.complete", sweep: () => workEnd.recover() }, { name: "scratch.recover", sweep: async () => { await scratchCleanup.recover(); } }], leadMinutes: meetingLead, options: withPlacement(options.dispatch), ...(options.availability === undefined ? {} : { availability: options.availability }), ...(options.meetingWake === undefined ? {} : { meetingWake: meetingWakeSink(options.meetingWake, options.meetingWake.timeoutMs === undefined ? {} : { timeoutMs: options.meetingWake.timeoutMs }) }), recovery: { stall, reconciler }, principals, grants, taskCredentials, projects, assignments, waits, contracts, catalog, routing, inquiries, agents, histories, reviews, retrieval, ...(options.onInternalError === undefined ? {} : { onError: options.onInternalError }) });
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
    let tools: ToolExecutionService | undefined;
    if (options.tools !== undefined && dispatch !== undefined) {
      const ro = {};
      tools = toolsLive = new ToolExecutionService({
        principal: dispatch.principal, credentials: taskCredentials, dispatch: { get: (...a) => dispatch!.dispatcher.get(...a), toolOperation: (...a) => dispatch!.dispatcher.toolOperation(...a) }, assignments, catalog: catalogService,
        hosts: HostService.withEpoch(storage, epoch, assignments, ro), admission: AdmissionService.withEpoch(storage, epoch, ro), pauses, desks, ...options.tools,
      });
    }
    const transport = options.conversationTransport === undefined ? undefined : await ConversationTransport.listen({ ...options.conversationTransport, conversations, principals });
    return {
      api, storage, epoch, check, filesystems, prerequisites, services: { ...(backups === undefined ? {} : { backups }), catalog: catalogService, workEnd, scratchCleanup, records, activity, continuations, resumes, handoffs, cutover, fallback, principals, taskCredentials, grants, projects, assignments, waits, stall, desks, histories, retrieval, inquiries, agents, harnesses: catalog, contracts, graph, resources, plans, responsibilities, reviews, conversations, configuration, routing, pauses, branches, jobs },
      ...(chat === undefined ? {} : { chat }), ...(coordinator === undefined ? {} : { coordinator }),
      ...(dispatch === undefined ? {} : { dispatch }), ...(tools === undefined ? {} : { tools }), ...(dispatchProblem === undefined ? {} : { dispatchProblem }),
      ...(transport === undefined ? {} : { conversationUrl: transport.url }),
      close: async () => { tools?.dispose(); await dispatch?.driver.stop(); await scratchCleanup.close().catch(() => undefined); await dispatch?.closeWorkers().catch(() => undefined); await transport?.close(); await backups?.finish(); await storage.close(); },
    };
  } catch (error) {
    toolsLive?.dispose();
    await dispatch?.driver.stop().catch(() => undefined);
    await dispatch?.closeWorkers().catch(() => undefined);
    await storage.close().catch(() => undefined);
    throw error;
  }
}
