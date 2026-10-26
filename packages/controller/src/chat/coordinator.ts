import { DomainError } from "../domain/errors.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { ProjectService } from "../domain/service.js";
import type { RetrievalService, SourceRef } from "../context/retrieval.js";
import type { InquiryService } from "../inquiries/index.js";
import type { AssignmentService } from "../domain/assignments.js";
import type { StateApi } from "../api/state-api.js";
import { API_VERSION } from "../api/state-api.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import type { ChatService, ChatStep } from "./chat.js";
import { describe } from "./commands.js";
import { CHAT_LIMITS } from "./interpreter.js";

/** What the coordinator's model is asked. The model call is behind this interface (scripted in tests); its answer is validated here and never acted on directly. */
export type CoordinatorRequest =
  | { readonly kind: "answer"; readonly question: string; readonly records: readonly { readonly source: SourceRef; readonly title?: string; readonly snippet: string }[] }
  | { readonly kind: "assign"; readonly project: { readonly id: string; readonly name: string }; readonly tasks: readonly { readonly id: string; readonly title: string; readonly repositoryId?: string }[]; /** The active agents the model may pick from. */ readonly agents?: readonly { readonly id: string; readonly name: string; readonly roles: readonly string[] }[] }
  | { readonly kind: "decompose"; readonly outcome: string; readonly project: { readonly id: string; readonly name: string; readonly repositories: readonly string[] } };

export interface CoordinatorModel {
  /** `route` is the provider route to use (the primary first, then the fallbacks in the order the owner listed them). */
  respond(route: string, request: CoordinatorRequest): Promise<unknown>;
}

export type CoordinatorState = "running" | "paused" | "stopped";

export interface CoordinatorBody {
  /** The coordinator's own principal: an agent with its own grants, which decide what it may do (it holds nothing by being the coordinator). */
  readonly principalId: string;
  /** Provider routes in the order to try: the primary, then the fallbacks. */
  readonly routes: readonly string[];
  readonly state: CoordinatorState;
  readonly createdAt: string;
}

export type Answer =
  | { readonly kind: "answer"; readonly text: string; readonly cites: readonly SourceRef[] }
  | { readonly kind: "asked"; readonly inquiryId: string; readonly to: string; readonly replayed: boolean }
  | { readonly kind: "insufficient"; readonly note: string }
  | { readonly kind: "unavailable"; readonly reason: string };

export interface Decomposition { readonly proposalId: string; readonly tasks: number; readonly assignments: "by-coordinator" | "by-owner" | "none"; readonly notes: readonly string[]; readonly replayed: boolean }

export const COORDINATOR_ID = "coordinator:main";
/** The most routes tried for one question: the same bound as the provider fallback (card R02). */
const MAX_ROUTES = 4;
const KEY = /^[a-z0-9][a-z0-9-]{0,29}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const isObject = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v);
const asJson = (value: unknown): JsonObject => JSON.parse(JSON.stringify(value)) as JsonObject;

export interface CoordinatorDeps {
  readonly chat: ChatService;
  readonly retrieval: RetrievalService;
  readonly inquiries: InquiryService;
  readonly projects: ProjectService;
  readonly assignments: AssignmentService;
  /** The state API and the coordinator's own credential, for the assignments it makes itself when it holds the grant. */
  readonly api?: Pick<StateApi, "handle">;
  readonly token?: () => Promise<string | undefined>;
  readonly model: CoordinatorModel;
  /** Where the routes come from, read at each question (the routing table, card U03b). Absent: the routes stored with the coordinator. */
  readonly routes?: () => Promise<readonly string[]> | readonly string[];
  /** The active agents the coordinator may assign to, shown to the model. Absent: none are shown, so no assignment is proposed. */
  readonly agents?: () => Promise<readonly { readonly id: string; readonly name: string; readonly roles: readonly string[] }[]>;
  /** The coordinator's own authenticated principal (the controller holds its credential). */
  readonly principal: () => Promise<Principal>;
}

/**
 * The persistent coordinator (card U03): a controller-managed agent record with its own principal (so its own grants), a list of provider routes (primary and fallbacks) and lifecycle controls
 * (running, paused, stopped) that only the owner uses. It answers questions from records, and asks an inquiry only when records do not answer; it breaks an outcome into tasks with dependencies
 * and saves that as a proposal. It cannot change a record itself: it has no way in except the state API under its own grants, and nothing it drafts is admitted until the owner applies it.
 * Assignments in a plan are run by the coordinator only if its own principal holds `assignment.manage` for the project; otherwise they are steps the owner's apply runs.
 *
 * The controller does not depend on it: when the coordinator is paused, stopped or every route fails, `answer` and `decompose` say `unavailable` and nothing else in the controller (the API, proposals,
 * the owner's chat commands) is affected.
 */
