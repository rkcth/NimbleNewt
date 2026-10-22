import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision, taskId as checkTaskId, text, type TaskBody, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";
import { credentialIdOf, hashSecret, newSecret, scopedCommandId, verifySecret, type StoredCredential } from "./credentials.js";
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
}

export interface IssuedTaskCredential { readonly id: string; readonly token: string }

const ID = /^tcr-[a-z2-7]{20}$/;
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

  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): TaskCredentialService {
    return new TaskCredentialService(new CommandRunner(storage, epoch, options));
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
    const body: TaskCredentialBody = { agentId, taskId, projectId: task.projectId, credential: stored, state: "active", issuedBy: owner.id, ...(expiresAt === undefined ? {} : { expiresAt }) };
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
    const now = this.#runner.now();
    if (body.expiresAt !== undefined && body.expiresAt <= now) throw refusal();
    const task = (await this.#runner.get("task", body.taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined || task.projectId !== body.projectId || task.state === "done" || task.state === "cancelled") throw refusal();
    const agent = (await this.#runner.get("principal", body.agentId))?.body as unknown as PrincipalBody | undefined;
    if (agent === undefined || agent.kind !== "agent" || agent.state !== "active") throw refusal();
    return effectiveOf(this.#runner, { id: body.agentId, kind: "agent", name: agent.name, grants: agent.grants, credentialId: credentialIdOf(body.credential), taskScope: { taskId: body.taskId, projectId: body.projectId } }, now);
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

  async #openTask(taskId: string): Promise<TaskBody> {
    const task = (await this.#runner.get("task", taskId))?.body as unknown as TaskBody | undefined;
    if (task === undefined) throw new DomainError("not_found", `task ${taskId} does not exist`);
    if (task.state === "done" || task.state === "cancelled") throw new DomainError("invalid_transition", `task ${taskId} is ${task.state}; it has no work left to credential`);
    return task;
  }
}
