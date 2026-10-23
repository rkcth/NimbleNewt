import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { credentialIdOf, hashSecret, newSecret, scopedCommandId, verifySecret, type StoredCredential } from "./credentials.js";
import { ActionCatalog } from "../policy/catalog.js";
import { effectiveOf } from "./grants.js";
import type { NoActor, Principal, PrincipalBody } from "./principals.js";
import { redactText } from "./redact.js";

/** A credential for one agent on one task (card A10b). The secret is never stored. */
export interface TaskCredentialBody {
  readonly agentId: string;
  readonly taskId: string;
  readonly projectId: string;
  readonly credential: StoredCredential;
  readonly state: "active" | "revoked";
  readonly issuedBy: string;
  readonly expiresAt?: string;
  readonly revokedBy?: string;
  readonly reason?: string;
  /** Who gave the owner's instruction for it: `owner` (the owner issued it) or `dispatcher` (the dispatcher issued it for an admitted attempt, card H12). */
  readonly issuedVia?: "owner" | "dispatcher";
  /** The attempt it was issued for (dispatcher issue only). */
  readonly attemptId?: string;
  /** The task contract's limit on tools at the time of issue (dispatcher issue only); absent when the contract states none. */
  readonly limit?: readonly string[];
}

export interface IssuedTaskCredential { readonly id: string; readonly token: string }

/** The one service principal that issues task credentials for admitted attempts (card H12). Enrolled by the owner as a `service`; no agent or conversation can be it. */
export const DISPATCHER_PRINCIPAL = "service:dispatcher";
const ID = /^tcr-[a-z2-7]{20}$/;
const ATTEMPT = /^att-[a-z2-7]{20}$/;
const refusal = (): DomainError => new DomainError("unauthenticated", "the credential was not accepted");
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };

/**
 * Per-task credentials (card A10b). An agent that serves several projects does not carry one credential for all of them: the owner (or the dispatcher on the owner's authority) issues one for each
 * task. Presenting it gives the agent's grants as they are now, cut down to the task's project (a grant for every project is narrowed to this one; a grant for another task is dropped), so it holds
 * the task's project-wide grants and the grants for this task; the access checks refuse anything outside that project, any other task where a check names the task, and every action that belongs to
 * no project. Within the project it is no narrower than the agent's own grants: what separates tasks of one project is the grants the owner gives, not this credential. The credential is refused at once when it
 * is revoked, when its task is done or cancelled, when it has expired and when the agent is disabled. The same secret is no use for another task: the token names its record. Unknown, malformed and wrong-secret tokens cost the same; the other refusals need the right secret first and take a read or two longer.
 */
export class TaskCredentialService {
  readonly #runner: CommandRunner;
  readonly #catalog: ActionCatalog;

  private constructor(runner: CommandRunner, catalog: ActionCatalog) { this.#runner = runner; this.#catalog = catalog; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { catalog?: ActionCatalog } = {}): TaskCredentialService {
    return new TaskCredentialService(new CommandRunner(storage, epoch, options), options.catalog ?? ActionCatalog.default);
  }

