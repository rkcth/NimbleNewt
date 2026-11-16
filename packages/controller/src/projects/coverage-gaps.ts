import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { projectId as gapProjectId } from "../domain/model.js";
import { CommandRunner, view, type RunnerOptions } from "../domain/runner.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { may, scanAll } from "./common.js";

/**
 * Times when nothing was watching (card P04f). A coverage gap is a fact with a start, an end (open while it lasts) and a reason, kept apart from the lapse of one responsibility (`CoverageService`): this is about the controller
 * and what it depends on, not about who holds a duty.
 *
 * - `controller-down`: the controller was not running. Start is the last time it was seen running (to the minute), end is when it came back.
 * - `provider-outage`: a model route, account or endpoint was unavailable, so no agent could be asked to look.
 * - `event-source-outage`: an event source could not be polled, so events that happened meanwhile may not have been seen.
 * - `events-missed`: events were lost past the retention window or between a source's saved position and now (they were not watched); a closed gap.
 */
export type GapReason = "controller-down" | "provider-outage" | "event-source-outage" | "events-missed";
export const GAP_REASONS: readonly GapReason[] = ["controller-down", "provider-outage", "event-source-outage", "events-missed"];

export interface GapBody {
  /** `installation` for everything the controller watches, or the project the gap is about. */
  readonly scope: string;
  readonly reason: GapReason;
  /** What the gap is about (`provider:model:x`, `source:files`), the same key for the same thing again. */
  readonly key: string;
  readonly start: string;
  readonly end?: string;
  readonly detail: string;
}

export const GAP_LIMITS = { detail: 300, key: 160, scan: 50_000, listed: 200 } as const;
/** A restart shorter than this leaves no gap (the first period a check can have is a minute, and a controller that is back within five has not missed a check that mattered). Provisional. */
export const DOWNTIME_MINUTES = 5;
/** Closed gaps older than this are removed (provisional; the owner-set retention of K06 does not cover them yet). */
export const GAP_KEEP_DAYS = 180;
const HEARTBEAT_EVERY_MS = 60_000;
const GC_PER_TICK = 25;

/** Model route, account and endpoint names, as the gap keys carry them: the canonical route (`model`), the account and the endpoint. */
export interface RouteNames { readonly models: readonly string[]; readonly accounts: readonly string[]; readonly endpoints: readonly string[] }
/**
 * The names the answering agent's calls can go to (T3), and `known`: every name some route of the routing table reaches now. An outage of a name outside `known` (renamed or moved since the outage, or never mapped) cannot be judged
 * against today's table and stays listed.
 */
export interface RouteUse extends RouteNames { readonly known?: RouteNames }

type Target = (route: string) => { readonly canonical: string; readonly account: string; readonly endpoint: string };
const namesOf = (routes: readonly string[], target: Target): RouteNames => {
  const t = routes.map(target);
  return { models: [...new Set(t.map((x) => x.canonical))], accounts: [...new Set(t.map((x) => x.account))], endpoints: [...new Set(t.map((x) => x.endpoint))] };
};

/**
 * The routes a dispatched task can be sent on (T3 review): the dispatcher picks each attempt's route from the task's difficulty profile (`DifficultyService.resolve`: the profile's own `provider/model` first, then its routing
 * profile's routes), and a task's difficulty can change, so every execution profile counts, mapped or not. `undefined` when no execution profiles are configured (nothing can be judged).
 */
export function dispatchRoutesOf(execution: { readonly profiles: Readonly<Record<string, { readonly provider?: string; readonly model?: string; readonly routingProfile?: string }>> } | undefined, profiles: Readonly<Record<string, readonly string[]>>): string[] | undefined {
  if (execution === undefined) return undefined;
  const out = new Set<string>();
  for (const p of Object.values(execution.profiles)) {
    if (p.provider !== undefined && p.model !== undefined) out.add(`${p.provider}/${p.model}`);
    if (p.routingProfile !== undefined && Object.hasOwn(profiles, p.routingProfile)) for (const r of profiles[p.routingProfile]!) out.add(r);
  }
  return [...out];
}

/**
 * What an agent's calls can reach (T3): the routes of its `defaultProfile` (the hosted coordinator's chat) together with `reach.dispatched`, every route a dispatched task can be sent on (`dispatchRoutesOf`: a responsibility's
 * check runs as a dispatched task, whose route comes from the task's difficulty profile, not from the agent). Known only when the agent has a `defaultProfile` that the routing table holds and no permitted override (an
 * override could send a call through another profile), and the dispatched routes are known; otherwise `undefined`, which keeps every provider outage listed (the safe direction: one too many is listed, none hidden).
 * `reach.tableRoutes` (every route of the routing table) gives `known`.
 */
