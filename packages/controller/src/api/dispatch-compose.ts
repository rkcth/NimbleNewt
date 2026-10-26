import { AdmissionService } from "../admission/index.js";
import { BudgetService } from "../budgets/index.js";
import { DecisionService } from "../decisions/index.js";
import { ContextEnforcementService } from "../context/index.js";
import { DispatchDriver, DispatcherService, QuiesceCoordinator, controllerGuards, type RuntimeGuards, type WorkOrder, activeAgents, attendanceLoops, decisionLoops, eventLoops, messageLoops, projectIds, standupLoops, type AttemptDispatcherOptions, type DispatcherLoop, type RouteResolver, type TimerPort, type WorkerHost } from "../dispatch/index.js";
import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import { BlockerService } from "../domain/blockers.js";
import { EffectService } from "../domain/effects.js";
import type { RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { WaitService } from "../domain/waits.js";
import { EventService } from "../events/index.js";
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
import { AttendanceService, MeetingService } from "../meetings/index.js";
import { AgentMessageService } from "../messaging/index.js";
import { NotificationService } from "../notifications/index.js";
import type { ContractService } from "../planning/index.js";
import { PolicyService } from "../policy/index.js";
import type { ReviewService } from "../review/index.js";
import { DifficultyService, type RoutingService } from "../routing/index.js";
import { DISPATCHER_PRINCIPAL, type GrantService, type PrincipalService, type TaskCredentialService } from "../security/index.js";
import { StandupService } from "../standups/index.js";
import type { ControllerStorage } from "../storage/types.js";

/** What the operator gives the controller to run the dispatcher (card H12c). Absent from `StartOptions`: no dispatcher is built and no loop runs. */
export interface DispatchStartOptions {
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
    readonly build: (services: { readonly guards: RuntimeGuards }) => WorkerHost | Promise<WorkerHost>;
    /** Shuts down what `build` made (live workers, the sandbox launcher, the relay). Called when the controller closes and when a later step of the start fails. */
    readonly close?: () => Promise<void>;
  };
  /** Remote MCP servers (cards T03, H12g): the name resolver the host uses. Given, the handle carries the MCP service and the connector that reaches an approved server only at a checked public address. */
  readonly mcp?: { readonly resolve: NameResolver; /** Refuses while the controller is paused or stopping (the lifecycle gate); default: never refuses. */ readonly gate?: () => Promise<void> };
}

export interface DispatchHandle {
  readonly dispatcher: DispatcherService;
  readonly driver: DispatchDriver;
  /** Makes an agent's attempts quiet around an integration, refresh, release or quarantine of its work (card H12d). */
  readonly quiesce: QuiesceCoordinator;
  /** Shuts down the local worker host the operator built, if it gave a way to. */
  readonly closeWorkers: () => Promise<void>;
  /** The MCP service and the only way the host reaches a remote server (cards T03, H12g); present when `mcp` was given. */
  readonly mcp?: { readonly service: McpService; readonly connector: RemoteMcpConnector };
}

