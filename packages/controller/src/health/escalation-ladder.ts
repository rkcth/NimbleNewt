import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "escalation-ladder-settings", id: "main" } as const;

/** How long an undecided concern waits at a level before it climbs to the next, when nothing else says (the owner's decision: 24 hours). */
export const DEFAULT_LADDER_HOURS = 24;
/** Per-level bounds: one hour to 30 days, whole hours; at most this many levels may be named (levels past the list use the default). */
export const LADDER_BOUNDS = { minHours: 1, maxHours: 24 * 30, maxLevels: 16 } as const;

export interface EscalationLadderBody {
  /** Hours the concern waits at level 0, 1, 2 ...; a level past the end of the list waits the default. */
  readonly hours: readonly number[];
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** Validates a list of per-level hours; throws `invalid_command` naming the field. */
export function checkLadderHours(value: unknown, field = "hours"): number[] {
  if (!Array.isArray(value)) throw new DomainError("invalid_command", `${field}: must be a list of whole hours, one per level (an empty list clears the setting)`, { field });
  if (value.length > LADDER_BOUNDS.maxLevels) throw new DomainError("invalid_command", `${field}: at most ${LADDER_BOUNDS.maxLevels} levels may be named`, { field });
  for (const h of value) if (typeof h !== "number" || !Number.isSafeInteger(h) || h < LADDER_BOUNDS.minHours || h > LADDER_BOUNDS.maxHours) throw new DomainError("invalid_command", `${field}: each level is a whole number of hours from ${LADDER_BOUNDS.minHours} to ${LADDER_BOUNDS.maxHours} (30 days)`, { field });
  return [...value] as number[];
}

/**
 * How long a concern that nobody decides waits at each level of the supervisor ladder (owner decision 2026-10-30, supervisor ladder): the owner's chat-settable setting. Owner only, validated, race-safe (`expectedRevision`).
 * `hours()` is read by the escalation pass; it throws when the stored record is damaged, so a bad record stops escalation (shown as a failed tick) rather than escalating at a wrong time.
 */
export class EscalationLadderService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): EscalationLadderService {
    return new EscalationLadderService(new CommandRunner(storage, epoch, options));
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly hours: readonly number[]; readonly defaultHours: number }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the escalation ladder`);
    const found = await this.#runner.get(REF.kind, REF.id);
    return { revision: found?.revision ?? 0, hours: await this.hours(), defaultHours: DEFAULT_LADDER_HOURS };
  }

  /** The owner's per-level hours replace the earlier ones; an empty list clears the setting (every level then waits the default). */
  async set(owner: Principal, command: NoActor & { hours?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the escalation ladder`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "hours", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.hours === undefined) throw new DomainError("invalid_command", "hours: name the hours for each level, for example [24, 48]; an empty list clears them", { field: "hours" });
    const hours = checkLadderHours(command.hours);
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("escalation.ladder.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { hours, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the escalation ladder is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const next: EscalationLadderBody = { hours, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { levels: hours.length } };
      },
    }));
    return { revision: result.revision };
  }

  /** The owner's hours (empty when none are set). Re-checked on read: a damaged record throws. */
  async hours(): Promise<readonly number[]> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return found === undefined ? [] : checkLadderHours((found.body as unknown as EscalationLadderBody).hours, "hours");
  }
}
