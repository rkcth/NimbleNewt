import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { CAP_BOUNDS, CAP_NAMES, type CapName, type Caps } from "./policy.js";

export const CAPS_REF = { kind: "capacity-limits-settings", id: "main" } as const;

/** One cap as the owner left it: on or off, and the figure kept while it is off so that it can be turned on again. */
export interface CapEntry { readonly enabled: boolean; readonly value?: number }
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const figure = (v: unknown, field: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= CAP_BOUNDS.min && v <= CAP_BOUNDS.max ? v : invalid(field, `must be a whole number from ${CAP_BOUNDS.min} to ${CAP_BOUNDS.max}`));
const names = (v: unknown, field: string): CapName[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return invalid(field, `must be a list of cap names (${CAP_NAMES.join(", ")})`);
  return [...new Set(v.map((k) => ((CAP_NAMES as readonly unknown[]).includes(k) ? (k as CapName) : invalid(field, `${String(k).slice(0, 30)} is not a cap (${CAP_NAMES.join(", ")})`))))].sort();
};

/** Reads a stored record leniently: the sound entries, and the names that are damaged (all of them if the record is not an object). */
export function readCapEntries(body: unknown): { readonly ok: Partial<Record<CapName, CapEntry>>; readonly damaged: CapName[] } {
  if (body === undefined) return { ok: {}, damaged: [] };
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: {}, damaged: [...CAP_NAMES] };
  const ok: Partial<Record<CapName, CapEntry>> = {};
  const damaged: CapName[] = [];
  for (const n of CAP_NAMES) {
    const e = (body as Record<string, unknown>)[n];
    if (e === undefined) continue;
    const o = e !== null && typeof e === "object" ? (e as { enabled?: unknown; value?: unknown }) : {};
    if (typeof o.enabled !== "boolean" || (o.value === undefined && o.enabled)) { damaged.push(n); continue; }
    try { ok[n] = { enabled: o.enabled, ...(o.value === undefined ? {} : { value: figure(o.value, n) }) }; } catch { damaged.push(n); }
  }
  return { ok, damaged };
}

/** The caps in force: only the entries that are on. A damaged record throws (admission must not guess), carrying the revision. */
export function capsOf(body: unknown, revision?: number): Caps {
  const { ok, damaged } = readCapEntries(body);
  if (damaged.length > 0) throw new DomainError("integrity", `the capacity limits setting is damaged at ${damaged.join(", ")}`, revision === undefined ? {} : { currentRevision: revision });
  const out: { -readonly [K in CapName]?: number } = {};
  for (const n of CAP_NAMES) if (ok[n]?.enabled === true) out[n] = ok[n]!.value!;
  return out;
}

/**
 * Optional capacity caps (card H10b): attempts running at once per project, per agent, and the fan-in (running child attempts whose parent task is owned by one supervising agent; reviewers are not counted). All OFF by default. The owner turns each
 * on with a figure, off (the figure is kept), on again, or forgets it. Owner only, race-safe (`expectedRevision`), replay-safe. Admission reads the record at every decision, so a change counts from the next one;
 * `onChanged` lets the controller re-run admission at once so a raised or removed cap lets waiting work in. Work already running is never stopped by a lower cap.
 */
export class CapacityLimitsService {
  readonly #runner: CommandRunner;
  readonly #onChanged: (revision: number) => Promise<void>;

  private constructor(runner: CommandRunner, onChanged: (revision: number) => Promise<void>) { this.#runner = runner; this.#onChanged = onChanged; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { onChanged?: (revision: number) => Promise<void> } = {}): CapacityLimitsService {
    const { onChanged, ...rest } = options;
    return new CapacityLimitsService(new CommandRunner(storage, epoch, rest), onChanged ?? (async () => undefined));
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly limits: Partial<Record<CapName, CapEntry>>; readonly effective: Caps }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the capacity limits`);
    const found = await this.#runner.get(CAPS_REF.kind, CAPS_REF.id);
    return { revision: found?.revision ?? 0, limits: readCapEntries(found?.body).ok, effective: capsOf(found?.body, found?.revision) };
  }

  async change(owner: Principal, command: NoActor & { set?: unknown; enable?: unknown; disable?: unknown; unset?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the capacity limits`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "set", "enable", "disable", "unset", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    const set: Partial<Record<CapName, number>> = {};
    const nulled: CapName[] = [];
    if (command.set !== undefined) {
      if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set)) invalid("set", "must be an object such as { \"perProject\": 2 }");
      for (const [k, v] of Object.entries(command.set as object)) {
        if (!(CAP_NAMES as readonly string[]).includes(k)) invalid("set", `${k.slice(0, 30)} is not a cap (${CAP_NAMES.join(", ")})`);
        if (v === null) nulled.push(k as CapName); else set[k as CapName] = figure(v, "set");
      }
    }
    const enable = names(command.enable, "enable"), disable = [...names(command.disable, "disable"), ...nulled], unset = names(command.unset, "unset");
    const setNames = Object.keys(set) as CapName[];
    const all = [...setNames, ...enable, ...disable, ...unset];
    if (all.length === 0) invalid("set", "name at least one cap to set, enable, disable or unset");
    if (new Set(all).size !== all.length) invalid("set", "a cap is named once across set, enable, disable and unset");
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) invalid("expectedRevision", "must be a whole number");
    const result = await this.#runner.command("capacity.limits.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { set: set as unknown as JsonObject, enable, disable, unset, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(CAPS_REF.kind, CAPS_REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the capacity limits are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const read = readCapEntries(current?.body);
        const mended = new Set<CapName>([...setNames, ...unset, ...disable]);
        const stuck = read.damaged.filter((n) => !mended.has(n));
        if (stuck.length > 0) invalid("set", `the capacity limits setting is damaged at ${stuck.join(", ")}: set, unset or disable ${stuck.length === 1 ? "it" : "each of them"} in this change to repair it`);
        const merged: Partial<Record<CapName, CapEntry>> = { ...read.ok };
        for (const n of setNames) merged[n] = { enabled: true, value: set[n]! };
        for (const n of enable) {
          const kept = merged[n]?.value;
          if (kept === undefined) invalid("enable", `${n} has no figure to turn on; give one in set`);
          merged[n] = { enabled: true, value: kept! };
        }
        for (const n of disable) merged[n] = { enabled: false, ...(merged[n]?.value === undefined ? {} : { value: merged[n]!.value! }) };
        for (const n of unset) delete merged[n];
        const next = { ...merged, updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref: CAPS_REF, body: next } : { type: "update" as const, ref: CAPS_REF, expectedRevision: current.revision, body: next };
        return { ref: CAPS_REF, creates: current === undefined, changes: [change], detail: { caps: Object.keys(merged).length } };
      },
    }));
    // The change is made; letting waiting work in is best effort (the next admission decision does it too).
    await this.#onChanged(result.revision).catch(() => undefined);
    return { revision: result.revision };
  }
}
