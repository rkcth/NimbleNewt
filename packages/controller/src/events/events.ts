import { DomainError } from "../domain/errors.js";
import { derivedId } from "../domain/ids.js";
import { onlyKnown, revision as checkRevision } from "../domain/model.js";
import { CommandRunner, type RunnerOptions } from "../domain/runner.js";
import { allows } from "../security/access.js";
import { scopedCommandId } from "../security/credentials.js";
import type { NoActor, Principal } from "../security/principals.js";
import type { AggregateRef, ControllerStorage, JsonObject } from "../storage/types.js";

export interface EventBody {
  readonly seq: number;
  readonly kind: string;
  readonly ref: { readonly kind: string; readonly id: string };
  /** Reports of the same thing share a key; the latest of them in a batch is the one delivered. */
  readonly key: string;
  readonly at: string;
  readonly producer: string;
  /** The events that led to this one, nearest first, as signatures (`kind|refKind:refId`): the causation chain. */
  readonly chain: readonly string[];
  readonly causedBy?: number;
  /** True for an event a loop would have produced again: kept for the record and never delivered. */
  readonly suppressed?: boolean;
  readonly source?: { readonly id: string; readonly seq: number };
}
export interface Gap { readonly source: string; readonly from: number; readonly to: number }
export interface HeadBody {
  readonly stream: string;
  /** The next sequence number. */
  readonly next: number;
  /** Events below this are past retention and no longer served. */
  readonly floor: number;
  readonly sources: Readonly<Record<string, number>>;
  readonly gaps: readonly Gap[];
}
export interface SubscriptionBody {
  readonly subscriber: string;
  readonly stream: string;
  readonly kinds: readonly string[];
  readonly cooldownSeconds: number;
  readonly batch: number;
  /** The last sequence number the subscriber has acknowledged. */
  readonly cursor: number;
  readonly lastWakeAt?: string;
  readonly state: "active" | "cancelled" | "expired";
  /** True when the controller relies on this subscriber (owner, host, service): only such subscribers slow producers. Everyone else is bounded by reconciliation instead. */
  readonly critical: boolean;
  readonly createdAt: string;
  /** The last acknowledgement, heartbeat, resume or the subscription itself (card H06b): idle time is counted from here. Absent on records made before idle expiry (createdAt is used). */
  readonly lastActiveAt?: string;
  /** The idle time this subscriber asked for; it can only shorten the owner's setting, never lengthen it. */
  readonly idleSeconds?: number;
  readonly expiredAt?: string;
  /** The cursor at the moment of expiry: the subscriber resumes from here. */
  readonly expiredCursor?: number;
  /** True while the Notice for an expiry that left events unhandled has not been delivered yet; a sweep retries it. */
  readonly noticePending?: boolean;
}
/** What an idle expiry hands to the notification path (U11 `emitFromController`; U11b's Needs-you view is not in code yet). */
export interface ExpiryNotice { readonly subscriptionId: string; readonly subscriber: string; readonly stream: string; readonly cursor: number; readonly expiredAt: string; readonly pending: number; readonly idleSeconds: number; readonly projectId?: string }
export type NotifyExpiry = (notice: ExpiryNotice) => Promise<void>;
export interface IdleStatus { readonly state: SubscriptionBody["state"]; readonly cursor: number; readonly lastActiveAt: string; readonly idleSeconds: number; readonly expiredAt?: string; readonly expiredCursor?: number }
interface SettingsBody { readonly idleSeconds: number }
export interface Pulled {
  readonly events: readonly { seq: number; kind: string; ref: { kind: string; id: string }; key: string; at: string; collapsed: number }[];
  /** True when the subscriber should act on these now. False when its scope is on manual hold or its cooldown has not passed: the events wait. */
  readonly wake: boolean;
  readonly held: boolean;
  readonly retryAt?: string;
  /** The stream cannot be trusted to be complete: events are missing, were reported out of order, or the subscriber's cursor fell behind retention. The subscriber reconciles from the source of truth and then acknowledges. */
  readonly reconcile: boolean;
  readonly reasons: readonly string[];
  readonly missing: readonly number[];
  /** The position to acknowledge through once these are handled. */
  readonly through: number;
}

export type PublishResult = { accepted: true; seq: number; suppressed: boolean; duplicate: boolean; late?: boolean; gap?: Gap } | { accepted: false; retryAfterSeconds: number; reason: string };

/** Carries a publish that was answered without being applied out of the command's build. */
class Rejected extends Error { constructor(readonly result: PublishResult) { super("rejected"); } }

export const EVENT_LIMITS = { queue: 1000, chain: 20, batch: 200, kinds: 20, cooldown: 3600, gaps: 50, scan: 2000, idleDefault: 900, idleMin: 10, idleMax: 604_800, sweep: 100 } as const;
const STREAM = /^(?:project|task):[a-z]+-[a-z2-7]{20}$/;
const KIND = /^[a-z][a-z0-9._-]{0,59}$/;
const KEY = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;
const SUB = /^sub-[a-z2-7]{20}$/;
const invalid = (field: string, message: string): never => { throw new DomainError("invalid_command", `${field}: ${message}`, { field }); };
const kindOf = (stream: string): string => `ev-${stream.replace(":", "-")}`;
const watcherKind = (stream: string): string => `wtc-${stream.replace(":", "-")}`;
const listedKind = (stream: string): string => `sbl-${stream.replace(":", "-")}`;
const SETTINGS: AggregateRef = { kind: "events-settings", id: "idle" };
/** Carries a sweep's decision not to expire (the subscription is no longer idle) out of the command's build. */
class NotIdle extends Error { constructor() { super("not idle"); } }
const idleOf = (sub: SubscriptionBody, ceiling: number): number => Math.min(sub.idleSeconds ?? ceiling, ceiling);
const lastActive = (sub: SubscriptionBody): string => sub.lastActiveAt ?? sub.createdAt;
const isIdle = (sub: SubscriptionBody, ceiling: number, now: string): boolean => Date.parse(now) >= Date.parse(lastActive(sub)) + idleOf(sub, ceiling) * 1000;
const pad = (n: number): string => String(n).padStart(10, "0");
const sig = (kind: string, ref: { kind: string; id: string }): string => `${kind}|${ref.kind}:${ref.id}`;

