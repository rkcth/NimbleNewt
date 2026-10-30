import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "resume-settings", id: "main" } as const;
/** The bounds of the blocked-round retry limit, and what applies when nothing is set. */
export const RESUME_ROUNDS = { min: 1, max: 10, default: 3 } as const;

export interface ResumeSettingsBody {
  /** The retry limit the owner set; absent when cleared, and then the installation default applies. */
  readonly maxRounds?: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

const whole = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= RESUME_ROUNDS.min && v <= RESUME_ROUNDS.max;

/**
 * How many blocked rounds a stalled resume check retries before the owner is told (owner decision 2026-10-30): 1..10, default 3, owner only, race-safe (`expectedRevision`), replay-safe (command ID).
 * `effective()` is read once per new check; a check already running keeps the value stored in its own record. A damaged record throws rather than silently falling back.
 */
export class ResumeSettingsService {
  readonly #runner: CommandRunner;
  readonly #startup: number;

  private constructor(runner: CommandRunner, startup: number) { this.#runner = runner; this.#startup = startup; }

  static withEpoch(storage: ControllerStorage, epoch: number, startup: number = RESUME_ROUNDS.default, options: RunnerOptions = {}): ResumeSettingsService {
    if (!whole(startup)) throw new RangeError("maxRounds must be a whole number from 1 to 10");
    return new ResumeSettingsService(new CommandRunner(storage, epoch, options), startup);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly maxRounds: number | null; readonly default: number; readonly effective: number }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the resume retry limit`);
    const found = await this.#runner.get(REF.kind, REF.id);
    return { revision: found?.revision ?? 0, maxRounds: (found?.body as unknown as ResumeSettingsBody | undefined)?.maxRounds ?? null, default: this.#startup, effective: await this.effective() };
  }

  /** Sets the limit (1..10), or clears it with `maxRounds: null` so the default applies. */
  async set(owner: Principal, command: NoActor & { maxRounds?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the resume retry limit`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "maxRounds", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.maxRounds !== null && !whole(command.maxRounds)) throw new DomainError("invalid_command", `maxRounds: must be a whole number from ${RESUME_ROUNDS.min} to ${RESUME_ROUNDS.max}, or null to clear`, { field: "maxRounds" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const value = command.maxRounds as number | null;
    const result = await this.#runner.command("resume.settings.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { maxRounds: value, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the resume setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const next: ResumeSettingsBody = { ...(value === null ? {} : { maxRounds: value }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { maxRounds: value } };
      },
    }));
    return { revision: result.revision };
  }

  /** The limit for a check starting now. Re-validated on read: a damaged record throws, so the start is refused instead of running with a wrong limit. */
  async effective(): Promise<number> {
    const found = await this.#runner.get(REF.kind, REF.id);
    const v = (found?.body as unknown as ResumeSettingsBody | undefined)?.maxRounds;
    if (v === undefined) return this.#startup;
    if (!whole(v)) throw new DomainError("invalid_command", "the stored resume retry limit is damaged", { field: "maxRounds" });
    return v;
  }
}
