import { AdmissionService } from "../../admission/index.js";
import { BudgetService } from "../../budgets/index.js";
import { DecisionService } from "../../decisions/index.js";
import { ProjectResourceService } from "../../projects/index.js";
import { AssignmentService } from "../../domain/assignments.js";
import { BlockerService } from "../../domain/blockers.js";
import { EffectService } from "../../domain/effects.js";
import { InboxService } from "../../domain/inbox.js";
import { ProjectService } from "../../domain/service.js";
import { WaitService } from "../../domain/waits.js";
import { GenerationService } from "../../generation/index.js";
import { HarnessCatalog } from "../../harness/index.js";
import { HostService } from "../../hosts/index.js";
import { PauseService } from "../../lifecycle/index.js";
import { ContractService } from "../../planning/index.js";
import { PolicyService } from "../../policy/index.js";
import { ReviewService } from "../../review/index.js";
import { DifficultyService, RoutingService } from "../../routing/index.js";
import { DISPATCHER_PRINCIPAL, GrantService, PrincipalService, TaskCredentialService, type Grant, type Principal } from "../../security/index.js";
import type { ControllerStorage } from "../../storage/types.js";
import { DispatcherService, type DispatcherDeps, type AttemptDispatcherOptions, type RouteResolver } from "../dispatcher.js";
import type { ToolGateway, WorkerTurnResult, WorkOrder, WorkerHandle, WorkerHost } from "../ports.js";
import type { JsonObject } from "../../storage/types.js";

