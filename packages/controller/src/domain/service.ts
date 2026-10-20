import { setTimeout as sleep } from "node:timers/promises";
import { commitOperation } from "../storage/commit.js";
import { isStorageError } from "../storage/errors.js";
import { canonicalJson, sha256 } from "../storage/json.js";
import type { Aggregate, AggregateRef, Change, ControllerStorage, JsonObject, OperationInput, OperationResult } from "../storage/types.js";
import { DomainError } from "./errors.js";
import { derivedId, operationIdOf } from "./ids.js";
import {
  LIMITS, TRANSITIONS, actor as checkActor, commandId as checkCommandId, onlyKnown, projectId as checkProjectId, repositories as checkRepositories, repositoryId as checkRepositoryId,
  revision as checkRevision, taskId as checkTaskId, taskState, text,
  type ProjectBody, type ProjectState, type Repository, type TaskBody, type TaskState, type View,
} from "./model.js";

/** Who is asking and which command this is. The command ID is the idempotency key: the same command may be sent any number of times and applies once. */
export interface CommandMeta {
  readonly commandId: string;
  readonly actor: string;
}

export interface CommandResult {
  /** The record the command created or changed. */
  readonly id: string;
  /** Its revision after the command. A repeated command returns the revision the first application produced. */
  readonly revision: number;
  /** True when this call found the command already applied and returned its recorded result. */
  readonly replayed: boolean;
}

export interface CreateProject extends CommandMeta { readonly name: string; readonly goal?: string; readonly repositories?: readonly Repository[] }
export interface UpdateProject extends CommandMeta {
  readonly projectId: string;
  readonly expectedRevision: number;
  readonly name?: string;
  readonly goal?: string;
  readonly state?: ProjectState;
  /** New repositories only: removing one is not supported yet, because tasks may refer to it. */
  readonly addRepositories?: readonly Repository[];
}
export interface CreateTask extends CommandMeta { readonly projectId: string; readonly title: string; readonly description?: string; readonly repositoryId?: string }
export interface UpdateTask extends CommandMeta {
  readonly taskId: string;
  readonly expectedRevision: number;
  readonly title?: string;
  readonly description?: string;
  /** A repository of the task's project, or `null` to detach the task from its repository. */
  readonly repositoryId?: string | null;
}
export interface TransitionTask extends CommandMeta { readonly taskId: string; readonly expectedRevision: number; readonly to: TaskState }

export interface ServiceOptions {
  /** Who holds the primary epoch, recorded with it. */
  readonly holder: string;
  /** The time recorded with each command. Never compared; tests may fix it. */
  readonly clock?: () => string;
  /** Total storage attempts for one command, including the first (contention is retried; the command applies once). Default 5. */
  readonly attempts?: number;
  /** Pause before a retry. Default: a short jittered backoff. */
  readonly pause?: (attempt: number) => Promise<void>;
}

interface Built {
  /** The record the command targets, and whether it creates it. */
  readonly ref: AggregateRef;
  readonly creates: boolean;
  readonly changes: readonly Change[];
  readonly detail: JsonObject;
}

/** The same object without its undefined fields (an absent optional field is omitted, never stored as undefined). */
const defined = <T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as { [K in keyof T]?: Exclude<T[K], undefined> };
const asRepositories = (value: unknown): Repository[] => value as Repository[];

/**
 * Project and task records, changed only by commands (card S01).
 *
 * - **Identity.** A created record's ID is derived from the command ID (`derivedId`), so it is stable, nobody picks it and a retry names
 *   the same record. Names and titles are ordinary editable fields, never identity.
 * - **Idempotency.** Each command is one storage operation named by its command ID. Repeating a command returns its recorded result
 *   without applying it again, even after the record has moved on; reusing a command ID for a different command is `command_conflict`.
 *   The command's digest is recorded in its audit entry, which is how a repeat is recognised without recomputing it from state that
 *   has since changed.
 * - **Optimistic revisions.** Every command that changes an existing record says which revision it saw (`expectedRevision`); at any
 *   other revision it fails as `stale_revision`, naming the current one, and writes nothing.
 * - **Optional repository.** A project may have no repository and a task may have none; nothing here requires one.
 * - **Not here.** Who works on a task (S02), delivery of changes (S03), permissions (A01) and removing a repository. A task created in a
 *   project that is archived a moment later is not prevented: the check is made when the command is received, and archived projects
 *   keep their tasks, so no reference is ever dangling.
 */
export class ProjectService {
  readonly #storage: ControllerStorage;
  readonly #epoch: number;
  readonly #clock: () => string;
  readonly #attempts: number;
  readonly #pause: (attempt: number) => Promise<void>;

