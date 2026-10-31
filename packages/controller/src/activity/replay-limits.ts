import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "replay-limits", id: "main" } as const;

/** What bounds a replay's reading of one task. Generous by default; `enabled: false` removes every bound. */
export interface ReplayLimitValues {
  /** Steps read into one view of a task (the newest, or the window around the step asked for). */
  readonly scan: number;
  /** Pages of 100 explanations an export reads. */
  readonly exportPages: number;
  /** Pages of 100 explanations one step's detail reads for its retrospective explanations. */
  readonly stepPages: number;
}
export const REPLAY_LIMIT_DEFAULTS: ReplayLimitValues = { scan: 50_000, exportPages: 200, stepPages: 100 };
const MAXIMUM = 10_000_000;
/** The effective bounds: `null` for a bound that is off. */
export interface EffectiveReplayLimits { readonly scan: number | null; readonly exportPages: number | null; readonly stepPages: number | null }
export interface ReplayLimitsBody { readonly enabled: boolean; readonly scan?: number; readonly exportPages?: number; readonly stepPages?: number; readonly updatedBy: string; readonly updatedAt: string }
const FIELDS = ["scan", "exportPages", "stepPages"] as const;
const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 1 && v <= MAXIMUM;

/**
 * How much of a task's record one replay reads (card U09, owner rule: limits are optional, generous and chat-settable). Owner only, race-safe (`expectedRevision`), replay-safe (command ID). `enabled: false` turns every bound off;
 * `null` for a figure puts it back to the default. A replay that stopped at a bound says so in its answer.
 */
export class ReplayLimitsService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ReplayLimitsService { return new ReplayLimitsService(new CommandRunner(storage, epoch, options)); }

  async get(by: Principal): Promise<{ readonly revision: number; readonly enabled: boolean; readonly values: ReplayLimitValues; readonly defaults: ReplayLimitValues }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the replay limits`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as ReplayLimitsBody | undefined;
    return { revision: found?.revision ?? 0, enabled: body?.enabled ?? true, values: this.#values(body), defaults: REPLAY_LIMIT_DEFAULTS };
  }

  /** Fields left out stay. `enabled` turns the bounds on or off; a figure of `null` goes back to the default. */
  async set(owner: Principal, command: NoActor & { enabled?: unknown; scan?: unknown; exportPages?: unknown; stepPages?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the replay limits`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "enabled", "scan", "exportPages", "stepPages", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.enabled === undefined && FIELDS.every((f) => command[f] === undefined)) throw new DomainError("invalid_command", "name enabled, scan, exportPages or stepPages", { field: "enabled" });
    if (command.enabled !== undefined && typeof command.enabled !== "boolean") throw new DomainError("invalid_command", "enabled: must be true or false", { field: "enabled" });
    for (const f of FIELDS) if (command[f] !== undefined && command[f] !== null && !whole(command[f])) throw new DomainError("invalid_command", `${f}: must be a whole number from 1 to ${MAXIMUM}, or null for the default`, { field: f });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("replay.limits.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { enabled: command.enabled ?? null, scan: (command.scan as number | null | undefined) ?? null, exportPages: (command.exportPages as number | null | undefined) ?? null, stepPages: (command.stepPages as number | null | undefined) ?? null, expectedRevision: command.expectedRevision ?? null } as unknown as JsonObject,
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the replay limits are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const was = current?.body as unknown as ReplayLimitsBody | undefined;
        const kept: Record<string, number> = {};
        for (const f of FIELDS) { const v = command[f] === undefined ? was?.[f] : (command[f] as number | null); if (typeof v === "number") kept[f] = v; }
        const next: ReplayLimitsBody = { enabled: (command.enabled as boolean | undefined) ?? was?.enabled ?? true, ...kept, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { enabled: next.enabled } };
      },
    }));
    return { revision: result.revision };
  }

  /** The bounds a replay applies now. A damaged record is read as the defaults, never as no bound. */
  async effective(): Promise<EffectiveReplayLimits> {
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as ReplayLimitsBody | undefined;
    if (body !== undefined && body !== null && typeof body === "object" && body.enabled === false) return { scan: null, exportPages: null, stepPages: null };
    const v = this.#values(body);
    return { scan: v.scan, exportPages: v.exportPages, stepPages: v.stepPages };
  }

  #values(body: ReplayLimitsBody | undefined): ReplayLimitValues {
    const pick = (f: (typeof FIELDS)[number]): number => { const v = body === undefined || body === null || typeof body !== "object" ? undefined : body[f]; return whole(v) ? v : REPLAY_LIMIT_DEFAULTS[f]; };
    return { scan: pick("scan"), exportPages: pick("exportPages"), stepPages: pick("stepPages") };
  }
}