  /**
   * Issues the credential of an agent for a task, and returns its token once. Issuing again for the same agent and task replaces the earlier one (which stops working at once). Owner only;
   * the task must be open and the agent an active agent principal.
   */
  async issue(owner: Principal, command: NoActor & { taskId: string; agentId: string; expiresAt?: string }): Promise<IssuedTaskCredential> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner issues task credentials`);
    onlyKnown(command, ["commandId", "taskId", "agentId", "expiresAt"]);
    const taskId = checkTaskId(command.taskId);
    const agentId = typeof command.agentId === "string" && /^agent:[a-z0-9][a-z0-9-]{0,39}$/.test(command.agentId) ? command.agentId : invalid("agentId", "is not an agent principal");
    const expiresAt = command.expiresAt === undefined ? undefined : (Number.isNaN(Date.parse(command.expiresAt)) || new Date(Date.parse(command.expiresAt)).toISOString() !== command.expiresAt ? invalid("expiresAt", "must be a UTC time such as 2026-10-21T09:00:00.000Z") : command.expiresAt);
    const task = await this.#openTask(taskId);
    const agent = (await this.#runner.get("principal", agentId))?.body as unknown as PrincipalBody | undefined;
    if (agent === undefined || agent.kind !== "agent" || agent.state !== "active") throw new DomainError("not_found", `${agentId} is not an active agent`);
    const id = derivedId("tcr", `${taskId}|${agentId}`);
    const secret = newSecret();
    const stored = await hashSecret(secret, this.#runner.now());
    const ref: AggregateRef = { kind: "task-credential", id };
    const body: TaskCredentialBody = { agentId, taskId, projectId: task.projectId, credential: stored, state: "active", issuedBy: owner.id, issuedVia: "owner", ...(expiresAt === undefined ? {} : { expiresAt }) };
    // The secret differs every time, so this command is never a replay of an earlier one.
    await this.#runner.command("task-credential.issue", { commandId: scopedCommandId(owner.id, `${command.commandId}.${credentialIdOf(stored)}`), actor: owner.id }, async () => ({
      payload: { id, taskId, agentId, expiresAt: expiresAt ?? null },
      build: async () => {
        const existing = await this.#runner.get("task-credential", id);
        return { ref, creates: existing === undefined, changes: [existing === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: existing.revision, body: body as unknown as JsonObject }], detail: { taskId, agentId, projectId: task.projectId } };
      },
    }));
    return { id, token: `${id}.${secret}` };
  }

  /**
   * Issues the credential of the agent that holds an admitted attempt, for the dispatcher (card H12; owner decision 2026-10-22: the owner gives direction, management decides the details, and the owner
   * is not asked to grant a credential). The caller must be the dispatcher service principal and nobody else (the owner has `issue`); the attempt must be the task's active attempt at the generation
   * now current, held by an active agent, on a task that is still open. The credential is the agent's own grants cut to the task's project and this task (as `issue` makes it) and, when the task's
   * contract states a limit on tools, cut again to that limit: the tool actions in the contract's permission list, with `class.<class>` entries read as the tools the catalogue puts in that class.
   * It carries no grant the agent does not hold. Issuing again for the same attempt replaces the earlier token. The token is returned once and kept nowhere.
   */
  async issueForAttempt(service: Principal, command: NoActor & { attemptId: string; expiresAt?: string }): Promise<IssuedTaskCredential & { agentId: string; limit?: readonly string[] }> {
    await this.#requireDispatcher(service);
    onlyKnown(command, ["commandId", "attemptId", "expiresAt"]);
    const attemptId = typeof command.attemptId === "string" && ATTEMPT.test(command.attemptId) ? command.attemptId : invalid("attemptId", "is not an attempt ID");
    const expiresAt = command.expiresAt === undefined ? undefined : (Number.isNaN(Date.parse(command.expiresAt)) || new Date(Date.parse(command.expiresAt)).toISOString() !== command.expiresAt ? invalid("expiresAt", "must be a UTC time such as 2026-10-21T09:00:00.000Z") : command.expiresAt);
    const held = await this.#heldAttempt(attemptId);
    const task = await this.#openTask(held.taskId);
    const agent = (await this.#runner.get("principal", held.agentId))?.body as unknown as PrincipalBody | undefined;
    if (agent === undefined || agent.kind !== "agent" || agent.state !== "active") throw new DomainError("not_found", `${held.agentId} is not an active agent`);
    const limit = await this.#limitOf(held.taskId, task.projectId);
    const id = derivedId("tcr", `${held.taskId}|${held.agentId}`);
    const secret = newSecret();
    const stored = await hashSecret(secret, this.#runner.now());
    const ref: AggregateRef = { kind: "task-credential", id };
    const body: TaskCredentialBody = { agentId: held.agentId, taskId: held.taskId, projectId: task.projectId, credential: stored, state: "active", issuedBy: service.id, issuedVia: "dispatcher", attemptId, ...(limit === undefined ? {} : { limit }), ...(expiresAt === undefined ? {} : { expiresAt }) };
    await this.#runner.command("task-credential.issue", { commandId: scopedCommandId(service.id, `${command.commandId}.${credentialIdOf(stored)}`), actor: service.id }, async () => ({
      payload: { id, taskId: held.taskId, agentId: held.agentId, attemptId, expiresAt: expiresAt ?? null },
      build: async () => {
        const existing = await this.#runner.get("task-credential", id);
        return { ref, creates: existing === undefined, changes: [existing === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: existing.revision, body: body as unknown as JsonObject }], detail: { taskId: held.taskId, agentId: held.agentId, projectId: task.projectId, attemptId, via: "dispatcher", limited: limit !== undefined } };
      },
    }));
    return { id, token: `${id}.${secret}`, agentId: held.agentId, ...(limit === undefined ? {} : { limit }) };
  }

  /**
   * The agent as the credential issued for this attempt presents it: the same principal `authenticate` would return, for the dispatcher's own use (reviews, MCP authorization and grant checks are
   * made as the agent, never as the dispatcher). With `limit: false` the contract's limit on tools is left off: the tool path judges a call beyond the contract's ceiling by asking, not by refusing. Refused unless that credential is active, unexpired and for this attempt, and the task is open.
   */
  async principalOf(service: Principal, attemptId: string, options: { limit?: boolean } = {}): Promise<Principal> {
    await this.#requireDispatcher(service);
    const attempt = typeof attemptId === "string" && ATTEMPT.test(attemptId) ? attemptId : invalid("attemptId", "is not an attempt ID");
    const held = await this.#attemptRecord(attempt);
    const found = await this.#runner.get("task-credential", derivedId("tcr", `${held.taskId}|${held.agentId}`));
    const body = found?.body as unknown as TaskCredentialBody | undefined;
    if (found === undefined || body === undefined || body.state !== "active" || body.attemptId !== attempt) throw refusal();
    return this.#present(body, options.limit !== false);
  }

  /** Ends the credential issued for an attempt (the attempt is over). The dispatcher only; ending one that is already ended is no change. */
  async endForAttempt(service: Principal, command: NoActor & { attemptId: string; reason: string }): Promise<{ ended: boolean }> {
    await this.#requireDispatcher(service);
    onlyKnown(command, ["commandId", "attemptId", "reason"]);
    const attempt = typeof command.attemptId === "string" && ATTEMPT.test(command.attemptId) ? command.attemptId : invalid("attemptId", "is not an attempt ID");
    const reason = text(command.reason, "reason", { min: 1, max: 500 });
    if (redactText(reason) !== reason) invalid("reason", "looks like a credential or key");
    const held = await this.#attemptRecord(attempt);
    const id = derivedId("tcr", `${held.taskId}|${held.agentId}`);
    const found = await this.#runner.get("task-credential", id);
    const body = found?.body as unknown as TaskCredentialBody | undefined;
    if (found === undefined || body === undefined || body.attemptId !== attempt || body.state === "revoked") return { ended: false };
    const ref: AggregateRef = { kind: "task-credential", id };
    await this.#runner.command("task-credential.end", { commandId: scopedCommandId(service.id, command.commandId), actor: service.id }, async () => ({
      payload: { attemptId: attempt, reason },
      build: async () => ({ ref, creates: false, changes: [{ type: "update", ref, expectedRevision: found.revision, body: { ...body, state: "revoked", revokedBy: service.id, reason } as unknown as JsonObject }], detail: { taskId: body.taskId, agentId: body.agentId, attemptId: attempt } }),
    }));
    return { ended: true };
  }

  /** The owner ends a credential now. Whatever presents it next is refused. */
  async revoke(owner: Principal, command: NoActor & { credentialId: string; expectedRevision: number; reason: string }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} is not the owner; only the owner revokes task credentials`);
    onlyKnown(command, ["commandId", "credentialId", "expectedRevision", "reason"]);
    const id = typeof command.credentialId === "string" && ID.test(command.credentialId) ? command.credentialId : invalid("credentialId", "is not a task credential ID");
    const expected = checkRevision(command.expectedRevision);
    const reason = text(command.reason, "reason", { min: 1, max: 500 });
    if (redactText(reason) !== reason) invalid("reason", "looks like a credential or key");
    await this.#runner.command("task-credential.revoke", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { credentialId: id, expectedRevision: expected, reason },
      build: async () => {
        const current = await this.#runner.existing("task-credential", id, expected);
        const body = current.body as unknown as TaskCredentialBody;
        if (body.state === "revoked") throw new DomainError("invalid_command", `credential ${id} is already revoked`, { field: "credentialId" });
        const ref: AggregateRef = { kind: "task-credential", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...body, state: "revoked", revokedBy: owner.id, reason } as unknown as JsonObject }], detail: { taskId: body.taskId, agentId: body.agentId } };
      },
    }));
  }

  /**
   * The principal a task token proves: the agent, as it is now, acting for the task. Unknown, revoked, expired, wrong-secret, ended-task and disabled-agent cases all look the same.
   */
  async authenticate(token: unknown): Promise<Principal> {
    const dot = typeof token === "string" && token.length <= 400 ? token.lastIndexOf(".") : -1;
    const id = dot > 0 ? (token as string).slice(0, dot) : undefined;
    const secret = dot > 0 ? (token as string).slice(dot + 1) : undefined;
    const found = id === undefined || !ID.test(id) ? undefined : await this.#runner.get("task-credential", id);
    const body = found?.body as unknown as TaskCredentialBody | undefined;
    const ok = await verifySecret(secret, body?.credential);
    if (!ok || found === undefined || body === undefined || body.state !== "active") throw refusal();
    return this.#present(body);
  }

  /** The owner's view of the task credentials (no secrets), optionally for one task. */
  async list(owner: Principal, taskId?: string): Promise<View<Omit<TaskCredentialBody, "credential">>[]> {
    if (owner.kind !== "owner") return [];
    const out: View<Omit<TaskCredentialBody, "credential">>[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("task-credential", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const a of page) {
        after = a.id;
        const { credential: _hidden, ...rest } = a.body as unknown as TaskCredentialBody;
        void _hidden;
        if (taskId === undefined || rest.taskId === taskId) out.push(view<Omit<TaskCredentialBody, "credential">>({ ...a, body: rest as unknown as JsonObject }));
      }
      if (page.length < 200) return out;
    }
  }

  /** The agent as it is now, acting for the credential's task, under the credential's limit. Refused (like a bad token) when the task has ended or the agent is gone or disabled. */
  async #present(body: TaskCredentialBody, withLimit = true): Promise<Principal> {
    const now = this.#runner.now();
    if (body.expiresAt !== undefined && body.expiresAt <= now) throw refusal();
    const task = (await this.#runner.get("task", body.taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || task.projectId !== body.projectId || task.state === "done" || task.state === "cancelled") throw refusal();
    const agent = (await this.#runner.get("principal", body.agentId))?.body as unknown as PrincipalBody | undefined;
    if (agent === undefined || agent.kind !== "agent" || agent.state !== "active") throw refusal();
    return effectiveOf(this.#runner, { id: body.agentId, kind: "agent", name: agent.name, grants: agent.grants, credentialId: credentialIdOf(body.credential), taskScope: { taskId: body.taskId, projectId: body.projectId, ...(!withLimit || body.limit === undefined ? {} : { limit: body.limit }) } }, now);
  }

  /** Only the dispatcher's service principal, as it is now: enrolled, a service, active, and the credential it authenticated with is the current one. */
  async #requireDispatcher(service: Principal): Promise<void> {
    if (service.kind !== "service" || service.id !== DISPATCHER_PRINCIPAL || service.taskScope !== undefined) throw new DomainError("forbidden", `${service.id} is not the dispatcher; only the dispatcher issues task credentials for admitted attempts`);
    const stored = (await this.#runner.get("principal", service.id))?.body as unknown as PrincipalBody | undefined;
    if (service.asOf === undefined || stored === undefined || stored.kind !== "service" || stored.state !== "active" || stored.credential === undefined || service.credentialId !== credentialIdOf(stored.credential)) throw new DomainError("forbidden", `${service.id} is not the dispatcher; only the dispatcher issues task credentials for admitted attempts`);
  }

  async #attemptRecord(attemptId: string): Promise<{ taskId: string; agentId: string; generation: number }> {
    const attempt = (await this.#runner.get("attempt", attemptId))?.body as unknown as { taskId: string; generation: number; owner: { kind: string; id: string } } | undefined;
    if (attempt === undefined || attempt.owner.kind !== "agent") throw new DomainError("not_found", `attempt ${attemptId} is not an attempt of an agent`);
    return { taskId: attempt.taskId, agentId: `agent:${attempt.owner.id}`, generation: attempt.generation };
  }

  /** The attempt, which must be the task's active one at the generation now current. */
  async #heldAttempt(attemptId: string): Promise<{ taskId: string; agentId: string; generation: number }> {
    const held = await this.#attemptRecord(attemptId);
    const attempt = (await this.#runner.get("attempt", attemptId))?.body as unknown as { state: string };
    const assignment = (await this.#runner.get("assignment", `asg-${held.taskId.slice(5)}`))?.body as unknown as { state: string; generation: number; activeAttemptId?: string; owner?: { kind: string; id: string } } | undefined;
    if (attempt.state !== "active" || assignment === undefined || assignment.state !== "assigned" || assignment.activeAttemptId !== attemptId || assignment.generation !== held.generation || `agent:${assignment.owner?.id}` !== held.agentId) {
      throw new DomainError("fenced", `attempt ${attemptId} is not the active attempt of ${held.agentId} at the current generation of its task; no credential is issued for it`, { field: "attemptId" });
    }
    return held;
  }

  /** The tools the task's contract allows, or `undefined` when it states no permission list. Entries `tool.x` and `tool.*` are kept; `class.x` becomes the tools the catalogue puts in that class. */
  async #limitOf(taskId: string, projectId: string): Promise<readonly string[] | undefined> {
    const contract = (await this.#runner.get("task-contract", taskId))?.body as unknown as { projectId: string; permissions?: readonly string[] } | undefined;
    if (contract === undefined || contract.projectId !== projectId || contract.permissions === undefined || contract.permissions.length === 0) return undefined;
    const tools = new Set<string>();
    for (const entry of contract.permissions) {
      if (entry === "tool.*" || entry === "*") tools.add("tool.*");
      else if (entry.startsWith("tool.")) tools.add(entry);
      else if (entry.startsWith("class.")) for (const name of this.#catalog.toolsOf(entry.slice(6))) tools.add(`tool.${name}`);
    }
    return [...tools].sort();
  }

  async #openTask(taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
    if (task.state === "done" || task.state === "cancelled") throw new DomainError("invalid_transition", `task ${taskId} is ${task.state}; it has no work left to credential`);
    return task;
  }
}
