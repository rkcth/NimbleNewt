import { randomUUID } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { checkLocalWorkerLimits, defaultWorkspaceLimits, LOCAL_WORKER_LIMIT_BOUNDS, type LocalWorkerLimits } from "./worker-limits.js";

const REF = { kind: "worker-limits-settings", id: "main" } as const;
const ENFORCED_KIND = "worker-limits-enforced";
const KEEP_LAUNCHES = 10;
const MAX_ENTRIES = 12;

/** What one launch of a local agent came to (host's `LaunchEnforcement`, restated: the controller does not depend on the worker package). */
export interface LaunchRecord {
  readonly attemptId: string;
  readonly outcome: "started" | "refused";
  readonly requested: LocalWorkerLimits;
  readonly bestEffort: boolean;
  readonly enforcement: readonly { readonly limit: string; readonly value: number; readonly enforced: "full" | "partial" | "none"; readonly by?: string; readonly detail: string }[];
  readonly wallTimeMs: number;
  readonly reason?: string;
}

const text = (v: unknown, max: number): string => String(v ?? "").slice(0, max);

/** A launch record cleaned to known fields and bounded sizes; anything that is not the expected shape throws. */
function cleanLaunch(raw: LaunchRecord, at: string): JsonObject {
  if (raw === null || typeof raw !== "object" || typeof raw.attemptId !== "string" || raw.attemptId === "" || raw.attemptId.length > 200) throw new DomainError("invalid_command", "attemptId: a non-empty string", { field: "attemptId" });
  if (raw.outcome !== "started" && raw.outcome !== "refused") throw new DomainError("invalid_command", "outcome: started or refused", { field: "outcome" });
  if (!Array.isArray(raw.enforcement) || raw.enforcement.length > MAX_ENTRIES) throw new DomainError("invalid_command", "enforcement: a short list", { field: "enforcement" });
  const requested = checkLocalWorkerLimits(raw.requested, "requested") ?? {};
  const enforcement = raw.enforcement.map((e) => {
    if (!["full", "partial", "none"].includes(e.enforced)) throw new DomainError("invalid_command", "enforcement: enforced is full, partial or none", { field: "enforcement" });
    return { limit: text(e.limit, 30), value: Number.isSafeInteger(e.value) ? e.value : 0, enforced: e.enforced, ...(e.by === undefined ? {} : { by: text(e.by, 120) }), detail: text(e.detail, 300) };
  });
  return { attemptId: raw.attemptId, outcome: raw.outcome, requested: requested as unknown as JsonObject, bestEffort: raw.bestEffort === true, enforcement, wallTimeMs: Number.isSafeInteger(raw.wallTimeMs) ? raw.wallTimeMs : 0, ...(raw.reason === undefined ? {} : { reason: text(raw.reason, 500) }), at };
}

export interface WorkerLimitsSettingsBody {
  /** The figures the owner set; a figure not here falls back to the start-up configuration. */
  readonly limits: LocalWorkerLimits;
  /** True when the owner allowed a limit the host cannot enforce in full to go ahead (best effort). Absent: refused (the default). */
  readonly bestEffort?: boolean;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

/**
 * What one local agent may use, as the owner sets it (card H12k): cpus, memoryMb, diskMb, processes, with the same bounds as the start-up `dispatch.local.limits`. The owner's figures win over the start-up ones per figure.
 * Owner only, validated, race-safe (`expectedRevision`). `effective()` is what the host builder reads when it opens an agent's workspace, so a change counts from the next agent launched; agents already running keep what they started with.
 * `effective()` throws when the setting cannot be read: the caller must refuse the launch rather than run without limits.
 */
export class WorkerLimitsSettingsService {
  readonly #runner: CommandRunner;
  readonly #startup: LocalWorkerLimits | undefined;