export class CoordinatorService {
  readonly #runner: CommandRunner;
  readonly #deps: CoordinatorDeps;

  private constructor(runner: CommandRunner, deps: CoordinatorDeps) {
    this.#runner = runner;
    this.#deps = deps;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: CoordinatorDeps, options: RunnerOptions = {}): CoordinatorService {
    return new CoordinatorService(new CommandRunner(storage, epoch, options), deps);
  }

  /** Sets up the coordinator (no `expectedRevision`) or changes its principal and routes (with the revision read). It starts `paused`: the owner starts it. */
  async configure(owner: Principal, command: { commandId: string; principalId: string; routes: readonly string[]; expectedRevision?: number }): Promise<{ id: string; revision: number; replayed: boolean }> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "principalId", "routes", "expectedRevision"]);
    if (typeof command.principalId !== "string" || !/^agent:[a-z0-9][a-z0-9-]{0,39}$/.test(command.principalId)) invalid("principalId", "must be an agent principal ID such as agent:coordinator");
    if (!Array.isArray(command.routes) || command.routes.length < 1 || command.routes.length > CHAT_LIMITS.routes || command.routes.some((r) => typeof r !== "string" || r.length < 1 || r.length > 80)) invalid("routes", `must be 1 to ${CHAT_LIMITS.routes} route names (the primary first)`);
    const routes = [...new Set(command.routes)];
    return this.#runner.command("coordinator.configure", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: asJson({ principalId: command.principalId, routes, expectedRevision: command.expectedRevision ?? null }),
      build: async () => {
        const ref: AggregateRef = { kind: "coordinator", id: COORDINATOR_ID };
        const current = await this.#runner.get("coordinator", COORDINATOR_ID);
        if (current === undefined) {
          if (command.expectedRevision !== undefined) throw new DomainError("not_found", "the coordinator is not set up");
          const body: CoordinatorBody = { principalId: command.principalId, routes, state: "paused", createdAt: this.#runner.now() };
          return { ref, creates: true, changes: [{ type: "create", ref, body: asJson(body) }], detail: { principalId: command.principalId } };
        }
        if (command.expectedRevision !== current.revision) throw new DomainError("stale_revision", `the coordinator is at revision ${current.revision}`, { currentRevision: current.revision });
        const next: CoordinatorBody = { ...(current.body as unknown as CoordinatorBody), principalId: command.principalId, routes };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: asJson(next) }], detail: { principalId: command.principalId } };
      },
    }));
  }

  /** Start (`running`), `paused` or `stopped`. A stopped coordinator can only be started again. */
  async setState(owner: Principal, command: { commandId: string; expectedRevision: number; to: CoordinatorState }): Promise<{ id: string; revision: number; replayed: boolean }> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "expectedRevision", "to"]);
    if (command.to !== "running" && command.to !== "paused" && command.to !== "stopped") invalid("to", "must be running, paused or stopped");
    return this.#runner.command("coordinator.state", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { expectedRevision: command.expectedRevision, to: command.to },
      build: async () => {
        const current = await this.#runner.existing("coordinator", COORDINATOR_ID, command.expectedRevision);
        const body = current.body as unknown as CoordinatorBody;
        if (body.state === "stopped" && command.to === "paused") throw new DomainError("invalid_command", "a stopped coordinator can only be started", { field: "to" });
        const ref: AggregateRef = { kind: "coordinator", id: COORDINATOR_ID };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: asJson({ ...body, state: command.to }) }], detail: { from: body.state, to: command.to } };
      },
    }));
  }

  async get(owner: Principal): Promise<(CoordinatorBody & { id: string; revision: number }) | undefined> {
    this.#requireOwner(owner);
    const found = await this.#runner.get("coordinator", COORDINATOR_ID);
    return found === undefined ? undefined : view<CoordinatorBody>(found);
  }

  /**
   * Answers from the project's records. The model sees only the records the owner may read and must cite them; an answer that cites nothing it was shown is not an answer. When records do not
   * answer and a task is named, an inquiry to the owner is opened (once per command ID); with no task there is nowhere to ask, and the owner is told the records are not enough.
   */
  async answer(owner: Principal, command: { commandId: string; projectId: string; question: string; taskId?: string; to?: string }): Promise<Answer> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "projectId", "question", "taskId", "to"]);
    if (command.to !== undefined && (typeof command.to !== "string" || !/^agent:[a-z0-9][a-z0-9-]{0,39}$/.test(command.to))) invalid("to", "must be an agent principal ID");
    const projectId = checkProjectId(command.projectId);
    if (typeof command.question !== "string" || command.question.length < 1 || command.question.length > CHAT_LIMITS.question) invalid("question", `must be text of 1 to ${CHAT_LIMITS.question} characters`);
    if (redactText(command.question) !== command.question) invalid("question", "looks like a credential or key");
    const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
    const state = await this.#usable();
    if (state.kind === "unavailable") return state;
    const found = await this.#deps.retrieval.search(owner, { projectId, query: command.question, limit: 5 });
    if (found.hits.length > 0) {
      const request: CoordinatorRequest = { kind: "answer", question: command.question, records: found.hits.map((h) => ({ source: h.source, ...(h.title === undefined ? {} : { title: h.title }), snippet: h.snippet })) };
      const reply = await this.#ask(state.body, request);
      if (reply === undefined) return { kind: "unavailable", reason: "the coordinator could not be reached on any route" };
      const checked = checkAnswer(reply, found.hits.map((h) => h.source));
      if (checked !== undefined) return checked;
    }
    if (taskId === undefined) return { kind: "insufficient", note: "The records do not answer this, and no task was named to ask about." };
    // Ask whoever can answer: the agent named, else the task's own assignee; never the coordinator itself, and not the owner (who gave direction, not detail).
    const coordinator = state.principal;
    const assignment = command.to === undefined ? await this.#deps.assignments.getAssignment(taskId) : undefined;
    const to = command.to ?? (assignment?.state === "assigned" && assignment.owner?.kind === "agent" ? `agent:${assignment.owner.id}` : undefined);
    if (to === undefined || to === coordinator.id) return { kind: "insufficient", note: "The records do not answer this, and there is no agent named or assigned to the task who could." };
    const asked = await this.#deps.inquiries.ask(coordinator, { commandId: `coord-${scopedCommandId(owner.id, command.commandId).slice(-40)}`, taskId, to, question: command.question });
    return { kind: "asked", inquiryId: asked.id, to, replayed: asked.replayed };
  }

  /** Breaks an outcome into tasks with dependencies, saved as a proposal. Nothing exists until the owner applies it. */
  async decompose(owner: Principal, command: { commandId: string; projectId: string; outcome: string }): Promise<Decomposition | { kind: "unavailable"; reason: string }> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "projectId", "outcome"]);
    const projectId = checkProjectId(command.projectId);
    if (typeof command.outcome !== "string" || command.outcome.length < 1 || command.outcome.length > CHAT_LIMITS.text) invalid("outcome", `must be text of 1 to ${CHAT_LIMITS.text} characters`);
    if (redactText(command.outcome) !== command.outcome) invalid("outcome", "looks like a credential or key");
    const state = await this.#usable();
    if (state.kind === "unavailable") return state;
    const project = await this.#deps.projects.getProject(projectId);
    if (project === undefined) throw new DomainError("not_found", "no such project");
    if (project.state !== "active") throw new DomainError("invalid_command", "the project is archived", { field: "projectId" });
    const repositories = project.repositories.map((r) => r.id);
    const reply = await this.#ask(state.body, { kind: "decompose", outcome: command.outcome, project: { id: projectId, name: project.name, repositories } });
    if (reply === undefined) return { kind: "unavailable", reason: "the coordinator could not be reached on any route" };
    const plan = checkPlan(reply, repositories);

    const coordinator = state.principal;
    const delegated = allows(coordinator, "assignment.manage", projectId);
    const steps: Omit<ChatStep, "commandId">[] = [];
    const notes: string[] = [];
    const only = repositories.length === 1 ? repositories[0] : undefined;
    const repoOf = new Map<string, string | undefined>();
    for (const t of plan) {
      const repositoryId = t.repositoryId ?? only;
      repoOf.set(t.key, repositoryId);
      steps.push({ op: "task.create", key: t.key, args: { projectId, title: t.title, ...(t.description === undefined ? {} : { description: t.description }), ...(repositoryId === undefined ? {} : { repositoryId }) } });
    }
    for (const t of plan) for (const d of t.dependsOn) steps.push({ op: "dependency.add", args: { taskId: { $ref: t.key }, prerequisiteId: { $ref: d } } });
    let assigned = 0;
    for (const t of plan) {
      if (t.assignTo === undefined) continue;
      // Work handed to someone carries its project and repository; without one there is nothing to dispatch.
      if (repoOf.get(t.key) === undefined) { notes.push(`"${t.title}" is not assigned: no repository was chosen for it`); continue; }
      steps.push({ op: "task.assign", args: { taskId: { $ref: t.key }, owner: t.assignTo, reason: "assigned by the coordinator's plan" }, as: delegated ? "coordinator" : "owner" });
      assigned++;
    }
    const preview = steps.map((s) => describe(s.op, s.args, {}));
    const saved = await this.#deps.chat.propose(owner, { commandId: command.commandId, source: "coordinator", reason: "a plan drafted by the coordinator", preview, steps, notes });
    return { proposalId: saved.id, tasks: plan.length, assignments: assigned === 0 ? "none" : delegated ? "by-coordinator" : "by-owner", notes, replayed: saved.replayed };
  }

  /**
   * Hands unassigned tasks of a project to agents. The model picks (from the tasks shown, each with its repository); a task with no repository is not assigned. A coordinator that holds
   * `assignment.manage` for the project makes the assignments itself under its own credential, each with the reason recorded; without the grant they are saved as a proposal for the owner.
   * Only assignments are made without the owner's apply: a plan with anything else in it (task creation, dependencies) waits for the owner.
   */
  async assign(owner: Principal, command: { commandId: string; projectId: string }): Promise<{ kind: "unavailable"; reason: string } | { kind: "made"; assigned: { taskId: string; owner: string; reason: string }[]; skipped: string[] } | { kind: "proposed"; proposalId: string; skipped: string[] }> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "projectId"]);
    const projectId = checkProjectId(command.projectId);
    const state = await this.#usable();
    if (state.kind === "unavailable") return state;
    const all = (await this.#deps.projects.listTasks({ projectId, limit: 100 })).items.filter((t) => t.state === "proposed" || t.state === "ready");
    const open: { id: string; title: string; repositoryId?: string }[] = [];
    for (const t of all) if ((await this.#deps.assignments.getAssignment(t.id)) === undefined) open.push({ id: t.id, title: t.title, ...(t.repositoryId === undefined ? {} : { repositoryId: t.repositoryId }) });
    const project = await this.#deps.projects.getProject(projectId);
    if (project === undefined) throw new DomainError("not_found", "no such project");
    const reply = await this.#ask(state.body, { kind: "assign", project: { id: projectId, name: project.name }, tasks: open, agents: await this.#agents() });
    if (reply === undefined) return { kind: "unavailable", reason: "the coordinator could not be reached on any route" };
    const picks = checkAssignments(reply, open);
    const skipped = picks.filter((p) => open.find((t) => t.id === p.taskId)?.repositoryId === undefined).map((p) => `${p.taskId}: no repository`);
    const usable = picks.filter((p) => open.find((t) => t.id === p.taskId)?.repositoryId !== undefined);
    const coordinator = state.principal;
    const token = await this.#deps.token?.();
    if (usable.length === 0) return { kind: "made", assigned: [], skipped };
    if (allows(coordinator, "assignment.manage", projectId) && token !== undefined && this.#deps.api !== undefined) {
      const assigned: { taskId: string; owner: string; reason: string }[] = [];
      for (const p of usable) {
        const r = await this.#deps.api.handle(token, { v: API_VERSION, op: "task.assign", commandId: `coord-assign-${scopedCommandId(owner.id, command.commandId).slice(-40)}-${p.taskId}`, args: { taskId: p.taskId, owner: p.owner, reason: p.reason } });
        if (r.ok) assigned.push({ taskId: p.taskId, owner: `${p.owner.kind}:${p.owner.id}`, reason: p.reason }); else skipped.push(`${p.taskId}: ${r.error.code}`);
      }
      return { kind: "made", assigned, skipped };
    }
    const steps: Omit<ChatStep, "commandId">[] = usable.map((p) => ({ op: "task.assign", args: { taskId: p.taskId, owner: p.owner, reason: p.reason } }));
    const pins = usable.map((p) => ({ taskId: p.taskId, projectId, repositoryId: open.find((t) => t.id === p.taskId)?.repositoryId as string }));
    const saved = await this.#deps.chat.propose(owner, { commandId: command.commandId, source: "coordinator", reason: "assignments the coordinator may not make itself", preview: steps.map((x) => describe(x.op, x.args, {})), steps, pins, notes: skipped });
    return { kind: "proposed", proposalId: saved.id, skipped };
  }

  // ---- internals -------------------------------------------------------------------------------------------------------------

  async #agents(): Promise<readonly { id: string; name: string; roles: readonly string[] }[]> {
    try { return (await this.#deps.agents?.()) ?? []; } catch { return []; }
  }

  #requireOwner(owner: Principal): void {
    if (owner.kind !== "owner" || owner.taskScope !== undefined) throw new DomainError("forbidden", "only the owner uses the coordinator");
  }

  async #usable(): Promise<{ kind: "ok"; body: CoordinatorBody; principal: Principal } | { kind: "unavailable"; reason: string }> {
    const found = await this.#runner.get("coordinator", COORDINATOR_ID);
    if (found === undefined) return { kind: "unavailable", reason: "the coordinator is not set up" };
    const body = found.body as unknown as CoordinatorBody;
    // The credential the controller holds must be the principal the owner configured; otherwise the coordinator would act with someone else's grants.
    // A credential that is missing or no longer valid makes the coordinator unavailable; it is never an error for the caller.
    const principal = await this.#deps.principal().then((p) => p, () => undefined);
    const held = principal?.id;
    if (principal === undefined || held === undefined) return { kind: "unavailable", reason: "the coordinator has no valid credential" };
    if (held !== body.principalId) return { kind: "unavailable", reason: "the coordinator's credential is not the configured principal" };
    return body.state === "running" ? { kind: "ok", body, principal } : { kind: "unavailable", reason: `the coordinator is ${body.state}` };
  }

  /** The primary route, then the fallbacks in order, at most four tries; the first usable reply wins and none is a refusal to answer, not an error. */
  async #ask(body: CoordinatorBody, request: CoordinatorRequest): Promise<unknown> {
    const routes = this.#deps.routes === undefined ? body.routes : await this.#deps.routes();
    for (const route of routes.slice(0, MAX_ROUTES)) {
      try { return await this.#deps.model.respond(route, request); } catch { /* try the next route */ }
    }
    return undefined;
  }
}

