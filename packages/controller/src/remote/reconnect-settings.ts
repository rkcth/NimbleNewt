import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "reconnect-settings", id: "main" } as const;

/** `auto`: a worker that reconnects takes its still-owned attempt up again at once. `owner`: it waits until the owner approves (or stops) it. */
export type ReacceptMode = "auto" | "owner";
const MODES: readonly string[] = ["auto", "owner"];
export const DEFAULT_PATIENCE_HOURS = 24;
const MAX_PATIENCE_HOURS = 24 * 365;

export interface ReconnectSettingsBody {
  /** The owner's choice; absent when cleared, and then the approval profile decides. */
  readonly reaccept?: ReacceptMode;
  /** How many hours an attempt that waits for the owner's decision keeps its lease; `"off"`: the lease is not extended. Absent: the default (24 hours). */
  readonly patienceHours?: number | "off";
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/** What the profile gives when the owner has not chosen (card H09b, provisional): autonomous re-accepts by itself; every other profile (strict, derived) waits for the owner. Pure. */
export const profileReaccept = (profile: string): ReacceptMode => (profile === "autonomous" ? "auto" : "owner");

/**
 * Whether a reconnecting worker may take its attempt up again by itself (card H09b). The owner's setting over the approval profile's default; owner only, race-safe (`expectedRevision`), replay-safe (command ID).
 * `effective()` is read at every re-accept decision, so a change counts from the next one. A damaged record falls back to the profile, and an unreadable profile to `owner` (the strict side).
 */
export class ReconnectSettingsService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ReconnectSettingsService {
    return new ReconnectSettingsService(new CommandRunner(storage, epoch, options));
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly reaccept: ReacceptMode | null; readonly profile: string; readonly effective: ReacceptMode; readonly patienceHours: number | "off"; readonly patienceChosen: boolean }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the reconnect setting`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const own = this.#own(found?.body);
    return { revision: found?.revision ?? 0, reaccept: own ?? null, profile: await this.#profile(), effective: await this.effective(), patienceHours: this.#patience(found?.body) ?? DEFAULT_PATIENCE_HOURS, patienceChosen: this.#patience(found?.body) !== undefined };
  }

  /**
   * Chooses `auto` (enable automatic re-accept) or `owner` (disable it: the owner decides each), or clears the choice with null so the profile decides. `patienceHours` is how long an attempt that waits for the owner keeps its lease
   * (a positive number of hours, `"off"` for no extension, or null for the default of 24 hours). A field left out keeps its value; at least one must be given.
   */
  async set(owner: Principal, command: NoActor & { reaccept?: unknown; patienceHours?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the reconnect setting`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "reaccept", "patienceHours", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.reaccept === undefined && command.patienceHours === undefined) throw new DomainError("invalid_command", "reaccept or patienceHours: give at least one", { field: "reaccept" });
    if (command.reaccept !== undefined && command.reaccept !== null && !(typeof command.reaccept === "string" && MODES.includes(command.reaccept))) throw new DomainError("invalid_command", "reaccept: must be auto, owner, or null to clear", { field: "reaccept" });
    const p = command.patienceHours;
    if (p !== undefined && p !== null && p !== "off" && !(typeof p === "number" && Number.isFinite(p) && p > 0 && p <= MAX_PATIENCE_HOURS)) throw new DomainError("invalid_command", `patienceHours: must be a number of hours above 0 and up to ${MAX_PATIENCE_HOURS}, "off", or null for the default`, { field: "patienceHours" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const value = command.reaccept as ReacceptMode | null | undefined;
    const result = await this.#runner.command("reconnect.settings.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { reaccept: value ?? null, ...(value === undefined ? { keepReaccept: true } : {}), patienceHours: (p ?? null) as never, ...(p === undefined ? { keepPatience: true } : {}), expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the reconnect setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const keptMode = this.#own(current?.body);
        const keptPatience = this.#patience(current?.body);
        const mode = value === undefined ? keptMode : (value ?? undefined);
        const patience = p === undefined ? keptPatience : (p ?? undefined);
        const next: ReconnectSettingsBody = { ...(mode === undefined ? {} : { reaccept: mode }), ...(patience === undefined ? {} : { patienceHours: patience }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { reaccept: mode ?? null, patienceHours: patience ?? null } };
      },
    }));
    return { revision: result.revision };
  }

  /** The patience in ms for an attempt that waits for the owner; `undefined`: off. A damaged record gives the default. */
  async patienceMs(): Promise<number | undefined> {
    let own: number | "off" | undefined;
    try { own = this.#patience((await this.#runner.get(REF.kind, REF.id))?.body); } catch { own = undefined; }
    const hours = own ?? DEFAULT_PATIENCE_HOURS;
    return hours === "off" ? undefined : hours * 3600_000;
  }

  #patience(body: unknown): number | "off" | undefined {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
    const v = (body as ReconnectSettingsBody).patienceHours;
    return v === "off" || (typeof v === "number" && Number.isFinite(v) && v > 0 && v <= MAX_PATIENCE_HOURS) ? v : undefined;
  }

  /** The mode in force now. */
  async effective(): Promise<ReacceptMode> {
    let own: ReacceptMode | undefined;
    try { own = this.#own((await this.#runner.get(REF.kind, REF.id))?.body); } catch { own = undefined; }
    return own ?? profileReaccept(await this.#profile());
  }

  #own(body: unknown): ReacceptMode | undefined {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
    const v = (body as ReconnectSettingsBody).reaccept;
    return typeof v === "string" && MODES.includes(v) ? v as ReacceptMode : undefined;
  }

  async #profile(): Promise<string> {
    try { return ((await this.#runner.get("approval-policy", "installation"))?.body as unknown as { profile?: string } | undefined)?.profile ?? "strict"; } catch { return "strict"; }
  }
}