export function routeUseOf(agent: { readonly defaultProfile?: string; readonly permittedOverrides?: readonly string[] }, profiles: Readonly<Record<string, readonly string[]>>, target: Target, reach: { readonly dispatched: readonly string[] | undefined; readonly tableRoutes: readonly string[] }): RouteUse | undefined {
  const profile = agent.defaultProfile;
  if (profile === undefined || (agent.permittedOverrides ?? []).length > 0 || !Object.hasOwn(profiles, profile) || reach.dispatched === undefined) return undefined;
  return { ...namesOf([...new Set([...profiles[profile]!, ...reach.dispatched])], target), known: namesOf([...new Set([...reach.tableRoutes, ...reach.dispatched, ...profiles[profile]!])], target) };
}

/** A provider outage (key `provider:<model|account|endpoint>:<name>`) touches a responsibility whose agent can reach that name; unknown routes, a name today's table does not reach, an unreadable key or a key cut at its limit stay listed. */
function outageTouches(key: string, routes: RouteUse | undefined): boolean {
  if (routes === undefined || key.length >= GAP_LIMITS.key) return true;
  const m = /^provider:(model|account|endpoint):(.+)$/.exec(key);
  if (m === null) return true;
  const pick = (n: RouteNames): readonly string[] => (m[1] === "model" ? n.models : m[1] === "account" ? n.accounts : n.endpoints);
  if (routes.known !== undefined && !pick(routes.known).includes(m[2]!)) return true;
  return pick(routes).includes(m[2]!);
}

/**
 * Whether a gap is about this responsibility (card P04h). `controller-down` is about all. `provider-outage`: only a responsibility that has an answering agent (one with nobody is recorded as not taken without asking any model, so
 * a route being down changes nothing for it) and, when the routes that agent uses are known (`routes`, T3), only an outage of one of them; unknown routes keep it listed. `event-source-outage` and `events-missed` of a source (key `source:<name>`): only a responsibility that names that source (`<name>`, or `<name>:<kind>`) in its event sources; one with
 * no event sources is not affected by an outage of an event source. A name without `:` may be an event kind (kinds never hold `:`, and a kind matches events of any source), so it is about every source's outage: listing a
 * gap too many is safe, hiding one is not. A key cut at its 160-character limit matches by its prefix. A gap kept by one responsibility's own look (key `events:<id>:...`, retention cut) is about that responsibility only. Any
 * other key stays about everything, because a gap that cannot be narrowed must not be hidden.
 */
export function gapAppliesTo(gap: { readonly reason: GapReason; readonly key: string }, duty: { readonly id: string; readonly ownerId?: string; readonly eventSources: readonly string[]; readonly routes?: RouteUse }): boolean {
  if (gap.reason === "provider-outage") return duty.ownerId !== undefined && outageTouches(gap.key, duty.routes);
  if (gap.reason === "event-source-outage" || gap.reason === "events-missed") {
    if (gap.key.startsWith("source:")) {
      const name = gap.key.slice("source:".length); const cut = gap.key.length >= 160;
      return duty.eventSources.some((n) => !n.includes(":") || n === name || n.startsWith(`${name}:`) || (cut && n.startsWith(name)));
    }
    if (gap.key.startsWith("events:")) return gap.key.startsWith(`events:${duty.id}:`);
  }
  return true;
}

const GAP = "coverage-gap";
const SLOT = "coverage-gap-slot";
const LIVE = { kind: "coverage-liveness", id: "installation" } as const;
const hash = (...parts: string[]): string => createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 24);
interface SlotBody { readonly generation: number; readonly openId?: string }
interface LiveBody { readonly lastSeenAt: string }

const asController = (by: Principal): boolean => by.kind === "owner" || by.kind === "service";
const forbidden = (by: Principal, what: string): DomainError => new DomainError("forbidden", `${by.id} may not ${what}`);

export class CoverageGapService {
  readonly #runner: CommandRunner;
  readonly #routesOf: ((ownerId: string) => Promise<RouteUse | undefined>) | undefined;
  private constructor(runner: CommandRunner, routesOf?: (ownerId: string) => Promise<RouteUse | undefined>) { this.#runner = runner; this.#routesOf = routesOf; }
  /** `routesOf` (T3): the routes an answering agent's calls can reach (`routeUseOf`); absent, or answering `undefined` or failing, every provider outage stays listed for a responsibility with an agent. */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { routesOf?: (ownerId: string) => Promise<RouteUse | undefined> } = {}): CoverageGapService { const { routesOf, ...rest } = options; return new CoverageGapService(new CommandRunner(storage, epoch, rest), routesOf); }

