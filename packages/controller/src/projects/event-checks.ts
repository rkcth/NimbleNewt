import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { projectId as eventProjectId, type View } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { EventBody } from "../events/events.js";
import type { Principal } from "../security/principals.js";
import type { ControllerStorage, JsonObject } from "../storage/types.js";
import { hidden, may } from "./common.js";
import type { CoverageGapService } from "./coverage-gaps.js";
import type { CheckTrigger, ResponsibilityChecks } from "./checks.js";
import type { ResponsibilityBody, ResponsibilityService } from "./responsibilities.js";

/** At most this many events are read for one responsibility in one look; the rest wait for the next (the position is kept, so nothing is skipped). */
export const EVENT_CHECK_BATCH = 200;
/** At most this many events are read in one sweep of a project, whatever the number of responsibilities (responsibilities at the same position share one read). */
export const EVENT_CHECK_READS = 2000;
const CURSOR = "responsibility-event-cursor";
type Read = { events: EventBody[]; next: number; floor: number; head: number };
interface Reads { readonly cache: Map<number, Promise<Read>>; budget: number }
interface CursorBody { readonly next: number; readonly at: string }
const hash = (...p: string[]): string => createHash("sha256").update(p.join("\0")).digest("hex").slice(0, 24);

export interface EventCheckDeps {
  readonly responsibilities: Pick<ResponsibilityService, "list">;
  readonly checks: Pick<ResponsibilityChecks, "recordEvent">;
  readonly events: { since(stream: string, from: number, limit: number): Promise<{ events: EventBody[]; next: number; floor: number; head: number }> };
  readonly gaps?: Pick<CoverageGapService, "record">;
  /** Events read for one responsibility in one look (default `EVENT_CHECK_BATCH`). */
  readonly batch?: number;
  /** Events read in all in one sweep of a project (default `EVENT_CHECK_READS`). */
  readonly reads?: number;
}

/**
 * Event-driven checks (card P04f). A responsibility names `eventSources`; an event in its project's stream whose source, kind or `source:kind` is one of those names makes the responsibility owe a check, next to the scheduled ones.
 *
 * - **One check for the events of one look**, not one per event: a flood of events is one owed check that says how many events, from which source and which sequence numbers.
 * - **Each responsibility has its own position** in the project's stream. A paused responsibility's position does not move, so what happened while it was paused is looked at when it is active again (the owner's pause keeps the queue).
 * - **Nothing is missed across a restart or downtime**: the position is kept, so the events recorded while the controller was down are read on return and give their one check. If the stream's retention cut away events the position had not reached,
 *   that is recorded as a closed `events-missed` coverage gap (from the last look to now) instead of being hidden, and the look goes on from what is still kept.
 * - **A new responsibility looks from the events recorded after it was created**, not at old history.
 * - Idempotent: the check is identified by the responsibility and its first and last event, and the position moves only after the check exists, so a crash in between repeats the same check, never a second one.
 */
