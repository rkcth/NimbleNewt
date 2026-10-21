import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, projectId as checkProjectId, taskId as checkTaskId, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import { effectiveOf } from "../security/grants.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";

export type ScopeType = "task" | "chat" | "meeting";
export type EntryRole = "user" | "agent" | "system" | "tool";
const ROLES: readonly EntryRole[] = ["user", "agent", "system", "tool"];

/** One separate history (kind `history-scope`): the task's own, or a chat, or a meeting. Entries of different scopes are never mixed. */
export interface ScopeBody {
  readonly type: ScopeType;
  readonly projectId: string;
  /** For a task history, the task. For a chat or meeting, an optional task it is about (a pointer only: its entries stay in its own scope). */
  readonly taskId?: string;
  /** Principals that may read and write a chat or meeting. A task history has none: access follows the project and task. */
  readonly participants: readonly string[];
  readonly createdBy: string;
  /** Entries so far; the next is `count + 1`. */
  readonly count: number;
}

export interface EntryBody {
  readonly scope: string;
  readonly seq: number;
  readonly role: EntryRole;
  readonly author: string;
  readonly text: string;
}

export interface OpenScope extends NoActor {
  readonly type: "chat" | "meeting";
  readonly projectId: string;
  readonly taskId?: string;
  /** The other participants (the opener is always one). Each must be an existing principal. */
  readonly participants: readonly string[];
}

export interface AppendEntry extends NoActor {
  /** Optional. The role is derived from the principal (the owner speaks as `user`, an agent as `agent`); a different role is refused. `system` and `tool` entries come only from the controller's own path. */
  readonly role?: EntryRole;
  readonly text: string;
}

export const HISTORY_LIMITS = { text: 8000, participants: 50, page: 500 } as const;
const SCOPE_ID = /^hst-[a-z2-7]{20}$/;
const PRINCIPAL = /^(?:owner|agent|host):[a-z0-9][a-z0-9-]{0,39}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const pad = (n: number): string => String(n).padStart(10, "0");
const entryId = (scope: string, seq: number): string => `${scope}.${pad(seq)}`;

/**
 * Separate durable histories (card C01): a task has its own, and a chat or a meeting has its own; entries are appended in order with no gaps and belong to one scope only, so a side
 * conversation cannot add to a task's history and a meeting cannot read a private chat.
 * - **Task history** follows the project: `history.append` / `history.read` in the task's project (the project is found from the stored task, not from the caller).
 * - **Chat and meeting histories** are for their participants (and the installation owner): a principal outside the list is refused, whatever it holds.
 * - Text that looks like a credential is refused, and nothing here is an instruction to anyone.
 */
