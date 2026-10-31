import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "quiet-host-settings", id: "main" } as const;
/** What happens when a host stops reporting while it holds work (owner decision 2026-10-30): the owner is warned first; the work is re-placed after a grace period unless the owner turns that off. */
export const QUIET_HOST = { graceHours: { min: 1, max: 720, default: 12 }, autoMove: { default: true } } as const;

export interface QuietHostSettingsBody {
  /** Hours the owner has to answer a quiet-host warning before the work is re-placed; absent: the installation default. */
  readonly graceHours?: number;
  /** Whether quiet hosts' work is re-placed after the grace period; absent: the installation default. false: never moved by itself (the owner can still move it). */
  readonly autoMove?: boolean;
  readonly updatedBy: string;
  readonly updatedAt: string;
}
export interface QuietHostFigures { readonly graceHours: number; readonly autoMove: boolean }
type Damage = (damage: { readonly revision: number; readonly detail: string }) => Promise<void>;

const hours = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= QUIET_HOST.graceHours.min && v <= QUIET_HOST.graceHours.max;

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
    const figures = { graceHours: startup.graceHours ?? QUIET_HOST.graceHours.default, autoMove: startup.autoMove ?? QUIET_HOST.autoMove.default };
    if (!hours(figures.graceHours)) throw new RangeError("graceHours must be a whole number from 1 to 720");
    return new QuietHostSettingsService(new CommandRunner(storage, epoch, options), figures, options.warn);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly graceHours: number | null; readonly autoMove: boolean | null; readonly default: QuietHostFigures; readonly effective: QuietHostFigures }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the quiet-host setting`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as QuietHostSettingsBody | undefined;
    const valid = body !== null && typeof body === "object" && !Array.isArray(body);
    return { revision: found?.revision ?? 0, graceHours: valid && hours(body?.graceHours) ? body!.graceHours! : null, autoMove: valid && typeof body?.autoMove === "boolean" ? body.autoMove : null, default: this.#startup, effective: await this.effective() };
  }

  /** Sets, or with `null` clears, either figure (at least one must be named). A figure not named keeps its value. It counts from the next pass of the sweep. */
  async change(owner: Principal, command: NoActor & { graceHours?: unknown; autoMove?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the quiet-host setting`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "graceHours", "autoMove", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.graceHours === undefined && command.autoMove === undefined) throw new DomainError("invalid_command", "graceHours: name graceHours or autoMove to change", { field: "graceHours" });
    if (command.graceHours !== undefined && command.graceHours !== null && !hours(command.graceHours)) throw new DomainError("invalid_command", `graceHours: must be a whole number of hours from ${QUIET_HOST.graceHours.min} to ${QUIET_HOST.graceHours.max}, or null to clear`, { field: "graceHours" });
    if (command.autoMove !== undefined && command.autoMove !== null && typeof command.autoMove !== "boolean") throw new DomainError("invalid_command", "autoMove: must be true, false or null to clear", { field: "autoMove" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("host.quiet.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { graceHours: command.graceHours === undefined ? "keep" : command.graceHours as number | null, autoMove: command.autoMove === undefined ? "keep" : command.autoMove as boolean | null, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the quiet-host setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        // A damaged earlier record is replaced, not merged: only valid figures are kept.
        const before = current?.body as unknown as QuietHostSettingsBody | undefined;
        const keptHours = before !== null && typeof before === "object" && hours(before.graceHours) ? before.graceHours : undefined;
        const keptAuto = before !== null && typeof before === "object" && typeof before.autoMove === "boolean" ? before.autoMove : undefined;
        const graceHours = command.graceHours === undefined ? keptHours : (command.graceHours as number | null) ?? undefined;
        const autoMove = command.autoMove === undefined ? keptAuto : (command.autoMove as boolean | null) ?? undefined;
        const next: QuietHostSettingsBody = { ...(graceHours === undefined ? {} : { graceHours }), ...(autoMove === undefined ? {} : { autoMove }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { graceHours: graceHours ?? null, autoMove: autoMove ?? null } };
      },
    }));
    return { revision: result.revision };
  }

  /** The figures for a pass of the sweep. Never throws for a damaged record (see the class comment); a failure to send the warning does not stop the sweep, and the next read tries again. */
  async effective(): Promise<QuietHostFigures> {
    const found = await this.#runner.get(REF.kind, REF.id);
    if (found === undefined) return this.#startup;
    const body = found.body as unknown;
    const damaged = body === null || typeof body !== "object" || Array.isArray(body)
      || ((body as QuietHostSettingsBody).graceHours !== undefined && !hours((body as QuietHostSettingsBody).graceHours))
      || ((body as QuietHostSettingsBody).autoMove !== undefined && typeof (body as QuietHostSettingsBody).autoMove !== "boolean");
    if (damaged) {
      if (this.#warn !== undefined) {
        try { await this.#warn({ revision: found.revision, detail: `the stored quiet-host setting is damaged, so no work is moved off a quiet host by itself until you set it again (host.quiet.change); the grace period reads as ${this.#startup.graceHours} hours` }); } catch { /* the next read tries again */ }
      }
      return { graceHours: this.#startup.graceHours, autoMove: false };
    }
    const b = body as QuietHostSettingsBody;
    return { graceHours: b.graceHours ?? this.#startup.graceHours, autoMove: b.autoMove ?? this.#startup.autoMove };
  }
}
