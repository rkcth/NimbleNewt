import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "ctx-route-settings", id: "main" } as const;

/** The system prompt a host assumes when a harness does not report one (the host's `UNKNOWN_SYSTEM_PROMPT_CHARS`), and an estimate of the bridge tools' schemas; together the floor of the fixed part of a route nobody has measured yet. */
export const ROUTE_FLOOR_DEFAULTS = { systemPromptChars: 8000, toolSchemaChars: 6000 } as const;
export const DEFAULT_ROUTE_FLOOR_CHARS = ROUTE_FLOOR_DEFAULTS.systemPromptChars + ROUTE_FLOOR_DEFAULTS.toolSchemaChars;
export const ROUTE_FLOOR_BOUNDS = { min: 1, max: 4_000_000 } as const;

type Name = "check" | "floorChars";
const NAMES: readonly Name[] = ["check", "floorChars"];
export interface RouteSettingsBody { check?: boolean; floorChars?: { enabled: boolean; value?: number }; updatedBy?: string; updatedAt?: string }
/** What the context service and the dispatcher use now: whether a changed route is checked at all (on by default) and the characters counted for a route not yet measured (0 when the owner turned the floor off). */
export interface RouteSettingsEffective { readonly check: boolean; readonly floorChars: number }

const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const figure = (v: unknown, field: string): number => (typeof v === "number" && Number.isSafeInteger(v) && v >= ROUTE_FLOOR_BOUNDS.min && v <= ROUTE_FLOOR_BOUNDS.max ? v : invalid(field, `floorChars must be a whole number from ${ROUTE_FLOOR_BOUNDS.min} to ${ROUTE_FLOOR_BOUNDS.max}`));
const names = (v: unknown, field: string): Name[] => {
  if (v === undefined) return [];
  if (!Array.isArray(v)) return invalid(field, "must be a list of setting names (check, floorChars)");
  return [...new Set(v.map((k) => (typeof k === "string" && (NAMES as readonly string[]).includes(k) ? (k as Name) : invalid(field, `${String(k).slice(0, 30)} is not a setting (check, floorChars)`))))].sort();
};
function read(body: unknown, revision?: number): RouteSettingsBody {
  if (body === undefined) return {};
  const b = body as { check?: unknown; floorChars?: { enabled?: unknown; value?: unknown } };
  const bad = body === null || typeof body !== "object" || Array.isArray(body) || (b.check !== undefined && typeof b.check !== "boolean")
    || (b.floorChars !== undefined && (b.floorChars === null || typeof b.floorChars !== "object" || typeof b.floorChars.enabled !== "boolean" || (b.floorChars.value !== undefined && !(typeof b.floorChars.value === "number" && Number.isSafeInteger(b.floorChars.value)))));
  if (bad) throw new DomainError("integrity", "the context route setting is damaged", revision === undefined ? {} : { currentRevision: revision });
  return { ...(b.check === undefined ? {} : { check: b.check as boolean }), ...(b.floorChars === undefined ? {} : { floorChars: b.floorChars as { enabled: boolean; value?: number } }) };
}

/**
 * Two settings of the route-change check (card C07f), both chat-settable and both ON by default: `check` (whether the dispatcher rebuilds the context of a task that moves to another route before the attempt starts; off: it starts as before)
 * and `floorChars` (the characters counted as the fixed part of a route nobody has measured yet; off: nothing is counted). `set` gives a figure, `enable` and `disable` switch a setting (the figure is kept), `unset` returns to the default.
 */
export class ContextRouteSettingsService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): ContextRouteSettingsService { return new ContextRouteSettingsService(new CommandRunner(storage, epoch, options)); }

  async effective(): Promise<RouteSettingsEffective> {
    const found = await this.#runner.get(REF.kind, REF.id);
    const b = read(found?.body, found?.revision);
    return { check: b.check ?? true, floorChars: b.floorChars === undefined ? DEFAULT_ROUTE_FLOOR_CHARS : b.floorChars.enabled ? (b.floorChars.value ?? DEFAULT_ROUTE_FLOOR_CHARS) : 0 };
  }

  async get(by: Principal): Promise<{ revision: number; settings: RouteSettingsBody; defaults: { check: true; floorChars: number }; effective: RouteSettingsEffective }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the context route settings`);
    const found = await this.#runner.get(REF.kind, REF.id);
    return { revision: found?.revision ?? 0, settings: read(found?.body, found?.revision), defaults: { check: true, floorChars: DEFAULT_ROUTE_FLOOR_CHARS }, effective: await this.effective() };
  }

  async change(owner: Principal, command: NoActor & { set?: unknown; enable?: unknown; disable?: unknown; unset?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the context route settings`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "set", "enable", "disable", "unset", "expectedRevision"].includes(k));
    if (unknown.length > 0) invalid(unknown[0]!, "is not a field of this command");
    let setFloor: number | undefined;
    if (command.set !== undefined) {
      if (command.set === null || typeof command.set !== "object" || Array.isArray(command.set)) invalid("set", "must be an object such as { \"floorChars\": 14000 }");
      for (const [k, v] of Object.entries(command.set as object)) { if (k !== "floorChars") invalid("set", `${k.slice(0, 30)} cannot be given a figure (only floorChars)`); setFloor = figure(v, "set"); }
    }
    const enable = names(command.enable, "enable"), disable = names(command.disable, "disable"), unset = names(command.unset, "unset");
    const all = [...enable, ...disable, ...unset, ...(setFloor === undefined ? [] : ["floorChars" as Name])];
    if (all.length === 0) invalid("enable", "name at least one setting to set, enable, disable or unset");
    if (new Set(all).size !== all.length) invalid("enable", "a setting is named once across set, enable, disable and unset");
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) invalid("expectedRevision", "must be a whole number");
    const result = await this.#runner.command("context.route.settings", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { set: setFloor ?? null, enable, disable, unset, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the context route settings are at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        // A damaged record is repaired by naming the entry in this change.
        let b: RouteSettingsBody = {};
        try { b = read(current?.body, current?.revision); } catch { b = {}; }
        const next: RouteSettingsBody = { ...b };
        if (enable.includes("check")) next.check = true; if (disable.includes("check")) next.check = false; if (unset.includes("check")) delete next.check;
        if (setFloor !== undefined) next.floorChars = { enabled: true, value: setFloor };
        if (enable.includes("floorChars")) next.floorChars = { enabled: true, ...(b.floorChars?.value === undefined ? {} : { value: b.floorChars.value }) };
        if (disable.includes("floorChars")) next.floorChars = { enabled: false, ...(b.floorChars?.value === undefined ? {} : { value: b.floorChars.value }) };
        if (unset.includes("floorChars")) delete next.floorChars;
        const body = { ...next, updatedBy: owner.id, updatedAt: this.#runner.now() } as unknown as JsonObject;
        return { ref: REF, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref: REF, body } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body }], detail: {} };
      },
    }));
    return { revision: result.revision };
  }
}