  private constructor(storage: ControllerStorage, epoch: number, options: Omit<ServiceOptions, "holder">) {
    this.#storage = storage;
    this.#epoch = epoch;
    this.#clock = options.clock ?? (() => new Date().toISOString());
    this.#attempts = options.attempts ?? 5;
    this.#pause = options.pause ?? ((attempt) => sleep(Math.round(Math.random() * Math.min(200, 10 * 2 ** attempt))));
  }

  /** Takes a new primary epoch, so earlier controllers (and services opened before) can no longer write, and returns the service that writes under it. */
  static async open(storage: ControllerStorage, options: ServiceOptions): Promise<ProjectService> {
    try {
      const { epoch } = await storage.acquireEpoch({ holder: options.holder, at: (options.clock ?? (() => new Date().toISOString()))() });
      return new ProjectService(storage, epoch, options);
    } catch (error) {
      throw mapStorageError(error);
    }
  }

  /**
   * A service that writes under an epoch some other part of the controller already took. Each `open` takes a new epoch and so deposes
   * every earlier service; all the services of one controller (this one, and those of later cards) must therefore share the one epoch
   * the controller acquired at start-up, by passing it here.
   */
  static withEpoch(storage: ControllerStorage, epoch: number, options: Omit<ServiceOptions, "holder"> = {}): ProjectService {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new DomainError("invalid_command", "epoch: must be a whole number of at least 1", { field: "epoch" });
    return new ProjectService(storage, epoch, options);
  }

