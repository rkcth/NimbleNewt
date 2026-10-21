import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import type { ProjectService } from "../domain/service.js";
import type { InquiryService } from "../inquiries/index.js";
import type { RetrievalService } from "../context/index.js";
import type { Principal } from "../security/principals.js";
import type { SecureApi } from "../security/secured.js";
import type { JsonObject } from "../storage/types.js";

export interface Context {
  readonly principal: Principal;
  readonly secure: SecureApi;
  readonly retrieval: RetrievalService;
  readonly inquiries: InquiryService;
  readonly projects: ProjectService;
  readonly assignments: AssignmentService;
}

export type Args = Record<string, unknown>;

/**
 * Whether the effect of a command is finished when it is accepted. `completed`: the recorded change is the effect (a task changes state). `deferred`: the command is durably accepted
 * and announced, and something else (a worker) must act before the work is done; the result says what to look at.
 */
export type Completion = { readonly kind: "completed" } | { readonly kind: "deferred"; readonly awaits: string };

export interface Operation {
  readonly name: string;
  readonly kind: "query" | "command";
  readonly summary: string;
  /** Argument names with a plain description; a trailing `?` marks an optional one. */
  readonly args: Readonly<Record<string, string>>;
  readonly result: string;
  readonly completion?: Completion;
  readonly run: (context: Context, args: Args, commandId: string | undefined) => Promise<JsonObject>;
}

export const PAGE = { default: 20, max: 100 } as const;

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

function only(args: Args, known: readonly string[]): void {
  for (const key of Object.keys(args)) if (!known.includes(key)) invalid(`args.${key}`, "is not an argument of this operation");
}
function str(args: Args, key: string): string {
  const v = args[key];
  return typeof v === "string" ? v : invalid(`args.${key}`, "is required and must be text");
}
function optStr(args: Args, key: string): string | undefined {
  const v = args[key];
  return v === undefined ? undefined : (typeof v === "string" ? v : invalid(`args.${key}`, "must be text"));
}
function limitOf(args: Args): number {
  const v = args["limit"];
  if (v === undefined) return PAGE.default;
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= PAGE.max ? v : invalid("args.limit", `must be a whole number from 1 to ${PAGE.max}`);
}
const need = (commandId: string | undefined): string => commandId ?? invalid("commandId", "is required for a command");
const asJson = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const page = (result: { items: unknown[]; next?: string }): JsonObject => asJson({ items: result.items, ...(result.next === undefined ? {} : { next: result.next }) });
const found = (what: string, value: unknown): JsonObject => (value === undefined ? ((): never => { throw new DomainError("not_found", `no such ${what}`); })() : asJson({ item: value }));
const written = (r: { id: string; revision?: number; replayed: boolean }): JsonObject => asJson({ id: r.id, ...(r.revision === undefined ? {} : { revision: r.revision }), replayed: r.replayed });
/** Everything in `args` except the named keys, for passing on to a service that checks its own fields. */
const rest = (args: Args, ...skip: string[]): Args => Object.fromEntries(Object.entries(args).filter(([k]) => !skip.includes(k)));

