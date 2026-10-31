import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "cleanup-settings", id: "main" } as const;

/** What happens to the controller-created scratch workspace when an attempt ends: removed once everything important was handed onward (the default), or always kept. */
export const SCRATCH_MODES = ["after-handoff", "keep"] as const;
export type ScratchMode = (typeof SCRATCH_MODES)[number];
export const SCRATCH_DEFAULT: ScratchMode = "after-handoff";
const NAMES = ["scratch"] as const;
type Name = (typeof NAMES)[number];

export interface CleanupSettingsBody { readonly scratch?: ScratchMode; readonly updatedBy: string; readonly updatedAt: string }

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const mode = (v: unknown): v is ScratchMode => typeof v === "string" && (SCRATCH_MODES as readonly string[]).includes(v);
const names = (v: unknown, field: string): Name[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return invalid(field, "must be a list of setting names (scratch)");
  return [...new Set(v.map((k) => (k === "scratch" ? (k as Name) : invalid(field, `${String(k).slice(0, 30)} is not a cleanup setting (scratch)`))))];
};

/**
 * What happens to an attempt's scratch workspace when the attempt ends (owner decision 2026-10-30): `scratch` is `after-handoff` (default: remove it once the work was handed onward) or `keep` (never remove it).
 * `disable` is `keep`, `enable` is `after-handoff`, `unset` forgets the owner's entry so the start-up default applies. Owner only, race-safe (`expectedRevision`), replay-safe.
 * `effective()` is read at each cleanup; a stored value that is damaged FAILS CLOSED to `keep` (nothing is deleted on a guess) until the owner changes the setting.
 */
export class CleanupSettingsService {
  readonly #runner: CommandRunner;
  readonly #startup: ScratchMode;
  readonly #warn: ((damage: { readonly revision: number; readonly detail: string }) => Promise<void>) | undefined;
  private constructor(runner: CommandRunner, startup: ScratchMode, warn: ((damage: { readonly revision: number; readonly detail: string }) => Promise<void>) | undefined) { this.#runner = runner; this.#startup = startup; this.#warn = warn; }

  static withEpoch(storage: ControllerStorage, epoch: number, startup: ScratchMode = SCRATCH_DEFAULT, options: RunnerOptions & { warn?: (damage: { readonly revision: number; readonly detail: string }) => Promise<void> } = {}): CleanupSettingsService {
    if (!mode(startup)) throw new RangeError("scratch must be after-handoff or keep");
    return new CleanupSettingsService(new CommandRunner(storage, epoch, options), startup, options.warn);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly scratch: ScratchMode | null; readonly default: ScratchMode; readonly effective: { readonly scratch: ScratchMode }; readonly damaged?: true }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the cleanup setting`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const read = this.#read(found?.body);
    return { revision: found?.revision ?? 0, scratch: read.value ?? null, default: this.#startup, effective: await this.effective(), ...(read.damaged ? { damaged: true as const } : {}) };
  }

  async change(owner: Principal, command: NoActor & { set?: unknown; enable?: unknown; disable?: unknown; unset?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the cleanup setting`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "set", "enable", "disable", "unset", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    let setTo: ScratchMode | undefined;
    if (command.set !== undefined) {
      if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set)) invalid("set", "must be an object such as { \"scratch\": \"keep\" }");
      for (const [k, v] of Object.entries(command.set as object)) {
        if (k !== "scratch") invalid("set", `${k.slice(0, 30)} is not a cleanup setting (scratch)`);
        if (!mode(v)) invalid("set", "scratch must be after-handoff or keep");
        setTo = v as ScratchMode;
      }
    }
    const enable = names(command.enable, "enable"), disable = names(command.disable, "disable"), unset = names(command.unset, "unset");
    const given = (setTo === undefined ? 0 : 1) + enable.length + disable.length + unset.length;
    if (given === 0) invalid("set", "name the scratch setting to set, enable, disable or unset");
    if (given > 1) invalid("set", "scratch is named once across set, enable, disable and unset");
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) invalid("expectedRevision", "must be a whole number");
    const next: ScratchMode | null = setTo ?? (enable.length > 0 ? "after-handoff" : disable.length > 0 ? "keep" : null);
    const result = await this.#runner.command("cleanup.settings.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { scratch: next, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the cleanup setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const body = { ...(next === null ? {} : { scratch: next }), updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref: REF, body } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { scratch: next } };
      },
    }));
    return { revision: result.revision };
  }

  #read(body: unknown): { readonly value?: ScratchMode; readonly damaged: boolean } {
    if (body === undefined) return { damaged: false };
    if (body === null || typeof body !== "object" || Array.isArray(body)) return { damaged: true };
    const v = (body as CleanupSettingsBody).scratch;
    return v === undefined ? { damaged: false } : mode(v) ? { value: v, damaged: false } : { damaged: true };
  }

  /**
   * The mode for a cleanup now: the owner's entry, else the start-up default. A damaged record gives `keep`, and `warn` tells the owner once per damage episode (the warning's identity is the damaged record's revision, so reading again
   * does not repeat it; the owner's next change repairs it). A warning that cannot be sent changes nothing; the next read tries again.
   */
  async effective(): Promise<{ readonly scratch: ScratchMode }> {
    const found = await this.#runner.get(REF.kind, REF.id);
    const read = this.#read(found?.body);
    if (read.damaged && found !== undefined && this.#warn !== undefined) {
      try { await this.#warn({ revision: found.revision, detail: "the stored cleanup setting is damaged, so scratch is kept (nothing is removed) until you set it again (cleanup.settings.change)" }); } catch { /* the next read tries again */ }
    }
    return { scratch: read.damaged ? "keep" : read.value ?? this.#startup };
  }
}
