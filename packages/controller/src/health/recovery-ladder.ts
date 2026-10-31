import { DomainError } from "../domain/errors.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";

const REF = { kind: "recovery-ladder-settings", id: "main" } as const;

/** The recovery actions, lowest rung first (card V02c). A concern climbs them one rung at a time; a rung once taken is not taken again. */
export const RECOVERY_ACTIONS = ["nudge", "rebrief", "reassign", "pause", "stop", "hand-to-owner"] as const;
export type RecoveryAction = (typeof RECOVERY_ACTIONS)[number];
export const rungOf = (action: RecoveryAction): number => RECOVERY_ACTIONS.indexOf(action);

/** At most this many escalation levels may be named; a level past the list uses the installation default. */
export const RECOVERY_BOUNDS = { maxLevels: 16 } as const;

/**
 * The installation default (provisional, see the notes): the first supervisor may nudge, re-brief and hand the concern to the owner; reassigning and pausing the agent come once the concern has climbed a level;
 * stopping the agent is for the top (the owner's level). `owner` is the level of a concern held by the owner (agents holding `assignment.manage` act there).
 */
export function defaultActionsAt(level: number | "owner"): readonly RecoveryAction[] {
  if (level === "owner") return RECOVERY_ACTIONS;
  return level === 0 ? ["nudge", "rebrief", "hand-to-owner"] : ["nudge", "rebrief", "reassign", "pause", "hand-to-owner"];
}

export interface RecoveryLadderBody {
  /** Whether agents may take recovery steps at all (the owner is not held to this). Default true. */
  readonly enabled: boolean;
  /** Allowed actions at escalation level 0, 1, 2 ...; a level past the list uses the default. */
  readonly levels: readonly (readonly RecoveryAction[])[];
  /** Allowed actions when the concern is held by the owner; absent: the default (every action). */
  readonly owner?: readonly RecoveryAction[];
  /** The least time, in minutes, between two recovery steps of one concern taken by agents; absent: no gap (off by default; the owner is not held to it). */
  readonly minGapMinutes?: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}

export interface RecoveryPolicy { readonly enabled: boolean; readonly levels: readonly (readonly RecoveryAction[])[]; readonly owner?: readonly RecoveryAction[]; readonly minGapMinutes?: number }
export const allowedAt = (policy: RecoveryPolicy, level: number | "owner"): readonly RecoveryAction[] =>
  level === "owner" ? policy.owner ?? defaultActionsAt("owner") : policy.levels[level] ?? defaultActionsAt(level);

export function checkActions(value: unknown, field: string): RecoveryAction[] {
  if (!Array.isArray(value)) throw new DomainError("invalid_command", `${field}: must be a list of actions (${RECOVERY_ACTIONS.join(", ")})`, { field });
  const out: RecoveryAction[] = [];
  for (const a of value) {
    if (typeof a !== "string" || !(RECOVERY_ACTIONS as readonly string[]).includes(a)) throw new DomainError("invalid_command", `${field}: each action is one of ${RECOVERY_ACTIONS.join(", ")}`, { field });
    if (!out.includes(a as RecoveryAction)) out.push(a as RecoveryAction);
  }
  return out;
}
const checkGap = (v: unknown): number => { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0 || v > 10_080) throw new DomainError("invalid_command", "minGapMinutes: the stored recovery ladder is damaged", { field: "minGapMinutes" }); return v; };
export function checkLevels(value: unknown, field = "levels"): RecoveryAction[][] {
  if (!Array.isArray(value)) throw new DomainError("invalid_command", `${field}: must be a list with one list of actions per level (an empty list clears the setting)`, { field });
  if (value.length > RECOVERY_BOUNDS.maxLevels) throw new DomainError("invalid_command", `${field}: at most ${RECOVERY_BOUNDS.maxLevels} levels may be named`, { field });
  return value.map((l, i) => checkActions(l, `${field}[${i}]`));
}

/** What a recovery step does outside the concern; the controller wires these to the existing services, which check the actor's rights themselves. `key` is stable for the step, so a repeat does it once. */
export interface RecoveryContext { readonly by: Principal; readonly key: string; readonly taskId: string; readonly projectId: string; readonly concernId: string; readonly text: string; readonly to?: string; /** The agent the concern is about, pinned when the concern was opened (the bare ID), not whoever holds the task now. */ readonly agent?: string }
export interface RecoveryEffects {
  /** `key` is stable for (concern, rung, episode), not for the command, so a retry by a new command does the effect once. */
  run(action: Exclude<RecoveryAction, "hand-to-owner">, ctx: RecoveryContext): Promise<{ readonly warnings?: readonly string[] }>;
  /** Why the actor cannot take this rung at all (so the ladder may pass it), or undefined when it can be attempted. */
  unavailable?(action: Exclude<RecoveryAction, "hand-to-owner">, ctx: Omit<RecoveryContext, "text" | "key">): Promise<string | undefined>;
}

