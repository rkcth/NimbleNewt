import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import type { EventSource } from "./adapters.js";
import { DEFINED_SOURCE_LIMITS, checkDefinition, definedSource, describeDefinition, typeOfDefinition, type DefinedSourceProbes, type SourceDefinition } from "./defined-sources.js";

const REF = { kind: "event-source-settings", id: "main" } as const;
const SOURCE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,63}$/;
export const SOURCE_SETTING_LIMITS = { sources: 100 } as const;

export interface EventSourceSettingsBody {
  /** Sources the owner turned off. A source not listed (including one added later by the host) is watched, which is what a controller does when nothing was set. */
  readonly disabled: readonly string[];
  /** Sources the owner defined (a timer, a file or folder, a git repository, a service's health address); absent in records written before they existed. */
  readonly defined?: readonly SourceDefinition[];
  readonly updatedBy: string;
  readonly updatedAt: string;
}

type Configured = Pick<EventSource, "id" | "type" | "retentionMs" | "critical">;
interface Body { readonly disabled: readonly string[]; readonly defined?: readonly SourceDefinition[] }
export interface SourceSettingsOptions extends RunnerOptions {
  /** Checks that a defined source's project (and task, when one is named) exists and that the task is in that project; throws `not_found` otherwise. Absent: not checked. */
  readonly streams?: (projectId: string, taskId: string | undefined) => Promise<void>;
  /** The probes the defined sources use (tests); absent, they look at the real machine. */
  readonly probes?: DefinedSourceProbes;
}
export interface SourceView { readonly id: string; readonly type: string; readonly enabled: boolean; readonly critical: boolean; readonly defined: boolean; readonly watches?: string; readonly definition?: SourceDefinition }

/**
 * Which event sources the controller watches (card H13f): the owner's choice, kept as a list of the sources turned off, and the sources the owner defined in settings (timers, files and folders,
 * git repositories, service health addresses). The host configures its own sources in code; the owner's defined ones are added to them without a restart (the polling loop reads them every tick). Owner only.
 * - A source is named by its ID and must be one the controller has, so a typo cannot silently turn nothing off. Turning one back on may name an ID that is no longer configured (to clear an old entry).
 * - A defined source may not take the ID of a host's source; defining an existing defined ID replaces it (and its watching starts again from a baseline). Removing one also clears it from the off-list.
 * - Read failure is not "all on": `disabled()` throws, and the loop that polls then polls nothing that tick.
 * - A disabled source keeps its saved position. When turned on again it continues from there, so what it finds that happened meanwhile is reported then (provisional, owner question in the notes).
 */
export class EventSourceSettingsService {
  readonly #runner: CommandRunner;
  readonly #host: () => readonly Configured[];
  readonly #options: SourceSettingsOptions;

