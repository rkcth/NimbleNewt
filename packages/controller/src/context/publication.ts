import { DomainError } from "../domain/errors.js";
import { onlyKnown, projectId as checkProjectId, revision as checkRevision, text, type View } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

/** An opening the owner has made for work records to move from one project to another (card A10). It is one-way and can be closed again. */
export interface PublicationPathBody {
  readonly fromProject: string;
  readonly toProject: string;
  readonly state: "open" | "closed";
  readonly reason: string;
  readonly openedBy: string;
  readonly openedAt: string;
  readonly closedAt?: string;
}

export const pathIdOf = (from: string, to: string): string => `${from}.${to}`;

/**
 * Publication paths between projects (card A10). An agent that serves several projects cannot move one project's records into another on its own: access to a source does not authorize
 * sending it elsewhere. The owner opens a path from one project to another (one direction), and only then can a record of the first be cited by, or copied into, the second. Closing a path
 * stops later citations and copies; it cannot take back what was already copied.
 */
export class PublicationService {
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): PublicationService {
    return new PublicationService(new CommandRunner(storage, epoch, options));
  }

  /** The owner opens (or reopens) a path from one project to another. */
  async open(owner: Principal, command: NoActor & { fromProject: string; toProject: string; reason: string }): Promise<{ revision: number; replayed: boolean }> {
    this.#owner(owner);
    onlyKnown(command, ["commandId", "fromProject", "toProject", "reason"]);
    const from = checkProjectId(command.fromProject); const to = checkProjectId(command.toProject);
    if (from === to) throw new DomainError("invalid_command", "fromProject: a path joins two different projects", { field: "fromProject" });
    const reason = text(command.reason, "reason", { min: 1, max: 500 });
    if (redactText(reason) !== reason) throw new DomainError("invalid_command", "reason: looks like a credential or key", { field: "reason" });
    const id = pathIdOf(from, to);
    const r = await this.#runner.command("publication.open", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { from, to, reason },
      build: async () => {
        for (const p of [from, to]) if ((await this.#runner.get("project", p)) === undefined) throw new DomainError("not_found", `project ${p} does not exist`);
        const ref: AggregateRef = { kind: "publication-path", id };
        const current = await this.#runner.get("publication-path", id);
        const body: PublicationPathBody = { fromProject: from, toProject: to, state: "open", reason, openedBy: owner.id, openedAt: this.#runner.now() };
        if (current === undefined) return { ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }], detail: { from, to } };
        if ((current.body as unknown as PublicationPathBody).state === "open") throw new DomainError("invalid_command", `a path from ${from} to ${to} is already open`, { field: "toProject" });
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { from, to, reopened: true } };
      },
    }));
    return { revision: r.revision, replayed: r.replayed };
  }

  /** The owner closes a path. */
  async close(owner: Principal, command: NoActor & { fromProject: string; toProject: string; expectedRevision: number }): Promise<void> {
    this.#owner(owner);
    onlyKnown(command, ["commandId", "fromProject", "toProject", "expectedRevision"]);
    const from = checkProjectId(command.fromProject); const to = checkProjectId(command.toProject);
    const expected = checkRevision(command.expectedRevision);
    await this.#runner.command("publication.close", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { from, to, expectedRevision: expected },
      build: async () => {
        const id = pathIdOf(from, to);
        const current = await this.#runner.existing("publication-path", id, expected);
        const body = current.body as unknown as PublicationPathBody;
        if (body.state !== "open") throw new DomainError("invalid_command", `the path from ${from} to ${to} is already closed`, { field: "toProject" });
        const ref: AggregateRef = { kind: "publication-path", id };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...body, state: "closed", closedAt: this.#runner.now() } as unknown as JsonObject }], detail: { from, to } };
      },
    }));
  }

  /** Whether records may move from one project to another now. A project always joins itself. */
  async isOpen(from: string, to: string): Promise<boolean> {
    if (from === to) return true;
    const found = await this.#runner.get("publication-path", pathIdOf(from, to));
    return (found?.body as unknown as PublicationPathBody | undefined)?.state === "open";
  }

  /** The path, for the owner. */
  async get(owner: Principal, from: string, to: string): Promise<View<PublicationPathBody> | undefined> {
    if (owner.kind !== "owner") return undefined;
    const found = await this.#runner.get("publication-path", pathIdOf(checkProjectId(from), checkProjectId(to)));
    return found === undefined ? undefined : view<PublicationPathBody>(found);
  }

  #owner(p: Principal): void { if (p.kind !== "owner") throw new DomainError("forbidden", `${p.id} is not the owner; only the owner opens or closes paths between projects`); }
}
