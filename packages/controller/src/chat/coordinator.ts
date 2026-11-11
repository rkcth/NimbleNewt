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
import { quoted as quotedText } from "../status/explain.js";
import { describe } from "./commands.js";
import { CHAT_LIMITS } from "./interpreter.js";
import type { AgentLifecyclePort, HostedLook, HostedState } from "./coordinator-host.js";

/** What the coordinator's model is asked. The model call is behind this interface (scripted in tests); its answer is validated here and never acted on directly. */
export type CoordinatorRequest =
  | { readonly kind: "answer"; readonly question: string; readonly records: readonly { readonly source: SourceRef; readonly title?: string; readonly snippet: string }[] }
  | { readonly kind: "assign"; readonly project: { readonly id: string; readonly name: string }; readonly tasks: readonly { readonly id: string; readonly title: string; readonly repositoryId?: string }[]; /** The active agents the model may pick from. */ readonly agents?: readonly { readonly id: string; readonly name: string; readonly roles: readonly string[] }[] }
  | { readonly kind: "decompose"; readonly outcome: string; readonly project: { readonly id: string; readonly name: string; readonly repositories: readonly string[] } };

export interface CoordinatorModel {
  /** `route` is the provider route to use (the primary first, then the fallbacks in the order the owner listed them). `meter`, when the model can count, is told the provider's token count of the call. */
  respond(route: string, request: CoordinatorRequest, meter?: (tokens: { readonly inputTokens: number; readonly outputTokens: number }) => void): Promise<unknown>;
}

export type CoordinatorState = "running" | "paused" | "stopped";

/** What the owner is told the coordinator is doing: the three it always had, and for a hosted one what the agent controls report besides. */
export type CoordinatorLifecycleState = CoordinatorState | HostedState | "unknown";

export interface CoordinatorBody {
  /** The coordinator's own principal: an agent with its own grants, which decide what it may do (it holds nothing by being the coordinator). */
  readonly principalId: string;
  /**
   * Set when the principal is an agent record (card U03c): the coordinator then runs as that agent, on the controller's own host, and its lifecycle is the agent's (the pause gates of its agent scope and of the scopes above it, and a
   * Stop). `state` is then only what the owner last ordered; what decides is the agent's gates. Absent: the controller holds the coordinator's state itself, as before.
   */
  readonly hosted?: { readonly agentId: string; readonly host: "controller" };
  /**
   * Provider routes in the order to try: the primary, then the fallbacks. For a hosted coordinator set up without routes this is empty and the routes come from the agent's profile (card U03d). The precedence for a hosted
   * coordinator, first one that gives a route wins: (1) `routes` the owner stated when setting it up (`explicitRoutes`), used as stated; (2) the routes the routing table gives the agent's `defaultProfile`; (3) the routes of the
   * coordinator role (`CoordinatorDeps.routes`, the routing table); (4) `routes` stored with a record made before U03d. A coordinator that is not hosted: `CoordinatorDeps.routes` if there is one, else `routes`, as before.
   */
  readonly routes: readonly string[];
  /** A hosted coordinator whose owner stated routes when setting it up: they override the agent's profile. Absent on records made before U03d, whose stored routes stay the last resort. */
  readonly explicitRoutes?: boolean;
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
  /** The agent controls (pause gates and Stop) a coordinator that is an agent record runs under (card U03c). Absent: a coordinator is never hosted; its state is its own. */
  readonly lifecycle?: AgentLifecyclePort;
  /** The routes the routing table gives a profile (card U03d), for a hosted coordinator whose agent has a `defaultProfile`. Absent: the profile is not read. */
  readonly profileRoutes?: (profile: string) => Promise<readonly string[]> | readonly string[];
  /** Of the routes the owner stated for a hosted coordinator, those the routing table lets it use, in the owner's order (as the coordinator role's own routes are judged). Absent: they are used as stated. */
  readonly eligibleRoutes?: (routes: readonly string[]) => Promise<readonly string[]> | readonly string[];
  /** Records a hosted coordinator's model call against its agent's budget (card U03d): usage by agent, as any agent's calls are. It records and never refuses; a failure to record is told to `onAttributionFailure` and changes nothing. */
  readonly attribute?: (by: Principal, principalId: string, use: CoordinatorUse) => Promise<void>;
  readonly onAttributionFailure?: (error: unknown) => void;
}

