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
export const COVERAGE_WORK = { slice: 200, reportExamine: 2_000, noticeItems: 10, gc: 25, projects: 1_000, newGapMs: 3_600_000 } as const;
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

/**
 * The kept record of a lapse (kind `coverage-lapse`, the responsibility's ID): when each reason was first seen, and when the lapse was first seen beyond the alert period (`beyondAt`; it starts again when the set of reasons changes, so a different lapse is a new one).
 * It is written when a lapse is first seen and deleted when the gap closes or the responsibility is paused, retired or gone. `toldAt` is read only from records written before `beyondAt` existed.
 */
interface LapseBody { readonly projectId: string; readonly seen: Partial<Record<CoverageReason, string>>; readonly beyondAt?: string; readonly toldAt?: string }
const LAPSE = "coverage-lapse";
const CURSOR = { kind: "coverage-cursor", id: "main" } as const;
const PROJECT_TOLD = "coverage-project";
const lapseBody = (b: unknown): LapseBody | undefined => {
  if (b === null || typeof b !== "object" || Array.isArray(b)) return undefined;
  const r = b as Record<string, unknown>;
  if (typeof r["projectId"] !== "string" || r["seen"] === null || typeof r["seen"] !== "object" || Array.isArray(r["seen"])) return undefined;
  const seen: Partial<Record<CoverageReason, string>> = {};
  for (const [k, v] of Object.entries(r["seen"] as Record<string, unknown>)) if ((k === "no-holder" || k === "no-recent-check" || k === "unscheduled") && typeof v === "string" && Number.isFinite(Date.parse(v))) seen[k] = v;
  const beyond = typeof r["beyondAt"] === "string" && Number.isFinite(Date.parse(r["beyondAt"])) ? r["beyondAt"] : typeof r["toldAt"] === "string" && Number.isFinite(Date.parse(r["toldAt"])) ? r["toldAt"] : undefined;
  return { projectId: r["projectId"], seen, ...(beyond === undefined ? {} : { beyondAt: beyond }) };
};

/**
 * What a project has collected over the current lap of the sweep (kind `coverage-project`, the project's ID), so a project whose lapses sit in several slices still gets ONE notice with the true total: `lap` counts the lapses beyond the period seen so far in this lap
 * (`untold`: those first seen beyond the period after the project was last told), `last` is the total of the lap before, `toldAt` is when the last notice's lapses were gathered, and `notice` is the notice built and not yet marked told (it is offered again by each sweep until it is).
 */
