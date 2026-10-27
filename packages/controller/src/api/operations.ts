import { DomainError } from "../domain/errors.js";
import type { AssignmentService } from "../domain/assignments.js";
import type { ProjectService } from "../domain/service.js";
import type { AgentService } from "../agents/index.js";
import type { WatchService } from "../events/handling.js";
import type { InquiryService } from "../inquiries/index.js";
import type { ContractService, WaitGraphService } from "../planning/index.js";
import type { ProjectPlanService, ProjectResourceService, ResponsibilityService } from "../projects/index.js";
import type { RetrievalService } from "../context/index.js";
import type { ContextBranchService } from "../branches/index.js";
import type { MeetingService } from "../meetings/index.js";
import type { AgentMessageService } from "../messaging/index.js";
import { shownLines } from "../standups/standups.js";
import type { Principal } from "../security/principals.js";
import type { SecureApi } from "../security/secured.js";
import type { JsonObject } from "../storage/types.js";

export interface Context {
  readonly principal: Principal;
  readonly secure: SecureApi;
  readonly retrieval: RetrievalService;
  readonly inquiries: InquiryService;
  readonly agents: AgentService;
  readonly contracts: ContractService;
  readonly graph: WaitGraphService;
  readonly projects: ProjectService;
  readonly assignments: AssignmentService;
  /** Absent when the controller runs without event handling. */
  readonly watches?: WatchService;
  /** Absent when the controller runs without project resources, plans and responsibilities (card P01). */
  readonly resources?: ProjectResourceService;
  readonly plans?: ProjectPlanService;
  readonly responsibilities?: ResponsibilityService;
  /** Absent when the controller runs without meetings (cards M01 and M03). */
  readonly meetings?: MeetingService;
  /** Absent when the controller runs without context branches (card C05). */
  readonly branches?: ContextBranchService;
  /** Absent when the controller runs without agent messages (card U12): questions to the owner. */
  readonly ownerQuestions?: Pick<AgentMessageService, "askOwner" | "ownerQuestions" | "answerOwner">;
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
/** A task credential acts for its one task: it may not read the failed event queue, which spans tasks and carries text from outside. */
const notFromTask = (c: Context, what: string): void => { if (c.principal.taskScope !== undefined) throw new DomainError("forbidden", `a task credential may not ${what}`); };
const watches = (c: Context): WatchService => c.watches ?? ((): never => { throw new DomainError("unavailable", "event handling is not configured"); })();
const unavailable = (what: string): never => { throw new DomainError("unavailable", `${what} is not configured`); };
const resources = (c: Context): ProjectResourceService => c.resources ?? unavailable("project resources");
const plans = (c: Context): ProjectPlanService => c.plans ?? unavailable("project plans");
const ownerQuestionsOf = (c: Context): NonNullable<Context["ownerQuestions"]> => c.ownerQuestions ?? unavailable("questions to the owner");
const branchesOf = (c: Context): ContextBranchService => c.branches ?? unavailable("context branches");
const meetingsOf = (c: Context): MeetingService => c.meetings ?? unavailable("meetings");
const duties = (c: Context): ResponsibilityService => c.responsibilities ?? unavailable("responsibilities");
const optNum = (args: Args, key: string): number | undefined => { const v = args[key]; return v === undefined ? undefined : (typeof v === "number" ? v : invalid(`args.${key}`, "must be a number")); };
const need = (commandId: string | undefined): string => commandId ?? invalid("commandId", "is required for a command");
const asJson = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;
const page = (result: { items: unknown[]; next?: string; scanLimited?: boolean }): JsonObject => asJson({ items: result.items, ...(result.next === undefined ? {} : { next: result.next }), ...(result.scanLimited === true ? { scanLimited: true } : {}) });
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
  { name: "agent.get", kind: "query", summary: "One agent record. The owner, a holder of `agent.read` or `agent.manage`, and the agent itself may ask; anyone else gets `not_found`.", args: { agentId: "the agent's ID" }, result: "`{ item }`: the agent (friendly name, roles, team, supervisor, state, identity), with its revision.",
    run: async (c, a) => { only(a, ["agentId"]); return found("agent", await c.agents.get(c.principal, str(a, "agentId"))); } },
  { name: "agent.list", kind: "query", summary: "Agent records (needs `agent.read` or `agent.manage`).", args: { "teamId?": "only this team's members", "state?": "`active` or `retired`", "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["teamId", "state", "limit", "after"]); const raw = optStr(a, "state"); if (raw !== undefined && raw !== "active" && raw !== "retired") invalid("args.state", "must be active or retired"); const state = raw as "active" | "retired" | undefined; return page(await c.agents.list(c.principal, { limit: limitOf(a), ...(optStr(a, "teamId") === undefined ? {} : { teamId: optStr(a, "teamId")! }), ...(state === undefined ? {} : { state }), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },
  { name: "team.list", kind: "query", summary: "Teams (needs `agent.read` or `agent.manage`).", args: { "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["limit", "after"]); return page(await c.agents.listTeams(c.principal, { limit: limitOf(a), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },
  { name: "role.list", kind: "query", summary: "Role templates: each name, the capability bundle it stands for and the roles it excludes (needs `agent.read` or `agent.manage`). A role grants nothing by itself.", args: { "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["limit", "after"]); return page(await c.agents.listRoles(c.principal, { limit: limitOf(a), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },
  { name: "agent.create", kind: "command", summary: "Creates an agent with a new durable ID and its own identity (no grants, no credential). Needs `agent.manage`.", args: { friendlyName: "a label for people (it may change and repeat)", "roles?": "role names", "teamId?": "a team", "supervisorId?": "the agent it reports to", "defaultProfile?": "a routing profile name", "permittedOverrides?": "what its profile may be overridden for", "environment?": "an environment name", "persona?": "style text (no effect on permissions)" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.agents.create(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "agent.update", kind: "command", summary: "Changes fields of an agent (the revision you read must still be current; `null` clears teamId, supervisorId, defaultProfile, environment or persona). Needs `agent.manage`.", args: { agentId: "the agent", expectedRevision: "the revision you read", "friendlyName?": "new label", "roles?": "the full list of role names", "teamId?": "team or null", "supervisorId?": "agent or null", "defaultProfile?": "profile name or null", "permittedOverrides?": "list", "environment?": "name or null", "persona?": "text or null" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.agents.update(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "agent.retire", kind: "command", summary: "Retires an agent and disables its identity. Refused while active agents report to it. Its ID is never reused; tasks it owns stay assigned to it until explicitly transferred. Any holder of `agent.manage` may retire any agent.", args: { agentId: "the agent", expectedRevision: "the revision you read" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.agents.retire(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "team.create", kind: "command", summary: "Creates a team, optionally under another team. Needs `agent.manage`.", args: { name: "the team's name", "parentTeamId?": "the team it sits under" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.agents.createTeam(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "role.define", kind: "command", summary: "Defines a role template, or replaces one when `expectedRevision` is given. Needs `agent.manage`.", args: { name: "the role's name", capabilities: "action names the role stands for (granting is separate)", "excludes?": "roles that may not be combined with it", "description?": "what it is for", "expectedRevision?": "the revision you read, to replace an existing role" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.agents.defineRole(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "contract.get", kind: "query", summary: "A task's contract as it stands (expected result, acceptance criteria, priority, difficulty, budget, P or PC class, required evidence, permissions). A task with none reads as the defaults at version 0.", args: { taskId: "the task" }, result: "`{ item }`: the contract with its `version`.",
    run: async (c, a) => { only(a, ["taskId"]); return found("task", await c.contracts.get(c.principal, str(a, "taskId"))); } },
  { name: "contract.history", kind: "query", summary: "Every stored version of a task's contract, oldest first.", args: { taskId: "the task" }, result: "`{ items }`.",
    run: async (c, a) => { only(a, ["taskId"]); const items = await c.contracts.history(c.principal, str(a, "taskId")); if (items === undefined) throw new DomainError("not_found", "no such task"); return asJson({ items }); } },
  { name: "dependency.list", kind: "query", summary: "What a task depends on, and which tasks depend on it.", args: { taskId: "the task" }, result: "`{ item: { dependsOn, dependents } }`.",
    run: async (c, a) => { only(a, ["taskId"]); return found("task", await c.contracts.dependencies(c.principal, str(a, "taskId"))); } },
  { name: "contract.set", kind: "command", summary: "Changes fields of a task's contract; each change stores a new version. Priority, difficulty and the P or PC class each need their own authority.", args: { taskId: "the task", expectedVersion: "the version you read (0 if none)", "expectedResult?": "text or null", "acceptanceCriteria?": "list of text", "priority?": "0 to 9, higher first", "difficulty?": "`trivial`, `easy`, `medium`, `hard`, `expert` or null", "budget?": "`{ maxAttempts?, maxMinutes?, maxCost? }`", "workClass?": "`P` or `PC`", "requiredEvidence?": "list of text", "permissions?": "action names the work may use, at most", "recovery?": "`none`, `native-continuation` (default) or `portable-reconstruction`: what the task needs from its harness to be recovered" }, result: "`{ id, revision (the new version), replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.contracts.setContract(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "dependency.add", kind: "command", summary: "Makes a task depend on another task of the same project. Refused if it would make a cycle. Needs `task.dependency.write` for the dependent task.", args: { taskId: "the dependent task", prerequisiteId: "the task it depends on", "responsible?": "the agent answerable for the prerequisite" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.contracts.addDependency(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "dependency.remove", kind: "command", summary: "Removes a dependency. Needs `task.dependency.write` for the dependent task.", args: { taskId: "the dependent task", prerequisiteId: "the task it depended on" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await c.contracts.removeDependency(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "waits.detect", kind: "command", summary: "Looks for tasks waiting for each other in a ring (through task dependencies and open inquiries) and opens a blocker for each ring. Needs `blocker.manage`.", args: { projectId: "the project" }, result: "`{ cycles }`: each ring's tasks and agents, the waits that form it and its blocker.", completion: { kind: "completed" },
    run: async (c, a, id) => asJson(await c.graph.detect(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "assignment.get", kind: "query", summary: "Who owns a task, at which generation, and its state. This is where a deferred command (`task.assign`) is seen to complete.", args: { taskId: "the task's ID" }, result: "`{ item }`: the assignment (owner, generation, state, revision).",
    run: async (c, a) => { only(a, ["taskId"]); return found("assignment", await c.secure.getAssignment(str(a, "taskId"))); } },
  { name: "assignment.history", kind: "query", summary: "Every generation of a task's assignment, oldest first.", args: { taskId: "the task's ID" }, result: "`{ items }`.",
    run: async (c, a) => { only(a, ["taskId"]); return asJson({ items: await c.secure.history(str(a, "taskId")) }); } },
  { name: "activity.get", kind: "query", summary: "The latest observed activity on a task (what was last seen, by whom, and whether it was the current generation).", args: { taskId: "the task's ID" }, result: "`{ item }`.",
    run: async (c, a) => { only(a, ["taskId"]); return found("activity", await c.secure.getActivity(str(a, "taskId"))); } },
  { name: "search", kind: "query", summary: "Word search over the desk records and histories the caller may read.", args: { projectId: "the project to search", query: "words to look for", "limit?": "1 to 50, default 20", "cursor?": "the `next` of the previous page" }, result: "`{ hits, next?, scanLimited }`: each hit links to its original.",
    run: async (c, a) => { only(a, ["projectId", "query", "limit", "cursor"]); return asJson(await c.retrieval.search(c.principal, { projectId: str(a, "projectId"), query: str(a, "query"), ...(a["limit"] === undefined ? {} : { limit: a["limit"] as number }), ...(optStr(a, "cursor") === undefined ? {} : { cursor: optStr(a, "cursor")! }) })); } },
  { name: "events.failures", kind: "query", summary: "Event handling attempts that failed (a delivery that could not be made, one the agent reported failed, one whose lease ended without a report, or one given up on), in record ID order (IDs are derived, so this is not chronological; sort by `createdAt`). The owner sees all; anyone else sees only the handlings of projects whose histories they may read (`projectId` narrows the list and grants nothing).", args: { "projectId?": "narrow to this project (what the caller may read is filtered either way)", "taskId?": "only this task", "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next?, scanLimited? }`: each handling with its state, attempts, failure, owner and the events it carried. `scanLimited: true` means the scan stopped before the end of the records: continue with `after` (as `next`).",
    run: async (c, a) => { notFromTask(c, "read the failed event queue"); only(a, ["projectId", "taskId", "limit", "after"]); return page(await watches(c).failures(c.principal, { limit: limitOf(a), ...(optStr(a, "projectId") === undefined ? {} : { projectId: optStr(a, "projectId")! }), ...(optStr(a, "taskId") === undefined ? {} : { taskId: optStr(a, "taskId")! }), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },
  { name: "events.handling", kind: "query", summary: "One event handling attempt: its events, why it was made, what became of it, the inbox item, and the text that came with the events (untrusted data).", args: { handlingId: "the handling's ID" }, result: "`{ item: { handling, data, inbox? } }`.",
    run: async (c, a) => { notFromTask(c, "read the failed event queue"); only(a, ["handlingId"]); return found("handling", await watches(c).inspect(c.principal, str(a, "handlingId"))); } },
  { name: "events.loops", kind: "query", summary: "Self-triggering event loops that are held (their events are not scheduled until the owner releases them).", args: { "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next?, scanLimited? }` (see `events.failures` for `scanLimited`).",
    run: async (c, a) => { notFromTask(c, "read the failed event queue"); only(a, ["limit", "after"]); return page(await watches(c).loops(c.principal, { limit: limitOf(a), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },
  { name: "branch.open", kind: "command", summary: "Opens a retained context branch of a task (an inquiry's, or a side question's): the parent's history is frozen at this point and the branch has its own. `returnTo` is where the work goes back to (default: the task it began from).", args: { taskId: "the task", purpose: "what the branch is for", "returnTo?": "the return destination", "continuationId?": "a complete continuation capture the branch inherits", "inquiryId?": "the inquiry it answers" }, result: "`{ id, scopeId, throughSeq, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => asJson(await branchesOf(c).open(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "branch.get", kind: "query", summary: "A branch, the updates applied to it (resolved for the caller only) and the lengths of the frozen parent and the branch.", args: { branchId: "the branch" }, result: "`{ item: { branch, updates, counts } }`.",
    run: async (c, a) => { only(a, ["branchId"]); return found("branch", await branchesOf(c).view(c.principal, str(a, "branchId"))); } },
  { name: "branch.apply", kind: "command", summary: "Applies selected updates (references to records) to a branch, once; the revision you read must still be current.", args: { branchId: "the branch", expectedRevision: "the revision you read", updates: "a list of references" }, result: "`{ revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => asJson(await branchesOf(c).applyUpdates(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "branch.suspend", kind: "command", summary: "Suspends an active branch (a newer task arrived): it keeps exactly the history it had and its return destination.", args: { branchId: "the branch", expectedRevision: "the revision you read", reason: "why" }, result: "`{}`.", completion: { kind: "completed" },
    run: async (c, a, id) => { await branchesOf(c).suspend(c.principal, { commandId: need(id), ...(a as object) } as never); return asJson({}); } },
  { name: "branch.restore", kind: "command", summary: "Brings a suspended branch back with exactly the history it had; anything others wrote to it meanwhile is reported, not hidden.", args: { branchId: "the branch", expectedRevision: "the revision you read" }, result: "`{}`.", completion: { kind: "completed" },
    run: async (c, a, id) => { await branchesOf(c).restore(c.principal, { commandId: need(id), ...(a as object) } as never); return asJson({}); } },
  { name: "branch.redirect", kind: "command", summary: "Changes where a branch returns to; the destination otherwise stays until the branch is resumed.", args: { branchId: "the branch", expectedRevision: "the revision you read", returnTo: "the new return destination" }, result: "`{}`.", completion: { kind: "completed" },
    run: async (c, a, id) => { await branchesOf(c).redirect(c.principal, { commandId: need(id), ...(a as object) } as never); return asJson({}); } },
  { name: "branch.append", kind: "command", summary: "Adds a line to the branch's own history (never to the frozen parent's).", args: { branchId: "the branch", text: "the text" }, result: "`{ seq, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => asJson(await branchesOf(c).append(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "branch.history", kind: "query", summary: "The frozen parent's history up to where the branch began, or the branch's own, in order.", args: { branchId: "the branch", part: "`parent` or `branch`", "afterSeq?": "return entries after this number", "limit?": "how many, default 50" }, result: "`{ item }`.",
    run: async (c, a) => { only(a, ["branchId", "part", "afterSeq", "limit"]); const part = str(a, "part"); if (part !== "parent" && part !== "branch") throw new DomainError("invalid_command", "part: parent or branch", { field: "part" }); return found("branch", await branchesOf(c).history(c.principal, str(a, "branchId"), { part, ...(typeof a["afterSeq"] === "number" ? { afterSeq: a["afterSeq"] } : {}), limit: typeof a["limit"] === "number" ? a["limit"] : 50 })); } },
  { name: "branch.switch", kind: "command", summary: "Suspends one branch and restores another in one step; each keeps exactly the history available to it.", args: { suspend: "`{ branchId, expectedRevision, reason }`", restore: "`{ branchId, expectedRevision }`" }, result: "`{}`.", completion: { kind: "completed" },
    run: async (c, a, id) => { await branchesOf(c).switch(c.principal, { commandId: need(id), ...(a as object) } as never); return asJson({}); } },
  { name: "branch.resume", kind: "command", summary: "Finishes a branch and returns to its destination, which stays until resumed or explicitly changed.", args: { branchId: "the branch", expectedRevision: "the revision you read" }, result: "`{ returnedTo }`.", completion: { kind: "completed" },
    run: async (c, a, id) => asJson(await branchesOf(c).resume(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "branch.pending", kind: "query", summary: "Branches that are waiting to be returned from.", args: { "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["limit", "after"]); return page(await branchesOf(c).pendingReturns(c.principal, { limit: limitOf(a), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },
  { name: "branch.delegate", kind: "command", summary: "Gives a child task only the selected references of a branch (never a fork of the parent context).", args: { branchId: "the branch", childTaskId: "the child task", refs: "a list of references" }, result: "`{ id, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => asJson(await branchesOf(c).delegate(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "owner.ask", kind: "command", summary: "An agent asks the owner a question about a task it works on. The question appears in `owner.questions` with the task's context; if `waitId` names the typed wait the task is blocked in for the owner, the owner's answer resolves it. Asking never wakes or resumes anything.", args: { taskId: "the task the question is about", question: "the question", "waitId?": "the wait the answer resolves" }, result: "`{ id, replayed }` (`id` is the inquiry).", completion: { kind: "completed" },
    run: async (c, a, id) => { only(a, ["taskId", "question", "waitId"]); const asked = await ownerQuestionsOf(c).askOwner(c.principal, { commandId: need(id), taskId: str(a, "taskId"), question: str(a, "question"), ...(optStr(a, "waitId") === undefined ? {} : { waitId: optStr(a, "waitId")! }) }); return asJson({ id: asked.inquiryId, replayed: asked.replayed }); } },
  { name: "owner.questions", kind: "query", summary: "The questions agents have put to the owner (each page in the order asked), each with the task it is about (title, state, project) and the wait its answer will resolve. Owner only.", args: { "limit?": `1 to ${PAGE.max}, default ${PAGE.default}`, "after?": "the `next` of the previous page" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["limit", "after"]); return page(await ownerQuestionsOf(c).ownerQuestions(c.principal, { limit: limitOf(a), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after")! }) })); } },
  { name: "owner.answer", kind: "command", summary: "The owner answers a question; if the task waits on it, the wait is resolved and the task is ready again. Owner only.", args: { inquiryId: "the question's ID (`id` of `owner.ask`)", answer: "the answer" }, result: "`{ id, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => { only(a, ["inquiryId", "answer"]); return written(await ownerQuestionsOf(c).answerOwner(c.principal, { commandId: need(id), inquiryId: str(a, "inquiryId"), answer: str(a, "answer") })); } },
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

  { name: "resource.list", kind: "query", summary: "The resources bound to a project (repositories, output folders, documents, services), each with its access scope.", args: { projectId: "the project", "state?": "`bound` or `unbound`" }, result: "`{ items }`.",
    run: async (c, a) => { only(a, ["projectId", "state"]); const st = optStr(a, "state"); if (st !== undefined && st !== "bound" && st !== "unbound") invalid("args.state", "must be bound or unbound"); const items = await resources(c).list(c.principal, str(a, "projectId"), st === undefined ? {} : { state: st as never }); if (items === undefined) throw new DomainError("not_found", "no such project"); return asJson({ items }); } },
  { name: "resource.get", kind: "query", summary: "One bound resource.", args: { resourceId: "the resource's ID" }, result: "`{ item }`.",
    run: async (c, a) => { only(a, ["resourceId"]); return found("resource", await resources(c).get(c.principal, str(a, "resourceId"))); } },
  { name: "checkout.get", kind: "query", summary: "The checkout a task works in, from records: the bound repository it names, with its location and scope. Refused with `checkout_changed` when a dispatched task's checkout has moved or been unbound.", args: { taskId: "the task" }, result: "`{ item }`.",
    run: async (c, a) => { only(a, ["taskId"]); return found("task", await resources(c).resolveCheckout(c.principal, str(a, "taskId"))); } },
  { name: "project.schedule", kind: "query", summary: "A project's due date and milestones against the clock now (`overdue` is computed, never stored; passing a date changes nothing).", args: { projectId: "the project" }, result: "`{ item }`.",
    run: async (c, a) => { only(a, ["projectId"]); return found("project", await plans(c).schedule(c.principal, str(a, "projectId"))); } },
  { name: "responsibility.get", kind: "query", summary: "One ongoing responsibility.", args: { responsibilityId: "the responsibility's ID" }, result: "`{ item }`.",
    run: async (c, a) => { only(a, ["responsibilityId"]); return found("responsibility", await duties(c).get(c.principal, str(a, "responsibilityId"))); } },
  { name: "responsibility.list", kind: "query", summary: "A project's ongoing responsibilities.", args: { projectId: "the project", "state?": "`active`, `paused` or `retired`" }, result: "`{ items }`.",
    run: async (c, a) => { only(a, ["projectId", "state"]); const st = optStr(a, "state"); if (st !== undefined && st !== "active" && st !== "paused" && st !== "retired") invalid("args.state", "must be active, paused or retired"); const items = await duties(c).list(c.principal, str(a, "projectId"), st === undefined ? {} : { state: st as never }); if (items === undefined) throw new DomainError("not_found", "no such project"); return asJson({ items }); } },
  { name: "responsibility.status", kind: "query", summary: "Where a responsibility stands against its schedule now: last check, next check due, whether it is overdue, whether now is inside a maintenance window. Starts nothing.", args: { responsibilityId: "the responsibility" }, result: "`{ item }`.",
    run: async (c, a) => { only(a, ["responsibilityId"]); return found("responsibility", await duties(c).status(c.principal, str(a, "responsibilityId"))); } },
  { name: "responsibility.history", kind: "query", summary: "A responsibility's operational history (checks, interventions, incidents, notes), oldest first.", args: { responsibilityId: "the responsibility", "afterSeq?": "the `next` of the previous page", "limit?": "1 to 100, default 20" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["responsibilityId", "afterSeq", "limit"]); const r = await duties(c).history(c.principal, str(a, "responsibilityId"), { limit: limitOf(a), ...(optNum(a, "afterSeq") === undefined ? {} : { afterSeq: optNum(a, "afterSeq")! }) }); if (r === undefined) throw new DomainError("not_found", "no such responsibility"); return asJson(r); } },

  { name: "resource.bind", kind: "command", summary: "Binds a resource to a project with an access scope (read by default). A repository bind also lists the repository for the project's tasks. Needs `resource.write` (and `resource.scope.write` for write access).", args: { projectId: "the project", kind: "`repository`, `output`, `document`, `service` or `other`", label: "a name, unique among the project's bound resources", locator: "where it is (a path, URL or name; never a credential)", "repositoryId?": "the project's handle for a repository (default: made from the label)", "access?": "`read` (default) or `write`", "paths?": "limit the scope to these paths below the resource", "acknowledgeOverlap?": "true to bind a location that contains or lies inside another project's binding (needs `resource.scope.write`)" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await resources(c).bindResource(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "resource.move", kind: "command", summary: "Points a bound resource at another location (needs `resource.scope.write` too when its access is write or unlimited). Tasks already dispatched to it are not redirected: they refuse with `checkout_changed` until their checkout is confirmed.", args: { resourceId: "the resource", expectedRevision: "the revision you read", locator: "the new location", "acknowledgeOverlap?": "true to accept an overlap with another project's binding" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await resources(c).moveResource(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "resource.scope", kind: "command", summary: "Replaces a resource's access scope for its project. Widening it needs `resource.scope.write`.", args: { resourceId: "the resource", expectedRevision: "the revision you read", access: "`read` or `write`", "paths?": "limit the scope to these paths" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await resources(c).setScope(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "resource.unbind", kind: "command", summary: "Ends a binding (refused while a responsibility manages the resource or an unfinished task is dispatched against it).", args: { resourceId: "the resource", expectedRevision: "the revision you read" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await resources(c).unbindResource(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "checkout.pin", kind: "command", summary: "Pins the checkout a task is dispatched against: the bound repository it names, at its current location. Needs `assignment.manage` for the task.", args: { taskId: "the task" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await resources(c).pinCheckout(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "checkout.repin", kind: "command", summary: "Confirms the checkout a task now resolves to after a move or a change of its repository.", args: { taskId: "the task", expectedRevision: "the pin's revision" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await resources(c).repinCheckout(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "project.plan", kind: "command", summary: "Sets a project's optional due date, workstreams, milestones and authorized participants (each given field replaces that field; `dueDate: null` clears it). A due date is information: passing it changes no state.", args: { projectId: "the project", expectedRevision: "the revision you read", "dueDate?": "`YYYY-MM-DD` or a UTC timestamp, or null", "workstreams?": "list of `{ id, name, description? }`", "milestones?": "list of `{ id, name, state?, dueDate?, workstreamId? }`", "participants?": "list of `{ principalId, role? }` (active agents; needs `project.participants.write`)" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await plans(c).setPlan(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "responsibility.create", kind: "command", summary: "Creates an ongoing responsibility in a project. Naming the answerable agent or managed resources also needs `responsibility.assign`.", args: { projectId: "the project", title: "the title", objective: "what must continually be true or done", "desiredCondition?": "the condition to keep", "ownerId?": "the answerable agent (principal ID)", "managed?": "IDs of project resources it manages", "everyMinutes?": "how often to check", "eventSources?": "names of event sources", "permittedActions?": "action names its work may use at most", "maintenanceWindows?": "list of `{ days, start, end }` (UTC)", "escalation?": "`{ to, afterMinutes?, note? }`" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await duties(c).create(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "responsibility.update", kind: "command", summary: "Changes a responsibility (the revision you read must still be current); `state` is active, paused or retired (final).", args: { responsibilityId: "the responsibility", expectedRevision: "the revision you read", "state?": "`active`, `paused` or `retired`", "title?": "new title", "objective?": "new objective", "desiredCondition?": "new condition", "ownerId?": "agent or null", "managed?": "resource IDs", "everyMinutes?": "minutes or null", "eventSources?": "names", "permittedActions?": "action names", "maintenanceWindows?": "windows", "escalation?": "escalation or null" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await duties(c).update(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "responsibility.record", kind: "command", summary: "Adds a check, intervention, incident or note to a responsibility's history, optionally linked to the bounded task it produced.", args: { responsibilityId: "the responsibility", kind: "`check`, `intervention`, `incident` or `note`", summary: "what was found or done", "outcome?": "`ok`, `attention` or `failed`", "taskId?": "the task it produced" }, result: "`{ id, revision, replayed }`.", completion: { kind: "completed" },
    run: async (c, a, id) => written(await duties(c).record(c.principal, { commandId: need(id), ...(a as object) } as never)) },
  { name: "agenda.capture", kind: "command", summary: "Saves a topic for a later stand-up or meeting, linked to the conversation it came from, and returns it as it will appear so it can be checked and corrected. The request type sets its authority: `discussion` and `recommendation` never execute anything; `delegated-decision` and `owner-instruction` can be recorded by the owner only. Needs `meeting.agenda` in the project (or the owner).", args: { projectId: "the project", topic: "the topic, in the requester's words", "question?": "the requester's actual question", "context?": "relevant context and constraints", "requestedOutcome?": "what the requester wants out of it", "urgency?": "`normal` (default) or `urgent`", "intent?": "`discussion` (default), `recommendation`, `delegated-decision` or `owner-instruction`", "participants?": "agent principal IDs it is for (empty: whoever attends)", "category?": "`conflict` (managers and the owner), `question`, `decision`, `topic` or `improvement`; default derived from the request type", "sourceTurnId?": "the owner's chat turn it came from (the chat sets this)" }, result: "`{ id, revision, replayed, shown }`: `shown` is the plain lines to show the requester.", completion: { kind: "completed" },
    run: async (c, a, id) => {
      only(a, ["projectId", "topic", "question", "context", "requestedOutcome", "urgency", "intent", "participants", "category", "sourceTurnId"]);
      const { sourceTurnId, ...rest } = a;
      // Which conversation a topic came from is the owner's chat to say (the chat sets it itself); no other caller names one.
      if (sourceTurnId !== undefined && c.principal.kind !== "owner") throw new DomainError("forbidden", "only the owner's chat links a topic to a conversation");
      const made = await meetingsOf(c).addAgendaItem(c.principal, { commandId: need(id), ...(rest as object), ...(sourceTurnId === undefined ? {} : { source: { kind: "chat-turn", id: typeof sourceTurnId === "string" ? sourceTurnId : invalid("args.sourceTurnId", "must be text") } }) } as never);
      const item = await meetingsOf(c).agendaItem(c.principal, made.id);
      return asJson({ id: made.id, revision: item?.revision ?? 1, replayed: made.replayed, shown: item === undefined ? [] : shownLines(item) });
    } },
  { name: "agenda.correct", kind: "command", summary: "Corrects an open agenda item (the revision you read must still be current); a field given as null is cleared. Only the owner can set or change an instruction or a decision delegated to the team. Returns the item as it now reads.", args: { itemId: "the agenda item", expectedRevision: "the revision you read", "topic?": "new topic", "question?": "new question, or null", "context?": "new context, or null", "requestedOutcome?": "new outcome, or null", "urgency?": "`normal` or `urgent`", "intent?": "the request type", "participants?": "agent principal IDs", "category?": "the kind of point, or null", "timeboxMinutes?": "minutes to spend on it, or null" }, result: "`{ id, revision, replayed, shown }`.", completion: { kind: "completed" },
    run: async (c, a, id) => {
      only(a, ["itemId", "expectedRevision", "topic", "question", "context", "requestedOutcome", "urgency", "intent", "participants", "category", "timeboxMinutes"]);
      const made = await meetingsOf(c).correctAgendaItem(c.principal, { commandId: need(id), ...(a as object) } as never);
      const itemId = str(a, "itemId");
      const item = await meetingsOf(c).agendaItem(c.principal, itemId);
      return asJson({ id: itemId, revision: made.revision, replayed: made.replayed, shown: item === undefined ? [] : shownLines(item) });
    } },
  { name: "agenda.get", kind: "query", summary: "One agenda item with its state, owner, deferral and outcome link.", args: { itemId: "the agenda item" }, result: "`{ item }`; the same answer for a missing item and one you may not see.",
    run: async (c, a) => { only(a, ["itemId"]); return found("agenda item", await meetingsOf(c).agendaItem(c.principal, str(a, "itemId"))); } },
  { name: "agenda.list", kind: "query", summary: "A project's open agenda items (queued or deferred) in the order a meeting takes them: urgent first, then conflicts, questions, decisions, other topics and improvement proposals. Needs `meeting.read`.", args: { projectId: "the project", "after?": "the `next` of the previous page", "limit?": "page size, at most 100" }, result: "`{ items, next? }`.",
    run: async (c, a) => { only(a, ["projectId", "after", "limit"]); const r = await meetingsOf(c).openAgenda(c.principal, str(a, "projectId"), { limit: limitOf(a), ...(optStr(a, "after") === undefined ? {} : { afterId: optStr(a, "after") as string }) }); return r === undefined ? asJson({ items: [] }) : page(r); } },
];

export const OPERATION_BY_NAME: ReadonlyMap<string, Operation> = new Map(OPERATIONS.map((o) => [o.name, o]));
void rest;
