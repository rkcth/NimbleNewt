import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "local-host-settings", id: "main" } as const;

export interface LocalHostSettingBody { readonly enabled: boolean; readonly updatedBy: string; readonly updatedAt: string }

/**
 * Whether the launcher starts a worker host on this machine (card U14b): off until the owner turns it on, owner only, race-safe (`expectedRevision`) and replay-safe (command ID). The launcher reads it when it starts,
 * so a change counts from the next start (the answer says so). It chooses nothing about models: the host's routes come only from the providers the owner configured, and no model is loaded or switched by it.
 */
export class LocalHostSettingService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): LocalHostSettingService { return new LocalHostSettingService(new CommandRunner(storage, epoch, options)); }

  async get(by: Principal): Promise<{ readonly revision: number; readonly enabled: boolean; readonly default: false; readonly takesEffect: "at the next start" }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the local host setting`);
    const found = await this.#runner.get(REF.kind, REF.id);
    return { revision: found?.revision ?? 0, enabled: await this.enabled(), default: false, takesEffect: "at the next start" };
  }

  async set(owner: Principal, command: NoActor & { enabled?: unknown; expectedRevision?: number }): Promise<{ revision: number; enabled: boolean; takesEffect: "at the next start" }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the local host setting`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "enabled", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (typeof command.enabled !== "boolean") throw new DomainError("invalid_command", "enabled: must be true or false", { field: "enabled" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const enabled = command.enabled;
    const result = await this.#runner.command("host.local.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { enabled, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the local host setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const next: LocalHostSettingBody = { enabled, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { enabled } };
      },
    }));
    return { revision: result.revision, enabled, takesEffect: "at the next start" };
  }

  /** What applies now: off unless the owner turned it on. A damaged record is off (nothing starts on a guess). */
  async enabled(): Promise<boolean> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return found !== undefined && (found.body as unknown as { enabled?: unknown }).enabled === true;
  }
}