/**
 * Event subscriptions with gap recovery (card H06). A stream is a project or a task; producers publish events into it and each is given the next sequence number. A subscriber has a cursor,
 * pulls the events after it (only the kinds it asked for, batched, the latest of events that share a key), and acknowledges what it has handled. The stream says when it cannot be trusted to be
 * complete (events missing from the sequence, a source's own numbering that skipped, repeated or came out of order, a cursor older than retention) and then the subscriber must reconcile from the
 * source of truth: nothing is guessed. An event never lifts a manual hold (it waits, with `wake: false`), each subscription has a cooldown, the causation chain of every event is recorded and an
 * event that a loop would produce again is suppressed, and a producer is told to slow down when a subscriber's queue is full.
 *
 * Idle expiry (card H06b): a subscription with no acknowledgement, heartbeat or resume for its idle time (the owner's setting is the ceiling; a subscriber may ask for less) is expired by `expireIdle`
 * (the scheduler's call) or by a producer that meets a full queue. An expired subscription no longer holds producers back, keeps its cursor on record, shows in the audit trail as `events.expire`, and
 * is reported through `notify` when events were waiting for it. Its subscriber `resume`s from the cursor; the owner can cancel at any time.
 */
export class EventService {
  readonly #runner: CommandRunner;
  readonly #held: (stream: string) => Promise<boolean>;
  readonly #notify: NotifyExpiry | undefined;

