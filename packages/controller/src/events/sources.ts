import { createHash } from "node:crypto";
import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import type { Principal } from "../security/principals.js";
import { redactText } from "../security/redact.js";
import type { AggregateRef, Change, ControllerStorage, JsonObject } from "../storage/types.js";
import type { EventSource, Signal } from "./adapters.js";
import type { EventService } from "./events.js";

/** What the runner keeps for one source: the adapter's state between polls, and how many times it was saved (the guard against two runners saving at once). */
export interface SourceStateBody { readonly source: string; readonly runs: number; readonly state: JsonObject; readonly at: string }
/** Remembers that a signal was published (and as which event), so a repeated observation is recognised before it reaches the stream, and a later signal can name it as its cause. */
export interface CauseBody { readonly stream: string; readonly seq: number; readonly source: string; readonly dedup: string }
/** Text that came with an event (a path, a message): data to read, kept apart from the event itself. */
export interface DetailBody { readonly text: string; readonly source: string }
/** The task's latest handled event while the task is handling one: a change the task makes now is attributed to it. */
export interface OriginBody { readonly open: boolean; readonly handlingId: string; readonly stream: string; readonly lastSeq: number }
/** A self-triggering loop that was seen and held: events with this signature are not scheduled again until the owner releases it. */
export interface LoopHoldBody {
  readonly stream: string;
  readonly kind: string;
  readonly ref: { readonly kind: string; readonly id: string };
  readonly state: "held" | "released";
  readonly count: number;
  readonly firstSeq: number;
  readonly firstAt: string;
  readonly lastAt: string;
  readonly releasedBy?: string;
}

export interface SourceRun {
  readonly source: string;
  readonly polled: number;
  readonly published: number;
  /** Observations already published before (or repeated by the source): nothing new was made of them. */
  readonly duplicates: number;
  /** Events a loop would have produced again: recorded as suppressed, and the loop is held. */
  readonly suppressed: number;
  /** Signals the stream refused as malformed (the source goes on past them). */
  readonly rejected: readonly string[];
  /** A subscriber the controller relies on is too far behind: publishing stopped, nothing was lost, and the next run continues. */
  readonly slowed?: { readonly retryAfterSeconds: number };
  /** More was waiting than one run takes. */
  readonly more: boolean;
  /** The saved position was older than the source's retention window (a long time off, or the controller was down): what happened between `from` and `to` was not watched, and the source started again from the present. */
  readonly gap?: { readonly from: string; readonly to: string };
  readonly error?: string;
}

export const SOURCE_LIMITS = { perRun: 200, maxPerRun: 1000, rejected: 20, error: 300 } as const;
export const SOURCE_KIND = "evx-source";
export const CAUSE_KIND = "evx-cause";
export const DETAIL_KIND = "evx-detail";
export const ORIGIN_KIND = "evx-origin";
export const LOOP_KIND = "evx-loop";
const hash = (value: string): string => createHash("sha256").update(value).digest("hex");
export const sourceIdOf = (source: string): string => derivedId("evx", `source\0${source}`);
export const causeIdOf = (stream: string, source: string, dedup: string): string => derivedId("evx", `cause\0${stream}\0${source}\0${dedup}`);
export const detailIdOf = (stream: string, seq: number): string => derivedId("evx", `detail\0${stream}\0${seq}`);
export const originIdOf = (taskId: string): string => derivedId("evx", `origin\0${taskId}`);
export const loopIdOf = (stream: string, kind: string, ref: { kind: string; id: string }): string => derivedId("evx", `loop\0${stream}\0${kind}\0${ref.kind}\0${ref.id}`);

/** Signals of one poll with every signal after the one it names as its cause (when that one is in the same poll), otherwise in the order given. A ring of causes is left as it is. */
function causesFirst(signals: readonly Signal[]): Signal[] {
  const inBatch = new Set(signals.map((s) => s.dedup));
  const out: Signal[] = []; const done = new Set<string>(); let rest = [...signals];
  while (rest.length > 0) {
    const ready = rest.filter((s) => s.causedBy === undefined || s.causedBy.source !== undefined || !inBatch.has(s.causedBy.dedup) || done.has(s.causedBy.dedup));
    const take = ready.length > 0 ? ready : rest;
    for (const s of take) { out.push(s); done.add(s.dedup); }
    rest = rest.filter((s) => !take.includes(s));
  }
  return out;
}