  /** Opens a gap for a thing that stopped being watched; a second open of the same key while one is open changes nothing. Returns whether this call opened one. Controller only (the owner or the controller's own service). */
  async open(by: Principal, command: { key: string; reason: GapReason; start: string; detail: string; scope?: string }): Promise<boolean> {
    if (!asController(by)) throw forbidden(by, "record a coverage gap");
    const { key, reason, start, detail, scope } = this.#check(command);
    const slotId = `cgs-${hash(key)}`;
    // Still open from an earlier look: nothing to write (a source that keeps failing is looked at every tick).
    const seen = (await this.#runner.get(SLOT, slotId))?.body as unknown as SlotBody | undefined;
    if (seen?.openId !== undefined && (await this.#runner.get(GAP, seen.openId)) !== undefined && ((await this.#runner.get(GAP, seen.openId))!.body as unknown as GapBody).end === undefined) return false;
    try {
      const result = await this.#runner.command("coverage.gap.open", { commandId: `cgo-${hash(key, start)}`, actor: by.id }, async () => ({
        payload: { key, reason, start, scope },
        build: async () => {
          const slot = await this.#runner.get(SLOT, slotId);
          const before = slot?.body as unknown as SlotBody | undefined;
          const open = before?.openId === undefined ? undefined : await this.#runner.get(GAP, before.openId);
          const slotRef = { kind: SLOT, id: slotId };
          if (open !== undefined && (open.body as unknown as GapBody).end === undefined) return { ref: { kind: GAP, id: open.id }, creates: false, changes: [{ type: "check" as const, ref: slotRef, ...(slot === undefined ? { expectedRevision: 0 } : { expectedRevision: slot.revision }) }], detail: { key, again: true } };
          const generation = (before?.generation ?? 0) + 1;
          const id = `cgap-${hash(key, String(generation))}`;
          const body: GapBody = { scope, reason, key, start, detail };
          const slotBody: SlotBody = { generation, openId: id };
          return { ref: { kind: GAP, id }, creates: true, changes: [
            { type: "create" as const, ref: { kind: GAP, id }, body: body as unknown as JsonObject },
            slot === undefined ? { type: "create" as const, ref: slotRef, body: slotBody as unknown as JsonObject } : { type: "update" as const, ref: slotRef, expectedRevision: slot.revision, body: slotBody as unknown as JsonObject },
          ], detail: { key, reason } };
        },
      }));
      return !result.replayed;
    } catch (error) { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict")) return false; throw error; }
  }

  /** Ends the open gap of a key at `end` (no open gap: nothing happens). Returns whether one was closed. */
  async close(by: Principal, command: { key: string; end: string }): Promise<boolean> {
    if (!asController(by)) throw forbidden(by, "record a coverage gap");
    const key = this.#key(command.key);
    const end = this.#time(command.end, "end");
    const slotId = `cgs-${hash(key)}`;
    const slot = await this.#runner.get(SLOT, slotId);
    const openId = (slot?.body as unknown as SlotBody | undefined)?.openId;
    if (slot === undefined || openId === undefined) return false;
    try {
      const result = await this.#runner.command("coverage.gap.close", { commandId: `cgc-${hash(openId, end)}`, actor: by.id }, async () => ({
        payload: { key, end },
        build: async () => {
          const cur = await this.#runner.get(SLOT, slotId);
          const id = (cur?.body as unknown as SlotBody | undefined)?.openId;
          const gap = id === undefined ? undefined : await this.#runner.get(GAP, id);
          if (cur === undefined || id === undefined || gap === undefined) return { ref: { kind: SLOT, id: slotId }, creates: false, changes: [{ type: "check" as const, ref: { kind: SLOT, id: slotId }, expectedRevision: cur?.revision ?? 0 }], detail: { key, again: true } };
          const b = gap.body as unknown as GapBody;
          const closedAt = Date.parse(end) < Date.parse(b.start) ? b.start : end;
          return { ref: { kind: GAP, id }, creates: false, changes: [
            { type: "update" as const, ref: { kind: GAP, id }, expectedRevision: gap.revision, body: { ...b, end: closedAt } as unknown as JsonObject },
            { type: "update" as const, ref: { kind: SLOT, id: slotId }, expectedRevision: cur.revision, body: { generation: (cur.body as unknown as SlotBody).generation } as unknown as JsonObject },
          ], detail: { key } };
        },
      }));
      return !result.replayed;
    } catch (error) { if (error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict")) return false; throw error; }
  }

  /** Records a gap that is already over (one id per reason, key, scope and start, so a repeat records nothing). Returns whether this call wrote it. */
  async record(by: Principal, command: { key: string; reason: GapReason; start: string; end: string; detail: string; scope?: string }): Promise<boolean> {
    if (!asController(by)) throw forbidden(by, "record a coverage gap");
    const { key, reason, start, detail, scope } = this.#check(command);
    const end = this.#time(command.end, "end");
    if (Date.parse(end) < Date.parse(start)) throw new DomainError("invalid_command", "end: must not be before the start", { field: "end" });
    const id = `cgap-${hash(key, reason, start, scope)}`;
    try {
      const result = await this.#runner.command("coverage.gap.record", { commandId: id, actor: by.id }, async () => ({
        payload: { key, reason, start, end, scope },
        build: async () => ({ ref: { kind: GAP, id }, creates: true, changes: [{ type: "create" as const, ref: { kind: GAP, id }, body: { scope, reason, key, start, end, detail } as unknown as JsonObject }], detail: { key, reason } }),
      }));
      return !result.replayed;
    } catch (error) { if (error instanceof DomainError && error.code === "command_conflict") return false; throw error; }
  }

  /**
   * The controller says it is running. The first call of a process (`startup`) compares with the last time it was seen: an absence longer than `DOWNTIME_MINUTES` becomes a closed `controller-down` gap from then to now. Later calls
   * only keep the time (at most once a minute) and, bounded to a few per call, remove closed gaps past `GAP_KEEP_DAYS`.
   */
  async heartbeat(by: Principal, options: { startup?: boolean } = {}): Promise<{ downtime?: { start: string; end: string } }> {
    if (!asController(by)) throw forbidden(by, "record a coverage gap");
    const now = this.#runner.now();
    const found = await this.#runner.get(LIVE.kind, LIVE.id);
    const last = (found?.body as unknown as LiveBody | undefined)?.lastSeenAt;
    let downtime: { start: string; end: string } | undefined;
    if (options.startup === true && last !== undefined && Date.parse(now) - Date.parse(last) > DOWNTIME_MINUTES * 60_000) {
      downtime = { start: last, end: now };
      await this.record(by, { key: "controller", reason: "controller-down", start: last, end: now, detail: "NimbleNewt was not running, so no check was generated and no alert was seen in this time." });
    }
    // Also when the clock went back: a last-seen time left in the future would hide a later real absence (now minus a future time is never over the threshold).
    const since = last === undefined ? Number.NaN : Date.parse(now) - Date.parse(last);
    if (found === undefined || options.startup === true || !Number.isFinite(since) || since < 0 || since >= HEARTBEAT_EVERY_MS) {
      try {
        await this.#runner.command("coverage.liveness", { commandId: `cgl-${hash(now, String(found?.revision ?? 0))}`, actor: by.id }, async () => ({
          payload: { at: now },
          build: async () => ({ ref: LIVE, creates: found === undefined, changes: [found === undefined ? { type: "create" as const, ref: LIVE, body: { lastSeenAt: now } as unknown as JsonObject } : { type: "update" as const, ref: LIVE, expectedRevision: found.revision, body: { lastSeenAt: now } as unknown as JsonObject }], detail: { at: now } }),
        }));
      } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict"))) throw error; }
    }
    await this.#gc(by, now);
    return downtime === undefined ? {} : { downtime };
  }

  /**
   * The gaps a reader may see, newest start first (open ones first): those of the whole installation and, for a project, that project's. A reader sees them when they may read the project's responsibilities (installation
   * gaps need that right in some project, here the one asked about). `truncated` when more were kept than `limit`.
   */
  async list(by: Principal, projectIdValue: string, options: { open?: boolean; limit?: number } = {}): Promise<{ items: (GapBody & { id: string; open: boolean })[]; truncated: boolean } | undefined> {
    const projectId = gapProjectId(projectIdValue);
    if (!(by.kind === "owner" || by.kind === "service" || may(by, "responsibility.read", projectId))) return undefined;
    const found = await scanAll(this.#runner, GAP, GAP_LIMITS.scan, (a) => { const g = a.body as unknown as GapBody; return g.scope === "installation" || g.scope === projectId; });
    const limit = Math.max(1, Math.min(options.limit ?? 50, GAP_LIMITS.listed));
    const all = found.map((a) => ({ ...view<GapBody>(a), open: (a.body as unknown as GapBody).end === undefined })).filter((g) => options.open !== true || g.open);
    all.sort((a, b) => (a.open === b.open ? (a.start < b.start ? 1 : a.start > b.start ? -1 : a.id < b.id ? -1 : 1) : a.open ? -1 : 1));
    return { items: all.slice(0, limit).map(({ revision: _r, createdAt: _c, updatedAt: _u, ...rest }) => { void _r; void _c; void _u; return rest as GapBody & { id: string; open: boolean }; }), truncated: all.length > limit };
  }

  /** Whether any gap of the installation or the project overlaps the time span (only those about the responsibility `about`, when given: `gapAppliesTo`): the check that "no recent observation" is explained by a gap, not by neglect. */
  async covering(by: Principal, projectIdValue: string, from: string, to: string, about?: { readonly id: string; readonly ownerId?: string; readonly eventSources: readonly string[]; readonly routes?: RouteUse }): Promise<{ id: string; reason: GapReason; start: string; end?: string }[]> {
    const listed = await this.list(by, projectIdValue, { limit: GAP_LIMITS.listed });
    const a = Date.parse(from); const b = Date.parse(to);
    const inTime = (listed?.items ?? []).filter((g) => Date.parse(g.start) <= b && (g.end === undefined || Date.parse(g.end) >= a));
    // The agent's routes are read only when a provider outage is among the gaps and the caller did not bring them; a failed read leaves them unknown (every outage listed).
    let known = about?.routes;
    if (about !== undefined && known === undefined && about.ownerId !== undefined && this.#routesOf !== undefined && inTime.some((g) => g.reason === "provider-outage")) { try { known = await this.#routesOf(about.ownerId); } catch { known = undefined; } }
    const duty = about === undefined ? undefined : { ...about, ...(known === undefined ? {} : { routes: known }) };
    return inTime.filter((g) => duty === undefined || gapAppliesTo(g, duty)).map((g) => ({ id: g.id, reason: g.reason, start: g.start, ...(g.end === undefined ? {} : { end: g.end }) }));
  }

  async #gc(by: Principal, now: string): Promise<void> {
    const cutoff = Date.parse(now) - GAP_KEEP_DAYS * 86_400_000;
    let removed = 0;
    for (const row of await this.#runner.list(GAP, { limit: 200 })) {
      const b = row.body as unknown as GapBody;
      if (removed >= GC_PER_TICK) break;
      if (b.end === undefined || Date.parse(b.end) >= cutoff) continue;
      try {
        await this.#runner.command("coverage.gap.remove", { commandId: `cgd-${hash(row.id, String(row.revision))}`, actor: by.id }, async () => ({
          payload: { id: row.id },
          build: async () => ({ ref: { kind: GAP, id: row.id }, creates: false, changes: [{ type: "delete" as const, ref: { kind: GAP, id: row.id }, expectedRevision: row.revision }], detail: { id: row.id } }),
        }));
        removed++;
      } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict" || error.code === "not_found"))) throw error; }
    }
  }

  #key(value: unknown): string { return typeof value === "string" && value.length >= 1 && value.length <= GAP_LIMITS.key ? value : ((): never => { throw new DomainError("invalid_command", `key: must be 1 to ${GAP_LIMITS.key} characters`, { field: "key" }); })(); }
  #time(value: unknown, field: string): string { return typeof value === "string" && Number.isFinite(Date.parse(value)) ? new Date(Date.parse(value)).toISOString() : ((): never => { throw new DomainError("invalid_command", `${field}: must be a UTC timestamp`, { field }); })(); }
  #check(c: { key: string; reason: GapReason; start: string; detail: string; scope?: string }): { key: string; reason: GapReason; start: string; detail: string; scope: string } {
    if (!GAP_REASONS.includes(c.reason)) throw new DomainError("invalid_command", `reason: must be one of ${GAP_REASONS.join(", ")}`, { field: "reason" });
    const scope = c.scope === undefined ? "installation" : c.scope === "installation" ? c.scope : gapProjectId(c.scope);
    return { key: this.#key(c.key), reason: c.reason, start: this.#time(c.start, "start"), detail: String(c.detail ?? "").replace(/[\u0000-\u001f\u2028\u2029]/g, " ").slice(0, GAP_LIMITS.detail), scope };
  }
}
