import { DomainError } from "../domain/errors.js";
import type { AssignmentService, AdmitAttempt, AssignTask, FencedTransition, FencedUpdate, FinishAttempt, ObserveActivity, ReleaseTask, TransferTask } from "../domain/assignments.js";
import type { ActivityBody, AssignmentBody, AttemptBody, GenerationBody } from "../domain/assignment-model.js";
import type { CommandResult } from "../domain/runner.js";
import type { CreateProject, CreateTask, ProjectService, TransitionTask, UpdateProject, UpdateTask } from "../domain/service.js";
import type { ProjectBody, TaskBody, View } from "../domain/model.js";
import { allows, requireAction as require, toolAction } from "./access.js";
import { scopedCommandId } from "./credentials.js";
import type { NoActor, Principal } from "./principals.js";
import { redactText } from "./redact.js";

type WithoutMeta<C> = Omit<C, "actor" | "commandId">;
/** A command as a caller sends it through the secured API: the actor is not a field. (A stray `actor` is checked, never trusted.) */
type Secure<C> = NoActor & WithoutMeta<C>;

export interface SecureDependencies {
  readonly projects: ProjectService;
  readonly assignments: AssignmentService;
}

/**
 * The controller's services as one authenticated principal may use them (card A01). Every call:
 * 1. takes its actor from the principal, never from the caller (a command naming another actor is refused);
 * 2. checks that the principal may take that action in the project the resource belongs to, found from the stored record, not from what the caller says;
 * 3. for work done as an attempt's owner, checks that the principal *is* that owner;
 * 4. reports refusals without revealing whether a record in another project exists, and with secrets removed from every message.
 * `authorizeTool` applies the same rule to a tool call. The unsecured services remain the controller's own internal path.
 */
export class SecureApi {
  readonly #p: Principal;
  readonly #d: SecureDependencies;

  constructor(principal: Principal, dependencies: SecureDependencies) {
    this.#p = principal;
    this.#d = dependencies;
  }

