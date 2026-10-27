import { EventService } from "../events/index.js";
import { BudgetService } from "../budgets/index.js";
import { NotificationService } from "../notifications/index.js";
import { StallService } from "../health/index.js";
import { DomainError } from "../domain/errors.js";
import { ProjectService } from "../domain/service.js";
import { AssignmentService } from "../domain/assignments.js";
import { WaitService } from "../domain/waits.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { dirname, isAbsolute, resolve } from "node:path";
import {
  UnsupportedEnvironmentError, checkEnvironment, checkFilesystems, checkPrerequisites, decideStartup, detectDistribution, detectEnvironment, hostLine, overrideRequested, overriddenCheck, prerequisiteProblems, realProbes, recordHost, recordOverride,
  type EnvironmentFacts, type FilesystemDetector, type FilesystemReport, type PrerequisiteNeed, type PrerequisiteReport, type Probes, type StartupCheck,
} from "../environment/index.js";
import { AgentService } from "../agents/index.js";
import { HarnessCatalog, type HarnessDeclaration } from "../harness/index.js";
import { Reconciler } from "../domain/reconcile.js";
import { InboxService } from "../domain/inbox.js";
import { EventService } from "../events/index.js";
import { WatchService } from "../events/handling.js";
import { EffectService } from "../domain/effects.js";
import { BlockerService } from "../domain/blockers.js";
import { ContractService, WaitGraphService } from "../planning/index.js";
import { ProjectPlanService, ProjectResourceService, ResponsibilityService } from "../projects/index.js";
import { InquiryService } from "../inquiries/index.js";
import { GrantService, PrincipalService, TaskCredentialService } from "../security/index.js";
import { SqliteStorage, probeSqliteLibrary } from "../storage/sqlite/index.js";
import { PostgresStorage, probePostgresLibrary } from "../storage/postgres/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { StateApi } from "./state-api.js";
import { ConfigurationService } from "../configuration/index.js";
import { ConversationService, type Availability } from "../conversations/index.js";
import { AgentMessageService } from "../messaging/index.js";
import { PolicyEditService } from "../chat/index.js";
import { PolicyService } from "../policy/index.js";
import { StatusService } from "../status/index.js";
import { ChatService, CoordinatorService, type ChatInterpreter, type CoordinatorModel } from "../chat/index.js";
import { ContextBranchService } from "../branches/index.js";
import { JobService } from "../jobs/index.js";
import { PauseService } from "../lifecycle/index.js";
import { ReviewService } from "../review/index.js";
import { DifficultyService, RoutingService } from "../routing/index.js";
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
  /**
   * Builds the attempt dispatcher and runs its loops (card H12c): the tick, the messages, attendance, stand-up, event and decision loops. Off unless given. The loops run only while this controller
   * holds the primary epoch; a newer controller instance stops them here. See `DispatchStartOptions`.
   */
  readonly dispatch?: DispatchStartOptions;
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
    readonly principals: PrincipalService; readonly taskCredentials: TaskCredentialService; readonly grants: GrantService; readonly projects: ProjectService; readonly assignments: AssignmentService;
    readonly waits: WaitService; readonly stall: StallService; readonly desks: DeskService; readonly histories: HistoryService; readonly retrieval: RetrievalService; readonly inquiries: InquiryService; readonly agents: AgentService; readonly harnesses: HarnessCatalog; readonly contracts: ContractService; readonly graph: WaitGraphService; readonly resources: ProjectResourceService; readonly plans: ProjectPlanService; readonly responsibilities: ResponsibilityService; readonly reviews: ReviewService; readonly conversations: ConversationService; readonly configuration: ConfigurationService; readonly routing: RoutingService; readonly pauses: PauseService; readonly branches: ContextBranchService;
    readonly jobs: JobService;
  };
  /** The dispatcher and the driver of its loops, when `dispatch` was given and the dispatcher could be provisioned. */
  readonly dispatch?: DispatchHandle;
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
  const print = options.print ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const override = overrideRequested(options.argv, options.env);
  const facts = options.facts ?? detectEnvironment();
  const dataDirectory = options.dataDirectory ?? (options.storage.kind === "sqlite" ? dirname(resolve(options.storage.path)) : undefined);
  const filesystems: FilesystemReport[] = await checkFilesystems([...(dataDirectory === undefined ? [] : [{ role: "data directory" as const, path: dataDirectory }]), ...(options.workspaceRoots ?? []).map((path) => ({ role: "workspace" as const, path }))], { platform: facts.platform, ...(options.filesystem === undefined ? {} : { detect: options.filesystem }) });
  // A controller that builds a local worker host runs agents in the sandbox on this machine, so the sandbox tools and the limits mechanism are required at start with the same found / required / install / switch message as every other prerequisite (card F04j). `features` says so explicitly (a test, or a controller whose workers are all remote).
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

  let storage: ControllerStorage;
  if (options.storage.kind === "postgres") {
    const pg = await PostgresStorage.open({ connectionString: options.storage.url, allowUnsupportedServer: override, ...(options.storage.schema === undefined ? {} : { schema: options.storage.schema }), ...(options.storage.maxConnections === undefined ? {} : { maxConnections: options.storage.maxConnections }), ...(options.storage.minimumServerVersionNum === undefined ? {} : { minimumServerVersionNum: options.storage.minimumServerVersionNum }) }).catch((error: unknown) => { if (error instanceof Error && error.message.startsWith("NimbleNewt will not start")) print(error.message); throw error; });
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
    storage = await SqliteStorage.open({ path: options.storage.path, allowNetworkFilesystem: override });
  }

  let dispatch: DispatchHandle | undefined;
  try {
    const projects = await ProjectService.open(storage, { holder: options.holder ?? "controller" });
    const epoch = projects.epoch;
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
    const grants = GrantService.withEpoch(storage, epoch);
    const catalog = HarnessCatalog.of(options.harnesses ?? []);
    const contracts = ContractService.withEpoch(storage, epoch);
    const assignments = AssignmentService.withEpoch(storage, epoch, projects, { attemptGate: async (taskId, harness) => catalog.checkAttempt(await contracts.recoveryOf(taskId), harness) });
    const waits = WaitService.withEpoch(storage, epoch, assignments);
    const desks = DeskService.withEpoch(storage, epoch);
    const histories = HistoryService.withEpoch(storage, epoch);
    const retrieval = RetrievalService.withEpoch(storage, epoch, desks, histories);
    const inquiries = InquiryService.withEpoch(storage, epoch, { histories, retrieval, waits, assignments });
    const agents = AgentService.withEpoch(storage, epoch);
    // Card L01: the pause gates supply the availability the conversations and the reviews consult, so a paused agent's messages are queued and a paused reviewer is skipped; whatever else the lifecycle reports (suspended, stopped) comes through `options.availability`.
    const pauses = PauseService.withEpoch(storage, epoch, { waits }, options.availability === undefined ? {} : { otherAvailability: options.availability });
    // Suspected stalls: a task under a pause is assessed as paused, never as stalled (card L01).
    const stall = StallService.withEpoch(storage, epoch, assignments, waits, { isPaused: (taskId) => pauses.isPaused(taskId) });
    // Durable job records (card T07): a permitted background job's result goes to the pause service; no MCP connection check is bound until an MCP client exists, so no MCP operation is admitted.
    const jobs = JobService.withEpoch(storage, epoch, { pauses }, { background: (principal, request) => pauses.recordFinishedJob(principal, request) });
    // The reviewer's host is the one its running attempt is on, or the host a moved attempt is pinned to (known once the dispatcher is built); without one, or when the lookup fails, the host is not judged.
    const reviews = ReviewService.withEpoch(storage, epoch, { availability: pauses.availability, reviewerHost: async (principalId) => { try { return await dispatch?.hostOfAgent(principalId); } catch { return undefined; } } });
    const graph = WaitGraphService.withEpoch(storage, epoch, contracts, BlockerService.withEpoch(storage, epoch), { extraEdges: (projectId, tasks) => reviews.waitEdges(projectId, tasks) });
    // The routing table is refused unless the coordinator, the safety supervisor and every other role in it have a valid fallback list (card R04).
    const routing = RoutingService.withEpoch(storage, epoch, {}, {});
    const configuration = ConfigurationService.withEpoch(storage, epoch, { routing });
    const conversations = ConversationService.withEpoch(storage, epoch, { availability: pauses.availability });
    const resources = ProjectResourceService.withEpoch(storage, epoch);
    const plans = ProjectPlanService.withEpoch(storage, epoch);
    const responsibilities = ResponsibilityService.withEpoch(storage, epoch);
    // Questions to the owner (card U12): agents ask through the API, the owner sees and answers them; the owner is told through the notifications.
    const notifications = NotificationService.withEpoch(storage, epoch);
    const messages = AgentMessageService.withEpoch(storage, epoch, { availability: pauses.availability, taskPaused: (t) => pauses.isPaused(t), guard: (t) => pauses.guard(t), waits, assignments, inquiries, notifications });
    const branches = ContextBranchService.withEpoch(storage, epoch, { histories, retrieval });
    // A new request for more budget tells the owner when it is addressed to them (card R05c). Only the controller's own facts go in the notice, never the requester's words.
    const budgets = BudgetService.withEpoch(storage, epoch, { notify: async (n) => { if (n.to === "owner") await notifications.emitFromController({ commandId: `bgt-req-${n.requestId}`, kind: "maintenance", ref: { kind: "budget-request", id: n.requestId }, detail: `${n.requestedBy} asked for more budget for task ${n.taskId} (${n.costMicros} millionths, ${n.computeMs} ms of compute). Decide it with budget.decide.` }); } });
    // Event watches (card H13): an agent's watch on a stream, its handling attempts and the failed queue, which the status answers and the state API read.
    const watchService = WatchService.withEpoch(storage, epoch, { events: EventService.withEpoch(storage, epoch), inbox: InboxService.withEpoch(storage, epoch, assignments), assignments, projects });
    const api = new StateApi({ branches, grants, watches: watchService, events: EventService.withEpoch(storage, epoch), budgets, difficulty: DifficultyService.withEpoch(storage, epoch, routing, contracts), ownerQuestions: messages, principals, taskCredentials, projects, assignments, retrieval, inquiries, agents, contracts, graph, resources, plans, responsibilities, ...(options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError }) });
    let chat: ChatService | undefined;
    let coordinator: CoordinatorService | undefined;
    if (options.chat !== undefined) {
      const o = options.chat;
      // The approval profile (A07), status explanations (U05) and conversational policy edits (U04) are composed from the services built above.
      const policy = PolicyService.withEpoch(storage, epoch, grants);
      const status = StatusService.withEpoch(storage, epoch, { assignments, waits, blockers: BlockerService.withEpoch(storage, epoch), contracts, pauses, stall, watch: watchService });
      const policyEdits = PolicyEditService.withEpoch(storage, epoch, { policy, reviews, grants, configuration, conversations, interpreter: o.interpreter });
      chat = ChatService.withEpoch(storage, epoch, { principals, api, interpreter: o.interpreter, policy, status, policyEdits, coordinator: () => coordinator, ...(o.coordinator === undefined ? {} : { coordinatorToken: o.coordinator.token }) });
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
        dispatch = await composeDispatch({ storage, epoch, options: options.dispatch, recovery: { stall, reconciler }, principals, grants, taskCredentials, projects, assignments, waits, contracts, catalog, routing, inquiries, agents, histories, reviews, retrieval, ...(options.onInternalError === undefined ? {} : { onError: options.onInternalError }) });
      } catch (error) {
        // A dispatcher the owner disabled, or a store that failed here, must not keep the rest of the controller from starting; the operator is told, and the reason stays on the controller.
        dispatchProblem = error instanceof Error ? error.message.slice(0, 300) : "the dispatcher could not be built";
        print(`The dispatcher is not running: ${dispatchProblem}`);
      }
    }
    const transport = options.conversationTransport === undefined ? undefined : await ConversationTransport.listen({ ...options.conversationTransport, conversations, principals });
    return {
      api, storage, epoch, check, filesystems, prerequisites, services: { principals, taskCredentials, grants, projects, assignments, waits, stall, desks, histories, retrieval, inquiries, agents, harnesses: catalog, contracts, graph, resources, plans, responsibilities, reviews, conversations, configuration, routing, pauses, branches, jobs },
      ...(chat === undefined ? {} : { chat }), ...(coordinator === undefined ? {} : { coordinator }),
      ...(dispatch === undefined ? {} : { dispatch }), ...(dispatchProblem === undefined ? {} : { dispatchProblem }),
      ...(transport === undefined ? {} : { conversationUrl: transport.url }),
      close: async () => { await dispatch?.driver.stop(); await dispatch?.closeWorkers().catch(() => undefined); await transport?.close(); await storage.close(); },
    };
  } catch (error) {
    await dispatch?.driver.stop().catch(() => undefined);
    await dispatch?.closeWorkers().catch(() => undefined);
    await storage.close().catch(() => undefined);
    throw error;
  }
}