export interface ComposeInput {
  readonly storage: ControllerStorage; readonly epoch: number; readonly options: DispatchStartOptions;
  readonly principals: PrincipalService; readonly grants: GrantService; readonly taskCredentials: TaskCredentialService; readonly projects: ProjectService; readonly assignments: AssignmentService; readonly waits: WaitService;
  readonly contracts: ContractService; readonly catalog: HarnessCatalog; readonly routing: RoutingService; readonly inquiries: InquiryService; readonly agents: AgentService; readonly histories: HistoryService; readonly reviews: ReviewService;
  readonly retrieval: RetrievalService;
  readonly onError?: (error: unknown) => void;
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
  const tell = (why: string): Promise<unknown> => notifications.emitFromController({ commandId: `dpa-off:${epoch}`, kind: "maintenance", ref: { kind: "principal", id: "dispatcher" }, detail: why });
  const issued = await i.principals.provisionService(DISPATCHER_PRINCIPAL.slice("service:".length)).catch(async (error: unknown) => {
    if (error instanceof DomainError && error.code === "forbidden") await tell("The dispatcher is switched off: its service principal is disabled, so no work is started. Enable service:dispatcher to turn it back on.").catch(() => undefined);
    throw error;
  });
  const principal = await i.principals.authenticate(issued.token);
  const admission = AdmissionService.withEpoch(storage, epoch, ro);
  const hosts = HostService.withEpoch(storage, epoch, i.assignments, ro);
  const effects = EffectService.withEpoch(storage, epoch, i.assignments, { ...ro, holder: "dispatcher" });
  const blockers = BlockerService.withEpoch(storage, epoch, ro);
  const policy = PolicyService.withEpoch(storage, epoch, i.grants, ro);
  const budgets = BudgetService.withEpoch(storage, epoch, ro);
  const pauses = PauseService.withEpoch(storage, epoch, { waits: i.waits }, ro);
  const events = EventService.withEpoch(storage, epoch, ro);
  const decisions = DecisionService.withEpoch(storage, epoch, { events, effects }, ro);
  const generation = GenerationService.withEpoch(storage, epoch, { assignments: i.assignments, effects, pauses, decisions }, ro);
  const difficulty = DifficultyService.withEpoch(storage, epoch, i.routing, i.contracts, ro);
  const route: RouteResolver = i.options.route ?? (async ({ commandId, taskId }) => {
    const d = await difficulty.resolve(principal, { commandId, taskId, role: "worker", data: "local-only", paidAuthorized: false });
    return d.outcome === "chosen" ? { route: d.route!, ...(d.profile?.harness === undefined ? {} : { harness: d.profile.harness }), role: d.role, request: d.request, routing: d.routingRevision ?? 0, profiles: d.profilesRevision } : { none: true, reasons: d.reasons };
  });
  const meetings = MeetingService.withEpoch(storage, epoch, { inquiries: i.inquiries }, { ...ro, availability: pauses.availability });
  const messages = AgentMessageService.withEpoch(storage, epoch, {
    ...ro, availability: pauses.availability, taskPaused: (t) => pauses.isPaused(t), guard: (t) => pauses.guard(t), waits: i.waits, assignments: i.assignments, meetings, inquiries: i.inquiries, notifications,
  });
  const attendance = AttendanceService.withEpoch(storage, epoch, { meetings, pauses, projects: i.projects, assignments: i.assignments, agents: i.agents, histories: i.histories }, { ...ro, availability: pauses.availability });
  const standups = StandupService.withEpoch(storage, epoch, { meetings, assignments: i.assignments }, { ...ro, availability: pauses.availability });
  const projects = (): Promise<string[]> => projectIds(i.projects);
  const loops: DispatcherLoop[] = [
    ...messageLoops(messages, () => activeAgents(storage)), ...attendanceLoops(attendance), ...standupLoops(standups, meetings, projects), ...eventLoops(events), ...decisionLoops(decisions, projects),
  ];
  // The local worker host gets its guards here, bound to the services built above (card H12k); the dispatcher then has it among its workers.
  const workers: WorkerHost[] = [...(i.options.workers ?? [])];
  if (i.options.local !== undefined) {
    const context = ContextEnforcementService.withEpoch(storage, epoch, { blockers, retrieval: i.retrieval }, ro);
    const guards = controllerGuards({
      context, pause: pauses, messages, system: principal,
      agent: (order) => i.taskCredentials.authenticate(order.credential),
      assignee: (order) => i.taskCredentials.agentOf(principal, order.attemptId),
      window: i.options.local.window,
      ...(i.options.local.storedTokens === undefined ? {} : { storedTokens: i.options.local.storedTokens }),
    });
    workers.push(await i.options.local.build({ guards }));
  }
  const dispatcher = DispatcherService.withEpoch(storage, epoch, {
    principal, assignments: i.assignments, projects: i.projects, credentials: i.taskCredentials, admission, hosts, workers,  contracts: i.contracts, harnesses: i.catalog, policy, effects, blockers, route,
    routing: i.routing, pauses, decisions, generation, reviews: i.reviews, budgets, meetings: attendance, notifications, loops,
  }, { ...ro, holder: "dispatcher", ...(i.options.dispatcher ?? {}) });
  const driver = new DispatchDriver({
    dispatcher, storage, epoch, record: { storage, options: ro },
    ...(i.options.intervalMs === undefined ? {} : { intervalMs: i.options.intervalMs }), ...(i.options.timer === undefined ? {} : { timer: i.options.timer }), ...(i.options.clock === undefined ? {} : { clock: i.options.clock }),
    ...(i.onError === undefined ? {} : { onError: i.onError }),
    enabled: async () => (await i.principals.get(DISPATCHER_PRINCIPAL))?.state === "active",
    onDisabled: async (why) => { await tell(why); },
  });
  if (i.options.manual !== true) driver.start();
  const mcpService = i.options.mcp === undefined ? undefined : McpService.withEpoch(storage, epoch, { ...ro, ...(i.options.mcp?.gate === undefined ? {} : { gate: i.options.mcp.gate }) });
  return {
    dispatcher, driver, closeWorkers: async () => { await i.options.local?.close?.(); }, quiesce: new QuiesceCoordinator({ dispatcher, blockers, principal }),
    ...(mcpService === undefined || i.options.mcp === undefined ? {} : { mcp: { service: mcpService, connector: new RemoteMcpConnector({ mcp: mcpService, resolve: i.options.mcp.resolve, principal }) } }),
  };
}