export class HistoryService {
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) {
    this.#runner = runner;
  }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): HistoryService {
    return new HistoryService(new CommandRunner(storage, epoch, options));
  }

  /** The ID of a task's history scope: derived from the task, so it is the same for everyone. */
  static taskScopeId(taskId: string): string { return derivedId("hst", `task\0${taskId}`); }

  /** Opens a chat or a meeting. The opener needs `history.append` in the project. */
  async openScope(principal: Principal, command: OpenScope): Promise<{ id: string; replayed: boolean }> {
    return this.#runner.command("history.open", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "type", "projectId", "taskId", "participants"]);
      const type = command.type === "chat" || command.type === "meeting" ? command.type : invalid("type", "must be chat or meeting (a task's history needs no opening)");
      const projectId = checkProjectId(command.projectId);
      const taskId = command.taskId === undefined ? undefined : checkTaskId(command.taskId);
      if (!Array.isArray(command.participants) || command.participants.length > HISTORY_LIMITS.participants) invalid("participants", `must be a list of at most ${HISTORY_LIMITS.participants} principals`);
      for (const [i, p] of command.participants.entries()) if (typeof p !== "string" || !PRINCIPAL.test(p)) invalid(`participants[${i}]`, "is not a principal ID");
      if (!allows(principal, "history.append", projectId)) throw new DomainError("forbidden", `${principal.id} may not history.append in ${projectId}`);
      const participants = [...new Set([principal.id, ...command.participants])].sort();
      return {
        payload: { type, projectId, ...(taskId === undefined ? {} : { taskId }), participants },
        build: async () => {
          if ((await this.#runner.get("project", projectId)) === undefined) throw new DomainError("not_found", `project ${projectId} does not exist`);
          if (taskId !== undefined && (await this.#runner.get("task", taskId).then((t) => (t?.body as { projectId?: string } | undefined)?.projectId)) !== projectId) throw new DomainError("invalid_command", `task ${taskId} is not in project ${projectId}`, { field: "taskId" });
          for (const p of participants) {
            const stored = await this.#runner.get("principal", p);
            if (stored === undefined) throw new DomainError("invalid_command", `participants: ${p} is not an enrolled principal`, { field: "participants" });
            const body = stored.body as unknown as { kind: Principal["kind"]; name: string; grants: Principal["grants"]; state: string };
            // A chat carries the project's information, so each participant must be someone who may read the project's histories.
            if (body.state !== "active" || !allows(await effectiveOf(this.#runner, { id: p, kind: body.kind, name: body.name, grants: body.grants }, this.#runner.now()), "history.read", projectId)) throw new DomainError("invalid_command", `participants: ${p} may not read the histories of project ${projectId}`, { field: "participants" });
          }
          const ref: AggregateRef = { kind: "history-scope", id: derivedId("hst", `${type}\0${scopedCommandId(principal.id, command.commandId)}`) };
          const body: ScopeBody = { type, projectId, ...(taskId === undefined ? {} : { taskId }), participants, createdBy: principal.id, count: 0 };
          return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { type, projectId } };
        },
      };
    }).then((r) => ({ id: r.id, replayed: r.replayed }));
  }

  /** Appends one entry to a scope. The author is the principal; the sequence number is assigned in order, with none skipped. */
  async append(principal: Principal, scopeId: string, command: AppendEntry & { taskId?: string }): Promise<{ seq: number; replayed: boolean }> {
    // Two appends at once: the later one finds the count moved and nothing was written, so it simply tries again with the same command.
    for (let attempt = 1; ; attempt++) {
      try { return await this.#appendOnce(principal, scopeId, command); } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || attempt >= 12) throw error;
      }
    }
  }

  async #appendOnce(principal: Principal, scopeId: string, command: AppendEntry & { taskId?: string }): Promise<{ seq: number; replayed: boolean }> {
    return this.#runner.command("history.append", { commandId: scopedCommandId(principal.id, command.commandId), actor: principal.id }, async () => {
      onlyKnown(command, ["commandId", "role", "text", "taskId"]);
      const derived: EntryRole = principal.kind === "owner" ? "user" : "agent";
      if (command.role !== undefined && !(ROLES as readonly string[]).includes(command.role)) invalid("role", `must be one of ${ROLES.join(", ")}`);
      if (command.role !== undefined && command.role !== derived) throw new DomainError("forbidden", `${principal.id} speaks as ${derived}, not ${command.role}`);
      const role = derived;
      const body = text(command.text, "text", { min: 1, max: HISTORY_LIMITS.text, multiline: true });
      if (redactText(body) !== body) invalid("text", "looks like a credential or key; those are not recorded in a history");
      return {
        payload: { scopeId, role, text: body, ...(command.taskId === undefined ? {} : { taskId: command.taskId }) },
        build: async () => {
          const scope = await this.#scopeFor(principal, scopeId, command.taskId, "append");
          const next = scope.current === undefined ? 1 : scope.current.count + 1;
          const ref: AggregateRef = { kind: "history-scope", id: scopeId };
          const entry: EntryBody = { scope: scopeId, seq: next, role, author: principal.id, text: body };
          const updated: ScopeBody = { ...scope.body, count: next };
          const scopeChange: Change = scope.revision === undefined
            ? { type: "create", ref, body: updated as unknown as JsonObject }
            : { type: "update", ref, expectedRevision: scope.revision, body: updated as unknown as JsonObject };
          const entryRef: AggregateRef = { kind: "history-entry", id: entryId(scopeId, next) };
          return {
            ref: entryRef, creates: true, changes: [scopeChange, { type: "create", ref: entryRef, body: entry as unknown as JsonObject }], detail: { scope: scopeId, seq: next },
            contention: async () => new DomainError("stale_revision", `the history ${scopeId} changed meanwhile; append again`),
          };
        },
      };
    }).then((r) => ({ seq: Number(r.id.slice(r.id.lastIndexOf(".") + 1)), replayed: r.replayed }));
  }

  /** Entries after `afterSeq`, in order. A scope the principal may not read looks the same as one that does not exist (except to the installation owner). */
  async read(principal: Principal, scopeId: string, query: { afterSeq?: number; limit: number; taskId?: string }): Promise<{ entries: View<EntryBody>[]; count: number }> {
    if (!Number.isSafeInteger(query.limit) || query.limit < 1 || query.limit > HISTORY_LIMITS.page) throw new DomainError("invalid_command", `limit: must be a whole number from 1 to ${HISTORY_LIMITS.page}`, { field: "limit" });
    const after = query.afterSeq ?? 0;
    if (!Number.isSafeInteger(after) || after < 0) throw new DomainError("invalid_command", "afterSeq: must be a whole number", { field: "afterSeq" });
    const scope = await this.#scopeFor(principal, scopeId, query.taskId, "read");
    const count = scope.current?.count ?? 0;
    const entries: View<EntryBody>[] = [];
    let cursor = entryId(scopeId, after);
    const prefix = `${scopeId}.`;
    while (entries.length < query.limit) {
      const page = await this.#runner.list("history-entry", { afterId: cursor, limit: Math.min(200, query.limit - entries.length) });
      for (const aggregate of page) {
        if (!aggregate.id.startsWith(prefix)) return { entries, count };
        entries.push(view<EntryBody>(aggregate));
        cursor = aggregate.id;
      }
      if (page.length === 0) break;
    }
    return { entries, count };
  }

  async getScope(principal: Principal, scopeId: string, taskId?: string): Promise<View<ScopeBody> | undefined> {
    await this.#scopeFor(principal, scopeId, taskId, "read");
    const found = await this.#runner.get("history-scope", scopeId);
    return found === undefined ? undefined : view<ScopeBody>(found);
  }

  /**
   * Finds the scope and checks the principal's access to it. A task's scope is created by its first append: for that, the caller names the task (`taskId`) and the scope ID must be the one
   * derived from it. The project is always taken from the stored task or scope.
   */
  async #scopeFor(principal: Principal, scopeId: string, taskId: string | undefined, mode: "append" | "read"): Promise<{ body: ScopeBody; revision: number | undefined; current: ScopeBody | undefined }> {
    const missing = (): never => { throw principal.kind === "owner" ? new DomainError("not_found", "no such history") : new DomainError("forbidden", `${principal.id} may not use that history`); };
    if (typeof scopeId !== "string" || !SCOPE_ID.test(scopeId)) return missing();
    const found = await this.#runner.get("history-scope", scopeId);
    if (found !== undefined) {
      const body = found.body as unknown as ScopeBody;
      if (!this.#mayUse(principal, body, mode)) return missing();
      return { body, revision: found.revision, current: body };
    }
    // Not yet created: only a task's history is created by use.
    if (taskId === undefined || HistoryService.taskScopeId(checkTaskId(taskId)) !== scopeId) return missing();
    const task = await this.#runner.get("task", taskId);
    const projectId = (task?.body as { projectId?: string } | undefined)?.projectId;
    if (projectId === undefined) return missing();
    const body: ScopeBody = { type: "task", projectId, taskId, participants: [], createdBy: principal.id, count: 0 };
    if (!this.#mayUse(principal, body, mode)) return missing();
    return { body, revision: undefined, current: undefined };
  }

  #mayUse(principal: Principal, scope: ScopeBody, mode: "append" | "read"): boolean {
    const action = mode === "append" ? "history.append" : "history.read";
    if (scope.type === "task") return allows(principal, action, scope.projectId);
    // A chat or meeting belongs to its participants, who must also still hold the project's history access (revoking a grant ends the access). The installation owner may always take part.
    return principal.kind === "owner" || (scope.participants.includes(principal.id) && allows(principal, action, scope.projectId));
  }
}
