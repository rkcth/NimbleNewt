import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { DispatcherLimitFigures } from "../dispatch/dispatcher.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "dispatch-limits-settings", id: "main" } as const;

/** The two limits of the dispatcher. Both are off (unlimited) unless the owner or the start-up options turn them on. */
export const DISPATCH_LIMIT_BOUNDS = { attemptMinutes: { min: 1, max: 525_600 }, maxAttempts: { min: 1, max: 1000 } } as const;
type Name = keyof typeof DISPATCH_LIMIT_BOUNDS;
const NAMES = Object.keys(DISPATCH_LIMIT_BOUNDS) as Name[];

/** One limit as the owner left it: on or off, and the figure kept while it is off so that it can be turned on again. */
export interface DispatchLimitEntry { readonly enabled: boolean; readonly value?: number }
export type DispatchLimitsBody = { readonly [K in Name]?: DispatchLimitEntry } & { readonly updatedBy: string; readonly updatedAt: string };

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const figure = (name: Name, v: unknown, field: string): number => {
  const b = DISPATCH_LIMIT_BOUNDS[name];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= b.min && v <= b.max ? v : invalid(field, `${name} must be a whole number from ${b.min} to ${b.max}`);
};
const names = (v: unknown, field: string): Name[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return invalid(field, "must be a list of limit names (attemptMinutes, maxAttempts)");
  return [...new Set(v.map((k) => (typeof k === "string" && (NAMES as string[]).includes(k) ? (k as Name) : invalid(field, `${String(k).slice(0, 30)} is not a limit (attemptMinutes, maxAttempts)`))))].sort();
};

/** Reads a stored record; a damaged one throws (the caller must not run with a guess). */
function entries(body: unknown): Partial<Record<Name, DispatchLimitEntry>> {
  if (body === undefined) return {};
  const out: Partial<Record<Name, DispatchLimitEntry>> = {};
  for (const n of NAMES) {
    const e = (body as Record<string, unknown>)[n];
    if (e === undefined) continue;
    if (e === null || typeof e !== "object" || typeof (e as { enabled?: unknown }).enabled !== "boolean") throw new DomainError("integrity", `the dispatcher limits setting is damaged at ${n}`);
    const v = (e as { value?: unknown }).value;
    if (v === undefined && (e as { enabled: boolean }).enabled) throw new DomainError("integrity", `the dispatcher limits setting is damaged at ${n}`);
    out[n] = { enabled: (e as { enabled: boolean }).enabled, ...(v === undefined ? {} : { value: figure(n, v, n) }) };
  }
  return out;
}

/**
 * The dispatcher's two limits, as the owner sets them: how long an attempt may run (`attemptMinutes`) and how many attempts the dispatcher admits after a lost one (`maxAttempts`). Both are OFF by default (no limit);
 * each can be turned on with a figure, turned off (the figure is kept), turned on again, or cleared so the start-up option applies. Owner only, race-safe (`expectedRevision`), replay-safe.
 * `effective()` is read by the dispatcher on every claim and re-admission, so a change counts from the next one; an attempt already running keeps the expiry it was given. It throws when the record cannot be read.
 */
export class DispatchLimitsSettingsService {
  readonly #runner: CommandRunner;
  readonly #startup: DispatcherLimitFigures;

