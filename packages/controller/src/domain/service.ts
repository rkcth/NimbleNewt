import type { Aggregate, ControllerStorage, JsonObject } from "../storage/types.js";
import { DomainError } from "./errors.js";
import { taskEventEntry, taskEventId } from "./events.js";
import { derivedId } from "./ids.js";
import { CommandRunner, defined, mapStorageError, view, type CommandMeta, type CommandResult, type RunnerOptions } from "./runner.js";
import {
  LIMITS, TRANSITIONS, onlyKnown, projectId as checkProjectId, repositories as checkRepositories, repositoryId as checkRepositoryId,
  revision as checkRevision, taskId as checkTaskId, taskState, text,
  type ProjectBody, type ProjectState, type Repository, type TaskBody, type TaskState, type View,
} from "./model.js";

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

export interface ServiceOptions extends RunnerOptions {
  /** Who holds the primary epoch, recorded with it. */
  readonly holder: string;
}

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
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  /** Takes a new primary epoch, so earlier controllers (and services opened before) can no longer write, and returns the service that writes under it. */
  static async open(storage: ControllerStorage, options: ServiceOptions): Promise<ProjectService> {
    return new ProjectService(await CommandRunner.acquire(storage, options.holder, options));
  }

  /**
   * A service that writes under an epoch some other part of the controller already took. Each `open` takes a new epoch and so deposes
   * every earlier service; all the services of one controller (this one, and those of later cards) must therefore share the one epoch
   * the controller acquired at start-up, by passing it here.
   */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ProjectService {
    if (!Number.isSafeInteger(epoch) || epoch < 1) throw new DomainError("invalid_command", "epoch: must be a whole number of at least 1", { field: "epoch" });
    return new ProjectService(new CommandRunner(storage, epoch, options));
  }

  get epoch(): number { return this.#runner.epoch; }

  // ---- commands ------------------------------------------------------------------------------------------------------------

  createProject(command: CreateProject): Promise<CommandResult> {
    return this.#runner.command("project.create", command, async (meta) => {
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
    return this.#runner.command("project.update", command, async () => {
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
          const current = await this.#runner.existing("project", id, expected);
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
    return this.#runner.command("task.create", command, async (meta) => {
      onlyKnown(command, ["commandId", "actor", "projectId", "title", "description", "repositoryId"]);
      const project = checkProjectId(command.projectId);
      const title = text(command.title, "title", { min: 1, max: LIMITS.title });
      const description = command.description === undefined ? "" : text(command.description, "description", { min: 0, max: LIMITS.description, multiline: true });
      const repository = command.repositoryId === undefined ? undefined : checkRepositoryId(command.repositoryId, "repositoryId");
      return {
        payload: defined({ projectId: project, title, description, repositoryId: repository }),
        build: async () => {
          const parent = await this.#runner.get("project", project);
          if (parent === undefined) throw new DomainError("not_found", `project ${project} does not exist`);
          const owner = parent.body as unknown as ProjectBody;
          if (owner.state === "archived") throw new DomainError("invalid_command", `project ${project} is archived; reactivate it to add tasks`, { field: "projectId" });
          if (repository !== undefined && !owner.repositories.some((r) => r.id === repository)) throw new DomainError("invalid_command", `repositoryId: project ${project} has no repository ${repository}`, { field: "repositoryId" });
          const id = derivedId("task", meta.commandId);
          const body: TaskBody = { projectId: project, title, description, state: "proposed", ...(repository === undefined ? {} : { repositoryId: repository }), createdBy: meta.actor };
          return { ref: { kind: "task", id }, creates: true, changes: [{ type: "create", ref: { kind: "task", id }, body: body as unknown as JsonObject }], detail: { projectId: project, title }, outbox: [taskEventEntry(id, body, 1, "created")] };
        },
      };
    });
  }

  updateTask(command: UpdateTask): Promise<CommandResult> {
    return this.#runner.command("task.update", command, async () => {
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
          const current = await this.#runner.existing("task", id, expected);
          const body = current.body as unknown as TaskBody;
          if (TRANSITIONS[body.state].length === 0) throw new DomainError("invalid_command", `task ${id} is ${body.state} and can no longer be edited`, { field: "taskId" });
          if (typeof repository === "string") {
            const parent = await this.#runner.get("project", body.projectId);
            const owner = parent?.body as unknown as ProjectBody | undefined;
            if (owner === undefined || !owner.repositories.some((r) => r.id === repository)) throw new DomainError("invalid_command", `repositoryId: project ${body.projectId} has no repository ${repository}`, { field: "repositoryId" });
          }
          const { repositoryId: _previous, ...rest } = body;
          const next: TaskBody = {
            ...rest, ...defined({ title, description }),
            ...(repository === null ? {} : typeof repository === "string" ? { repositoryId: repository } : _previous === undefined ? {} : { repositoryId: _previous }),
          };
          return { ref: { kind: "task", id }, creates: false, changes: [{ type: "update", ref: { kind: "task", id }, expectedRevision: expected, body: next as unknown as JsonObject }], detail: defined({ title, repositoryId: repository }), outbox: [taskEventEntry(id, next, expected + 1, "updated")] };
        },
      };
    });
  }

  transitionTask(command: TransitionTask): Promise<CommandResult> {
    return this.#runner.command("task.transition", command, async () => {
      onlyKnown(command, ["commandId", "actor", "taskId", "expectedRevision", "to"]);
      const id = checkTaskId(command.taskId);
      const expected = checkRevision(command.expectedRevision);
      const to = taskState(command.to);
      return {
        payload: { taskId: id, expectedRevision: expected, to },
        build: async () => {
          const current = await this.#runner.existing("task", id, expected);
          const body = current.body as unknown as TaskBody;
          if (!TRANSITIONS[body.state].includes(to)) throw new DomainError("invalid_transition", `task ${id} cannot move from ${body.state} to ${to} (allowed: ${TRANSITIONS[body.state].join(", ") || "none, it is final"})`, { field: "to" });
          const next: TaskBody = { ...body, state: to };
          return { ref: { kind: "task", id }, creates: false, changes: [{ type: "update", ref: { kind: "task", id }, expectedRevision: expected, body: next as unknown as JsonObject }], detail: { from: body.state, to }, outbox: [taskEventEntry(id, next, expected + 1, "transitioned", body.state)] };
        },
      };
    });
  }

  /**
   * Gap repair for task events (card S03): for each task in the page, makes sure its current revision has its event, and writes the event
   * (change `reconciled`) in one command if it does not. Commands announce their own changes in the same transaction, so a gap exists only
   * for records written before events existed or by a store restored from a copy; this finds them. It reads, never rewrites, a task: if
   * the task moves while it is being repaired, the repair is skipped (the command that moved it announced the new revision). Repeating it
   * changes nothing. Returns where to continue (absent at the end).
   */
  async reconcileTaskEvents(page: { afterId?: string; limit: number }): Promise<{ checked: number; repaired: string[]; next?: string }> {
    const tasks = await this.#runner.list("task", page);
    const repaired: string[] = [];
    for (const task of tasks) {
      let known: unknown;
      try { known = await this.#runner.storage.getDelivery(taskEventId(task.id, task.revision)); } catch (error) { throw mapStorageError(error); }
      if (known !== undefined) continue;
      try {
        await this.#runner.command("task.event.repair", { commandId: `repair:${task.id}:${task.revision}`, actor: "reconciler" }, async () => ({
          payload: { taskId: task.id, revision: task.revision },
          build: async () => {
            const current = await this.#runner.existing("task", task.id, task.revision);
            const body = current.body as unknown as TaskBody;
            return { ref: { kind: "task", id: task.id }, creates: false, changes: [{ type: "check", ref: { kind: "task", id: task.id }, expectedRevision: task.revision }], detail: { revision: task.revision }, outbox: [taskEventEntry(task.id, body, task.revision, "reconciled")] };
          },
        }));
        repaired.push(task.id);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision") throw error;
      }
    }
    const last = tasks[tasks.length - 1];
    return { checked: tasks.length, repaired, ...(tasks.length === page.limit && last !== undefined ? { next: last.id } : {}) };
  }

  // ---- reads ---------------------------------------------------------------------------------------------------------------

  async getProject(id: string): Promise<View<ProjectBody> | undefined> {
    const found = await this.#runner.get("project", checkProjectId(id));
    return found === undefined ? undefined : view<ProjectBody>(found);
  }

  async getTask(id: string): Promise<View<TaskBody> | undefined> {
    const found = await this.#runner.get("task", checkTaskId(id));
    return found === undefined ? undefined : view<TaskBody>(found);
  }

  /** Projects in ID order after `afterId`. */
  async listProjects(page: { afterId?: string; limit: number }): Promise<View<ProjectBody>[]> {
    return (await this.#runner.list("project", page)).map((a) => view<ProjectBody>(a));
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
      const page = await this.#runner.list("task", { ...(after === undefined ? {} : { afterId: after }), limit: SCAN_PAGE });
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
}

const SCAN_PAGE = 500;
const MAX_SCAN_PAGES = 20;

const projectState = (value: unknown): ProjectState => {
  if (value !== "active" && value !== "archived") throw new DomainError("invalid_command", "state: must be active or archived", { field: "state" });
  return value;
};

