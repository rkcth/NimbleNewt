import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { projectId as coverageProjectId } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { hidden, may, scanAll } from "./common.js";
import type { ResponsibilityBody } from "./responsibilities.js";

const REF = { kind: "coverage-settings", id: "main" } as const;
/** Bounds of the lapse period in minutes, and the period used when the alert is turned on without naming one (provisional: one day). */
export const COVERAGE_PERIOD = { min: 1, max: 525_600, default: 1_440 } as const;
const wholeMinutes = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= COVERAGE_PERIOD.min && v <= COVERAGE_PERIOD.max;
/** Most lapsed responsibilities one project's sweep tells about per tick (bounded work); the rest are reached on the report, and when others are resolved. */
const SWEEP_MAX = 500;
const PAGE_MAX = 100;

export interface CoverageSettingsBody {
  /** The alert for a lapse beyond the period. Off unless the owner turns it on. */
  readonly enabled: boolean;
  /** The owner's period; absent means the default. */
  readonly afterMinutes?: number;
  readonly updatedBy: string;
  readonly updatedAt: string;
}
export interface CoverageSettings { readonly enabled: boolean; readonly afterMinutes: number }

/**
 * The global setting for the coverage-lapse alert (card P04, provisional choices in the notes): off by default, owner only, race-safe (`expectedRevision`), replay-safe (command ID).
 * A stored record that is damaged is an error (`unavailable`), not a silent "off" and not a silent "on".
 */