/**
 * Which recovery actions the installation allows at which escalation level (card V02c), and whether recovery steps are allowed at all. Owner only, validated, race-safe (`expectedRevision`), replay-safe.
 * `policy()` is read when a step is taken; it throws when the stored record is damaged, so a damaged record refuses steps rather than allowing wrong ones.
 */
export class RecoveryLadderService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }

  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): RecoveryLadderService {
    return new RecoveryLadderService(new CommandRunner(storage, epoch, options));
  }

  async get(by: Principal): Promise<{ readonly revision: number; readonly enabled: boolean; readonly levels: readonly (readonly RecoveryAction[])[]; readonly owner: readonly RecoveryAction[]; readonly minGapMinutes: number | null; readonly defaults: { readonly first: readonly RecoveryAction[]; readonly later: readonly RecoveryAction[]; readonly owner: readonly RecoveryAction[] } }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the recovery ladder`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const p = await this.policy();
    return { revision: found?.revision ?? 0, enabled: p.enabled, levels: p.levels, owner: allowedAt(p, "owner"), minGapMinutes: p.minGapMinutes ?? null, defaults: { first: defaultActionsAt(0), later: defaultActionsAt(1), owner: defaultActionsAt("owner") } };
  }

  /** Fields left out keep their value. `levels: []` clears the per-level lists (defaults apply); `owner` replaces the owner-level list. */
  async set(owner: Principal, command: NoActor & { levels?: unknown; owner?: unknown; enabled?: unknown; minGapMinutes?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the recovery ladder`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "levels", "owner", "enabled", "minGapMinutes", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.levels === undefined && command.owner === undefined && command.enabled === undefined && command.minGapMinutes === undefined) throw new DomainError("invalid_command", "name levels, owner, enabled or minGapMinutes", { field: "levels" });
    const levels = command.levels === undefined ? undefined : checkLevels(command.levels);
    const ownerList = command.owner === undefined ? undefined : checkActions(command.owner, "owner");
    if (command.enabled !== undefined && typeof command.enabled !== "boolean") throw new DomainError("invalid_command", "enabled: must be true or false", { field: "enabled" });
    // null or 0 clears the gap (off); otherwise whole minutes up to a week.
    if (command.minGapMinutes !== undefined && command.minGapMinutes !== null && (typeof command.minGapMinutes !== "number" || !Number.isSafeInteger(command.minGapMinutes) || command.minGapMinutes < 0 || command.minGapMinutes > 10_080)) throw new DomainError("invalid_command", "minGapMinutes: must be a whole number of minutes from 0 to 10080 (0 or null: no gap)", { field: "minGapMinutes" });
    const gap = command.minGapMinutes === undefined ? undefined : (command.minGapMinutes as number | null) ?? 0;
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("recovery.ladder.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { levels: levels ?? null, owner: ownerList ?? null, enabled: command.enabled ?? null, minGapMinutes: gap ?? null, expectedRevision: command.expectedRevision ?? null } as unknown as JsonObject,
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the recovery ladder is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const was = current === undefined ? undefined : (current.body as unknown as RecoveryLadderBody);
        const keepOwner = ownerList ?? was?.owner;
        const keepGap = gap === undefined ? was?.minGapMinutes : gap === 0 ? undefined : gap;
        const next: RecoveryLadderBody = { enabled: (command.enabled as boolean | undefined) ?? was?.enabled ?? true, levels: levels ?? was?.levels ?? [], ...(keepOwner === undefined ? {} : { owner: keepOwner }), ...(keepGap === undefined ? {} : { minGapMinutes: keepGap }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { levels: next.levels.length, enabled: next.enabled } };
      },
    }));
    return { revision: result.revision };
  }

  /** The effective setting (defaults when none is stored). A damaged record throws. */
  async policy(): Promise<RecoveryPolicy> {
    const found = await this.#runner.get(REF.kind, REF.id);
    if (found === undefined) return { enabled: true, levels: [] };
    const b = found.body as unknown as Partial<RecoveryLadderBody>;
    if (typeof b.enabled !== "boolean") throw new DomainError("invalid_command", "enabled: the stored recovery ladder is damaged", { field: "enabled" });
    return { enabled: b.enabled, levels: checkLevels(b.levels, "levels"), ...(b.owner === undefined ? {} : { owner: checkActions(b.owner, "owner") }), ...(b.minGapMinutes === undefined ? {} : { minGapMinutes: checkGap(b.minGapMinutes) }) };
  }
}