export class ResponsibilityEventChecks {
  readonly #runner: CommandRunner;
  readonly #deps: EventCheckDeps;
  #turn = 0;
  private constructor(runner: CommandRunner, deps: EventCheckDeps) { this.#runner = runner; this.#deps = deps; }

  static withEpoch(storage: ControllerStorage, epoch: number, deps: EventCheckDeps, options: RunnerOptions = {}): ResponsibilityEventChecks {
    return new ResponsibilityEventChecks(new CommandRunner(storage, epoch, options), deps);
  }

  /** Looks at the events of one project for every active responsibility that names event sources. Returns how many checks were newly recorded and whether more events are waiting. */
  async sweep(by: Principal, projectIdValue: string): Promise<{ recorded: number; more: boolean }> {
    const projectId = eventProjectId(projectIdValue);
    if (!(by.kind === "owner" || by.kind === "service" || may(by, "responsibility.write", projectId))) throw hidden(by, "look at events for that project");
    let recorded = 0; let more = false; let failure: unknown;
    const watching = ((await this.#deps.responsibilities.list(by, projectId, { state: "active" })) ?? []).filter((r) => r.eventSources.length > 0);
    // Bounded per sweep: responsibilities at the same position share one read, and at most `EVENT_CHECK_READS` events are read in all; those left wait for the next tick, and the start rotates so each gets its turn.
    const reads: Reads = { cache: new Map(), budget: this.#deps.reads ?? EVENT_CHECK_READS };
    const start = watching.length === 0 ? 0 : this.#turn++ % watching.length;
    for (let i = 0; i < watching.length; i++) {
      const r = watching[(start + i) % watching.length]!;
      try { const one = await this.#one(by, projectId, r, reads); recorded += one.recorded; more ||= one.more; } catch (error) { failure ??= error; }
    }
    if (failure !== undefined) throw failure;
    return { recorded, more };
  }

  /** Whether the event is about one of the names (its source, its kind, or `source:kind`). */
  static matches(names: readonly string[], event: Pick<EventBody, "kind" | "source">): string | undefined {
    const source = event.source?.id;
    for (const n of names) if (n === event.kind || (source !== undefined && (n === source || n === `${source}:${event.kind}`))) return n;
    return undefined;
  }

  async #one(by: Principal, projectId: string, r: View<ResponsibilityBody>, reads: Reads): Promise<{ recorded: number; more: boolean }> {
    const stream = `project:${projectId}`;
    const found = await this.#runner.get(CURSOR, r.id);
    const cursor = found?.body as unknown as CursorBody | undefined;
    const limit = Math.max(1, this.#deps.batch ?? EVENT_CHECK_BATCH);
    // A new responsibility starts at the first event recorded after it was created (found by halving, a few reads), not at the start of a long history.
    const from = cursor?.next ?? (await this.#firstAfter(stream, Date.parse(r.createdAt)));
    let pending = reads.cache.get(from);
    if (pending === undefined) {
      if (reads.budget <= 0) return { recorded: 0, more: true };
      // Charged by the sequence numbers actually scanned, so a look at the end of the stream (nothing new) costs nothing and does not hold back one that is behind. At most one batch over the budget.
      pending = this.#deps.events.since(stream, from, limit).then((r) => { reads.budget -= Math.max(0, r.next - Math.max(from, r.floor)); return r; });
      reads.cache.set(from, pending);
    }
    const read = await pending;
    const now = this.#runner.now();
    if (cursor !== undefined && cursor.next < read.floor && this.#deps.gaps !== undefined) {
      await this.#deps.gaps.record(by, { key: `events:${r.id}:${cursor.next}`, reason: "events-missed", start: cursor.at, end: now, scope: projectId, detail: `Events ${cursor.next} to ${read.floor - 1} of the project were cut by retention before "${r.title.slice(0, 80)}" looked at them.` });
    }
    const created = Date.parse(r.createdAt);
    const hits: { event: EventBody; name: string }[] = [];
    for (const event of read.events) {
      if (event.suppressed === true || Date.parse(event.at) < created) continue;
      const name = ResponsibilityEventChecks.matches(r.eventSources, event);
      if (name !== undefined) hits.push({ event, name });
    }
    let recorded = 0;
    if (hits.length > 0) {
      const first = hits[0]!.event; const last = hits[hits.length - 1]!.event;
      const trigger: CheckTrigger = { kind: "event", source: (first.source?.id ?? hits[0]!.name).slice(0, 120), events: hits.length, firstSeq: first.seq, lastSeq: last.seq, kinds: [...new Set(hits.map((h) => h.event.kind))].slice(0, 5) };
      // Identified by where the look started: a look repeated after a crash (or by a second instance) from the same position is the same check, even when more events arrived in between.
      if (await this.#deps.checks.recordEvent(by, projectId, r.id, trigger, last.at, from)) recorded++;
    }
    if (found === undefined || cursor === undefined || read.next !== cursor.next) await this.#move(by, r.id, found, read.next, now);
    return { recorded, more: read.next < read.head };
  }

  /** The lowest sequence number whose event was recorded at or after `at` (or the next to be written). Holes and unreadable events count as "after", so the search can only start earlier, never skip an event. */
  async #firstAfter(stream: string, at: number): Promise<number> {
    const probe = await this.#deps.events.since(stream, 1, 1);
    let lo = Math.max(1, probe.floor); let hi = probe.head;
    if (!Number.isFinite(at)) return lo;
    for (let i = 0; i < 64 && lo < hi; i++) {
      const mid = lo + Math.floor((hi - lo) / 2);
      const e = (await this.#deps.events.since(stream, mid, 1)).events[0];
      if (e !== undefined && e.seq === mid && Date.parse(e.at) < at) lo = mid + 1; else hi = mid;
    }
    return lo;
  }

  async #move(by: Principal, id: string, current: { revision: number } | undefined, next: number, at: string): Promise<void> {
    const body: CursorBody = { next, at };
    try {
      await this.#runner.command("responsibility.events.cursor", { commandId: `rec-${hash(id, String(next), String(current?.revision ?? 0))}`, actor: by.id }, async () => ({
        payload: { id, next },
        build: async () => ({ ref: { kind: CURSOR, id }, creates: current === undefined, changes: [current === undefined ? { type: "create" as const, ref: { kind: CURSOR, id }, body: body as unknown as JsonObject } : { type: "update" as const, ref: { kind: CURSOR, id }, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { id, next } }),
      }));
    } catch (error) { if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict"))) throw error; }
  }

  /** Where a responsibility has looked up to (the next sequence number), for the status view and tests. */
  async position(by: Principal, responsibilityId: string): Promise<number | undefined> {
    if (!(by.kind === "owner" || by.kind === "service")) throw hidden(by, "read event positions");
    return ((await this.#runner.get(CURSOR, responsibilityId))?.body as unknown as CursorBody | undefined)?.next;
  }
}
