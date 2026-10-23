import { ProjectService } from "../domain/service.js";
import { AssignmentService } from "../domain/assignments.js";
import { WaitService } from "../domain/waits.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { dirname, resolve } from "node:path";
import {
  UnsupportedEnvironmentError, checkEnvironment, checkFilesystems, checkPrerequisites, decideStartup, detectDistribution, detectEnvironment, hostLine, overrideRequested, overriddenCheck, prerequisiteProblems, realProbes, recordHost, recordOverride,
  type EnvironmentFacts, type FilesystemDetector, type FilesystemReport, type PrerequisiteNeed, type PrerequisiteReport, type Probes, type StartupCheck,
} from "../environment/index.js";
import { AgentService } from "../agents/index.js";
import { HarnessCatalog, type HarnessDeclaration } from "../harness/index.js";
import { BlockerService } from "../domain/blockers.js";
import { ContractService, WaitGraphService } from "../planning/index.js";
import { InquiryService } from "../inquiries/index.js";
import { GrantService, PrincipalService, TaskCredentialService } from "../security/index.js";
import { SqliteStorage, probeSqliteLibrary } from "../storage/sqlite/index.js";
import { PostgresStorage, probePostgresLibrary } from "../storage/postgres/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { StateApi } from "./state-api.js";
import { ConfigurationService } from "../configuration/index.js";
import { ConversationService, type Availability } from "../conversations/index.js";
import { ReviewService } from "../review/index.js";
import { RoutingService } from "../routing/index.js";
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
  /** The parts this controller runs on this machine besides the controller itself (card F04j): their tools are required at start. Default none: the sandbox and the limits are then checked by the launcher, which refuses to advertise capacity without them. */
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
    readonly waits: WaitService; readonly desks: DeskService; readonly histories: HistoryService; readonly retrieval: RetrievalService; readonly inquiries: InquiryService; readonly agents: AgentService; readonly harnesses: HarnessCatalog; readonly contracts: ContractService; readonly graph: WaitGraphService; readonly reviews: ReviewService; readonly conversations: ConversationService; readonly configuration: ConfigurationService; readonly routing: RoutingService;
  };
  /** The conversation listener's address, when it was asked for. */
  readonly conversationUrl?: string;
  close(): Promise<void>;
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
  const filesystems = await checkFilesystems([...(dataDirectory === undefined ? [] : [{ role: "data directory" as const, path: dataDirectory }]), ...(options.workspaceRoots ?? []).map((path) => ({ role: "workspace" as const, path }))], { platform: facts.platform, ...(options.filesystem === undefined ? {} : { detect: options.filesystem }) });
  const needs: PrerequisiteNeed[] = ["start", options.storage.kind, ...(options.features ?? [])];
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

  try {
    const projects = await ProjectService.open(storage, { holder: options.holder ?? "controller" });
    const epoch = projects.epoch;
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
    const reviews = ReviewService.withEpoch(storage, epoch);
    const graph = WaitGraphService.withEpoch(storage, epoch, contracts, BlockerService.withEpoch(storage, epoch), { extraEdges: (projectId, tasks) => reviews.waitEdges(projectId, tasks) });
    // The routing table is refused unless the coordinator, the safety supervisor and every other role in it have a valid fallback list (card R04).
    const routing = RoutingService.withEpoch(storage, epoch, {}, {});
    const configuration = ConfigurationService.withEpoch(storage, epoch, { routing });
    const conversations = ConversationService.withEpoch(storage, epoch, options.availability === undefined ? {} : { availability: options.availability });
    const api = new StateApi({ principals, taskCredentials, projects, assignments, retrieval, inquiries, agents, contracts, graph, ...(options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError }) });
    const transport = options.conversationTransport === undefined ? undefined : await ConversationTransport.listen({ ...options.conversationTransport, conversations, principals });
    return {
      api, storage, epoch, check, filesystems, prerequisites, services: { principals, taskCredentials, grants, projects, assignments, waits, desks, histories, retrieval, inquiries, agents, harnesses: catalog, contracts, graph, reviews, conversations, configuration, routing },
      ...(transport === undefined ? {} : { conversationUrl: transport.url }),
      close: async () => { await transport?.close(); await storage.close(); },
    };
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
}