  get principal(): Principal { return this.#p; }

  // ---- projects and tasks --------------------------------------------------------------------------------------------------

  createProject(command: Secure<CreateProject>): Promise<CommandResult> {
    return this.#run(async () => { require(this.#p, "project.create", undefined); return this.#d.projects.createProject(this.#with(command)); });
  }

  updateProject(command: Secure<UpdateProject>): Promise<CommandResult> {
    return this.#run(async () => { require(this.#p, "project.update", command.projectId); return this.#d.projects.updateProject(this.#with(command)); });
  }

  createTask(command: Secure<CreateTask>): Promise<CommandResult> {
    return this.#run(async () => { require(this.#p, "task.create", command.projectId); return this.#d.projects.createTask(this.#with(command)); });
  }

  updateTask(command: Secure<UpdateTask>): Promise<CommandResult> {
    return this.#run(async () => { await this.#requireOnTask("task.update", command.taskId); return this.#d.projects.updateTask(this.#with(command)); });
  }

  transitionTask(command: Secure<TransitionTask>): Promise<CommandResult> {
    return this.#run(async () => { await this.#requireOnTask("task.transition", command.taskId); return this.#d.projects.transitionTask(this.#with(command)); });
  }

  getProject(projectId: string): Promise<View<ProjectBody> | undefined> {
    return this.#run(async () => { require(this.#p, "project.read", projectId); return this.#d.projects.getProject(projectId); });
  }

  getTask(taskId: string): Promise<View<TaskBody> | undefined> {
    return this.#run(async () => { const task = await this.#requireOnTask("task.read", taskId); return task; });
  }

  /** Only the projects the principal may read, up to `limit` (pages are read until the limit is filled or the projects end); `next` is where to continue. */
  listProjects(page: { afterId?: string; limit: number }): Promise<{ items: View<ProjectBody>[]; next?: string }> {
    return this.#run(async () => {
      const items: View<ProjectBody>[] = [];
      let after = page.afterId;
      for (let reads = 0; reads < 20; reads++) {
        const chunk = await this.#d.projects.listProjects({ ...(after === undefined ? {} : { afterId: after }), limit: 500 });
        for (const project of chunk) {
          after = project.id;
          if (!allows(this.#p, "project.read", project.id)) continue;
          items.push(project);
          if (items.length >= page.limit) return { items, next: project.id };
        }
        if (chunk.length < 500) return { items };
      }
      return { items, ...(after === undefined ? {} : { next: after }) };
    });
  }

  /** Tasks of one project the principal may read. Only the owner may list across projects. */
  listTasks(query: { projectId?: string; afterId?: string; limit: number }): Promise<{ items: View<TaskBody>[]; next?: string }> {
    return this.#run(async () => {
      if (query.projectId === undefined && this.#p.kind !== "owner") throw new DomainError("forbidden", `${this.#p.id} must name a project to list tasks`);
      if (query.projectId !== undefined) require(this.#p, "task.read", query.projectId);
      return this.#d.projects.listTasks(query);
    });
  }

  // ---- assignment ----------------------------------------------------------------------------------------------------------

  assignTask(command: Secure<AssignTask>): Promise<CommandResult> {
    return this.#run(async () => { await this.#requireOnTask("assignment.manage", command.taskId); return this.#d.assignments.assignTask(this.#with(command)); });
  }

  transferTask(command: Secure<TransferTask>): Promise<CommandResult> {
    return this.#run(async () => { await this.#requireOnTask("assignment.manage", command.taskId); return this.#d.assignments.transferTask(this.#with(command)); });
  }

  releaseTask(command: Secure<ReleaseTask>): Promise<CommandResult> {
    return this.#run(async () => { await this.#requireOnTask("assignment.manage", command.taskId); return this.#d.assignments.releaseTask(this.#with(command)); });
  }

  getAssignment(taskId: string): Promise<View<AssignmentBody> | undefined> {
    return this.#run(async () => { await this.#requireOnTask("assignment.read", taskId); return this.#d.assignments.getAssignment(taskId); });
  }

  history(taskId: string): Promise<View<GenerationBody>[]> {
    return this.#run(async () => { await this.#requireOnTask("assignment.read", taskId); return this.#d.assignments.history(taskId); });
  }

  getAttempt(attemptId: string): Promise<View<AttemptBody> | undefined> {
    return this.#run(async () => {
      const attempt = await this.#d.assignments.getAttempt(attemptId);
      if (attempt === undefined) { this.#hide(); return undefined; }
      await this.#requireOnTask("assignment.read", attempt.taskId);
      return attempt;
    });
  }

  getActivity(taskId: string): Promise<View<ActivityBody> | undefined> {
    return this.#run(async () => { await this.#requireOnTask("assignment.read", taskId); return this.#d.assignments.getActivity(taskId); });
  }

  // ---- work as an attempt's owner (the principal must be the owner) ------------------------------------------------------------

