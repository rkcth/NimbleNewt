import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "agreed-limits-settings", id: "main" } as const;

/** The optional ceilings on what a decision may carry out. Every figure is absent by default: no ceiling (owner decision 2026-10-30). */
export interface AgreedLimits {
  /** The most one raise of money carried out by the approval policy may add, in millionths. */
  readonly raiseMaxCostMicros?: number;
  /** The most compute time one raise carried out by the approval policy may add, in milliseconds. */
  readonly raiseMaxComputeMs?: number;
  /** The longest a right granted by a decision may last, in days. */
  readonly grantMaxDays?: number;
}

/** What the services read: the current ceilings, fresh at each carry-out. It throws when the setting cannot be read, and the carry-out then fails (never goes through unchecked). */
export type AgreedLimitsReader = () => Promise<AgreedLimits>;

export const AGREED_LIMIT_BOUNDS = { raiseMaxCostMicros: { min: 1, max: 1e15 }, raiseMaxComputeMs: { min: 1, max: 1e12 }, grantMaxDays: { min: 1, max: 3650 } } as const;
const NAMES = Object.keys(AGREED_LIMIT_BOUNDS);

export function checkAgreedLimits(value: unknown, label: string): AgreedLimits {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label}: must be an object`);
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (!Object.hasOwn(AGREED_LIMIT_BOUNDS, k)) throw new Error(`${label}.${k}: is not a limit (${NAMES.join(", ")})`);
    const b = AGREED_LIMIT_BOUNDS[k as keyof typeof AGREED_LIMIT_BOUNDS];
    if (typeof v !== "number" || !Number.isSafeInteger(v) || v < b.min || v > b.max) throw new Error(`${label}.${k}: must be a whole number from ${b.min} to ${b.max}`);
    out[k] = v;
  }
  return out as AgreedLimits;
}

interface Body { readonly limits: AgreedLimits; readonly updatedBy: string; readonly updatedAt: string }

/**
 * Optional ceilings on agreed raises and agreed grants (owner decision 2026-10-30): none by default, so a raise or grant that was agreed goes through as agreed; the owner may set a ceiling, which then applies from the next carry-out.
 * Owner only, validated, race-safe (`expectedRevision`). `effective()` throws when the setting cannot be read or is damaged: the caller must refuse the carry-out.
 */
export class AgreedLimitsSettingsService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): AgreedLimitsSettingsService { return new AgreedLimitsSettingsService(new CommandRunner(storage, epoch, options)); }

  async get(by: Principal): Promise<{ readonly revision: number; readonly limits: AgreedLimits }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the limits on agreed raises and grants`);
    const found = await this.#runner.get(REF.kind, REF.id);
    return { revision: found?.revision ?? 0, limits: await this.effective() };
  }

  /** Sets the named ceilings and clears the ones in `unset`, leaving the others. */
  async change(owner: Principal, command: NoActor & { set?: unknown; unset?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the limits on agreed raises and grants`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "set", "unset", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    let set: AgreedLimits = {};
    if (command.set !== undefined) { try { set = checkAgreedLimits(command.set, "set"); } catch (e) { throw new DomainError("invalid_command", (e as Error).message, { field: "set" }); } }
    let unset: string[] = [];
    if (command.unset !== undefined) {
      if (!Array.isArray(command.unset)) throw new DomainError("invalid_command", "unset: must be a list of limit names", { field: "unset" });
      for (const k of command.unset) if (typeof k !== "string" || !NAMES.includes(k)) throw new DomainError("invalid_command", `unset: ${String(k).slice(0, 30)} is not a limit (${NAMES.join(", ")})`, { field: "unset" });
      unset = [...new Set(command.unset as string[])].sort();
    }
    if (Object.keys(set).length + unset.length === 0) throw new DomainError("invalid_command", "set: name at least one limit to set or clear", { field: "set" });
    for (const k of unset) if (Object.hasOwn(set, k)) throw new DomainError("invalid_command", `unset: ${k} is also in set; a limit is named once`, { field: "unset" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("agreed.limits.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { set: set as unknown as JsonObject, unset, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the limits setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const merged: Record<string, number> = { ...((current?.body as unknown as Body | undefined)?.limits ?? {}) as Record<string, number>, ...set as Record<string, number> };
        for (const k of unset) delete merged[k];
        const next: Body = { limits: merged, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { limits: Object.keys(merged).length } };
      },
    }));
    return { revision: result.revision };
  }

  /** The ceilings now in force (none when never set). Re-checked on read, so a damaged record throws rather than being treated as "no ceiling". */
  async effective(): Promise<AgreedLimits> {
    const found = await this.#runner.get(REF.kind, REF.id);
    if (found === undefined) return {};
    return checkAgreedLimits((found.body as unknown as Body).limits, "limits");
  }
}
