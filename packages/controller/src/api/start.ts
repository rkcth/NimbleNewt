import { ProjectService } from "../domain/service.js";
import { AssignmentService } from "../domain/assignments.js";
import { WaitService } from "../domain/waits.js";
import { DeskService, HistoryService, RetrievalService } from "../context/index.js";
import { UnsupportedEnvironmentError, detectEnvironment, overrideRequested, overriddenCheck, startupCheck, recordOverride, type EnvironmentFacts, type StartupCheck } from "../environment/index.js";
import { InquiryService } from "../inquiries/index.js";
import { GrantService, PrincipalService } from "../security/index.js";
import { SqliteStorage } from "../storage/sqlite/index.js";
import { PostgresStorage } from "../storage/postgres/index.js";
import type { ControllerStorage } from "../storage/types.js";
import { StateApi } from "./state-api.js";

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
  /** For tests: called with errors that are not part of the API contract. */
  readonly onInternalError?: (error: unknown) => void;
}

export interface Controller {
  readonly api: StateApi;
  readonly storage: ControllerStorage;
  readonly epoch: number;
  readonly check: StartupCheck;
  readonly services: {
    readonly principals: PrincipalService; readonly grants: GrantService; readonly projects: ProjectService; readonly assignments: AssignmentService;
    readonly waits: WaitService; readonly desks: DeskService; readonly histories: HistoryService; readonly retrieval: RetrievalService; readonly inquiries: InquiryService;
  };
  close(): Promise<void>;
}

/**
 * The controller's start-up path (first built with card U01). In order:
 * 1. Detect the environment (operating system, Node.js) and decide with `startupCheck`: a supported one passes silently, an unsupported one **refuses to start** with what was found, what is
 *    supported, how to test it and the exact override, unless the operator gave the override; then it prints the notice and goes on.
 * 2. Open the storage. For PostgreSQL the server's version is checked too: an unsupported server is refused unless the override was given (the adapter is told so), and then it is added to the notice.
 * 3. Take the primary epoch and write the audit record of an override (once per epoch). Nothing is written for a supported environment.
 * 4. Build the services and the state API on that epoch.
 * Nothing else about behaviour changes under the override.
 */
export async function startController(options: StartOptions): Promise<Controller> {
  const print = options.print ?? ((line: string) => { process.stderr.write(`${line}\n`); });
  const override = overrideRequested(options.argv, options.env);
  const facts = options.facts ?? detectEnvironment();
  let check: StartupCheck;
  try { check = startupCheck(facts, { allowUnsupported: override }); } catch (error) {
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
      const full = overriddenCheck([...check.problems, server]);
      // When an operating-system or Node.js problem already printed the notice, only the server's own line is new.
      for (const line of check.output.length === 0 ? full.output : full.output.filter((l) => l.includes(`${server.item}: found ${server.found}`))) print(line);
      check = full;
    }
  } else {
    storage = await SqliteStorage.open({ path: options.storage.path });
  }

  try {
    const projects = await ProjectService.open(storage, { holder: options.holder ?? "controller" });
    const epoch = projects.epoch;
    await recordOverride(storage, epoch, check);
    const principals = PrincipalService.withEpoch(storage, epoch);
    const grants = GrantService.withEpoch(storage, epoch);
    const assignments = AssignmentService.withEpoch(storage, epoch, projects);
    const waits = WaitService.withEpoch(storage, epoch, assignments);
    const desks = DeskService.withEpoch(storage, epoch);
    const histories = HistoryService.withEpoch(storage, epoch);
    const retrieval = RetrievalService.withEpoch(storage, epoch, desks, histories);
    const inquiries = InquiryService.withEpoch(storage, epoch, { histories, retrieval, waits, assignments });
    const api = new StateApi({ principals, projects, assignments, retrieval, inquiries, ...(options.onInternalError === undefined ? {} : { onInternalError: options.onInternalError }) });
    return { api, storage, epoch, check, services: { principals, grants, projects, assignments, waits, desks, histories, retrieval, inquiries }, close: () => storage.close() };
  } catch (error) {
    await storage.close().catch(() => undefined);
    throw error;
  }
}