/** An answer is usable only if it has text and cites at least one record it was shown, and only those. */
function checkAnswer(reply: unknown, shown: readonly SourceRef[]): Answer | undefined {
  if (!isObject(reply) || reply["kind"] !== "answer" || typeof reply["text"] !== "string" || reply["text"].length === 0 || reply["text"].length > 4000 || !Array.isArray(reply["cites"]) || reply["cites"].length === 0) return undefined;
  const wanted = new Set(shown.map((s) => JSON.stringify(s)));
  const cites = reply["cites"] as SourceRef[];
  if (!cites.every((c) => wanted.has(JSON.stringify(c)))) return undefined;
  return { kind: "answer", text: redactText(reply["text"]), cites };
}

interface PlannedTask { readonly key: string; readonly title: string; readonly description?: string; readonly dependsOn: readonly string[]; readonly repositoryId?: string; readonly assignTo?: { kind: string; id: string } }

/** The decomposition the model proposed, checked: bounded, unique keys, known dependencies, no cycle, repositories that exist. A plan that fails is refused whole. */
function checkPlan(reply: unknown, repositories: readonly string[]): PlannedTask[] {
  if (!isObject(reply) || !Array.isArray(reply["tasks"]) || reply["tasks"].length < 1 || reply["tasks"].length > CHAT_LIMITS.planTasks) return invalid("plan.tasks", `must be 1 to ${CHAT_LIMITS.planTasks} tasks`);
  const tasks = reply["tasks"].map((raw: unknown, i): PlannedTask => {
    const f = `plan.tasks[${i}]`;
    if (!isObject(raw)) return invalid(f, "must be an object");
    for (const k of Object.keys(raw)) if (!["key", "title", "description", "dependsOn", "repositoryId", "assignTo"].includes(k)) invalid(`${f}.${k}`, "is not a field of a planned task");
    const key = typeof raw["key"] === "string" && KEY.test(raw["key"]) ? raw["key"] : invalid(`${f}.key`, "must be a short lowercase key");
    const title = typeof raw["title"] === "string" && raw["title"].length >= 1 && raw["title"].length <= 200 ? raw["title"] : invalid(`${f}.title`, "must be text of 1 to 200 characters");
    const description = raw["description"] === undefined ? undefined : (typeof raw["description"] === "string" && raw["description"].length <= 8000 ? raw["description"] : invalid(`${f}.description`, "must be text"));
    const dependsOn = raw["dependsOn"] === undefined ? [] : (Array.isArray(raw["dependsOn"]) && raw["dependsOn"].length <= CHAT_LIMITS.planTasks && raw["dependsOn"].every((d) => typeof d === "string") ? raw["dependsOn"] as string[] : invalid(`${f}.dependsOn`, "must be a list of keys"));
    const repositoryId = raw["repositoryId"] === undefined ? undefined : (typeof raw["repositoryId"] === "string" && repositories.includes(raw["repositoryId"]) ? raw["repositoryId"] : invalid(`${f}.repositoryId`, "must be a repository of the project"));
    let assignTo: { kind: string; id: string } | undefined;
    if (raw["assignTo"] !== undefined) {
      const a = raw["assignTo"];
      if (!isObject(a) || typeof a["kind"] !== "string" || typeof a["id"] !== "string" || Object.keys(a).length !== 2) invalid(`${f}.assignTo`, "must be { kind, id }");
      assignTo = { kind: (a as { kind: string }).kind, id: (a as { id: string }).id };
    }
    return { key, title, ...(description === undefined ? {} : { description }), dependsOn, ...(repositoryId === undefined ? {} : { repositoryId }), ...(assignTo === undefined ? {} : { assignTo }) };
  });
  const keys = new Set(tasks.map((t) => t.key));
  if (keys.size !== tasks.length) invalid("plan.tasks", "keys must be unique");
  for (const t of tasks) for (const d of t.dependsOn) if (!keys.has(d) || d === t.key) invalid("plan.tasks", `${t.key} depends on ${d}, which is not another task of the plan`);
  // Kahn's algorithm: whatever cannot be ordered is in a cycle.
  const remaining = new Map(tasks.map((t) => [t.key, new Set(t.dependsOn)]));
  for (let progressed = true; progressed && remaining.size > 0;) {
    progressed = false;
    for (const [key, deps] of remaining) if (deps.size === 0) { remaining.delete(key); for (const other of remaining.values()) other.delete(key); progressed = true; }
  }
  if (remaining.size > 0) invalid("plan.tasks", `tasks wait for each other in a ring: ${[...remaining.keys()].join(", ")}`);
  return tasks;
}