/** The version-1 operations. The documentation (`renderApiDocs`) is generated from this table, so it cannot drift. */
export const OPERATIONS: readonly Operation[] = [
  { name: "project.get", kind: "query", summary: "One project.", args: { projectId: "the project's ID" }, result: "`{ item }`: the project, with its ID, revision and timestamps.",
    run: async (c, a) => { only(a, ["projectId"]); return found("project", await c.secure.getProject(str(a, "projectId"))); } },
  { name: "project.list", kind: "query", summary: "The projects the caller may read.", args: { "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["limit", "after"]); return page(await c.secure.listProjects({ limit: limitOf(a), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },
  { name: "task.get", kind: "query", summary: "One task.", args: { taskId: "the task's ID" }, result: "`{ item }`: the task, with its state, revision and timestamps.",
    run: async (c, a) => { only(a, ["taskId"]); return found("task", await c.secure.getTask(str(a, "taskId"))); } },
  { name: "task.list", kind: "query", summary: "Tasks the caller may read. Only the installation owner may list across projects; anyone else names the project.", args: { "projectId?": "the project (required unless the caller is the owner)", "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["projectId", "limit", "after"]); return page(await c.secure.listTasks({ limit: limitOf(a), ...(optStr(a, "projectId") === undefined ? {} : { projectId: optStr(a, "projectId")! }), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },
  { name: "assignment.get", kind: "query", summary: "Who owns a task, at which generation, and its state. This is where a deferred command (`task.assign`) is seen to complete.", args: { taskId: "the task's ID" }, result: "`{ item }`: the assignment (owner, generation, state, revision).",
    run: async (c, a) => { only(a, ["taskId"]); return found("assignment", await c.secure.getAssignment(str(a, "taskId"))); } },
  { name: "assignment.history", kind: "query", summary: "Every generation of a task's assignment, oldest first.", args: { taskId: "the task's ID" }, result: "`{ items }`.",
    run: async (c, a) => { only(a, ["taskId"]); return asJson({ items: await c.secure.history(str(a, "taskId")) }); } },
  { name: "activity.get", kind: "query", summary: "The latest observed activity on a task (what was last seen, by whom, and whether it was the current generation).", args: { taskId: "the task's ID" }, result: "`{ item }`.",
    run: async (c, a) => { only(a, ["taskId"]); return found("activity", await c.secure.getActivity(str(a, "taskId"))); } },
  { name: "search", kind: "query", summary: "Word search over the desk records and histories the caller may read.", args: { projectId: "the project to search", query: "words to look for", "limit?": "1 to 50, default 20", "cursor?": "the `next` of the previous page" }, result: "`{ hits, next?, scanLimited }`: each hit links to its original.",
    run: async (c, a) => { only(a, ["projectId", "query", "limit", "cursor"]); return asJson(await c.retrieval.search(c.principal, { projectId: str(a, "projectId"), query: str(a, "query"), ...(a["limit"] === undefined ? {} : { limit: a["limit"] as number }), ...(optStr(a, "cursor") === undefined ? {} : { cursor: optStr(a, "cursor")! }) })); } },
  { name: "inquiry.pending", kind: "query", summary: "Open inquiries waiting for the caller to answer.", args: { "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["limit", "after"]); return page(await c.inquiries.pendingFor(c.principal, { limit: limitOf(a), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },

  { name: "project.create", kind: "command", summary: "Creates a project.", args: { name: "the name", "goal?": "what it is for", "repositories?": "list of `{ id, location, label? }`" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.secure.createProject({ commandId: need(id), ...(a as object) } as never)) },
  { name: "project.update", kind: "command", summary: "Changes a project (the revision you read must still be current).", args: { projectId: "the project's ID", expectedRevision: "the revision you read", "name?": "new name", "goal?": "new goal", "state?": "`active` or `archived`", "addRepositories?": "repositories to add" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.secure.updateProject({ commandId: need(id), ...(a as object) } as never)) },
  { name: "task.create", kind: "command", summary: "Creates a task in a project (it starts `proposed`).", args: { projectId: "the project", title: "the title", "description?": "details", "repositoryId?": "one of the project's repositories" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.secure.createTask({ commandId: need(id), ...(a as object) } as never)) },
  { name: "task.update", kind: "command", summary: "Changes a task's title, description or repository (the revision you read must still be current).", args: { taskId: "the task", expectedRevision: "the revision you read", "title?": "new title", "description?": "new description", "repositoryId?": "a repository of the project, or null to detach" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.secure.updateTask({ commandId: need(id), ...(a as object) } as never)) },
  { name: "task.transition", kind: "command", summary: "Moves a task to another state (only the lifecycle's allowed moves).", args: { taskId: "the task", expectedRevision: "the revision you read", to: "`ready`, `in_progress`, `blocked`, `done` or `cancelled`" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.secure.transitionTask({ commandId: need(id), ...(a as object) } as never)) },
  { name: "task.assign", kind: "command", summary: "Gives a task an owner. Accepted and recorded at once; the work is not under way until the owner's worker admits an attempt.", args: { taskId: "the task", "expectedRevision?": "the assignment's revision, when it was released before", owner: "`{ kind, id }` of the owner", "reason?": "why" }, result: "`{ id, revision, replayed }`.", completion: { kind: "deferred", awaits: "the owner's worker admitting an attempt (see assignment.get and activity.get)" },
    run: async (c, a, id) => written(await c.secure.assignTask({ commandId: need(id), ...(a as object) } as never)) },
  { name: "task.transfer", kind: "command", summary: "Moves a task's ownership to another owner, fencing the old owner. Accepted and recorded at once; the new owner's worker must admit an attempt.", args: { taskId: "the task", expectedRevision: "the assignment's revision", to: "`{ kind, id }` of the new owner", "reason?": "why" }, result: "`{ id, revision, replayed }`.", completion: { kind: "deferred", awaits: "the new owner's worker admitting an attempt (see assignment.get)" },
    run: async (c, a, id) => written(await c.secure.transferTask({ commandId: need(id), ...(a as object) } as never)) },
  { name: "task.release", kind: "command", summary: "Gives up a task's ownership. The record is changed at once; the previous owner's worker may keep running until its next fenced write is refused.", args: { taskId: "the task", expectedRevision: "the assignment's revision", "reason?": "why" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.secure.releaseTask({ commandId: need(id), ...(a as object) } as never)) },
];

export const OPERATION_BY_NAME: ReadonlyMap<string, Operation> = new Map(OPERATIONS.map((o) => [o.name, o]));
void rest;
