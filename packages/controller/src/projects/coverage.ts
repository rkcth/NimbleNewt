import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { projectId as coverageProjectId } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { may } from "./common.js";
import type { ResponsibilityBody } from "./responsibilities.js";

const REF = { kind: "coverage-settings", id: "main" } as const;
/** Bounds of the lapse period in minutes, and the period used when the alert is turned on without naming one (provisional: one day). */
export const COVERAGE_PERIOD = { min: 1, max: 525_600, default: 1_440 } as const;
const wholeMinutes = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= COVERAGE_PERIOD.min && v <= COVERAGE_PERIOD.max;
/** The work bounds (card P04 review): the sweep looks at one slice of the installation's responsibilities per tick (a persisted cursor rotates through them, so no tick reads them all); a report looks at no more than this many records per call and says where it stopped. */
export const COVERAGE_WORK = { slice: 200, reportExamine: 2_000, noticeItems: 10 } as const;
const PAGE_MAX = 100;
const DISPATCHER = "service:dispatcher";

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
  /** The earliest time any of the reasons began to hold: the time the lapse was first seen (kept, so an unrelated edit does not move it), or the moment it is known to have begun. */
  readonly since: string;
  readonly lapsedMinutes: number;
  /** The gap is longer than the alert period (false when no period applies, which is when the alert is off or damaged). */
  readonly beyondPeriod: boolean;
  readonly holder?: string;
  readonly lastCheckAt?: string;
}
/** `status` says what the alert is: `damaged` is not `off` (a damaged setting is neither on nor off; mend it with coverage.settings.set). */
export interface CoverageReport { readonly items: CoverageGap[]; readonly next?: string; /** True when the search stopped at its work bound before the end: ask again from `next`. */ readonly partial?: true; readonly asOf: string; readonly alert: CoverageSettings & { readonly status: "on" | "off" | "damaged" } }

/** One notice for one project: up to a few responsibilities by name, and the count of all of them. */
export interface CoverageNotice {
  readonly alertId: string;
  readonly projectId: string;
  readonly count: number;
  readonly items: readonly { readonly responsibilityId: string; readonly title: string; readonly reasons: readonly CoverageReason[]; readonly since: string; readonly lapsedMinutes: number }[];
  /** Every responsibility the notice covers (bounded by the slice), marked as told once the notice is sent. */
  readonly covered: readonly string[];
}

/** The kept record of a lapse (kind `coverage-lapse`, the responsibility's ID): when each reason was first seen. It is written when a lapse is first seen and emptied when the gap closes. */
interface LapseBody { readonly projectId: string; readonly seen: Partial<Record<CoverageReason, string>>; /** When this episode was told to the owner. */ readonly toldAt?: string }
const LAPSE = "coverage-lapse";
const CURSOR = { kind: "coverage-cursor", id: "main" } as const;
const PROJECT_TOLD = "coverage-project";
const lapseBody = (b: unknown): LapseBody | undefined => {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return undefined;
  const r = b as Record<string, unknown>;
  if (typeof r["projectId"] !== "string" || r["seen"] === null || typeof r["seen"] !== "object" || Array.isArray(r["seen"])) return undefined;
  const seen: Partial<Record<CoverageReason, string>> = {};
  for (const [k, v] of Object.entries(r["seen"] as Record<string, unknown>)) if ((k === "no-holder" || k === "no-recent-check" || k === "unscheduled") && typeof v === "string" && Number.isFinite(Date.parse(v))) seen[k] = v;
  return { projectId: r["projectId"], seen, ...(typeof r["toldAt"] === "string" ? { toldAt: r["toldAt"] } : {}) };
};

interface Reads {
  holderState(holder: string): Promise<{ active: boolean; since?: string }>;
}

/**
 * Coverage of ongoing responsibilities (card P04): which active responsibilities have no active holder, no recent check (none yet, or the last one older than twice the period: the same rule as `observed`, so
 * "no recent observation" is never counted as covered) or no check schedule at all (a responsibility driven by event sources is not "unscheduled"). A paused or retired responsibility is not expected to be covered and
 * is not listed. The report is a read; the sweep (dispatcher only) keeps the time each lapse was first seen and tells the owner, one notice per project per period.
 */
