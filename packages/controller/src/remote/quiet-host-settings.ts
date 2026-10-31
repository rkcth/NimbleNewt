import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "quiet-host-settings", id: "main" } as const;
/** What happens when a host stops reporting while it holds work (owner decision 2026-10-30): the owner is warned first; the work is re-placed after a grace period unless the owner turns that off. */
export const QUIET_HOST = {
  graceHours: { min: 1, max: 720, default: 12 }, autoMove: { default: true },
  /** How long a host must have been reporting again, without a gap, before its quiet episode is over (a host that reports every few minutes and drops out in between is one episode, not many). Provisional default 10 minutes. */
  recoverMinutes: { min: 1, max: 1440, default: 10 },
  /** At most one needs-you notice per host in this many hours, however often the host drops out. Provisional default 6 hours. */
  noticeHours: { min: 1, max: 720, default: 6 },
} as const;
const NUMBERS = ["graceHours", "recoverMinutes", "noticeHours"] as const;
type NumberKey = (typeof NUMBERS)[number];

export interface QuietHostSettingsBody {
  /** Hours the owner has to answer a quiet-host warning before the work is re-placed; absent: the installation default. */
  readonly graceHours?: number;
  /** Whether quiet hosts' work is re-placed after the grace period; absent: the installation default. false: never moved by itself (the owner can still move it). */
  readonly autoMove?: boolean;
  /** Minutes of unbroken reporting that end a quiet episode; absent: the installation default. */
  readonly recoverMinutes?: number;
  /** Hours between two notices about the same host; absent: the installation default. */
  readonly noticeHours?: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}
export interface QuietHostFigures { readonly graceHours: number; readonly autoMove: boolean; readonly recoverMinutes: number; readonly noticeHours: number }
type Damage = (damage: { readonly revision: number; readonly detail: string }) => Promise<void>;