  private constructor(runner: CommandRunner, host: () => readonly Configured[], options: SourceSettingsOptions) { this.#runner = runner; this.#host = host; this.#options = options; }

  /** `configured` lists the host's own sources (those given in code). */
  static withEpoch(storage: ControllerStorage, epoch: number, configured: () => readonly Configured[], options: SourceSettingsOptions = {}): EventSourceSettingsService {
    return new EventSourceSettingsService(new CommandRunner(storage, epoch, options), configured, options);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly disabled: readonly string[]; readonly sources: readonly SourceView[] }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read which event sources are watched`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const body = found?.body as unknown as EventSourceSettingsBody | undefined;
    const off = new Set(body?.disabled ?? []);
    const host = this.#host().map((s): SourceView => ({ id: s.id, type: s.type, enabled: !off.has(s.id), critical: s.critical === true, defined: false }));
    const defined = (body?.defined ?? []).map((d): SourceView => ({ id: d.id, type: typeOfDefinition(d.type), enabled: !off.has(d.id), critical: false, defined: true, watches: describeDefinition(d), definition: d }));
    return { revision: found?.revision ?? 0, disabled: [...off].sort(), sources: [...host, ...defined] };
  }

  /** The owner names every source to leave off (the list replaces the earlier one; an empty list turns all on). */
  async set(owner: Principal, command: NoActor & { disabled?: readonly string[]; expectedRevision?: number }): Promise<{ revision: number; warning?: string }> {
    this.#owner(owner);
    this.#fields(command, ["commandId", "disabled", "expectedRevision"]);
    if (command.disabled === undefined) throw new DomainError("invalid_command", "disabled: name the sources to leave off (an empty list turns all on)", { field: "disabled" });
    this.#revision(command.expectedRevision);
    const raw = command.disabled;
    this.#ids(raw, "disabled", undefined);
    return this.#write("event-sources.set", owner, command.commandId, { disabled: [...raw], expectedRevision: command.expectedRevision ?? null }, command.expectedRevision, (before) => {
      const list = this.#ids(raw, "disabled", this.#known(before));
      this.#notCritical(list, "disabled");
      return { ...before, disabled: list };
    });
  }

  /** The owner turns sources off or on, leaving the rest as they are (what the chat proposes, so a request that waits while the setting changes still does only what it says). */
  async change(owner: Principal, command: NoActor & { disable?: readonly string[]; enable?: readonly string[] }): Promise<{ revision: number; warning?: string }> {
    this.#owner(owner);
    this.#fields(command, ["commandId", "disable", "enable"]);
    const disable = command.disable === undefined ? [] : this.#ids(command.disable, "disable", undefined);
    const enable = command.enable === undefined ? [] : this.#ids(command.enable, "enable", undefined);
    if (disable.length + enable.length === 0) throw new DomainError("invalid_command", "disable: name at least one source to turn off or on", { field: "disable" });
    for (const id of disable) if (enable.includes(id)) throw new DomainError("invalid_command", `disable: ${id} is also named in enable; a source is named once`, { field: "disable" });
    this.#notCritical(disable, "disable");
    return this.#write("event-sources.change", owner, command.commandId, { disable, enable }, undefined, (before) => {
      // Turning off must name a source the controller has, as the setting stands now (a defined source may have been added or removed meanwhile).
      this.#ids(disable, "disable", this.#known(before));
      const next = new Set(before.disabled); for (const id of enable) next.delete(id); for (const id of disable) next.add(id);
      return { ...before, disabled: [...next] };
    });
  }

  /**
   * The owner defines a source in settings (or replaces one they defined under the same ID): a timer (`everyMinutes` or `at`), a file or folder (`path`), a git repository (`path`) or a service's
   * health address (`url`), reporting into the project's stream or, with `taskId`, the task's. It is polled from the next tick, starting from a baseline (what is already there is not reported).
   */
  async define(owner: Principal, command: NoActor & Record<string, unknown>): Promise<{ revision: number; replaced: boolean }> {
    this.#owner(owner);
    this.#fields(command, ["commandId", "sourceId", "type", "projectId", "taskId", "everyMinutes", "at", "path", "url", "checkSeconds"]);
    const { commandId, ...raw } = command;
    const def = checkDefinition(raw, this.#runner.now(), owner.id);
    if (this.#host().some((s) => s.id === def.id)) throw new DomainError("invalid_command", `sourceId: ${def.id} is a source the controller already has; choose another name`, { field: "sourceId" });
    if (this.#options.streams !== undefined) await this.#options.streams(def.projectId, def.taskId);
    let replaced = false;
    const r = await this.#write("event-sources.define", owner, commandId, raw as JsonObject, undefined, (before) => {
      const defined = [...(before.defined ?? [])];
      const at = defined.findIndex((d) => d.id === def.id);
      replaced = at >= 0;
      if (at >= 0) defined[at] = def; else defined.push(def);
      if (defined.length > DEFINED_SOURCE_LIMITS.defined) throw new DomainError("invalid_command", `at most ${DEFINED_SOURCE_LIMITS.defined} sources may be defined; remove one first`, { field: "sourceId" });
      return { ...before, defined };
    });
    return { revision: r.revision, replaced };
  }

  /** The owner removes a source they defined; it is no longer polled from the next tick, and it leaves the off-list. A host's source cannot be removed (it can be turned off). */
  async remove(owner: Principal, command: NoActor & { sourceId?: string }): Promise<{ revision: number }> {
    this.#owner(owner);
    this.#fields(command, ["commandId", "sourceId"]);
    const id = command.sourceId;
    if (typeof id !== "string" || !SOURCE_ID.test(id)) throw new DomainError("invalid_command", "sourceId: name the defined source to remove", { field: "sourceId" });
    const r = await this.#write("event-sources.remove", owner, command.commandId, { sourceId: id }, undefined, (before) => {
      if (!(before.defined ?? []).some((d) => d.id === id)) throw new DomainError("not_found", this.#host().some((s) => s.id === id) ? `${id} is configured by the host, not defined in settings; it can be turned off instead` : `no source called ${id} is defined`);
      return { ...before, defined: (before.defined ?? []).filter((d) => d.id !== id), disabled: before.disabled.filter((x) => x !== id) };
    });
    return { revision: r.revision };
  }

  /** The sources to leave out of this tick. Throws when the setting cannot be read: the caller then polls nothing. */
  async disabled(): Promise<ReadonlySet<string>> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return new Set((found?.body as unknown as EventSourceSettingsBody | undefined)?.disabled ?? []);
  }

  /** The event sources the owner defined, built afresh from the setting (read at every tick, so a definition counts from the next one). Throws when the setting cannot be read. */
  async definedSources(): Promise<EventSource[]> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return ((found?.body as unknown as EventSourceSettingsBody | undefined)?.defined ?? []).map((d) => definedSource(d, this.#options.probes));
  }

  /** A source declared critical cannot be switched off. */
  #notCritical(ids: readonly string[], field: string): void {
    for (const id of ids) {
      if (this.#host().find((s) => s.id === id)?.critical === true) throw new DomainError("invalid_command", `${field}: ${id} cannot be switched off; the controller relies on it`, { field });
    }
  }

  /** Every source this controller has: the host's and the owner's defined ones (as the setting stands inside the command). */
  #known(before: Body): ReadonlySet<string> { return new Set([...this.#host().map((s) => s.id), ...(before.defined ?? []).map((d) => d.id)]); }

  async #write(name: string, owner: Principal, commandId: string, payload: JsonObject, expected: number | undefined, compute: (before: Body) => Body): Promise<{ revision: number; warning?: string }> {
    let newlyOff: string[] = [];
    const result = await this.#runner.command(name, { commandId: scopedCommandId(owner.id, commandId), actor: owner.id }, async () => ({
      payload,
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        const stored = current?.body as unknown as EventSourceSettingsBody | undefined;
        if (expected !== undefined && (current?.revision ?? 0) !== expected) throw new DomainError("stale_revision", `the event source setting is at revision ${current?.revision ?? 0}, not ${expected}`, { currentRevision: current?.revision ?? 0 });
        const before: Body = { disabled: stored?.disabled ?? [], ...(stored?.defined === undefined ? {} : { defined: stored.defined }) };
        const after = compute(before);
        const disabled = [...new Set(after.disabled)].sort();
        newlyOff = disabled.filter((id) => !before.disabled.includes(id));
        if (disabled.length > SOURCE_SETTING_LIMITS.sources) throw new DomainError("invalid_command", `at most ${SOURCE_SETTING_LIMITS.sources} sources may be turned off`, { field: "disabled" });
        const next: EventSourceSettingsBody = { disabled, ...(after.defined === undefined || after.defined.length === 0 ? {} : { defined: after.defined }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { disabled: disabled.length, defined: next.defined?.length ?? 0 } };
      },
    }));
    // A source that forgets older events loses them while it is off: say so when it is turned off.
    const lossy = this.#host().filter((s) => newlyOff.includes(s.id) && s.retentionMs !== undefined);
    if (lossy.length === 0) return { revision: result.revision };
    const days = (ms: number): string => `${Math.round((ms / 86_400_000) * 10) / 10} days`;
    return { revision: result.revision, warning: lossy.map((s) => `${s.id}: events that happen while it is off and are older than ${days(s.retentionMs!)} when it is turned on again are lost; the controller will report that gap then`).join("; ") };
  }

  #owner(by: Principal): void { if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not change which event sources are watched`); }
  #fields(command: object, allowed: string[]): void {
    const unknown = Object.keys(command).filter((k) => !allowed.includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
  }
  #revision(value: number | undefined): void {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
  }
  /** `known`: turning a source off must name one the controller has; without it (turning one on, or the shape check) an old entry may be named. */
  #ids(value: unknown, field: string, known: ReadonlySet<string> | undefined): string[] {
    if (!Array.isArray(value) || value.length > SOURCE_SETTING_LIMITS.sources) throw new DomainError("invalid_command", `${field}: must be a list of at most ${SOURCE_SETTING_LIMITS.sources} source IDs`, { field });
    for (const id of value) {
      if (typeof id !== "string" || !SOURCE_ID.test(id)) throw new DomainError("invalid_command", `${field}: ${String(id).slice(0, 80)} is not a source ID`, { field });
      if (known !== undefined && !known.has(id)) throw new DomainError("invalid_command", `${field}: ${id} is not an event source this controller has`, { field });
    }
    return [...new Set(value as string[])];
  }
}