/** The model's picks, checked: only tasks it was shown, once each, to an agent, with a reason. */
function checkAssignments(reply: unknown, shown: readonly { id: string }[]): { taskId: string; owner: { kind: "agent"; id: string }; reason: string }[] {
  if (!isObject(reply) || !Array.isArray(reply["assignments"]) || reply["assignments"].length > CHAT_LIMITS.planTasks) return invalid("assignments", `must be a list of at most ${CHAT_LIMITS.planTasks}`);
  const seen = new Set<string>();
  return reply["assignments"].map((raw: unknown, i) => {
    const f = `assignments[${i}]`;
    if (!isObject(raw) || Object.keys(raw).some((k) => !["taskId", "owner", "reason"].includes(k))) return invalid(f, "must be { taskId, owner, reason }");
    const taskId = typeof raw["taskId"] === "string" && shown.some((t) => t.id === raw["taskId"]) && !seen.has(raw["taskId"]) ? raw["taskId"] : invalid(`${f}.taskId`, "must be one of the tasks shown, once");
    seen.add(taskId);
    const o = raw["owner"];
    if (!isObject(o) || o["kind"] !== "agent" || typeof o["id"] !== "string" || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(o["id"]) || Object.keys(o).length !== 2) return invalid(`${f}.owner`, "must be { kind: agent, id }");
    const reason = typeof raw["reason"] === "string" && raw["reason"].length >= 1 && raw["reason"].length <= 500 ? redactText(raw["reason"]) : invalid(`${f}.reason`, "must be text");
    return { taskId, owner: { kind: "agent" as const, id: o["id"] }, reason };
  });
}