  private constructor(runner: CommandRunner, startup: DispatcherLimitFigures) { this.#runner = runner; this.#startup = startup; }

  static withEpoch(storage: ControllerStorage, epoch: number, startup: DispatcherLimitFigures = {}, options: RunnerOptions = {}): DispatchLimitsSettingsService {
    return new DispatchLimitsSettingsService(new CommandRunner(storage, epoch, options), startup);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly limits: Partial<Record<Name, DispatchLimitEntry>>; readonly startup: { readonly attemptMinutes?: number; readonly maxAttempts?: number }; readonly effective: { readonly attemptMinutes?: number; readonly maxAttempts?: number } }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the dispatcher limits`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const e = await this.effective();
    const startup = { ...(this.#startup.attemptMs === undefined ? {} : { attemptMinutes: Math.ceil(this.#startup.attemptMs / 60_000) }), ...(this.#startup.maxAttempts === undefined ? {} : { maxAttempts: this.#startup.maxAttempts }) };
    return { revision: found?.revision ?? 0, limits: entries(found?.body), startup, effective: { ...(e.attemptMs === undefined ? {} : { attemptMinutes: Math.ceil(e.attemptMs / 60_000) }), ...(e.maxAttempts === undefined ? {} : { maxAttempts: e.maxAttempts }) } };
  }

  /**
   * Merge-style change (what the chat proposes): `set` turns the named limits on with a figure; `disable` turns them off keeping the figure; `enable` turns them on again with the kept figure; `unset` forgets the owner's entry so the
   * start-up option (or no limit) applies. A limit is named once. `expectedRevision` is optional.
   */
  async change(owner: Principal, command: NoActor & { set?: unknown; enable?: unknown; disable?: unknown; unset?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the dispatcher limits`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "set", "enable", "disable", "unset", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    const set: Partial<Record<Name, number>> = {};
    const nulled: Name[] = [];
    if (command.set !== undefined) {
      if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set)) invalid("set", "must be an object such as { \"attemptMinutes\": 240 }");
      for (const [k, v] of Object.entries(command.set as object)) {
        if (!(NAMES as string[]).includes(k)) invalid("set", `${k.slice(0, 30)} is not a limit (attemptMinutes, maxAttempts)`);
        if (v === null) nulled.push(k as Name); else set[k as Name] = figure(k as Name, v, "set"); // null: turn the limit off
      }
    }
    const enable = names(command.enable, "enable"), disable = [...names(command.disable, "disable"), ...nulled], unset = names(command.unset, "unset");
    const setNames = Object.keys(set) as Name[];
    if (setNames.length + enable.length + disable.length + unset.length === 0) invalid("set", "name at least one limit to set, enable, disable or unset");
    const all = [...setNames, ...enable, ...disable, ...unset];
    if (new Set(all).size !== all.length) invalid("set", "a limit is named once across set, enable, disable and unset");
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) invalid("expectedRevision", "must be a whole number");
    const result = await this.#runner.command("dispatch.limits.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { set: set as unknown as JsonObject, enable, disable, unset, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the dispatcher limits are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const merged: Partial<Record<Name, DispatchLimitEntry>> = { ...entries(current?.body) };
        for (const n of setNames) merged[n] = { enabled: true, value: set[n]! };
        for (const n of enable) {
          const kept = merged[n]?.value;
          if (kept === undefined) invalid("enable", `${n} has no figure to turn on; give one in set`);
          merged[n] = { enabled: true, value: kept! };
        }
        for (const n of disable) merged[n] = { enabled: false, ...(merged[n]?.value === undefined ? {} : { value: merged[n]!.value! }) };
        for (const n of unset) delete merged[n];
        const next = { ...merged, updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { limits: Object.keys(merged).length } };
      },
    }));
    return { revision: result.revision };
  }

  /** What the dispatcher uses now, per figure: the owner's entry (a figure when on, none when off) or else the start-up option, or else no limit. */
  async effective(): Promise<DispatcherLimitFigures> {
    const found = await this.#runner.get(REF.kind, REF.id);
    const e = entries(found?.body);
    const minutes = e.attemptMinutes === undefined ? this.#startup.attemptMs : e.attemptMinutes.enabled ? e.attemptMinutes.value! * 60_000 : undefined;
    const attempts = e.maxAttempts === undefined ? this.#startup.maxAttempts : e.maxAttempts.enabled ? e.maxAttempts.value! : undefined;
    return { ...(minutes === undefined ? {} : { attemptMs: minutes }), ...(attempts === undefined ? {} : { maxAttempts: attempts }) };
  }
}