const inRange = (key: NumberKey, v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= QUIET_HOST[key].min && v <= QUIET_HOST[key].max;
const hours = (v: unknown): v is number => inRange("graceHours", v);
/** A stored record that is not an object, or holds a figure that is not valid. */
const damagedBody = (body: unknown): boolean => body === null || typeof body !== "object" || Array.isArray(body)
  || NUMBERS.some((k) => (body as Record<string, unknown>)[k] !== undefined && !inRange(k, (body as Record<string, unknown>)[k]))
  || ((body as QuietHostSettingsBody).autoMove !== undefined && typeof (body as QuietHostSettingsBody).autoMove !== "boolean");

/**
 * The owner's setting for quiet hosts: `graceHours` (1..720, default 12) and `autoMove` (default on). Owner only, race-safe (`expectedRevision`), replay-safe (command ID). The defaults come from the controller's start-up
 * figures (the installation profile / global setting) and the owner's record overrides them per figure; `null` clears one figure back to the default. `effective()` is read by the sweep at every pass.
 * A damaged record never throws and never moves work: the grace period falls back to the default, automatic moves are OFF until the owner sets the figures again, and one needs-you notice (identity: the damaged revision) says so.
 */
export class QuietHostSettingsService {
  readonly #runner: CommandRunner;
  readonly #startup: QuietHostFigures;
  readonly #warn: Damage | undefined;

  private constructor(runner: CommandRunner, startup: QuietHostFigures, warn: Damage | undefined) { this.#runner = runner; this.#startup = startup; this.#warn = warn; }

  static withEpoch(storage: ControllerStorage, epoch: number, startup: Partial<QuietHostFigures> = {}, options: RunnerOptions & { warn?: Damage } = {}): QuietHostSettingsService {
    const figures: QuietHostFigures = { graceHours: startup.graceHours ?? QUIET_HOST.graceHours.default, autoMove: startup.autoMove ?? QUIET_HOST.autoMove.default, recoverMinutes: startup.recoverMinutes ?? QUIET_HOST.recoverMinutes.default, noticeHours: startup.noticeHours ?? QUIET_HOST.noticeHours.default };
    for (const k of NUMBERS) if (!inRange(k, figures[k])) throw new RangeError(`${k} must be a whole number from ${QUIET_HOST[k].min} to ${QUIET_HOST[k].max}`);
    return new QuietHostSettingsService(new CommandRunner(storage, epoch, options), figures, options.warn);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly graceHours: number | null; readonly autoMove: boolean | null; readonly recoverMinutes: number | null; readonly noticeHours: number | null; readonly damaged: boolean; readonly default: QuietHostFigures; readonly effective: QuietHostFigures }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the quiet-host setting`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as QuietHostSettingsBody | undefined;
    const valid = body !== null && typeof body === "object" && !Array.isArray(body);
    const num = (k: NumberKey): number | null => (valid && inRange(k, body?.[k]) ? body![k]! : null);
    return { revision: found?.revision ?? 0, graceHours: num("graceHours"), autoMove: valid && typeof body?.autoMove === "boolean" ? body.autoMove : null, recoverMinutes: num("recoverMinutes"), noticeHours: num("noticeHours"), damaged: found !== undefined && damagedBody(found.body), default: this.#startup, effective: await this.effective() };
  }

  /**
   * Sets, or with `null` clears, any of the figures (at least one must be named). A figure not named keeps its value. It counts from the next pass of the sweep. When the stored record is damaged, `autoMove` must be
   * stated (true or false): fixing one figure of a damaged record never turns automatic moves back on by itself.
   */
  async change(owner: Principal, command: NoActor & { graceHours?: unknown; autoMove?: unknown; recoverMinutes?: unknown; noticeHours?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the quiet-host setting`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "graceHours", "autoMove", "recoverMinutes", "noticeHours", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (NUMBERS.every((k) => command[k] === undefined) && command.autoMove === undefined) throw new DomainError("invalid_command", "graceHours: name graceHours, autoMove, recoverMinutes or noticeHours to change", { field: "graceHours" });
    const unit: Record<NumberKey, string> = { graceHours: "hours", recoverMinutes: "minutes", noticeHours: "hours" };
    for (const k of NUMBERS) if (command[k] !== undefined && command[k] !== null && !inRange(k, command[k])) throw new DomainError("invalid_command", `${k}: must be a whole number of ${unit[k]} from ${QUIET_HOST[k].min} to ${QUIET_HOST[k].max}, or null to clear`, { field: k });
    if (command.autoMove !== undefined && command.autoMove !== null && typeof command.autoMove !== "boolean") throw new DomainError("invalid_command", "autoMove: must be true, false or null to clear", { field: "autoMove" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("host.quiet.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { ...Object.fromEntries(NUMBERS.map((k) => [k, command[k] === undefined ? "keep" : command[k] as number | null])), autoMove: command.autoMove === undefined ? "keep" : command.autoMove as boolean | null, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the quiet-host setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        // A damaged earlier record is replaced, not merged: only valid figures are kept, and automatic moves stay off until the owner says what they want.
        const damaged = current !== undefined && damagedBody(current.body);
        if (damaged && typeof command.autoMove !== "boolean") throw new DomainError("invalid_command", "autoMove: the stored setting is damaged and automatic moves are off; say autoMove true or false together with the change", { field: "autoMove" });
        const before = current?.body as unknown as QuietHostSettingsBody | undefined;
        const isObject = before !== null && typeof before === "object" && !Array.isArray(before);
        const merged: Partial<Record<NumberKey, number>> = {};
        for (const k of NUMBERS) {
          const kept = isObject && inRange(k, before[k]) ? before[k] : undefined;
          const v = command[k] === undefined ? kept : (command[k] as number | null) ?? undefined;
          if (v !== undefined) merged[k] = v;
        }
        const keptAuto = isObject && typeof before.autoMove === "boolean" ? before.autoMove : undefined;
        const autoMove = command.autoMove === undefined ? keptAuto : (command.autoMove as boolean | null) ?? undefined;
        const next: QuietHostSettingsBody = { ...merged, ...(autoMove === undefined ? {} : { autoMove }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { graceHours: merged.graceHours ?? null, autoMove: autoMove ?? null, recoverMinutes: merged.recoverMinutes ?? null, noticeHours: merged.noticeHours ?? null } };
      },
    }));
    return { revision: result.revision };
  }

  /** The figures for a pass of the sweep. Never throws for a damaged record (see the class comment); a failure to send the warning does not stop the sweep, and the next read tries again. */
  async effective(): Promise<QuietHostFigures> {
    const found = await this.#runner.get(REF.kind, REF.id);
    if (found === undefined) return this.#startup;
    const body = found.body as unknown;
    if (damagedBody(body)) {
      if (this.#warn !== undefined) {
        try { await this.#warn({ revision: found.revision, detail: `the stored quiet-host setting is damaged, so no work is moved off a quiet host by itself until you set it again (host.quiet.change, saying autoMove); the grace period reads as ${this.#startup.graceHours} hours` }); } catch { /* the next read tries again */ }
      }
      return { ...this.#startup, autoMove: false };
    }
    const b = body as QuietHostSettingsBody;
    return { graceHours: b.graceHours ?? this.#startup.graceHours, autoMove: b.autoMove ?? this.#startup.autoMove, recoverMinutes: b.recoverMinutes ?? this.#startup.recoverMinutes, noticeHours: b.noticeHours ?? this.#startup.noticeHours };
  }
}