  /** Admits the principal's own attempt: the owner named must be the principal. */
  admitAttempt(command: Secure<AdmitAttempt>): Promise<CommandResult> {
    return this.#run(async () => {
      await this.#requireOnTask("attempt.work", command.taskId);
      if (command.owner?.kind !== this.#p.kind || command.owner?.id !== this.#p.name) throw new DomainError("forbidden", `${this.#p.id} may admit only its own attempts`);
      return this.#d.assignments.admitAttempt(this.#with(command));
    });
  }

  finishAttempt(command: Secure<FinishAttempt>): Promise<CommandResult> {
    return this.#run(async () => { await this.#requireOwnerOf(command.taskId); return this.#d.assignments.finishAttempt(this.#with(command)); });
  }

  /** A task write made as the attempt's owner (checked against its fence, atomically with the write). */
  transitionTaskAsOwner(command: Secure<FencedTransition>): Promise<CommandResult> {
    return this.#run(async () => { await this.#requireOwnerOf(command.taskId); return this.#d.assignments.transitionTask(this.#with(command)); });
  }

  updateTaskAsOwner(command: Secure<FencedUpdate>): Promise<CommandResult> {
    return this.#run(async () => { await this.#requireOwnerOf(command.taskId); return this.#d.assignments.updateTask(this.#with(command)); });
  }

  /** Records that a worker was seen. Any principal with `attempt.work` may report; it never changes ownership. */
  observeActivity(command: Secure<ObserveActivity>): Promise<CommandResult> {
    return this.#run(async () => {
      await this.#requireOnTask("attempt.work", command.taskId);
      // Activity is the liveness signal later stall detection reads: a principal reports only itself (the installation owner may report for any worker).
      if (this.#p.kind !== "owner" && command.observedBy !== this.#p.id && !(this.#p.kind === "agent" && command.observedBy === this.#p.name)) throw new DomainError("forbidden", `${this.#p.id} may report only its own activity`);
      return this.#d.assignments.observeActivity(this.#with(command));
    });
  }

  // ---- tools ---------------------------------------------------------------------------------------------------------------

  /**
   * The gate a tool call passes before it runs: `tool.<name>` in the project of the task the call is for, found from the stored task (never from what the caller says). Throws
   * `forbidden`. This is the gate itself; the registry and the adapter's tool execution (T01, A04, A05) are what must call it, and nothing does yet.
   */
  async authorizeTool(toolName: string, taskId: string): Promise<void> {
    await this.#run(async () => {
      const task = await this.#d.projects.getTask(taskId);
      if (task === undefined || !allows(this.#p, toolAction(toolName), task.projectId, { resource: { kind: "task", id: taskId } })) this.#hide();
    });
  }

  // ---- plumbing ------------------------------------------------------------------------------------------------------------

  /** The command with the principal as actor. A command that names someone else as actor is refused, not corrected. */
  #with<C extends object>(command: C): C & { actor: string } {
    const named = (command as { actor?: unknown }).actor;
    if (named !== undefined && named !== this.#p.id) throw new DomainError("forbidden", redactText(`the command names the actor ${typeof named === "string" ? named.slice(0, 60) : "(not text)"}, but the caller is ${this.#p.id}`));
    return { ...command, actor: this.#p.id, commandId: scopedCommandId(this.#p.id, (command as { commandId?: unknown }).commandId) };
  }

  /** A record that does not exist and one the caller may not see look the same to anyone but the owner. */
  #hide(): never {
    throw this.#p.kind === "owner" ? new DomainError("not_found", "no such record") : new DomainError("forbidden", `${this.#p.id} may not read that`);
  }

  async #requireOnTask(action: string, taskId: string): Promise<View<TaskBody>> {
    const task = await this.#d.projects.getTask(taskId);
    if (task === undefined) return this.#hide();
    // A refusal on a record that exists must read exactly like a record that does not (and must not name the record's project).
    if (!allows(this.#p, action, task.projectId, { resource: { kind: "task", id: taskId } })) return this.#hide();
    return task;
  }

  /** The principal must be the current owner of the task's assignment. */
  async #requireOwnerOf(taskId: string): Promise<void> {
    await this.#requireOnTask("attempt.work", taskId);
    const assignment = await this.#d.assignments.getAssignment(taskId);
    const owner = assignment?.owner;
    if (assignment?.state !== "assigned" || owner === undefined || owner.kind !== this.#p.kind || owner.id !== this.#p.name) throw new DomainError("forbidden", `${this.#p.id} is not the owner of task ${taskId}'s assignment`);
  }

  async #run<T>(work: () => Promise<T>): Promise<T> {
    try { return await work(); } catch (error) { throw redacted(error); }
  }
}

/** The same error with its message cleaned of secrets (domain errors can echo caller-supplied text). */
function redacted(error: unknown): unknown {
  if (!(error instanceof DomainError)) return error;
  const clean = redactText(error.message);
  if (clean === error.message) return error;
  return new DomainError(error.code, clean, { ...(error.currentRevision === undefined ? {} : { currentRevision: error.currentRevision }), ...(error.field === undefined ? {} : { field: error.field }) });
}