export class CoverageSettingsService {
  readonly #runner: CommandRunner;
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): CoverageSettingsService { return new CoverageSettingsService(new CommandRunner(storage, epoch, options)); }

  async get(by: Principal): Promise<{ readonly revision: number; readonly enabled: boolean; readonly afterMinutes: number | null; readonly default: number; readonly effective: CoverageSettings }> {
    if (by.kind !== "owner") throw new DomainError("forbidden", `${by.id} may not read the coverage settings`);
    const found = await this.#runner.get(REF.kind, REF.id);
    const effective = await this.effective();
    return { revision: found?.revision ?? 0, enabled: effective.enabled, afterMinutes: (found?.body as unknown as CoverageSettingsBody | undefined)?.afterMinutes ?? null, default: COVERAGE_PERIOD.default, effective };
  }

  /** Only the fields given change: `enabled` (true/false), `afterMinutes` (whole minutes, or null to go back to the default). */
  async set(owner: Principal, command: NoActor & { enabled?: unknown; afterMinutes?: unknown; expectedRevision?: number }): Promise<{ revision: number }> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not change the coverage settings`);
    const unknown = Object.keys(command).filter((k) => !["commandId", "enabled", "afterMinutes", "expectedRevision"].includes(k));
    if (unknown.length > 0) throw new DomainError("invalid_command", `${unknown[0]}: is not a field of this command`, { field: unknown[0]! });
    if (command.enabled === undefined && command.afterMinutes === undefined) throw new DomainError("invalid_command", "enabled: give enabled, afterMinutes or both", { field: "enabled" });
    if (command.enabled !== undefined && typeof command.enabled !== "boolean") throw new DomainError("invalid_command", "enabled: must be true or false", { field: "enabled" });
    if (command.afterMinutes !== undefined && command.afterMinutes !== null && !wholeMinutes(command.afterMinutes)) throw new DomainError("invalid_command", `afterMinutes: must be a whole number of minutes from ${COVERAGE_PERIOD.min} to ${COVERAGE_PERIOD.max}, or null for the default`, { field: "afterMinutes" });
    if (command.expectedRevision !== undefined && (!Number.isSafeInteger(command.expectedRevision) || command.expectedRevision < 0)) throw new DomainError("invalid_command", "expectedRevision: must be a whole number", { field: "expectedRevision" });
    const result = await this.#runner.command("coverage.settings.set", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { enabled: (command.enabled as boolean | undefined) ?? null, afterMinutes: command.afterMinutes === undefined ? "keep" : (command.afterMinutes as number | null), expectedRevision: command.expectedRevision ?? null },
      build: async () => {
        const current = await this.#runner.get(REF.kind, REF.id);
        if (command.expectedRevision !== undefined && (current?.revision ?? 0) !== command.expectedRevision) throw new DomainError("stale_revision", `the coverage setting is at revision ${current?.revision ?? 0}, not ${command.expectedRevision}`, { currentRevision: current?.revision ?? 0 });
        const before = current === undefined ? undefined : this.#parse(current.body);
        const enabled = (command.enabled as boolean | undefined) ?? before?.enabled ?? false;
        const minutes = command.afterMinutes === undefined ? before?.afterMinutes : command.afterMinutes === null ? undefined : (command.afterMinutes as number);
        const next: CoverageSettingsBody = { enabled, ...(minutes === undefined ? {} : { afterMinutes: minutes }), updatedBy: owner.id, updatedAt: this.#runner.now() };
        const change = current === undefined ? { type: "create" as const, ref: REF, body: next as unknown as JsonObject } : { type: "update" as const, ref: REF, expectedRevision: current.revision, body: next as unknown as JsonObject };
        return { ref: REF, creates: current === undefined, changes: [change], detail: { enabled, afterMinutes: minutes ?? null } };
      },
    }));
    return { revision: result.revision };
  }

  /** What applies now. No record: off, with the default period. A damaged record throws, so the alert never silently changes meaning. */
  async effective(): Promise<CoverageSettings> {
    const found = await this.#runner.get(REF.kind, REF.id);
    if (found === undefined) return { enabled: false, afterMinutes: COVERAGE_PERIOD.default };
    const body = this.#parse(found.body);
    if (body === undefined) throw new DomainError("unavailable", "the stored coverage setting is damaged; set it again (coverage.settings.set)");
    return { enabled: body.enabled, afterMinutes: body.afterMinutes ?? COVERAGE_PERIOD.default };
  }

  /** The stored body when it is well formed; a repairing `set` of a damaged record starts from the defaults. */
  #parse(body: unknown): { enabled: boolean; afterMinutes?: number } | undefined {
    if (body === null || typeof body !== "object" || Array.isArray(body)) return undefined;
    const b = body as Record<string, unknown>;
    if (typeof b["enabled"] !== "boolean" || (b["afterMinutes"] !== undefined && !wholeMinutes(b["afterMinutes"]))) return undefined;
    return { enabled: b["enabled"], ...(b["afterMinutes"] === undefined ? {} : { afterMinutes: b["afterMinutes"] as number }) };
  }
}

export type CoverageReason = "no-holder" | "no-recent-check" | "unscheduled";
export interface CoverageGap {
  readonly responsibilityId: string;
  readonly projectId: string;
  readonly title: string;
  readonly reasons: readonly CoverageReason[];
  /** The earliest time any of the reasons began to hold. */
  readonly since: string;
  readonly lapsedMinutes: number;
  /** The gap is longer than the alert period (false when no period applies, which is when the alert is off). */
  readonly beyondPeriod: boolean;
  readonly holder?: string;
  readonly lastCheckAt?: string;
}
export interface CoverageReport { readonly items: CoverageGap[]; readonly next?: string; readonly asOf: string; readonly alert: CoverageSettings }

interface Reads {
  holderState(holder: string): Promise<{ active: boolean; since?: string }>;
}

/**
 * Coverage of ongoing responsibilities (card P04): which active responsibilities have no active holder, no recent check (none yet, or the last one older than twice the period: the same rule as `observed`, so
 * "no recent observation" is never counted as covered) or no check schedule at all. A pure read, plus a sweep that finds the gaps longer than the owner's alert period. A paused or retired responsibility is not
 * expected to be covered and is not listed.
 */
export class CoverageService {
  readonly #runner: CommandRunner;
  readonly #settings: Pick<CoverageSettingsService, "effective">;
  readonly #reads: Reads;
  readonly #scanLimit: number;

  private constructor(runner: CommandRunner, settings: Pick<CoverageSettingsService, "effective">, scanLimit: number) {
    this.#runner = runner; this.#settings = settings; this.#scanLimit = scanLimit;
    this.#reads = {
      holderState: async (holder) => {
        const p = await runner.get("principal", holder);
        const pb = p?.body as unknown as { state?: string } | undefined;
        if (p === undefined || pb?.state !== "active") return { active: false, ...(p === undefined ? {} : { since: p.updatedAt }) };
        if (holder.startsWith("agent:")) {
          const a = await runner.get("agent", holder.slice("agent:".length));
          if (a !== undefined && (a.body as unknown as { state?: string }).state === "retired") return { active: false, since: a.updatedAt };
        }
        return { active: true };
      },
    };
  }

  static withEpoch(storage: ControllerStorage, epoch: number, settings: Pick<CoverageSettingsService, "effective">, options: RunnerOptions & { scanLimit?: number } = {}): CoverageService {
    return new CoverageService(new CommandRunner(storage, epoch, options), settings, options.scanLimit ?? 50_000);
  }

  async #gaps(projectId: string, alertMinutes: number | undefined): Promise<{ gaps: CoverageGap[]; asOf: string } | undefined> {
    if ((await this.#runner.get("project", projectId)) === undefined) return undefined;
    const asOf = this.#runner.now();
    const now = Date.parse(asOf);
    const gaps: CoverageGap[] = [];
    for (const a of (await scanAll(this.#runner, "responsibility", this.#scanLimit, (x) => { const b = x.body as unknown as ResponsibilityBody; return b.projectId === projectId && b.state === "active"; })).sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0))) {
      const r = view<ResponsibilityBody>(a);
      const reasons: CoverageReason[] = [];
      const starts: number[] = [];
      if (r.ownerId === undefined) { reasons.push("no-holder"); starts.push(Date.parse(r.updatedAt)); }
      else { const h = await this.#reads.holderState(r.ownerId); if (!h.active) { reasons.push("no-holder"); starts.push(Date.parse(h.since ?? r.updatedAt)); } }
      let lastCheckAt: string | undefined;
      if (r.everyMinutes === undefined) { reasons.push("unscheduled"); starts.push(Date.parse(r.updatedAt)); }
      else {
        lastCheckAt = ((await this.#runner.get("responsibility-log", r.id))?.body as unknown as { lastCheckAt?: string } | undefined)?.lastCheckAt;
        const stale = Date.parse(lastCheckAt ?? r.createdAt) + 2 * r.everyMinutes * 60_000;
        if (stale < now) { reasons.push("no-recent-check"); starts.push(stale); }
      }
      if (reasons.length === 0) continue;
      const since = Math.min(...starts);
      const lapsedMinutes = Math.max(0, Math.floor((now - since) / 60_000));
      gaps.push({ responsibilityId: r.id, projectId, title: r.title, reasons, since: new Date(since).toISOString(), lapsedMinutes, beyondPeriod: alertMinutes !== undefined && lapsedMinutes >= alertMinutes, ...(r.ownerId === undefined ? {} : { holder: r.ownerId }), ...(lastCheckAt === undefined ? {} : { lastCheckAt }) });
    }
    return { gaps, asOf };
  }

  /** The responsibilities of a project with a coverage gap, by ID, `limit` (1 to 100, default 50) after `afterId`. Needs `responsibility.read` in the project. `undefined`: no such project, or not readable (told apart from nothing). */
  async report(by: Principal, projectIdValue: string, page: { afterId?: string; limit?: number } = {}): Promise<CoverageReport | undefined> {
    const projectId = coverageProjectId(projectIdValue);
    if (!(by.kind === "owner" || may(by, "responsibility.read", projectId))) return undefined;
    const limit = page.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new DomainError("invalid_command", `limit: must be a whole number from 1 to ${PAGE_MAX}`, { field: "limit" });
    if (page.afterId !== undefined && (typeof page.afterId !== "string" || page.afterId.length > 120)) throw new DomainError("invalid_command", "afterId: must be an ID", { field: "afterId" });
    const alert = await this.#settings.effective().catch((): CoverageSettings => ({ enabled: false, afterMinutes: COVERAGE_PERIOD.default }));
    const found = await this.#gaps(projectId, alert.enabled ? alert.afterMinutes : undefined);
    if (found === undefined) return undefined;
    const rest = page.afterId === undefined ? found.gaps : found.gaps.filter((g) => g.responsibilityId > page.afterId!);
    const items = rest.slice(0, limit);
    return { items, ...(rest.length > limit ? { next: items[items.length - 1]!.responsibilityId } : {}), asOf: found.asOf, alert };
  }

  /** The gaps longer than the alert period, oldest first, at most 500; nothing when the alert is off. Owner, service, or `responsibility.write` in the project. */
  async lapsed(by: Principal, projectIdValue: string): Promise<(CoverageGap & { alertId: string })[]> {
    const projectId = coverageProjectId(projectIdValue);
    if (!(by.kind === "owner" || by.kind === "service" || may(by, "responsibility.write", projectId))) throw hidden(by, "check coverage in that project");
    const alert = await this.#settings.effective();
    if (!alert.enabled) return [];
    const found = await this.#gaps(projectId, alert.afterMinutes);
    return (found?.gaps ?? []).filter((g) => g.beyondPeriod).sort((a, b) => (a.since < b.since ? -1 : a.since > b.since ? 1 : a.responsibilityId < b.responsibilityId ? -1 : 1)).slice(0, SWEEP_MAX)
      .map((g) => ({ ...g, alertId: `cov-lapse-${createHash("sha256").update(`${g.responsibilityId}\0${g.since}`).digest("hex").slice(0, 24)}` }));
  }
}
