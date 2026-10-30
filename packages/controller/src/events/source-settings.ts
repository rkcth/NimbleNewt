import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { EventSource } from "./adapters.js";

const REF = { kind: "event-source-settings", id: "main" } as const;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const SOURCE_SETTING_LIMITS = { sources: 100 } as const;

export interface EventSourceSettingsBody {
  /** Sources the owner turned off. A source not listed (including one added later by the host) is watched, which is what a controller does when nothing was set. */
  readonly disabled: readonly string[];
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/**
 * Which of the configured event sources the controller watches (card H13f): the owner's choice, kept as a list of the sources turned off. The sources themselves are configured by the host; this only switches them. Owner only.
 * - A source is named by its ID and must be one the host configured, so a typo cannot silently turn nothing off. Turning one back on may name an ID that is no longer configured (to clear an old entry).
 * - Read failure is not "all on": `disabled()` throws, and the loop that polls then polls nothing that tick.
 * - A disabled source keeps its saved position. When turned on again it continues from there, so what it finds that happened meanwhile is reported then (provisional, owner question in the notes).
 */
export class EventSourceSettingsService {
  readonly #runner: CommandRunner;
  readonly #configured: () => readonly Pick<EventSource, "id" | "type">[];

  private constructor(runner: CommandRunner, configured: () => readonly Pick<EventSource, "id" | "type">[]) { this.#runner = runner; this.#configured = configured; }

  static withEpoch(storage: ControllerStorage, epoch: number, configured: () => readonly Pick<EventSource, "id" | "type">[], options: RunnerOptions = {}): EventSourceSettingsService {
    return new EventSourceSettingsService(new CommandRunner(storage, epoch, options), configured);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly disabled: readonly string[]; readonly sources: readonly { id: string; type: string; enabled: boolean }[] }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read which event sources are watched`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const off = new Set((found?.body as unknown as EventSourceSettingsBody | undefined)?.disabled ?? []);
    return { revision: found?.revision ?? 0, disabled: [...off].sort(), sources: this.#configured().map((s) => ({ id: s.id, type: s.type, enabled: !off.has(s.id) })) };
  }

  /** The owner names every source to leave off (the list replaces the earlier one; an empty list turns all on). */
  async set(owner: Principal, command: NoActor & { disabled?: readonly string[]; expectedRevision?: number }): Promise<{ revision: number }> {
    this.#owner(owner);
    this.#fields(command, ["commandId", "disabled", "expectedRevision"]);
    if (command.disabled === undefined) throw new DomainError("invalid_command", "disabled: name the sources to leave off (an empty list turns all on)", { field: "disabled" });
    const list = this.#ids(command.disabled, "disabled", true);
    this.#revision(command.expectedRevision);
    return this.#write("event-sources.set", owner, command.commandId, { disabled: list, expectedRevision: command.expectedRevision ?? null }, command.expectedRevision, () => new Set(list));
  }

  /** The owner turns sources off or on, leaving the rest as they are (what the chat proposes, so a request that waits while the setting changes still does only what it says). */
  async change(owner: Principal, command: NoActor & { disable?: readonly string[]; enable?: readonly string[] }): Promise<{ revision: number }> {
    this.#owner(owner);
    this.#fields(command, ["commandId", "disable", "enable"]);
    const disable = command.disable === undefined ? [] : this.#ids(command.disable, "disable", true);
    const enable = command.enable === undefined ? [] : this.#ids(command.enable, "enable", false);
    if (disable.length + enable.length === 0) throw new DomainError("invalid_command", "disable: name at least one source to turn off or on", { field: "disable" });
    for (const id of disable) if (enable.includes(id)) throw new DomainError("invalid_command", `disable: ${id} is also named in enable; a source is named once`, { field: "disable" });
    return this.#write("event-sources.change", owner, command.commandId, { disable, enable }, undefined, (before) => { const next = new Set(before); for (const id of enable) next.delete(id); for (const id of disable) next.add(id); return next; });
  }

  /** The sources to leave out of this tick. Throws when the setting cannot be read: the caller then polls nothing. */
  async disabled(): Promise<ReadonlySet<string>> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return new Set((found?.body as unknown as EventSourceSettingsBody | undefined)?.disabled ?? []);
  }

  async #write(name: string, owner: Principal, commandId: string, payload: JsonObject, expected: number | undefined, compute: (before: readonly string[]) => Set<string>): Promise<{ revision: number }> {
    const result = await this.#runner.command(name, { commandId: scopedCommandId(owner.id, commandId), actor: owner.id }, async () => ({
      payload,
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        const before = current?.body as unknown as EventSourceSettingsBody | undefined;
        if (expected !== undefined && (current?.revision ?? 0) !== expected) throw new DomainError("stale_revision", `the event source setting is at revision ${current?.revision ?? 0}, not ${expected}`, { currentRevision: current?.revision ?? 0 });
        const disabled = [...compute(before?.disabled ?? [])].sort();
        if (disabled.length > SOURCE_SETTING_LIMITS.sources) throw new DomainError("invalid_command", `at most ${SOURCE_SETTING_LIMITS.sources} sources may be turned off`, { field: "disabled" });
        const next: EventSourceSettingsBody = { disabled, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { disabled: disabled.length } };
      },
    }));
    return { revision: result.revision };
  }

  #owner(by: Principal): void { if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not change which event sources are watched`); }
  #fields(command: object, allowed: string[]): void {
    const unknown = Object.keys(command).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
  }
  #revision(value: number | undefined): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
  }
  /** `mustBeConfigured`: turning a source off must name one the host configured; turning one on may name an old entry. */
  #ids(value: unknown, field: string, mustBeConfigured: boolean): string[] {
    if (!Array.isArray(value) || value.length > SOURCE_SETTING_LIMITS.sources) throw new DomainError("invalid_command", `${field}: must be a list of at most ${SOURCE_SETTING_LIMITS.sources} source IDs`, { field });
    const known = new Set(this.#configured().map((s) => s.id));
    for (const id of value) {
      if (typeof id !== "string" || !SOURCE_ID.test(id)) throw new DomainError("invalid_command", `${field}: ${String(id).slice(0, 80)} is not a source ID`, { field });
      if (mustBeConfigured && !known.has(id)) throw new DomainError("invalid_command", `${field}: ${id} is not an event source this controller has`, { field });
    }
    return [...new Set(value as string[])];
  }
}