  private constructor(runner: CommandRunner, startup: LocalWorkerLimits | undefined) { this.#runner = runner; this.#startup = startup; }

  static withEpoch(storage: ControllerStorage, epoch: number, startup: LocalWorkerLimits | undefined, options: RunnerOptions = {}): WorkerLimitsSettingsService {
    return new WorkerLimitsSettingsService(new CommandRunner(storage, epoch, options), startup);
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly bestEffort: boolean; readonly limits: LocalWorkerLimits; readonly startup: LocalWorkerLimits; readonly effective: LocalWorkerLimits }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the limits for local agents`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const limits = (found?.body as unknown as WorkerLimitsSettingsBody | undefined)?.limits ?? {};
    return { revision: found?.revision ?? 0, bestEffort: (found?.body as unknown as WorkerLimitsSettingsBody | undefined)?.bestEffort === true, limits, startup: this.#startup ?? {}, effective: defaultWorkspaceLimits(this.#startup, limits) ?? {} };
  }

  /** The owner's figures replace the earlier ones; an empty `limits` clears the setting (the start-up figures then apply). */
  async set(owner: Principal, command: NoActor & { limits?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the limits for local agents`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "limits", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.limits === undefined) throw new DomainError("invalid_command", "limits: name the figures (cpus, memoryMb, diskMb, processes); an empty object clears them", { field: "limits" });
    let limits: LocalWorkerLimits;
    try { limits = checkLocalWorkerLimits(command.limits, "limits") ?? {}; } catch (e) { throw new DomainError("invalid_command", (e as Error).message, { field: "limits" }); }
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("workers.limits.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { limits: limits as unknown as JsonObject, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the limits setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const kept = (current?.body as unknown as WorkerLimitsSettingsBody | undefined)?.bestEffort;
        const next: WorkerLimitsSettingsBody = { limits, ...(kept === undefined ? {} : { bestEffort: kept }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { figures: Object.keys(limits).length } };
      },
    }));
    return { revision: result.revision };
  }

  /**
   * The owner sets the named figures and clears the ones in `unset`, leaving the others as they are (what the chat proposes, so a request that waits while the API changes another figure still does only what it says).
   * `expectedRevision` is optional.
   */
  async change(owner: Principal, command: NoActor & { set?: unknown; unset?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the limits for local agents`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "set", "unset", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    let set: LocalWorkerLimits = {};
    if (command.set !== undefined) { try { set = checkLocalWorkerLimits(command.set, "set") ?? {}; } catch (e) { throw new DomainError("invalid_command", (e as Error).message, { field: "set" }); } }
    let unset: string[] = [];
    if (command.unset !== undefined) {
      if (!Array.isArray(command.unset)) throw new DomainError("invalid_command", "unset: must be a list of figure names", { field: "unset" });
      for (const k of command.unset) if (typeof k !== "string" || !Object.hasOwn(LOCAL_WORKER_LIMIT_BOUNDS, k)) throw new DomainError("invalid_command", `unset: ${String(k).slice(0, 30)} is not a limit (cpus, memoryMb, diskMb, processes)`, { field: "unset" });
      unset = [...new Set(command.unset as string[])].sort();
    }
    if (Object.keys(set).length + unset.length === 0) throw new DomainError("invalid_command", "set: name at least one figure to set or clear", { field: "set" });
    for (const k of unset) if (Object.hasOwn(set, k)) throw new DomainError("invalid_command", `unset: ${k} is also in set; a figure is named once`, { field: "unset" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("workers.limits.change", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { set: set as unknown as JsonObject, unset, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the limits setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const merged: Record<string, number> = { ...((current?.body as unknown as WorkerLimitsSettingsBody | undefined)?.limits ?? {}) as Record<string, number>, ...set as Record<string, number> };
        for (const k of unset) delete merged[k];
        const kept = (current?.body as unknown as WorkerLimitsSettingsBody | undefined)?.bestEffort;
        const next: WorkerLimitsSettingsBody = { limits: merged, ...(kept === undefined ? {} : { bestEffort: kept }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { figures: Object.keys(merged).length } };
      },
    }));
    return { revision: result.revision };
  }

  /**
   * The owner allows (`enabled: true`) or forbids (`false`, the default) a local agent to start when this OS cannot enforce a limit in full. Owner only, optional `expectedRevision`. Counts from the next agent launched.
   * Limits themselves are untouched.
   */
  async setBestEffort(owner: Principal, command: NoActor & { enabled?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the limits for local agents`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "enabled", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (typeof command.enabled !== "boolean") throw new DomainError("invalid_command", "enabled: true to allow best effort, false to refuse a launch whose limits cannot be enforced in full", { field: "enabled" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const enabled = command.enabled;
    const result = await this.#runner.command("workers.limits.besteffort", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { enabled, expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the limits setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = current?.body as unknown as WorkerLimitsSettingsBody | undefined;
        const next: WorkerLimitsSettingsBody = { limits: before?.limits ?? {}, bestEffort: enabled, updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { bestEffort: enabled } };
      },
    }));
    return { revision: result.revision };
  }

  /** Whether a launch may go ahead with a limit this OS cannot enforce in full. Throws when the setting cannot be read or is damaged: the host must then refuse the launch. */
  async bestEffortAllowed(): Promise<boolean> {
    const found = await this.#runner.get(REF.kind, REF.id);
    const flag = (found?.body as unknown as WorkerLimitsSettingsBody | undefined)?.bestEffort;
    if (flag !== undefined && typeof flag !== "boolean") throw new DomainError("invalid_command", "the best-effort setting is damaged");
    return flag === true;
  }

  /** Keeps what a launch came to (the last ten per attempt). Called by the host for every launch, started or refused. Each call is its own command (a launch is not a replay of an earlier one). */
  async recordLaunch(record: LaunchRecord): Promise<void> {
    const at = this.#runner.now();
    const clean = cleanLaunch(record, at);
    const id = clean["attemptId"] as string;
    await this.#runner.command("workers.limits.enforced", { commandId: `wle-${randomUUID()}`, actor: "host" }, async () => ({
      payload: { launch: clean },
      build: async () => {
        const ref = { kind: ENFORCED_KIND, id } as const;
        const current = await this.#runner.get(ref.kind, ref.id);
        const before = (current?.body as unknown as { launches?: JsonObject[]; count?: number } | undefined);
        const launches = [...(before?.launches ?? []), clean].slice(-KEEP_LAUNCHES);
        const body = { attemptId: id, count: (before?.count ?? 0) + 1, launches } as unknown as JsonObject;
        const change = current === undefined ? { type: "create" as const, ref, body } : { type: "update" as const, ref, expectedRevision: current.revision, body };
        return { ref, creates: current === undefined, changes: [change], detail: { outcome: clean["outcome"] as string } };
      },
    }));
  }

  /** What the launches of one attempt came to (owner only). */
  async enforced(by: Principal, attemptId: string): Promise<{ readonly attemptId: string; readonly count: number; readonly launches: readonly JsonObject[] }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the limits applied to local agents`);
    if (typeof attemptId !== "string" || attemptId === "" || attemptId.length > 200) throw new DomainError("invalid_command", "attemptId: a non-empty string", { field: "attemptId" });
    const found = await this.#runner.get(ENFORCED_KIND, attemptId);
    if (found === undefined) throw new DomainError("not_found", "no launch of this attempt was recorded");
    const body = found.body as unknown as { count: number; launches: JsonObject[] };
    return { attemptId, count: body.count, launches: body.launches };
  }

  /** The limits to give an agent being launched now: start-up figures with the owner's over them. Re-checked on read, so a damaged record throws rather than being used. */
  async effective(): Promise<LocalWorkerLimits | undefined> {
    const found = await this.#runner.get(REF.kind, REF.id);
    return defaultWorkspaceLimits(this.#startup, (found?.body as unknown as WorkerLimitsSettingsBody | undefined)?.limits);
  }
}
