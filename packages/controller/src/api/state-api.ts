import { DomainError, isDomainError } from "../domain/errors.js";
import { isStorageError } from "../storage/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import type { ProjectService } from "../domain/service.js";
import type { RetrievalService } from "../context/index.js";
import type { AgentService } from "../agents/index.js";
import type { WatchService } from "../events/handling.js";
import type { InquiryService } from "../inquiries/index.js";
import type { ContractService, WaitGraphService } from "../planning/index.js";
import type { ProjectPlanService, ProjectResourceService, ResponsibilityService } from "../projects/index.js";
import type { MeetingService } from "../meetings/index.js";
import type { AgentMessageService } from "../messaging/index.js";
import { SecureApi } from "../security/secured.js";
import type { PrincipalService } from "../security/principals.js";
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
  /** When present, agenda items can be captured, corrected and listed through the API (cards M01 and M03). */
  readonly meetings?: MeetingService;
  /** When present, an agent can ask the owner a question and the owner can see and answer the questions (card U12). */
  readonly ownerQuestions?: Pick<AgentMessageService, "askOwner" | "ownerQuestions" | "answerOwner">;
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
        ...(this.#deps.meetings === undefined ? {} : { meetings: this.#deps.meetings }),
        ...(this.#deps.ownerQuestions === undefined ? {} : { ownerQuestions: this.#deps.ownerQuestions }),
      };
      const result = await operation.run(context, args, request.commandId);
      if (operation.kind === "query") return { v: API_VERSION, op: request.op, ok: true, result };
      const deferred = operation.completion?.kind === "deferred";
      return { v: API_VERSION, op: request.op, ok: true, result, accepted: true, completed: !deferred, ...(operation.completion?.kind === "deferred" ? { awaits: operation.completion.awaits } : {}) };
    } catch (error) {
      return { v: API_VERSION, op, ok: false, error: this.#error(error) };
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
