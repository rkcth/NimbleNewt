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
  private constructor(runner: CommandRunner) { this.#runner = runner; }
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions = {}): CoverageGapService { return new CoverageGapService(new CommandRunner(storage, epoch, options)); }

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
    if (found === undefined || options.startup === true || last === undefined || Date.parse(now) - Date.parse(last) >= HEARTBEAT_EVERY_MS) {
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

  /** Whether any gap of the installation or the project overlaps the time span: the check that "no recent observation" is explained by a gap, not by neglect. */
  async covering(by: Principal, projectIdValue: string, from: string, to: string): Promise<{ id: string; reason: GapReason; start: string; end?: string }[]> {
    const listed = await this.list(by, projectIdValue, { limit: GAP_LIMITS.listed });
    const a = Date.parse(from); const b = Date.parse(to);
    return (listed?.items ?? []).filter((g) => Date.parse(g.start) <= b && (g.end === undefined || Date.parse(g.end) >= a)).map((g) => ({ id: g.id, reason: g.reason, start: g.start, ...(g.end === undefined ? {} : { end: g.end }) }));
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