interface LapItem { readonly responsibilityId: string; readonly title: string; readonly reasons: readonly CoverageReason[]; readonly since: string; readonly beyondAt: string }
interface ProjectBody { readonly toldAt?: string; readonly lap: { readonly startedAt: string; readonly count: number; readonly untold: number; readonly items: readonly LapItem[] }; readonly last?: { readonly count: number }; readonly notice?: Omit<CoverageNotice, "projectId"> & { readonly at: string } }
const projectBody = (b: unknown, now: string): ProjectBody => {
  const r = (b !== null && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
  const lap = (r["lap"] !== null && typeof r["lap"] === "object" ? r["lap"] : undefined) as { startedAt?: unknown; count?: unknown; untold?: unknown; items?: unknown } | undefined;
  const ok = (v: unknown): v is string => typeof v === "string" && Number.isFinite(Date.parse(v));
  return {
    ...(ok(r["toldAt"]) ? { toldAt: r["toldAt"] } : {}),
    lap: { startedAt: ok(lap?.startedAt) ? lap!.startedAt as string : now, count: typeof lap?.count === "number" ? lap.count : 0, untold: typeof lap?.untold === "number" ? lap.untold : 0, items: Array.isArray(lap?.items) ? (lap!.items as LapItem[]).filter((x) => x !== null && typeof x === "object" && typeof x.responsibilityId === "string").slice(0, COVERAGE_WORK.noticeItems) : [] },
    ...(r["last"] !== null && typeof r["last"] === "object" && typeof (r["last"] as { count?: unknown }).count === "number" ? { last: { count: (r["last"] as { count: number }).count } } : {}),
    ...(r["notice"] !== null && typeof r["notice"] === "object" && !Array.isArray(r["notice"]) && typeof (r["notice"] as { alertId?: unknown }).alertId === "string" ? { notice: r["notice"] as ProjectBody["notice"] & object } : {}),
  };
};
interface CursorBody { readonly after?: string; readonly projects: readonly string[]; readonly pending: readonly string[]; readonly gcLapse?: string; readonly gcProject?: string }
const cursorBody = (b: unknown): CursorBody => {
  const r = (b !== null && typeof b === "object" && !Array.isArray(b) ? b : {}) as Record<string, unknown>;
  const list = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, COVERAGE_WORK.projects) : []);
  return { ...(typeof r["after"] === "string" ? { after: r["after"] } : {}), projects: list(r["projects"]), pending: list(r["pending"]), ...(typeof r["gcLapse"] === "string" ? { gcLapse: r["gcLapse"] } : {}), ...(typeof r["gcProject"] === "string" ? { gcProject: r["gcProject"] } : {}) };
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

  /**
   * The kept time wins over the derived one: editing the responsibility must not move the start of a lapse that was already seen. One exception: a check recorded AFTER the kept first-seen time of "no recent check" means the gap closed in between (the sweep does not
   * visit every responsibility at every instant), so what is lapsed now began after that check, not at the old time.
   */
  #seenAt(kept: LapseBody | undefined, a: { natural: Partial<Record<CoverageReason, number>>; lastCheckAt?: string }, x: CoverageReason): number {
    const k = kept?.seen[x];
    if (k === undefined) return a.natural[x]!;
    if (x === "no-recent-check" && a.lastCheckAt !== undefined && Date.parse(a.lastCheckAt) > Date.parse(k)) return a.natural[x]!;
    return Date.parse(k);
  }

  #gap(r: ResponsibilityBody & { id: string }, a: { reasons: CoverageReason[]; natural: Partial<Record<CoverageReason, number>>; lastCheckAt?: string }, kept: LapseBody | undefined, now: number, alertMinutes: number | undefined): CoverageGap {
    const since = Math.min(...a.reasons.map((x) => this.#seenAt(kept, a, x)));
    const lapsedMinutes = Math.max(0, Math.floor((now - since) / 60_000));
    return { responsibilityId: r.id, projectId: r.projectId, title: r.title, reasons: a.reasons, since: new Date(since).toISOString(), lapsedMinutes, beyondPeriod: alertMinutes !== undefined && lapsedMinutes >= alertMinutes, ...(r.ownerId === undefined ? {} : { holder: r.ownerId }), ...(a.lastCheckAt === undefined ? {} : { lastCheckAt: a.lastCheckAt }) };
  }

  /** The responsibilities of a project with a coverage gap, by ID, `limit` (1 to 100, default 50) after `afterId`; looks at no more than a bounded number of records per call (`partial` and `next` say where it stopped; a page may come back with no items and `partial`, the records it looked at having no gap: the caller asks again from `next` until there is no `next`). Needs `responsibility.read` in the project. `undefined`: no such project, or not readable. */
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
      if (examined >= this.#examine) {
        // Stopped exactly at the bound: only say so when something is left to look at, so `next` never leads to nothing.
        partial = (await this.#runner.list("responsibility", { afterId: after!, limit: 1 })).length > 0;
        break;
      }
    }
    if (gaps.length > limit) { const items = gaps.slice(0, limit); return { items, next: items[items.length - 1]!.responsibilityId, asOf, alert }; }
    return { items: gaps, ...(partial && last !== undefined ? { next: last, partial: true as const } : {}), asOf, alert };
  }

  /**
   * One tick of the coverage sweep (dispatcher only): looks at the next slice of the installation's responsibilities (a kept cursor rotates through them, so the work per tick is bounded however many there are), keeps the time each
   * lapse was first seen (and deletes the record when the gap closes or the responsibility is paused, retired or gone), and, when the alert is on, gathers the lapses beyond the period PER PROJECT across the whole lap, so a project whose lapses sit
   * in several slices gets one notice with the true total. A notice is built when the lap completes (or, on a lap longer than the period, when the period is up; its count is then the larger of the lap so far and the last full lap), at most once per period
   * per project, EXCEPT a lapse first seen beyond the period after the last notice (a new or different one: a changed set of reasons is a new lapse) which is told at once, but not more than once an hour (or the period, if shorter). The notice is final only
   * when `markTold` follows; until then each tick offers it again with the same ID. A damaged setting keeps the bookkeeping going and then raises its error.
   */
  async sweep(by: Principal): Promise<CoverageNotice[]> {
    if (by.id !== DISPATCHER) throw new DomainError("forbidden", `${by.id} may not run the coverage sweep`);
    let alert: CoverageSettings | undefined;
    let damaged: unknown;
    try { alert = await this.#settings.effective(); } catch (error) { damaged = error; }
    const cursorRec = await this.#runner.get(CURSOR.kind, CURSOR.id);
    const cursor = cursorBody(cursorRec?.body);
    const rows = await this.#runner.list("responsibility", { ...(cursor.after === undefined ? {} : { afterId: cursor.after }), limit: this.#slice });
    const at = this.#runner.now();
    const now = Date.parse(at);
    const counting = alert?.enabled === true;
    const projectCache = new Map<string, { rec: { revision: number } | undefined; body: ProjectBody; dirty: boolean }>();
    const project = async (id: string): Promise<{ rec: { revision: number } | undefined; body: ProjectBody; dirty: boolean }> => {
      let p = projectCache.get(id);
      if (p === undefined) { const rec = await this.#runner.get(PROJECT_TOLD, id); p = { rec, body: projectBody(rec?.body, at), dirty: false }; projectCache.set(id, p); }
      return p;
    };
    for (const row of rows) {
      const r = view<ResponsibilityBody>(row);
      const rec = await this.#runner.get(LAPSE, r.id);
      const kept = lapseBody(rec?.body);
      if (r.state !== "active") { if (rec !== undefined) await this.#delete(by, LAPSE, rec); continue; }
      const a = await this.#assess(r, now);
      if (a.reasons.length === 0) { if (rec !== undefined) await this.#delete(by, LAPSE, rec); continue; }
      const seen: Partial<Record<CoverageReason, string>> = {};
      for (const x of a.reasons) seen[x] = new Date(Math.min(this.#seenAt(kept, a, x), now)).toISOString();
      const sameReasons = kept !== undefined && Object.keys(seen).length === Object.keys(kept.seen).length && (Object.keys(seen) as CoverageReason[]).every((k) => kept.seen[k] !== undefined);
      const g = this.#gap(r, a, { projectId: r.projectId, seen }, now, counting ? alert!.afterMinutes : undefined);
      // A different set of reasons is a different lapse: it is first seen beyond the period afresh and so is told again.
      const beyondAt = counting && g.beyondPeriod ? (sameReasons && kept.beyondAt !== undefined ? kept.beyondAt : at) : undefined;
      const same = sameReasons && (Object.keys(seen) as CoverageReason[]).every((k) => kept.seen[k] === seen[k]) && kept.beyondAt === beyondAt;
      if (!same) await this.#put(by, LAPSE, r.id, rec, { projectId: r.projectId, seen, ...(beyondAt === undefined ? {} : { beyondAt }) });
      if (beyondAt !== undefined) {
        const p = await project(r.projectId);
        const fresh = p.body.toldAt === undefined || Date.parse(beyondAt) > Date.parse(p.body.toldAt);
        const items = [...p.body.lap.items, { responsibilityId: r.id, title: r.title.slice(0, 120), reasons: a.reasons, since: g.since, beyondAt }]
          .sort((x, y) => (Number(Date.parse(y.beyondAt) > Date.parse(p.body.toldAt ?? "1970-01-01")) - Number(Date.parse(x.beyondAt) > Date.parse(p.body.toldAt ?? "1970-01-01"))) || (x.since < y.since ? -1 : x.since > y.since ? 1 : x.responsibilityId < y.responsibilityId ? -1 : 1))
          .slice(0, COVERAGE_WORK.noticeItems);
        p.body = { ...p.body, lap: { ...p.body.lap, count: p.body.lap.count + 1, untold: p.body.lap.untold + (fresh ? 1 : 0), items } };
        p.dirty = true;
      }
    }
    const lapDone = rows.length < this.#slice;
    const nextAfter = lapDone ? undefined : rows[rows.length - 1]!.id;
    // Which projects to decide on: those that gathered something this slice, and, when the lap is complete, every project that had something in it.
    const decide = new Set<string>(counting ? [...projectCache.keys()] : []);
    if (lapDone) for (const id of cursor.projects) decide.add(id);
    const lapProjects = new Set<string>(lapDone ? [] : [...cursor.projects, ...[...projectCache].filter(([, p]) => p.dirty).map(([id]) => id)]);
    const pending = new Set<string>(cursor.pending);
    for (const id of [...decide].sort()) {
      const p = await project(id);
      let body = p.body;
      if (counting && body.notice === undefined && body.lap.untold > 0) {
        const periodMs = alert!.afterMinutes * 60_000;
        const told = body.toldAt === undefined ? undefined : Date.parse(body.toldAt);
        const lapAge = now - Date.parse(body.lap.startedAt);
        const due = told === undefined || now - told >= periodMs ? (lapDone || lapAge >= periodMs) : now - told >= Math.min(periodMs, COVERAGE_WORK.newGapMs);
        if (due) {
          const count = lapDone ? body.lap.count : Math.max(body.lap.count, body.last?.count ?? 0);
          const items = body.lap.items.slice(0, COVERAGE_WORK.noticeItems).map((x) => ({ responsibilityId: x.responsibilityId, title: x.title, reasons: x.reasons, since: x.since, lapsedMinutes: Math.max(0, Math.floor((now - Date.parse(x.since)) / 60_000)) }));
          const digest = createHash("sha256").update(`${id}\0${body.toldAt ?? ""}\0${count}\0${body.lap.items.map((x) => `${x.responsibilityId}@${x.since}`).join("\0")}`).digest("hex").slice(0, 24);
          body = { ...body, notice: { alertId: `cov-lapse-${digest}`, count, items, covered: items.map((x) => x.responsibilityId), at } };
          p.dirty = true;
        }
      }
      if (lapDone) { body = { ...body, last: { count: body.lap.count }, lap: { startedAt: at, count: 0, untold: 0, items: [] } }; p.dirty = true; }
      p.body = body;
      if (body.notice !== undefined) pending.add(id);
      if (p.dirty) await this.#put(by, PROJECT_TOLD, id, p.rec, body);
      if (lapDone && body.lap.count === 0 && body.notice === undefined && body.last?.count === 0) { /* nothing to carry: dropped from the lap list */ }
    }
    // The lap list keeps the projects that have something in the new lap; at completion it starts again empty.
    // Bookkeeping that is no longer needed goes: records of paused, retired or gone responsibilities and of archived or gone projects (a bounded number per tick, from a kept position).
    const gc = await this.#collect(by, cursor);
    const offered: CoverageNotice[] = [];
    const stillPending: string[] = [];
    for (const id of [...pending].sort()) {
      const p = await project(id);
      const n = p.body.notice;
      if (n === undefined) continue;
      stillPending.push(id);
      if (counting) offered.push({ alertId: n.alertId, projectId: id, count: n.count, items: n.items, covered: n.covered });
    }
    const nextCursor: CursorBody = { ...(nextAfter === undefined ? {} : { after: nextAfter }), projects: [...lapProjects].slice(0, COVERAGE_WORK.projects), pending: stillPending.slice(0, COVERAGE_WORK.projects), ...gc };
    if (JSON.stringify(nextCursor) !== JSON.stringify(cursor)) await this.#put(by, CURSOR.kind, CURSOR.id, cursorRec, nextCursor);
    if (damaged !== undefined) throw damaged;
    return offered;
  }

  /** The notice reached the owner: the project is not told again until a lapse that was first seen beyond the period after this notice's gathering, or the next period. */
  async markTold(by: Principal, notice: CoverageNotice): Promise<void> {
    if (by.id !== DISPATCHER) throw new DomainError("forbidden", `${by.id} may not run the coverage sweep`);
    const at = this.#runner.now();
    const rec = await this.#runner.get(PROJECT_TOLD, notice.projectId);
    const body = projectBody(rec?.body, at);
    // The notice's own gathering time marks what it covered (a lapse first seen beyond the period after it is a new one), not the time the sending finished.
    const gathered = body.notice !== undefined && body.notice.alertId === notice.alertId ? body.notice.at : at;
    const { notice: _n, ...rest } = body; void _n;
    await this.#put(by, PROJECT_TOLD, notice.projectId, rec, { ...rest, toldAt: gathered, lap: { ...body.lap, untold: 0 } });
  }

  /** Removes a bookkeeping record (the next tick looks again when another writer got there first). */
  async #delete(by: Principal, kind: string, current: { revision: number }, id?: string): Promise<void> {
    const rec = current as { revision: number; id?: string };
    const target = id ?? rec.id!;
    const ref = { kind, id: target };
    const commandId = `covdel-${createHash("sha256").update(`${kind}\0${target}\0${current.revision}`).digest("hex").slice(0, 40)}`;
    try {
      await this.#runner.command("coverage.keep", { commandId, actor: by.id }, async () => ({
        payload: { kind, id: target, revision: current.revision, deleted: true } as unknown as JsonObject,
        build: async () => ({ ref, creates: false, changes: [{ type: "delete" as const, ref, expectedRevision: current.revision }], detail: { kind, deleted: true } }),
      }));
    } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict" || error.code === "not_found"))) throw error; }
  }

  /** The tidy-up: a bounded number of lapse records and project records are checked each tick, from kept positions that go round. Returns the positions. */
  async #collect(by: Principal, cursor: CursorBody): Promise<{ gcLapse?: string; gcProject?: string }> {
    const out: { gcLapse?: string; gcProject?: string } = {};
    const lapses = await this.#runner.list(LAPSE, { ...(cursor.gcLapse === undefined ? {} : { afterId: cursor.gcLapse }), limit: COVERAGE_WORK.gc });
    for (const row of lapses) {
      const resp = await this.#runner.get("responsibility", row.id);
      const b = lapseBody(row.body);
      if (resp === undefined || (resp.body as unknown as ResponsibilityBody).state !== "active" || b === undefined || Object.keys(b.seen).length === 0) await this.#delete(by, LAPSE, row, row.id);
    }
    if (lapses.length === COVERAGE_WORK.gc) out.gcLapse = lapses[lapses.length - 1]!.id;
    const projects = await this.#runner.list(PROJECT_TOLD, { ...(cursor.gcProject === undefined ? {} : { afterId: cursor.gcProject }), limit: COVERAGE_WORK.gc });
    for (const row of projects) {
      const proj = await this.#runner.get("project", row.id);
      if (proj === undefined || (proj.body as unknown as { state?: string }).state !== "active") await this.#delete(by, PROJECT_TOLD, row, row.id);
    }
    if (projects.length === COVERAGE_WORK.gc) out.gcProject = projects[projects.length - 1]!.id;
    return out;
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
