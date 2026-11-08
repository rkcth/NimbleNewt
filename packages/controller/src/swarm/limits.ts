import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

export const SWARM_LIMITS_REF = { kind: "swarm-limits-settings", id: "main" } as const;

/**
 * How far one task may expand into child tasks (card H10). `depth`: how many levels of children below a task that was not spawned (0: no spawning at all). `liveChildren`: children of one
 * parent that are not finished at once (0: the parent may spawn nothing now). `totalChildren`: the fan-in of one parent, the children it may have in all, finished ones included, so the
 * results that come back to one parent stay bounded (absent: no total). The figures are the owner's; the defaults hold until the owner changes them.
 */
export interface SwarmLimits {
  readonly depth: number;
  readonly liveChildren: number;
  readonly totalChildren?: number;
}

export const SWARM_LIMIT_DEFAULTS: Required<SwarmLimits> = { depth: 3, liveChildren: 4, totalChildren: 16 };
export const SWARM_LIMIT_BOUNDS = { depth: { min: 0, max: 8 }, liveChildren: { min: 0, max: 64 }, totalChildren: { min: 1, max: 1000 } } as const;
type Name = keyof typeof SWARM_LIMIT_BOUNDS;
const NAMES = Object.keys(SWARM_LIMIT_BOUNDS) as Name[];

/** What the owner set: a figure, or (fan-in only) `null` for no total. A name that is absent has its default. */
export type SwarmLimitEntries = { readonly depth?: number; readonly liveChildren?: number; readonly totalChildren?: number | null };

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const figure = (name: Name, v: unknown, field: string): number => {
  const b = SWARM_LIMIT_BOUNDS[name];
  return typeof v === "number" && Number.isSafeInteger(v) && v >= b.min && v <= b.max ? v : invalid(field, `${name} must be a whole number from ${b.min} to ${b.max}`);
};

/** Reads a stored record leniently: the sound entries and the names that are damaged (every name when the record is not an object). */
function readEntries(body: unknown): { readonly ok: SwarmLimitEntries; readonly damaged: Name[] } {
  if (body === undefined) return { ok: {}, damaged: [] };
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { ok: {}, damaged: [...NAMES] };
  const ok: { -readonly [K in Name]?: number | null } = {};
  const damaged: Name[] = [];
  for (const n of NAMES) {
    const v = (body as Record<string, unknown>)[n];
    if (v === undefined) continue;
    if (v === null && n === "totalChildren") { ok[n] = null; continue; }
    try { ok[n] = figure(n, v, n); } catch { damaged.push(n); }
  }
  return { ok: ok as SwarmLimitEntries, damaged };
}

/** The limits in force. A damaged record throws `integrity`: spawning must not run on a guess (cancelling never reads it). */
export function swarmLimitsOf(body: unknown, revision?: number): SwarmLimits {
  const { ok, damaged } = readEntries(body);
  if (damaged.length > 0) throw new DomainError("integrity", `the swarm limits setting is damaged at ${damaged.join(", ")}: set or unset ${damaged.length === 1 ? "it" : "them"} again (swarm.limits.change) to repair it`, revision === undefined ? {} : { currentRevision: revision });
  const total = ok.totalChildren === undefined ? SWARM_LIMIT_DEFAULTS.totalChildren : ok.totalChildren;
  return { depth: ok.depth ?? SWARM_LIMIT_DEFAULTS.depth, liveChildren: ok.liveChildren ?? SWARM_LIMIT_DEFAULTS.liveChildren, ...(total === null ? {} : { totalChildren: total }) };
}

/**
 * The owner's limits on spawning child tasks (card H10). Owner only, race-safe (`expectedRevision`) and replay-safe. `set` names figures (a `null` total turns the fan-in total off), `unset`
 * returns a name to its default. Spawning reads the record at every spawn, so a change counts from the next one; a lower limit cancels nothing that exists, it only refuses new children.
 */
export class SwarmLimitsService {
  readonly #runner: CommandRunner;

  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): SwarmLimitsService {
    return new SwarmLimitsService(new CommandRunner(storage, epoch, options));
  }

  /** What applies now (no rights check: the swarm service reads it for every spawn). Throws `integrity` when the record is damaged. */
  async effective(): Promise<SwarmLimits> {
    const found = await this.#runner.get(SWARM_LIMITS_REF.kind, SWARM_LIMITS_REF.id);
    return swarmLimitsOf(found?.body, found?.revision);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly limits: SwarmLimitEntries; readonly defaults: Required<SwarmLimits>; readonly effective: SwarmLimits | null; readonly damaged: string[] }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the swarm limits`);
    const found = await this.#runner.get(SWARM_LIMITS_REF.kind, SWARM_LIMITS_REF.id);
    const read = readEntries(found?.body);
    return { revision: found?.revision ?? 0, limits: read.ok, defaults: SWARM_LIMIT_DEFAULTS, effective: read.damaged.length > 0 ? null : swarmLimitsOf(found?.body), damaged: read.damaged };
  }

  async change(owner: Principal, command: NoActor & { set?: unknown; unset?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the swarm limits`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "set", "unset", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    const set: { -readonly [K in Name]?: number | null } = {};
    if (command.set !== undefined) {
      if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set)) invalid("set", "must be an object such as { \"liveChildren\": 2 }");
      for (const [k, v] of Object.entries(command.set as object)) {
        if (!(NAMES as string[]).includes(k)) invalid("set", `${k.slice(0, 30)} is not a swarm limit (${NAMES.join(", ")})`);
        if (v === null) { if (k !== "totalChildren") invalid("set", `${k} cannot be turned off; set a figure (0 allows no new child)`); set[k as Name] = null; } else set[k as Name] = figure(k as Name, v, "set");
      }
    }
    let unset: Name[] = [];
    if (command.unset !== undefined) {
      if (!Array.isArray(command.unset)) invalid("unset", `must be a list of limit names (${NAMES.join(", ")})`);
      unset = [...new Set((command.unset as unknown[]).map((k) => (typeof k === "string" && (NAMES as string[]).includes(k) ? (k as Name) : invalid("unset", `${String(k).slice(0, 30)} is not a swarm limit (${NAMES.join(", ")})`))))].sort();
    }
    const all = [...Object.keys(set), ...unset];
    if (all.length === 0) invalid("set", "name at least one limit to set or unset");
    if (new Set(all).size !== all.length) invalid("set", "a limit is named once across set and unset");
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) invalid("expectedRevision", "must be a whole number");
    const result = await this.#runner.command("swarm.limits.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { set: set as unknown as JsonObject, unset, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(SWARM_LIMITS_REF.kind, SWARM_LIMITS_REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the swarm limits are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const read = readEntries(current?.body);
        const stuck = read.damaged.filter((n) => !all.includes(n));
        if (stuck.length > 0) invalid("set", `the swarm limits setting is damaged at ${stuck.join(", ")}: set or unset ${stuck.length === 1 ? "it" : "each of them"} in this change to repair it`);
        const merged: { -readonly [K in Name]?: number | null } = { ...read.ok, ...set };
        for (const n of unset) delete merged[n];
        const next = { ...merged, updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref: SWARM_LIMITS_REF, body: next } : { type: "update" as const, ref: SWARM_LIMITS_REF, expectedRevision: current.revision, body: next };
        return { ref: SWARM_LIMITS_REF, creates: current === undefined, changes: [change], detail: { names: all.length } };
      },
    }));
    return { revision: result.revision };
  }
}
