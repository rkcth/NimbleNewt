import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "generation-stream-settings", id: "main" } as const;
/**
 * `record`: the model stream of each call is recorded against its generation. `cut`: a reply whose generation was interrupted is held back from the worker. `failClosed`: when the store cannot answer (it errors or does not
 * answer in time) a call is not sent and a reply being read is cut, with the reason shown; off ("open"): the call and the reply go on unrecorded and the reason is reported.
 */
export const STREAM_SETTINGS = ["record", "cut", "failClosed"] as const;
export type StreamSetting = (typeof STREAM_SETTINGS)[number];
/** Numeric settings: 0 turns the limit off. */
export const STREAM_VALUES = {
  /** How long one store call may take before it counts as failed (default 20 s). */
  storeTimeoutMs: { default: 20_000, max: 3_600_000 },
  /** The recorded stream is written at least this often while a reply streams (default 250 ms; 0: every piece). */
  batchMs: { default: 250, max: 60_000 },
  /** ... and when this many characters are waiting (default 2000; 0: every piece). */
  batchChars: { default: 2000, max: 65_536 },
  /** The most a reply that cannot yet be told from a whole one is held in memory (default 16 MB; 0: no cap). */
  heldBufferBytes: { default: 16 * 1024 * 1024, max: 1024 * 1024 * 1024 },
} as const;
export type StreamValue = keyof typeof STREAM_VALUES;
export interface StreamSettingsView {
  readonly revision: number;
  readonly record: boolean;
  readonly cut: boolean;
  /** The fail mode `onStoreFailure`: "closed" (default) or "open". */
  readonly onStoreFailure: "open" | "closed";
  readonly failClosed: boolean;
  readonly storeTimeoutMs: number;
  readonly batchMs: number;
  readonly batchChars: number;
  readonly heldBufferBytes: number;
}

type Stored = { record?: unknown; cut?: unknown; failClosed?: unknown } & Partial<Record<StreamValue, unknown>>;
const valueOf = (body: Stored | undefined, name: StreamValue): number => { const v = body?.[name]; return typeof v === "number" && Number.isSafeInteger(v) && v >= 0 && v <= STREAM_VALUES[name].max ? v : STREAM_VALUES[name].default; };
export const viewOf = (found: { revision: number; body: unknown } | undefined): StreamSettingsView => {
  const body = found?.body as Stored | undefined;
  const failClosed = body?.failClosed !== false;
  return { revision: found?.revision ?? 0, record: body?.record !== false, cut: body?.cut !== false, onStoreFailure: failClosed ? "closed" : "open", failClosed, storeTimeoutMs: valueOf(body, "storeTimeoutMs"), batchMs: valueOf(body, "batchMs"), batchChars: valueOf(body, "batchChars"), heldBufferBytes: valueOf(body, "heldBufferBytes") };
};

/**
 * The owner's settings for feeding the model stream into revision-bound generation (card L05b). The switches are ON unless the owner turns them off (recording is what makes a late reply visible and holdable; the cut keeps it from
 * the worker; `failClosed` is the safer side when the store cannot be asked: no call goes out that could not be bound to a revision). The numbers are limits, all optional (0 turns one off). Owner only, race-safe through
 * `expectedRevision`, replay-safe. A setting that cannot be read leaves the defaults.
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
  async effective(): Promise<StreamSettingsView> { return viewOf(await this.#runner.get(REF.kind, REF.id)); }

  async change(owner: Principal, command: NoActor & { enable?: unknown; disable?: unknown; set?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the model stream settings`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "enable", "disable", "set", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    const names = (v: unknown, field: string): StreamSetting[] => {
      if (v === undefined) return [];
      if (!Array.isArray(v) || v.some((n) => !(STREAM_SETTINGS as readonly unknown[]).includes(n))) throw new DomainError("invalid_command", `${field}: must be a list of ${STREAM_SETTINGS.join(", ")}`, { field });
      return [...new Set(v as StreamSetting[])];
    };
    const enable = names(command.enable, "enable"), disable = names(command.disable, "disable");
    const set: Partial<Record<StreamValue, number>> = {};
    if (command.set !== undefined) {
      if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set)) throw new DomainError("invalid_command", "set: must be an object of numbers", { field: "set" });
      for (const [k, v] of Object.entries(command.set)) {
        if (!(k in STREAM_VALUES)) throw new DomainError("invalid_command", `set.${k}: is not a setting (${Object.keys(STREAM_VALUES).join(", ")})`, { field: "set" });
        const spec = STREAM_VALUES[k as StreamValue];
        if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > spec.max) throw new DomainError("invalid_command", `set.${k}: must be a whole number from 0 (off) to ${spec.max}`, { field: "set" });
        set[k as StreamValue] = v;
      }
    }
    if (enable.length + disable.length + Object.keys(set).length === 0) throw new DomainError("invalid_command", "enable: name at least one setting to turn on or off, or give set", { field: "enable" });
    for (const n of enable) if (disable.includes(n)) throw new DomainError("invalid_command", `enable: ${n} is named in both enable and disable`, { field: "enable" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("generation.stream.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { enable, disable, set: set as JsonObject, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the model stream settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = viewOf(current);
        const next: Record<StreamSetting, boolean> & Record<StreamValue, number> = { record: before.record, cut: before.cut, failClosed: before.failClosed, storeTimeoutMs: before.storeTimeoutMs, batchMs: before.batchMs, batchChars: before.batchChars, heldBufferBytes: before.heldBufferBytes };
        for (const n of enable) next[n] = true;
        for (const n of disable) next[n] = false;
        for (const [k, v] of Object.entries(set)) next[k as StreamValue] = v;
        const body = { ...next, updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref: REF, body } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body };
        return { ref: REF, creates: current === undefined, changes: [change], detail: next as unknown as JsonObject };
      },
    }));
    return { revision: result.revision };
  }
}