/**
 * Runs event sources (card H13): polls each adapter, publishes what it saw into the event streams (H06), and records what it needs to keep that safe.
 *
 * - **Deduplicated.** Each signal has a dedup identity within its source. A signal already published is recognised from its own record and not published again; the publish command ID is
 *   derived from source and dedup too, so a crash between publishing and recording, or a second runner, yields the same event, never a second one.
 * - **Causation links.** A signal names the earlier signal it follows from (`causedBy`) or the task whose work caused it (`originTask`: while that task is handling an event, the change is linked to
 *   the event it was handling). The stream records the chain; an event that repeats its own ancestry is suppressed, and **the loop is held**: events with that signature are not scheduled
 *   until the owner releases it.
 * - **Bounded.** A run takes at most `perRun` signals from one source (a flood is taken in pieces, the rest waits in the source), sources are polled one after another and one failing source
 *   does not stop the others, and when the stream says a subscriber the controller relies on is full the run stops for that source (nothing is lost; the next run continues).
 * - **Not a clock.** Time is the injected clock's.
 */
export class SourceService {
  readonly #runner: CommandRunner;
  readonly #events: EventService;

  private constructor(runner: CommandRunner, events: EventService) { this.#runner = runner; this.#events = events; }

  static withEpoch(storage: ControllerStorage, epoch: number, events: EventService, options: RunnerOptions = {}): SourceService {
    return new SourceService(new CommandRunner(storage, epoch, options), events);
  }

  /** Polls each source once and publishes what it found. Only the owner, a host or a service may run sources. */
  async run(by: Principal, sources: readonly EventSource[], options: { perSource?: number } = {}): Promise<SourceRun[]> {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} may not run event sources`);
    const limit = options.perSource ?? SOURCE_LIMITS.perRun;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > SOURCE_LIMITS.maxPerRun) throw new DomainError("invalid_command", `perSource: must be 1 to ${SOURCE_LIMITS.maxPerRun}`, { field: "perSource" });
    const out: SourceRun[] = [];
    for (const source of sources) out.push(await this.#one(by, source, limit));
    return out;
  }

  async #one(by: Principal, source: EventSource, limit: number): Promise<SourceRun> {
    const ref: AggregateRef = { kind: SOURCE_KIND, id: sourceIdOf(source.id) };
    const saved = await this.#runner.get(ref.kind, ref.id);
    const before = saved?.body as unknown as SourceStateBody | undefined;
    let polled;
    const now = this.#runner.now();
    const gap = before !== undefined && source.retentionMs !== undefined && Date.parse(now) - Date.parse(before.at) > source.retentionMs ? { from: before.at, to: now } : undefined;
    try { polled = await source.poll({ state: gap === undefined ? before?.state : undefined, now, limit }); } catch (error) {
      return { source: source.id, polled: 0, published: 0, duplicates: 0, suppressed: 0, rejected: [], more: false, error: redactText(error instanceof Error ? error.message : String(error)).slice(0, SOURCE_LIMITS.error) };
    }
    let published = 0; let duplicates = 0; let suppressed = 0; const rejected: string[] = [];
    for (const signal of causesFirst(polled.signals)) {
      const result = await this.#publish(by, source.id, signal);
      if (result === "duplicate") duplicates++;
      else if (result === "published") published++;
      else if (result === "suppressed") { published++; suppressed++; }
      else if (typeof result === "object" && "slowed" in result) {
        // Nothing is saved: the next run polls the same state again and the signals already published are recognised.
        return { source: source.id, polled: polled.signals.length, published, duplicates, suppressed, rejected, slowed: result.slowed, more: true };
      } else if (rejected.length < SOURCE_LIMITS.rejected) rejected.push(result.rejected);
    }
    // Another runner saving first is harmless: everything published here is recognised by its own record the next time.
    try { await this.#save(source.id, ref, saved?.revision, before?.runs ?? 0, polled.state); } catch (error) {
      if (!(error instanceof DomainError && (error.code === "stale_revision" || error.code === "command_conflict"))) throw error;
    }
    return { source: source.id, polled: polled.signals.length, published, duplicates, suppressed, rejected, more: polled.more, ...(gap === undefined ? {} : { gap }) };
  }

  async #publish(by: Principal, source: string, signal: Signal): Promise<"published" | "duplicate" | "suppressed" | { slowed: { retryAfterSeconds: number } } | { rejected: string }> {
    try {
      const causeRef: AggregateRef = { kind: CAUSE_KIND, id: causeIdOf(signal.stream, source, signal.dedup) };
      if (await this.#runner.get(causeRef.kind, causeRef.id) !== undefined) return "duplicate";
      const causedBy = await this.#cause(source, signal);
      const result = await this.#events.publish(by, {
        commandId: `sig-${hash(`${source}\0${signal.stream}\0${signal.dedup}`).slice(0, 40)}`, stream: signal.stream, kind: signal.kind, ref: signal.ref,
        ...(signal.key === undefined ? {} : { key: signal.key }), ...(causedBy === undefined ? {} : { causedBy }), ...(signal.seq === undefined ? {} : { source: { id: source, seq: signal.seq } }),
      });
      if (!result.accepted) return { slowed: { retryAfterSeconds: result.retryAfterSeconds } };
      if (result.seq === 0) return "duplicate";
      const changes: Change[] = [{ type: "create", ref: causeRef, body: { stream: signal.stream, seq: result.seq, source, dedup: signal.dedup } as unknown as JsonObject }];
      if (signal.text !== undefined) changes.push({ type: "create", ref: { kind: DETAIL_KIND, id: detailIdOf(signal.stream, result.seq) }, body: { text: redactText(signal.text).slice(0, 300), source } as unknown as JsonObject });
      await this.#runner.command("events.source.note", { commandId: `note-${hash(`${source}\0${signal.stream}\0${signal.dedup}`).slice(0, 40)}`, actor: by.id }, async () => ({
        payload: { source, stream: signal.stream, dedup: signal.dedup, seq: result.seq },
        build: async () => ({ ref: causeRef, creates: true, changes, detail: { source, seq: result.seq } }),
      }));
      if (result.suppressed) { await this.#hold(by, signal, result.seq); return "suppressed"; }
      return "published";
    } catch (error) {
      // A signal whose cause became known (or unknown) since an earlier, crashed attempt published it under the same command ID: the event exists, so it is a repeat.
      if (error instanceof DomainError && error.code === "command_conflict") return "duplicate";
      if (error instanceof DomainError && error.code === "invalid_command") return { rejected: `${signal.dedup.slice(0, 60)}: ${error.message.slice(0, 120)}` };
      throw error;
    }
  }

  /** The event this signal follows from: the one it names, or the event its originating task is handling. Only an event of the same stream can be a cause. */
  async #cause(source: string, signal: Signal): Promise<{ stream: string; seq: number } | undefined> {
    if (signal.causedBy !== undefined) {
      const named = await this.#runner.get(CAUSE_KIND, causeIdOf(signal.stream, signal.causedBy.source ?? source, signal.causedBy.dedup));
      if (named !== undefined) return { stream: signal.stream, seq: (named.body as unknown as CauseBody).seq };
    }
    if (signal.originTask !== undefined) {
      const origin = (await this.#runner.get(ORIGIN_KIND, originIdOf(signal.originTask)))?.body as unknown as OriginBody | undefined;
      if (origin !== undefined && origin.open && origin.stream === signal.stream) return { stream: origin.stream, seq: origin.lastSeq };
    }
    return undefined;
  }

  /** Records a loop and holds it. A repeat (the same suppressed event) changes nothing; a new suppression of a released loop holds it again. */
  async #hold(by: Principal, signal: Signal, seq: number): Promise<void> {
    const id = loopIdOf(signal.stream, signal.kind, signal.ref);
    const ref: AggregateRef = { kind: LOOP_KIND, id };
    await this.#runner.command("events.loop.hold", { commandId: `loop-${hash(`${signal.stream}\0${seq}`).slice(0, 40)}`, actor: by.id }, async () => ({
      payload: { stream: signal.stream, kind: signal.kind, seq },
      build: async () => {
        const found = await this.#runner.get(ref.kind, ref.id);
        const now = this.#runner.now();
        const old = found?.body as unknown as LoopHoldBody | undefined;
        const body: LoopHoldBody = { stream: signal.stream, kind: signal.kind, ref: signal.ref, state: "held", count: (old?.count ?? 0) + 1, firstSeq: old?.firstSeq ?? seq, firstAt: old?.firstAt ?? now, lastAt: now };
        return { ref, creates: found === undefined, changes: [found === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: found.revision, body: body as unknown as JsonObject }], detail: { stream: signal.stream, kind: signal.kind, seq } };
      },
    }));
  }

  async #save(source: string, ref: AggregateRef, revision: number | undefined, runs: number, state: JsonObject): Promise<void> {
    await this.#runner.command("events.source.save", { commandId: `src-${hash(source).slice(0, 24)}-${runs + 1}`, actor: "source-runner" }, async () => ({
      payload: { source, runs: runs + 1 },
      build: async () => {
        const body: SourceStateBody = { source, runs: runs + 1, state, at: this.#runner.now() };
        return { ref, creates: revision === undefined, changes: [revision === undefined ? { type: "create", ref, body: body as unknown as JsonObject } : { type: "update", ref, expectedRevision: revision, body: body as unknown as JsonObject }], detail: { source, runs: runs + 1 }, contention: async () => new DomainError("stale_revision", "another run of this source saved its state first") };
      },
    }));
  }

  /** The saved state of a source, for inspection. */
  async state(by: Principal, source: string): Promise<SourceStateBody | undefined> {
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service")) return undefined;
    return (await this.#runner.get(SOURCE_KIND, sourceIdOf(source)))?.body as unknown as SourceStateBody | undefined;
  }
}