export class CoverageService {
  readonly #runner: CommandRunner;
  readonly #settings: Pick<CoverageSettingsService, "effective">;
  readonly #reads: Reads;
  readonly #slice: number;
  readonly #examine: number;

  private constructor(runner: CommandRunner, settings: Pick<CoverageSettingsService, "effective">, slice: number, examine: number) {
    this.#runner = runner; this.#settings = settings; this.#slice = slice; this.#examine = examine;
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

  static withEpoch(storage: ControllerStorage, epoch: number, settings: Pick<CoverageSettingsService, "effective">, options: RunnerOptions & { slice?: number; reportExamine?: number } = {}): CoverageService {
    return new CoverageService(new CommandRunner(storage, epoch, options), settings, options.slice ?? COVERAGE_WORK.slice, options.reportExamine ?? COVERAGE_WORK.reportExamine);
  }

  /** The reasons a responsibility is not covered and when each is known to have begun (before any kept first-seen time is applied). */
  async #assess(r: ResponsibilityBody & { id: string; createdAt: string; updatedAt: string }, now: number): Promise<{ reasons: CoverageReason[]; natural: Partial<Record<CoverageReason, number>>; lastCheckAt?: string }> {
    const reasons: CoverageReason[] = [];
    const natural: Partial<Record<CoverageReason, number>> = {};
    if (r.ownerId === undefined) { reasons.push("no-holder"); natural["no-holder"] = Date.parse(r.updatedAt); }
    else { const h = await this.#reads.holderState(r.ownerId); if (!h.active) { reasons.push("no-holder"); natural["no-holder"] = Date.parse(h.since ?? r.updatedAt); } }
    let lastCheckAt: string | undefined;
    if (r.everyMinutes === undefined) {
      // Driven by events, not by a clock: it has no schedule to miss, so it is not "unscheduled".
      if ((r.eventSources ?? []).length === 0) { reasons.push("unscheduled"); natural["unscheduled"] = Date.parse(r.updatedAt); }
    } else {
      lastCheckAt = ((await this.#runner.get("responsibility-log", r.id))?.body as unknown as { lastCheckAt?: string } | undefined)?.lastCheckAt;
      const stale = Date.parse(lastCheckAt ?? r.createdAt) + 2 * r.everyMinutes * 60_000;
      if (stale < now) { reasons.push("no-recent-check"); natural["no-recent-check"] = stale; }
    }
    return { reasons, natural, ...(lastCheckAt === undefined ? {} : { lastCheckAt }) };
  }

  #gap(r: ResponsibilityBody & { id: string }, a: { reasons: CoverageReason[]; natural: Partial<Record<CoverageReason, number>>; lastCheckAt?: string }, kept: LapseBody | undefined, now: number, alertMinutes: number | undefined): CoverageGap {
    // The kept time wins over the derived one: editing the responsibility must not move the start of a lapse that was already seen.
    const since = Math.min(...a.reasons.map((x) => (kept?.seen[x] === undefined ? a.natural[x]! : Date.parse(kept.seen[x]!))));
    const lapsedMinutes = Math.max(0, Math.floor((now - since) / 60_000));
    return { responsibilityId: r.id, projectId: r.projectId, title: r.title, reasons: a.reasons, since: new Date(since).toISOString(), lapsedMinutes, beyondPeriod: alertMinutes !== undefined && lapsedMinutes >= alertMinutes, ...(r.ownerId === undefined ? {} : { holder: r.ownerId }), ...(a.lastCheckAt === undefined ? {} : { lastCheckAt: a.lastCheckAt }) };
  }

  /** The responsibilities of a project with a coverage gap, by ID, `limit` (1 to 100, default 50) after `afterId`; looks at no more than a bounded number of records per call (`partial` and `next` say where it stopped). Needs `responsibility.read` in the project. `undefined`: no such project, or not readable. */
  async report(by: Principal, projectIdValue: string, page: { afterId?: string; limit?: number } = {}): Promise<CoverageReport | undefined> {
    const projectId = coverageProjectId(projectIdValue);
    if (!(by.kind === "owner" || may(by, "responsibility.read", projectId))) return undefined;
    const limit = page.limit ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > PAGE_MAX) throw new DomainError("invalid_command", `limit: must be a whole number from 1 to ${PAGE_MAX}`, { field: "limit" });
    if (page.afterId !== undefined && (typeof page.afterId !== "string" || page.afterId.length > 120)) throw new DomainError("invalid_command", "afterId: must be an ID", { field: "afterId" });
    let alert: CoverageReport["alert"];
    try { const e = await this.#settings.effective(); alert = { ...e, status: e.enabled ? "on" : "off" }; } catch { alert = { enabled: false, afterMinutes: COVERAGE_PERIOD.default, status: "damaged" }; }
    if ((await this.#runner.get("project", projectId)) === undefined) return undefined;
    const asOf = this.#runner.now();
    const now = Date.parse(asOf);
    const gaps: CoverageGap[] = [];
    let after = page.afterId;
    let examined = 0;
    let last: string | undefined;
    let partial = false;
    scan: for (;;) {
      const want = Math.min(500, this.#examine - examined);
      const rows = await this.#runner.list("responsibility", { ...(after === undefined ? {} : { afterId: after }), limit: want });
      for (const row of rows) {
        after = row.id; last = row.id; examined++;
        const b = row.body as unknown as ResponsibilityBody;
        if (b.projectId !== projectId || b.state !== "active") continue;
        const r = view<ResponsibilityBody>(row);
        const a = await this.#assess(r, now);
        if (a.reasons.length === 0) continue;
        gaps.push(this.#gap(r, a, lapseBody((await this.#runner.get(LAPSE, r.id))?.body), now, alert.enabled ? alert.afterMinutes : undefined));
        if (gaps.length > limit) break scan;
      }
      if (rows.length < want) break;
      if (examined >= this.#examine) { partial = true; break; }
    }
    if (gaps.length > limit) { const items = gaps.slice(0, limit); return { items, next: items[items.length - 1]!.responsibilityId, asOf, alert }; }
    return { items: gaps, ...(partial && last !== undefined ? { next: last, partial: true as const } : {}), asOf, alert };
  }

  /**
   * One tick of the coverage sweep (dispatcher only): looks at the next slice of the installation's responsibilities (a kept cursor rotates through them, so the work per tick is bounded however many there are), keeps the time each
   * lapse was first seen (and empties it when the gap closes), and, when the alert is on, returns one notice for each project that has lapses beyond the period not yet told, unless that project was told within the period. The
   * notice is final only when `markTold` follows. A damaged setting keeps the bookkeeping going and then raises its error.
   */
  async sweep(by: Principal): Promise<CoverageNotice[]> {
    if (by.id !== DISPATCHER) throw new DomainError("forbidden", `${by.id} may not run the coverage sweep`);
    let alert: CoverageSettings | undefined;
    let damaged: unknown;
    try { alert = await this.#settings.effective(); } catch (error) { damaged = error; }
    const cursor = await this.#runner.get(CURSOR.kind, CURSOR.id);
    const after = (cursor?.body as { after?: unknown } | undefined)?.after;
    const rows = await this.#runner.list("responsibility", { ...(typeof after === "string" ? { afterId: after } : {}), limit: this.#slice });
    const at = this.#runner.now();
    const now = Date.parse(at);
    const pending = new Map<string, { gap: CoverageGap; seen: LapseBody }>();
    for (const row of rows) {
      const r = view<ResponsibilityBody>(row);
      const rec = await this.#runner.get(LAPSE, r.id);
      const kept = lapseBody(rec?.body);
      const a: { reasons: CoverageReason[]; natural: Partial<Record<CoverageReason, number>>; lastCheckAt?: string } = r.state === "active" ? await this.#assess(r, now) : { reasons: [], natural: {} };
      const seen: Partial<Record<CoverageReason, string>> = {};
      for (const x of a.reasons) seen[x] = kept?.seen[x] ?? new Date(Math.min(a.natural[x]!, now)).toISOString();
      const same = kept !== undefined && Object.keys(seen).length === Object.keys(kept.seen).length && (Object.keys(seen) as CoverageReason[]).every((k) => kept.seen[k] === seen[k]);
      // A new episode (the gap had closed) is not "told" yet.
      const toldAt = Object.keys(kept?.seen ?? {}).length === 0 || Object.keys(seen).length === 0 ? undefined : kept?.toldAt;
      const next: LapseBody = { projectId: r.projectId, seen, ...(toldAt === undefined ? {} : { toldAt }) };
      if (!same && !(kept === undefined && Object.keys(seen).length === 0)) await this.#put(by, LAPSE, r.id, rec, next);
      if (a.reasons.length > 0 && toldAt === undefined && alert?.enabled === true) {
        const g = this.#gap(r, a, next, now, alert.afterMinutes);
        if (g.beyondPeriod) pending.set(r.id, { gap: g, seen: next });
      }
    }
    const nextAfter = rows.length === this.#slice ? rows[rows.length - 1]!.id : undefined;
    if (nextAfter !== (typeof after === "string" ? after : undefined)) await this.#put(by, CURSOR.kind, CURSOR.id, cursor, nextAfter === undefined ? {} : { after: nextAfter });
    if (damaged !== undefined) throw damaged;
    const byProject = new Map<string, CoverageGap[]>();
    for (const { gap } of pending.values()) byProject.set(gap.projectId, [...(byProject.get(gap.projectId) ?? []), gap]);
    const notices: CoverageNotice[] = [];
    for (const [projectId, gaps] of [...byProject].sort(([x], [y]) => (x < y ? -1 : 1))) {
      const told = ((await this.#runner.get(PROJECT_TOLD, projectId))?.body as { toldAt?: unknown } | undefined)?.toldAt;
      if (typeof told === "string" && now - Date.parse(told) < alert!.afterMinutes * 60_000) continue; // one notice a project each period; these wait
      gaps.sort((x, y) => (x.since < y.since ? -1 : x.since > y.since ? 1 : x.responsibilityId < y.responsibilityId ? -1 : 1));
      const covered = gaps.map((g) => g.responsibilityId).sort();
      const digest = createHash("sha256").update(`${projectId}\0${gaps.map((g) => `${g.responsibilityId}@${g.since}`).sort().join("\0")}`).digest("hex").slice(0, 24);
      notices.push({ alertId: `cov-lapse-${digest}`, projectId, count: gaps.length, items: gaps.slice(0, COVERAGE_WORK.noticeItems).map((g) => ({ responsibilityId: g.responsibilityId, title: g.title, reasons: g.reasons, since: g.since, lapsedMinutes: g.lapsedMinutes })), covered });
    }
    return notices;
  }

  /** The notice reached the owner: its responsibilities are not told again for this lapse, and the project is not told again within the period. */
  async markTold(by: Principal, notice: CoverageNotice): Promise<void> {
    if (by.id !== DISPATCHER) throw new DomainError("forbidden", `${by.id} may not run the coverage sweep`);
    const at = this.#runner.now();
    for (const id of notice.covered) {
      const rec = await this.#runner.get(LAPSE, id);
      const kept = lapseBody(rec?.body);
      if (rec === undefined || kept === undefined || kept.toldAt !== undefined) continue;
      await this.#put(by, LAPSE, id, rec, { ...kept, toldAt: at });
    }
    await this.#put(by, PROJECT_TOLD, notice.projectId, await this.#runner.get(PROJECT_TOLD, notice.projectId), { toldAt: at });
  }

  /** Writes a small bookkeeping record under a command keyed by the record and its revision; a concurrent writer that got there first is accepted (the next tick looks again). */
  async #put(by: Principal, kind: string, id: string, current: { revision: number } | undefined, body: object): Promise<void> {
    const ref = { kind, id };
    const commandId = `cov-${createHash("sha256").update(`${kind}\0${id}\0${current?.revision ?? 0}`).digest("hex").slice(0, 40)}`;
    try {
      await this.#runner.command("coverage.keep", { commandId, actor: by.id }, async () => ({
        payload: { kind, id, revision: current?.revision ?? 0, body } as unknown as JsonObject,
        build: async () => ({ ref, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref, body: body as JsonObject } : { type: "update" as const, ref, expectedRevision: current.revision, body: body as JsonObject }], detail: { kind } }),
      }));
    } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict"))) throw error; }
  }
}