  get epoch(): number { return this.#epoch; }

  // ---- commands ------------------------------------------------------------------------------------------------------------

  createProject(command: CreateProject): Promise<CommandResult> {
    return this.#command("project.create", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "name", "goal", "repositories"]);
      const name = text(command.name, "name", { min: 1, max: LIMITS.name });
      const goal = command.goal === undefined ? "" : text(command.goal, "goal", { min: 0, max: LIMITS.goal, multiline: true });
      const repositories = command.repositories === undefined ? [] : checkRepositories(command.repositories, "repositories");
      return {
        payload: { name, goal, repositories: repositories as unknown as JsonObject[] },
        build: async () => {
          const id = derivedId("proj", meta.commandId);
          const body: ProjectBody = { name, goal, state: "active", repositories, createdBy: meta.actor };
          return { ref: { kind: "project", id }, creates: true, changes: [{ type: "create", ref: { kind: "project", id }, body: body as unknown as JsonObject }], detail: { name } };
        },
      };
    });
  }

  updateProject(command: UpdateProject): Promise<CommandResult> {
    return this.#command("project.update", command, async () => {
      onlyKnown(command, ["commandId", "actor", "projectId", "expectedRevision", "name", "goal", "state", "addRepositories"]);
      const id = checkProjectId(command.projectId);
      const expected = checkRevision(command.expectedRevision);
      const name = command.name === undefined ? undefined : text(command.name, "name", { min: 1, max: LIMITS.name });
      const goal = command.goal === undefined ? undefined : text(command.goal, "goal", { min: 0, max: LIMITS.goal, multiline: true });
      const state = command.state === undefined ? undefined : projectState(command.state);
      const added = command.addRepositories === undefined ? undefined : checkRepositories(command.addRepositories, "addRepositories");
      if (name === undefined && goal === undefined && state === undefined && added === undefined) throw new DomainError("invalid_command", "an update must change at least one of name, goal, state or addRepositories", { field: "name" });
      return {
        payload: defined({ projectId: id, expectedRevision: expected, name, goal, state, addRepositories: added as unknown as JsonObject[] | undefined }),
        build: async () => {
          const current = await this.#existing("project", id, expected);
          const body = current.body as unknown as ProjectBody;
          let repositories = asRepositories(body.repositories);
          if (added !== undefined) {
            const known = new Set(repositories.map((r) => r.id));
            for (const [i, r] of added.entries()) if (known.has(r.id)) throw new DomainError("invalid_command", `addRepositories[${i}].id: the project already has a repository ${r.id}`, { field: `addRepositories[${i}].id` });
            repositories = [...repositories, ...added];
            if (repositories.length > LIMITS.repositories) throw new DomainError("invalid_command", `a project has at most ${LIMITS.repositories} repositories`, { field: "addRepositories" });
          }
          const next: ProjectBody = { ...body, ...defined({ name, goal, state }), repositories };
          return { ref: { kind: "project", id }, creates: false, changes: [{ type: "update", ref: { kind: "project", id }, expectedRevision: expected, body: next as unknown as JsonObject }], detail: defined({ name, state, repositoriesAdded: added?.length }) };
        },
      };
    });
  }

  createTask(command: CreateTask): Promise<CommandResult> {
    return this.#command("task.create", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "projectId", "title", "description", "repositoryId"]);
      const project = checkProjectId(command.projectId);
      const title = text(command.title, "title", { min: 1, max: LIMITS.title });
      const description = command.description === undefined ? "" : text(command.description, "description", { min: 0, max: LIMITS.description, multiline: true });
      const repository = command.repositoryId === undefined ? undefined : checkRepositoryId(command.repositoryId, "repositoryId");
      return {
        payload: defined({ projectId: project, title, description, repositoryId: repository }),
        build: async () => {
          const parent = await this.#get("project", project);
          if (parent === undefined) throw new DomainError("not_found", `project ${project} does not exist`);
          const owner = parent.body as unknown as ProjectBody;
          if (owner.state === "archived") throw new DomainError("invalid_command", `project ${project} is archived; reactivate it to add tasks`, { field: "projectId" });
          if (repository !== undefined && !owner.repositories.some((r) => r.id === repository)) throw new DomainError("invalid_command", `repositoryId: project ${project} has no repository ${repository}`, { field: "repositoryId" });
          const id = derivedId("task", meta.commandId);
          const body: TaskBody = { projectId: project, title, description, state: "proposed", ...(repository === undefined ? {} : { repositoryId: repository }), createdBy: meta.actor };
          return { ref: { kind: "task", id }, creates: true, changes: [{ type: "create", ref: { kind: "task", id }, body: body as unknown as JsonObject }], detail: { projectId: project, title } };
        },
      };
    });
  }

  updateTask(command: UpdateTask): Promise<CommandResult> {
    return this.#command("task.update", command, async () => {
      onlyKnown(command, ["commandId", "actor", "taskId", "expectedRevision", "title", "description", "repositoryId"]);
      const id = checkTaskId(command.taskId);
      const expected = checkRevision(command.expectedRevision);
      const title = command.title === undefined ? undefined : text(command.title, "title", { min: 1, max: LIMITS.title });
      const description = command.description === undefined ? undefined : text(command.description, "description", { min: 0, max: LIMITS.description, multiline: true });
      const repository = command.repositoryId === undefined || command.repositoryId === null ? command.repositoryId : checkRepositoryId(command.repositoryId, "repositoryId");
      if (title === undefined && description === undefined && repository === undefined) throw new DomainError("invalid_command", "an update must change at least one of title, description or repositoryId", { field: "title" });
      return {
        payload: { taskId: id, expectedRevision: expected, ...defined({ title, description }), ...(repository === undefined ? {} : { repositoryId: repository }) },
        build: async () => {
          const current = await this.#existing("task", id, expected);
          const body = current.body as unknown as TaskBody;
          if (TRANSITIONS[body.state].length === 0) throw new DomainError("invalid_command", `task ${id} is ${body.state} and can no longer be edited`, { field: "taskId" });
          if (typeof repository === "string") {
            const parent = await this.#get("project", body.projectId);
            const owner = parent?.body as unknown as ProjectBody | undefined;
            if (owner === undefined || !owner.repositories.some((r) => r.id === repository)) throw new DomainError("invalid_command", `repositoryId: project ${body.projectId} has no repository ${repository}`, { field: "repositoryId" });
          }
          const { repositoryId: _previous, ...rest } = body;
          const next: TaskBody = {
            ...rest, ...defined({ title, description }),
            ...(repository === null ? {} : typeof repository === "string" ? { repositoryId: repository } : _previous === undefined ? {} : { repositoryId: _previous }),
          };
          return { ref: { kind: "task", id }, creates: false, changes: [{ type: "update", ref: { kind: "task", id }, expectedRevision: expected, body: next as unknown as JsonObject }], detail: defined({ title, repositoryId: repository }) };
        },
      };
    });
  }

  transitionTask(command: TransitionTask): Promise<CommandResult> {
    return this.#command("task.transition", command, async () => {
      onlyKnown(command, ["commandId", "actor", "taskId", "expectedRevision", "to"]);
      const id = checkTaskId(command.taskId);
      const expected = checkRevision(command.expectedRevision);
      const to = taskState(command.to);
      return {
        payload: { taskId: id, expectedRevision: expected, to },
        build: async () => {
          const current = await this.#existing("task", id, expected);
          const body = current.body as unknown as TaskBody;
          if (!TRANSITIONS[body.state].includes(to)) throw new DomainError("invalid_transition", `task ${id} cannot move from ${body.state} to ${to} (allowed: ${TRANSITIONS[body.state].join(", ") || "none, it is final"})`, { field: "to" });
          const next: TaskBody = { ...body, state: to };
          return { ref: { kind: "task", id }, creates: false, changes: [{ type: "update", ref: { kind: "task", id }, expectedRevision: expected, body: next as unknown as JsonObject }], detail: { from: body.state, to } };
        },
      };
    });
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------------

  async getProject(id: string): Promise<View<ProjectBody> | undefined> {
    const found = await this.#get("project", checkProjectId(id));
    return found === undefined ? undefined : view<ProjectBody>(found);
  }

  async getTask(id: string): Promise<View<TaskBody> | undefined> {
    const found = await this.#get("task", checkTaskId(id));
    return found === undefined ? undefined : view<TaskBody>(found);
  }

  /** Projects in ID order after `afterId`. */
  async listProjects(page: { afterId?: string; limit: number }): Promise<View<ProjectBody>[]> {
    return (await this.#list("project", page)).map((a) => view<ProjectBody>(a));
  }

  /**
   * Tasks in ID order after `afterId`, optionally only those of one project. Tasks are stored by kind, so a project filter reads
   * pages and keeps the matches: `next` is where to continue (absent at the end), and a page may hold fewer than `limit` tasks while
   * `next` is present.
   */
  async listTasks(query: { projectId?: string; afterId?: string; limit: number }): Promise<{ items: View<TaskBody>[]; next?: string }> {
    const project = query.projectId === undefined ? undefined : checkProjectId(query.projectId);
    const items: View<TaskBody>[] = [];
    let after = query.afterId;
    for (let reads = 0; reads < MAX_SCAN_PAGES; reads++) {
      const page = await this.#list("task", { ...(after === undefined ? {} : { afterId: after }), limit: SCAN_PAGE });
      for (const aggregate of page) {
        if (project !== undefined && (aggregate.body as unknown as TaskBody).projectId !== project) { after = aggregate.id; continue; }
        items.push(view<TaskBody>(aggregate));
        after = aggregate.id;
        if (items.length >= query.limit) return { items, next: aggregate.id };
      }
      if (page.length < SCAN_PAGE) return { items };
    }
    return { items, ...(after === undefined ? {} : { next: after }) };
  }

  // ---- plumbing ------------------------------------------------------------------------------------------------------------

  async #get(kind: string, id: string): Promise<Aggregate | undefined> {
    try { return await this.#storage.getAggregate({ kind, id }); } catch (error) { throw mapStorageError(error); }
  }

  async #list(kind: string, page: { afterId?: string; limit: number }): Promise<Aggregate[]> {
    if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1000) throw new DomainError("invalid_command", "limit: must be a whole number from 1 to 1000", { field: "limit" });
    if (page.afterId !== undefined && (typeof page.afterId !== "string" || page.afterId.length > 200)) throw new DomainError("invalid_command", "afterId: must be a record ID", { field: "afterId" });
    try { return await this.#storage.listAggregates(kind, { ...(page.afterId === undefined ? {} : { afterId: page.afterId }), limit: page.limit }); } catch (error) { throw mapStorageError(error); }
  }

  /** The record, which must exist and be at `expected`. */
  async #existing(kind: string, id: string, expected: number): Promise<Aggregate> {
    const found = await this.#get(kind, id);
    if (found === undefined) throw new DomainError("not_found", `${kind} ${id} does not exist`);
    if (found.revision !== expected) throw new DomainError("stale_revision", `${kind} ${id} is at revision ${found.revision}, not ${expected}`, { currentRevision: found.revision });
    return found;
  }

  /**
   * Runs one command: validate, recognise a repeat, build the change from current state, commit it as one operation.
   * `prepare` validates and returns the normalised payload (for the command digest) and the builder of the change.
   */
  async #command<C extends CommandMeta>(
    type: string, command: C,
    prepare: (meta: CommandMeta) => Promise<{ payload: JsonObject; build: () => Promise<Built> }>,
  ): Promise<CommandResult> {
    if (command === null || typeof command !== "object") throw new DomainError("invalid_command", "a command is an object");
    const meta: CommandMeta = { commandId: checkCommandId(command.commandId), actor: checkActor(command.actor) };
    const { payload, build } = await prepare(meta);
    const operationId = operationIdOf(meta.commandId);
    const digest = sha256(canonicalJson({ v: 1, type, actor: meta.actor, payload }));

    const recorded = await this.#recorded(operationId, digest);
    if (recorded !== undefined) return recorded;

    // A duplicate sent at the same moment as the original can pass the check above before the original commits, and then meet the state
    // the original produced. Whenever this command is about to be refused because of state, look once more for a record of itself: if it
    // has been applied meanwhile, the duplicate is answered with that result instead of an error.
    const refusedUnlessApplied = async (refusal: DomainError): Promise<CommandResult> => (await this.#recorded(operationId, digest)) ?? Promise.reject(refusal);

    let built: Built;
    try {
      built = await build();
    } catch (error) {
      if (error instanceof DomainError) return refusedUnlessApplied(error);
      throw error;
    }
    const input: OperationInput = {
      operationId, epoch: this.#epoch, actor: meta.actor, correlationId: operationId, at: this.#clock(),
      changes: built.changes, audit: [{ type, subject: built.ref, detail: { commandDigest: digest, ...built.detail } }],
      outbox: [], effects: [], timers: [], cancelTimers: [], completeDeliveries: [], completeTimers: [], settleEffects: [],
    };
    let result: OperationResult;
    try {
      result = await commitOperation(this.#storage, input, { attempts: this.#attempts, pause: this.#pause });
    } catch (error) {
      if (isStorageError(error, "revision_conflict")) {
        if (built.creates) return refusedUnlessApplied(new DomainError("command_conflict", `${built.ref.kind} ${built.ref.id} already exists, so this command ID was used by something else`, { cause: error }));
        const now = await this.#get(built.ref.kind, built.ref.id);
        if (now === undefined) throw new DomainError("not_found", `${built.ref.kind} ${built.ref.id} does not exist`, { cause: error });
        return refusedUnlessApplied(new DomainError("stale_revision", `${built.ref.kind} ${built.ref.id} changed meanwhile and is now at revision ${now.revision}`, { currentRevision: now.revision, cause: error }));
      }
      throw mapStorageError(error);
    }
    return { id: built.ref.id, revision: revisionOf(result, built.ref), replayed: result.replayed };
  }

  /** The recorded result if this command already applied; `command_conflict` if the command ID was used for a different command. */
  async #recorded(operationId: string, digest: string): Promise<CommandResult | undefined> {
    try {
      const stored = await this.#storage.getOperation(operationId);
      if (stored === undefined) return undefined;
      const seq = stored.result.auditSeqs[0];
      const audit = seq === undefined ? undefined : (await this.#storage.listAudit({ afterSeq: seq - 1, limit: 1 }))[0];
      if (audit === undefined || audit.seq !== seq || audit.operationId !== operationId || audit.subject === undefined) {
        throw new DomainError("command_conflict", `command ID ${operationId.slice(4)} belongs to an operation that is not a project command`);
      }
      if (audit.detail["commandDigest"] !== digest) throw new DomainError("command_conflict", `command ID ${operationId.slice(4)} was already used for a different command`);
      return { id: audit.subject.id, revision: revisionOf(stored.result, audit.subject), replayed: true };
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw mapStorageError(error);
    }
  }
}

const SCAN_PAGE = 500;
const MAX_SCAN_PAGES = 20;

const projectState = (value: unknown): ProjectState => {
  if (value !== "active" && value !== "archived") throw new DomainError("invalid_command", "state: must be active or archived", { field: "state" });
  return value;
};

function revisionOf(result: OperationResult, ref: AggregateRef): number {
  const found = result.revisions.find((r) => r.ref.kind === ref.kind && r.ref.id === ref.id);
  if (found === undefined) throw new DomainError("unavailable", `storage did not report a revision for ${ref.kind} ${ref.id}`);
  return found.revision;
}

function view<B>(aggregate: Aggregate): View<B> {
  return { ...(aggregate.body as unknown as B), id: aggregate.id, revision: aggregate.revision, createdAt: aggregate.createdAt, updatedAt: aggregate.updatedAt };
}

/** Storage failures that no command-specific rule explains, in the domain's terms. */
function mapStorageError(error: unknown): DomainError {
  if (error instanceof DomainError) return error;
  if (isStorageError(error, "stale_epoch")) return new DomainError("stale_epoch", "this controller is no longer the primary", { cause: error });
  if (isStorageError(error, "idempotency_conflict")) return new DomainError("command_conflict", "this command ID was already used for a different command", { cause: error });
  if (isStorageError(error, "not_found")) return new DomainError("not_found", error instanceof Error ? error.message : "not found", { cause: error });
  if (isStorageError(error, "invalid_input")) return new DomainError("invalid_command", error instanceof Error ? error.message : "invalid command", { ...(error.path === undefined ? {} : { field: error.path }), cause: error });
  return new DomainError("unavailable", error instanceof Error ? `storage could not complete the request: ${error.message}` : "storage could not complete the request", { cause: error });
}
