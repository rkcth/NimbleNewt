import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { checkLocalWorkerLimits, defaultWorkspaceLimits, type LocalWorkerLimits } from "./worker-limits.js";

const REF = { kind: "worker-limits-settings", id: "main" } as const;

export interface WorkerLimitsSettingsBody {
  /** The figures the owner set; a figure not here falls back to the start-up configuration. */
  readonly limits: LocalWorkerLimits;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/**
 * What one local agent may use, as the owner sets it (card H12k): cpus, memoryMb, diskMb, processes, with the same bounds as the start-up `dispatch.local.limits`. The owner's figures win over the start-up ones per figure.
 * Owner only, validated, race-safe (`expectedRevision`). `effective()` is what the host builder reads when it opens an agent's workspace, so a change counts from the next agent launched; agents already running keep what they started with.
 * `effective()` throws when the setting cannot be read: the caller must refuse the launch rather than run without limits.
 */
export class WorkerLimitsSettingsService {
  readonly #runner: CommandRunner;
  readonly #startup: LocalWorkerLimits | undefined;

  private constructor(runner: CommandRunner, startup: LocalWorkerLimits | undefined) { this.#runner = runner; this.#startup = startup; }

  static withEpoch(storage: ControllerStorage, epoch: number, startup: LocalWorkerLimits | undefined, options: RunnerOptions = {}): WorkerLimitsSettingsService {
    return new WorkerLimitsSettingsService(new CommandRunner(storage, epoch, options), startup);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly limits: LocalWorkerLimits; readonly startup: LocalWorkerLimits; readonly effective: LocalWorkerLimits }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the limits for local agents`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const limits = (found?.body as unknown as WorkerLimitsSettingsBody | undefined)?.limits ?? {};
    return { revision: found?.revision ?? 0, limits, startup: this.#startup ?? {}, effective: defaultWorkspaceLimits(this.#startup, limits) ?? {} };
  }

  /** The owner's figures replace the earlier ones; an empty `limits` clears the setting (the start-up figures then apply). */
  async set(owner: Principal, command: NoActor & { limits?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the limits for local agents`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "limits", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.limits === undefined) throw new DomainError("invalid_command", "limits: name the figures (cpus, memoryMb, diskMb, processes); an empty object clears them", { field: "limits" });
    let limits: LocalWorkerLimits;
    try { limits = checkLocalWorkerLimits(command.limits, "limits") ?? {}; } catch (e) { throw new DomainError("invalid_command", (e as Error).message, { field: "limits" }); }
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("workers.limits.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { limits: limits as unknown as JsonObject, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the limits setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const next: WorkerLimitsSettingsBody = { limits, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { figures: Object.keys(limits).length } };
      },
    }));
    return { revision: result.revision };
  }

  /** The limits to give an agent being launched now: start-up figures with the owner's over them. Re-checked on read, so a damaged record throws rather than being used. */
  async effective(): Promise<LocalWorkerLimits | undefined> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return defaultWorkspaceLimits(this.#startup, (found?.body as unknown as WorkerLimitsSettingsBody | undefined)?.limits);
  }
}