  private constructor(runner: CommandRunner, held: (stream: string) => Promise<boolean>, notify: NotifyExpiry | undefined) { this.#runner = runner; this.#held = held; this.#notify = notify; }

  /** `held` says whether a stream's scope is on manual hold (the pause service supplies it); `notify` reports an idle expiry that left events unhandled (see `noticeThroughNotifications`). */
  static withEpoch(storage: ControllerStorage, epoch: number, options: RunnerOptions & { held?: (stream: string) => Promise<boolean>; notify?: NotifyExpiry } = {}): EventService {
    return new EventService(new CommandRunner(storage, epoch, options), options.held ?? (async () => false), options.notify);
  }

  /** Publishes an event. Returns its sequence number, or says it was suppressed (a loop), was a repeat from its source, or that the producer must wait (a subscriber's queue is full). */
  async publish(by: Principal, command: NoActor & { stream: string; kind: string; ref: { kind: string; id: string }; key?: string; causedBy?: { stream: string; seq: number }; source?: { id: string; seq: number } }): Promise<
    PublishResult
  > {
    onlyKnown(command, ["commandId", "stream", "kind", "ref", "key", "causedBy", "source"]);
    const stream = this.#stream(command.stream);
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service" || (by.kind === "agent" && allows(by, "events.publish", this.#projectOf(stream))))) throw new DomainError("forbidden", `${by.id} may not publish to ${stream}`);
    const kind = typeof command.kind === "string" && KIND.test(command.kind) ? command.kind : invalid("kind", "must be lower-case words");
    const ref = this.#ref(command.ref);
    const key = command.key === undefined ? sig(kind, ref) : typeof command.key === "string" && KEY.test(command.key) ? command.key : invalid("key", "is not an acceptable key");
    const source = command.source === undefined ? undefined : (typeof command.source.id === "string" && KEY.test(command.source.id) && Number.isSafeInteger(command.source.seq) && command.source.seq >= 1 ? command.source : invalid("source", "needs an id and a sequence number from 1"));
    let idleSeen: string[] = [];
    for (let attempt = 1; ; attempt++) {
      try {
        const headRef: AggregateRef = { kind: "events-head", id: derivedId("sub", stream) };
        const eventKind = kindOf(stream);
        let outcome: { suppressed: boolean; gap?: Gap } = { suppressed: false };
        // Everything that depends on the stream's state is decided inside the build, so a repeat of a recorded command is answered from the record and never judged again.
        const published = await this.#runner.command("events.publish", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
          payload: { stream, kind, ref: ref as unknown as JsonObject, key, causedBy: (command.causedBy ?? null) as unknown as JsonObject, source: (source ?? null) as unknown as JsonObject },
          build: async () => {
            const found = await this.#runner.get(headRef.kind, headRef.id);
            const head = (found?.body as unknown as HeadBody | undefined) ?? { stream, next: 1, floor: 1, sources: {}, gaps: [] };
            // A watcher that has been idle past its time does not hold anyone back; it is expired for the record after this command.
            const { worst: behind, idle } = await this.#backlog(stream, head, await this.#ceiling(), this.#runner.now());
            idleSeen = idle;
            if (behind >= EVENT_LIMITS.queue) throw new Rejected({ accepted: false, retryAfterSeconds: 5, reason: `a subscriber of ${stream} is ${behind} events behind` });
            let chain: string[] = []; let suppressed = false; let causedBySeq: number | undefined;
            if (command.causedBy !== undefined) {
              // A cause must be in the same stream; one that is elsewhere answers like one that does not exist.
              const seq = command.causedBy.seq;
              const cause = command.causedBy.stream === stream && Number.isSafeInteger(seq) && seq >= 1 ? (await this.#runner.get(eventKind, pad(seq)))?.body as unknown as EventBody | undefined : undefined;
              if (cause === undefined) invalid("causedBy", "names no event of this stream");
              chain = [sig(cause!.kind, cause!.ref), ...cause!.chain].slice(0, EVENT_LIMITS.chain);
              causedBySeq = seq;
              suppressed = chain.includes(sig(kind, ref)) || chain.length >= EVENT_LIMITS.chain;
            }
            let gap: Gap | undefined; let sources = head.sources; let gaps = head.gaps;
            if (source !== undefined) {
              const last = head.sources[source.id] ?? 0;
              if (source.seq <= last) throw new Rejected({ accepted: true, seq: 0, suppressed: false, duplicate: source.seq === last, late: source.seq < last });
              if (source.seq > last + 1) { gap = { source: source.id, from: last + 1, to: source.seq - 1 }; gaps = [...head.gaps, gap].slice(-EVENT_LIMITS.gaps); }
              sources = { ...head.sources, [source.id]: source.seq };
            }
            const seq = head.next;
            const body: EventBody = { seq, kind, ref, key, at: this.#runner.now(), producer: by.id, chain, ...(causedBySeq === undefined ? {} : { causedBy: causedBySeq }), ...(suppressed ? { suppressed: true } : {}), ...(source === undefined ? {} : { source }) };
            const eref: AggregateRef = { kind: eventKind, id: pad(seq) };
            const nextHead: HeadBody = { ...head, next: seq + 1, sources, gaps };
            outcome = { suppressed, ...(gap === undefined ? {} : { gap }) };
            return { ref: eref, creates: true, changes: [{ type: "create", ref: eref, body: body as unknown as JsonObject }, found === undefined ? { type: "create", ref: headRef, body: nextHead as unknown as JsonObject } : { type: "update", ref: headRef, expectedRevision: found.revision, body: nextHead as unknown as JsonObject }], detail: { stream, kind, seq, suppressed }, contention: async () => new DomainError("stale_revision", "another event was published at the same moment") };
          },
        }));
        // A repeat of the same command is the same event: its number is the recorded one (the suppressed flag of a repeat is read back from the record).
        const seq = Number(published.id);
        await this.#reap(idleSeen);
        const suppressed = published.replayed ? ((await this.#runner.get(eventKind, pad(seq)))?.body as unknown as EventBody | undefined)?.suppressed === true : outcome.suppressed;
        return { accepted: true, seq, suppressed, duplicate: false, ...(outcome.gap === undefined ? {} : { gap: outcome.gap }) };
      } catch (error) {
        if (error instanceof Rejected) { await this.#reap(idleSeen); return error.result; }
        if (!(error instanceof DomainError) || error.code !== "stale_revision" || error.currentRevision !== undefined || attempt >= 8) throw error;
      }
    }
  }

  /** Subscribes to a stream from now on (or from the start). The subscriber must be able to read the stream's project. */
  async subscribe(by: Principal, command: NoActor & { stream: string; kinds?: readonly string[]; cooldownSeconds?: number; batch?: number; fromStart?: boolean; idleSeconds?: number }): Promise<{ id: string }> {
    onlyKnown(command, ["commandId", "stream", "kinds", "cooldownSeconds", "batch", "fromStart", "idleSeconds"]);
    const stream = this.#stream(command.stream);
    if (!(by.kind === "owner" || by.kind === "host" || by.kind === "service" || allows(by, "history.read", this.#projectOf(stream)))) throw new DomainError("forbidden", `${by.id} may not subscribe to ${stream}`);
    const kinds = command.kinds ?? [];
    if (!Array.isArray(kinds) || kinds.length > EVENT_LIMITS.kinds || kinds.some((k) => typeof k !== "string" || !KIND.test(k))) invalid("kinds", `must be at most ${EVENT_LIMITS.kinds} lower-case kinds`);
    const cooldown = command.cooldownSeconds ?? 0;
    if (!Number.isSafeInteger(cooldown) || cooldown < 0 || cooldown > EVENT_LIMITS.cooldown) invalid("cooldownSeconds", `must be 0 to ${EVENT_LIMITS.cooldown}`);
    const batch = command.batch ?? 50;
    if (!Number.isSafeInteger(batch) || batch < 1 || batch > EVENT_LIMITS.batch) invalid("batch", `must be 1 to ${EVENT_LIMITS.batch}`);
    const idle = command.idleSeconds;
    if (idle !== undefined && (!Number.isSafeInteger(idle) || idle < EVENT_LIMITS.idleMin || idle > EVENT_LIMITS.idleMax)) invalid("idleSeconds", `must be ${EVENT_LIMITS.idleMin} to ${EVENT_LIMITS.idleMax}`);
    const id = derivedId("sub", scopedCommandId(by.id, command.commandId));
    const head = (await this.#runner.get("events-head", derivedId("sub", stream)))?.body as unknown as HeadBody | undefined;
    const body: SubscriptionBody = { subscriber: by.id, stream, kinds: [...new Set(kinds as string[])].sort(), cooldownSeconds: cooldown, batch, cursor: command.fromStart === true ? (head?.floor ?? 1) - 1 : (head?.next ?? 1) - 1, state: "active", critical: by.kind !== "agent" && by.kind !== "client", createdAt: this.#runner.now(), lastActiveAt: this.#runner.now(), ...(idle === undefined ? {} : { idleSeconds: idle }) };
    const ref: AggregateRef = { kind: "subscription", id };
    await this.#runner.command("events.subscribe", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { stream, kinds: body.kinds as unknown as string[], cooldown, batch, fromStart: command.fromStart === true, idle: idle ?? null },
      build: async () => ({ ref, creates: true, changes: [{ type: "create", ref, body: body as unknown as JsonObject }, { type: "create", ref: { kind: listedKind(stream), id }, body: { subscription: id } as JsonObject }, ...(body.critical ? [{ type: "create" as const, ref: { kind: watcherKind(stream), id }, body: { subscription: id } as JsonObject }] : [])], detail: { stream } }),
    }));
    return { id };
  }

  /** The next batch for a subscription (its owner only). Reading changes nothing: a batch is handled and then acknowledged. */
  async pull(by: Principal, subscriptionId: string): Promise<Pulled> {
    const { sub, id } = await this.#mine(by, subscriptionId);
    const head = (await this.#runner.get("events-head", derivedId("sub", sub.stream)))?.body as unknown as HeadBody | undefined;
    const now = this.#runner.now();
    const reasons: string[] = []; let reconcile = false;
    let cursor = sub.cursor;
    if (head !== undefined && head.next - 1 - Math.max(cursor, head.floor - 1) > EVENT_LIMITS.queue) { reconcile = true; reasons.push(`the subscription fell more than ${EVENT_LIMITS.queue} events behind, so the oldest are no longer kept for it`); cursor = head.next - 1 - EVENT_LIMITS.queue; }
    if (head !== undefined && cursor < head.floor - 1) { reconcile = true; reasons.push(`the subscription is behind retention (events before ${head.floor} are no longer kept)`); cursor = head.floor - 1; }
    if (head !== undefined && head.gaps.length > 0) { reconcile = true; reasons.push(...head.gaps.map((g) => `source ${g.source} skipped ${g.from}..${g.to}`)); }
    const out: { seq: number; ev: EventBody }[] = []; const missing: number[] = []; let through = cursor;
    if (head !== undefined) {
      for (let seq = cursor + 1, reads = 0; seq < head.next && out.length < sub.batch && reads < EVENT_LIMITS.scan; seq++, reads++) {
        const ev = (await this.#runner.get(kindOf(sub.stream), pad(seq)))?.body as unknown as EventBody | undefined;
        if (ev === undefined) { missing.push(seq); reconcile = true; through = seq; continue; }
        through = seq;
        if (ev.suppressed === true || (sub.kinds.length > 0 && !sub.kinds.includes(ev.kind))) continue;
        out.push({ seq, ev });
      }
    }
    if (missing.length > 0) reasons.push(`events ${missing.slice(0, 5).join(", ")}${missing.length > 5 ? "…" : ""} are missing from the sequence`);
    // The latest of events that share a key is delivered, counting the others.
    const latest = new Map<string, { seq: number; ev: EventBody; n: number }>();
    for (const { seq, ev } of out) { const p = latest.get(ev.key); latest.set(ev.key, { seq, ev, n: (p?.n ?? 0) + 1 }); }
    const events = [...latest.values()].sort((a, b) => a.seq - b.seq).map(({ seq, ev, n }) => ({ seq, kind: ev.kind, ref: ev.ref, key: ev.key, at: ev.at, collapsed: n - 1 }));
    const held = await this.#held(sub.stream);
    const cooling = sub.lastWakeAt !== undefined && Date.parse(now) < Date.parse(sub.lastWakeAt) + sub.cooldownSeconds * 1000;
    const retryAt = cooling ? new Date(Date.parse(sub.lastWakeAt!) + sub.cooldownSeconds * 1000).toISOString() : undefined;
    const wake = events.length > 0 && !held && !cooling;
    void id;
    return { events, wake, held, ...(retryAt === undefined ? {} : { retryAt }), reconcile, reasons, missing, through };
  }

  /** The subscriber has handled everything through `through`. Only forward; a repeat or an old acknowledgement changes nothing. A wake starts the cooldown. */
  async acknowledge(by: Principal, command: NoActor & { subscriptionId: string; through: number; woke?: boolean }): Promise<{ cursor: number }> {
    onlyKnown(command, ["commandId", "subscriptionId", "through", "woke"]);
    const { sub, id } = await this.#mine(by, command.subscriptionId);
    if (!Number.isSafeInteger(command.through) || command.through < 0) invalid("through", "must be a sequence number");
    const head = (await this.#runner.get("events-head", derivedId("sub", sub.stream)))?.body as unknown as HeadBody | undefined;
    if (command.through >= (head?.next ?? 1)) invalid("through", "is beyond the last event");
    const ref: AggregateRef = { kind: "subscription", id };
    const result = await this.#runner.command("events.ack", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { subscriptionId: id, through: command.through, woke: command.woke === true },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        const body = current!.body as unknown as SubscriptionBody;
        const cursor = Math.max(body.cursor, command.through);
        const next: SubscriptionBody = { ...body, cursor, lastActiveAt: this.#runner.now(), ...(command.woke === true ? { lastWakeAt: this.#runner.now() } : {}) };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current!.revision, body: next as unknown as JsonObject }], detail: { cursor } };
      },
    }));
    void result;
    return { cursor: ((await this.#runner.get(ref.kind, ref.id))!.body as unknown as SubscriptionBody).cursor };
  }

  /** The owner or the service that repaired the source says a skipped range has been reconciled, so subscribers stop being told to reconcile for it. */
  async reconciled(by: Principal, command: NoActor & { stream: string; source: string; through: number }): Promise<void> {
    if (!(by.kind === "owner" || by.kind === "service" || by.kind === "host")) throw new DomainError("forbidden", `${by.id} may not clear a gap`);
    onlyKnown(command, ["commandId", "stream", "source", "through"]);
    const stream = this.#stream(command.stream);
    const ref: AggregateRef = { kind: "events-head", id: derivedId("sub", stream) };
    await this.#runner.command("events.reconciled", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { stream, source: command.source, through: command.through },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        if (current === undefined) throw new DomainError("not_found", "no such stream");
        const head = current.body as unknown as HeadBody;
        const next: HeadBody = { ...head, gaps: head.gaps.filter((g) => !(g.source === command.source && g.to <= command.through)) };
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: next as unknown as JsonObject }], detail: { source: command.source } };
      },
    }));
  }

  /** Retention: events before `floor` are no longer served (the owner or the service decides). */
  async setFloor(by: Principal, command: NoActor & { stream: string; floor: number }): Promise<void> {
    if (!(by.kind === "owner" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} may not set retention`);
    onlyKnown(command, ["commandId", "stream", "floor"]);
    const stream = this.#stream(command.stream);
    const ref: AggregateRef = { kind: "events-head", id: derivedId("sub", stream) };
    await this.#runner.command("events.floor", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { stream, floor: command.floor },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        if (current === undefined) throw new DomainError("not_found", "no such stream");
        const head = current.body as unknown as HeadBody;
        if (!Number.isSafeInteger(command.floor) || command.floor < head.floor || command.floor > head.next) throw new DomainError("invalid_command", `the floor may only move forward, to at most ${head.next}`, { field: "floor" });
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...head, floor: command.floor } as unknown as JsonObject }], detail: { floor: command.floor } };
      },
    }));
  }

  /** The events of a stream, with their causation chains, for the owner and those who may read the project (suppressed ones included, marked). */
  async trace(by: Principal, stream: string, from = 1, limit = 100): Promise<EventBody[]> {
    const s = this.#stream(stream);
    if (!(by.kind === "owner" || allows(by, "history.read", this.#projectOf(s)))) return [];
    const out: EventBody[] = [];
    const head = (await this.#runner.get("events-head", derivedId("sub", s)))?.body as unknown as HeadBody | undefined;
    for (let seq = Math.max(from, 1); head !== undefined && seq < head.next && out.length < Math.min(limit, EVENT_LIMITS.scan); seq++) {
      const ev = (await this.#runner.get(kindOf(s), pad(seq)))?.body as unknown as EventBody | undefined;
      if (ev !== undefined) out.push(ev);
    }
    return out;
  }

  // ---- internals ------------------------------------------------------------------------------------------------------------

  #stream(value: unknown): string { return typeof value === "string" && STREAM.test(value) ? value : invalid("stream", "must be project:<id> or task:<id>"); }
  #ref(value: unknown): { kind: string; id: string } {
    const r = value as { kind?: unknown; id?: unknown };
    return typeof value === "object" && value !== null && typeof r.kind === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(r.kind) && typeof r.id === "string" && KEY.test(r.id) ? { kind: r.kind, id: r.id } : invalid("ref", "must name a record: { kind, id }");
  }
  /** The project a stream belongs to: for `project:` streams the ID itself; a `task:` stream's project is looked up when it is used. */
  #projectOf(stream: string): string | undefined { return stream.startsWith("project:") ? stream.slice("project:".length) : undefined; }

  async #mine(by: Principal, subscriptionId: string): Promise<{ sub: SubscriptionBody; id: string }> {
    const id = typeof subscriptionId === "string" && SUB.test(subscriptionId) ? subscriptionId : invalid("subscriptionId", "is not a subscription ID");
    const sub = (await this.#runner.get("subscription", id))?.body as unknown as SubscriptionBody | undefined;
    if (sub === undefined || sub.subscriber !== by.id) throw new DomainError("forbidden", `${by.id} has no such subscription`);
    if (sub.state === "expired") throw new DomainError("invalid_transition", `the subscription expired after being idle; it holds the cursor at ${sub.expiredCursor ?? sub.cursor}: resume it`);
    if (sub.state !== "active") throw new DomainError("forbidden", `${by.id} has no such subscription`);
    return { sub, id };
  }

  /** The backlog of the slowest critical subscriber of the stream (those the controller relies on). Others never slow a producer. A watcher idle past its time is not counted and is named in `idle`. */
  async #backlog(stream: string, head: HeadBody, ceiling: number, now: string): Promise<{ worst: number; idle: string[] }> {
    let worst = 0; const idle: string[] = [];
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list(watcherKind(stream), { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const w of page) {
        after = w.id;
        const s = (await this.#runner.get("subscription", w.id))?.body as unknown as SubscriptionBody | undefined;
        if (s === undefined || s.state !== "active") continue;
        if (isIdle(s, ceiling, now)) { idle.push(w.id); continue; }
        worst = Math.max(worst, head.next - 1 - Math.max(s.cursor, head.floor - 1));
      }
      if (page.length < 200) return { worst, idle };
    }
  }

  /** The owner's idle ceiling: the setting, or the default. */
  async #ceiling(): Promise<number> { return ((await this.#runner.get(SETTINGS.kind, SETTINGS.id))?.body as unknown as SettingsBody | undefined)?.idleSeconds ?? EVENT_LIMITS.idleDefault; }

  /** Expires the named subscriptions for the record; one that is active again or raced with an acknowledgement is left alone. A failure here never fails the publish that found them (the next sweep does it). */
  async #reap(ids: readonly string[]): Promise<void> {
    for (const id of ids.slice(0, EVENT_LIMITS.sweep)) { try { await this.#expire(id); } catch { /* the sweep will find it again */ } }
  }

  // ---- idle expiry (card H06b) ----------------------------------------------------------------------------------------------

  /** The owner sets how long a subscription may be idle before the system expires it (the default is 15 minutes). A subscriber may ask for a shorter time, never a longer one. Counts from the next check. */
  async configureIdle(owner: Principal, command: NoActor & { idleSeconds: number }): Promise<void> {
    if (owner.kind !== "owner") throw new DomainError("forbidden", `${owner.id} may not set the idle time`);
    onlyKnown(command, ["commandId", "idleSeconds"]);
    if (!Number.isSafeInteger(command.idleSeconds) || command.idleSeconds < EVENT_LIMITS.idleMin || command.idleSeconds > EVENT_LIMITS.idleMax) invalid("idleSeconds", `must be ${EVENT_LIMITS.idleMin} to ${EVENT_LIMITS.idleMax}`);
    await this.#runner.command("events.idle-configure", { commandId: scopedCommandId(owner.id, command.commandId), actor: owner.id }, async () => ({
      payload: { idleSeconds: command.idleSeconds },
      build: async () => {
        const current = await this.#runner.get(SETTINGS.kind, SETTINGS.id);
        const body = { idleSeconds: command.idleSeconds } as unknown as JsonObject;
        return { ref: SETTINGS, creates: current === undefined, changes: [current === undefined ? { type: "create", ref: SETTINGS, body } : { type: "update", ref: SETTINGS, expectedRevision: current.revision, body }], detail: { idleSeconds: command.idleSeconds } };
      },
    }));
  }

  /**
   * Gives every subscription made before idle expiry existed (no `lastActiveAt`) the time of this call as its last activity, so the idle time counts from now and not from the day it was made.
   * It does nothing for a subscription that has one, and repeating it changes nothing more. For the owner or a service; the controller runs it at start.
   */
  async stampIdle(by: Principal): Promise<{ stamped: number }> {
    if (!(by.kind === "owner" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} may not stamp subscriptions`);
    let stamped = 0;
    for (let after: string | undefined; ;) {
      const page = await this.#runner.list("subscription", { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
      for (const rec of page) {
        after = rec.id;
        const sub = rec.body as unknown as SubscriptionBody;
        if (sub.state !== "active" || sub.lastActiveAt !== undefined) continue;
        const ref: AggregateRef = { kind: "subscription", id: rec.id };
        const at = this.#runner.now();
        try { await this.#runner.command("events.idle-stamp", { commandId: `idle-stamp-${rec.id}`, actor: by.id }, async () => ({
          payload: { subscriptionId: rec.id },
          build: async () => {
            const current = await this.#runner.get(ref.kind, ref.id);
            const body = current?.body as unknown as SubscriptionBody | undefined;
            if (current === undefined || body === undefined || body.lastActiveAt !== undefined) throw new NotIdle();
            return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...body, lastActiveAt: at } as unknown as JsonObject }], detail: { subscriber: body.subscriber } };
          },
        })); stamped++; } catch (error) { if (!(error instanceof NotIdle)) throw error; }
      }
      if (page.length < 200) return { stamped };
    }
  }

  /** The subscriber says it is alive and working (a long batch in hand), so the idle time starts again. Acknowledging does the same. */
  async heartbeat(by: Principal, command: NoActor & { subscriptionId: string }): Promise<void> {
    onlyKnown(command, ["commandId", "subscriptionId"]);
    const { id } = await this.#mine(by, command.subscriptionId);
    const ref: AggregateRef = { kind: "subscription", id };
    await this.#runner.command("events.heartbeat", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { subscriptionId: id },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        const sub = current!.body as unknown as SubscriptionBody;
        if (sub.state !== "active") throw new DomainError("invalid_transition", "the subscription is not active");
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current!.revision, body: { ...sub, lastActiveAt: this.#runner.now() } as unknown as JsonObject }], detail: { subscriber: sub.subscriber } };
      },
    }));
  }

  /** Where a subscription stands, for its subscriber or the owner: whether it expired, and the cursor to resume from. */
  async status(by: Principal, subscriptionId: string): Promise<IdleStatus> {
    const id = typeof subscriptionId === "string" && SUB.test(subscriptionId) ? subscriptionId : invalid("subscriptionId", "is not a subscription ID");
    const sub = (await this.#runner.get("subscription", id))?.body as unknown as SubscriptionBody | undefined;
    if (sub === undefined || !(by.kind === "owner" || sub.subscriber === by.id)) throw new DomainError("forbidden", `${by.id} has no such subscription`);
    return { state: sub.state, cursor: sub.cursor, lastActiveAt: lastActive(sub), idleSeconds: idleOf(sub, await this.#ceiling()), ...(sub.expiredAt === undefined ? {} : { expiredAt: sub.expiredAt }), ...(sub.expiredCursor === undefined ? {} : { expiredCursor: sub.expiredCursor }) };
  }

  /**
   * Takes an expired subscription back (its subscriber only; a cancelled one stays cancelled). The cursor is where it was, so every event after the last acknowledged one is still served; if the
   * cursor has meanwhile passed retention or the queue bound, the next `pull` says `reconcile` exactly as for any slow subscriber.
   */
  async resume(by: Principal, command: NoActor & { subscriptionId: string }): Promise<{ cursor: number }> {
    onlyKnown(command, ["commandId", "subscriptionId"]);
    const id = typeof command.subscriptionId === "string" && SUB.test(command.subscriptionId) ? command.subscriptionId : invalid("subscriptionId", "is not a subscription ID");
    const ref: AggregateRef = { kind: "subscription", id };
    await this.#runner.command("events.resume", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { subscriptionId: id },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        const sub = current?.body as unknown as SubscriptionBody | undefined;
        if (current === undefined || sub === undefined || sub.subscriber !== by.id || sub.state === "cancelled") throw new DomainError("forbidden", `${by.id} has no such subscription`);
        if (sub.state !== "expired") throw new DomainError("invalid_transition", "the subscription has not expired");
        const { expiredAt: _a, expiredCursor: _c, noticePending: _n, ...rest } = sub;
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...rest, state: "active", lastActiveAt: this.#runner.now() } as unknown as JsonObject }], detail: { subscriber: sub.subscriber, cursor: sub.cursor, expiredAt: sub.expiredAt ?? null } };
      },
    }));
    return { cursor: ((await this.#runner.get(ref.kind, ref.id))!.body as unknown as SubscriptionBody).cursor };
  }

  /**
   * The scheduler's call (the owner or a service): expires every subscription that has been idle for its time and delivers the Notices still owed. At most `EVENT_LIMITS.sweep` expiries per call, so call
   * again while `more` is true. Streams that have never had an event are not looked at (nothing can be held back there).
   */
  async expireIdle(by: Principal): Promise<{ expired: string[]; noticed: number; noticeFailed: number; more: boolean }> {
    if (!(by.kind === "owner" || by.kind === "service")) throw new DomainError("forbidden", `${by.id} may not expire subscriptions`);
    const ceiling = await this.#ceiling(); const now = this.#runner.now();
    const expired: string[] = []; let noticed = 0; let noticeFailed = 0; let more = false;
    // A Notice that cannot be delivered never stops the sweep: the flag stays on the subscription and the next sweep tries again.
    const owe = async (id: string, known?: ExpiryNotice): Promise<void> => { try { if (await this.#noticeOwed(id, known)) noticed++; } catch { noticeFailed++; } };
    for (let afterHead: string | undefined; !more;) {
      const heads = await this.#runner.list("events-head", { ...(afterHead === undefined ? {} : { afterId: afterHead }), limit: 200 });
      for (const h of heads) {
        if (more) break;
        afterHead = h.id;
        const stream = (h.body as unknown as HeadBody).stream;
        for (let after: string | undefined; !more;) {
          const page = await this.#runner.list(listedKind(stream), { ...(after === undefined ? {} : { afterId: after }), limit: 200 });
          for (const entry of page) {
            if (expired.length >= EVENT_LIMITS.sweep) { more = true; break; }
            after = entry.id;
            const sub = (await this.#runner.get("subscription", entry.id))?.body as unknown as SubscriptionBody | undefined;
            if (sub === undefined || sub.state === "cancelled") continue;
            if (sub.state === "active" && isIdle(sub, ceiling, now)) {
              const done = await this.#expire(entry.id);
              if (done !== undefined) { expired.push(entry.id); await owe(entry.id, done); }
            } else if (sub.state === "expired" && sub.noticePending === true) await owe(entry.id);
          }
          if (page.length < 200) break;
        }
      }
      if (heads.length < 200) break;
    }
    return { expired, noticed, noticeFailed, more };
  }

  /** Expires one subscription if it is (still) idle; says what to tell the owner when this call did it. Never calls the notifier: a slow channel must not slow a producer. */
  async #expire(id: string): Promise<ExpiryNotice | undefined> {
    const ref: AggregateRef = { kind: "subscription", id };
    const first = (await this.#runner.get(ref.kind, ref.id))?.body as unknown as SubscriptionBody | undefined;
    if (first === undefined || first.state !== "active") return undefined;
    let notice: ExpiryNotice | undefined;
    try {
      // The command ID names the activity it expires after: a new acknowledgement makes a new ID, so an earlier expiry's record is never mistaken for this one.
      await this.#runner.command("events.expire", { commandId: `expire-${id}-${lastActive(first)}`, actor: "events" }, async () => ({
        payload: { subscriptionId: id },
        build: async () => {
          const current = await this.#runner.get(ref.kind, ref.id);
          const sub = current?.body as unknown as SubscriptionBody | undefined;
          const now = this.#runner.now(); const ceiling = await this.#ceiling();
          if (current === undefined || sub === undefined || sub.state !== "active" || !isIdle(sub, ceiling, now)) throw new NotIdle();
          const head = (await this.#runner.get("events-head", derivedId("sub", sub.stream)))?.body as unknown as HeadBody | undefined;
          const pending = head === undefined ? 0 : Math.max(0, head.next - 1 - Math.max(sub.cursor, head.floor - 1));
          const idleSeconds = idleOf(sub, ceiling);
          const body: SubscriptionBody = { ...sub, state: "expired", expiredAt: now, expiredCursor: sub.cursor, ...(pending > 0 || sub.critical ? { noticePending: true } : {}) };
          notice = { subscriptionId: id, subscriber: sub.subscriber, stream: sub.stream, cursor: sub.cursor, expiredAt: now, pending, idleSeconds, ...(sub.stream.startsWith("project:") ? { projectId: sub.stream.slice("project:".length) } : {}) };
          return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: body as unknown as JsonObject }], detail: { subscriber: sub.subscriber, stream: sub.stream, cursor: sub.cursor, lastActiveAt: lastActive(sub), idleSeconds, critical: sub.critical, pending, noticed: pending > 0 || sub.critical }, contention: async () => new DomainError("stale_revision", "the subscription was acknowledged at the same moment") };
        },
      }));
    } catch (error) {
      if (error instanceof NotIdle) return undefined;
      if (error instanceof DomainError && error.code === "stale_revision") return undefined;
      throw error;
    }
    return notice;
  }

  /** Delivers the Notice an expiry owes, then clears the flag. A failed delivery leaves the flag for the next sweep. */
  async #noticeOwed(id: string, known?: ExpiryNotice): Promise<boolean> {
    const ref: AggregateRef = { kind: "subscription", id };
    const current = await this.#runner.get(ref.kind, ref.id);
    const sub = current?.body as unknown as SubscriptionBody | undefined;
    if (current === undefined || sub === undefined || sub.state !== "expired" || sub.noticePending !== true) return false;
    if (this.#notify === undefined) return false;
    const head = (await this.#runner.get("events-head", derivedId("sub", sub.stream)))?.body as unknown as HeadBody | undefined;
    const pending = known?.pending ?? (head === undefined ? 0 : Math.max(0, head.next - 1 - Math.max(sub.cursor, head.floor - 1)));
    await this.#notify(known ?? { subscriptionId: id, subscriber: sub.subscriber, stream: sub.stream, cursor: sub.expiredCursor ?? sub.cursor, expiredAt: sub.expiredAt!, pending, idleSeconds: idleOf(sub, await this.#ceiling()), ...(sub.stream.startsWith("project:") ? { projectId: sub.stream.slice("project:".length) } : {}) });
    const { noticePending: _n, ...rest } = sub;
    try {
      await this.#runner.command("events.noticed", { commandId: `noticed-${id}-${sub.expiredAt}`, actor: "events" }, async () => ({
        payload: { subscriptionId: id },
        build: async () => ({ ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: rest as unknown as JsonObject }], detail: { subscriber: sub.subscriber } }),
      }));
    } catch (error) { if (!(error instanceof DomainError && error.code === "stale_revision")) throw error; }
    return true;
  }

  /** Ends a subscription (its subscriber or the owner). Its events are no longer kept for it. */
  async cancel(by: Principal, command: NoActor & { subscriptionId: string }): Promise<void> {
    onlyKnown(command, ["commandId", "subscriptionId"]);
    const id = typeof command.subscriptionId === "string" && SUB.test(command.subscriptionId) ? command.subscriptionId : invalid("subscriptionId", "is not a subscription ID");
    const ref: AggregateRef = { kind: "subscription", id };
    await this.#runner.command("events.cancel", { commandId: scopedCommandId(by.id, command.commandId), actor: by.id }, async () => ({
      payload: { subscriptionId: id },
      build: async () => {
        const current = await this.#runner.get(ref.kind, ref.id);
        const sub = current?.body as unknown as SubscriptionBody | undefined;
        if (current === undefined || sub === undefined || !(by.kind === "owner" || sub.subscriber === by.id)) throw new DomainError("forbidden", `${by.id} has no such subscription`);
        return { ref, creates: false, changes: [{ type: "update", ref, expectedRevision: current.revision, body: { ...sub, state: "cancelled" } as unknown as JsonObject }], detail: { subscriber: sub.subscriber } };
      },
    }));
  }
}
void checkRevision;

/** Wires idle-expiry notices to the owner notifications (U11): a `maintenance` item pointing at the subscription, with the cursor and the number of events left unhandled. U11b's Needs-you view is not in code yet; the notice reaches the owner's inbox and digest like any maintenance report. */
export const noticeThroughNotifications = (notifications: { emitFromController(command: { commandId: string; kind: "maintenance"; ref: { kind: string; id: string }; detail?: string; projectId?: string }): Promise<unknown> }): NotifyExpiry => async (n) => {
  await notifications.emitFromController({ commandId: `events-expired-${n.subscriptionId}-${n.expiredAt}`, kind: "maintenance", ref: { kind: "subscription", id: n.subscriptionId }, detail: `${n.subscriber} stopped acknowledging events on ${n.stream} for ${n.idleSeconds}s; it was expired at event ${n.cursor} with ${n.pending} unhandled`, ...(n.projectId === undefined ? {} : { projectId: n.projectId }) });
};
