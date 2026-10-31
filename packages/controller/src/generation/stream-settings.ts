import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "generation-stream-settings", id: "main" } as const;
/** `record`: the model stream of each call is recorded against its generation. `cut`: a reply whose generation was interrupted is held back from the worker. */
export const STREAM_SETTINGS = ["record", "cut"] as const;
export type StreamSetting = (typeof STREAM_SETTINGS)[number];
export interface StreamSettingsView { readonly revision: number; readonly record: boolean; readonly cut: boolean }

/**
 * The owner's switches for feeding the model stream into revision-bound generation (card L05b). Neither is a limit or a budget; both are ON unless the owner turns them off (recording is what makes a late reply visible and holdable;
 * the cut is what keeps it from the worker). Owner only, race-safe through `expectedRevision`, replay-safe. A setting that cannot be read leaves both on (the safe side).
 */
export class StreamSettingsService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): StreamSettingsService { return new StreamSettingsService(new CommandRunner(storage, epoch, options)); }

  async get(by: Principal): Promise<StreamSettingsView> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the model stream settings`);
    return this.effective();
  }

  /** What applies now; no principal needed (the controller's own read). */
  async effective(): Promise<StreamSettingsView> {
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as { record?: unknown; cut?: unknown } | undefined;
    return { revision: found?.revision ?? 0, record: body?.record !== false, cut: body?.cut !== false };
  }

  async change(owner: Principal, command: NoActor & { enable?: unknown; disable?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the model stream settings`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "enable", "disable", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    const names = (v: unknown, field: string): StreamSetting[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((n) => !(STREAM_SETTINGS as readonly unknown[]).includes(n))) throw new DomainError("invalid_command", `${field}: must be a list of ${STREAM_SETTINGS.join(", ")}`, { field });
      return [...new Set(v as StreamSetting[])];
    };
    const enable = names(command.enable, "enable"), disable = names(command.disable, "disable");
    if (enable.length + disable.length === 0) throw new DomainError("invalid_command", "enable: name at least one setting to turn on or off", { field: "enable" });
    for (const n of enable) if (disable.includes(n)) throw new DomainError("invalid_command", `enable: ${n} is named in both enable and disable`, { field: "enable" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("generation.stream.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { enable, disable, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the model stream settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = current?.body as unknown as { record?: unknown; cut?: unknown } | undefined;
        const next: Record<StreamSetting, boolean> = { record: before?.record !== false, cut: before?.cut !== false };
        for (const n of enable) next[n] = true;
        for (const n of disable) next[n] = false;
        const body = { ...next, updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref: REF, body } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { record: next.record, cut: next.cut } };
      },
    }));
    return { revision: result.revision };
  }
}