/** A clock that only moves when a test moves it. */
export class TestClock {
  #ms = Date.parse("2026-10-23T09:00:00.000Z");
  readonly now = (): string => new Date(this.#ms).toISOString();
  advance(ms: number): void { this.#ms += ms; }
}

/** What a scripted worker does with its attempt: it gets the order and the gateway the dispatcher bound to the attempt. */
export type WorkerScript = (context: { readonly order: WorkOrder; readonly gateway: ToolGateway; readonly worker: ScriptedHandle }) => Promise<WorkerTurnResult>;

export class ScriptedHandle implements WorkerHandle {
  readonly workerVersion: string;
  readonly told: string[] = [];
  readonly restarts: { recipe: string; from: JsonObject }[] = [];
  checkpoints = 0;
  stopped = 0;
  constructor(readonly order: WorkOrder, private readonly script: WorkerScript, version: string) { this.workerVersion = version; }
  run(gateway: ToolGateway): Promise<WorkerTurnResult> { return this.script({ order: this.order, gateway, worker: this }); }
  async checkpoint(): Promise<JsonObject> { this.checkpoints++; return { n: this.checkpoints, attempt: this.order.attemptId }; }
  async restart(recipe: { revision: string }, from: JsonObject): Promise<void> { this.restarts.push({ recipe: recipe.revision, from }); }
  async tell(text: string): Promise<void> { this.told.push(text); }
  async stop(): Promise<void> { this.stopped++; }
}

/** A worker host that runs a script instead of a model: the same contract a real local or remote worker implements. */
export class ScriptedWorker implements WorkerHost {
  readonly starts: WorkOrder[] = [];
  readonly handles: ScriptedHandle[] = [];
  failToStart: Error | undefined;
  /** Attempts the dispatcher asked this host to let go of with no handle in hand (a restarted controller). */
  readonly released: { attemptId: string; reason: string }[] = [];
  async release(attemptId: string, reason: string): Promise<void> { this.released.push({ attemptId, reason }); }
  constructor(readonly hostId: string, public script: WorkerScript, readonly resources = { cpus: 1, memoryMb: 1024 }, private readonly version = "worker-1.0.0") {}
  async start(order: WorkOrder): Promise<WorkerHandle> {
    if (this.failToStart !== undefined) throw this.failToStart;
    this.starts.push(order);
    const handle = new ScriptedHandle(order, (c) => this.script(c), this.version);
    this.handles.push(handle);
    return handle;
  }
}

export const PI = { harness: "pi", nativeContinuation: true, portableReconstruction: false, checkpointExport: false, abort: "conversation" as const };
export const ROUTING_TABLE = {
  providers: { localp: { enabled: true, paid: false, location: "local" }, cloudp: { enabled: true, paid: true, location: "cloud" } },
  routes: { "localp/small": { contextTokens: 128_000, capabilities: ["tools"] }, "cloudp/big": { contextTokens: 200_000, capabilities: ["tools"] } },
  profiles: { "r-local": ["localp/small"], "r-cloud": ["cloudp/big", "localp/small"] },
  roles: {},
};
export const EXEC_PROFILES = { profiles: { default: { harness: "pi", routingProfile: "r-local" } }, mapping: { unrated: "default" } };

export interface DispatchWorld {
  readonly storage: ControllerStorage;
  readonly epoch: number;
  readonly clock: TestClock;
  readonly owner: Principal;
  readonly dispatcherPrincipal: Principal;
  readonly projects: ProjectService;
  readonly assignments: AssignmentService;
  readonly inbox: InboxService;
  readonly effects: EffectService;
  readonly blockers: BlockerService;
  readonly principals: PrincipalService;
  readonly grants: GrantService;
  readonly credentials: TaskCredentialService;
  readonly admission: AdmissionService;
  readonly hosts: HostService;
  readonly contracts: ContractService;
  readonly harnesses: HarnessCatalog;
  readonly policy: PolicyService;
  readonly routing: RoutingService;
  readonly difficulty: DifficultyService;
  readonly budgets: BudgetService;
  readonly pauses: PauseService;
  readonly generation: GenerationService;
  readonly decisions: DecisionService;
  readonly resources: ProjectResourceService;
  readonly reviews: ReviewService;
  readonly waits: WaitService;
  readonly project: string;
  readonly deps: DispatcherDeps;
  readonly options: AttemptDispatcherOptions;
  worker: ScriptedWorker;
  dispatcher: DispatcherService;
  /** A new dispatcher over the same storage (a restart of the controller process). */
  restart(overrides?: Partial<DispatcherDeps>, options?: AttemptDispatcherOptions): DispatcherService;
  agent(name: string, grants?: Grant[]): Promise<{ id: string; aid: string }>;
  /** A ready task in the project, assigned to the agent, with its attempt admitted (naming the harness) the way the inbox does it. */
  task(title: string, agent: { aid: string }, extra?: { project?: string; admit?: boolean; harness?: string; repositoryId?: string }): Promise<{ taskId: string; attemptId: string | undefined }>;
  heartbeatHost(hostName?: string): Promise<void>;
}

let n = 0;
const cid = (label: string): string => `${label}-${n++}`;

/** Every service the dispatcher is built from, over one storage and one clock, with a scripted worker host. */
export async function buildWorld(storage: ControllerStorage, o: { route?: RouteResolver; withBudget?: boolean; workerScript?: WorkerScript; options?: AttemptDispatcherOptions; staleAfterMs?: number } = {}): Promise<DispatchWorld> {
  const clock = new TestClock();
  const options = { clock: clock.now, pause: async () => undefined };
  const projects = await ProjectService.open(storage, { holder: "c1", ...options });
  const epoch = projects.epoch;
  const principals = PrincipalService.withEpoch(storage, epoch, options);
  const owner = await principals.authenticate((await principals.bootstrapOwner({ name: "rob" })).token);
  const grants = GrantService.withEpoch(storage, epoch, options);
  const harnesses = HarnessCatalog.of([PI]);
  const contracts = ContractService.withEpoch(storage, epoch, options);
  const assignments = AssignmentService.withEpoch(storage, epoch, projects, { ...options, attemptGate: async (taskId, harness) => harnesses.checkAttempt(await contracts.recoveryOf(taskId), harness) });
  const inbox = InboxService.withEpoch(storage, epoch, assignments, { ...options, harness: "pi" });
  const effects = EffectService.withEpoch(storage, epoch, assignments, { ...options, holder: "dispatcher-1" });
  const blockers = BlockerService.withEpoch(storage, epoch, options);
  const waits = WaitService.withEpoch(storage, epoch, assignments, options);
  const credentials = TaskCredentialService.withEpoch(storage, epoch, options);
  const admission = AdmissionService.withEpoch(storage, epoch, options);
  const hosts = HostService.withEpoch(storage, epoch, assignments, { ...options, staleAfterMs: o.staleAfterMs ?? 90_000 });
  const policy = PolicyService.withEpoch(storage, epoch, grants, options);
  const routing = RoutingService.withEpoch(storage, epoch, options);
  await routing.setTable(owner, { commandId: cid("rt"), expectedRevision: 0, table: ROUTING_TABLE });
  const difficulty = DifficultyService.withEpoch(storage, epoch, routing, contracts, options);
  await difficulty.setProfiles(owner, { commandId: cid("sp"), expectedRevision: 0, profiles: EXEC_PROFILES });
  const budgets = BudgetService.withEpoch(storage, epoch, options);
  const pauses = PauseService.withEpoch(storage, epoch, { waits }, options);
  const decisions = DecisionService.withEpoch(storage, epoch, { effects }, options);
  const resources = ProjectResourceService.withEpoch(storage, epoch, options);
  const generation = GenerationService.withEpoch(storage, epoch, { assignments, effects, pauses, decisions }, options);
  const reviews = ReviewService.withEpoch(storage, epoch, { ...options, decisions });
  // The dispatcher's own service principal, and a host with a fresh heartbeat.
  await principals.enroll(owner, { commandId: cid("e"), kind: "service", name: "dispatcher", grants: [] });
  const dispatcherPrincipal = await principals.authenticate((await principals.issueCredential(owner, DISPATCHER_PRINCIPAL)).token);
  await principals.enroll(owner, { commandId: cid("e"), kind: "host", name: "w1", grants: [] });
  const hostP = await principals.authenticate((await principals.issueCredential(owner, "host:w1")).token);
  await hosts.announce(hostP, { commandId: cid("an"), capabilities: { os: "linux", arch: "x64", harnesses: [{ name: "pi", version: "1.3.0" }], isolation: ["bubblewrap"], tools: [], workspaces: [] } });
  let beat = 0;
  const heartbeatHost = async (): Promise<void> => { await hosts.heartbeat(hostP, { commandId: cid("hb"), sequence: ++beat }); };
  await heartbeatHost();
  await admission.setCapacity({ commandId: cid("cap"), actor: owner.id, host: "host:w1", capacity: { cpus: 8, memoryMb: 16_384 } });
  const project = (await projects.createProject({ commandId: cid("p"), actor: owner.id, name: "Garden" })).id;
  const worker = new ScriptedWorker("host:w1", o.workerScript ?? (async () => ({ status: "completed", text: "done" })));
  const route: RouteResolver = o.route ?? (async ({ commandId, taskId }) => {
    const d = await difficulty.resolve(dispatcherPrincipal, { commandId, taskId, role: "worker", data: "local-only", paidAuthorized: false });
    return d.outcome === "chosen" ? { route: d.route!, ...(d.profile?.harness === undefined ? {} : { harness: d.profile.harness }), role: d.role, request: d.request, routing: d.routingRevision ?? 0, profiles: d.profilesRevision } : { none: true, reasons: d.reasons };
  });
  const deps: DispatcherDeps = {
    principal: dispatcherPrincipal, assignments, projects, checkouts: resources, credentials, admission, hosts, workers: [worker], contracts, harnesses, policy, effects, blockers, route, routing, pauses, decisions, generation, reviews,
    ...(o.withBudget === false ? {} : { budgets }),
  };
  const make = (overrides: Partial<DispatcherDeps> = {}, opts: AttemptDispatcherOptions = {}): DispatcherService => DispatcherService.withEpoch(storage, epoch, { ...deps, workers: [world.worker], ...overrides }, { ...options, ...(o.options ?? {}), ...opts });
  const world: DispatchWorld = {
    storage, epoch, clock, owner, dispatcherPrincipal, resources, projects, assignments, inbox, effects, blockers, principals, grants, credentials, admission, hosts, contracts, harnesses, policy, routing, difficulty, budgets, pauses, generation, decisions, reviews, waits, project, deps, options,
    worker, dispatcher: undefined as never, restart: (overrides, opts) => make(overrides, opts), heartbeatHost,
    agent: async (name, g = []) => {
      await principals.enroll(owner, { commandId: cid("ag"), kind: "agent", name, grants: g });
      return { id: `agent:${name}`, aid: name };
    },
    task: async (title, agent, extra = {}) => {
      const taskId = (await projects.createTask({ commandId: cid("t"), actor: owner.id, projectId: extra.project ?? project, title, ...(extra.repositoryId === undefined ? {} : { repositoryId: extra.repositoryId }) })).id;
      await projects.transitionTask({ commandId: cid("r"), actor: owner.id, taskId, expectedRevision: 1, to: "ready" });
      await assignments.assignTask({ commandId: cid("as"), actor: owner.id, taskId, owner: { kind: "agent", id: agent.aid } });
      if (extra.admit === false) return { taskId, attemptId: undefined };
      const a = (await assignments.getAssignment(taskId))!;
      const admitted = await assignments.admitAttempt({ commandId: cid("ad"), actor: "inbox", taskId, expectedRevision: a.revision, generation: a.generation, owner: { kind: "agent", id: agent.aid }, harness: extra.harness ?? "pi" });
      return { taskId, attemptId: admitted.id };
    },
  };
  (world as { dispatcher: DispatcherService }).dispatcher = make();
  return world;
}

/** The agent grants a worker needs to act on a task: work on it, run effects, ask for a review, and the tools named. */
export const workGrants = (project: string, tools: readonly string[] = []): Grant[] => [
  { action: "attempt.work", project }, { action: "effect.perform", project }, { action: "review.request", project }, { action: "task.read", project }, ...tools.map((t) => ({ action: `tool.${t}`, project })),
];
