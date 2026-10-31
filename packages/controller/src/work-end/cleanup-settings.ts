import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { DEFAULT_AWAIT_STOP_HOURS } from "./scratch-cleanup.js";

const REF = { kind: "cleanup-settings", id: "main" } as const;

/** What happens to the controller-created scratch workspace when an attempt ends: removed once everything important was handed onward (the default), or always kept. */
export const SCRATCH_MODES = ["after-handoff", "keep"] as const;
export type ScratchMode = (typeof SCRATCH_MODES)[number];
export const SCRATCH_DEFAULT: ScratchMode = "after-handoff";
const NAMES = ["scratch", "awaitStopHours"] as const;
type Name = (typeof NAMES)[number];

/** `awaitStopHours`: how long scratch waits for a worker to confirm it stopped before the supervisor/owner is told it is kept (a whole number of hours; `null` means never tell; absent: the default of 24). */
export interface CleanupSettingsBody { readonly scratch?: ScratchMode; readonly awaitStopHours?: number | null; readonly updatedBy: string; readonly updatedAt: string }

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const mode = (v: unknown): v is ScratchMode => typeof v === "string" && (SCRATCH_MODES as readonly string[]).includes(v);
const hours = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= 24 * 365);
const names = (v: unknown, field: string): Name[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return invalid(field, "must be a list of setting names (scratch, awaitStopHours)");
  return [...new Set(v.map((k) => ((NAMES as readonly unknown[]).includes(k) ? (k as Name) : invalid(field, `${String(k).slice(0, 30)} is not a cleanup setting (scratch, awaitStopHours)`))))];
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

  async get(by: Principal): Promise<{ readonly revision: number; readonly scratch: ScratchMode | null; readonly awaitStopHours: number | null | undefined; readonly default: ScratchMode; readonly effective: { readonly scratch: ScratchMode; readonly awaitStopHours: number | null }; readonly damaged?: true }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the cleanup setting`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const read = this.#read(found?.body);
    return { revision: found?.revision ?? 0, scratch: read.value ?? null, awaitStopHours: read.hours, default: this.#startup, effective: await this.effective(), ...(read.damaged ? { damaged: true as const } : {}) };
  }

  async change(owner: Principal, command: NoActor & { set?: unknown; enable?: unknown; disable?: unknown; unset?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the cleanup setting`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "set", "enable", "disable", "unset", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    // What each setting is asked to become: a value, `enable` (the default, written), `disable` (off), or `unset` (the owner's entry is forgotten).
    const asked = new Map<Name, { readonly op: "set" | "unset"; readonly value?: ScratchMode | number | null }>();
    const once = (n: Name, e: { readonly op: "set" | "unset"; readonly value?: ScratchMode | number | null }): void => { if (asked.has(n)) invalid("set", `${n} is named once across set, enable, disable and unset`); asked.set(n, e); };
    if (command.set !== undefined) {
      if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set)) invalid("set", "must be an object such as { \"scratch\": \"keep\" } or { \"awaitStopHours\": 48 }");
      for (const [k, v] of Object.entries(command.set as object)) {
        if (k === "scratch") { if (!mode(v)) invalid("set", "scratch must be after-handoff or keep"); once("scratch", { op: "set", value: v as ScratchMode }); }
        else if (k === "awaitStopHours") { if (!hours(v)) invalid("set", "awaitStopHours must be a whole number of hours (1 to 8760), or null for never"); once("awaitStopHours", { op: "set", value: v }); }
        else invalid("set", `${k.slice(0, 30)} is not a cleanup setting (scratch, awaitStopHours)`);
      }
    }
    for (const n of names(command.enable, "enable")) once(n, { op: "set", value: n === "scratch" ? "after-handoff" : DEFAULT_AWAIT_STOP_HOURS });
    for (const n of names(command.disable, "disable")) once(n, { op: "set", value: n === "scratch" ? "keep" : null });
    for (const n of names(command.unset, "unset")) once(n, { op: "unset" });
    if (asked.size === 0) invalid("set", "name a cleanup setting (scratch, awaitStopHours) to set, enable, disable or unset");
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) invalid("expectedRevision", "must be a whole number");
    const patch = Object.fromEntries([...asked].map(([n, e]) => [n, e.op === "unset" ? "unset" : e.value ?? null]));
    const result = await this.#runner.command("cleanup.settings.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { patch: patch as unknown as JsonObject, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the cleanup setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        // A damaged record is replaced by what is asked (the owner's change repairs it); otherwise the other setting is kept.
        const was = this.#read(current?.body);
        const keep: { scratch?: ScratchMode; awaitStopHours?: number | null } = was.damaged ? {} : { ...(was.value === undefined ? {} : { scratch: was.value }), ...(was.hours === undefined ? {} : { awaitStopHours: was.hours }) };
        for (const [n, e] of asked) { if (e.op === "unset") delete keep[n]; else (keep as Record<string, unknown>)[n] = e.value; }
        const body = { ...keep, updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref: REF, body } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { patch: patch as unknown as JsonObject } };
      },
    }));
    return { revision: result.revision };
  }

  #read(body: unknown): { readonly value?: ScratchMode; readonly hours?: number | null; readonly damaged: boolean } {
    if (body === undefined) return { damaged: false };
    if (body === null || typeof body !== "object" || Array.isArray(body)) return { damaged: true };
    const v = (body as CleanupSettingsBody).scratch, h = (body as CleanupSettingsBody).awaitStopHours;
    if (v !== undefined && !mode(v)) return { damaged: true };
    // A damaged patience does not stop scratch from being kept or removed by `scratch`; the default patience applies (the notice is the only thing it changes).
    return { ...(v === undefined ? {} : { value: v }), ...(h === undefined || !hours(h) ? {} : { hours: h }), damaged: false };
  }

  /**
   * The mode for a cleanup now: the owner's entry, else the start-up default. A damaged record gives `keep`, and `warn` tells the owner once per damage episode (the warning's identity is the damaged record's revision, so reading again
   * does not repeat it; the owner's next change repairs it). A warning that cannot be sent changes nothing; the next read tries again.
   */
  async effective(): Promise<{ readonly scratch: ScratchMode; readonly awaitStopHours: number | null }> {
    const found = await this.#runner.get(REF.kind, REF.id);
    const read = this.#read(found?.body);
    if (read.damaged && found !== undefined && this.#warn !== undefined) {
      try { await this.#warn({ revision: found.revision, detail: "the stored cleanup setting is damaged, so scratch is kept (nothing is removed) until you set it again (cleanup.settings.change)" }); } catch { /* the next read tries again */ }
    }
    return { scratch: read.damaged ? "keep" : read.value ?? this.#startup, awaitStopHours: read.hours === undefined ? DEFAULT_AWAIT_STOP_HOURS : read.hours };
  }
}