/** Where a hosted coordinator's routes come from now (see `CoordinatorBody.routes`). */
export type RouteSource = "owner" | "profile" | "role" | "stored";

/** The coordinator as the owner reads it: its record, and for a hosted one the lifecycle the agent controls report (`state` is `unknown` when they cannot be read: it is not claimed to be stopped). */
export type CoordinatorView = Omit<CoordinatorBody, "state"> & { readonly id: string; readonly revision: number; readonly state: CoordinatorLifecycleState; readonly lifecycle?: HostedLook; /** Hosted only: where the routes come from now, and the profile when it is the agent's. */ readonly routeSource?: RouteSource; readonly profile?: string };

/** What one model call of a hosted coordinator used, for the agent's budget: wall time of the call and the provider's own token count when it gave one. */
export interface CoordinatorUse { readonly route: string; readonly computeMs: number; readonly inputTokens?: number; readonly outputTokens?: number; readonly projectId?: string }

const AGENT_RECORD = /^agent:(agt-[a-z2-7]{20})$/;

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
  async configure(owner: Principal, command: { commandId: string; principalId: string; routes?: readonly string[]; expectedRevision?: number }): Promise<{ id: string; revision: number; replayed: boolean }> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "principalId", "routes", "expectedRevision"]);
    if (typeof command.principalId !== "string" || !/^agent:[a-z0-9][a-z0-9-]{0,39}$/.test(command.principalId)) invalid("principalId", "must be an agent principal ID such as agent:coordinator");
    // An agent record as the principal makes the coordinator a hosted agent (card U03c): it must be an active agent, and it starts under a pause of its own agent scope unless the coordinator was already running.
    const hostedId = this.#deps.lifecycle === undefined ? undefined : AGENT_RECORD.exec(command.principalId)?.[1];
    // Routes are stated for a coordinator that is not hosted; a hosted one may leave them to its agent's profile (card U03d).
    if (command.routes === undefined && hostedId === undefined) invalid("routes", `must be 1 to ${CHAT_LIMITS.routes} route names (the primary first); only a coordinator that is an agent record may leave them to the agent's profile`);
    if (command.routes !== undefined && (!Array.isArray(command.routes) || command.routes.length < 1 || command.routes.length > CHAT_LIMITS.routes || command.routes.some((r) => typeof r !== "string" || r.length < 1 || r.length > 80))) invalid("routes", `must be 1 to ${CHAT_LIMITS.routes} route names (the primary first)`);
    const routes = command.routes === undefined ? [] : [...new Set(command.routes)];
    const before = await this.#runner.get("coordinator", COORDINATOR_ID);
    let ours: string | undefined;
    if (hostedId !== undefined) {
      const look = await this.#deps.lifecycle!.look(owner, hostedId);
      if (look.agent !== "active") invalid("principalId", look.agent === "retired" ? "that agent is retired" : "no such agent");
      const was = before === undefined ? undefined : (before.body as unknown as CoordinatorBody);
      const newlyHosted = was?.hosted?.agentId !== hostedId;
      const wouldApply = before === undefined ? command.expectedRevision === undefined : command.expectedRevision === before.revision;
      // The pause comes first, so the record never exists with the agent free to be used before the owner starts it. Repeating the command repeats the same pause by its command ID.
      if (newlyHosted && wouldApply && (was === undefined || was.hosted !== undefined || was.state !== "running")) ours = (await this.#deps.lifecycle!.pause(owner, hostedId, `coord-host-${command.commandId}`.slice(0, 120), "the coordinator is set up as this agent and waits for the owner to start it")).requestId;
    }
    try {
      return await this.#configured(owner, command, routes, hostedId);
    } catch (error) {
      // A set-up refused after its pause (a concurrent change took the record meanwhile) must not leave the agent paused for a coordinator that does not exist: the pause this call made is taken back, and only that pause (card U03d).
      // But when the record now hosts this very agent (the owner's concurrent set-up of the same agent, which found it paused and made no pause of its own, or this call's own write that landed before the error),
      // that pause is what keeps the coordinator from running before the owner starts it, and it stays. A record that cannot be read is treated the same way: the pause stays, and the refusal says so.
      const now = ours === undefined ? undefined : await this.#runner.get("coordinator", COORDINATOR_ID).then((f) => ({ hosts: (f?.body as unknown as CoordinatorBody | undefined)?.hosted?.agentId === hostedId }), () => ({ hosts: undefined }));
      if (ours !== undefined && hostedId !== undefined && now?.hosts !== true) {
        const lifted = now?.hosts === undefined ? undefined : await this.#deps.lifecycle!.undoPause(owner, hostedId, `coord-undo-${command.commandId}`.slice(0, 120), ours, "the coordinator's set-up was refused, so the pause it made is lifted").then((l) => l, () => undefined);
        if (lifted === undefined && error instanceof DomainError) throw new DomainError(error.code, `${error.message} (the pause this set-up made on the agent could not be lifted; resume the agent if it is not wanted)`, { ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }), ...(error.field === undefined ? {} : { field: error.field }) });
      }
      throw error;
    }
  }

  async #configured(owner: Principal, command: { commandId: string; principalId: string; expectedRevision?: number }, routes: readonly string[], hostedId: string | undefined): Promise<{ id: string; revision: number; replayed: boolean }> {
    return this.#runner.command("coordinator.configure", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: asJson({ principalId: command.principalId, routes, expectedRevision: command.expectedRevision ?? null }),
      build: async () => {
        const ref: AggregateRef = { kind: "coordinator", id: COORDINATOR_ID };
        const current = await this.#runner.get("coordinator", COORDINATOR_ID);
        const hosted = hostedId === undefined ? undefined : ({ agentId: hostedId, host: "controller" } as const);
        if (current === undefined) {
          if (command.expectedRevision !== undefined) throw new DomainError("not_found", "the coordinator is not set up");
          const body: CoordinatorBody = { principalId: command.principalId, routes, state: "paused", createdAt: this.#runner.now(), ...(hosted === undefined ? {} : { hosted }), ...(hosted !== undefined && routes.length > 0 ? { explicitRoutes: true } : {}) };
          return { ref, creates: true, changes: [{ type: "create", ref, body: asJson(body) }], detail: { principalId: command.principalId, hosted: hosted !== undefined } };
        }
        if (command.expectedRevision !== current.revision) throw new DomainError("stale_revision", `the coordinator is at revision ${current.revision}`, { currentRevision: current.revision });
        const old = current.body as unknown as CoordinatorBody;
        const { hosted: _was, explicitRoutes: _explicit, ...rest } = old;
        // A coordinator taken off its agent record has no gates to answer for it: it comes back paused, never as whatever it last was.
        const next: CoordinatorBody = { ...rest, principalId: command.principalId, routes, ...(old.hosted !== undefined && hosted === undefined ? { state: "paused" as const } : {}), ...(hosted === undefined ? {} : { hosted }), ...(hosted !== undefined && routes.length > 0 ? { explicitRoutes: true } : {}) };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: asJson(next) }], detail: { principalId: command.principalId, hosted: hosted !== undefined } };
      },
    }));
  }

  /**
   * Start (`running`), `paused` or `stopped`. A stopped coordinator can only be started again.
   * A hosted coordinator (card U03c) is started, paused and stopped through the agent controls: the pause gate of its agent scope is lifted or set, and a Stop is asked of the stop service, exactly as the owner would for any agent.
   * The record keeps what the owner ordered (and its revision moves, so the order is audited and a stale order is refused); what the coordinator is doing is read from the gates. Starting it lifts only its own gate:
   * a team or the installation that is paused still holds it, and the answer says so (`stillHeldBy`).
   */
  async setState(owner: Principal, command: { commandId: string; expectedRevision: number; to: CoordinatorState }): Promise<{ id: string; revision: number; replayed: boolean; stillHeldBy?: readonly string[] }> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "expectedRevision", "to"]);
    if (command.to !== "running" && command.to !== "paused" && command.to !== "stopped") invalid("to", "must be running, paused or stopped");
    const before = await this.#runner.get("coordinator", COORDINATOR_ID);
    const hosted = before === undefined ? undefined : (before.body as unknown as CoordinatorBody).hosted;
    let held: readonly string[] | undefined;
    // The agent controls are used only for an order that would be accepted, and each repeats safely by its command ID.
    if (hosted !== undefined && before!.revision === command.expectedRevision && this.#deps.lifecycle !== undefined) {
      const port = this.#deps.lifecycle;
      const look = await port.look(owner, hosted.agentId);
      if (look.agent !== "active") throw new DomainError("invalid_command", "the coordinator's agent is retired", { field: "to" });
      if (look.state === "stopped" && command.to === "paused") throw new DomainError("invalid_command", "a stopped coordinator can only be started", { field: "to" });
      const id = `coord-${scopedCommandId(owner.id, command.commandId).slice(-60)}`;
      if (command.to === "running") held = (await port.resume(owner, hosted.agentId, id, "the owner started the coordinator")).stillHeldBy.map((s) => `${s.kind} ${s.id}`);
      else if (command.to === "paused") { await port.pause(owner, hosted.agentId, id, "the owner paused the coordinator"); await this.#reportIfIdle(owner, hosted.agentId); }
      else await port.stop(owner, hosted.agentId, id, "the owner stopped the coordinator");
    }
    const done = await this.#runner.command("coordinator.state", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { expectedRevision: command.expectedRevision, to: command.to },
      build: async () => {
        const current = await this.#runner.existing("coordinator", COORDINATOR_ID, command.expectedRevision);
        const body = current.body as unknown as CoordinatorBody;
        // A hosted coordinator was checked against its agent's gates before they were touched; the order recorded last is not what decides (the agent may have been started through its own controls since).
        if (body.hosted === undefined && body.state === "stopped" && command.to === "paused") throw new DomainError("invalid_command", "a stopped coordinator can only be started", { field: "to" });
        const ref: AggregateRef = { kind: "coordinator", id: COORDINATOR_ID };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: asJson({ ...body, state: command.to }) }], detail: { from: body.state, to: command.to } };
      },
    }));
    return held === undefined || held.length === 0 ? done : { ...done, stillHeldBy: held };
  }

  /**
   * The coordinator as the owner reads it. For a hosted one `state` is what the agent controls say now (running, paused, stopping, suspended or stopped) and `lifecycle` carries the gates that hold it; the order the
   * owner last gave stays in the record's history. A hosted coordinator whose agent record is gone or retired reads as stopped, and one whose agent controls cannot be read reads as `unknown`.
   */
  async get(owner: Principal): Promise<CoordinatorView | undefined> {
    this.#requireOwner(owner);
    const found = await this.#runner.get("coordinator", COORDINATOR_ID);
    if (found === undefined) return undefined;
    const plain = view<CoordinatorBody>(found);
    if (plain.hosted === undefined || this.#deps.lifecycle === undefined) return plain;
    const look = await this.#deps.lifecycle.look(owner, plain.hosted.agentId).then((l) => l, () => undefined);
    // Controls that cannot be read are not a stopped agent: the owner is told the state is unknown (card U03d).
    if (look === undefined) return { ...plain, state: "unknown", ...await this.#sourceOf(plain, undefined) };
    // A pause made directly through the agent's own controls is reported reached by the coordinator when it holds no work (card U03d).
    await this.#reportReached(owner, plain.hosted.agentId, look);
    return { ...plain, state: look.agent !== "active" ? "stopped" : look.state, lifecycle: look, ...await this.#sourceOf(plain, look.profile) };
  }

  async #sourceOf(body: CoordinatorBody, profile: string | undefined): Promise<{ routeSource?: RouteSource; profile?: string }> {
    const r = await this.#routesOf(body, profile);
    return { routeSource: r.source, ...(profile === undefined ? {} : { profile }) };
  }

  /**
   * Answers from the project's records. The model sees only the records the owner may read and must cite them; an answer that cites nothing it was shown is not an answer. When records do not
   * answer and a task is named, an inquiry to the owner is opened (once per command ID); with no task there is nowhere to ask, and the owner is told the records are not enough.
   */
  answer(owner: Principal, command: { commandId: string; projectId: string; question: string; taskId?: string; to?: string }): Promise<Answer> {
    return this.#busy(() => this.#answer(owner, command));
  }

  async #answer(owner: Principal, command: { commandId: string; projectId: string; question: string; taskId?: string; to?: string }): Promise<Answer> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "projectId", "question", "taskId", "to"]);
    if (command.to !== undefined && (typeof command.to !== "string" || !/^agent:[a-z0-9][a-z0-9-]{0,39}$/.test(command.to))) invalid("to", "must be an agent principal ID");
    const projectId = checkProjectId(command.projectId);
    if (typeof command.question !== "string" || command.question.length < 1 || command.question.length > CHAT_LIMITS.question) invalid("question", `must be text of 1 to ${CHAT_LIMITS.question} characters`);
    if (redactText(command.question) !== command.question) invalid("question", "looks like a credential or key");
    const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
    const state = await this.#usable(owner);
    if (state.kind === "unavailable") return state;
    const found = await this.#deps.retrieval.search(owner, { projectId, query: command.question, limit: 5 });
    if (found.hits.length > 0) {
      const request: CoordinatorRequest = { kind: "answer", question: command.question, records: found.hits.map((h) => ({ source: h.source, ...(h.title === undefined ? {} : { title: h.title }), snippet: h.snippet })) };
      const reply = await this.#ask(owner, state, request, projectId);
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
  decompose(owner: Principal, command: { commandId: string; projectId: string; outcome: string }): Promise<Decomposition | { kind: "unavailable"; reason: string }> {
    return this.#busy(() => this.#decompose(owner, command));
  }

  async #decompose(owner: Principal, command: { commandId: string; projectId: string; outcome: string }): Promise<Decomposition | { kind: "unavailable"; reason: string }> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "projectId", "outcome"]);
    const projectId = checkProjectId(command.projectId);
    if (typeof command.outcome !== "string" || command.outcome.length < 1 || command.outcome.length > CHAT_LIMITS.text) invalid("outcome", `must be text of 1 to ${CHAT_LIMITS.text} characters`);
    if (redactText(command.outcome) !== command.outcome) invalid("outcome", "looks like a credential or key");
    const state = await this.#usable(owner);
    if (state.kind === "unavailable") return state;
    const project = await this.#deps.projects.getProject(projectId);
    if (project === undefined) throw new DomainError("not_found", "no such project");
    if (project.state !== "active") throw new DomainError("invalid_command", "the project is archived", { field: "projectId" });
    const repositories = project.repositories.map((r) => r.id);
    const reply = await this.#ask(owner, state, { kind: "decompose", outcome: command.outcome, project: { id: projectId, name: project.name, repositories } }, projectId);
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
      if (repoOf.get(t.key) === undefined) { notes.push(`${quotedText(t.title, 200)} is not assigned: no repository was chosen for it`); continue; }
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
  assign(owner: Principal, command: { commandId: string; projectId: string }): Promise<{ kind: "unavailable"; reason: string } | { kind: "made"; assigned: { taskId: string; owner: string; reason: string }[]; skipped: string[] } | { kind: "proposed"; proposalId: string; skipped: string[] }> {
    return this.#busy(() => this.#assign(owner, command));
  }

  async #assign(owner: Principal, command: { commandId: string; projectId: string }): Promise<{ kind: "unavailable"; reason: string } | { kind: "made"; assigned: { taskId: string; owner: string; reason: string }[]; skipped: string[] } | { kind: "proposed"; proposalId: string; skipped: string[] }> {
    this.#requireOwner(owner);
    onlyKnown(command, ["commandId", "projectId"]);
    const projectId = checkProjectId(command.projectId);
    const state = await this.#usable(owner);
    if (state.kind === "unavailable") return state;
    const all = (await this.#deps.projects.listTasks({ projectId, limit: 100 })).items.filter((t) => t.state === "proposed" || t.state === "ready");
    const open: { id: string; title: string; repositoryId?: string }[] = [];
    for (const t of all) if ((await this.#deps.assignments.getAssignment(t.id)) === undefined) open.push({ id: t.id, title: t.title, ...(t.repositoryId === undefined ? {} : { repositoryId: t.repositoryId }) });
    const project = await this.#deps.projects.getProject(projectId);
    if (project === undefined) throw new DomainError("not_found", "no such project");
    const reply = await this.#ask(owner, state, { kind: "assign", project: { id: projectId, name: project.name }, tasks: open, agents: await this.#agents() }, projectId);
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

  async #usable(owner: Principal): Promise<{ kind: "ok"; body: CoordinatorBody; principal: Principal; profile?: string } | { kind: "unavailable"; reason: string }> {
    const found = await this.#runner.get("coordinator", COORDINATOR_ID);
    if (found === undefined) return { kind: "unavailable", reason: "the coordinator is not set up" };
    const body = found.body as unknown as CoordinatorBody;
    // A hosted coordinator whose agent was retired says so (retiring also disables the identity, which would otherwise read as a missing credential).
    if (body.hosted !== undefined && this.#deps.lifecycle !== undefined && (await this.#deps.lifecycle.look(owner, body.hosted.agentId).then((l) => l.agent, () => undefined)) === "retired") return { kind: "unavailable", reason: "the coordinator's agent is retired" };
    // The credential the controller holds must be the principal the owner configured; otherwise the coordinator would act with someone else's grants.
    // A credential that is missing or no longer valid makes the coordinator unavailable; it is never an error for the caller.
    const principal = await this.#deps.principal().then((p) => p, () => undefined);
    const held = principal?.id;
    if (principal === undefined || held === undefined) return { kind: "unavailable", reason: "the coordinator has no valid credential" };
    if (held !== body.principalId) return { kind: "unavailable", reason: "the coordinator's credential is not the configured principal" };
    if (body.hosted !== undefined) {
      // A hosted coordinator is as available as its agent: the agent record is active and no pause gate on its chain holds it. The same gates pause any agent, so a pause by the owner, a team's pause or the installation's all reach it.
      if (this.#deps.lifecycle === undefined) return { kind: "unavailable", reason: "the coordinator's agent controls are not available" };
      if (body.hosted.agentId !== AGENT_RECORD.exec(body.principalId)?.[1]) return { kind: "unavailable", reason: "the coordinator's agent is not its configured principal" };
      const look = await this.#deps.lifecycle.look(owner, body.hosted.agentId).then((l) => l, () => undefined);
      if (look === undefined) return { kind: "unavailable", reason: "the coordinator's agent controls could not be read" };
      if (look.agent !== "active") return { kind: "unavailable", reason: "the coordinator's agent is retired" };
      if (look.state !== "running") {
        await this.#reportReached(owner, body.hosted.agentId, look);
        const outer = look.heldBy.find((h) => h.scope.kind !== "agent");
        return { kind: "unavailable", reason: `the coordinator is ${look.state}${look.heldBy.every((h) => h.scope.kind !== "agent") && outer !== undefined ? ` (held by ${outer.scope.kind} ${outer.scope.id})` : ""}` };
      }
      return { kind: "ok", body, principal, ...(look.profile === undefined ? {} : { profile: look.profile }) };
    }
    return body.state === "running" ? { kind: "ok", body, principal } : { kind: "unavailable", reason: `the coordinator is ${body.state}` };
  }

  /**
   * Operations in flight (an answer, a draft, an assignment round, from the availability check to its last write), so a pause is reported as reached only when none is: a pause never cuts an operation that has
   * begun (its model call ends and its answer is still the owner's to read, its assignments are made), and the safe boundary is claimed only after it (review: counting only the model call let a pause be reported
   * between the availability check and the call, or before an assignment round made its assignments).
   */
  #inflight = 0;
  #reportWhenIdle: { readonly owner: Principal; readonly agentId: string } | undefined;

  async #reportIfIdle(owner: Principal, agentId: string): Promise<void> {
    if (this.#inflight > 0) { this.#reportWhenIdle = { owner, agentId }; return; }
    this.#reportWhenIdle = undefined;
    await this.#deps.lifecycle?.settled(owner, agentId).catch(() => undefined);
  }

  /** Where the routes come from now and what they are (the precedence is on `CoordinatorBody.routes`). A routing table that cannot be read leaves no route to try: the coordinator is unavailable, never an error for the caller. */
  async #routesOf(body: CoordinatorBody, profile: string | undefined): Promise<{ routes: readonly string[]; source: RouteSource }> {
    const read = async (get: () => Promise<readonly string[]> | readonly string[]): Promise<readonly string[]> => (async () => get())().then((r) => r, () => [] as readonly string[]);
    if (body.hosted !== undefined) {
      if (body.explicitRoutes === true && body.routes.length > 0) {
        // The owner's routes are an order of preference, not a way past the routing table: only those it lets the coordinator use (local data, no paid route, not disabled or excluded) are tried.
        const usable = this.#deps.eligibleRoutes === undefined ? body.routes : await read(() => this.#deps.eligibleRoutes!(body.routes));
        if (usable.length > 0) return { routes: usable, source: "owner" };
      }
      if (profile !== undefined && this.#deps.profileRoutes !== undefined) {
        const fromProfile = await read(() => this.#deps.profileRoutes!(profile));
        if (fromProfile.length > 0) return { routes: fromProfile, source: "profile" };
      }
    }
    return this.#deps.routes === undefined ? { routes: body.routes, source: "stored" } : { routes: await read(this.#deps.routes), source: "role" };
  }

  /**
   * The primary route, then the fallbacks in order, at most four tries; the first usable reply wins and none is a refusal to answer, not an error. A hosted coordinator's calls are recorded against its agent's budget
   * (usage by agent, as any agent's model calls are); recording never refuses a call and never fails one (card U03d).
   */
  async #ask(owner: Principal, state: { readonly body: CoordinatorBody; readonly profile?: string }, request: CoordinatorRequest, projectId?: string): Promise<unknown> {
    const { body } = state;
    const { routes } = await this.#routesOf(body, state.profile);
    for (const route of routes.slice(0, MAX_ROUTES)) {
      let tokens: { inputTokens: number; outputTokens: number } | undefined;
      const began = Date.now();
      let reply: unknown;
      try { reply = await this.#deps.model.respond(route, request, (t) => { tokens = t; }); } catch { continue; /* try the next route */ }
      if (body.hosted !== undefined && this.#deps.attribute !== undefined) {
        await this.#deps.attribute(owner, body.principalId, { route, computeMs: Math.max(0, Date.now() - began), ...(tokens === undefined ? {} : tokens), ...(projectId === undefined ? {} : { projectId }) }).catch((error: unknown) => { try { this.#deps.onAttributionFailure?.(error); } catch { /* a report that fails changes nothing */ } });
      }
      return reply;
    }
    return undefined;
  }

  /** A pause made through the agent's own controls (not by the coordinator's order) is reported to its gate as reached once the coordinator holds no work; the order path already does so. */
  async #reportReached(owner: Principal, agentId: string, look: HostedLook): Promise<void> {
    const mine = look.heldBy.find((h) => h.scope.kind === "agent" && h.scope.id === agentId);
    if (mine === undefined || (mine.observed !== undefined && ["paused", "stopped", "suspended", "stopping"].includes(mine.observed))) return;
    await this.#reportIfIdle(owner, agentId);
  }

  async #busy<T>(work: () => Promise<T>): Promise<T> {
    this.#inflight++;
    try { return await work(); } finally {
      this.#inflight--;
      const waiting = this.#reportWhenIdle;
      if (this.#inflight === 0 && waiting !== undefined) await this.#reportIfIdle(waiting.owner, waiting.agentId);
    }
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
